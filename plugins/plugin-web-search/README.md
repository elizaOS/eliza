# @elizaos/plugin-web-search

Credential-free public web search for Node and Worker hosts. Import the plugin,
search action, injected runner, and keyless transport from `@elizaos/plugin-web-search`.
Provider failures return an explicit unavailable result; preserve complete search output.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-web-search build  # build
bun run --cwd plugins/plugin-web-search test   # tests
```
