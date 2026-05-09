# llama.cpp patches

Patches applied on top of the apothic/llama.cpp-1bit-turboquant fork
(`b2b5273e8b275bb96362fe844a5202632eb3e52b`) before each AOSP build.

Each subdirectory is a `git format-patch`-style series. They are applied
in numeric order via `apply-patches.mjs` from inside `compile-libllama.mjs`.

## Series

### `qjl/`

Adds `GGML_TYPE_QJL1_256 = 46` + `GGML_OP_ATTN_SCORE_QJL`. K-side
KV-cache quantization at ~1 bit per JL-projected coord plus a per-token
bf16 norm. Composes with V-side `GGML_TYPE_TBQ3_0` for ~5.7× total KV
reduction at long context (Qwen3-0.6B-shape, head_dim=128, 8 kv_heads).

CPU kernels vendored from
`packages/native-plugins/qjl-cpu/` (scalar + AVX2 + NEON, 100/100
bit-parity vs the Python reference).

### `polarquant/`

Adds `GGML_TYPE_Q4_POLAR = 45` + `block_q4_polar` (82B = fp16 d-norm +
64B Q4 codes + 16B optional QJL residual = 5.125 bpw with QJL,
4.125 without). Weight-side rotated quantizer with Lloyd-Max-for-N(0,1)
centroids; rotation is precomputed in the GGUF converter so dequant is
rotation-free.

CPU kernels (scalar reference only this drop) vendored from
`packages/native-plugins/polarquant-cpu/`. NEON / AVX2 SIMD are next-
session work.

The QJL residual sign-vector portability question (Python `torch.randint`
vs C `xorshift32`) is gated behind a runtime flag
`ggml_q4_polar_set_use_qjl()` — defaults off until the GGUF converter
embeds the canonical signs in metadata. Effective bpw is therefore
4.125 today.

## How to apply

```bash
cd <llama.cpp checkout>
git checkout b2b5273e8b275bb96362fe844a5202632eb3e52b
for p in eliza/packages/app-core/scripts/aosp/llama-cpp-patches/*/[0-9]*.patch; do
    git am < "$p"
done
```

`compile-libllama.mjs` does this automatically before configuring CMake.

## Updating a series

When a vendored kernel library changes:

1. Cherry-pick the corresponding commits from
   `worktree-agent-a55644a05aeeed035` (QJL adapter wiring) or
   `worktree-agent-af1c97296995ca45a` (PolarQuant).
2. Re-run `git format-patch <base>..<branch>` in the local llama.cpp
   working tree.
3. Replace the relevant subdirectory contents with the new patch series.
4. Bump the comment in `compile-libllama.mjs`'s pin block so the next
   build invalidates its cache.

## Why patches and not a fork?

The Apothic fork is the actual remote we cross-compile against. Pushing
QJL+PolarQuant changes there requires a maintainer review on that repo.
Until those changes land upstream, the patches let an AOSP build pull
the canonical fork tag and apply our deltas locally — no fork-of-fork
to maintain on a separate remote.
