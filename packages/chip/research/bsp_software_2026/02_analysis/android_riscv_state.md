# Android on RISC-V State, 2024 - early 2026

Date: 2026-05-19. Status of the AOSP RV64 port as it bears on Eliza E1's
`docs/arch/android-contract.md`, `docs/sw/aosp-device`, and the
`docs/project/aosp-simulator-completion-gate.yaml` evidence list. Upstream
status only; E1 boot logs still need real captures into the gate.

## Timeline and governance

- **2021 - 2023**: initial Google work in `android14-*` branches added an
  early RV64 ART backend and Bionic RV64 port. In Oct 2023 Google removed
  RV64 from the public Android 14 release branch, citing "the porting is not
  ready for production"; merges paused on user-facing branches.
- **Aug 2023**: RISE Project (Linux Foundation) launched, naming AOSP main
  RV64 as a P0 deliverable. Members include Google, Qualcomm, MediaTek,
  Intel, Ventana, T-Head/Alibaba, NVIDIA, Imagination, Andes, Red Hat,
  Samsung, SiFive.
- **2024 - 2025**: riscv-android-sig (RISC-V International SIG) plus RISE
  members converged on AOSP main, not a release branch. Patches keep
  landing in `frameworks/`, `art/`, `bionic/`, `prebuilts/`,
  `device/google/cuttlefish/`.
- **2025 H2 - 2026 H1**: AOSP main `aosp_cf_riscv64_phone` Cuttlefish lunch
  combo regrew into the canonical RV64 reference device. CTS-on-CF passes
  most non-graphics test packages; VTS-on-CF passes for AIDL HALs that
  vendor implementations register.
- Google has not committed RV64 to any released Android dessert as a
  user-facing ABI through Android 16; the public position is "RV64 is
  developer-supported on AOSP main, productization timing TBD".

## Compiler / runtime / libc

- **NDK r28** (Q1 2026): RV64 target available behind a flag, with rv64gc
  baseline and rv64gcv (V) variant. min API level 36 (Android 16) when
  RV64 is selected. Clang/LLVM 19 toolchain.
- **Bionic libc**: `bionic/libc/arch-riscv64/` complete; rv64 setjmp,
  vfork, signal trampolines, syscall stubs, optimized memcpy/memset/strcmp
  including rv64gcv variants gated by hwcap2.
- **ART**: `art/compiler/optimizing/code_generator_riscv64.cc` and
  `art/runtime/arch/riscv64/` deliver an optimizing-compiler backend used
  by both dex2oat (AOT) and the JIT. Interpreter path: Nterp RV64 in
  `art/runtime/interpreter/mterp/riscv64/`. AOT image generation for
  system_server is functional; perf is below ARM64 today but closing.
- **HotSpot**: not used by Android. OpenJDK RV64 HotSpot is separately
  upstream and feeds RISE host-side tooling.
- **libcore + frameworks**: build clean for RV64 in AOSP main; ICU, OkHttp,
  Conscrypt, BoringSSL all have RV64 paths.
- **Renderscript**: removed long before RV64 port; not a gate.

## Cuttlefish RV64 (`aosp_cf_riscv64_phone`)

- Lunch combo defined in `device/google/cuttlefish/vsoc_riscv64/`.
- Backed by crosvm; host requires KVM-RV with H-extension on real silicon,
  or nested KVM-on-KVM when running on x86 (slow). Common practice:
  RV64 host (e.g. VisionFive 2, SG2042, TH1520) running crosvm.
- Guest kernel: built from `kernel/common` android-mainline RV64 config.
- Boot path: U-Boot in crosvm -> Generic Kernel Image (GKI) -> Android
  ramdisk -> init -> zygote -> system_server.
- Virtio devices: virtio-mmio + virtio-pci for block, net, gpu, snd,
  console, rng, vsock. virtio-gpu provides KMS surface; SurfaceFlinger uses
  drm_hwcomposer + Mesa virgl for OpenGL ES; Vulkan via venus on capable
  hosts.

## CTS / VTS coverage on RV64

- **CTS-on-CF**: bulk of non-graphics CTS tests pass on RV64 Cuttlefish in
  riscv-android-sig CI. Known-gaps live in CtsRenderscriptTestCases
  (removed), CtsNNAPITestCases (NNAPI legacy), and a small set of CPU
  feature tests gated on V.
- **VTS-on-CF**: AIDL HAL VTS passes for the HALs Cuttlefish provides
  (audio, camera, neural, sensors). VINTF compatibility matrix at
  `device/google/cuttlefish/shared/config/manifest.xml` is the template the
  Eliza E1 `eliza_ai_soc` device target must follow.
- **GTS** (Google Test Suite, GMS-bound): not applicable to AOSP-only
  devices; not a gate for Eliza E1.

## AIDL HAL story for vendor surfaces

Android 13+ requires AIDL `@VintfStability` HALs for new device targets.
Relevant HALs that the Eliza E1 BSP must register against the VINTF
compatibility matrix:

| HAL | Package | Status on RV64 main |
| --- | --- | --- |
| Power | `android.hardware.power` v4 | works on CF; needs Eliza Power HAL |
| Thermal | `android.hardware.thermal` v2 | works on CF; needs Eliza HAL |
| Wi-Fi | `android.hardware.wifi` | wpa_supplicant rv64 builds |
| Bluetooth | `android.hardware.bluetooth` | hci_attach socket |
| Audio | `android.hardware.audio.core` v2 | tinyalsa rv64 ok |
| Camera | `android.hardware.camera.provider` v3 | needs sensor + ISP |
| GNSS | `android.hardware.gnss` v3 | rv64 ok |
| Sensors | `android.hardware.sensors` v2 | iio bridge |
| Neural | legacy + AICore delegate | see `ai_accelerator_hal.md` |
| DRM (media) | `android.hardware.drm` v1 | Widevine rv64 not shipping |

The Cuttlefish manifest at
`device/google/cuttlefish/shared/config/manifest.xml` and matrix at
`compatibility_matrix.current.xml` is the working template; Eliza E1's
`docs/sw/aosp-device/device/eliza/eliza_ai_soc/` must mirror that shape
to pass `checkvintf` and the gate-listed
`eliza_ai_soc_checkvintf.log`.

## SELinux / init / boot evidence

- Cuttlefish RV64 init scripts live under
  `device/google/cuttlefish/shared/config/init.vendor.rc`. Eliza E1 must
  ship its own `init.eliza_ai_soc.rc` describing UART console, NPU driver
  bring-up, firmware load, and modem stubs.
- SELinux: vendor policy under `sepolicy/`. The neverallow rules are
  fixed by the AOSP base policy; the Eliza vendor policy must compile and
  pass `selinux_neverallow.log` (gate-listed) and `make vendorimage`.
- Treble VNDK: AOSP 14+ collapsed VNDK; vendor partition links against
  the `vendor` variant of system libs.

## What this means for Eliza E1

1. The upstream Android RV64 stack is real, but RV64 Android product
   readiness is "AOSP main on Cuttlefish RV64" not "shippable consumer
   build". The gate at
   `docs/project/aosp-simulator-completion-gate.yaml` correctly targets
   Cuttlefish RV64 evidence + `eliza_ai_soc` lunch + `make vendorimage`
   not a CTS-passing retail Android.
2. The reference device `aosp_cf_riscv64_phone` is the working template
   for `docs/sw/aosp-device/device/eliza/eliza_ai_soc/`. Lift the
   manifest / matrix / SELinux / init shape, swap virtio devices for
   the Eliza E1 contract devices generated from
   `sw/platform/e1_platform_contract.json`.
3. AICore + LiteRT, not NNAPI, is the right target for the NPU HAL.
   See `ai_accelerator_hal.md`.
4. Camera, Wi-Fi, BT, Cellular HALs gate-listed in
   `aosp-simulator-completion-gate.yaml` should be wired as virtio +
   stub HALs first (matching Cuttlefish), then specialized once Eliza
   silicon contracts solidify.
