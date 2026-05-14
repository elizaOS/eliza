# OpenVINO Runtime Target

The `linux-x64-openvino` llama.cpp build target enables upstream
`ggml-openvino` for Intel CPU/GPU/NPU hosts. It is a runtime-device path, not
an Eliza-1 W4-B kernel implementation.

## Scope

- Use OpenVINO for static-graph voice ASR on Intel NPU/GPU, and as an opt-in
  CPU fallback.
- Keep autoregressive chat defaults on the existing Vulkan/CUDA/Metal/CPU
  paths. Lunar Lake measurements from issue #7633 show NPU decode is slower
  than CPU for Llama token generation, while Whisper-style ASR is the NPU win.
- Do not mark OpenVINO as satisfying `dflash`, `turbo3`, `turbo4`,
  `turbo3_tcq`, `qjl_full`, or `polarquant`. Those are custom Eliza-1 kernels
  and are still gated by `CAPABILITIES.json`.

## Build

```sh
source /opt/intel/openvino_2026/setupvars.sh
node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-openvino
```

The target writes `openvino` metadata into `CAPABILITIES.json`, including the
runtime selector env var:

```sh
GGML_OPENVINO_DEVICE=CPU
GGML_OPENVINO_DEVICE=GPU
GGML_OPENVINO_DEVICE=NPU
```

The OpenVINO target is intentionally `publishable: false` for Eliza-1 default
chat bundles until the custom W4-B/DFlash kernels have an OpenVINO backend.

## Linux Prerequisites

- OpenVINO Runtime: `OpenVINO_DIR` or `INTEL_OPENVINO_DIR` must be set, usually
  by `setupvars.sh`.
- NPU: `/dev/accel/accel*` must exist and be readable.
- GPU: `/dev/dri/renderD*` plus the full Intel Compute Runtime stack:
  `intel-opencl-icd`, `libigc2`, and `libigdfcl2`.

The hardware probe surfaces these as `hardware.openvino`. The recommender uses
that metadata as an availability hint for voice ASR routing; it does not use an
NPU as the default LLM chat backend.
