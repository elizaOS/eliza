# Issue #12884 evidence: coding remote runner command/env exposure

## Summary

- `POST /v1/processes/run` and `PUT /v1/fs/file` now require a configured bearer token even when `ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED=1`.
- Spawned commands receive only an allowlisted subset of runner process env plus caller-supplied env values.
- `ELIZA_REMOTE_RUNNER_HTTP_TOKEN` and `REMOTE_RUNNER_HTTP_TOKEN` are denied even when present in caller env or the operator env allowlist.
- Default bind address is `127.0.0.1`; wider exposure requires explicit `HOST`.

## Verification

- `bun run --cwd packages/cloud/services/coding-remote-runner test`
  - Passed: 13 tests, 0 failed.
- `bun run --cwd packages/cloud/services/coding-remote-runner typecheck`
  - Passed.
- `bunx biome check packages/cloud/services/coding-remote-runner/src/index.ts packages/cloud/services/coding-remote-runner/__tests__/server.test.ts`
  - Passed.

## Live local runner trace

Started the real service via `Bun.serve`:

```bash
env HOST=127.0.0.1 PORT=39884 \
  ELIZA_CODING_WORKSPACE=/tmp/eliza-12884-runner-workspace \
  ELIZA_REMOTE_RUNNER_HTTP_TOKEN=token \
  SECRET_CLOUD_KEY=leak-me \
  bun run --cwd packages/cloud/services/coding-remote-runner start
```

Startup log:

```json
{"level":"info","message":"[CodingRemoteRunner] listening","hostname":"127.0.0.1","port":39884,"workspaceRoot":"/tmp/eliza-12884-runner-workspace","authConfigured":true}
```

Authenticated health:

```text
GET /v1/health
Authorization: Bearer token

HTTP/1.1 200 OK
{"ok":true,"id":"eliza.coding-remote-runner","capabilities":["fs.list","fs.read","fs.write","process.run"]}
```

Unauthenticated command execution is rejected before the command runner:

```text
POST /v1/processes/run

HTTP/1.1 401 Unauthorized
{"error":"Unauthorized"}
```

Unauthenticated workspace write is rejected:

```text
PUT /v1/fs/file?path=blocked.txt

HTTP/1.1 401 Unauthorized
{"error":"Unauthorized"}
```

Authenticated command env filtering:

```bash
curl -X POST \
  -H 'Authorization: Bearer token' \
  -H 'content-type: application/json' \
  --data '{"command":"/usr/bin/env","args":[],"cwd":".","env":{"ELIZA_REMOTE_RUNNER_HTTP_TOKEN":"caller-token","CALLER_VAR":"ok"},"timeoutMs":5000}' \
  http://127.0.0.1:39884/v1/processes/run
```

Observed output included the caller-supplied non-secret env:

```text
CALLER_VAR=ok
ELIZA_CODING_WORKSPACE=/tmp/eliza-12884-runner-workspace
```

Observed output did not include either of these values:

```text
ELIZA_REMOTE_RUNNER_HTTP_TOKEN
SECRET_CLOUD_KEY
```

## Unauthenticated escape-hatch trace

Started the real service with no token and read-only unauthenticated mode:

```bash
env HOST=127.0.0.1 PORT=39885 \
  ELIZA_CODING_WORKSPACE=/tmp/eliza-12884-runner-workspace \
  ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED=1 \
  bun run --cwd packages/cloud/services/coding-remote-runner start
```

Startup log:

```json
{"level":"info","message":"[CodingRemoteRunner] listening","hostname":"127.0.0.1","port":39885,"workspaceRoot":"/tmp/eliza-12884-runner-workspace","authConfigured":false}
```

Read-only routes remained available:

```text
GET /v1/health
HTTP/1.1 200 OK

GET /v1/fs/file?path=pub.txt
HTTP/1.1 200 OK
pub
```

Mutating/execution routes stayed fail-closed:

```text
POST /v1/processes/run
HTTP/1.1 503 Service Unavailable
{"error":"Remote runner token is required for this route"}

PUT /v1/fs/file?path=blocked.txt
HTTP/1.1 503 Service Unavailable
{"error":"Remote runner token is required for this route"}
```

## Container lane

- Attempted Docker evidence with:

```bash
docker build --build-arg INSTALL_CODEX=false \
  --build-arg INSTALL_CLAUDE_CODE=false \
  --build-arg INSTALL_OPENCODE=false \
  -t eliza-coding-remote-runner-12884:local \
  packages/cloud/services/coding-remote-runner
```

- N/A in this checkout: Docker Desktop daemon is not running.

```text
Cannot connect to the Docker daemon at unix:///Users/shawwalters/.docker/run/docker.sock. Is the docker daemon running?
```

## UI/model/audio evidence

N/A - hosted-agent security hardening in a standalone HTTP runner; no UI, model, or audio path is involved.

