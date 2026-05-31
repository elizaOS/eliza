#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_minimum_linux_npu_target.py"


def load_check_module():
    spec = importlib.util.spec_from_file_location("check_minimum_linux_npu_target", CHECK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MinimumLinuxNpuTargetTest(unittest.TestCase):
    def run_json(self) -> dict:
        completed = subprocess.run(
            [sys.executable, "scripts/check_minimum_linux_npu_target.py", "--json"],
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout)
        return json.loads(completed.stdout)

    def test_gate_reports_concrete_minimum_target_surfaces(self):
        report = self.run_json()
        self.assertEqual(report["schema"], "eliza.minimum_linux_npu_target.v1")
        self.assertRegex(report["generated_utc"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertNotIn("/home/", json.dumps(report))
        self.assertNotIn("/tmp/", json.dumps(report))
        self.assertIn(report["status"], {"blocked", "pass"})
        self.assertEqual(report["integrated_linux_npu_ml_claim"], report["status"] == "pass")
        for claim_key in (
            "phone_class_performance_claim_allowed",
            "release_claim_allowed",
            "android_boot_claim_allowed",
            "android_nnapi_claim_allowed",
            "sustained_performance_claim_allowed",
            "silicon_claim_allowed",
            "production_readiness_claim_allowed",
        ):
            self.assertIs(report[claim_key], False, claim_key)
        self.assertIn("remaining_blockers", report)
        names = {gate["name"] for gate in report["gates"]}
        for required in (
            "cpu_ap_transcript_bundle",
            "model_input",
            "runtime_abi",
            "linux_device_path",
            "rtl_cocotb_proof",
            "qemu_npu_emulator_stack",
            "benchmark_command",
            "modeled_mlperf_inference_energy_gate",
            "tflite_nnapi_proof_gate",
            "generated_ap_linux_boot",
            "local_npu_ml_smoke",
        ):
            self.assertIn(required, names)
        self.assertEqual(report["benchmark_command"][0], "e1-npu-ml-smoke")
        self.assertIn("/dev/e1-npu", report["benchmark_command"])
        self.assertIn("--workload", report["benchmark_command"])
        self.assertIn("gemm_s8_int8_2x2x3", report["benchmark_command"])
        self.assertIn("--require-npu", report["benchmark_command"])
        benchmark_gate = next(
            gate for gate in report["gates"] if gate["name"] == "benchmark_command"
        )
        target_smoke = next(
            gate for gate in report["gates"] if gate["name"] == "target_side_npu_ml_smoke"
        )
        if target_smoke["status"] == "passed":
            self.assertEqual(benchmark_gate["status"], "passed")
            self.assertEqual(
                benchmark_gate["evidence"]["path"],
                "docs/evidence/linux/eliza_e1_npu_ml_smoke.log",
            )
            blocker_names = {gate["name"] for gate in report["blockers"]}
            self.assertNotIn("benchmark_command", blocker_names)
        capture_commands = target_smoke["report"]["capture_commands"]
        self.assertIn("--workload gemm_s8_int8_2x2x3", capture_commands["target_smoke"])
        self.assertIn("--require-npu", capture_commands["target_smoke"])
        self.assertIn(
            "sw/linux/scripts/capture-linux-bsp-evidence.sh /path/to/linux ml-smoke",
            capture_commands["capture_wrapper"],
        )
        mlperf_energy = next(
            gate
            for gate in report["gates"]
            if gate["name"] == "modeled_mlperf_inference_energy_gate"
        )
        self.assertEqual(mlperf_energy["status"], "passed")
        self.assertIn("measured silicon power stays BLOCKED", mlperf_energy["stdout"])
        emulator_stack = next(
            gate for gate in report["gates"] if gate["name"] == "qemu_npu_emulator_stack"
        )
        self.assertEqual(emulator_stack["status"], "passed")
        self.assertEqual(emulator_stack["required_machine_arg"], "-M virt,e1-npu=on")
        self.assertEqual(emulator_stack["required_guest_device"], "/dev/e1-npu")
        self.assertIn(
            "functional qemu-system-riscv64 e1-npu MMIO", emulator_stack["claim_boundary"]
        )
        self.assertEqual(
            emulator_stack["model"]["path"],
            "sw/qemu/qemu-device/eliza_e1_npu.c",
        )
        generated_boot = next(
            gate for gate in report["gates"] if gate["name"] == "generated_ap_linux_boot"
        )
        self.assertEqual(
            generated_boot["path"],
            "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        )
        self.assertEqual(
            generated_boot["attempt_log"]["path"],
            "build/chipyard/eliza_rocket/verilator-linux-smoke.log",
        )
        self.assertEqual(
            generated_boot["expected_opensbi_payload_fdt_addr"],
            "0x80b00000",
        )
        self.assertEqual(
            generated_boot["expected_domain0_next_arg1"],
            "0x0000000080b00000",
        )
        self.assertIn(
            generated_boot["readiness_state"],
            {
                "accepted_linux_userspace_npu_transcript",
                "diagnostic_attempt_has_linux_userspace_npu_markers",
                "accepted_transcript_missing",
                "accepted_transcript_incomplete_or_fallback",
                "accepted_transcript_stale",
            },
        )
        self.assertIn("accepted_transcript_present", generated_boot)
        self.assertIn("accepted_transcript_state", generated_boot)
        self.assertIn("accepted_userland_npu_markers_complete", generated_boot)
        self.assertIn("attempt_userland_npu_markers_complete", generated_boot)
        fdt_handoff = generated_boot["companion_fdt_handoff"]
        self.assertEqual(
            fdt_handoff["expected_opensbi_payload_fdt_addr"],
            "0x80b00000",
        )
        self.assertEqual(
            fdt_handoff["expected_domain0_next_arg1"],
            "0x0000000080b00000",
        )
        self.assertIn("generated_fdt_audit", fdt_handoff)
        self.assertIn("opensbi_fdt_handoff_audit", fdt_handoff)
        self.assertIn(
            "capture_chipyard_linux_evidence.sh linux-boot", generated_boot["unblock_command"]
        )
        cpu_ap_bundle = next(
            gate for gate in report["gates"] if gate["name"] == "cpu_ap_transcript_bundle"
        )
        self.assertEqual(
            cpu_ap_bundle["report"],
            "build/reports/cpu_ap_stale_evidence.json",
        )
        self.assertIn("minimum_required_transcripts", cpu_ap_bundle)
        self.assertIn("minimum_missing_transcript_states", cpu_ap_bundle)
        self.assertIn("non_minimum_transcript_blockers", cpu_ap_bundle)
        companion_reports = cpu_ap_bundle["companion_reports"]
        self.assertEqual(
            companion_reports["opensbi_boot"]["diagnostic_report"],
            "build/reports/cpu_ap_opensbi_boot_regeneration_blocked.json",
        )
        self.assertEqual(
            companion_reports["opensbi_boot"]["accepted_evidence"]["path"],
            "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log",
        )
        self.assertIn(
            companion_reports["opensbi_boot"]["accepted_evidence_state"],
            {"accepted", "missing", "stale"},
        )
        self.assertTrue(companion_reports["opensbi_boot"]["diagnostic_report_only"])
        self.assertEqual(
            companion_reports["isa_cache_mmu"]["path"],
            "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json",
        )
        self.assertEqual(
            companion_reports["isa_cache_mmu"]["accepted_evidence"]["path"],
            "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
        )
        self.assertIn(
            companion_reports["isa_cache_mmu"]["accepted_evidence_state"],
            {"accepted", "missing", "stale"},
        )
        self.assertIn(
            companion_reports["isa_cache_mmu"]["loaded_report"],
            {
                "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json",
                "build/reports/cpu_ap_isa_cache_mmu_probe.json",
            },
        )
        self.assertEqual(
            companion_reports["isa_cache_mmu"]["legacy_report"],
            "build/reports/cpu_ap_isa_cache_mmu_probe.json",
        )
        self.assertEqual(
            companion_reports["isa_cache_mmu"]["required_linux_userspace_hwprobe_marker"],
            "riscv_hwprobe: syscall rc=0",
        )
        self.assertEqual(
            companion_reports["ap_benchmarks"]["path"],
            "build/reports/cpu_ap_benchmark_runner_wiring.json",
        )
        self.assertEqual(
            companion_reports["ap_benchmarks"]["accepted_evidence"]["path"],
            "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
        )
        self.assertIn(
            companion_reports["ap_benchmarks"]["accepted_evidence_state"],
            {"accepted", "missing", "stale"},
        )
        self.assertEqual(
            companion_reports["ap_benchmarks"]["required_linux_boot_evidence"],
            "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        )
        if cpu_ap_bundle["status"] == "blocked":
            cpu_ap_remaining = next(
                item
                for item in report["remaining_blockers"]
                if item["name"] == "cpu_ap_transcript_bundle"
            )
            self.assertIn("full_cpu_ap_checker_status", cpu_ap_remaining)
            self.assertIn("accepted_transcript_states", cpu_ap_remaining)
            self.assertIn("accepted_minimum_evidence_requirements", cpu_ap_remaining)
            self.assertIn("accepted_minimum_evidence_blockers", cpu_ap_remaining)
            self.assertIn("minimum_required_transcripts", cpu_ap_remaining)
            self.assertIn("minimum_missing_transcript_states", cpu_ap_remaining)
            self.assertIn("non_minimum_transcript_blockers", cpu_ap_remaining)
            self.assertIn("missing_transcripts", cpu_ap_remaining)
            self.assertEqual(
                cpu_ap_remaining["isa_cache_mmu_report"],
                "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json",
            )
            self.assertEqual(
                cpu_ap_remaining["required_linux_userspace_hwprobe_marker"],
                "riscv_hwprobe: syscall rc=0",
            )
            self.assertIn("isa_cache_mmu_missing_hwprobe_markers", cpu_ap_remaining)
            self.assertEqual(
                cpu_ap_remaining["ap_benchmarks_required_linux_boot_evidence"],
                "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
            )
            self.assertIn("next_actions", cpu_ap_remaining)
            self.assertIn("linux_boot", cpu_ap_remaining["next_actions"])
            self.assertIn(
                "build/reports/cpu_ap_opensbi_boot_regeneration_blocked.json",
                cpu_ap_remaining["diagnostic_reports_only"],
            )
            bundle_evidence = {
                finding["evidence"]
                for finding in cpu_ap_bundle["findings"]
                if isinstance(finding, dict) and "evidence" in finding
            }
            if cpu_ap_bundle["accepted_transcript_states"]["opensbi_boot"] == "accepted":
                self.assertNotIn(
                    "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log",
                    bundle_evidence,
                )
                self.assertTrue(
                    companion_reports["opensbi_boot"][
                        "diagnostic_report_superseded_by_accepted_evidence"
                    ]
                )
            else:
                self.assertIn(
                    "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log",
                    bundle_evidence,
                )
            self.assertIn(
                "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
                bundle_evidence,
            )
            self.assertIn(
                "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
                bundle_evidence,
            )
            self.assertIn(
                "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
                bundle_evidence,
            )
            self.assertIn("blocker", cpu_ap_bundle)
        bundle_summary = report["blocking_summary"]["cpu_ap_transcript_bundle"]
        self.assertEqual(
            bundle_summary["report"],
            "build/reports/cpu_ap_stale_evidence.json",
        )
        self.assertEqual(
            bundle_summary["companion_reports"]["opensbi_boot"],
            "build/reports/cpu_ap_opensbi_boot_regeneration_blocked.json",
        )
        self.assertIn("accepted_transcript_states", bundle_summary)
        self.assertIn("accepted_minimum_evidence_requirements", bundle_summary)
        self.assertIn("accepted_minimum_evidence_blockers", bundle_summary)
        self.assertIn("full_cpu_ap_checker_status", bundle_summary)
        self.assertIn("minimum_required_transcripts", bundle_summary)
        self.assertIn("minimum_missing_transcript_states", bundle_summary)
        self.assertIn("non_minimum_transcript_blockers", bundle_summary)
        self.assertIn(
            bundle_summary["accepted_transcript_states"]["opensbi_boot"],
            {"accepted", "missing", "stale"},
        )
        self.assertEqual(
            bundle_summary["companion_reports"]["isa_cache_mmu"],
            "build/evidence/cpu_ap/cpu_ap_isa_cache_mmu_probe.json",
        )
        self.assertEqual(
            bundle_summary["companion_reports"]["ap_benchmarks"],
            "build/reports/cpu_ap_benchmark_runner_wiring.json",
        )
        self.assertIn("companion_report_statuses", bundle_summary)
        self.assertIn("next_actions", bundle_summary)
        summary = report["blocking_summary"]["generated_ap_linux_boot"]
        self.assertEqual(
            summary["required_evidence"],
            "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        )
        self.assertEqual(
            summary["companion_report"],
            "build/chipyard/eliza_rocket/verilator-linux-smoke.json",
        )
        self.assertIn("companion_report_progress", summary)
        self.assertEqual(summary["expected_opensbi_payload_fdt_addr"], "0x80b00000")
        self.assertEqual(summary["expected_domain0_next_arg1"], "0x0000000080b00000")
        self.assertEqual(
            summary["companion_fdt_handoff"]["expected_opensbi_payload_fdt_addr"],
            "0x80b00000",
        )
        self.assertIn(
            summary["readiness_state"],
            {
                "accepted_linux_userspace_npu_transcript",
                "diagnostic_attempt_has_linux_userspace_npu_markers",
                "accepted_transcript_missing",
                "accepted_transcript_incomplete_or_fallback",
                "accepted_transcript_stale",
            },
        )
        self.assertIn("accepted_transcript_present", summary)
        self.assertIn("accepted_transcript_state", summary)
        self.assertIn("accepted_userland_npu_markers_complete", summary)
        self.assertIn("attempt_userland_npu_markers_complete", summary)
        self.assertIn(
            "CPU/AP bundle completeness remains a separate blocker",
            summary["claim_boundary"],
        )
        self.assertIn("observed_markers", summary)
        if generated_boot["status"] == "blocked":
            generated_remaining = next(
                item
                for item in report["remaining_blockers"]
                if item["name"] == "generated_ap_linux_boot"
            )
            self.assertEqual(
                generated_remaining["required_accepted_transcript"],
                "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
            )
            self.assertEqual(
                generated_remaining["diagnostic_attempt_only"],
                generated_boot["observed_source"] == "diagnostic_attempt_log",
            )
            self.assertEqual(
                generated_remaining["accepted_transcript_present"],
                generated_boot["accepted_transcript_present"],
            )
            self.assertIn("accepted_missing_userland_npu_markers", generated_remaining)
            self.assertIn("attempt_missing_userland_npu_markers", generated_remaining)
            self.assertIn("claim_boundary", generated_boot)
            self.assertIn("missing_userland_npu_markers", generated_boot)
            self.assertIn("accepted_missing_userland_npu_markers", generated_boot)
            self.assertIn("accepted_forbidden_userland_npu_markers", generated_boot)
            self.assertIn("e1 MMIO smoke result: PASS", generated_boot["required_markers"])
            self.assertIn("e1-npu-ml-smoke: PASS", generated_boot["required_markers"])
            self.assertIn("device=/dev/e1-npu", generated_boot["required_markers"])
            self.assertIn("CPU fallback percent=0", generated_boot["required_markers"])
            self.assertIn("device=/dev/mem", generated_boot["forbidden_markers"])
            self.assertIn("device=/dev/mem generated-mmio", generated_boot["forbidden_markers"])
            self.assertIn("devmem-only", generated_boot["forbidden_markers"])
            self.assertIn("CPU fallback percent=100", generated_boot["forbidden_markers"])
            self.assertIn("forbidden_userland_npu_markers", generated_boot)
            self.assertIn("initramfs start", generated_boot["observed_markers"])
            self.assertIn("device=/dev/e1-npu", generated_boot["observed_markers"])
            active_attempt = generated_boot.get("companion_report_active_smoke_attempt")
            if isinstance(active_attempt, dict):
                self.assertIn(
                    active_attempt["stage"],
                    {
                        "simulator_rebuild_in_progress",
                        "chipyard_generation_in_progress",
                        "chipyard_sbt_assembly_in_progress",
                        "simulator_runtime_in_progress",
                        "wrapper_command_in_progress",
                        "wrapper_waiting_for_output",
                    },
                )
                self.assertIn("reached_simulator_runtime", active_attempt)
            self.assertIn("companion_report_next_safe_action", generated_boot)
            instruction_trace = generated_boot.get("companion_report_instruction_trace")
            if isinstance(instruction_trace, dict):
                self.assertIn("fresh_for_log", instruction_trace)
                self.assertIn("bootrom_to_payload_handoff", instruction_trace)
                if instruction_trace.get("bootrom_to_payload_handoff"):
                    self.assertEqual(
                        instruction_trace.get("first_payload_pc"),
                        "0x0000000080000000",
                    )
                    self.assertIn("retired_instruction_count", instruction_trace)

    def test_generated_ap_gate_rejects_devmem_fallback_transcript(self):
        module = load_check_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            accepted = Path(temp_dir) / "eliza_e1_linux_boot.log"
            accepted.write_text(
                "\n".join(
                    [
                        "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke",
                        "Kernel command line: console=ttySIF0",
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
                        "riscv_hwprobe: syscall rc=0 pair_count=6",
                        "e1 MMIO smoke result: PASS",
                        "e1-npu-ml-smoke: PASS",
                        "workload=gemm_s8_int8_2x2x3",
                        "--require-npu",
                        "device=/dev/e1-npu",
                        "require_npu=true",
                        "CPU fallback percent=0",
                        "device=/dev/mem generated-mmio",
                        "eliza-evidence: status=PASS",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            module.ACCEPTED_LINUX_BOOT_EVIDENCE = accepted
            gate = module.generated_ap_linux_boot_gate(
                accepted.read_text(encoding="utf-8"),
                "",
                {"status": "pass"},
            )
        self.assertEqual(gate["status"], "blocked")
        self.assertIn("device=/dev/mem generated-mmio", gate["forbidden_userland_npu_markers"])
        self.assertIn(
            "device=/dev/mem generated-mmio",
            gate["accepted_forbidden_userland_npu_markers"],
        )
        self.assertEqual(gate["readiness_state"], "accepted_transcript_incomplete_or_fallback")
        self.assertIn("forbidden fallback markers", gate["blocker"])

    def test_generated_ap_gate_rejects_nonzero_cpu_fallback_transcript(self):
        module = load_check_module()
        original_accepted = module.ACCEPTED_LINUX_BOOT_EVIDENCE
        with tempfile.TemporaryDirectory() as temp_dir:
            accepted = Path(temp_dir) / "eliza_e1_linux_boot.log"
            accepted.write_text(
                "\n".join(
                    [
                        "eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot",
                        "OpenSBI v1.5",
                        "Linux version 6.6.0",
                        "Kernel command line: console=ttySIF0",
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
                        "riscv_hwprobe: syscall rc=0 pair_count=6",
                        "e1 MMIO smoke result: PASS",
                        "e1-npu-ml-smoke: PASS",
                        "workload=gemm_s8_int8_2x2x3",
                        "--require-npu",
                        "device=/dev/e1-npu",
                        "require_npu=true",
                        "CPU fallback percent=0",
                        "CPU fallback percent=100",
                        "eliza-evidence: status=PASS",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            module.ACCEPTED_LINUX_BOOT_EVIDENCE = accepted
            gate = module.generated_ap_linux_boot_gate(
                accepted.read_text(encoding="utf-8"),
                "",
                {"status": "pass"},
            )
        module.ACCEPTED_LINUX_BOOT_EVIDENCE = original_accepted
        self.assertEqual(gate["status"], "blocked")
        self.assertEqual(gate["readiness_state"], "accepted_transcript_incomplete_or_fallback")
        self.assertIn("CPU fallback percent=100", gate["accepted_forbidden_userland_npu_markers"])
        self.assertFalse(gate["accepted_userland_npu_markers_complete"])

    def test_generated_ap_gate_does_not_accept_attempt_log_without_archived_transcript(self):
        module = load_check_module()
        original_accepted = module.ACCEPTED_LINUX_BOOT_EVIDENCE
        with tempfile.TemporaryDirectory() as temp_dir:
            missing_accepted = Path(temp_dir) / "missing-linux-boot.log"
            attempt_text = "\n".join(
                [
                    "OpenSBI v1.5",
                    "Linux version 6.6.0",
                    "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke",
                    "Kernel command line: console=ttySIF0",
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
                    "riscv_hwprobe: syscall rc=0 pair_count=6",
                    "e1 MMIO smoke result: PASS",
                    "e1-npu-ml-smoke: PASS",
                    "workload=gemm_s8_int8_2x2x3",
                    "--require-npu",
                    "device=/dev/e1-npu",
                    "require_npu=true",
                    "CPU fallback percent=0",
                    "eliza-evidence: status=PASS",
                ]
            )
            module.ACCEPTED_LINUX_BOOT_EVIDENCE = missing_accepted
            gate = module.generated_ap_linux_boot_gate("", attempt_text, {"status": "pass"})
        module.ACCEPTED_LINUX_BOOT_EVIDENCE = original_accepted
        self.assertEqual(gate["status"], "blocked")
        self.assertEqual(
            gate["readiness_state"],
            "diagnostic_attempt_has_linux_userspace_npu_markers",
        )
        self.assertTrue(gate["attempt_userland_npu_markers_complete"])
        self.assertFalse(gate["accepted_transcript_present"])
        self.assertFalse(gate["accepted_userland_npu_markers_complete"])
        self.assertEqual(gate["acceptance_basis"], "")
        self.assertIn("raw simulator attempt logs", gate["claim_boundary"])
        remaining = module.remaining_blocker_records([gate])
        self.assertEqual(remaining[0]["required_accepted_transcript"], str(missing_accepted))
        self.assertTrue(remaining[0]["diagnostic_attempt_only"])
        self.assertTrue(remaining[0]["attempt_userland_npu_markers_complete"])
        self.assertFalse(remaining[0]["accepted_transcript_present"])

    def test_generated_ap_gate_accepts_archived_cpu_ap_linux_boot_marker(self):
        module = load_check_module()
        original_accepted = module.ACCEPTED_LINUX_BOOT_EVIDENCE
        with tempfile.TemporaryDirectory() as temp_dir:
            accepted = Path(temp_dir) / "eliza_e1_linux_boot.log"
            accepted.write_text(
                "\n".join(
                    [
                        "eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot",
                        "OpenSBI v1.5",
                        "Linux version 6.6.0",
                        "Kernel command line: console=ttySIF0",
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
                        "riscv_hwprobe: syscall rc=0 pair_count=6",
                        "e1 MMIO smoke result: PASS",
                        "e1-npu-ml-smoke: PASS",
                        "workload=gemm_s8_int8_2x2x3",
                        "--require-npu",
                        "device=/dev/e1-npu",
                        "require_npu=true",
                        "CPU fallback percent=0",
                        "eliza-evidence: status=PASS",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            module.ACCEPTED_LINUX_BOOT_EVIDENCE = accepted
            gate = module.generated_ap_linux_boot_gate(
                accepted.read_text(encoding="utf-8"),
                "",
                {"status": "pass"},
            )
        module.ACCEPTED_LINUX_BOOT_EVIDENCE = original_accepted
        self.assertEqual(gate["status"], "passed")
        self.assertEqual(gate["readiness_state"], "accepted_linux_userspace_npu_transcript")
        self.assertTrue(gate["accepted_userland_npu_markers_complete"])
        self.assertEqual(gate["accepted_missing_userland_npu_markers"], [])
        self.assertEqual(
            gate["acceptance_basis"],
            "accepted_cpu_ap_linux_boot_transcript_with_userland_npu_mmio_markers",
        )

    def test_generated_ap_gate_rejects_stale_archived_transcript(self):
        module = load_check_module()
        original_accepted = module.ACCEPTED_LINUX_BOOT_EVIDENCE
        with tempfile.TemporaryDirectory() as temp_dir:
            accepted = Path(temp_dir) / "eliza_e1_linux_boot.log"
            accepted.write_text(
                "\n".join(
                    [
                        "eliza-evidence: target=cpu_ap artifact=eliza_e1_linux_boot",
                        "OpenSBI v1.5",
                        "Linux version 6.6.0",
                        "Kernel command line: console=ttySIF0",
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
                        "riscv_hwprobe: syscall rc=0 pair_count=6",
                        "e1 MMIO smoke result: PASS",
                        "e1-npu-ml-smoke: PASS",
                        "workload=gemm_s8_int8_2x2x3",
                        "--require-npu",
                        "device=/dev/e1-npu",
                        "require_npu=true",
                        "CPU fallback percent=0",
                        "eliza-evidence: status=PASS",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            module.ACCEPTED_LINUX_BOOT_EVIDENCE = accepted
            gate = module.generated_ap_linux_boot_gate(
                accepted.read_text(encoding="utf-8"),
                "",
                {"status": "pass"},
                accepted_transcript_state="stale",
            )
        module.ACCEPTED_LINUX_BOOT_EVIDENCE = original_accepted
        self.assertEqual(gate["status"], "blocked")
        self.assertEqual(gate["readiness_state"], "accepted_transcript_stale")
        self.assertEqual(gate["accepted_transcript_state"], "stale")
        self.assertFalse(gate["accepted_userland_npu_markers_complete"])
        self.assertIn("marked stale", gate["blocker"])

    def test_fdt_handoff_contract_reports_expected_low_fdt_without_evidence_substitution(self):
        module = load_check_module()
        contract = module.fdt_handoff_contract(
            {
                "generated_fdt_audit": {
                    "path": "build/chipyard/eliza_rocket/generated-src/current.dts",
                    "exists": True,
                    "dtc_status": "pass",
                    "expected_opensbi_payload_fdt_addr": "0x87000000",
                    "expected_opensbi_payload_fdt_addr_fits_dram": True,
                    "expected_opensbi_payload_fdt_addr_clear_of_kernel_low_window": True,
                },
                "opensbi_fdt_handoff_audit": {
                    "observed": True,
                    "domain0_next_arg1": "0x0000000088000000",
                    "expected_domain0_next_arg1": "0x0000000087000000",
                    "domain0_next_arg1_matches_expected": False,
                    "domain0_next_arg1_clear_of_kernel_low_window": True,
                },
                "fdt_handoff_diagnosis": {
                    "generated_dtb_plausible": True,
                    "last_symbol": "fdt_offset_ptr",
                },
            }
        )
        self.assertEqual(contract["expected_opensbi_payload_fdt_addr"], "0x80b00000")
        self.assertEqual(contract["expected_domain0_next_arg1"], "0x0000000080b00000")
        self.assertEqual(contract["observed_domain0_next_arg1"], "0x0000000088000000")
        self.assertIs(contract["domain0_next_arg1_matches_expected"], False)
        self.assertEqual(
            contract["generated_fdt_audit"]["expected_opensbi_payload_fdt_addr"],
            "0x80b00000",
        )
        self.assertIs(
            contract["generated_fdt_audit"][
                "expected_opensbi_payload_fdt_addr_clear_of_kernel_low_window"
            ],
            False,
        )
        self.assertEqual(
            contract["opensbi_fdt_handoff_audit"]["expected_domain0_next_arg1"],
            "0x0000000080b00000",
        )
        self.assertIs(
            contract["opensbi_fdt_handoff_audit"][
                "domain0_next_arg1_clear_of_kernel_low_window"
            ],
            False,
        )
        self.assertIn("diagnostic", contract["claim_boundary"])

    def test_fdt_handoff_contract_recomputes_matches_against_low_fdt(self):
        module = load_check_module()
        contract = module.fdt_handoff_contract(
            {
                "opensbi_fdt_handoff_audit": {
                    "observed": True,
                    "domain0_next_arg1": "0x0000000080b00000",
                    "expected_domain0_next_arg1": "0x0000000087000000",
                    "domain0_next_arg1_matches_expected": False,
                },
            }
        )
        self.assertEqual(contract["observed_domain0_next_arg1"], "0x0000000080b00000")
        self.assertIs(contract["domain0_next_arg1_matches_expected"], True)
        self.assertIs(
            contract["opensbi_fdt_handoff_audit"]["domain0_next_arg1_matches_expected"],
            True,
        )

    def test_minimum_cpu_ap_subset_passes_with_only_non_minimum_stale_blocker(self):
        module = load_check_module()
        ready, missing = module.minimum_cpu_ap_subset_ready(
            completed_returncode=1,
            stdout=(
                "STATUS: BLOCKED cpu_ap.linux_evidence - stale generated-manifest-bound "
                "evidence must be regenerated"
            ),
            report={
                "status": "blocked",
                "missing_transcripts": [],
                "stale_transcripts": [
                    {
                        "transcript": "build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log",
                        "mode": "trap-timer-irq",
                    }
                ],
            },
            states={
                "opensbi_boot": "accepted",
                "linux_boot": "accepted",
                "isa_cache_mmu": "accepted",
                "ap_benchmarks": "accepted",
            },
        )
        self.assertTrue(ready)
        self.assertEqual(missing, {})

    def test_minimum_cpu_ap_subset_blocks_missing_linux_isa_or_ap(self):
        module = load_check_module()
        ready, missing = module.minimum_cpu_ap_subset_ready(
            completed_returncode=1,
            stdout=(
                "STATUS: BLOCKED cpu_ap.linux_evidence - missing production boot/trap evidence"
            ),
            report={
                "status": "blocked",
                "missing_transcripts": [
                    "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
                    "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
                    "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
                ],
                "stale_transcripts": [],
            },
            states={
                "opensbi_boot": "accepted",
                "linux_boot": "missing",
                "isa_cache_mmu": "missing",
                "ap_benchmarks": "missing",
            },
        )
        self.assertFalse(ready)
        self.assertEqual(
            missing,
            {
                "linux_boot": "missing",
                "isa_cache_mmu": "missing",
                "ap_benchmarks": "missing",
            },
        )

    def test_minimum_cpu_ap_evidence_requirements_report_stale_ap_and_isa(self):
        module = load_check_module()
        requirements, missing = module.minimum_cpu_ap_evidence_requirements(
            {
                "opensbi_boot": "accepted",
                "linux_boot": "accepted",
                "isa_cache_mmu": "stale",
                "ap_benchmarks": "stale",
            },
            {"status": "blocked"},
            {"status": "blocked"},
        )
        self.assertEqual(
            missing,
            {
                "isa_cache_mmu": "stale",
                "ap_benchmarks": "stale",
            },
        )
        self.assertEqual(
            requirements["linux_boot"]["path"],
            "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        )
        self.assertEqual(
            requirements["isa_cache_mmu"]["path"],
            "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
        )
        self.assertEqual(
            requirements["ap_benchmarks"]["path"],
            "build/evidence/cpu_ap/eliza_e1_ap_benchmarks.log",
        )
        self.assertEqual(
            requirements["isa_cache_mmu"]["required_linux_userspace_hwprobe_marker"],
            "riscv_hwprobe: syscall rc=0",
        )

    def test_qemu_npu_emulator_gate_rejects_missing_virt_machine_wiring(self):
        module = load_check_module()
        original_patch = module.QEMU_VIRT_PATCH
        with tempfile.TemporaryDirectory() as temp_dir:
            bad_patch = Path(temp_dir) / "virt-e1-npu-integration.patch"
            bad_patch.write_text(
                "CONFIG_ELIZA_E1_NPU\nobject_class_property_add_bool\ne1-npu\n",
                encoding="utf-8",
            )
            module.QEMU_VIRT_PATCH = bad_patch
            gate = module.qemu_npu_emulator_stack_gate()
        module.QEMU_VIRT_PATCH = original_patch
        self.assertEqual(gate["status"], "blocked")
        self.assertIn("virt-e1-npu-integration.patch", next(iter(gate["missing_tokens"])))
        missing = "\n".join(token for tokens in gate["missing_tokens"].values() for token in tokens)
        self.assertIn("0x10020000", missing)
        self.assertIn("eliza,e1-npu", missing)


if __name__ == "__main__":
    unittest.main()
