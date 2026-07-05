# 13726 — local-only runtime mode survives config migration

`cloud.enabled` is the persisted opt-out bit for local-only mode. This proof
records the config-migration and live API behavior that the fix restores:
`migrateLegacyRuntimeConfig()` must prune legacy cloud routing fields without
deleting `cloud.enabled`, and the disk-backed runtime-mode resolver must then
hide `/api/cloud/*` with the standard route-mode 404.

## Live API Probe

Booted the real app-core API server (`startApiServer` plus a real
`AgentRuntime`) with `eliza.json` containing exactly:

```json
{ "cloud": { "enabled": false } }
```

Before the fix on develop `035223a063`:

```text
GET /api/runtime/mode -> {"mode":"local"} [200]
GET /api/cloud/status -> 401
```

After the fix on this branch:

```text
GET /api/runtime/mode -> {"mode":"local-only","deploymentRuntime":"local","isRemoteController":false,"remoteApiBaseConfigured":false} [200]
GET /api/cloud/status -> {"error":"Not found"} [404]
```

The same running server re-read config on each request and resolved the other
persisted modes correctly:

```text
{"deploymentTarget":{"runtime":"cloud","provider":"elizacloud"}} -> {"mode":"cloud"}
{"deploymentTarget":{"runtime":"remote","remoteApiBase":"http://192.168.1.50:2138"}} -> {"mode":"remote"}
{} -> {"mode":"local"}
{"cloud":{"enabled":false}} -> {"mode":"local-only"}
```

Guard check: in plain `local` mode, `GET /api/cloud/status` returns 401 (auth),
which proves the fix does not over-hide the cloud surface.

## Regression Tests

The branch adds two focused regression tests:

- `packages/shared/src/contracts/first-run-options.migration.test.ts`
  preserves `cloud.enabled` while still pruning legacy routing siblings.
- `packages/app-core/src/runtime/mode/runtime-mode.disk.test.ts` resolves
  runtime mode through the real `loadElizaConfig()` path in a throwaway
  `ELIZA_STATE_DIR`, the seam that was broken on develop.

Local verification reported on the PR:

```bash
bun run --cwd packages/shared build:i18n
bun run --cwd packages/core prebuild
bun test packages/app-core/src/runtime/mode/runtime-mode.disk.test.ts packages/app-core/src/runtime/mode/route-mode-matrix.test.ts
# 30 pass, 0 fail

bun test packages/shared/src/contracts/first-run-options.migration.test.ts
# 3 pass, 0 fail

bun test packages/core/src/contracts/contracts-alignment.test.ts packages/core/src/contracts/service-routing.test.ts
# 13 pass, 0 fail

bunx @biomejs/biome check packages/app-core/src/runtime/mode/runtime-mode.disk.test.ts packages/shared/src/contracts/first-run-options.migration.test.ts packages/shared/src/contracts/first-run-options.ts packages/core/src/contracts/first-run-options.ts
# pass

git diff --check origin/develop...origin/pr/13721
# pass
```

## N/A

Screenshots, video, and live-LLM trajectories are N/A: this is a deterministic
config migration and HTTP route-mode contract change, with no UI or model path.
