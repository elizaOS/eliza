# Deploying Headscale / tunnel infrastructure

End-to-end checklist to bring the Headscale-backed tailnet online. Headscale is
the coordination server for both internal agent containers and customer tunnel
nodes. It runs on the Hetzner control-plane VM so agent provisioning and the
provisioning worker share a private, loopback API.

> **Railway runtime removed (2026-06-17).** The previously Railway-hosted
> Headscale service (staging + prod, in the `eliza-cloud` project) has been
> deleted. It was already dead weight: `headscale.elizacloud.ai` and
> `headscale-staging.elizacloud.ai` resolve to the Hetzner control-plane VM
> (A records, not the Railway custom-domain binding), so the Railway service
> was not the live coordination server for either env. Headscale now runs only
> on the Hetzner control-plane VM via the workflow below. The `Dockerfile`,
> `entrypoint.sh`, `railway.toml`, `config.yaml`, and the `cloud-headscale.yml`
> deploy workflow that backed the Railway service have been removed from this
> directory; `acl.hujson` stays because the Hetzner arm workflow deploys it.
> The customer-tunnel proxy (`tunnel-proxy` Railway service +
> `/api/v1/apis/tunnels/tailscale/auth-key` Worker route) points at
> `headscale.elizacloud.ai`, which now resolves to the Hetzner headscale — the
> arm workflow provisions the `tunnel` user and the `tag:eliza-tunnel` /
> `tag:eliza-proxy` ACLs there — so that path continues to coordinate against
> Hetzner; only the redundant Railway headscale was removed.

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

