# @elizaos/plugin-assistant

Explicitly registered conversational behavior for the Node runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-assistant build  # build
bun run --cwd plugins/plugin-assistant test   # tests
```

The public OAuth provider catalog remains here; connection flows belong to
hosts, connectors, and cloud services. The unused OAuth callback bus and
plugin-configuration action plugin have been removed.
