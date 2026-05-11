# @elizaos/plugin-tailscale

Tunnel plugin for elizaOS. Exposes a local port through one of two interchangeable
Tailscale-backed implementations:

- **Local backend (`LocalTailscaleService`)** — drives the locally-installed
  `tailscale` CLI (`tailscale serve` for tailnet-internal HTTPS, `tailscale
funnel` for public Internet exposure). The user must already be authenticated
  to a tailnet.
- **Cloud backend (`CloudTailscaleService`)** — calls
  `POST /v1/apis/tunnels/tailscale/auth-key` on Eliza Cloud to mint a scoped
  ephemeral auth key for the configured `tag:eliza-tunnel` ACL, then runs
  `tailscale up --auth-key=...` followed by `tailscale serve`/`funnel` against
  the local port. The cloud holds the Headscale API credential, charges the
  user's organization a small on-demand credit debit for each provisioning, and
  returns a generated public hostname.

Both backends register under `serviceType = "tunnel"` and implement the same
`ITunnelService` shape, so consumers always go through
`runtime.getService("tunnel")` and never reach for backend-specific APIs.

> **Mutually exclusive with `@elizaos/plugin-ngrok`.** Both plugins register
> under `serviceType = "tunnel"`. Enable only one at a time.

## Backend selection

The plugin reads `TAILSCALE_BACKEND` from runtime settings:

| Value            | Behavior                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`          | Always register `LocalTailscaleService`.                                                                                                                                     |
| `cloud`          | Always register `CloudTailscaleService`.                                                                                                                                     |
| `auto` (default) | Register `CloudTailscaleService` when Eliza Cloud is connected (`ELIZAOS_CLOUD_API_KEY` set + `ELIZAOS_CLOUD_ENABLED=true`); otherwise fall back to `LocalTailscaleService`. |

`isCloudConnected` from `@elizaos/cloud-routing` is the source of truth.

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
| `ELIZAOS_CLOUD_BASE_URL`            | `https://www.elizacloud.ai/api/v1` | Cloud base URL override.                                                                                                |
| `ELIZAOS_CLOUD_ENABLED`             | `false`                            | Required (truthy) for `auto` mode to pick the cloud backend.                                                            |

The cloud backend is not a subscription product. Each successful auth-key
provisioning debits org credits once, using the Cloud Worker
`TUNNEL_AUTH_KEY_COST_USD` setting, and Headscale failures are refunded by the
Worker.

## Actions

- `START_TAILSCALE` (similes: `START_TUNNEL`, `OPEN_TUNNEL`, `CREATE_TUNNEL`, `TAILSCALE_UP`)
- `STOP_TAILSCALE` (similes: `STOP_TUNNEL`, `CLOSE_TUNNEL`, `TAILSCALE_DOWN`)
- `GET_TAILSCALE_STATUS` (similes: `TAILSCALE_STATUS`, `CHECK_TUNNEL`, `TUNNEL_INFO`)

All three resolve the active backend through `runtime.getService("tunnel")`, so
they behave identically across local and cloud modes.

## Cloud backend wire format

`POST /v1/apis/tunnels/tailscale/auth-key`:

```json
{ "tags": ["tag:eliza-tunnel"], "expirySeconds": 3600 }
```

Response:

```json
{
  "authKey": "tskey-auth-...",
  "tailnet": "https://headscale.elizacloud.ai",
  "loginServer": "https://headscale.elizacloud.ai",
  "hostname": "eliza-orgpart-randomhex-expiry-signature",
  "magicDnsName": "eliza-orgpart-randomhex-expiry-signature.tunnel.elizacloud.ai",
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
tailscale serve --bg --https=443 localhost:<port>     # or `tailscale funnel <port>`
```

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
```

## License

MIT
