# @elizaos/plugin-local-inference

Eliza-1 local inference provider for elizaOS. Serves text generation, embeddings, text-to-speech, ASR, image generation, and image description entirely on-device — no network required after model download.

## What it does

- **Text generation** (`TEXT_SMALL`, `TEXT_LARGE`) via an in-process llama.cpp FFI binding. There are two text runtime classes, picked per model by the dispatcher (`services/backend.ts`):
  - **fused Eliza-1 bundles** (`runtimeClass: "fused-eliza1"`) run through the fused `libelizainference` (`desktop-fused-ffi-backend-runtime.ts`) — the full local pipeline: manifest-gated MTP speculative decoding, fork kernels where applicable, native tokenization over the active Eliza-1 bundle tokenizer, and fused voice/vision/ASR. This is the default/recommended path.
  - **generic single-file GGUF** (`runtimeClass: "generic-gguf"`) — a model you downloaded/scanned (Hugging Face / ModelScope / LM Studio / Ollama) loaded from an explicit `modelPath` with stock f16 KV and *reduced optimizations* (no MTP, no fork kernels, no fused voice/vision). The explicit-`modelPath` binding ships on mobile (`llama-cpp-capacitor`); on desktop it is not yet built into the shipping `libelizainference`, so an assigned generic model is rejected at the assignment boundary with a typed reason rather than failing silently at load.
- `node-llama-cpp` has been retired; there is no node-llama-cpp fallback.
- **Text embeddings** (`TEXT_EMBEDDING`) via a dedicated embedding GGUF loaded separately from the chat model.
- **Text-to-speech** (`TEXT_TO_SPEECH`) via the local Kokoro/OmniVoice runtime selected by tier and policy.
- **Automatic speech recognition** (`TRANSCRIPTION`) via the eligible bundled local ASR head in fused `libelizainference`; there is no whisper.cpp fallback.
- **Image generation** (`IMAGE`) via sd.cpp, CoreML (Apple Silicon), mflux, TensorRT, or AOSP backends; selected by hardware and catalog entry.
- **Image description / vision** (`IMAGE_DESCRIPTION`) via the tier-matched Eliza-1 multimodal projector attached to the active text model.
- **Model catalog, download management, and hardware-fit recommendation** exposed as HTTP routes for the elizaOS dashboard.
- **Voice pipeline**: barge-in, VAD, speaker imprint, phrase streaming, voice profiles, and first-run onboarding.

## Capabilities added to an Eliza agent

| Capability | How it appears |
|---|---|
| `GENERATE_MEDIA` action | Agent responds to "draw me a ...", "say ...", "speak ...", etc. by calling the local image or TTS backend. |
| `TEXT_SMALL` / `TEXT_LARGE` handler | Agent uses the active Eliza-1 text model for all reasoning and response generation. |
| `TEXT_EMBEDDING` handler | Agent embeds memories using the local embedding GGUF; avoids cloud API calls for RAG. |
| `TEXT_TO_SPEECH` handler | Agent converts text to audio using the selected local TTS backend. |
| `TRANSCRIPTION` handler | Agent transcribes audio using the eligible bundled local ASR runtime. |
| `IMAGE` handler | Agent generates images using the active local diffusion backend. |
| `IMAGE_DESCRIPTION` handler | Agent describes images using the active multimodal model. |

## Requirements

- Node.js 20+ or Bun runtime.
- The fused `libelizainference` native library for the desktop text/voice/vision path (built from `tools/omnivoice`; resolved via `ELIZA_INFERENCE_LIBRARY` / `ELIZA_INFERENCE_LIB_DIR` or the bundle's `lib/` dir). Generic single-file GGUF additionally needs the explicit-`modelPath` binding (`llama-cpp-capacitor` on mobile).
- Native binaries for optional capabilities: `sd.cpp` for image-gen on Linux/Windows and `mflux` for Apple Silicon image-gen.
- An Eliza-1 GGUF bundle downloaded via the model catalog (dashboard → Models, or `POST /api/local-inference/downloads`).

## Enabling the plugin

Add `@elizaos/plugin-local-inference` to the `plugins` array in your elizaOS agent character or bootstrap configuration:

```ts
import localInferencePlugin from "@elizaos/plugin-local-inference";

const agent = new AgentRuntime({
  plugins: [localInferencePlugin],
  // ...
});
```

The plugin registers its model handlers at priority `−100`. The routing-policy layer (not raw priority) controls whether a given request is served locally or by a cloud provider. Users configure this in the dashboard under Settings → Model Routing.

## Configuration

Key environment variables (all optional unless noted):

| Variable | Purpose |
|---|---|
| `MODELS_DIR` | Override the GGUF model directory (default: `~/.eliza/models`) |
| `LOCAL_SMALL_MODEL` | Small model filename (mobile/Capacitor adapter) |
| `LOCAL_LARGE_MODEL` | Large model filename (mobile/Capacitor adapter) |
| `ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP` | Set truthy to defer startup GGUF embedding prefetch until the dev/runtime server is ready |
| `ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP` | Set truthy to skip GGUF embedding prefetch entirely while leaving local embedding settings intact |
| `ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP` | Desktop startup opt-in that starts GGUF embedding warmup during runtime bootstrap when no skip/defer override is set |
| `ELIZA_DISABLE_LOCAL_EMBEDDINGS` | Set `1` to disable local `TEXT_EMBEDDING` registration entirely |
| `ELIZA_IMAGEGEN_ACCELERATOR` | Force image-gen backend: `coreml`, `mflux`, `sd-cpp`, `tensorrt` |
| `ELIZA_DEVICE_BRIDGE_ENABLED` | Enable iOS/AOSP physical device bridge |
| `SD_CPP_BIN` | Absolute path to sd.cpp binary |
| `MFLUX_BIN` | Absolute path to mflux binary |
| `ELIZA_KOKORO_DEFAULT_VOICE_ID` | Default Kokoro TTS voice |

## Architecture notes

The plugin exposes these subpath exports (see `package.json` `exports`):

- `@elizaos/plugin-local-inference` — plugin object, `GENERATE_MEDIA` action, `handleLocalInferenceRoutes`, embedding presets.
- `@elizaos/plugin-local-inference/runtime` — boot-time handler registration (`ensureLocalInferenceHandler`), embedding warm-up policy, mobile gate.
- `@elizaos/plugin-local-inference/runtime/embedding-presets` — `detectEmbeddingPreset`, `EMBEDDING_PRESETS`.
- `@elizaos/plugin-local-inference/routes` — HTTP route handlers (`handleLocalInferenceCompatRoutes`, TTS/ASR, voice) mounted by app-core.
- `@elizaos/plugin-local-inference/services` — full service surfaces (engine, arbiter, catalog, recommendation, voice) for deep integrations.

The **MemoryArbiter** (`services/memory-arbiter.ts`) is the single coordination point for all model handles across modalities. On memory-constrained devices (mobile, low-RAM desktop), the arbiter evicts models by priority before loading a new one. Cross-plugin consumers (vision, image-gen) register capabilities via `arbiter.registerCapability(...)` rather than loading models independently.

## Voice Workbench (#8785)

This package hosts the **Voice Workbench** — one scenario/corpus/benchmark
harness that unifies what used to be five disjoint voice-test families behind a
single entrypoint, scenario format, and metric module.

### Entrypoint

```bash
bun run --cwd plugins/plugin-local-inference voice:workbench \
  [--mock|--logic|--real] [--out <dir>] [--baseline <report.json>]
```

- `--mock` (default) — ground-truth mock services; the CI plumbing lane (no
  model, no network). Runs + passes.
- `--logic` — the shipped decision logic (EOT / respond / echo / bystander /
  wake-word gate + name extraction) over the corpus, without acoustic models.
  CI-runnable; catches a regression in the decision layer.
- `--real` — real local acoustic backend; any scenario without a provisioned
  real service reports `skipped`, never a false `pass` (the honesty contract).
- `--baseline <path>` — compare metrics against a golden report; exit 1 on any
  metric regression past tolerance (the regression gate).

It writes one machine-readable `report.json` plus a Markdown rendering — WER,
EOT latency + false-trigger rate, diarization DER, respond accuracy,
entity-match, first-audio/TTFT latency — via `workbench-entrypoint.ts` +
`voice-workbench-report.ts`.

### Pieces

- **Scenario schema** — `services/voice/voice-scenario.ts`: a declarative
  `VoiceScenario` (participants + ordered turns + assertions) that both the
  headless runner and the headful player execute and the benchmark layer scores,
  covering every class: multi-voice, pauses, respond/no-respond, multi-speaker,
  diarization, entity-extraction, voice→entity match, EOT, transcription-mode,
  multi-agent room, and the long-form monologue.
- **Corpus generator** — `corpus:generate` (`scripts/generate-voice-corpus.ts`)
  TTS-synthesizes each turn, splices pauses, and mixes multi-speaker streams into
  a versioned labeled corpus (PCM + ground-truth JSON). Robustness DSP
  (noise / reverb / gain / low-quality-line) lives in `corpus-augment.ts`.
- **Single scoring module** — `services/voice/e2e-harness.ts` is the one shared
  source of truth for voice scoring (`scoreTtsAsrRoundTrip`, `scoreEotDecision`,
  `scoreDiarization`, `scoreRespondDecision`, `scoreEntityExtraction`,
  `scoreVoiceEntityMatch`, `scoreEchoRejection`, `scoreOwnerSecurity`, …); WER
  itself is `@elizaos/shared/voice-wer`. The duplicate `wordErrorRate` that used
  to live in the headful `voice-selftest-harness.ts` is gone — it imports the
  shared one.
- **Headless runner** — `workbench-headless-runner.ts` drives each scenario class
  through the real services and scores it; an absent corpus/backend yields
  `skipped`, never `pass`.
- **scenario-runner audio turn** — `packages/scenario-runner/src/voice-turn.ts`
  adds a `voice` turn kind so voice scenarios are first-class `.scenario.ts`
  files over a real `AgentRuntime`.
- **Headful specs** — `packages/app/test/ui-smoke/voice-workbench-*.spec.ts` (one
  per scenario class) drive the real frontend client pipeline with a per-turn
  DOM-mirrored verdict.
- **Real-model lanes** (dev hosts with a built engine + staged models):
  `roundtrip:real` (cloud-TTS → local ASR → fast cloud LLM → cloud-TTS),
  `robustness:real` (WER under noise / reverb / far-field / telephone),
  `voicestack:real` (speaker recognition / diarization / VAD / local TTS),
  `agentvoice:real` (agent-self-voice rejection + overlapping speakers).
- **CI** — `.github/workflows/voice-workbench.yml` runs the `--logic` lane plus
  the regression baseline on every change to the voice surface.

### Legacy harnesses it absorbs

The workbench is the single home for what was previously fragmented across a pure
scoring lib (`e2e-harness.ts`, now promoted to the source of truth), a two-agent
`voice:duet` harness, native `packages/benchmarks/voice/*.mjs` scenarios, Python
benches, and the single-turn headful self-test (`voice-selftest`). Those remain
runnable, but **new** voice coverage should be authored as a `VoiceScenario` +
corpus and scored through `e2e-harness.ts`, not as a new bespoke harness.

For agent-facing documentation see `CLAUDE.md` / `AGENTS.md` in this directory.
