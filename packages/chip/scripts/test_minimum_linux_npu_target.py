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
        self.assertIn(report["status"], {"blocked", "pass"})
        self.assertEqual(report["integrated_linux_npu_ml_claim"], report["status"] == "pass")
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
            "build/reports/cpu_ap_isa_cache_mmu_probe.json",
        )
        self.assertEqual(
            companion_reports["ap_benchmarks"]["path"],
            "build/reports/cpu_ap_benchmark_runner_wiring.json",
        )
        if cpu_ap_bundle["status"] == "blocked":
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
        self.assertIn(
            bundle_summary["accepted_transcript_states"]["opensbi_boot"],
            {"accepted", "missing", "stale"},
        )
        self.assertEqual(
            bundle_summary["companion_reports"]["isa_cache_mmu"],
            "build/reports/cpu_ap_isa_cache_mmu_probe.json",
        )
        self.assertEqual(
            bundle_summary["companion_reports"]["ap_benchmarks"],
            "build/reports/cpu_ap_benchmark_runner_wiring.json",
        )
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
        self.assertIn("observed_markers", summary)
        if generated_boot["status"] == "blocked":
            self.assertIn("claim_boundary", generated_boot)
            self.assertIn("missing_userland_npu_markers", generated_boot)
            self.assertIn("e1 MMIO smoke result: PASS", generated_boot["required_markers"])
            self.assertIn("e1-npu-ml-smoke: PASS", generated_boot["required_markers"])
            self.assertIn("device=/dev/e1-npu", generated_boot["required_markers"])
            self.assertIn("CPU fallback percent=0", generated_boot["required_markers"])
            self.assertIn("device=/dev/mem generated-mmio", generated_boot["forbidden_markers"])
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
        self.assertIn("forbidden fallback markers", gate["blocker"])

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
