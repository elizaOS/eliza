# @elizaos/plugin-ngrok

Ngrok tunnel backend plugin for elizaOS. Implements the `ITunnelService` contract from `@elizaos/plugin-tunnel`, enabling Eliza agents to expose local HTTP ports via secure ngrok HTTPS tunnels.

## What it does

When loaded alongside `@elizaos/plugin-tunnel`, this plugin registers `NgrokService` under the shared `"tunnel"` service slot. The `TUNNEL` action (provided by `plugin-tunnel`) then delegates start/stop/status operations to ngrok. If another tunnel backend (such as a cloud tunnel service) has already claimed the slot, this plugin skips registration silently — first-active-wins.

This plugin adds **no new agent actions**. Tunnel control is handled by the `TUNNEL` action in `@elizaos/plugin-tunnel`.

## Requirements

- The `ngrok` CLI must be installed and available on `PATH`.

```bash
# macOS
brew install ngrok

# Linux
snap install ngrok
```

## Installation

```bash
npm install @elizaos/plugin-ngrok
```

## Usage

Load it in your agent's plugin list alongside `@elizaos/plugin-tunnel`:

```typescript
import { tunnelPlugin } from '@elizaos/plugin-tunnel';
import ngrokPlugin from '@elizaos/plugin-ngrok';

const agent = new AgentRuntime({
  plugins: [tunnelPlugin, ngrokPlugin],
  // ...
});
```

## Configuration

All variables are read from `runtime.getSetting()` first, then `process.env`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NGROK_AUTH_TOKEN` | No | — | ngrok account auth token. Without it, tunnels are anonymous and session-limited. |
| `NGROK_REGION` | No | `us` | Tunnel region: `us`, `eu`, `ap`, `au`, `sa`, `jp`, `in` |
| `NGROK_DOMAIN` | No | — | Static domain (e.g. `my-agent.ngrok-free.app`). Required for pay-as-you-go accounts. |
| `NGROK_SUBDOMAIN` | No | — | Custom subdomain (requires paid ngrok plan). |
| `NGROK_DEFAULT_PORT` | No | `3000` | Default port to tunnel (also aliased from `NGROK_TUNNEL_PORT`). |
| `NGROK_USE_RANDOM_SUBDOMAIN` | No | — | Set `true` to force a random URL even when a domain/subdomain is configured. |

### Getting an ngrok auth token

1. Sign up at [dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken)
2. Copy your auth token
3. Set `NGROK_AUTH_TOKEN=<token>` in your environment or agent config

### Pay-as-you-go accounts

If you see `ERR_NGROK_15002`, your account requires a registered domain. Set `NGROK_DOMAIN` to a domain registered in your ngrok dashboard (e.g. `NGROK_DOMAIN=my-agent.ngrok-free.app`).

## How it works

`NgrokService` spawns the `ngrok http <port>` CLI subprocess and polls `http://localhost:4040/api/tunnels` (ngrok's local API) to discover the public HTTPS URL. It retries up to 3 times at 2-second intervals. Once the URL is obtained, it is exposed via `getUrl()` and `getStatus()`.

