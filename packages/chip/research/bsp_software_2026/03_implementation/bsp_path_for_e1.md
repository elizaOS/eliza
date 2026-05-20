# BSP Path for Eliza E1

Date: 2026-05-19. Ranked recommendations for the Linux + Android + firmware
stack on the Eliza E1 chip. Each recommendation maps to scaffolds and
gates already in tree. This file is planning evidence; it does not promote
any gate or claim past its current state.

## Confidence rubric

- **High**: upstream supports it, the scaffold already exists, and the
  only missing piece is local execution evidence captured through a
  named script.
- **Medium**: upstream supports it, but the local scaffold needs new
  files or a non-trivial configuration. Identifiable risk.
- **Low**: depends on a hardware decision still in `selected_not_generated`
  status, an upstream feature still in flight, or both.

## Anchors

- `docs/arch/android-contract.md`
- `docs/arch/boot.md`, `docs/arch/boot-rom-spec.md`
- `docs/arch/linux-capable-cpu-contract.md`
- `docs/sw/opensbi/`, `docs/sw/u-boot/`, `docs/sw/linux/`,
  `docs/sw/buildroot/`, `docs/sw/aosp-device/`
- `docs/project/aosp-simulator-completion-gate.yaml`
- `docs/project/minimum-linux-npu-target.md`
- `sw/platform/e1_platform_contract.json` plus
  `sw/platform/generated/{e1_platform.vh,e1-platform.dtsi,e1_platform.h,e1_platform_hal.json}`

---

## High-confidence path

### H-1. Wire OpenSBI + U-Boot + Linux on qemu-virt first, with real captures

- Use the `qemu-virt` software reference target named in
  `docs/arch/android-contract.md` and `docs/arch/boot.md`.
- Build OpenSBI 1.6 generic platform in `FW_DYNAMIC` mode pointing at
  U-Boot RV64 proper. Build a Buildroot rv64gc image (Buildroot
  `qemu_riscv64_virt_defconfig` is the seed).
- Drive captures through the existing scaffolds:
  - `docs/sw/opensbi/capture-opensbi-evidence.sh`
  - `docs/sw/u-boot/capture-u-boot-evidence.sh`
  - `scripts/check_e1_npu_linux_smoke.py` (for the minimum-Linux + NPU
    integrated claim)
- Output expectations:
  - OpenSBI banner with `SPEC_VERSION = 2.0` and `Platform Name`.
  - U-Boot banner with `arch riscv` and `EFI loader` active.
  - Linux kernel booted via `earlycon=sbi`, login prompt on the SBI
    debug console.

### H-2. Adopt the `aosp_cf_riscv64_phone` template for `eliza_ai_soc`

- Copy the shape of `device/google/cuttlefish/vsoc_riscv64` into
  `docs/sw/aosp-device/device/eliza/eliza_ai_soc/`:
  - `manifest.xml`, `compatibility_matrix.current.xml`
  - `BoardConfig.mk`, `device.mk`, `AndroidProducts.mk`
  - `sepolicy/` skeleton with vendor SELinux types
  - `init.eliza_ai_soc.rc` with the Eliza E1 device nodes
- Swap virtio devices for the Eliza E1 contract devices from
  `sw/platform/generated/e1_platform_hal.json`.
- Generate device-target evidence required by
  `aosp-simulator-completion-gate.yaml`:
  - `eliza_ai_soc_lunch.log`
  - `eliza_ai_soc_vendorimage.log`
  - `eliza_ai_soc_checkvintf.log`
  - `eliza_ai_soc_sepolicy_build.log`
  - `eliza_ai_soc_selinux_neverallow.log`
- Until all of those exist, `make aosp-bsp-check` correctly fails closed.

### H-3. Anchor the NPU HAL story on libe1_npu + LiteRT delegate

- Designate `libe1_npu` (userspace, in `compiler/runtime/` or a new
  `sw/npu/userspace/`) as the canonical Eliza NPU driver. Build the
  LiteRT delegate (`libe1_litert_delegate.so`) and the ExecuTorch
  backend (`libe1_executorch_backend.a`) on top of it.
- Land an AOSP vendor HAL service `vendor.eliza.hardware.npu` *only*
  when a system service other than the inference runtime needs the NPU.
- Treat `android.hardware.neuralnetworks` (NNAPI) as legacy
  compatibility only; include it in the VINTF matrix only if CTS-NN
  coverage is required for the Cuttlefish RV64 image.
- The kernel driver should target `drivers/accel/` (DRM accel uAPI) +
  DMA-BUF for buffer sharing.

### H-4. Use DT, not ACPI

- The Eliza E1 boot path is DT-only. Treat the generated
  `sw/platform/generated/e1-platform.dtsi` as the only contract source
  for kernel + OpenSBI + U-Boot. Do not write any handwritten DTS that
  references contract device compatibles at non-generated base
  addresses (already enforced by `make platform-contract-check`).
- For the Linux-capable AP variant, the generated DTS must additionally
  declare CPU nodes, memory, CLINT/ACLINT, PLIC (or AIA/IMSIC), Sstc,
  Sscofpmf, Zicbom/Zicboz block sizes, NPU node, simple-framebuffer
  node, UART console. The audit already exists:
  `python3 scripts/capture_cpu_ap_evidence.py dts-audit --run-dtc`.

### H-5. Targeted SBI feature floor: v2.0 + Sscofpmf + DBCN + Sstc

- The Eliza E1 SBI dependency floor is: base, TIME, IPI, RFENCE, HSM,
  SRST, DBCN, PMU (Sscofpmf), Sstc consumed at S-mode via the CSR
  (not as an SBI service).
- v3.0 draft extensions (FWFT, SSE, MPXY, NACL) are optional and tied
  to specific features (e.g. NACL only if KVM-RV with H lands in E1).
- Capture this in `docs/sw/opensbi/README.md` so the OpenSBI build
  config is reproducible.

---

## Medium-confidence path

### M-1. Pull Buildroot config for the Eliza E1 minimum Linux image

- Start from `qemu_riscv64_virt_defconfig`, add the Eliza E1 NPU
  userspace driver, the LiteRT delegate, and the integrated GEMM
  test binary required by `mvp_npu_ml_smoke.log`.
- Land the config under `docs/sw/buildroot/` and a build script that
  produces a reproducible image. Wire the image into the
  `check_e1_npu_linux_smoke.py` flow.
- Risk: Buildroot RV64 GCC + libe1_npu cross-build interactions
  (Bionic vs glibc differences if anything ends up shared with the
  AOSP path).

### M-2. AICore integration plan (track-only)

- AICore is GMS-bound and Google-owned. For AOSP-only Eliza builds we
  cannot ship AICore itself; we can ship the LiteRT delegate it would
  load. Plan an AICore compatibility test once Google publishes a
  vendor-facing SDK for AICore in Android 16 or 17.
- Risk: AICore vendor delegate API is not fully public end of 2025.

### M-3. KVM-RV / Hypervisor extension decision

- ElizaRocketConfig today does not include the H extension. If Eliza
  E1 is expected to run Android Virtualization Framework (AVF) or
  protected Compute (pKVM-RV when ported) workloads, H must enter the
  AP design.
- Defer the H decision until the CPU subsystem 2028 spec-db lands
  (`docs/spec-db/cpu-2028-target.yaml`).

### M-4. Treble / VNDK shape

- AOSP main has collapsed VNDK; vendor partition links against
  vendor variants of system libs. The `eliza_ai_soc` target should
  declare `BOARD_API_LEVEL := 36` (Android 16) so the build picks
  the correct vendor variant set.
- Risk: vendor.img layout for RV64 has fewer pre-built reference
  packages than ARM; some `frameworks/av` libs need explicit build
  flags for RV64 (notably codec2 and Tuner HAL stubs).

### M-5. Wi-Fi / BT module selection

- Pick a single PCIe/SDIO module with mainline kernel driver, mainline
  hostapd/wpa_supplicant support, and a working Android HAL. Concrete
  candidates: ath11k (Qualcomm WCN6750), mt7921 (MediaTek), rtw89
  (Realtek 8852). The Wi-Fi / BT contract in `docs/arch/wifi.md` is
  upstream of this decision; align there first.

---

## Low-confidence / decision-required

### L-1. GPU strategy

- E1 has no GPU IP today. Mainline `simpledrm` carries Android
  SurfaceFlinger and basic GLES via swiftshader, but UI performance
  will be the limiting factor for any retail Android claim. A future
  GPU IP decision (Mali Bifrost with panfrost, Vivante GC with
  etnaviv, or PowerVR with closed userspace) is a multi-quarter
  research item.

### L-2. ACPI on RV

- ACPI for RV is in flight at UEFI / RISC-V International but not
  merged. Do not bet on it. If a server-class Eliza variant is added
  later, revisit; for the mobile/edge AP target DT is correct.

### L-3. Verified boot key infrastructure

- AVB 2.0 requires a fused root-of-trust key. The Eliza E1
  `boot-rom-spec.md` lists policy fuses abstractly. Concrete fuse
  bank counts, OTP layout, and key rotation policy are out of scope
  for 2026 and tied to the security gate in
  `docs/arch/security.md`.

### L-4. Cellular modem path

- The cellular peripheral in `aosp-simulator-completion-gate.yaml`
  is currently satisfiable by the Cuttlefish modem simulator. Real
  cellular requires either a vendor modem IP (out of scope for an
  open RV chip) or an external modem with libqmi/libmbim adapters.
  Treat as compat-stub-first.

---

## Required scaffold edits (do not perform here; record only)

The following edits would unblock the H-1 / H-2 paths. They are listed
for sequencing only; this packet does not perform them.

- Populate `docs/sw/opensbi/README.md` with the FW_DYNAMIC build recipe,
  target SBI extension list, and the exact OpenSBI release line pin.
- Populate `docs/sw/u-boot/README.md` with the RV64 + EFI_LOADER + AVB
  config and the qemu-virt boot recipe.
- Populate `docs/sw/buildroot/README.md` with the
  `qemu_riscv64_virt_defconfig` plus Eliza overlay path and an output
  artifact path used by `check_e1_npu_linux_smoke.py`.
- Populate `docs/sw/linux/README.md` with the kernel version line and
  config delta required for Eliza E1 (Sscofpmf, Sstc, accel driver,
  simpledrm).
- Add `docs/sw/aosp-device/device/eliza/eliza_ai_soc/` skeleton
  (manifest, matrix, BoardConfig, init, sepolicy) modeled on
  `device/google/cuttlefish/vsoc_riscv64`.

Each of these is an open item against `make aosp-bsp-check` and the
gate-listed evidence files in
`docs/project/aosp-simulator-completion-gate.yaml`. None of these are
satisfied by this research packet; the packet only justifies the
direction.

---

## What this packet does NOT claim

- It does not claim Eliza E1 boots Linux. Boot ROM is still a contract
  ROM per `docs/arch/boot.md`.
- It does not claim Eliza E1 boots Android. The AOSP gate is
  explicitly `blocked_until_evidence`.
- It does not claim the NPU HAL exists. It selects the HAL shape that
  the NPU runtime (`compiler/runtime/e1_npu_runtime.py`) should grow
  into.
- It does not claim Cuttlefish RV64 is exercising Eliza E1 IP. The
  Cuttlefish path is the software reference path; native RTL-level
  execution remains gated on the CPU/AP work in
  `docs/project/cpu-ap-blocker-status-2026-05-17.md`.
