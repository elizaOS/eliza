# @elizaos/plugin-local-inference

Eliza-1 local inference provider for elizaOS. Serves text generation, embeddings, text-to-speech, ASR, image generation, and image description entirely on-device — no network required after model download.

## What it does

- **Text generation** (`TEXT_SMALL`, `TEXT_LARGE`) via an in-process llama.cpp FFI binding. There are two text runtime classes, picked per model by the dispatcher (`services/backend.ts`):
  - **fused Eliza-1 bundles** (`runtimeClass: "fused-eliza1"`) run through the fused `libelizainference` (`desktop-fused-ffi-backend-runtime.ts`) — the full local pipeline: manifest-gated MTP speculative decoding, fork kernels where applicable, native tokenization over the active Eliza-1 bundle tokenizer, and fused voice/vision/ASR. This is the default/recommended path.
  - **generic single-file GGUF** (`runtimeClass: "generic-gguf"`) — a model you downloaded/scanned (Hugging Face / ModelScope / LM Studio / Ollama) loaded from an explicit `modelPath` with stock f16 KV and *reduced optimizations* (no MTP, no fork kernels, no fused voice/vision). The explicit-`modelPath` binding ships on mobile (`llama-cpp-capacitor`); on desktop it is not yet built into the shipping `libelizainference`, so an assigned generic model is rejected at the assignment boundary with a typed reason rather than failing silently at load.
- `node-llama-cpp` has been retired; there is no node-llama-cpp fallback.
- **Text embeddings** (`TEXT_EMBEDDING`) via a dedicated embedding GGUF loaded separately from the chat model.
- **Text-to-speech** (`TEXT_TO_SPEECH`) via the local Kokoro runtime (the only on-device TTS backend).
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
- The fused `libelizainference` native library for the desktop text/voice/vision path (built from the llama.cpp fork's fused-inference FFI tool at `tools/omnivoice` — the Kokoro TTS engine is folded into this library; resolved via `ELIZA_INFERENCE_LIBRARY` / `ELIZA_INFERENCE_LIB_DIR` or the bundle's `lib/` dir). Generic single-file GGUF additionally needs the explicit-`modelPath` binding (`llama-cpp-capacitor` on mobile).
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
| `ELIZA_DEFER_LOCAL_EMBEDDING_WARMUP` | Defer is the DEFAULT: startup GGUF embedding prefetch runs after the runtime is ready. Set to `0`/`false`/`no`/`off` for the eager process-entry prefetch |
| `ELIZA_SKIP_LOCAL_EMBEDDING_WARMUP` | Set truthy to skip GGUF embedding prefetch entirely while leaving local embedding settings intact |
| `ELIZA_ENABLE_STARTUP_LOCAL_EMBEDDING_WARMUP` | Desktop startup opt-in that starts GGUF embedding warmup during runtime bootstrap when no skip/defer override is set |
| `ELIZA_DISABLE_LOCAL_EMBEDDINGS` | Set `1` to disable local `TEXT_EMBEDDING` registration entirely |
| `ELIZA_IMAGEGEN_ACCELERATOR` | Force image-gen backend: `coreml`, `mflux`, `sd-cpp`, `tensorrt` |
| `ELIZA_DEVICE_BRIDGE_ENABLED` | Enable iOS/AOSP physical device bridge |
| `SD_CPP_BIN` | Absolute path to sd.cpp binary |
| `MFLUX_BIN` | Absolute path to mflux binary |
| `ELIZA_KOKORO_DEFAULT_VOICE_ID` | Default Kokoro TTS voice |

## Per-target local inference recommendations

The runtime already computes the recommendation from the hardware probe; this
table documents the current policy so device setup is reviewable without
reading code. The source of truth is:

- `src/services/device-tier.ts` for `MAX` / `GOOD` / `OKAY` / `POOR`
  classification and the mobile context clamp.
- `src/services/recommendation.ts` for text-model slot ladders.
- `src/runtime/embedding-presets.ts` for local embedding defaults.
- `scripts/local-inference-thresholds.json` for backend tok/s floors used by
  ablation gates.

| Target | Local mode | Text model policy | Context policy | Embeddings | Notes |
|---|---|---|---|---|---|
| Android / iOS phone, >= 6 GB RAM and >= 3 GB free | `OKAY` at best; local LM can run; voice defaults to cloud TTS/ASR with local turn detection, VAD, and wake-word only. | `TEXT_SMALL` uses `eliza-1-2b`; `TEXT_LARGE` tries `eliza-1-4b` then `eliza-1-2b`. | Mobile is capped at 64k even if coarse RAM math says 128k fits. | `gte-small_fp16.gguf`, 384 dimensions, 512 context. Use CPU on <= 8 GB or no accelerator; otherwise `gpuLayers: "auto"`. | Phone OS background-task limits are the reason for the tier cap; do not force 9B/27B on mobile for default routing. |
| 8 GB Apple Silicon | `OKAY`; local-capable with swapping discipline. | Prefer 2B/4B fits; avoid pinning larger tiers as defaults. | Use the fit selected by the dashboard; expect short or downscaled context under pressure. | CPU fallback if <= 8 GB; `gte-small` stays the embedding model. | `device-tier.ts` hard-caps 8 GB Apple Silicon at `OKAY`. |
| Apple Silicon >= 16 GB with >= 8 GB free | `GOOD` when the free/effective-memory gates pass; all models can run serialized. | `TEXT_SMALL`: 2B then 4B. `TEXT_LARGE`: 27B, 9B, 4B, 2B in fit order. | Long-context variants are preferred when the RAM/VRAM headroom gate passes. | `gte-small` with accelerator offload. | `MAX` requires >= 32 GB shared RAM plus the `MAX` free/effective memory gates. |
| Linux / Windows with discrete GPU >= 8 GB VRAM, >= 12 GB effective memory, and >= 8 GB free | `GOOD`; serialized local LM is recommended. | `TEXT_SMALL`: 2B then 4B. `TEXT_LARGE`: 27B, 9B, 4B, 2B in fit order. | Long-context variants are preferred when memory headroom passes. | `gte-small` with `gpuLayers: "auto"` on CUDA/Vulkan. | `MAX` requires >= 16 GB VRAM plus the free/effective memory gates. |
| CPU-only desktop >= 32 GB RAM with >= 8 GB free | `GOOD`; local LM is viable, but expect CPU tok/s floors rather than GPU floors. | `TEXT_SMALL`: 2B then 4B. `TEXT_LARGE`: 9B, 4B, 2B in fit order. | Prefer the dashboard fit; avoid forcing long context if free RAM is below the session gate. | CPU `gte-small` unless a supported accelerator is detected. | CPU-only effective model memory is `totalRamGb * 0.5`. |
| CPU-only desktop around 16 GB RAM | `OKAY`; local is possible with load/unload behavior. | Use the largest fit selected by the dashboard, usually 2B/4B. | Keep context conservative; let `selectBestEliza1FitForDevice()` downscale. | CPU `gte-small`. | If free RAM is below 25% of total, the tier is demoted. |
| Below the `OKAY` thresholds or unsupported CPU baseline | `POOR`; route model generation to cloud. | Do not pin a local default. | N/A | Cloud or disabled local embeddings. | `recommendedMode` is `cloud-only`; privacy helpers such as local turn detection/VAD can still run where available. |

Operational knobs:

- Use `LOCAL_INFERENCE_ACTIVE_TIER` only to pin a curated Eliza-1 tier for a
  known device; otherwise let the dashboard recommendation choose the largest
  fit.
- Use `ELIZA_LOCAL_IDLE_UNLOAD_MS` to free memory on shared or mobile hosts.
- Use `ELIZA_LOCAL_SESSION_POOL_SIZE` and
  `ELIZA_LOCAL_AUTO_RESIZE_PARALLEL=1` only when the host has enough headroom
  for concurrent conversations; the engine warns when the conversation high
  water mark exceeds the running `--parallel` value.
- Use `ELIZA_LOCAL_STREAM_TOKENS_PER_STEP` to trade streaming smoothness against
  JS/FFI round trips. The shared FFI runner default is `32`, clamped to
  `1`-`512`; the interactive chat path uses a finer default of `8` when the env
  is unset (internal / planner / voice calls keep the coarse `32`).
- Embedding overrides (`LOCAL_EMBEDDING_MODEL`,
  `LOCAL_EMBEDDING_GPU_LAYERS`, `LOCAL_EMBEDDING_CONTEXT_SIZE`,
  `LOCAL_EMBEDDING_DIMENSIONS`) should keep the SQL vector dimension in sync.
  The built-in `gte-small` preset is intentionally 384-dim because the default
  storage schema is 384-dim.
- Generic single-file GGUFs are advanced/developer-mode only and should not be
  used as automatic defaults. The default recommender is Eliza-1-only because
  fused bundles carry the manifest, tokenizer, KV/cache policy, and voice/vision
  assets the runtime can verify.

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

## Real-weight Kokoro smoke (#9588 loader↔GGUF drift gate)

`scripts/kokoro-real-smoke.ts` loads the fused `libelizainference`, loads the
**real** published Kokoro GGUF, synthesizes a phrase, and asserts non-empty
24 kHz PCM whose amplitude envelope looks like speech (envelope-cv ≫ 0.4) rather
than the flat noise the #9588 dtype/tensor-name bug produced. With an ASR bundle
staged (`ELIZA_ASR_BUNDLE`) it additionally gates intelligibility by WER.

It exits `0` on pass, `1` on a real failure, and `2` when the lib/model aren't
staged (so a dev box without them is skipped). Set **`KOKORO_SMOKE_REQUIRE=1`**
to turn every skip into a hard failure (exit `1`) — that is how the CI gate makes
a lane that is *supposed* to have staged the assets go RED instead of passing
silently.

Stage + run locally:

```bash
# 0. From a fresh checkout, install workspace dependencies first.
bun install
bun run --cwd packages/core prebuild

# 1. Build + stage the fused lib with Kokoro folded in.
node packages/app-core/scripts/stage-desktop-fused-lib.mjs --variant cpu --out /tmp/fused-lib

# 2. Stage the published Kokoro GGUF + a voice pack (af_bella is the fallback voice).
DIR=/tmp/kokoro-model; mkdir -p "$DIR/voices"
base="https://huggingface.co/elizaos/eliza-1/resolve/main"
curl -fSL -o "$DIR/kokoro-82m-v1_0.gguf" "$base/bundles/2b/tts/kokoro/kokoro-82m-v1_0.gguf?download=true"
curl -fSL -o "$DIR/voices/af_bella.bin" "$base/bundles/2b/tts/kokoro/voices/af_bella.bin?download=true"

# 3. Run the gate.
ELIZA_INFERENCE_LIB_DIR=/tmp/fused-lib LD_LIBRARY_PATH=/tmp/fused-lib \
  ELIZA_KOKORO_MODEL_DIR="$DIR" KOKORO_SMOKE_REQUIRE=1 \
  bun plugins/plugin-local-inference/scripts/kokoro-real-smoke.ts
```

CI runs exactly this on Linux via `.github/workflows/kokoro-real-smoke.yml`
(opt-in: `workflow_dispatch`, a `kokoro-smoke-*` tag, or a loader/converter/smoke/submodule change).

For agent-facing documentation see `CLAUDE.md` / `AGENTS.md` in this directory.
