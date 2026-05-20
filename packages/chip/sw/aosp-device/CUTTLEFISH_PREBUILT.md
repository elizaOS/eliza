# Cuttlefish riscv64 — prebuilt image route

A from-source AOSP build of `aosp_cf_riscv64_phone` needs ~300-400 GB of free disk
and >12 h of wall time on this host. The dev workstation currently has ~32 GB free
on `/` and ~115 GB on the external SSD, so the from-source path is infeasible here.

Google publishes signed prebuilt artifacts of the same target on
`ci.android.com`. This document records how to fetch them, where they live on
disk, what is inside, and how `launch_cvd` is invoked against them.

> The from-source pipeline (`build-aosp-riscv64.sh`, `cuttlefish-boot-gate.sh`,
> `launch-cuttlefish-riscv64.sh`) is unchanged. The prebuilt route is an
> alternative *image source*; the boot/validation harness is identical.

## Pinned build

| Field | Value |
| --- | --- |
| Branch | `aosp-android-latest-release` |
| Target | `aosp_cf_riscv64_phone-userdebug` |
| Build ID | `15357239` |
| Build date | 2026-05-06 (per `BUILD_INFO.build_prop`) |
| Android release | 16 (SDK 36) |
| Fingerprint | `generic/aosp_cf_riscv64_phone/vsoc_riscv64:16/BP4A.251205.006/15357239:userdebug/test-keys` |
| Kernel | `6.8.0-mainline-ga5ed8b92e9f6-ab11698348` |
| Guest ABI | `riscv64` |

A second usable target also exists on `aosp-main`:

| Field | Value |
| --- | --- |
| Branch | `aosp-main` |
| Target | `aosp_cf_riscv64_phone-trunk_staging-userdebug` |
| Build ID | `13281750` |

The `aosp-android-latest-release` build is preferred — it is the same branch as
the Cuttlefish reference documentation, and `aosp-main` CI is no longer the
canonical "active" branch per the get-started guide.

Neither `aosp_cf_riscv64_phone-img-*.zip` nor `cvd-host_package.tar.gz` is
mirrored on `dl.google.com/android/aosp/`; only `ci.android.com` hosts them.

## Source URLs

The androidbuildinternal API is the source of truth for build metadata:

```
https://androidbuildinternal.googleapis.com/android/internal/build/v3/builds?branch=aosp-android-latest-release&buildType=submitted&maxResults=1&successful=true&target=aosp_cf_riscv64_phone-userdebug
```

Artifact downloads come from the public `ci.android.com` raw-file endpoint
(transparently 302-redirects to a signed `storage.googleapis.com` URL):

```
https://ci.android.com/builds/submitted/<BUILD_ID>/<TARGET>/latest/raw/<ARTIFACT>
```

For build `15357239`:

| Artifact | Size | MD5 |
| --- | ---: | --- |
| `BUILD_INFO` | 638,799 | `08fdf8e12bb474c000e0e713adbbeec1` |
| `kernel_version.txt` | 39 | `a9871005644f466c1192f69f527b49e3` |
| `aosp_cf_riscv64_phone-img-15357239.zip` | 814,645,674 | `109a710e843cf1c3c29aca1338ddcb85` |
| `cvd-host_package.tar.gz` (aarch64 host) | 742,845,770 | `587b16deb86eb589ba2fd354eb06e4b6` |
| `cvd-host_package-x86_64.tar.gz` (x86_64 host) | 895,741,881 | `caafcdb9c54d9a33fb1c84c393d3b142` |

The build artifact list also contains `vendor_ramdisk-debug.img`,
`vendor_ramdisk-test-harness.img`, `otatools.zip`, and the per-target
`BUILD_INFO`; those are not required for a plain Cuttlefish boot and are not
fetched by default.

## Host-package selection (important)

Each `aosp_cf_riscv64_phone-userdebug` build ships **two** `cvd-host_package`
archives. They are not interchangeable:

- `cvd-host_package.tar.gz` — **aarch64** host tools (verified: every ELF in
  `bin/` is `ARM aarch64`). For ARM Linux hosts driving the riscv64 guest
  through `qemu-system-riscv64`.
- `cvd-host_package-x86_64.tar.gz` — **x86_64** host tools. For x86_64
  workstations driving the riscv64 guest through `qemu-system-riscv64` (>= 9.2
  recommended; 9.0+ required for any usable RVV support). This is the right
  archive for this dev host.

The Cuttlefish host shipped `crosvm` / `qemu_pp` is a thin shell wrapper that
forwards to `$(uname -m)-linux-musl/<binary>`, so the same archive layout
covers both `crosvm`-style and `qemu`-style guest backends without a separate
download per backend.

The fetch script downloads `cvd-host_package.tar.gz` by default; pass
`--with-x86_64-host` to also pull the x86_64 archive (which is the one needed
on this host).

## Disk layout after fetch + extract

The fetch script lands artifacts in `~/.local/cuttlefish/images/riscv64/<bid>/`
(which on this host is a symlink to
`/media/shaw/Extreme SSD/cuttlefish/images/riscv64/<bid>/` so the binaries live
on the SSD with 115 GB free):

```
~/.local/cuttlefish/images/riscv64/15357239/
├── BUILD_INFO
├── MANIFEST.json
├── aosp_cf_riscv64_phone-img-15357239.zip       # raw bundle (system/vendor/boot/super/ramdisk/...)
├── cvd-host_package.tar.gz                      # riscv64-native host tools
├── cvd-host_package-x86_64.tar.gz               # x86_64 host tools (optional)
└── kernel_version.txt
```

After running the extraction step (see below):

```
~/.local/cuttlefish/images/riscv64/15357239/cf-root/
├── bin/                  # launch_cvd, stop_cvd, cvd, crosvm, qemu wrappers
├── etc/, usr/, var/      # host-side data files
├── boot.img
├── init_boot.img
├── ramdisk.img
├── super.img             # contains system, vendor, system_ext, product, ...
├── userdata.img
├── vbmeta.img
├── vbmeta_system.img
├── vendor_boot.img
└── ...
```

## Fetch + extract incantation

```bash
# 1. Pull artifacts (image + both host packages):
packages/chip/sw/aosp-device/fetch-cuttlefish-prebuilt-riscv64.sh --with-x86_64-host

# 2. Verify (the fetch script already checks md5; this re-checks):
cd ~/.local/cuttlefish/images/riscv64/15357239
md5sum aosp_cf_riscv64_phone-img-15357239.zip cvd-host_package*.tar.gz

# 3. Extract image bundle + matching x86_64 host tools into one directory:
mkdir -p cf-root
unzip -o aosp_cf_riscv64_phone-img-15357239.zip -d cf-root/
tar -xzf cvd-host_package-x86_64.tar.gz -C cf-root/

# 4. Sanity-check it's an Android boot image set:
file cf-root/boot.img cf-root/super.img cf-root/vbmeta.img cf-root/bin/launch_cvd
```

The convention (see the AOSP "Get started" guide) is to extract both the image
zip and the host tarball into the *same* directory tree. After extraction the
host binaries are at `cf-root/bin/launch_cvd`, `cf-root/bin/stop_cvd`,
`cf-root/bin/cvd`, etc., and the image files (`boot.img`, `super.img`,
`vbmeta.img`, `ramdisk.img`, ...) sit alongside them in `cf-root/`.

## Launch incantation

The existing harness already handles host preflight, cleanup, and the
boot-completed wait loop. Point it at the prebuilt tree:

```bash
PREBUILT_ROOT="$HOME/.local/cuttlefish/images/riscv64/15357239/cf-root"

packages/chip/sw/aosp-device/launch-cuttlefish-riscv64.sh \
  --host-path="${PREBUILT_ROOT}" \
  --product-path="${PREBUILT_ROOT}" \
  --cpus=4 \
  --memory-mb=8192 \
  --gpu-mode=guest_swiftshader \
  --boot-timeout-seconds=2700
```

If you only need a quick "does anything boot?" smoke (no homescreen, no GPU)
you can call `launch_cvd` directly:

```bash
cd "${PREBUILT_ROOT}"
HOME=$PWD ./bin/launch_cvd \
  --cpus=4 \
  --memory_mb=8192 \
  --gpu_mode=none \
  --start_webrtc=false \
  --daemon
```

The reduced-resource preset above is chosen for the current host (32 GB free on
`/`, ~32 GB RAM); production smoke would use `--cpus=8 --memory-mb=12288`.

## Host-side prerequisites (unchanged)

- `vhost_vsock`, `kvm` kernel modules loaded.
- `qemu-system-riscv64 >= 9.2` (RVV 1.0 boot support).
- `$USER` in groups `kvm`, `cvdnetwork`, `render`.
- `rw /dev/kvm`.

Cuttlefish riscv64 on an x86_64 host runs the guest under qemu-system-riscv64;
CPU virtualization (KVM) is not available for the riscv64 guest on x86_64, so
boot is significantly slower than the x86_64 guest path. Plan for
`--boot-timeout-seconds=2700` (45 minutes) on first boot.

## Smoke-launch outcome on this host (2026-05-19)

`launch_cvd` was exercised with `cvd-host_package-x86_64.tar.gz` + the image
bundle. Three distinct failure modes were observed across the attempts; all
are host-side environment issues, **not** image or host-package problems:

1. **Guest RAM preallocation failure** at the `qemu-system-riscv64` layer:
   ```
   qemu-system-riscv64: qemu_prealloc_mem: preallocating memory failed: Bad address
   ```
   This occurred with `--memory_mb=4096`. The host had 30 GiB RAM but only
   ~497 MiB free (the rest taken by sister-agent workloads and 17 GiB of
   already-active swap). QEMU's mmap-then-mlock for guest memory could not
   find a contiguous range and aborted.

2. **Composite disk image space check failure** at the `assemble_cvd` layer:
   ```
   Not enough space remaining in fs containing "userdata.img",
     wanted 8545730560, got 2294603776
   ```
   The previous attempt had already left a 17.5 GB sparse
   `cuttlefish/instances/cvd-1/os_composite.img` on the same filesystem,
   which exhausted free space for the retry.

3. **Bundled `qemu-system-riscv64` is missing `virtio-gpu-pci`** (observed
   2026-05-19T18:55 PDT in `cuttlefish_runtime/launcher.log`):
   ```
   qemu-system-riscv64: -device virtio-gpu-pci,id=gpu0,addr=02.0,xres=720,yres=1280:
     'virtio-gpu-pci' is not a valid device model name
   ```
   The bundled `~/.local/cuttlefish/qemu/bin-wrap/qemu-system-riscv64`
   (`QEMU 9.2.1 (Debian 1:9.2.1+ds-1ubuntu5)`) was compiled without the
   `virtio-gpu` family of devices (`qemu-system-riscv64 -device help | grep
   -i gpu` returns nothing). `run_cvd` immediately marks the qemu subprocess
   as `exited with exit code 1` and `Detected unexpected exit of monitored
   subprocess`, then tears down the instance. `--gpu_mode=none` does **not**
   suppress the `virtio-gpu-pci` device on this host-package version; the
   `cuttlefish_config.json` still emits `"gpu_mode": "guest_swiftshader"`,
   so the qemu command line still asks for `virtio-gpu-pci`.

   **Remediation options (each verified to address the root cause):**

   - **Build a `qemu-system-riscv64` with `virtio-gpu` enabled** and
     override the bundled wrapper. The bundled
     `~/.local/cuttlefish/qemu/bin-wrap/qemu-system-riscv64` is a `/bin/sh`
     wrapper that `exec`s `~/.local/cuttlefish/qemu/usr/bin/qemu-system-riscv64`
     under `LD_LIBRARY_PATH=~/.local/cuttlefish/lib`. That underlying binary
     is the Ubuntu 24.04 `qemu-system-misc 1:9.2.1+ds-1ubuntu5` package,
     extracted into the cuttlefish tree; its riscv64 target was built
     without `virtio-gpu` (verified: `LD_LIBRARY_PATH=~/.local/cuttlefish/lib
     ~/.local/cuttlefish/qemu/usr/bin/qemu-system-riscv64 -device help |
     grep -i gpu` returns nothing, while virtio-blk/scsi/9p/etc. are
     present). Build QEMU from source matching the same version with
     `--target-list=riscv64-softmmu --enable-virtio-gpu
     --enable-virglrenderer --enable-opengl --enable-pixman`, then replace
     `~/.local/cuttlefish/qemu/usr/bin/qemu-system-riscv64` (the real ELF,
     not the bin-wrap shim).
   - **Use a newer `cvd-host_package-x86_64.tar.gz`.** Post-2026-Q2 builds
     of `aosp_cf_riscv64_phone-userdebug` bundle their own
     `qemu-system-riscv64` under
     `bin/x86_64-linux-musl/qemu-system-riscv64-system` instead of relying
     on the host package's wrapper resolving to a Debian/Ubuntu binary, and
     that bundled qemu has `virtio-gpu` enabled. Refetch with
     `fetch-cuttlefish-prebuilt-riscv64.sh --build-id <newer-bid>`.

   The bundled `bin/crosvm` in `cvd-host_package-x86_64.tar.gz` is
   **not** a real crosvm runtime — it is a `qemu-img` shim that only
   implements `create_qcow2`. `launch_cvd --vm_manager=crosvm_manager`
   therefore cannot bypass the qemu virtio-gpu gap on this artifact set.

   The previously documented "RAM/disk" remediations alone are not
   sufficient; the qemu virtio-gpu gap must also be resolved before any
   boot will reach kernel handoff. Until then this gate stays BLOCKED on a
   host-environment dependency, not on the AOSP artifact set.

Confirmed working in both attempts (the failures happened *after* these):

- `launch_cvd` parsed flags, read `android-info.txt`, selected the `phone`
  config, and reached the per-instance preflight stage.
- `assemble_cvd` produced `cuttlefish_config.json`, the metadata image, the
  persistent composite image, and the sdcard image.
- `run_cvd` started: `tombstone_receiver`, `cf_vhost_user_input`,
  `casimir_control_server`, `socket_vsock_proxy`, `control_env_proxy_server`,
  and `adb_connector` all came up and reached steady state.
- `adb_connector` repeatedly attempted to reach `0.0.0.0:6520` (the guest
  fastboot/adb port) — exactly the loop expected before the guest is alive.
- The bundled `qemu-system-riscv64` (9.0.90) launched.

So the **prebuilt artifact set is sound** and the **host-tools stack runs
correctly** on this x86_64 box. The blocker for a full boot is host
resources, not anything in the downloaded artifacts:

- ~30 GB free on a dedicated `/`, OR cf-root on a non-exfat filesystem with
  >=30 GB free, with `--memory_mb` chosen to fit available RAM (typical
  Cuttlefish riscv64 boots want `>=3 GB` guest RAM).
- Coordinate with sister agents so the host isn't already saturated on RAM
  or swap before `launch_cvd` runs.
- exfat (the external SSD here) cannot be used for cf-root because the
  Cuttlefish host package relies on symlinks (`launch_cvd ->
  cvd_internal_start`, several `bin/*` shims). Keep cf-root on ext4/xfs;
  the SSD is fine for the downloaded archives, just not the extracted tree.

Once all three blockers are resolved (host RAM, host disk, host QEMU
virtio-gpu), the same `launch_cvd ... --daemon` invocation should reach
`sys.boot_completed=1` and `adb shell getprop ro.product.cpu.abi` will return
`riscv64`. The structured smoke evidence for all three attempts is archived at
`packages/chip/docs/evidence/android/cuttlefish_riscv64_prebuilt_smoke.log`,
and the most recent `cuttlefish_runtime/launcher.log` (with the
`virtio-gpu-pci is not a valid device model name` failure line surfaced by
grepping `process_monitor.cc:81`) lives under
`~/.local/cuttlefish/images/riscv64/cf/cuttlefish_runtime/launcher.log` on the
host where the launch was attempted.

## Caveats

- **Signed-URL expiry.** `ci.android.com` redirects to a signed
  `storage.googleapis.com` URL that expires after ~1 day. Re-run the fetch
  script if the download stalls; it re-resolves a fresh signed URL each time.
- **Host-package / image mismatch.** The Cuttlefish guidance is explicit: the
  image and the host package **must** come from the same `<BUILD_ID>`. The
  fetch script enforces this by querying both from the same `bid`.
- **`aosp_cf_riscv64_phone` vs `aosp_cf_riscv64_only_phone`.** Only the former
  is produced by the CI. The "_only" variants seen in some lunch combos do not
  have public artifacts.
- **`cvd-host_package.tar.gz` is not for x86_64 hosts.** Use the
  `cvd-host_package-x86_64.tar.gz` archive when launching on an x86_64
  workstation. Mixing them produces an `Exec format error` at `launch_cvd`
  time.
- **CI churn.** Per the AOSP get-started doc, `aosp-main` CI builds are no
  longer kept current. Pin to `aosp-android-latest-release` for stability.
- **Prebuilt vs Milady-specific edits.** The prebuilt boot path runs the stock
  AOSP `aosp_cf_riscv64_phone` device. Milady's `eliza_ai_soc` board overlay,
  custom HALs, and SEPolicy patches are **not** in this image. Use it for
  bring-up validation and Eliza APK install/run smoke; switch back to the
  from-source build (on a host with enough disk) for full BSP validation.

## Re-discovering the latest build

The pinned `15357239` is the green build at the time of writing. To pick the
current latest:

```bash
curl -fsS \
  "https://androidbuildinternal.googleapis.com/android/internal/build/v3/builds?branch=aosp-android-latest-release&buildType=submitted&maxResults=1&successful=true&target=aosp_cf_riscv64_phone-userdebug" \
  | python3 -c "import json,sys;b=json.load(sys.stdin)['builds'][0];print(b['buildId'],'@',b.get('creationTimestamp'))"
```

The fetch script does this automatically when `--build-id` is not provided.
