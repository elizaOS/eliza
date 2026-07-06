# Mobile Resource Workbench — Agent Guide

On-device (iOS + Android) resource profiling harness: battery, RSS, prefill/decode
tok/s, TTFT, thermal timeline. Mirrors `loadperf`'s budgets/results/CI-gate
shape. Standalone Node ESM — run directly with `node`, not via the suite
orchestrator. Issue #8800.

## Run

```bash
node packages/benchmarks/mobile-resource/run-workbench.mjs            # auto-detect device
node packages/benchmarks/mobile-resource/run-workbench.mjs --platform=android --tier=eliza-1-2b
node packages/benchmarks/mobile-resource/report.mjs                   # consolidated report
```

Flags: `--platform=android|ios`, `--tier=eliza-1-2b|eliza-1-4b`,
`--device-class=<budgets.json key>`, `--workloads=a,b,c`, `--base-url=<agent>`,
`--package=<android pkg>`, `--json`, `--fail-on-missing`.

Exit: `0` pass, `1` budget/gate fail, `2` skipped (no device/agent).

## Smoke test (no device, no keys)

```bash
node --test packages/benchmarks/mobile-resource/metrics.test.mjs   # pure aggregation + budgets
node packages/benchmarks/mobile-resource/report.mjs                # report from whatever results exist
```

Off-device the runner records `{ skipped }` and exits `2` — it never fabricates
numbers.

## Where the numbers come from

- **tok/s + TTFT** — the agent's device bridge differences `generateResult`
  (`computeGenerationThroughput`, in `@elizaos/shared/local-inference`) and
  buffers them; the runner reads `GET /api/dev/device-resource-metrics`.
- **RSS / thermal / battery / low-power** — native `getResourceSnapshot`
  (`ElizaIntent` on iOS, `ResourceProbe` on Android) + host probes
  (`android-probe.mjs` via adb; `ios-probe.mjs` via simctl + MetricKit).

## Conventions

- **Never fabricate a missing measurement.** Unmeasured → `null`, surfaced as
  `—` in reports and recorded as `not-measured` in budget checks (which pass by
  default; use `--fail-on-missing` to fail closed).
- **Budgets are per device-class × tier** in `budgets.json`; `null` budget =
  no-baseline (recorded, never fails). Ratchet in from `BASELINE.md`.
- **Results are generated, not committed** (`results/` is gitignored; only
  `.gitignore` is tracked).
- Pure aggregation/budget logic lives in `metrics.mjs` and is unit-tested with
  `node --test`. Keep device-driving glue in the runner/probes.

See the root [AGENTS.md](../../../AGENTS.md) for repo-wide rules and the issue
#8800 acceptance criteria.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
