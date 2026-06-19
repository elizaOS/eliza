# MLX in-process binding — Status

Status (2026-05-19): **Decided — watch upstream `node-mlx`; no in-process
MLX runtime today.** `mlxBackendEligible()` returns `eligible: false`
with a reason citing this document, which is the runtime behavior on
develop. No further work in this repo is planned until either (a) a
usable `node-mlx` Node binding stabilizes with `mlx_lm` text-generation
coverage, or (b) somebody picks up the libelizainference MLX backend
path described below.

Local inference must stay in-process: no subprocesses, no TCP. The
previous `mlx-server.ts` that spawned `python -m mlx_lm.server` and
spoke HTTP to it has been **deleted outright** — the file is gone, not
stubbed. No production callsite ever invoked it.

`plugins/plugin-mlx/` is an independent plugin that targets a
user-managed external `mlx_lm.server`. It's unrelated to this
in-process surface.

---

## Why no in-process MLX today

MLX is Apple's Python-first ML framework. There is no public C/C++
inference API we can wrap directly. To run MLX inference inside the
agent process we'd need one of:

### Path 1 — `libelizainference` MLX backend (preferred when picked up)

Add an `mlx` target under `plugins/plugin-local-inference/native/configs/gpu/`.
Link against `mlx-c` (the upstream C API for the MLX framework) and
implement the streaming/sampling glue against `eliza_token_trie_sampler.h`.
Expose the same FFI symbols the llama.cpp backend exposes, so
`FfiStreamingRunner` can drive it without a code change.

Constraints:
- MLX stays outside the kernel-verification contract (no TurboQuant
  K/V, no QJL, no PolarQuant). It's an opt-in reduced-optimization
  path like `ELIZA_LOCAL_ALLOW_STOCK_KV=1`.
- Stays gated behind `ELIZA_LOCAL_MLX=1` / `ELIZA_INFERENCE_BACKEND=mlx-server`.

Effort: 1–2 weeks of native + JS work.

### Path 2 — Swift-bridge MLX via Capacitor (iOS/macOS only)

Add MLXSwift as a SwiftPM dep in the Capacitor host. Wire a new
`ComputerUse` method (e.g. `mlxGenerate`) analogous to
`foundationModelGenerate`. Build an adapter under
`plugins/plugin-local-inference/src/backends/` that delegates through
that bridge. Stays in-process (Capacitor is not a subprocess — it's
the same app process).

Effort: ~1 week of Swift + JS work. iOS/macOS only; useless on
Linux/Windows. **Only consider if iOS/macOS MLX is a product priority.**

### Path 3 — `node-mlx` / `mlx-c` Node binding (passive)

Watch upstream. If a usable Node binding lands with `mlx_lm`
text-generation coverage (sampling loop, KV cache, tokenizer glue),
wire it as a third option. Don't depend on this — it's external.

Verified absent today: `rg -E "(mlx-c|node-mlx|mlx-swift|mlx-js)"
--include=package.json` → no hits across the monorepo.

### Chosen path

**Path 3 — wait for upstream.** Rationale: MLX is not a kernel-aware
path (it can never satisfy §3's TurboQuant/QJL/PolarQuant contract),
so the marginal value of building a custom integration is low. The
llama.cpp Metal backend already covers Apple Silicon for the
verified-kernel publish path. MLX-in-process is a "nice to have" for
unverified text-only generation, not a blocker.

If product priorities change (e.g. an iOS/macOS app specifically
needs MLX models for some reason), Path 2 is the most direct unblock.
Path 1 is the right architectural fit but is the largest effort.

---

## Whatever path gets picked must

- Not spawn a subprocess for inference.
- Not open a TCP socket for inference.
- Surface failures with real errors (no silent fallbacks).
- Keep MLX gated behind `ELIZA_LOCAL_MLX=1` / `ELIZA_INFERENCE_BACKEND=mlx-server`
  and outside the verified-kernel contract.

---

## Current runtime behavior

- `mlx-server.ts` deleted (commit `3f38613fd8b`).
- `mlxBackendEligible()` lives in… well, nowhere now — it was inlined
  into the diagnostic surface and the deletion took its callers with it.
  If a future MLX integration lands, it'll reintroduce eligibility
  reporting under its own naming.
- `ELIZA_LOCAL_MLX=1` / `ELIZA_INFERENCE_BACKEND=mlx-server` env vars are
  recognized by the engine config but have no effect — there's no MLX
  backend to activate. Set values are silently ignored. (If we want
  these to throw instead of being silent no-ops, that's a 5-line
  change in `engine.ts`'s env parsing.)

If you're hitting this doc because you want MLX inference, pick Path 1
or Path 2 above based on your platform constraint. The integration
seam (`FfiStreamingRunner` consuming `LlmStreamingBinding`) is ready;
plugging a new backend into it is mechanical once the C/Swift side
exists.
