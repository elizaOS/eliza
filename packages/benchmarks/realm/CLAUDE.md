# REALM-Bench — Agent Guide

Real-World Planning benchmark: 11 problem types (TSP, VRP, DARP, event
coordination, disaster relief, JSSP) drawn from arXiv:2502.18836. Vendored
upstream task definitions and datasets under `upstream/`. Registered in the
suite registry as `realm`.

## Run

```bash
# Direct — all 11 problems, one instance each, via the eliza TS bridge
python -m benchmarks.realm.cli --max-tasks 1

# Subset of problem types
python -m benchmarks.realm.cli --problems P1 P11

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks realm --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Deterministic mock oracle agent, tiny built-in P1 + P11 sample
python -m benchmarks.realm.cli --provider mock --use-sample-tasks

# Full mock run (all vendored instances, mock agent)
python -m benchmarks.realm.cli --provider mock --full-dataset
```

## Test the harness

```bash
# One-time install (from packages/benchmarks/realm/)
pip install -e ".[dev]"

# Run tests (from repo root or packages/benchmarks/)
pytest packages/benchmarks/realm/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `cli.py` | CLI entrypoint (`python -m benchmarks.realm.cli`) |
| `runner.py` | Async execution loop + `_MockREALMAgent` (oracle-based mock) |
| `evaluator.py` | Per-problem extrinsic scoring (quality, optimality, CSR, …) |
| `solvers.py` | OR-Tools oracles: TSP-TW, DARP, JSSP CP-SAT, disaster |
| `dataset.py` | Loader; normalises upstream schema variations |
| `disruption.py` | Mid-run disruption injection for P4/P7/P8/P9/P10 |
| `types.py` | `RealmProblem` (P1–P11), `REALMConfig`, DTOs |
| `plugin/` | Plan-response parsing helpers |
| `upstream/` | Vendored from genglongling/REALM-Bench (datasets + evaluation) |
| `tests/` | pytest suite (smoke, dataset, runner, solver, env-loader) |

## Notes

- Results write to `./benchmark_results/realm/<timestamp>/` (gitignored).
  Result files match `realm-benchmark-*.json`.
- Scored by `_score_from_realm_json` in `registry/scores.py`.
- OR-Tools is optional; install with `pip install "elizaos-benchmarks-realm[ortools]"`
  or pass `--auto-install-ortools`. Without it, P1/P3/P4 use heuristic fallbacks
  and P11 errors unless the instance has an `upper_bound` header.
- Solver wall-clock budget: `--solver-timeout` (default 30 s). Use 120 s for
  large DMU/TA JSSP instances to reach OPTIMAL.
- Upstream reference: <https://github.com/genglongling/REALM-Bench>.
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
