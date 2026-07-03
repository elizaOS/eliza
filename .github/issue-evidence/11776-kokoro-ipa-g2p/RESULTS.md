# #11776 — Kokoro TTS unintelligible on espeak-less fused builds — evidence

**Fix:** expose `ipa_to_token_ids()` through the fused FFI (`eliza_inference_kokoro_g2p_kind` + `eliza_inference_kokoro_synthesize_ipa`, ABI v12→v14) and, in the TS Kokoro runtime, feed espeak-ng-WASM IPA through the IPA entry when the loaded lib reports `g2p_kind == ascii`.

All WER numbers are from ASR round-trips I ran and read (real `eliza-1-asr` GGUF, not a mock). WER = word-level Levenshtein / reference length.

## Headline: before vs after (same espeak-less lib)

| G2P path | espeak-**less** lib (Android/iOS/host-without-espeak) | espeak-**linked** lib (baseline) |
|---|---|---|
| RAW-TEXT (old default — the bug) | **0.958** (garbled) | 0.042 |
| WASM-IPA (this fix) | **0.042** (intelligible) | 0.042 |

The fix makes the espeak-less build reach the espeak-linked baseline exactly (0.042 == 0.042).

## Desktop A/B — `scratch-kokoro-ab.ts`, macOS M4 Max, model `kokoro-82m-v1_0-Q4_K_M.gguf`, voice `af_bella`

espeak-**less** fused lib (`-DKOKORO_ENABLE_ESPEAK=OFF`), `g2p_kind=ascii`:

```
[p0] "Hello, this is a native Kokoro voice test."
  RAW-TEXT  WER 0.88   asr: "Hello, T C Sanativé. Cocoro voyjet est."
  WASM-IPA  WER 0.13   asr: "Hello. This is a native Cagloo voice test."
[p1] "The quick brown fox jumps over the lazy dog."
  RAW-TEXT  WER 1.00   asr: "Takeuit bronfo, yumpa verta la zida."
  WASM-IPA  WER 0.00   asr: "The quick brown fox jumps over the lazy dog."
[p2] "She sells seashells by the seashore."
  RAW-TEXT  WER 1.00   asr: "Tells the angels, Be tells the story."
  WASM-IPA  WER 0.00   asr: "She sells seashells by the seashore."
=== noespeak mean WER: RAW-TEXT 0.958  WASM-IPA 0.042 ===
```

espeak-**linked** fused lib (`-DKOKORO_ENABLE_ESPEAK=ON`), `g2p_kind=espeak` (parity check):

```
=== espeak mean WER: RAW-TEXT 0.042  WASM-IPA 0.042 ===
```

WAVs: `desktop-wav/{noespeak,espeak}-p{0,1,2}-{rawtext,ipa}.wav`.

## Desktop real TS runtime — `bun scripts/kokoro-real-smoke.ts` against the espeak-less lib

```
[kokoro-real-smoke] lib=…/build-fused-noespeak/…/libelizainference.dylib (ABI v14)
[kokoro] using phonemizer=phonemizer
[KokoroFfiRuntime] loaded Eliza-1 voice af_bella …
[kokoro-real-smoke] envelope-cv 1.228 (speech ≫0.4)
[kokoro-real-smoke] ASR transcript: "Hello. This is a native Cagloo voice test." — WER 0.13 vs "Hello, this is a native Kokoro voice test."
```

The production `KokoroFfiRuntime` picks the IPA path automatically (`g2p_kind=ascii`) and the real `phonemizer` (espeak-ng WASM) resolved. WER 0.13 < 0.5 gate.

## Android emulator-5554 (arm64-v8a, API 35) — the exact #10727 emu leg

Real 76 MB statically-fused `libelizainference.so` (NDK arm64, `-DKOKORO_ENABLE_ESPEAK=OFF`), driven on-device by `android-on-device-harness.c` (dlopen → kokoro_load → raw + IPA synth). WAVs pulled to host and ASR-transcribed:

```
ABI=v14 kokoro_supported=1   g2p_kind=0 (ASCII)
and-p0-ipa.wav       WER 0.13  nonEmpty=true   asr: "Hello. This is a native Cagloo voice test."
and-p0-rawtext.wav   WER 0.88  nonEmpty=true   asr: "Hello, T C Sanativé. Cocoro voyjet est."
and-p1-ipa.wav       WER 0.00  nonEmpty=true   asr: "The quick brown fox jumps over the lazy dog."
and-p1-rawtext.wav   WER 1.00  nonEmpty=true   asr: "Takeuit bronfo, yumpa verta la zida."
and-p2-ipa.wav       WER 0.00  nonEmpty=true   asr: "She sells seashells by the seashore."
and-p2-rawtext.wav   WER 1.00  nonEmpty=true   asr: "Tells the angels, Be tells the story."
=== ANDROID on-device .so → host ASR ===
RAW-TEXT (ASCII bug)  mean WER 0.958
WASM-IPA (the fix)    mean WER 0.042
```

Method label: the on-device harness is a standalone NDK C executable that dlopens the REAL ~72 MB fused `.so` and drives the REAL IPA entry with the espeak-ng-WASM IPA the TS layer produces (hardcoded from the `phonemizer` npm output). Full-app deploy would exercise the identical `KokoroFfiRuntime` → same FFI entry. WAVs: `android-wav/and-p{0,1,2}-{rawtext,ipa}.wav`.

## Fork native tests (macOS, espeak linked)

- `test_kokoro_phonemes`: OK (new: `g2p_kind_of_build()` mirrors `espeak_available()`; IPA-input path derives exact wrapped `input_ids`).
- `test_kokoro_g2p_espeak`: ALL PASS (new: `g2p_kind_of_build() == ESPEAK` when linked).

## iOS

The IPA path is platform-neutral TS + FFI; iOS never links espeak so it reports `g2p_kind=ascii` and inherits the same fix. On-device iOS capture is tracked by #11612-residual / #11734 (not attempted here).
