# Native inference engine and kernels

Native inference kernels, model converters, and backend verification tools.

Preserve packed tensor layouts and the public ABI. Compare kernels with scalar references and exercise the built runtime graph on the claimed physical backend before declaring it supported.

This directory is part of `plugins/plugin-local-inference`.

The plugin's `build` command bundles TypeScript; it does not compile the native
engine. Root `bun install` initializes the pinned llama.cpp submodule and invokes
the fused-engine installer. Use the staging script directly to build an isolated
artifact without replacing the library used by a running profile:

```bash
bun packages/app/scripts/stage-desktop-fused-lib.mjs \
  --variant auto --out ./test-results/native-build/lib --jobs 4
bun packages/app/scripts/stage-desktop-fused-lib.mjs \
  --variant auto --out ./test-results/native-build/lib --check
```

The host needs CMake, a C++ toolchain and eSpeak NG development files. On macOS,
the Metal build also needs Xcode's Metal compiler. Check `xcrun --find metal`;
if only Command Line Tools are selected, an installed full Xcode can be selected
for the build process with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. This does not change
the system-wide developer directory.

`--check` validates the staged artifact's source fingerprint and library hashes;
it is not an inference test. To exercise embeddings, use
`packages/app/scripts/verify-fused-embedding.mjs` with the pinned BGE model path
and `ELIZA_INFERENCE_LIBRARY` pointing to the newly staged library. Set
`LOCAL_EMBEDDING_GPU_LAYERS=0` for explicit CPU validation or a positive value
for an explicit accelerator check; automatic fallback is not accelerator proof.

Run the plugin tests from the repository root:

```bash
bun run --cwd plugins/plugin-local-inference test
```
