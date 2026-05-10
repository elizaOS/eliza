# tunnel-proxy

Railway service for public Eliza Cloud tunnel URLs.

The service joins the Headscale tailnet with `tsnet` as `tag:eliza-proxy`.
Railway terminates public TLS for `*.tunnel.elizacloud.ai`, then this proxy maps
the public host to the matching Headscale MagicDNS host:

```text
<session>.tunnel.elizacloud.ai -> https://<session>.tunnel.eliza.local
```

Required Railway environment variables:

| Variable | Value |
| --- | --- |
| `HEADSCALE_PUBLIC_URL` | `https://headscale.elizacloud.ai` |
| `TUNNEL_PROXY_TS_AUTHKEY` | reusable Headscale preauth key tagged `tag:eliza-proxy` |
| `TUNNEL_PROXY_HOST` | `tunnel.elizacloud.ai` |
| `TUNNEL_TAILNET_DOMAIN` | `tunnel.eliza.local` |

Mount a Railway volume at `/var/lib/tunnel-proxy` so the `tsnet` node identity
persists across restarts.
