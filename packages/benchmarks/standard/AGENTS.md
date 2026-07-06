# Standard Academic Benchmarks — Agent Guide

Four classic NLP/coding evaluation adapters — MMLU, HumanEval, GSM8K, and MT-Bench —
all dispatched through `../run.py` and registered in the suite registry as `mmlu`,
`humaneval`, `gsm8k`, and `mt_bench`.

## Run

```bash
# Direct — one adapter at a time (from the repo root or benchmarks/ dir)
python -m benchmarks.standard.mmlu \
    --provider openai --model gpt-4o-mini \
    --output /tmp/mmlu-out

python -m benchmarks.standard.humaneval \
    --provider openai --model gpt-4o-mini \
    --output /tmp/humaneval-out

python -m benchmarks.standard.gsm8k \
    --provider openai --model gpt-4o-mini \
    --output /tmp/gsm8k-out

python -m benchmarks.standard.mt_bench \
    --provider openai --model eliza-1-9b \
    --judge-provider openai --judge-model gpt-4o \
    --output /tmp/mt-bench-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks mmlu --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks humaneval --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks gsm8k --provider <p> --model <m>
python -m benchmarks.orchestrator run --benchmarks mt_bench --provider <p> --model <m>
```

## Smoke test (no API keys)

All four adapters support `--mock` for a deterministic offline run using built-in fixtures.

```bash
python -m benchmarks.standard.mmlu --mock --provider openai --model mock \
    --output /tmp/mmlu-smoke --api-key-env DOES_NOT_EXIST

python -m benchmarks.standard.humaneval --mock --provider openai --model mock \
    --output /tmp/humaneval-smoke --api-key-env DOES_NOT_EXIST

python -m benchmarks.standard.gsm8k --mock --provider openai --model mock \
    --output /tmp/gsm8k-smoke --api-key-env DOES_NOT_EXIST

python -m benchmarks.standard.mt_bench --mock --provider openai --model mock \
    --output /tmp/mt-bench-smoke --api-key-env DOES_NOT_EXIST
```

## Test the harness

```bash
# From the benchmarks/ package root
pytest standard/tests/ -v
```

No extra install step — the `standard/` package is part of the `benchmarks` namespace.

## Layout

| Path | Role |
| --- | --- |
| `mmlu.py` | MMLU adapter (cais/mmlu, 57-subject 4-way multiple choice) |
| `humaneval.py` | HumanEval adapter (164 Python pass@1 problems) |
| `gsm8k.py` | GSM8K adapter (grade-school math, `#### <int>` scoring) |
| `mt_bench.py` | MT-Bench adapter (80 multi-turn prompts, LLM-as-judge) |
| `trajectory_replay.py` | Trajectory replay adapter (shared module) |
| `agent_command.py` | Agent command execution helper |
| `code_agent_humaneval.py` | Code-agent variant of HumanEval |
| `_base.py` | Shared runner base classes, client abstractions, mock client |
| `_cli.py` | Shared argparse scaffolding (`build_parser`, `run_cli`) |
| `tests/` | pytest suite for all adapters |

## Notes

- Results write to `<output>/mmlu-results.json`, `humaneval-results.json`,
  `gsm8k-results.json`, or `mt-bench-results.json` respectively.
- Scored by `_score_from_mmlu_json`, `_score_from_humaneval_json`,
  `_score_from_gsm8k_json`, `_score_from_mt_bench_json` in `registry/scores.py`.
- MMLU and GSM8K load datasets lazily via `datasets` (HuggingFace); built-in
  fixtures are used as fallback when the package is absent or `--mock` is set.
- HumanEval prefers `bigcode-evaluation-harness` when installed; falls back to a
  built-in sandboxed execution loop.
- MT-Bench requires a separate judge model/endpoint; the judge and candidate model
  can be on different providers.
- All adapters record per-turn trajectories to `<output>/trajectories.jsonl`.

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
