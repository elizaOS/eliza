# #13415 — cloud-shared fallback sweep slice 5: containers / provisioning

Hetzner/DigitalOcean cloud-API clients, warm-pool, autoscaler, registry probe.
Verified untouched by every in-flight fallback-sweep branch at file level.

## Behavioral fail-closed fixes (path/line/verdict)

| location | before | after |
|---|---|---|
| agent-warm-pool-creator.destroyPoolContainer | `.catch(() => undefined)` → phantom leaked pool row read as success | propagates to WarmPoolManager as failed destroy (verified `deletePoolEntry` returns false on already-gone rows) |
| hetzner-client/{client,registry,docker-stats}, hetzner-volumes, digitalocean-provider | cloud-API catch swallowing failed create/delete/list → empty/null/success | propagate; designed-empty (real empty 200, idempotent no-op) stays distinct |
| hetzner-client/docker-stats.parseDockerStats | `parseFloat` accepted partial tokens (`12.3.4%`→`12.3`, `1.2.3MB`→`1.2`, `.`→`NaN`) — corrupt docker output read as healthy metrics | strict whole-token parse (`\d+(\.\d+)?` regex + `Number()`); malformed → `invalid_input` throw. Regression tests added for partial/multi-dot/NaN/trailing-garbage/exponent tokens |
| registry-probe (J7 ghcr best-effort), forwarded-database-url-guard (J3 untrusted-input), warm-pool health (J4) | unannotated | annotated |

## Verification
- 114+ containers error-path `bun:test` suites pass under `--isolate` (the CI invocation).
- existing containers suites 369 pass / 0 fail (no regression).
- `biome check` clean; `audit:error-policy-ratchet` → "no new fallback-slop"; typecheck adds 0 new errors in touched files (pre-existing repo-wide drizzle-orm declaration noise unrelated).
- Money guard honored (provisioning-cost arithmetic untouched/flagged).

## N/A
UI screenshots / model trajectories / audio — N/A (infra provisioning services). Runtime traces — the changed paths are lower-level provider/unit coverage proven by the error-path unit tests above; a full `cloud:mock` request/response trace is N/A for these provider-client units (no route surface added).
