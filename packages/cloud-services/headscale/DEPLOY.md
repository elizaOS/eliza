# Deploying Headscale / tunnel infrastructure

End-to-end checklist to bring the Headscale-backed tailnet online. Headscale is
the coordination server for both internal agent containers and customer tunnel
nodes. The runtime can be hosted on Railway for the customer-tunnel service, but
the launch control-plane path runs Headscale on the Hetzner control-plane VM so
agent provisioning and the provisioning worker share a private, loopback API.

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

## Railway runtime (customer-tunnel legacy/service path)

The rest of this document covers the Railway-hosted tunnel stack. Keep it for
the customer-tunnel service and for historical context, but do not use it to arm
the Hetzner provisioning-worker host.

## 1. DNS

- `headscale.elizacloud.ai` → CNAME/ALIAS → Railway public domain for the headscale service.
- `tunnel.elizacloud.ai` AND `*.tunnel.elizacloud.ai` → CNAME/ALIAS → Railway public domain for the tunnel-proxy service.
- Railway terminates public TLS for the tunnel-proxy custom domains; the proxy then uses `tsnet` to reach private tailnet hosts.

## 2. Headscale Railway service

```
cd packages/cloud-services/headscale
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

### Per-environment variables

`server_url` must equal the public-facing custom domain (agents/tunnels register and re-derive control/DERP/MagicDNS against it). The entrypoint templates it from an explicit `HEADSCALE_PUBLIC_URL` Railway variable, NOT from `RAILWAY_PUBLIC_DOMAIN` (Railway injects that as the auto-generated `*.up.railway.app` host, not the custom domain). Per env:

| Environment | `HEADSCALE_PUBLIC_URL` |
|---|---|
| production | `https://headscale.elizacloud.ai` |
| staging | `https://headscale-staging.elizacloud.ai` |

You do not set this on the Railway service by hand: it lives as a **GitHub Environment variable** (below) and the CI/CD workflow syncs it onto the Railway service (`railway variables --set … --skip-deploys`) before each `railway up`. The GitHub var is the single source of truth. When the var is unset entirely, the committed `config.yaml` prod value stands.

### CI/CD (`.github/workflows/cloud-headscale.yml`)

`develop -> staging`, `main -> production`, deployed explicitly with `railway up`. Required one-time setup so this is the SOLE deploy path and it targets the right env:

- **Disable Railway's native GitHub auto-deploy** on the headscale service (Settings -> disconnect repo / no auto-deploy). Otherwise a single push triggers BOTH the native Railway deploy and the workflow's `railway up`, racing two concurrent builds of the live control plane against the single SQLite volume.
- Define two **GitHub Environments** (`staging`, `production`), each holding its own project-scoped `RAILWAY_TOKEN` bound to that Railway environment. A Railway project token is scoped to one project+environment, so per-env tokens are what make the branch->env mapping actually land in the right place; the workflow's `environment:` key resolves the matching token and applies production protection rules.
- Set `HEADSCALE_PUBLIC_URL` (above) as a GitHub Environment variable. The workflow uses it twice: it syncs it onto the Railway service (so the entrypoint's `server_url` is correct) AND points its post-deploy `/health` gate at that host. `railway up --ci` only validates the BUILD, not runtime health — the health gate is what catches a container that builds but crash-loops (bad server_url, missing volume).

> **IaC scope.** The Railway **volume** (`/var/lib/headscale`) and the **custom domain** are stateful Railway service resources — Railway's `railway.toml` only declares build + deploy config (`[build]`, `[deploy]`), so neither can be expressed there. They are one-time setup, created via the Railway dashboard or API and persisted as service state; this file is their reproducible record. `HEADSCALE_PUBLIC_URL` is the exception: it IS codified, as the GitHub Environment variable the workflow pushes to Railway on every deploy.

## 3. Long-lived headscale preauth key for the proxy

```
# Run inside the headscale container
headscale preauthkeys create --reusable --expiration 8760h --tags tag:eliza-proxy
```

Save the returned key as Railway secret `TUNNEL_PROXY_TS_AUTHKEY` on the tunnel-proxy service.

## 4. Tunnel-proxy Railway service

```
cd packages/cloud-services/tunnel-proxy
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
