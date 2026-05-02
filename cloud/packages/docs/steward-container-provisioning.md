# Steward-aware container provisioning

The Docker sandbox orchestrator creates newly provisioned Agent containers with Steward integration by default. Steward dashboard calls are handled by the Eliza Cloud API Worker directly; containers only receive the Steward env needed by the agent runtime.

## What changed

- New containers now receive these env vars automatically:
  - `ELIZA_CLOUD_PROVISIONED=1`
  - `STEWARD_API_URL=<container-reachable steward URL>`
  - `STEWARD_AGENT_ID=<agent-id>`
  - `STEWARD_AGENT_TOKEN=<minted during provisioning>`
- Provisioning now registers the agent in Steward on the target node before container start:
  - `POST /agents`
  - `POST /agents/:agentId/token`
- New containers are attached to `agent-isolated` by default
  - Overrideable with `AGENT_DOCKER_NETWORK`
- Docker healthcheck now targets `ELIZA_PORT` instead of legacy `ELIZA_PORT`

## Steward URL Resolution

Cloud-side registration uses `STEWARD_API_URL` from the Worker binding environment, falling back to `NEXT_PUBLIC_STEWARD_API_URL`, then the embedded Worker mount at `NEXT_PUBLIC_API_URL + /steward`. Local development should set one of those values explicitly, usually `http://localhost:8787/steward`.

Container-side `STEWARD_API_URL` is resolved separately through `resolveStewardContainerUrl()` so a Docker container is never handed an unreachable host-local `localhost` URL. Set `STEWARD_CONTAINER_URL` only when the default host mapping is not correct for the Docker node.

## Scope

These changes only affect newly created Docker sandboxes. Running containers are not modified.
