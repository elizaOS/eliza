# Deploying tunnel infrastructure

End-to-end checklist to bring the customer-tunnel stack online. Railway owns the Headscale runtime; Wrangler owns the Eliza Cloud Worker config and secrets.

## 1. DNS

- `headscale.elizacloud.ai` → CNAME/ALIAS → Railway public domain for the headscale service.
- `tunnel.elizacloud.ai` AND `*.tunnel.elizacloud.ai` → CNAME/ALIAS → Railway public domain for the tunnel-proxy service.
- Railway terminates public TLS for the tunnel-proxy custom domains; the proxy then uses `tsnet` to reach private tailnet hosts.

## 2. Headscale Railway service

```
cd cloud/services/headscale
# Push to a Railway service backed by this Dockerfile.
railway up
```

Then inside the running container:

```
headscale users create agent
headscale users create tunnel
headscale apikeys create --expiration=8760h
```

Mount a Railway volume at `/var/lib/headscale` so the SQLite DB and generated keys persist across restarts.
Do not set a Railway start-command override; the Dockerfile starts Headscale with `CMD ["headscale", "serve"]`.

## 3. Long-lived headscale preauth key for the proxy

```
# Run inside the headscale container
headscale preauthkeys create --reusable --expiration 8760h --tags tag:eliza-proxy
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
| `TUNNEL_PROXY_HOST` | `tunnel.elizacloud.ai` |
| `TUNNEL_TAILNET_DOMAIN` | `tunnel.eliza.local` |
| `TUNNEL_HOSTNAME_SIGNING_SECRET` | shared HMAC secret also set as a Worker secret |

Mount a Railway volume at `/var/lib/tunnel-proxy` so the `tsnet` node identity persists across restarts.

## 5. API Worker secrets

On the cloud-api Worker (Cloudflare):

```
wrangler secret put HEADSCALE_API_KEY          # from step 2
wrangler secret put CLOUD_INTERNAL_TOKEN       # same value as the proxy
wrangler secret put HEADSCALE_INTERNAL_TOKEN   # same value as CLOUD_INTERNAL_TOKEN
wrangler secret put TUNNEL_HOSTNAME_SIGNING_SECRET
```

`HEADSCALE_PUBLIC_URL`, `HEADSCALE_API_URL`, `HEADSCALE_USER`, `TUNNEL_PROXY_HOST`, `TUNNEL_TAILNET_DOMAIN`, and `TUNNEL_AUTH_KEY_COST_USD` are non-secret Worker vars in `apps/api/wrangler.toml`. The tunnel cost is a small on-demand org-credit debit per successful auth-key provisioning, not a subscription. Do not set `TUNNEL_ALLOW_UNSIGNED_HOSTNAMES` in production.

## 6. Worker deploy

```
cd cloud
bun run --cwd apps/api codegen
bun run build:api
bun run deploy:api -- --env production
```

## 7. Smoke test

From a machine with the tailscale CLI installed and `@elizaos/plugin-tailscale` enabled with `ELIZAOS_CLOUD_API_KEY` set:

```
# In an agent prompt:
> start tunnel on port 3000
```

You should see:
- The agent host appear under `headscale nodes list`
- A 200 response from `https://<sessionId>.tunnel.elizacloud.ai`
- An immediate debit row in `credit_transactions` with `metadata.type = "tunnel"` and `metadata.billing_model = "on_demand"`

## 8. Verify ACL isolation

The agent fleet (`tag:agent`) must NOT be reachable from a customer tunnel (`tag:eliza-tunnel`). After a tunnel is up, run from the tunnel node:

```
tailscale ping -c 1 <some agent container's tailnet IP>
```

This should fail with "no path". Do not add Tailscale-style `tests` blocks to `acl.hujson`; Headscale v0.28 rejects that field at startup.
