# libomnivoice prebuilt binaries

End users of `@elizaos/plugin-omnivoice` load the native `libomnivoice`
shared library through `bun:ffi`. Building it locally requires cmake +
a working CPU/Metal/CUDA toolchain and a clone of the upstream
`omnivoice.cpp` repo (which is **not** vendored into this monorepo —
`packages/inference/omnivoice.cpp` is gitignored at the parent level).

To avoid forcing every user through that, CI builds `libomnivoice` on
release cuts and uploads it as a GitHub Actions artifact you can drop
into place.

## Where the artifacts come from

Workflow: [`.github/workflows/build-omnivoice.yml`](../../.github/workflows/build-omnivoice.yml)

Triggers:

- `workflow_dispatch` — manually fire from the Actions UI; pass
  `run_cuda=true` if a self-hosted `gpu,cuda` runner is online.
- `push` of any tag matching `omnivoice-*` (e.g. `omnivoice-2026-05-12`)
  — this is the canonical release path.

The matrix builds the following targets:

| target              | runner       | backend | library name           |
| ------------------- | ------------ | ------- | ---------------------- |
| `darwin-arm64-metal`| `macos-14`   | metal   | `libomnivoice.dylib`   |
| `linux-x64-cpu`     | `ubuntu-22.04` | cpu   | `libomnivoice.so`      |
| `linux-x64-cuda`    | self-hosted `gpu,cuda` | cuda | `libomnivoice.so` |

CUDA is intentionally excluded from the default matrix: GitHub-hosted
Linux runners don't ship `nvcc`, and pulling the full toolchain on every
build is expensive. The CUDA leg is `continue-on-error: true` so the
workflow stays green if the self-hosted runner is offline.

## Downloading an artifact

1. Open the [Build libomnivoice workflow runs](https://github.com/elizaOS/eliza/actions/workflows/build-omnivoice.yml).
2. Pick the most recent green run on the tag you care about.
3. Scroll to **Artifacts** and download the one matching your platform,
   e.g. `libomnivoice-darwin-arm64-metal.zip`.
4. The zip contains:
   - `libomnivoice.{dylib,so}` — the shared library.
   - `BUILD_INFO.txt` — ref/sha/target provenance.

Headless / scripted download via `gh`:

```bash
gh run download --repo elizaOS/eliza \
  --name libomnivoice-darwin-arm64-metal \
  --dir /tmp/libomnivoice
```

## Installing locally

The plugin looks for the library inside the omnivoice.cpp build dir.
The cleanest way to install a prebuilt is to seed that path so a
subsequent `node packages/inference/build-omnivoice.mjs` becomes a
no-op:

```bash
# macOS arm64
mkdir -p packages/inference/omnivoice.cpp/build
cp /tmp/libomnivoice/libomnivoice.dylib \
   packages/inference/omnivoice.cpp/build/libomnivoice.dylib

# Linux x64
mkdir -p packages/inference/omnivoice.cpp/build
cp /tmp/libomnivoice/libomnivoice.so \
   packages/inference/omnivoice.cpp/build/libomnivoice.so
```

If you want to override the location, set `OMNIVOICE_BUILD_DIR` to point
at a directory containing the library — the same env var the local
build script honors.

## Building locally (fallback)

If a prebuilt isn't available for your platform, run:

```bash
node packages/inference/build-omnivoice.mjs
```

This invokes the same code path CI uses. It requires `cmake`,
`ninja-build` (or make), a C++ toolchain, and on Linux a clone of
`omnivoice.cpp` at `packages/inference/omnivoice.cpp` (the script
fails fast if the directory is missing). Use `--dry-run` to inspect
the cmake invocation without compiling, `--clean` to nuke `build/`.

Env knobs: `OMNIVOICE_BACKEND` (`auto|metal|cuda|vulkan|cpu`),
`OMNIVOICE_BUILD_DIR`, `OMNIVOICE_JOBS`.

## License caveats

`libomnivoice` is built from the upstream
[`omnivoice.cpp`](https://github.com/elizaOS/omnivoice.cpp) source
(MIT) which itself vendors `ggml` (MIT) and is derived from
`llama.cpp` (MIT). The CI artifacts inherit those terms. Redistributing
the prebuilt binary alongside Eliza is fine; redistributing it as a
standalone product still requires preserving the upstream MIT notices
shipped in each repo's `LICENSE` file.
