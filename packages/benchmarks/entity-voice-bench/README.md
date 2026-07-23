# entity-voice-bench

Measures how well the shipped elizaOS entity pipeline turns **spoken
conversation into a correct knowledge graph** — the "who is talking, who did
they mention, and what did we learn about them" problem (#10726 pillar 4).
Everything under test is real production code; nothing in the extraction path
is reimplemented or stubbed here.

## What it measures

A committed corpus (`corpus.ts`) of 42 utterances across 4 voice sessions,
spoken by 8 distinct Kokoro voices, carries ground truth for four
capabilities:

| Capability | Question |
| --- | --- |
| **recognition** | Does a turn by an already-known speaker bind to that speaker's existing entity (no duplicate)? |
| **creation** | Does an introduction mint a new person entity with the right preferred name? |
| **attribute** | Does a stated fact attach to the right person? Precision is a groundedness / anti-hallucination measure. |
| **disambiguation** | Do confusable names (Maria/Mario/Marie, Erin/Aaron) stay distinct, with claims landing on the right one? False merges are counted. |

Each is scored as precision / recall / F1 per session and aggregated
(`metrics.ts`). Ground truth describes what a *correct* pipeline should do;
rows the shipped extractors do not yet cover exist to measure the gap
honestly, not to be skipped.

## Two lanes × two inputs

`run.ts` drives two independent extraction paths over the same corpus:

- **`kg` lane (default, keyless).** Emits the production
  `VOICE_TURN_OBSERVED` event into a real `AgentRuntime` with
  `@elizaos/plugin-personal-assistant` registered. The plugin's
  voice-observer bridge folds each turn into the knowledge-graph
  `EntityStore` / `RelationshipStore` (match-or-create, partner claims,
  merges) and round-trips `VOICE_ENTITY_BOUND` — exactly what happens when
  `plugin-local-inference` attributes a live voice turn. Built on the
  scenario-runner factory with the deterministic LLM proxy; the merge-engine
  path makes no LLM calls, so this lane needs no API keys.
- **`llm` lane (live model required).** Feeds the same transcripts through
  `runtime.messageService.handleMessage` as owner chat turns — exercising the
  stage-1 extract, the `facts_and_relationships` stage, the reflection
  evaluators, and plugin-personal-assistant's owner-profile extraction.
  Needs a provider key (GROQ / OPENAI / ANTHROPIC / GOOGLE / OPENROUTER) or
  `ELIZA_CHAT_VIA_CLI=claude|codex` on a subscription host.

Input selection isolates the ASR contribution to entity error:

- **`--input text`** scores extraction over the reference transcripts
  (pure extraction quality).
- **`--input audio`** replays the committed `asr-transcripts.json` produced
  by the real Kokoro → ASR pipeline, so the delta between the two inputs is
  exactly the ASR-induced entity error.

## Audio pipeline

- `synthesize.ts` renders each corpus utterance to WAV with the real
  in-process Kokoro engine (fused `libelizainference` FFI — the same path
  that ships on mobile/desktop). WAVs are gitignored artifacts under
  `results/audio/`; a speech-envelope guard rejects loader/dtype regressions
  that would produce noise instead of speech.
- `transcribe.ts` transcribes those WAVs with the real local ASR (Eliza-1
  Qwen3-ASR GGUF through the same fused FFI) and writes
  `asr-transcripts.json` — committed with full provenance so the `--input
  audio` lanes can run keyless/deterministic in CI. Regenerate on any
  ASR / model / corpus change.

## Mechanics

Sessions run in child processes (fresh PGLite dir each) because the
knowledge-graph store is per-agent, not per-room. Per-session JSON and the
aggregate `report-<lane>-<input>.json` land in `results/` (gitignored). A
`baseline.json` next to `run.ts`, when present, acts as a regression gate:
any aggregate precision/recall dropping more than 0.05 below the recorded
baseline fails the run. `ENTITY_VOICE_REAL_REQUIRE=1` turns every skip
(missing assets / no provider) into a hard failure for fail-closed CI lanes.

Exit codes: `0` pass · `1` failure/regression · `2` skip (missing assets or
provider, and REQUIRE unset).

## Status: run-only, not registered

This benchmark is **not integrated into the suite registry or the
orchestrator** — run it directly with the commands in
[AGENTS.md](AGENTS.md):

- No `BenchmarkDefinition` in `registry/commands.py`, so
  `python -m benchmarks.orchestrator run` cannot invoke it.
- Explicitly excluded from orchestrator adapter discovery
  (`orchestrator/adapters.py` `IGNORED_BENCHMARK_DIRS`).
- Tracked by the full-campaign manifest only as an `UNINTEGRATED`
  `DirectCampaignEntry` (`orchestrator/full_campaign.py`) — a real-LLM
  workload with no normalized adapter/scorer across the three harnesses.

## Layout

| Path | Role |
| --- | --- |
| `run.ts` | Runner: lanes, session child processes, aggregation, baseline gate |
| `corpus.ts` | Committed corpus: speakers, sessions, utterances, ground truth |
| `metrics.ts` | Lane-agnostic P/R/F1 scoring + WER / name-survival helpers |
| `synthesize.ts` | Corpus → WAV via real in-process Kokoro (gitignored artifacts) |
| `transcribe.ts` | WAV → `asr-transcripts.json` via real local ASR (committed) |
| `asr-transcripts.json` | Recorded real-ASR hypotheses with provenance |
| `corpus.test.ts` / `metrics.test.ts` | Vitest suites over corpus invariants + scoring math |
| `results/` | Run output — gitignored, never commit |
