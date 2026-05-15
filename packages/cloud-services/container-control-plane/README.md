# Container Control Plane

Node/Bun sidecar for Eliza Cloud user containers. Cloudflare Workers cannot run
the Hetzner-Docker client because it depends on SSH, so Worker routes forward
container mutations here when `CONTAINER_CONTROL_PLANE_URL` is configured.

## Run

```bash
PORT=8791 bun run --cwd services/container-control-plane start
```

Point the Worker at it:

```bash
CONTAINER_CONTROL_PLANE_URL=http://127.0.0.1:8791
CONTAINER_CONTROL_PLANE_TOKEN=<optional shared secret>
```

For production Hetzner-Docker nodes, configure the sidecar with the same
database as the Worker plus Docker-node SSH credentials:

```bash
DATABASE_URL=<cloud database url>
CONTAINER_CONTROL_PLANE_TOKEN=<same value as Worker secret>
CONTAINERS_SSH_KEY=<base64 private key>
# or CONTAINERS_SSH_KEY_PATH=/path/to/private_key
CONTAINERS_SSH_USER=root
ELIZA_AGENT_IMAGE=ghcr.io/elizaos/eliza:latest
ELIZA_AGENT_HOT_POOL_PREPULL=true
```

Autoscaled Hetzner Cloud nodes need the Worker cron secrets:

```bash
HCLOUD_TOKEN=<hetzner cloud api token>
# HETZNER_CLOUD_API_KEY is also accepted as an alias.
CONTAINERS_AUTOSCALE_PUBLIC_SSH_KEY=<public key matching CONTAINERS_SSH_KEY>
CONTAINERS_BOOTSTRAP_CALLBACK_URL=https://api.elizacloud.ai/api/v1/admin/docker-nodes/bootstrap-callback
CONTAINERS_BOOTSTRAP_SECRET=<strong random secret>
```

The Worker forwards authenticated user context with:

- `x-eliza-user-id`
- `x-eliza-organization-id`
- `x-container-control-plane-token` when a shared secret is configured

When deploying private registry images, configure the sidecar with
`CONTAINERS_REGISTRY_USERNAME` and either `CONTAINERS_REGISTRY_TOKEN` or
`CONTAINERS_REGISTRY_TOKEN_FILE`. The sidecar logs Docker into the image
registry on the target node before pulling.

The sidecar owns only Node-only container operations: create, delete, restart,
env replacement, logs, and metrics. Worker-safe reads can stay on the Worker.
