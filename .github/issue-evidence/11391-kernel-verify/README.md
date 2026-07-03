# #11391 — per-backend kernel verify + kokoro RTF + TurboQuant evidence

**Date:** 2026-07-02 · **Host:** Apple M4 Max (128 GB), macOS 26.2 ·
**Fork pin:** `plugins/plugin-local-inference/native/llama.cpp` @ `58c0391eb`
(the exact `origin/develop` gitlink = `2bdcef890` kokoro portable-fast + the
two #11612 Metal fixes). Fork built fresh at the pin:
`cmake -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON`.

**Load caveat:** this host was carrying a concurrent agent swarm (load average
70–135, including *other* agents' llama-bench processes). GPU/Metal numbers and
user-CPU-time figures are the durable signal; CPU wall-clock throughput is
contention-depressed and annotated as such.

Durable decision doc:
[`plugins/plugin-local-inference/native/verify/M6-per-backend-kernel-decisions.md`](../../../plugins/plugin-local-inference/native/verify/M6-per-backend-kernel-decisions.md).

## Files

| File | What it proves |
|---|---|
| `cpu-reference-test.log` | CPU C-reference fixture gate clean (`gen_fixture --self-test`: all kernels finite, fused-attn + TBQ V-cache + split-K merge parity OK) |
| `metal-verify-8of8.log` | §8 gate: **8/8 PASS** (turbo3, turbo4, turbo3_tcq, qjl, polar, polar+QJL-residual, polar-preHT, polar-preHT+QJL-residual), tol 1e-3, max diff ≤ 8.1e-6 |
| `metal-verify-shipped.log` | The kernels **embedded in the fork's runtime metallib source** (`ggml-metal/eliza-shipped/`) match the C reference — the anti-drift gate |
| `metal-verify-fused.log` | Fused-attn QJL-K+TBQ3-V / QJL-K+Q4_POLAR-V (incl. causal) + polar-preHT multi 2/3/4/8 PASS |
| `metal-verify-multiblock.log` | Multi-block entrypoints PASS at blocks 2/3/4/8 |
| `metal-dispatch-smoke.log` | **9/9 graph routes PASS** against the *built* `libggml-metal.dylib` at the pin (ATTN_SCORE_QJL / TBQ×3 / POLAR×2 / POLAR_PREHT×2 / FUSED_ATTN_QJL_TBQ) |
| `vulkan-moltenvk-verify-8of8.log` | `vulkan-verify` **8/8 PASS** on MoltenVK (`device=Apple M4 Max api=1.2.334`), max diff ≤ 4.4e-6 |
| `metal-fa1-gemma4-e2b-llama-bench.log` | Gemma-4 E2B Q8_0, Metal, `-fa 1`: `flash_attn = enabled`, `dk512_dv512` + `dk256_dv256` FA pipelines compiled, **0 “padding V cache” lines**; pp512 **2828.56 ± 84.62 t/s**, tg128 **89.65 ± 0.46 t/s** |
| `metal-fa0-gemma4-e2b-llama-bench.log` | Same model `-fa 0`: **4 “padding V cache to 512” lines** (the dual-head-dim padding FA removes); pp512 2690 / tg128 86.48 |
| `kokoro-rtf-m4max.{log,wav}` | Real kokoro synth at the pin (Q4_K_M model + af_bella, same phrase as the merged evidence): WAV **byte-identical (md5) to `kokoro-metal-perf/after.wav`**, samples=112800 @ 24 kHz (4.7 s), 0.90 s user CPU ≈ **compute RTF 0.19** under swarm load (idle-host merged evidence: 723 ms wall, **RTF 0.15**; pre-fix baseline RTF ≈ 64) |
| `metal-tbq4-kv-llama-bench.log` | **Honest failure:** `-ctk tbq4_0 -ctv tbq4_0` on Metal aborts — `pre-allocated tensor (cache_k_l0 (view)) in a buffer (MTL0) that cannot run the operation (SET_ROWS)`; Metal SET_ROWS/CPY whitelists have QJL1_256 but no TBQ type (CUDA `set-rows.cu` has both TBQ3_0/TBQ4_0) |
| `cpu-tbq4-kv-llama-bench.log` | TBQ4_0 KV on CPU runs end-to-end on Gemma: tg16 **39.41 t/s**, pp64 **1.33 t/s** |
| `cpu-fa1-baseline-llama-bench.log` | Same shape, default (f16) KV, back-to-back under the same contention: pp64 **2.13 t/s** → TBQ KV prefill ≈ **0.62×** baseline; both absolute CPU numbers are contention-bound (other agents' llama-bench processes co-resident), only the ratio is meaningful |
| `ppl-metal-q8_0-src.log` | wikitext-2 (8 chunks) PPL, shipped gemma4-E2B **Q8_0** weights, Metal: **184.07 ± 22.33** |
| `ppl-metal-q4km.log` | Same, **Q4_K_M** requant of the same weights: **204.05 ± 24.81** (+10.9% vs Q8_0) |
| `ppl-metal-tbq4k-ffn-EXPECT-FAIL.log` | The TBQ4_K-FFN quantize output does not load (rejected partial) — see quantize failure below |
| `ppl-cpu-kv-tbq4_0.log` | wikitext-2 (2 chunks) PPL, Q8_0 weights, CPU, `-ctk tbq4_0 -ctv tbq4_0 -fa 1`: **101.63 ± 24.55** |
| `ppl-cpu-kv-f16.log` | Same 2 chunks with default f16 KV: **103.54 ± 25.05** → TBQ4_0 KV is quality-parity on Gemma (within noise) |
| `quantize-tbq4k-ffn.log` (excerpt below) | **TurboQuant weight-quant is broken at the pin:** `llama-quantize --tensor-type ffn_{up,gate,down}=tbq4_k` applies 105 overrides, converts, then **fails**: `ggml_validate_row_data: invalid type 50` → `llama_model_quantize: failed to quantize: quantized data validation failed` (exit 1) |

## TurboQuant weight-quant — tool-level failure (verbatim)

```
[  14/ 601] blk.0.ffn_down.weight  - [ 6144, 1536, 1, 1], type = q8_0, converting to tbq4_k .. ggml_validate_row_data: invalid type 50
…
llama_model_quantize: failed to quantize: quantized data validation failed
main: failed to quantize model from '…/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf'
```

Plus the structural grep facts at the pin: no `LLAMA_FTYPE_MOSTLY_TBQ*` in
`include/llama.h` / `src/llama-quant.cpp`; no TBQ3_K/TBQ4_K kernels under
`ggml/src/ggml-metal/` or `ggml/src/ggml-vulkan/` (CPU-only trait entries).
TurboQuant *weight* quant therefore does not exist end-to-end at this pin —
recorded as the honest residual in the decision doc §4(b).
