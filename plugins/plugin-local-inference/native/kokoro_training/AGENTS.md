# AGENTS.md — vendored kokoro_training

Read [VENDORED_FROM](VENDORED_FROM) and [LICENSE.upstream](LICENSE.upstream)
before touching anything in this directory. This tree was vendored
verbatim from `https://github.com/jonirajala/kokoro_training` at commit
`f7815b9ebfe41e6d084e73c386e4dbd8042ae6e3` and is in-tree only.

## Scope rules

1. **No new GGUF, no new quantization, no new vocoder** in this
   directory. Those concerns live in:
   - `../llama.cpp/convert_hf_to_gguf.py` + `../llama.cpp/tools/quantize/`
     (canonical GGUF I/O + K-quant for everything in the bundle).
   - `../omnivoice.cpp/` (canonical mel / RVQ / HuBERT for voice).
   - `packages/training/scripts/kokoro/export_to_onnx.py` (canonical
     Kokoro → ONNX export for the runtime backend).
   The vendor is a **trainer**. It produces a `.pth` checkpoint. Any
   path that turns `.pth` into a shipping artifact goes through the
   canonical scripts above, not through this directory.

2. **No re-export of vendored symbols from non-adjacent code.** The
   bridge between the Eliza training scripts and this vendor lives in
   `milady_adapter/` (one directory, one file per concern). Other
   Eliza-side code MUST go through the adapter — direct imports from
   `kokoro_training.kokoro.model` etc. are not allowed from the
   `packages/` tree.

3. **No drift from upstream without a recorded delta.** If a downstream
   bug forces a patch in vendored code, leave an `# elizaOS:` comment
   on the changed line and a one-line entry in `UPSTREAM_DELTAS.md`
   (create on first patch) so a future re-vendor knows what to keep.

4. **Don't reintroduce `.git/`.** This vendor is not a submodule.
   Re-vendoring is a full copy + diff against `UPSTREAM_DELTAS.md`.

## What this vendor brings us

- A real **full-fine-tune** training loop for a Kokoro-inspired
  encoder-decoder TTS transformer (~22M-120M parameters depending on
  config). The upstream `hexgrad/Kokoro-82M` is StyleTTS-2 + iSTFTNet
  and is harder to fine-tune end-to-end because its inference package
  doesn't expose the training entry points (see
  `.swarm/impl/I7-kokoro.md` for the long-form analysis).
- A practical English phoneme processor + LJSpeech dataset adapter +
  MFA TextGrid loader. We use these to stage the `sam` corpus
  (`packages/training/data/voice/sam/`) for full-fine-tune.
- An adaptive memory manager that auto-detects MPS / CUDA / CPU and
  reports peak/allocated. Useful for our tier-detection story.
- A checkpoint manager that supports resume-from-latest, which our
  long-running training scripts already lean on by convention.

## What this vendor does NOT bring us

- It is **not** a fine-tuner for `hexgrad/Kokoro-82M`. The architecture
  is independent. Outputs of this trainer are NOT drop-in for the
  Kokoro runtime backend at
  `plugins/plugin-local-inference/src/services/voice/kokoro/`. Shipping
  outputs from this trainer at runtime requires a separate runtime
  backend (out of N1 scope; flagged as a follow-up).
- The voice-clone path (the `ref_s` mel-fit optimization that
  `packages/training/scripts/kokoro/extract_voice_embedding.py` runs
  against the `hexgrad/Kokoro-82M` style encoder) is unrelated to
  this trainer. They are complementary, not conflicting.

## Adapter contract

`milady_adapter/` is the only stable interface. See
`milady_adapter/README.md` for the surface. Stable functions:

- `milady_adapter.run_full_finetune(config_dict) -> ExitCode` —
  wraps `training_english.main()` with our config schema, our
  trajectory-aware logging, and the APOLLO optimizer mandate from
  `packages/training/AGENTS.md`.
- `milady_adapter.smoke_full_finetune(corpus_dir, run_dir, steps=2) -> None` —
  pure smoke test that validates the import surface + a 2-step batch.

Everything else is internal. Future-proofing tip: when we re-vendor
upstream, only `milady_adapter/` needs to stay stable.
