#!/usr/bin/env sh
set -eu

variant_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
workspace_dir="$(CDPATH='' cd -- "$variant_dir/../../../.." && pwd)"
boot_transcript="${ELIZA_GENERATED_AP_BOOT_TRANSCRIPT:-$variant_dir/evidence/generated_eliza_ap_boot.transcript.log}"
agent_transcript="${ELIZA_GENERATED_AP_AGENT_TRANSCRIPT:-$variant_dir/evidence/generated_eliza_ap_agent_live.transcript.log}"
blocked_report="$variant_dir/evidence/generated_eliza_ap_capture_blocked.json"
chipyard_smoke_report="$workspace_dir/packages/chip/build/chipyard/eliza_rocket/verilator-linux-smoke.json"
chipyard_smoke_mirror="$workspace_dir/packages/chip/build/reports/chipyard_verilator_linux_smoke.json"
boot_cmd="${ELIZA_GENERATED_AP_CHIP_BOOT_CMD:-}"
agent_cmd="${ELIZA_GENERATED_AP_CHIP_AGENT_CMD:-}"
mode="${1:-run}"

usage() {
	printf 'usage: %s [plan|preflight|run]\n' "$0"
	printf '\n'
	printf 'Set ELIZA_GENERATED_AP_CHIP_BOOT_CMD to the command that boots the generated Eliza AP/chip emulator and prints the real serial transcript.\n'
	printf 'Optionally set ELIZA_GENERATED_AP_CHIP_AGENT_CMD to a command that probes the already-booted target and prints systemd, process, /api/health, and TUI readiness output.\n'
	printf '\n'
	printf 'Outputs, if the transcript validator passes:\n'
	printf '  evidence/generated_eliza_ap_boot.json\n'
	printf '  evidence/generated_eliza_ap_agent_live.json\n'
}

write_blocked_report() {
	mkdir -p "$(dirname -- "$blocked_report")"
	python3 - "$blocked_report" "$variant_dir" "$boot_transcript" "$agent_transcript" "$chipyard_smoke_report" "$chipyard_smoke_mirror" <<'PY'
import json
import sys
from pathlib import Path

blocked_report = Path(sys.argv[1])
variant_dir = Path(sys.argv[2])
boot_transcript = Path(sys.argv[3])
agent_transcript = Path(sys.argv[4])
smoke_candidates = [Path(sys.argv[5]), Path(sys.argv[6])]


def rel_variant(path: Path) -> str:
    try:
        return path.resolve().relative_to(variant_dir.resolve()).as_posix()
    except ValueError:
        return str(path)


def rel_workspace(path: str | None) -> str | None:
    if not path:
        return path
    return path


def load_latest_smoke() -> dict[str, object] | None:
    for candidate in smoke_candidates:
        if not candidate.is_file():
            continue
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        live = payload.get("live_sim_output")
        latest_live = live.get("latest") if isinstance(live, dict) else None
        active = payload.get("active_smoke_attempt")
        progress = payload.get("progress")
        log_metadata = payload.get("log_metadata")
        return {
            "report": rel_workspace(payload.get("report")) or str(candidate),
            "status": payload.get("status"),
            "log": payload.get("log"),
            "next_command": payload.get("next_command"),
            "blockers": payload.get("blockers", [])[:8]
            if isinstance(payload.get("blockers"), list)
            else [],
            "active_smoke_attempt": active if isinstance(active, dict) else {},
            "latest_live_sim_output": latest_live if isinstance(latest_live, dict) else {},
            "progress": progress if isinstance(progress, dict) else {},
            "log_metadata": {
                key: log_metadata.get(key)
                for key in (
                    "exit_code",
                    "timeout_after_seconds",
                    "last_progress_marker",
                    "raw_transcript_closed",
                    "run_target",
                )
            }
            if isinstance(log_metadata, dict)
            else {},
        }
    return None


payload: dict[str, object] = {
    "schema": "eliza.os.linux.generated_ap_capture_blocked.v1",
    "status": "blocked",
    "claim_boundary": "generated_eliza_ap_chip_emulator_required_no_qemu_virt_substitution",
    "boot_command_env": "ELIZA_GENERATED_AP_CHIP_BOOT_CMD",
    "agent_command_env": "ELIZA_GENERATED_AP_CHIP_AGENT_CMD",
    "boot_transcript": rel_variant(boot_transcript),
    "agent_transcript": rel_variant(agent_transcript),
    "required_outputs": [
        "evidence/generated_eliza_ap_boot.json",
        "evidence/generated_eliza_ap_agent_live.json",
    ],
    "blocked_reasons": [
        "ELIZA_GENERATED_AP_CHIP_BOOT_CMD is unset; no real generated Eliza AP/chip-emulator boot transcript can be captured",
        "qemu-virt reference transcripts are intentionally rejected for this evidence lane",
    ],
    "next_commands": [
        "cd ../../../chip && python3 scripts/wire_cpu_ap_capture_commands.py --format json",
        "cd ../../../chip && ELIZA_LINUX_BOOT_CMD=<command from wire output> python3 scripts/capture_cpu_ap_evidence.py intake linux-boot --source build/chipyard/eliza_rocket/verilator-linux-smoke.log --command '<exact generated-AP boot command>'",
        "ELIZA_GENERATED_AP_CHIP_BOOT_CMD='<real generated-AP boot command that prints serial transcript>' scripts/capture-generated-ap-chip-evidence.sh run",
        "python3 ../../../chip/scripts/check_os_rv64_chip_boot_contract.py",
    ],
}
latest_smoke = load_latest_smoke()
if latest_smoke is not None:
    payload["latest_chipyard_verilator_linux_smoke"] = latest_smoke

blocked_report.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

plan() {
	cat <<EOF
# Generated Eliza AP/chip-emulator OS evidence capture skeleton.
# Fill these with commands that run the real generated AP runtime.
# The wrapper archives stdout/stderr transcripts, then capture-chip-boot-evidence.py
# writes JSON only if the transcripts contain all required markers.
export ELIZA_GENERATED_AP_CHIP_BOOT_CMD=''
export ELIZA_GENERATED_AP_CHIP_AGENT_CMD=''
export ELIZA_GENERATED_AP_BOOT_TRANSCRIPT='${boot_transcript}'
export ELIZA_GENERATED_AP_AGENT_TRANSCRIPT='${agent_transcript}'

# Required boot transcript markers:
# - OpenSBI or SBI handoff markers
# - Linux version
# - elizaos-firstboot-ready
#
# Required agent/TUI transcript markers:
# - elizaos-agent-ready or systemctl is-active elizaos-agent.service: active
# - process.pid=<positive integer> or PID=<positive integer>
# - /opt/elizaos/bin/elizaos or process.command/process.executable containing elizaos
# - GET /api/health HTTP 200, GET /api/health 200, /api/health 200, or elizaos-curl-health-ready
# - agentId in the health response
# - full-agent marker/full-agent response
# - fallback_payload_used=false
# - elizaos-tui-ready

scripts/capture-generated-ap-chip-evidence.sh run
python3 ../../../chip/scripts/check_os_rv64_chip_boot_contract.py
EOF
}

preflight() {
	rc=0
	printf 'STATUS: RUN os_rv64.generated_ap_capture_preflight\n'
	if [ -z "$boot_cmd" ]; then
		printf '  - BLOCKED ELIZA_GENERATED_AP_CHIP_BOOT_CMD is unset\n'
		printf '    next: scripts/capture-generated-ap-chip-evidence.sh plan\n'
		write_blocked_report
		printf '    report: %s\n' "${blocked_report#"$variant_dir"/}"
		rc=2
	else
		printf '  - READY ELIZA_GENERATED_AP_CHIP_BOOT_CMD is set\n'
	fi
	if [ -z "$agent_cmd" ]; then
		printf '  - INFO ELIZA_GENERATED_AP_CHIP_AGENT_CMD is unset; boot transcript must include agent/API/TUI markers\n'
	else
		printf '  - READY ELIZA_GENERATED_AP_CHIP_AGENT_CMD is set\n'
	fi
	if [ "$rc" -eq 0 ]; then
		printf 'STATUS: PASS os_rv64.generated_ap_capture_preflight\n'
	else
		printf 'STATUS: BLOCKED os_rv64.generated_ap_capture_preflight\n'
	fi
	return "$rc"
}

capture_command() {
	label="$1"
	command_text="$2"
	output="$3"
	mkdir -p "$(dirname -- "$output")"
	{
		printf '## generated_ap_chip_evidence transcript\n'
		printf '## label: %s\n' "$label"
		printf '## command: %s\n' "$command_text"
		printf '## claim_boundary: generated_eliza_ap_chip_emulator_transcript_only_not_qemu_virt\n'
		printf '## qemu_virt_reference_evidence: not accepted for this capture\n'
		printf '##\n'
	} >"$output"

	set +e
	(
		cd "$variant_dir"
		sh -c "$command_text"
	) >>"$output" 2>&1
	status=$?
	set -e
	printf '## command_exit_code: %s\n' "$status" >>"$output"
	if [ "$status" -ne 0 ]; then
		printf 'STATUS: BLOCKED os_rv64.generated_ap_capture.%s\n' "$label"
		printf '  - command exited with status %s\n' "$status"
		printf '  - transcript: %s\n' "${output#"$variant_dir"/}"
		return "$status"
	fi
}

run_capture() {
	if ! preflight; then
		return 2
	fi
	capture_command boot "$boot_cmd" "$boot_transcript"
	if [ -n "$agent_cmd" ]; then
		capture_command agent "$agent_cmd" "$agent_transcript"
	else
		agent_transcript="$boot_transcript"
	fi

	"$variant_dir/scripts/capture-chip-boot-evidence.py" \
		--boot-transcript "$boot_transcript" \
		--agent-transcript "$agent_transcript" \
		--update-manifest
}

case "$mode" in
	-h|--help)
		usage
		;;
	plan)
		plan
		;;
	preflight)
		preflight
		;;
	run)
		run_capture
		;;
	*)
		usage >&2
		exit 2
		;;
esac
