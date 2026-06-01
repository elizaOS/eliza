# @elizaos/plugin-tailscale

Tunnel plugin for elizaOS. Exposes a local port through one of two interchangeable
Tailscale-backed implementations:

- **Local backend (`LocalTailscaleService`)** — drives the locally-installed
  `tailscale` CLI (`tailscale serve` for tailnet-internal HTTPS, `tailscale
funnel` for public Internet exposure). The user must already be authenticated
  to a tailnet.
- **Cloud backend (`CloudTailscaleService`)** — POSTs to
  `apis/tunnels/tailscale/auth-key` (relative to `ELIZAOS_CLOUD_BASE_URL`,
  default `https://api.elizacloud.ai/api/v1`) on Eliza Cloud to mint a scoped
  ephemeral auth key for the configured `tag:eliza-tunnel` ACL, then runs
  `tailscale up --auth-key=...` followed by `tailscale serve`/`funnel` against
  the local port. The cloud holds the Headscale credential and returns a
  `magicDnsName` the agent serves on. When the response includes a `billing`
  payload it is retained and exposed via `getLastProvisioningBilling()`.

Both backends register under `serviceType = "tunnel"` and implement the same
`ITunnelService` shape, so consumers always go through `getTunnelService(runtime)`
from `@elizaos/plugin-tunnel` and never reach for backend-specific APIs.

> **Mutually exclusive with `@elizaos/plugin-ngrok`.** Both plugins register
> under `serviceType = "tunnel"`. Enable only one at a time.

## Backend selection

The plugin reads `TAILSCALE_BACKEND` from runtime settings:

| Value            | Behavior                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `local`          | Always register `LocalTailscaleService`.                                                                                          |
| `cloud`          | Always register `CloudTailscaleService`.                                                                                          |
| `auto` (default) | Register `CloudTailscaleService` when `isCloudConnected(runtime)` from `@elizaos/cloud-routing` returns true; otherwise `LocalTailscaleService`. |

## Settings

| Key                                 | Default                            | Notes                                                                                                                   |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `TAILSCALE_BACKEND`                 | `auto`                             | `local` / `cloud` / `auto`.                                                                                             |
| `TAILSCALE_AUTH_KEY`                | —                                  | Optional pre-minted auth key for the local backend. Most users authenticate via `tailscale up` once and never set this. |
| `TAILSCALE_TAGS`                    | `tag:eliza-tunnel`                 | Comma-separated list of ACL tags applied to the cloud-minted ephemeral key.                                             |
| `TAILSCALE_FUNNEL`                  | `false`                            | When truthy, use `tailscale funnel` (public Internet) instead of `tailscale serve` (tailnet-only).                      |
| `TAILSCALE_DEFAULT_PORT`            | `3000`                             | Used when no port is extracted from the user message.                                                                   |
| `TAILSCALE_AUTH_KEY_EXPIRY_SECONDS` | `3600`                             | Expiry hint passed to the cloud auth-key minter.                                                                        |
| `ELIZAOS_CLOUD_API_KEY`             | —                                  | Required for the cloud backend.                                                                                         |
| `ELIZAOS_CLOUD_BASE_URL`            | `https://api.elizacloud.ai/api/v1` | Cloud base URL override.                                                                                                |

Billing is owned by Eliza Cloud, not this plugin. The auth-key mint response
may carry a `billing` object (`model: "on_demand"`, `unit`, `charged`,
`amountUsd`, `subscription`); the plugin only records it for
`getLastProvisioningBilling()`.

## Actions

This package does not expose provider-specific actions. It only registers a
Tailscale-backed `serviceType = "tunnel"` implementation. User-facing tunnel
operations go through the canonical `TUNNEL` action with
`action=start | stop | status`.

## Cloud backend wire format

Request — `POST <ELIZAOS_CLOUD_BASE_URL>/apis/tunnels/tailscale/auth-key`
(`Authorization: Bearer <ELIZAOS_CLOUD_API_KEY>`):

```json
{ "tags": ["tag:eliza-tunnel"], "expirySeconds": 3600 }
```

Response (`authKey`, `tailnet`, `magicDnsName` required; `loginServer`,
`hostname`, `billing` optional):

```json
{
  "authKey": "hskey-auth-...",
  "tailnet": "https://headscale.elizacloud.ai",
  "loginServer": "https://headscale.elizacloud.ai",
  "hostname": "eliza-test-session",
  "magicDnsName": "eliza-test-session.tunnel.elizacloud.ai",
  "billing": {
    "model": "on_demand",
    "unit": "tunnel_auth_key",
    "charged": true,
    "amountUsd": 0.01,
    "subscription": false
  }
}
```

The plugin then runs locally, in this order:

```bash
tailscale up --auth-key=<authKey> --login-server=<loginServer> --hostname=<hostname>
tailscale serve --bg --https=443 localhost:<port>     # or `tailscale funnel --bg <port>`
```

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
```
