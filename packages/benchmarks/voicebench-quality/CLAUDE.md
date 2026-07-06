# VoiceBench (quality) — Agent Guide

Vendored implementation of VoiceBench (Chen et al. 2024): 8 task suites covering
6,783 spoken instructions, measuring response quality (score in [0, 1]) for
voice-input language assistants. Registered in the suite registry as `voicebench_quality`.

Separate from `packages/benchmarks/voicebench/` (that one is TypeScript and measures
latency in ms; this one is Python and measures response quality).

## Run

```bash
# Direct, from this directory
python -m elizaos_voicebench \
    --agent eliza \
    --suite all \
    --output ./results

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks voicebench_quality --provider <p> --model <m>
```

Agent choices: `eliza`, `hermes`, `openclaw`. STT provider is auto-detected
(prefers local eliza1 binary > `GROQ_API_KEY` > `faster-whisper`); override with
`--stt-provider {groq,eliza-runtime,eliza1,faster-whisper,local-whisper}`.

## Smoke test (no API keys)

```bash
# --mock uses bundled fixtures with a deterministic no-cost adapter and judge
python -m elizaos_voicebench --mock --suite openbookqa --limit 5 --output /tmp/vbq-smoke
```

Note: mock results are rejected by the real scorer (`_score_from_voicebench_quality_json`).

## Test the harness

```bash
pip install -e ".[test]"
pytest tests/ -x
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_voicebench/__main__.py` | CLI entry point (`python -m elizaos_voicebench`) |
| `elizaos_voicebench/runner.py` | Execution loop — resolves suites, drives adapter + judge |
| `elizaos_voicebench/adapters.py` | `VoiceAdapter` base + eliza/hermes/openclaw/echo impls |
| `elizaos_voicebench/clients/` | Groq STT, eliza-1 ASR, Cerebras LLM judge, say TTS |
| `elizaos_voicebench/fixtures/` | Bundled JSONL task fixtures (8 suites) used in mock mode |
| `elizaos_voicebench/types.py` | `SUITES` tuple and shared type definitions |
| `tests/` | pytest suite |
| `pyproject.toml` | Package metadata; `elizaos-voicebench` console script |

## Notes

- Results write to `<output>/voicebench-quality-results.json`. Registry expects it at
  `<output_dir>/voicebench-quality-results.json` (`_voicebench_quality_result`).
- Scored by `_score_from_voicebench_quality_json` in `registry/scores.py` (line 755).
  Score is the unweighted mean of the 8 per-suite scores.
- Required env vars for live runs: `CEREBRAS_API_KEY` (LLM judge), `GROQ_API_KEY` or
  `VOICEBENCH_QUALITY_STT_PROVIDER` (STT).
- Judged suites (`alpacaeval`, `commoneval`, `sd-qa`, `bbh`) use `gpt-oss-120b` on
  Cerebras; deterministic suites (`ifeval`, `advbench`, `openbookqa`, `mmsu`) need no judge key.
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
