# Vendored Kokoro trainer

Pinned Python training source from `jonirajala/kokoro_training`, plus the thin
elizaOS adapter consumed by `packages/training/scripts/kokoro/finetune_kokoro.py`.
Read [VENDORED_FROM](VENDORED_FROM), [LICENSE.upstream](LICENSE.upstream), the
parent [native inference guide](../CLAUDE.md), and the
[training guide](../../../../packages/training/CLAUDE.md) before editing it.

## Ownership boundary

- The vendored `kokoro/`, `training/`, `audio/`, and top-level Python files are
  an upstream snapshot. They implement a Kokoro-inspired trainer; they are not
  the `hexgrad/Kokoro-82M` runtime model.
- `eliza_adapter/` is the only stable interface from elizaOS training code into
  the vendor. Non-adjacent code must not import vendor internals directly.
- This directory produces Python checkpoints. It does not own GGUF conversion,
  quantization, runtime loading, bundle manifests, or Hugging Face publication.
  Those remain in `packages/training` and the parent native inference package.
- Do not introduce runtime code, a second vocoder pipeline, or a second model
  publishing path here.

## Stable adapter surface

`eliza_adapter` exports:

- `probe_vendor_environment()` for dependency and accelerator discovery;
- `build_vendor_config()` for translating the elizaOS YAML configuration;
- `run_full_finetune()` for the APOLLO-backed vendor training loop;
- `smoke_full_finetune()` for a small synthetic forward/backward check.

The adapter must fail when APOLLO or a required training dependency is missing;
it must not silently fall back to the vendor's AdamW configuration. Successful
runs preserve vendor checkpoints and add the elizaOS manifest containing the
vendor revision, configuration hash, optimizer version, and dataset hash.

## Updating the vendor

1. Compare the new upstream tree with the commit recorded in `VENDORED_FROM`.
2. Preserve `VENDORED_FROM`, `LICENSE.upstream`, both agent guides, and
   `eliza_adapter/`; do not copy an upstream `.git/` directory or generated
   training outputs.
3. Reconcile adapter imports and configuration against the new vendor surface.
4. Record the new upstream URL, commit, date, license state, included files, and
   stripped files in `VENDORED_FROM`.
5. Review the upstream license again. The current snapshot did not publish a
   license file, so it must not be assumed to grant redistribution or
   commercial-use rights beyond the conservative policy in `LICENSE.upstream`.

## Verification

Install the pinned Python requirements in an isolated environment and run the
vendor tests affected by the change. Then run the adapter's synthetic smoke
through `packages/training/scripts/kokoro/finetune_kokoro.py` and inspect its
manifest and checkpoint outputs. A training-path change also requires a real
small-corpus run, audio review of resulting samples, and the evaluation gates
defined by the training guide. Never present an import-only or synthetic smoke
as evidence that the produced voice is usable.
