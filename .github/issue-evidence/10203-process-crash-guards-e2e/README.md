# #10203 — installProcessCrashGuards real-process E2E

## Gap closed

`installProcessCrashGuards` (`packages/shared/src/process-guards.ts`) is the
seam that turns a serving agent's uncaught exception into a *supervised restart*
(exit 75) and keeps a background promise rejection non-fatal. Its unit test
(`process-guards.test.ts`) **deliberately mocks `process.on`** — its own comment
says it captures the listeners "without actually attaching them to the live
process (which would let a deliberately triggered rejection escape into the test
runner)". So it proves the listener *logic* with a mocked `exit`, but nothing
proved the **real** `process.on("uncaughtException" | "unhandledRejection")`
wiring behaves per policy in an actual process. Per PR_EVIDENCE ("real E2E, no
larp"), that seam is now proven end to end.

## What the new fixture + tests do

`packages/agent/test/fixtures/process-guards-child.ts` (spawned under `bun`)
installs the real guards and triggers a REAL fault:

| PG_POLICY | PG_FAULT | Expected exit | Meaning |
| --- | --- | --- | --- |
| restart | uncaught | **75** | supervisor would respawn |
| exit | uncaught | **1** | supervisor would propagate |
| keep-alive | uncaught | **0** | agent survives (degraded) |
| (any) | rejection | **0** | background rejection non-fatal |

Four `RUN_CRASH_RESTART_E2E=1`-gated cases added to
`crash-restart-supervisor.test.ts` (same gate as the existing crash-restart +
memory-watchdog e2e; out of the fast unit lane).

## Verification (host-only; no device/key/cluster)

```
# direct fixture runs:
PG_POLICY=restart    PG_FAULT=uncaught  -> exit=75
PG_POLICY=exit       PG_FAULT=uncaught  -> exit=1
PG_POLICY=keep-alive PG_FAULT=uncaught  -> exit=0
PG_POLICY=restart    PG_FAULT=rejection -> exit=0

$ RUN_CRASH_RESTART_E2E=1 bun run --cwd packages/agent test -- crash-restart-supervisor
 Test Files  1 passed (1)
      Tests  14 passed (14)   # 7 crash-injection + 3 memory-watchdog + 4 process-guards

$ bun run --cwd packages/agent test -- crash-restart-supervisor
      Tests  14 skipped (14)   # gate holds; fast lane unaffected
```

## N/A
- **Live-LLM trajectory / screenshots / audio:** N/A — process-lifecycle stability
  test (spawned `bun` children triggering real faults); no model/UI/audio path.
- **iOS device / k8s cluster:** out of scope here — those remaining #10197/#10203
  lanes are tracked in the (still-draft) #10616.
