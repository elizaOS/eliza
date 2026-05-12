# Interactive voice E2E

`bun run voice:interactive` is a runnable, human-in-the-loop end-to-end voice
harness for Eliza-1 (`eliza-1-1_7b`). Speak into your mic, get a spoken reply
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
| The DFlash `llama-server` binary, with the kernels `eliza-1-1_7b` requires (`dflash`, `turbo3`, `turbo4`, `qjl_full`, `polarquant`) advertised in its `CAPABILITIES.json` | `bun run local-inference:dflash:build` — and note that `qjl_full` / `polarquant` / `turbo3_tcq` currently ship on the **macOS-Metal** fused build; a Linux/Windows CPU/CUDA build won't advertise them, so a real interactive turn currently needs the macOS-Metal fused build (`packages/app-core/scripts/build-llama-cpp-dflash.mjs --target <triple>`, see `packages/inference/AGENTS.md` §8). |
| The `eliza-1-1_7b` bundle (text GGUF + drafter + ASR + VAD + TTS + speaker preset) installed under `<state-dir>/local-inference/models/eliza-1-1_7b.bundle/` | Download it from the dashboard, or acquire/convert/quantize/stage it per `RELEASE_V1.md`, then either let the harness re-register it (it reads the bundle manifest and registers the text GGUF + drafter automatically) or set `ELIZA_AUTO_DOWNLOAD_BUNDLE=1` to have the harness download it. |
| A real TTS backend — the fused `libelizainference` (real OmniVoice TTS + Qwen3-ASR; full graph on macOS-Metal, a CPU fused build runs but slower) | Build it: `packages/app-core/scripts/omnivoice-fuse/README.md`. The stub TTS backend emits silence and is **rejected** by `startVoiceSession` — there is no silent fallback. |
| An ASR backend — the fused Qwen3-ASR region in the bundle, **or** whisper.cpp | The bundle ships an `asr/` region by default; otherwise set `ELIZA_WHISPER_BIN` to a `whisper-cli`/`main` binary + `ELIZA_WHISPER_MODEL` to a ggml model, or let the harness auto-download `ggml-base.en.bin` (~140 MB). |
| The Silero v5 VAD ONNX (`vad/silero-vad-int8.onnx`, ~2 MB, MIT) | Shipped in the bundle; otherwise set `ELIZA_VAD_MODEL_PATH`, or let the harness auto-download it. |
| A microphone (interactive mode only) | macOS / Linux: `arecord` (alsa-utils) or `sox` on `PATH`. Windows has no universal CLI recorder — use `--wav <path>` or `--say "<text>"` there. |

If anything's missing the harness prints a checklist of what's missing + the
exact command to fix each, then exits non-zero (it never fakes — no
silence-and-call-it-TTS, no pretend-a-model-loaded). `bun run voice:interactive
-- --list-active` prints the active-optimizations list (and the missing-prereq
checklist, if any) and exits without trying to start a session.

## Modes

| Invocation | What it does |
|---|---|
| `bun run voice:interactive` | Real mic, interactive (default). |
| `bun run voice:interactive -- --list-active` | Print which optimizations are active + the prereq checklist, then exit. |
| `bun run voice:interactive -- --say "hello"` | Skip ASR; inject the text directly as a finalized transcript — tests the LLM→TTS half without a mic. Writes audio to the sink, runs one turn, exits. |
| `bun run voice:interactive -- --wav speech.wav` | Feed a WAV file through the same path once (mic→VAD→ASR→LLM→TTS) — a quick non-mic smoke. |
| `bun run voice:interactive -- --no-audio` | Don't play to speakers; write `out-<ts>.wav` instead (also the fallback when no `aplay`/`paplay`/`play` is on `PATH`). |
| `bun run voice:interactive -- --no-dflash` | Set `MILADY_DFLASH_DISABLE=1` for a sanity-compare run. The harness warns loudly — this is a **developer-only kill switch**, not a product setting; the eliza-1 path is designed to run with DFlash always on (`packages/inference/AGENTS.md` §4). |
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
  `eliza-1-1_7b` bundle + fused TTS + the required kernels, asserting real PCM
  output. Skips when the bundle / fused build / required kernels aren't
  present — i.e. almost everywhere except a macOS-Metal box with the bundle
  staged.
