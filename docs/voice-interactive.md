# Interactive voice E2E

`bun run voice:interactive` is a runnable, human-in-the-loop end-to-end voice
harness for Eliza-1 (`eliza-1-2b` by default). Speak into your mic, get a spoken reply
back — the full optimized voice-assistant loop the W1–W13 swarm landed, run
interactively. There's also an automated headless e2e
(`packages/app-core/src/services/local-inference/voice/interactive-session.e2e.test.ts`)
that exercises the same path with synthetic audio + stub backends.

It assembles the same pipeline `LocalInferenceEngine.startVoiceSession()`
builds:

```
mic → VAD (RMS gate + Silero v5 ONNX)
   → streaming ASR (fused Qwen3-ASR, else whisper.cpp)
   → VoiceTurnController  (prewarm on speech-start, speculative generate on
                           speech-pause >~300ms, abort on resume, promote-or-
                           rerun on speech-end)
   → runtime message handler  (Stage-1 forced-JSON-structure grammar,
                               streamed: {shouldRespond, replyText, contexts, …})
   → PhraseChunker  (flush on , . ! ? / 30 words)
   → streaming OmniVoice TTS
   → PcmRingBuffer → system audio sink (aplay / paplay / sox `play`)
```

with **DFlash speculative decoding**, **KV-prefix prewarm**
(`prewarmResponseHandler`), **streaming LLM→TTS**, **barge-in**
(pause / resume / hard-stop), and **force-stop** on a keypress all wired on.

## Prerequisites (the harness checks all of these and prints a fix command per missing one)

| Prereq | How to get it |
|---|---|
| The DFlash `llama-server` binary, with the kernels `eliza-1-2b` requires (`dflash`, `turbo3`, `turbo4`, `qjl_full`, `polarquant`) advertised in its `CAPABILITIES.json` | `bun run local-inference:dflash:build` (or `packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>`, see `packages/inference/AGENTS.md` §8). Per-backend coverage: **Metal** (Apple Silicon) graph-dispatches all 5; the **CUDA** fork binary ships all 5 `.cu`/`.cuh`; **Vulkan** stages the shaders + source-patches dispatch (runtime-verified on Intel ANV and Pixel 6a/Mali-G78; Adreno still needs a physical-device run); **CPU** builds advertise `dflash`/`turbo3`/`turbo4` via `tbq3_0`/`tbq4_0` (the patch hook also extends the `--cache-type-k/v` whitelist with `qjl1_256`/`q4_polar`, so a CPU build now also advertises `qjl_full`/`polarquant`); `turbo3_tcq` is only required for the 27b-256k context tiers. If the host's binary genuinely can't dispatch a required kernel (e.g. ROCm/HIP — the custom kernels aren't HIP-ported yet), set **`MILADY_LOCAL_ALLOW_STOCK_KV=1`**: the model loads with stock `f16` KV instead of hard-refusing — a loud one-time warning, NOT publishable, NOT a default — so the voice pipeline still *runs*. (Build-side companion: `ELIZA_DFLASH_ALLOW_REDUCED_KERNELS=1` lets `build-llama-cpp-dflash.mjs` finish such a target with `publishable: false` + `reducedOptimizationLocalMode: true` instead of throwing.) |
| The `eliza-1-2b` bundle (text GGUF + drafter + ASR + VAD + TTS + speaker preset) installed under `<state-dir>/local-inference/models/eliza-1-2b.bundle/` | Download it from the dashboard, or acquire/convert/quantize/stage it per `RELEASE_V1.md`, then either let the harness re-register it (it reads the bundle manifest and registers the text GGUF + drafter automatically) or set `ELIZA_AUTO_DOWNLOAD_BUNDLE=1` to have the harness download it. |
| A real TTS backend — the fused `libelizainference` (real OmniVoice TTS + Qwen3-ASR; full graph on macOS-Metal, a CPU/Vulkan/CUDA fused build runs but slower) | Build it: `packages/app-core/scripts/omnivoice-fuse/README.md`. The stub TTS backend emits silence and is **rejected** by `startVoiceSession` — there is no silent fallback. |
| An ASR backend — the fused Qwen3-ASR region in the bundle, **or** whisper.cpp | The bundle ships an `asr/` region by default; otherwise set `ELIZA_WHISPER_BIN` to a `whisper-cli`/`main` binary + `ELIZA_WHISPER_MODEL` to a ggml model, or let the harness auto-download `ggml-base.en.bin` (~140 MB). |
| The Silero v5 VAD ONNX (`vad/silero-vad-int8.onnx`, ~2 MB, MIT), run on `onnxruntime-node` (desktop) / `onnxruntime-mobile` (iOS/Android) | Shipped in the bundle; otherwise set `ELIZA_VAD_MODEL_PATH`, or let the harness auto-download it. `onnxruntime-node` is an `optionalDependency` and works on Linux/Windows/macOS × x64/arm64; a missing runtime is a hard error (no silent downgrade to the RMS gate). On mobile the Capacitor ONNX bridge runs the model. |
| A microphone (interactive mode only) | Auto-resolved per platform: **Linux** `arecord` (alsa-utils) / `parec` (PulseAudio) / `sox`; **macOS** `sox -d` (`rec`) / `ffmpeg -f avfoundation`; **Windows** `ffmpeg -f dshow` (DirectShow). When no CLI recorder is on `PATH`, feed PCM via `PushMicSource` (the renderer's `getUserMedia`, the Capacitor `Microphone` plugin on mobile, or `--wav` / `--say`). |
| A speaker (interactive, non-`--no-audio` mode) | Auto-resolved: **Linux** `aplay` / `paplay` / `play`(sox) / `ffplay`; **macOS** `play`(sox) / `ffplay` (`afplay` needs a file, not used for streaming); **Windows** `ffplay` / `play`(sox). When none is on `PATH` the harness falls back to `WavFileAudioSink` (writes `out-<ts>.wav`) — never silence. |

If anything's missing the harness prints a checklist of what's missing + the
exact command to fix each, then exits non-zero (it never fakes — no
silence-and-call-it-TTS, no pretend-a-model-loaded). `bun run voice:interactive
-- --list-active` prints the active-optimizations list (and the missing-prereq
checklist, if any) and exits without trying to start a session.

## Modes

| Invocation | What it does |
|---|---|
| `bun run voice:interactive` | Real mic, interactive (default). |
| `bun run voice:interactive -- --list-active` | Print which optimizations are active + the prereq checklist (host-aware: shows which mic recorder / audio player / ONNX runtime this machine would use), then exit. |
| `bun run voice:interactive -- --platform-report` | Print the cross-platform voice support matrix — for {iOS, Android, Linux-x64, Linux-arm64, Windows-x64, Windows-arm64, macOS-arm64} × {the GPU backends available there}: runtime path (llama-server-spawn vs in-process FFI), kernel coverage, mic + player, VAD runtime, TTS/ASR backend, and what's verified vs needs-hardware/needs-SDK. Always exits 0. |
| `bun run voice:interactive -- --say "hello"` | Skip ASR; inject the text directly as a finalized transcript — tests the LLM→TTS half without a mic. Writes audio to the sink, runs one turn, exits. |
| `bun run voice:interactive -- --wav speech.wav` | Feed a WAV file through the same path once (mic→VAD→ASR→LLM→TTS) — a quick non-mic smoke. |
| `bun run voice:interactive -- --no-audio` | Don't play to speakers; write `out-<ts>.wav` instead (also the fallback when no `aplay`/`paplay`/`play`/`ffplay` is on `PATH`). |
| `bun run voice:interactive -- --no-dflash` | Set `ELIZA_DFLASH_DISABLE=1` for a sanity-compare run. The harness warns loudly — this is a **developer-only kill switch**, not a product setting; the eliza-1 path is designed to run with DFlash always on (`packages/inference/AGENTS.md` §4). |
| `bun run voice:interactive -- --room <id>` | Set the conversation/room id. |

## Keyboard controls (interactive modes, raw mode)

| Key | Action |
|---|---|
| `s` | Force-stop the in-flight LLM/drafter generation + TTS for the current turn (`engine.triggerBargeIn()` — drains the ring buffer, flushes the chunker, aborts the generate's `AbortSignal`; exactly the barge-in `hard-stop` path, so the abort propagates past TTS into the LLM/drafter). |
| `m` | Mute / unmute the mic. |
| `p` | Print the full latency histogram (`voiceLatencyTracer.histogramSummaries()` — p50/p90/p99 per derived stage). |
| `q` | Clean shutdown — stop the session, disarm voice, unload the model, exit 0. |
| `Ctrl-C` | Once = force-stop; twice (within 1.5 s) = clean shutdown. |

## Live UI

As you speak, the harness prints `[heard]` markers as the VAD fires, `[final]
<transcript>` on speech-end, `[agent] <replyText streaming>` token-by-token,
the structured envelope fields as they close (`shouldRespond=RESPOND
replyText.len=…`), and `[barge-in] paused` / `[barge-in] resumed` /
`[barge-in] hard-stop (words detected)` events.

## Latency trace lines

After each turn the harness prints a one-line trace from
`voiceLatencyTracer.recentTraces()`:

```
trace: VAD→first-LLM-token=Xms  →first-replyText-char=Yms  →first-TTS-audio=Zms  →audio-played=Wms  dflash-accept=N%
```

| Field | Span (latency-trace checkpoints) | Meaning |
|---|---|---|
| `VAD→first-LLM-token` | `vad-trigger → llm-first-token` (TTFT) | How long from "you made a sound" to the model's first token. |
| `→first-replyText-char` | `llm-first-token → llm-first-replytext-char` | Envelope-skip overhead — how fast the forced-grammar `replyText` field opens after generation starts. |
| `→first-TTS-audio` | `vad-trigger → tts-first-audio-chunk` (TTFA) | How long to the first synthesized PCM chunk. |
| `→audio-played` | `vad-trigger → audio-first-played` (TTAP — the headline) | How long until the first audio came out of the speaker. |
| `dflash-accept` | (from the running `llama-server`'s `/metrics`) | DFlash drafter token-acceptance rate this turn. `—` when no server / no drafter. |

`p` prints the full per-stage histogram (the same one
`bun run voice:latency-report` shows when a dev API is running).

## Automated headless e2e

`bun test packages/app-core/src/services/local-inference/voice/interactive-session.e2e.test.ts`
(Bun's test runner — the repo's `*.e2e.test.ts` files are run by `bun test`,
not vitest, matching `engine.e2e.test.ts`). It boots the same standalone
engine + voice bridge but with a `PushMicSource` fed synthetic speech PCM and
an in-memory audio sink, and asserts:

- **Unconditionally** (stub TTS backend + a deterministic test transcriber + a
  fake `generate`): the VAD event order
  (`speech-start → speech-active → speech-pause → speech-end`); the
  transcriber emits `partial` then `final`; the `generate` outcome is a valid
  forced-grammar envelope shape (`shouldRespond ∈ {RESPOND,IGNORE,STOP}`,
  `replyText` a string, `contexts` an array); `replyText` tokens reach the
  scheduler and the in-memory sink gets >0 PCM samples with the first chunk
  arriving before the last token (streaming); force-stop
  (`engine.triggerBargeIn()` mid-`generate` → the in-flight `AbortSignal`
  fires and `generate` returns/throws a cancellation that propagated past TTS
  into the LLM/drafter); barge-in (`speech-active → pause-tts`, blip →
  `resume-tts`, ASR-confirmed words → `hard-stop`); the latency-tracer surface
  is queryable.
- **`it.skipIf(!realBackendPresent)`**: the same path against the real
  `eliza-1-2b` bundle + fused TTS + the required kernels, asserting real PCM
  output. Skips when the bundle / fused build / required kernels aren't
  present — i.e. almost everywhere except a macOS-Metal box with the bundle
  staged.

## Cross-platform voice support matrix

The full mic → VAD → ASR → forced-grammar LLM (DFlash) → streaming TTS →
audio-out pipeline is meant to run on **every platform regardless of GPU
architecture**. `bun run voice:interactive -- --platform-report` prints the
live version of this; the summary:

| Platform | GPU backend(s) | Runtime path | Kernel coverage | Mic | Player | VAD runtime | TTS/ASR | Status |
|---|---|---|---|---|---|---|---|---|
| Linux x64 | cpu | `llama-server` spawn | dflash/turbo3/turbo4 via tbq3_0/tbq4_0; qjl_full/polarquant via the extended `--cache-type-k/v` whitelist; turbo3_tcq not a cache type | arecord / parec / sox | aplay / paplay / sox / ffplay | onnxruntime-node | fused `libelizainference` (CPU) / whisper.cpp ASR fallback | builds + runs on a Linux host |
| Linux x64 | cuda | `llama-server` spawn | all 5 (fork CUDA binary ships the `.cu`/`.cuh`) | arecord / parec / sox | aplay / paplay / sox / ffplay | onnxruntime-node | fused `libelizainference` (CUDA) | CUDA kernels hardware-verified on RTX 5080; build needs `nvcc` |
| Linux x64 | rocm | `llama-server` spawn | custom kernels not HIP-ported → **reduced-optimization local mode** (`MILADY_LOCAL_ALLOW_STOCK_KV=1`, stock f16 KV) | arecord / parec / sox | aplay / paplay / sox / ffplay | onnxruntime-node | fused `libelizainference` (HIP) | needs a ROCm host (`hipcc`) |
| Linux x64 | vulkan | `llama-server` spawn | all 5 shaders staged + dispatch source-patched | arecord / parec / sox | aplay / paplay / sox / ffplay | onnxruntime-node | fused `libelizainference` (Vulkan) | shaders + fused-attn graph dispatch verified on Intel ARL ANV; needs-hardware elsewhere |
| Linux aarch64 | cpu / cuda | `llama-server` spawn | CPU SIMD TUs (ARMv8.4 dotprod) / CUDA fork binary | arecord / parec / sox | aplay / paplay / sox / ffplay | onnxruntime-node (arm64) | fused `libelizainference` | needs an arm64 Linux host (GH200 for cuda) |
| Windows x64 | cpu / cuda / vulkan | `llama-server` spawn (QJL TUs folded into `ggml-base` for the DLL link) | same as Linux per backend | ffmpeg -f dshow / renderer getUserMedia | ffplay / renderer AudioContext | onnxruntime-node | fused `libelizainference` | build needs MSVC/mingw (+CUDA SDK / Vulkan GPU); cross-config `--dry-run` only on a Linux host |
| Windows arm64 | cpu / vulkan | `llama-server` spawn | CPU SIMD TUs (NEON) / Vulkan shaders | ffmpeg -f dshow / renderer getUserMedia | ffplay / renderer AudioContext | onnxruntime-node (arm64) | fused `libelizainference` | needs an MSVC arm64 cross-toolchain or a native Windows arm64 host (Snapdragon X / Adreno X1) |
| macOS arm64 | metal | `llama-server` spawn (the `*-fused` build serves `/v1/audio/speech` in-process) | **all 5 graph-dispatched** on Apple Silicon | sox -d / ffmpeg -f avfoundation / renderer getUserMedia | sox / ffplay / renderer AudioContext | onnxruntime-node (arm64) | fused `libelizainference.dylib` (full graph) | Metal kernels hardware-verified on M4 Max; needs a macOS arm64 host to build |
| iOS arm64 | metal | **in-process FFI** (`@elizaos/llama-cpp-capacitor` `LlamaCpp.xcframework` + `@elizaos/plugin-aosp-local-inference` `aosp-llama`/`aosp-dflash` adapters) — NOT `llama-server`-spawn | static `.a` + embedded `default.metallib` carry the 5 milady kernel symbols; on-device graph dispatch matches macOS-Metal once the xcframework is rebuilt with them | Capacitor `Microphone` plugin → `PushMicSource` | Capacitor audio sink → `PcmRingBuffer` → native `AVAudioEngine` | `onnxruntime-mobile` (iOS) / Capacitor ONNX bridge | fused `libelizainference` (`ios-arm64-metal-fused` — to add) carried inside the xcframework, or the Capacitor framework links the `omnivoice_*` symbols | needs an Xcode build (macOS + Xcode): `packages/app-core/scripts/ios-xcframework/build-xcframework.mjs` + a physical-device smoke (`run-physical-device-smoke.mjs`) |
| Android arm64 | cpu / vulkan | **in-process FFI** (`@elizaos/plugin-aosp-local-inference` `compile-libllama.mjs` → `libllama.so` + the `aosp-llama`/`aosp-dflash` adapters) — NOT `llama-server`-spawn | CPU SIMD TUs (NEON) / Vulkan shaders (needs a physical Vulkan-1.3 device for the dispatch smoke) | Capacitor `Microphone` plugin → `PushMicSource` | Capacitor audio sink → `PcmRingBuffer` → native `AudioTrack` | `onnxruntime-mobile` (Android) / Capacitor ONNX bridge | fused `libelizainference` (`android-arm64-{cpu,vulkan}-fused` — to add) inside the AAR | needs an Android Studio / NDK build (`aosp/compile-libllama.mjs` cross-compiles); the Vulkan path needs a device for the dispatch smoke |

### §3-vs-"works-everywhere" reconciliation

`packages/inference/AGENTS.md` §3 mandates the TurboQuant/QJL/PolarQuant/DFlash
kernels on every bundle and forbids a "kernels-missing fallback build". The
SA-1 directive is "works everywhere regardless of GPU". The reconciliation:

1. **The build dispatches the kernels on every backend where it can** — Metal
   (all 5 graph-dispatched), CUDA (fork binary ships the `.cu`/`.cuh`), Vulkan
   (shaders staged + dispatch source-patched + runtime-dispatch evidence), CPU
   (turbo3/turbo4 via `tbq3_0`/`tbq4_0`, plus the `--cache-type-k/v` whitelist
   extended with `qjl1_256`/`q4_polar` so QJL+Polar are reachable).
2. **For backends where a required kernel can't be dispatched yet** (ROCm/HIP;
   `turbo3_tcq` as a generic K/V cache type — it has a block layout but no ggml
   type-traits entry), there is an **opt-in reduced-optimization local mode**:
   `MILADY_LOCAL_ALLOW_STOCK_KV=1` at runtime (and `ELIZA_DFLASH_ALLOW_REDUCED_KERNELS=1`
   at build time) loads the model with stock `f16` KV instead of hard-refusing,
   with a **loud one-time warning** every relevant time. This mode is **not
   publishable** and **not a default** — `defaultEligible` bundles still require
   the verified kernels per backend (`eliza-1.manifest.json` `kernels.verifiedBackends`).
   The default (no env var) still hard-refuses, preserving §3.

So the voice pipeline *runs* everywhere; the *optimized* path is shipped where
the kernels are dispatched, and the reduced path is the loudly-flagged escape
hatch for the rest.
