# Deploying Headscale / tunnel infrastructure

End-to-end checklist to bring the Headscale-backed tailnet online. Headscale is
the coordination server for both internal agent containers and customer tunnel
nodes. It runs on the Hetzner control-plane VM so agent provisioning and the
provisioning worker share a private, loopback API. The customer-facing
**tunnel-proxy** service stays on Railway, but Headscale itself is no longer
Railway-hosted (that runtime was decommissioned 2026-06-17 — see below).

Why this matters: when `HEADSCALE_API_KEY` is configured, the sandbox provider
requires a real `headscale_ip` before a container is marked `running`. That is
the safety gate that prevents a launched-but-unreachable agent from looking
healthy in prod.

## Hetzner control-plane runtime (agent launch path)

Use this for staging/prod agent provisioning. The workflow below configures the
host idempotently instead of relying on hand-edited `/etc/headscale/config.yaml`
or `/opt/eliza/cloud/.env.local`.

### Required GitHub Environment values

Set these on each GitHub Environment (`staging`, `production`):

| Name | Type | Why |
|---|---|---|
| `ELIZA_PROVISIONING_HOST` | secret | Public IP of the control-plane host; SSH hostnames are Cloudflare-proxied and do not carry TCP/22. |
| `ELIZA_PROVISIONING_SSH_KEY` | secret | Deploy-user SSH key used by the provisioning-worker deploy workflow. |
| `HEADSCALE_API_KEY` | secret | Existing Headscale API key; create/rotate on the host with `headscale apikeys create --expiration=8760h`. |
| `AGENT_TOKEN_PRIVATE_KEY_PEM` | secret | Optional but launch-critical when steward agent JWT auth is enabled; must match the Worker secret. |
| `ELIZA_LOCAL_ROOT_KEY` | secret | Optional but launch-critical for local root-token paths; must match the Worker secret. |
| `HEADSCALE_PUBLIC_URL` | variable | `https://headscale-staging.elizacloud.ai` or `https://headscale.elizacloud.ai`. |

### Run the arm workflow

```bash
gh workflow run arm-headscale-control-plane.yml --repo elizaOS/eliza --ref main \
  -f environment=production \
  -f headscale_api_url=http://127.0.0.1:8081 \
  -f listen_addr=127.0.0.1:8081
```

> `workflow_dispatch` runs the copy of the workflow on the dispatched ref, so
> `--ref main` only works once this workflow has merged to `main`. Before then,
> dispatch against the branch that already carries it (e.g. `--ref develop`).

The workflow:

1. writes the committed `acl.hujson` to `/etc/headscale/acl.hujson`;
2. converges `server_url`, `listen_addr`, metrics, and gRPC addresses in
   `/etc/headscale/config.yaml`;
3. ensures Headscale users `agent` and `tunnel` exist;
4. upserts `HEADSCALE_PUBLIC_URL`, `HEADSCALE_API_URL`,
   `HEADSCALE_API_KEY`, `HEADSCALE_USER`, and optional agent-token secrets into
   `/opt/eliza/cloud/.env.local`;
5. restarts `headscale` and `eliza-provisioning-worker.service`;
6. fails if local `/health` is not green.

The matching Cloudflare Worker secrets still need to be set through the normal
Worker secret path. Keep host and Worker values identical for
`HEADSCALE_API_KEY`, `AGENT_TOKEN_PRIVATE_KEY_PEM`, and `ELIZA_LOCAL_ROOT_KEY`;
otherwise the daemon can mint state that the Worker cannot validate.

`headscale-api-key-health.yml` probes the daemon-local user-list endpoint from
the staging control-plane host every day and fails on a missing, expired, or
rejected key. It deliberately reads `HEADSCALE_API_KEY` from the host's
`/opt/eliza/cloud/.env.local` instead of importing the admin key into the
Actions runner. Production uses the same workflow through a manual dispatch
because that GitHub Environment requires deployment approval.

### Manual equivalent

```bash
node packages/scripts/cloud/admin/arm-headscale-control-plane.mjs \
  --host <control-plane-ip> \
  --ssh-key <deploy-key> \
  --headscale-public-url https://headscale.elizacloud.ai \
  --headscale-api-url http://127.0.0.1:8081 \
  --listen-addr 127.0.0.1:8081 \
  --headscale-api-key "$HEADSCALE_API_KEY"
```

Do not paste a newly generated API key into issue comments or workflow inputs.
Generate it on the host, store it as a GitHub/Worker secret, and let the script
consume it from the environment.

## Railway runtime (customer-tunnel path only)

The rest of this document covers the Railway-hosted **tunnel-proxy** stack — the
customer-tunnel path that legitimately stays on Railway. Do not use it to arm the
Hetzner provisioning-worker host.

> **Headscale itself no longer runs on Railway.** The previous Railway-hosted
> Headscale runtime was decommissioned on 2026-06-17, along with its
> `Dockerfile`, `entrypoint.sh`, `railway.toml`, `config.yaml`, and the
> `.github/workflows/cloud-headscale.yml` deploy workflow (this directory now
> ships only `DEPLOY.md`, `README.md`, and `acl.hujson`). The headscale
> coordination server runs **on the Hetzner control-plane VM** — see the
> "Hetzner control-plane runtime (agent launch path)" section above. There is no
> headscale Railway service to `railway up`; users/api-keys are created on the
> CP host (`headscale users create agent`, `headscale apikeys create
> --expiration=8760h`), and `server_url` is converged into
> `/etc/headscale/config.yaml` on the CP by `arm-headscale-control-plane.yml`.

## 1. DNS

- `headscale.elizacloud.ai` / `headscale-staging.elizacloud.ai` → A-record → the
  Hetzner control-plane VM (`eliza-production-1` / `eliza-staging-1`), with
  nginx + Let's Encrypt terminating TLS in front of local headscale. NOT a CNAME
  to Railway — the Railway headscale service was removed (see note above).
- `tunnel.elizacloud.ai` AND `*.tunnel.elizacloud.ai` → CNAME/ALIAS → Railway public domain for the tunnel-proxy service.
- Railway terminates public TLS for the tunnel-proxy custom domains; the proxy then uses `tsnet` to reach private tailnet hosts.

## 2. Long-lived headscale preauth key for the proxy

```
# Run on the control-plane VM (where headscale lives)
headscale preauthkeys create --reusable --expiration 8760h --tags tag:eliza-proxy
```

Save the returned key as Railway secret `TUNNEL_PROXY_TS_AUTHKEY` on the tunnel-proxy service.

## 3. Tunnel-proxy Railway service

```
cd packages/cloud/services/tunnel-proxy
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

## 4. API Worker secrets

On the cloud-api Worker (Cloudflare):

```
wrangler secret put HEADSCALE_API_KEY          # created on the CP host
wrangler secret put CLOUD_INTERNAL_TOKEN       # same value as the proxy
wrangler secret put HEADSCALE_INTERNAL_TOKEN   # same value as CLOUD_INTERNAL_TOKEN
wrangler secret put TUNNEL_HOSTNAME_SIGNING_SECRET
```

`HEADSCALE_PUBLIC_URL`, `HEADSCALE_API_URL`, `HEADSCALE_USER`, `TUNNEL_PROXY_HOST`, `TUNNEL_TAILNET_DOMAIN`, and `TUNNEL_AUTH_KEY_COST_USD` are non-secret Worker vars in `apps/api/wrangler.toml`. The tunnel cost is a small on-demand org-credit debit per successful auth-key provisioning, not a subscription. Do not set `TUNNEL_ALLOW_UNSIGNED_HOSTNAMES` in production.

## 5. Worker deploy

```
cd cloud
bun run --cwd apps/api codegen
bun run build:api
bun run deploy:api -- --env production
```

## 6. Smoke test

From a machine with the tailscale CLI installed and `@elizaos/plugin-tailscale` enabled with `ELIZAOS_CLOUD_API_KEY` set:

```
# In an agent prompt:
> start tunnel on port 3000
```

You should see:
- The agent host appear under `headscale nodes list`
- A 200 response from `https://<sessionId>.tunnel.elizacloud.ai`
- An immediate debit row in `credit_transactions` with `metadata.type = "tunnel"` and `metadata.billing_model = "on_demand"`

## 7. Verify ACL isolation

The agent fleet (`tag:agent`) must NOT be reachable from a customer tunnel (`tag:eliza-tunnel`). After a tunnel is up, run from the tunnel node:

```
tailscale ping -c 1 <some agent container's tailnet IP>
```

This should fail with "no path". Do not add Tailscale-style `tests` blocks to `acl.hujson`; Headscale v0.28 rejects that field at startup.
