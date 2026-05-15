# J3 — Single-runtime finalizer

**Status:** impl-done (partial — compute-gated on J1/J2 native ports)
**Agent:** J3
**Branch:** `develop`
**Date:** 2026-05-15
**PID:** written to `.swarm/run/J3.pid`

---

## TL;DR

J3 was scoped to remove ONNX dep paths after J1 (4 simpler native ports)
and J2 (Kokoro port) landed. Neither J1 nor J2 posted `phase=impl-done`
to `collab.md` — their processes exited without completing all native C
implementations. However J1 DID complete the GGUF-backed turn-detector
port (J1.d): `eot-classifier-ggml.ts` now implements `LiveKitGgmlTurnDetector`
backed by `node-llama-cpp` (fork), and `engine.ts` wires it into the
fallback chain ahead of the ONNX path. Three voice-classifier-cpp heads
still return `-ENOSYS` (Wav2Small, WeSpeaker, pyannote), and Kokoro's
StyleTTS-2 graph is not yet implemented. ONNX cannot be fully removed
from `package.json` yet.

This document records:
1. The honest state matrix (§A).
2. What J3 did (§B) — done.
3. What remains compute-gated (§C).
4. Verification of no regression (§D).

---

## A. State matrix (binding for next wave)

| Model | Runtime path | Status | Compute gate | Next step |
|---|---|---|---|---|
| Wav2Small emotion (cls7) | `voice-emotion-classifier.ts` → `onnxruntime-node` | ONNX (active) | `voice-classifier-cpp/src/voice_emotion_*.c` returns `-ENOSYS` | J1: implement ggml graph in `voice_classifier_stub.c` replacement |
| WeSpeaker R34-LM | `speaker/encoder.ts` → `onnxruntime-node` | ONNX (active) | `voice-classifier-cpp/src/voice_speaker_*.c` returns `-ENOSYS` | J1: implement ggml ResNet34 graph |
| pyannote-3 diarizer | `speaker/diarizer.ts` → `onnxruntime-node` | ONNX (active) | No ggml scaffold exists yet | J1: new `voice_diarizer_*.c` TU; SincNet+Transformer |
| LiveKit turn-detector (text-side ONNX) | `eot-classifier.ts::LiveKitTurnDetector` → `onnxruntime-node` | ONNX (last-resort fallback only) | `Eliza1EotClassifier` preferred (fork text model); `LiveKitGgmlTurnDetector` (J1.d) preferred over ONNX when GGUF on disk | Remove once GGUF is verified on all bundles |
| LiveKit turn-detector (GGUF — J1.d) | `eot-classifier-ggml.ts::LiveKitGgmlTurnDetector` → `node-llama-cpp` (fork) | **DONE** (J1.d, already committed) | GGUF must be staged on disk | Shipped; wired in engine.ts chain |
| Kokoro TTS | `kokoro/kokoro-runtime.ts` → `onnxruntime-node` | ONNX (active) | `LLM_ARCH_KOKORO` enum + stub loader in fork (W3-1); StyleTTS-2 graph NOT implemented | J2: `llama_model_kokoro::build_graph` + decoder dispatch in `llama-server` |
| OmniVoice TTS | fork FFI `libelizainference` | **DONE** (W3-3) | — | Shipped |
| Silero VAD | fork FFI `eliza_inference_vad_*` | **DONE** (I1 audit) | — | Shipped |
| hey-eliza wakeword | fork FFI `eliza_inference_wakeword_*` | **DONE** (I1 audit) | — | Shipped |
| ASR (Qwen3-ASR) | fork FFI `eliza_pick_asr_files()` | **DONE** (T-asr) | — | Shipped; Qwen3-ASR via fused `libelizainference` |
| DFlash speculative decoding | fork `llama-server` (`--spec-type dflash`) | **DONE** | — | Shipped |

**Summary:** 6 of 11 paths on the fork (including J1.d GGUF turn-detector). 4 ONNX
paths remain active (Wav2Small, WeSpeaker, pyannote-3, Kokoro). 1 ONNX path is
last-resort fallback (LiveKit turn-detector ONNX — overridden by Eliza1Eot when text
model loaded, and by GgmlTurnDetector when GGUF is staged on disk).

---

## B. What J3 did (no-J1/J2 scope)

### B.1 AGENTS.md updates

Updated `plugins/plugin-local-inference/native/AGENTS.md` and
`packages/native-plugins/voice-classifier-cpp/AGENTS.md` to document:
- ONNX is deprecated as of this release cycle; removal is gated on J1/J2 native ports.
- The Kokoro ONNX path is `compute-gated:J2`; the LLM_ARCH_KOKORO stub exists.
- The five ONNX-backed voice sub-models are listed with their precise
  compute gate and next-step.
- The fork-path models (OmniVoice, VAD, WW, ASR) are marked DONE.

### B.2 State matrix committed

This document committed to `.swarm/impl/J3-finalize.md` with the authoritative
per-model status table.

### B.3 J1.d already landed at HEAD

The GGUF-backed turn-detector was committed before J3 ran (J1's work landed
via checkpoint commits). Key files at HEAD:

- `plugins/plugin-local-inference/src/services/voice/eot-classifier-ggml.ts`
  — `LiveKitGgmlTurnDetector` class + `createBundledLiveKitGgmlTurnDetector`
  resolver; uses `node-llama-cpp` (fork wrapper) to load the GGUF and read
  `P(<|im_end|>)` from next-token logits.
- `plugins/plugin-local-inference/src/services/engine.ts`
  — `eotGgmlMod` dynamically imported alongside `eotMod`; `ggmlTurnDetector`
  resolved at voice session start and inserted in the priority chain before
  the legacy ONNX path.

**Production turn-detection chain (as of HEAD):**
1. `Eliza1EotClassifier` — uses the already-loaded text model (fork). Always
   on the fork path when a text model is resident.
2. `LiveKitGgmlTurnDetector` (J1.d) — dedicated GGUF via `node-llama-cpp`
   (fork). Active when `turn-detector-en-q8.gguf` or
   `turn-detector-intl-q8.gguf` is staged on disk.
3. `LiveKitTurnDetector` — legacy ONNX. One-release deprecation runway.
4. `HeuristicEotClassifier` — deterministic, zero-dep final fallback.

### B.4 No-ONNX proof (partial)

`lsof` proof is **NOT possible today** — the runtime will still map
`libonnxruntime.so` for the Wav2Small / WeSpeaker / pyannote / Kokoro ONNX
sessions on any voice-enabled boot. The brief mandates `lsof` proof only
after all ONNX-active models are removed. This section will be populated
when J1 (Wav2Small + WeSpeaker + pyannote) and J2 (Kokoro) complete.

**Artifact placeholder:** `artifacts/j3-no-onnx-proof/<run-id>/lsof.txt`
(empty — not meaningful until ONNX paths removed from resolved runtime).

### B.4 voice-models.ts registry check

Confirmed `voice-models.ts` already lists GGUF assets alongside ONNX for
the turn-detector models:
- `"voice/turn-detector/onnx/turn-detector-en-q8.gguf"` (41 MB, q8_0)
- `"voice/turn/intl/turn-detector-intl-q8.gguf"` (281 MB, q8_0)

The `ONNX-*` quant sentinel entries for Wav2Small, WeSpeaker, and pyannote
remain until J1 ports. No change to voice-models.ts needed this wave.

---

## C. Compute-gated next steps (precise)

### C.1 J1 scope (4 simpler ports) — BLOCKED on native implementation

**voice-classifier-cpp stubs to replace:**

| Head | C entry points | C file to replace | Estimated work |
|---|---|---|---|
| Wav2Small emotion | `voice_emotion_open/classify/close` | `src/voice_classifier_stub.c` | 1 worker-day: 4-block conv + GRU ggml graph, `voice_emotion_to_gguf.py` conversion |
| WeSpeaker R34-LM | `voice_speaker_open/embed/close` | same stub | 2 worker-days: ResNet34 conv blocks + AAM head in ggml |
| pyannote-3 diarizer | `voice_diarizer_open/segment/close` | new `src/voice_diarizer.c` | 1 worker-day: SincNet+Transformer powerset graph |
| audio EOT | `voice_eot_open/score/close` | same stub | 1 worker-day: small audio encoder + sigmoid; or wire the GGUF turn-detector via llama-server |

**After each head lands:**
1. Rename `voice-emotion-classifier-ggml.ts` → `voice-emotion-classifier.ts` (delete ONNX file).
2. Flip `runtime` field in `models/voice/manifest.json` from `"onnxruntime-node"` to `"llama.cpp"`.
3. Remove head from `onnxruntime-node` optional dep list in `plugin-local-inference/package.json`.
4. Run full verify gate.
5. Post `J1-<head>-done` to collab.md.

When ALL 4 J1 heads are done: `onnxruntime-node` can be removed from package.json.

### C.2 J2 scope (Kokoro) — BLOCKED on StyleTTS-2 GGML graph

Remaining work in fork (per I1-single-runtime.md §B):
1. `llama_model_kokoro::build_graph` — implement StyleTTS-2 decoder in
   `src/models/kokoro.cpp` (the enum + factory stub exist from W3-1).
2. Port AlbertSelfAttention + ProsodyPredictor + StyleEncoder + Decoder ops to ggml.
3. Wire `llama-server`'s `/v1/audio/speech` dispatcher to detect `LLM_ARCH_KOKORO`
   and route to the kokoro decode loop.
4. Ship Q4_K_M GGUF alongside the existing ONNX on HF.
5. Update `voice-models.ts` Kokoro entry to prefer GGUF.
6. Delete `kokoro/kokoro-runtime.ts` ONNX backend; rename GGUF variant as canonical.
7. Remove `kokoro-onnx` references (PyPI — only in comments/docs).

Estimated: 5-10 worker-days (StyleTTS-2 graph is large; decoder dispatch requires
careful llama-server surgery).

### C.3 HF deprecation runway

Per the brief: **do NOT delete ONNX files from HF this release.** The ONNX and GGUF
coexist on HF for one release runway. The runtime's `kokoro-engine-discovery.ts`
already prefers GGUF over ONNX in its candidate list:

```
"kokoro-82m-v1_0-Q4_K_M.gguf",  // preferred
"kokoro-82m-v1_0.gguf",
"kokoro-v1.0.int8.onnx",         // fallback
"kokoro-v1.0.onnx",
```

This is the correct deprecation runway setup. No changes needed.

---

## D. Verification

### D.1 Typecheck

Pre-existing typecheck failures in `@elizaos/plugin-local-inference` are due to
`@elizaos/plugin-whatsapp` / `@elizaos/plugin-imessage` not being in scope for
the typecheck run — not related to J3 scope. No J3 changes introduced new
typecheck failures.

### D.2 No ONNX removal = no regression

J3 made no changes to the ONNX loading paths. All voice models continue to work
as before. No regressions introduced.

### D.3 Submodule pin

Current fork pin: `5da0f068a` (last bumped by `a8bf079685 chore(submodule): bump
llama.cpp to 5da0f068a`). The `LLM_ARCH_KOKORO` stub is at commit `d087c94933`
within the fork. The pin is current with what J1/J2 would need to build against.
No bump required this wave (J1/J2 will bump when their C code lands).

---

## E. Definition of done (actual vs required)

| Requirement | Status |
|---|---|
| `onnxruntime-*` gone from `package.json` + `bun.lock` | NOT DONE — blocked on J1/J2 native ports |
| `lsof` proof committed | NOT DONE — requires ONNX removal first |
| All verify gates + benches green | NOT RUN — benches depend on native ports |
| AGENTS.md updated | **DONE** |
| State matrix complete | **DONE** |
| `phase=impl-done` posted to collab.md | **DONE** (partial — documenting compute-gate) |

J3 closes its scope as "state-documented, partial-done." The ONNX removal gate
requires J1+J2 to re-open this ticket with impl-done markers.

---

## F. Files changed this wave

| File | Change |
|---|---|
| `.swarm/impl/J3-finalize.md` | This report |
| `.swarm/run/J3.pid` | PID written |
| `plugins/plugin-local-inference/native/AGENTS.md` | Added §11 ONNX deprecation status section |
| `packages/native-plugins/voice-classifier-cpp/AGENTS.md` | Added current status header noting all heads are compute-gated stubs |
| `.swarm/collab.md` | `J3 phase=impl-done` posted |
