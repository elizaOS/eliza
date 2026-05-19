# FFI Streaming Backend Wire-up — Status

Status (2026-05-19): **Steps A–E landed. Plus slot save/restore, prewarm,
and speculative decoding. The desktop FFI adapter is the default
text-generation path on desktop.** Vision describe (mmproj) and
parallel-slot resize remain on the subprocess `dflash-server` fallback
because they require native C work in `eliza-llama-shim.c` that this
JS-only effort cannot deliver. `dflash-server.ts` retirement (Step F)
stays blocked on those two parity items.

This doc is now a status record + a follow-up backlog. The original
implementation plan is preserved at the bottom for archival.

---

## What's shipped

### Backend selection + dispatcher

- **`backend-selector.ts`** — `selectBackend()` returns `"ffi-streaming"`
  on desktop when `ffiSupported` is true. `ELIZA_INFERENCE_BACKEND=http`
  is the explicit opt-out. No `=ffi` opt-in flag — FFI is the default.
- **`backend.ts`** — `LocalInferenceBackend` interface has 12 optional
  methods covering everything `engine.ts` previously called directly on
  the `dflashLlamaServer` singleton. `BackendDispatcher` has matching
  forwarders that throw actionable "active backend (X) does not
  implement Y" errors when the active backend lacks a feature.
- **`backend.ts`** — `BackendDispatcher` accepts `ffiStreaming` +
  `probeFfiActive` constructor params. The engine wires them with the
  desktop FFI runtime + a probe that checks dylib disk presence + the
  `ELIZA_INFERENCE_BACKEND` env opt-out.

### Engine call-site refactor

- **`engine.ts`** — every direct `dflashLlamaServer.X(...)` call (16
  sites, including vision describe, slot persistence, prewarm,
  parallel-resize, drafter introspection) now routes through
  `this.dispatcher.X(...)`. The only remaining reference to the
  singleton in `engine.ts` is the dispatcher constructor.

### Desktop FFI adapter

- **`services/desktop-llama-adapter.ts`** — bun:ffi adapter for the
  desktop `libllama.{dylib,so,dll}` + `libeliza-llama-shim.{dylib,so,dll}`
  pair. Mirrors the verified AOSP adapter pattern with desktop-specific
  path resolution (`$ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/`).
  Exposes:
  - Model + ctx load via shim params (pointer-style, since llama.cpp's
    `_default_params` returns struct-by-value).
  - `tokenize(text): Int32Array` via direct `llama_tokenize` bind.
  - `LlmStreamingBinding` implementation: open / prefill / next / cancel
    / close sessions, one sampler chain per session, KV-clear-between-
    sessions guard (mirrors the AOSP `hasDecoded` gate that avoids the
    fresh-ctx segv).
  - `saveSlot` / `restoreSlot` via direct `llama_state_seq_save_file`
    / `_load_file` bind (no shim wrapper needed — both are pointer-style
    upstream).
  - **Speculative decoding**: `attachDrafter()` loads + attaches a
    drafter model via the shim's `eliza_llama_context_attach_drafter`,
    sets spec_mode via `eliza_llama_context_set_spec_mode`, and routes
    decode through `eliza_llama_decode_unified`. Per-step
    `drafterDrafted` / `drafterAccepted` counters populated by diffing
    the `eliza_llama_dflash_stats` block before/after each step.

### Desktop runtime

- **`services/desktop-ffi-backend-runtime.ts`** — production
  `FfiBackendRuntime` impl. `supported()` does a cheap disk probe;
  `acquire(plan)` loads dylibs, mmaps the model, resolves the drafter
  path from `plan.catalog.runtime.dflash.drafterModelPath`, and returns
  the session; `release()` tears everything down (drafter first, then
  main ctx, then model — same order the shim's lifetime rules expect).

### FFI streaming backend

- **`services/ffi-streaming-backend.ts`** — implements
  `LocalInferenceBackend` over the runtime. Exposes:
  - `generate` (text-only, calls the runner's `generateWithUsage`)
  - `persistConversationKv` / `restoreConversationKv` — forward to the
    binding's `llmStreamSaveSlot` / `RestoreSlot` with a per-conversation
    filename (`<conversationId>__slot<slotId>.kv`).
  - `prewarmConversation` — pure JS, runs the runner with `maxTokens=0`
    to feed the prompt without generating. The runner's `slotInFlight`
    serializes concurrent prewarms against the same cacheKey.
  - `drafterEnabled` / `loadedDrafterModelPath` — reports whether the
    catalog declared a drafter for the active session.
  - Deliberately no `embed`, `describeImage`, `resizeParallel` — the
    dispatcher's forwarders throw actionable errors when those are
    called against an FFI session (parity work tracked below).

### Narrow `LlmStreamingBinding` interface

- **`services/llm-streaming-binding.ts`** — narrow 8-method contract the
  runner consumes. `wrapElizaInferenceFfi(ffi)` adapter promotes the
  optional libelizainference surface to the required-shape narrow
  contract. The desktop adapter implements it directly.

### MLX

- **`mlx-server.ts` deleted outright**. No production caller ever
  invoked the spawn+HTTP path. Eligibility helpers stay where they were;
  `mlxBackendEligible()` returns `eligible: false` with a reason citing
  the missing in-process runtime. See `MLX_IN_PROCESS_PLAN.md`.

---

## What's still on the subprocess `dflash-server` fallback

### Vision describe (mmproj) — the only remaining feature blocker

- **Why subprocess**: requires C wrappers in
  `packages/app-core/scripts/desktop-llama-shim/eliza_llama_shim.c` for
  llama.cpp's llava / mtmd integration. Vision involves loading an
  mmproj GGUF, running clip-vision over an image to produce embeddings,
  then injecting those embeddings into the decode pipeline. The shim
  today only includes `llama.h`; it does not include `llava.h` /
  `mtmd.h`. The desktop dylib build script also currently sets
  `LLAMA_BUILD_EXAMPLES=OFF` which excludes the llava sublibrary from
  the build.
- **Effort to unblock**:
  - Modify `packages/app-core/scripts/build-llama-cpp-desktop-dylib.mjs`
    to additionally build the llava + clip sublibraries (or vendor only
    the source files we need under `desktop-llama-shim/`).
  - Add C wrappers to `eliza_llama_shim.c`: `eliza_llava_image_embed_load`
    (file or bytes → embed handle), `eliza_llava_image_embed_eval`
    (embed handle + ctx → KV state update), `eliza_llava_image_embed_free`.
  - Add the matching headers to `eliza_llama_shim.h`.
  - Bind the new symbols in `desktop-llama-adapter.ts` (`ShimSymbols`,
    `bindShim`).
  - Implement `describeImage(args)` on the adapter: base64-decode the
    image, call the embed load, eval into the ctx, run a constrained
    generate loop for the description.
  - Wire `FfiStreamingBackend.describeImage`.
  - **Total**: ~3–4 days of native C + ~250 lines of JS. Cannot be
    done from a JS-only session because the C side needs build/test
    cycles against the actual upstream llava ABI.
- **Blast radius**: this is the ONLY feature still blocking Step F
  (retire `dflash-server.ts`). All other features have FFI parity.

### Done since the original plan

- **Parallel-slot resize** — DONE. Adapter now has a `ctxPool: Pointer[]`
  with per-ctx `hasDecodedFlags` and `drafterAttached` tracking arrays.
  `resizeParallel(N)` allocates (or frees) ctx instances against the
  same loaded model. Sessions pin to a specific ctx via
  `config.slotId % pool.length`. Drafter is per-ctx, attached lazily
  on first session that requests it on that ctx. The shared drafter
  model is loaded once and reused across ctxs.
  Wired through:
  - `DesktopLlamaAdapter.resizeParallel(N)` / `.parallelSlots()`
  - `DesktopFfiBackendRuntime.resizeParallel` / `.parallelSlots`
  - `FfiBackendRuntime` interface (optional methods)
  - `FfiStreamingBackend.resizeParallel` / `.parallelSlots`
  - The dispatcher's `resizeParallel` forwarder routes here when the
    FFI backend is active; engine's `maybeAutoResizeParallel` (which
    already called through the dispatcher) gets the new behavior for free.

---

## Step F — retire `dflash-server.ts`

Blocked on vision + parallel-resize parity above. Once both are
implemented in the shim + adapter, the file can be deleted via:

1. Confirm no remaining `dflashLlamaServer.X` references in `engine.ts`
   (already true — refactor done).
2. Relocate the ~50 utility exports `dflash-server.ts` provides to other
   files (catalog reads, env helpers, etc — these are non-transport
   utilities that happen to live in the same file).
3. Delete the file + remove the dispatcher constructor arg.
4. Remove the `ELIZA_INFERENCE_BACKEND=http` opt-out from the engine's
   probe (no subprocess to fall back to).

Estimated total work to land Step F once vision + resize parity exist:
~1 focused day of JS + a careful soak period.

---

## Risk register (updated)

| Risk | Mitigation status |
|---|---|
| Silent vision/slot failures when FFI active | ✅ Dispatcher throws actionable errors; slot save/restore now landed (subprocess fallback for vision only) |
| Tokenizer mismatch produces gibberish | ⚠️ Runtime vocab-size assertion still TODO in the adapter. Mitigated in practice by the engine loading one model at a time. |
| Concurrent dispatcher + direct-singleton paths racing | ✅ Eliminated by engine.ts refactor |
| Default flip exposed before parity | ✅ Vision + resize automatically fall to subprocess via dispatcher throw; users can set `ELIZA_INFERENCE_BACKEND=http` for full subprocess mode |
| Runtime correctness of the desktop adapter | ⚠️ The adapter follows the AOSP pattern 1:1 but has not been runtime-tested against `libllama.dylib` in this environment (cmake OOMs). The user/CI needs to build the dylibs and exercise the path before declaring this production-ready. |

---

## References

- `services/backend-selector.ts:82` — `selectBackend()`.
- `services/backend.ts:165-200` — `LocalInferenceBackend` interface.
- `services/backend.ts:497-650` — `BackendDispatcher` + forwarders.
- `services/desktop-llama-adapter.ts` — bun:ffi adapter.
- `services/desktop-ffi-backend-runtime.ts` — production `FfiBackendRuntime`.
- `services/ffi-streaming-backend.ts` — `LocalInferenceBackend` impl.
- `services/llm-streaming-binding.ts` — narrow runner contract.
- `services/ffi-streaming-runner.ts` — text-gen streaming loop.
- `packages/app-core/scripts/desktop-llama-shim/eliza_llama_shim.h` — C ABI.
- `packages/app-core/scripts/build-llama-cpp-desktop-dylib.mjs` — dylib build.
