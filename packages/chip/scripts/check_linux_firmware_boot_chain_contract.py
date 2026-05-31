#!/usr/bin/env python3
"""Static Linux firmware boot-chain contract gate.

This check covers the gap between repo-local BSP scaffolds and the evidence
needed to claim that Linux can boot through the firmware chain on the chip
target. It fails closed when Buildroot, OpenSBI, or U-Boot evidence is missing
or when reference-only qemu-virt evidence can be mistaken for chip boot proof.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import hashlib
import json
import re
import sys
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
EVIDENCE_MANIFEST = ROOT / "docs/evidence/software-bsp-evidence-manifest.json"
PREFLIGHT_REPORT = ROOT / "docs/evidence/software-bsp-external-preflight-status.json"
CHECK_SOFTWARE_BSP = ROOT / "scripts/check_software_bsp.py"
BUILDROOT_README = ROOT / "docs/sw/buildroot/README.md"
OPENSBI_README = ROOT / "docs/sw/opensbi/README.md"
UBOOT_README = ROOT / "docs/sw/u-boot/README.md"
QEMU_VIRT_SCRIPT = ROOT / "sw/buildroot/scripts/capture-buildroot-qemu-virt-smoke.sh"
BUILDROOT_BLOCKED_DIR = ROOT / "docs/evidence/buildroot"
ELIZAOS_MULTIARCH_BOOT_MATRIX = (
    REPO_ROOT / "packages/os/linux/elizaos/evidence/multiarch_boot_matrix.json"
)
REPORT = ROOT / "build/reports/linux_firmware_boot_chain_contract.json"

SCHEMA = "eliza.linux_firmware_boot_chain_contract.v1"
CLAIM_BOUNDARY = "static_firmware_boot_chain_contract_only_not_external_boot_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "external_boot_claim_allowed": False,
    "firmware_handoff_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}
TARGETS = ("buildroot", "opensbi", "u-boot")
SELECTED_RISCV64_FIRMWARE_CHAIN = "EDK2/OpenSBI -> GRUB EFI -> Linux"
SELECTED_RISCV64_BOOTLOADER_PACKAGES = {"grub-efi-riscv64", "grub-efi-riscv64-bin"}
PRODUCTION_BLOCKING_GAP_TOKENS = (
    "fallback agent",
    "missing-current-iso-evidence",
    "must be staged",
    "must be recaptured",
    "need to be collected",
    "predates verified",
)
FORBIDDEN_TRANSCRIPT_MARKERS = (
    "placeholder transcript",
    "synthetic placeholder",
    "blocked",
    "not run",
    "status=FAIL",
    "status: FAIL",
    "eliza-evidence: status=FAIL",
)
STALE_BUILROOT_SIDECAR_TOKENS = (
    "OpenPhone",
    "openphone",
    "openphone_hello",
    "openphone hello",
    "HELLO_NPU_ML_SMOKE_CMD",
    "hello-mmio-smoke",
    "hello-npu-ml-smoke",
)
REFERENCE_ONLY_TOKENS = (
    "buildroot_qemu_virt_smoke_evidence_only_no_silicon_or_physical_board_claim",
    "qemu-virt boot transcript evidence only",
    "does NOT prove silicon boot",
)
HOST_LOCAL_PATH_RE = re.compile(r"/Users/[^\s\"']+")


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str
    next_command: str = ""
    evidence_requirements: list[dict[str, Any]] | None = None
    blocker_dependency: str | None = None


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, findings: list[Finding]) -> dict[str, Any]:
    if not path.is_file():
        findings.append(
            Finding(
                "missing_input",
                "blocker",
                "required firmware boot-chain input is missing",
                rel(path),
                "Restore the software BSP evidence manifest and preflight report before claiming firmware boot-chain readiness.",
            )
        )
        return {}
    try:
        data = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        findings.append(
            Finding(
                "invalid_json_input",
                "blocker",
                "required firmware boot-chain JSON input is invalid",
                f"{rel(path)}: {exc}",
                "Fix the JSON syntax so the gate can inspect evidence requirements.",
            )
        )
        return {}
    if not isinstance(data, dict):
        findings.append(
            Finding(
                "invalid_json_input",
                "blocker",
                "required firmware boot-chain JSON input is not an object",
                rel(path),
                "Use a JSON object with target evidence metadata.",
            )
        )
        return {}
    return data


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
    next_command: str = "",
    *,
    blocker_dependency: str | None = None,
) -> None:
    if condition:
        findings.append(
            Finding(
                code,
                "blocker",
                message,
                evidence,
                next_step,
                next_command,
                blocker_dependency=blocker_dependency,
            )
        )


def manifest_items(manifest: Mapping[str, Any], target: str) -> list[dict[str, Any]]:
    targets = manifest.get("targets")
    if not isinstance(targets, Mapping):
        return []
    target_doc = targets.get(target)
    if not isinstance(target_doc, Mapping):
        return []
    items = target_doc.get("evidence")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def evidence_problems(item: Mapping[str, Any]) -> list[str]:
    item_path = item.get("path")
    if not isinstance(item_path, str) or not item_path:
        return ["manifest item missing path"]

    path = ROOT / item_path
    if not path.is_file():
        return [f"missing {item_path}"]

    text = read_text(path)
    problems: list[str] = []
    min_bytes = int(item.get("min_bytes", 0) or 0)
    byte_count = len(text.encode("utf-8"))
    if byte_count < min_bytes:
        problems.append(f"{item_path} is too small ({byte_count} bytes < {min_bytes})")

    required = [value for value in item.get("required_strings", []) if isinstance(value, str)]
    missing = [value for value in required if value not in text]
    if missing:
        problems.append(f"{item_path} missing required markers: {', '.join(missing)}")

    forbidden = [marker for marker in FORBIDDEN_TRANSCRIPT_MARKERS if marker in text]
    if forbidden:
        problems.append(f"{item_path} contains forbidden markers: {', '.join(forbidden)}")
    return problems


def evidence_requirement(item: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "path": item.get("path", ""),
        "artifact": item.get("artifact", ""),
        "capture_command": item.get("capture_command", ""),
        "validation_command": item.get("validation_command", ""),
        "claim_boundary": item.get("claim_boundary", ""),
        "required_strings": item.get("required_strings", []),
        "at_least_one": item.get("at_least_one", []),
        "min_bytes": item.get("min_bytes", 0),
    }


def evidence_next_command(target: str, items: list[dict[str, Any]]) -> str:
    commands = [
        str(item.get("capture_command", "")).strip()
        for item in items
        if str(item.get("capture_command", "")).strip()
    ]
    if commands:
        return " && ".join(
            [*commands, "python3 scripts/check_linux_firmware_boot_chain_contract.py"]
        )
    return f"python3 scripts/check_software_bsp.py {target} --evidence-plan"


def collect_evidence_findings(
    findings: list[Finding], manifest: Mapping[str, Any], target: str, code: str
) -> None:
    items = manifest_items(manifest, target)
    if not items:
        findings.append(
            Finding(
                code,
                "blocker",
                f"{target} firmware boot-chain evidence is not declared in the manifest",
                f"target={target} manifest={rel(EVIDENCE_MANIFEST)}",
                f"Declare {target} evidence requirements and capture real PASS transcripts.",
                f"python3 scripts/check_software_bsp.py {target} --evidence-plan",
                [],
            )
        )
        return

    problems: list[str] = []
    for item in items:
        problems.extend(evidence_problems(item))
    if problems:
        requirements = [evidence_requirement(item) for item in items]
        findings.append(
            Finding(
                code,
                "blocker",
                f"{target} firmware boot-chain evidence is missing or invalid",
                "; ".join(problems),
                f"Capture the {target} evidence files from a real external tree and validate them with the software BSP evidence checker.",
                evidence_next_command(target, items),
                requirements,
            )
        )


def architecture_row(matrix: Mapping[str, Any], arch: str) -> Mapping[str, Any] | None:
    rows = matrix.get("architectures")
    if not isinstance(rows, list):
        return None
    for row in rows:
        if isinstance(row, Mapping) and row.get("arch") == arch:
            return row
    return None


def selected_grub_chain_declared(matrix: Mapping[str, Any]) -> bool:
    contract = matrix.get("debian_riscv64_port_contract")
    if not isinstance(contract, Mapping):
        return False
    packages = contract.get("bootloader_packages")
    if not isinstance(packages, list):
        return False
    return (
        contract.get("firmware_chain") == SELECTED_RISCV64_FIRMWARE_CHAIN
        and set(packages) >= SELECTED_RISCV64_BOOTLOADER_PACKAGES
        and contract.get("removable_uefi_path") == "EFI/boot/bootriscv64.efi"
    )


def check_selected_grub_chain(findings: list[Finding], matrix: Mapping[str, Any]) -> bool:
    if not selected_grub_chain_declared(matrix):
        findings.append(
            Finding(
                "selected_riscv64_grub_chain_not_declared",
                "blocker",
                "selected riscv64 Linux boot chain is not declared as EDK2/OpenSBI plus GRUB EFI",
                rel(ELIZAOS_MULTIARCH_BOOT_MATRIX),
                "Declare the Debian riscv64 UEFI/GRUB bootloader chain and keep U-Boot as an alternate BSP target unless it is selected for production boot.",
            )
        )
        return False

    row = architecture_row(matrix, "riscv64")
    problems: list[str] = []
    if row is None:
        problems.append("multiarch matrix has no riscv64 runtime row")
    else:
        if row.get("status") != "candidate":
            problems.append(f"riscv64 status is {row.get('status')!r}, not 'candidate'")
        gaps = row.get("gaps")
        if not isinstance(gaps, list):
            problems.append("riscv64 gaps field is not a list")
        else:
            blocking_gaps = [
                gap
                for gap in gaps
                if isinstance(gap, str)
                and any(token in gap.lower() for token in PRODUCTION_BLOCKING_GAP_TOKENS)
            ]
            if blocking_gaps:
                problems.append(
                    "riscv64 still has production-blocking gaps: " + "; ".join(blocking_gaps)
                )
        iso = row.get("iso")
        sha = row.get("sha256")
        evidence = row.get("evidence")
        if not isinstance(iso, str) or not iso:
            problems.append("riscv64 row does not record an ISO")
        elif (REPO_ROOT / "packages/os/linux/elizaos" / iso).is_file():
            iso_path = REPO_ROOT / "packages/os/linux/elizaos" / iso
            actual = sha256_file(iso_path)
            if sha != actual:
                problems.append(f"riscv64 ISO sha256 mismatch: {actual}")
        else:
            problems.append(f"riscv64 ISO artifact is missing: {iso}")
        if not isinstance(sha, str) or len(sha) != 64:
            problems.append("riscv64 row does not record a 64-character ISO sha256")
        if not isinstance(evidence, str) or not evidence:
            problems.append("riscv64 row does not record QEMU boot evidence")
        elif not (REPO_ROOT / "packages/os/linux/elizaos" / evidence).is_file():
            problems.append(f"riscv64 boot evidence artifact is missing: {evidence}")

    if problems:
        findings.append(
            Finding(
                "selected_riscv64_grub_chain_evidence_incomplete",
                "blocker",
                "selected riscv64 UEFI/GRUB Linux boot-chain evidence is incomplete",
                "; ".join(problems),
                "Build the current riscv64 elizaOS ISO with staged runtime artifacts, run qemu_virt_smoke.py, and promote passing evidence into the multiarch boot matrix.",
                "make -C packages/os/linux/elizaos qemu-virt-smoke "
                "ARCH=riscv64 ISO=<iso> && make -C packages/os/linux/elizaos "
                "update-boot-matrix ARCH=riscv64 EVIDENCE=<report> ISO=<iso>",
            )
        )
        return False
    return True


def check_alternate_uboot_status(findings: list[Finding], manifest: Mapping[str, Any]) -> None:
    items = manifest_items(manifest, "u-boot")
    problems: list[str] = []
    for item in items:
        problems.extend(evidence_problems(item))
    if problems:
        findings.append(
            Finding(
                "u_boot_alternate_boot_chain_not_selected",
                "info",
                "U-Boot evidence is incomplete, but the selected Linux bootloader chain is Debian riscv64 UEFI/GRUB",
                "; ".join(problems),
                "Capture U-Boot evidence only if U-Boot is selected as a production boot path; otherwise keep it scoped as an alternate BSP target.",
                "python3 scripts/check_software_bsp.py u-boot --evidence-plan",
                [evidence_requirement(item) for item in items],
            )
        )


def check_uboot_gate(
    findings: list[Finding], manifest: Mapping[str, Any], *, selected_grub_declared: bool
) -> None:
    uboot_items = manifest_items(manifest, "u-boot")
    software_bsp_text = read_text(CHECK_SOFTWARE_BSP) if CHECK_SOFTWARE_BSP.is_file() else ""
    missing_checker_target = (
        bool(uboot_items)
        and '"u-boot"' not in software_bsp_text
        and "'u-boot'" not in software_bsp_text
    )
    if missing_checker_target:
        findings.append(
            Finding(
                "uboot_evidence_not_in_software_bsp_gate",
                "info" if selected_grub_declared else "blocker",
                "U-Boot evidence is declared, but check_software_bsp.py has no u-boot target",
                f"manifest_target=u-boot checker={rel(CHECK_SOFTWARE_BSP)}",
                "Add U-Boot to the software BSP checker if U-Boot is selected; otherwise keep it as an alternate BSP target behind the selected UEFI/GRUB chain.",
            )
        )


def check_reference_only_qemu(findings: list[Finding]) -> None:
    checked = [BUILDROOT_README, QEMU_VIRT_SCRIPT]
    hits: list[str] = []
    for path in checked:
        if not path.is_file():
            continue
        text = read_text(path)
        if any(token in text for token in REFERENCE_ONLY_TOKENS):
            hits.append(rel(path))
    if hits:
        findings.append(
            Finding(
                "buildroot_qemu_virt_reference_only",
                "info",
                "Buildroot qemu-virt smoke is explicitly reference-only and cannot prove chip boot",
                f"paths={hits}",
                "Keep qemu-virt evidence separate from chip-target boot readiness and capture generated-AP or chip-emulator Buildroot boot evidence.",
            )
        )


def check_stale_sidecars(findings: list[Finding]) -> None:
    hits: list[str] = []
    if BUILDROOT_BLOCKED_DIR.is_dir():
        for path in sorted(BUILDROOT_BLOCKED_DIR.glob("*.BLOCKED")):
            text = read_text(path)
            if any(token in text for token in STALE_BUILROOT_SIDECAR_TOKENS):
                hits.append(rel(path))
    add_if(
        findings,
        bool(hits),
        "buildroot_blocked_sidecars_use_openphone_markers",
        "Buildroot blocked evidence sidecars still use old OpenPhone/hello markers",
        f"paths={hits}",
        "Regenerate blocked sidecars and capture templates with Eliza e1 artifact names, binaries, and PASS markers.",
    )


def check_preflight(findings: list[Finding], preflight: Mapping[str, Any]) -> None:
    text = json.dumps(preflight, sort_keys=True)
    host_paths = sorted(set(HOST_LOCAL_PATH_RE.findall(text)))
    add_if(
        findings,
        bool(host_paths),
        "software_bsp_preflight_has_host_local_paths",
        "Software BSP external preflight report contains stale host-local paths",
        f"paths={host_paths[:8]}",
        "Regenerate the preflight report on the current bring-up host or remove it from readiness claims.",
    )
    add_if(
        findings,
        "/exact/qemu-or-renode fw_dynamic handoff command" in text,
        "opensbi_handoff_command_placeholder",
        "OpenSBI fw_dynamic handoff evidence still uses a placeholder command",
        rel(PREFLIGHT_REPORT),
        "Set ELIZA_OPENSBI_HANDOFF_CMD to the exact QEMU, Renode, or board handoff command and recapture the OpenSBI handoff transcript.",
        "ELIZA_OPENSBI_HANDOFF_CMD='<exact qemu, renode, or board handoff command>' "
        "python3 scripts/check_software_bsp_external_preflight.py --write-report",
        blocker_dependency="live_device_validation",
    )


def check_docs_present(findings: list[Finding]) -> None:
    for path in (
        BUILDROOT_README,
        OPENSBI_README,
        UBOOT_README,
        QEMU_VIRT_SCRIPT,
        CHECK_SOFTWARE_BSP,
    ):
        add_if(
            findings,
            not path.is_file(),
            "missing_input",
            "required firmware boot-chain contract input is missing",
            rel(path),
            "Restore the BSP documentation and validation scripts before claiming Linux firmware boot-chain readiness.",
        )


def run_check(args: argparse.Namespace) -> dict[str, Any]:
    findings: list[Finding] = []
    selected_grub_ready = False
    manifest = load_json(EVIDENCE_MANIFEST, findings)
    preflight = load_json(PREFLIGHT_REPORT, findings)
    boot_matrix = load_json(ELIZAOS_MULTIARCH_BOOT_MATRIX, findings)
    check_docs_present(findings)

    if manifest:
        collect_evidence_findings(
            findings, manifest, "buildroot", "buildroot_external_evidence_missing"
        )
        collect_evidence_findings(
            findings, manifest, "opensbi", "opensbi_external_evidence_missing"
        )
        selected_grub_declared = selected_grub_chain_declared(boot_matrix)
        selected_grub_ready = check_selected_grub_chain(findings, boot_matrix)
        if selected_grub_declared:
            check_alternate_uboot_status(findings, manifest)
        else:
            collect_evidence_findings(
                findings, manifest, "u-boot", "u_boot_boot_chain_evidence_missing"
            )
        check_uboot_gate(findings, manifest, selected_grub_declared=selected_grub_declared)

    check_reference_only_qemu(findings)
    check_stale_sidecars(findings)
    if preflight:
        check_preflight(findings, preflight)

    evidence = {
        "manifest": rel(EVIDENCE_MANIFEST),
        "preflight_report": rel(PREFLIGHT_REPORT),
        "software_bsp_checker": rel(CHECK_SOFTWARE_BSP),
        "elizaos_multiarch_boot_matrix": str(ELIZAOS_MULTIARCH_BOOT_MATRIX.relative_to(REPO_ROOT)),
        "selected_riscv64_firmware_chain": SELECTED_RISCV64_FIRMWARE_CHAIN,
        "selected_grub_ready": selected_grub_ready if manifest and boot_matrix else False,
        "targets": list(TARGETS),
    }
    return payload(findings, evidence)


def payload(findings: list[Finding], evidence: Mapping[str, object]) -> dict[str, Any]:
    blockers = [finding for finding in findings if finding.severity == "blocker"]
    command_plan = next_command_plan(findings)
    blocker_dependency_counts = {
        "repo_artifact_generation": sum(
            1 for finding in blockers if finding.blocker_dependency == "repo_artifact_generation"
        ),
        "live_device_validation": sum(
            1 for finding in blockers if finding.blocker_dependency == "live_device_validation"
        ),
        "actionable_external_dependency": sum(
            1
            for finding in blockers
            if finding.blocker_dependency == "actionable_external_dependency"
        ),
    }
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "blockers": len(blockers),
            "findings": len(findings),
            "blocker_dependency_counts": blocker_dependency_counts,
            "next_command_batch_count": len(command_plan),
        },
        "blocker_dependency_counts": blocker_dependency_counts,
        "findings": [asdict(finding) for finding in findings],
        "next_command_plan": command_plan,
        "evidence": evidence,
    }


def next_command_plan(findings: list[Finding]) -> list[dict[str, Any]]:
    plan: list[dict[str, Any]] = []
    for finding in findings:
        if finding.severity != "blocker" or not finding.next_command:
            continue
        plan.append(
            {
                "id": f"resolve_{finding.code}",
                "scope": "external_firmware_capture",
                "claim_boundary": "operator_commands_only_not_firmware_boot_evidence",
                "blocker_dependency": finding.blocker_dependency or "repo_artifact_generation",
                "commands": [finding.next_command],
                "requires": [
                    "exact selected QEMU, Renode, generated-AP, or board handoff command",
                    "real firmware transcript with required PASS markers",
                    "rerun of the firmware boot-chain contract after capture",
                ],
            }
        )
    return plan


def write_report(report: Mapping[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: Mapping[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} linux.firmware_boot_chain_contract")
    for finding in report["findings"]:
        print(f"- {finding['severity'].upper()} {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
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
