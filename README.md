# embspec-mcp

[![npm](https://img.shields.io/npm/v/@mukundakatta/embspec-mcp.svg)](https://www.npmjs.com/package/@mukundakatta/embspec-mcp)
[![mcp](https://img.shields.io/badge/mcp-stdio-blue)](https://modelcontextprotocol.io)

MCP server: embedding pipeline ops + drift detection for production RAG. Wraps the Python library [`embspec`](https://github.com/MukundaKatta/embspec) by re-implementing its query-shaped surface natively in TypeScript so the MCP server has zero runtime deps beyond the MCP SDK.

```bash
npm install -g @mukundakatta/embspec-mcp
```

Or run via npx without installing:

```bash
npx -y @mukundakatta/embspec-mcp
```

## Tools

### `assert_compatible`

Fail-fast check that a query encoder matches an index manifest's recorded embedding model + version. Same primitive as Python embspec's `assert_compatible()` / `@embed_assert` decorator.

**Why:** prevents the silent-accuracy-collapse failure described in the [decompressed.io RAG observability post-mortem (2026-03-09)](https://decompressed.io/learn/rag-observability-postmortem) — query encoder ships before the index is re-encoded; every health check stays green while retrieval accuracy tanks.

```jsonc
// input
{
  "manifest": {
    "embspec_format_version": 1,
    "index_name": "prod-v3",
    "embedding": {
      "model_id": "amazon.titan-embed-text-v2:0",
      "dimension": 1024,
      "model_version": null,
      "normalization": "l2"
    }
  },
  "query_spec": {
    "model_id": "amazon.titan-embed-text-v2:0",
    "dimension": 1024
  }
}

// returns
{ "ok": true, "index_name": "prod-v3" }
```

On mismatch, returns the offending field and both values along with a human-readable error message ready to surface to the user.

### `neighbor_stability`

Compare two retrievers on a frozen probe set; returns mean overlap@k, mean Jaccard@k, list of regressed probes, and a deploy-safety verdict. Same metric Python embspec produces in `neighbor_stability()`.

**Why:** gates embedding-model upgrades, chunker swaps, or rerank changes before deploy. Computed entirely from caller-supplied retrieval results — the MCP server has no knowledge of your vector DB.

```jsonc
// input
{
  "old_results": {
    "q1": ["doc-a", "doc-b", "doc-c", "doc-d", "doc-e"],
    "q2": ["doc-x", "doc-y", "doc-z"]
  },
  "new_results": {
    "q1": ["doc-a", "doc-b", "doc-z", "doc-y", "doc-x"],
    "q2": ["doc-x", "doc-y", "doc-z"]
  },
  "k": 5,
  "regression_threshold": 0.5
}

// returns
{
  "n_probes": 2,
  "k": 5,
  "mean_overlap_at_k": 0.7,
  "mean_jaccard_at_k": 0.65,
  "regression_probe_ids": [],
  "regression_count": 0,
  "is_safe_to_deploy": false
}
```

The `is_safe_to_deploy` heuristic requires **mean_overlap >= 0.85** AND **regression fraction <= 0.05** (matching Python embspec's defaults).

## Configure your MCP client

### Claude Desktop

Add to `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "embspec": {
      "command": "npx",
      "args": ["-y", "@mukundakatta/embspec-mcp"]
    }
  }
}
```

### Cursor / Cline / Windsurf / Zed

Same shape — drop the `embspec` entry into the corresponding MCP server section.

## Why use this from an MCP client

A practitioner debugging RAG quality regressions naturally lives in their assistant. Running stability checks against retrieval-result dumps without leaving the conversation is the right ergonomic. Sample workflows:

> "I ran the same 50 probe queries against our v3 and v4 indexes — here are the top-5 results from each. Is it safe to deploy v4?"
> *(assistant calls `neighbor_stability`, returns the report and the offending probe ids)*

> "Here's the manifest from our prod index and the embedding spec our planner is about to use. Compatible?"
> *(assistant calls `assert_compatible`, fails fast with the field that drifted)*

## Sibling

The Python source lives at [github.com/MukundaKatta/embspec](https://github.com/MukundaKatta/embspec). It also ships `DriftAdapter` (linear least-squares migration helper that recovers 95-99% retrieval after embedding-model swap without re-encoding the corpus), which is too math-heavy to surface as an MCP tool and stays Python-only.

## Source

[github.com/MukundaKatta/embspec-mcp](https://github.com/MukundaKatta/embspec-mcp)

## License

MIT.
