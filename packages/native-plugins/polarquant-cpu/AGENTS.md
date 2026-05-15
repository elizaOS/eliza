# polarquant-cpu — AGENTS

Standalone C library for **PolarQuant Q4** (`block_q4_polar`,
fork-side `GGML_TYPE_Q4_POLAR=47`). Used as both the Q4 weight quant
and the V-cache quant in the >8k-context default cache layout.
Sibling of `qjl-cpu` (K-cache) and `turboquant-cpu` (TBQ V-cache /
W-cache).

The combined fork that ships QJL + Q4_POLAR + TBQ is
**`elizaOS/llama.cpp @ v0.1.0-eliza`**, vendored at
`plugins/plugin-local-inference/native/llama.cpp/`. See `README.md`
for the algorithm, block format, and SIMD parity numbers.

## Source of truth

| File | Contains |
|---|---|
| `plugins/plugin-local-inference/native/llama.cpp/ggml/include/ggml.h`              | `GGML_TYPE_Q4_POLAR=47` |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-common.h`           | `block_q4_polar` (82 B) |
| `plugins/plugin-local-inference/native/llama.cpp/ggml/src/ggml-cpu/quants.{c,h}`   | fork CPU implementation |
| `plugins/plugin-local-inference/native/reference/qjl_polar_ref.{c,h}`              | bit-exact CPU reference |

This standalone library is the user-space mirror; the GGUF converter
at `scripts/polarquant_to_gguf.py` packs PolarQuant safetensors
sidecars into Q4_POLAR=47 GGUF files using the same block layout.

## Current tier coverage (W3 quant-matrix — 2026-05-14)

PolarQuant Q4 is the **V-cache default for every shipping Eliza-1
tier at >8k context** — see
`packages/shared/src/local-inference/CONTEXT_SCALING.md` table on
`qjl1_256` K + `q4_polar` V being the shipping default. The
TurboQuant TBQ3_0 V is the ≤8k-context fallback.

| Tier              | Q4_POLAR V-cache (default >8k ctx) | Q4_POLAR weights (Q4 path) |
|-------------------|-----------------------------------:|---------------------------:|
| eliza-1-0_8b      | shipped | buildable via `polarquant_apply.py` |
| eliza-1-2b        | shipped | buildable |
| eliza-1-4b        | shipped | buildable |
| eliza-1-9b        | shipped | buildable |
| eliza-1-27b       | shipped | buildable |
| eliza-1-27b-256k  | shipped | buildable |
| eliza-1-27b-1m    | shipped | buildable |

The full tier × quant-type matrix (rows = tier, columns = QJL-K +
PolarQuant-V + TurboQuant-W variants) lives at
`packages/training/reports/eliza1-quant-matrix-2026-05-14.md`.

## Tests + parity

- `polar_roundtrip_test` — round-trip a float[128] vs the Python
  reference's measured per-block error (~9–10%).
- `polar_dot_test` — dot product against an unquantized fp32 reference.
- `polar_simd_parity_test` — AVX2 vs scalar over 100 random blocks
  (max-abs ≤ 5e-7 dequant; rel-err ≤ 2e-7 dot).
- `polar_preht_*` — pre-Hadamard variants the fused-attn path needs.
- `make -C plugins/plugin-local-inference/native/verify kernel-contract`
  lists `polarquant` in `manifestKernelNames` /
  `requiredRuntimeCapabilityKeys` and reads the JSON fixture this
  library generates.
- `scripts/test_converter.py` — synthesise a 128×128 fp32 linear,
  encode + GGUF-write, read back via `gguf.GGUFReader`.
