#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
raw_dir="$repo_dir/build/evidence/cpu_ap/raw"
generated_manifest="${ELIZA_GENERATED_MANIFEST:-build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json}"
mode="${1:-all}"

usage() {
	printf 'usage: %s [preflight|wire|wire-preflight|plan|all|opensbi-boot|linux-boot|trap-timer-irq|isa-cache-mmu|ap-benchmarks]\n' "$0"
	printf '\n'
	printf 'Set one command env var per capture. Each command must run the generated AP simulator/test and print the real transcript to stdout/stderr:\n'
	printf '  ELIZA_OPENSBI_BOOT_CMD\n'
	printf '  ELIZA_LINUX_BOOT_CMD\n'
	printf '  ELIZA_TRAP_TIMER_IRQ_CMD\n'
	printf '  ELIZA_ISA_CACHE_MMU_CMD\n'
	printf '  ELIZA_AP_BENCHMARKS_CMD\n'
	printf '\n'
	printf 'Optional:\n'
	printf '  ELIZA_GENERATED_MANIFEST=%s\n' "$generated_manifest"
	printf '\n'
	printf 'Run all capture lanes after setting the command env vars:\n'
	printf '  %s all\n' "$0"
	printf '\n'
	printf 'Check command wiring without running the simulator:\n'
	printf '  %s preflight\n' "$0"
	printf '\n'
	printf 'Derive Linux-host command env vars from checked-in generated-AP runners where possible:\n'
	printf "  eval \"\$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)\"\n"
	printf '  %s wire-preflight\n' "$0"
	printf '\n'
	printf 'Marker checklist:\n'
	printf '  python3 scripts/capture_cpu_ap_evidence.py template all\n'
	printf '  python3 scripts/capture_cpu_ap_evidence.py plan all --format shell\n'
}

env_name_for_mode() {
	case "$1" in
		opensbi-boot) printf 'ELIZA_OPENSBI_BOOT_CMD' ;;
		linux-boot) printf 'ELIZA_LINUX_BOOT_CMD' ;;
		trap-timer-irq) printf 'ELIZA_TRAP_TIMER_IRQ_CMD' ;;
		isa-cache-mmu) printf 'ELIZA_ISA_CACHE_MMU_CMD' ;;
		ap-benchmarks) printf 'ELIZA_AP_BENCHMARKS_CMD' ;;
		*) return 1 ;;
	esac
}

preflight_mode() {
	capture_mode="$1"
	env_name="$(env_name_for_mode "$capture_mode")"
	command_text="$(eval "printf '%s' \"\${$env_name:-}\"")"
	if [ -z "$command_text" ]; then
		printf '  - BLOCKED %s: %s is unset\n' "$capture_mode" "$env_name"
		return 2
	fi
	printf '  - READY %s: %s is set\n' "$capture_mode" "$env_name"
	return 0
}

preflight_all() {
	rc=0
	printf 'STATUS: RUN cpu_ap.capture_preflight\n'
	printf '  generated_manifest: %s\n' "$generated_manifest"
	if [ ! -f "$repo_dir/$generated_manifest" ] && [ ! -f "$generated_manifest" ]; then
		printf '  - BLOCKED generated manifest is missing\n'
		printf '    next: generate/import ElizaRocketConfig before archiving boot evidence\n'
		rc=2
	fi
	for capture_mode in opensbi-boot linux-boot trap-timer-irq isa-cache-mmu ap-benchmarks; do
		if preflight_mode "$capture_mode"; then
			:
		else
			status=$?
			if [ "$status" -gt "$rc" ]; then
				rc="$status"
			fi
		fi
	done
	if [ "$rc" -eq 0 ]; then
		printf 'STATUS: PASS cpu_ap.capture_preflight - all command lanes are wired\n'
	else
		printf 'STATUS: BLOCKED cpu_ap.capture_preflight - capture wiring incomplete\n'
		printf '  next: python3 scripts/wire_cpu_ap_capture_commands.py --format shell\n'
	fi
	return "$rc"
}

wire_commands() {
	python3 "$repo_dir/scripts/wire_cpu_ap_capture_commands.py" --format shell
}

wire_preflight() {
	eval "$(python3 "$repo_dir/scripts/wire_cpu_ap_capture_commands.py" --format shell)"
	preflight_all
}

write_opensbi_blocker_report() {
	capture_mode="$1"
	phase="$2"
	command_status="$3"
	intake_status="${4:-}"
	if [ "$capture_mode" != "opensbi-boot" ]; then
		return 0
	fi
	OPENSBI_BLOCKER_REPO="$repo_dir" \
	OPENSBI_BLOCKER_RAW="$raw_log" \
	OPENSBI_BLOCKER_COMMAND="$command_text" \
	OPENSBI_BLOCKER_PHASE="$phase" \
	OPENSBI_BLOCKER_COMMAND_STATUS="$command_status" \
	OPENSBI_BLOCKER_INTAKE_STATUS="$intake_status" \
	OPENSBI_BLOCKER_GENERATED_MANIFEST="$generated_manifest" \
	python3 - <<'PY'
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

repo = Path(os.environ["OPENSBI_BLOCKER_REPO"])
sys.path.insert(0, str(repo / "scripts"))

from cpu_ap_evidence_lib import load_evidence_manifest, rel, sha256_path, transcript_specs

raw_path = Path(os.environ["OPENSBI_BLOCKER_RAW"])
if not raw_path.is_absolute():
    raw_path = repo / raw_path
report_path = repo / "build/reports/cpu_ap_opensbi_boot_regeneration_blocked.json"
evidence_path = repo / "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log"
generated_manifest = Path(os.environ["OPENSBI_BLOCKER_GENERATED_MANIFEST"])
if not generated_manifest.is_absolute():
    generated_manifest = repo / generated_manifest

raw_text = raw_path.read_text(encoding="utf-8", errors="ignore") if raw_path.is_file() else ""
errors: list[str] = []
manifest = load_evidence_manifest(errors)
spec = transcript_specs(manifest).get("opensbi_boot_log", {})
required = [str(item) for item in spec.get("raw_required_strings", []) if isinstance(item, str)]
present = [marker for marker in required if marker in raw_text]
missing = [marker for marker in required if marker not in raw_text]

handoff_markers = [
    "Platform Name",
    "Platform Timer Device",
    "Platform Console Device",
    "Firmware Base",
    "Runtime SBI Version",
    "Domain0 Next Address",
    "Domain0 Next Mode",
    "Boot HART ID",
    "Boot HART Base ISA",
]
has_banner = "OpenSBI v" in raw_text
has_any_handoff = any(marker in raw_text for marker in handoff_markers)
has_all_handoff = all(marker in raw_text for marker in handoff_markers)
if has_banner and not has_any_handoff:
    diagnosis = "opensbi_banner_only_no_platform_or_handoff_table"
elif has_banner and not has_all_handoff:
    diagnosis = "opensbi_partial_handoff_table_missing_required_markers"
elif has_banner:
    diagnosis = "opensbi_markers_present_but_capture_or_intake_failed"
else:
    diagnosis = "no_opensbi_banner_in_raw_attempt"

progress_patterns = (
    "OpenSBI v",
    "Linux version",
    "SBI specification",
    "SBI implementation ID",
    "SBI TIME extension",
    "SBI IPI extension",
    "SBI RFENCE extension",
    "SBI SRST extension",
    "earlycon: sbi",
    "bootconsole [sbi0] enabled",
    "Forcing kernel command line",
    "Domain0 Next Address",
    "Boot HART ID",
    "Runtime SBI Version",
    "Platform Name",
    "SimDRAM loaded ELF",
    "[UART]",
)
progress = [
    line.strip()
    for line in raw_text.splitlines()
    if any(pattern in line for pattern in progress_patterns)
]
last_progress = progress[-1] if progress else ""
linux_sbi_markers = [
    line.strip()
    for line in raw_text.splitlines()
    if any(
        marker in line
        for marker in (
            "Linux version",
            "SBI specification",
            "SBI implementation ID",
            "SBI TIME extension",
            "SBI IPI extension",
            "SBI RFENCE extension",
            "SBI SRST extension",
            "earlycon: sbi",
            "bootconsole [sbi0] enabled",
            "Forcing kernel command line",
        )
    )
]
status_markers = sorted(set(re.findall(r"eliza-evidence: status=([A-Z]+)", raw_text)))
exit_codes = sorted(set(re.findall(r"eliza-evidence: exit_code=([0-9]+)", raw_text)))
timeout_seconds = sorted(set(re.findall(r"timeout(?:_after)?_seconds=([0-9]+)", raw_text)))

existing_text = (
    evidence_path.read_text(encoding="utf-8", errors="ignore") if evidence_path.is_file() else ""
)
recorded_sha = None
match = re.search(r"^eliza-evidence: generated_manifest_sha256=([0-9a-fA-F]+)$", existing_text, re.M)
if match:
    recorded_sha = match.group(1).lower()
current_sha = sha256_path(generated_manifest) if generated_manifest.is_file() else None

blockers: list[str] = []
if errors:
    blockers.extend(f"manifest error: {error}" for error in errors)
if not raw_path.is_file():
    blockers.append(f"raw transcript is missing: {rel(raw_path)}")
elif missing:
    if diagnosis == "opensbi_banner_only_no_platform_or_handoff_table":
        blockers.append(
            "generated-AP output reaches the OpenSBI banner but never emits the accepted "
            "platform/domain/Boot HART handoff table"
        )
    elif diagnosis == "no_opensbi_banner_in_raw_attempt":
        blockers.append("generated-AP output does not emit the OpenSBI banner")
        if linux_sbi_markers:
            blockers.append(
                "raw output reaches Linux early console/SBI detection, but the OpenSBI "
                "platform/domain/Boot HART table is not visible on the captured transcript"
            )
    else:
        blockers.append("generated-AP OpenSBI transcript is missing required raw markers")
    blockers.append("missing OpenSBI raw markers: " + ", ".join(missing))
if os.environ["OPENSBI_BLOCKER_COMMAND_STATUS"] not in ("", "0"):
    blockers.append(
        "capture command exited nonzero before evidence could be archived: "
        + os.environ["OPENSBI_BLOCKER_COMMAND_STATUS"]
    )
if os.environ["OPENSBI_BLOCKER_INTAKE_STATUS"] not in ("", "0"):
    blockers.append(
        "intake refused to rewrite eliza_e1_opensbi_boot.log: "
        + os.environ["OPENSBI_BLOCKER_INTAKE_STATUS"]
    )
if recorded_sha and current_sha and recorded_sha != current_sha:
    blockers.append(
        "existing OpenSBI evidence is stale: recorded generated_manifest_sha256="
        f"{recorded_sha} current={current_sha}"
    )

report = {
    "schema": "eliza.cpu_ap_opensbi_boot_regeneration.v1",
    "status": "blocked",
    "claim_boundary": "blocked_report_only_no_hash_rewrite_no_opensbi_evidence_regenerated",
    "generated_utc": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "phase": os.environ["OPENSBI_BLOCKER_PHASE"],
    "attempt_command": os.environ["OPENSBI_BLOCKER_COMMAND"],
    "command_status": os.environ["OPENSBI_BLOCKER_COMMAND_STATUS"],
    "intake_status": os.environ["OPENSBI_BLOCKER_INTAKE_STATUS"] or None,
    "raw_attempt": rel(raw_path),
    "raw_attempt_exists": raw_path.is_file(),
    "raw_attempt_size_bytes": raw_path.stat().st_size if raw_path.is_file() else 0,
    "evidence_log": rel(evidence_path),
    "evidence_log_rewritten": False,
    "generated_manifest": rel(generated_manifest),
    "generated_manifest_exists": generated_manifest.is_file(),
    "generated_manifest_sha256": current_sha,
    "existing_evidence_generated_manifest_sha256": recorded_sha,
    "existing_evidence_stale": bool(recorded_sha and current_sha and recorded_sha != current_sha),
    "diagnosis": diagnosis,
    "required_raw_markers": required,
    "present_raw_markers": present,
    "missing_raw_markers": missing,
    "observed_status_markers": status_markers,
    "observed_exit_codes": exit_codes,
    "observed_timeout_seconds": timeout_seconds,
    "observed_linux_sbi_markers": linux_sbi_markers,
    "last_observed_progress_marker": last_progress,
    "blockers": blockers,
    "next_smallest_step": (
        "Fix generated-AP OpenSBI console/early text progression so the real simulator output "
        "emits Platform, Domain0, and Boot HART handoff markers, then rerun "
        "eval \"$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)\" && "
        "scripts/capture_chipyard_linux_evidence.sh opensbi-boot."
    ),
}
report_path.parent.mkdir(parents=True, exist_ok=True)
report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(f"  report: {rel(report_path)}")
PY
}

run_mode() {
	capture_mode="$1"
	env_name="$(env_name_for_mode "$capture_mode")"
	command_text="$(eval "printf '%s' \"\${$env_name:-}\"")"
	if [ -z "$command_text" ]; then
		printf 'STATUS: BLOCKED cpu_ap.capture.%s\n' "$capture_mode"
		printf '  - %s is unset\n' "$env_name"
		printf '  - run: python3 scripts/capture_cpu_ap_evidence.py template %s\n' "$capture_mode"
		return 2
	fi

	mkdir -p "$raw_dir"
	raw_log="$raw_dir/${capture_mode}.raw.log"
	printf 'STATUS: RUN cpu_ap.capture.%s\n' "$capture_mode"
	printf '  command_env: %s\n' "$env_name"
	printf '  raw_log: %s\n' "${raw_log#"$repo_dir"/}"

	set +e
	(
		cd "$repo_dir"
		sh -c "$command_text"
	) >"$raw_log" 2>&1
	status=$?
	set -e
	if [ "$status" -ne 0 ]; then
		printf 'STATUS: FAIL cpu_ap.capture.%s\n' "$capture_mode"
		printf '  - command exited with status %s\n' "$status"
		printf '  - raw transcript kept at %s\n' "${raw_log#"$repo_dir"/}"
		write_opensbi_blocker_report "$capture_mode" "command_failed" "$status" ""
		return "$status"
	fi

	set +e
	python3 "$repo_dir/scripts/capture_cpu_ap_evidence.py" intake "$capture_mode" \
		--source "$raw_log" \
		--command "$command_text" \
		--generated-manifest "$generated_manifest"
	status=$?
	set -e
	if [ "$status" -ne 0 ]; then
		write_opensbi_blocker_report "$capture_mode" "intake_failed" "0" "$status"
	fi
	return "$status"
}

case "$mode" in
	-h|--help)
		usage
		exit 0
		;;
plan)
	python3 "$repo_dir/scripts/capture_cpu_ap_evidence.py" plan all --format shell
	;;
preflight)
	preflight_all
	;;
wire)
	wire_commands
	;;
wire-preflight)
	wire_preflight
	;;
all)
		rc=0
		for capture_mode in opensbi-boot linux-boot trap-timer-irq isa-cache-mmu ap-benchmarks; do
			if run_mode "$capture_mode"; then
				:
			else
				status=$?
				if [ "$status" -gt "$rc" ]; then
					rc="$status"
				fi
			fi
		done
		exit "$rc"
		;;
	opensbi-boot|linux-boot|trap-timer-irq|isa-cache-mmu|ap-benchmarks)
		run_mode "$mode"
		;;
	*)
		usage >&2
		exit 2
		;;
esac
