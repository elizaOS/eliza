# VoiceBench — Agent Guide

End-to-end voice latency benchmark for the elizaOS TypeScript runtime. Measures
transcription (STT), response TTFT/total, TTS generation, and full speech-end-to-first-audio
pipeline across `simple` and `non-simple` action modes. Registered in the suite as `voicebench`.

## Run

```bash
# Direct — from benchmarks/voicebench
./run.sh --profile=groq
./run.sh --profile=elevenlabs

# With a labeled dataset manifest (enables WER/CER scoring)
./run.sh --profile=groq --dataset=fixtures/manifest-groq.json
./run.sh --profile=elevenlabs --dataset=fixtures/manifest-elevenlabs.json

# Optional flags
./run.sh --profile=groq --iterations=5
./run.sh --profile=groq --dataset=fixtures/manifest-groq.json --output-dir=/tmp/voicebench-out

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks voicebench --provider groq --model <m>
```

Required env for groq profile: `GROQ_API_KEY`.
Required env for elevenlabs profile: `GROQ_API_KEY` + `ELEVENLABS_API_KEY`.
Audio source: set `VOICEBENCH_AUDIO_PATH` or pass `--dataset`. For the `groq`/`elevenlabs`
profiles without `--dataset`, a real audio file must exist at
`benchmarks/voicebench/shared/audio/default.wav` or `agent-town/public/assets/background.mp3`.

## Smoke test (no API keys)

```bash
# From benchmarks/voicebench — emits a zeroed mock JSON result, no network calls
./run.sh --profile=mock
./run.sh --profile=mock --iterations=3
```

## Test the harness

No pytest/bun test suite exists in this directory. The TypeScript runner has no
standalone test entrypoint. Verify changes by running the mock profile above and
inspecting the output JSON, then run the real profile against a fixture dataset.

## Layout

| Path | Role |
| --- | --- |
| `run.sh` | CLI entrypoint; handles profile routing, audio/dataset resolution, mock path |
| `typescript/src/bench.ts` | TypeScript runner (Bun); instantiates elizaOS AgentRuntime, drives STT → response → TTS |
| `shared/config.json` | Benchmark config: `defaultIterations`, `responseMaxChars`, mode definitions |
| `shared/character.json` | Agent character loaded by the TS runner |
| `shared/fixture_prompts.jsonl` | Fixture prompts injected into the benchmark context |
| `fixtures/manifest-groq.json` | Labeled dataset manifest for the groq profile |
| `fixtures/manifest-elevenlabs.json` | Labeled dataset manifest for the elevenlabs profile |

## Notes

- Results write to `benchmarks/voicebench/results/` as `voicebench-typescript-<profile>-<ts>.json` (gitignored).
- Scored by `_score_from_voicebench_json` in `registry/scores.py`.
- Profiles: `groq` (Groq STT + LLM + TTS), `elevenlabs` (Groq LLM, ElevenLabs STT + TTS),
  `local-cerebras` (faster-whisper STT, Cerebras LLM, macOS `say` TTS),
  `local-eliza1` (eliza-1 ASR, Cerebras LLM, macOS `say` TTS), `mock` (zero-latency smoke).
- The `--py-only` and `--rs-only` flags exit with an error; only TypeScript runs.
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
