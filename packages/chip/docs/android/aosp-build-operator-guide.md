# AOSP riscv64 build operator guide

Operator-facing recipe for building AOSP (Cuttlefish riscv64) with the
`eliza_ai_soc` device overlay projected into the source tree. Pairs with:

- `packages/chip/sw/aosp-device/build-aosp-riscv64.sh` - the pipeline script.
- `packages/chip/sw/aosp-device/Dockerfile` - reproducible builder image.
- `packages/chip/sw/aosp-device/local_manifests/eliza.xml` - repo local-manifest
  fragment for the eliza_ai_soc overlay.
- `packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/` - the actual device
  tree (BoardConfig.mk, manifest.xml, sepolicy, kernel fragment, DTS, HAL stubs).

This guide owns the **build** half of the Cuttlefish bring-up. Downstream:

- **Task 29** - `launch_cvd` + boot validation. See
  `docs/android/cuttlefish-riscv64-bringup.md` and
  `docs/android/cuttlefish-agent-smoke-operator-recipe.md`.
- **Task 30** - artefact / evidence capture via
  `sw/aosp-device/capture-aosp-evidence.sh` and
  `scripts/check_aosp_simulator_completion_gate.py`.
- **Task 31** - HAL / VINTF / sepolicy gates via
  `scripts/check_software_bsp.py aosp` and
  `sw/aosp-device/scripts/check_aosp_bsp.py`.

The build script intentionally does **not** capture evidence files or run the
HAL gates. Hand the build outputs to Task 30 once `m` exits cleanly.

---

## Host preflight checklist

| Requirement | Why | How to check |
|---|---|---|
| Ubuntu 24.04 (or recent x86_64 Linux) | AOSP build tools assume glibc + apt baseline | `lsb_release -a` |
| x86_64 architecture | AOSP cross-builds riscv64 from x86_64 hosts only | `uname -m` |
| >= 64 GB RAM | `m -j$(nproc)` peaks ~1.5 GB / core; below 64 GB OOMs | `free -h` |
| >= 400 GB free disk on workspace | source ~150 GB + out ~150 GB + ccache ~80 GB | `df -h /path/to/workspace` |
| JDK 21 | AOSP `android-latest-release` requires JDK 21 | `java -version` |
| `repo` launcher | Sync/fetch driver. Bootstrapped by the script if missing | `command -v repo` |
| `git`, `curl`, `python3`, `rsync` | Generic build prerequisites | `command -v <tool>` |
| KVM (`/dev/kvm`) | Only required for `--launch-cvd`; Task 29 owns the real flow | `ls -l /dev/kvm` |
| `vhost_vsock` module loaded | Faster cuttlefish vsock (Task 29) | `lsmod \| grep vhost_vsock` |
| QEMU >= 9.2 with `qemu-system-riscv64` | Only required for `--launch-cvd` | `qemu-system-riscv64 --version` |

Host install on a clean Ubuntu 24.04 box (one-time):

```sh
sudo apt update
sudo apt install -y --no-install-recommends \
    build-essential git curl rsync unzip zip bc bison flex \
    python3 python3-venv python3-pip \
    openjdk-21-jdk-headless ccache jq file kmod \
    libssl-dev libxml2-utils xsltproc \
    libgl1 libglu1-mesa libxext6 libxrender1 \
    qemu-system-misc device-tree-compiler

# repo launcher (system-wide)
curl -fsSL https://storage.googleapis.com/git-repo-downloads/repo \
    | sudo install -m 755 /dev/stdin /usr/local/bin/repo

# KVM + vsock (only needed for --launch-cvd)
sudo modprobe vhost_vsock
sudo usermod -aG kvm,render "$USER"
```

If the host distro is anything other than Ubuntu 24.04, **use the Docker
builder** (next section). Don't try to patch missing libraries by hand.

---

## Step-by-step run (bare-metal Ubuntu 24.04 host)

From the elizaOS checkout:

```sh
# 1. Choose a workspace with >= 400 GB free.
export AOSP_WORK=$HOME/aosp-cf-riscv64
mkdir -p "$AOSP_WORK"

# 2. Run the pipeline. First run takes 90-150 min on a 32-core x86 box.
packages/chip/sw/aosp-device/build-aosp-riscv64.sh \
    --workspace "$AOSP_WORK" \
    --branch android-latest-release \
    --lunch-target aosp_cf_riscv64_phone-trunk_staging-userdebug \
    --jobs "$(nproc)"

# 3. Inspect the build report.
jq . "$AOSP_WORK/eliza-build-report.json"

# 4. Hand off to Task 30 (evidence capture).
packages/chip/sw/aosp-device/capture-aosp-evidence.sh "$AOSP_WORK" lunch
packages/chip/sw/aosp-device/capture-aosp-evidence.sh "$AOSP_WORK" vendorimage
packages/chip/sw/aosp-device/capture-aosp-evidence.sh "$AOSP_WORK" checkvintf
```

To run the eliza_ai_soc product instead of `aosp_cf_riscv64_phone`, switch the
overlay mode so the project is sync'd through a proper repo entry rather than
plain symlinks:

```sh
packages/chip/sw/aosp-device/build-aosp-riscv64.sh \
    --workspace "$AOSP_WORK" \
    --device-overlay-mode local-manifest \
    --lunch-target eliza_ai_soc-trunk_staging-userdebug
```

To pass through to `launch_cvd` after a successful build:

```sh
packages/chip/sw/aosp-device/build-aosp-riscv64.sh \
    --workspace "$AOSP_WORK" \
    --launch-cvd
```

Convenience only - **Task 29** owns the real launch + boot validation harness.

---

## Docker builder path (CI / non-Ubuntu hosts)

```sh
# 1. Build the image.
docker buildx build --check \
    -f packages/chip/sw/aosp-device/Dockerfile \
    -t eliza/aosp-riscv64-builder:dev \
    packages/chip/sw/aosp-device
docker buildx build \
    -f packages/chip/sw/aosp-device/Dockerfile \
    -t eliza/aosp-riscv64-builder:dev \
    packages/chip/sw/aosp-device

# 2. Run the pipeline inside the container. Mount the elizaOS checkout read-only
#    and a fresh workspace volume read-write.
docker run --rm -it \
    -v "$PWD:/eliza:ro" \
    -v "$HOME/aosp-cf-riscv64:/work/aosp" \
    eliza/aosp-riscv64-builder:dev \
    "/eliza/packages/chip/sw/aosp-device/build-aosp-riscv64.sh \
        --workspace /work/aosp \
        --branch android-latest-release \
        --lunch-target aosp_cf_riscv64_phone-trunk_staging-userdebug"
```

The container ships JDK 21, `repo`, and QEMU 9.2 already installed; it skips
the host-side `apt install` step entirely.

---

## Expected wall-clock times

| Stage | Cold (first run) | Warm (`m` incremental) |
|---|---|---|
| `repo init` + `repo sync` | 35-60 min | <2 min |
| `m -j$(nproc)` on 32-core x86_64 + 128 GB RAM | 60-90 min | 5-25 min |
| Total cold build | 90-150 min | 5-25 min |

ccache hit rate above ~60% after the second build dramatically reduces wall
time. The default `CCACHE_DIR=/work/.ccache` (Docker) or
`~/.ccache` (bare-metal) is preserved across runs.

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `java: command not found` or `unsupported class file major version` | JDK 17 (Ubuntu default) instead of 21 | `sudo apt install openjdk-21-jdk-headless && sudo update-alternatives --set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java` |
| `Killed` during `m` linking | OOM on a < 64 GB host | Lower `--jobs` to `$(($(nproc)/2))`, or run inside Docker with `--memory-swap=200g` |
| `repo: command not found` | Missing repo launcher | Re-run; the script bootstraps `repo` under `$WORKSPACE/.bin` automatically |
| `repo init` complains about partial-clone | Old `git` (< 2.34) | Upgrade git (`apt install git` on 24.04 is fine; older distros need ppa or source) |
| `error: device tree out of sync` after sync | Mixed symlink + local-manifest modes against the same workspace | Wipe `device/eliza/eliza_ai_soc` and re-run with one consistent `--device-overlay-mode` |
| `vsoc_riscv64/system.img` missing after `m` exits 0 | Lunch target mismatch with the product output dir | Verify `LUNCH_TARGET` matches the `out/target/product/<name>/` you expect; the report's `product_out_dir` is the source of truth |
| `launch_cvd` fails immediately | `/dev/kvm` missing or QEMU < 9.2 | Re-run preflight without `--skip-preflight`; see Task 29 doc for full launch flow |

For build failures inside `m`, the script captures full stdout/stderr to
`$WORKSPACE/eliza-build.log`. Grep for `FAILED:` first, then walk back to the
first ninja-emitted error.

---

## Hand-off contracts

After a successful build, three downstream agents take over:

### Task 29 - boot validation

Consumes `$WORKSPACE/out/host/linux-x86/bin/launch_cvd`,
`$WORKSPACE/out/target/product/vsoc_riscv64/*.img`. Does NOT use anything from
this guide beyond the build artifacts. See
`docs/android/cuttlefish-riscv64-bringup.md`.

### Task 30 - evidence capture

Consumes `$WORKSPACE` directly via `capture-aosp-evidence.sh`. The build report
at `$WORKSPACE/eliza-build-report.json` is informational; the canonical
evidence schema lives at `docs/android/boot-transcript.schema.json`.

### Task 31 - HAL / VINTF / sepolicy gates

Consumes `$WORKSPACE/out/target/product/eliza_ai_soc/` (when built against the
eliza_ai_soc lunch combo). See `scripts/check_software_bsp.py aosp` and
`sw/aosp-device/scripts/check_aosp_bsp.py`.

---

## What this guide explicitly does NOT cover

- Building Android for the e1 silicon target itself (no hardware exists yet).
- Booting on real RISC-V boards (e.g. VisionFive). Cuttlefish is a
  reference-only virtual device.
- CTS / VTS execution. Task 30 + Task 31 will gate that against captured
  evidence; do not run CTS from this guide.
- AVB / verified boot / OTA. `fstab.eliza` documents AVB as `FUTURE`.
- Google Mobile Services / Play certification. This is an AOSP-only build.
