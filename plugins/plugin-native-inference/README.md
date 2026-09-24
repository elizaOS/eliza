# @elizaos/plugin-native-inference

Native inference and mobile bridges for elizaOS, with explicit entrypoints for
each runtime.

| Import | Purpose |
| --- | --- |
| `@elizaos/plugin-native-inference` | AOSP fused `libelizainference.so` bootstrap through lazy `bun:ffi` |
| `@elizaos/plugin-native-inference/host-bridge` | Agent-side device bridge service and lazy mobile CLI helpers |
| `@elizaos/plugin-native-inference/llama` | Capacitor llama adapter, device relay, and token-tree codec |
| `@elizaos/plugin-native-inference/mlkit-text` | Android ML Kit OCR, registered as `Tesseract` |

The host bridge also exposes `/android/bridge`, `/android/dispatch`,
`/ios/bridge`, `/mobile-device-bridge-bootstrap`, `/shared/fs-shim`, and
`/shared/stdio-bridge`. Browser code imports the llama or OCR entrypoint so
Node and Bun host code stays outside the renderer.

AOSP uses one fused native text/voice runtime, activated by `ELIZA_LOCAL_LLAMA=1`
(or automatically on riscv64); `ELIZA_DISABLE_FFI_LLAMA=1` disables it.
Stock Android uses the authenticated device WebSocket bridge; iOS uses native
Bun host IPC. Chat and BGE embedding contexts remain separately owned.

The Capacitor-discovered `android/` library contains ML Kit OCR. The
`android-bridge/` directory retains the separately integrated computer-use
native fragment. No model binaries are committed here.

```bash
bun run --cwd plugins/plugin-native-inference build
bun run --cwd plugins/plugin-native-inference typecheck
bun run --cwd plugins/plugin-native-inference lint:check
bun run --cwd plugins/plugin-native-inference test
```

See [the package guide](AGENTS.md) for activation, ownership, and verification.
