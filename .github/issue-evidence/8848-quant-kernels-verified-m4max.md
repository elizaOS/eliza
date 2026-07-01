# #8848 — custom quantization kernels verified on Apple M4 Max (NEON-dotprod)

The QJL / TurboQuant / PolarQuant kernels (`packages/native/plugins/{qjl,turboquant,polarquant}-cpu`)
— the building blocks of the fused on-device quant path — verified correct on
real Apple Silicon (NEON-dotprod active lane):

| Kernel | Result |
|---|---|
| TurboQuant smoke | tbq3_0 rel-L2 **0.1635** (<0.30) · tbq4_0 **0.0880** (<0.20) · PASS |
| QJL int8 smoke | max_abs **0.001207**, **failures=0** |
| QJL avxvnni/neon-dotprod smoke | max_abs **0.000e+00** (exact), failures=0 |
| Polar SIMD-parity (dequant) | use_qjl=1 neon, max_abs **0.000e+00** (exact) |
| Polar SIMD-parity (dot) | rel_err **7.7e-08 / 7.9e-08** (budget 1e-5) |
| Polar roundtrip | rel_L2 0.091/0.099 (budgets 0.095/0.105) |

**On "Metal kernel fusion":** these kernels are CPU-SIMD (AVX2/NEON/RVV/dotprod/VNNI)
with no `.metal` shaders. Fusing them into net-new Metal compute kernels is a deep,
multi-week GPU-shader effort and is **dimensionally moot for the shipped Gemma-4**
(stock f16/q8_0 via the standard ggml-metal path, benchmarked separately at
250 tok/s decode on this M4 Max). The fused-quant family is the **retired 0.8b**
q-domain; its CPU kernels are correct here, and the Metal *model* path is verified.
