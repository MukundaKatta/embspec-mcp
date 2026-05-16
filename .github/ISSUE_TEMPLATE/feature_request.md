---
name: Feature request
about: Propose a new MCP tool, a new manifest field, or a behavior change.
title: "[feat] "
labels: enhancement
assignees: ''
---

## Scope check

Before opening, please confirm this proposal fits the project scope (see `CONTRIBUTING.md`):

- [ ] It is a **read-only check**. (No `embed`, no `index`, no `query` — nothing that calls an embedding API or contacts a vector store from inside this server.)
- [ ] It does **not require credentials** (no OpenAI key, no AWS credentials, no Pinecone key passed to the MCP server).
- [ ] It does **not** make the MCP server stateful (no probe set held across calls, no cached indexes).

If any of those are unchecked, the right home is probably the Python `embspec` library or your own application code: <https://github.com/MukundaKatta/embspec>.

## What you want

A clear description of the proposed tool / field / behavior.

## Why

What silent-failure mode in production RAG does this catch? Concrete example of the prompt or flow that would benefit.

## Proposed tool shape

If proposing a new tool, sketch the input/output contract:

```jsonc
// tool name:
// input:
{
  "field": "type — description"
}
// output:
{
  "field": "type — description"
}
```

## Manifest field

If this is "add field X to the compatibility check", please also:

- [ ] Link to the embedding-model docs (or vector-store docs) showing how the field is exposed.
- [ ] Confirm whether the Python `embspec` `manifest.py` has the field yet (we keep them in sync within a week).
- [ ] State whether mismatch on this field should be a hard fail (`ok=false`) or a warning.

## Alternatives considered

What workarounds exist today (manual checks in app code, periodic audit scripts) and why aren't they good enough?
