#!/usr/bin/env python3
"""Tests for the DFT scripts: policy gates, scan-rule manifest, scan-chain
contract builder, and the ATPG bring-up harness.

These exercise the fail-closed contracts: every script must surface a clear
failure when an input is missing, malformed, or over-claims, and pass only
when the checked-in artifacts satisfy the schema.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import atpg_bringup  # noqa: E402
import build_scan_chain_contract as bscc  # noqa: E402
import check_dft_atpg_policy as dft_policy  # noqa: E402
import check_dft_scan_rules as scan_rules  # noqa: E402
import check_hardware_security_ai_policy as hwsec_policy  # noqa: E402
from chip_utils import load_yaml_object  # noqa: E402


class PolicyGateTests(unittest.TestCase):
    def test_dft_policy_passes_on_checked_in_yaml(self) -> None:
        self.assertEqual(dft_policy.main(), 0)

    def test_hardware_security_policy_passes_on_checked_in_yaml(self) -> None:
        self.assertEqual(hwsec_policy.main(), 0)

    def test_dft_policy_yaml_schema_and_status(self) -> None:
        data = load_yaml_object(dft_policy.POLICY)
        self.assertEqual(data["schema"], dft_policy.EXPECTED_SCHEMA)
        self.assertEqual(data["status"], "DRAFT_CAPTURE_ONLY")
        self.assertEqual(data["claim_boundary"], dft_policy.EXPECTED_CLAIM_BOUNDARY)
        for key in dft_policy.REQUIRED_FALSE_CLAIM_FLAGS:
            self.assertIs(data.get(key), False, key)

    def test_dft_policy_requires_quarantine_root(self) -> None:
        data = load_yaml_object(dft_policy.POLICY)
        self.assertIn("build/ai_eda/dft_atpg/", data["artifact_quarantine_roots"])

    def test_dft_policy_blocked_actions_complete(self) -> None:
        data = load_yaml_object(dft_policy.POLICY)
        self.assertEqual(
            dft_policy.REQUIRED_BLOCKED_ACTIONS - set(data["blocked_actions"]),
            set(),
        )

    def test_hardware_security_blocked_actions_complete(self) -> None:
        data = load_yaml_object(hwsec_policy.POLICY)
        self.assertEqual(
            hwsec_policy.REQUIRED_BLOCKED_ACTIONS - set(data["blocked_actions"]),
            set(),
        )

    def test_require_set_reports_missing(self) -> None:
        errors: list[str] = []
        dft_policy.require_set(["a"], "blocked_actions", {"a", "b"}, errors)
        self.assertTrue(any("missing: b" in e for e in errors))


class ScanRulesTests(unittest.TestCase):
    def test_scan_rules_pass_on_checked_in_manifest(self) -> None:
        self.assertEqual(scan_rules.main(), 0)

    def test_manifest_covers_all_node_profiles(self) -> None:
        data = load_yaml_object(scan_rules.MANIFEST)
        nodes = set(data["nodes"])
        for required in scan_rules.OPEN_EXERCISABLE_NODES | scan_rules.NDA_NODES:
            self.assertIn(required, nodes)

    def test_nda_nodes_stay_blocked(self) -> None:
        data = load_yaml_object(scan_rules.MANIFEST)
        for node_id in scan_rules.NDA_NODES:
            self.assertTrue(
                str(data["nodes"][node_id]["scan_status"]).startswith("BLOCKED"),
                f"{node_id} must be BLOCKED",
            )

    def test_scan_capable_nodes_list_scan_flops(self) -> None:
        data = load_yaml_object(scan_rules.MANIFEST)
        for node_id, node in data["nodes"].items():
            if node.get("scan_status") == "scan_capable_library_present":
                self.assertTrue(
                    node.get("scan_flop_cells"),
                    f"{node_id} must list scan_flop_cells",
                )


class ScanChainContractTests(unittest.TestCase):
    def test_classify_sky130_scan_flop(self) -> None:
        self.assertEqual(bscc.classify("sky130_fd_sc_hd__sdfxtp_1"), "sky130_fd_sc_hd")

    def test_classify_gf180_scan_flop(self) -> None:
        self.assertEqual(bscc.classify("gf180mcu_fd_sc_mcu7t5v0__sdffq_1"), "gf180mcu")

    def test_classify_non_scan_flop_returns_none(self) -> None:
        self.assertIsNone(bscc.classify("sky130_fd_sc_hd__dfrtp_1"))
        self.assertIsNone(bscc.classify("sky130_fd_sc_hd__nor2_1"))

    def test_find_scan_flops_parses_instances(self) -> None:
        netlist = (
            "module dut(clk);\n"
            "  sky130_fd_sc_hd__sdfxtp_1 _0_ (\n"
            "    .CLK(clk)\n"
            "  );\n"
            "  sky130_fd_sc_hd__nor2_1 _1_ (\n"
            "    .A(a)\n"
            "  );\n"
            "  gf180mcu_fd_sc_mcu7t5v0__sdffq_1 \\reg.q (\n"
            "    .CLK(clk)\n"
            "  );\n"
            "endmodule\n"
        )
        flops = bscc.find_scan_flops(netlist)
        self.assertEqual([f[0] for f in flops], ["_0_", "reg.q"])
        self.assertEqual(flops[0][2], "sky130_fd_sc_hd")
        self.assertEqual(flops[1][2], "gf180mcu")

    def test_builder_fails_closed_on_missing_netlist(self) -> None:
        argv = sys.argv
        try:
            sys.argv = [
                "build_scan_chain_contract.py",
                "--top",
                "e1_chip_top",
                "--netlist",
                str(ROOT / "build/dft/does_not_exist.scan.v"),
            ]
            self.assertEqual(bscc.main(), 2)
        finally:
            sys.argv = argv


class AtpgBringupTests(unittest.TestCase):
    def test_bringup_blocks_without_vendored_tool(self) -> None:
        argv = sys.argv
        try:
            sys.argv = ["atpg_bringup.py", "--run-id", "unittest"]
            # No ATPG backend is vendored; the harness must fail closed.
            self.assertEqual(atpg_bringup.main(), 2)
        finally:
            sys.argv = argv

    def test_fault_model_schema_present_and_blocked(self) -> None:
        data = load_yaml_object(atpg_bringup.FAULT_MODEL_SCHEMA)
        self.assertEqual(data["schema"], "eliza.dft_fault_model.v1")
        self.assertEqual(data["status"], "DRAFT_CAPTURE_ONLY")
        self.assertEqual(data["coverage_artifact"]["status"], "BLOCKED_no_vendored_atpg_tool")


if __name__ == "__main__":
    unittest.main()
