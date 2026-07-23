# entity-voice-bench — Agent Guide

Benchmark for **entity extraction from voice conversation** (#10726 pillar 4):
does the shipped pipeline recognize known speakers, create the right person
entities, attach facts to the right people, and keep confusable names
(Maria/Mario/Marie, Erin/Aaron) distinct? Two lanes drive real production
code — the voice merge engine (`kg`, keyless) and the full message pipeline
(`llm`, live model) — over reference transcripts (`--input text`) or recorded
real-ASR output (`--input audio`).

**Run-only / unregistered.** No `BenchmarkDefinition` in
`registry/commands.py` and no scorer in `registry/scores.py`, so
`python -m benchmarks.orchestrator run` cannot invoke it; it is explicitly
listed in `IGNORED_BENCHMARK_DIRS` in `orchestrator/adapters.py`, and the
full-campaign manifest (`orchestrator/full_campaign.py`) carries it only as
an `UNINTEGRATED` `DirectCampaignEntry`. Run it directly with the commands
below.

## Run

```bash
# From this directory.
bun run bench            # default: kg lane, text input (keyless, deterministic)
bun run bench:kg:text    # merge-engine lane over reference transcripts
bun run bench:kg:audio   # merge-engine lane over recorded real-ASR transcripts
bun run bench:llm:text   # message-pipeline lane, live model over reference text
bun run bench:llm:audio  # message-pipeline lane, live model over ASR transcripts

# Equivalent direct invocation (any flag combination):
bun --conditions=eliza-source run.ts --lane kg|llm --input text|audio \
  [--report <json>]
```

The `llm` lane needs a live provider: any of `GROQ_API_KEY` /
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` /
`OPENROUTER_API_KEY`, or `ELIZA_CHAT_VIA_CLI=claude|codex` on a subscription
host. The `kg` lane uses the scenario-runner deterministic LLM proxy and
needs no keys (the merge-engine path makes no LLM calls).

Per-session JSON and `report-<lane>-<input>.json` write to `results/`
(gitignored). If a `baseline.json` exists next to `run.ts`, aggregate
precision/recall more than 0.05 below the recorded baseline fails the run.

Exit codes: `0` pass · `1` failure/regression · `2` skip (missing assets or
provider). Set `ENTITY_VOICE_REAL_REQUIRE=1` to turn every skip into a hard
failure (fail-closed CI lane).

## Regenerate the audio corpus

Only needed when `corpus.ts`, the Kokoro voices, or the ASR model change —
`asr-transcripts.json` is committed, so `--input audio` runs keyless without
these steps. Both scripts need the fused local-inference assets staged:

```bash
bun run corpus:synth       # corpus → results/audio/*.wav (real Kokoro TTS)
bun run corpus:transcribe  # WAVs → asr-transcripts.json (real local ASR)
```

Env: `ELIZA_INFERENCE_LIBRARY` / `ELIZA_INFERENCE_LIB_DIR` (fused
libelizainference), `ELIZA_KOKORO_MODEL_DIR` (kokoro-82m gguf + voices) for
synth, `ELIZA_ASR_BUNDLE` (eliza-1-asr gguf + mmproj) for transcribe.
`run.ts --input audio` skips (exit 2) when `asr-transcripts.json` is missing
or stale against the current corpus.

## Smoke test (no API keys)

The default lane IS the no-key path — it boots a real `AgentRuntime` +
PGLite + plugin-personal-assistant, emits production `VOICE_TURN_OBSERVED`
events, and scores the resulting knowledge graph deterministically:

```bash
bun run bench:kg:text
```

`bench:kg:audio` is also keyless (it replays the committed ASR transcripts).

## Test the harness

```bash
bun run test    # vitest run — corpus invariants + scoring math
```

`corpus.test.ts` pins corpus shape (utterance counts, unique ids, category
coverage, valid Kokoro voice ids); `metrics.test.ts` validates the P/R/F1
scoring, confusable-name rejection, groundedness, false-merge counting, and
WER helpers against known cases.

## Layout

| Path | Role |
| --- | --- |
| `run.ts` | Runner: lanes, per-session child processes, aggregation, baseline gate |
| `corpus.ts` | Committed corpus: 8 speakers, 4 sessions, 42 utterances + ground truth |
| `metrics.ts` | Lane-agnostic scoring (creation/recognition/attribute/disambiguation) |
| `synthesize.ts` | Corpus → WAV via real in-process Kokoro (artifacts, gitignored) |
| `transcribe.ts` | WAV → committed `asr-transcripts.json` via real local ASR |
| `asr-transcripts.json` | Recorded real-ASR hypotheses (reference + hypothesis + provenance) |
| `results/` | Run output — gitignored, never commit |

## Notes

- Sessions run in child processes with a fresh PGLite dir each because the
  knowledge-graph entity store is per-agent, not per-room.
- The text↔audio delta on the same lane is exactly the ASR-induced entity
  error; the kg↔llm delta on the same input compares the merge engine to the
  full LLM extraction stack.
- Ground truth includes rows the shipped extractors intentionally do not
  cover yet — they measure the gap honestly; do not prune them to make
  scores look better.

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
