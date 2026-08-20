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
| `ELIZA_PROVISIONING_SSH_KNOWN_HOSTS` | secret | Independently verified host-key line for `ELIZA_PROVISIONING_HOST`; obtain the fingerprint from the Hetzner console or an existing trusted operator inventory, never from deployment-time `ssh-keyscan` alone. |
| `HEADSCALE_API_KEY` | secret | Existing Headscale API key; create/rotate on the host with `headscale apikeys create --expiration=8760h`. |
| `AGENT_TOKEN_PRIVATE_KEY_PEM` | secret | Optional but launch-critical when steward agent JWT auth is enabled; must match the Worker secret. |
| `ELIZA_LOCAL_ROOT_KEY` | secret | Optional but launch-critical for local root-token paths; must match the Worker secret. |
| `HEADSCALE_PUBLIC_URL` | variable | `https://headscale-staging.eliza.app` or `https://headscale.eliza.app`. |

`HEADSCALE_PUBLIC_URL` is always the canonical Eliza URL and remains the only
value written to Headscale `server_url` and the provisioning daemon. During the
domain migration, the arm workflow derives the matching legacy exact hostname
from the selected environment. Operators do not provide or override that alias.

### Run the arm workflow

```bash
gh workflow run arm-headscale-control-plane.yml --repo elizaOS/eliza --ref main \
  -f environment=production -f operation=converge
```

> `workflow_dispatch` runs the copy of the workflow on the dispatched ref, so
> production is accepted only from `main`, while staging is accepted only from
> `develop`. Checkout is pinned to the dispatched `github.sha` with persisted
> Git credentials disabled. Test the change on staging after it merges to
> `develop`; do not dispatch a feature branch.

The workflow:

1. writes the committed `acl.hujson` to `/etc/headscale/acl.hujson`;
2. ensures the package-compatible `headscale` system user and group exist,
   including on legacy hosts where the binary was installed manually;
3. converges `server_url`, `listen_addr`, metrics, and gRPC addresses in
   `/etc/headscale/config.yaml`; the canonical hostname selects fixed loopback
   API/listen values, and dispatch callers cannot override them;
4. ensures Headscale users `agent` and `tunnel` exist;
5. upserts `HEADSCALE_PUBLIC_URL`, `HEADSCALE_API_URL`,
   `HEADSCALE_API_KEY`, `HEADSCALE_USER`, and optional agent-token secrets into
   `/opt/eliza/cloud/.env.local`;
6. obtains or expands one Let's Encrypt certificate whose SANs cover both the
   canonical and legacy exact hostnames, then serves both names from the same
   no-http2 nginx vhost; after the ACME vhost is gone, `nginx -T` must report no
   conflicting-name warning and only `/etc/nginx/conf.d/headscale.conf` may own
   either exact hostname, exactly once on HTTP and HTTPS; every arm also
   installs a root-owned certbot deploy hook that requires both SANs and a valid
   nginx config before reload, and fails unless `certbot.timer` is enabled and
   active;
7. restarts `headscale` and `eliza-provisioning-worker.service`;
8. fails unless local health and both public HTTPS health endpoints are green,
   and both public SNI names serve the same leaf fingerprint whose SANs contain
   both exact hostnames, with normal certificate verification.

The ACME and final vhost bytes are staged before installation. Rollback traps
are installed before either loaded config path is changed. If `nginx -t`,
reload, effective ownership, or exact-SAN validation fails, the script restores
the prior file bytes and reloads the prior valid config. An ownership failure
prints only the conflicting config paths and hostnames, leaves unknown nginx
files untouched, and fails the workflow. Review the explicit conflict path and
land a separate targeted cleanup; do not add a generic config deletion rule.
Certificate expansion can succeed before a later vhost ownership failure, but
the prior active vhost is still restored.

Staging has one separately reviewed retirement path for the legacy manual
vhost discovered by the fail-closed ownership audit:
`/etc/nginx/conf.d/headscale-staging.conf`. Inspect it first without changing
the host:

```bash
gh workflow run arm-headscale-control-plane.yml --repo elizaOS/eliza \
  --ref develop -f environment=staging -f operation=inspect-legacy-vhost
```

The inspection requires a regular, root-owned, non-group/world-writable file,
exactly two server blocks that name only `headscale-staging.elizacloud.ai`, and
exactly two loaded nginx owners from that path. A file-local websocket upgrade
map may use nginx's exact `$variable` or `${variable}` spelling, may wrap either
in balanced single or double quotes, and may place its opening brace on the
header or the immediately following line. Its empty-string key may use nginx's
equivalent single or double quotes. The source must be exactly `http_upgrade`;
the output may use a different valid nginx variable name only when `nginx -T`
proves it has no reference outside the exact reviewed file, except for the
reviewed migration overlap of exactly two references in the managed
`/etc/nginx/conf.d/headscale.conf`. That managed file is transactionally
replaced with the self-contained canonical vhost before the legacy file is
removed, and the validator runs again before deletion. Any other path, count,
or mixed owner remains fail-closed. Mismatched quotes, an altered source,
additional tokens or entries, and an intervening header line also fail closed.
When an external reference blocks retirement, the diagnostic reports only its
loaded nginx config path and reference count; it never prints the variable or
directive value. The inspection reports file metadata,
SHA-256, directive-name counts, and the validated server-block/name/map shape
for review without printing directive literal values. If the map is rejected,
only structural counts are printed so operators can distinguish formatting
drift from an additional entry without exposing values. A rejected map also
reports only the candidate count, field count, exact/other/mismatched token-form
categories, extra-field presence, and brace placement; it never prints a token
or directive value. Only after that run is reviewed may an operator select the
retirement operation and supply that exact lowercase digest:

```bash
gh workflow run arm-headscale-control-plane.yml --repo elizaOS/eliza \
  --ref develop -f environment=staging \
  -f operation=retire-legacy-vhost-and-converge \
  -f reviewed_legacy_vhost_sha256=<LOWERCASE_SHA256_FROM_INSPECTION>
```

The digest makes the reviewed bytes the retirement authority; any intervening
file change fails closed. The arm backs up the exact file,
installs the canonical dual-name vhost, removes the legacy file only after the
rollback trap is active, then validates ownership, SANs, nginx, and public
health before converging router enrollment, environment writes, the worker
restart, and final service liveness. Any failure before all remote convergence
passes restores both prior files and reloads the previous valid configuration.
Production has no registered cleanup path and rejects both legacy-file
operations.

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
node packages/cloud/scripts/admin/arm-headscale-control-plane.mjs \
  --host <control-plane-ip> \
  --ssh-key <deploy-key> \
  --ssh-known-hosts <verified-known-hosts-file> \
  --headscale-public-url https://headscale.eliza.app \
  --headscale-legacy-public-url https://headscale.elizacloud.ai \
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
> `/etc/headscale/config.yaml` by the control-plane operator flow.

## 1. DNS

- `headscale.eliza.app` / `headscale-staging.eliza.app` → A-record → the
  Hetzner control-plane VM (`eliza-production-1` / `eliza-staging-1`), with
  nginx + Let's Encrypt terminating TLS in front of local headscale. The
  matching `headscale.elizacloud.ai` / `headscale-staging.elizacloud.ai` record
  remains pointed at the same VM during migration and is covered by the same
  certificate. These are NOT CNAMEs to Railway — the Railway headscale service
  was removed (see note above).
- `tunnel.eliza.app` AND `*.tunnel.eliza.app` → CNAME/ALIAS → Railway public domain for the tunnel-proxy service.
- Railway terminates public TLS for the tunnel-proxy custom domains; the proxy then uses `tsnet` to reach private tailnet hosts.

### Retiring the legacy Headscale hostname

Legacy retirement is a separate reviewed operation after Worker, tunnel proxy,
agent, and access-log evidence shows no remaining legacy clients. Remove the
legacy nginx `server_name`, certificate SAN, and DNS record together; then
re-run the arm and public-health proofs using the retirement-aware workflow
revision. Do not delete the DNS record or legacy SAN while this overlap contract
is active, and do not change `HEADSCALE_PUBLIC_URL` away from the canonical
Eliza URL.

## 2. Protected tunnel-proxy convergence

Dispatch `.github/workflows/deploy-tunnel-proxy.yml` against `develop` for
staging or `main` for production. GitHub Environment approvals protect the
Railway token, control-plane SSH identity, and shared tunnel signer. The
workflow resolves the numeric `tunnel` user on the control-plane VM, mints a
reusable one-year `tag:eliza-proxy` preauth key, and publishes it to Railway
through stdin without logging or persisting it as a GitHub secret.
`ELIZA_PROVISIONING_SSH_KNOWN_HOSTS` must contain the independently verified
host-key line for `ELIZA_PROVISIONING_HOST`; the workflow uses strict host-key
checking and never learns trust from the deployment connection itself.

The workflow converges these service variables:

| Var | Value |
|---|---|
| `HEADSCALE_PUBLIC_URL` | `https://headscale.eliza.app` |
| `TUNNEL_PROXY_TS_AUTHKEY` | workflow-minted reusable `tag:eliza-proxy` key |
| `TUNNEL_PROXY_HOST` | `tunnel.eliza.app` |
| `TUNNEL_TAILNET_DOMAIN` | `tunnel.eliza.local` |
| `TUNNEL_HOSTNAME_SIGNING_SECRET` | shared HMAC secret also set as a Worker secret |

Mount a Railway volume at `/var/lib/tunnel-proxy` so the `tsnet` node identity persists across restarts.

It also attaches and verifies both `tunnel.eliza.app` and
`*.tunnel.eliza.app` (or the staging pair), deploys the committed service
directory, proves `/health`, proves arbitrary unsigned wildcard labels return
404, and only then expires superseded reusable proxy keys. If the Railway
domains are not DNS-verified, the workflow stops before live smoke and retains
the old keys. Copy the exact reviewed inventory from the workflow summary into
the protected `RAILWAY_TUNNEL_DNS_RECORDS_JSON` environment variable, add each
existing Cloudflare record ID to `DNS_RECORD_IMPORT_IDS_JSON` under its
`railway-tunnel/<logical-key>` import key, and apply the `Infrastructure
pages-domains` workflow. Rerun the tunnel deployment after Terraform owns the
records. The tunnel apex, wildcard route, wildcard certificate challenge, and
verification records remain DNS-only so Railway terminates TLS; this path does
not require Cloudflare Advanced Certificate Manager.

## 3. API Worker secrets

On the cloud-api Worker (Cloudflare):

```
wrangler secret put HEADSCALE_API_KEY          # created on the CP host
wrangler secret put CLOUD_INTERNAL_TOKEN       # same value as the proxy
wrangler secret put HEADSCALE_INTERNAL_TOKEN   # same value as CLOUD_INTERNAL_TOKEN
wrangler secret put TUNNEL_HOSTNAME_SIGNING_SECRET
```

For normal protected deployments, store one value as the
`TUNNEL_HOSTNAME_SIGNING_SECRET` GitHub Environment secret instead of entering
it independently at each provider. `cloud-cf-deploy.yml` publishes it to the
Worker and `deploy-tunnel-proxy.yml` publishes the same value to Railway. A
first adoption still requires an intentional rotation because existing
provider-side secret values cannot be read back for comparison.

`HEADSCALE_PUBLIC_URL`, `HEADSCALE_API_URL`, `HEADSCALE_USER`, `TUNNEL_PROXY_HOST`, `TUNNEL_TAILNET_DOMAIN`, and `TUNNEL_AUTH_KEY_COST_USD` are non-secret Worker vars in `apps/api/wrangler.toml`. The tunnel cost is a small on-demand org-credit debit per successful auth-key provisioning, not a subscription. Do not set `TUNNEL_ALLOW_UNSIGNED_HOSTNAMES` in production.

## 4. Worker deploy

```
cd cloud
bun run --cwd apps/api codegen
bun run build:api
bun run deploy:api -- --env production
```

## 5. Smoke test

From a machine with the tailscale CLI installed and `@elizaos/plugin-tailscale` enabled with `ELIZAOS_CLOUD_API_KEY` set:

```
# In an agent prompt:
> start tunnel on port 3000
```

You should see:
- The agent host appear under `headscale nodes list`
- A 200 response from `https://<sessionId>.tunnel.eliza.app`
- An immediate debit row in `credit_transactions` with `metadata.type = "tunnel"` and `metadata.billing_model = "on_demand"`

## 6. Verify ACL isolation

The agent fleet (`tag:agent`) must NOT be reachable from a customer tunnel (`tag:eliza-tunnel`). After a tunnel is up, run from the tunnel node:

```
tailscale ping -c 1 <some agent container's tailnet IP>
```

This should fail with "no path". Do not add Tailscale-style `tests` blocks to `acl.hujson`; Headscale v0.28 rejects that field at startup.

After the #22945 phase-2 removal PR lands, additionally verify from the Railway tunnel proxy that no `tag:agent` IP is reachable (the CP router on `tag:eliza-cp` must still reach `tag:agent:2138`). During phase 1 the tunnel proxy retains agent reach by design — do not treat that as a failure.
