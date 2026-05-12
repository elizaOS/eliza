# Voicebench

`voicebench` benchmarks end-to-end voice latency with Eliza using the TypeScript runtime.

## What It Measures

For each runtime and each mode (`simple`, `non-simple`):

- transcription time (`TRANSCRIPTION` model)
- speech-end-to-text (`speechEndToTextMs`; equivalent to transcription time for pre-segmented fixture audio)
- transcription accuracy against labels (when a dataset manifest includes expected text)
- response-handler decision latency (`responseHandlerDecisionMs`; first callback/early reply timing)
- response TTFT (time to first response token/chunk; falls back to response completion when streaming is unavailable)
- response total time
- speech-end-to-response-decision (`speechEndToResponseDecisionMs`; STT plus response-handler decision)
- speech-end-to-first-audio (`speechEndToFirstAudio*Ms`; STT plus response total plus first-sentence synthesis) for cached and uncached first sentence paths
- legacy aliases `speechToResponseStartMs` and `speechToVoiceStart*Ms`
- voice generation time (`TEXT_TO_SPEECH` model)
- voice first-token proxy (first-sentence synthesis) in two paths:
  - uncached first sentence
  - cached first sentence while synthesizing remainder in parallel
- end-to-end time
- p95/p99 latency tails (transcription, response TTFT/total, TTS, voice TTFT, cached pipeline, end-to-end)
- in-context and out-context excerpts
- model input/output excerpts from trajectory logs (raw vs cleaned)
- thinking/XML tag detection counts on model raw output
- trajectory counts (provider accesses + LLM calls)

## Modes

- `simple`: normal path, no benchmark context injected
- `non-simple`: injects `benchmarkContext` metadata so `CONTEXT_BENCH` forces the non-simple action loop

## Provider Profiles

- `groq`: Groq for transcription + response models + voice generation
- `elevenlabs`: Groq for response models, ElevenLabs for transcription + voice generation
- `mock`: deterministic in-process model, transcription, and TTS handlers for smoke tests without external credentials

## Required Environment

Common:

- `VOICEBENCH_AUDIO_PATH` (optional; if unset, `run.sh` will try these defaults in order):
  - `benchmarks/voicebench/shared/audio/default.wav`
  - `agent-town/public/assets/background.mp3`
  - `run.sh` resolves the selected path to an absolute path before invoking the TypeScript runner
  - `mock` profile additionally falls back to `benchmarks/voicebench/shared/mock-audio.txt`

Mock profile:

- no external credentials

Groq profile:

- `GROQ_API_KEY`
- `GROQ_LARGE_MODEL` (optional; default: `openai/gpt-oss-120b`)
- `GROQ_SMALL_MODEL` (optional; default: `openai/gpt-oss-120b`)
- `GROQ_TRANSCRIPTION_MODEL` (optional; default: `whisper-large-v3-turbo`)
- `GROQ_TTS_MODEL` (optional; default: `canopylabs/orpheus-v1-english`)
- `GROQ_TTS_VOICE` (optional; default: `troy`)
- `GROQ_TTS_RESPONSE_FORMAT` (optional; default: `wav`)

ElevenLabs profile:

- `GROQ_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_MODEL_ID` (optional; default in `run.sh`: `eleven_flash_v2_5`)
- `ELEVENLABS_VOICE_ID` (optional; default in `run.sh`: `EXAVITQu4vr4xnSDxMaL`)
- `ELEVENLABS_OPTIMIZE_STREAMING_LATENCY` (optional; default in `run.sh`: `4`)
- `ELEVENLABS_OUTPUT_FORMAT` (optional; default in `run.sh`: `mp3_22050_32`)

## Run

```bash
cd benchmarks/voicebench
./run.sh --profile=mock --iterations=1 --dataset=fixtures/manifest-mock.json
./run.sh --profile=groq
./run.sh --profile=elevenlabs
```

Run benchmark against labeled dataset:

```bash
cd benchmarks/voicebench
./run.sh --profile=groq --dataset=fixtures/manifest-groq.json
./run.sh --profile=elevenlabs --dataset=fixtures/manifest-elevenlabs.json
```

Optional flags:

- `--iterations=N` (default from `shared/config.json`)
- `--ts-only` (no-op; only TypeScript runs). `--py-only` / `--rs-only` exit with an error.
- `--output-dir=/absolute/or/relative/path`
- `--dataset=/path/to/manifest.json` (uses fixture samples instead of a single `VOICEBENCH_AUDIO_PATH`)

Results are written as JSON in `benchmarks/voicebench/results/`.

## Notes

- Fixture prompts live in `benchmarks/voicebench/shared/fixture_prompts.jsonl`.
- Response verbosity is hard-capped via `responseMaxChars` in `benchmarks/voicebench/shared/config.json`.
- Fixture manifests include `samples[].id`, `samples[].text`, and `samples[].audioPath`.
- TypeScript runner dynamically imports plugin packages from:
  - `plugins/plugin-groq`
  - `plugins/plugin-elevenlabs`
- If Bun reports missing plugin dependencies, install those plugin dependencies first.
