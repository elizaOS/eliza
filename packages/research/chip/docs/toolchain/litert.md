# LiteRT (Google AI Edge) — `benchmark_model` toolchain

LiteRT is the renamed successor to TFLite, hosted at
[`google-ai-edge/LiteRT`](https://github.com/google-ai-edge/LiteRT). It is the
source for the on-device `benchmark_model` binary we use to measure model
runtime on the e1 NPU bring-up host and on RISC-V test rigs.

## Current pin

- Tag: `v2.1.5` (published 2026-05-18).
- Pin manifest: [`external/litert/pin-manifest.json`](../../external/litert/pin-manifest.json).
- Previous: TFLite `v25.9.23` (`tools/bin/benchmark_model`, x86-64 ELF, build
  identifier `579ca6ba6489c51352805b5affdbed3a0f469772`).

## What ships in the v2.1.5 release

The `v2.1.5` release ships exactly one asset:
[`litert_cc_sdk.zip`](https://github.com/google-ai-edge/LiteRT/releases/download/v2.1.5/litert_cc_sdk.zip)
(sha256 `7c056c5d701c1e2e1ed6579d7b5c322957421526ac8e9df4cf7feb46faf0dc72`,
~260 KB, 128 files). It is a **header-only C++ SDK** plus a thin CMake harness
that builds two demo executables (`run_model_simple`, `dump_model_simple`)
against a `libLiteRt.so` that the SDK does **not** ship. There is no prebuilt
`benchmark_model` for linux-x64 (or any other platform) in the release.

The SDK is mirrored at:

```
external/litert/v2.1.5/
  litert_cc_sdk.zip          # original asset, sha256-pinned in pin-manifest.json
  litert_cc_sdk/             # extracted headers + CMake scaffolding
    CMakeLists.txt
    CMakePresets.json
    litert/cc/, litert/c/    # C++ + C public headers
    litert/tools/run_model_simple.cc
    litert/tools/dump_model_simple.cc
```

## v2.1.5 wins worth flagging

From the [upstream release notes](https://github.com/google-ai-edge/LiteRT/releases/tag/v2.1.5):

- C++ APIs are now header-only.
- Python 3.14 PyPI wheels.
- LiteRT environment / option APIs callable directly from Python.
- `libLiteRt.so` dependency removed from GPU accelerator and Dispatch API
  shared libraries (they no longer require `libLiteRt.so`).
- LiteRT `Options` class becomes a pure data object (no C-API roundtrip).
- Raspberry Pi 5 GPU acceleration support added.
- GPU prebuilts fixed for iOS devices.

For the chip package the relevant wins are the decoupled GPU/Dispatch shared
libraries and the simplified Options surface — both feed into the bring-up
plan for `tools/bin/benchmark_model` on the e1 NPU evaluation host. The
RV64 / RISC-V GPU delegate path is **not yet upstream** in v2.1.5; it is
tracked separately under the
[`elizanpu` IREE backend](iree-eliza-npu.md) plus
[`executorch-riscv.md`](executorch-riscv.md).

## Source-build recipe (blocked-on-bazel)

LiteRT does not publish a prebuilt `benchmark_model` for linux-x64 in
`v2.1.5`. To rebuild it locally, the canonical path is the upstream Bazel
build inside the LiteRT source tree:

```sh
# 1. Clone the tagged source tree (NOT the SDK zip — the zip is headers-only).
git clone --depth 1 --branch v2.1.5 \
  https://github.com/google-ai-edge/LiteRT.git external/litert/v2.1.5/src

cd external/litert/v2.1.5/src

# 2. Install bazel (LiteRT v2.1.5 pins bazel 6.5.0 in .bazelversion).
#    Use bazelisk or download from https://github.com/bazelbuild/bazel/releases/tag/6.5.0
#    On the chip dev host we keep bazelisk at external/bazelisk/bazel.

# 3. Pull the LiteRT-internal dependency tree (clang, protobuf, abseil,
#    flatbuffers, ruy, gemmlowp, XNNPACK, kissfft, eigen, fp16, neon2sse,
#    farmhash, opencl-headers, ml_dtypes, pybind11, ...). This is a multi-GB
#    download on first invocation.
bazel fetch //litert/tools/benchmark:benchmark_model

# 4. Build linux-x64 (optimized).
bazel build -c opt \
  --config=linux_x86_64 \
  //litert/tools/benchmark:benchmark_model

# 5. Result lands under bazel-bin/, copy into tools/bin.
install -m 0755 \
  bazel-bin/litert/tools/benchmark/benchmark_model \
  $REPO/tools/bin/benchmark_model
```

Cross-build for RV64 follows the same pattern but with
`--config=linux_riscv64` and a RISC-V sysroot (LiteRT v2.1.5 does not ship a
turn-key `--config=linux_riscv64` preset; the e1 cross-host plan is tracked
in [`riscv64-cross-host.md`](riscv64-cross-host.md)). Treat the RV64
benchmark_model as **BLOCKED** until the cross-sysroot is in place.

### Why we are not building from source today

- Pulling the LiteRT bazel dep tree against bazel 6.5.0 is a one-shot
  multi-gigabyte download that competes with the IREE and LLVM bazel/cmake
  trees already pinned for the chip package.
- The chip package today is a Linux-x86-64 host plus a RISC-V cross target;
  the GPU delegate wins in v2.1.5 (Raspberry Pi 5, iOS) do not apply.
- The existing TFLite `25.9.23` binary at `tools/bin/benchmark_model`
  produces the same flag surface and is sufficient for the current bring-up
  smoke gates. It stays first on PATH via `tools/env.sh`.

When the v2.1.5 binary becomes load-bearing (specifically: a new op in our
e1 NPU partitioner whitelist, or a RISC-V GPU delegate that lands in a
future LiteRT release), execute the bazel recipe above and update both
[`tools/bin/benchmark_model`](../../tools/bin) and
[`external/litert/pin-manifest.json`](../../external/litert/pin-manifest.json).

## Smoke

```sh
. tools/env.sh
benchmark_model --help | head -5
```

Until the bazel build runs, the smoke resolves to the TFLite `25.9.23`
fallback at `tools/bin/benchmark_model`. The pin manifest records the
LiteRT v2.1.5 SDK as `blocked_on_build` so the audit trail is durable.

## Evidence

- Release manifest:
  `gh release view --repo google-ai-edge/LiteRT v2.1.5 --json assets`
  returns one asset: `litert_cc_sdk.zip`.
- Confirmed absence of `benchmark_model` in the asset:
  `unzip -l external/litert/v2.1.5/litert_cc_sdk.zip | grep -i benchmark`
  returns no matches.
- CMake scaffold in the SDK builds only `run_model_simple` and
  `dump_model_simple` (and imports a `libLiteRt.so` the zip does not
  contain). The bazel tree is the only supported path to a `benchmark_model`
  binary at v2.1.5.
