# In-process FFI streaming LLM

Eliza's local-inference subsystem runs token generation through one of two
backends. On desktop / GPU hosts the historical path spawns an
out-of-process `llama-server` child process and talks to it over HTTP. On
mobile (iOS and Android) that path is unavailable — `child_process.spawn`
cannot ship inside an App Store / Play Store sandbox, and a per-token HTTP
round-trip would be unacceptable on a battery-constrained device. The
mobile path uses the in-process **FFI streaming runner** instead: a
`bun:ffi` binding against a shared `libelizainference` library that runs
the prefill + decode loop in the app's own address space.

Both backends produce the same `InferenceStreamEvent` shape via
`dispatchGenerate()` (`packages/app-core/src/services/local-inference/runtime-dispatcher.ts`),
so callers above the dispatcher don't change with the backend choice.

## Platform → backend

| Platform                | Runtime mode    | Backend         | Source of truth                                                     |
| ----------------------- | --------------- | --------------- | ------------------------------------------------------------------- |
| macOS (Intel / Apple)   | `spawn`         | `http-server`   | `dflash-server.ts` (out-of-process `llama-server`)                  |
| Linux (CPU / CUDA / ROCm) | `spawn`       | `http-server`   | `dflash-server.ts`                                                  |
| Windows                 | `spawn`         | `http-server`   | `dflash-server.ts`                                                  |
| iOS                     | `ffi`           | `ffi-streaming` | `ffi-streaming-runner.ts` + `voice/ffi-bindings.ts`                 |
| Android                 | `ffi`           | `ffi-streaming` | `ffi-streaming-runner.ts` + `voice/ffi-bindings.ts`                 |
| Capacitor native shell (any OS) | `ffi`   | `ffi-streaming` | Detected via `globalThis.Capacitor.isNativePlatform()`              |
| Future opt-out builds   | `native-bridge` | (Capacitor plugin) | Reserved — selected only via `MILADY_INFERENCE_MODE=native-bridge` |

The detection rule lives in `runtime-target.ts`; the backend resolution
on top of it lives in `backend-selector.ts`. Both are pure functions —
callers pass platform / env / Capacitor signals explicitly so the
decision can be replayed in tests.

### Environment overrides

| Env var                    | Values                                  | Effect                                          |
| -------------------------- | --------------------------------------- | ----------------------------------------------- |
| `MILADY_INFERENCE_MODE`    | `spawn` / `ffi` / `native-bridge`       | Wins over platform / Capacitor heuristics      |
| `ELIZA_INFERENCE_MODE`     | same                                    | Legacy alias; deferred to `MILADY_INFERENCE_MODE` |
| `ELIZA_INFERENCE_BACKEND`  | `auto` / `ffi` / `http` / `server`      | Forces the backend within the chosen mode      |

A mobile build that asks for `ELIZA_INFERENCE_BACKEND=http` is a hard
error — the spawn path cannot run there, and we surface the bad config
loudly rather than silently fall back.

## Where artifacts land at install time

The CI workflows build per-target shared libraries and upload them as
`actions/upload-artifact@v4` artifacts. The desktop / mobile installer
downloads the matching artifact and lands it in a known location the
loader consults.

| Target               | Workflow file                                     | Artifact name                              | Installed path                                                                 |
| -------------------- | ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `darwin-arm64-metal` | `.github/workflows/build-llama-ffi-macos.yml`     | `libelizainference-darwin-arm64-metal`     | `~/.milady/native/darwin-arm64-metal/libelizainference.dylib`                  |
| `linux-x64-cpu`      | `.github/workflows/build-llama-ffi-linux.yml`     | `libelizainference-linux-x64-cpu`          | `~/.milady/native/linux-x64-cpu/libelizainference.so`                          |
| `linux-x64-cuda`     | `.github/workflows/build-llama-ffi-linux.yml`     | `libelizainference-linux-x64-cuda`         | `~/.milady/native/linux-x64-cuda/libelizainference.so`                         |
| `ios-arm64`          | `.github/workflows/build-llama-ffi-ios.yml`       | `libelizainference-ios-arm64`              | App bundle: `<App>.app/Frameworks/llama.xcframework`                          |
| `android-arm64-v8a`  | `.github/workflows/build-llama-ffi-android.yml`   | `libelizainference-android-arm64-v8a`      | APK: `lib/arm64-v8a/libelizainference.so`                                      |
| `android-armeabi-v7a`| `.github/workflows/build-llama-ffi-android.yml`   | `libelizainference-android-armeabi-v7a`    | APK: `lib/armeabi-v7a/libelizainference.so`                                    |
| `android-x86_64`     | `.github/workflows/build-llama-ffi-android.yml`   | `libelizainference-android-x86_64`         | APK: `lib/x86_64/libelizainference.so`                                         |

`MILADY_STATE_DIR` overrides the `~/.milady` root. The mobile artifacts
do not move at install time — they're packaged inside the app bundle / APK
by the per-platform build of the Electrobun shell.

### Provenance

Every staged artifact ships a `BUILD_INFO.txt` next to the binary
containing the target tuple, the runner ID, the git ref + sha, and the
llama.cpp submodule sha. The doctor command surfaces this so a user
running an unexpected build can be diagnosed without running the binary.

## Status of the workflows

The four `build-llama-ffi-*` workflow files exist as **scaffolds** — they
carry an explicit `if: false` guard on the job that produces the
artifact. The guard exists because:

1. The artifact path on disk (`libllama.so` vs `bin/libllama.so`) varies
   with the cmake generator and has not been validated end-to-end in CI.
2. The mobile XCFramework consumption path through the Electrobun iOS
   shell has not been smoke-tested with a runner-built artifact.
3. The Android per-ABI install path inside the APK is wired by the
   Capacitor / Electrobun packaging step, which has its own workflow.

Once a workflow is verified end-to-end, drop the `if: false` and trigger
via `workflow_dispatch` or a `llama-ffi-*` tag push.

## Debugging missing artifacts

When the FFI runner is selected but cannot load the library, the error
surfaces as a structured `VoiceLifecycleError` with code `missing-ffi`
(see `voice/ffi-bindings.ts` → `loadElizaInferenceFfi`). The doctor pass
in `dflash-doctor.ts` checks for it on startup.

### "missing-ffi" / dlopen failed

Cause: the build did not ship a `libelizainference` for the running
platform tuple, or the file is at a different path than the loader
checks. Fix path:

1. Confirm `inferenceRuntimeMode()` is returning `"ffi"` (or
   `"native-bridge"`). On a Mac CLI tester this typically requires
   `MILADY_INFERENCE_MODE=ffi` since `process.platform === "darwin"`
   defaults to spawn.
2. Check `~/.milady/native/<target>/libelizainference.{dylib,so}` exists
   (desktop) or the artifact is present inside the app bundle (mobile).
   The `target` tuple is reported in the error message and matches the
   table above.
3. If absent, download the matching artifact from the workflow run that
   produced it. Workflows live in `.github/workflows/build-llama-ffi-*`.
4. If the file is present but dlopen fails, inspect the runtime linker
   logs: `DYLD_PRINT_LIBRARIES=1` (macOS) / `LD_DEBUG=libs` (Linux). The
   most common cause is a missing transitive dependency (Metal +
   IOSurface on macOS, OpenMP on Linux CPU builds).

### "missing streaming-LLM symbols"

Cause: the library was built before the `ffi-streaming-llm.h` symbols
landed, or against an older ABI version. The JS-side
`ELIZA_INFERENCE_ABI_VERSION` constant in `voice/ffi-bindings.ts` must
match `eliza_inference_abi_version()` at runtime; a mismatch is a hard
error.

Fix: rebuild the library against `HEAD` of the omnivoice-fuse repo.
Locally:

```bash
node packages/inference/build-omnivoice.mjs           # for the desktop dylib path
# OR — for llama.cpp-only FFI surface (no fused omnivoice symbols)
cmake -S packages/inference/llama.cpp -B packages/inference/llama.cpp/build \
      -DBUILD_SHARED_LIBS=ON -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=OFF
cmake --build packages/inference/llama.cpp/build --target llama -j 4
```

CI rebuilds happen through the four `build-llama-ffi-*` workflows once
their `if: false` guards are flipped off.

### "platform forced to spawn but llama-server is missing"

Cause: a desktop install where the spawn path is selected (the default
on macOS / Linux / Windows) but the bundled `llama-server` binary did
not ship. Fix: flip `MILADY_INFERENCE_MODE=ffi` to use the in-process
path, or download the matching `llama-server` from the catalog manifest.

## FFI streaming LLM ABI

The TypeScript-side ABI surface lives in
`packages/app-core/src/services/local-inference/ffi-llm-streaming-abi.ts`.
It mirrors the C header at
`packages/inference/llama.cpp/omnivoice/src/ffi-streaming.h` — the
function names are identical so `bun:ffi` can resolve them by symbol name
without aliasing.

### Core types

```ts
export interface FfiLlmHandle { readonly _brand: "FfiLlmHandle" }

export type TokenCallback = (
  tokenId: number,
  tokenText: string,
  isDone: boolean,
) => void;
```

`FfiLlmHandle` is an opaque branded value; concrete implementations alias
it to `bigint` (a C pointer). `TokenCallback` fires once per decoded token
from the generation background thread; the final invocation has
`isDone = true`.

### Single-model streaming ABI (`FfiLlmStreamingAbi`)

```ts
export interface FfiLlmStreamingAbi {
  eliza_inference_llm_stream_open(
    modelPath: string,
    contextSizeTokens: number,
    numThreads: number,
    gpuLayers: number,
  ): FfiLlmHandle | null;

  eliza_inference_llm_stream_prefill(
    handle: FfiLlmHandle,
    promptTokens: Int32Array,
    slotId: number,
  ): number;

  eliza_inference_llm_stream_generate(
    handle: FfiLlmHandle,
    maxNewTokens: number,
    temperature: number,
    topP: number,
    tokenCallback: TokenCallback,
  ): number | Promise<number>;

  eliza_inference_llm_stream_cancel(handle: FfiLlmHandle): void;
  eliza_inference_llm_stream_close(handle: FfiLlmHandle): void;
}
```

| Method | Description |
|---|---|
| `open` | Memory-map the model and allocate a KV context. Returns `null` on OOM, missing file, or GPU unavailability. |
| `prefill` | Blocking KV-cache fill with the supplied pre-tokenized prompt. Returns token count or -1 on error. |
| `generate` | Schedule background decode; fires `tokenCallback` per token. Returns (or resolves to) 0 on success, -1 on error. |
| `cancel` | Signal the decode loop to stop at the next safe boundary. Non-blocking; a final `isDone=true` callback fires shortly after. |
| `close` | Release all session resources and evict KV slots. Must be called after `isDone=true` (or after `cancel` settles). |

### DFlash speculative-decoding ABI (`FfiDflashStreamingAbi`) — Phase 2

```ts
export interface FfiDflashStreamingAbi {
  eliza_inference_dflash_stream_open(
    drafterModelPath: string,
    verifierModelPath: string,
    contextSizeTokens: number,
    numThreads: number,
    gpuLayers: number,
    speculativeWindowSize: number,
  ): FfiLlmHandle | null;

  eliza_inference_dflash_stream_prefill(handle, promptTokens, slotId): number;
  eliza_inference_dflash_stream_generate(handle, maxNewTokens, temperature, topP, tokenCallback): number | Promise<number>;
  eliza_inference_dflash_stream_cancel(handle): void;
  eliza_inference_dflash_stream_close(handle): void;
}
```

The DFlash ABI holds two model contexts internally (drafter + verifier).
`open` takes both GGUF paths and a `speculativeWindowSize` (4 is a safe
default for mobile). The `tokenCallback` fires once per *verifier-accepted*
token — rejected drafter proposals are discarded at the C layer, so the
JS consumer always sees the same token sequence as a greedy single-model
decode would produce.

### Mobile capability snapshot

```ts
export type MobileInferenceCapabilities = {
  streamingLlm: boolean;       // FFI streaming LLM path available
  dflashSupported: boolean;    // Drafter FFI available (phase 2)
  omnivoiceStreaming: boolean; // OmniVoice TTS FFI path available
  maxContextTokens: number;    // Device-reported context limit
  recommendedGpuLayers: number; // 0 = CPU only
};

export function detectMobileCapabilities(
  ffi: FfiLlmStreamingAbi | null,
): MobileInferenceCapabilities
```

`detectMobileCapabilities(null)` returns an all-false/zero snapshot used
by the cloud-only path so the UI can render without branching on "was an
FFI loaded". When `ffi` is non-null the function probes `llmStreamSupported`
and `ttsStreamSupported` duck-typed methods on the binding.

Note: `dflashSupported` is always `false` from this function at Phase 1.
The drafter bundle probe is the platform bootstrap's responsibility; callers
that have completed it should OR their result in after receiving the snapshot.

### iOS XCFramework gap

The ABI is defined and the C header is frozen. The iOS XCFramework that
re-exports these symbols through a Swift bridge has **not shipped** yet.
`loadIosStreamingLlmBinding()` in `ios-llama-streaming.ts` returns `null`
until the XCFramework build lands.

Current status: **header frozen, not yet linked**.

The Swift glue (separate deliverable) needs to:
1. Re-export the streaming-LLM symbols under `LlamaCpp.Streaming.*`.
2. Expose an Objective-C-bridgeable `LlamaStreamingSession` wrapper class
   for Capacitor plugin registration.
3. Wire `ProcessInfo.thermalState` into a thermal-throttle hook so
   speculative decoding can be disabled under sustained heat.

Until then, iOS falls back to the cloud route.

### Mobile DFlash phasing

**Phase 1** — target model only. Use `FfiLlmStreamingAbi`. No drafter
weights required. The device capability snapshot has `dflashSupported=false`.
`detectMobileCapabilities(ffi)` is sufficient to gate on-device inference.

**Phase 2** — speculative decoding. Enabled when
`MobileInferenceCapabilities.dflashSupported === true`. Swap to
`FfiDflashStreamingAbi` which opens a paired drafter + verifier session.
Both ABIs share the `FfiLlmHandle` brand so `runtime-dispatcher.ts` is
unaffected by the swap.

### How to test

Run the ABI + mock unit tests with:

```bash
bun test packages/app-core/src/services/local-inference/__tests__/ffi-streaming-runner.test.ts
```

The test file covers:

- `detectMobileCapabilities(null)` → all-false snapshot
- `detectMobileCapabilities(mockFfi)` → `streamingLlm=true`
- generate → cancel stops the synthetic stream early
- close after generate cleans up mock state (no double-free simulation needed)
- DFlash ABI shape — instantiate mock, verify interface contract at the
  TypeScript type level

All tests use `makeFfiLlmMock()` from `ffi-llm-mock.ts`. No native library
is loaded and no GGUF is read.

## Related code

- `runtime-target.ts` — platform → mode decision (`inferenceRuntimeMode()`)
- `backend-selector.ts` — mode + capability → backend (`selectBackend()`)
- `runtime-dispatcher.ts` — unified async-iterable surface (`dispatchGenerate()`)
- `ffi-streaming-runner.ts` — FFI streaming runner (`FfiStreamingRunner`)
- `ffi-llm-streaming-abi.ts` — TypeScript ABI surface + `detectMobileCapabilities()`
- `ffi-llm-mock.ts` — mock implementation for tests
- `voice/ffi-bindings.ts` — `bun:ffi` loader + typed handle
- `dflash-server.ts` — out-of-process HTTP backend
- `dflash-event-schema.ts` — native DFlash event wire format (owned separately)
- `packages/inference/llama.cpp/build-xcframework.sh` — iOS / macOS framework build
