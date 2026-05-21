#!/usr/bin/env python3
"""Gate Linux RV64 OS evidence for the chip/emulator boot objective.

The OS variant's own release gate is intentionally scoped to a generic
qemu-virt Debian artifact. This chip-side gate answers a different question:
does the current Linux fork evidence prove boot on the Eliza chip/AP emulator
and prove the Eliza agent is live? Today the expected answer is BLOCKED.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
VARIANT = WORKSPACE / "os/linux/elizaos"
MANIFEST = VARIANT / "manifest.json"
if not MANIFEST.exists() and (VARIANT / "manifest.json.template").exists():
    MANIFEST = VARIANT / "manifest.json.template"
STATUS_REPORT = VARIANT / "README.md"
QEMU_EVIDENCE = VARIANT / "evidence/qemu_virt_boot.json"
FIRST_BOOT = VARIANT / "config/includes.chroot/usr/lib/elizaos/first-boot.sh"
if not FIRST_BOOT.exists():
    FIRST_BOOT = VARIANT / "config/includes.chroot/usr/local/lib/elizaos/first-boot.sh"
AGENT_UNIT = VARIANT / "config/includes.chroot/etc/systemd/system/elizaos-agent.service"
AGENT_INSTALL_HOOK = VARIANT / "config/hooks/normal/0010-elizaos-agent.hook.chroot"
RELEASE_CHECK = VARIANT / "scripts/check_release_manifest.py"
TUI_SMOKE_UNIT = (
    VARIANT / "config/includes.chroot/etc/systemd/system/elizaos-terminal-tui-smoke.service"
)
TUI_SMOKE_SCRIPT = VARIANT / "config/includes.chroot/usr/lib/elizaos/run-terminal-tui-smoke.sh"
REPORT = ROOT / "build/reports/os_rv64_chip_boot_contract.json"
SCHEMA = "eliza.os_rv64_chip_boot_contract.v1"
CLAIM_BOUNDARY = "chip_objective_gate_no_qemu_virt_or_first_boot_marker_substitution"

CHIP_BOOT_EVIDENCE_IDS = {
    "generated-eliza-ap-boot",
    "eliza-chip-emulator-boot",
    "chip-target-linux-boot",
}
AGENT_LIVE_EVIDENCE_IDS = {
    "elizaos-agent-live",
    "elizaos-agent-health",
    "linux-agent-health",
}
QEMU_ONLY_BOUNDARY_MARKERS = (
    "qemu_virt",
    "no_silicon",
    "no physical-board",
    "not e1-chip",
)


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def read_json(path: Path) -> dict[str, object]:
    text = read_text(path)
    if path.name == "manifest.json.template":
        text = (
            text.replace("@@ARCH@@", "riscv64")
            .replace("@@PROFILE@@", "default")
            .replace("@@FILENAME@@", "elizaos-linux-riscv64-template.iso")
            .replace("@@BUILD_TIMESTAMP@@", "template")
            .replace("@@SHA256@@", "0" * 64)
            .replace("@@SIZE_BYTES@@", "null")
        )
    return json.loads(text)


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def evidence_rows(manifest: dict[str, object]) -> dict[str, dict[str, object]]:
    validation = manifest.get("validation", {})
    raw = validation.get("evidence", []) if isinstance(validation, dict) else []
    rows: dict[str, dict[str, object]] = {}
    if isinstance(raw, list):
        for row in raw:
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                rows[str(row["id"])] = row
    elif isinstance(validation, dict):
        mapped = {
            "qemuBoot": "qemu-virt-boot",
            "agentHealth": "elizaos-agent-live",
            "terminalTui": "elizaos-terminal-tui-live",
        }
        for key, evidence_id in mapped.items():
            value = validation.get(key)
            if isinstance(value, dict):
                rows[evidence_id] = {
                    "id": evidence_id,
                    "status": value.get("status"),
                    "path": value.get("evidence"),
                }
    return rows


def required_evidence(manifest: dict[str, object]) -> set[str]:
    validation = manifest.get("validation", {})
    raw = validation.get("requiredEvidence", []) if isinstance(validation, dict) else []
    required = {str(item) for item in raw if isinstance(item, str)}
    if isinstance(validation, dict):
        if "qemuBoot" in validation:
            required.add("qemu-virt-boot")
        if "agentHealth" in validation:
            required.add("elizaos-agent-live")
        if "terminalTui" in validation:
            required.add("elizaos-terminal-tui-live")
    return required


def resolve_variant_path(path_value: object) -> Path | None:
    if not isinstance(path_value, str) or not path_value:
        return None
    candidate = Path(path_value)
    if not candidate.is_absolute():
        return (VARIANT / candidate).resolve()
    if candidate.is_file():
        return candidate
    fallback = VARIANT / "evidence" / candidate.name
    if fallback.is_file():
        return fallback.resolve()
    return candidate


def transcript_text(evidence: dict[str, object]) -> tuple[str, str]:
    inline = evidence.get("transcript")
    if isinstance(inline, str):
        return inline, "inline transcript"
    transcript_path = resolve_variant_path(evidence.get("transcript_path"))
    if transcript_path is None:
        return "", "missing transcript_path"
    if not transcript_path.is_file():
        return "", f"missing transcript file {transcript_path}"
    return read_text(transcript_path), rel(transcript_path)


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
) -> None:
    if condition:
        findings.append(Finding(code, "blocker", message, evidence, next_step))


def agent_binary_path(unit_text: str) -> str | None:
    match = re.search(r"^ExecStart=(\S+)", unit_text, flags=re.MULTILINE)
    return match.group(1) if match else None


def agent_installer_packages_binary(path_value: str | None) -> bool:
    if not path_value or not AGENT_INSTALL_HOOK.is_file():
        return False
    hook = read_text(AGENT_INSTALL_HOOK)
    if path_value == "/opt/elizaos/bin/bun":
        return (
            "/opt/elizaos-artifacts" in hook
            and "bun.sha256" in hook
            and "install -m 0755" in hook
            and "${INSTALL}/bin/bun" in hook
        )
    if path_value != "/opt/elizaos/bin/elizaos":
        return False
    return (
        "bun-linux-riscv64-musl.zip" in hook
        and "sha256sum" in hook
        and "AGENT_BIN_SOURCE" in hook
        and "${INSTALL_ROOT}/bin/elizaos" in hook
    )


def packaged_agent_binary_exists(path_value: str | None) -> bool:
    if not path_value:
        return False
    absolute = path_value.lstrip("/")
    candidates = (
        VARIANT / "config/includes.chroot" / absolute,
        VARIANT / "config/includes.binary" / absolute,
    )
    return any(candidate.exists() for candidate in candidates) or agent_installer_packages_binary(
        path_value
    )


def marker_position(text: str, needle: str) -> int | None:
    pos = text.find(needle)
    return pos if pos >= 0 else None


def qemu_boundary_is_reference_only(boundary: str) -> bool:
    lowered = boundary.lower()
    return any(marker in lowered for marker in QEMU_ONLY_BOUNDARY_MARKERS)


def run_check(args: argparse.Namespace) -> dict[str, object]:
    manifest_path = Path(args.manifest) if args.manifest else MANIFEST
    qemu_evidence_path = Path(args.qemu_evidence) if args.qemu_evidence else QEMU_EVIDENCE
    required_inputs = (
        manifest_path,
        STATUS_REPORT,
        qemu_evidence_path,
        FIRST_BOOT,
        AGENT_UNIT,
        RELEASE_CHECK,
        TUI_SMOKE_UNIT,
        TUI_SMOKE_SCRIPT,
    )
    findings: list[Finding] = []
    for path in required_inputs:
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required Linux RV64 chip-boot contract input is missing",
            rel(path),
            "Restore or generate the missing input before evaluating chip-target Linux boot readiness.",
        )
    if findings:
        return payload(findings, {})

    manifest = read_json(manifest_path)
    qemu_evidence = read_json(qemu_evidence_path)
    rows = evidence_rows(manifest)
    required_ids = required_evidence(manifest)
    row_ids = set(rows)
    chip_ids_present = sorted((required_ids | row_ids) & CHIP_BOOT_EVIDENCE_IDS)
    agent_ids_present = sorted((required_ids | row_ids) & AGENT_LIVE_EVIDENCE_IDS)
    target = manifest.get("target", {})
    if not isinstance(target, dict):
        target = {
            "platform": manifest.get("platform"),
            "architecture": manifest.get("architecture"),
            "device": manifest.get("device"),
            "hypervisor": manifest.get("hypervisor"),
            "firmware": manifest.get("firmware"),
        }
    target_device = target.get("device") if isinstance(target, dict) else None
    target_hypervisor = target.get("hypervisor") if isinstance(target, dict) else None
    qemu_boundary = str(qemu_evidence.get("claim_boundary", ""))
    qemu_provenance = qemu_evidence.get("provenance")
    transcript, transcript_source = transcript_text(qemu_evidence)
    status_report = read_text(STATUS_REPORT)
    first_boot = read_text(FIRST_BOOT)
    agent_unit = read_text(AGENT_UNIT)
    release_check = read_text(RELEASE_CHECK)
    exec_start = agent_binary_path(agent_unit)
    collected_qemu_or_grub = any(
        rows.get(evidence_id, {}).get("status") == "collected"
        for evidence_id in ("qemu-virt-boot", "grub-efi-riscv64-boot")
    )
    manifest_size_bytes = manifest.get("sizeBytes")
    manifest_has_real_artifact = (
        manifest.get("status") in {"candidate", "published"}
        and isinstance(manifest.get("filename"), str)
        and not str(manifest.get("filename")).endswith("template.iso")
        and isinstance(manifest_size_bytes, int)
        and manifest_size_bytes > 1
    )

    add_if(
        findings,
        not chip_ids_present,
        "missing_chip_target_boot_evidence_row",
        "Linux RV64 manifest has no required evidence row for generated Eliza AP/chip-emulator boot",
        f"requiredEvidence={sorted(required_ids)} evidenceRows={sorted(row_ids)}",
        "Add a chip-target boot evidence row backed by a generated Eliza AP/chip-emulator serial transcript.",
    )
    add_if(
        findings,
        not agent_ids_present,
        "missing_agent_live_evidence_row",
        "Linux RV64 manifest has no required evidence row for Eliza agent liveness",
        f"requiredEvidence={sorted(required_ids)} evidenceRows={sorted(row_ids)}",
        "Add an agent-live evidence row requiring service active status and a local API/health smoke.",
    )
    add_if(
        findings,
        target_device is None and target_hypervisor is None,
        "manifest_target_is_generic",
        "Linux RV64 manifest target is not bound to an Eliza chip device or emulator",
        json.dumps(target, sort_keys=True),
        "Publish a chip-target manifest or variant with explicit device/emulator/firmware metadata.",
    )
    add_if(
        findings,
        qemu_provenance == "qemu_virt" or qemu_boundary_is_reference_only(qemu_boundary),
        "qemu_virt_evidence_is_reference_only",
        "current Linux boot evidence is qemu-virt reference evidence, not Eliza chip/AP boot evidence",
        f"provenance={qemu_provenance!r} claim_boundary={qemu_boundary!r}",
        "Keep qemu-virt evidence as OS reference evidence and capture a separate generated-AP/chip-emulator boot transcript.",
    )
    add_if(
        findings,
        manifest_has_real_artifact
        and collected_qemu_or_grub
        and (
            "no_iso_built_no_qemu_boot_captured" in status_report
            or "No claim is made anywhere in this document that an ISO was built" in status_report
            or "No transcript is committed" in status_report
        ),
        "os_rv64_status_report_stale_against_manifest",
        "Linux RV64 STATUS.md still describes no ISO/qemu evidence even though the current manifest has a candidate artifact and collected emulator evidence",
        f"{rel(STATUS_REPORT)} vs {rel(manifest_path)}",
        "Regenerate STATUS.md from the manifest/check output and keep qemu-virt scope explicitly separate from chip-target/agent-live readiness.",
    )
    add_if(
        findings,
        "agent binary missing" in transcript,
        "transcript_agent_binary_missing",
        "boot transcript says the Eliza agent binary is missing",
        f"{transcript_source}: agent binary missing at /opt/elizaos/bin/elizaos",
        "Package the real RV64 agent binary and rerun the boot transcript until the service starts.",
    )
    ready_pos = marker_position(first_boot, "READY_LINE=")
    agent_start_pos = marker_position(first_boot, "systemctl start")
    add_if(
        findings,
        "elizaos-ready" in first_boot
        and ready_pos is not None
        and agent_start_pos is not None
        and ready_pos < agent_start_pos,
        "elizaos_ready_marker_before_agent_start",
        "`elizaos-ready` is emitted before the first-boot script attempts to start elizaos-agent.service",
        f"{rel(FIRST_BOOT)} READY_LINE offset={ready_pos} systemctl_start offset={agent_start_pos}",
        "Split first-boot readiness from agent readiness, e.g. `elizaos-firstboot-ready` and `elizaos-agent-ready`.",
    )
    add_if(
        findings,
        "prints once the agent is up" in release_check and "elizaos-ready" in release_check,
        "linux_release_gate_overstates_elizaos_ready_marker",
        "Linux release checker comments describe elizaos-ready as agent-up even though first boot can emit it before/without the agent",
        rel(RELEASE_CHECK),
        "Update release-gate wording and checks so `elizaos-ready` means first boot only, and agent liveness has a separate required marker.",
    )
    add_if(
        findings,
        not packaged_agent_binary_exists(exec_start),
        "agent_execstart_not_packaged",
        "elizaos-agent.service ExecStart target is not packaged into the RV64 image tree",
        f"ExecStart={exec_start!r}",
        "Stage a real `/opt/elizaos/bin/elizaos` binary or package into config/includes before requiring agent-live evidence.",
    )
    add_if(
        findings,
        "elizaos-agent-ready" not in transcript
        and "systemctl is-active elizaos-agent.service: active" not in transcript
        and "/api/health" not in transcript,
        "missing_agent_liveness_marker",
        "boot transcript lacks an agent-live marker, active service check, or API health smoke",
        transcript_source,
        "Capture `systemctl is-active elizaos-agent.service` and a localhost health/API probe in the Linux boot evidence.",
    )
    add_if(
        findings,
        "elizaos-tui-ready" not in transcript,
        "missing_tui_liveness_marker",
        "boot transcript lacks a terminal TUI startup marker",
        transcript_source,
        "Run the terminal TUI smoke in the boot target and capture `elizaos-tui-ready` in the Linux boot evidence.",
    )

    evidence = {
        "manifest": rel(manifest_path),
        "qemu_evidence": rel(qemu_evidence_path),
        "target": target,
        "required_evidence": sorted(required_ids),
        "evidence_rows": sorted(row_ids),
        "chip_boot_evidence_ids_present": chip_ids_present,
        "agent_live_evidence_ids_present": agent_ids_present,
        "qemu_claim_boundary": qemu_boundary,
        "qemu_provenance": qemu_provenance,
        "transcript_source": transcript_source,
        "agent_execstart": exec_start,
        "status_report": rel(STATUS_REPORT),
        "tui_smoke_unit": rel(TUI_SMOKE_UNIT),
        "tui_smoke_script": rel(TUI_SMOKE_SCRIPT),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(finding) for finding in findings],
        "evidence": evidence,
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} os_rv64.chip_boot_contract")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", help="OS RV64 manifest to inspect")
    parser.add_argument("--qemu-evidence", help="qemu-virt evidence JSON to inspect")
    parser.add_argument(
        "--report",
        default=str(REPORT),
        help=f"report path (default: {REPORT.relative_to(ROOT)})",
    )
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
