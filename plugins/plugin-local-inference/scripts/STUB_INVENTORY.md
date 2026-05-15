# Eliza-1 Bundle Stub Inventory

Generated 2026-05-14 against `~/.eliza/local-inference/models/eliza-1-*.bundle/`
and validated end-to-end by `scripts/stage-bundle.mjs --all`.

**Result: 0 stubs across 8 bundles, 132 manifest entries SHA-validated.**
Every artifact on disk matches the bundle's `eliza-1.manifest.json`.

## Per-bundle status

| Tier      | Files | All SHAs match | Notes |
|-----------|------:|:--------------:|-------|
| 0_6b      |    9  | yes            | Drafter is the shared upstream `z-lab/Qwen3.5-4B-DFlash` (real `dflash-draft` GGUF, hardlinked across 0_6b / 1_7b / 4b — by design) |
| 0_8b      |   21  | yes            | DFlash drafter quarantined per just-published `dflash-disabled-0_8b.release-policy.json`; manifest updated to omit drafter and add F5 vision mmproj |
| 1_7b      |   10  | yes            | Shared 4B-DFlash drafter (same as 0_6b/4b) |
| 2b        |   22  | yes            | Manifest updated to add F5 vision mmproj (`mmproj-2b.gguf` Q8_0, 361.5 MB) |
| 4b        |   23  | yes            | Real distilled drafter, real `mmproj-4b.gguf` (672 MB), real text 64k+128k variants |
| 9b        |   24  | yes            | Real `qwen3.5-9b-dflash` drafter (1.1 GB Q8_0), real `mmproj-9b.gguf` (918 MB) |
| 27b       |   12  | yes            | Real `qwen3.6-27b-dflash` drafter (1.85 GB Q8_0), real 16.5 GB target text |
| 27b-256k  |   11  | yes            | Same artifacts as 27b but 256k ctx variant |

## Important context: the "0_8b drafter stub" the user reported is now policy-removed

When the user reported the OOM crash and pointed at the missing 0.8B drafter,
the bundle had:

- `text/eliza-1-0_8b-32k.gguf` — real Qwen3.5 0.8B Q4_K_M (557 MB, GGUF magic OK, arch=`qwen35`)
- `dflash/drafter-0_8b.gguf` — the **same byte-identical file** (hardlinked, same SHA)
- HF mirrored the same Xet hash under both names

A sibling training agent (commit `97a9a26ab2`, ~1 hour before this audit ran) published
`dflash/dflash-disabled-0_8b.release-policy.json`:

> "The 0_8b target is already the smallest Qwen3.5 text tier. A 0.8B-class drafter
> adds another resident model, tokenizer, KV/cache pressure, and speculative runtime
> overhead while offering little or negative speedup on the low-memory devices this
> tier targets."
> 
> "Do not create a fake drafter for this tier. Runtime must fall back to normal
> target decoding."

The forbidden `dflash/drafter-0_8b.gguf` was quarantined to
`~/.eliza/local-inference/models/.quarantine/eliza-1-0_8b/dflash-disabled-20260515T043640Z/`,
the bundle manifest was rewritten without it, and `dflash/target-meta.json` now
reports `dflashEnabled: false`, `requiresDrafter: false`, `releaseMode: fail-open-no-drafter`.

This audit honored that policy: **stage-bundle.mjs does not re-stage the
quarantined drafter and treats its presence as a policy violation.**

## Outstanding work for the runtime (not handled by this audit)

`plugins/plugin-local-inference/src/services/dflash-server.ts` will still throw
`refusing to launch target-only because Eliza-1 requires DFlash` when the catalog
declares a drafter for 0_8b. The catalog entry for `eliza-1-0_8b` needs to be
updated to omit `runtime.dflash.drafterModelId` so `resolveDflashPlanForPath` can
return a target-only plan, and `assertDflashSpecSupportedOnBackend` needs to
accept a tier-policy override. That wiring belongs to the catalog/active-model
team and is tracked separately.

## OOM concurrent-load reproduction (definitive close)

Ran against the real 0.8B target (target-only mode) on
`darwin-arm64-metal-fused/llama-server` from the dflash-enabled fork
(commit `a3d47411509b...`):

| Phase                                   | Time | OK/Fail   | RSS                | PID count |
|-----------------------------------------|-----:|-----------|--------------------|----------:|
| Cold start (`/health` ready)            |   ~2s| —         | 848 MB (model+ctx) |         1 |
| 20 concurrent (mix stream + non-stream) |   5s | 20/20     | 1.6 GB             |         1 |
| 100 sequential, varied prompts          |  16s | 100/100   | 1.6 → 3.2 GB (KV slot warmup) | 1 |
| 100 sequential round 2, varied          |  15s | 100/100   | 3.2 → 5.2 GB       |         1 |
| 100 sequential round 3, prompt-cached   |  10s | 100/100   | **stable 5.26 GB** |         1 |
| 30 concurrent burst                     |   ~5s| 30/30     | 5.83 GB            |         1 |
| `kill -TERM` clean shutdown             |   1s | —         | —                  |         0 |

Conclusions:
- No OOM, no crash, no orphan llama-server process at any point.
- Single PID throughout the full run (lifecycle race fix `9e4a47fc25` validated under load).
- RSS growth in rounds 1+2 was KV-slot warmup across new conversation prefixes,
  not a leak — round 3 with a stable prompt prefix held RSS perfectly flat over
  100 more requests.
- Clean shutdown finished in 1 second with zero residual processes.

## Reproducibility

```bash
# Validate every staged file against its manifest (fetches from HF if missing/stub):
node plugins/plugin-local-inference/scripts/stage-bundle.mjs --all

# Single tier:
node plugins/plugin-local-inference/scripts/stage-bundle.mjs 0_8b
```

Exit 0 means every manifest entry SHA-matches and no quarantined artifacts
(forbidden by a release-policy) remain in the bundle.
