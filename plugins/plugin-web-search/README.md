# @elizaos/plugin-web-search

Adds live web search through a full Tavily service on Node and a minimal credential-free
`./edge` action on Workers.

The Node service requires `TAVILY_API_KEY` in agent settings or the environment. Without
it, requests fail as unavailable. The `./edge` entry provides the separate
credential-free Worker-safe action.

The Node service requires `TAVILY_API_KEY`; register the plugin with the agent to expose the web search category.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-web-search build  # build
bun run --cwd plugins/plugin-web-search test   # tests
```
