# #10726 — Real host voice lanes on Linux x86-64 (2026-07-02)

Honest REAL / SKIP / RED audit of every non-mock host voice lane in
`plugins/plugin-local-inference`, run against **real model weights** on a Linux
x86-64 dev host. CPU-only (the host NVIDIA driver is in a failed state — CUDA
was not attempted). Base: `origin/develop` @ `dd2632667a`; fork submodule pin
`ba598f56` (post-#9684).

Companion lane: the Pixel 6a on-device voice-selftest is captured by a parallel
agent (see `10726-android-voice-selftest/`).

## Environment

| Piece | Value |
| --- | --- |
| Fused lib | rebuilt from the fork pin via `packages/app-core/scripts/stage-desktop-fused-lib.mjs --variant cpu` (ABI v12); a second variant re-configured with system `libespeak-ng.so.1` + espeak-ng 1.51 headers (`Kokoro G2P: real IPA path enabled`) |
| ASR bundle | `~/.local/state/milady/asr-bundle/asr/` — `eliza-1-asr.gguf` 804,749,248 B + `eliza-1-asr-mmproj.gguf` 214,392,480 B (byte-size-identical to HF `bundles/2b/asr/`) |
| Kokoro model | fresh download of the **republished** HF `bundles/2b/tts/kokoro/kokoro-82m-v1_0.gguf` (162,546,720 B) + fixed voices (522,240 B each) |

## Lane-by-lane results

| Lane | Verdict | Detail |
| --- | --- | --- |
| `test:asr:real` | **REAL PASS** | Real Qwen3-ASR GGUF weights (302 mmproj tensors + main model) transcribe `native/audio-fixtures/freeman.wav` accurately: 39 words / ≈3 sentences, 13.1 s on the current-fork lib (27.4 s on a stale Jun-24 lib). Bare run without `ELIZA_ASR_BUNDLE` skips with exit 2 (documented dev behavior, not a silent pass). |
| `test:kokoro:real` (`KOKORO_SMOKE_REQUIRE=1`) | **RED — but the #9588 blocker is CLOSED** | Three-stage story below. Final state: model loads, audio **intelligible (WER 0.13)**; lane fails only the 700 ms mobile TTFA budget (79.6 s on this single-threaded desktop CPU build). |
| `voicestack:real` | **SKIP (exit 2)** | Gates on `ELIZA_INFERENCE_LIBRARY`, then `ELEVENLABS_API_KEY`. No ElevenLabs key on this host. Honest skip, not a larp pass. |
| `roundtrip:real` | **SKIP (exit 2)** | Same ElevenLabs gate (+ Cerebras for the LLM leg). |
| `robustness:real` | **SKIP (exit 2)** | Same ElevenLabs gate. |
| `agentvoice:real` | **SKIP (exit 2)** | Same ElevenLabs gate. |
| `voice:workbench --logic` | **PASS (logic-only by design)** | 18/18 scenarios, 163 cases, 0 failed (EOT / echo-rejection / bystander / owner-security decision logic). Runs no model weights — perfect-ASR assumption; not claimed as a weights lane. |
| vitest voice unit suites (`src/services/voice/`) | **PASS** | 100 test files, **953 passed, 1 skipped** (post-fix; pre-fix 952/1 — the +1 is the new #10726 regression test). |

## Kokoro GGUF republish verdict (#9588 / #9684)

**The republish has landed and is loadable.** HF
`elizaos/eliza-1/bundles/2b/tts/kokoro/` was updated **2026-07-02T04:40:20Z**
(commit “fix(kokoro): replace malformed voice presets (522560→522240, …)”):

- `kokoro-82m-v1_0.gguf` — 162,546,720 B, GGUF v3, **457 tensors with the
  published names** (`kokoro.bert.*`, `kokoro.text_encoder.*`,
  `kokoro.decoder.*`) and F16 weights. Loads cleanly in a post-#9684 lib.
- The preferred `kokoro-82m-v1_0-Q4_K_M.gguf` filename still 404s; the
  discovery list falls through to the canonical F16 name, so this is benign.
- 10 voice presets at the fixed 522,240 B size. Note: `af_same.bin` (Samantha)
  is **not** in `bundles/2b/tts/kokoro/voices/` — it exists only under the
  top-level `voice/kokoro/voices/` tree. Runtime falls back loudly to
  `af_bella`.
- Any locally staged pre-fix presets (522,560 B) are the malformed ones —
  restage. A stale pre-#9684 lib rejects the new GGUF with
  `required tensor missing: bert.embd.tok.weight …` (old internal names);
  rebuild the fused lib.

## The kokoro lane in three honest stages

1. **Stale host lib (built Jun 24, pre-#9684)** → RED at load:
   `kokoro: required tensor missing: bert.embd.tok.weight …` — the loader-side
   tensor-name mismatch #9588 described. Fix: rebuild from the current fork pin.
2. **Rebuilt lib, before the #10726 fix** → loads + synthesizes speech-shaped
   audio (envelope-cv 1.736) but **WER 1.00**: reference “Hello, this is a
   native Kokoro voice test.” transcribed as “Los Nevados said.” Every voice
   garbles differently (af_sarah “Pluses inevocables.”, am_michael “Losers
   ain't never cool, but damn.”, bf_emma “Hello, Zinovko. Visited.”). Exactly
   the failure class the lane's WER gate exists to catch.
3. **Rebuilt lib + raw-text fix + espeak-linked build** → “Hello. This is a
   native Kakoro voice test.” — **WER 0.13**, envelope-cv 1.250. Lane remains
   RED **only** on `TTFA 79558ms exceeds the mobile budget 700ms`.

## Root cause found & fixed: IPA double-phonemization (this PR)

`KokoroFfiRuntime.synthesize` passed the JS-side **IPA string**
(`args.phonemes.phonemes`) as the `text` argument of
`eliza_inference_kokoro_synthesize`. The engine **re-phonemizes internally**
(`kokoro_phonemize`: espeak-ng when linked, else a **per-byte** ASCII grapheme
fallback). Feeding it IPA double-phonemizes:

- espeak-less build: multi-byte UTF-8 IPA codepoints are shredded per byte →
  near-random token ids → WER 1.00 (“Los Nevados said.”).
- espeak-linked build: espeak re-G2Ps IPA as if it were words → garble too.

Proof chain (all on the same lib + model + voice):

| Input handed to the engine | Result |
| --- | --- |
| IPA string (old JS path) | 75,600 samples, “Los Nevados said.”, WER 1.00 |
| Hand-built misaki-style ids via phonemizer override | identical output — proved the runtime ignores JS ids entirely |
| Raw text through the same FFI call | 91,800 samples, “Hello, TC Sanativ. Kokoro voyjetest.” — byte-identical behavior to the fork's own `kokoro-tts` CLI |
| Raw text + espeak-linked lib (the fix) | 91,200 samples, “Hello. This is a native Kakoro voice test.”, **WER 0.13** |

**Fix:** plumb the raw pre-phonemization phrase text through
`KokoroRuntimeInputs.text` (required field) and have `KokoroFfiRuntime` hand
the engine that text, per the engine's own contract. Regression tests assert
the runtime receives raw text, never IPA, at both the backend seam and the FFI
seam.

Audio evidence (same phrase, af_bella, republished GGUF):

- `10726-kokoro-af_bella-before-ipa-garble.wav` — speech-shaped, unintelligible.
- `10726-kokoro-af_bella-after-textfix-espeak.wav` — intelligible.

## Remaining gaps (recorded, not fixed here)

1. **TTFA**: whole-phrase synchronous forward at ~65–80 s on desktop CPU
   (`user ≈ real` in CLI timing → effectively single-threaded predictor/
   decoder). The 700 ms mobile budget is unreachable on this build; the lane
   stays RED on perf until the engine is parallelized/optimized or the gate is
   tiered per host class.
2. **espeak provisioning**: `stage-desktop-fused-lib.mjs` builds silently
   without espeak when libespeak-ng dev files are absent (cmake prints only a
   STATUS line). The staged lib then uses the per-byte ASCII fallback →
   degraded WER (~0.75 on the smoke phrase) even with the raw-text fix. The
   staging script should surface this loudly, and CI/dev docs should require
   `libespeak-ng-dev` (this host had runtime `libespeak-ng.so.1` +
   `espeak-ng-data` installed; only headers/dev-symlink were missing).
3. **Fork follow-up**: expose `ipa_to_token_ids` through the FFI so the TS
   layer's high-quality espeak-WASM IPA can be consumed directly (single G2P,
   no espeak system dependency). The CMake comment (“TS layer must supply
   IPA”) promises this contract, but `phonemize_ascii` cannot parse UTF-8 IPA,
   so it was never real.
4. **HF layout note (Qwen→Gemma migration era)**: voice artifacts verified
   present on HF `elizaos/eliza-1` under the top-level `voice/` tree (ASR
   q3–q8 quants, `diarizer/pyannote-segmentation-3.0.gguf`,
   `speaker-encoder/wespeaker-resnet34-lm.gguf`, 3-stage `wakeword/hey-eliza`,
   VAD, turn-detector en+intl, voice-emotion) and under `bundles/2b/{asr,tts,vad}`.
   `speaker/`, `diariz/`, `wakeword/` do **not** exist under `bundles/2b/` —
   bundle-relative probes for those artifacts depend on provisioning to remap.

## Commands (reproduce)

```bash
# ASR (REAL):
ELIZA_ASR_BUNDLE=~/.local/state/milady/asr-bundle \
ELIZA_INFERENCE_LIB_DIR=<staged-lib-dir> \
  bun run --cwd plugins/plugin-local-inference test:asr:real

# Kokoro (REAL, requires staged model + voices):
KOKORO_SMOKE_REQUIRE=1 \
ELIZA_KOKORO_MODEL_DIR=<dir with kokoro-82m-v1_0.gguf + voices/> \
ELIZA_ASR_BUNDLE=~/.local/state/milady/asr-bundle \
ELIZA_INFERENCE_LIB_DIR=<staged-lib-dir> \
  bun run --cwd plugins/plugin-local-inference test:kokoro:real

# Logic workbench + unit suites:
bun run --cwd plugins/plugin-local-inference voice:workbench --logic
bunx vitest run src/services/voice   # from the plugin dir
```
