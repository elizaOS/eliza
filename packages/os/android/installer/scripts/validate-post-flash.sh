#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=1
DEVICE_SERIAL=""
MANIFEST=""
BOOT_TIMEOUT=""
declare -a EXPECTED_PROPS=()
declare -a PLAN=()

usage() {
  cat <<'EOF'
Usage:
  validate-post-flash.sh [--device SERIAL] [--manifest MANIFEST.json] [--expect key=value] [--execute]

Plans or runs read-only ADB checks against a booted Android device. The default
mode is dry-run: commands are printed and no device is queried.

Options:
  --device SERIAL             adb serial to target.
  --manifest MANIFEST.json    Read validation.properties and boot timeout from
                              an Android release manifest.
  --expect KEY=VALUE          Add or override an expected getprop value.
  --boot-timeout SECONDS      wait-for-device timeout used in the printed plan.
  --execute                   Run the read-only ADB validation commands.
  --dry-run                   Print the validation plan only. Default.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

shell_join() {
  local out=""
  local arg
  for arg in "$@"; do
    if [[ -z "$out" ]]; then
      printf -v out "%q" "$arg"
    else
      printf -v out "%s %q" "$out" "$arg"
    fi
  done
  echo "$out"
}

adb_base() {
  if [[ -n "$DEVICE_SERIAL" ]]; then
    echo adb -s "$DEVICE_SERIAL"
  else
    echo adb
  fi
}

add_plan() {
  PLAN+=("$(shell_join "$@")")
}

run_cmd() {
  local printable
  printable="$(shell_join "$@")"
  echo "+ $printable"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    "$@"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --device)
        [[ $# -ge 2 ]] || die "--device requires a serial"
        DEVICE_SERIAL="$2"
        shift 2
        ;;
      --manifest)
        [[ $# -ge 2 ]] || die "--manifest requires a JSON file"
        MANIFEST="$2"
        shift 2
        ;;
      --expect)
        [[ $# -ge 2 ]] || die "--expect requires KEY=VALUE"
        EXPECTED_PROPS+=("$2")
        shift 2
        ;;
      --boot-timeout)
        [[ $# -ge 2 ]] || die "--boot-timeout requires seconds"
        BOOT_TIMEOUT="$2"
        shift 2
        ;;
      --execute)
        DRY_RUN=0
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

load_manifest_expectations() {
  [[ -z "$MANIFEST" ]] && return
  [[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST"
  command -v node >/dev/null 2>&1 || die "node is required to read manifest expectations"

  local manifest_output
  manifest_output="$(node - "$MANIFEST" <<'NODE'
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (manifest.validation?.bootTimeoutSeconds) {
  console.log(`BOOT_TIMEOUT=${manifest.validation.bootTimeoutSeconds}`);
}
for (const [key, value] of Object.entries(manifest.validation?.properties ?? {})) {
  console.log(`EXPECT=${key}=${value}`);
}
if (manifest.validation?.expectedFingerprintPrefix) {
  console.log(`FINGERPRINT_PREFIX=${manifest.validation.expectedFingerprintPrefix}`);
}
NODE
)"

  local line
  while IFS= read -r line; do
    case "$line" in
      BOOT_TIMEOUT=*)
        [[ -z "$BOOT_TIMEOUT" ]] && BOOT_TIMEOUT="${line#BOOT_TIMEOUT=}"
        ;;
      EXPECT=*)
        EXPECTED_PROPS+=("${line#EXPECT=}")
        ;;
      FINGERPRINT_PREFIX=*)
        EXPECTED_PROPS+=("ro.build.fingerprint^=${line#FINGERPRINT_PREFIX=}")
        ;;
    esac
  done <<<"$manifest_output"
}

build_plan() {
  local adb_cmd
  read -r -a adb_cmd <<<"$(adb_base)"
  local timeout_prefix=()
  if [[ -n "$BOOT_TIMEOUT" ]]; then
    timeout_prefix=(timeout "$BOOT_TIMEOUT")
  fi

  add_plan "${timeout_prefix[@]}" "${adb_cmd[@]}" wait-for-device
  add_plan "${adb_cmd[@]}" get-state
  add_plan "${adb_cmd[@]}" shell getprop ro.product.device
  add_plan "${adb_cmd[@]}" shell getprop ro.build.fingerprint
  add_plan "${adb_cmd[@]}" shell getprop ro.boot.slot_suffix
  add_plan "${adb_cmd[@]}" shell getprop sys.boot_completed
}

print_plan() {
  echo
  echo "Post-flash validation plan:"
  local command
  for command in "${PLAN[@]}"; do
    echo "  $command"
  done
  if [[ "${#EXPECTED_PROPS[@]}" -gt 0 ]]; then
    echo
    echo "Expected properties:"
    local expected
    for expected in "${EXPECTED_PROPS[@]}"; do
      echo "  $expected"
    done
  fi
  echo
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry-run only. No ADB commands were executed."
  fi
}

getprop_value() {
  local prop="$1"
  local adb_cmd
  read -r -a adb_cmd <<<"$(adb_base)"
  "${adb_cmd[@]}" shell getprop "$prop" 2>/dev/null | tr -d '\r'
}

validate_expectations() {
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  local expected key want actual
  for expected in "${EXPECTED_PROPS[@]}"; do
    if [[ "$expected" == *"^="* ]]; then
      key="${expected%%^=*}"
      want="${expected#*^=}"
      actual="$(getprop_value "$key")"
      [[ "$actual" == "$want"* ]] || die "$key='$actual' does not start with '$want'"
    else
      [[ "$expected" == *=* ]] || die "expected property must be KEY=VALUE or KEY^=PREFIX: $expected"
      key="${expected%%=*}"
      want="${expected#*=}"
      actual="$(getprop_value "$key")"
      [[ "$actual" == "$want" ]] || die "$key='$actual' does not match '$want'"
    fi
  done
}

execute_plan() {
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  command -v adb >/dev/null 2>&1 || die "required tool 'adb' was not found in PATH"

  local command
  for command in "${PLAN[@]}"; do
    eval "run_cmd $command"
  done
  validate_expectations
}

parse_args "$@"
load_manifest_expectations
build_plan
print_plan
execute_plan
