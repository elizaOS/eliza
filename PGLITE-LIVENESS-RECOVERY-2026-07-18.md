# PGlite liveness recovery receipt, 2026-07-18

Signed: `[sol-orch]`

## Incident and Block-0

Staging left a live dedicated-agent process false-green while all DB-backed work failed continuously with `PGlite is closed` and `Database is shutting down - operation rejected`. A manual container restart restored service.

Before implementation, open issues, open PRs, and ElizaOS Project 12 were searched for the exact terminal-PGlite/liveness/automatic-recovery scope. No duplicate was found. Related work was non-overlapping:

- #16309 / #16311: fresh-boot service/schema/scheduler failures.
- #15228: stale PGlite lock crash loops where pid 1 exits.
- #15603 / #15783: hosted-agent hardening and off-box durability.

Created and claimed #16650 and added it to Project 12:

- https://github.com/elizaOS/eliza/issues/16650

## Implementation

Branch: `fix/16650-pglite-liveness`

- Added a real `SELECT 1` runtime database probe with explicit `ok`, `unknown`, `transient_error`, and `terminal_error` states.
- Terminal classification preserves nested causes and recognizes the incident's PGlite closed/shutdown signatures.
- `/api/health` now reports `ready: false`, `canRespond: false`, terminal DB state, and HTTP 503 after terminal closure.
- Dedicated cloud-agent `/health`, `/api/health`, and `status.get` now expose the same DB liveness contract.
- PGlite `isReady()` now exercises the DB rather than trusting cached manager state.
- The fleet heartbeat consumer parses the truthful health payload and enqueues the existing deduplicated restart job on terminal DB closure.
- Transient DB probe failures use normal heartbeat retries/hysteresis and do not immediately restart.
- DB recovery has an isolated three-restart budget in a one-hour window plus a ten-minute cooldown. Unrelated `error_count` values cannot consume the budget, and old episodes age out rather than permanently disabling recovery.
- Existing restart/provisioning paths remain responsible for state-preserving recovery. No auth, billing, backup, restore, or persistence policy was weakened.

## Proof

Passing focused tests:

1. `packages/agent`: real in-memory PGlite is healthy, is closed after boot, then `/api/health` returns 503 with terminal DB state.
   - 1 passed.
2. `packages/app-core`: cloud-agent liveness classification covers terminal closed DB, preserved terminal errors when `isReady()` collapses to false, and bounded transient classification.
   - 5 passed.
3. `packages/cloud/shared`: terminal recovery enqueue, transient no-immediate-restart, unrelated-budget isolation, cooldown suppression, and budget exhaustion.
   - 5 passed, 104 filtered out.
4. `packages/cloud/shared` typecheck passed.
5. Biome check/write on all touched source and test files passed, and `git diff --check` passed.

Agent/app-core/plugin-sql package-wide typechecks were attempted but are blocked in this isolated worktree by pre-existing/missing generated optional workspace packages and dist artifacts, including `@elizaos/plugin-app-control`, Capacitor packages, `@elizaos/cloud-routing`, and `@elizaos/contracts`. Focused tests compile and execute every changed recovery surface.

Commit includes:

`Co-authored-by: wakesync <wakesync@users.noreply.github.com>`
