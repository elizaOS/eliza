#!/usr/bin/env python3
"""Separate CPU/AP scaffold checks from Linux-capable evidence claims."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys

from cpu_ap_evidence_lib import (
    EXPECTED_CHIPYARD,
    GENERATED_MANIFEST,
    ROOT,
    SELECTED_MANIFEST,
    load_evidence_manifest,
    load_json,
    rel,
    require,
    sha256_path,
    text_problems,
    transcript_metadata_problems,
    transcript_specs,
)

STALE_EVIDENCE_REPORT = ROOT / "build/reports/cpu_ap_stale_evidence.json"

FALSE_CLAIM_FLAGS = {
    "phone_2028_ap_claim_allowed": False,
    "release_claim_allowed": False,
    "linux_capable_cpu_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "privileged_boot_claim_allowed": False,
    "generated_cpu_ap_completion_claim_allowed": False,
}

TRANSCRIPT_MODE_BY_KEY = {
    "ap_benchmark_log": "ap-benchmarks",
    "isa_cache_mmu_log": "isa-cache-mmu",
    "linux_boot_log": "linux-boot",
    "opensbi_boot_log": "opensbi-boot",
    "trap_timer_irq_log": "trap-timer-irq",
}


def evidence_marker(text: str, name: str) -> str | None:
    match = re.search(rf"^eliza-evidence: {re.escape(name)}=(.+)$", text, re.M)
    return match.group(1).strip() if match else None


def parse_evidence_utc(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def transcript_intake_order_problem(
    *,
    prerequisite_text: str,
    prerequisite_path: str,
    dependent_text: str,
    dependent_path: str,
    dependency_label: str,
) -> str | None:
    prerequisite_utc = parse_evidence_utc(evidence_marker(prerequisite_text, "intake_utc"))
    dependent_utc = parse_evidence_utc(evidence_marker(dependent_text, "intake_utc"))
    if prerequisite_utc is None:
        return (
            f"{prerequisite_path} is missing a valid eliza-evidence: intake_utc marker; "
            f"cannot prove {dependency_label} freshness"
        )
    if dependent_utc is None:
        return (
            f"{dependent_path} is missing a valid eliza-evidence: intake_utc marker; "
            f"cannot prove it was captured after {dependency_label}"
        )
    if dependent_utc < prerequisite_utc:
        return (
            f"{dependent_path} was intaken at {dependent_utc.isoformat().replace('+00:00', 'Z')} "
            f"before {dependency_label} {prerequisite_path} was intaken at "
            f"{prerequisite_utc.isoformat().replace('+00:00', 'Z')}; regenerate the dependent "
            "transcript from the current generated-AP run"
        )
    return None


def dependent_transcript_freshness_problems(evidence_manifest: dict) -> list[str]:
    specs = transcript_specs(evidence_manifest)
    linux_spec = specs.get("linux_boot_log", {})
    ap_spec = specs.get("ap_benchmark_log", {})
    linux_path = linux_spec.get("path")
    ap_path = ap_spec.get("path")
    if not isinstance(linux_path, str) or not isinstance(ap_path, str):
        return []
    linux_file = ROOT / linux_path
    ap_file = ROOT / ap_path
    if not linux_file.is_file() or not ap_file.is_file():
        return []
    problem = transcript_intake_order_problem(
        prerequisite_text=linux_file.read_text(encoding="utf-8", errors="ignore"),
        prerequisite_path=linux_path,
        dependent_text=ap_file.read_text(encoding="utf-8", errors="ignore"),
        dependent_path=ap_path,
        dependency_label="linux-boot",
    )
    return [problem] if problem else []


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8", errors="ignore")


def check_scaffold(errors: list[str]) -> None:
    linux_gate = subprocess.run(
        [sys.executable, "scripts/check_linux_hardware_contract_gate.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    require(
        linux_gate.returncode == 0,
        "Linux hardware contract gate failed:\n" + linux_gate.stdout.rstrip(),
        errors,
    )

    cpu = read("rtl/cpu/e1_tiny_cpu_contract.sv")
    cpu_alias = read("rtl/cpu/e1_cpu_subsystem_stub.sv")
    test = read("verify/cocotb/test_tiny_cpu_execution.py")
    tb = read("verify/cocotb/e1_tiny_cpu_contract_tb.sv")
    linux_contract = read("docs/arch/linux-capable-cpu-contract.md")
    blocker = read("docs/project/cpu-ap-blocker-status-2026-05-17.md")
    contract = json.loads(read("sw/platform/e1_platform_contract.json"))
    manifest = load_json(SELECTED_MANIFEST)
    chipyard = manifest.get("chipyard", {})
    selected = manifest.get("selected_path", {})
    claim_policy = manifest.get("claim_policy", {})
    phone_target = manifest.get("phone_2028_target_boundary", {})
    evidence_manifest = load_evidence_manifest(errors)

    require(
        "FETCH_REQ" in cpu and "EXECUTE" in cpu,
        "tiny CPU no longer has fetch/execute states",
        errors,
    )
    require(
        "module e1_cpu_subsystem_stub" in cpu_alias and "e1_tiny_cpu_contract" in cpu_alias,
        "legacy CPU stub alias no longer wraps the tiny CPU contract",
        errors,
    )
    require("7'b0010011" in cpu and "7'b0000011" in cpu, "tiny CPU opcode subset drifted", errors)
    require(
        "irq_pending = timer_irq | software_irq | external_irq" in cpu,
        "IRQ placeholder reflection changed",
        errors,
    )
    require(
        "stall_cpu_ar" in tb and "stall_cpu_aw" in tb and "stall_cpu_w" in tb,
        "CPU contract TB lacks request stall injection",
        errors,
    )
    require(
        "tiny_cpu_extended_opcode_subset_has_observable_state" in test,
        "tiny CPU opcode coverage test is missing",
        errors,
    )
    require(
        "tiny_cpu_waits_for_fetch_and_store_request_stalls" in test,
        "tiny CPU bus stall test is missing",
        errors,
    )
    require(
        "tiny_cpu_privileged_csr_and_trap_instructions_are_blocked_scaffold" in test,
        "tiny CPU privileged/CSR/trap-class fail-closed test is missing",
        errors,
    )
    require(
        contract["e1_chip"].get("has_cpu") is False,
        "platform contract must remain has_cpu=false until package top integrates a production CPU",
        errors,
    )
    require(
        manifest.get("status") in {"selected_not_generated", "linux_complete"},
        "Rocket manifest status must be selected_not_generated or linux_complete",
        errors,
    )
    require(
        chipyard.get("tag") == EXPECTED_CHIPYARD["tag"],
        "Chipyard AP path must remain pinned to tag main-2026-05-20",
        errors,
    )
    require(
        chipyard.get("commit") == EXPECTED_CHIPYARD["commit"],
        "Chipyard AP path must remain pinned to the selected commit",
        errors,
    )
    require(
        selected.get("core") == "Rocket" and selected.get("isa") == "RV64GC",
        "AP path must select Rocket RV64GC",
        errors,
    )
    require(
        selected.get("harts") == 1,
        "first local AP integration target must remain single-hart",
        errors,
    )
    require(
        selected.get("config_name") == "ElizaRocketConfig",
        "AP config name drifted",
        errors,
    )
    require(
        selected.get("claim_level") == "initial_linux_bringup_only",
        "single Rocket AP path must be labeled initial Linux bring-up only",
        errors,
    )
    require(
        phone_target.get("status") == "blocked_not_selected_for_product_claims",
        "2028 phone-class AP target boundary must remain blocked",
        errors,
    )
    require(
        claim_policy.get("linux_capable_cpu_claim")
        is (manifest.get("status") == "linux_complete"),
        "manifest Linux boot claim must match selected manifest evidence state",
        errors,
    )
    require(
        claim_policy.get("platform_contract_has_cpu_may_flip_to_true") is False,
        "platform e1_chip.has_cpu flip must remain blocked for generated AP evidence",
        errors,
    )
    require(
        manifest.get("evidence_manifest") == "docs/evidence/cpu-ap-evidence-manifest.json",
        "selected manifest must point to CPU/AP evidence manifest",
        errors,
    )
    require(
        manifest.get("target_delta_manifest") == "docs/evidence/cpu-ap-2028-target-deltas.json",
        "selected manifest must point to CPU/AP 2028 target delta manifest",
        errors,
    )
    require(
        manifest.get("roadmap_manifest") == "docs/evidence/cpu-ap-roadmap.json",
        "selected manifest must point to CPU/AP roadmap manifest",
        errors,
    )
    require(
        manifest.get("capture_helper") == "scripts/capture_cpu_ap_evidence.py",
        "selected manifest must point to CPU/AP evidence capture helper",
        errors,
    )
    for spec in transcript_specs(evidence_manifest).values():
        path = spec.get("path")
        require(
            path in manifest.get("required_evidence", []),
            f"selected manifest lacks required CPU/AP evidence path: {path}",
            errors,
        )

    require(
        (ROOT / "docs/arch/linux-capable-cpu-contract.md").is_file(),
        "Linux-capable CPU requirements gate is missing",
        errors,
    )
    for token in (
        "OpenSBI",
        "Linux early console",
        "mcause",
        "mepc",
        "mtimecmp",
        "external interrupt claim/complete",
        "firmware-to-kernel handoff",
        "2028 phone-class",
        "ISA compliance",
        "cache hierarchy",
        "MMU",
        "CoreMark",
        "STREAM",
        "power method",
        "process_14a_corner_benchmark_derate_evidence",
        "process effects contract",
        "worst process corner",
        "pdk signoff claim=none",
        "Exact Linux-Capable Gate States",
        "rv64gc_isa",
        "s_mode_privilege",
        "mmu_sv39_or_stronger",
        "clint_timer_software_irq",
        "plic_external_irq",
        "dtb_linux_boot_contract",
        "linux_initramfs_smoke",
        "QEMU `virt` OS boot attempts are useful software-reference evidence only",
    ):
        require(
            token in linux_contract,
            f"Linux-capable CPU contract lacks required evidence token: {token}",
            errors,
        )
    for token in (
        "No generated Chipyard/Rocket RTL",
        "ElizaRocketConfig",
        "has_cpu=false",
        "single Rocket RV64GC hart is not a 2028 phone-class AP",
        "eliza_e1_isa_cache_mmu.log",
        "eliza_e1_ap_benchmarks.log",
    ):
        require(
            token in blocker, f"CPU/AP blocker status lacks required blocker token: {token}", errors
        )


def evidence_problems() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    evidence_manifest = load_evidence_manifest(errors)
    missing: list[str] = []
    problems = errors[:]
    for spec in transcript_specs(evidence_manifest).values():
        rel_path = spec.get("path")
        if not isinstance(rel_path, str):
            continue
        path = ROOT / rel_path
        if not path.is_file():
            missing.append(rel_path)
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        problems.extend(text_problems(text, spec, rel_path, raw=False))
        problems.extend(transcript_metadata_problems(text, rel_path))
    problems.extend(dependent_transcript_freshness_problems(evidence_manifest))
    return missing, problems


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def stale_manifest_bindings(evidence_manifest: dict) -> list[dict[str, object]]:
    if not GENERATED_MANIFEST.is_file():
        return []

    expected_sha = sha256_path(GENERATED_MANIFEST)
    expected_manifest = rel(GENERATED_MANIFEST)
    stale: list[dict[str, object]] = []
    for key, spec in transcript_specs(evidence_manifest).items():
        rel_path = spec.get("path")
        if not isinstance(rel_path, str):
            continue
        path = ROOT / rel_path
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        sha_match = re.search(
            r"^eliza-evidence: generated_manifest_sha256=([0-9a-fA-F]+)$",
            text,
            re.M,
        )
        if not sha_match:
            continue
        recorded_sha = sha_match.group(1).lower()
        if recorded_sha == expected_sha:
            continue
        manifest_match = re.search(r"^eliza-evidence: generated_manifest=(.+)$", text, re.M)
        mode = TRANSCRIPT_MODE_BY_KEY.get(key, key)
        stale.append(
            {
                "transcript": rel_path,
                "transcript_key": key,
                "mode": mode,
                "recorded_generated_manifest": manifest_match.group(1).strip()
                if manifest_match
                else None,
                "recorded_generated_manifest_sha256": recorded_sha,
                "current_generated_manifest": expected_manifest,
                "current_generated_manifest_sha256": expected_sha,
                "transcript_mtime_utc": dt.datetime.fromtimestamp(path.stat().st_mtime, dt.UTC)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
                "generated_manifest_mtime_utc": dt.datetime.fromtimestamp(
                    GENERATED_MANIFEST.stat().st_mtime, dt.UTC
                )
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
                "regeneration_command": (
                    'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
                    f"&& scripts/capture_chipyard_linux_evidence.sh {mode}"
                ),
                "intake_command_template": spec.get("capture_command"),
            }
        )
    return stale


def write_stale_evidence_report(stale: list[dict[str, object]], absent: list[str]) -> None:
    blocked = bool(stale or absent)
    findings = [
        {
            "code": "cpu_ap_stale_transcript",
            "severity": "blocker",
            "message": f"{item.get('transcript')}: manifest hash is stale",
            "evidence": item.get("transcript"),
        }
        for item in stale
    ] + [
        {
            "code": "cpu_ap_missing_transcript",
            "severity": "blocker",
            "message": f"{path}: required CPU/AP transcript is missing",
            "evidence": path,
        }
        for path in absent
    ]
    report = {
        "schema": "eliza.cpu_ap_stale_evidence.v1",
        "status": "blocked" if blocked else "pass",
        "claim_boundary": (
            "blocked_report_only_no_hash_rewrite_no_regenerated_evidence_created_by_this_check"
            if blocked
            else "clear_report_only_no_hash_rewrite_no_regenerated_evidence_created_by_this_check"
        ),
        "generated_utc": utc_now(),
        "generated_manifest": rel(GENERATED_MANIFEST),
        "current_generated_manifest_sha256": sha256_path(GENERATED_MANIFEST)
        if GENERATED_MANIFEST.is_file()
        else None,
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "evidence_current": not blocked,
            "release_ready": False,
            "stale_transcript_count": len(stale),
            "missing_transcript_count": len(absent),
        },
        "findings": findings,
        "stale_transcripts": stale,
        "missing_transcripts": absent,
        "next_smallest_step": (
            "Regenerate each stale transcript from a real generated-AP command, then archive it "
            "with scripts/capture_cpu_ap_evidence.py intake so the transcript records the current "
            "ElizaRocketConfig.manifest.json sha256."
            if blocked
            else "CPU/AP transcripts are current for the selected generated manifest."
        ),
    }
    STALE_EVIDENCE_REPORT.parent.mkdir(parents=True, exist_ok=True)
    STALE_EVIDENCE_REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")


def print_missing_transcripts(absent: list[str], evidence_manifest: dict) -> None:
    if not absent:
        return
    print("  missing production boot/trap evidence:")
    capture_commands: list[str] = []
    specs_by_path = {
        spec.get("path"): spec
        for spec in transcript_specs(evidence_manifest).values()
        if isinstance(spec.get("path"), str)
    }
    for path in absent:
        print(f"  - {path}")
        command = specs_by_path.get(path, {}).get("capture_command")
        if isinstance(command, str) and command:
            capture_commands.append(command)
    if capture_commands:
        print("  capture commands:")
        for command in capture_commands:
            print(f"    {command}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-evidence", action="store_true")
    args = parser.parse_args()

    errors: list[str] = []
    check_scaffold(errors)
    if errors:
        print("CPU/AP scaffold check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("STATUS: PASS cpu_ap.scaffold - tiny executable CPU path and gates are present")
    absent, problems = evidence_problems()
    evidence_manifest = load_evidence_manifest([])
    stale = stale_manifest_bindings(evidence_manifest)
    stale_problem_messages = {
        f"{entry['transcript']} generated_manifest_sha256 must match {rel(GENERATED_MANIFEST)}"
        for entry in stale
    }
    if problems:
        non_stale_problems = [
            problem for problem in problems if problem not in stale_problem_messages
        ]
        if stale and not non_stale_problems:
            write_stale_evidence_report(stale, absent)
            print(
                "STATUS: BLOCKED cpu_ap.linux_evidence - stale generated-manifest-bound "
                "evidence must be regenerated"
            )
            for entry in stale:
                print(
                    "  - "
                    f"{entry['transcript']} records generated_manifest_sha256="
                    f"{entry['recorded_generated_manifest_sha256']} but current "
                    f"{entry['current_generated_manifest']} is "
                    f"{entry['current_generated_manifest_sha256']}"
                )
                print(f"    next: {entry['regeneration_command']}")
            print(f"  report: {rel(STALE_EVIDENCE_REPORT)}")
            print_missing_transcripts(absent, evidence_manifest)
            return 1 if args.require_evidence else 0
        print("STATUS: FAIL cpu_ap.linux_evidence - evidence logs are invalid:")
        for problem in non_stale_problems:
            print(f"  - {problem}")
        return 1
    if absent:
        print("STATUS: BLOCKED cpu_ap.linux_evidence - missing production boot/trap evidence:")
        print_missing_transcripts(absent, evidence_manifest)
        print(
            "  next: run python3 scripts/capture_cpu_ap_evidence.py plan all --format shell, "
            "wire the generated AP simulator/test commands, run "
            "scripts/capture_chipyard_linux_evidence.sh preflight, then capture real generated-AP "
            "transcripts and rerun python3 scripts/check_cpu_ap_evidence.py --require-evidence"
        )
        return 1 if args.require_evidence else 0

    write_stale_evidence_report([], [])
    print("STATUS: PASS cpu_ap.linux_evidence")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
