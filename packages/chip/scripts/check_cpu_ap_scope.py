#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
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
CPU_CONTRACT_RTL = ROOT / "rtl/cpu/e1_tiny_cpu_contract.sv"
CPU_LEGACY_ALIAS_RTL = ROOT / "rtl/cpu/e1_cpu_subsystem_stub.sv"
CPU_SOURCE_LISTS = (
    ROOT / "Makefile",
    ROOT / "scripts/run_rtl_check.sh",
    ROOT / "scripts/run_verilator.sh",
    ROOT / "scripts/yosys_e1_soc.ys",
    ROOT / "scripts/yosys_formal_top.ys",
    ROOT / "scripts/yosys_formal_top_structural.ys",
    ROOT / "verify/cocotb/Makefile",
    ROOT / "verify/cocotb/soc/Makefile",
    ROOT / "verify/cocotb/jtag_tap/Makefile",
    ROOT / "verify/formal/e1_soc_top.sby",
)

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


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    status = selected.get("status")
    return (
        status in {"selected_not_generated", "linux_complete"}
        and selected_path.get("core") == "Rocket"
        and selected_path.get("isa") == "RV64GC"
        and selected_path.get("harts") == 1
        and selected_path.get("claim_level") == "initial_linux_bringup_only"
        and claim_policy.get("linux_capable_cpu_claim") is (status == "linux_complete")
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


def completion_gate_accepts_generated_ap_claim() -> bool:
    gate = subprocess.run(
        [sys.executable, "scripts/check_cpu_ap_completion_gate.py", "--require-complete"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    source = COMPLETION_GATE.read_text(encoding="utf-8")
    return gate.returncode == 0 and contains_all(
        source,
        (
            "generated Rocket RV64GC AP artifacts and boot evidence are present",
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


def legacy_cpu_alias_is_compatibility_only() -> bool:
    alias = CPU_LEGACY_ALIAS_RTL.read_text(encoding="utf-8")
    alias_ok = (
        "module e1_cpu_subsystem_stub" in alias
        and "Compatibility alias for legacy source lists" in alias
        and alias.count("e1_tiny_cpu_contract #(") == 1
        and "always_ff" not in alias
        and "always_comb" not in alias
    )
    if not alias_ok:
        return False

    contract_token = "rtl/cpu/e1_tiny_cpu_contract.sv"
    alias_token = "rtl/cpu/e1_cpu_subsystem_stub.sv"
    for source_list in CPU_SOURCE_LISTS:
        text = source_list.read_text(encoding="utf-8")
        contract_index = text.find(contract_token)
        alias_index = text.find(alias_token)
        if contract_index < 0 or alias_index < 0 or contract_index > alias_index:
            return False
    return True


def build_report() -> dict[str, Any]:
    manifest = load_evidence_manifest([])
    selected = load_json_object(SELECTED_MANIFEST)
    platform = load_json_object(PLATFORM_CONTRACT)
    target = load_yaml_object(CPU_TARGET)
    evidence = evidence_status()
    completion_gate_passes = completion_gate_accepts_generated_ap_claim()
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
            "id": "completion_gate_accepts_generated_ap_claim",
            "status": "pass" if completion_gate_passes else "fail",
            "evidence": rel(COMPLETION_GATE),
        },
        {
            "id": "linux_contract_and_blocker_status_cover_release_requirements",
            "status": "pass" if linux_contract_covers_release_requirements() else "fail",
            "evidence": rel(LINUX_CONTRACT),
        },
        {
            "id": "legacy_cpu_alias_is_compatibility_only",
            "status": "pass" if legacy_cpu_alias_is_compatibility_only() else "fail",
            "evidence": rel(CPU_LEGACY_ALIAS_RTL),
        },
        {
            "id": "cpu_ap_evidence_bundle_complete",
            "status": "pass"
            if cpu_scaffold_passes() and evidence["evidence_status"] == "PASS"
            else "fail",
            "evidence": rel(EVIDENCE_CHECKER),
        },
    ]
    findings = structured_findings(evidence, checks)
    status = (
        "pass"
        if evidence["evidence_status"] == "PASS"
        and completion_gate_passes
        and all(check["status"] == "pass" for check in checks)
        else "cpu_ap_scope_release_blocked"
    )
    transcript_paths = [
        str(spec.get("path"))
        for spec in transcript_specs(manifest).values()
        if isinstance(spec.get("path"), str)
    ]
    return {
        "schema": "eliza.cpu_ap_scope.v1",
        "status": status,
        "generated_utc": utc_now(),
        "claim_boundary": (
            "Generated Chipyard Rocket RV64GC AP scope only; accepts generated AP artifacts, "
            "OpenSBI handoff, Linux boot, RV64GC smoke, and AP benchmark transcripts for "
            "initial Linux/NPU/AP-benchmark bring-up. This is not power/thermal/process-corner "
            "evidence, not Android compatibility evidence, not production silicon evidence, "
            "not a 2028 phone-class AP claim, and not a product release claim."
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
            "cpu_contract_rtl": rel(CPU_CONTRACT_RTL),
            "cpu_legacy_alias_rtl": rel(CPU_LEGACY_ALIAS_RTL),
            "cpu_source_lists": [rel(path) for path in CPU_SOURCE_LISTS],
        },
        "required_transcripts": transcript_paths,
        "missing_transcripts": evidence["missing_transcripts"],
        "invalid_transcript_problems": evidence["invalid_transcript_problems"],
        "findings": findings,
        "blocked_until_real_evidence": [
            "multi-hart phone-class application CPU topology or documented equivalent",
            "RVA23/Android profile and extension matrix for the selected phone AP path",
            "silicon or cycle-calibrated power/thermal/voltage/frequency evidence",
            "process 14A corner benchmark derate evidence",
            "Android userspace/CTS/VTS evidence proves the generated AP path is sufficient for Android-class software, not just Linux smoke",
            "reviewer approval that single-hart Rocket remains Linux bring-up only and is not promoted to a 2028 phone-class AP",
        ],
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "missing_transcript_count": len(evidence["missing_transcripts"]),
            "invalid_transcript_problem_count": len(evidence["invalid_transcript_problems"]),
            "generated_manifest_present": GENERATED_MANIFEST.is_file(),
            "completion_claimed": completion_gate_passes,
            "platform_contract_cpu_claimed": check_cpu_ap_completion_gate.completion_claimed(),
            "generated_ap_scope_claim_allowed": status == "pass",
            "phone_2028_ap_claim_allowed": False,
            "release_claim_allowed": False,
        },
        "checks": checks,
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.cpu_ap_scope.v1", "schema mismatch", errors)
    require(isinstance(data.get("generated_utc"), str), "generated_utc missing", errors)
    require(
        data.get("status") in {"pass", "cpu_ap_scope_release_blocked"},
        "status must be pass or cpu_ap_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "Generated Chipyard Rocket RV64GC AP scope only",
        "initial Linux/NPU/AP-benchmark bring-up",
        "not power/thermal/process-corner evidence",
        "not Android compatibility evidence",
        "not production silicon evidence",
        "not a 2028 phone-class AP claim",
        "not a product release claim",
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
        summary.get("phone_2028_ap_claim_allowed") is False,
        "phone_2028_ap_claim_allowed must stay false",
        errors,
    )
    if data.get("status") == "pass":
        require(summary.get("completion_claimed") is True, "completion_claimed must be true", errors)
        require(
            summary.get("generated_ap_scope_claim_allowed") is True,
            "generated_ap_scope_claim_allowed must be true",
            errors,
        )
        require(
            summary.get("missing_transcript_count") == 0,
            "missing_transcript_count must be zero for pass",
            errors,
        )
        require(
            summary.get("invalid_transcript_problem_count") == 0,
            "invalid_transcript_problem_count must be zero for pass",
            errors,
        )
    else:
        require(
            summary.get("completion_claimed") is False,
            "completion_claimed must remain false while release-blocked",
            errors,
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
    if not isinstance(findings, list):
        errors.append("findings must be a list")
    elif data.get("status") != "pass" and not findings:
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
    if not isinstance(blocked, list) or len(blocked) < 6:
        errors.append("CPU/AP scope must enumerate remaining phone/release evidence items")
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
            "cpu_contract_rtl",
            "cpu_legacy_alias_rtl",
            "cpu_source_lists",
        ):
            if key == "cpu_source_lists":
                require(
                    isinstance(scaffolds.get(key), list) and bool(scaffolds.get(key)),
                    f"current_scaffolds missing {key}",
                    errors,
                )
            else:
                require(
                    isinstance(scaffolds.get(key), str),
                    f"current_scaffolds missing {key}",
                    errors,
                )
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
    if report["status"] == "pass":
        print(
            f"CPU/AP scope check passed: {rel(OUT)} allows generated AP bring-up scope only."
        )
    else:
        print(f"CPU/AP scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
