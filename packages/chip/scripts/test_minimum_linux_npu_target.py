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
        self.assertFalse(report["integrated_linux_npu_ml_claim"])
        names = {gate["name"] for gate in report["gates"]}
        for required in (
            "model_input",
            "runtime_abi",
            "linux_device_path",
            "rtl_cocotb_proof",
            "benchmark_command",
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
        target_smoke = next(
            gate for gate in report["gates"] if gate["name"] == "target_side_npu_ml_smoke"
        )
        capture_commands = target_smoke["report"]["capture_commands"]
        self.assertIn("--workload gemm_s8_int8_2x2x3", capture_commands["target_smoke"])
        self.assertIn("--require-npu", capture_commands["target_smoke"])


if __name__ == "__main__":
    unittest.main()
