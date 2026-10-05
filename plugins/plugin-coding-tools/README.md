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
