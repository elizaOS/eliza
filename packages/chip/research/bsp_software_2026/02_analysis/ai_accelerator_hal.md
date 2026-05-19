# AI Accelerator HAL Path for Eliza E1

Date: 2026-05-19. The Android on-device AI surface is mid-migration from
NNAPI to AICore + LiteRT + ExecuTorch. This file selects the HAL story the
Eliza E1 NPU should follow, anchored to `docs/arch/npu.md` and the
gate-listed NPU evidence in
`docs/project/aosp-simulator-completion-gate.yaml`.

## Surface state, end of 2025

| Surface | Owner | State end 2025 | Eliza E1 relevance |
| --- | --- | --- | --- |
| NNAPI (`android.hardware.neuralnetworks`) | AOSP | Deprecated in Android 15; "legacy, no further enhancements" in NDK docs | Skip for new HAL design; keep as CTS-only path |
| LiteRT (formerly TF Lite) | Google AI Edge | Active rebrand 2024-09; same .tflite, same delegate API | Primary userland inference path |
| ExecuTorch | PyTorch / Meta | 0.4 stable Nov 2024; vendor delegate API standardized | Primary path for PT2-trained models |
| AICore | Google / Android | First-class system service in Android 16 | Vendor accelerator integration point |
| MediaPipe Tasks | Google AI Edge | Built on LiteRT; LLM Inference API | App-facing API, no HAL impact |

## What "AICore" is

- AICore (`com.google.android.aicore`) is a Google system service shipped
  on Android 16+ devices. It hosts on-device foundation models (e.g.
  Gemini Nano), exposes ML APIs to apps via the AICore SDK, and lets
  vendor accelerators participate via a delegate plugin that AICore loads
  into the inference runtime (LiteRT under the hood).
- AICore is GMS-bound in current shipping devices; for AOSP-only Eliza
  E1 the path is: provide a LiteRT delegate registered through the
  standard `TfLiteDelegate` C API, plus an AIDL HAL surface that exposes
  the accelerator to system services other than AICore (camera
  framework's HDR / Night Sight equivalents, etc.).

## What ExecuTorch is

- ExecuTorch (`torch.executorch`) converts PyTorch 2 exported programs
  into `.pte` files that run in a small C++ runtime. Vendor accelerators
  plug in via the `Backend` registration API. ExecuTorch ships reference
  delegates for XNNPACK (CPU), Qualcomm (QNN), MediaTek, Apple Core ML,
  ARM Ethos-U, Vulkan, and a `custom` path for arbitrary accelerators.
- ExecuTorch is the natural target for Eliza models exported from PyTorch
  via `torch.export`. The Eliza compiler in
  `packages/chip/compiler/` and the runtime in
  `compiler/runtime/e1_npu_runtime.py` are the right place to host an
  ExecuTorch backend that emits NPU programs.

## LiteRT delegate vs AIDL HAL vs custom userspace driver

There are three integration surfaces; Eliza E1 needs all three but
should anchor on one canonical NPU userspace driver and adapt outward.

```
+--------------------------------------------------------------+
|  Apps (Android) / Eliza inference services (Linux)           |
+--------------------------------------------------------------+
|  LiteRT runtime  |  ExecuTorch runtime  |  Direct E1 NPU SDK |
+--------------------------------------------------------------+
|        LiteRT TfLiteDelegate  |  ET Backend  |  libe1_npu    |
+--------------------------------------------------------------+
|             libe1_npu  (vendor userspace driver, .so)        |
+--------------------------------------------------------------+
|             AIDL NPU HAL (vendor service) -- optional        |
+--------------------------------------------------------------+
|             /dev/e1_npu char/DRM accel driver (kernel)       |
+--------------------------------------------------------------+
|                E1 NPU IP (per docs/arch/npu.md)              |
+--------------------------------------------------------------+
```

- **libe1_npu**: the single vendor userspace driver. Owns DMA-BUF imports,
  command-stream submission to the kernel, fence/sync, and the program
  loader that consumes the artifact produced by
  `compiler/runtime/e1_npu_runtime.py`. This is the source of truth.
- **LiteRT delegate (libe1_litert_delegate.so)**: thin shim that
  implements `TfLiteDelegate` and lowers operators by calling into
  libe1_npu. Loaded by LiteRT in-process (no Binder).
- **ExecuTorch backend (libe1_executorch_backend.a)**: thin shim that
  implements `BackendInterface` and calls libe1_npu. Linked into the
  ExecuTorch runtime.
- **AIDL NPU HAL** (`vendor.eliza.hardware.npu`): exposed only when
  AOSP system services (camera HAL, audio HAL, AICore) need to share
  the accelerator across processes. Wraps libe1_npu with Binder. This
  is *not* `android.hardware.neuralnetworks`; that AIDL is the
  legacy NNAPI surface and should be registered with a thin
  compatibility delegate only if CTS-NN is required.

## Kernel driver path

- The Eliza NPU should land in `drivers/accel/` (or `drivers/gpu/drm/`
  if it grows DRM/KMS-style buffer management) and present a DRM accel
  uAPI. The mainline `accel` subsystem (Habana Gaudi, Intel VPU, AMD
  XDNA, Rockchip RKNPU) is the established home for AI accelerators that
  do not produce framebuffers.
- DMA-BUF is the right buffer interop. Eliza userspace allocates from a
  vendor DMA heap (see `dma_heap_aidl` source entry) and shares with
  GPU / Camera / Display when needed.
- IOCTLs: submit-command-buffer, wait-fence, query-capability. Keep the
  uAPI small and stable; let libe1_npu hide vendor evolution.

## SELinux + init.rc

- The NPU device node (`/dev/accel/e1_npu0` or similar) needs SELinux
  labels: `u:object_r:e1_npu_device:s0`. The vendor HAL service binary
  gets its own domain. The init.rc snippet loads firmware (if any),
  brings the device online, and starts the AIDL HAL service.
- These belong under `docs/sw/aosp-device/device/eliza/eliza_ai_soc/
  sepolicy/` and `init.eliza_ai_soc.rc` once the device target is wired.

## NNAPI compatibility (only if CTS-NN is required)

- Cuttlefish RV64 currently includes the NNAPI HAL stub; CTS-NN tests
  exercise it. If `aosp_cf_riscv64_phone` CTS coverage must include
  CtsNNAPITestCases, Eliza E1 needs a minimal NNAPI HAL that delegates
  to the same libe1_npu. The HAL maps NNAPI ops onto LiteRT ops
  (most are 1:1) and reuses the LiteRT delegate path internally.
- Otherwise NNAPI can be omitted from `manifest.xml` and `checkvintf`
  will accept the absence as long as the matrix does not require it.

## Mapping to `docs/arch/npu.md` and the gate

- `docs/arch/npu.md` defines the NPU as a command/status/result-register
  block; today the gate-listed evidence is `gemm_s8_int8_2x2x3` running
  via `compiler/runtime/e1_npu_runtime.py` and the scale model
  `mvp_npu_scale_sim.json`. The HAL story above is upstream of both:
  libe1_npu wraps the runtime's program loader, the LiteRT delegate
  wraps libe1_npu, the AIDL HAL wraps libe1_npu.
- The `integrated_linux_npu_ml_claim` gate marker maps to: Linux
  userspace loads libe1_npu via /dev/accel, runs an int8 GEMM through
  it, and reports PASS. The AOSP path adds the LiteRT delegate path on
  Cuttlefish RV64.

## Recommendations for Eliza E1

1. Make `libe1_npu` (userspace) and the kernel `drivers/accel/e1_npu`
   driver the canonical interface boundary. All higher-level surfaces
   (LiteRT delegate, ExecuTorch backend, AIDL HAL, optional NNAPI HAL)
   are thin shims over it.
2. Target LiteRT delegate + ExecuTorch backend as the primary apps. Do
   not invest in NNAPI HAL beyond a compatibility shim. Track AICore
   integration as a 2027+ item once AICore SDK stabilizes for vendors.
3. Define `vendor.eliza.hardware.npu` AIDL HAL only when a second
   system process needs the NPU (e.g. camera HAL HDR). Avoid premature
   AIDL design.
4. Land the kernel driver in `drivers/accel/` with a DRM accel uAPI.
   Reuse DMA-BUF heaps for tensor sharing with display, GPU, camera.
5. Add a CTS-NN compatibility decision to
   `docs/project/aosp-simulator-completion-gate.yaml` so the
   `make vendorimage` / `checkvintf` work knows whether to include
   `android.hardware.neuralnetworks` in the VINTF matrix.
