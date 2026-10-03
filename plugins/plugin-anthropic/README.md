# @elizaos/plugin-anthropic

Anthropic Claude model provider for elizaOS — registers model handlers for text
generation, reasoning, image description, and structured output across all elizaOS
`ModelType` tiers.

Register the plugin and configure `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`).
`ANTHROPIC_AUTH_MODE` also supports configured OAuth and Claude CLI credentials. Model
tier and endpoint overrides are defined in the package configuration; use
runtime.useModel for dispatch. Import the provider and endpoint configuration
from the package root; the provider runs in Node.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-anthropic build  # build
bun run --cwd plugins/plugin-anthropic test   # tests
```
