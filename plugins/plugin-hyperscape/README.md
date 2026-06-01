# @elizaos/plugin-hyperscape

elizaOS plugin that connects an Eliza agent to a live Hyperscape game session. The plugin provides session lifecycle resolvers (launch, auth, live refresh, teardown) and operator UI surfaces so you can spectate, steer, and control an embedded Hyperscape agent from the elizaOS dashboard.

## What it does

- **Session resolution.** On launch, the plugin fetches live session state from the Hyperscape API (current goal, available goals, quick-action commands, recent thoughts, run status) and returns it to the elizaOS app-manager as a structured `AppSessionState`.
- **Viewer auth.** When an `HYPERSCAPE_AUTH_TOKEN` is available, the plugin builds a `HYPERSCAPE_AUTH` postMessage credential so the Hyperscape iframe auto-logs in without a manual sign-in step.
- **Wallet-auth bootstrap.** If no auth token is configured, the plugin attempts wallet-based auth against the Hyperscape API using the agent's EVM address (derived from the runtime wallet or `EVM_PRIVATE_KEY`). The resulting token is persisted to the runtime for subsequent launches.
- **Live refresh.** The `refreshRunSession` hook is called by the app-manager on a polling interval and keeps the session state current during an active run.
- **Pause / resume controls.** The operator surface exposes pause and resume buttons that relay control commands to the app-manager run.
- **Operator relay.** Type or select suggested prompts to send free-form steering messages to the running Hyperscape agent.

## Capabilities added to the agent

| capability | description |
|------------|-------------|
| Hyperscape operator surface | Dashboard panel showing run status, viewer attachment, current goal, health, and recent activity |
| Hyperscape XR surface | Same surface rendered in XR context |
| Hyperscape TUI surface | Minimal terminal surface for headless environments |
| Detail panel extension | Embedded operator panel in the app detail drawer (`hyperscape-embedded-agents` panel id) |

## Required configuration

| env var | purpose |
|---------|---------|
| `HYPERSCAPE_API_URL` | Base URL of the Hyperscape API (absolute `http`/`https`). Falls back to `HYPERSCAPE_CLIENT_URL` when absent. At least one of these two must be set for live session data to load. |
| `HYPERSCAPE_CLIENT_URL` | Viewer client origin; used as API base fallback when `HYPERSCAPE_API_URL` is not set. |

## Optional configuration

| env var | purpose |
|---------|---------|
| `HYPERSCAPE_AUTH_TOKEN` | Pre-configured bearer token for viewer auto-login. If absent, the plugin attempts wallet-auth on launch. |
| `HYPERSCAPE_CHARACTER_ID` | Hyperscape character ID to follow in the viewer. Populated automatically by wallet-auth when returned by the API. |
| `EVM_PRIVATE_KEY` | EVM private key used to derive a wallet address for wallet-auth when the runtime agent has no stored EVM wallet. |

## Enabling the plugin

Add `@elizaos/plugin-hyperscape` to the `plugins` array in your agent character file:

```json
{
  "name": "MyAgent",
  "plugins": ["@elizaos/plugin-hyperscape"]
}
```

Then set at minimum `HYPERSCAPE_API_URL` (or `HYPERSCAPE_CLIENT_URL`) in your agent's environment or character settings.

## Session mode

This plugin operates in **spectate-and-steer** mode. The elizaOS app-manager hosts the Hyperscape iframe; the agent runs inside Hyperscape and the operator (or another agent) can send steering messages and pause/resume autonomy from the elizaOS UI.

## Building

```bash
bun run --cwd plugins/plugin-hyperscape build
```

This runs three steps: tsup JS bundle, Vite views bundle, and tsc declarations. Both the main bundle and the views bundle (`dist/views/bundle.js`) must be present for the plugin to function at runtime.
