#!/usr/bin/env python3
"""Gate Linux RV64 OS evidence for the chip/emulator boot objective.

The OS variant's own release gate is intentionally scoped to a generic
qemu-virt Debian artifact. This chip-side gate answers a different question:
does the current Linux fork evidence prove boot on the Eliza chip/AP emulator
and prove the Eliza agent is live? Today the expected answer is BLOCKED.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
REPO = ROOT.parents[1]
VARIANT = WORKSPACE / "os/linux/elizaos"
CHIP_MANIFEST = VARIANT / "chip-boot-manifest.json"
MANIFEST = CHIP_MANIFEST if CHIP_MANIFEST.exists() else VARIANT / "manifest.json"
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
CAPTURE_SCRIPT = "packages/os/linux/elizaos/scripts/capture-chip-boot-evidence.py"
CAPTURE_TRANSCRIPT_PLACEHOLDER = "/path/to/generated-ap-serial.log"
AGENT_TRANSCRIPT_PLACEHOLDER = "/path/to/agent-health.log"
RECHECK_COMMAND = (
    "python3 packages/chip/scripts/check_os_rv64_chip_boot_contract.py --json-only"
)

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
DEFAULT_CHIP_BOOT_EVIDENCE = VARIANT / "evidence/generated_eliza_ap_boot.json"
DEFAULT_AGENT_LIVE_EVIDENCE = VARIANT / "evidence/generated_eliza_ap_agent_live.json"
CHIP_PROVENANCE_MARKERS = (
    "generated_eliza_ap",
    "generated-eliza-ap",
    "chip_emulator",
    "chip-emulator",
    "eliza_chip",
    "eliza-chip",
)
CHIP_BOOT_TRANSCRIPT_MARKER_GROUPS = (
    ("OpenSBI", "SBI specification", "SBI implementation ID=", "Domain0 Next Address"),
    ("Linux version",),
    ("elizaos-firstboot-ready",),
)
AGENT_LIVE_SCHEMA = "eliza.os.linux.agent_live.v1"
AGENT_SERVICE_NAME = "elizaos-agent.service"


def object_at(payload: dict[str, object], key: str) -> dict[str, object]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def bool_at(payload: dict[str, object], key: str) -> bool | None:
    value = payload.get(key)
    return value if isinstance(value, bool) else None


def int_at(payload: dict[str, object], key: str) -> int | None:
    value = payload.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def agent_live_schema_findings(evidence: dict[str, object]) -> list[str]:
    missing: list[str] = []
    if evidence.get("schema") != AGENT_LIVE_SCHEMA:
        missing.append(f"schema={AGENT_LIVE_SCHEMA}")
    if not chip_evidence_has_chip_provenance(evidence):
        missing.append("chip provenance/claim_boundary")
    if evidence.get("fallback_payload_used") is not False:
        missing.append("fallback_payload_used=false")
    if evidence.get("full_agent_bundle") is not True:
        missing.append("full_agent_bundle=true")

    service = object_at(evidence, "service")
    if service.get("name") != AGENT_SERVICE_NAME:
        missing.append(f"service.name={AGENT_SERVICE_NAME}")
    if service.get("active") is not True:
        missing.append("service.active=true")
    if service.get("systemctl_is_active") != "active":
        missing.append("service.systemctl_is_active=active")

    process = object_at(evidence, "process")
    pid = int_at(process, "pid")
    if pid is None or pid <= 0:
        missing.append("process.pid>0")
    command = str(process.get("command", ""))
    executable = str(process.get("executable", ""))
    if "elizaos" not in command and "elizaos" not in executable:
        missing.append("process.command/executable contains elizaos")

    health = object_at(evidence, "health")
    if "/api/health" not in str(health.get("url", "")):
        missing.append("health.url contains /api/health")
    if health.get("http_status") != 200:
        missing.append("health.http_status=200")
    if health.get("ready") is not True and health.get("status") not in {"ready", "ok", "healthy"}:
        missing.append("health ready/status")
    response = health.get("response")
    if not isinstance(response, dict):
        missing.append("health.response object")
    elif response.get("agentId") in {None, "", "fallback"}:
        missing.append("health.response.agentId real")
    return missing


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def next_command_plan(findings: list[Finding]) -> list[dict[str, object]]:
    """Return executable capture steps without converting blockers into evidence."""

    if not findings:
        return []
    codes = {finding.code for finding in findings}
    plan: list[dict[str, object]] = []
    if any(
        code.startswith("chip_target_boot")
        or code in {
            "missing_chip_target_boot_evidence_row",
            "missing_agent_liveness_marker",
            "missing_tui_liveness_marker",
        }
        for code in codes
    ):
        plan.append(
            {
                "id": "write_blocked_boot_evidence_from_real_transcript",
                "scope": "host",
                "claim_boundary": "diagnostic_blocked_evidence_only_not_live_capture_proof",
                "command": (
                    f"{CAPTURE_SCRIPT} "
                    f"--boot-transcript {CAPTURE_TRANSCRIPT_PLACEHOLDER} "
                    "--write-blocked"
                ),
                "requires": [
                    "real generated Eliza AP/chip-emulator serial transcript",
                    "OpenSBI and Linux boot markers in transcript",
                ],
            }
        )
    if any(
        code.startswith("agent_live")
        or code in {"missing_agent_liveness_marker", "missing_tui_liveness_marker"}
        for code in codes
    ):
        plan.append(
            {
                "id": "write_blocked_agent_live_evidence_from_real_transcript",
                "scope": "host",
                "claim_boundary": "diagnostic_blocked_evidence_only_not_live_capture_proof",
                "command": (
                    f"{CAPTURE_SCRIPT} "
                    f"--boot-transcript {CAPTURE_TRANSCRIPT_PLACEHOLDER} "
                    f"--agent-transcript {AGENT_TRANSCRIPT_PLACEHOLDER} "
                    "--write-blocked"
                ),
                "requires": [
                    "real generated Eliza AP/chip-emulator boot transcript",
                    "real target transcript containing service, process, and /api/health probes",
                ],
            }
        )
        plan.append(
            {
                "id": "target_agent_live_probe_transcript",
                "scope": "target",
                "claim_boundary": "operator_target_commands_only_not_repo_local_evidence",
                "command": (
                    "systemctl is-active elizaos-agent.service; "
                    "ps -eo pid,args | grep '/opt/elizaos/bin/elizaos'; "
                    "curl -fsS http://127.0.0.1:31337/api/health; "
                    "systemctl start elizaos-terminal-tui-smoke.service; "
                    "journalctl -u elizaos-terminal-tui-smoke.service --no-pager"
                ),
                "requires": ["running generated Eliza AP/chip-emulator Linux target"],
            }
        )
    plan.append(
        {
            "id": "recheck_contract",
            "scope": "host",
            "claim_boundary": CLAIM_BOUNDARY,
            "command": RECHECK_COMMAND,
            "requires": ["repo checkout after evidence JSON update"],
        }
    )
    return plan


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
        return path.relative_to(REPO).as_posix()
    except ValueError:
        pass
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
    if candidate.is_file():
        return candidate
    if not candidate.is_absolute():
        repo_candidate = (REPO / candidate).resolve()
        if repo_candidate.is_file():
            return repo_candidate
        variant_candidate = (VARIANT / candidate).resolve()
        if variant_candidate.is_file():
            return variant_candidate
        if path_value.startswith("packages/"):
            return repo_candidate
        return variant_candidate
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
        return "", f"missing transcript file {rel(transcript_path)}"
    return read_text(transcript_path), rel(transcript_path)


def evidence_row_path(row: dict[str, object], default: Path) -> tuple[Path, str]:
    path_value = row.get("path")
    if isinstance(path_value, str) and path_value:
        candidate = resolve_variant_path(path_value)
        if candidate is not None:
            return candidate, path_value
    return default.resolve(), rel(default)


def first_evidence_row(
    rows: dict[str, dict[str, object]], evidence_ids: set[str]
) -> tuple[str | None, dict[str, object] | None]:
    for evidence_id in sorted(evidence_ids):
        row = rows.get(evidence_id)
        if row is not None:
            return evidence_id, row
    return None, None


def load_evidence_json(path: Path) -> tuple[dict[str, object] | None, str | None]:
    if not path.is_file():
        return None, f"evidence file not present: {rel(path)}"
    try:
        payload = read_json(path)
    except json.JSONDecodeError as exc:
        return None, f"evidence JSON invalid at {rel(path)}: {exc}"
    if not isinstance(payload, dict):
        return None, f"evidence JSON must be an object: {rel(path)}"
    return payload, None


def row_path_is_qemu_reference(row: dict[str, object], qemu_evidence_path: Path) -> bool:
    path_value = row.get("path")
    if not isinstance(path_value, str) or not path_value:
        return False
    candidate = resolve_variant_path(path_value)
    if candidate is None:
        return False
    try:
        return candidate.resolve() == qemu_evidence_path.resolve()
    except OSError:
        return candidate.name == qemu_evidence_path.name


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


def missing_marker_groups(text: str, groups: tuple[tuple[str, ...], ...]) -> list[str]:
    missing: list[str] = []
    for group in groups:
        if not any(marker in text for marker in group):
            missing.append(" one of ".join(group))
    return missing


def transcript_has_agent_liveness(text: str) -> bool:
    return any(
        marker in text
        for marker in (
            "elizaos-agent-ready",
            "systemctl is-active elizaos-agent.service: active",
            "systemctl is-active elizaos-agent.service\nactive",
            "systemctl_is_active=active",
            "/api/health",
        )
    )


def qemu_boundary_is_reference_only(boundary: str) -> bool:
    lowered = boundary.lower()
    return any(marker in lowered for marker in QEMU_ONLY_BOUNDARY_MARKERS)


def chip_evidence_is_qemu_reference(evidence: dict[str, object]) -> bool:
    provenance = str(evidence.get("provenance", "")).lower()
    boundary = str(evidence.get("claim_boundary", "")).lower()
    schema = str(evidence.get("schema", "")).lower()
    return (
        "qemu_virt" in provenance
        or "qemu-virt" in provenance
        or qemu_boundary_is_reference_only(boundary)
        or "qemu_virt" in schema
        or "qemu-virt" in schema
    )


def chip_evidence_has_chip_provenance(evidence: dict[str, object]) -> bool:
    provenance = str(evidence.get("provenance", "")).lower()
    boundary = str(evidence.get("claim_boundary", "")).lower()
    return any(marker in provenance or marker in boundary for marker in CHIP_PROVENANCE_MARKERS)


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
    chip_ids_present = sorted(row_ids & CHIP_BOOT_EVIDENCE_IDS)
    agent_ids_present = sorted(row_ids & AGENT_LIVE_EVIDENCE_IDS)
    chip_row_id, chip_row = first_evidence_row(rows, CHIP_BOOT_EVIDENCE_IDS)
    agent_row_id, agent_row = first_evidence_row(rows, AGENT_LIVE_EVIDENCE_IDS)
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
    agent_live_reference_rows = [
        evidence_id
        for evidence_id in agent_ids_present
        if evidence_id in rows and row_path_is_qemu_reference(rows[evidence_id], qemu_evidence_path)
    ]
    qemu_boundary = str(qemu_evidence.get("claim_boundary", ""))
    qemu_provenance = qemu_evidence.get("provenance")
    qemu_transcript, qemu_transcript_source = transcript_text(qemu_evidence)
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

    chip_evidence_path = DEFAULT_CHIP_BOOT_EVIDENCE.resolve()
    chip_evidence_path_display = rel(DEFAULT_CHIP_BOOT_EVIDENCE)
    chip_evidence: dict[str, object] | None = None
    chip_transcript = ""
    chip_transcript_source = f"missing generated-AP boot evidence {chip_evidence_path_display}"
    chip_boot_evidence_usable = False
    if chip_row is None:
        findings.append(
            Finding(
                "missing_chip_target_boot_evidence_row",
                "blocker",
                "Linux RV64 manifest has no required evidence row for generated Eliza AP/chip-emulator boot",
                "expected row id one of "
                f"{sorted(CHIP_BOOT_EVIDENCE_IDS)} with path={chip_evidence_path_display}; "
                f"requiredEvidence={sorted(required_ids)} evidenceRows={sorted(row_ids)}",
                "Add a chip-target boot evidence row backed by a generated Eliza AP/chip-emulator serial transcript.",
            )
        )
    else:
        chip_evidence_path, chip_evidence_path_display = evidence_row_path(
            chip_row, DEFAULT_CHIP_BOOT_EVIDENCE
        )
        add_if(
            findings,
            chip_row.get("status") != "collected",
            "chip_target_boot_evidence_not_collected",
            "generated Eliza AP/chip-emulator boot evidence row is not collected",
            f"id={chip_row_id} status={chip_row.get('status')!r} path={chip_evidence_path_display}",
            "Capture a generated Eliza AP/chip-emulator serial transcript and mark the row collected only after it is on disk.",
        )
        add_if(
            findings,
            not isinstance(chip_row.get("path"), str) or not chip_row.get("path"),
            "chip_target_boot_evidence_path_missing",
            "generated Eliza AP/chip-emulator boot evidence row has no path",
            f"id={chip_row_id} expected_path={chip_evidence_path_display}",
            "Set the row path to the generated AP boot evidence JSON that contains the serial transcript path.",
        )
        chip_evidence, load_error = load_evidence_json(chip_evidence_path)
        add_if(
            findings,
            load_error is not None,
            "chip_target_boot_evidence_file_missing",
            "generated Eliza AP/chip-emulator boot evidence file is missing or unreadable",
            load_error or rel(chip_evidence_path),
            "Generate the AP/chip-emulator boot evidence JSON and transcript at the manifest row path.",
        )
        if chip_evidence is not None:
            chip_transcript, chip_transcript_source = transcript_text(chip_evidence)
            is_qemu_reference = chip_evidence_is_qemu_reference(chip_evidence)
            has_chip_provenance = chip_evidence_has_chip_provenance(chip_evidence)
            chip_boot_completed = chip_evidence.get("boot_completed") is True
            missing_boot_markers = missing_marker_groups(
                chip_transcript, CHIP_BOOT_TRANSCRIPT_MARKER_GROUPS
            )
            add_if(
                findings,
                is_qemu_reference,
                "chip_target_boot_evidence_reuses_qemu_virt_reference",
                "generated AP/chip-emulator boot evidence row points at qemu-virt reference evidence",
                f"id={chip_row_id} path={chip_evidence_path_display}",
                "Keep qemu-virt evidence as OS reference evidence and capture a separate generated-AP/chip-emulator boot transcript.",
            )
            add_if(
                findings,
                not has_chip_provenance,
                "chip_target_boot_evidence_missing_chip_provenance",
                "generated AP/chip-emulator boot evidence lacks chip-target provenance or claim boundary",
                f"id={chip_row_id} path={chip_evidence_path_display}",
                "Use an evidence JSON whose provenance or claim boundary names generated_eliza_ap/chip_emulator scope.",
            )
            add_if(
                findings,
                not chip_boot_completed,
                "chip_target_boot_not_completed",
                "generated AP/chip-emulator boot evidence does not report a completed boot",
                f"id={chip_row_id} boot_completed={chip_evidence.get('boot_completed')!r}",
                "Rerun the generated AP/chip-emulator boot capture until Linux reaches the expected serial markers.",
            )
            add_if(
                findings,
                bool(missing_boot_markers),
                "chip_target_boot_transcript_missing_linux_markers",
                "generated AP/chip-emulator boot transcript lacks required boot markers",
                f"{chip_transcript_source}: missing={missing_boot_markers}",
                "Capture a serial transcript that includes OpenSBI handoff and Linux kernel boot markers on the generated AP/chip emulator.",
            )
            chip_boot_evidence_usable = (
                not is_qemu_reference
                and has_chip_provenance
                and chip_boot_completed
                and not missing_boot_markers
            )

    agent_evidence_path = DEFAULT_AGENT_LIVE_EVIDENCE.resolve()
    agent_evidence_path_display = rel(DEFAULT_AGENT_LIVE_EVIDENCE)
    agent_evidence: dict[str, object] | None = None
    agent_transcript = ""
    agent_transcript_source = (
        f"missing generated-AP agent-live evidence {agent_evidence_path_display}"
    )
    if agent_row is None:
        findings.append(
            Finding(
                "missing_agent_live_evidence_row",
                "blocker",
                "Linux RV64 manifest has no required evidence row for Eliza agent liveness on generated AP/chip emulator",
                "expected row id one of "
                f"{sorted(AGENT_LIVE_EVIDENCE_IDS)} with path={agent_evidence_path_display}; "
                f"requiredEvidence={sorted(required_ids)} evidenceRows={sorted(row_ids)}",
                "Add an agent-live evidence row requiring service active status and a local API/health smoke on the generated AP/chip emulator.",
            )
        )
    else:
        agent_evidence_path, agent_evidence_path_display = evidence_row_path(
            agent_row, DEFAULT_AGENT_LIVE_EVIDENCE
        )
        add_if(
            findings,
            agent_row.get("status") != "collected",
            "agent_live_evidence_not_collected",
            "generated AP/chip-emulator agent-live evidence row is not collected",
            f"id={agent_row_id} status={agent_row.get('status')!r} path={agent_evidence_path_display}",
            "Capture generated AP/chip-emulator agent liveness evidence and mark the row collected only after it is on disk.",
        )
        add_if(
            findings,
            not isinstance(agent_row.get("path"), str) or not agent_row.get("path"),
            "agent_live_evidence_path_missing",
            "generated AP/chip-emulator agent-live evidence row has no path",
            f"id={agent_row_id} expected_path={agent_evidence_path_display}",
            "Set the row path to the generated AP agent-live evidence JSON.",
        )
        agent_evidence, load_error = load_evidence_json(agent_evidence_path)
        add_if(
            findings,
            load_error is not None,
            "agent_live_evidence_file_missing",
            "generated AP/chip-emulator agent-live evidence file is missing or unreadable",
            load_error or rel(agent_evidence_path),
            "Generate the AP/chip-emulator agent-live evidence JSON and transcript at the manifest row path.",
        )
        if agent_evidence is not None:
            agent_transcript, agent_transcript_source = transcript_text(agent_evidence)
            missing_agent_schema_fields = agent_live_schema_findings(agent_evidence)
            add_if(
                findings,
                chip_evidence_is_qemu_reference(agent_evidence),
                "agent_live_evidence_reuses_qemu_virt_reference",
                "Linux RV64 agent-live evidence row reuses qemu-virt evidence that cannot prove chip/AP emulator agent liveness",
                f"id={agent_row_id} path={agent_evidence_path_display} qemu_evidence={rel(qemu_evidence_path)}",
                "Capture a separate chip-target agent-live transcript with systemd state, process/PID, and localhost /api/health after boot on the generated AP/chip emulator.",
            )
            add_if(
                findings,
                bool(missing_agent_schema_fields),
                "agent_live_evidence_schema_incomplete",
                "generated AP/chip-emulator agent-live evidence does not satisfy the fail-closed liveness schema",
                f"id={agent_row_id} path={agent_evidence_path_display} missing={missing_agent_schema_fields}",
                "Capture structured agent-live evidence with service active state, real process PID, full-agent bundle flag, no fallback payload, and /api/health response body.",
            )

    chip_liveness_transcript = "\n".join(
        part for part in (chip_transcript, agent_transcript) if part
    )
    chip_liveness_source = (
        chip_transcript_source
        if chip_transcript_source == agent_transcript_source or not agent_transcript
        else f"{chip_transcript_source}; {agent_transcript_source}"
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
        target_device is None or str(target_hypervisor).lower() in {"qemu-virt", "qemu_virt"},
        "manifest_target_not_chip_emulator",
        "Linux RV64 manifest target is still a generic qemu-virt target rather than the Eliza chip/AP emulator",
        json.dumps(target, sort_keys=True),
        "Publish a separate chip-target manifest with device=generated Eliza AP/e1 chip, chip-emulator hypervisor metadata, and firmware tied to the generated boot path.",
    )
    add_if(
        findings,
        not chip_boot_evidence_usable
        and (qemu_provenance == "qemu_virt" or qemu_boundary_is_reference_only(qemu_boundary)),
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
        "agent binary missing" in qemu_transcript,
        "transcript_agent_binary_missing",
        "boot transcript says the Eliza agent binary is missing",
        f"{qemu_transcript_source}: agent binary missing at /opt/elizaos/bin/elizaos",
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
    agent_install_hook = read_text(AGENT_INSTALL_HOOK) if AGENT_INSTALL_HOOK.is_file() else ""
    add_if(
        findings,
        "install_fallback_payload" in agent_install_hook
        or "elizaos-fallback" in agent_install_hook
        or "fallback_agent.py" in agent_install_hook,
        "linux_agent_fallback_payload_allowed",
        "Linux RV64 image can satisfy /api/health with an offline fallback agent instead of the real Eliza agent payload",
        rel(AGENT_INSTALL_HOOK),
        "Make missing real agent artifacts fail the image build for chip-objective evidence, or require the runtime transcript/status body to prove the full Eliza agent bundle rather than the fallback.",
    )
    add_if(
        findings,
        not transcript_has_agent_liveness(chip_liveness_transcript),
        "missing_agent_liveness_marker",
        "generated AP/chip-emulator transcript lacks an agent-live marker, active service check, or API health smoke",
        chip_liveness_source,
        "Capture `systemctl is-active elizaos-agent.service` and a localhost health/API probe in the Linux boot evidence.",
    )
    add_if(
        findings,
        "elizaos-tui-ready" not in chip_liveness_transcript,
        "missing_tui_liveness_marker",
        "generated AP/chip-emulator transcript lacks a terminal TUI startup marker",
        chip_liveness_source,
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
        "agent_live_reference_rows": agent_live_reference_rows,
        "qemu_claim_boundary": qemu_boundary,
        "qemu_provenance": qemu_provenance,
        "qemu_transcript_source": qemu_transcript_source,
        "chip_boot_evidence_row": chip_row_id,
        "chip_boot_evidence_path": rel(chip_evidence_path),
        "chip_boot_transcript_source": chip_transcript_source,
        "agent_live_evidence_row": agent_row_id,
        "agent_live_evidence_path": rel(agent_evidence_path),
        "agent_live_transcript_source": agent_transcript_source,
        "agent_execstart": exec_start,
        "agent_install_hook": rel(AGENT_INSTALL_HOOK),
        "agent_fallback_allowed": "fallback_agent.py" in agent_install_hook,
        "status_report": rel(STATUS_REPORT),
        "tui_smoke_unit": rel(TUI_SMOKE_UNIT),
        "tui_smoke_script": rel(TUI_SMOKE_SCRIPT),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: dict[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    command_plan = next_command_plan(findings)
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "generated_utc": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        ),
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "blockers": len(blockers),
            "findings": len(findings),
            "next_command_count": len(command_plan),
        },
        "findings": [asdict(finding) for finding in findings],
        "next_command_plan": command_plan,
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
