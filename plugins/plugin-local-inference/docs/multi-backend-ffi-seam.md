# Multi-backend `libelizainference` FFI seam — design doc

> Realizes milestone **M3** of the Gemma 4 cutover ([gemma4-cutover-plan.md](gemma4-cutover-plan.md))
> and the M4/M5 backends that land on top of it. The interface this doc
> describes is already written: [`src/llm-backend.h`](../native/llama.cpp/tools/omnivoice/src/llm-backend.h).
> The FFI ABI it plugs into is [`include/eliza-inference-ffi.h`](../native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h)
> (the streaming-LLM surface, ABI v8+). The governing contract is
> [`native/AGENTS.md` §11](../native/CLAUDE.md) — "one managed library, one
> pipe, no sidecar/subprocess/TCP."

## 1. The problem — one FFI pipe, N in-process runtimes

The streaming-LLM FFI (`eliza_inference_llm_stream_open` → `_prefill` →
`_next`* → `_close`, plus `_cancel` / `_reset` / `_reset_keep`) is **one pipe**.
Every consumer — the Node FFI loader (`ffi-bindings.ts`), the Capacitor JNI
bridge on Android, the Swift bridge on iOS — drives exactly these symbols and
knows nothing about which inference runtime answers behind them.

Today that runtime is always the in-tree llama.cpp path: `EliLlmStream` owns a
private `llama_context` + sampler chain (and an optional `eliza_mtp::Engine`
speculative driver), and the FFI functions call into it directly. That is the
right default everywhere — CPU / CUDA / Vulkan-Mali-Adreno / Metal — but it is
**not** the fastest backend on every device:

| Backend | Where it wins | §11 status |
|---|---|---|
| **llama.cpp** | everywhere; the reference | owned pipe (today) |
| **LiteRT-LM** | Android **NPU** (Tensor / Qualcomm QNN / MediaTek NeuroPilot); opt. desktop/iOS GPU | owned pipe (M4) |
| **CoreML / MLX** | Apple Silicon (mac first, iOS later) | owned pipe (M5) |
| AICore / Apple Foundation | opportunistic fast-path | **external — not owned, not a backend here** |

Per the §11 reinterpretation, LiteRT-LM and MLX are **embeddable in-process C++
libraries** — they link *into* `libelizainference` and answer the *same* FFI
streaming symbols. They are never a child process or a TCP server. AICore
(Android Binder system service) and Apple Foundation Models stay opportunistic
adapters on the **TS** side (`backends/apple-foundation.ts` and friends); they
are out-of-process and are **not** registered as backends in this seam.

The problem M3 solves: let one FFI pipe be served by more than one in-process
runtime, selected per-`_open` from the platform + bundle + build flags + an env
override — **without touching the llama.cpp code path**, which stays the
default and the fallback.

## 2. Architecture

### 2.1 The two abstractions

[`llm-backend.h`](../native/llama.cpp/tools/omnivoice/src/llm-backend.h) defines
two pure-virtual interfaces. Both mirror the FFI 1:1 so the dispatch is a
delegate with zero argument translation.

**`LlmBackendSession`** — one per active generation. Its methods are the FFI
entry points minus the opaque-handle argument:

```cpp
int prefill(const int32_t* token_ids, size_t num_tokens, char** out_error);
int next(int32_t* tokens_out, size_t tokens_cap, size_t* num_tokens_out,
         char* text_out, size_t text_cap,
         int32_t* drafter_drafted_out, int32_t* drafter_accepted_out,
         char** out_error);                       // 0=more, 1=final, <0=ELIZA_* err
int cancel();                                     // ELIZA_OK; safe from another thread
int reset();                                      // clear KV + sampler/counters
int reset_keep(int32_t n_keep);                   // prefix-preserving; full-reset fallback => 0
int save_slot(const char*, char**);               // optional; default ELIZA_ERR_INVALID_ARG
int restore_slot(const char*, char**);            // optional; default ELIZA_ERR_INVALID_ARG
```

Status conventions are identical to the FFI: `>= 0` on success, the negative
`ELIZA_*` constants on failure (`ELIZA_ERR_CANCELLED` on cancel), `*out_error`
heap-allocated for the caller to free. `next()`'s `drafter_*_out` carry per-step
speculative stats and are `0` when the backend has no drafter. A backend that
cannot do prefix reuse MUST make `reset_keep()` fall back to a full reset and
return `0` — **never** an error.

**`LlmBackendFactory`** — one static-lifetime singleton per linked-in runtime:

```cpp
const char* name() const;                         // "llama.cpp" | "litert-lm" | "mlx-coreml"
bool available() const;                            // compiled in AND deps present on THIS host
bool can_serve(const char* bundle_dir) const;      // backend artifact exists in the bundle
int  preference_rank() const;                      // higher wins; llama.cpp == 0 (implicit fallback)
LlmBackendSession* open(EliInferenceContext*, const eliza_llm_stream_config_t*, char** out_error);
```

`available()` and `can_serve()` are both **cheap** — no model load. `available()`
returns false when the build gate is OFF or the runtime dependency (NPU delegate,
Metal device, linked lib) is absent on this host. `can_serve()` is a directory
probe for the backend-specific artifact under the bundle's `text/` dir.

`open()` receives the `EliInferenceContext*` but treats it as **opaque** — the
struct is only forward-declared in `llm-backend.h`. A backend reads the bundle
root through the one seam accessor
`llm_backend_context_bundle_dir(ctx)` (declared in `llm-backend.h`, defined in
the FFI translation unit where the struct is complete) and re-resolves its
artifact from there. There is no bundle-dir caching between `can_serve()` and
`open()`: both probe from the same root, so the selection path carries no
mutable cross-call state.

### 2.2 Bundle artifact discovery (`can_serve`)

The text model lives under `<bundle_dir>/text/` (§2 bundle layout). Each backend
recognizes its own artifact there:

| Backend | `can_serve(bundle_dir)` true when |
|---|---|
| llama.cpp | (implicit) `text/*.gguf` present — it is the fallback, never selected by rank |
| LiteRT-LM | `text/*.litertlm` present (Google ships pre-converted Gemma 4 `.litertlm` bundles) |
| MLX/CoreML | `text/*.mlpackage` **or** `text/*.mlmodelc` **or** an MLX weights dir present |

The manifest is the source of truth for bundle *contents*; `can_serve` is a
fast on-disk existence check that lets the selector skip a backend whose artifact
was not staged for this tier. A bundle that ships only `text/*.gguf` is served by
llama.cpp on every platform with no behavior change.

### 2.3 The selector

`llm_backend_select(bundle_dir, cfg, out_error)` runs at `_open` time. Resolution
order:

1. **`ELIZA_LLM_BACKEND` env — a HARD select (case-insensitive `name()` match).**
   - `"llama.cpp"` / `"llamacpp"` → returns `nullptr`, `*out_error == nullptr`:
     forces the in-tree path.
   - Any other name that is **not** registered+`available()`, or that
     **cannot** `can_serve(bundle_dir)`, is a **hard error**: returns `nullptr`
     **and** sets `*out_error`, so the FFI aborts rather than silently falling
     back to llama.cpp. An explicit backend request that can't be honored must
     fail loudly (§9 no-defensive-fallback).
2. **No env override — auto-select.** Among registered backends that are
   `available()` **and** `can_serve(bundle_dir)`, pick the highest
   `preference_rank()`. If none qualifies, return `nullptr` (`*out_error ==
   nullptr`) → use the in-tree llama.cpp path.

The return contract is the load-bearing detail:

| Return | `*out_error` | Meaning |
|---|---|---|
| non-null factory | — | open a session on this backend |
| `nullptr` | `nullptr` | **use the in-tree llama.cpp path** (not an error) |
| `nullptr` | non-null | **hard failure** — propagate, abort the `_open` |

`llm_backend_register_builtins()` registers every compiled-in factory once
(idempotent, gated by the `-DELIZA_ENABLE_*` options); the FFI translation unit
calls it at first `_open`.

### 2.4 Non-invasive FFI dispatch

The llama.cpp path is **untouched and stays the default**. Each
`eliza_inference_llm_stream_*` function gets one `if (stream-has-backend)` branch
inserted **above** the existing branches — never replacing them.

`EliLlmStream` today holds `{ lctx, sampler, mtp, ... }` and the streaming
functions already branch `if (stream->mtp) { ... } else { plain llama.cpp }`. M3
adds one field and one branch *above* that:

```cpp
struct EliLlmStream {
    LlmBackendSession* backend = nullptr;  // non-null => alternate runtime owns this session
    llama_context*     lctx    = nullptr;  // in-tree llama.cpp path (unchanged)
    /* sampler, eliza_mtp::Engine* mtp, mtp_first_token, mtp_step_buf, ... unchanged */
};
```

`_open`:

```cpp
char* sel_err = nullptr;
LlmBackendFactory* f = llm_backend_select(ctx->bundle_dir, cfg, &sel_err);
if (sel_err) { /* hard error: free stream, set *out_error, return NULL */ }
if (f) {
    stream->backend = f->open(ctx, cfg, out_error);
    if (!stream->backend) { /* free stream, return NULL */ }
    return stream;                         // alternate backend session — done
}
/* f == nullptr && no error: fall through to the EXISTING llama.cpp/MTP open path */
```

Every other streaming function gets the same top branch and otherwise runs
unchanged:

```cpp
int eliza_inference_llm_stream_next(EliLlmStream* s, /* ... */) {
    if (s->backend) return s->backend->next(/* args forwarded verbatim */);
    if (s->mtp)     { /* existing MTP path — unchanged */ }
    /* existing plain llama.cpp path — unchanged */
}
```

`_close` deletes `stream->backend` (the FFI owns the session per the interface
contract) and then tears down `lctx`/`sampler`/`mtp` as today. `_cancel` /
`_reset` / `_reset_keep` / `_save_slot` / `_restore_slot` follow the identical
"backend-branch-on-top" shape.

Consequence: a build with no alternate backend compiled in has
`stream->backend == nullptr` on every path, `llm_backend_select()` returns
`nullptr`/no-error, and the library behaves **exactly as before** — byte-for-byte
the current llama.cpp + MTP code path. The seam is inert until a backend gate is
turned on AND the bundle ships that backend's artifact AND it's selected.

## 3. Build flags — each backend is a compiled-out stub when its gate is off

Two CMake options, **both default OFF**:

| Flag | Backend | Links | Registers |
|---|---|---|---|
| `-DELIZA_ENABLE_LITERT` | LiteRT-LM | LiteRT-LM in-process C++ lib + NPU delegates | `litert-lm` factory |
| `-DELIZA_ENABLE_MLX` | MLX/CoreML | MLX / CoreML in-process libs (Apple only) | `mlx-coreml` factory |

When a gate is **off**:

- The backend's factory translation unit is either not compiled, or compiled as
  a stub whose `available()` returns `false` and whose `open()` returns
  `nullptr` + an error. `llm_backend_register_builtins()` only registers the
  factories whose gate is on.
- No alternate-runtime headers/libs enter the link line. The default
  `libelizainference` (no gates) links only the in-tree llama.cpp tree —
  unchanged from today.
- `llm_backend_select()` finds no `available()` candidate → returns `nullptr` →
  llama.cpp path. A stale `ELIZA_LLM_BACKEND=litert-lm` on a build without the
  gate is a clean hard error (env names an unavailable backend), not a silent
  llama.cpp fallback.

This keeps M3 (the seam + selector + stubs) landable and verifiable on Linux x64
**before** the device-only backend bodies (M4/M5) exist. The stubs compile out
cleanly; the seam compiles in.

`ELIZA_ENABLE_LITERT` / `ELIZA_ENABLE_MLX` join the existing per-feature gates
(`ELIZA_ENABLE_KOKORO`, `ELIZA_ENABLE_VISION`) and follow the same "absent
symbol / `*_supported() == 0`" degradation convention the ABI already uses.

## 4. Verifiability matrix

Honest scoping per the cutover plan's "verifiable in-session vs needs hardware"
split. Nothing is claimed verified without the evidence.

### Verifiable here (Linux x64 + CUDA)

| Item | How |
|---|---|
| The seam compiles | Build `libelizainference` with the M3 patch; the `if (stream->backend)` branches + `EliLlmStream::backend` field type-check and link. |
| llama.cpp still works **through** the seam | With no gate on, `llm_backend_select()` returns `nullptr`/no-error on every `_open`; run the existing CPU/CUDA text-gen + MTP + `llama-bench` / `e2e_loop_bench` and diff against the pre-M3 baseline. Identical output = the seam is inert when it should be. |
| Selector is unit-testable | Register fake factories (controllable `available()` / `can_serve()` / `preference_rank()`) and assert the resolution table: env hard-select (hit / unavailable-error / `llama.cpp`→nullptr), rank ordering, and the nullptr/`*out_error` tri-state. No model load, no device. |
| Scaffolds compile-out cleanly | Build with `-DELIZA_ENABLE_LITERT=ON` / `-DELIZA_ENABLE_MLX=ON` on Linux x64 where the runtime deps are absent: the factories compile, `register_builtins()` registers them, `available()` returns false (no NPU / no Metal), and selection still falls through to llama.cpp. Confirms the gate wiring without the device. |

### Device-gated (scoped + scaffolded, NOT claimed here)

| Item | Needs | Owner milestone |
|---|---|---|
| Gemma 4 → `.litertlm` conversion + bundle staging | LiteRT-LM toolchain; Pixel | M4 |
| LiteRT NPU delegate ladder (Tensor → QNN → NeuroPilot → GPU/CPU) | Pixel / QNN / NeuroPilot device | M4 |
| LiteRT on-device tok/s, first-token, peak RSS | Pixel | M4 / M7 |
| Gemma 4 → `.mlpackage` / `.mlmodelc` / MLX-weights conversion | Mac; CoreML/MLX toolchain | M5 |
| MLX/CoreML on-device tok/s, RSS, first-token | Mac (mac first, iOS later) | M5 / M7 |
| `next()` drafter stats parity vs llama.cpp MTP | per-backend device run | M6 / M7 |

The M3 PR ships: the interface (already written), the selector + its unit tests,
the non-invasive FFI dispatch branches, the two build gates, and compile-out
stubs for both backends. The backend *bodies* (delegate ladders, weight loaders,
real `prefill`/`next`) are M4/M5 and land behind their device gates.

## 5. Mapping to cutover-plan acceptance criteria

From [gemma4-cutover-plan.md](gemma4-cutover-plan.md) "Acceptance criteria":

| Criterion | How this seam satisfies it |
|---|---|
| "Multi-backend selection behind one FFI; LiteRT/MLX/CoreML in-process; AICore/Foundation opportunistic." | `LlmBackendFactory` + `llm_backend_select()` are *the* multi-backend selection, behind the single `eliza_inference_llm_stream_*` pipe. LiteRT/MLX register as in-process factories; AICore/Foundation are explicitly **not** registered here (TS adapters). |
| "Gemma 4 runs through `libelizainference` (text+vision+audio+MTP) on every buildable backend." | The seam is the text-path mechanism by which a non-llama.cpp backend serves Gemma; llama.cpp remains the buildable-everywhere path (rank 0 fallback). Vision/audio/MTP stay on their existing fused surfaces. |
| "tok/s + RSS + first-token + MTP-acceptance captured per platform; faster-or-justified vs the retired Qwen line." | `next()`'s `drafter_drafted_out` / `drafter_accepted_out` give per-step MTP-acceptance for any backend that drafts; per-platform tok/s/RSS/first-token are the M4/M5/M7 device measurements gated above. |
| "Verified on web + desktop app + on-device (as hardware allows; else honestly scoped)." | §4: the seam + selector + compile-out are verified on Linux x64+CUDA in-session; the LiteRT/MLX bodies are scoped to M4/M5/M7 device runs and not claimed before evidence. |
| "eliza-1 branding preserved (users never see Qwen/Gemma)." | Unchanged — the backend `name()` values (`llama.cpp`, `litert-lm`, `mlx-coreml`) and `ELIZA_LLM_BACKEND` are developer-facing only; no user-visible string changes. |

### M3 milestone exit

M3 (this seam) is done when, on Linux x64 + CUDA:

- [ ] `libelizainference` builds with the dispatch branches; default (no-gate)
      build is byte-for-byte the pre-M3 llama.cpp path on `e2e_loop_bench`.
- [ ] The selector unit tests pass the full resolution table (env hard-select,
      rank ordering, the nullptr/`*out_error` tri-state).
- [ ] `-DELIZA_ENABLE_LITERT=ON` and `-DELIZA_ENABLE_MLX=ON` builds compile,
      register, report `available() == false` on this host, and fall through to
      llama.cpp.
- [ ] No consumer (`ffi-bindings.ts`, JNI, Swift) changes — the FFI ABI is
      unchanged (the seam is entirely below the ABI surface).

M4 (LiteRT body) and M5 (MLX/CoreML body) build on this seam behind their
device gates and are out of M3's scope.
