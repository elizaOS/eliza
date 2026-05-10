# @elizaos/plugin-tunnel

Local Tailscale-CLI tunnel backend for elizaOS.

Registers `serviceType = "tunnel"` and exposes:

- **`TUNNEL` action** — dispatcher with `op` parameter-enum (`start | stop | status`). Legacy `TAILSCALE`-prefixed action names are kept as similes.
- **`TUNNEL_STATE` provider** — reads the active service's `getStatus()` into model state.
- **`LocalTunnelService`** — wraps `tailscale serve` / `tailscale funnel`.

## Coexistence

`plugin-tunnel`, [`@elizaos/plugin-elizacloud`](../plugin-elizacloud) (hosted headscale + reverse proxy), and [`@elizaos/plugin-ngrok`](https://github.com/elizaos-plugins/plugin-ngrok) all register under `serviceType="tunnel"`. **First active wins** — each plugin's `init` only registers if its credentials are present *and* the slot is free.

```
character.plugins = [
  '@elizaos/plugin-elizacloud',  // wins if ELIZAOS_CLOUD_API_KEY set
  '@elizaos/plugin-tunnel',      // falls back to local tailscale CLI
  '@elizaos/plugin-ngrok',       // last-resort, if NGROK_AUTHTOKEN set
];
```

## Setup

1. Install Tailscale: `brew install tailscale` (or [download](https://tailscale.com/download)).
2. Authenticate the device once:
   - Against the public Tailscale tailnet: `tailscale up`
   - Or against a self-hosted headscale: `tailscale up --login-server=https://headscale.example.com`
3. Optional: `TUNNEL_FUNNEL=true` to expose publicly via Tailscale Funnel.

## Config

| Env var | Default | Notes |
|---|---|---|
| `TUNNEL_TAGS` | `tag:eliza-tunnel` | Comma-separated ACL tags (informational; user authenticates separately) |
| `TUNNEL_FUNNEL` | `false` | When true, uses `tailscale funnel` instead of `tailscale serve` |
| `TUNNEL_DEFAULT_PORT` | `3000` | Used when no port is extracted from the user's message |

`TAILSCALE_*` aliases are accepted for one release window.
