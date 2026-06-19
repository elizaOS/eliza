# Kokoro-82M → CoreML (fused end-to-end) exporter

Produces the **single** `kokoro_5s.mlmodelc` that the iOS on-device TTS path
loads (`KokoroCoreMlModel` / `KokoroCoreMlEngine` in
`plugins/plugin-native-bun-runtime/ios/Sources/ElizaBunRuntimePlugin/kokoro/`),
plus the `vocab_index.json` and `voices/*.json` sidecars. This is the
"separate conversion" that the Swift engine was written against — Kokoro is not
published as a single fused CoreML graph anywhere, so we build it.

## Why fused (not the 5-model mattmireles pipeline)

[`mattmireles/kokoro-coreml`](https://github.com/mattmireles/kokoro-coreml) (MIT)
splits Kokoro into 5 CoreML models with Swift-side alignment + hn-NSF, dropping
F0/N prosody and using `IdentityAdaIN` to dodge old-coremltools breakage. Our
Swift contract instead loads **one** E2E model. We keep that contract and build
a faithful fused graph (real F0/N, real AdaIN, real hn-NSF) using mattmireles'
CoreML-convertible kokoro modules (`custom_stft`, `istftnet`) as the base.

## Model contract (matches `KokoroCoreMlModel.swift`)

```
inputs:  input_ids[1,128] int32, attention_mask[1,128] int32,
         ref_s[1,256] f32, random_phases[1,9] f32, speed[1] f32
outputs: audio[1, frames*600] f32, audio_length_samples[1] int32, pred_dur[1,128] int32
```

Key engineering points (see `export_e2e_coreml.py`):

- **Fixed-bucket in-graph alignment.** Kokoro's `repeat_interleave` alignment is
  data-dependent (unconvertible). Replaced with a fixed `[N,F]` one-hot built
  from `cumsum(pred_dur)` bounds (`ge*lt`, no `bitwise_and`). Bucket `F=320`
  frames (8s @ 600 samples/frame) holds the Swift chunker's 96-token max.
- **Padding-invariant AdaIN.** `AdaIN1d` normalizes over time; the padded
  bucket would poison mean/var. Overridden to masked stats (a frame-valid mask
  interpolated to each resolution). Same for F0Ntrain's shared bidirectional
  LSTM (masked-LSTM unroll).
- **Injected hn-NSF phase.** `SineGen._f02sine`'s `torch.rand` initial phase is
  replaced by the `random_phases` input; excitation noise zeroed for a
  deterministic graph.
- **FLOAT32 precision required.** fp16 catastrophically degrades AdaIN variance
  over >100 frames (halved amplitude, spectral corr 0.99→0.63). Ship fp32.
- **int32 `audio_length_samples`.** fp16 scalars overflow past 65504 (>1.8s).

## Reproduce

```bash
# 1. CoreML-convertible kokoro modules (MIT). Apply the custom_stft patch below.
git clone --depth 1 https://github.com/mattmireles/kokoro-coreml.git ref
patch -p0 < custom_stft.coreml.patch            # bitwise_and + boolean-scatter -> float blend

# 2. Weights (Apache-2.0) + voice packs
hf download hexgrad/Kokoro-82M kokoro-v1_0.pth config.json "voices/*.pt" --local-dir hexgrad
mkdir -p ref/checkpoints && cp hexgrad/{config.json,kokoro-v1_0.pth} ref/checkpoints/

# 3. Tooling
python3 -m pip install coremltools torch soundfile

# 4. Convert (fp32, 320-frame bucket) -> out/kokoro_5s.mlpackage
KOKORO_COREML_REF=$PWD/ref python3 export_e2e_coreml.py --stage full --frames 320 --precision fp32
xcrun coremlc compile out/kokoro_5s.mlpackage out/compiled

# 5. Sidecars (vocab_index.json + voices/*.json)
python3 gen_assets.py out/kokoro-coreml

# 6. Validate end-to-end (real sentence, spectral parity vs torch ground truth)
python3 validate_e2e_coreml.py
```

Stage `out/compiled/kokoro_5s.mlmodelc` + `out/kokoro-coreml/{vocab_index.json,voices/}`
into a bundle's `tts/kokoro-coreml/` (see `KokoroCoreMlEngine.modelDirectory`).

## Validation (Mac, coremltools predict)

- **torch fused vs real Kokoro `forward_with_tokens`: stft-mag corr 0.99**,
  log-mel L1 0.02, rms matches — the fused PyTorch module is perceptually
  identical to ground truth and bucket-invariant (0.99 at 200/320/512 frames).
- **CoreML vs torch: KNOWN FIDELITY GAP (WIP) — now LOCALIZED to the iSTFT.**
  The compiled model is structurally correct — `pred_dur`,
  `audio_length_samples`, and I/O names all match exactly — but the audio
  diverges from the torch module (stft-mag corr ~0.68, waveform corr ~0.33,
  amplitude ~½). Root-cause isolated by elimination AND by direct staged
  comparison (`diag_stages.py`, which exports `F0_pred` + `har_source` as extra
  CoreML outputs and correlates them against torch):
  - NOT precision: identical under fp16 and fp32.
  - NOT the AdaIN padding mask: identical with `F.interpolate(nearest)` and the
    `arange`-based exact mask.
  - NOT alignment/duration: those convert exactly.
  - NOT F0Ntrain (masked LSTM / AdaIN): **`diag_stages.py` reports F0_pred corr
    = 1.00000** — the predictor path is bit-faithful in CoreML.
  - NOT the `F.interpolate(linear)` hn-NSF phase resample: replacing both linear
    resamples in `SineGen._f02sine` with a numerically-exact host-constant
    gather+blend (`_linear_resample`, matches `align_corners=False` to fp32) left
    the audio corr **unchanged at ~0.33**. So the resample was never the cause
    (the gather+blend stays anyway — it is a deterministic CoreML-clean form).
  → **Verdict: `iSTFT / decoder convs diverge`** (`diag_stages.py` final line).
  F0 and the harmonic source reach the decoder intact; the gap is introduced by
  the `CustomSTFT` inverse (two `conv_transpose1d` overlap-adds, `custom_stft.py`
  `inverse()`) and/or the iSTFTNet decoder upsample convs, where coremltools'
  `conv_transpose1d` (output_padding / overlap-add scaling) diverges from
  PyTorch. **Next step:** stage the decoder's pre-iSTFT spec vs the final audio to
  confirm which conv, then replace the `conv_transpose1d` overlap-add with an
  explicit gather/scatter (or `fold`-equivalent) overlap-add whose semantics
  CoreML reproduces exactly — same approach that fixed the index typing here.

**Until parity lands, do NOT stage this `.mlmodelc` into a shipping bundle** —
the iOS Swift `synthesizeSpeech` tries CoreML first, so a degraded model would
regress TTS. The production iOS TTS path is the fused GGUF Kokoro via
`eliza_inference_tts_synthesize` (libelizainference), which is validated.

## Provenance / licenses

- Weights: `hexgrad/Kokoro-82M` (Apache-2.0).
- CoreML-convertible model code: `mattmireles/kokoro-coreml` (MIT), itself
  derived from StyleTTS2 (MIT) + the `kokoro` package (Apache-2.0).
- Vocab: Kokoro `config.json` `vocab` (IPA→id).
