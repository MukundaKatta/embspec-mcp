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

// --- types ---------------------------------------------------------------

type Normalization = 'l2' | 'none';

interface EmbeddingSpec {
  model_id: string;
  dimension: number;
  model_version?: string | null;
  normalization?: Normalization;
}

interface ManifestJson {
  embspec_format_version?: number;
  index_name: string;
  embedding: EmbeddingSpec;
}

// --- tool implementations ------------------------------------------------

function assertCompatibleTool(args: {
  manifest: ManifestJson;
  query_spec: EmbeddingSpec;
}) {
  const manifest = args.manifest;
  const querySpec = args.query_spec;

  // Mirror Python embspec's IndexManifest.assert_compatible field order so
  // the first reported mismatch matches the Python lib's error message.
  const manifestEmb = manifest.embedding;
  const queryNorm = querySpec.normalization ?? 'l2';
  const manifestNorm = manifestEmb.normalization ?? 'l2';
  const queryVer = querySpec.model_version ?? null;
  const manifestVer = manifestEmb.model_version ?? null;

  const failures: Array<{
    field: string;
    manifest_value: unknown;
    query_value: unknown;
  }> = [];

  if (queryVer !== manifestVer) {
    failures.push({
      field: 'embedding.model_version',
      manifest_value: manifestVer,
      query_value: queryVer,
    });
  }
  if (queryNorm !== manifestNorm) {
    failures.push({
      field: 'embedding.normalization',
      manifest_value: manifestNorm,
      query_value: queryNorm,
    });
  }
  if (querySpec.dimension !== manifestEmb.dimension) {
    failures.push({
      field: 'embedding.dimension',
      manifest_value: manifestEmb.dimension,
      query_value: querySpec.dimension,
    });
  }
  if (querySpec.model_id !== manifestEmb.model_id) {
    failures.push({
      field: 'embedding.model_id',
      manifest_value: manifestEmb.model_id,
      query_value: querySpec.model_id,
    });
  }

  // Python embspec raises on the FIRST mismatch in this order:
  // model_id > dimension > model_version > normalization. We sort to match.
  failures.sort((a, b) => {
    const order = [
      'embedding.model_id',
      'embedding.dimension',
      'embedding.model_version',
      'embedding.normalization',
    ];
    return order.indexOf(a.field) - order.indexOf(b.field);
  });

  if (failures.length === 0) {
    return jsonResult({
      ok: true,
      index_name: manifest.index_name,
    });
  }

  const first = failures[0]!;
  return jsonResult({
    ok: false,
    index_name: manifest.index_name,
    failed_field: first.field,
    manifest_value: first.manifest_value,
    query_value: first.query_value,
    all_failures: failures,
    message:
      `Index ${JSON.stringify(manifest.index_name)} manifest declares ` +
      `${first.field}=${JSON.stringify(first.manifest_value)} but query encoder ` +
      `uses ${JSON.stringify(first.query_value)}. ` +
      `Re-encode the corpus or roll the query encoder back.`,
  });
}

function neighborStabilityTool(args: {
  old_results: Record<string, string[]>;
  new_results: Record<string, string[]>;
  k?: number;
  regression_threshold?: number;
}) {
  const k = args.k ?? 10;
  const regressionThreshold = args.regression_threshold ?? 0.5;
  if (k < 1) {
    return errorResult('neighbor_stability: k must be >= 1');
  }
  if (regressionThreshold < 0 || regressionThreshold > 1) {
    return errorResult(
      'neighbor_stability: regression_threshold must be in [0, 1]',
    );
  }

  const oldKeys = Object.keys(args.old_results ?? {});
  const newKeys = new Set(Object.keys(args.new_results ?? {}));
  const common = oldKeys.filter((k) => newKeys.has(k)).sort();

  if (common.length === 0) {
    return jsonResult({
      n_probes: 0,
      k,
      mean_overlap_at_k: 0,
      mean_jaccard_at_k: 0,
      regression_probe_ids: [],
      regression_count: 0,
      is_safe_to_deploy: false,
    });
  }

  let overlapSum = 0;
  let jaccardSum = 0;
  const regressions: string[] = [];

  for (const probeId of common) {
    const oldTopk = new Set(args.old_results[probeId]!.slice(0, k));
    const newTopk = new Set(args.new_results[probeId]!.slice(0, k));
    let intersect = 0;
    for (const id of oldTopk) {
      if (newTopk.has(id)) intersect++;
    }
    const union = new Set([...oldTopk, ...newTopk]).size;
    const overlap = intersect / k;
    const jaccard = union > 0 ? intersect / union : 0;
    overlapSum += overlap;
    jaccardSum += jaccard;
    if (overlap < regressionThreshold) {
      regressions.push(probeId);
    }
  }

  const n = common.length;
  const meanOverlap = overlapSum / n;
  const meanJaccard = jaccardSum / n;
  const regressionFraction = regressions.length / n;
  // Default deploy-safety thresholds match Python embspec's
  // StabilityReport.is_safe_to_deploy(): >= 0.85 mean overlap and
  // <= 5% regressions.
  const isSafe = meanOverlap >= 0.85 && regressionFraction <= 0.05;

  return jsonResult({
    n_probes: n,
    k,
    mean_overlap_at_k: meanOverlap,
    mean_jaccard_at_k: meanJaccard,
    regression_probe_ids: regressions,
    regression_count: regressions.length,
    is_safe_to_deploy: isSafe,
  });
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
