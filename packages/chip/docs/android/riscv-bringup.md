# Android RISC-V Bring-Up

The Android path is split into a simulator track and a physical-board track.
The simulator track proves that the software stack and device contracts are
coherent. The physical-board track proves that real drivers, clocks, memory,
display, and power behavior can survive Android workloads.

## Baseline Targets

| Target | Purpose | Status expectation |
|---|---|---|
| AOSP riscv64 / Cuttlefish | Fastest Android userspace and framework path | Use for simulator/home-screen work and app/runtime validation; not a proof of e1_soc hardware ABI. |
| QEMU virt | Kernel, init, shell, block, network, and device-contract smoke | Good for software plumbing; not hardware ABI proof. |
| Renode | Peripheral and firmware model smoke | Useful for deterministic device-model tests. |
| TH1520 board | Physical RISC-V Android baseline | Best purchasable Android/RISC-V reference, but not fully open SoC silicon. |
| e1_soc RTL | Open hardware contract proof | Tiny target; Linux/Android performance claims are non-v0. |

Current local evidence: Android has not been verified booting in this repo.
Treat the commands below as the required bring-up recipe and evidence checklist
until a checked-in transcript proves otherwise. The repo-local scaffold checks
are CLI-only and must not be reported as Android boot evidence.

## Host Prerequisites

Use a Linux host for Cuttlefish. The expected development host is Ubuntu or
Debian on x86_64 with hardware virtualization enabled.

Minimum host checks:

```sh
grep -c -w 'vmx\|svm' /proc/cpuinfo
find /dev -name kvm
groups "$USER" | grep -E 'kvm|cvdnetwork|render'
qemu-system-riscv64 --version
adb version
repo version
```

Repo preflight and handoff:

```sh
cd /path/to/Eliza-AI-SoC
export AOSP_DIR=/path/to/aosp
python3 scripts/check_aosp_linux_preflight.py --write-report
sw/aosp-device/import-aosp-device.sh --check "$AOSP_DIR"
make aosp-bsp-check
AOSP_DIR="$AOSP_DIR" scripts/boot_android_simulator.sh \
  --run-cuttlefish --run-cts --run-vts --run-qemu --run-renode
python3 scripts/check_android_sim_boot.py
python3 scripts/check_software_bsp.py aosp --require-evidence
```

Expected results:

- `/dev/kvm` exists and the user is in `kvm`, `cvdnetwork`, and `render`.
- QEMU is at least 8.1; QEMU 9.0 or newer is preferred for vector-extension
  fixes.
- `repo`, `adb`, `launch_cvd`, and `stop_cvd` are in `PATH` after the AOSP
  environment is sourced.
- At least 250 GB free disk space and 32 GB RAM are available for a local AOSP
  build. A shell-only Cuttlefish run should use at least 8 GB guest RAM.

Cuttlefish host packages, when not provided by the OS image, are built and
installed from the Android Cuttlefish host package source:

```sh
sudo apt install -y git devscripts equivs config-package-dev \
  debhelper-compat golang curl
git clone https://github.com/google/android-cuttlefish
cd android-cuttlefish
tools/buildutils/build_packages.sh
sudo dpkg -i ./cuttlefish-base_*_*64.deb || sudo apt-get install -f
sudo dpkg -i ./cuttlefish-user_*_*64.deb || sudo apt-get install -f
sudo usermod -aG kvm,cvdnetwork,render "$USER"
sudo reboot
```

## AOSP riscv64 Cuttlefish Runbook

Use this track first because it exercises Android userspace, ART, framework
services, adb, and Tradefed without depending on the incomplete e1_soc CPU
and GPU story.

```sh
mkdir -p ~/aosp-riscv64
cd ~/aosp-riscv64
repo init -u https://android.googlesource.com/platform/manifest \
  -b android-latest-release
repo sync -c -j"$(nproc)"
source build/envsetup.sh
lunch aosp_cf_riscv64_phone-trunk_staging-userdebug
make -j"$(nproc)"
```

Shell-first launch:

```sh
launch_cvd -cpus=4 --memory_mb=8192 --gpu_mode=none --daemon
adb wait-for-device
adb shell getprop ro.product.cpu.abi
adb shell uname -m
adb shell logcat -d -b all > out/eliza-riscv64-logcat.txt
stop_cvd
```

Home-screen launch:

```sh
launch_cvd -cpus=8 --memory_mb=8192 --daemon
adb wait-for-device
adb shell getprop sys.boot_completed
adb shell dumpsys SurfaceFlinger --display-id
adb shell logcat -d -b all > out/eliza-riscv64-home-logcat.txt
stop_cvd
```

Record failure as useful data. Do not update status to "Android running" from
these repo-local docs. A virtual-device transcript may be useful smoke evidence
when it includes `adb shell`, `ro.product.cpu.abi=riscv64`, and
`sys.boot_completed=1`, but it is still not e1_soc hardware ABI proof.

The checked-in capture wrapper records that bounded transcript shape without
fabricating pass markers:

```sh
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cuttlefish-boot
make software-bsp-evidence-check
```

For a different external Cuttlefish product or UI launch, set:

```sh
AOSP_PRODUCT=aosp_cf_riscv64_phone-trunk_staging-userdebug \
AOSP_CUTTLEFISH_ARGS="--cpus=8 --memory_mb=8192" \
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cuttlefish-boot
```

The `cuttlefish-boot` mode currently emits the backward-compatible
`docs/evidence/android/cuttlefish_riscv64_boot.log` alias. The stricter AOSP
BSP gate in `scripts/check_software_bsp.py` requires
`docs/evidence/android/cuttlefish_riscv64_smoke.log` plus QEMU and Renode smoke
logs before the Android BSP evidence gate clears.

## Eliza AOSP Device Tree Runbook

The repo-local device tree is a scaffold intended to be copied or overlaid into
an external AOSP checkout:

```sh
cd ~/aosp-riscv64
mkdir -p device/eliza
rsync -a /path/to/Eliza-AI-SoC/sw/aosp-device/device/eliza/ \
  device/eliza/
source build/envsetup.sh
lunch eliza_ai_soc-userdebug
m nothing
m vendorimage
```

The first expected result is a useful build failure if a required Android
surface is absent. A successful `m vendorimage` only means the scaffold
is syntactically integrated; it does not mean Android boots on e1_soc.

Use the repo capture commands for archived evidence:

```sh
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp lunch
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vendorimage
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp checkvintf
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cts-subset
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vts-subset
python3 scripts/intake_android_evidence.py --target aosp --from-dir /path/to/logs --install
```

The required evidence files, command markers, and pass markers for
`scripts/check_software_bsp.py` are listed in
`docs/android/bsp-log-evidence-manifest.json`. The stricter AOSP gate requires
these logs:

- `docs/evidence/android/eliza_ai_soc_lunch.log`
- `docs/evidence/android/eliza_ai_soc_vendorimage.log`
- `docs/evidence/android/eliza_ai_soc_checkvintf.log`
- `docs/evidence/android/eliza_ai_soc_sepolicy_build.log`
- `docs/evidence/android/eliza_ai_soc_selinux_neverallow.log`
- `docs/evidence/android/eliza_ai_soc_cts_vts_plan.log`
- `docs/evidence/android/cuttlefish_riscv64_smoke.log`
- `docs/evidence/android/qemu_riscv64_smoke.log`
- `docs/evidence/android/renode_e1_soc_smoke.log`

The legacy capture outputs `cuttlefish_riscv64_boot.log`,
`cts_virtual_device_subset.log`, and `vts_virtual_device_subset.log` may be
kept as aliases when produced by `capture-aosp-evidence.sh`, but they are not a
complete AOSP BSP evidence gate.

Expected local artifacts after integration:

| Artifact | Producer | Evidence to attach |
|---|---|---|
| `out/target/product/eliza_ai_soc/vendor.img` | `m vendorimage` | `ls -lh`, build log, VINTF check result |
| `out/target/product/eliza_ai_soc/installed-files-vendor.txt` | AOSP build | HAL/init/fstab entries present |
| `out/target/product/eliza_ai_soc/obj/PACKAGING/vndk_intermediates` | AOSP build | VNDK/Treble packaging log |
| `out/target/product/eliza_ai_soc/obj/ETC/vendor_sepolicy.cil_intermediates/vendor_sepolicy.cil` | AOSP policy build | SELinux policy build transcript |
| `out/eliza-riscv64-logcat.txt` | Cuttlefish run | virtual-device smoke, init, HAL, and SELinux data; not e1_soc boot proof |
| `out/host/linux-x86/cts` | `m cts` or Tradefed list/run command | CTS/VTS plan transcript and result dir, not a full CTS claim |
| `out/host/linux-x86/vts` | `m vts` or Tradefed list/run command | CTS/VTS plan transcript and result dir, not a full VTS claim |

## v0 Device Contract

The `sw/aosp-device/device/eliza/eliza_ai_soc` tree must remain tied to
`sw/platform/e1_platform_contract.json`. Any HAL, init service, device-tree
node, or kernel driver added for Android must have a contract entry or an
explicit stub rationale.

The checked-in `sw/linux/dts/eliza-e1.dts` file is not a complete AP boot
DTB. For Android/Linux bring-up it must be combined with, or replaced by, the
selected generated AP DTS containing CPU, memory, timer, interrupt-controller,
and enabled UART console nodes. Run `python3 scripts/capture_cpu_ap_evidence.py
dts-audit --run-dtc` against the generated DTS before using it for OpenSBI,
Linux, or Android boot evidence.

Required v0 surfaces:

- boot image and kernel config contract
- serial console / log path
- framebuffer or stub display path
- input stub
- block storage path
- NPU service shim that can fail closed
- SELinux labels for project-owned device nodes
- init service declarations
- manifest entries for HAL stubs

## HAL Stub Map

All v0 HALs must either fail closed or delegate to the Linux device contract.
No stub may fake hardware success.

| Surface | AOSP artifact | Contract source | v0 behavior |
|---|---|---|---|
| Graphics composer | `hwcomposer.eliza_ai_soc` and VINTF `android.hardware.graphics.composer@2.4` | `display` MMIO region at `0x10030000` | Stub exposes a framebuffer path only after a Linux display node exists; otherwise service stays disabled or returns unsupported. |
| NPU | `e1_npu.default` and VINTF `vendor.eliza.e1_npu@1.0` | `npu` MMIO region at `0x10020000` and IRQ_NPU | Runtime shim runs fixed-vector smoke only when `/dev/e1-npu` exists; all other ops return unsupported. |
| DMA | No public Android HAL in v0 | `dma` MMIO region at `0x10010000` and IRQ_DMA | Kernel-only support for NPU/display staging; no framework exposure. |
| Input | Generic evdev or no-op input | Board DTS input node, when present | Simulator may use Cuttlefish input; e1_soc target has no touch claim. |
| Audio | None | No contract entry | Excluded; do not add manifest entries. |
| Camera | None | No contract entry | Excluded; do not add manifest entries. |
| Radio/modem | None | No contract entry | Excluded; do not add manifest entries. |
| Power/thermal | Minimal default Android services only | No power island contract yet | Excluded from performance claims. |

Explicit v0 exclusions:

- cellular modem integration
- carrier voice, VoLTE, VoNR, emergency calling
- GMS, Play certification, Widevine L1, HDCP
- full Vulkan/GLES performance path
- production camera HAL3
- full CTS/VTS pass

## Three-Week Android Target

The three-week target is not a consumer phone. It is a verified demo:

1. AOSP/riscv64 or Cuttlefish-based virtual device reaches shell or home
   screen in a captured smoke transcript.
2. The Eliza device tree and BoardConfig compile far enough to expose
   missing HAL/kernel contracts.
3. QEMU/Renode software-reference smoke checks pass against the platform
   contract and are not e1-chip hardware boot proof.
   Required evidence term: QEMU/Renode software-reference smoke checks are not
   e1-chip hardware boot proof. The current AOSP BSP gate expects
   `qemu_riscv64_smoke.log` and `renode_e1_soc_smoke.log`.
4. The NPU runtime shim can run a deterministic fixed test vector or report
   unsupported operations without crashing Android.
5. CTS/VTS subsets are identified and at least the host-side plumbing exists.

## CTS/VTS Subset Plan

The first compatibility goal is a stable virtual-device subset, not a full
phone certification run.

Build test harnesses from the same AOSP checkout:

```sh
source build/envsetup.sh
lunch aosp_cf_riscv64_phone-trunk_staging-userdebug
m -j"$(nproc)" cts vts
```

Run order:

1. `adb shell true`, `adb shell cmd package list packages`, and
   `adb shell getenforce`.
2. CTS smoke modules that do not require camera, cellular, audio, Vulkan, GLES,
   biometrics, secure element, or Play services.
3. `cts-tradefed run cts-virtual-device-stable` when the riscv64 virtual device
   is stable enough to keep multiple shards online.
4. VTS kernel, VINTF, binder, SELinux, and HAL-manager checks for declared HALs.
5. Project-specific smoke: `/dev/e1-npu` absent must not crash Android;
   present must pass a fixed-vector runtime test before any NNAPI/TFLite claim.

Initial excludes:

- `CtsCameraTestCases`
- `CtsMedia*` modules requiring hardware codecs or microphones
- `CtsGraphics*` modules requiring GLES/Vulkan conformance
- telephony, eUICC, NFC, secure element, biometric, and GNSS modules
- NNAPI performance or accelerator conformance until the NPU HAL has a real
  framework integration

Pass criteria for the first report:

- test command line and AOSP build ID recorded
- result directory archived
- failed modules classified as expected exclusion, product bug, infra bug, or
  unknown
- no SELinux denial is waived without a linked policy or device-contract issue
- no CDD, full CTS, full VTS, or Android compatibility claim is made from these
  subset logs

## Failure Triage

Use this order so failures stay actionable:

| Symptom | First commands | Likely owner |
|---|---|---|
| Cuttlefish does not launch | `launch_cvd -verbosity=DEBUG`, `ls -l /dev/kvm`, `groups`, `cvd_status` | host setup |
| `adb devices` is empty | `adb kill-server; adb start-server`, `ss -ltnp | grep 652`, `tail -200 ~/cuttlefish_runtime/logs/*` | Cuttlefish/adb |
| riscv64 build fails before lunch | `repo branch`, `build/soong/soong_ui.bash --dumpvar-mode TARGET_ARCH` | AOSP branch/target |
| boot hangs before init | `tail -300 ~/cuttlefish_runtime/kernel.log`, `adb wait-for-device` | kernel/bootloader |
| init restarts HAL | `adb shell logcat -b all -d | grep -E 'init|hwservicemanager|e1|composer'` | device tree/HAL |
| VINTF failure | `adb shell lshal`, `adb shell vintf` when available, inspect vendor manifest | manifest/HAL |
| SELinux denial | `adb shell dmesg | grep avc`, `adb logcat -b all -d | grep avc` | sepolicy |
| UI never reaches home | `adb shell getprop sys.boot_completed`, `dumpsys SurfaceFlinger`, `logcat ActivityTaskManager` | graphics/framework |
| CTS module times out | `tradefed.sh list devices`, `adb logcat`, retry a single module | test infra or module |

## Evidence Required

Every Android bring-up report must include:

- AOSP branch or tag
- host OS and toolchain
- target architecture
- kernel config
- virtual-device smoke log, without claiming e1_soc Android boot
- init log
- SELinux denials
- HAL manifest state
- vendorimage, checkvintf, sepolicy build, and neverallow transcripts
- CTS/VTS scope plan with exclusions and result directory path
- command transcript
- pass/fail status for `make aosp-bsp-check`
- pass/fail status for `python3 sw/check_bsp_scaffolds.py aosp`

Repo-local expected output before external AOSP work:

```text
aosp: scaffold audit
  local command: make aosp-bsp-check
  expected output: aosp BSP check passed.
  dependency blocker: external AOSP checkout with riscv64/Cuttlefish host dependencies and HAL binaries
  status: clear
aosp BSP check failed:
  - aosp BSP BLOCKED: missing evidence for external AOSP lunch/vendorimage/VINTF/SELinux/CTS-VTS intake logs plus virtual-device smoke transcripts: ...
```

Sources:

- AOSP RISC-V tracking: https://github.com/google/android-riscv64
- Android CTS: https://source.android.com/docs/compatibility/cts
- Android VTS: https://source.android.com/docs/core/tests/vts
- Android CDD: https://source.android.com/docs/compatibility/cdd
