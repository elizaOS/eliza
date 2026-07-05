# 13725 — bare agent server enforces the runtime-mode gate + remote forwarder

Real end-to-end probes against the BARE `@elizaos/agent` server (the exact
`startApiServer` root `bun run start` binds — no app-core wrapper), booted with
`bun --conditions=eliza-source` against a scratch `ELIZA_STATE_DIR`. The
"remote target" is a real loopback HTTP server that records every request it
receives. No mocks.

Config for the remote phases:

```json
{
  "deploymentTarget": {
    "runtime": "remote",
    "remoteApiBase": "http://127.0.0.1:59999",
    "remoteAccessToken": "dm1-verify-token"
  }
}
```

## Before (develop `d84a4eafef`, ungated)

```
[eliza-api] Listening on http://127.0.0.1:4834
--- mode=remote (deploymentTarget.runtime=remote) ---
GET /api/local-inference/hub -> 200 {"catalog":[{"id":"eliza-1-2b","displayName":"eliza-1-2B","hfRepo":"elizaos/eliza-1",...
POST /api/cloud/login -> 200 {"ok":true,"sessionId":"3e554381-dc84-4517-a06c-3abf9c38a35c","browserUrl":"https://elizacloud.ai/auth/cli-login?session=3e554381-dc84-4517-a06c-3abf9c38a35c"}
target hits: []
```

- The local-model catalog is served in remote mode (matrix:
  `/api/local-inference/` is `local`/`local-only` only).
- `POST /api/cloud/login` executed LOCALLY and opened a real elizacloud CLI
  login session on the controller; the configured target received **zero**
  requests.

## After (this fix)

```
[eliza-api] Listening on http://127.0.0.1:4834
--- mode=remote (deploymentTarget.runtime=remote) ---
GET /api/local-inference/hub -> 404 {"error":"Not found"}
POST /api/cloud/login -> 200 {"forwardedToTarget":true}
target hits: [{"method":"POST","url":"/api/cloud/login","auth":"Bearer dm1-verify-token"}]
```

- Hidden route is a plain 404 (mode state not probeable).
- The cloud mutation reached the target with the controller's
  `remoteAccessToken` as the bearer, and the target's response body/status were
  relayed to the caller.

## Regression test (fails on the bug)

`packages/agent/test/api/runtime-mode-gate.real-server.test.ts` spawns the same
bare server as a real `bun` child process and drives the phases above plus
cloud-mode hiding, the no-target 400, read/OPTIONS passthrough, and
default-local reachability.

- On the fixed tree: `Test Files 1 passed — Tests 6 passed`.
- With the `handleRuntimeModePreDispatch` call in
  `packages/agent/src/api/server.ts` disabled (= develop behavior): 4 of 6
  fail — the remote-hide, remote-forward, no-target-reject, and cloud-hide
  assertions.

## Suite runs (fixed tree)

- `packages/agent`: runtime-mode unit + e2e — 5 files / 53 tests passed.
- `packages/app-core`: server pipeline tests (`server-reset-hop`,
  `route-auth-policy.dispatch`, `server-compat-route-chain.guard`,
  `first-run-persistence.restart`) — 4 files / 20 tests passed.
- Typecheck parity vs pristine develop in the same environment (unbuilt-dist
  noise identical): `packages/agent` 72 → 72 errors, `packages/app-core`
  41 → 41 errors, none in the changed files.

## N/A

- Screenshots / video / trajectories: N/A — headless HTTP contract change; no
  UI surface or model behavior touched. The probes above are the domain
  artifacts.

Discovered and fixed while QA-ing the desktop local/remote runtime-mode
toggle. The local-only leg turned up a separate pre-existing resolver hole,
filed as #13726. — [core-brain]
