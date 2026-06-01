# @elizaos/plugin-farcaster

Farcaster client plugin for [elizaOS](https://github.com/elizaOS/eliza). Gives an Eliza agent the ability to publish casts, reply to mentions, read its feed, and react to casts on the Farcaster decentralized social network via the [Neynar API](https://neynar.com).

## Capabilities

- **Cast publishing** — send new casts and thread replies; auto-truncates to 320 characters using the agent's language model when needed.
- **Feed reading** — fetch and search the authenticated account's recent timeline.
- **Mentions & interactions** — monitor mentions and respond in polling mode or via real-time webhook.
- **Reactions** — like, unlike, recast, and remove recasts.
- **Thread traversal** — walk a cast thread back to its root.
- **Profile provider** — injects the agent's Farcaster profile (FID, username, display name) as context for social-posting and messaging tasks.
- **Webhook handler** — `POST /webhook` route processes Neynar webhook events in real time.
- **Multi-account** — one agent can manage multiple Farcaster accounts via namespaced env vars.

## Installation

```bash
bun add @elizaos/plugin-farcaster
```

## Configuration

The plugin is auto-enabled when a `farcaster` connector block is present in the agent config. Register it manually if needed:

```typescript
import farcasterPlugin from "@elizaos/plugin-farcaster";

const agent = new AgentRuntime({
  plugins: [farcasterPlugin],
  // ...
});
```

### Environment variables

| Variable                   | Required | Default            | Description |
|----------------------------|----------|--------------------|-------------|
| `FARCASTER_NEYNAR_API_KEY` | yes      | —                  | Neynar API key |
| `FARCASTER_FID`            | yes      | —                  | Farcaster user ID (integer) |
| `FARCASTER_SIGNER_UUID`    | yes      | —                  | Neynar signer UUID |
| `FARCASTER_MODE`           | no       | `polling`          | `polling` or `webhook` |
| `FARCASTER_HUB_URL`        | no       | `hub.pinata.cloud` | Farcaster hub base URL |
| `FARCASTER_POLL_INTERVAL`  | no       | `120`              | Seconds between polling cycles |
| `FARCASTER_DRY_RUN`        | no       | `false`            | Simulate without publishing |
| `MAX_CAST_LENGTH`          | no       | `320`              | Max cast characters |
| `ENABLE_CAST`              | no       | `true`             | Enable autonomous cast loop |
| `CAST_INTERVAL_MIN`        | no       | `90`               | Min minutes between autonomous casts |
| `CAST_INTERVAL_MAX`        | no       | `180`              | Max minutes between autonomous casts |
| `CAST_IMMEDIATELY`         | no       | `false`            | Post first cast immediately on start |
| `ENABLE_ACTION_PROCESSING` | no       | `false`            | Process mentions automatically |
| `ACTION_INTERVAL`          | no       | `5`                | Minutes between action-processing cycles |
| `MAX_ACTIONS_PROCESSING`   | no       | `1`                | Max interactions processed per cycle |

For multi-account setups, prefix any variable with `FARCASTER_<ACCOUNT_ID>_` (e.g. `FARCASTER_MYACCT_FID`).

### Webhook mode

Set `FARCASTER_MODE=webhook` and configure your Neynar app to send webhook events to `POST /webhook` on your agent's public URL. The handler validates the `NeynarWebhookData` payload shape before processing.

## Providers

### `farcasterProfile`

Injects the agent's current Farcaster profile (FID, username, display name) into the context for turns in the `social_posting`, `messaging`, and `connectors` contexts.

## Development

```bash
bun run --cwd plugins/plugin-farcaster build       # build node + browser bundles
bun run --cwd plugins/plugin-farcaster dev         # watch mode
bun run --cwd plugins/plugin-farcaster test        # run all tests
bun run --cwd plugins/plugin-farcaster typecheck   # type-check only
bun run --cwd plugins/plugin-farcaster lint        # biome check + fix
```
