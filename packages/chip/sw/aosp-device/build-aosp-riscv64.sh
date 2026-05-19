#!/usr/bin/env bash
# build-aosp-riscv64.sh - AOSP build pipeline for the Cuttlefish riscv64 target,
# overlaid with the eliza_ai_soc device tree.
#
# Default lunch combo:  aosp_cf_riscv64_phone-trunk_staging-userdebug
# Optional lunch combo: eliza_ai_soc-trunk_staging-userdebug (requires the
#                       overlay-mode=local-manifest path so the project is sync'd
#                       under the AOSP tree with a proper repo project entry).
#
# This script is intentionally idempotent enough to re-run incrementally:
#   * Pre-flight is non-destructive.
#   * `repo init` only runs if the workspace is empty / missing .repo.
#   * `repo sync` is incremental; pass --resync to force a fresh sync.
#   * Build artifacts are captured to a build-report.json under the workspace.
#
# Sibling tasks (DO NOT extend here):
#   Task 29 owns launch_cvd / Cuttlefish boot validation (see
#     docs/android/cuttlefish-riscv64-bringup.md).
#   Task 30 owns evidence capture (capture-aosp-evidence.sh).
#   Task 31 owns HAL / VINTF / sepolicy gates
#     (scripts/check_software_bsp.py aosp + sw/aosp-device/scripts/check_aosp_bsp.py).
set -euo pipefail

SCRIPT_PATH=$(readlink -f "$0")
SCRIPT_DIR=$(dirname "$SCRIPT_PATH")
CHIP_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
ELIZA_ROOT=$(cd -- "$CHIP_ROOT/../.." && pwd)
DEVICE_OVERLAY_SRC="$SCRIPT_DIR/device/eliza/eliza_ai_soc"
LOCAL_MANIFEST_TEMPLATE="$SCRIPT_DIR/local_manifests/eliza.xml"

usage() {
  cat <<'USAGE'
usage: build-aosp-riscv64.sh [options]

required:
  --workspace PATH        AOSP source workspace (must have ~400 GB free).

build options:
  --branch BRANCH         AOSP manifest branch (default: android-latest-release).
  --lunch-target COMBO    Lunch target
                          (default: aosp_cf_riscv64_phone-trunk_staging-userdebug).
  --jobs N                Parallelism for repo sync and `m`
                          (default: $(nproc)).
  --device-overlay-mode MODE
                          symlink (default) - drop symlinks under
                                              device/eliza/eliza_ai_soc/.
                          local-manifest    - install local_manifests/eliza.xml
                                              with the remote rewritten to the
                                              Milady checkout, then `repo sync`
                                              again so repo materializes the
                                              project + linkfiles.

flags:
  --resync                Force a fresh `repo sync` (drops .repo project staging).
  --skip-preflight        Skip host pre-flight checks (NOT for CI).
  --skip-sync             Skip `repo init` + `repo sync` (workspace must already
                          be populated).
  --skip-build            Skip the actual `m` step. Useful for sync-only smoke.
  --launch-cvd            Pass through to launch_cvd after a successful build.
                          Convenience only; Task 29 owns the real launch flow.
  --report PATH           Write the structured build report JSON to PATH
                          (default: <workspace>/eliza-build-report.json).
  -h, --help              Show this help.

env overrides:
  AOSP_MANIFEST_URL       Defaults to https://android.googlesource.com/platform/manifest
  AOSP_JDK_MAJOR          JDK major version required on host (default: 21)
  AOSP_MIN_DISK_GB        Default 400
  AOSP_MIN_RAM_GB         Default 64
  AOSP_MIN_QEMU_VERSION   Default 9.2 (only checked with --launch-cvd)

This script does not commit anything and does not push. Build outputs are
treated as host-local artifacts and are not checked in.
USAGE
}

log()  { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '[%s] FATAL: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }
warn() { printf '[%s] WARN:  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

WORKSPACE=""
BRANCH="android-latest-release"
LUNCH_TARGET="aosp_cf_riscv64_phone-trunk_staging-userdebug"
JOBS=$(nproc 2>/dev/null || echo 4)
OVERLAY_MODE="symlink"
RESYNC=0
SKIP_PREFLIGHT=0
SKIP_SYNC=0
SKIP_BUILD=0
LAUNCH_CVD=0
REPORT_PATH=""

AOSP_MANIFEST_URL="${AOSP_MANIFEST_URL:-https://android.googlesource.com/platform/manifest}"
AOSP_JDK_MAJOR="${AOSP_JDK_MAJOR:-21}"
AOSP_MIN_DISK_GB="${AOSP_MIN_DISK_GB:-400}"
AOSP_MIN_RAM_GB="${AOSP_MIN_RAM_GB:-64}"
AOSP_MIN_QEMU_VERSION="${AOSP_MIN_QEMU_VERSION:-9.2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace)            WORKSPACE=${2:?--workspace requires a path}; shift 2 ;;
    --workspace=*)          WORKSPACE=${1#--workspace=}; shift ;;
    --branch)               BRANCH=${2:?--branch requires a value}; shift 2 ;;
    --branch=*)             BRANCH=${1#--branch=}; shift ;;
    --lunch-target)         LUNCH_TARGET=${2:?--lunch-target requires a value}; shift 2 ;;
    --lunch-target=*)       LUNCH_TARGET=${1#--lunch-target=}; shift ;;
    --jobs)                 JOBS=${2:?--jobs requires a value}; shift 2 ;;
    --jobs=*)               JOBS=${1#--jobs=}; shift ;;
    --device-overlay-mode)  OVERLAY_MODE=${2:?--device-overlay-mode requires a value}; shift 2 ;;
    --device-overlay-mode=*) OVERLAY_MODE=${1#--device-overlay-mode=}; shift ;;
    --report)               REPORT_PATH=${2:?--report requires a path}; shift 2 ;;
    --report=*)             REPORT_PATH=${1#--report=}; shift ;;
    --resync)               RESYNC=1; shift ;;
    --skip-preflight)       SKIP_PREFLIGHT=1; shift ;;
    --skip-sync)            SKIP_SYNC=1; shift ;;
    --skip-build)           SKIP_BUILD=1; shift ;;
    --launch-cvd)           LAUNCH_CVD=1; shift ;;
    -h|--help)              usage; exit 0 ;;
    *)                      die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$WORKSPACE" ] || die "--workspace is required"
case "$OVERLAY_MODE" in
  symlink|local-manifest) ;;
  *) die "--device-overlay-mode must be 'symlink' or 'local-manifest' (got: $OVERLAY_MODE)" ;;
esac

mkdir -p "$WORKSPACE"
WORKSPACE=$(cd -- "$WORKSPACE" && pwd)
[ -z "$REPORT_PATH" ] && REPORT_PATH="$WORKSPACE/eliza-build-report.json"

# Sanity: device overlay we expect to project must exist in the Milady repo.
for required in \
  "$DEVICE_OVERLAY_SRC/AndroidProducts.mk" \
  "$DEVICE_OVERLAY_SRC/eliza_ai_soc.mk" \
  "$DEVICE_OVERLAY_SRC/BoardConfig.mk" \
  "$DEVICE_OVERLAY_SRC/device.mk" \
  "$DEVICE_OVERLAY_SRC/manifest.xml" \
  "$DEVICE_OVERLAY_SRC/eliza_e1.xml" \
  "$LOCAL_MANIFEST_TEMPLATE"; do
  [ -f "$required" ] || die "missing repo artifact: $required"
done

preflight() {
  log "preflight: host arch / disk / ram / jdk / repo / qemu"
  local host_arch; host_arch=$(uname -m)
  if [ "$host_arch" != "x86_64" ]; then
    die "host arch must be x86_64 for AOSP cross-build (got: $host_arch). riscv64 hosts are not supported."
  fi

  local free_gb
  free_gb=$(df -BG --output=avail "$WORKSPACE" | awk 'NR==2 { sub(/G$/, "", $1); print $1 }')
  if [ -z "$free_gb" ] || [ "$free_gb" -lt "$AOSP_MIN_DISK_GB" ]; then
    die "workspace $WORKSPACE has ${free_gb:-?} GB free; need >= ${AOSP_MIN_DISK_GB} GB"
  fi

  local total_kb ram_gb
  total_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || echo 0)
  ram_gb=$(( total_kb / 1024 / 1024 ))
  if [ "$ram_gb" -lt "$AOSP_MIN_RAM_GB" ]; then
    warn "host has ${ram_gb} GB RAM; recommended >= ${AOSP_MIN_RAM_GB} GB. Build may OOM at -j${JOBS}."
  fi

  if ! command -v java >/dev/null 2>&1; then
    die "java not found on PATH. AOSP needs JDK ${AOSP_JDK_MAJOR}."
  fi
  local jver
  jver=$(java -version 2>&1 | awk -F\" '/version/ { print $2 }' | head -n1 || true)
  local jmajor
  jmajor=${jver%%.*}
  case "$jmajor" in
    [0-9]|[0-9][0-9]) : ;;
    *) jmajor=0 ;;
  esac
  if [ "$jmajor" -lt "$AOSP_JDK_MAJOR" ]; then
    die "JDK >= ${AOSP_JDK_MAJOR} required (found: ${jver:-unknown}). Install openjdk-${AOSP_JDK_MAJOR}-jdk."
  fi

  for tool in git curl python3 rsync; do
    command -v "$tool" >/dev/null 2>&1 || die "host missing required tool: $tool"
  done

  if [ "$LAUNCH_CVD" -eq 1 ]; then
    if [ ! -e /dev/kvm ]; then die "--launch-cvd needs /dev/kvm (KVM not present)"; fi
    if [ ! -e /dev/vhost-vsock ]; then warn "/dev/vhost-vsock missing; cuttlefish vsock will fall back to slow path"; fi
    if ! command -v qemu-system-riscv64 >/dev/null 2>&1; then
      die "--launch-cvd needs qemu-system-riscv64 (>= ${AOSP_MIN_QEMU_VERSION})"
    fi
    local qver
    qver=$(qemu-system-riscv64 --version 2>/dev/null | awk 'NR==1 { for (i=1; i<=NF; i++) if ($i ~ /^[0-9]+\.[0-9]+/) { print $i; exit } }')
    if [ -n "$qver" ]; then
      local qmajor qminor
      qmajor=${qver%%.*}
      qminor=${qver#*.}; qminor=${qminor%%.*}
      local min_major min_minor
      min_major=${AOSP_MIN_QEMU_VERSION%%.*}
      min_minor=${AOSP_MIN_QEMU_VERSION#*.}
      if [ "$qmajor" -lt "$min_major" ] || { [ "$qmajor" -eq "$min_major" ] && [ "$qminor" -lt "$min_minor" ]; }; then
        die "qemu-system-riscv64 ${qver} < required ${AOSP_MIN_QEMU_VERSION}"
      fi
    fi
  fi

  log "preflight: ok (arch=$host_arch, free=${free_gb}G, ram=${ram_gb}G, jdk=${jver:-?})"
}

bootstrap_repo() {
  if command -v repo >/dev/null 2>&1; then
    log "repo: already on PATH ($(command -v repo))"
    return 0
  fi
  log "repo: bootstrapping into $WORKSPACE/.bin"
  mkdir -p "$WORKSPACE/.bin"
  curl -fsSL https://storage.googleapis.com/git-repo-downloads/repo \
    -o "$WORKSPACE/.bin/repo"
  chmod +x "$WORKSPACE/.bin/repo"
  export PATH="$WORKSPACE/.bin:$PATH"
  command -v repo >/dev/null 2>&1 || die "repo bootstrap failed"
}

run_repo_init() {
  log "repo init: -u $AOSP_MANIFEST_URL -b $BRANCH"
  cd "$WORKSPACE"
  if [ "$RESYNC" -eq 1 ] && [ -d "$WORKSPACE/.repo" ]; then
    log "repo: --resync set; clearing .repo/project-objects and .repo/projects"
    rm -rf "$WORKSPACE/.repo/project-objects" "$WORKSPACE/.repo/projects"
  fi
  repo init \
    --partial-clone \
    --clone-filter=blob:limit=10M \
    -u "$AOSP_MANIFEST_URL" \
    -b "$BRANCH"
}

run_repo_sync() {
  log "repo sync: -c -j${JOBS} --fail-fast --no-clone-bundle --no-tags"
  cd "$WORKSPACE"
  repo sync -c -j"$JOBS" --fail-fast --no-clone-bundle --no-tags
  log "repo manifest: pinning to $WORKSPACE/eliza-cf-manifest.xml"
  repo manifest -r -o "$WORKSPACE/eliza-cf-manifest.xml"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$WORKSPACE/eliza-cf-manifest.xml" \
      > "$WORKSPACE/eliza-cf-manifest.xml.sha256"
  fi
}

install_overlay_symlinks() {
  log "overlay: dropping symlinks into device/eliza/eliza_ai_soc/"
  local dst="$WORKSPACE/device/eliza/eliza_ai_soc"
  mkdir -p "$dst"
  # Mirror the layout exactly. We symlink files (not the whole dir) so any
  # additions to the overlay are picked up on the next run.
  cd "$DEVICE_OVERLAY_SRC"
  find . -type f -print0 | while IFS= read -r -d '' rel; do
    rel=${rel#./}
    mkdir -p "$dst/$(dirname "$rel")"
    ln -sfn "$DEVICE_OVERLAY_SRC/$rel" "$dst/$rel"
  done
}

install_overlay_local_manifest() {
  log "overlay: installing .repo/local_manifests/eliza.xml (remote -> file://$ELIZA_ROOT)"
  local lm_dir="$WORKSPACE/.repo/local_manifests"
  [ -d "$WORKSPACE/.repo" ] || die "local-manifest overlay mode needs an initialized .repo (run sync first)"
  mkdir -p "$lm_dir"
  sed "s|REPLACE_WITH_ELIZA_REPO_PARENT_FILE_URL|file://$ELIZA_ROOT|g" \
    "$LOCAL_MANIFEST_TEMPLATE" > "$lm_dir/eliza.xml"
  log "overlay: re-running repo sync so linkfile projection is materialized"
  cd "$WORKSPACE"
  repo sync -c -j"$JOBS" --fail-fast --no-clone-bundle --no-tags vendor/eliza/src
}

install_overlay() {
  case "$OVERLAY_MODE" in
    symlink)        install_overlay_symlinks ;;
    local-manifest) install_overlay_local_manifest ;;
  esac
  # Sanity: every linkfile dest should resolve to a real file.
  for rel in \
    AndroidProducts.mk \
    eliza_ai_soc.mk \
    BoardConfig.mk \
    device.mk \
    manifest.xml \
    eliza_e1.xml; do
    [ -f "$WORKSPACE/device/eliza/eliza_ai_soc/$rel" ] \
      || die "overlay install: device/eliza/eliza_ai_soc/$rel did not materialize"
  done
}

run_build() {
  log "build: source build/envsetup.sh && lunch $LUNCH_TARGET && m -j${JOBS}"
  cd "$WORKSPACE"
  local build_log="$WORKSPACE/eliza-build.log"
  : > "$build_log"
  local start_ts end_ts wall_seconds
  start_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local rc=0
  # shellcheck disable=SC1091
  ( . build/envsetup.sh \
      && lunch "$LUNCH_TARGET" \
      && m -j"$JOBS" ) 2>&1 | tee "$build_log" || rc=$?
  end_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  wall_seconds=$(( $(date -d "$end_ts" +%s) - $(date -d "$start_ts" +%s) ))
  emit_report "$start_ts" "$end_ts" "$wall_seconds" "$rc"
  [ "$rc" -eq 0 ] || die "build failed with rc=$rc (see $build_log)"
}

# Derive the product output directory from the lunch combo.
product_out_dir() {
  case "$LUNCH_TARGET" in
    aosp_cf_riscv64_phone-*) echo "$WORKSPACE/out/target/product/vsoc_riscv64" ;;
    eliza_ai_soc-*)          echo "$WORKSPACE/out/target/product/eliza_ai_soc" ;;
    *)
      local short=${LUNCH_TARGET%%-*}
      echo "$WORKSPACE/out/target/product/${short}"
      ;;
  esac
}

emit_report() {
  local start_ts="$1" end_ts="$2" wall="$3" rc="$4"
  local product_out; product_out=$(product_out_dir)
  local build_id="unknown"
  if [ -f "$product_out/system/build.prop" ]; then
    build_id=$(awk -F= '/^ro\.build\.id=/ { print $2 }' "$product_out/system/build.prop" | head -n1)
  fi
  hash_img() {
    [ -f "$1" ] && command -v sha256sum >/dev/null 2>&1 \
      && sha256sum "$1" | awk '{ print $1 }' \
      || echo "absent"
  }
  local system_sha vendor_sha boot_sha
  system_sha=$(hash_img "$product_out/system.img")
  vendor_sha=$(hash_img "$product_out/vendor.img")
  boot_sha=$(hash_img "$product_out/boot.img")
  cat > "$REPORT_PATH" <<EOF
{
  "schema": "eliza-aosp-build-report.v1",
  "lunch_target": "$LUNCH_TARGET",
  "branch": "$BRANCH",
  "overlay_mode": "$OVERLAY_MODE",
  "jobs": $JOBS,
  "manifest_pin": "eliza-cf-manifest.xml",
  "start_utc": "$start_ts",
  "end_utc": "$end_ts",
  "wall_seconds": $wall,
  "result_code": $rc,
  "build_id": "$build_id",
  "product_out_dir": "$product_out",
  "artifacts": {
    "system_img_sha256": "$system_sha",
    "vendor_img_sha256": "$vendor_sha",
    "boot_img_sha256":   "$boot_sha"
  }
}
EOF
  log "report: $REPORT_PATH (rc=$rc, wall=${wall}s, build_id=$build_id)"
}

maybe_launch_cvd() {
  [ "$LAUNCH_CVD" -eq 1 ] || return 0
  log "launch_cvd: convenience pass-through (Task 29 owns the real launcher)"
  cd "$WORKSPACE"
  local launcher
  launcher="$(product_out_dir)/../../../host/linux-x86/bin/launch_cvd"
  if [ ! -x "$launcher" ]; then
    warn "launch_cvd not found at $launcher; skipping"
    return 0
  fi
  "$launcher" --noresume
}

main() {
  log "AOSP riscv64 build pipeline"
  log "  workspace:      $WORKSPACE"
  log "  branch:         $BRANCH"
  log "  lunch target:   $LUNCH_TARGET"
  log "  overlay mode:   $OVERLAY_MODE"
  log "  jobs:           $JOBS"
  log "  eliza root:     $ELIZA_ROOT"

  if [ "$SKIP_PREFLIGHT" -eq 0 ]; then
    preflight
  else
    warn "preflight skipped (--skip-preflight)"
  fi

  if [ "$SKIP_SYNC" -eq 0 ]; then
    bootstrap_repo
    run_repo_init
    run_repo_sync
  else
    log "sync: skipped (--skip-sync)"
  fi

  install_overlay

  if [ "$SKIP_BUILD" -eq 0 ]; then
    run_build
  else
    log "build: skipped (--skip-build)"
  fi

  maybe_launch_cvd
  log "done"
}

main "$@"
