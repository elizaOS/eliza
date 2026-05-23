#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


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
            "model_input",
            "runtime_abi",
            "linux_device_path",
            "rtl_cocotb_proof",
            "benchmark_command",
            "modeled_loadgen_npu_mlperf_subset",
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
        mlperf_modeled = next(
            gate for gate in report["gates"] if gate["name"] == "modeled_loadgen_npu_mlperf_subset"
        )
        self.assertEqual(mlperf_modeled["status"], "passed")
        self.assertEqual(
            mlperf_modeled["report"]["claim_boundary"],
            "modeled_presilicon_loadgen_subset_not_official_mlcommons_not_linux_target_"
            "not_silicon_performance_or_power",
        )
        self.assertEqual(
            {scenario["scenario"] for scenario in mlperf_modeled["report"]["scenarios"]},
            {"SingleStream", "Offline"},
        )
        mlperf_energy = next(
            gate
            for gate in report["gates"]
            if gate["name"] == "modeled_mlperf_inference_energy_gate"
        )
        self.assertEqual(mlperf_energy["status"], "passed")
        self.assertIn("measured silicon power stays BLOCKED", mlperf_energy["stdout"])
        generated_boot = next(
            gate for gate in report["gates"] if gate["name"] == "generated_ap_linux_boot"
        )
        if generated_boot["status"] == "blocked":
            self.assertIn("claim_boundary", generated_boot)
            self.assertIn("missing_userland_npu_markers", generated_boot)
            self.assertIn("e1 MMIO smoke result: PASS", generated_boot["required_markers"])
            self.assertIn("e1-npu-ml-smoke: PASS", generated_boot["required_markers"])
            self.assertIn("initramfs start", generated_boot["observed_markers"])
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


if __name__ == "__main__":
    unittest.main()
