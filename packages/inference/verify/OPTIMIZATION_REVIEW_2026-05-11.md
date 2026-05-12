# Shader/runtime optimization review - 2026-05-11

Worker E scope: standalone Metal/Vulkan shaders plus verify-side optimization
evidence. This pass kept runtime and fork patch code untouched.

## Edit landed

- `metal/turbo3_tcq.metal`: preload the 24-bit TCQ bit window once per lane in
  both `kernel_turbo3_tcq_dot` and `kernel_turbo3_tcq_dot_multi`.
- `vulkan/turbo3_tcq.comp`: mirror the same TCQ preload in the Vulkan
  standalone shader.

Reasoning: each lane decodes four consecutive TCQ states at bit offsets
`tid*12 + {0,3,6,9}`. The four 9-bit windows overlap and fit in three bytes,
including the final lane (`byte_idx0 + 2 == 48`, inside `qs[49]`). The old
loop reloaded two bytes per state; the new loop loads three bytes total and
uses shifts for each state. The decoded state sequence is algebraically
identical.

## Verification run

All commands were run from `/Users/shawwalters/eliza-workspace/eliza/eliza`.

```bash
make -C packages/inference/verify reference-test
make -C packages/inference/verify kernel-contract
make -C packages/inference/verify metal-verify metal-verify-multiblock
VK_ICD_FILENAMES=/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json \
DYLD_LIBRARY_PATH=/opt/homebrew/opt/vulkan-loader/lib:/opt/homebrew/opt/molten-vk/lib \
GLSLC=/opt/homebrew/bin/glslc \
  make -C packages/inference/verify vulkan-verify
```

Results:

- Reference self-test: finite outputs for Turbo3, Turbo4, TCQ, QJL, Polar, and
  Polar+QJL.
- Kernel contract: OK.
- Metal standalone: all six fixture routes passed 8/8. Edited TCQ single-block
  max diff was `6.676e-06`.
- Metal multi-block: Turbo3, Turbo4, TCQ, and QJL passed 8/8 at N=2,3,4,8.
  Edited TCQ multi-block max diff was `6.676e-06`.
- Vulkan standalone through MoltenVK: all six fixture routes passed 8/8 after
  rebuilding `turbo3_tcq.spv` from the edited source. Edited TCQ max diff was
  `4.768e-06`.

## Diagnostic bench

Ran a short non-calibrating bench to catch obvious regressions without
overwriting the published M4 Max JSON:

```bash
cd packages/inference/verify
./metal_bench --iters 120 --warmup 20 --runs 1 \
  --out /tmp/eliza-worker-e-metal-default.json
./metal_bench --mode multiblock --iters 60 --warmup 10 \
  --out /tmp/eliza-worker-e-metal-multiblock-final.json
```

This run was intentionally short and high-variance. It should not replace the
calibrated `bench_results/m4max_*.json` files. No obvious TCQ regression showed:
default TCQ was in the same cluster as the other small kernels, and multiblock
TCQ still improved best-case throughput (`285.44 us` at N=8 in the final short
run, `2.41x` vs its local single-block baseline).

## Remaining optimization opportunities

1. Fuse QJL score + softmax + V-cache mix. This removes score write/readback
   and is more valuable than isolated score-kernel tuning. The current ledger
   already identifies the CPU-side `GGML_OP_FUSED_ATTN_QJL_TBQ` shape as the
   target to port.
2. Keep realtime voice paths unbatched. Command-buffer batching hurts barge-in
   latency. Use N=1 for voice; use multi-block only where non-voice graph
   semantics allow the longer in-flight kernel.
3. Wire verified Metal multi-block paths deliberately for non-voice scans. The
   shader entrypoints are correct; the remaining work is runtime policy, not
   shader math.
4. PolarQuant can still improve by avoiding decode-to-128-float scratch for hot
   matvec paths. A fused Hadamard-dot route is the next shader-level target, but
   it is a larger correctness surface than the TCQ preload.
5. Do not pursue 64/128/256-thread Metal groups without replacing `simd_sum`
   with a shared-memory reduction. Current shaders assume one 32-lane SIMD
   group.
6. TCQ codebook inlining and fp16 Polar Hadamard remain speculative. Both need
   precision/perf experiments before shipping.
7. Vulkan wave64-specific reductions are still a hardware-tuning item for AMD,
   not a correctness fix. Keep the current 32-thread shared reduction as the
   portable baseline.

No change was needed in `ELIZA_1_TESTING_TODO.md`.
