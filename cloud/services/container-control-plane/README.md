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
