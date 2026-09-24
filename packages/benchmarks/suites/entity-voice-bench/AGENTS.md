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

