<!--
Thanks for sending a PR to embspec-mcp.

Quick reminders before you submit:
  - This is an MCP server. Tools must stay read-only and credential-free. See CONTRIBUTING.md.
  - Tool descriptions are read by an LLM agent with no other context. Spell out the failure mode each tool prevents.
  - Tests live in test/ and run via `npm test`. Add one for any new logic.
  - Manifest fields here must also be mirrored in the Python `embspec` repo within the same week.
-->

## What this changes

A one-line summary, then a short paragraph if needed.

## Why

The user-visible problem or silent failure mode this addresses.

## Type of change

- [ ] Bug fix in an existing tool (`assert_compatible` / `neighbor_stability`)
- [ ] New manifest field for compatibility check
- [ ] New MCP tool (read-only / credential-free only)
- [ ] Documentation
- [ ] CI / build / release plumbing
- [ ] Test coverage

## Scope check (for new tools)

- [ ] Tool is read-only. No embedding API is called; no vector store is contacted.
- [ ] Tool does not require credentials at the MCP server layer.
- [ ] Tool description is written for an LLM consumer (spells out the failure mode it prevents).

## Validation

- [ ] `npm test` passes locally
- [ ] `npm run lint` (tsc --noEmit) passes locally
- [ ] `npm run build` succeeds and the server starts: piping `tools/list` to `node dist/server.js` returns the expected tool array
- [ ] If a manifest field was added, a matching change is queued for the Python `embspec` `manifest.py`

## Linked issue

Closes #
