# @elizaos/plugin-aosp-local-inference

AOSP-only llama.cpp FFI bindings (via `bun:ffi`) and the local-inference
bootstrap that registers `TEXT_SMALL`, `TEXT_LARGE`, and `TEXT_EMBEDDING`
model handlers on the AOSP mobile agent.

Both exports self-gate on `ELIZA_LOCAL_LLAMA=1` and are no-ops on every
other platform/runtime, so they are safe to import unconditionally from
the mobile agent's static plugin barrel.

## Public surface

- `registerAospLlamaLoader()` — registers the bun:ffi-backed llama loader
  with `@elizaos/agent` when running on AOSP.
- `ensureAospLocalInferenceHandlers()` — registers the text / embedding
  model handlers against the AOSP loader. Tracking for the missing
  `TEXT_TO_SPEECH` handler is in [docs/kokoro-tpu-nnapi-delegate.md](./docs/kokoro-tpu-nnapi-delegate.md)
  (elizaOS/eliza#7666).
- `probeNnapiAvailability()` — readiness probe for ORT NNAPI execution
  provider availability. See the [NNAPI delegate readiness](#nnapi-delegate-readiness-elizaoseliza7667)
  section below.
- `assessKokoroDelegateReadiness()` — pure classifier that decides whether
  the Android Kokoro TTS accelerator path is `blocked`, `ready-for-prototype`,
  or `ready-for-hardware-validation`. Side-effect free.

## NNAPI delegate readiness (elizaOS/eliza#7667)

The Tensor TPU / NNAPI delegate work for Kokoro TTS on Android is **blocked**
on #7666 and is scoped as polish, not critical path. This package only ships
the readiness scaffold today:

- `probeNnapiAvailability()` returns `{ available: false, reason: "not implemented", androidApiLevel: null }`.
  The contract is documented in [`src/nnapi-availability.ts`](./src/nnapi-availability.ts);
  callers should fall through to the CPU execution provider when
  `available` is `false`.
- The Kokoro execution-provider knob lives in
  [`@elizaos/shared/local-inference`](../../packages/shared/src/local-inference/kokoro-execution-provider.ts)
  as `KokoroExecutionProvider` and defaults to `"cpu"` so behaviour is
  unchanged until the future wiring PR lands.
- Full plan, gates, and deferred-wiring TODOs:
  [`docs/rfc/7667-npu-kokoro-android.md`](../../docs/rfc/7667-npu-kokoro-android.md).

### ONNX Runtime build flags for the NNAPI EP

The default `onnxruntime-react-native` and `onnxruntime-node` packages on
npm are built **without** the NNAPI execution provider. The CPU EP and
XNNPACK EP are available out of the box; NNAPI / CoreML require a custom
ORT build.

To enable the NNAPI EP for an AOSP build of `onnxruntime-react-native`,
the ORT source build must be invoked with `--use_nnapi` (the upstream flag
from `microsoft/onnxruntime` `build.sh`):

```bash
./build.sh \
  --android \
  --android_sdk_path "$ANDROID_SDK_ROOT" \
  --android_ndk_path "$ANDROID_NDK_HOME" \
  --android_abi arm64-v8a \
  --android_api 27 \
  --build_shared_lib \
  --config Release \
  --use_nnapi
```

Equivalent custom-build flags for the other supported providers:

| Provider | Build flag                | Notes                                                                   |
| -------- | ------------------------- | ----------------------------------------------------------------------- |
| `cpu`    | (built by default)        | Baseline; current production path.                                      |
| `xnnpack`| `--use_xnnpack`           | Also built into the default `onnxruntime-react-native`.                 |
| `nnapi`  | `--use_nnapi`             | Requires Android API 27+. Custom build only.                            |
| `coreml` | `--use_coreml` (iOS only) | Not exercised by this package; listed for the cross-platform knob only. |

Until a custom ORT artifact is wired through `bun run aosp` and #7666 has
landed a CPU Kokoro baseline on the device, **do not** flip the
`kokoroExecutionProvider` knob away from `"cpu"`. The probe and the
classifier are the gate: `probeNnapiAvailability()` must report
`available: true` before any caller passes `"nnapi"` to
`buildKokoroOrtSessionOptions()`.

## Layout

```
plugins/plugin-aosp-local-inference/
  src/
    index.ts                              Barrel
    aosp-llama-adapter.ts                 bun:ffi loader registration
    aosp-llama-streaming.ts               Streaming bridge
    aosp-llama-vision.ts                  Vision adapter
    aosp-dflash-adapter.ts                DFlash drafter wiring
    aosp-local-inference-bootstrap.ts     Model-handler registrar
    kokoro-tts-delegate-readiness.ts      Pure classifier (#7667 gate)
    nnapi-availability.ts                 NNAPI EP probe scaffold (#7667)
  docs/
    kokoro-tpu-nnapi-delegate.md          #7666/#7667 snapshot & plan
  __tests__/                              vitest suites
```
