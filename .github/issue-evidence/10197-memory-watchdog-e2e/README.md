# #10197 — memory-watchdog → supervised-restart end-to-end proof

## Gap closed

The memory watchdog (`packages/agent/src/runtime/memory-watchdog.ts`) was
covered in three disjoint pieces:
- `memory-watchdog.test.ts` — unit test of `createMemoryWatchdog`'s
  threshold/debounce/one-shot logic with **fake** deps.
- `crash-restart-supervisor.test.ts` — real spawned-process proof that
  `RESTART_EXIT_CODE=75` drives the supervisor's respawn/storm-guard contract,
  but only via the `crash-injection` fixture.

Nothing drove a **real process whose real RSS crosses the threshold through the
real `requestRestart` seam**. Per PR_EVIDENCE ("real E2E, no larp"), that seam
is now proven end to end.

## What the new fixture + tests do

`packages/agent/test/fixtures/memory-watchdog-child.ts` (spawned under `bun`):
1. Registers the **same restart handler production uses**
   (`app-core/src/cli/run-main.ts` → `setRestartHandler(() => process.exit(RESTART_EXIT_CODE))`).
2. Holds `CRASH_CHILD_ALLOC_MB` of **page-touched** heap so
   `process.memoryUsage().rss` genuinely climbs.
3. Starts the real `startMemoryWatchdog()` (real RSS source + real
   `requestRestart`).
4. A ref'd guard timer fails loud (exit 2) if the watchdog never fires.

Three gated e2e cases added to `crash-restart-supervisor.test.ts`
(`RUN_CRASH_RESTART_E2E=1`, out of the fast unit lane):
- **trips**: 400 MB held, 128 MB threshold, sustained=1 → real watchdog samples
  RSS 570 MB ≥ 128 MB → `requestRestart` → `process.exit(75)`.
- **stays quiet under threshold**: 64 GB threshold → no restart → guard exit 2.
- **respects the opt-in gate**: `ELIZA_MEMORY_WATCHDOG` unset → `startMemoryWatchdog`
  returns null → clean exit 0 even under 400 MB pressure.

## Verification (host-only; no device/key/cluster)

```
# real child, breach case — actual log lines:
 Info  [MemoryWatchdog] enabled (threshold 128MB, interval 1000ms, sustained 1 samples)
 Warn  [MemoryWatchdog] memory-watchdog: RSS 570MB >= 128MB for 1 samples — requesting clean restart via supervisor
 memory-watchdog-child: restart requested: ... — exiting 75
 exit=75

$ RUN_CRASH_RESTART_E2E=1 bun run --cwd packages/agent test -- crash-restart-supervisor
 Test Files  1 passed (1)
      Tests  10 passed (10)      # 7 existing + 3 new

# fast unit lane still excludes the e2e (gate holds):
$ bun run --cwd packages/agent test -- crash-restart-supervisor
      Tests  10 skipped (10)
```

## N/A
- **Live-LLM trajectory / screenshots / audio:** N/A — this is a process-lifecycle
  stability test (spawned `bun` children under real memory pressure); no model,
  UI, or audio path is involved.
- **iOS device / k8s cluster:** out of scope for this seam — those device/cluster
  lanes are the remaining #10197 work tracked in the (still-draft) #10616.
