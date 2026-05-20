# Cuttlefish riscv64 Operator Guide

This guide drives the launch + boot validation harness for the Cuttlefish
riscv64 virtual device produced by Task 28's AOSP build pipeline. Three
scripts under `sw/aosp-device/` work together:

| Script | Purpose |
| --- | --- |
| `launch-cuttlefish-riscv64.sh` | host preflight, optional cleanup, `launch_cvd` with deterministic flags, wait-for-boot polling |
| `cuttlefish-boot-gate.sh` | post-launch assertions; emits `docs/evidence/android/cuttlefish_riscv64_boot.log` |
| `bootloop-triage.sh` | dumps host + guest signals to `out/triage/cuttlefish-riscv64-bootfail-<epoch>.log` when boot fails |

The capture wrapper `sw/aosp-device/capture-aosp-evidence.sh /path/to/aosp
cuttlefish-boot-full` chains launch + gate in a single command and wraps the
result with the canonical `eliza-evidence:` framing.

## Claim boundary

This stage produces *virtual-device boot smoke* evidence only. A passing
`cuttlefish_riscv64_boot.log` is not e1_soc/AP silicon evidence and is not an
Android compatibility claim. The transcript carries the existing
`claim_boundary=virtual_device_smoke_only_not_boot_or_compatibility_evidence`
marker that the broader gate enforces.

## Host prerequisites

Linux x86_64 host with hardware virtualization. The launch script will
abort with an actionable error if any of these are not satisfied:

- `/dev/kvm` readable and writable by `$USER`
- `vhost_vsock` kernel module loaded (`sudo modprobe vhost_vsock`)
- `$USER` in groups `kvm`, `cvdnetwork`, `render`
  (`sudo usermod -aG kvm,cvdnetwork,render "$USER"` then re-login)
- `qemu-system-riscv64 --version` reports >= 9.2. Cuttlefish riscv64 on
  x86_64 runs the guest CPU under QEMU TCG (KVM cannot accelerate a
  riscv64 guest on an x86_64 host); QEMU < 9.2 makes boot prohibitively
  slow.

A built AOSP tree from Task 28 is also required so that `adb`, `launch_cvd`,
`stop_cvd`, and `cvd` are on `PATH`. Source `build/envsetup.sh` and `lunch`
the riscv64 product before running the launch script, or pass
`--aosp=/path/to/aosp` so the launcher does it for you.

## One-shot launch recipe

```sh
REPO=/path/to/Eliza-AI-SoC
AOSP=/path/to/aosp

# 1. Source the AOSP environment.
cd "$AOSP"
source build/envsetup.sh
lunch aosp_cf_riscv64_phone-trunk_staging-userdebug

# 2. Launch with a clean runtime directory, shell-first GPU mode.
"$REPO/sw/aosp-device/launch-cuttlefish-riscv64.sh" \
  --clean \
  --cpus=8 \
  --memory-mb=12288 \
  --gpu-mode=none \
  --boot-timeout-seconds=1800

# 3. Run the boot gate. Record the AOSP manifest snapshot from Task 28 so
#    the transcript carries its sha256.
"$REPO/sw/aosp-device/cuttlefish-boot-gate.sh" \
  --manifest="$AOSP/eliza-cf-manifest.xml"

# 4. Stop the CVD when you're done.
stop_cvd
```

A successful run writes `docs/evidence/android/cuttlefish_riscv64_boot.log`
with `eliza-evidence: status=PASS`, `RESULT=0`, and the canonical boot
markers (`ro.product.cpu.abi=riscv64`, `uname_m=riscv64`,
`sys.boot_completed=1`, `getenforce=Enforcing`, `KERNEL_INIT_MARKER=present`,
`KERNEL_PANIC=false`, plus `BUILD_ID` and `MANIFEST_SHA256`).

Use `--gpu-mode=guest_swiftshader` once shell-first is reliable; it enables
home-screen SurfaceFlinger but is slower.

## Capture-wrapper recipe

For evidence runs use the wrapper. It applies the same eliza-evidence
framing as every other AOSP capture stage:

```sh
"$REPO/sw/aosp-device/capture-aosp-evidence.sh" "$AOSP" cuttlefish-boot-full
```

Environment knobs honored by `cuttlefish-boot-full`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AOSP_CUTTLEFISH_BOOT_CPUS` | 8 | vCPU count |
| `AOSP_CUTTLEFISH_BOOT_MEMORY_MB` | 12288 | guest RAM (MiB) |
| `AOSP_CUTTLEFISH_BOOT_GPU_MODE` | `none` | `--gpu_mode` for `launch_cvd` |
| `AOSP_CUTTLEFISH_BOOT_TIMEOUT_SECONDS` | 1800 | wait-for-boot deadline |
| `AOSP_CUTTLEFISH_BOOT_MANIFEST` | empty | optional AOSP manifest xml whose sha256 is recorded |
| `AOSP_CUTTLEFISH_BOOT_CLEAN` | 0 | set to `1` to wipe `~/cuttlefish_runtime` and kill stale crosvm before launch |
| `AOSP_ADB_SERIAL` | empty | adb -s <serial> for multi-device hosts |

## Triage recipes

### Symptom: `launch_cvd` exits immediately or `adb get-state` never sees the device

Run:

```sh
"$REPO/sw/aosp-device/bootloop-triage.sh"
```

The dump contains:

- host groups (`kvm`/`cvdnetwork`/`render`)
- loaded kernel modules (`vhost_vsock`, `nbd`)
- `qemu-system-riscv64 --version`
- `ls -l /dev/kvm`
- live `crosvm` processes
- tail of `~/cuttlefish_runtime/launcher.log`
- tail of `~/cuttlefish_runtime/kernel.log`
- `adb devices -l`

### Symptom: crosvm exits with `SIGSEGV`

Known issue
[`google/android-cuttlefish#163`](https://github.com/google/android-cuttlefish/issues/163).
Force shell-first launch with `--gpu_mode=none` (the default for
`launch-cuttlefish-riscv64.sh`). Only move to `guest_swiftshader` once
shell-first is verified.

### Symptom: `Disk has been locked` from `launch_cvd`

Known issue
[`google/android-cuttlefish#146`](https://github.com/google/android-cuttlefish/issues/146).
Re-launch with `--clean`, which runs
`stop_cvd; pkill -f crosvm; rm -rf ~/cuttlefish_runtime` before
`launch_cvd`.

### Symptom: `vhost_vsock` not loaded

```sh
sudo modprobe vhost_vsock
echo vhost_vsock | sudo tee /etc/modules-load.d/vhost_vsock.conf
```

### Symptom: user not in `kvm`/`cvdnetwork`/`render`

```sh
sudo usermod -aG kvm,cvdnetwork,render "$USER"
# Log out and back in so group membership applies.
```

### Symptom: `qemu-system-riscv64` is < 9.2

Distribution packages may be too old. Use a recent QEMU build (Debian
testing/unstable, Ubuntu 24.04+, or build from source). Cuttlefish riscv64
boot times collapse to ~10-30 min on a 32-core host with QEMU 9.2+; the
2023 baseline (~12 h) is no longer representative.

### Symptom: `sys.boot_completed` never reaches `1`

```sh
adb shell logcat -d -b all | tail -200
adb shell dmesg | tail -200
cat ~/cuttlefish_runtime/kernel.log | tail -200
```

Then run `bootloop-triage.sh` to capture the full failure snapshot.

## Feeding boot evidence into the completion gate

The completion gate consumes `cuttlefish_riscv64_boot.log` as required
Android evidence (alongside the other `eliza_ai_soc_*` logs and the
`cuttlefish_riscv64_smoke.log`):

```sh
python3 "$REPO/scripts/check_aosp_simulator_completion_gate.py"
```

The checker BLOCKS while the boot transcript is missing. It passes the
boot-log checks once the transcript carries `RESULT=0`, the
`eliza-evidence: status=PASS` marker, and the canonical
`virtual_device_smoke_only_not_boot_or_compatibility_evidence` boundary
marker - exactly what `cuttlefish-boot-gate.sh` writes on a clean run.

A FAIL transcript stays archived. The checker continues to BLOCK on it,
which is the desired behavior: failed boots must be triaged and reproduced
to a passing state, not hidden.

## References

- `sw/aosp-device/launch-cuttlefish-riscv64.sh`
- `sw/aosp-device/cuttlefish-boot-gate.sh`
- `sw/aosp-device/bootloop-triage.sh`
- `sw/aosp-device/capture-aosp-evidence.sh` (`cuttlefish-boot-full` mode)
- `docs/android/cuttlefish-riscv64-bringup.md` (manual bring-up recipe)
- `docs/android/riscv-bringup.md` (host package list and triage matrix)
- `docs/project/aosp-simulator-completion-gate.yaml`
