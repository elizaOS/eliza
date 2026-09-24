# @elizaos/plugin-elizacloud

Eliza Cloud integration — multi-model inference, container provisioning, agent bridge,
and billing for elizaOS agents.

Configure `ELIZAOS_CLOUD_API_KEY`; `ELIZAOS_CLOUD_BASE_URL` overrides the API endpoint.
`ELIZAOS_CLOUD_ENABLED` enables provisioning, device-auth, bridge, and backup services.
Keep API keys server-side and retain per-agent routing authority.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-elizacloud build  # build
bun run --cwd plugins/plugin-elizacloud test   # tests
```
