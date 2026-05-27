#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/minimum_linux_npu_target.json"
DOC = ROOT / "docs/project/minimum-linux-npu-target.md"
CONTRACT = ROOT / "docs/spec-db/e1-npu-runtime-contract.json"
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
COCOTB_XML = ROOT / "verify/cocotb/results/e1_npu_test_e1_npu.xml"
LINUX_DTS = ROOT / "sw/linux/dts/eliza-e1.dts"
LINUX_DRIVER = ROOT / "sw/linux/drivers/e1/e1-npu.c"
QEMU_NPU_MODEL = ROOT / "sw/qemu/qemu-device/eliza_e1_npu.c"
QEMU_NPU_HEADER = ROOT / "sw/qemu/qemu-device/eliza_e1_npu.h"
QEMU_VIRT_PATCH = ROOT / "sw/qemu/qemu-device/virt-e1-npu-integration.patch"
QEMU_BUILD_STACK = ROOT / "sw/qemu/build-e1-qemu-stack.sh"
QEMU_RUN_SMOKE = ROOT / "sw/qemu/run-e1-smoke.sh"
MVP_REPORT = ROOT / "build/reports/mvp_npu_ml_smoke.json"
BOOT_LOG = ROOT / "build/chipyard/eliza_rocket/verilator-linux-smoke.log"
BOOT_REPORT = ROOT / "build/chipyard/eliza_rocket/verilator-linux-smoke.json"
ACCEPTED_LINUX_BOOT_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_linux_boot.log"
ACCEPTED_OPENSBI_BOOT_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log"
CPU_AP_STALE_EVIDENCE_REPORT = ROOT / "build/reports/cpu_ap_stale_evidence.json"
CPU_AP_OPENSBI_BOOT_REPORT = ROOT / "build/reports/cpu_ap_opensbi_boot_regeneration_blocked.json"
CPU_AP_ISA_CACHE_MMU_REPORT = ROOT / "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json"
CPU_AP_ISA_CACHE_MMU_LEGACY_REPORT = ROOT / "build/reports/cpu_ap_isa_cache_mmu_probe.json"
CPU_AP_BENCHMARK_REPORT = ROOT / "build/reports/cpu_ap_benchmark_runner_wiring.json"
CPU_AP_ISA_CACHE_MMU_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log"
CPU_AP_BENCHMARK_EVIDENCE = ROOT / "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"
NNAPI_PROOF = ROOT / "benchmarks/capabilities/e1_npu_nnapi.proof.json"
LINUX_NPU_SMOKE_EVIDENCE = ROOT / "docs/evidence/linux/eliza_e1_npu_ml_smoke.log"
MINIMUM_CPU_AP_TRANSCRIPTS = {
    "opensbi_boot": "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log",
    "linux_boot": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
    "isa_cache_mmu": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
    "ap_benchmarks": "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
}

DEVICE_PATH = "/dev/e1-npu"
WORKLOAD = "gemm_s8_int8_2x2x3"
EXPECTED_OPENSBI_PAYLOAD_FDT_ADDR = "0x80b00000"
EXPECTED_OPENSBI_DOMAIN0_NEXT_ARG1 = "0x0000000080b00000"
BENCHMARK_COMMAND = [
    "e1-npu-ml-smoke",
    "--device",
    DEVICE_PATH,
    "--workload",
    WORKLOAD,
    "--require-npu",
]
GENERATED_AP_USERLAND_NPU_MARKERS = (
    "Linux early console",
    "generated DTS hash",
    "memory node",
    "CPU node",
    "timer node",
    "interrupt-controller node",
    "UART node",
    "chosen stdout",
    "Linux CONFIG_MMU",
    "Run /init as init process",
    "initramfs start",
    "riscv_hwprobe: syscall rc=0",
    "e1 MMIO smoke result: PASS",
    "e1-npu-ml-smoke: PASS",
    "workload=gemm_s8_int8_2x2x3",
    "--require-npu",
    "device=/dev/e1-npu",
    "require_npu=true",
    "CPU fallback percent=0",
    "eliza-evidence: status=PASS",
)
GENERATED_AP_ONE_OF_NPU_MARKERS = (
    (
        "eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot",
        "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke",
    ),
    (
        "Kernel command line:",
        "Forcing kernel command line to:",
    ),
)
GENERATED_AP_FORBIDDEN_NPU_MARKERS = (
    "device=/dev/mem",
    "device=/dev/mem generated-mmio",
    "/dev/mem fallback",
    "/dev/mem-only",
    "devmem fallback",
    "devmem-only",
    "devmem_only",
    "CPU-only fallback",
    "CPU fallback percent=100",
    "CPU fallback percent=1",
    "CPU fallback percent=nonzero",
    "cpu_fallback_percent=100",
    "cpu_fallback_percent=1",
    "cpu_fallback_percent_nonzero",
    "fallback_used=true",
    "require_npu=false",
)
FDT_HANDOFF_SUMMARY_FIELDS = (
    "observed",
    "domain0_next_address",
    "expected_domain0_next_address",
    "domain0_next_address_matches_expected",
    "domain0_next_arg1",
    "expected_domain0_next_arg1",
    "domain0_next_arg1_matches_expected",
    "domain0_next_arg1_in_dram",
    "domain0_next_arg1_fits_dram",
    "domain0_next_arg1_clear_of_kernel_low_window",
    "bounded_bad_dtb_fix",
)
GENERATED_FDT_AUDIT_SUMMARY_FIELDS = (
    "path",
    "exists",
    "dtc_status",
    "dtb_size_bytes",
    "bootrom_plus_dtb_bytes",
    "fits_bootrom_region",
    "expected_opensbi_payload_fdt_addr",
    "expected_opensbi_payload_fdt_addr_in_dram",
    "expected_opensbi_payload_fdt_addr_fits_dram",
    "expected_opensbi_payload_fdt_addr_clear_of_kernel_low_window",
    "missing_required_tokens",
)
FDT_DIAGNOSIS_SUMMARY_FIELDS = (
    "dtc_status",
    "dtb_size_bytes",
    "bootrom_plus_dtb_bytes",
    "generated_dtb_plausible",
    "first_payload_pc",
    "last_pc",
    "last_symbol",
    "retired_instruction_count",
    "loop_detected",
    "reason",
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"_invalid_json": True, "_json_error": str(exc), "_path": rel(path)}
    return data if isinstance(data, dict) else {}


def sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact(path: Path) -> dict[str, Any]:
    item: dict[str, Any] = {"path": rel(path), "exists": path.is_file()}
    if path.is_file():
        item.update({"bytes": path.stat().st_size, "sha256": sha256(path)})
    return item


def load_preferred_json(primary: Path, *fallbacks: Path) -> tuple[dict[str, Any], Path]:
    for path in (primary, *fallbacks):
        if path.is_file():
            return load_json(path), path
    return {}, primary


def report_blockers(report: dict[str, Any]) -> list[str]:
    blockers = report.get("blockers", [])
    if isinstance(blockers, list):
        return [str(blocker) for blocker in blockers if blocker]
    blocker = report.get("blocker")
    return [str(blocker)] if blocker else []


def pick_fields(data: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    return {field: data.get(field) for field in fields if field in data}


def normalize_companion_fdt_expectations(
    generated_fdt: dict[str, Any], opensbi_handoff: dict[str, Any]
) -> None:
    """Keep stale companion reports from re-exporting obsolete FDT expectations."""
    if generated_fdt:
        generated_fdt["expected_opensbi_payload_fdt_addr"] = EXPECTED_OPENSBI_PAYLOAD_FDT_ADDR
        generated_fdt["expected_opensbi_payload_fdt_addr_clear_of_kernel_low_window"] = False
    if opensbi_handoff:
        opensbi_handoff["expected_domain0_next_arg1"] = EXPECTED_OPENSBI_DOMAIN0_NEXT_ARG1
        opensbi_handoff["domain0_next_arg1_clear_of_kernel_low_window"] = False
        observed = opensbi_handoff.get("domain0_next_arg1")
        if observed:
            opensbi_handoff["domain0_next_arg1_matches_expected"] = (
                str(observed).lower() == EXPECTED_OPENSBI_DOMAIN0_NEXT_ARG1.lower()
            )


def fdt_handoff_contract(boot_report: dict[str, Any]) -> dict[str, Any]:
    generated_fdt = pick_fields(
        boot_report.get("generated_fdt_audit"), GENERATED_FDT_AUDIT_SUMMARY_FIELDS
    )
    opensbi_handoff = pick_fields(
        boot_report.get("opensbi_fdt_handoff_audit"), FDT_HANDOFF_SUMMARY_FIELDS
    )
    normalize_companion_fdt_expectations(generated_fdt, opensbi_handoff)
    fdt_diagnosis = pick_fields(
        boot_report.get("fdt_handoff_diagnosis"), FDT_DIAGNOSIS_SUMMARY_FIELDS
    )
    diagnostic_fdt_diagnosis = pick_fields(
        boot_report.get("diagnostic_fdt_handoff_diagnosis"), FDT_DIAGNOSIS_SUMMARY_FIELDS
    )
    expected_fdt_addr = EXPECTED_OPENSBI_PAYLOAD_FDT_ADDR
    expected_next_arg1 = EXPECTED_OPENSBI_DOMAIN0_NEXT_ARG1
    observed_next_arg1 = opensbi_handoff.get("domain0_next_arg1")
    matches_expected = opensbi_handoff.get("domain0_next_arg1_matches_expected")
    return {
        "expected_opensbi_payload_fdt_addr": expected_fdt_addr,
        "expected_domain0_next_arg1": expected_next_arg1,
        "observed_domain0_next_arg1": observed_next_arg1,
        "domain0_next_arg1_matches_expected": matches_expected,
        "generated_fdt_audit": generated_fdt,
        "opensbi_fdt_handoff_audit": opensbi_handoff,
        "fdt_handoff_diagnosis": fdt_diagnosis,
        "diagnostic_fdt_handoff_diagnosis": diagnostic_fdt_diagnosis,
        "claim_boundary": (
            "companion Chipyard FDT handoff evidence is diagnostic for this aggregate "
            "gate; the minimum target still requires accepted CPU/AP transcript intake "
            "before integrated Linux+NPU proof can pass"
        ),
    }


def cpu_ap_transcript_state(report: dict[str, Any], transcript: Path) -> str:
    transcript_rel = rel(transcript)
    missing = set(report.get("missing_transcripts", []))
    stale = {
        str(item.get("transcript"))
        for item in report.get("stale_transcripts", [])
        if isinstance(item, dict)
    }
    if transcript_rel in missing:
        return "missing"
    if transcript_rel in stale:
        return "stale"
    if transcript.is_file():
        return "accepted"
    return "missing"


def accepted_cpu_ap_transcript_states(
    report: dict[str, Any], full_check_passed: bool
) -> dict[str, str]:
    if full_check_passed:
        return {name: "accepted" for name in MINIMUM_CPU_AP_TRANSCRIPTS}
    return {
        "opensbi_boot": cpu_ap_transcript_state(report, ACCEPTED_OPENSBI_BOOT_EVIDENCE),
        "linux_boot": cpu_ap_transcript_state(report, ACCEPTED_LINUX_BOOT_EVIDENCE),
        "isa_cache_mmu": cpu_ap_transcript_state(
            report, ROOT / "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log"
        ),
        "ap_benchmarks": cpu_ap_transcript_state(
            report, ROOT / "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"
        ),
    }


def minimum_cpu_ap_subset_ready(
    *, completed_returncode: int, stdout: str, report: dict[str, Any], states: dict[str, str]
) -> tuple[bool, dict[str, str]]:
    missing_required = {
        name: state
        for name, state in states.items()
        if name in MINIMUM_CPU_AP_TRANSCRIPTS and state != "accepted"
    }
    if completed_returncode == 0:
        return True, missing_required
    if "STATUS: FAIL cpu_ap.linux_evidence" in stdout:
        return False, missing_required
    stale_or_missing = bool(report.get("stale_transcripts") or report.get("missing_transcripts"))
    return stale_or_missing and not missing_required, missing_required


def minimum_cpu_ap_evidence_requirements(
    states: dict[str, str],
    isa_cache_mmu_report: dict[str, Any],
    ap_benchmark_report: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    requirements = {
        "linux_boot": {
            "path": rel(ACCEPTED_LINUX_BOOT_EVIDENCE),
            "accepted_transcript_state": states.get("linux_boot", "missing"),
            "exists": ACCEPTED_LINUX_BOOT_EVIDENCE.is_file(),
        },
        "isa_cache_mmu": {
            "path": rel(CPU_AP_ISA_CACHE_MMU_EVIDENCE),
            "accepted_transcript_state": states.get("isa_cache_mmu", "missing"),
            "exists": CPU_AP_ISA_CACHE_MMU_EVIDENCE.is_file(),
            "companion_report": rel(CPU_AP_ISA_CACHE_MMU_REPORT),
            "companion_report_status": isa_cache_mmu_report.get("status", ""),
            "required_linux_userspace_hwprobe_marker": "riscv_hwprobe: syscall rc=0",
        },
        "ap_benchmarks": {
            "path": rel(CPU_AP_BENCHMARK_EVIDENCE),
            "accepted_transcript_state": states.get("ap_benchmarks", "missing"),
            "exists": CPU_AP_BENCHMARK_EVIDENCE.is_file(),
            "companion_report": rel(CPU_AP_BENCHMARK_REPORT),
            "companion_report_status": ap_benchmark_report.get("status", ""),
            "required_linux_boot_evidence": rel(ACCEPTED_LINUX_BOOT_EVIDENCE),
        },
        "opensbi_boot": {
            "path": rel(ACCEPTED_OPENSBI_BOOT_EVIDENCE),
            "accepted_transcript_state": states.get("opensbi_boot", "missing"),
            "exists": ACCEPTED_OPENSBI_BOOT_EVIDENCE.is_file(),
        },
    }
    missing = {
        name: str(item["accepted_transcript_state"])
        for name, item in requirements.items()
        if item.get("accepted_transcript_state") != "accepted"
    }
    return requirements, missing


def cocotb_gate() -> dict[str, Any]:
    if not COCOTB_XML.is_file():
        return {"name": "rtl_cocotb_proof", "status": "blocked", "path": rel(COCOTB_XML)}
    try:
        import xml.etree.ElementTree as ET

        root = ET.fromstring(read(COCOTB_XML))
    except ImportError as exc:
        return {
            "name": "rtl_cocotb_proof",
            "status": "blocked",
            "path": rel(COCOTB_XML),
            "blocker": f"Python XML parser unavailable: {exc}",
        }
    except ET.ParseError as exc:
        return {
            "name": "rtl_cocotb_proof",
            "status": "failed",
            "path": rel(COCOTB_XML),
            "error": f"invalid cocotb XML: {exc}",
        }
    failures = sum(int(suite.attrib.get("failures", "0")) for suite in root.iter("testsuite"))
    errors = sum(int(suite.attrib.get("errors", "0")) for suite in root.iter("testsuite"))
    testcases = len(list(root.iter("testcase")))
    return {
        "name": "rtl_cocotb_proof",
        "status": "passed" if testcases and failures == 0 and errors == 0 else "failed",
        "path": rel(COCOTB_XML),
        "testcases": testcases,
        "failures": failures,
        "errors": errors,
    }


def run_mvp_smoke() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_mvp_npu_ml_evidence.py", "--run"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(MVP_REPORT)
    report_status = report.get("status")
    status = "passed" if report_status == "pass" or completed.returncode == 0 else "blocked"
    return {
        "name": "local_npu_ml_smoke",
        "status": status,
        "command": completed.args,
        "stdout": completed.stdout,
        "report": report,
    }


def run_linux_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_minimum_linux_target.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(ROOT / "build/reports/minimum-linux-kernel-target.json")
    report_status = report.get("status")
    status = report_status if report_status in {"pass", "blocked", "fail"} else None
    return {
        "name": "minimum_linux_kernel_target",
        "status": (
            "passed"
            if status == "pass"
            else "blocked"
            if status == "blocked"
            else "blocked"
            if completed.returncode != 0 or status == "fail"
            else "blocked"
        ),
        "command": completed.args,
        "stdout": completed.stdout,
        "report": report,
    }


def run_target_smoke_source_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_e1_npu_linux_smoke.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(ROOT / "build/reports/e1_npu_linux_smoke_source.json")
    report_status = report.get("status")
    return {
        "name": "target_side_npu_ml_smoke",
        "status": (
            "passed"
            if report_status == "pass"
            else "blocked"
            if report_status == "blocked"
            else "blocked"
        ),
        "command": completed.args,
        "stdout": completed.stdout,
        "report": report,
    }


def run_cpu_ap_transcript_bundle_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_cpu_ap_evidence.py", "--require-evidence"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    report = load_json(CPU_AP_STALE_EVIDENCE_REPORT)
    full_check_passed = completed.returncode == 0
    transcript_states = accepted_cpu_ap_transcript_states(report, full_check_passed)
    minimum_ready, minimum_missing_states = minimum_cpu_ap_subset_ready(
        completed_returncode=completed.returncode,
        stdout=completed.stdout,
        report=report,
        states=transcript_states,
    )
    opensbi_evidence_state = cpu_ap_transcript_state(report, ACCEPTED_OPENSBI_BOOT_EVIDENCE)
    if full_check_passed:
        opensbi_evidence_state = "accepted"
    opensbi_regeneration_report = load_json(CPU_AP_OPENSBI_BOOT_REPORT)
    isa_cache_mmu_report, isa_cache_mmu_report_path = load_preferred_json(
        CPU_AP_ISA_CACHE_MMU_REPORT, CPU_AP_ISA_CACHE_MMU_LEGACY_REPORT
    )
    ap_benchmark_report = load_json(CPU_AP_BENCHMARK_REPORT)
    accepted_requirements, accepted_requirement_blockers = (
        minimum_cpu_ap_evidence_requirements(
            transcript_states, isa_cache_mmu_report, ap_benchmark_report
        )
    )
    companion_reports = {
        "opensbi_boot": {
            "accepted_evidence": artifact(ACCEPTED_OPENSBI_BOOT_EVIDENCE),
            "accepted_evidence_state": opensbi_evidence_state,
            "diagnostic_report": rel(CPU_AP_OPENSBI_BOOT_REPORT),
            "diagnostic_report_status": opensbi_regeneration_report.get("status", ""),
            "diagnostic_report_only": True,
            "diagnostic_report_superseded_by_accepted_evidence": (
                opensbi_evidence_state == "accepted"
            ),
            "report": opensbi_regeneration_report,
        },
        "isa_cache_mmu": {
            "path": rel(CPU_AP_ISA_CACHE_MMU_REPORT),
            "accepted_evidence": artifact(CPU_AP_ISA_CACHE_MMU_EVIDENCE),
            "accepted_evidence_state": transcript_states.get("isa_cache_mmu", "missing"),
            "loaded_report": rel(isa_cache_mmu_report_path),
            "legacy_report": rel(CPU_AP_ISA_CACHE_MMU_LEGACY_REPORT),
            "status": isa_cache_mmu_report.get("status", ""),
            "required_linux_userspace_hwprobe_marker": "riscv_hwprobe: syscall rc=0",
            "missing_final_markers": isa_cache_mmu_report.get("missing_final_markers", []),
            "missing_hwprobe_markers": (
                (isa_cache_mmu_report.get("linux_userspace_hwprobe") or {}).get(
                    "missing_hwprobe_markers", []
                )
                if isinstance(isa_cache_mmu_report.get("linux_userspace_hwprobe"), dict)
                else []
            ),
            "blockers": report_blockers(isa_cache_mmu_report),
            "report": isa_cache_mmu_report,
        },
        "ap_benchmarks": {
            "path": rel(CPU_AP_BENCHMARK_REPORT),
            "accepted_evidence": artifact(CPU_AP_BENCHMARK_EVIDENCE),
            "accepted_evidence_state": transcript_states.get("ap_benchmarks", "missing"),
            "status": ap_benchmark_report.get("status", ""),
            "blockers": report_blockers(ap_benchmark_report),
            "required_linux_boot_evidence": rel(ACCEPTED_LINUX_BOOT_EVIDENCE),
            "report": ap_benchmark_report,
        },
    }
    status = "passed" if minimum_ready else "blocked"
    gate: dict[str, Any] = {
        "name": "cpu_ap_transcript_bundle",
        "status": status,
        "command": completed.args,
        "stdout": completed.stdout,
        "full_cpu_ap_checker_status": "passed" if full_check_passed else "blocked",
        "report": rel(CPU_AP_STALE_EVIDENCE_REPORT),
        "report_status": report.get("status", ""),
        "missing_transcripts": report.get("missing_transcripts", []),
        "stale_transcripts": report.get("stale_transcripts", []),
        "findings": report.get("findings", []),
        "companion_reports": companion_reports,
        "accepted_transcript_states": transcript_states,
        "accepted_minimum_evidence_requirements": accepted_requirements,
        "accepted_minimum_evidence_blockers": accepted_requirement_blockers,
        "minimum_required_transcripts": MINIMUM_CPU_AP_TRANSCRIPTS,
        "minimum_missing_transcript_states": minimum_missing_states,
        "non_minimum_transcript_blockers": {
            "missing_transcripts": [
                item
                for item in report.get("missing_transcripts", [])
                if item not in MINIMUM_CPU_AP_TRANSCRIPTS.values()
            ],
            "stale_transcripts": [
                item
                for item in report.get("stale_transcripts", [])
                if isinstance(item, dict)
                and item.get("transcript") not in MINIMUM_CPU_AP_TRANSCRIPTS.values()
            ],
        },
        "claim_boundary": (
            "imports only OpenSBI, Linux boot, ISA/cache/MMU, and AP benchmark "
            "CPU/AP transcript intake blockers as prerequisites for the minimum "
            "Linux+NPU target; broader CPU/AP checker blockers remain diagnostic "
            "unless they affect those minimum transcripts"
        ),
        "next_actions": {
            "linux_boot": (
                'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
                "&& scripts/capture_chipyard_linux_evidence.sh linux-boot"
            ),
            "linux_docs_sync": (
                "python3 scripts/capture_cpu_ap_evidence.py sync-linux-docs"
            ),
            "remaining_after_linux_boot": (
                'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
                "&& scripts/capture_chipyard_linux_evidence.sh remaining-after-linux-boot"
            ),
            "trap_timer_irq": (
                'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
                "&& scripts/capture_chipyard_linux_evidence.sh trap-timer-irq"
            ),
            "isa_cache_mmu": (
                'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
                "&& scripts/capture_chipyard_linux_evidence.sh isa-cache-mmu"
            ),
            "ap_benchmarks": (
                'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
                "&& scripts/capture_chipyard_linux_evidence.sh ap-benchmarks"
            ),
        },
    }
    if status != "passed":
        gate["blocker"] = (
            "minimum CPU/AP transcript subset is incomplete or stale; regenerate "
            "linux-boot, isa-cache-mmu, and ap-benchmarks generated-AP evidence "
            "as needed and archive it through capture_cpu_ap_evidence.py"
        )
    return gate


def run_mlperf_inference_energy_check() -> dict[str, Any]:
    completed = subprocess.run(
        [sys.executable, "scripts/check_mlperf_inference.py"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return {
        "name": "modeled_mlperf_inference_energy_gate",
        "status": "passed" if completed.returncode == 0 else "blocked",
        "command": completed.args,
        "stdout": completed.stdout,
        "claim_boundary": (
            "single modeled pre-silicon MLPerf Inference subset (SingleStream + Offline) "
            "over E1NpuRuntime/E1NpuMmioSim with a simulator energy block (G-7); "
            "not generated-AP Linux target proof, official MLCommons, or measured silicon power"
        ),
    }


def benchmark_command_gate(target_smoke: dict[str, Any]) -> dict[str, Any]:
    report = target_smoke.get("report")
    report = report if isinstance(report, dict) else {}
    evidence = report.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    evidence_path = ROOT / str(evidence.get("path") or rel(LINUX_NPU_SMOKE_EVIDENCE))
    evidence_text = read(evidence_path)
    target_command = str(
        (report.get("capture_commands") or {}).get("target_smoke", "")
        if isinstance(report.get("capture_commands"), dict)
        else ""
    )
    required_markers = (
        "e1-npu-ml-smoke",
        "--device /dev/e1-npu",
        "--workload gemm_s8_int8_2x2x3",
        "--require-npu",
        "e1-npu-ml-smoke: PASS",
        "workload=gemm_s8_int8_2x2x3",
        "input_sha256=",
        "output_sha256=",
        "desc_bytes_read=",
        "desc_bytes_written=",
        "claim_boundary=driver_ioctl_gemm_only_not_nnapi_or_hardware_benchmark",
        "eliza-evidence: status=PASS",
    )
    missing_markers = [marker for marker in required_markers if marker not in evidence_text]
    required_command_tokens = ("e1-npu-ml-smoke", "/dev/e1-npu", WORKLOAD, "--require-npu")
    missing_command_tokens = [
        token
        for token in required_command_tokens
        if token not in target_command and token not in evidence_text
    ]
    forbidden_markers = [
        marker for marker in GENERATED_AP_FORBIDDEN_NPU_MARKERS if marker in evidence_text
    ]
    passed = (
        target_smoke.get("status") == "passed"
        and evidence_path.is_file()
        and not missing_markers
        and not missing_command_tokens
        and not forbidden_markers
    )
    gate: dict[str, Any] = {
        "name": "benchmark_command",
        "status": "passed" if passed else "blocked",
        "command": BENCHMARK_COMMAND,
        "capture_command": target_command,
        "evidence": artifact(evidence_path),
        "source_gate_status": target_smoke.get("status"),
        "claim_boundary": (
            "proves the target-side Linux NPU userspace command and deterministic GEMM "
            "markers were captured; generated-AP integrated boot proof is checked by "
            "generated_ap_linux_boot/minimum_linux_kernel_target"
        ),
    }
    if missing_markers or missing_command_tokens:
        gate["missing_markers"] = missing_markers
        gate["missing_command_tokens"] = missing_command_tokens
    if forbidden_markers:
        gate["forbidden_markers"] = forbidden_markers
    if not passed:
        gate["blocker"] = (
            "target-side e1-npu-ml-smoke transcript lacks required command/PASS "
            "markers or contains forbidden /dev/mem or CPU fallback markers"
        )
    return gate


def qemu_npu_emulator_stack_gate() -> dict[str, Any]:
    model_text = read(QEMU_NPU_MODEL)
    header_text = read(QEMU_NPU_HEADER)
    patch_text = read(QEMU_VIRT_PATCH)
    build_text = read(QEMU_BUILD_STACK)
    run_text = read(QEMU_RUN_SMOKE)
    required_tokens = {
        rel(QEMU_NPU_MODEL): (
            "TYPE_ELIZA_E1_NPU",
            "system/dma.h",
            "eliza_e1_npu_gemm",
            "eliza_e1_npu_run_descriptors",
            "dma_memory_read",
            "dma_memory_write",
            "R_DESC_BASE",
            "R_DESC_BYTES_READ",
            "R_DESC_BYTES_WRITTEN",
            "VMStateDescription vmstate_eliza_e1_npu",
        ),
        rel(QEMU_NPU_HEADER): (
            'TYPE_ELIZA_E1_NPU "eliza.e1-npu"',
            "ElizaE1NpuState",
        ),
        rel(QEMU_VIRT_PATCH): (
            "CONFIG_ELIZA_E1_NPU",
            'qemu_fdt_setprop_string(ms->fdt, name, "compatible", "eliza,e1-npu")',
            "0x10020000",
            "object_class_property_add_bool",
            "e1-npu",
        ),
        rel(QEMU_BUILD_STACK): (
            "cp sw/qemu/qemu-device/eliza_e1_npu.c",
            "CONFIG_ELIZA_E1_CONTRACT=y",
            "e1-npu-ml-smoke",
            "rootfs-e1.cpio.gz",
        ),
        rel(QEMU_RUN_SMOKE): (
            "-M virt,e1-npu=on",
            "E1_SMOKE_BEGIN",
            "E1_SMOKE_RC=",
            "e1smoke=$mode",
        ),
    }
    texts = {
        rel(QEMU_NPU_MODEL): model_text,
        rel(QEMU_NPU_HEADER): header_text,
        rel(QEMU_VIRT_PATCH): patch_text,
        rel(QEMU_BUILD_STACK): build_text,
        rel(QEMU_RUN_SMOKE): run_text,
    }
    missing_files = [
        rel(path)
        for path in (
            QEMU_NPU_MODEL,
            QEMU_NPU_HEADER,
            QEMU_VIRT_PATCH,
            QEMU_BUILD_STACK,
            QEMU_RUN_SMOKE,
        )
        if not path.is_file()
    ]
    missing_tokens = {
        path: [token for token in tokens if token not in texts.get(path, "")]
        for path, tokens in required_tokens.items()
    }
    missing_tokens = {path: tokens for path, tokens in missing_tokens.items() if tokens}
    passed = not missing_files and not missing_tokens
    gate: dict[str, Any] = {
        "name": "qemu_npu_emulator_stack",
        "status": "passed" if passed else "blocked",
        "model": artifact(QEMU_NPU_MODEL),
        "header": artifact(QEMU_NPU_HEADER),
        "virt_patch": artifact(QEMU_VIRT_PATCH),
        "build_stack": artifact(QEMU_BUILD_STACK),
        "run_smoke": artifact(QEMU_RUN_SMOKE),
        "required_machine_arg": "-M virt,e1-npu=on",
        "required_guest_device": DEVICE_PATH,
        "claim_boundary": (
            "static contract for the functional qemu-system-riscv64 e1-npu MMIO "
            "device model, virt-machine FDT wiring, Linux driver import, and smoke "
            "runner; runtime PASS still requires running sw/qemu/run-e1-smoke.sh "
            "and capturing the transcript"
        ),
    }
    if missing_files or missing_tokens:
        gate["missing_files"] = missing_files
        gate["missing_tokens"] = missing_tokens
        gate["blocker"] = (
            "QEMU e1-npu emulator stack is not structurally complete enough to "
            "support a generated Linux+NPU runtime proof"
        )
    return gate


def generated_ap_linux_boot_gate(
    accepted_boot_text: str,
    attempt_text: str,
    boot_report: dict[str, Any],
    accepted_transcript_state: str = "accepted",
) -> dict[str, Any]:
    observed_text = accepted_boot_text or attempt_text
    observed_source = (
        "accepted_cpu_ap_linux_boot_transcript"
        if accepted_boot_text
        else "diagnostic_attempt_log"
        if attempt_text
        else "none"
    )
    early_boot_markers_present = "Linux version" in observed_text and (
        "OpenSBI" in observed_text or "SBI specification" in observed_text
    )
    missing_one_of_userland_npu_markers = [
        " or ".join(group)
        for group in GENERATED_AP_ONE_OF_NPU_MARKERS
        if not any(marker in observed_text for marker in group)
    ]
    missing_userland_npu_markers = [
        marker for marker in GENERATED_AP_USERLAND_NPU_MARKERS if marker not in observed_text
    ] + missing_one_of_userland_npu_markers
    forbidden_userland_npu_markers = [
        marker for marker in GENERATED_AP_FORBIDDEN_NPU_MARKERS if marker in observed_text
    ]
    accepted_missing_one_of_userland_npu_markers = [
        " or ".join(group)
        for group in GENERATED_AP_ONE_OF_NPU_MARKERS
        if not any(marker in accepted_boot_text for marker in group)
    ]
    accepted_missing_userland_npu_markers = [
        marker for marker in GENERATED_AP_USERLAND_NPU_MARKERS if marker not in accepted_boot_text
    ] + accepted_missing_one_of_userland_npu_markers
    accepted_forbidden_userland_npu_markers = [
        marker for marker in GENERATED_AP_FORBIDDEN_NPU_MARKERS if marker in accepted_boot_text
    ]
    attempt_missing_one_of_userland_npu_markers = [
        " or ".join(group)
        for group in GENERATED_AP_ONE_OF_NPU_MARKERS
        if not any(marker in attempt_text for marker in group)
    ]
    attempt_missing_userland_npu_markers = [
        marker for marker in GENERATED_AP_USERLAND_NPU_MARKERS if marker not in attempt_text
    ] + attempt_missing_one_of_userland_npu_markers
    attempt_forbidden_userland_npu_markers = [
        marker for marker in GENERATED_AP_FORBIDDEN_NPU_MARKERS if marker in attempt_text
    ]
    accepted_evidence_present = ACCEPTED_LINUX_BOOT_EVIDENCE.is_file()
    accepted_evidence_current = accepted_evidence_present and accepted_transcript_state == "accepted"
    generated_ap_linux_boot_passed = (
        accepted_evidence_current
        and not accepted_missing_userland_npu_markers
        and not accepted_forbidden_userland_npu_markers
    )
    if generated_ap_linux_boot_passed:
        readiness_state = "accepted_linux_userspace_npu_transcript"
    elif not accepted_evidence_present:
        readiness_state = (
            "diagnostic_attempt_has_linux_userspace_npu_markers"
            if attempt_text
            and not attempt_missing_userland_npu_markers
            and not attempt_forbidden_userland_npu_markers
            else "accepted_transcript_missing"
        )
    elif accepted_transcript_state == "stale":
        readiness_state = "accepted_transcript_stale"
    else:
        readiness_state = "accepted_transcript_incomplete_or_fallback"
    companion_fdt_handoff = fdt_handoff_contract(boot_report)
    gate: dict[str, Any] = {
        "name": "generated_ap_linux_boot",
        "status": "passed" if generated_ap_linux_boot_passed else "blocked",
        "path": rel(ACCEPTED_LINUX_BOOT_EVIDENCE),
        "evidence": artifact(ACCEPTED_LINUX_BOOT_EVIDENCE),
        "attempt_log": artifact(BOOT_LOG),
        "companion_report": rel(BOOT_REPORT),
        "companion_report_status": boot_report.get("status", ""),
        "expected_opensbi_payload_fdt_addr": companion_fdt_handoff[
            "expected_opensbi_payload_fdt_addr"
        ],
        "expected_domain0_next_arg1": companion_fdt_handoff["expected_domain0_next_arg1"],
        "companion_fdt_handoff": companion_fdt_handoff,
        "acceptance_basis": (
            "accepted_cpu_ap_linux_boot_transcript_with_userland_npu_mmio_markers"
            if generated_ap_linux_boot_passed
            else ""
        ),
        "required_markers": list(GENERATED_AP_USERLAND_NPU_MARKERS),
        "required_one_of_markers": [list(group) for group in GENERATED_AP_ONE_OF_NPU_MARKERS],
        "forbidden_markers": list(GENERATED_AP_FORBIDDEN_NPU_MARKERS),
        "missing_userland_npu_markers": missing_userland_npu_markers,
        "forbidden_userland_npu_markers": forbidden_userland_npu_markers,
        "accepted_transcript_present": accepted_evidence_present,
        "accepted_transcript_state": accepted_transcript_state,
        "observed_source": observed_source,
        "readiness_state": readiness_state,
        "accepted_userland_npu_markers_complete": (
            accepted_evidence_current
            and not accepted_missing_userland_npu_markers
            and not accepted_forbidden_userland_npu_markers
        ),
        "accepted_missing_userland_npu_markers": accepted_missing_userland_npu_markers,
        "accepted_forbidden_userland_npu_markers": accepted_forbidden_userland_npu_markers,
        "attempt_userland_npu_markers_complete": (
            bool(attempt_text)
            and not attempt_missing_userland_npu_markers
            and not attempt_forbidden_userland_npu_markers
        ),
        "attempt_missing_userland_npu_markers": attempt_missing_userland_npu_markers,
        "attempt_forbidden_userland_npu_markers": attempt_forbidden_userland_npu_markers,
        "observed_markers": {
            "OpenSBI_or_SBI": "OpenSBI" in observed_text or "SBI specification" in observed_text,
            "Linux version": "Linux version" in observed_text,
            "initramfs start": "initramfs start" in observed_text,
            "e1 MMIO smoke result: PASS": "e1 MMIO smoke result: PASS" in observed_text,
            "e1-npu-ml-smoke: PASS": "e1-npu-ml-smoke: PASS" in observed_text,
            "device=/dev/e1-npu": "device=/dev/e1-npu" in observed_text,
            "CPU fallback percent=0": "CPU fallback percent=0" in observed_text,
        },
        "early_boot_markers_present": early_boot_markers_present,
        "claim_boundary": (
            "generated AP Linux+NPU proof requires an accepted CPU/AP Linux boot "
            "transcript captured through capture_cpu_ap_evidence.py at "
            f"{rel(ACCEPTED_LINUX_BOOT_EVIDENCE)} with deterministic MMIO/GEMM PASS "
            "markers; raw simulator attempt logs and companion progress reports are "
            "diagnostic only"
        ),
        "unblock_command": (
            'eval "$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)" '
            "&& scripts/capture_chipyard_linux_evidence.sh linux-boot"
        ),
    }
    if boot_report:
        gate["companion_report_blockers"] = boot_report.get("blockers", [])
        gate["companion_report_progress"] = boot_report.get("progress", {})
        gate["companion_report_next_safe_action"] = boot_report.get("next_safe_action", "")
        instruction_trace = boot_report.get("instruction_trace")
        if isinstance(instruction_trace, dict) and instruction_trace.get("exists"):
            gate["companion_report_instruction_trace"] = {
                "path": instruction_trace.get("path"),
                "fresh_for_log": instruction_trace.get("fresh_for_log"),
                "bootrom_to_payload_handoff": instruction_trace.get("bootrom_to_payload_handoff"),
                "first_payload_pc": instruction_trace.get("first_payload_pc"),
                "last_pc": instruction_trace.get("last_pc"),
                "last_symbol": instruction_trace.get("last_symbol"),
                "retired_instruction_count": instruction_trace.get("retired_instruction_count"),
            }
        active_attempt = boot_report.get("active_smoke_attempt")
        if isinstance(active_attempt, dict) and active_attempt.get("exists"):
            gate["companion_report_active_smoke_attempt"] = active_attempt
    if not generated_ap_linux_boot_passed:
        if not accepted_evidence_present:
            gate["blocker"] = (
                f"missing accepted generated-AP Linux boot transcript at "
                f"{rel(ACCEPTED_LINUX_BOOT_EVIDENCE)}; current Chipyard smoke artifacts "
                "remain diagnostic until captured through the CPU/AP evidence intake"
            )
        elif accepted_transcript_state != "accepted":
            gate["blocker"] = (
                "accepted generated-AP transcript is marked "
                f"{accepted_transcript_state} by CPU/AP evidence intake; refresh and "
                "archive the Linux boot transcript before claiming Linux+NPU proof"
            )
        elif missing_userland_npu_markers or forbidden_userland_npu_markers:
            gate["blocker"] = (
                "accepted generated-AP transcript lacks required FireMarshal /dev/e1-npu "
                "zero-fallback PASS markers or contains forbidden fallback markers"
            )
    return gate


def remaining_blocker_records(blockers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for gate in blockers:
        name = str(gate.get("name", "unknown"))
        record: dict[str, Any] = {"name": name, "status": gate.get("status", "blocked")}
        if gate.get("blocker"):
            record["blocker"] = gate["blocker"]
        if name == "minimum_linux_kernel_target":
            report = gate.get("report") if isinstance(gate.get("report"), dict) else {}
            record["upstream_blockers"] = report.get("blockers", [])
            record["report"] = "build/reports/minimum-linux-kernel-target.json"
        elif name == "cpu_ap_transcript_bundle":
            record["full_cpu_ap_checker_status"] = gate.get("full_cpu_ap_checker_status", "")
            record["accepted_transcript_states"] = gate.get("accepted_transcript_states", {})
            record["accepted_minimum_evidence_requirements"] = gate.get(
                "accepted_minimum_evidence_requirements", {}
            )
            record["accepted_minimum_evidence_blockers"] = gate.get(
                "accepted_minimum_evidence_blockers", {}
            )
            record["minimum_required_transcripts"] = gate.get(
                "minimum_required_transcripts", {}
            )
            record["minimum_missing_transcript_states"] = gate.get(
                "minimum_missing_transcript_states", {}
            )
            record["non_minimum_transcript_blockers"] = gate.get(
                "non_minimum_transcript_blockers", {}
            )
            record["missing_transcripts"] = gate.get("missing_transcripts", [])
            record["stale_transcripts"] = gate.get("stale_transcripts", [])
            companion_reports = gate.get("companion_reports") or {}
            record["diagnostic_reports_only"] = [
                companion.get("diagnostic_report")
                for companion in companion_reports.values()
                if isinstance(companion, dict) and companion.get("diagnostic_report_only")
            ]
            isa_cache_mmu = companion_reports.get("isa_cache_mmu")
            if isinstance(isa_cache_mmu, dict):
                record["isa_cache_mmu_report"] = isa_cache_mmu.get("path", "")
                record["isa_cache_mmu_accepted_evidence"] = (
                    isa_cache_mmu.get("accepted_evidence", {}).get("path", "")
                    if isinstance(isa_cache_mmu.get("accepted_evidence"), dict)
                    else ""
                )
                record["isa_cache_mmu_accepted_evidence_state"] = isa_cache_mmu.get(
                    "accepted_evidence_state", ""
                )
                record["isa_cache_mmu_loaded_report"] = isa_cache_mmu.get("loaded_report", "")
                record["required_linux_userspace_hwprobe_marker"] = isa_cache_mmu.get(
                    "required_linux_userspace_hwprobe_marker", ""
                )
                record["isa_cache_mmu_missing_hwprobe_markers"] = isa_cache_mmu.get(
                    "missing_hwprobe_markers", []
                )
                record["isa_cache_mmu_missing_final_markers"] = isa_cache_mmu.get(
                    "missing_final_markers", []
                )
                record["isa_cache_mmu_blockers"] = isa_cache_mmu.get("blockers", [])
            ap_benchmarks = companion_reports.get("ap_benchmarks")
            if isinstance(ap_benchmarks, dict):
                record["ap_benchmarks_report"] = ap_benchmarks.get("path", "")
                record["ap_benchmarks_accepted_evidence"] = (
                    ap_benchmarks.get("accepted_evidence", {}).get("path", "")
                    if isinstance(ap_benchmarks.get("accepted_evidence"), dict)
                    else ""
                )
                record["ap_benchmarks_accepted_evidence_state"] = ap_benchmarks.get(
                    "accepted_evidence_state", ""
                )
                record["ap_benchmarks_blockers"] = ap_benchmarks.get("blockers", [])
                record["ap_benchmarks_required_linux_boot_evidence"] = ap_benchmarks.get(
                    "required_linux_boot_evidence", ""
                )
            if gate.get("next_actions"):
                record["next_actions"] = gate["next_actions"]
        elif name == "generated_ap_linux_boot":
            record.update(
                {
                    "required_accepted_transcript": gate.get("path", ""),
                    "observed_source": gate.get("observed_source", "none"),
                    "diagnostic_attempt_only": (
                        gate.get("observed_source") == "diagnostic_attempt_log"
                    ),
                    "readiness_state": gate.get("readiness_state", ""),
                    "accepted_transcript_present": gate.get(
                        "accepted_transcript_present", False
                    ),
                    "accepted_transcript_state": gate.get(
                        "accepted_transcript_state", ""
                    ),
                    "accepted_userland_npu_markers_complete": gate.get(
                        "accepted_userland_npu_markers_complete", False
                    ),
                    "attempt_userland_npu_markers_complete": gate.get(
                        "attempt_userland_npu_markers_complete", False
                    ),
                    "accepted_missing_userland_npu_markers": gate.get(
                        "accepted_missing_userland_npu_markers", []
                    ),
                    "accepted_forbidden_userland_npu_markers": gate.get(
                        "accepted_forbidden_userland_npu_markers", []
                    ),
                    "attempt_missing_userland_npu_markers": gate.get(
                        "attempt_missing_userland_npu_markers", []
                    ),
                    "attempt_forbidden_userland_npu_markers": gate.get(
                        "attempt_forbidden_userland_npu_markers", []
                    ),
                }
            )
        else:
            for field in (
                "missing_markers",
                "missing_command_tokens",
                "missing_files",
                "missing_tokens",
            ):
                if gate.get(field):
                    record[field] = gate[field]
        records.append(record)
    return records


def build_report() -> dict[str, Any]:
    doc_text = read(DOC)
    contract = load_json(CONTRACT)
    dts_text = read(LINUX_DTS)
    driver_text = read(LINUX_DRIVER)
    accepted_boot_text = read(ACCEPTED_LINUX_BOOT_EVIDENCE)
    boot_text = read(BOOT_LOG)
    boot_report = load_json(BOOT_REPORT)
    linux_check = run_linux_check()
    target_smoke = run_target_smoke_source_check()
    cpu_ap_transcript_bundle = run_cpu_ap_transcript_bundle_check()
    mlperf_inference_energy = run_mlperf_inference_energy_check()
    mvp = run_mvp_smoke()
    benchmark_gate = benchmark_command_gate(target_smoke)
    emulator_stack_gate = qemu_npu_emulator_stack_gate()
    generated_boot_gate = generated_ap_linux_boot_gate(
        accepted_boot_text,
        boot_text,
        boot_report,
        str(
            (cpu_ap_transcript_bundle.get("accepted_transcript_states") or {}).get(
                "linux_boot", "missing" if not ACCEPTED_LINUX_BOOT_EVIDENCE.is_file() else "accepted"
            )
        ),
    )
    gates = [
        linux_check,
        cpu_ap_transcript_bundle,
        target_smoke,
        {
            "name": "model_input",
            "status": "passed",
            "workload": WORKLOAD,
            "source": rel(RUNTIME),
            "expected_output": [[-44, 8], [139, -54]],
        },
        {
            "name": "runtime_abi",
            "status": "passed"
            if contract.get("schema") == "eliza.e1_npu_runtime_contract.v1"
            else "blocked",
            "contract": rel(CONTRACT),
            "device_path": DEVICE_PATH,
            "mmio_base": contract.get("mmio", {}).get("base"),
            "opcode": "GEMM_S8",
        },
        {
            "name": "linux_device_path",
            "status": "passed"
            if 'miscdev.name = "e1-npu"' in driver_text
            and "eliza,e1-npu" in driver_text
            and "npu@10020000" in dts_text
            else "blocked",
            "device_path": DEVICE_PATH,
            "driver": rel(LINUX_DRIVER),
            "dts": rel(LINUX_DTS),
        },
        cocotb_gate(),
        emulator_stack_gate,
        benchmark_gate,
        mlperf_inference_energy,
        {
            "name": "tflite_nnapi_proof_gate",
            "status": "passed" if NNAPI_PROOF.is_file() else "not_required",
            "proof": rel(NNAPI_PROOF),
            "note": "NNAPI/TFLite acceleration proof remains out of scope for the minimum Linux+NPU target",
        },
        generated_boot_gate,
        mvp,
    ]
    errors = [gate for gate in gates if gate.get("status") == "failed"]
    blockers = [gate for gate in gates if gate.get("status") == "blocked"]
    for token in ("/dev/e1-npu", "GEMM_S8", "input hash", "output hash", "CPU-only fallback"):
        if token not in doc_text:
            blockers.append({"name": "doc_required_terms", "missing": token, "status": "blocked"})
    remaining_blockers = remaining_blocker_records(blockers)
    blocking_summary = {
        "cpu_ap_transcript_bundle": {
            "status": cpu_ap_transcript_bundle.get("status"),
            "full_cpu_ap_checker_status": cpu_ap_transcript_bundle.get(
                "full_cpu_ap_checker_status", ""
            ),
            "report": rel(CPU_AP_STALE_EVIDENCE_REPORT),
            "missing_transcripts": cpu_ap_transcript_bundle.get("missing_transcripts", []),
            "stale_transcripts": cpu_ap_transcript_bundle.get("stale_transcripts", []),
            "findings": cpu_ap_transcript_bundle.get("findings", []),
            "accepted_transcript_states": cpu_ap_transcript_bundle.get(
                "accepted_transcript_states", {}
            ),
            "accepted_minimum_evidence_requirements": cpu_ap_transcript_bundle.get(
                "accepted_minimum_evidence_requirements", {}
            ),
            "accepted_minimum_evidence_blockers": cpu_ap_transcript_bundle.get(
                "accepted_minimum_evidence_blockers", {}
            ),
            "minimum_required_transcripts": cpu_ap_transcript_bundle.get(
                "minimum_required_transcripts", {}
            ),
            "minimum_missing_transcript_states": cpu_ap_transcript_bundle.get(
                "minimum_missing_transcript_states", {}
            ),
            "non_minimum_transcript_blockers": cpu_ap_transcript_bundle.get(
                "non_minimum_transcript_blockers", {}
            ),
            "companion_reports": {
                name: companion.get("path") or companion.get("diagnostic_report")
                for name, companion in (
                    cpu_ap_transcript_bundle.get("companion_reports") or {}
                ).items()
                if isinstance(companion, dict)
            },
            "companion_report_statuses": {
                name: companion.get("status") or companion.get("diagnostic_report_status")
                for name, companion in (
                    cpu_ap_transcript_bundle.get("companion_reports") or {}
                ).items()
                if isinstance(companion, dict)
            },
            "next_actions": cpu_ap_transcript_bundle.get("next_actions", {}),
        },
        "minimum_linux_kernel_target": {
            "status": linux_check.get("status"),
            "report": "build/reports/minimum-linux-kernel-target.json",
            "remaining_blockers": (linux_check.get("report") or {}).get("blockers", []),
            "note": (
                "kernel-target blockers are upstream prerequisites; generated-AP "
                "Linux/NPU transcript acceptance is tracked separately by "
                "generated_ap_linux_boot to avoid treating raw attempt logs as evidence"
            ),
        },
        "generated_ap_linux_boot": {
            "status": generated_boot_gate.get("status"),
            "required_evidence": rel(ACCEPTED_LINUX_BOOT_EVIDENCE),
            "attempt_log": rel(BOOT_LOG),
            "companion_report": rel(BOOT_REPORT),
            "companion_report_status": generated_boot_gate.get("companion_report_status", ""),
            "companion_report_progress": generated_boot_gate.get("companion_report_progress", {}),
            "companion_report_blockers": generated_boot_gate.get("companion_report_blockers", []),
            "companion_report_next_safe_action": generated_boot_gate.get(
                "companion_report_next_safe_action", ""
            ),
            "unblock_command": generated_boot_gate.get("unblock_command", ""),
            "readiness_state": generated_boot_gate.get("readiness_state", ""),
            "accepted_transcript_present": generated_boot_gate.get(
                "accepted_transcript_present", False
            ),
            "accepted_transcript_state": generated_boot_gate.get(
                "accepted_transcript_state", ""
            ),
            "accepted_userland_npu_markers_complete": generated_boot_gate.get(
                "accepted_userland_npu_markers_complete", False
            ),
            "attempt_userland_npu_markers_complete": generated_boot_gate.get(
                "attempt_userland_npu_markers_complete", False
            ),
            "claim_boundary": (
                "generated target readiness is reported from accepted Linux/userspace "
                "transcripts only; CPU/AP bundle completeness remains a separate blocker"
            ),
            "expected_opensbi_payload_fdt_addr": generated_boot_gate.get(
                "expected_opensbi_payload_fdt_addr", EXPECTED_OPENSBI_PAYLOAD_FDT_ADDR
            ),
            "expected_domain0_next_arg1": generated_boot_gate.get(
                "expected_domain0_next_arg1", EXPECTED_OPENSBI_DOMAIN0_NEXT_ARG1
            ),
            "companion_fdt_handoff": generated_boot_gate.get("companion_fdt_handoff", {}),
            "observed_markers": generated_boot_gate.get("observed_markers", {}),
            "missing_userland_npu_markers": generated_boot_gate.get(
                "missing_userland_npu_markers", []
            ),
            "forbidden_userland_npu_markers": generated_boot_gate.get(
                "forbidden_userland_npu_markers", []
            ),
        },
    }
    return {
        "schema": "eliza.minimum_linux_npu_target.v1",
        "status": "fail" if errors else ("blocked" if blockers else "pass"),
        "claim_boundary": "minimum Linux basic ML only; not Android NNAPI or phone-class performance",
        "integrated_linux_npu_ml_claim": not errors and not blockers,
        "benchmark_command": BENCHMARK_COMMAND,
        "blocking_summary": blocking_summary,
        "remaining_blockers": remaining_blockers,
        "gates": gates,
        "errors": errors,
        "blockers": blockers,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    report = build_report()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif report["status"] == "pass":
        print("STATUS: PASS minimum_linux_npu_target")
    elif report["status"] == "blocked":
        print("STATUS: BLOCKED minimum_linux_npu_target")
        print(f"  report: {rel(REPORT)}")
        for blocker in report["remaining_blockers"]:
            detail = blocker.get("blocker") or "; ".join(blocker.get("upstream_blockers", []))
            suffix = f": {detail}" if detail else ""
            print(f"  - {blocker['name']}{suffix}")
    else:
        print("STATUS: FAIL minimum_linux_npu_target")
        print(f"  report: {rel(REPORT)}")
        for error in report["errors"]:
            print(f"  - {error['name']}")
    if report["status"] == "fail":
        return 1
    if report["status"] == "blocked" and args.strict:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
