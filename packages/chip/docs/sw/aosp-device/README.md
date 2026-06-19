# AOSP device target

Repo-local source path:

```text
sw/aosp-device/device/eliza/eliza_ai_soc
```

External AOSP checkout path:

```text
device/eliza/eliza_ai_soc
```

Initial Android bring-up should target AOSP riscv64 Cuttlefish plus QEMU/Renode
before RTL simulation, but qemu-virt or Cuttlefish success is not hardware ABI
validation. Device and HAL code must tie back to
`sw/platform/e1_platform_contract.json` or generated artifacts from it.

## AVB/A-B/recovery/OTA local status

Current status is fail-closed scaffold only. The local fstab and product files
do not define AVB keys, rollback indexes, recovery behavior, OTA payload
verification, or lock-state policy. Do not claim AVB, A/B OTA, recovery, secure
fastboot, or verified boot from this tree. Required negative evidence includes
bad signatures, rollback OTA, interrupted install, low-battery update,
full-storage update, corrupt slot metadata, and unauthorized flashing.

Exact gate terms: AVB/A-B/recovery/OTA local status; fail-closed scaffold only;
does not define AVB keys; Do not claim AVB; bad signatures; unauthorized
flashing.

Current local status: this repository has not verified Android booting on
e1_soc or on Cuttlefish. The files here are an executable scaffold for the
first external AOSP integration attempt.

`make aosp-bsp-check` rejects a documentation-only target. The initial Android bring-up target must provide:

```text
import-aosp-device.sh
capture-aosp-evidence.sh
manifests/eliza-ai-soc-local.xml
AndroidProducts.mk
eliza_ai_soc.mk
BoardConfig.mk
device.mk
init.eliza.rc
manifest.xml
SELinux file_contexts
kernel config
device tree
init files
fstab
SELinux policy
HAL scaffolds
framebuffer/display path
NPU HAL/runtime shim
```

## Repo-local scaffold check

Command:

```sh
make aosp-bsp-check
python3 sw/check_bsp_scaffolds.py aosp
```

Expected output:

```text
aosp: scaffold audit
  local command: make aosp-bsp-check
  expected output: aosp BSP check passed.
  dependency blocker: external AOSP checkout with riscv64/Cuttlefish host dependencies and HAL binaries
  status: clear
aosp BSP check passed.
aosp BSP external evidence blocked:
  - aosp BSP BLOCKED: missing evidence for external AOSP lunch/vendorimage/VINTF/SELinux/CTS-VTS intake logs plus virtual-device smoke transcripts: ...
aosp BSP check failed:
  - aosp BSP BLOCKED: missing evidence for external AOSP lunch/vendorimage/VINTF/SELinux/CTS-VTS intake logs plus virtual-device smoke transcripts: ...
```

Dependency blocker: a real Android build requires an external AOSP checkout,
riscv64/Cuttlefish host dependencies, and actual `e1_npu.default` and
`hwcomposer.eliza_ai_soc` HAL source or reviewed prebuilts that fail closed
when their backing Linux nodes are absent. This repo includes a host-buildable
`e1_npu` runtime probe under `hal/` so the absent-device behavior is locally
checked; the checked-in `device.mk` and VINTF manifest intentionally do not
list active HAL packages or HAL entries until Android integration and evidence
exist.

Evidence intake for `scripts/check_software_bsp.py` is defined by
`docs/android/bsp-log-evidence-manifest.json` and validated by
`make software-bsp-evidence-check`. The checker rejects non-evidence stubs:
each transcript must include the required provenance fields, command marker,
claim-boundary markers, and target-specific pass markers.
`hwcomposer.eliza_ai_soc` HAL binaries that fail closed when their backing
Linux nodes are absent.

## External AOSP integration

Use a Linux host with Cuttlefish/KVM enabled. From an AOSP checkout:

```sh
/path/to/Eliza-AI-SoC/sw/aosp-device/import-aosp-device.sh /path/to/aosp
cd /path/to/aosp
source build/envsetup.sh
lunch eliza_ai_soc-userdebug
m nothing
m vendorimage
```

The import helper copies only the device tree into an existing AOSP checkout.
It does not run `repo sync`, download AOSP, or build Android.

The single-command driver for this flow is:

```sh
AOSP_DIR=/path/to/aosp make aosp-linux-preflight
AOSP_DIR=/path/to/aosp make aosp-linux-handoff-build-only
AOSP_DIR=/path/to/aosp make aosp-linux-handoff
```

`make aosp-linux-preflight` checks only Linux host readiness: `AOSP_DIR`,
`build/envsetup.sh`, `/dev/kvm`, `repo`, `adb`, and Cuttlefish launcher
visibility from `PATH` or `AOSP_DIR/out/host/linux-x86/bin`. It writes
`build/reports/aosp_linux_preflight.json` when requested by the Make target.
That report is host-preflight status only and does not create
`docs/evidence/android/*.log`. The report also breaks readiness into import,
build, Cuttlefish, compatibility-intake, QEMU, and Renode tracks so the Linux
operator can see which blocker is host setup, which is missing command wiring,
and which is missing real evidence.

`make aosp-linux-handoff-build-only` runs preflight, checks/imports the local
device tree into the external AOSP checkout, captures the build-only evidence
categories, and stops before simulator/CTS/VTS claims. `make
aosp-linux-handoff` attempts the full virtual-device evidence sequence and then
runs both `scripts/check_android_sim_boot.py` and
`scripts/check_software_bsp.py aosp --require-evidence`.

`make android-sim-boot-check` imports the device tree, captures `lunch`,
`vendorimage`, and `checkvintf` evidence, then validates the AOSP evidence
manifest. The stricter AOSP BSP gate still remains BLOCKED until SELinux policy
build, neverallow, CTS/VTS scope-intake, and Cuttlefish/QEMU/Renode smoke logs
are also installed.
To attempt a Cuttlefish run as well:

```sh
AOSP_DIR=/path/to/aosp make aosp-linux-preflight
AOSP_DIR=/path/to/aosp scripts/boot_android_simulator.sh --run-cuttlefish
```

`--run-cuttlefish` requires a Linux AOSP environment with Cuttlefish tools on
`PATH`. On hosts without `launch_cvd`/`cvd`, the script writes
`build/reports/android_sim_boot.json` with `status=blocked` instead of treating
missing simulator support as an Android boot failure.

If the Linux host provides only the modern `cvd` launcher, set
`AOSP_CUTTLEFISH_LAUNCHER=cvd`; otherwise the scripts prefer `launch_cvd` and
fall back to `cvd start`. Override `AOSP_CUTTLEFISH_ARGS` for host-specific
CPU, memory, GPU, or instance settings.

Android compatibility remains blocked separately from AOSP build and virtual
device smoke. `sw/aosp-device/evidence_manifest.json` requires a bounded
CTS/VTS plan transcript before any compatibility language is allowed; that plan
is not full CDD, CTS, or VTS certification evidence.

Capture external logs with the repo helper so the strict evidence gate sees the
required provenance markers:

```sh
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp lunch
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vendorimage
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp checkvintf
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp sepolicy-build
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp selinux-neverallow
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cts-vts-plan
/path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cuttlefish-smoke
AOSP_QEMU_SMOKE_COMMAND='/exact/qemu-system-riscv64 smoke command' \
  /path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp qemu-smoke
AOSP_RENODE_SMOKE_COMMAND='/exact/renode smoke command' \
  /path/to/Eliza-AI-SoC/sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp renode-smoke
python3 scripts/intake_android_evidence.py --target aosp --from-dir /path/to/logs --install
scripts/android/capture_e1_npu_hal_absent_device.sh
python3 scripts/check_e1_npu_android_proof_manifest.py
```

These commands write under `docs/evidence/android/`. They capture command
transcripts only; they do not make a boot claim. The legacy `cuttlefish-boot`,
`cts-subset`, and `vts-subset` capture modes may produce
`cuttlefish_riscv64_boot.log`, `cts_virtual_device_subset.log`, and
`vts_virtual_device_subset.log`; those filenames are backward-compatible
aliases for simulator tooling and are not the full `scripts/check_software_bsp.py`
AOSP gate. Install or validate the nine current gate logs with
`scripts/intake_android_evidence.py`.

Use `scripts/android/capture_e1_npu_nnapi_evidence.sh` only on a connected
Android target that exposes a real `e1-npu` NNAPI accelerator. It captures
the four NNAPI transcripts and a transcript manifest under
`docs/evidence/android/e1-npu/`. By default it does not assert acceleration.
With `E1_NPU_WRITE_PROOF_JSON=1` plus the required measured counter
environment variables, the same target job can also write
`benchmarks/capabilities/e1_npu_nnapi.proof.json`; the script refuses to do so
if the transcripts lack the required `e1-npu`, NNAPI, and DMA markers. That
proof JSON still requires reviewed target counters, exact transcript hashes,
model hash, DMA bytes, and zero CPU fallback.

For a full target-side e1-NPU Android proof run, use
`scripts/android/capture_e1_npu_android_proof_bundle.sh`. It runs the
absent-device probe, VINTF capture, NNAPI transcript/proof capture, CTS smoke,
VTS smoke, manifest assembly, and both strict proof checks in order. It is the
preferred closure entry point once ADB sees exactly one booted Android target
and `AOSP_TREE` points at the built checkout with CTS/VTS Tradefed tools.
Use `python3 scripts/check_e1_npu_android_proof_bundle_preflight.py --json`
to inspect those prerequisites before starting the full bundle.
If the preflight reports missing `cts-tradefed` or `vts-tradefed`, build and
verify the host bundles first:

```sh
AOSP_TREE=/path/to/aosp scripts/android/build_cts_vts_tradefed.sh
```

The helper runs `m cts vts`, verifies both executable paths, and writes
`docs/evidence/android/e1-npu/cts-vts-tradefed-build.log` with pass/fail
markers. Use `--verify-only` to re-check an already built tree without starting
another AOSP build.

Use `python3 scripts/check_e1_npu_android_proof_manifest.py --manifest
docs/evidence/android/e1-npu/android-proof-manifest.json --require-pass` for
a filled Android proof manifest. The checked-in template is valid only as a
blocked shape and cannot satisfy HAL, CTS, VTS, or NNAPI proof.

The Cuttlefish boot capture defaults to `AOSP_PRODUCT=eliza_ai_soc-userdebug`
and `AOSP_CUTTLEFISH_ARGS="--cpus=4 --memory_mb=8192 --gpu_mode=none"`.
Override those environment variables when running a different riscv64
Cuttlefish product or a home-screen launch.

For a commit-ready local validation pass that does not fabricate logs, run:

```sh
make aosp-scaffold-check
make aosp-linux-preflight
scripts/run_aosp_linux_handoff.sh --preflight-only
scripts/android/capture_e1_npu_hal_absent_device.sh
python3 scripts/check_e1_npu_android_proof_manifest.py
make android-sim-status-test
make software-bsp-test
```

On non-Linux hosts, or Linux hosts without `AOSP_DIR`/KVM/Cuttlefish tooling,
`make aosp-linux-preflight` is expected to return BLOCKED and record the exact
blockers. Do not convert that blocked report into Android evidence.

Required AOSP evidence inputs are intentionally explicit and do not, by
themselves, claim Android boot or compatibility:

| Evidence log | External artifact or marker that must back it |
|---|---|
| `docs/evidence/android/eliza_ai_soc_lunch.log` | `build/envsetup.sh`, `device/eliza/eliza_ai_soc/AndroidProducts.mk`, `TARGET_PRODUCT=eliza_ai_soc` |
| `docs/evidence/android/eliza_ai_soc_vendorimage.log` | `out/target/product/eliza_ai_soc/vendor.img`, `out/target/product/eliza_ai_soc/installed-files-vendor.txt`, `out/target/product/eliza_ai_soc/vendor/etc/vintf/manifest/eliza_e1.xml` |
| `docs/evidence/android/eliza_ai_soc_checkvintf.log` | `checkvintf` output against `out/target/product/eliza_ai_soc/vendor` and `eliza_e1.xml` |
| `docs/evidence/android/eliza_ai_soc_sepolicy_build.log` | `m vendor_sepolicy.cil selinux_policy`, `e1_npu_device`, and `hal_e1_npu_default` |
| `docs/evidence/android/eliza_ai_soc_selinux_neverallow.log` | `m sepolicy_neverallows` and `e1_npu` neverallow coverage |
| `docs/evidence/android/eliza_ai_soc_cts_vts_plan.log` | CTS/VTS build or list-module output, selected smoke scope, exclusions, and result directory path |
| `docs/evidence/android/cuttlefish_riscv64_smoke.log` | Cuttlefish launch or `cvd start`, `adb` smoke checks, `ro.product.cpu.abi=riscv64`, and `eliza_ai_soc` |
| `docs/evidence/android/qemu_riscv64_smoke.log` | `qemu-system-riscv64` transcript with AOSP-built artifacts and console or `adb` smoke checks |
| `docs/evidence/android/renode_e1_soc_smoke.log` | Renode monitor/UART smoke transcript against the Eliza model and Android-capable handoff when available |

Legacy aliases, when produced by `capture-aosp-evidence.sh`, are
`cuttlefish_riscv64_boot.log`, `cts_virtual_device_subset.log`, and
`vts_virtual_device_subset.log`. Keep them with reports if useful, but do not
describe them as satisfying the current AOSP BSP gate.

`manifests/eliza-ai-soc-local.xml` is a local-manifest starting point for
teams that mirror this repository into an AOSP `repo` workspace. The script
above is the deterministic path for a plain local checkout.

Expected first-pass artifacts:

```text
out/target/product/eliza_ai_soc/vendor.img
out/target/product/eliza_ai_soc/installed-files-vendor.txt
out/target/product/eliza_ai_soc/obj/PACKAGING/check_vintf_all_intermediates/
```

If `lunch eliza_ai_soc-userdebug` is not visible, add the product makefile
to the external tree's product list before changing the board files. If
`vendorimage` fails, classify the failure as missing HAL binary, VINTF mismatch,
SELinux type error, missing kernel/DTS artifact, or generic AOSP product wiring.

## External evidence capture

From this repository, with `/path/to/aosp` already provisioned:

```sh
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp lunch
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp vendorimage
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp checkvintf
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp sepolicy-build
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp selinux-neverallow
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cts-vts-plan
sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp cuttlefish-smoke
AOSP_QEMU_SMOKE_COMMAND='/exact/qemu-system-riscv64 smoke command' \
  sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp qemu-smoke
AOSP_RENODE_SMOKE_COMMAND='/exact/renode smoke command' \
  sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp renode-smoke
python3 scripts/intake_android_evidence.py --target aosp --from-dir /path/to/logs --install
make software-bsp-evidence-check
```

The Cuttlefish smoke log requires `ro.product.cpu.abi=riscv64` and a real
Cuttlefish/adb transcript. It is Android virtual-device evidence only; it is
not e1_soc hardware ABI proof and must not be described as an Android boot
claim for e1_soc. CTS/VTS intake is scope-planning evidence only and must
not be described as full Android compatibility evidence.

## Artifact map

| Artifact | Repo file | Purpose |
|---|---|---|
| Import helper | `import-aosp-device.sh` | Copies device files into an external AOSP checkout and prints lunch checks. |
| Evidence capture helper | `capture-aosp-evidence.sh` | Captures external AOSP command transcripts with required evidence markers. |
| Local manifest seed | `manifests/eliza-ai-soc-local.xml` | Records the intended repo workspace path for mirrored integrations. |
| Product list | `device/eliza/eliza_ai_soc/AndroidProducts.mk` | Exposes `eliza_ai_soc-userdebug` to `lunch`. |
| Lunch product | `device/eliza/eliza_ai_soc/eliza_ai_soc.mk` | Inherits generic AOSP product glue and the Eliza device makefile. |
| Board config | `device/eliza/eliza_ai_soc/BoardConfig.mk` | Declares riscv64 target and vendor policy directories. |
| Product makefile | `device/eliza/eliza_ai_soc/device.mk` | Copies init, fstab, and the empty VINTF scaffold; HAL packages stay disabled until evidence exists. |
| Init | `device/eliza/eliza_ai_soc/init.eliza.rc` | Creates the e1 device namespace and starts the NPU HAL only when enabled. |
| Fstab | `device/eliza/eliza_ai_soc/fstab.eliza` | Documents first vendor/data mount contract for simulator integration. |
| VINTF manifest | `device/eliza/eliza_ai_soc/manifest.xml` | Reserves graphics-composer and e1_npu names in comments only. |
| SELinux contexts | `device/eliza/eliza_ai_soc/sepolicy/file_contexts` | Labels HAL binaries and `/dev/e1-npu`. |
| SELinux types | `device/eliza/eliza_ai_soc/sepolicy/e1_npu.te` | Defines the fail-closed NPU device and HAL domains. |
| Kernel fragment | `device/eliza/eliza_ai_soc/kernel/eliza_ai_soc.fragment` | Records Android kernel config needed by the scaffold. |
| DTS scaffold | `device/eliza/eliza_ai_soc/dts/eliza-e1-android.dts` | Mirrors the central platform contract for Android-facing nodes. |
| HAL runtime skeleton | `device/eliza/eliza_ai_soc/hal/e1_npu_runtime.cc` | Host-buildable fail-closed probe for absent `/dev/e1-npu`; always reports `nnapi_acceleration=false` in local checks. |
| HAL probe CLI | `device/eliza/eliza_ai_soc/hal/e1_npu_probe_main.cc` | CLI used by `sw/check_bsp_scaffolds.py aosp` to verify absent-device behavior without fake device evidence. |
| HAL plan | `device/eliza/eliza_ai_soc/hal/README.md` | Defines fail-closed behavior required before package claims are enabled. |

## HAL stub policy

Stubs must not claim feature success unless backed by a Linux node or the
central platform contract.

| HAL/package | Backing node | Required v0 behavior |
|---|---|---|
| `e1_npu.default` | `/dev/e1-npu` | Return unsupported when the device node is absent; only fixed-vector smoke is allowed when present. |
| `hwcomposer.eliza_ai_soc` | framebuffer/display node | Expose a simple framebuffer path only; no GLES or Vulkan claim. |
| input | Cuttlefish/evdev only | No touch-panel claim for e1_soc. |
| camera/audio/radio/GNSS/NFC | none | No package, no VINTF entry, no CTS claim. |

## Local checks

Run from the repository root:

```sh
make aosp-bsp-check
make docs-check
```

`docs-check` does not currently inspect this AOSP tree directly, so
`aosp-bsp-check` is the primary local guard for this ownership area. It must
remain BLOCKED until the strict external AOSP build, SELinux, CTS/VTS intake,
and virtual-device smoke evidence is checked in.
