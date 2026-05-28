#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=1
DEVICE_SERIAL=""
MANIFEST=""
BOOT_TIMEOUT=""
LAUNCHER_PACKAGE="ai.elizaos.app"
LAUNCHER_ACTIVITY="ai.elizaos.app/.MainActivity"
AGENT_HEALTH_URL="http://127.0.0.1:31337/api/health"
EXPECTED_PM_PATH=""
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
  --launcher-package PACKAGE  Expected Eliza launcher package.
  --launcher-activity CMP     Expected foreground HOME activity component.
  --agent-health-url URL      Local agent health URL to probe on the device.
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
      --launcher-package)
        [[ $# -ge 2 ]] || die "--launcher-package requires a package name"
        LAUNCHER_PACKAGE="$2"
        shift 2
        ;;
      --launcher-activity)
        [[ $# -ge 2 ]] || die "--launcher-activity requires a component"
        LAUNCHER_ACTIVITY="$2"
        shift 2
        ;;
      --agent-health-url)
        [[ $# -ge 2 ]] || die "--agent-health-url requires a URL"
        AGENT_HEALTH_URL="$2"
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
const properties = manifest.validation?.properties ?? {};
const semanticProperties = new Set([
  'agent_health',
  'agent_service_pid',
  'foreground_activity',
  'home_role',
  'logcat_fatal_count',
  'pm_path',
  'selinux_avc_denied_count',
]);
if (manifest.validation?.bootTimeoutSeconds) {
  console.log(`BOOT_TIMEOUT=${manifest.validation.bootTimeoutSeconds}`);
}
for (const [key, value] of Object.entries(properties)) {
  if (!semanticProperties.has(key)) {
    console.log(`EXPECT=${key}=${value}`);
  }
}
if (typeof properties.pm_path === 'string') {
  console.log(`EXPECTED_PM_PATH=${properties.pm_path}`);
}
if (typeof properties.home_role === 'string') {
  console.log(`LAUNCHER_PACKAGE=${properties.home_role}`);
}
if (typeof properties.foreground_activity === 'string') {
  console.log(`LAUNCHER_ACTIVITY=${properties.foreground_activity}`);
}
if (manifest.validation?.expectedFingerprintPrefix) {
  console.log(`FINGERPRINT_PREFIX=${manifest.validation.expectedFingerprintPrefix}`);
}
const checks = manifest.validation?.launcherAgentChecks ?? {};
if (checks.launcherPackage) {
  console.log(`LAUNCHER_PACKAGE=${checks.launcherPackage}`);
}
if (checks.launcherActivity) {
  console.log(`LAUNCHER_ACTIVITY=${checks.launcherActivity}`);
}
if (checks.agentHealthUrl) {
  console.log(`AGENT_HEALTH_URL=${checks.agentHealthUrl}`);
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
      EXPECTED_PM_PATH=*)
        EXPECTED_PM_PATH="${line#EXPECTED_PM_PATH=}"
        ;;
      FINGERPRINT_PREFIX=*)
        EXPECTED_PROPS+=("ro.build.fingerprint^=${line#FINGERPRINT_PREFIX=}")
        ;;
      LAUNCHER_PACKAGE=*)
        LAUNCHER_PACKAGE="${line#LAUNCHER_PACKAGE=}"
        ;;
      LAUNCHER_ACTIVITY=*)
        LAUNCHER_ACTIVITY="${line#LAUNCHER_ACTIVITY=}"
        ;;
      AGENT_HEALTH_URL=*)
        AGENT_HEALTH_URL="${line#AGENT_HEALTH_URL=}"
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
  add_plan "${adb_cmd[@]}" shell pm path "$LAUNCHER_PACKAGE"
  add_plan "${adb_cmd[@]}" shell cmd role holders android.app.role.HOME
  add_plan "${adb_cmd[@]}" shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME
  add_plan "${adb_cmd[@]}" shell dumpsys package "$LAUNCHER_PACKAGE"
  add_plan "${adb_cmd[@]}" shell dumpsys activity activities
  add_plan "${adb_cmd[@]}" shell pidof "$LAUNCHER_PACKAGE"
  add_plan "${adb_cmd[@]}" shell curl -fsS "$AGENT_HEALTH_URL"
  add_plan "${adb_cmd[@]}" logcat -d
  add_plan "${adb_cmd[@]}" logcat -d
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

validate_launcher_agent_liveness() {
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  local adb_cmd
  read -r -a adb_cmd <<<"$(adb_base)"
  local pm_path

  pm_path="$("${adb_cmd[@]}" shell pm path "$LAUNCHER_PACKAGE" | tr -d '\r')"
  if [[ -n "$EXPECTED_PM_PATH" ]]; then
    [[ "$pm_path" == "$EXPECTED_PM_PATH" ]] \
      || die "launcher package path '$pm_path' does not match '$EXPECTED_PM_PATH'"
  else
    grep -F "package:" <<<"$pm_path" >/dev/null \
      || die "launcher package is not installed: $LAUNCHER_PACKAGE"
  fi
  "${adb_cmd[@]}" shell cmd role holders android.app.role.HOME | grep -F "$LAUNCHER_PACKAGE" >/dev/null \
    || die "launcher package is not a HOME role holder: $LAUNCHER_PACKAGE"
  "${adb_cmd[@]}" shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME \
    | grep -F "$LAUNCHER_PACKAGE" >/dev/null \
    || die "HOME intent does not resolve to launcher package: $LAUNCHER_PACKAGE"
  "${adb_cmd[@]}" shell dumpsys activity activities | grep -F "$LAUNCHER_ACTIVITY" >/dev/null \
    || die "expected launcher foreground activity was not found: $LAUNCHER_ACTIVITY"
  "${adb_cmd[@]}" shell pidof "$LAUNCHER_PACKAGE" >/dev/null \
    || die "launcher/agent process is not running: $LAUNCHER_PACKAGE"
  "${adb_cmd[@]}" shell curl -fsS "$AGENT_HEALTH_URL" | grep -Ei '"status"[[:space:]]*:[[:space:]]*"ready"|ok|healthy' >/dev/null \
    || die "agent health probe did not return ready/ok/healthy: $AGENT_HEALTH_URL"
  ! "${adb_cmd[@]}" logcat -d | grep -Ei 'FATAL EXCEPTION|AndroidRuntime|crash' >/dev/null \
    || die "fatal Android runtime/crash log entries were found"
  ! "${adb_cmd[@]}" logcat -d | grep -i 'avc: denied' >/dev/null \
    || die "SELinux avc: denied log entries were found"
}

execute_plan() {
  [[ "$DRY_RUN" -eq 0 ]] || return 0
  command -v adb >/dev/null 2>&1 || die "required tool 'adb' was not found in PATH"

  local command
  for command in "${PLAN[@]}"; do
    eval "run_cmd $command"
  done
  validate_expectations
  validate_launcher_agent_liveness
}

parse_args "$@"
load_manifest_expectations
build_plan
print_plan
execute_plan
