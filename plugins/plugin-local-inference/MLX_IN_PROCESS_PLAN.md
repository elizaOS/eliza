# MLX in-process binding — blocker and unblock plan

Local inference must stay in-process: no subprocesses, no TCP. The previous
`plugins/plugin-local-inference/src/services/mlx-server.ts` spawned
`python -m mlx_lm.server` and called it over `http://127.0.0.1:<port>` with
`fetch()`. That transport has been removed.

The MLX class (`MlxLocalServer`) is now a stub — `hasLoadedModel()` is
permanently `false`, `load()` and `generate()` throw with a pointer to this
document. The engine no longer has an MLX fallthrough. Eligibility helpers
(`mlxOptIn`, `isAppleSilicon`, `resolveMlxPython`, `looksLikeMlxModelDir`,
`resolveMlxModelDir`, `mlxBackendEligible`) remain for diagnostics; the last
one now reports `eligible: false` with a reason citing the missing in-process
runtime even when the host otherwise looks ready.

## Why this is safe today

Nothing in production code ever called `mlxLocalServer.load()`. Grep:

```
$ rg "mlxLocalServer\.(load|generate|unload)" --type ts plugins/ packages/
plugins/plugin-local-inference/src/services/engine.ts:        // (now removed)
```

The engine branch was gated on `mlxLocalServer.hasLoadedModel()`, which could
only return `true` after a successful `load()`. No callsite invoked `load()`,
so the branch was unreachable. Removing the spawn+HTTP machinery and the
engine branch eliminates dead code that violated the no-subprocess rule.

`plugins/plugin-mlx/` is an independent plugin that targets a user-managed
external `mlx_lm.server`. It is unrelated to this in-process surface and is
not affected.

## Blocker — why we can't drop in an in-process MLX runtime today

MLX is Apple's Python-first ML framework. There is no public C/C++ inference
API we wrap. To run MLX inference inside the Node process we need one of:

1. **`node-mlx` / `mlx-c` Node binding.** Neither dependency is present:
   - `rg -E "(mlx-c|node-mlx|mlx-swift|mlx-js)" --include=package.json` → no hits.
   - No upstream community binding has stabilized at the time of writing that
     covers `mlx_lm` text generation (sampling loop, KV cache, tokenizer glue).
2. **MLX backend inside `libelizainference`.** Inspection of
   `plugins/plugin-local-inference/native/`:
   - `include/` has only `eliza_token_trie_sampler.h` — no MLX symbols.
   - `configs/gpu/` has no MLX target (CUDA, Metal-via-llama.cpp, ROCm, Vulkan).
   - The fused build wraps llama.cpp; MLX kernels are not linked in.
3. **Swift / Objective-C bridge via Capacitor.** Possible on iOS/macOS but
   `apple-foundation.ts` already covers the Apple-Intelligence surface for
   that platform via the `ComputerUse` bridge. MLX through the same bridge
   would need new Swift code in `plugins/plugin-computeruse` plus an
   MLXSwift dependency; it is a meaningful build addition, not a drop-in.

## Concrete unblock plan (when MLX in-process is wanted)

Recommended path, ordered by effort:

1. **Reuse `ffi-streaming-runner` with a `libelizainference` MLX backend.**
   - Add an `mlx` target under `plugins/plugin-local-inference/native/configs/gpu/`.
   - Link against `mlx-c` (the upstream C API for the MLX framework) and
     implement the streaming/sampling glue against `eliza_token_trie_sampler.h`.
   - Expose the same FFI symbols the llama.cpp backend exposes, so
     `ffi-streaming-runner` can drive it without a code change.
   - Keep MLX outside the kernel-verification contract (it never satisfies
     §3 — no TurboQuant K/V, no QJL, no PolarQuant); it remains an opt-in
     reduced-optimization path like `ELIZA_LOCAL_ALLOW_STOCK_KV=1`.

2. **Swift-bridge MLX via Capacitor (iOS/macOS only).**
   - Add MLXSwift as a SwiftPM dep in the Capacitor host.
   - Wire a new `ComputerUse` method (e.g. `mlxGenerate`) analogous to
     `foundationModelGenerate`.
   - Build an adapter under `plugins/plugin-local-inference/src/backends/`
     that delegates through that bridge. This stays in-process (Capacitor is
     not a subprocess — it's the same app process).

3. **Watch upstream `node-mlx`.** If a usable Node binding lands with
   `mlx_lm` text-generation coverage, wire it as a third option. Don't depend
   on this — it's external.

Whichever path we pick must:

- Not spawn a subprocess for inference.
- Not open a TCP socket for inference.
- Surface failures with real errors (no silent fallbacks).
- Keep MLX gated behind `ELIZA_LOCAL_MLX=1` / `ELIZA_LOCAL_BACKEND=mlx-server`
  and outside the verified-kernel contract.

## Until then

`mlxBackendEligible()` returns `eligible: false` with a reason that names this
document. The recommendation surface, `/api/local-inference/active`, and any
diagnostics that consume eligibility will report MLX as unavailable instead of
silently falling through to a working backend.
