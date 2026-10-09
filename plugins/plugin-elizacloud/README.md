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

Image description forwards the caller AbortSignal to the Cloud SDK, interrupts
warming/rate-limit waits, and discards responses received after cancellation.
Actual server-side cancellation depends on the provider; no late result is
returned as a successful description.

Hosts that provide account management through their own trusted UI may set
`ELIZAOS_CLOUD_ACCOUNT_ACTIONS=disabled` before loading the plugin. Its account
status, agent-listing and API-key creation actions are then absent from runtime
registration; inference models, providers and services remain available. The
unset/default value is `enabled`; other values fail plugin loading. This controls
registration, not authorization of arbitrary direct SDK calls or other plugins.
