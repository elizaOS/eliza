# Tau-bench — Agent Guide

Vendored implementation of Sierra's [tau-bench](https://github.com/sierra-research/tau-bench)
(Yao et al., 2024): Tool-Agent-User Interaction benchmark across retail (115 tasks) and airline
(50 tasks) domains, with pass^k scoring and an LLM judge. Registered in the suite registry as
`tau_bench`.

## Run

```bash
# Direct, from this directory — full 165-task suite, pass^4 (paper default)
python -m elizaos_tau_bench --agent-model gpt-4o

# With a non-OpenAI agent; keep openai for user-simulator and judge
python -m elizaos_tau_bench \
    --agent-provider anthropic --agent-model claude-3-5-sonnet-latest \
    --user-provider openai --user-model gpt-4o \
    --judge-provider openai --judge-model gpt-4o-mini

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks tau_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Deterministic mock agent — no LLM calls, no keys required
python -m elizaos_tau_bench --mock --use-sample-tasks
```

## Test the harness

```bash
# One-time install (from this directory)
pip install -e ".[dev]"

# Run the pytest suite
pytest packages/benchmarks/tau-bench/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_tau_bench/cli.py` | CLI entrypoint (`python -m elizaos_tau_bench`) |
| `elizaos_tau_bench/runner.py` | Main execution loop (TauBenchRunner) |
| `elizaos_tau_bench/judge.py` | LLM judge (gpt-4o-mini, falls back to substring) |
| `elizaos_tau_bench/pass_k.py` | Unbiased pass^k estimator |
| `elizaos_tau_bench/types.py` | TauBenchConfig, TauBenchReport DTOs |
| `elizaos_tau_bench/upstream/` | Vendored sierra-research/tau-bench source (MIT) |
| `elizaos_tau_bench/compact_fixtures/` | Compact DB fixtures for smoke runs |
| `tests/` | pytest suite (dataset, pass^k, judge, output contract, smoke) |
| `pyproject.toml` | Package metadata; `tau-bench` console script |

## Notes

- Results write to `benchmark_results/tau-bench/<timestamp>/` (report.json + trajectories.json).
- Scored by `_score_from_taubench_json` in `registry/scores.py`.
- Required env vars: `OPENAI_API_KEY` (agent + user simulator + judge by default). Override
  each component's provider with `--agent-provider`, `--user-provider`, `--judge-provider`.
- Full retail + airline data is fetched lazily into `~/.cache/elizaos_tau_bench/` on first run.
  Set `TAU_BENCH_DATA_DIR` to a pre-populated path, or `TAU_BENCH_DATA_MODE=smoke` to use only
  compact fixtures.
- Vendored upstream commit: `59a200c6d575d595120f1cb70fea53cef0632f6b`.
- Full background: [README.md](README.md).

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
