---
name: Bug report
about: A tool returned the wrong answer, the server failed to start, or an MCP client can't reach a tool.
title: "[bug] "
labels: bug
assignees: ''
---

## What happened

A clear, concise description of the actual behavior.

## What you expected

A clear, concise description of what should have happened.

## Reproduction

Which tool: `assert_compatible` / `neighbor_stability`

Exact arguments passed:

```json
{
  "manifest": { },
  "query_spec": { }
}
```

Exact response received (paste the JSON-RPC `result` or `error`):

```json
```

If the bug is in `neighbor_stability`, please include the **smallest** pair of result lists that reproduces. Doc ids can be anonymized but must round-trip identically.

## Environment

- embspec-mcp version: (`npm ls @mukundakatta/embspec-mcp` or `cat package.json | jq .version`)
- Node version: (`node --version`)
- OS: (macOS 14 / Ubuntu 22.04 / Windows 11)
- MCP client: (Claude Desktop / Cursor / Cline / Windsurf / Zed / custom)
- MCP client version:

## Server discovery confirms the tool is registered

Output of piping a `tools/list` request to the server (rules out manifest/build issues):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js
```

```json
```

## Notes

Anything else — embedding model involved (text-embedding-3-small, voyage-3, cohere-embed-v3, amazon.titan-embed-text-v2, etc.), index store (Pinecone / Qdrant / Weaviate / pgvector), and whether this came from a real re-index or a synthetic test.
