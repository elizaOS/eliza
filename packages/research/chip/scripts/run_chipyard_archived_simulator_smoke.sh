#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
out_dir="$repo_dir/build/chipyard/eliza_rocket"
log="${CHIPYARD_ARCHIVED_SIM_LOG:-$out_dir/archived-simulator-linux-smoke.log}"
simulator="${CHIPYARD_ARCHIVED_SIMULATOR:-$out_dir/simulator/simulator-chipyard.harness-ElizaRocketConfig}"
payload="${CHIPYARD_LINUX_BINARY:-}"
timeout_seconds="${CHIPYARD_ARCHIVED_SIM_TIMEOUT_SECONDS:-60}"
timeout_cycles="${CHIPYARD_ARCHIVED_SIM_TIMEOUT_CYCLES:-200000}"
extra_sim_flags="${CHIPYARD_ARCHIVED_SIM_FLAGS:-+dramsim +max-cycles=$timeout_cycles}"

mkdir -p "$out_dir"

if [ -z "$payload" ]; then
	payload_export="$(python3 "$repo_dir/scripts/locate_chipyard_linux_payload.py" --export-env || true)"
	case "$payload_export" in
		export\ CHIPYARD_LINUX_BINARY=*)
			eval "$payload_export"
			payload="${CHIPYARD_LINUX_BINARY:-}"
			;;
	esac
fi

{
	printf 'eliza-evidence: target=generated_chipyard_ap\n'
	printf 'eliza-evidence: wrapper=scripts/run_chipyard_archived_simulator_smoke.sh\n'
	printf 'eliza-evidence: simulator=%s\n' "$simulator"
	printf 'eliza-evidence: payload=%s\n' "${payload:-}"
	printf 'eliza-evidence: timeout_after_seconds=%s\n' "$timeout_seconds"
	printf 'eliza-evidence: timeout_cycles=%s\n' "$timeout_cycles"
	printf 'eliza-evidence: claim_boundary=bounded archived simulator attempt only; not boot evidence unless required markers appear\n'
} >"$log"

if [ ! -x "$simulator" ]; then
	{
		printf 'eliza-evidence: raw_transcript_begin\n'
		printf 'STATUS: BLOCKED chipyard.archived_simulator - simulator is missing or not executable: %s\n' "$simulator"
		printf 'eliza-evidence: raw_transcript_end\n'
		printf 'eliza-evidence: exit_code=2\n'
		printf 'eliza-evidence: status=BLOCKED\n'
	} >>"$log"
	cat "$log"
	exit 2
fi

if [ -z "$payload" ] || [ ! -f "$payload" ]; then
	{
		printf 'eliza-evidence: raw_transcript_begin\n'
		printf 'STATUS: BLOCKED chipyard.archived_simulator - CHIPYARD_LINUX_BINARY is unset or missing: %s\n' "${payload:-}"
		printf 'eliza-evidence: raw_transcript_end\n'
		printf 'eliza-evidence: exit_code=2\n'
		printf 'eliza-evidence: status=BLOCKED\n'
	} >>"$log"
	cat "$log"
	exit 2
fi

host_system="$(uname -s 2>/dev/null || printf unknown)"
host_machine="$(uname -m 2>/dev/null || printf unknown)"
if [ "$host_system" != "Linux" ]; then
	{
		printf 'eliza-evidence: raw_transcript_begin\n'
		printf 'STATUS: BLOCKED chipyard.archived_simulator - archived simulator is a Linux ELF and this host is %s/%s\n' "$host_system" "$host_machine"
		printf 'eliza-evidence: raw_transcript_end\n'
		printf 'eliza-evidence: exit_code=2\n'
		printf 'eliza-evidence: status=BLOCKED\n'
	} >>"$log"
	cat "$log"
	exit 2
fi

command_text="$(printf '%s +permissive %s +permissive-off %s' "$simulator" "$extra_sim_flags" "$payload")"
{
	printf 'eliza-evidence: command=%s\n' "$command_text"
	printf 'eliza-evidence: raw_transcript_begin\n'
} >>"$log"

set +e
# shellcheck disable=SC2086 # extra_sim_flags intentionally expands into simulator plusargs.
python3 "$repo_dir/scripts/run_with_timeout.py" \
	--timeout-seconds "$timeout_seconds" \
	--label chipyard-archived-simulator-linux-smoke \
	-- "$simulator" +permissive $extra_sim_flags +permissive-off "$payload" >>"$log" 2>&1
status=$?
set -e

{
	printf 'eliza-evidence: raw_transcript_end\n'
	printf 'eliza-evidence: exit_code=%s\n' "$status"
	if [ "$status" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
	else
		printf 'eliza-evidence: status=BLOCKED\n'
	fi
} >>"$log"

cat "$log"
if [ "$status" -eq 0 ]; then
	exit 0
fi
exit 2
