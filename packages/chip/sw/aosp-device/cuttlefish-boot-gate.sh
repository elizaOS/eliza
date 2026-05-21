#!/usr/bin/env bash
# cuttlefish-boot-gate.sh
#
# Assert + evidence-capture script for the Cuttlefish riscv64 boot harness.
# Runs after launch-cuttlefish-riscv64.sh, collects the canonical
# riscv64 boot markers, and writes a transcript to
# docs/evidence/android/cuttlefish_riscv64_boot.log with eliza-evidence:
# status=PASS|FAIL markers + RESULT=0|1 + per-assertion KEY=value lines.
#
# Claim boundary: virtual-device boot smoke only. This is not e1_soc/AP
# silicon evidence and is not an Android compatibility claim.

set -euo pipefail

usage() {
	cat >&2 <<'USAGE'
usage: cuttlefish-boot-gate.sh [options]

options:
  --out=PATH              evidence transcript output path
                          (default: <repo>/docs/evidence/android/cuttlefish_riscv64_boot.log)
  --manifest=PATH         AOSP manifest XML from Task 28; recorded with sha256
  --adb-serial=SERIAL     adb -s <serial> for multi-device hosts
  --runtime-dir=PATH      Cuttlefish runtime directory (default: ~/cuttlefish_runtime)
  --agent-package=PKG     launcher/agent package id (default: ai.elizaos.app)
  --agent-service=COMP    foreground service component (default: ai.elizaos.app/.ElizaAgentService)
  --agent-host-port=PORT  host adb-forwarded port for /api/health (default: 31337)
  --agent-device-port=N   device port for /api/health (default: 31337)
  --launcher-evidence=PATH structured launcher runtime evidence JSON output
                          (default: <repo>/docs/evidence/android/eliza_launcher_runtime_evidence.json)
  --help                  this message

Assertions:
  ro.product.cpu.abi      == riscv64
  ro.product.cpu.abilist  contains riscv64
  uname -m                == riscv64
  sys.boot_completed      == 1
  getenforce              == Enforcing
  kernel.log              contains "Run /init as init process" and no panic
  BUILD_ID                non-empty
  manifest sha256         present when --manifest is provided

Launcher / local-agent assertions:
  pm path <package>       prints the installed launcher APK path
  resolve-activity HOME   resolves to the launcher package for the HOME intent
  role HOME holder        cmd role get-role-holders android.app.role.HOME == launcher
  dumpsys activity        foreground resumed activity is the launcher package
  pidof service           ElizaAgentService process is alive
  /api/health             HTTP 200 over the adb-forwarded port
  logcat fatal scan       no FATAL EXCEPTION / SIGSEGV crash lines
  avc denial scan         no audit avc: denied lines for the launcher domain
USAGE
}

out=
manifest=
adb_serial=
runtime_dir="$HOME/cuttlefish_runtime"
agent_package="ai.elizaos.app"
agent_service="ai.elizaos.app/.ElizaAgentService"
agent_host_port=31337
agent_device_port=31337
launcher_evidence=

while [ "$#" -gt 0 ]; do
	case "$1" in
		--out=*) out=${1#*=}; shift ;;
		--manifest=*) manifest=${1#*=}; shift ;;
		--adb-serial=*) adb_serial=${1#*=}; shift ;;
		--runtime-dir=*) runtime_dir=${1#*=}; shift ;;
		--agent-package=*) agent_package=${1#*=}; shift ;;
		--agent-service=*) agent_service=${1#*=}; shift ;;
		--agent-host-port=*) agent_host_port=${1#*=}; shift ;;
		--agent-device-port=*) agent_device_port=${1#*=}; shift ;;
		--launcher-evidence=*) launcher_evidence=${1#*=}; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -z "$out" ]; then
	out="$repo_root/docs/evidence/android/cuttlefish_riscv64_boot.log"
fi
if [ -z "$launcher_evidence" ]; then
	launcher_evidence="$repo_root/docs/evidence/android/eliza_launcher_runtime_evidence.json"
fi
mkdir -p "$(dirname "$out")"
mkdir -p "$(dirname "$launcher_evidence")"

adb_cvd() {
	if [ -n "$adb_serial" ]; then
		adb -s "$adb_serial" "$@"
	else
		adb "$@"
	fi
}

result=0
fails=()

assert_eq() {
	# $1 key, $2 actual, $3 expected
	local key=$1 actual=$2 expected=$3
	printf '%s=%s\n' "$key" "$actual"
	if [ "$actual" != "$expected" ]; then
		fails+=("$key expected '$expected' got '$actual'")
		return 1
	fi
}

assert_contains() {
	local key=$1 actual=$2 needle=$3
	printf '%s=%s\n' "$key" "$actual"
	case "$actual" in
		*"$needle"*) return 0 ;;
	esac
	fails+=("$key expected to contain '$needle' got '$actual'")
	return 1
}

start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
result_file=$(mktemp)
trap 'rm -f "$result_file"' EXIT
echo 0 > "$result_file"

emit() {
	echo "eliza-evidence: target=aosp artifact=cuttlefish_riscv64_boot"
	echo "eliza-evidence: claim_boundary=virtual_device_smoke_only_not_boot_or_compatibility_evidence"
	echo "eliza-evidence: command=cuttlefish-boot-gate.sh"
	echo "BOOT_CLAIM=virtual_device_only"
	echo "COMPATIBILITY_CLAIM=none"
	echo "START_UTC=$start_utc"
	echo "eliza-evidence: started_utc=$start_utc"
	echo "ADB_SERIAL=${adb_serial:-default}"
	echo "RUNTIME_DIR=$runtime_dir"

	if ! command -v adb >/dev/null 2>&1; then
		echo "error: adb not on PATH" >&2
		result=1
	fi

	if [ "$result" -eq 0 ]; then
		# Arch triad. The canonical implementation of these three assertions
		# is validateExpectedAbi() in
		# eliza/packages/app-core/scripts/aosp/boot-validate.mjs (reachable
		# as `boot-validate.mjs --expected-abi <abi>`); the variant-driven
		# mjs validator owns the x86_64/arm64/variant-riscv64 path. This gate
		# keeps its own host-side copy because it targets the chip
		# ai.elizaos.app product, which has no `app.config.ts > aosp:` variant
		# block, and pairs the triad with the kernel.log / manifest /
		# evidence-emission assertions the mjs validator does not perform.
		# Keep the two in sync.
		abi=$(adb_cvd shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r' || true)
		assert_eq ro.product.cpu.abi "$abi" riscv64 || result=1

		abilist=$(adb_cvd shell getprop ro.product.cpu.abilist 2>/dev/null | tr -d '\r' || true)
		assert_contains ro.product.cpu.abilist "$abilist" riscv64 || result=1

		uname_m=$(adb_cvd shell uname -m 2>/dev/null | tr -d '\r' || true)
		assert_eq uname_m "$uname_m" riscv64 || result=1

		boot=$(adb_cvd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
		assert_eq sys.boot_completed "$boot" 1 || result=1

		selinux=$(adb_cvd shell getenforce 2>/dev/null | tr -d '\r' || true)
		assert_eq getenforce "$selinux" Enforcing || result=1

		build_id=$(adb_cvd shell getprop ro.build.id 2>/dev/null | tr -d '\r' || true)
		printf 'BUILD_ID=%s\n' "$build_id"
		if [ -z "$build_id" ]; then
			fails+=("BUILD_ID empty")
			result=1
		fi

		sdk=$(adb_cvd shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r' || true)
		printf 'ro.build.version.sdk=%s\n' "$sdk"
	fi

	# Launcher + local-agent assertions. These prove the boot reached an
	# interactive Eliza launcher holding the HOME role with a live local
	# agent, not merely a generic Android boot.
	launcher_ok=1
	if [ "$result" -eq 0 ]; then
		echo "AGENT_PACKAGE=$agent_package"
		echo "AGENT_SERVICE=$agent_service"

		pm_path=$(adb_cvd shell pm path "$agent_package" 2>/dev/null | tr -d '\r' || true)
		printf 'PM_PATH=%s\n' "$pm_path"
		case "$pm_path" in
			package:*) : ;;
			*) fails+=("pm path $agent_package returned no APK"); result=1; launcher_ok=0 ;;
		esac

		resolved_home=$(adb_cvd shell cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tr -d '\r' || true)
		printf 'RESOLVE_ACTIVITY_HOME=%s\n' "$(printf '%s' "$resolved_home" | tr '\n' ' ')"
		case "$resolved_home" in
			*"$agent_package"*) : ;;
			*) fails+=("resolve-activity HOME did not resolve to $agent_package"); result=1; launcher_ok=0 ;;
		esac

		role_holder=$(adb_cvd shell cmd role get-role-holders android.app.role.HOME 2>/dev/null | tr -d '\r' || true)
		printf 'HOME_ROLE_HOLDER=%s\n' "$role_holder"
		case "$role_holder" in
			*"$agent_package"*) : ;;
			*) fails+=("HOME role holder is '$role_holder', expected $agent_package"); result=1; launcher_ok=0 ;;
		esac

		foreground=$(adb_cvd shell dumpsys activity activities 2>/dev/null | tr -d '\r' | grep -E 'ResumedActivity|mResumedActivity|topResumedActivity' | head -n1 || true)
		printf 'FOREGROUND_ACTIVITY=%s\n' "$foreground"
		case "$foreground" in
			*"$agent_package"*) : ;;
			*) fails+=("foreground (dumpsys activity) is not $agent_package: '$foreground'"); result=1; launcher_ok=0 ;;
		esac

		agent_pid=$(adb_cvd shell pidof "$agent_package" 2>/dev/null | tr -d '\r' | awk '{print $1}' || true)
		printf 'AGENT_PID=%s\n' "$agent_pid"
		if [ -z "$agent_pid" ]; then
			fails+=("pidof $agent_package found no running service process")
			result=1
			launcher_ok=0
			echo "AGENT_SERVICE_STATE=dead"
		else
			echo "AGENT_SERVICE_STATE=alive"
		fi

		adb_cvd forward "tcp:$agent_host_port" "tcp:$agent_device_port" >/dev/null 2>&1 || true
		health_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$agent_host_port/api/health" 2>/dev/null || echo 000)
		printf 'AGENT_HEALTH_HTTP=%s\n' "$health_code"
		printf 'AGENT_HEALTH_ENDPOINT=/api/health\n'
		if [ "$health_code" = 200 ]; then
			echo "AGENT_HEALTH=ok"
		else
			fails+=("/api/health returned HTTP $health_code, expected 200")
			result=1
			launcher_ok=0
			echo "AGENT_HEALTH=fail"
		fi

		logcat_dump=$(adb_cvd shell logcat -d -b crash -b main 2>/dev/null | tr -d '\r' || true)
		fatal_hits=$(printf '%s\n' "$logcat_dump" | grep -E 'FATAL EXCEPTION|signal 11 \(SIGSEGV\)|--------- beginning of crash' | head -n5 || true)
		printf 'LOGCAT_FATAL=%s\n' "$(printf '%s' "$fatal_hits" | tr '\n' ';')"
		if [ -n "$fatal_hits" ]; then
			fails+=("logcat reported fatal/crash lines")
			result=1
			launcher_ok=0
			echo "LOGCAT_FATAL_PRESENT=true"
		else
			echo "LOGCAT_FATAL_PRESENT=false"
		fi

		avc_hits=$(printf '%s\n' "$logcat_dump" | grep -E 'avc: +denied' | head -n5 || true)
		if [ -z "$avc_hits" ]; then
			avc_hits=$(adb_cvd shell dmesg 2>/dev/null | tr -d '\r' | grep -E 'avc: +denied' | head -n5 || true)
		fi
		printf 'AVC_DENIED=%s\n' "$(printf '%s' "$avc_hits" | tr '\n' ';')"
		if [ -n "$avc_hits" ]; then
			fails+=("SELinux avc: denied entries present")
			result=1
			launcher_ok=0
			echo "AVC_DENIED_PRESENT=true"
		else
			echo "AVC_DENIED_PRESENT=false"
		fi
	else
		launcher_ok=0
	fi

	kernel_log="$runtime_dir/kernel.log"
	if [ -f "$kernel_log" ]; then
		printf 'KERNEL_LOG=%s\n' "$kernel_log"
		if grep -q 'Run /init as init process' "$kernel_log"; then
			echo "KERNEL_INIT_MARKER=present"
		else
			fails+=("kernel.log missing 'Run /init as init process'")
			result=1
			echo "KERNEL_INIT_MARKER=absent"
		fi
		if grep -qE 'Kernel panic|Oops:' "$kernel_log"; then
			fails+=("kernel.log contains panic/Oops")
			result=1
			echo "KERNEL_PANIC=true"
		else
			echo "KERNEL_PANIC=false"
		fi
	else
		echo "KERNEL_LOG=missing:$kernel_log"
		fails+=("$kernel_log not present")
		result=1
	fi

	if [ -n "$manifest" ]; then
		if [ -f "$manifest" ]; then
			manifest_sha=$(sha256sum "$manifest" | awk '{print $1}')
			printf 'MANIFEST_PATH=%s\n' "$manifest"
			printf 'MANIFEST_SHA256=%s\n' "$manifest_sha"
		else
			echo "MANIFEST_PATH=missing:$manifest"
			fails+=("manifest $manifest not found")
			result=1
		fi
	else
		echo "MANIFEST_PATH=unset"
	fi

	end_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	echo "END_UTC=$end_utc"
	echo "eliza-evidence: ended_utc=$end_utc"

	if [ "$result" -eq 0 ]; then
		status=PASS
	else
		status=FAIL
		for line in "${fails[@]}"; do
			printf 'FAILURE=%s\n' "$line"
		done
	fi
	echo "eliza-evidence: status=$status"
	echo "RESULT=$result"
	echo "$result" > "$result_file"

	json_bool() { if [ "${1:-0}" = 1 ]; then printf 'true'; else printf 'false'; fi; }
	json_str() { printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
	{
		echo "{"
		echo "  \"schema\": \"eliza.android_launcher_runtime_evidence.v1\","
		echo "  \"claim_boundary\": \"virtual_device_smoke_only_not_boot_or_compatibility_evidence\","
		echo "  \"status\": \"$(json_str "$status")\","
		echo "  \"result\": $result,"
		echo "  \"started_utc\": \"$(json_str "$start_utc")\","
		echo "  \"ended_utc\": \"$(json_str "$end_utc")\","
		echo "  \"agent_package\": \"$(json_str "$agent_package")\","
		echo "  \"agent_service\": \"$(json_str "$agent_service")\","
		echo "  \"pm_path\": \"$(json_str "${pm_path:-}")\","
		echo "  \"home_role_holder\": \"$(json_str "${role_holder:-}")\","
		echo "  \"foreground_activity\": \"$(json_str "${foreground:-}")\","
		echo "  \"agent_pid\": \"$(json_str "${agent_pid:-}")\","
		echo "  \"agent_health_endpoint\": \"/api/health\","
		echo "  \"agent_health_http\": \"$(json_str "${health_code:-}")\","
		echo "  \"logcat_fatal_present\": $(json_bool "$( [ -n "${fatal_hits:-}" ] && echo 1 || echo 0 )"),"
		echo "  \"avc_denied_present\": $(json_bool "$( [ -n "${avc_hits:-}" ] && echo 1 || echo 0 )"),"
		echo "  \"launcher_ok\": $(json_bool "${launcher_ok:-0}")"
		echo "}"
	} > "$launcher_evidence"
	echo "LAUNCHER_EVIDENCE=$launcher_evidence"
}

emit | tee "$out"

final_result=$(cat "$result_file")
exit "$final_result"
