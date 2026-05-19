# Cuttlefish riscv64 Bring-Up Recipe

This is a runnable recipe for booting Android on the Cuttlefish riscv64 virtual
device (`aosp_cf_riscv64_phone`). It is the fastest available Android-on-RISC-V
path and is the pre-silicon validation surface for this repo's Android claims.

This recipe is for the **simulator track only**. A successful Cuttlefish boot
does not prove anything about `e1_soc` silicon, drivers, or HALs.

## Scope

- Boot AOSP `aosp_cf_riscv64_phone-userdebug` under Cuttlefish.
- Collect the canonical boot-log markers so a transcript can be archived as
  Android bring-up evidence.
- Provide deterministic `launch_cvd` flags for shell-first and home-screen runs.

Out of scope: device-tree integration (`device/eliza`), CTS/VTS execution,
NPU HAL integration. See `docs/android/cts-vts-smoke-plan.md` and
`docs/arch/android-contract.md`.

## Host Prerequisites

Linux x86_64 host, hardware virtualization enabled. See
`docs/android/riscv-bringup.md` for the host package list. The bare minimum:

```sh
test -e /dev/kvm                           # KVM available
groups "$USER" | grep -E 'kvm|cvdnetwork|render'
repo --version
adb --version
qemu-system-riscv64 --version              # expect >= 8.1 (>= 9.0 preferred)
```

A full AOSP build needs 250 GB free disk and 32 GB RAM. The Cuttlefish guest
needs 8 GB RAM and 4 vCPUs minimum.

From this repository, run the host-only preflight before attempting capture:

```sh
AOSP_DIR=/path/to/aosp make aosp-linux-preflight
```

The preflight checks `AOSP_DIR`, `build/envsetup.sh`, `/dev/kvm`, `repo`,
`adb`, and `launch_cvd`/`cvd` visibility. It may write
`build/reports/aosp_linux_preflight.json`, but it does not create
`docs/evidence/android/*.log` and is not AOSP build, boot, CTS, VTS, or
e1-chip hardware evidence.

## Repo Init and Sync

Use the `android-latest-release` branch. riscv64 Cuttlefish targets are present
only on recent branches; do not pin to an older `android-*` release branch.

```sh
mkdir -p ~/aosp-riscv64
cd ~/aosp-riscv64

repo init -u https://android.googlesource.com/platform/manifest \
  -b android-latest-release \
  --partial-clone --clone-filter=blob:limit=10M

repo sync -c -j"$(nproc)" --fail-fast --no-clone-bundle --no-tags
```

Record the manifest snapshot for the boot report:

```sh
repo manifest -r -o "$PWD/eliza-cf-manifest.xml"
sha256sum eliza-cf-manifest.xml
```

## Lunch and Build

```sh
source build/envsetup.sh
lunch aosp_cf_riscv64_phone-trunk_staging-userdebug
# Fallback if trunk_staging is unavailable on this branch:
#   lunch aosp_cf_riscv64_phone-userdebug

# Required AOSP build identity printed by lunch: capture for the report.
get_build_var BUILD_ID
get_build_var TARGET_PRODUCT
get_build_var TARGET_BUILD_VARIANT
get_build_var TARGET_ARCH        # must be riscv64

m -j"$(nproc)"
```

Expected artifacts:

| Path | Purpose |
|---|---|
| `out/target/product/vsoc_riscv64/system.img` | Cuttlefish system image |
| `out/target/product/vsoc_riscv64/vendor.img` | Cuttlefish vendor image |
| `out/host/linux-x86/bin/launch_cvd` | Host launcher |
| `out/host/linux-x86/bin/stop_cvd` | Host stopper |
| `out/host/linux-x86/bin/cvd` | Cuttlefish control CLI |

## Launch (Shell-First)

Shell-first run uses `--gpu_mode=none` so boot is not blocked on graphics.

```sh
launch_cvd \
  --cpus=4 \
  --memory_mb=8192 \
  --gpu_mode=none \
  --report_anonymous_usage_stats=n \
  --daemon

adb wait-for-device
```

### Required boot markers

The transcript that gets archived must contain all of these. They are checked
verbatim by `scripts/intake_android_evidence.py`.

```sh
adb shell getprop ro.product.cpu.abi      # expect: riscv64
adb shell getprop ro.product.cpu.abilist  # expect: riscv64
adb shell uname -m                        # expect: riscv64
adb shell getprop sys.boot_completed      # expect: 1
adb shell getprop ro.build.version.sdk    # capture; non-empty
adb shell getprop ro.build.id             # capture; non-empty
adb shell getenforce                      # expect: Enforcing
```

### Archive the transcript

```sh
mkdir -p out/cf-riscv64
adb shell logcat -d -b all          > out/cf-riscv64/logcat.txt
adb shell dmesg                     > out/cf-riscv64/dmesg.txt
adb shell getprop                   > out/cf-riscv64/getprop.txt
adb shell lshal                     > out/cf-riscv64/lshal.txt || true
cp ~/cuttlefish_runtime/kernel.log    out/cf-riscv64/kernel.log
cp ~/cuttlefish_runtime/launcher.log  out/cf-riscv64/launcher.log

stop_cvd
```

## Launch (Home-Screen)

Use this once shell-first is reliable. Adds SwiftShader for GLES.

```sh
launch_cvd \
  --cpus=8 \
  --memory_mb=8192 \
  --gpu_mode=guest_swiftshader \
  --report_anonymous_usage_stats=n \
  --daemon

adb wait-for-device

# Wait up to ~5 min for boot_completed; do not assume immediate.
for _ in $(seq 1 60); do
  [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ] && break
  sleep 5
done

adb shell getprop sys.boot_completed         # expect: 1
adb shell dumpsys SurfaceFlinger --display-id
adb shell logcat -d -b all > out/cf-riscv64/home-logcat.txt
stop_cvd
```

## Boot Success Definition

A run is "Android booted on Cuttlefish riscv64" only when ALL of the following
are recorded in archived files in the same `out/cf-riscv64/` directory:

1. `ro.product.cpu.abi=riscv64`
2. `uname -m` reports `riscv64`
3. `sys.boot_completed=1` (shell-first OR home-screen)
4. `adb shell true` returned 0
5. AOSP `BUILD_ID` and manifest sha256 are recorded
6. `kernel.log` shows no panics and includes a `Run /init as init process` line
7. `getenforce` returns `Enforcing`

Anything less is a partial result. Record it as such; do not claim Android boot.

## Failure Triage

See `docs/android/riscv-bringup.md` "Failure Triage" — the same table applies.

## References

- AOSP riscv64 tracking: https://github.com/google/android-riscv64
- Cuttlefish: https://source.android.com/docs/setup/create/cuttlefish
- launch_cvd flags: https://source.android.com/docs/setup/create/cuttlefish-ref-launch
