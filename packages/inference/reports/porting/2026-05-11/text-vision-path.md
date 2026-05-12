# Text / vision backbone path — verification (2026-05-11)

Continues the Eliza-1 text-model review. Scope: confirm that text and vision
are one backbone, document the mmproj / `libmtmd` story per tier, and identify
what is still missing for the vision-bearing tiers (`9b`, `27b`, `27b-256k`,
`27b-1m`).

## Verdict: one backbone, mmproj sidecar on the big tiers only

- **Text and vision are the same Qwen3.5/3.6 text GGUF.** There is no separate
  "vision model" weight set. AGENTS.md §1/§2 and `catalog.ts` are explicit: the
  tier's `text/eliza-1-<tier>-<ctx>.gguf` IS the vision model; the only extra
  artifact is the multimodal projector (`vision/mmproj-<tier>.gguf`) for the
  tiers where it isn't inlined. The `0_6b` / `1_7b` tiers are **text-only by
  design** — no `vision/` directory, `manifest.files.vision: []`, and the
  catalog `sourceModel.components.vision` is unset for those two ids. Verified
  against the on-disk bundles at
  `~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle` (no `vision/`
  dir, `vision: []` in both `eliza-1.manifest.json`).
- **`libmtmd` ships in every llama.cpp build** (the fork builds `libmtmd.so` /
  `libmtmd-0` alongside `libllama` — see `~/.eliza/local-inference/bin/dflash/
  linux-x64-{cpu,vulkan}/libmtmd.so*`), so the multimodal runtime is *present*
  on all tiers' binaries; it's just unused on `0_6b`/`1_7b` because there's no
  mmproj to load.
- **Catalog `sourceModel.components.vision`** is populated for `9b`
  (`unsloth/Qwen3.5-9B-GGUF` / `mmproj-F16.gguf`), `27b` and `27b-256k`
  (`batiai/Qwen3.6-27B-GGUF` / `mmproj-Qwen-Qwen3.6-27B-Q6_K.gguf`). `27b-1m`
  has no vision component in the catalog (a gap if the 1M tier is meant to be
  multimodal — most likely intentional, since `27b-1m` is the long-context
  text-server tier).
- The manifest schema (`manifest/schema.ts`) carries `lineage.vision`,
  `files.vision[]` and the `"vision"` file role; the bundle-staging /
  recommendation / downloader code treats vision as optional and never *requires*
  it for any tier. That matches the contract.

## mmproj is now auto-wired from the bundle manifest (was a gap, fixed 2026-05-11)

`dflash-server.ts`'s `load()` derives `--mmproj` from the bundle's
`eliza-1.manifest.json` `files.vision[0].path` (`findBundleVisionMmproj()`),
folds it into `optimizations.mmproj`, and the arg builder appends `--mmproj`.
Vision-capable tiers (`9b` / `27b` / `27b-256k` / `27b-1m`) load their projector
automatically; text-only tiers (`0_6b` / `1_7b`) get `null` and run text-only.
`ELIZA_LOCAL_MMPROJ` is now a debug override (point at a hand-built projector),
not the only path. Image input itself — `--image` / the `/v1/chat/completions`
multimodal content blocks — is handled by upstream `llama-server` + `libmtmd`
once `--mmproj` is on the command line.

There is no `0_6b`/`1_7b` work here — they are text-only and correct as shipped.

## What's still needed for the vision tiers (not buildable on this machine — no 9b/27b weights here)

1. ~~**Wire mmproj end-to-end.**~~ Done — `findBundleVisionMmproj()` +
   `load()` thread the manifest path to `--mmproj`; covered by a unit test
   against a synthetic manifest in `dflash-server.test.ts`. The remaining items
   need real 9b/27b weights:
2. **Verify-on-device should exercise vision** for tiers that ship mmproj: the
   one-time post-download verify pass (AGENTS.md §7 item 4) currently does
   text + voice + barge-in; add a 1-image multimodal generation step for
   vision-bearing tiers.
3. **mmproj quant audit on the big tiers.** `9b` uses an `F16` projector
   (~1 GB), `27b` a `Q6_K` projector — once those bundles are staged locally,
   confirm the projector quant against the tier's `ramBudgetMb` and that
   `libmtmd` accepts the GGUF (the projector arch tag must match what the fork's
   `clip.cpp`/`mtmd` expects for Qwen3.5-VL / Qwen3.6-VL).
4. **Manifest `kernels.required` does not list a vision kernel** — correct;
   vision uses the stock `clip`/`mtmd` path, not the TBQ/QJL/Polar kernels. No
   change needed, just noting it so nobody "adds a vision kernel requirement".

## Bottom line

The architecture is right: one Qwen text/vision backbone, mmproj sidecar on
`9b`/`27b`/`27b-256k`, text-only `0_6b`/`1_7b`. `libmtmd` is in every build.
The single outstanding code gap is that the runtime never passes `--mmproj`
because the bundle-manifest → spawn-arg path for the vision file is unimplemented.
Everything else (image content blocks, the `libmtmd` runtime) is upstream and
works once that one path is connected. Not testable here — this machine has no
9b/27b weights and 16 GB VRAM can't hold the 27B KV cache anyway.
