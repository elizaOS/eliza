#!/usr/bin/env bash
# Build and verify the AOSP CTS/VTS Tradefed host bundles required by the
# Android e1-NPU proof bundle.

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: build_cts_vts_tradefed.sh [--verify-only]

Environment:
  AOSP_TREE or AOSP_DIR        Built AOSP checkout. Defaults to /home/shaw/aosp if present.
  AOSP_PRODUCT                Lunch target, defaults to eliza_openagent_ai_soc_phone-trunk_staging-userdebug.
  AOSP_CTS_VTS_BUILD_TARGETS  Build targets, defaults to "cts vts".
  AOSP_MAKE_ARGS              Optional args passed before build targets.
  AOSP_SHELL                  Shell used for envsetup/lunch/m, defaults to bash.
  E1_NPU_CTS_VTS_BUILD_LOG    Output log path, defaults to docs/evidence/android/e1-npu/cts-vts-tradefed-build.log.
USAGE
}

die() {
  printf 'build_cts_vts_tradefed: %s\n' "$*" >&2
  exit 2
}

VERIFY_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only)
      VERIFY_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

repo_root="$(CDPATH=; cd -- "$(dirname -- "$0")/../.." && pwd)"
aosp_tree="${AOSP_TREE:-${AOSP_DIR:-}}"
if [ -z "$aosp_tree" ] && [ -d /home/shaw/aosp ]; then
  aosp_tree=/home/shaw/aosp
fi
[ -n "$aosp_tree" ] || die "AOSP_TREE/AOSP_DIR is required"
[ -d "$aosp_tree" ] || die "AOSP tree does not exist: $aosp_tree"
[ -f "$aosp_tree/build/envsetup.sh" ] || die "AOSP tree is missing build/envsetup.sh: $aosp_tree"

aosp_shell="${AOSP_SHELL:-bash}"
command -v "$aosp_shell" >/dev/null 2>&1 || die "AOSP_SHELL is unavailable: $aosp_shell"

log="${E1_NPU_CTS_VTS_BUILD_LOG:-docs/evidence/android/e1-npu/cts-vts-tradefed-build.log}"
case "$log" in
  /*) ;;
  *) log="$repo_root/$log" ;;
esac
mkdir -p "$(dirname "$log")"

cts_tf="$aosp_tree/out/host/linux-x86/cts/android-cts/tools/cts-tradefed"
vts_tf="$aosp_tree/out/host/linux-x86/vts/android-vts/tools/vts-tradefed"
aosp_product="${AOSP_PRODUCT:-eliza_openagent_ai_soc_phone-trunk_staging-userdebug}"
targets="${AOSP_CTS_VTS_BUILD_TARGETS:-cts vts}"
make_args="${AOSP_MAKE_ARGS:-}"
started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status_file="$(mktemp "${TMPDIR:-/tmp}/e1-npu-cts-vts-build.XXXXXX")"

{
  echo "eliza-evidence: target=aosp artifact=e1_npu_cts_vts_tradefed_build"
  echo "eliza-evidence: external_tree=$aosp_tree"
  echo "eliza-evidence: command=scripts/android/build_cts_vts_tradefed.sh"
  echo "EXTERNAL_TREE=$aosp_tree"
  echo "AOSP_PRODUCT=$aosp_product"
  echo "AOSP_CTS_VTS_BUILD_TARGETS=$targets"
  echo "AOSP_MAKE_ARGS=$make_args"
  echo "VERIFY_ONLY=$VERIFY_ONLY"
  echo "START_UTC=$started_utc"
  echo "eliza-evidence: started_utc=$started_utc"
  cd "$aosp_tree"
  set +e
  if [ "$VERIFY_ONLY" -eq 0 ]; then
    # Variables expand in the subshell (-lc '...'), not the outer shell; single quotes are intentional
    # shellcheck disable=SC2016
    env AOSP_PRODUCT="$aosp_product" AOSP_CTS_VTS_BUILD_TARGETS="$targets" AOSP_MAKE_ARGS="$make_args" "$aosp_shell" -lc '
      source build/envsetup.sh &&
      lunch "$AOSP_PRODUCT" >/dev/null &&
      m ${AOSP_MAKE_ARGS:-} ${AOSP_CTS_VTS_BUILD_TARGETS}
    '
    build_rc=$?
  else
    build_rc=0
  fi
  cts_ready=0
  vts_ready=0
  [ -x "$cts_tf" ] && cts_ready=1
  [ -x "$vts_tf" ] && vts_ready=1
  echo "CTS_TRADEFED=$cts_tf"
  echo "VTS_TRADEFED=$vts_tf"
  echo "CTS_TRADEFED_READY=$cts_ready"
  echo "VTS_TRADEFED_READY=$vts_ready"
  if [ "$build_rc" -eq 0 ] && [ "$cts_ready" -eq 1 ] && [ "$vts_ready" -eq 1 ]; then
    rc=0
    status=PASS
  else
    rc=2
    status=FAIL
  fi
  ended_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "eliza-evidence: ended_utc=$ended_utc"
  echo "eliza-evidence: status=$status"
  echo "END_UTC=$ended_utc"
  echo "RESULT=$rc"
  echo "$rc" > "$status_file"
  exit "$rc"
} 2>&1 | tee "$log"

rc="$(cat "$status_file" 2>/dev/null || echo 2)"
rm -f "$status_file"
exit "$rc"
