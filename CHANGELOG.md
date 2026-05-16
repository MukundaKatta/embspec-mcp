# Changelog

All notable changes to `embspec-mcp` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-09

Initial release. MCP server exposing two pure, read-only embedding-pipeline checks to Claude Desktop, Cursor, Cline, Windsurf, Zed, and other MCP clients.

### Added

- **`assert_compatible` tool** — compare an index manifest (the embedding spec a vector index was built with) against the query encoder spec the caller wants to use right now. Catches the silent-accuracy-collapse failure mode where a query encoder upgrade ships before the index is re-encoded.
- **`neighbor_stability` tool** — compute retrieval stability between two index versions on a frozen probe set. Returns Jaccard@k and rank-correlation per query plus aggregates, so an LLM agent can answer "should I be worried about this re-index" with a number, not a vibe.
- `server.json` manifest at modelcontextprotocol.io schema 2025-12-11 for registry discovery.

### Notes

- 12 unit tests via `node --test`.
- Zero runtime dependencies beyond `@modelcontextprotocol/sdk`.
- Pure value comparison. No embedding API is called; no vector store is contacted; no credentials are required.
- Comparison logic mirrors the Python `embspec` `manifest.py` and is treated as data, not API; new manifest fields added in minor releases.
- TypeScript native; no Python sidecar process at runtime.
