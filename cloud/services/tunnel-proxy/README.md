# tunnel-proxy

Railway service for public Eliza Cloud tunnel URLs.

The service joins the Headscale tailnet with `tsnet` as `tag:eliza-proxy`.
Railway terminates public TLS for `*.tunnel.elizacloud.ai`, then this proxy maps
the public host to the matching Headscale MagicDNS host:

```text
eliza-<org>-<random>.tunnel.elizacloud.ai -> https://eliza-<org>-<random>.tunnel.eliza.local
```

Only Cloud-minted hostnames matching
`eliza-<orgpart>-<randomhex>-<signature>` are proxied when
`TUNNEL_HOSTNAME_SIGNING_SECRET` is set. Root traffic and arbitrary wildcard
labels return 404, while `/health` and `/ready` remain public for Railway and
DNS smoke checks.

Required Railway environment variables:

| Variable | Value |
| --- | --- |
| `HEADSCALE_PUBLIC_URL` | `https://headscale.elizacloud.ai` |
| `TUNNEL_PROXY_TS_AUTHKEY` | reusable Headscale preauth key tagged `tag:eliza-proxy` |
| `TUNNEL_PROXY_HOST` | `tunnel.elizacloud.ai` |
| `TUNNEL_TAILNET_DOMAIN` | `tunnel.eliza.local` |
| `TUNNEL_HOSTNAME_SIGNING_SECRET` | shared HMAC secret also set as a Cloud Worker secret |

Mount a Railway volume at `/var/lib/tunnel-proxy` so the `tsnet` node identity
persists across restarts.
