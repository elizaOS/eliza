# @elizaos/core

Node runtime kernel for Eliza agents: plugin registration, authorization, state, model
dispatch, memory, and cancellation.

Import from `@elizaos/core`. Hosts explicitly supply database adapters, model providers,
and `@elizaos/plugin-assistant` for conversational behavior. Core is Node-only, with one
public package entry; it does not own HTTP routes or install assistant behavior
implicitly. Runtime settings are per-agent and do not implicitly read process.env.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/core build  # build
bun run --cwd packages/core test   # tests
```
