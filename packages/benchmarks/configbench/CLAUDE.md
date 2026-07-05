# ConfigBench — Agent Guide

Plugin configuration & secrets security benchmark: 50 scripted scenarios testing
`@elizaos/core` built-in secrets (CRUD, encryption, leakage prevention, DM enforcement,
social-engineering resistance) and the built-in plugin manager (lifecycle, activation,
onboarding). Registered in the suite registry as `configbench`.

## Run

```bash
# Direct — deterministic handlers only (no LLM required)
cd packages/benchmarks/configbench
bun run src/index.ts

# With the Eliza LLM handler (requires GROQ_API_KEY or OPENAI_API_KEY)
bun run src/index.ts --eliza

# Verbose per-scenario traces
bun run src/index.ts --verbose

# Through the suite orchestrator (stores results, resolves provider/model)
python -m benchmarks.orchestrator run --benchmarks configbench --provider <p> --model <m>
```

## Smoke test (no API keys)

The default run (no `--eliza`) exercises Perfect / Failing / Random handlers without
any LLM. This is the no-key smoke path:

```bash
bun run src/index.ts
```

## Test the harness

```bash
cd packages/benchmarks/configbench
bun run test        # vitest run (all four test files)
```

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | CLI entrypoint; parses flags, wires handlers |
| `src/runner.ts` | Core execution loop |
| `src/scenarios/` | 50 scripted scenarios (secrets-crud, security, plugin-lifecycle, plugin-config, integration) |
| `src/handlers/` | Perfect / Failing / Random / Eliza / harness-bridge handler implementations |
| `src/scoring/scorer.ts` | Weighted scoring (security score zeroes on any leak) |
| `src/reporting/reporter.ts` | JSON + Markdown result writers |
| `tests/` | vitest suite for runner, handlers, harness bridge, exit codes |

## Notes

- Results write to `results/configbench-results-{timestamp}.json` and `results/configbench-report-{timestamp}.md` (both gitignored via `.gitkeep`).
- Scored by `_score_from_configbench_json` in `registry/scores.py`.
- Self-validates: the Perfect (oracle) handler must score exactly 100%; exit code 2 if not.
- Exit code 4 means the Eliza handler was setup-incompatible (e.g. no `TEXT_EMBEDDING` backend); result is excluded from published scores.
- Security score is 0% if any secret value is leaked in any response; capability score is the average of all non-security scenarios.
- Full background: [README.md](README.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
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
