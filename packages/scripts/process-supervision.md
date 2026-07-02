# Process Supervision Boundaries

Issue #11366 asked whether the dev orchestrators and the cross-package test
runner should share one child-process supervision/fan-out helper. The decision
for the current code is: keep the seams separate and document why.

## Decision

Do not extract a shared helper between:

- `packages/app-core/scripts/lib/api-supervisor.mjs`
- `packages/app-core/scripts/dev-ui.mjs`
- `packages/app-core/scripts/dev-platform.mjs`
- `packages/scripts/dev-all.mjs`
- `packages/scripts/run-all-tests.mjs`
- `packages/scripts/lib/test-task-pool.mjs`

They all spawn children, but the identical part is too small to carry the real
behavior safely. A shared abstraction today would mostly be switches for
different lifecycles, not a simpler production seam.

## Why They Stay Separate

`api-supervisor.mjs` is a long-lived single-child supervisor. Its contract is to
keep the API server alive across intentional restarts and non-shutdown exits. It
tracks a rolling crash streak, relaunches after exit 0 / 75 / other non-shutdown
exits, treats source-watch reloads as intentional, escalates a stuck restart
from `SIGTERM` to `SIGKILL`, and gives up only after the restart window trips.

`dev-ui.mjs` and `dev-platform.mjs` wrap that API supervisor, but each owns
different process-tree and stream behavior. `dev-ui.mjs` filters API startup
noise, supervises Vite with its own restart guard, and coordinates API/UI hot
reloads. `dev-platform.mjs` prefixes several processes, allocates ports, and
shuts down API/Vite/Electrobun as one terminal session when the desktop app
quits or a signal arrives.

`dev-all.mjs` is a long-lived stack launcher, not a restart supervisor. It
starts several detached services, waits for dependent ports, prefixes each
service stream, and stops the whole stack when any service exits. Its shutdown
contract is process-group termination followed by a fixed `SIGKILL` fallback.

`run-all-tests.mjs` is a bounded batch runner. It never respawns a failed test
child. In serial mode it preserves the historical fail-fast behavior. In
parallel mode it partitions tasks through `test-task-pool.mjs`, buffers pooled
child output so logs do not interleave, runs every parallel-safe task to
completion, drains the unsafe tasks serially, and reports all failures together.
Its sharding contract is stable package bucketing via
`digest.readUInt32BE(0)`.

## Extraction Criteria

A future shared helper is allowed only if two callers have the same answers for
all of these:

- child lifetime: one long-lived child, long-lived stack, or bounded batch task
- exit semantics: relaunch, fail-fast, collect-all-failures, or stop-the-stack
- stream policy: live prefixing, filtering, or quiet buffering until failure
- signal policy: direct child kill, process-group kill, process-tree kill, or no
  parent-owned shutdown path
- restart policy: none, hot-reload-only, fixed retry, or rolling crash window
- result shape: process exit, per-task result array, or dev session teardown

Until those match, keep behavior in the existing purpose-specific modules and
test their invariants where they live.
