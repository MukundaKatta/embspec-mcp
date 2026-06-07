#!/usr/bin/env node
/**
 * embspec MCP server.
 *
 * Exposes two tools to any MCP client (Claude Desktop, Cursor, Cline,
 * Windsurf, Zed, etc.):
 *
 *   assert_compatible    — fail-fast check that a query encoder matches an
 *                          index manifest's recorded embedding model+version.
 *                          Same primitive as Python embspec's
 *                          `assert_compatible()` / `@embed_assert` decorator.
 *
 *   neighbor_stability   — compare two retrievers on a frozen probe set;
 *                          returns mean overlap@k, mean Jaccard@k, list of
 *                          regressed probe ids, and a deploy-safety verdict.
 *                          Same metric Python embspec produces in
 *                          `neighbor_stability()`.
 *
 * The pure tool logic lives in `./core.js` so the unit tests exercise
 * exactly the code that ships. This file only handles MCP wiring: the tool
 * catalog, request dispatch, and the stdio transport.
 *
 * Wraps the Python library at https://github.com/MukundaKatta/embspec by
 * re-implementing its query-shaped surface natively in TypeScript so the
 * MCP server has zero runtime dependencies beyond the MCP SDK.
 *
 * Configure your client to spawn this binary over stdio. Example for
 * Claude Desktop's claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "embspec": {
 *         "command": "npx",
 *         "args": ["-y", "@mukundakatta/embspec-mcp"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  assertCompatible,
  neighborStability,
  StabilityArgumentError,
  type EmbeddingSpec,
  type ManifestJson,
} from './core.js';

const VERSION = '0.1.0';

const server = new Server(
  {
    name: 'embspec',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// --- tool catalog ---------------------------------------------------------

const TOOLS = [
  {
    name: 'assert_compatible',
    description:
      'Compare an index manifest (the embedding spec a vector index was built with) against the query encoder spec the caller wants to use right now. Returns ok=true when every field matches, ok=false with the offending field and both values otherwise. Use this before every search to catch the silent-accuracy-collapse failure mode where a query encoder upgrade ships before the index is re-encoded. Compatibility is exact-match on model_id + dimension + model_version + normalization; any drift is a failure.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: {
          type: 'object',
          description:
            'The IndexManifest JSON produced by Python embspec.IndexManifest.save() (or constructed manually). Must include embedding.{model_id, dimension, model_version?, normalization?} and index_name.',
          properties: {
            embspec_format_version: { type: 'integer' },
            index_name: { type: 'string' },
            embedding: {
              type: 'object',
              properties: {
                model_id: { type: 'string' },
                dimension: { type: 'integer' },
                model_version: { type: ['string', 'null'] },
                normalization: { type: 'string', enum: ['l2', 'none'] },
              },
              required: ['model_id', 'dimension'],
            },
          },
          required: ['index_name', 'embedding'],
        },
        query_spec: {
          type: 'object',
          description: 'EmbeddingSpec the query encoder uses right now.',
          properties: {
            model_id: { type: 'string' },
            dimension: { type: 'integer' },
            model_version: { type: ['string', 'null'] },
            normalization: {
              type: 'string',
              enum: ['l2', 'none'],
              default: 'l2',
            },
          },
          required: ['model_id', 'dimension'],
        },
      },
      required: ['manifest', 'query_spec'],
    },
  },
  {
    name: 'neighbor_stability',
    description:
      'Compare two retrievers on a frozen probe set. Both arguments map probe_id to top-k doc id list. Returns mean overlap@k (|new ∩ old| / k), mean Jaccard@k (|new ∩ old| / |new ∪ old|), list of probe ids whose overlap fell below regression_threshold, and a deploy-safety verdict (heuristic: mean_overlap >= 0.85 AND regression fraction <= 0.05). Use to gate embedding-model upgrades, chunker swaps, or rerank changes before deploying.',
    inputSchema: {
      type: 'object',
      properties: {
        old_results: {
          type: 'object',
          description:
            'Map of probe_id -> ordered list of top-k doc ids from the OLD retriever. Caller produces this by running each probe through the existing system.',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        new_results: {
          type: 'object',
          description:
            'Map of probe_id -> ordered list of top-k doc ids from the NEW retriever. Probe ids must overlap with old_results; extras in either are ignored.',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        k: {
          type: 'integer',
          description: 'Top-k cutoff for the comparison.',
          default: 10,
          minimum: 1,
        },
        regression_threshold: {
          type: 'number',
          description:
            'Probe overlap below this is counted as a regression and listed in regression_probe_ids. 0.5 means "lost more than half the top-k".',
          default: 0.5,
          minimum: 0,
          maximum: 1,
        },
      },
      required: ['old_results', 'new_results'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// --- tool dispatch --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'assert_compatible':
        return assertCompatibleTool(
          args as { manifest: ManifestJson; query_spec: EmbeddingSpec },
        );
      case 'neighbor_stability':
        return neighborStabilityTool(
          args as {
            old_results: Record<string, string[]>;
            new_results: Record<string, string[]>;
            k?: number;
            regression_threshold?: number;
          },
        );
      default:
        return errorResult('unknown tool: ' + name);
    }
  } catch (err) {
    return errorResult('internal error: ' + (err as Error).message);
  }
});

// --- tool implementations ------------------------------------------------

function assertCompatibleTool(args: {
  manifest: ManifestJson;
  query_spec: EmbeddingSpec;
}) {
  if (!args?.manifest || !args.manifest.embedding) {
    return errorResult(
      'assert_compatible: manifest with an "embedding" object is required',
    );
  }
  if (!args.query_spec) {
    return errorResult('assert_compatible: query_spec is required');
  }
  return jsonResult(assertCompatible(args.manifest, args.query_spec));
}

function neighborStabilityTool(args: {
  old_results: Record<string, string[]>;
  new_results: Record<string, string[]>;
  k?: number;
  regression_threshold?: number;
}) {
  try {
    return jsonResult(
      neighborStability(
        args.old_results ?? {},
        args.new_results ?? {},
        args.k,
        args.regression_threshold,
      ),
    );
  } catch (err) {
    if (err instanceof StabilityArgumentError) {
      return errorResult(err.message);
    }
    throw err;
  }
}

// --- helpers --------------------------------------------------------------

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

// --- bootstrap ------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`embspec MCP server v${VERSION} ready on stdio\n`);
