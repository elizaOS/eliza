# VoiceAgentBench — Agent Guide

Vendored from [Patil et al., arXiv:2510.07978](https://arxiv.org/abs/2510.07978).
5,757 voice queries across six suites measuring voice-in → tool-call-out accuracy:
single, parallel, sequential, multi-turn state threading, safety refusal, and multilingual.
Registered in the suite registry as `voiceagentbench`. Headline metric: `pass_at_1`.

## Run

```bash
# Direct, from this directory
python -m elizaos_voiceagentbench \
    --agent {eliza,hermes,openclaw} \
    --suite {single,parallel,sequential,multi-turn,safety,multilingual,all} \
    --limit 50 --seeds 1 --output ./results [--no-judge]

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks voiceagentbench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Uses bundled fixtures/mock_tasks.jsonl + deterministic mock agent; no GROQ/CEREBRAS keys needed
python -m elizaos_voiceagentbench --mock --suite single --no-judge --output /tmp/vab-smoke
```

## Test the harness

```bash
pip install -e ".[test]"
PYTHONPATH=/path/to/eliza/packages/benchmarks/voiceagentbench:/path/to/eliza/packages/benchmarks/lifeops-bench \
  pytest packages/benchmarks/voiceagentbench/tests -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_voiceagentbench/cli.py` | CLI entrypoint (`main()`) |
| `elizaos_voiceagentbench/__main__.py` | Module entry (`python -m elizaos_voiceagentbench`) |
| `elizaos_voiceagentbench/runner.py` | Async task execution loop |
| `elizaos_voiceagentbench/evaluator.py` | Scoring axes + LLM coherence judge |
| `elizaos_voiceagentbench/scorer.py` | Report compilation (`pass_at_1`, `pass^k`) |
| `elizaos_voiceagentbench/dataset.py` | JSONL task loader and suite filter |
| `elizaos_voiceagentbench/stt.py` | STT backends (Groq Whisper, eliza1, faster-whisper) |
| `elizaos_voiceagentbench/adapters/` | Agent adapters: eliza, hermes, openclaw |
| `elizaos_voiceagentbench/types.py` | `MessageTurn`, `Suite`, `VoiceBenchmarkReport` |
| `fixtures/mock_tasks.jsonl` | Hermetic fixture dataset for smoke/CI |
| `fixtures/test_tasks.jsonl` | Task fixtures for pytest |
| `tests/` | pytest suite |

## Notes

- Results write to `./results/voiceagentbench_<agent>_<suite>_<timestamp>.json` (gitignored).
- Scored by `_score_from_voiceagentbench_json` in `registry/scores.py`.
- STT defaults: auto-detects eliza1 binary → `GROQ_API_KEY` → faster-whisper. Override with `--stt-provider`.
- Required env vars for real runs: `GROQ_API_KEY` (STT), `CEREBRAS_API_KEY` (coherence judge). Skip judge with `--no-judge`.
- `VOICEAGENTBENCH_STT_PROVIDER` overrides STT backend selection.
- Full background and scoring formula: [README.md](README.md).

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
