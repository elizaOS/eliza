# FFI Streaming Backend Wire-up — Implementation Plan

Status: **scaffolding landed, production wiring pending**.

This doc captures the architectural audit and step-by-step plan for routing
desktop local-inference text generation through the in-process FFI streaming
runner (`plugins/plugin-local-inference/src/services/ffi-streaming-runner.ts`)
instead of the subprocess+HTTP `dflash-server`. The polarity flip in
`backend-selector.ts` was completed earlier in the consolidation pass, but
`selectBackend()` is not yet consumed by any production code — the runtime
still routes through `BackendDispatcher` which only knows about
`node-llama-cpp` vs the subprocess.

This doc describes the safe, incremental path to close that gap.

## What's already done

- `backend-selector.ts` returns `"ffi-streaming"` on desktop when
  `ffiSupported` is true, with `ELIZA_INFERENCE_BACKEND=http` as opt-out.
- `ffi-streaming-runner.ts` is fully implemented but unused outside tests.
- `runtime-dispatcher.ts` exposes `dispatchGenerate()` that already speaks the
  `selectBackend()` return type — also unused outside tests.
- The `dflash-server.ts` subprocess+HTTP path no longer carries the OmniVoice
  TTS routes (P2 consolidation work) and the `mlx_lm.server` subprocess+HTTP
  path is stubbed to a throw (P1).
- `plugins/plugin-local-inference/src/services/ffi-streaming-backend.ts` —
  scaffolding class implementing `LocalInferenceBackend`, takes a
  `FfiBackendRuntime` constructor dependency. **Not yet constructed from
  `engine.ts`** (the `FfiBackendRuntime` provider doesn't exist in production
  yet).
- `BackendDispatcher` accepts optional `ffiStreaming` + `probeFfiActive`
  constructor params — when both are supplied, the dispatcher routes the
  `"llama-server"` decision through the FFI backend instead of the subprocess.
  Default behavior unchanged when params are omitted.

## What's NOT done — the real architectural gaps

The Plan agent audit (`@/services/backend.ts` lines 165-175, 395-489, and
`engine.ts` direct-call sites) surfaced four gaps that make a naive "swap the
default" change unsafe:

### 1. The engine bypasses the dispatcher for ~19 method calls

`dflashLlamaServer` is a module-level singleton in `dflash-server.ts:4328`,
imported and called directly from `engine.ts` for:

- vision (`describeImage` at `engine.ts:1216`)
- slot/KV persistence (`persistConversationKv` at `:3814`,
  `restoreConversationKv` at `:3839`, called from `engine.ts:1268, 1304`)
- conversation prewarm (`prewarmConversation` at `engine.ts:1372`)
- parallel-slot resize (`resizeParallel` at `dflash-server.ts:3101`, called
  from `engine.ts:1018, 1441, 2534`)
- direct generate at `engine.ts:654-655`
- introspection (`currentMmprojPath`, `loadedDrafterModelPath`,
  `parallelSlots`, etc.)

If the dispatcher routes loads through the FFI backend, the subprocess never
starts, `dflashLlamaServer.hasLoadedModel()` returns `false`, and **all of
these call sites silently no-op or take a wrong branch**. They must either:

- (a) Get rewritten to go through the dispatcher (each direct call replaced
  by `this.dispatcher.<method>()` or an injected provider).
- (b) Be guarded — when `dispatcher.activeBackendId() === "llama-server"`
  but the FFI backend is active, throw an actionable error pointing at
  `ELIZA_INFERENCE_BACKEND=http`.

(b) is the safer first step. (a) is the eventual right answer.

### 2. FFI context ownership

`FfiStreamingRunner` requires `ElizaInferenceFfi` + `ElizaInferenceContextHandle`
in its constructor. That handle is created/destroyed by the **voice lifecycle
service** today, not the engine. The dispatcher has no path to acquire it.

To wire production, someone needs to build a `FfiBackendRuntime` provider that
either:

- Owns its own FFI context (separate from the voice service's), or
- Shares the voice service's handle when one exists, or
- Refactors the voice lifecycle to be the canonical FFI-context owner that
  every consumer (including the engine) borrows from.

This is the biggest architectural decision the wire-up depends on.

### 3. Tokenization gap

`FfiStreamingRunner.generateWithUsage` takes `promptTokens: Int32Array`, not
a `prompt: string`. `GenerateArgs.prompt` is a string. The new
`FfiStreamingBackend` needs a `tokenize(prompt: string) => Int32Array`
function for the loaded GGUF.

Today the tokenizer is reachable via the `llmTokenize` symbol on the same
FFI binding — but it requires a `LlmModelHandle`, which is itself owned by
the voice service. Same ownership question as #2.

A runtime assertion is required: the tokenizer's vocab size must match the
loaded model. Mismatches produce gibberish silently.

### 4. No slot save/restore parity at the engine seam

`dflash-server.ts:3814, 3839` expose `persistConversationKv` /
`restoreConversationKv`. The FFI runner exposes `saveSlot`/`restoreSlot` but
only when the `llmStreamSaveSlot` symbol is exported by the loaded
`libelizainference`. The conversation registry will lose context across app
backgrounds when the FFI path is active and the symbol is missing.

This needs a capability probe before flipping the default.

## The conservative wire-up path

Steps in dependency order. Each step is independently mergeable and reversible.

### Step A — design doc + scaffolding (this commit)

- Land this doc.
- Add `FfiStreamingBackend implements LocalInferenceBackend` in
  `services/ffi-streaming-backend.ts`. The class takes an opaque
  `FfiBackendRuntime` constructor arg with `acquire` / `release` / `supported`
  / `tokenize`. **Not constructed in production yet.**
- Add optional `ffiStreaming` + `probeFfiActive` params to
  `BackendDispatcher`. When both are supplied, the dispatcher consults the
  probe inside the `"llama-server"` branch and routes accordingly. When
  omitted, behavior is identical to before.
- Add unit tests covering both routes (probe true → FFI, probe false →
  subprocess, switching unloads correctly).
- Default behavior in production: **unchanged**. Nothing constructs the
  FFI backend yet.

### Step B — build the `FfiBackendRuntime` provider

The hardest step. Needs:
- A decision on FFI context ownership (#2 above).
- A tokenizer wired through `llmTokenize` (#3).
- A capability probe for slot persistence (#4).

This is real architectural work. ~1–2 days of careful integration. Best done
as its own focused PR.

### Step C — guard the direct `dflashLlamaServer.*` engine calls

In `engine.ts`, replace the existing
`if (dflashLlamaServer.hasLoadedModel())` guards with explicit checks against
`this.dispatcher.activeBackendId() === "llama-server"` AND
`dflashLlamaServer.hasLoadedModel()`. When the dispatcher says the
llama-server slot is active but the subprocess isn't loaded, throw a clear
error pointing at `ELIZA_INFERENCE_BACKEND=http`.

Call sites to update (file:line, from the Plan agent's audit):
`engine.ts:654, 655, 951, 953, 1017, 1018, 1031, 1064, 1216, 1222, 1223, 1268, 1304, 1372, 1387, 1441, 2515, 2534`.

### Step D — wire `engine.ts` to construct the FFI backend

Once B and C are done:

```ts
private readonly ffiBackend = new FfiStreamingBackend(buildFfiBackendRuntime());
private readonly dispatcher = new BackendDispatcher(
  this.nodeBackend,
  dflashLlamaServer,
  () => getDflashRuntimeStatus().enabled,
  () => dflashRequired(),
  () => getDflashRuntimeStatus().capabilities?.kernels ?? null,
  this.ffiBackend,                                  // new
  () => {                                            // new — strict opt-in
    const override = readBackendEnvOverride();
    if (override !== "ffi") return false;
    return llmStreamSupported(loadedFfiHandleOrNull());
  },
);
```

The probe is intentionally restrictive: only `ELIZA_INFERENCE_BACKEND=ffi`
activates the FFI path. `auto` (the default) stays on the subprocess until
the soak period passes.

### Step E — flip the default

Once the FFI path has soaked under opt-in (`ELIZA_INFERENCE_BACKEND=ffi`)
for a meaningful period with no regressions, relax the probe to also activate
on `auto` when the platform is desktop and `llmStreamSupported()` is true.
This is what `backend-selector.ts` already returns; the runtime change is
trivial once steps A-D are validated.

### Step F — retire `dflash-server.ts`

The 3800-line subprocess+HTTP path can be deleted ONLY when:
- Step E has held for at least a couple of weeks in production without
  regressions
- All direct `dflashLlamaServer.*` call sites in `engine.ts` are gone (step C)
- Slot/vision/embed parity is verified

This is the final step and the riskiest. Not in scope for any near-term work.

## Risk register

| Risk | Mitigation |
|---|---|
| Silent vision/slot failures when FFI active | Step C guards + actionable errors |
| Tokenizer mismatch produces gibberish | Runtime vocab-size assertion in `FfiStreamingBackend.load()` |
| Concurrent dispatcher and direct-singleton paths racing | Step C eliminates direct path |
| Default flip exposed before parity | Step E only flips after explicit soak; steps A-D do not change defaults |

## File ownership for follow-up

- `services/ffi-streaming-backend.ts` — new, scaffolding only.
- `services/backend.ts` — opt-in dispatcher params added; semantics
  unchanged when omitted.
- `services/backend.test.ts` — new tests for both routes.
- `services/engine.ts` — UNCHANGED in step A. Steps B/C/D will modify.
- `services/dflash-server.ts` — UNCHANGED. Retired in step F only.

## References

- `backend-selector.ts:82` — `selectBackend()`.
- `ffi-streaming-runner.ts:77-112` — runner shape.
- `ffi-streaming-runner.ts:35-65` — `FfiStreamingGenerateArgs` /
  `FfiStreamingGenerateResult`.
- `backend.ts:165-175` — `LocalInferenceBackend` interface.
- `backend.ts:398-519` — `BackendDispatcher`.
- `dflash-server.ts:4328` — `dflashLlamaServer` singleton.
