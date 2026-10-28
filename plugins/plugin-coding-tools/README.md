# @elizaos/plugin-coding-tools

Native coding tools (READ, WRITE, EDIT, FILE, SHELL, WORKTREE) for Eliza agents running
in code/terminal/automation contexts.

`CODING_TOOLS_WORKSPACE_ROOTS` scopes file tools and shell working directories. SHELL is
owner-authorized arbitrary command execution, not a filesystem sandbox. Apply host
isolation where required; preserve typed authorization and explicit failures.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-coding-tools build  # build
bun run --cwd plugins/plugin-coding-tools test   # tests
```

### Public Worker URL reads

`createWebFetchEdgeAction` from `@elizaos/plugin-coding-tools/edge` registers only the canonical public `WEB_FETCH` action. It reads through the anonymous Parallel provider and does not load shell, filesystem or browser capabilities. Source-bound provider extracts have no claimed origin HTTP status or freshness; `extract` is not applied to them. The default Node action preserves direct DNS-pinned HTTP, JSON-path extraction, retrieval metadata and upstream recovery hints.

When a caller supplies `signal` or `abortSignal`, cancellation rejects with the caller’s abort reason. This applies to both Node and edge actions; callers must handle the rejected promise.
