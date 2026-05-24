#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_cpu_ap_completion_gate  # noqa: E402
import check_cpu_ap_evidence  # noqa: E402
from cpu_ap_evidence_lib import (  # noqa: E402
    EVIDENCE_MANIFEST,
    GENERATED_MANIFEST,
    PLATFORM_CONTRACT,
    SELECTED_MANIFEST,
    artifact_specs,
    load_evidence_manifest,
    transcript_specs,
    validate_evidence_manifest,
)

OUT = ROOT / "build/reports/cpu_ap_scope.json"
CPU_TARGET = ROOT / "docs/spec-db/cpu-2028-target.yaml"
LINUX_CONTRACT = ROOT / "docs/arch/linux-capable-cpu-contract.md"
BLOCKER_STATUS = ROOT / "docs/project/cpu-ap-blocker-status-2026-05-17.md"
CAPTURE_HELPER = ROOT / "scripts/capture_cpu_ap_evidence.py"
COMMAND_WIRING = ROOT / "scripts/wire_cpu_ap_capture_commands.py"
CAPTURE_WRAPPER = ROOT / "scripts/capture_chipyard_linux_evidence.sh"
COMPLETION_GATE = ROOT / "scripts/check_cpu_ap_completion_gate.py"
EVIDENCE_CHECKER = ROOT / "scripts/check_cpu_ap_evidence.py"

REQUIRED_TRANSCRIPTS = {
    "opensbi_boot_log",
    "linux_boot_log",
    "trap_timer_irq_log",
    "isa_cache_mmu_log",
    "ap_benchmark_log",
}
REQUIRED_ARTIFACTS = {"generated_src", "verilog", "dts", "simulator"}
REQUIRED_LINUX_GATES = {
    "rv64gc_isa",
    "s_mode_privilege",
    "mmu_sv39_or_stronger",
    "clint_timer_software_irq",
    "plic_external_irq",
    "uart_console",
    "dtb_linux_boot_contract",
    "opensbi_handoff",
    "linux_initramfs_smoke",
}
REQUIRED_PHONE_BLOCKERS = {
    "multi_hart_application_cpu_topology_or_documented_equivalent",
    "riscv_application_profile_and_extension_matrix",
    "cache_hierarchy_and_coherency_evidence",
    "mmu_page_table_and_tlb_evidence",
    "sustained_boot_and_benchmark_evidence",
    "power_thermal_voltage_frequency_evidence",
    "process_14a_corner_benchmark_derate_evidence",
    "android_cts_vts_and_userspace_evidence",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def cpu_scaffold_passes() -> bool:
    errors: list[str] = []
    check_cpu_ap_evidence.check_scaffold(errors)
    return not errors


def evidence_status() -> dict[str, Any]:
    missing, problems = check_cpu_ap_evidence.evidence_problems()
    return {
        "missing_transcripts": missing,
        "invalid_transcript_problems": problems,
        "evidence_status": "PASS" if not missing and not problems else "BLOCKED",
    }


def structured_findings(
    evidence: dict[str, Any], checks: list[dict[str, Any]]
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for path in list_values(evidence.get("missing_transcripts")):
        text = str(path)
        findings.append(
            {
                "code": f"cpu_ap_missing_transcript_{code_from_text(text, 'transcript')}",
                "severity": "blocker",
                "message": f"required CPU/AP transcript is missing: {text}",
                "evidence": text,
                "next_step": "Run python3 scripts/capture_cpu_ap_evidence.py plan all --format json, wire the exact external commands, then capture the missing transcript.",
            }
        )
    for problem in list_values(evidence.get("invalid_transcript_problems")):
        text = str(problem)
        findings.append(
            {
                "code": f"cpu_ap_invalid_transcript_{code_from_text(text, 'problem')}",
                "severity": "blocker",
                "message": text,
                "evidence": "invalid_transcript_problems",
                "next_step": "Regenerate the transcript with the required CPU/AP evidence markers and rerun scripts/check_cpu_ap_evidence.py --require-evidence.",
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        ident = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": f"cpu_ap_scope_check_failed_{code_from_text(ident, 'scope_check')}",
                "severity": "blocker",
                "message": f"{ident} structural scope check is {check.get('status')}",
                "evidence": str(check.get("evidence", "")),
                "next_step": "Repair the CPU/AP scope contract before treating generated AP evidence as release evidence.",
            }
        )
    return findings


def manifest_is_fail_closed(manifest: dict[str, Any]) -> bool:
    errors: list[str] = []
    validate_evidence_manifest(manifest, errors)
    if errors:
        return False
    policy = mapping(manifest.get("target_policy"))
    gate_matrix = list_values(manifest.get("linux_capable_gate_matrix"))
    gates = {str(gate.get("gate")) for gate in gate_matrix if isinstance(gate, dict)}
    if gates != REQUIRED_LINUX_GATES:
        return False
    if any(isinstance(gate, dict) and gate.get("status") != "blocked" for gate in gate_matrix):
        return False
    if set(transcript_specs(manifest)) != REQUIRED_TRANSCRIPTS:
        return False
    if set(artifact_specs(manifest)) != REQUIRED_ARTIFACTS:
        return False
    return (
        manifest.get("claim_boundary")
        == "generated_chipyard_artifacts_and_external_transcripts_only"
        and manifest.get("completion_claim")
        == "blocked_until_all_required_artifacts_and_evidence_pass"
        and policy.get("initial_linux_bringup_claim")
        == "single_hart_rocket_rv64gc_linux_smoke_only"
        and policy.get("phone_2028_ap_claim")
        == "blocked_until_phone_class_artifacts_and_evidence_pass"
        and set(list_values(policy.get("phone_2028_claim_requires"))) >= REQUIRED_PHONE_BLOCKERS
    )


def selected_manifest_is_bringup_only(selected: dict[str, Any], platform: dict[str, Any]) -> bool:
    selected_path = mapping(selected.get("selected_path"))
    claim_policy = mapping(selected.get("claim_policy"))
    phone_boundary = mapping(selected.get("phone_2028_target_boundary"))
    return (
        selected.get("status") == "selected_not_generated"
        and selected_path.get("core") == "Rocket"
        and selected_path.get("isa") == "RV64GC"
        and selected_path.get("harts") == 1
        and selected_path.get("claim_level") == "initial_linux_bringup_only"
        and claim_policy.get("linux_capable_cpu_claim") is False
        and claim_policy.get("platform_contract_has_cpu_may_flip_to_true") is False
        and platform.get("e1_chip", {}).get("has_cpu") is False
        and phone_boundary.get("status") == "blocked_not_selected_for_product_claims"
    )


def cpu_target_keeps_2028_claim_blocked(target: dict[str, Any]) -> bool:
    phase_gates = mapping(target.get("phase_gates"))
    selected_ap = mapping(target.get("selected_ap_path"))
    text = json.dumps(target, sort_keys=True, default=str)
    return (
        target.get("schema") == "eliza.cpu_2028_target.v1"
        and "This document is a target spec, not silicon evidence"
        in str(target.get("claim_boundary", ""))
        and selected_ap.get("selected_for_2028_phone_class_big_core") is False
        and contains_all(
            text,
            (
                "RVA22U64+V",
                "RVA23",
                "RVV_1_0",
                "Zicbom",
                "Zicbop",
                "Zicboz",
                "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
                "Android boot at A14-class power",
            ),
        )
        and bool(phase_gates)
    )


def capture_helpers_cover_all_transcripts(manifest: dict[str, Any]) -> bool:
    plan = subprocess.run(
        [sys.executable, "scripts/capture_cpu_ap_evidence.py", "plan", "all", "--format", "json"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if plan.returncode != 0:
        return False
    try:
        data = json.loads(plan.stdout)
    except json.JSONDecodeError:
        return False
    entries = list_values(data.get("entries"))
    paths = {str(entry.get("destination")) for entry in entries if isinstance(entry, dict)}
    transcript_paths = {
        str(spec.get("path"))
        for spec in transcript_specs(manifest).values()
        if isinstance(spec.get("path"), str)
    }
    wiring_text = COMMAND_WIRING.read_text(encoding="utf-8")
    wrapper_text = CAPTURE_WRAPPER.read_text(encoding="utf-8")
    return (
        data.get("schema") == "eliza.cpu_ap_capture_plan.v1"
        and paths == transcript_paths
        and contains_all(
            wiring_text + "\n" + wrapper_text,
            (
                "ELIZA_OPENSBI_BOOT_CMD",
                "ELIZA_LINUX_BOOT_CMD",
                "ELIZA_TRAP_TIMER_IRQ_CMD",
                "ELIZA_ISA_CACHE_MMU_CMD",
                "ELIZA_AP_BENCHMARKS_CMD",
            ),
        )
    )


def completion_gate_blocks_without_claim() -> bool:
    return check_cpu_ap_completion_gate.completion_claimed() is False and contains_all(
        COMPLETION_GATE.read_text(encoding="utf-8"),
        (
            "no real RV64GC/Linux AP completion claim",
            "scripts/check_cpu_ap_evidence.py",
            "--require-evidence",
            "--require-generated",
        ),
    )


def linux_contract_covers_release_requirements() -> bool:
    contract = LINUX_CONTRACT.read_text(encoding="utf-8")
    blocker = BLOCKER_STATUS.read_text(encoding="utf-8")
    return contains_all(
        contract,
        (
            "OpenSBI",
            "Linux early console",
            "firmware-to-kernel handoff",
            "Exact Linux-Capable Gate States",
            "rv64gc_isa",
            "mmu_sv39_or_stronger",
            "linux_initramfs_smoke",
            "CoreMark",
            "STREAM",
            "power method",
            "process effects contract",
            "QEMU `virt` OS boot attempts are useful software-reference evidence only",
        ),
    ) and contains_all(
        blocker,
        (
            "No generated Chipyard/Rocket RTL",
            "ElizaRocketConfig",
            "has_cpu=false",
            "single Rocket RV64GC hart is not a 2028 phone-class AP",
            "eliza_e1_ap_benchmarks.log",
        ),
    )


def build_report() -> dict[str, Any]:
    manifest = load_evidence_manifest([])
    selected = load_json_object(SELECTED_MANIFEST)
    platform = load_json_object(PLATFORM_CONTRACT)
    target = load_yaml_object(CPU_TARGET)
    evidence = evidence_status()
    checks = [
        {
            "id": "cpu_ap_evidence_manifest_is_fail_closed",
            "status": "pass" if manifest_is_fail_closed(manifest) else "fail",
            "evidence": rel(EVIDENCE_MANIFEST),
        },
        {
            "id": "selected_rocket_path_is_linux_bringup_only",
            "status": "pass" if selected_manifest_is_bringup_only(selected, platform) else "fail",
            "evidence": rel(SELECTED_MANIFEST),
        },
        {
            "id": "cpu_2028_target_blocks_phone_class_claims",
            "status": "pass" if cpu_target_keeps_2028_claim_blocked(target) else "fail",
            "evidence": rel(CPU_TARGET),
        },
        {
            "id": "capture_helpers_cover_required_transcripts",
            "status": "pass" if capture_helpers_cover_all_transcripts(manifest) else "fail",
            "evidence": rel(CAPTURE_HELPER),
        },
        {
            "id": "completion_gate_blocks_without_generated_ap_claim",
            "status": "pass" if completion_gate_blocks_without_claim() else "fail",
            "evidence": rel(COMPLETION_GATE),
        },
        {
            "id": "linux_contract_and_blocker_status_cover_release_requirements",
            "status": "pass" if linux_contract_covers_release_requirements() else "fail",
            "evidence": rel(LINUX_CONTRACT),
        },
        {
            "id": "cpu_ap_scaffold_passes_while_evidence_blocks_release",
            "status": "pass"
            if cpu_scaffold_passes() and evidence["evidence_status"] != "PASS"
            else "fail",
            "evidence": rel(EVIDENCE_CHECKER),
        },
    ]
    findings = structured_findings(evidence, checks)
    transcript_paths = [
        str(spec.get("path"))
        for spec in transcript_specs(manifest).values()
        if isinstance(spec.get("path"), str)
    ]
    return {
        "schema": "eliza.cpu_ap_scope.v1",
        "status": "cpu_ap_scope_release_blocked",
        "claim_boundary": (
            "CPU/AP scope audit only; not generated Chipyard AP RTL evidence, not OpenSBI "
            "handoff evidence, not Linux boot evidence, not RV64GC compliance evidence, "
            "not AP benchmark evidence, not power/thermal/process-corner evidence, not "
            "Android compatibility evidence, and not a 2028 phone-class AP claim."
        ),
        "current_scaffolds": {
            "cpu_target": rel(CPU_TARGET),
            "selected_manifest": rel(SELECTED_MANIFEST),
            "platform_contract": rel(PLATFORM_CONTRACT),
            "evidence_manifest": rel(EVIDENCE_MANIFEST),
            "generated_manifest": rel(GENERATED_MANIFEST),
            "linux_contract": rel(LINUX_CONTRACT),
            "blocker_status": rel(BLOCKER_STATUS),
            "capture_helper": rel(CAPTURE_HELPER),
            "command_wiring": rel(COMMAND_WIRING),
            "completion_gate": rel(COMPLETION_GATE),
            "evidence_checker": rel(EVIDENCE_CHECKER),
        },
        "required_transcripts": transcript_paths,
        "missing_transcripts": evidence["missing_transcripts"],
        "invalid_transcript_problems": evidence["invalid_transcript_problems"],
        "findings": findings,
        "blocked_until_real_evidence": [
            "pinned Chipyard main-2026-05-20 checkout generates ElizaRocketConfig artifacts and manifest hashes",
            "generated Rocket AP Verilog, DTS, source tree, and simulator artifact exist and hash-match",
            "generated AP DTS compiles and contains CPU, memory, timer, interrupt-controller, UART, and chosen stdout nodes",
            "OpenSBI transcript proves next-stage handoff, timer, console, DRAM base, and boot hart ISA",
            "Linux boot transcript proves early console, MMU-enabled initramfs smoke, generated DTS hash, and E1 MMIO smoke",
            "trap/timer/interrupt transcript proves mcause/mepc/mtval, CLINT/ACLINT timer/software IRQ, and PLIC claim/complete",
            "ISA/cache/MMU transcript proves RV64GC, Zicsr/Zifencei, Sv39, cache hierarchy, TLB, and page table behavior",
            "AP benchmark transcript links schema-valid benchmark report hashes, CoreMark, STREAM, lmbench/fio, run counts, power method, thermal state, and process-corner derates",
            "Android userspace/CTS/VTS evidence proves the generated AP path is sufficient for Android-class software, not just Linux smoke",
            "reviewer approval that single-hart Rocket remains Linux bring-up only and is not promoted to a 2028 phone-class AP",
        ],
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "missing_transcript_count": len(evidence["missing_transcripts"]),
            "invalid_transcript_problem_count": len(evidence["invalid_transcript_problems"]),
            "generated_manifest_present": GENERATED_MANIFEST.is_file(),
            "completion_claimed": check_cpu_ap_completion_gate.completion_claimed(),
            "release_claim_allowed": False,
        },
        "checks": checks,
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.cpu_ap_scope.v1", "schema mismatch", errors)
    require(
        data.get("status") == "cpu_ap_scope_release_blocked",
        "status must remain cpu_ap_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not generated Chipyard AP RTL evidence",
        "not OpenSBI handoff evidence",
        "not Linux boot evidence",
        "not RV64GC compliance evidence",
        "not AP benchmark evidence",
        "not power/thermal/process-corner evidence",
        "not Android compatibility evidence",
        "not a 2028 phone-class AP claim",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    require(
        summary.get("release_claim_allowed") is False,
        "release_claim_allowed must stay false",
        errors,
    )
    require(
        summary.get("completion_claimed") is False, "completion_claimed must remain false", errors
    )
    require(
        isinstance(summary.get("missing_transcript_count"), int)
        and summary.get("missing_transcript_count", 0) > 0,
        "missing_transcript_count must show AP evidence blockers",
        errors,
    )
    transcripts = data.get("required_transcripts")
    if not isinstance(transcripts, list) or len(transcripts) < len(REQUIRED_TRANSCRIPTS):
        errors.append("required_transcripts must list all CPU/AP transcript paths")
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured CPU/AP blockers")
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") != "pass":
            errors.append(f"{check.get('id')}: must pass structural scope check")
    blocked = data.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 9:
        errors.append("CPU/AP scope must enumerate blocked real-evidence items")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "cpu_target",
            "selected_manifest",
            "platform_contract",
            "evidence_manifest",
            "generated_manifest",
            "linux_contract",
            "blocker_status",
            "capture_helper",
            "command_wiring",
            "completion_gate",
            "evidence_checker",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"CPU/AP scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
