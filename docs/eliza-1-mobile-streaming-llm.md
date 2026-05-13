# Eliza-1 — Mobile streaming LLM (FFI-only)

Status: contract landed (this doc); Android JNI wiring + iOS Swift glue
gated on the fused `libelizainference.{so,dylib}` rebuild.

## Why we are dropping the spawned `llama-server` on mobile

The previous DFlash adapter on Android spawned a cross-compiled
`llama-server` binary as a child process and routed inference over
`http://127.0.0.1:<port>`. That cannot ship as the production mobile
path:

- **Sandbox**: stock AOSP forbids forking arbitrary executables out of
  the APK private dir on most OEM builds; the SELinux policy refuses
  the `execve` outright on Samsung / Pixel / OnePlus + the major
  Chinese OEMs (>80% of phones).
- **App Store**: iOS App Review (5.2.1) rejects apps that spawn
  sub-processes. The pattern is unshippable on iOS regardless of
  whether the binary loads.
- **Latency**: every token costs an HTTP round-trip over the loopback
  socket; on a phone CPU we measured ~10–30 ms per token of overhead
  before the kernel even starts decoding. Speculative decoding
  (DFlash) is supposed to *save* latency; spending it on HTTP defeats
  the point.
- **Slot persistence**: cross-launch KV cache reuse needs slot save /
  restore. The `llama-server` `/slots/save` and `/slots/restore`
  endpoints write to an absolute path that we cannot make portable
  inside the APK / IPA sandbox without an extra Unix-socket hop.

The replacement is an in-process FFI streaming path. Same speculative
loop, no HTTP, no fork, sandbox-clean, codesign-clean.

## New surface

### C ABI

`packages/app-core/scripts/omnivoice-fuse/ffi-streaming-llm.h` declares
seven additive symbols:

```
eliza_inference_llm_stream_supported()             -> int
eliza_inference_llm_stream_open(ctx, cfg, err)     -> session*
eliza_inference_llm_stream_prefill(sess, toks, n, err) -> int
eliza_inference_llm_stream_generate(sess, max, cb, ud, err) -> int
eliza_inference_llm_stream_cancel(sess)            -> int
eliza_inference_llm_stream_save_slot(sess, file, err) -> int
eliza_inference_llm_stream_restore_slot(sess, file, err) -> int
eliza_inference_llm_stream_close(sess)             -> void
```

Callback shape:

```c
typedef int (*eliza_llm_token_callback)(
    int32_t token_id,
    const char * token_text,
    void * user_data);
```

The callback returns non-zero to request cancellation. Mirrors how
streaming TTS already works (`eliza_tts_chunk_cb` in `ffi.h`).

The richer accept/reject decomposition continues to flow through
`eliza_inference_set_verifier_callback` from ABI v2 (`ffi.h`), so the
JS scheduler's existing rollback queue plumbing is unchanged.

### CMake integration

Append to the fused `libelizainference` SHARED target in
`cmake-graft.mjs`:

```cmake
target_sources(elizainference PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/omnivoice/src/streaming_llm.cpp)
target_include_directories(elizainference PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/omnivoice/include)
```

`streaming_llm.cpp` lives next to omnivoice's streaming TTS impl. It
links against `common/speculative.cpp` for the in-process drafter
loop. Symbols are exported with `__attribute__((visibility("default")))`
under `ELIZA_INFERENCE_BUILD`, matching the rest of the surface.

## Per-platform adapter

### Android — `bun:ffi`

`plugins/plugin-aosp-local-inference/src/aosp-llama-streaming.ts`
wraps the C ABI. The AOSP agent process already dlopens the per-ABI
`libelizainference.so` from `agent/{abi}/` via the existing
`aosp-llama-adapter.ts` flow. The streaming binding is built on top of
that same handle — no new dlopen, no new `.so` to ship.

Threading: prefill + generate block the JS thread (the runtime is
single-threaded). Cancel is fired from the AbortSignal listener and
publishes a flag the native side polls between decode steps.

### iOS — Capacitor Swift bridge

`packages/app-core/src/services/local-inference/ios-llama-streaming.ts`
wraps a Capacitor plugin (`LlamaStreaming`) that the Swift bridge in
`LlamaCpp.xcframework` exposes. Until the Swift glue ships (gating
item — see [eliza-1-ios-streaming-status.md](./eliza-1-ios-streaming-status.md))
the loader returns null and the runtime falls back to cloud.

The async Capacitor bridge is adapted to the synchronous-ish JS
contract via an internal queue keyed by stream handle: native fires
`addListener("llmStreamStep", cb)` for each step; `llmStreamNext`
blocks on a `Promise<step>`.

### Why not bun:ffi on iOS?

The dynamic linker on a codesigned iOS device build refuses to load
arbitrary `.dylib` from the app bundle at `dlopen` time. The Swift
bridge wraps the symbols at compile time inside the XCFramework so
the codesignature covers them.

## DFlash mobile rollout phasing

DFlash speculative decoding needs both a target model *and* a drafter
model resident in RAM. On a phone that adds ~600 MB (drafter weights
+ KV cache + per-step buffers). We're rolling it in phases:

**Phase 1 (this PR)** — streaming FFI lands without DFlash. Mobile
runtime emits a single `accept` event per committed token (no drafter,
no rejects). `dflashSupported === false` everywhere except desktop.
Speculative pretends it's running with `draft_min = draft_max = 0`.

**Phase 2** — drafter weights ship in the per-tier mobile bundle and
get mapped into the same FFI context. The runtime emits real
`accept` + `reject` events through the existing verifier callback.

**Phase 3** — thermal-throttle hooks: when
`ProcessInfo.thermalState >= serious` (iOS) or
`PowerManager.getCurrentThermalStatus >= THROTTLING` (Android), the
runtime drops back to Phase 1 behaviour mid-session so the OS doesn't
start clock-gating us. Wired into `inference-capabilities.ts` via the
`thermalState` probe.

## Per-tier memory budget

Hard caps for the local-only mobile chat model. Anything > 2 B is
cloud-routed unless the user explicitly downloads a larger model and
accepts the latency / battery trade-off.

| Tier        | Phone class         | Max local target | Max local drafter |
|-------------|---------------------|------------------|-------------------|
| `low`       | 4 GB RAM phones     | 0.6 B q4         | none              |
| `mid`       | 6–8 GB RAM phones   | 1.7 B q4         | 0.6 B q4 (Phase 2)|
| `high`      | 12+ GB RAM phones   | 2.0 B q4         | 0.6 B q4 (Phase 2)|

The tier is detected at boot from `os.totalmem()` on Android and
`ProcessInfo.physicalMemory` on iOS. Catalog entries (in
`shared/src/local-inference/catalog.ts`) carry per-tier path keys
matching these caps.

## Thermal + battery hooks

The capability probe surfaces a `thermalState: "nominal" | "fair" |
"serious" | "critical"`. Source per platform:

- **iOS**: `ProcessInfo.thermalState` via the Capacitor bridge.
- **Android**: `PowerManager.getCurrentThermalStatus()` over the
  existing capacitor-mobile-signals plugin.

Battery: the runtime refuses to start a new streaming session when
the device is under 20 % AND not charging. Caller-side check, not in
the FFI.

## Capability bits the runtime reads

`packages/app-core/src/services/local-inference/inference-capabilities.ts`:

```
streamingLlm        — eliza_inference_llm_stream_supported() == 1
dflashSupported     — streamingLlm && drafter resident && thermal <= fair
omnivoiceStreaming  — eliza_inference_tts_stream_supported() == 1
mmprojSupported     — mmproj weights resident in bundle
thermalState        — last snapshot, used for DFlash gating
platform            — android / ios / desktop / unknown
```

Read at boot and on resume. UI surfaces (model picker, voice toggle)
hide options the loaded build cannot honour.

## What this replaces

- `aosp-dflash-adapter.ts` no longer spawns `llama-server`. The
  `legacyServerSpawn` flag is retained as an explicit failure path —
  setting it raises a loud error pointing at this doc.
- `dflash-server.ts` continues to exist for the desktop HTTP path
  (Electrobun build). The mobile loaders never reach it.

## See also

- `packages/app-core/scripts/omnivoice-fuse/ffi-streaming-llm.h` — the C ABI.
- `packages/app-core/src/services/local-inference/ffi-streaming-runner.ts` —
  the in-process runner that consumes the C ABI through the JS bindings.
- `plugins/plugin-aosp-local-inference/src/aosp-llama-streaming.ts` —
  Android binding wrapper.
- `packages/app-core/src/services/local-inference/ios-llama-streaming.ts` —
  iOS binding wrapper (stub-loaded; gated on Swift bridge).
- `docs/eliza-1-ios-streaming-status.md` — current iOS shim vs real
  bridge status.
- `docs/eliza-1-dflash-native-events.md` — verifier callback wire
  format (unchanged).
