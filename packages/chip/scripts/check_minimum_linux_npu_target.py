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
CPU_AP_ISA_CACHE_MMU_REPORT = ROOT / "build/reports/cpu_ap_isa_cache_mmu_probe.json"
CPU_AP_BENCHMARK_REPORT = ROOT / "build/reports/cpu_ap_benchmark_runner_wiring.json"
NNAPI_PROOF = ROOT / "benchmarks/capabilities/e1_npu_nnapi.proof.json"
LINUX_NPU_SMOKE_EVIDENCE = ROOT / "docs/evidence/linux/eliza_e1_npu_ml_smoke.log"

DEVICE_PATH = "/dev/e1-npu"
WORKLOAD = "gemm_s8_int8_2x2x3"
BENCHMARK_COMMAND = [
    "e1-npu-ml-smoke",
    "--device",
    DEVICE_PATH,
    "--workload",
    WORKLOAD,
    "--require-npu",
]
GENERATED_AP_USERLAND_NPU_MARKERS = (
    "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke",
    "Linux early console",
    "generated DTS hash",
    "memory node",
    "CPU node",
    "timer node",
    "interrupt-controller node",
    "UART node",
    "chosen stdout",
    "Linux CONFIG_MMU",
    "initramfs start",
    "e1 MMIO smoke result: PASS",
    "e1-npu-ml-smoke: PASS",
    "workload=gemm_s8_int8_2x2x3",
    "--require-npu",
    "device=/dev/e1-npu",
    "require_npu=true",
    "CPU fallback percent=0",
    "eliza-evidence: status=PASS",
)
GENERATED_AP_FORBIDDEN_NPU_MARKERS = (
    "device=/dev/mem generated-mmio",
    "CPU-only fallback",
    "cpu_fallback_percent=100",
    "require_npu=false",
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
    opensbi_evidence_state = cpu_ap_transcript_state(report, ACCEPTED_OPENSBI_BOOT_EVIDENCE)
    opensbi_regeneration_report = load_json(CPU_AP_OPENSBI_BOOT_REPORT)
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
            "report": load_json(CPU_AP_ISA_CACHE_MMU_REPORT),
        },
        "ap_benchmarks": {
            "path": rel(CPU_AP_BENCHMARK_REPORT),
            "report": load_json(CPU_AP_BENCHMARK_REPORT),
        },
    }
    status = "passed" if completed.returncode == 0 else "blocked"
    gate: dict[str, Any] = {
        "name": "cpu_ap_transcript_bundle",
        "status": status,
        "command": completed.args,
        "stdout": completed.stdout,
        "report": rel(CPU_AP_STALE_EVIDENCE_REPORT),
        "report_status": report.get("status", ""),
        "missing_transcripts": report.get("missing_transcripts", []),
        "stale_transcripts": report.get("stale_transcripts", []),
        "findings": report.get("findings", []),
        "companion_reports": companion_reports,
        "accepted_transcript_states": {
            "opensbi_boot": opensbi_evidence_state,
            "linux_boot": cpu_ap_transcript_state(report, ACCEPTED_LINUX_BOOT_EVIDENCE),
            "isa_cache_mmu": cpu_ap_transcript_state(
                report, ROOT / "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log"
            ),
            "ap_benchmarks": cpu_ap_transcript_state(
                report, ROOT / "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log"
            ),
        },
        "claim_boundary": (
            "imports CPU/AP transcript intake blockers as prerequisites for the "
            "minimum Linux+NPU target; companion reports remain diagnostic and do "
            "not satisfy this gate without accepted CPU/AP evidence transcripts"
        ),
    }
    if status != "passed":
        gate["blocker"] = (
            "CPU/AP transcript bundle is incomplete or stale; regenerate real "
            "generated-AP evidence and archive it through capture_cpu_ap_evidence.py"
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
    passed = (
        target_smoke.get("status") == "passed"
        and evidence_path.is_file()
        and not missing_markers
        and not missing_command_tokens
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
    if not passed:
        gate["blocker"] = (
            "target-side e1-npu-ml-smoke transcript lacks required command/PASS markers"
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
    accepted_boot_text: str, attempt_text: str, boot_report: dict[str, Any]
) -> dict[str, Any]:
    observed_text = accepted_boot_text or attempt_text
    early_boot_markers_present = "Linux version" in observed_text and (
        "OpenSBI" in observed_text or "SBI specification" in observed_text
    )
    missing_userland_npu_markers = [
        marker for marker in GENERATED_AP_USERLAND_NPU_MARKERS if marker not in observed_text
    ]
    forbidden_userland_npu_markers = [
        marker for marker in GENERATED_AP_FORBIDDEN_NPU_MARKERS if marker in observed_text
    ]
    accepted_evidence_present = ACCEPTED_LINUX_BOOT_EVIDENCE.is_file()
    generated_ap_linux_boot_passed = (
        accepted_evidence_present
        and not missing_userland_npu_markers
        and not forbidden_userland_npu_markers
    )
    gate: dict[str, Any] = {
        "name": "generated_ap_linux_boot",
        "status": "passed" if generated_ap_linux_boot_passed else "blocked",
        "path": rel(ACCEPTED_LINUX_BOOT_EVIDENCE),
        "evidence": artifact(ACCEPTED_LINUX_BOOT_EVIDENCE),
        "attempt_log": artifact(BOOT_LOG),
        "companion_report": rel(BOOT_REPORT),
        "companion_report_status": boot_report.get("status", ""),
        "acceptance_basis": (
            "accepted_cpu_ap_linux_boot_transcript_with_userland_npu_mmio_markers"
            if generated_ap_linux_boot_passed
            else ""
        ),
        "required_markers": list(GENERATED_AP_USERLAND_NPU_MARKERS),
        "forbidden_markers": list(GENERATED_AP_FORBIDDEN_NPU_MARKERS),
        "missing_userland_npu_markers": missing_userland_npu_markers,
        "forbidden_userland_npu_markers": forbidden_userland_npu_markers,
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
            "eval \"$(python3 scripts/wire_cpu_ap_capture_commands.py --format shell)\" "
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
                "bootrom_to_payload_handoff": instruction_trace.get(
                    "bootrom_to_payload_handoff"
                ),
                "first_payload_pc": instruction_trace.get("first_payload_pc"),
                "last_pc": instruction_trace.get("last_pc"),
                "last_symbol": instruction_trace.get("last_symbol"),
                "retired_instruction_count": instruction_trace.get(
                    "retired_instruction_count"
                ),
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
        elif missing_userland_npu_markers or forbidden_userland_npu_markers:
            gate["blocker"] = (
                "accepted generated-AP transcript lacks required FireMarshal /dev/e1-npu "
                "zero-fallback PASS markers or contains forbidden fallback markers"
            )
    return gate


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
        accepted_boot_text, boot_text, boot_report
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
    blocking_summary = {
        "cpu_ap_transcript_bundle": {
            "status": cpu_ap_transcript_bundle.get("status"),
            "report": rel(CPU_AP_STALE_EVIDENCE_REPORT),
            "missing_transcripts": cpu_ap_transcript_bundle.get("missing_transcripts", []),
            "stale_transcripts": cpu_ap_transcript_bundle.get("stale_transcripts", []),
            "findings": cpu_ap_transcript_bundle.get("findings", []),
            "accepted_transcript_states": cpu_ap_transcript_bundle.get(
                "accepted_transcript_states", {}
            ),
            "companion_reports": {
                name: companion.get("path") or companion.get("diagnostic_report")
                for name, companion in (
                    cpu_ap_transcript_bundle.get("companion_reports") or {}
                ).items()
                if isinstance(companion, dict)
            },
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
            "companion_report_progress": generated_boot_gate.get(
                "companion_report_progress", {}
            ),
            "companion_report_blockers": generated_boot_gate.get(
                "companion_report_blockers", []
            ),
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
        for blocker in report["blockers"]:
            print(f"  - {blocker['name']}")
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
