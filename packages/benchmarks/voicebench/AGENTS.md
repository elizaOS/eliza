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
