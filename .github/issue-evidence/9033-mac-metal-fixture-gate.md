# #9033 Mac Metal fixture gate evidence

Date: 2026-07-01
Branch: `fix/mac-local-inference-tests`
Host: Apple M1 Pro MacBook Pro, macOS Darwin 25.4.0, arm64, 16 GB RAM.

## Verification

Command:

```bash
make -C plugins/plugin-local-inference/native/verify metal-verify metal-verify-multiblock metal-verify-fused
```

Result: passed on this Mac.

Manually reviewed output highlights:

- Scalar Metal kernel gate passed for `turbo3`, `turbo4`, `turbo3_tcq`, `qjl`, `polar`, `polar + QJL residual`, `polar pre-Hadamard query`, and `polar pre-Hadamard query + QJL residual`.
- Multiblock Metal sweeps passed for `turbo3`, `turbo4`, `turbo3_tcq`, and `qjl` at block counts 2, 3, 4, and 8.
- Fused-attention Metal gates passed:
  - QJL-K + TBQ3-V: 1920/1920 outputs passed.
  - QJL-K + TBQ3-V causal prefix: 1536/1536 outputs passed.
  - QJL-K + Q4_POLAR-V: 1920/1920 outputs passed.
  - QJL-K + Q4_POLAR-V causal prefix: 1536/1536 outputs passed.
  - Polar pre-Hadamard score passed for use_qjl 0/1 and multiblock 2, 3, 4, 8.

## Evidence Applicability

- This is real Apple Metal fixture-parity evidence on an M-series Mac.
- It does not claim per-tier GGUF throughput, CoreML/MLX in-process backend validation, iOS validation, or production Gemma bundle lifecycle completion. Those #9033 residuals require staged model bundles, `llama-bench`/runtime artifacts, or additional devices.
