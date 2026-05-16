# Security Policy

## Supported Versions

embspec-mcp is at v0.1.x. Security fixes will be issued for the current minor (0.1.x). Older minors will not receive backports.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately by emailing `mukunda.vjcs6@gmail.com` with the subject `[embspec-mcp security]`. Include:

- A description of the vulnerability and its impact.
- The version of embspec-mcp affected (`npm ls @mukundakatta/embspec-mcp`).
- The MCP client involved (Claude Desktop, Cursor, Cline, Windsurf, Zed, custom).
- Reproduction steps or a minimal proof-of-concept.
- Any suggested mitigation, if you have one.

You can expect:

- An acknowledgment within 5 business days.
- A status update within 14 days.
- A coordinated disclosure window of at most 90 days from the acknowledgment.

## Specific Risk Surfaces

embspec-mcp is an MCP server that runs over stdio in the user's local environment, exposing two read-only RAG-pipeline checks to an LLM client. Areas worth special attention:

- **`assert_compatible`** — compares an index manifest against a query encoder spec. This is pure value comparison; no I/O, no network. If you find a path where the tool reads filesystem or env values outside the explicit input, that's a real issue.
- **`neighbor_stability`** — takes two retrieval result sets (lists of doc ids) and computes Jaccard / rank-correlation between them. Doc ids are treated as opaque strings and should never be eval'd, shelled out to, or used as filesystem paths. If a doc id can trigger anything other than string comparison, that's a high-severity report.
- **Probe-set handling** — both tools take caller-provided arrays. If a maliciously large array (or one with cyclic JSON) can crash the server in a way that takes down the MCP client process, that's worth reporting. Memory exhaustion via a 10M-element array is expected — a fast OOM in MB-range inputs is not.
- **stdio protocol layer** — the underlying `@modelcontextprotocol/sdk` handles the JSON-RPC framing. Vulnerabilities in that surface should be reported to <https://github.com/modelcontextprotocol/typescript-sdk> directly, not here.

## Out of scope

- **Embedding model invocation.** This server does **not** call any embedding API or load any embedding model. If you find a path where it does, that's a bug, not a security issue — but please file it.
- **Vector store access.** The server never connects to Pinecone, Qdrant, Weaviate, pgvector, or any other vector store. It only operates on caller-provided manifests + result arrays.

## Dependencies

embspec-mcp has exactly one runtime dependency: `@modelcontextprotocol/sdk`. Any addition is reviewed for security impact and dependency confusion risk.

We will not pay bug bounties at this time.
