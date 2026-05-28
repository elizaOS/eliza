#!/usr/bin/env python3
import subprocess
import sys
import unittest

import check_memory_uma_claim_gate as gate
import yaml


class MemoryUmaClaimGateTest(unittest.TestCase):
    def test_gate_passes_and_reports_scaffold_boundary(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_memory_uma_claim_gate.py"],
            cwd=gate.ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("current_rtl_storage: 4096 bytes SRAM-backed AXI-Lite model", result.stdout)
        self.assertIn("software_aperture: 0x80000000..0x8fffffff 256 MiB", result.stdout)
        self.assertIn("real_dram_lpddr_uma_iommu_qos_status: BLOCKED", result.stdout)

    def test_phone_target_profile_blocks_real_claims(self) -> None:
        data = yaml.safe_load(gate.GATE.read_text())
        target = data["phone_2028_target_profile"]
        actual = data["linux_scaffold_current_capability"]
        local_rtl = data["separate_local_rtl_evidence"]
        bandwidth_latency = data["bandwidth_latency_evidence_contract"]

        self.assertEqual(target["claim_level_required"], "L6_COMPLETE_PHONE")
        self.assertGreaterEqual(target["external_memory"]["peak_bandwidth_gbps_min"], 180)
        self.assertGreaterEqual(target["cache_and_sram"]["shared_system_cache_mib_min"], 32)
        self.assertTrue(target["protection"]["iommu_or_smmu_required"])
        self.assertTrue(target["validation"]["requires_clint_plic_access_map"])
        self.assertTrue(target["validation"]["requires_page_fault_reporting_fields"])
        self.assertEqual(actual["usable_rtl_capacity_bytes"], 4096)
        self.assertEqual(actual["coherent_dma"], "none")
        self.assertEqual(actual["page_fault_reporting"], "none")
        self.assertEqual(actual["memory_qos"], "none")
        self.assertEqual(actual["clint_plic_access_map"], "incomplete")
        self.assertEqual(actual["phone_class_status"], "blocked")
        self.assertEqual(
            local_rtl["dram_controller_boundary"]["gate"], "make dram-controller-check"
        )
        self.assertEqual(local_rtl["iommu_boundary"]["gate"], "make iommu-evidence-check")
        self.assertEqual(
            bandwidth_latency["status"],
            "blocked_until_real_target_measurements",
        )
        self.assertIn(
            "p95_random_read_latency_ns",
            bandwidth_latency["required_metrics"],
        )
        self.assertIn("Host benchmark results.", bandwidth_latency["invalid_evidence"])

    def test_every_blocked_artifact_has_required_schema(self) -> None:
        data = yaml.safe_load(gate.GATE.read_text())
        schemas = data["required_artifact_schemas"]
        blocked_artifacts = {
            artifact
            for claim in data["blocked_real_claims"]
            for artifact in claim["evidence_artifacts"]
        }

        self.assertEqual(set(gate.REQUIRED_ARTIFACT_SCHEMAS), blocked_artifacts)
        self.assertIn("linux_interrupt_access_map", gate.REQUIRED_BLOCKED)
        for artifact in blocked_artifacts:
            self.assertEqual(schemas[artifact], gate.REQUIRED_ARTIFACT_SCHEMAS[artifact])
            self.assertFalse((gate.ROOT / artifact).exists(), artifact)


if __name__ == "__main__":
    unittest.main()
