# Contributing to embspec-mcp

embspec-mcp is the MCP server wrapper for the embedding pipeline check surface (compatibility assertion + neighbor stability between index versions). It is the TypeScript-native sibling of the Python [`embspec`](https://github.com/MukundaKatta/embspec) library.

## In scope

- Bug fixes in either exposed tool (`assert_compatible`, `neighbor_stability`).
- New comparison fields on the manifest (e.g. tokenizer revision, normalization scheme) once they are stable in the Python `embspec`.
- Additional **read-only** RAG-ops checks that have a stable, side-effect-free contract suitable for an MCP tool call. Good candidates: probe-set drift summaries, manifest diff visualization, dimension/dtype sanity.
- Test coverage improvements.
- Better error messages.

## Out of scope

- **Embedding generation.** This server does not call any embedding API. Exposing an `embed` tool via MCP would let an LLM client run up arbitrary OpenAI / Cohere / Bedrock embedding bills. That belongs in your application, using the Python `embspec` library or your embedding provider's SDK directly.
- **Vector store I/O.** No tool here should connect to Pinecone, Qdrant, Weaviate, pgvector, etc. MCP servers in this lineup are stdio-only and credential-free; index access belongs in the calling application.
- **Conversion to a stateful service.** The MCP server holds no probe sets, no indexes, no embeddings between calls. Adding session state changes the threat model significantly.
- **Re-ranking / scoring.** The server compares results; it does not produce them.

## Sibling libraries

embspec-mcp wraps the Python library:

- Python: [`embspec`](https://github.com/MukundaKatta/embspec) (the canonical implementation)

The comparison logic and field list lives in two places (Python `embspec/manifest.py` and TS `src/server.ts`). When a new manifest field is added to the Python side, mirror it here within the same week.

## Development setup

```bash
git clone https://github.com/MukundaKatta/embspec-mcp.git
cd embspec-mcp
npm install
npm test              # 12 unit tests via node --test + tsx
npm run lint          # tsc --noEmit
npm run build         # tsc -> dist/
npm run dev           # tsx src/server.ts (run from stdio for local testing)
```

Node 18+ required.

## Local testing against an MCP client

After `npm run build`, point your MCP client at the built server:

```jsonc
{
  "mcpServers": {
    "embspec": {
      "command": "node",
      "args": ["/absolute/path/to/embspec-mcp/dist/server.js"]
    }
  }
}
```

For Claude Desktop, this goes in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). Restart the client. The server's stderr line `embspec MCP server v0.1.0 ready on stdio` should show up in the client's logs.

## Workflow

1. Open an issue first for anything bigger than a one-file change.
2. Branch from `main`.
3. Write tests for the change. Pure functions added in `src/` should have unit tests in `test/`.
4. Run `npm test` and `npm run lint` and confirm both pass.
5. Build the server (`npm run build`) and smoke-test by piping a `tools/list` JSON-RPC request to it.
6. Open a PR against `main`. Fill in the template.
7. CI must be green before review.

## Coding conventions

- TypeScript strict mode. No `any` in exported types; runtime `as unknown as T` casts are allowed where the SDK gives us `Record<string, unknown>`.
- Tool descriptions matter. Write them as if an LLM agent is going to read them with no other context — because that's exactly what happens. Spell out the failure mode each tool prevents.
- Error results (`isError: true`) should be plain strings the agent can act on, not stack traces.
- Doc ids are opaque strings. Never use them as filesystem paths, never `eval` them, never shell out with them.

## Release cadence

Releases follow semver. Patches: bug fixes only. Minor versions: new tools or new manifest fields. Major versions: breaking changes to the tool schemas (unlikely in v0.x).

Releases are cut by the maintainer via tag push. See `.github/workflows/release.yml`. npm publish uses provenance OIDC; no NPM_TOKEN secret needed.
