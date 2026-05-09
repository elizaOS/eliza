# Deploying tunnel infrastructure

End-to-end checklist to bring the customer-tunnel stack online. This is human-driven; the code lives in this repo but the Railway/DNS work is manual.

## 1. DNS

- `headscale.elizacloud.ai` → A/AAAA → Railway public IP for the headscale service.
- `tunnel.elizacloud.ai` AND `*.tunnel.elizacloud.ai` → A/AAAA → Railway public IP for the tunnel-proxy service.
- Delegate `_acme-challenge.tunnel.elizacloud.ai` to Cloudflare (or whichever DNS provider matches the Caddy `dns` directive in `services/tunnel-proxy/Caddyfile`).

## 2. Headscale Railway service

```
cd cloud/services/headscale
# Push to a Railway service backed by this Dockerfile
railway up
```

Then inside the running container:

```
headscale users create agent
headscale users create tunnel
headscale apikeys create --expiration=8760h
```

Mount a Railway volume at `/var/lib/headscale` so the SQLite DB and private keys persist across restarts.

## 3. Long-lived headscale preauth key for the proxy

```
# Run inside the headscale container
headscale --user tunnel preauthkeys create --reusable --expiration 8760h --tags tag:eliza-proxy
```

Save the returned key as Railway secret `TUNNEL_PROXY_TS_AUTHKEY` on the tunnel-proxy service.

## 4. Tunnel-proxy Railway service

```
cd cloud/services/tunnel-proxy
railway up
```

Required env vars on the proxy service:

| Var | Value |
|---|---|
| `HEADSCALE_PUBLIC_URL` | `https://headscale.elizacloud.ai` |
| `TUNNEL_PROXY_TS_AUTHKEY` | (from step 3) |
| `CLOUD_API_URL` | `https://www.elizacloud.ai` |
| `CLOUD_INTERNAL_TOKEN` | random 64-byte token, also set on the API Worker |
| `CF_API_TOKEN` | Cloudflare token with `Zone:DNS:Edit` on the elizacloud.ai zone (for ACME wildcard) |

## 5. API Worker secrets

On the cloud-api Worker (Cloudflare):

```
wrangler secret put HEADSCALE_PUBLIC_URL
wrangler secret put HEADSCALE_API_URL          # same as above unless private network is wired
wrangler secret put HEADSCALE_API_KEY          # from step 2
wrangler secret put HEADSCALE_USER             # value: "tunnel"
wrangler secret put TUNNEL_PROXY_HOST          # value: "tunnel.elizacloud.ai"
wrangler secret put TUNNEL_TAILNET_DOMAIN      # value: "tunnel.eliza.local"  (matches headscale config)
wrangler secret put CLOUD_INTERNAL_TOKEN       # same value as the proxy
```

## 6. Database migration

```
cd cloud
bun run db:migrate
```

This applies `0105_add_tunnel_sessions.sql`. Verify with:

```
psql $DATABASE_URL -c '\d tunnel_sessions'
```

## 7. Smoke test

From a machine with the tailscale CLI installed and `@elizaos/plugin-elizacloud` enabled with `ELIZAOS_CLOUD_API_KEY` set:

```
# In an agent prompt:
> start tunnel on port 3000
```

You should see:
- A tunnel session row inserted into `tunnel_sessions`
- The agent host appear under `headscale node list --user tunnel`
- A 200 response from `https://<sessionId>.tunnel.elizacloud.ai`
- A debit row in `credit_transactions` after ~1 minute (the per-minute cron tick)

## 8. Verify ACL isolation

The agent fleet (tag:agent) must NOT be reachable from a customer tunnel (tag:eliza-tunnel-*). After a tunnel is up, run from the agent's tailnet shell:

```
tailscale ping -c 1 <some agent container's tailnet IP>
```

This should fail with "no path". The headscale ACL test block in `acl.hujson` enforces this — keep it green.
