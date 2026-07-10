# Upstream Bun issue template — Windows Bun-canary + PGlite native crash

Use this template to file the crash on https://github.com/oven-sh/bun/issues
when the quarantined tenant-db PGlite pass reports a native crash
(`scripts/run-bun-tests.mjs` prints the capture-file path — attach that file
and the `https://bun.report/…` link from it). Tracked in elizaOS/eliza#15785.

---

**Title:** `panic(main thread): Illegal instruction` running PGlite (Postgres
WASM) under `bun test` on Windows — hook wedges, then the process dies with
exit code 3

## What version of Bun is running?

1.4.0-canary (observed on the GitHub Actions `windows-latest` runner; fill in
the exact revision from the crash capture's `bun test v…` banner).

## What platform is your computer?

Windows Server 2022/2025 x64 (GitHub Actions `windows-latest`).

## What steps can reproduce the bug?

Intermittent — roughly one occurrence across many daily runs of the same
byte-identical suite, so treat as a race. The failing workload:

1. A `bun test --isolate` run over a `bun:test` suite that boots
   `@electric-sql/pglite` (Postgres compiled to WASM) against an on-disk data
   dir (`pglite://<tmpdir>`), executes DDL/DML through drizzle-orm, and closes
   the connection in `afterAll`
   (`packages/cloud/shared/src/lib/services/tenant-db/tenant-db-placement-claimer.test.ts`
   in elizaOS/eliza).
2. Most runs: the suite completes in ~50 ms.
3. Failing runs: a `beforeEach`/`afterEach` hook first times out (~6 s), the
   process then wedges (observed ~64 minutes of dead air), and finally panics.

## What is the expected behavior?

The suite passes (as it does on the vast majority of runs, and always on
Linux/macOS), or at worst reports a test failure — no native panic.

## What do you see instead?

```
src\lib\services\tenant-db\tenant-db-placement-claimer.test.ts:
(fail) tenant DB durable placement claimer > (unnamed) [6147.35ms]
  ^ a beforeEach/afterEach hook timed out for this test.
panic(main thread): Illegal instruction at address 0x7FF6B271CDB0
oh no: Bun has crashed. This indicates a bug in Bun, not your code.

To send a redacted crash report to Bun's team,
please file a GitHub issue using the link below:

 https://bun.report/1.4.0/w_2fc865b3gHuhooCg7m3rD+6xilC4l1klCo6silCmxqilCs11/hB2v1/hB885/xBgslytBk9kytB4w4ntBqy8h/By78h/B_A3s//Bhl54xtC
error: script "test" exited with code 3
```

(Observed in elizaOS/eliza Actions run 29041377960, develop@03f8dcdcf9d,
2026-07-09. The identical test blob passed in 49 ms in the previous run 11 h
earlier.)

## Additional information

- The suite runs under `bun test --isolate` in one process with many other
  files; the panic kills the whole run (exit code 3).
- The workload in the wedged hook is plain SQL over an in-process PGlite
  (Emscripten/WASM) instance — `DELETE FROM …` × 3 + one `INSERT`.
- Timeline of the wedge: hook timeout reported at 18:54:11, panic printed at
  19:58:00 — the event loop appears alive (the panic eventually prints) but
  the file never finishes.
- Attach the full capture written by `scripts/run-bun-tests.mjs`
  (`.tmp/bun-pglite-crash/tenant-db-pglite-crash-<timestamp>-attempt<N>.log`
  at the repo root), which includes the complete child output plus platform,
  command, exit status, and classification metadata.
