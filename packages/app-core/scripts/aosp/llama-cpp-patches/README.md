# llama.cpp patches — DEPRECATED archival drop (2026-05-09)

> **Superseded by `elizaOS/llama.cpp @ v0.1.0-eliza`.** These patch
> series are no longer applied on AOSP builds. `compile-libllama.mjs`
> now points at the unified Eliza fork, which has TBQ + QJL + Q4_POLAR
> baked in (plus the Metal kernel sources). See
> `docs/porting/unified-fork-strategy.md` for the migration story.

The directory and `apply-patches.mjs` script are kept in-tree for one
release as a rollback path. To re-enable the legacy flow:

1. In `compile-libllama.mjs`, restore the prior pin:
   ```js
   export const LLAMA_CPP_TAG    = "main-b8198-b2b5273";
   export const LLAMA_CPP_COMMIT = "b2b5273e8b275bb96362fe844a5202632eb3e52b";
   export const LLAMA_CPP_REMOTE = "https://github.com/Apothic-AI/llama.cpp-1bit-turboquant.git";
   ```
2. Re-add the `applyVendoredPatches({ srcDir: cacheDir, log })` call after
   `patchLlamaCppSourceForMusl` in `ensureLlamaCppCheckout`.

The two flows produce equivalent libraries on AOSP today (W1-A and W1-B
patches were lifted directly into the fork tree). The fork path:
- **Eliminates** the quadratic merge-conflict cost between QJL and
  Polar in `ggml-common.h` / `ggml-cpu.c` (both modified the same
  type_traits table; in-tree the conflict is resolved once, in patches
  it's resolved on every cherry-pick from a moving base).
- **Adds** the Metal kernel sources alongside the C/NEON sources, so a
  future `bun run build:metal` doesn't need to apply runtime patches.
- **Standardizes** on a single `LLAMA_CPP_TAG` across the host (DFlash)
  and AOSP build paths (next agent: align
  `build-llama-cpp-dflash.mjs` once DFlash is ported into the fork).

Once a follow-up release verifies no consumer pins the patches
directly, this directory can be deleted.

## Historical content (frozen)

### `qjl/`
Five patches that added `GGML_TYPE_QJL1_256 = 46` +
`GGML_OP_ATTN_SCORE_QJL` to apothic@b2b5273. Now landed on
`elizaOS/llama.cpp` branch `eliza/qjl` and merged into
`eliza/integration` (slot 46 unchanged).

### `polarquant/`
Four patches that added `GGML_TYPE_Q4_POLAR = 45` to apothic@b2b5273.
Now landed on `elizaOS/llama.cpp` branch `eliza/polarquant` —
**slot bumped from 45 to 47** so QJL (46) and Polar (47) coexist
without colliding on the reserved hole at 45 (which was
`GGML_TYPE_COUNT` in the TBQ-only build).
