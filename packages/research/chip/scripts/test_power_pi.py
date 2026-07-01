#!/usr/bin/env python3
"""Tests for power-integrity & electrothermal gates and models.

Covers:
  * check_upf_consistency  — UPF planning-intent consistency gate
  * check_power_thermal_ai_policy — AI-EDA power/thermal policy gate
  * pdn_ir_analysis        — per-corner static-IR/EM report binding (fail-closed)
  * pdn_activity_model      — vectorless dynamic-IR budget + package droop
  * electrothermal_coanalysis — coupled theta-network + leakage fixed point
"""

from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

check_upf = importlib.import_module("check_upf_consistency")
check_policy = importlib.import_module("check_power_thermal_ai_policy")
pdn_ir = importlib.import_module("pdn_ir_analysis")
activity = importlib.import_module("pdn_activity_model")
electro = importlib.import_module("electrothermal_coanalysis")


class TestUpfConsistency(unittest.TestCase):
    def test_passes_on_repo_upf(self) -> None:
        self.assertEqual(check_upf.main(), 0)

    def test_parser_extracts_domains_and_supplies(self) -> None:
        model = check_upf.parse_upf(check_upf.UPF_FILE)
        self.assertEqual(len(model.power_domains), 16)
        self.assertIn("VDD_AON", model.supply_nets)
        self.assertIn("PD_AON", model.always_on_domains)
        self.assertIn("PD_PMC", model.always_on_domains)
        # set_retention only declared for retention-FF domains, not all 16.
        self.assertEqual(len(model.retention_domains), 8)
        self.assertEqual(model.domain_primary_net["PD_NPU"], "VDD_NPU")

    def test_required_planning_blockers_present(self) -> None:
        text = check_upf.UPF_FILE.read_text()
        for token in check_upf.REQUIRED_UPF_BLOCKER_TOKENS:
            self.assertIn(token, text)


class TestPowerThermalAiPolicy(unittest.TestCase):
    def test_policy_gate_passes(self) -> None:
        self.assertEqual(check_policy.main(), 0)

    def test_policy_yaml_is_draft_capture_only(self) -> None:
        from chip_utils import load_yaml_object

        doc = load_yaml_object(check_policy.POLICY)
        self.assertEqual(doc["schema"], check_policy.EXPECTED_SCHEMA)
        self.assertEqual(doc["status"], "DRAFT_CAPTURE_ONLY")
        self.assertEqual(doc["claim_boundary"], check_policy.EXPECTED_CLAIM_BOUNDARY)
        self.assertIn(check_policy.REQUIRED_QUARANTINE_ROOT, doc["artifact_quarantine_roots"])

    def test_blocked_actions_complete(self) -> None:
        from chip_utils import load_yaml_object

        doc = load_yaml_object(check_policy.POLICY)
        self.assertTrue(check_policy.REQUIRED_BLOCKED_ACTIONS.issubset(set(doc["blocked_actions"])))


class TestPdnIrAnalysis(unittest.TestCase):
    def test_fails_closed_without_reports(self) -> None:
        # No Voltus/RedHawk/open-flow reports exist -> must fail closed.
        self.assertEqual(pdn_ir.main([]), 1)

    def test_allow_blocked_surfaces_without_failing(self) -> None:
        self.assertEqual(pdn_ir.main(["--allow-blocked"]), 0)

    def test_corner_matrix_is_36_runs(self) -> None:
        report = pdn_ir.analyze()
        self.assertEqual(report["corner_matrix"]["computed_total"], 36)
        self.assertFalse(report["any_report_present"])


class TestPdnActivityModel(unittest.TestCase):
    def test_budget_check_passes(self) -> None:
        self.assertEqual(activity.main(["--check"]), 0)

    def test_budget_uses_2x_margin_and_rail_peak(self) -> None:
        report, blockers = activity.build_budget()
        self.assertEqual(blockers, [])
        self.assertEqual(report["dynamic_margin_factor"], 2.0)
        for row in report["blocks"]:
            af = row["activity_factor"]
            ssf = row["simultaneous_switch_factor"]
            self.assertTrue(0.0 <= af <= 1.0)
            self.assertTrue(0.0 <= ssf <= 1.0)
            expected = round(row["peak_a"] * af * ssf, 4)
            self.assertAlmostEqual(row["vectorless_dynamic_current_a"], expected, places=3)
            self.assertAlmostEqual(
                row["dynamic_ir_budget_a_with_margin"], round(expected * 2.0, 4), places=3
            )

    def test_droop_passes_and_stays_above_dvfs_min(self) -> None:
        self.assertEqual(activity.main(["--droop"]), 0)
        report, blockers = activity.build_droop()
        self.assertEqual(blockers, [])
        self.assertTrue(report["scenarios"])
        for scen in report["scenarios"]:
            # Droop must be a positive first-order estimate within budget.
            self.assertGreater(scen["v_droop_total"], 0.0)
            self.assertTrue(scen["within_max_droop_pct"])
            self.assertTrue(scen["above_dvfs_min_v"])
            self.assertGreater(scen["tank_impedance_z0_mohm"], 0.0)

    def test_droop_release_use_locked(self) -> None:
        report, _ = activity.build_droop()
        self.assertEqual(report["release_use"], "prohibited_until_external_review")


class TestElectrothermalCoanalysis(unittest.TestCase):
    def test_check_passes(self) -> None:
        self.assertEqual(electro.main(["--check"]), 0)

    def test_leakage_feedback_increases_power(self) -> None:
        report = electro.coanalyze()
        self.assertEqual(report["status"], "draft_local_evidence")
        self.assertEqual(report["release_use"], "prohibited_until_external_review")
        # 2-iteration fixed point recorded.
        self.assertEqual(len(report["iterations"]), 2)
        # Temperature feedback must raise every block's power above the
        # reference sustained value (positive leakage uplift).
        for block in report["blocks"]:
            self.assertGreaterEqual(block["leakage_uplift_w"], 0.0)
            self.assertGreater(block["converged_tj_c"], electro.T_AMBIENT_C - 0.01)
        self.assertGreater(
            report["totals"]["converged_total_power_w"],
            sum(b["sustained_w_at_ref"] for b in report["blocks"]) - 1e-6,
        )

    def test_tj_within_envelope(self) -> None:
        report = electro.coanalyze()
        self.assertLessEqual(report["totals"]["max_tj_c"], electro.MAX_TJ_C)


if __name__ == "__main__":
    unittest.main()
