# Deployment Toolkit

This directory contains the generic deployment assets for elizaOS apps: Dockerfiles, compose files, node rollout scripts, Cloudflare proxy sources, and the cloud-agent runtime helpers.

## Layout

- `deploy.defaults.env` — shared defaults loaded by the setup and rollout scripts
- `Dockerfile.ci` — canonical image for prebuilt runtime/UI artifacts
- `Dockerfile.cloud` — cloud-optimized full-app image
- `Dockerfile.cloud-agent` — subordinate cloud-agent runtime image
- `docker-compose.yml` — gateway plus interactive CLI services
- `docker-compose.supabase-db.yml` — optional local Postgres service
- `docker-setup.sh` — local image build plus compose-based onboarding flow
- `deploy-to-nodes.sh` — image load / restart helper for remote Docker nodes
- `cloudflare/eliza-cloud-proxy/` — proxy worker source and Wrangler example

## App Overrides

Create a repo-root `deploy/deploy.env` and override only what differs from `deploy.defaults.env`. The scripts look for that file in this order:

1. `DEPLOY_CONFIG`
2. `./deploy.env`
3. `../deploy/deploy.env`

`deploy-to-nodes.sh` also looks for `nodes.json` in the same order, using `DEPLOY_NODES_FILE`, `./nodes.json`, and `../deploy/nodes.json`.

## Common Commands

```bash
# Build a local image and walk through setup.
cd deploy
bash ../eliza/packages/app-core/deploy/docker-setup.sh

# Load the current image onto configured nodes.
cd deploy
bash ../eliza/packages/app-core/deploy/deploy-to-nodes.sh --status
```

## Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_NAME` | App/project name used by compose and helper output | `eliza` |
| `APP_ENTRYPOINT` | Runtime entrypoint copied into images | `app.mjs` |
| `APP_CMD_START` | Startup command for the full app container | `node --import ./node_modules/tsx/dist/loader.mjs app.mjs start` |
| `APP_IMAGE` | Local Docker image name | `eliza:local` |
| `APP_REGISTRY` | Optional registry prefix used by node rollout image matching | _empty_ |
| `APP_PORT` | Primary app/API port inside the container | `2138` |
| `APP_GATEWAY_PORT` | Gateway listener port | `18789` |
| `APP_BRIDGE_PORT` | Cloud bridge port | `18790` |
| `APP_GATEWAY_BIND` | Gateway bind preset passed to the CLI | `lan` |
| `APP_STATE_DIR` | In-container state/config directory | `/home/node/.eliza` |
| `APP_CONFIG_DIR` | Host-side config directory mounted into the container | `${HOME}/.eliza` |
| `APP_WORKSPACE_DIR` | Host-side workspace directory mounted into the container | `${HOME}/.eliza/workspace` |
| `APP_DB_NAME` | Database name for the Postgres helper compose file | `eliza` |
| `APP_API_BIND` | Default API bind address baked into the image | `127.0.0.1` |
| `OCI_SOURCE` | OCI source metadata | _empty_ |
| `OCI_TITLE` | OCI image title | `elizaOS Agent` |
| `OCI_DESCRIPTION` | OCI image description | `elizaOS agent runtime` |
| `OCI_LICENSES` | OCI image license metadata | `MIT` |
| `CF_WORKER_NAME` | Suggested Cloudflare worker name | `eliza-cloud-proxy` |
| `CF_ALLOWED_ORIGINS` | Allowed CORS origins for the proxy worker | _empty_ |
| `CF_PROXY_PATH_PREFIXES` | Comma-separated path prefixes forwarded by the proxy worker | _empty_ |
