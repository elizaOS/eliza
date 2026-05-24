#!/usr/bin/env python3
"""Tests for ``scripts/aggregate_tapeout_readiness.py``.

Covers the prefix-based classifier, the report builder, the exit-code policy,
and the static gate inventory.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import aggregate_tapeout_readiness as agg  # noqa: E402
import check_e1_phone_factory_output_content as factory_content  # noqa: E402
import check_e1_phone_fabrication_release as fabrication_release  # noqa: E402
import check_e1_phone_first_article_content as first_article_content  # noqa: E402
import check_e1_phone_board_package as board_package  # noqa: E402
import check_e1_phone_enclosure_mechanical_content as enclosure_content  # noqa: E402
import check_e1_phone_release_approval_signatures as approval_signatures  # noqa: E402
import check_e1_phone_release_evidence_regeneration as regeneration_check  # noqa: E402
import check_e1_phone_routed_output_content as routed_content  # noqa: E402
import check_e1_phone_supplier_return_content as supplier_content  # noqa: E402
import e1_phone_release_evidence_content_contract as release_contract  # noqa: E402
import e1_phone_release_evidence_validation_dry_run as release_validation  # noqa: E402
import e1_phone_mechanical_cad_evidence_inventory as mechanical_inventory  # noqa: E402
import e1_phone_kicad_route_inventory as route_inventory  # noqa: E402
import e1_phone_enclosure_readiness_gap_map as enclosure_gap_map  # noqa: E402
import e1_phone_first_article_missing_evidence_diagnostic as first_article_missing  # noqa: E402
import e1_phone_routed_board_release_acceptance_matrix as routed_acceptance  # noqa: E402


class ClassifyTests(unittest.TestCase):
    def test_status_blocked_prefix_wins_over_zero_exit(self) -> None:
        self.assertEqual(
            agg._classify(0, "STATUS: BLOCKED foo - missing PDK"),
            "BLOCKED",
        )

    def test_status_blocked_prefix_wins_over_non_zero_exit(self) -> None:
        self.assertEqual(
            agg._classify(1, "STATUS: BLOCKED bar - missing tool"),
            "BLOCKED",
        )

    def test_release_blocked_text_wins_over_non_zero_exit(self) -> None:
        self.assertEqual(
            agg._classify(1, "enclosure placement ok: release blocked\n"),
            "BLOCKED",
        )

    def test_non_zero_exit_without_blocked_is_fail(self) -> None:
        self.assertEqual(
            agg._classify(1, "FAIL: padframe pin missing\n"),
            "FAIL",
        )

    def test_zero_exit_is_pass(self) -> None:
        self.assertEqual(
            agg._classify(0, "cpu 2028 target check passed\n"),
            "PASS",
        )


class EvidenceLineTests(unittest.TestCase):
    def test_prefers_blocked_line(self) -> None:
        out = "starting check\nSTATUS: BLOCKED foo - missing\ndone\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "STATUS: BLOCKED foo - missing",
        )

    def test_blocked_wins_over_status_pass(self) -> None:
        out = (
            "STATUS: PASS cpu.core_selection\n"
            "STATUS: BLOCKED cpu.core_selection_big_core - license required\n"
        )
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "STATUS: BLOCKED cpu.core_selection_big_core - license required",
        )

    def test_prefers_fail_line(self) -> None:
        out = "starting\nFAIL: something broke\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 1),
            "FAIL: something broke",
        )

    def test_status_pass_line_picked_when_no_blocker(self) -> None:
        out = "preamble\nSTATUS: PASS rva23.llvm_pin_sha — abc\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "STATUS: PASS rva23.llvm_pin_sha — abc",
        )

    def test_falls_back_to_first_nonempty_line(self) -> None:
        out = "\n\ncheck passed: 42 items\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "check passed: 42 items",
        )

    def test_truncates_to_200_chars(self) -> None:
        out = "BLOCKED: " + ("x" * 500)
        self.assertEqual(len(agg._first_evidence_line("foo", out, 0)), 200)

    def test_empty_output_synthesises_evidence(self) -> None:
        self.assertEqual(
            agg._first_evidence_line("foo", "", 0),
            "foo: no output (exit=0)",
        )


class E1PhoneBoardPackageArtifactClassifierTests(unittest.TestCase):
    def test_inline_blocked_candidate_pdf_is_not_release_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            pdf_path = Path(tmp_text) / "rf-calibration-procedure.pdf"
            pdf_path.write_bytes(
                b"%PDF-1.4\n"
                b"% rf_calibration_procedure_candidate: "
                b"blocked local factory candidate, not release evidence\n"
                b"%%EOF\n"
            )

            self.assertTrue(board_package.is_blocked_candidate_artifact(pdf_path))
            self.assertFalse(board_package.is_release_artifact_present(pdf_path))

    def test_supplier_return_csv_placeholder_is_not_release_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            csv_path = Path(tmp_text) / "pinout-or-pad-map.csv"
            csv_path.write_text(
                "artifact_id,disposition,release_credit,notes\n"
                "display_touch:pinout_or_pad_map,"
                "blocked_pending_supplier_return,false,"
                "placeholder for supplier return\n",
                encoding="utf-8",
            )

            self.assertTrue(board_package.is_blocked_candidate_artifact(csv_path))
            self.assertFalse(board_package.is_release_artifact_present(csv_path))

    def test_supplier_return_text_placeholder_is_not_release_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            step_path = Path(tmp_text) / "supplier-model.step"
            step_path.write_text(
                "E1 phone supplier-return placeholder\n"
                "release_credit: false\n"
                "This is not supplier evidence. Replace with signed supplier artifact.\n",
                encoding="utf-8",
            )

            self.assertTrue(board_package.is_blocked_candidate_artifact(step_path))
            self.assertFalse(board_package.is_release_artifact_present(step_path))


class BuildReportTests(unittest.TestCase):
    def _result(self, status: agg.Status) -> agg.GateResult:
        return agg.GateResult(
            name="g",
            status=status,
            evidence="ev",
            subsystem="cpu",
            tier="spec",
        )

    def test_release_blocker_is_true_when_any_fail(self) -> None:
        report = agg.build_report(
            [self._result("PASS"), self._result("FAIL"), self._result("BLOCKED")]
        )
        self.assertTrue(report["release_blocker"])
        self.assertTrue(report["effective_release_blocker"])
        self.assertEqual(report["summary"], {"pass": 1, "fail": 1, "blocked": 1})

    def test_release_blocker_false_when_only_blocked(self) -> None:
        report = agg.build_report([self._result("PASS"), self._result("BLOCKED")])
        self.assertFalse(report["release_blocker"])
        self.assertTrue(report["effective_release_blocker"])
        self.assertEqual(report["blocker_dependency_counts"]["repo_artifact_generation"], 1)

    def test_release_blocker_false_when_all_pass(self) -> None:
        report = agg.build_report([self._result("PASS"), self._result("PASS")])
        self.assertFalse(report["release_blocker"])
        self.assertFalse(report["effective_release_blocker"])

    def test_schema_and_claim_boundary_fields(self) -> None:
        report = agg.build_report([self._result("PASS")])
        self.assertEqual(report["schema"], "eliza.tapeout_readiness.v1")
        self.assertEqual(
            report["claim_boundary"],
            "tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim",
        )

    def test_results_alias_matches_gates_for_status_consumers(self) -> None:
        report = agg.build_report([self._result("PASS"), self._result("BLOCKED")])
        self.assertEqual(report["results"], report["gates"])
        self.assertEqual(report["results"][1]["status"], "BLOCKED")

    def test_blocked_gates_are_grouped_by_actionable_dependency(self) -> None:
        report = agg.build_report(
            [
                agg.GateResult(
                    name="phone-runtime-readiness-contract-check",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED adb device/emulator unavailable",
                    subsystem="platform",
                    tier="silicon",
                    script="scripts/check_phone_runtime_readiness_contract.py",
                ),
                agg.GateResult(
                    name="android-release-readiness-contract-check",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED missing boot.img artifact",
                    subsystem="platform",
                    tier="pd",
                    script="scripts/check_android_release_readiness_contract.py",
                ),
                agg.GateResult(
                    name="e1-phone-release-approval-signature-check",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED approvals missing reviewer",
                    subsystem="platform",
                    tier="pd",
                    script="scripts/check_e1_phone_release_approval_signatures.py",
                ),
            ]
        )
        self.assertEqual(report["blocker_dependency_counts"]["live_device_validation"], 1)
        self.assertEqual(report["blocker_dependency_counts"]["repo_artifact_generation"], 1)
        self.assertEqual(
            report["blocker_dependency_counts"]["actionable_external_dependency"],
            1,
        )
        self.assertEqual(
            report["blocker_groups"]["live_device_validation"][0]["name"],
            "phone-runtime-readiness-contract-check",
        )
        self.assertEqual(
            report["blocker_action_plan"]["live_device_validation"][0]["validation_command"],
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
        )
        self.assertIn(
            "Boot a target phone/emulator",
            report["blocker_action_plan"]["live_device_validation"][0]["next_action"],
        )
        self.assertIn(
            "missing boot.img artifact",
            report["blocker_action_plan"]["repo_artifact_generation"][0]["evidence"],
        )

    def test_product_action_plan_includes_repo_artifact_groups(self) -> None:
        agg.PRODUCT_RELEASE_STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
        original = (
            agg.PRODUCT_RELEASE_STATUS_PATH.read_text(encoding="utf-8")
            if agg.PRODUCT_RELEASE_STATUS_PATH.exists()
            else None
        )
        try:
            agg.PRODUCT_RELEASE_STATUS_PATH.write_text(
                json.dumps(
                    {
                        "repo_artifact_generation_groups": [
                            {
                                "family": "manufacturing_release_artifacts",
                                "count": 110,
                                "next_command": "python3 scripts/check_manufacturing_artifacts.py --release",
                            },
                            {
                                "family": "kicad_fabrication_artifacts",
                                "count": 43,
                                "next_command": "python3 scripts/check_kicad_artifacts.py --release",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            report = agg.build_report(
                [
                    agg.GateResult(
                        name="product-release-status-check",
                        status="BLOCKED",
                        evidence="STATUS: BLOCKED product release check",
                        subsystem="platform",
                        tier="pd",
                        script="scripts/product_check.py",
                        args=("--release",),
                    )
                ]
            )
            next_action = report["blocker_action_plan"]["repo_artifact_generation"][0][
                "next_action"
            ]
            self.assertIn("manufacturing_release_artifacts=110", next_action)
            self.assertIn("check_manufacturing_artifacts.py --release", next_action)
            self.assertIn("kicad_fabrication_artifacts=43", next_action)
        finally:
            if original is None:
                agg.PRODUCT_RELEASE_STATUS_PATH.unlink(missing_ok=True)
            else:
                agg.PRODUCT_RELEASE_STATUS_PATH.write_text(original, encoding="utf-8")

    def test_blocked_phone_gates_are_grouped_into_release_phases(self) -> None:
        report = agg.build_report(
            [
                agg.GateResult(
                    name="e1-phone-fabrication-release-check",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED fabrication gate",
                    subsystem="platform",
                    tier="pd",
                    script="scripts/check_e1_phone_fabrication_release.py",
                ),
                agg.GateResult(
                    name="phone-runtime-readiness-contract-check",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED phone.runtime_readiness_contract",
                    subsystem="platform",
                    tier="silicon",
                    script="scripts/check_phone_runtime_readiness_contract.py",
                ),
                agg.GateResult(
                    name="product-release-status-check",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED product release check",
                    subsystem="platform",
                    tier="pd",
                    script="scripts/product_check.py",
                    args=("--release",),
                ),
            ]
        )
        phase_map = {
            row["phase"]: row
            for row in report["blocker_phase_plan"]
        }
        self.assertIn("phone_fabrication_enclosure_release", phase_map)
        self.assertIn("phone_end_to_end_runtime_release", phase_map)
        self.assertIn("product_release_rollup", phase_map)
        fabrication = phase_map["phone_fabrication_enclosure_release"]
        self.assertEqual(fabrication["blocked_gate_count"], 1)
        self.assertEqual(
            fabrication["blocker_dependency_counts"]["actionable_external_dependency"],
            1,
        )
        self.assertIn(
            "e1-phone-fabrication-release-check",
            fabrication["blocked_gates"],
        )
        self.assertEqual(
            fabrication["blocked_gate_details"][0]["name"],
            "e1-phone-fabrication-release-check",
        )
        self.assertEqual(
            fabrication["blocked_gate_details"][0]["blocker_dependency"],
            "actionable_external_dependency",
        )
        self.assertEqual(
            fabrication["blocked_gate_details"][0]["validation_command"],
            "python3 scripts/check_e1_phone_fabrication_release.py",
        )
        self.assertIn("next_action", fabrication["blocked_gate_details"][0])
        self.assertEqual(
            fabrication["next_command_by_dependency"][
                "actionable_external_dependency"
            ],
            ["python3 scripts/check_e1_phone_fabrication_release.py"],
        )
        runtime = phase_map["phone_end_to_end_runtime_release"]
        self.assertEqual(
            runtime["blocker_dependency_counts"]["live_device_validation"],
            1,
        )
        self.assertEqual(
            runtime["validation_commands"],
            ["python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py"],
        )
        self.assertIn(
            "python3 scripts/aggregate_tapeout_readiness.py --scope phone --strict",
            runtime["acceptance_commands"],
        )


class GateInventoryTests(unittest.TestCase):
    def test_every_gate_script_exists(self) -> None:
        for spec in agg.GATES:
            with self.subTest(gate=spec.name):
                self.assertTrue(
                    (ROOT / spec.script).is_file(),
                    f"missing script for gate {spec.name}: {spec.script}",
                )

    def test_gate_names_are_unique(self) -> None:
        names = [spec.name for spec in agg.GATES]
        self.assertEqual(len(names), len(set(names)))

    def test_subsystems_and_tiers_are_allowed(self) -> None:
        allowed_subsystems = {
            "cpu",
            "memory",
            "security",
            "npu",
            "process",
            "pd",
            "platform",
            "bsp",
            "verify",
            "benchmarks",
            "os_rv64",
        }
        allowed_tiers = {"spec", "rtl", "pd", "silicon"}
        for spec in agg.GATES:
            with self.subTest(gate=spec.name):
                self.assertIn(spec.subsystem, allowed_subsystems)
                self.assertIn(spec.tier, allowed_tiers)
                self.assertIn(spec.scope, {"chip", "phone"})

    def test_scope_partitions_keep_all_gates_visible(self) -> None:
        self.assertTrue(agg.CHIP_TAPEOUT_GATES)
        self.assertTrue(agg.PHONE_PRODUCT_GATES)
        self.assertEqual(
            set(agg.GATES),
            set(agg.CHIP_TAPEOUT_GATES) | set(agg.PHONE_PRODUCT_GATES),
        )
        self.assertFalse(set(agg.CHIP_TAPEOUT_GATES) & set(agg.PHONE_PRODUCT_GATES))
        self.assertEqual(
            len(agg.GATES),
            len(agg.CHIP_TAPEOUT_GATES) + len(agg.PHONE_PRODUCT_GATES),
        )
        self.assertEqual(agg.select_gates("all"), agg.GATES)
        self.assertEqual(agg.select_gates("chip"), agg.CHIP_TAPEOUT_GATES)
        self.assertEqual(agg.select_gates("phone"), agg.PHONE_PRODUCT_GATES)

    def test_chip_scope_excludes_phone_product_gates(self) -> None:
        chip_names = {spec.name for spec in agg.CHIP_TAPEOUT_GATES}
        phone_names = {spec.name for spec in agg.PHONE_PRODUCT_GATES}

        self.assertNotIn("e1-phone-fabrication-release-check", chip_names)
        self.assertNotIn("product-release-status-check", chip_names)
        self.assertNotIn("phone-runtime-readiness-contract-check", chip_names)
        self.assertIn("e1-phone-fabrication-release-check", phone_names)
        self.assertIn("product-release-status-check", phone_names)
        self.assertIn("phone-runtime-readiness-contract-check", phone_names)

    def test_at_least_one_gate_per_subsystem(self) -> None:
        required = {
            "cpu",
            "memory",
            "security",
            "npu",
            "process",
            "pd",
            "platform",
            "bsp",
            "verify",
            "benchmarks",
            "os_rv64",
        }
        present = {spec.subsystem for spec in agg.GATES}
        missing = required - present
        self.assertFalse(missing, f"missing subsystem coverage: {missing}")

    def test_chipyard_generated_linux_contract_gate_requires_boot_evidence(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("chipyard-generated-linux-contract-check", specs)
        self.assertEqual(
            specs["chipyard-generated-linux-contract-check"].args,
            ("--require-boot-evidence",),
        )

    def test_pd_soc_input_contract_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("pd-soc-input-contract-check", specs)
        spec = specs["pd-soc-input-contract-check"]
        self.assertEqual(spec.script, "scripts/check_e1_soc_pd_input_contract.py")
        self.assertEqual(spec.subsystem, "pd")
        self.assertEqual(spec.tier, "pd")
        self.assertEqual(spec.args, ("--strict",))

    def test_e1_phone_board_package_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-board-package-check", specs)
        spec = specs["e1-phone-board-package-check"]
        self.assertEqual(spec.script, "scripts/check_e1_phone_board_package.py")
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")
        self.assertEqual(spec.scope, "phone")

    def test_e1_phone_fabrication_release_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-fabrication-release-check", specs)
        spec = specs["e1-phone-fabrication-release-check"]
        self.assertEqual(spec.script, "scripts/check_e1_phone_fabrication_release.py")
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")
        self.assertEqual(spec.scope, "phone")

    def test_e1_phone_release_evidence_regeneration_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-release-evidence-regeneration-check", specs)
        spec = specs["e1-phone-release-evidence-regeneration-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_release_evidence_regeneration.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_release_approval_signature_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-release-approval-signature-check", specs)
        spec = specs["e1-phone-release-approval-signature-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_release_approval_signatures.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_supplier_return_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-supplier-return-content-check", specs)
        spec = specs["e1-phone-supplier-return-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_supplier_return_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_routed_output_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-routed-output-content-check", specs)
        spec = specs["e1-phone-routed-output-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_routed_output_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_factory_output_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-factory-output-content-check", specs)
        spec = specs["e1-phone-factory-output-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_factory_output_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_first_article_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-first-article-content-check", specs)
        spec = specs["e1-phone-first-article-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_first_article_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_enclosure_mechanical_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-enclosure-mechanical-content-check", specs)
        spec = specs["e1-phone-enclosure-mechanical-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_enclosure_mechanical_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_product_dependency_gates_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        expected = {
            "pinout-check": (
                "package/scripts/validate_pinout.py",
                "pd",
                "spec",
                ("package/e1-demo-pinout.yaml",),
            ),
            "e1-phone-manufacturing-artifacts-check": (
                "scripts/check_manufacturing_artifacts.py",
                "platform",
                "pd",
                ("--manifest", "board/kicad/e1-phone/artifact-manifest.yaml"),
            ),
            "pdk-access-gate": (
                "scripts/check_pdk_access_gate.py",
                "process",
                "pd",
                (),
            ),
            "io-cell-contract-check": (
                "scripts/check_io_cell_contract.py",
                "pd",
                "pd",
                (),
            ),
            "rail-plan-check": ("scripts/check_rail_plan.py", "pd", "pd", ()),
            "upf-check": ("scripts/check_upf_consistency.py", "pd", "pd", ()),
            "pdn-workload-signoff": (
                "scripts/check_pdn_workload_signoff.py",
                "pd",
                "pd",
                (),
            ),
            "pmic-procurement-gate": (
                "scripts/check_pdn_workload_signoff.py",
                "pd",
                "pd",
                ("--allow-blocked",),
            ),
            "e1-phone-assemblability-check": (
                "scripts/check_e1_phone_assemblability.py",
                "platform",
                "pd",
                (),
            ),
            "e1-phone-button-orientation-check": (
                "scripts/check_e1_phone_button_orientation.py",
                "platform",
                "pd",
                (),
            ),
            "e1-phone-boolean-interference-check": (
                "scripts/check_e1_phone_boolean_interference.py",
                "platform",
                "pd",
                (),
            ),
        }
        for name, (script, subsystem, tier, args) in expected.items():
            with self.subTest(name=name):
                self.assertIn(name, specs)
                self.assertEqual(specs[name].script, script)
                self.assertEqual(specs[name].subsystem, subsystem)
                self.assertEqual(specs[name].tier, tier)
                self.assertEqual(specs[name].args, args)

    def test_release_mode_gates_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        expected = {
            "pd-signoff-check": ("scripts/check_pd_signoff.py", "pd", ()),
            "pd-release-evidence-check": (
                "scripts/check_pd_release_evidence.py",
                "pd",
                (),
            ),
            "manufacturing-artifacts-release-check": (
                "scripts/check_manufacturing_artifacts.py",
                "platform",
                ("--release",),
            ),
            "fpga-release-check": (
                "scripts/check_fpga_release.py",
                "platform",
                ("--release",),
            ),
            "antenna-metadata-release-check": (
                "scripts/check_antenna_metadata.py",
                "pd",
                ("--release",),
            ),
            "product-release-status-check": (
                "scripts/product_check.py",
                "platform",
                ("--release",),
            ),
            "package-cross-probe-release-check": (
                "scripts/check_package_cross_probe.py",
                "platform",
                ("--release",),
            ),
            "kicad-artifacts-release-check": (
                "scripts/check_kicad_artifacts.py",
                "platform",
                ("--release",),
            ),
            "openlane-run-release-preflight-check": (
                "scripts/check_openlane_run_preflight.py",
                "pd",
                ("--release",),
            ),
        }
        for name, (script, subsystem, args) in expected.items():
            with self.subTest(name=name):
                self.assertIn(name, specs)
                self.assertEqual(specs[name].script, script)
                self.assertEqual(specs[name].subsystem, subsystem)
                self.assertEqual(specs[name].args, args)

    def test_os_rv64_subsystem_present(self) -> None:
        """The unified bring-up dashboard requires at least one os_rv64 gate.

        The chip aggregator spans the chip and OS RV64 variant so that a
        single ``make chip-os-bring-up-status`` view covers both halves of
        the promotion contract. If this assertion fails the unified
        dashboard has silently lost its OS side.
        """
        os_gates = [spec for spec in agg.GATES if spec.subsystem == "os_rv64"]
        self.assertTrue(os_gates, "no os_rv64 gates registered in GATES")
        names = {spec.name for spec in os_gates}
        self.assertIn("os-rv64-release-check", names)
        self.assertIn("os-rv64-qemu-virt-boot-test", names)

    def test_android_release_readiness_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("android-release-readiness-contract-check", names)

    def test_phone_runtime_readiness_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("phone-runtime-readiness-contract-check", names)

    def test_chipyard_ap_abi_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("chipyard-ap-abi-contract-check", names)

    def test_chipyard_generated_linux_contract_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("chipyard-generated-linux-contract-check", specs)
        self.assertEqual(
            specs["chipyard-generated-linux-contract-check"].args,
            ("--require-boot-evidence",),
        )

    def test_boot_security_chain_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("boot-security-chain-contract-check", names)

    def test_linux_bsp_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("linux-bsp-contract-check", names)

    def test_linux_boot_artifacts_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("linux-boot-artifacts-check", specs)
        self.assertEqual(specs["linux-boot-artifacts-check"].args, ("--require-pass",))

    def test_linux_firmware_boot_chain_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("linux-firmware-boot-chain-contract-check", names)

    def test_linux_memory_platform_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("linux-memory-platform-contract-check", names)

    def test_chipyard_verilator_linux_smoke_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("chipyard-verilator-linux-smoke-check", names)

    def test_aosp_hal_service_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("aosp-hal-service-contract-check", names)

    def test_aosp_linux_handoff_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("aosp-linux-handoff-contract-check", names)

    def test_android_evidence_capture_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("android-evidence-capture-contract-check", names)

    def test_android_simulated_peripheral_evidence_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("android-simulated-peripheral-evidence-check", names)

    def test_cross_fork_agent_payload_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("cross-fork-agent-payload-contract-check", names)

    def test_chip_os_bringup_workflow_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("chip-os-bringup-workflow-contract-check", names)

    def test_host_local_paths_are_not_hardcoded(self) -> None:
        for spec in agg.GATES:
            with self.subTest(gate=spec.name):
                self.assertNotIn("/home/shaw/", spec.script)


class MainExitCodeTests(unittest.TestCase):
    def test_main_returns_zero_when_no_fail(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="ext-dep",
                status="BLOCKED",
                evidence="STATUS: BLOCKED ext",
                subsystem="pd",
                tier="pd",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
            redirect_stdout(io.StringIO()),
        ):
            rc = agg.main(["--json-only"])
        self.assertEqual(rc, 0)

    def test_main_returns_one_when_any_fail(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="bad",
                status="FAIL",
                evidence="FAIL: broken",
                subsystem="pd",
                tier="pd",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
            redirect_stdout(io.StringIO()),
        ):
            rc = agg.main(["--json-only"])
        self.assertEqual(rc, 1)

    def test_strict_mode_returns_one_on_blocked(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="ext-dep",
                status="BLOCKED",
                evidence="STATUS: BLOCKED ext",
                subsystem="pd",
                tier="pd",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
            redirect_stdout(io.StringIO()),
        ):
            rc = agg.main(["--strict", "--json-only"])
        self.assertEqual(rc, 1)

    def test_strict_mode_returns_zero_when_all_pass(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok-1",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="ok-2",
                status="PASS",
                evidence="ok",
                subsystem="npu",
                tier="spec",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
            redirect_stdout(io.StringIO()),
        ):
            rc = agg.main(["--strict", "--json-only"])
        self.assertEqual(rc, 0)

    def test_main_honors_scope_filter_and_reports_scope(self) -> None:
        fake_gate = agg.GateSpec(
            name="phone-only",
            script="scripts/check_e1_phone_fabrication_release.py",
            subsystem="platform",
            tier="pd",
            scope="phone",
        )
        fake_results = [
            agg.GateResult(
                name="phone-only",
                status="BLOCKED",
                evidence="STATUS: BLOCKED phone",
                subsystem="platform",
                tier="pd",
            )
        ]
        reports: list[dict[str, object]] = []

        def capture_report(report: dict[str, object], report_path=None) -> None:
            reports.append(report)

        with (
            mock.patch.object(agg, "select_gates", return_value=(fake_gate,)) as select_gates,
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "write_report", side_effect=capture_report),
            redirect_stdout(io.StringIO()),
        ):
            rc = agg.main(["--scope", "phone", "--json-only"])

        self.assertEqual(rc, 0)
        select_gates.assert_called_once_with("phone")
        self.assertEqual(reports[0]["scope"], "phone")
        self.assertEqual(reports[0]["status"], "blocked")
        self.assertEqual(reports[0]["summary"], {"pass": 0, "fail": 0, "blocked": 1})

    def test_json_only_stdout_is_parseable_report_json(self) -> None:
        fake_gate = agg.GateSpec(
            name="phone-only",
            script="scripts/check_e1_phone_fabrication_release.py",
            subsystem="platform",
            tier="pd",
            scope="phone",
        )
        fake_result = agg.GateResult(
            name="phone-only",
            status="BLOCKED",
            evidence="STATUS: BLOCKED phone",
            subsystem="platform",
            tier="pd",
        )
        stdout = io.StringIO()

        with (
            mock.patch.object(agg, "select_gates", return_value=(fake_gate,)),
            mock.patch.object(agg, "run_gate", return_value=fake_result),
            mock.patch.object(agg, "write_report"),
            redirect_stdout(stdout),
        ):
            rc = agg.main(["--scope", "phone", "--json-only"])

        payload = json.loads(stdout.getvalue())
        self.assertEqual(rc, 0)
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["scope"], "phone")
        self.assertEqual(payload["summary"], {"pass": 0, "fail": 0, "blocked": 1})
        self.assertEqual(payload["gates"][0]["name"], "phone-only")
        self.assertNotIn("STATUS     SUBSYSTEM", stdout.getvalue())

    def test_json_only_stdout_stays_parseable_when_release_blocking_fail(self) -> None:
        fake_gate = agg.GateSpec(
            name="bad",
            script="scripts/check_e1_phone_fabrication_release.py",
            subsystem="platform",
            tier="pd",
            scope="phone",
        )
        fake_result = agg.GateResult(
            name="bad",
            status="FAIL",
            evidence="FAIL: broken",
            subsystem="platform",
            tier="pd",
        )
        stdout = io.StringIO()

        with (
            mock.patch.object(agg, "select_gates", return_value=(fake_gate,)),
            mock.patch.object(agg, "run_gate", return_value=fake_result),
            mock.patch.object(agg, "write_report"),
            redirect_stdout(stdout),
        ):
            rc = agg.main(["--scope", "phone", "--json-only"])

        payload = json.loads(stdout.getvalue())
        self.assertEqual(rc, 1)
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["summary"], {"pass": 0, "fail": 1, "blocked": 0})
        self.assertIs(payload["release_blocker"], True)


class MakefileScopeTargetTests(unittest.TestCase):
    def _target_recipe(self, target: str) -> str:
        lines = (ROOT / "Makefile").read_text(encoding="utf-8").splitlines()
        prefix = f"{target}:"
        for index, line in enumerate(lines):
            if line.startswith(prefix):
                recipe: list[str] = []
                for following in lines[index + 1 :]:
                    if following and not following.startswith(("\t", " ")):
                        break
                    if following.startswith("\t"):
                        recipe.append(following.strip())
                return "\n".join(recipe)
        self.fail(f"missing Makefile target: {target}")

    def test_makefile_scope_targets_invoke_expected_aggregate_modes(self) -> None:
        self.assertIn(
            "scripts/aggregate_tapeout_readiness.py",
            self._target_recipe("tapeout-readiness"),
        )
        self.assertNotIn("--scope", self._target_recipe("tapeout-readiness"))
        self.assertNotIn("--strict", self._target_recipe("tapeout-readiness"))

        self.assertIn(
            "scripts/aggregate_tapeout_readiness.py --strict",
            self._target_recipe("tapeout-readiness-strict"),
        )
        self.assertNotIn("--scope", self._target_recipe("tapeout-readiness-strict"))

        self.assertIn(
            "--scope chip --report build/reports/chip-tapeout-readiness.json",
            self._target_recipe("chip-tapeout-readiness"),
        )
        self.assertNotIn("--strict", self._target_recipe("chip-tapeout-readiness"))

        self.assertIn(
            "--scope chip --strict --report build/reports/chip-tapeout-readiness.json",
            self._target_recipe("chip-tapeout-readiness-strict"),
        )

        self.assertIn(
            "--scope phone --report build/reports/phone-release-readiness.json",
            self._target_recipe("phone-release-readiness"),
        )
        self.assertNotIn("--strict", self._target_recipe("phone-release-readiness"))

        self.assertIn(
            "--scope phone --strict --report build/reports/phone-release-readiness.json",
            self._target_recipe("phone-release-readiness-strict"),
        )


class PrintSummaryTests(unittest.TestCase):
    def test_strict_summary_marks_blocked_as_effective_release_blocker(self) -> None:
        report = agg.build_report(
            [
                agg.GateResult(
                    name="ext-dep",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED ext",
                    subsystem="pd",
                    tier="pd",
                )
            ]
        )
        with mock.patch("sys.stdout") as stdout:
            agg.print_summary(report, strict=True)
        printed = "".join(call.args[0] + "\n" for call in stdout.write.call_args_list)
        self.assertIn("release_blocker=False", printed)
        self.assertIn("effective_release_blocker=True", printed)
        self.assertIn("strict=True", printed)


class ReportFileTests(unittest.TestCase):
    def test_write_report_emits_valid_json_with_trailing_newline(self) -> None:
        import tempfile

        report = agg.build_report(
            [
                agg.GateResult(
                    name="x",
                    status="PASS",
                    evidence="ok",
                    subsystem="cpu",
                    tier="spec",
                )
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested/dir/tapeout-readiness.json"
            with mock.patch.object(agg, "REPORT_PATH", target):
                agg.write_report(report)
            text = target.read_text()
        self.assertTrue(text.endswith("\n"))
        parsed = json.loads(text)
        self.assertEqual(parsed["schema"], "eliza.tapeout_readiness.v1")
        self.assertEqual(parsed["gates"][0]["name"], "x")

    def test_report_includes_gate_script_args_and_module(self) -> None:
        result = agg.GateResult(
            name="x",
            status="BLOCKED",
            evidence="STATUS: BLOCKED x",
            subsystem="platform",
            tier="pd",
            script="scripts/check_x.py",
            args=("--release",),
            module="tests.test_x",
        )
        report = agg.build_report([result])
        gate = report["gates"][0]  # type: ignore[index]
        self.assertEqual(gate["script"], "scripts/check_x.py")
        self.assertEqual(gate["args"], ("--release",))
        self.assertEqual(gate["module"], "tests.test_x")


class AbsolutePathGateTests(unittest.TestCase):
    """The aggregator must accept absolute-path GateSpec entries so it can
    reach across packages (e.g. the OS RV64 variant's release-check).
    """

    def test_absolute_path_gate_runs_and_reports_pass(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_gate.py"
            script.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "print('STATUS: PASS synthetic absolute-path gate')\n"
                "sys.exit(0)\n"
            )
            spec = agg.GateSpec(
                name="synthetic-abs-pass",
                script=str(script),
                subsystem="os_rv64",
                tier="spec",
            )
            result = agg.run_gate(spec)
        self.assertEqual(result.status, "PASS")
        self.assertEqual(result.name, "synthetic-abs-pass")
        self.assertIn("STATUS: PASS", result.evidence)

    def test_absolute_path_gate_classifies_blocked_marker(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_blocked.py"
            script.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "print('STATUS: BLOCKED waiting on external dep')\n"
                "sys.exit(0)\n"
            )
            spec = agg.GateSpec(
                name="synthetic-abs-blocked",
                script=str(script),
                subsystem="os_rv64",
                tier="spec",
            )
            result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")

    def test_absolute_path_gate_missing_script_is_fail(self) -> None:
        spec = agg.GateSpec(
            name="synthetic-abs-missing",
            script="/definitely/not/here/missing_gate.py",
            subsystem="os_rv64",
            tier="spec",
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "FAIL")
        self.assertIn("script missing", result.evidence)
        self.assertEqual(result.script, "/definitely/not/here/missing_gate.py")


class E1PhoneReleaseContentStrictnessTests(unittest.TestCase):
    def _contract_row(self, path: str, **overrides: object) -> dict[str, object]:
        row: dict[str, object] = {
            "evidence_id": "synthetic:evidence",
            "category": "synthetic",
            "path": path,
            "source_matrix": "synthetic-matrix.yaml",
            "release_allowed": False,
            "template_only": False,
            "presence_only": False,
            "validated": False,
            "approval_status": "draft",
        }
        row.update(overrides)
        return row

    def _content_contract(self, category: str = "synthetic") -> dict[str, object]:
        return {
            "id": category,
            "required_content_fields": sorted(release_validation.REQUIRED_CONTENT_FIELDS),
        }

    def test_release_validation_splits_local_valid_from_external_release_block(self) -> None:
        build_dir = ROOT / "build"
        build_dir.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=build_dir) as tmp_text:
            tmp = Path(tmp_text)
            evidence = tmp / "local-evidence.yaml"
            evidence.write_text(
                yaml.safe_dump(
                    {
                        "artifact_id": "synthetic",
                        "source_requirement_id": "req",
                        "owner": "owner",
                        "created_at": "2026-05-22",
                        "tool_or_supplier_revision": "rev-a",
                        "input_artifact_hashes": {"input": "sha256"},
                        "reviewer": "reviewer",
                        "reviewed_at": "2026-05-22",
                        "disposition": "approved",
                    }
                ),
                encoding="utf-8",
            )
            contract = tmp / "contract.yaml"
            report_path = tmp / "report.yaml"
            contract.write_text(
                yaml.safe_dump(
                    {
                        "schema": "synthetic",
                        "status": "blocked",
                        "content_contracts": [self._content_contract()],
                        "artifact_content_requirements": [
                            self._contract_row(str(evidence))
                        ],
                    }
                ),
                encoding="utf-8",
            )

            report = release_validation.build_report(contract, report_path)
            row = report["validation_rows"][0]

        self.assertEqual(row["local_evidence_validation_state"], "locally_validated")
        self.assertEqual(row["local_validation_failures"], [])
        self.assertEqual(row["external_release_validation_state"], "blocked_fail_closed")
        self.assertFalse(row["release_allowed"])
        self.assertEqual(report["summary"]["locally_validated_row_count"], 1)
        self.assertEqual(report["summary"]["external_release_validated_row_count"], 0)

    def test_release_validation_missing_artifact_remains_local_and_release_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            missing = tmp / "missing.yaml"
            contract = tmp / "contract.yaml"
            report_path = tmp / "report.yaml"
            contract.write_text(
                yaml.safe_dump(
                    {
                        "schema": "synthetic",
                        "status": "blocked",
                        "content_contracts": [self._content_contract()],
                        "artifact_content_requirements": [
                            self._contract_row(str(missing))
                        ],
                    }
                ),
                encoding="utf-8",
            )

            report = release_validation.build_report(contract, report_path)
            row = report["validation_rows"][0]

        self.assertEqual(row["local_evidence_validation_state"], "local_blocked_fail_closed")
        self.assertIn("artifact_missing", row["local_validation_failures"])
        self.assertEqual(row["external_release_validation_state"], "blocked_fail_closed")
        self.assertIn("artifact_missing", row["failures"])

    def test_release_validation_fails_closed_on_unknown_category(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            contract = tmp / "contract.yaml"
            report_path = tmp / "report.yaml"
            contract.write_text(
                yaml.safe_dump(
                    {
                        "schema": "synthetic",
                        "status": "blocked",
                        "content_contracts": [self._content_contract("known")],
                        "artifact_content_requirements": [
                            self._contract_row(str(tmp / "missing.yaml"), category="unknown")
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "no content contract required fields"):
                release_validation.build_report(contract, report_path)

    def test_release_validation_enforces_category_specific_fields(self) -> None:
        build_dir = ROOT / "build"
        build_dir.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=build_dir) as tmp_text:
            tmp = Path(tmp_text)
            evidence = tmp / "first-article.yaml"
            evidence.write_text(
                yaml.safe_dump(
                    {
                        "artifact_id": "synthetic",
                        "source_requirement_id": "req",
                        "owner": "owner",
                        "created_at": "2026-05-22",
                        "tool_or_supplier_revision": "rev-a",
                        "input_artifact_hashes": {"input": "sha256"},
                        "reviewer": "reviewer",
                        "reviewed_at": "2026-05-22",
                        "disposition": "approved",
                    }
                ),
                encoding="utf-8",
            )
            contract = tmp / "contract.yaml"
            report_path = tmp / "report.yaml"
            contract.write_text(
                yaml.safe_dump(
                    {
                        "schema": "synthetic",
                        "status": "blocked",
                        "content_contracts": [
                            {
                                "id": "first_article_bench_evidence",
                                "required_content_fields": [
                                    *sorted(release_validation.REQUIRED_CONTENT_FIELDS),
                                    "board_serial",
                                    "measured_results",
                                    "pass_fail_disposition",
                                ],
                            }
                        ],
                        "artifact_content_requirements": [
                            self._contract_row(
                                str(evidence),
                                category="first_article_bench_evidence",
                            )
                        ],
                    }
                ),
                encoding="utf-8",
            )

            report = release_validation.build_report(contract, report_path)
            row = report["validation_rows"][0]

        self.assertEqual(row["local_evidence_validation_state"], "local_blocked_fail_closed")
        self.assertFalse(row["required_content_fields_present"])
        self.assertIn("board_serial", row["missing_required_content_fields"])
        self.assertIn("measured_results", row["missing_required_content_fields"])
        self.assertIn("pass_fail_disposition", row["missing_required_content_fields"])

    def test_factory_directory_requires_release_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            output_dir = tmp / "production" / "bom"
            output_dir.mkdir(parents=True)
            (output_dir / "random.txt").write_text("nonempty\n", encoding="utf-8")
            self.assertIn(
                "directory_missing_release_manifest",
                factory_content.content_failures(str(output_dir)),
            )

    def test_routed_binary_metadata_must_be_approved_release_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            step = tmp / "routed.step"
            step.write_bytes(b"solid")
            step.with_suffix(".step.metadata.yaml").write_text(
                yaml.safe_dump(
                    {
                        "artifact_id": "routed-step",
                        "source_requirement_id": "req",
                        "owner": "layout",
                        "created_at": "2026-05-22",
                        "reviewer": "reviewer",
                        "reviewed_at": "2026-05-22",
                        "disposition": "draft",
                    }
                ),
                encoding="utf-8",
            )
            failures = routed_content.content_failures(str(step))
            self.assertIn("external_metadata_disposition_not_approved", failures)
            self.assertIn("missing_external_metadata_field:artifact_sha256", failures)
            self.assertIn("missing_external_metadata_field:routed_pcb_hash", failures)

    def test_routed_kicad_text_requires_release_metadata_or_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            pcb = tmp / "e1-phone-mainboard-routed.kicad_pcb"
            pcb.write_text("(kicad_pcb (version 20240108) (segment))\n", encoding="utf-8")

            failures = routed_content.content_failures(str(pcb))

        self.assertIn("missing_text_release_metadata_or_provenance", failures)

    def test_routed_kicad_text_accepts_approved_companion_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            pcb = tmp / "e1-phone-mainboard-routed.kicad_pcb"
            pcb.write_text("(kicad_pcb (version 20240108) (segment))\n", encoding="utf-8")
            pcb.with_suffix(".kicad_pcb.metadata.yaml").write_text(
                yaml.safe_dump(
                    {
                        "artifact_id": "routed-pcb",
                        "source_requirement_id": "route-release",
                        "owner": "layout",
                        "created_at": "2026-05-22",
                        "reviewer": "release-review",
                        "reviewed_at": "2026-05-22",
                        "disposition": "approved",
                        "external_review_authority": "layout-review-board",
                        "signature_or_approval_record": "approval-123",
                        "artifact_sha256": "sha256:pcb",
                        "kicad_project_revision": "rev-a",
                        "routed_pcb_hash": "sha256:routed",
                        "erc_result": "pass",
                        "drc_result": "pass",
                        "stackup_revision": "stackup-a",
                        "impedance_coupon_reference": "coupon-a",
                        "si_pi_rf_report_references": ["si-pi-rf-a"],
                        "fab_output_manifest": "fab-manifest-a",
                        "routed_step_reference": "routed.step",
                    }
                ),
                encoding="utf-8",
            )

            self.assertEqual(routed_content.content_failures(str(pcb)), [])

    def test_routed_kicad_text_accepts_approved_embedded_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            pcb = tmp / "e1-phone-mainboard-routed.kicad_pcb"
            fields = {
                "source_requirement_id": "route-release",
                "owner": "layout",
                "created_at": "2026-05-22",
                "reviewer": "release-review",
                "reviewed_at": "2026-05-22",
                "disposition": "approved",
                "external_review_authority": "layout-review-board",
                "signature_or_approval_record": "approval-123",
                "artifact_sha256": "sha256:pcb",
                "kicad_project_revision": "rev-a",
                "routed_pcb_hash": "sha256:routed",
                "erc_result": "pass",
                "drc_result": "pass",
                "stackup_revision": "stackup-a",
                "impedance_coupon_reference": "coupon-a",
                "si_pi_rf_report_references": "si-pi-rf-a",
                "fab_output_manifest": "fab-manifest-a",
                "routed_step_reference": "routed.step",
            }
            provenance = "\n".join(f"# {key}: {value}" for key, value in fields.items())
            pcb.write_text(
                f"{provenance}\n(kicad_pcb (version 20240108) (segment))\n",
                encoding="utf-8",
            )

            self.assertEqual(routed_content.content_failures(str(pcb)), [])

    def test_first_article_enforces_contract_field_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            record = tmp / "first-article.yaml"
            payload = {
                "artifact_id": "fa",
                "source_requirement_id": "req",
                "owner": "validation",
                "created_at": "2026-05-22",
                "tool_or_supplier_revision": "fixture-a",
                "input_artifact_hashes": {"input": "sha256"},
                "reviewer": "reviewer",
                "reviewed_at": "2026-05-22",
                "disposition": "approved",
                "board_serial_or_lot": "old-field",
                "fixture_or_program_revision": "old-field",
                "limits_revision": "old-field",
                "operator_or_test_station": "old-field",
                "pass_fail_result": "old-field",
                "measurement_summary": {},
                "traceability_ids": [],
            }
            record.write_text(yaml.safe_dump(payload), encoding="utf-8")
            failures = first_article_content.content_failures(str(record), "executed_log")
            self.assertIn("missing_first_article_field:board_serial", failures)
            self.assertIn("missing_first_article_field:fixture_id", failures)
            self.assertIn("missing_first_article_field:pass_fail_disposition", failures)

    def test_first_article_templates_block_even_with_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            template = tmp / "traveler.template.yaml"
            template.write_text("template_empty_not_executed: true\n", encoding="utf-8")
            failures = first_article_content.content_failures(str(template), "template")
            self.assertIn("template_cannot_unlock_release", failures)


class E1PhoneBoardPackageGateTests(unittest.TestCase):
    def test_top_bottom_interconnect_accepts_current_kicad_capture_blocker(self) -> None:
        plan = {
            "status": "blocked_interconnect_requires_connector_stackup_and_si",
            "source_artifacts": [
                "board/kicad/e1-phone/board-topology-decision.yaml",
                "board/kicad/e1-phone/block-netlist.yaml",
                "board/kicad/e1-phone/routing-constraints.yaml",
                "package/interconnect/e1-phone-top-bottom-flex.yaml",
                "package/usb-c/e1-phone-usb-c-port.yaml",
                "package/audio/v0-codec.yaml",
            ],
            "selected_topology": "top_bottom_rigid_islands_with_flex_or_board_to_board",
            "preferred_interconnect_family": "Hirose_BM28",
            "fallback_interconnect_families": [
                "Hirose_FH58_signal_flex_plus_power_tabs",
                "Molex_SlimStack_two_board_stack",
            ],
            "cross_island_buses": [
                {
                    "name": "USB2_FROM_BOTTOM_PORT_TO_TOP_SOC_PD",
                    "nets": ["USB_DP", "USB_DN", "VBUS", "GND"],
                    "routing_constraint_refs": ["USB_DP_DN"],
                },
                {
                    "name": "POWER_FROM_TOP_CHARGER_TO_BOTTOM_IO",
                    "nets": [
                        "SYS",
                        "AON_1V8",
                        "IO_1V8",
                        "VDD_AUDIO_3V3",
                        "VDD_AMP_3V3",
                        "GND",
                    ],
                    "routing_constraint_refs": [],
                },
                {
                    "name": "AUDIO_DIGITAL_TO_BOTTOM_CODEC_MICS",
                    "nets": [
                        "I2S_BCLK",
                        "I2S_LRCLK",
                        "I2S_DOUT",
                        "I2S_DIN",
                        "PDM_CLK",
                        "PDM_DAT",
                    ],
                    "routing_constraint_refs": ["AUDIO_I2S_PDM"],
                },
                {
                    "name": "HAPTIC_AND_FACTORY_TEST",
                    "nets": ["HAPTIC_OUT", "VBUS", "VBAT", "SYS", "RF_VBAT"],
                    "routing_constraint_refs": [],
                },
            ],
            "candidate_connector_stack": {
                "primary": {
                    "family": "Hirose_BM28",
                    "unresolved": [
                        "exact_circuit_count_and_power_contact_count",
                        "mating_pair_orderable_part_numbers",
                    ],
                },
                "signal_flex_alternate": {"family": "Hirose_FH58"},
                "stacked_board_fallback": {
                    "family": "Molex_SlimStack_ACB6_Plus_or_equivalent"
                },
            },
            "minimum_pin_budget": {
                "signal_or_power_nets_counted": 31,
                "required_ground_or_return_pins_min": 12,
                "required_spares_min": 6,
                "recommended_contacts_min": 49,
            },
            "release_blockers": [
                "exact connector circuit count and orderable mating part numbers not selected",
                "flex stackup, bend radius, stiffener, and strain relief not drawn",
                "USB2 and audio SI across the flex not simulated or measured",
                "power contact current rise and return allocation not reviewed",
                "bottom island decoupling, ESD, and test fixture edge pending KiCad capture",
                "assembly sequence for battery insertion and split-board connection not validated",
            ],
            "forbidden_claims": [
                "interconnect_ready",
                "rigid_flex_ready",
                "usb_si_closed",
                "bottom_island_ready",
                "enclosure_ready",
            ],
        }
        binding = {
            "status": "planning_binding_no_connector_stack_selected",
            "primary_candidate": {"family": "Hirose_BM28"},
            "required_cross_island_buses": plan["cross_island_buses"],
        }
        decision = {
            "selected_topology_for_next_repack": {
                "id": "top_bottom_rigid_islands_with_flex_or_board_to_board"
            }
        }
        netlist = {
            "blocks": [
                {
                    "nets": {
                        "all": [
                            net
                            for bus in plan["cross_island_buses"]
                            for net in bus["nets"]
                        ]
                    }
                }
            ],
            "voltage_domains": [],
            "required_shared_nets": {"power": []},
        }
        routing = {
            "differential_pairs": [{"name": "USB_DP_DN"}],
            "single_ended_buses": [{"name": "AUDIO_I2S_PDM"}],
        }

        def fake_load_yaml(path: Path) -> dict:
            name = path.name
            if name == "top-bottom-interconnect-plan.yaml":
                return plan
            if name == "e1-phone-top-bottom-flex.yaml":
                return binding
            if name == "board-topology-decision.yaml":
                return decision
            if name == "block-netlist.yaml":
                return netlist
            if name == "routing-constraints.yaml":
                return routing
            raise AssertionError(f"unexpected fixture path: {path}")

        with mock.patch.object(board_package, "load_yaml", side_effect=fake_load_yaml):
            with redirect_stdout(io.StringIO()):
                board_package.check_top_bottom_interconnect_plan()

    def test_checker_reports_release_not_ready_without_hiding_direct_failures(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_board_package.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertEqual(agg._classify(completed.returncode, combined), "BLOCKED")
        report = json.loads(
            (ROOT / "build/reports/e1_phone_board_package.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn("STATUS: BLOCKED E1 phone board package", combined)
        self.assertFalse(report["summary"]["fabrication_ready"])
        self.assertFalse(report["summary"]["release_evidence_complete"])
        linked_categories = report["summary"]["linked_evidence_blocker_categories"]
        self.assertEqual(linked_categories["true_missing_artifacts"], 0)
        self.assertGreater(linked_categories["present_blocked_placeholders"], 0)
        self.assertGreater(linked_categories["missing_approval_metadata"], 0)
        self.assertGreater(linked_categories["external_supplier_dependencies"], 0)
        self.assertTrue(report["next_unblock_commands"])

    def test_aggregator_classifies_e1_phone_board_package_as_blocked(self) -> None:
        spec = next(gate for gate in agg.GATES if gate.name == "e1-phone-board-package-check")
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertTrue(
            "blocked" in result.evidence.lower()
            or "missing source" in result.evidence.lower()
            or "failed" in result.evidence.lower(),
            result.evidence,
        )

    def test_development_route_snapshot_is_non_release_context(self) -> None:
        report = route_inventory.build_report(
            route_inventory.repo_root(),
            route_inventory.repo_root() / route_inventory.DEFAULT_BOARD,
            route_inventory.repo_root() / route_inventory.DEFAULT_BURNDOWN,
            route_inventory.repo_root() / route_inventory.DEFAULT_REPORT,
        )
        snapshot = report["development_route_snapshot"]

        self.assertIs(snapshot["present"], True)
        self.assertEqual(snapshot["status"], "development_routed_tracks_present_not_release")
        self.assertEqual(snapshot["evidence_class"], "development_routing_visualization_not_release")
        self.assertEqual(snapshot["route_count"], 153)
        self.assertEqual(snapshot["segment_count"], 306)
        self.assertEqual(snapshot["missing_nets"], [])
        self.assertIs(snapshot["release_credit"], False)
        self.assertIs(report["fail_closed_policy"]["fabrication_ready"], False)

    def test_routed_acceptance_carries_development_context_without_unlocking(self) -> None:
        route_report = route_inventory.build_report(
            route_inventory.repo_root(),
            route_inventory.repo_root() / route_inventory.DEFAULT_BOARD,
            route_inventory.repo_root() / route_inventory.DEFAULT_BURNDOWN,
            route_inventory.repo_root() / route_inventory.DEFAULT_REPORT,
        )
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            route_inventory_path = tmp / "route-inventory.yaml"
            route_inventory_path.write_text(yaml.safe_dump(route_report), encoding="utf-8")
            report = routed_acceptance.build_report(
                route_inventory_path,
                routed_acceptance.DEFAULT_BURNDOWN,
                routed_acceptance.DEFAULT_RELEASE_PLAN,
                tmp / "routed.yaml",
                tmp / "routed.md",
            )

        context = report["development_route_context"]
        self.assertIs(context["present"], True)
        self.assertEqual(context["route_count"], 153)
        self.assertEqual(context["segment_count"], 306)
        self.assertIs(context["release_credit"], False)
        self.assertEqual(report["summary"]["acceptance_allowed"], False)
        self.assertGreater(
            report["summary"]["candidate_present_blocked_required_output_path_count"],
            0,
        )
        self.assertEqual(report["summary"]["missing_validation_evidence_category_count"], 0)


class E1PhoneMechanicalCadEvidenceInventoryTests(unittest.TestCase):
    def test_mechanical_inventory_paths_are_chip_relative(self) -> None:
        report = mechanical_inventory.build_report()

        self.assertEqual(
            report["scope"]["cad_output_dir"],
            "mechanical/e1-phone/out",
        )
        self.assertFalse(report["scope"]["cad_output_dir"].startswith("packages/chip/"))
        assembly = report["manifest_inventory"]["assembly"]
        self.assertEqual(
            assembly["path"],
            "mechanical/e1-phone/out/assembly-manifest.json",
        )
        board_step = report["review_gate_inventory"]["routed_board_step_intake"]
        self.assertEqual(
            board_step["path"],
            "mechanical/e1-phone/review/board-step-readiness.json",
        )

    def test_mechanical_resolvers_accept_chip_and_repo_relative_paths(self) -> None:
        chip_relative = "mechanical/e1-phone/review/board-step-readiness.json"
        repo_relative = "packages/chip/mechanical/e1-phone/review/board-step-readiness.json"

        self.assertEqual(
            release_contract.resolve_repo_path(chip_relative),
            release_contract.resolve_repo_path(repo_relative),
        )
        self.assertEqual(
            enclosure_content.repo_path(chip_relative),
            enclosure_content.repo_path(repo_relative),
        )

    def test_local_cad_readiness_does_not_unlock_enclosure_release(self) -> None:
        report = mechanical_inventory.build_report()
        local = report["local_enclosure_cad_ready"]
        release = report["release_enclosure_ready"]
        legacy_release = report["release_readiness"]

        self.assertIs(local["release_claim_allowed"], False)
        self.assertGreater(local["assembly_manifest_part_count"], 0)
        if local["step_validation_passed"]:
            self.assertIs(local["ready"], True)
            self.assertGreater(local["assembly_step_bytes"], 0)
            self.assertGreater(local["step_validation_validated_count"], 0)
        else:
            self.assertIs(local["ready"], False)
            self.assertEqual(local["assembly_step_bytes"], 0)
            self.assertEqual(local["step_validation_validated_count"], 0)

        self.assertIs(release["ready"], False)
        self.assertIs(release["release_claim_allowed"], False)
        self.assertIs(legacy_release["release_ready"], False)
        self.assertGreater(release["missing_required_evidence_count"], 0)

    def test_mechanical_release_blockers_survive_local_cad_readiness(self) -> None:
        report = mechanical_inventory.build_report()
        blocker_ids = {
            row["gate"] for row in report["missing_release_ready_evidence"]
        }

        self.assertEqual(
            blocker_ids,
            {
                "routed_board_step_intake",
                "routed_board_clearance",
                "supplier_evidence",
                "physical_fit_evidence",
                "physical_process_validation",
            },
        )
        board_step = report["review_gate_inventory"]["routed_board_step_intake"]
        self.assertEqual(board_step["production_step_files"], [])
        self.assertTrue(board_step["demo_step_files_ignored"])
        self.assertEqual(
            board_step["required_routed_board_evidence_class"],
            "physical_routed_board_release",
        )


class E1PhoneFabricationReleaseGateTests(unittest.TestCase):
    def _release_report(self) -> dict[str, object]:
        return {
            "schema": fabrication_release.EXPECTED_SCHEMA,
            "summary": {
                "blocked_release_gate_count": 1,
                "total_blocker_count": 1,
                "release_state": "blocked_fail_closed",
                "fabrication_release_allowed": False,
                "enclosure_release_allowed": False,
                "factory_first_article_allowed": False,
                "end_to_end_release_allowed": False,
            },
            "release_gates": [
                {
                    "id": "fabrication_release",
                    "release_allowed": False,
                    "status": "blocked_fail_closed",
                    "blocker_count": 1,
                    "blockers": [{"reason": "missing evidence"}],
                }
            ],
        }

    def test_validate_report_rejects_blocked_count_summary_drift(self) -> None:
        report = self._release_report()
        report["summary"]["blocked_release_gate_count"] = 0

        with self.assertRaisesRegex(ValueError, "blocked_release_gate_count"):
            fabrication_release.validate_report(report)

    def test_validate_report_rejects_release_allowed_blocked_gate(self) -> None:
        report = self._release_report()
        gate = report["release_gates"][0]
        gate["release_allowed"] = True

        with self.assertRaisesRegex(ValueError, "release_allowed=true"):
            fabrication_release.validate_report(report)

    def test_checker_exits_nonzero_and_reports_blocked_release(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_fabrication_release.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined)
        self.assertIn(
            "STATUS: BLOCKED E1 phone fabrication/enclosure/e2e release gate",
            combined,
        )
        report = json.loads(
            (ROOT / "build/reports/e1_phone_fabrication_release.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertTrue(report["blocked_evidence_inventory"])
        gate_blocker = report["blocked_evidence_inventory"][0]
        self.assertIn("gate", gate_blocker)
        self.assertIn("source", gate_blocker)
        self.assertIn("evidence_path", gate_blocker)
        self.assertIn("validation_command", gate_blocker)
        diagnostics = report["blocker_diagnostics"]
        self.assertIn("blocked_by_gate", diagnostics)
        self.assertIn("blocked_by_owner", diagnostics)
        self.assertIn("missing_sources_by_owner", diagnostics)
        categories = diagnostics["fabrication_release_blocker_categories"]
        self.assertEqual(categories["true_missing_artifacts"], 0)
        self.assertGreater(categories["present_blocked_placeholders"], 0)
        self.assertGreater(categories["missing_approval_metadata"], 0)
        self.assertGreater(categories["external_supplier_dependencies"], 0)

    def test_aggregator_classifies_e1_phone_fabrication_release_as_blocked(
        self,
    ) -> None:
        spec = next(gate for gate in agg.GATES if gate.name == "e1-phone-fabrication-release-check")
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone", result.evidence)


class E1PhoneReleaseEvidenceRegenerationGateTests(unittest.TestCase):
    def test_drift_diagnostic_names_generator_sources_and_release_credit(self) -> None:
        parent = ROOT / "build/test-e1-phone-release-evidence-regeneration"
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as tmp_text:
            tmp = Path(tmp_text)
            committed = tmp / "committed.yaml"
            generated = tmp / "generated.yaml"
            source = tmp / "source.yaml"
            committed.write_text("status: old\n", encoding="utf-8")
            generated.write_text("status: new\n", encoding="utf-8")
            source.write_text("status: source\n", encoding="utf-8")
            spec = regeneration_check.OutputSpec(
                generated=generated,
                committed=committed,
                generator_command=("scripts/example_generator.py", "--report", str(generated)),
                source_inputs=(source,),
            )

            failures = regeneration_check.compare_outputs([spec])
            report = regeneration_check.drift_report(failures)

        self.assertEqual(report["status"], "blocked_stale_generated_reports")
        self.assertIs(report["release_credit"], False)
        self.assertEqual(report["summary"]["stale_generated_report_count"], 1)
        finding = report["findings"][0]
        self.assertEqual(finding["code"], "stale_generated_report")
        self.assertIs(finding["release_credit"], False)
        self.assertIn("scripts/example_generator.py", finding["generator_command"])
        self.assertEqual(len(finding["source_inputs"]), 1)
        self.assertTrue(finding["source_inputs"][0]["exists"])

    def test_checker_reports_regeneration_drift_as_blocked_or_pass(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_release_evidence_regeneration.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertIn(completed.returncode, {0, 2}, combined[-4000:])
        self.assertTrue(
            "STATUS: PASS E1 phone release evidence regeneration" in combined
            or "STATUS: BLOCKED E1 phone release evidence regeneration drift detected"
            in combined,
            combined[-4000:],
        )


class E1PhoneReleaseApprovalSignatureGateTests(unittest.TestCase):
    def _approved_row(self, **overrides: object) -> dict[str, object]:
        row: dict[str, object] = {
            "schema": approval_signatures.ROW_SCHEMA,
            "approval_status": "approved",
            "owner": "release-owner",
            "reviewer": "reviewer",
            "captured_at": "2026-05-22T00:00:00Z",
            "revision_or_lot": "rev-a",
            "sha256": "a" * 64,
            "traceability_ids": ["REQ-1"],
            "validated": True,
            "release_allowed": False,
            "template_only": False,
            "presence_only": False,
            "status": "blocked_until_top_level_release_gate_passes",
        }
        row.update(overrides)
        return row

    def test_approval_validity_is_separate_from_release_unlock(self) -> None:
        row = self._approved_row()

        self.assertEqual(approval_signatures.approval_signature_failures(row), [])
        self.assertEqual(approval_signatures.release_failures(row), ["release_not_allowed"])
        self.assertEqual(approval_signatures.row_failures(row), ["release_not_allowed"])

    def test_release_blocked_status_text_does_not_poison_approval_validity(self) -> None:
        row = self._approved_row(
            status="blocked_fail_closed_release_not_unlocked",
            evidence_id="concept-demo-blocked-row",
            traceability_ids=["REQ-1"],
        )

        self.assertEqual(approval_signatures.approval_signature_failures(row), [])
        self.assertEqual(approval_signatures.release_failures(row), ["release_not_allowed"])

    def test_approval_disposition_is_not_placeholder_metadata(self) -> None:
        row = self._approved_row(
            approval_status="missing_or_unvalidated",
            traceability_ids=["REQ-1"],
        )

        self.assertEqual(
            approval_signatures.approval_signature_failures(row),
            ["approval_status_not_approved"],
        )

    def test_missing_traceability_is_bucketed_as_signed_metadata(self) -> None:
        row = self._approved_row(traceability_ids=[])

        self.assertEqual(
            approval_signatures.approval_signature_failures(row),
            ["missing_traceability_ids"],
        )

    def test_approval_rows_are_split_into_action_tracks(self) -> None:
        supplier_row = self._approved_row(
            category="supplier_return_evidence",
            path="board/kicad/e1-phone/production/sourcing/battery_pack/sample-inspection.yaml",
            template_only=False,
        )
        template_row = self._approved_row(
            category="first_article_bench_evidence",
            path="board/kicad/e1-phone/production/test/charger-cc-cv-cycle.template.json",
            template_only=True,
        )
        repo_row = self._approved_row(
            category="mechanical_enclosure_evidence",
            path="mechanical/e1-phone/review/fit-check-report.json",
            template_only=False,
        )

        self.assertEqual(
            approval_signatures.approval_track_for_row(supplier_row),
            "external_supplier_approvals",
        )
        self.assertEqual(
            approval_signatures.approval_track_for_row(template_row),
            "template_only_rows",
        )
        self.assertEqual(
            approval_signatures.approval_track_for_row(repo_row),
            "repo_generated_evidence_approvals",
        )
        self.assertIn(
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            approval_signatures.validation_commands_for_row(supplier_row),
        )
        self.assertIn(
            "python3 scripts/check_e1_phone_first_article_content.py",
            approval_signatures.validation_commands_for_row(template_row),
        )
        self.assertIn(
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            approval_signatures.validation_commands_for_row(repo_row),
        )

    def test_candidate_paths_are_not_approval_signature_eligible(self) -> None:
        rows = [
            self._approved_row(path="board/kicad/e1-phone/production/reports/zone-fill.json"),
            self._approved_row(path="board/kicad/e1-phone/production/reports/drc.json"),
        ]
        candidate_manifest = {
            "artifacts": [
                {
                    "path": "board/kicad/e1-phone/production/reports/zone-fill.json",
                    "metadata": "",
                }
            ]
        }

        self.assertEqual(
            approval_signatures.candidate_path_violations(rows, candidate_manifest),
            ["board/kicad/e1-phone/production/reports/zone-fill.json"],
        )

    def test_checker_exits_nonzero_and_reports_blocked_approvals(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_release_approval_signatures.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone release approval signatures",
            combined,
        )
        self.assertIn("approval_valid=", combined)
        self.assertIn("release_blocked=", combined)
        report = json.loads(
            (ROOT / "build/reports/e1_phone_release_approval_signatures.json").read_text(
                encoding="utf-8"
            )
        )
        matrix = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/readiness/"
                "release-approval-signature-blocker-matrix-2026-05-23.yaml"
            ).read_text(encoding="utf-8")
        )
        self.assertIn("failure_counts", report["summary"])
        self.assertIn("blocker_bucket_counts", report["summary"])
        self.assertIn("approval_blocker_categories", report["summary"])
        self.assertIn("approval_track_counts", report["summary"])
        self.assertIn("approval_track_summaries", report["summary"])
        self.assertIn("signed_metadata_field_summary", report["summary"])
        self.assertIn("blocked_category_counts", report["summary"])
        self.assertIn("blocked_owner_counts", report["summary"])
        self.assertIn("next_unblock_groups", report["summary"])
        self.assertIs(report["release_credit"], False)
        self.assertEqual(
            report["approval_contract"]["required_signed_metadata_fields"],
            sorted(approval_signatures.REQUIRED_SIGNED_METADATA_FIELDS),
        )
        self.assertGreater(
            report["summary"]["failure_counts"]["release_not_allowed"],
            0,
        )
        blocker_categories = report["summary"]["approval_blocker_categories"]
        for category_id in (
            "missing_owner",
            "missing_reviewer",
            "missing_captured_at",
            "missing_sha256",
            "missing_traceability_ids",
            "release_disposition_not_unlocked",
        ):
            self.assertIn(category_id, blocker_categories)
            self.assertGreater(blocker_categories[category_id]["blocked_rows"], 0)
            self.assertFalse(blocker_categories[category_id]["release_credit"])
            self.assertIn(
                "required_signed_metadata_fields",
                blocker_categories[category_id],
            )
        self.assertTrue(report["blocked_evidence_inventory"])
        approval_blocker = report["blocked_evidence_inventory"][0]
        self.assertIn("missing_fields", approval_blocker)
        self.assertIn("validation_command", approval_blocker)
        self.assertIn("supplier_family", approval_blocker)
        self.assertIn("approval_authority", approval_blocker)
        self.assertIn("accepted_record_paths", approval_blocker)
        self.assertIn("required_signed_metadata_fields", approval_blocker)
        self.assertIn("traceability_ids", approval_blocker)
        self.assertIs(approval_blocker["release_credit"], False)
        self.assertIn("approval_status", approval_blocker["required_signed_metadata_fields"])
        self.assertIn("traceability_ids", approval_blocker["required_signed_metadata_fields"])
        self.assertIn("approval_track", approval_blocker)
        self.assertIn("missing_signed_metadata_fields", approval_blocker)
        self.assertIn("owner_action_summary", approval_blocker)
        self.assertIn("validation_commands", approval_blocker)
        self.assertIn(
            "board/kicad/e1-phone/production/readiness/release-evidence-content-contract-2026-05-22.yaml",
            approval_blocker["accepted_record_paths"],
        )
        track_counts = report["summary"]["approval_track_counts"]
        self.assertGreater(track_counts["external_supplier_approvals"], 0)
        self.assertGreater(track_counts["repo_generated_evidence_approvals"], 0)
        self.assertEqual(track_counts["template_only_rows"], 6)
        self.assertEqual(
            report["summary"]["template_only_row_count"],
            track_counts["template_only_rows"],
        )
        self.assertEqual(
            report["summary"]["external_supplier_approval_count"],
            track_counts["external_supplier_approvals"],
        )
        self.assertEqual(
            report["summary"]["repo_generated_evidence_approval_count"],
            track_counts["repo_generated_evidence_approvals"],
        )
        supplier_track = report["summary"]["approval_track_summaries"][
            "external_supplier_approvals"
        ]
        self.assertIn("owner", supplier_track)
        self.assertIn("action", supplier_track)
        self.assertIn("validation_commands", supplier_track)
        self.assertFalse(supplier_track["release_credit"])
        self.assertIn(
            "python3 scripts/check_e1_phone_supplier_return_content.py",
            supplier_track["validation_commands"],
        )
        metadata_summary = report["summary"]["signed_metadata_field_summary"]
        self.assertEqual(metadata_summary["field_counts"]["owner"], report["summary"]["rows"])
        self.assertEqual(
            metadata_summary["field_counts"]["reviewer"],
            report["summary"]["rows"],
        )
        self.assertTrue(
            all(row["release_credit"] is False for row in report["summary"]["next_unblock_groups"])
        )
        unblock_ids = {row["id"] for row in report["summary"]["next_unblock_groups"]}
        self.assertIn("missing_owner", unblock_ids)
        self.assertIn("missing_reviewer", unblock_ids)
        self.assertIn("missing_traceability_ids", unblock_ids)
        self.assertIn("missing_or_rejected_approval_disposition", unblock_ids)
        self.assertIn("release_disposition_not_unlocked", unblock_ids)
        self.assertEqual(
            matrix["schema"],
            "eliza.e1_phone_release_approval_signature_blocker_matrix.v1",
        )
        self.assertEqual(matrix["status"], "blocked")
        self.assertFalse(matrix["summary"]["release_credit"])
        self.assertEqual(
            matrix["summary"]["blocker_bucket_counts"],
            report["summary"]["blocker_bucket_counts"],
        )
        self.assertTrue(
            all(row["release_credit"] is False for row in matrix["blocker_buckets"])
        )
        self.assertEqual(
            matrix["approval_tracks"],
            report["summary"]["approval_track_summaries"],
        )
        self.assertEqual(
            matrix["signed_metadata_field_summary"],
            report["summary"]["signed_metadata_field_summary"],
        )

    def test_current_approval_rows_exclude_local_candidates(self) -> None:
        contract = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/readiness/"
                "release-evidence-content-contract-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )
        candidate_manifest = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )
        factory_candidate_manifest = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )

        self.assertEqual(
            approval_signatures.candidate_path_violations(
                contract["artifact_content_requirements"],
                candidate_manifest,
            ),
            [],
        )
        self.assertEqual(
            approval_signatures.candidate_path_violations(
                contract["artifact_content_requirements"],
                factory_candidate_manifest,
            ),
            [],
        )
        self.assertGreater(len(contract.get("local_candidate_content_requirements", [])), 0)

    def test_candidate_directories_are_not_locally_validated(self) -> None:
        row = {
            "evidence_id": "candidate-dir",
            "category": "production_factory_outputs",
            "path": "board/kicad/e1-phone/production/bom",
            "source_matrix": "test",
            "release_allowed": False,
            "template_only": False,
            "presence_only": True,
            "validated": False,
            "approval_status": "missing_or_unvalidated",
        }
        fields = {
            "production_factory_outputs": {
                "artifact_id",
                "source_requirement_id",
                "owner",
                "created_at",
                "tool_or_supplier_revision",
                "input_artifact_hashes",
                "reviewer",
                "reviewed_at",
                "disposition",
                "release_package_revision",
                "fab_vendor_or_assembler",
                "program_or_fixture_revision",
                "limits_revision",
                "calibration_state",
                "lot_or_serial_traceability",
            }
        }
        findings = release_validation.content_findings(
            row,
            release_validation.resolve_path(row["path"]),
            fields,
        )

        self.assertEqual(
            findings["local_evidence_validation_state"],
            "local_blocked_fail_closed",
        )
        self.assertIn(
            "directory_manifest_release_not_allowed",
            findings["local_validation_failures"],
        )

    def test_routed_candidate_manifest_keeps_measured_outputs_absent(self) -> None:
        matrix = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/readiness/"
                "routed-board-release-acceptance-matrix-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )
        manifest = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )

        self.assertEqual(manifest["status"], "blocked_local_candidate_outputs_not_release")
        self.assertFalse(manifest["release_credit"])
        manifest_paths = {artifact["path"] for artifact in manifest["artifacts"]}
        self.assertIn(
            "board/kicad/e1-phone/production/reports/si-pi/pcie-cellular-wifi.json",
            manifest_paths,
        )
        self.assertIn(
            "board/kicad/e1-phone/production/reports/rf/sar-prescan-plan.json",
            manifest_paths,
        )
        self.assertIn(
            "board/kicad/e1-phone/production/pdf/assembly.pdf",
            manifest_paths,
        )
        self.assertIn(
            "board/kicad/e1-phone/production/pdf/split-interconnect-assembly.pdf",
            manifest_paths,
        )
        self.assertIn(
            "board/kicad/e1-phone/production/reports/rf/conducted-cellular-wifi-bt.json",
            manifest_paths,
        )
        self.assertIn(
            "board/kicad/e1-phone/production/reports/power-thermal/load-step.json",
            manifest_paths,
        )
        self.assertEqual(
            len(routed_content.collect_required_outputs(matrix, include_present_validation_artifacts=False)),
            matrix["summary"]["required_output_path_count"],
        )
        self.assertGreater(
            len(routed_content.collect_required_outputs(matrix)),
            matrix["summary"]["required_output_path_count"],
        )
        self.assertGreater(
            matrix["summary"]["candidate_present_blocked_required_output_path_count"],
            0,
        )
        self.assertEqual(matrix["summary"]["truly_missing_required_output_path_count"], 0)
        self.assertFalse(matrix["summary"]["acceptance_allowed"])
        self.assertEqual(matrix["summary"]["release_state"], "blocked_fail_closed")

    def test_direct_phone_gates_honor_report_argument(self) -> None:
        report_dir = ROOT / "build/reports/test-direct-phone-gates"
        cases = [
            (
                "scripts/check_e1_phone_routed_output_content.py",
                report_dir / "routed-output.json",
                "blocked",
            ),
            (
                "scripts/check_e1_phone_enclosure_mechanical_content.py",
                report_dir / "enclosure-mechanical.json",
                "blocked",
            ),
            (
                "scripts/check_e1_phone_fabrication_release.py",
                report_dir / "fabrication-release.json",
                "blocked",
            ),
            (
                "scripts/check_e1_phone_release_approval_signatures.py",
                report_dir / "release-approval-signatures.json",
                "blocked",
            ),
        ]

        for script, report_path, expected_status in cases:
            if report_path.exists():
                report_path.unlink()
            completed = subprocess.run(
                [sys.executable, script, "--report", str(report_path)],
                cwd=ROOT,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
            self.assertTrue(report_path.is_file(), f"{script} did not write {report_path}")
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], expected_status)
            self.assertFalse(report["summary"]["release_ready"])

    def test_aggregator_classifies_e1_phone_release_approvals_as_blocked(
        self,
    ) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-release-approval-signature-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone release approval", result.evidence)


class E1PhoneSupplierReturnContentGateTests(unittest.TestCase):
    def test_supplier_return_scope_accepts_function_named_archives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            archive = tmp / "usb_pd_controller" / "rfq-response-pack.yaml"
            archive.parent.mkdir(parents=True)
            archive.write_text(
                yaml.safe_dump(
                    {
                        "artifact_id": "usb_pd_controller:rfq_response_pack",
                        "source_requirement_id": "usb_pd_controller",
                        "owner": "sourcing:charger_pd",
                        "created_at": "blocked_pending_supplier_return",
                        "tool_or_supplier_revision": "blocked_pending_supplier_return",
                        "input_artifact_hashes": ["blocked_pending_supplier_return"],
                        "reviewer": "blocked_pending_supplier_return",
                        "reviewed_at": "blocked_pending_supplier_return",
                        "disposition": "blocked_pending_supplier_return",
                        "supplier_name": "blocked_pending_supplier_return",
                        "supplier_part_number": "blocked_pending_supplier_return",
                        "manufacturer_part_number": "blocked_pending_supplier_return",
                        "drawing_revision": "blocked_pending_supplier_return",
                        "sample_lot_or_quote_id": "blocked_pending_supplier_return",
                        "signed_supplier_response": False,
                        "pinout_or_land_pattern_source": "blocked_pending_supplier_return",
                        "mechanical_model_source": "blocked_pending_supplier_return",
                    }
                ),
                encoding="utf-8",
            )

            failures = supplier_content.evidence_failures(
                "charger_pd",
                {
                    "evidence_class": "rfq_response_pack",
                    "expected_local_intake_path": str(archive),
                },
                function="usb_pd_controller",
            )

        self.assertNotIn("artifact_path_not_lane_scoped", failures)
        self.assertIn("disposition_not_approved", failures)

    def test_supplier_csv_return_requires_signed_external_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            csv_path = tmp / "display_touch-pinout.csv"
            csv_path.write_text(
                "net_or_pin,supplier_pin_name,source_revision\n"
                "MIPI_D0P,D0P,rev-a\n",
                encoding="utf-8",
            )

            failures = supplier_content.evidence_failures(
                "display_touch",
                {"expected_local_intake_path": str(csv_path)},
            )

        self.assertIn("missing_external_signed_review_metadata", failures)

    def test_supplier_external_metadata_must_be_approved_and_non_placeholder(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            step_path = tmp / "display_touch-supplier-model.step"
            step_path.write_text("ISO-10303-21;\n", encoding="utf-8")
            step_path.with_suffix(".step.metadata.yaml").write_text(
                yaml.safe_dump(
                    {
                        "artifact_id": "display_touch_supplier_model",
                        "source_requirement_id": "REQ-DISPLAY-001",
                        "owner": "sourcing:display_touch",
                        "created_at": "2026-05-22",
                        "tool_or_supplier_revision": "supplier-rev-a",
                        "input_artifact_hashes": ["sha256:example"],
                        "reviewer": "mechanical",
                        "reviewed_at": "2026-05-22",
                        "disposition": "blocked",
                        "supplier_name": "placeholder supplier",
                        "supplier_part_number": "DT-001",
                        "manufacturer_part_number": "MFG-DT-001",
                        "drawing_revision": "A",
                        "sample_lot_or_quote_id": "Q-001",
                        "signed_supplier_response": "unsigned",
                        "pinout_or_land_pattern_source": "supplier pack",
                        "mechanical_model_source": "supplier STEP",
                    }
                ),
                encoding="utf-8",
            )

            failures = supplier_content.evidence_failures(
                "display_touch",
                {"expected_local_intake_path": str(step_path)},
            )

        self.assertIn("external_metadata_disposition_not_approved", failures)
        self.assertIn("external_metadata_placeholder_or_blocked_marker_present", failures)

    def test_downstream_release_placeholder_is_classified_without_supplier_type_noise(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp_text:
            tmp = Path(tmp_text)
            schematic = tmp / "e1-phone.kicad_sch"
            schematic.write_text(
                yaml.safe_dump(
                    {
                        "schema": "eliza.e1_phone_supplier_return_intake_placeholder.v1",
                        "artifact_id": "display_touch:production_schematic_capture",
                        "source_requirement_id": "display_touch",
                        "owner": "sourcing:display_touch",
                        "created_at": "blocked_pending_supplier_return",
                        "tool_or_supplier_revision": "blocked_pending_supplier_return",
                        "input_artifact_hashes": ["blocked_pending_supplier_return"],
                        "reviewer": "blocked_pending_supplier_return",
                        "reviewed_at": "blocked_pending_supplier_return",
                        "disposition": "blocked_pending_supplier_return",
                        "supplier_name": "blocked_pending_supplier_return",
                        "supplier_part_number": "blocked_pending_supplier_return",
                        "manufacturer_part_number": "blocked_pending_supplier_return",
                        "drawing_revision": "blocked_pending_supplier_return",
                        "sample_lot_or_quote_id": "blocked_pending_supplier_return",
                        "signed_supplier_response": False,
                        "pinout_or_land_pattern_source": "blocked_pending_supplier_return",
                        "mechanical_model_source": "blocked_pending_supplier_return",
                        "expected_intake_path": str(schematic),
                        "evidence_class": "production_schematic_capture",
                        "release_credit": False,
                    }
                ),
                encoding="utf-8",
            )

            failures = supplier_content.evidence_failures(
                "display_touch",
                {
                    "evidence_class": "production_schematic_capture",
                    "expected_local_intake_path": str(schematic),
                },
            )

        self.assertIn("downstream_release_disposition_not_approved", failures)
        self.assertIn("downstream_release_placeholder_or_blocked_marker_present", failures)
        self.assertNotIn("unsupported_supplier_artifact_type", failures)
        self.assertNotIn("artifact_path_not_lane_scoped", failures)

    def test_checker_exits_nonzero_and_reports_blocked_supplier_content(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_supplier_return_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone supplier-return content",
            combined,
        )
        report = json.loads(
            (ROOT / "build/reports/e1_phone_supplier_return_content.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(report["status"], "blocked")
        self.assertGreater(report["summary"]["blocked"], 0)
        self.assertTrue(report["findings"])
        self.assertTrue(report["blocked_evidence_inventory"])
        first_blocker = report["blocked_evidence_inventory"][0]
        self.assertIn("expected_path", first_blocker)
        self.assertIn("supplier_family", first_blocker)
        self.assertIn("approval_authority", first_blocker)
        self.assertIn("accepted_record_targets", first_blocker)
        self.assertIn("required_signed_metadata_fields", first_blocker)
        self.assertIn("owner", first_blocker)
        self.assertIn("validation_command", first_blocker)
        self.assertIs(first_blocker["release_credit"], False)
        self.assertTrue(first_blocker["accepted_record_targets"]["accepted_record_paths"])
        self.assertIn(
            "signed_supplier_response",
            first_blocker["required_signed_metadata_fields"]["supplier_traceability"],
        )
        diagnostics = report["blocker_diagnostics"]
        self.assertIn("blocked_by_lane", diagnostics)
        self.assertIn("blocked_by_evidence_group", diagnostics)
        self.assertIn("blocked_by_evidence_class", diagnostics)
        self.assertIn("blocked_by_failure", diagnostics)
        self.assertIn("missing_paths_by_lane", diagnostics)
        external_dependencies = diagnostics["external_supplier_dependency_summary"]
        self.assertGreater(external_dependencies["external_supplier_return_rows"], 0)
        self.assertGreater(
            external_dependencies["downstream_release_rows_waiting_on_supplier_returns"],
            0,
        )
        self.assertEqual(
            external_dependencies["true_missing_supplier_return_artifacts"], 0
        )
        self.assertIn("validation_command", external_dependencies)
        self.assertGreater(diagnostics["blocked_by_evidence_group"]["supplier_return"], 0)
        self.assertGreater(
            diagnostics["blocked_by_evidence_group"]["downstream_release_evidence"],
            0,
        )
        categories = diagnostics["supplier_return_blocker_categories"]
        primary_categories = diagnostics["primary_supplier_return_blocker_categories"]
        self.assertEqual(categories["true_missing_supplier_return_artifacts"], 0)
        self.assertEqual(categories["template_only_rows"], 0)
        self.assertGreater(categories["missing_approval_metadata"], 0)
        self.assertGreater(categories["candidate_present_but_blocked"], 0)
        self.assertGreater(categories["present_unapproved_or_placeholder"], 0)
        self.assertEqual(sum(primary_categories.values()), report["summary"]["blocked"])
        self.assertEqual(
            report["summary"]["supplier_return_blocker_categories"],
            categories,
        )
        self.assertNotIn("unsupported_supplier_artifact_type", diagnostics["blocked_by_failure"])
        self.assertNotIn("artifact_path_not_lane_scoped", diagnostics["blocked_by_failure"])
        approval_summary = diagnostics["approval_metadata_unblock_summary"]
        self.assertEqual(
            [row["id"] for row in approval_summary],
            [
                "attach_external_signed_review_metadata",
                "complete_supplier_approval_metadata_fields",
                "approve_and_deplaceholder_supplier_records",
            ],
        )
        self.assertTrue(all(row["release_credit"] is False for row in approval_summary))
        self.assertGreater(approval_summary[1]["blocked_rows"], 0)
        self.assertIn("validation_command", approval_summary[0])
        self.assertIn("approval_authority", approval_summary[0])
        self.assertIn("required_signed_metadata_fields", approval_summary[0])

    def test_aggregator_classifies_e1_phone_supplier_content_as_blocked(
        self,
    ) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-supplier-return-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone supplier-return", result.evidence)


class E1PhoneRoutedOutputContentGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_routed_content(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_routed_output_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone routed-output content",
            combined,
        )
        self.assertIn("content_valid=", combined)
        report = json.loads(
            (ROOT / "build/reports/e1_phone_routed_output_content.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(report["status"], "blocked")
        self.assertIn("present", report["summary"])
        self.assertIn("content_valid", report["summary"])
        self.assertGreater(report["summary"]["blocked"], 0)
        self.assertEqual(report["summary"]["missing_outputs"], 0)
        self.assertGreater(report["summary"]["candidate_present_blocked_count"], 0)
        self.assertEqual(report["summary"]["true_missing_generated_output_count"], 0)
        self.assertEqual(report["summary"]["missing_approval_metadata_count"], 0)
        self.assertGreater(report["summary"]["candidate_present_but_blocked_count"], 0)
        self.assertIn("repo_generated_candidate_blocked_count", report["summary"])
        self.assertIn("external_release_evidence_required_count", report["summary"])
        self.assertEqual(
            report["summary"]["release_credit_false_count"],
            report["summary"]["blocked"],
        )
        self.assertTrue(report["findings"])
        self.assertTrue(report["blocked_evidence_inventory"])
        routed_blocker = report["blocked_evidence_inventory"][0]
        self.assertIn("path", routed_blocker)
        self.assertIn("current_path", routed_blocker)
        self.assertIn("candidate_path", routed_blocker)
        self.assertIn("required_production_artifact_class", routed_blocker)
        self.assertIn("metadata_record", routed_blocker)
        self.assertIn("source_manifest_refs", routed_blocker)
        self.assertIn("action", routed_blocker)
        self.assertIn("validation_command", routed_blocker)
        self.assertIn("next_validation_commands", routed_blocker)
        self.assertFalse(routed_blocker["release_credit"])
        diagnostics = report["blocker_diagnostics"]
        self.assertIn("blocked_by_owner", diagnostics)
        self.assertIn("blocked_by_source_id", diagnostics)
        self.assertIn("blocked_by_required_status", diagnostics)
        self.assertIn("blocked_by_failure", diagnostics)
        self.assertIn("present_blocked_paths", diagnostics)
        self.assertIn("next_unblock_groups", diagnostics)
        approval_summary = diagnostics["approval_metadata_unblock_summary"]
        self.assertEqual(
            [row["id"] for row in approval_summary],
            [
                "attach_routed_external_review_metadata",
                "add_text_release_metadata_or_provenance",
                "complete_routed_approval_metadata_fields",
                "approve_and_deplaceholder_routed_records",
            ],
        )
        self.assertTrue(all(row["release_credit"] is False for row in approval_summary))
        self.assertGreaterEqual(approval_summary[0]["blocked_rows"], 0)
        self.assertGreater(approval_summary[2]["blocked_rows"], 0)
        blocker_categories = report["routed_output_blocker_categories"]
        self.assertFalse(blocker_categories["release_credit"])
        self.assertEqual(
            sum(blocker_categories["counts"].values()),
            report["summary"]["blocked"],
        )
        self.assertEqual(
            blocker_categories["counts"]["true_missing_generated_outputs"],
            0,
        )
        self.assertEqual(
            blocker_categories["counts"]["missing_approval_metadata"],
            0,
        )
        self.assertEqual(
            blocker_categories["release_credit_false_artifacts"]["count"],
            report["summary"]["blocked"],
        )
        self.assertGreater(
            blocker_categories["counts"]["present_unapproved_or_placeholder"],
            0,
        )
        self.assertGreater(
            blocker_categories["counts"]["candidate_present_but_blocked"],
            0,
        )
        self.assertEqual(
            blocker_categories["by_path"]["board/kicad/e1-phone/production/stackup"][
                "category"
            ],
            "present_unapproved_or_placeholder",
        )
        stackup_category = blocker_categories["by_path"][
            "board/kicad/e1-phone/production/stackup"
        ]
        self.assertTrue(stackup_category["release_credit_false"])
        self.assertIn("failure_buckets", stackup_category)
        self.assertIn("candidate_fail_closed_metadata", stackup_category)
        self.assertIn("required_metadata_record", stackup_category)
        self.assertIn("repo_generation_plan", stackup_category)
        generation = report["repo_generation_summary"]
        self.assertFalse(generation["release_credit"])
        self.assertEqual(generation["true_missing_generated_artifact_count"], 0)
        self.assertGreater(generation["generator_command_available_count"], 0)
        self.assertEqual(
            generation["external_release_evidence_required_count"],
            report["summary"]["blocked"],
        )
        self.assertIn(
            "generate_e1_phone_routed_output_candidates.py",
            generation["generator_command"],
        )
        coverage = report["candidate_manifest_coverage"]
        self.assertEqual(
            coverage["candidate_manifest"],
            "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
        )
        self.assertTrue(coverage["candidate_manifest_present"])
        self.assertFalse(coverage["candidate_release_credit"])
        self.assertGreater(coverage["candidate_artifact_count"], 0)
        self.assertGreater(coverage["candidate_present_but_blocked_count"], 0)
        self.assertEqual(
            coverage["missing_required_paths_not_in_candidate_manifest_count"],
            0,
        )
        packet_inventory = report["routed_execution_packet_inventory"]
        self.assertEqual(len(packet_inventory), report["summary"]["blocked"])
        self.assertTrue(all(row["release_credit"] is False for row in packet_inventory))
        self.assertTrue(
            all(
                row["next_validation_commands"]
                == ["python3 scripts/check_e1_phone_routed_output_content.py"]
                for row in packet_inventory
            )
        )
        pcb_packet = next(
            row
            for row in packet_inventory
            if row["path"] == "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
        )
        self.assertEqual(pcb_packet["current_path"], pcb_packet["path"])
        self.assertEqual(pcb_packet["candidate_path"], pcb_packet["path"])
        self.assertEqual(
            pcb_packet["required_production_artifact_class"],
            "routed_kicad_pcb",
        )
        self.assertEqual(
            pcb_packet["metadata_record"]["record_type"],
            "text_release_metadata_or_embedded_provenance",
        )
        self.assertIn("board/kicad/e1-phone/production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml", {ref["manifest"] for ref in pcb_packet["source_manifest_refs"]})
        self.assertFalse(pcb_packet["release_credit"])

    def test_aggregator_classifies_e1_phone_routed_content_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-routed-output-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone routed-output", result.evidence)


class E1PhoneFactoryOutputContentGateTests(unittest.TestCase):
    def test_factory_candidate_manifest_is_non_release_and_leaves_outputs_blocked(
        self,
    ) -> None:
        manifest = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/"
                "factory-output-candidate-manifest-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )
        inventory = yaml.safe_load(
            (
                ROOT
                / "board/kicad/e1-phone/production/readiness/"
                "production-factory-required-output-presence-inventory-2026-05-22.yaml"
            ).read_text(encoding="utf-8")
        )
        artifact_paths = {row["path"] for row in manifest["artifacts"]}

        self.assertEqual(
            manifest["status"],
            "blocked_local_factory_output_candidates_not_release",
        )
        self.assertIs(manifest["release_credit"], False)
        self.assertGreater(manifest["artifact_count"], 0)
        self.assertLess(
            inventory["summary"]["missing_required_output_path_count"],
            inventory["summary"]["required_output_path_count"],
        )
        self.assertGreater(
            inventory["summary"]["candidate_present_blocked_required_output_path_count"],
            0,
        )
        self.assertEqual(inventory["summary"]["truly_missing_required_output_path_count"], 0)
        self.assertEqual(inventory["summary"]["release_state"], "blocked_fail_closed")
        self.assertIn(
            "board/kicad/e1-phone/production/stackup/field-solved-impedance-table.csv",
            artifact_paths,
        )
        self.assertTrue(
            (
                ROOT
                / "board/kicad/e1-phone/production/stackup/"
                "field-solved-impedance-table.csv"
            ).exists()
        )

    def test_checker_exits_nonzero_and_reports_blocked_factory_content(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_factory_output_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone factory-output content",
            combined,
        )
        report = json.loads(
            (ROOT / "build/reports/e1_phone_factory_output_content.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(report["summary"]["present"], report["summary"]["path_exists_count"])
        self.assertNotEqual(
            report["summary"]["present"],
            report["summary"]["content_valid_count"],
        )
        self.assertIn("repo_generated_candidate_blocked_count", report["summary"])
        self.assertIn("external_release_evidence_required_count", report["summary"])
        self.assertTrue(report["blocked_evidence_inventory"])
        factory_blocker = report["blocked_evidence_inventory"][0]
        self.assertIn("path", factory_blocker)
        self.assertIn("current_path", factory_blocker)
        self.assertIn("candidate_path", factory_blocker)
        self.assertIn("required_production_artifact_class", factory_blocker)
        self.assertIn("metadata_record", factory_blocker)
        self.assertIn("source_manifest_refs", factory_blocker)
        self.assertIn("owner", factory_blocker)
        self.assertIn("validation_command", factory_blocker)
        self.assertIn("next_validation_commands", factory_blocker)
        self.assertFalse(factory_blocker["release_credit"])
        diagnostics = report["blocker_diagnostics"]
        self.assertIn("blocked_by_owner", diagnostics)
        self.assertIn("blocked_by_source_id", diagnostics)
        self.assertIn("blocked_by_failure", diagnostics)
        self.assertIn("present_blocked_paths", diagnostics)
        approval_summary = diagnostics["approval_metadata_unblock_summary"]
        self.assertEqual(
            [row["id"] for row in approval_summary],
            [
                "attach_factory_external_review_metadata",
                "complete_factory_approval_metadata_fields",
                "approve_and_deplaceholder_factory_records",
            ],
        )
        self.assertTrue(all(row["release_credit"] is False for row in approval_summary))
        self.assertGreaterEqual(approval_summary[0]["blocked_rows"], 0)
        self.assertGreaterEqual(approval_summary[1]["blocked_rows"], 0)
        blocker_categories = report["factory_output_blocker_categories"]
        self.assertFalse(blocker_categories["release_credit"])
        self.assertEqual(
            sum(blocker_categories["counts"].values()),
            report["summary"]["blocked"],
        )
        self.assertEqual(
            blocker_categories["counts"]["true_missing_factory_outputs"],
            0,
        )
        self.assertEqual(
            blocker_categories["counts"]["missing_approval_metadata"],
            0,
        )
        self.assertGreater(
            blocker_categories["counts"]["candidate_present_but_blocked"],
            0,
        )
        self.assertGreater(
            blocker_categories["counts"]["present_unapproved_or_placeholder"],
            0,
        )
        self.assertEqual(
            blocker_categories["by_path"][
                "board/kicad/e1-phone/production/bom"
            ]["category"],
            "candidate_present_but_blocked",
        )
        self.assertEqual(
            blocker_categories["by_path"][
                "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
            ]["category"],
            "present_unapproved_or_placeholder",
        )
        coverage = report["candidate_manifest_coverage"]
        self.assertEqual(
            coverage["candidate_manifest"],
            "board/kicad/e1-phone/production/factory-output-candidate-manifest-2026-05-22.yaml",
        )
        self.assertTrue(coverage["candidate_manifest_present"])
        self.assertFalse(coverage["candidate_release_credit"])
        self.assertGreater(coverage["candidate_artifact_count"], 0)
        self.assertGreater(coverage["candidate_present_but_blocked_count"], 0)
        self.assertEqual(
            coverage["missing_required_paths_not_in_candidate_manifest_count"],
            0,
        )
        self.assertEqual(coverage["candidate_paths_not_required_by_inventory_count"], 1)
        self.assertIn(
            "board/kicad/e1-phone/production/reports/power-thermal/load-step.json",
            coverage["candidate_paths_not_required_by_inventory"],
        )
        self.assertEqual(
            coverage["candidate_paths_not_required_by_inventory_blocked_count"],
            1,
        )
        packet_inventory = report["factory_execution_packet_inventory"]
        self.assertEqual(len(packet_inventory), report["summary"]["blocked"])
        self.assertTrue(all(row["release_credit"] is False for row in packet_inventory))
        self.assertTrue(
            all(
                row["next_validation_commands"][0]
                == "python3 scripts/check_e1_phone_factory_output_content.py"
                for row in packet_inventory
            )
        )
        self.assertTrue(
            all("first_article_consumer_count" in row for row in packet_inventory)
        )
        self.assertTrue(
            all("bridges_first_article_execution" in row for row in packet_inventory)
        )
        bridge = report["factory_first_article_bridge"]
        self.assertFalse(bridge["release_credit"])
        self.assertEqual(
            bridge["blocked_first_article_consumer_rows"],
            report["summary"]["blocked"],
        )
        self.assertEqual(
            bridge["factory_blocked_paths_with_first_article_consumers"],
            report["summary"]["blocked"],
        )
        self.assertEqual(
            bridge["consumer_rows_by_factory_blocker_category"][
                "candidate_present_but_blocked"
            ],
            blocker_categories["counts"]["candidate_present_but_blocked"],
        )
        self.assertEqual(
            bridge["consumer_rows_by_factory_blocker_category"][
                "present_unapproved_or_placeholder"
            ],
            blocker_categories["counts"]["present_unapproved_or_placeholder"],
        )
        self.assertIn(
            "board/kicad/e1-phone/production/bom",
            bridge["by_factory_path"],
        )
        directory_packet = next(
            row
            for row in packet_inventory
            if row["path"] == "board/kicad/e1-phone/production/bom"
        )
        self.assertIn("repo_generation_plan", directory_packet)
        self.assertTrue(directory_packet["repo_generation_plan"]["repo_generated_candidate"])
        self.assertIn(
            "generate_e1_phone_factory_output_candidates.py",
            directory_packet["repo_generation_plan"]["generator_command"],
        )
        self.assertTrue(directory_packet["bridges_first_article_execution"])
        self.assertEqual(directory_packet["first_article_consumer_count"], 1)
        self.assertEqual(
            directory_packet["first_article_consumers"][0]["validation_command"],
            "python3 scripts/check_e1_phone_first_article_content.py",
        )
        self.assertEqual(
            directory_packet["metadata_record"]["record_type"],
            "directory_release_manifest",
        )
        self.assertEqual(
            directory_packet["required_production_artifact_class"],
            "factory_release_directory_manifest",
        )
        self.assertEqual(directory_packet["current_path"], directory_packet["path"])
        self.assertIn(
            "board/kicad/e1-phone/production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml",
            {ref["manifest"] for ref in directory_packet["source_manifest_refs"]},
        )
        self.assertEqual(
            directory_packet["metadata_record"]["primary_record_path"],
            "board/kicad/e1-phone/production/bom/release-manifest.yaml",
        )
        self.assertIn(
            "lot_or_serial_traceability",
            directory_packet["required_field_groups"]["factory_traceability"],
        )
        self.assertIn(
            "directory_manifest_disposition_not_approved",
            directory_packet["failures"],
        )
        pdf_packet = next(
            row
            for row in packet_inventory
            if row["path"]
            == "board/kicad/e1-phone/production/dfm/assembler-dfa-report.pdf"
        )
        self.assertEqual(
            pdf_packet["metadata_record"]["record_type"],
            "external_signed_review_metadata",
        )
        self.assertEqual(
            pdf_packet["metadata_record"]["primary_record_path"],
            "board/kicad/e1-phone/production/dfm/assembler-dfa-report.pdf.metadata.yaml",
        )
        self.assertIn(
            "artifact_sha256",
            pdf_packet["required_field_groups"]["external_review_metadata"],
        )
        self.assertIn(
            "external_metadata_disposition_not_approved",
            pdf_packet["failures"],
        )
        generation = report["repo_generation_summary"]
        self.assertFalse(generation["release_credit"])
        self.assertEqual(generation["true_missing_generated_artifact_count"], 0)
        self.assertGreater(generation["generator_command_available_count"], 0)
        self.assertEqual(
            generation["external_release_evidence_required_count"],
            report["summary"]["blocked"],
        )

    def test_aggregator_classifies_e1_phone_factory_content_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-factory-output-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone factory-output", result.evidence)


class E1PhoneFirstArticleContentGateTests(unittest.TestCase):
    def test_first_article_missing_evidence_diagnostic_is_fail_closed(self) -> None:
        report = first_article_missing.build_report(
            ROOT
            / "board/kicad/e1-phone/production/test/readiness/"
            "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml",
            ROOT
            / "board/kicad/e1-phone/production/test/readiness/"
            "e1-phone-first-article-missing-evidence-2026-05-22.yaml",
        )

        self.assertEqual(report["status"], "blocked_fail_closed_diagnostic_only")
        self.assertFalse(report["summary"]["release_allowed"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertEqual(report["summary"]["matrix_row_count"], 67)
        self.assertEqual(report["summary"]["template_row_count"], 6)
        self.assertEqual(report["summary"]["required_non_template_row_count"], 61)
        self.assertEqual(
            report["summary"]["present_required_non_template_row_count"],
            report["summary"]["required_non_template_row_count"],
        )
        self.assertEqual(
            report["summary"]["missing_required_non_template_row_count"],
            0,
        )
        self.assertEqual(report["summary"]["recommended_next_evidence_packet_count"], 0)
        self.assertIsNone(report["summary"]["highest_leverage_next_packet"])
        self.assertEqual(report["recommended_next_evidence_packets"], [])

    def test_checker_exits_nonzero_and_reports_blocked_first_article(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_first_article_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone first-article content",
            combined,
        )
        report = json.loads(
            (ROOT / "build/reports/e1_phone_first_article_content.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertTrue(report["blocked_evidence_inventory"])
        article_blocker = report["blocked_evidence_inventory"][0]
        self.assertIn("path", article_blocker)
        self.assertIn("owner", article_blocker)
        self.assertIn("validation_command", article_blocker)
        diagnostics = report["blocker_diagnostics"]
        self.assertIn("blocked_by_owner", diagnostics)
        self.assertIn("blocked_by_evidence_kind", diagnostics)
        self.assertIn("blocked_by_failure", diagnostics)
        self.assertIn("template_paths", diagnostics)
        approval_summary = diagnostics["approval_metadata_unblock_summary"]
        self.assertEqual(
            [row["id"] for row in approval_summary],
            [
                "execute_templates_on_serialized_hardware",
                "attach_first_article_external_review_metadata",
                "complete_first_article_directory_release_manifests",
                "complete_first_article_approval_metadata_fields",
                "approve_and_deplaceholder_first_article_records",
            ],
        )
        self.assertTrue(all(row["release_credit"] is False for row in approval_summary))
        self.assertGreater(approval_summary[0]["blocked_rows"], 0)
        self.assertGreater(approval_summary[1]["blocked_rows"], 0)
        self.assertGreater(approval_summary[2]["blocked_rows"], 0)
        self.assertGreater(approval_summary[3]["blocked_rows"], 0)
        blocker_categories = report["first_article_blocker_categories"]
        self.assertFalse(blocker_categories["release_credit"])
        self.assertEqual(
            sum(blocker_categories["counts"].values()),
            report["summary"]["blocked"],
        )
        self.assertEqual(
            blocker_categories["counts"]["true_missing_artifacts"],
            report["summary"]["missing_artifact_count"],
        )
        self.assertGreater(
            blocker_categories["counts"]["template_only_placeholders"],
            0,
        )
        self.assertGreater(
            blocker_categories["counts"]["directory_manifest_approval_incomplete"],
            0,
        )
        self.assertGreater(
            blocker_categories["counts"]["signed_external_metadata_incomplete"],
            0,
        )
        self.assertGreater(
            blocker_categories["counts"]["structured_record_approval_incomplete"],
            0,
        )
        self.assertEqual(
            report["summary"]["blocked_required_present_count"],
            blocker_categories["present_non_template_blocked_rows"],
        )
        self.assertEqual(report["summary"]["blocked_required_present_count"], 61)
        self.assertEqual(report["summary"]["blocked_template_present_count"], 6)
        self.assertEqual(report["summary"]["repo_generated_candidate_blocked_count"], 0)
        self.assertEqual(
            report["summary"]["external_execution_or_approval_required_count"],
            report["summary"]["blocked"],
        )
        self.assertEqual(
            diagnostics["first_article_execution_packet_count"],
            report["summary"]["blocked"],
        )
        self.assertIn(
            "first_article_traceability",
            diagnostics["first_article_execution_packet_required_field_groups"],
        )
        packet_inventory = report["first_article_execution_packet_inventory"]
        self.assertEqual(len(packet_inventory), report["summary"]["blocked"])
        self.assertTrue(all(row["release_credit"] is False for row in packet_inventory))
        self.assertTrue(all("blocker_category" in row for row in packet_inventory))
        self.assertTrue(
            all("factory_first_article_bridge" in row for row in packet_inventory)
        )
        self.assertTrue(all("bridge_causes" in row for row in packet_inventory))
        self.assertTrue(all("execution_required" in row for row in packet_inventory))
        self.assertTrue(all("approval_required" in row for row in packet_inventory))
        self.assertTrue(
            all(
                row["source_matrix"].endswith(
                    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
                )
                for row in packet_inventory
            )
        )
        self.assertTrue(
            all(
                row["validation_report"] == "build/reports/e1_phone_first_article_content.json"
                for row in packet_inventory
            )
        )
        self.assertTrue(all(row["routed_hardware_prerequisites"] for row in packet_inventory))
        bridge = report["factory_first_article_bridge"]
        self.assertFalse(bridge["release_credit"])
        self.assertEqual(
            bridge["summary"]["blocked_first_article_rows"],
            report["summary"]["blocked"],
        )
        self.assertEqual(
            bridge["summary"]["first_article_rows_with_factory_packet_blocker"],
            56,
        )
        self.assertEqual(
            bridge["summary"]["first_article_rows_blocked_by_missing_factory_packet"],
            0,
        )
        self.assertEqual(
            bridge["summary"]["first_article_rows_blocked_by_unapproved_factory_packet"],
            56,
        )
        self.assertEqual(
            bridge["summary"]["first_article_template_only_rows"],
            report["summary"]["blocked_template_present_count"],
        )
        self.assertGreater(
            bridge["summary"]["first_article_rows_with_execution_or_measurement_gap"],
            0,
        )
        self.assertGreater(
            bridge["summary"]["first_article_rows_with_approval_gap"],
            0,
        )
        self.assertIn(
            "board/kicad/e1-phone/production/bom",
            bridge["by_first_article_path"],
        )
        directory_packet = next(
            row
            for row in packet_inventory
            if row["path"] == "board/kicad/e1-phone/production/first-article"
        )
        self.assertIn("repo_generation_plan", directory_packet)
        self.assertFalse(directory_packet["repo_generation_plan"]["repo_generated_candidate"])
        self.assertTrue(
            directory_packet["repo_generation_plan"][
                "external_execution_or_approval_required"
            ]
        )
        self.assertTrue(directory_packet["factory_dependency_present"])
        self.assertIn("factory_packet_unapproved", directory_packet["bridge_causes"])
        self.assertIn("first_article_approval_gap", directory_packet["bridge_causes"])
        self.assertEqual(
            directory_packet["metadata_record"]["record_type"],
            "directory_release_manifest",
        )
        self.assertEqual(
            directory_packet["metadata_record"]["primary_record_path"],
            "board/kicad/e1-phone/production/first-article/release-manifest.yaml",
        )
        self.assertIn(
            "fixture_calibration_id",
            directory_packet["missing_first_article_traceability_fields"],
        )
        pdf_packet = next(
            row
            for row in packet_inventory
            if row["path"]
            == "board/kicad/e1-phone/production/dfm/assembler-dfa-report.pdf"
        )
        self.assertEqual(
            pdf_packet["metadata_record"]["record_type"],
            "external_signed_review_metadata",
        )
        self.assertEqual(
            pdf_packet["metadata_record"]["primary_record_path"],
            "board/kicad/e1-phone/production/dfm/assembler-dfa-report.pdf.metadata.yaml",
        )
        generation = report["repo_generation_summary"]
        self.assertFalse(generation["release_credit"])
        self.assertEqual(generation["repo_generated_candidate_blocked_count"], 0)
        self.assertEqual(
            generation["external_execution_or_approval_required_count"],
            report["summary"]["blocked"],
        )
        self.assertIn(
            "e1_phone_first_article_bench_acceptance_matrix.py",
            generation["matrix_regeneration_command"],
        )

    def test_aggregator_classifies_e1_phone_first_article_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-first-article-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone first-article", result.evidence)


class E1PhoneEnclosureMechanicalContentGateTests(unittest.TestCase):
    def test_enclosure_gap_map_is_fail_closed_diagnostic_only(self) -> None:
        report = enclosure_gap_map.build_report(
            ROOT / "board/kicad/e1-phone/enclosure-mechanical-release-burndown-2026-05-22.yaml",
            ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml",
            ROOT
            / "board/kicad/e1-phone/production/test/readiness/"
            "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml",
            ROOT
            / "board/kicad/e1-phone/production/sourcing/readiness/"
            "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml",
            ROOT
            / "board/kicad/e1-phone/production/readiness/"
            "enclosure-readiness-gap-map-2026-05-22.yaml",
        )

        self.assertEqual(report["status"], "blocked_fail_closed_diagnostic_only")
        self.assertFalse(report["summary"]["release_allowed"])
        self.assertFalse(report["summary"]["release_credit"])
        self.assertGreater(report["summary"]["physical_interfaces_blocked"], 0)
        self.assertEqual(report["summary"]["production_routed_step_release_count"], 0)
        self.assertEqual(report["summary"]["candidate_routed_step_count"], 3)
        self.assertEqual(report["summary"]["clearance_results_complete"], 0)
        self.assertEqual(report["summary"]["clearance_results_expected"], 12)
        self.assertEqual(report["summary"]["blocked_clearance_case_count"], 12)
        self.assertEqual(
            report["summary"]["first_article_missing_required_non_template_count"],
            0,
        )
        self.assertEqual(
            report["summary"]["production_enclosure_handoff_packet_count"],
            6,
        )
        handoff_gap = report["production_enclosure_handoff_gap"]
        self.assertEqual(len(handoff_gap), 6)
        self.assertEqual(handoff_gap[0]["id"], "enclosure_drawing_pack")
        self.assertEqual(
            handoff_gap[0]["expected_path"],
            "board/kicad/e1-phone/production/enclosure/drawing-pack.yaml",
        )
        self.assertIn("owner", handoff_gap[0])
        self.assertIn("required_action", handoff_gap[0])
        self.assertEqual(
            handoff_gap[0]["validation_command"],
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        )
        routed_gap = report["routed_board_clearance_gap"]
        self.assertFalse(routed_gap["release_allowed"])
        self.assertFalse(routed_gap["release_credit"])
        self.assertTrue(routed_gap["candidate_paths_do_not_grant_release_credit"])
        self.assertEqual(routed_gap["production_routed_step_release_count"], 0)
        self.assertEqual(routed_gap["candidate_routed_step_count"], 3)
        self.assertEqual(len(routed_gap["blocked_clearance_cases"]), 12)
        self.assertEqual(routed_gap["missing_routed_board_intake_artifacts"], [])
        self.assertEqual(routed_gap["missing_routed_board_intake_fields"], [])
        action_inventory = report["fabrication_enclosure_unblock_action_inventory"]
        self.assertEqual(
            [row["id"] for row in action_inventory],
            [
                "supplier_return_content_validation",
                "routed_board_release_outputs",
                "production_factory_release_outputs",
                "first_article_execution_outputs",
                "enclosure_clearance_and_handoff",
            ],
        )
        self.assertEqual(
            report["summary"]["release_unblock_action_group_count"],
            len(action_inventory),
        )
        self.assertTrue(all(row["release_credit"] is False for row in action_inventory))
        self.assertIn(
            "scripts/check_e1_phone_factory_output_content.py",
            action_inventory[2]["validation_command"],
        )
        self.assertEqual(action_inventory[4]["blocked_clearance_cases"], 12)

        approval_inventory = report["approval_metadata_action_inventory"]
        self.assertEqual(
            [row["family"] for row in approval_inventory],
            [
                "supplier_return_approvals",
                "routed_release_approvals",
                "factory_release_approvals",
                "first_article_approvals",
                "enclosure_handoff_approvals",
            ],
        )
        self.assertEqual(
            report["summary"]["approval_metadata_action_group_count"],
            len(approval_inventory),
        )
        self.assertTrue(all(row["release_credit"] is False for row in approval_inventory))
        self.assertIn("signature_or_approval_record", approval_inventory[1]["required_metadata"])
        self.assertIn("approval_signature", approval_inventory[4]["missing_required_fields"])
        clearance_actions = report["routed_clearance_release_action_inventory"]
        self.assertEqual(report["summary"]["routed_clearance_release_action_count"], 12)
        self.assertEqual(
            report["summary"]["clearance_supplier_family_mapping_count"],
            12,
        )
        self.assertEqual(
            report["summary"]["clearance_routed_step_input_mapping_count"],
            12,
        )
        self.assertTrue(all(row["release_credit"] is False for row in clearance_actions))
        self.assertTrue(
            all(
                row["required_evidence_class"]
                == "physical_routed_board_clearance_result"
                for row in clearance_actions
            )
        )
        self.assertIn(
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
            {
                row["required_inputs"]["routed_board_step"]
                for row in clearance_actions
            },
        )
        self.assertIn(
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            clearance_actions[0]["next_commands"],
        )
        self.assertIn(
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
            clearance_actions[0]["next_artifacts"],
        )
        self.assertFalse(
            clearance_actions[0]["routed_step_input_map"]["release_credit"]
        )
        self.assertTrue(
            clearance_actions[0]["routed_step_input_map"][
                "candidate_step_paths_present"
            ]
        )
        self.assertTrue(
            clearance_actions[0]["supplier_geometry_families"],
            clearance_actions[0],
        )
        self.assertTrue(
            all(
                family["release_credit"] is False
                for row in clearance_actions
                for family in row["supplier_geometry_families"]
            )
        )
        first_article_fit_actions = report["first_article_physical_fit_action_inventory"]
        self.assertEqual(report["summary"]["first_article_physical_fit_action_count"], 7)
        self.assertEqual(len(first_article_fit_actions), 7)
        self.assertTrue(
            all(row["release_credit"] is False for row in first_article_fit_actions)
        )
        self.assertIn(
            "production_routed_board_step_release",
            {row["evidence_class"] for row in first_article_fit_actions},
        )
        self.assertIn(
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
            {
                row["required_inputs"]["routed_board_step"]
                for row in first_article_fit_actions
            },
        )

    def test_checker_exits_nonzero_and_reports_blocked_enclosure(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_enclosure_mechanical_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone enclosure mechanical content",
            combined,
        )

        report = json.loads(
            (ROOT / "build/reports/e1_phone_enclosure_mechanical_content.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(report["summary"]["handoff_outputs_required"], 6)
        self.assertEqual(report["summary"]["handoff_outputs_present"], 6)
        self.assertEqual(report["summary"]["handoff_packet_files_required"], 6)
        self.assertEqual(report["summary"]["handoff_packet_files_present"], 6)
        self.assertEqual(report["summary"]["handoff_external_deliverables_missing"], 6)
        self.assertEqual(
            report["summary"]["missing_release_evidence_categories"],
            {
                "local_cad_candidate_present_no_release": 1,
                "physical_fit_first_article_evidence_missing": 1,
                "physical_process_validation_results_missing": 1,
                "routed_clearance_release_results_missing": 1,
                "supplier_geometry_and_return_evidence_missing": 1,
            },
        )
        self.assertEqual(
            report["summary"]["supplier_family_blocker_categories"],
            {"supplier_geometry_return_blocker": 6},
        )
        self.assertEqual(report["summary"]["supplier_required_geometry_input_count"], 15)
        self.assertEqual(report["summary"]["supplier_required_release_input_count"], 11)
        self.assertEqual(
            report["summary"]["physical_interface_blocker_categories"],
            {"physical_interface_release_blocker": 8},
        )
        self.assertEqual(report["summary"]["physical_interface_required_check_count"], 22)
        self.assertEqual(
            report["summary"]["physical_interface_required_evidence_count"], 24
        )
        self.assertEqual(report["summary"]["repo_generatable_release_step_count"], 0)
        self.assertEqual(
            report["summary"]["repo_generatable_missing_release_evidence_count"],
            0,
        )
        self.assertEqual(
            report["summary"]["blocked_missing_release_evidence_generation_count"],
            5,
        )
        routed_step_plan = report["routed_step_generation_plan"]
        self.assertFalse(routed_step_plan["repo_can_generate_release_step_now"])
        self.assertEqual(routed_step_plan["repo_generatable_release_step_count"], 0)
        self.assertEqual(routed_step_plan["candidate_step_file_count"], 3)
        self.assertIn(
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
            routed_step_plan["candidate_step_paths"],
        )
        self.assertIn(
            "component_3d_model_manifest_approved:false",
            routed_step_plan["blocked_by"],
        )
        generation_plan = report["missing_release_evidence_generation_plan"]
        self.assertEqual(len(generation_plan), 5)
        self.assertTrue(all(row["release_credit"] is False for row in generation_plan))
        self.assertTrue(
            all(row["repo_generatable_now"] is False for row in generation_plan)
        )
        routed_step_missing = next(
            row for row in generation_plan if row["gate"] == "routed_board_step_intake"
        )
        self.assertEqual(
            routed_step_missing["repo_generation_status"],
            "blocked_candidate_present_no_release",
        )
        self.assertTrue(routed_step_missing["candidate_artifacts_present"])
        supplier_missing = next(
            row for row in generation_plan if row["gate"] == "supplier_evidence"
        )
        self.assertEqual(
            supplier_missing["repo_generation_status"],
            "external_supplier_return_required",
        )
        self.assertIn(
            "supplier returned quote, 2D drawing, STEP/B-rep, sample, and traceability packs",
            supplier_missing["next_external_inputs"],
        )
        self.assertTrue(report["summary"]["full_cad_boolean_local_concept_passed"])
        self.assertFalse(report["summary"]["full_cad_boolean_release_ready"])
        self.assertTrue(report["summary"]["full_cad_boolean_release_blocked"])
        self.assertEqual(
            report["summary"]["full_cad_boolean_release_blocker_category"],
            "routed_supplier_boolean_rerun_missing",
        )
        self.assertTrue(report["summary"]["step_validation_release_blocked"])
        self.assertEqual(
            report["summary"]["step_validation_release_blocker_category"],
            "local_step_validation_tooling_unavailable",
        )
        self.assertEqual(
            report["summary"]["clearance_result_blocker_categories"],
            {
                "case_pass": 12,
                "evidence_class:physical_routed_board_clearance_result": 12,
                "interference_count_zero": 12,
                "measured_min_gap_mm": 12,
                "measurement_artifact": 12,
                "reviewer": 12,
            },
        )
        self.assertEqual(
            len(report["summary"]["missing_handoff_output_paths"]),
            0,
        )
        self.assertEqual(
            len(report["summary"]["missing_handoff_external_items"]),
            6,
        )
        self.assertEqual(report["summary"]["handoff_packet_count"], 6)
        self.assertEqual(report["summary"]["missing_handoff_packet_ids"], [])
        handoff_actions = report["summary"]["handoff_packet_actions"]
        self.assertEqual(len(handoff_actions), 6)
        self.assertEqual(
            report["production_enclosure_handoff_unblock_actions"],
            handoff_actions,
        )
        self.assertEqual(
            len(report["missing_production_enclosure_handoff_outputs"]["all_items"]),
            6,
        )
        self.assertEqual(handoff_actions[0]["owner"], "mechanical_release")
        self.assertEqual(
            handoff_actions[0]["expected_path"],
            "board/kicad/e1-phone/production/enclosure/drawing-pack.yaml",
        )
        self.assertTrue(handoff_actions[0]["present"])
        self.assertFalse(handoff_actions[0]["release_credit"])
        self.assertIn("approval_signature", handoff_actions[0]["missing_required_fields"])
        self.assertIn(
            "enclosure_drawing_pack:missing_field:approval_signature",
            report["summary"]["invalid_handoff_packet_evidence"],
        )
        self.assertEqual(
            handoff_actions[0]["validation_command"],
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
        )
        self.assertIn(
            "production_enclosure_handoff_outputs_missing",
            {finding["code"] for finding in report["findings"]},
        )
        self.assertIn(
            "production_enclosure_handoff_packets_not_executed",
            {finding["code"] for finding in report["findings"]},
        )
        step_inventory = report["routed_step_inventory"]
        self.assertEqual(step_inventory["approved_release_count"], 0)
        self.assertEqual(step_inventory["candidate_present_count"], 3)
        self.assertTrue(
            all(
                row["release_credit"] is False
                for row in step_inventory["candidate_no_release_credit"]
            )
        )
        self.assertEqual(
            len(report["routed_clearance_case_diagnostics"]),
            report["summary"]["clearance_results_expected"],
        )
        self.assertEqual(len(report["routed_clearance_unblock_actions"]), 12)
        first_clearance = report["routed_clearance_unblock_actions"][0]
        self.assertEqual(first_clearance["risk_level"], "high")
        self.assertEqual(
            first_clearance["required_release_report"],
            "board/kicad/e1-phone/production/reports/clearance/battery_to_pcb_islands.yaml",
        )
        self.assertIn("measured_min_gap_mm", first_clearance["missing"])
        self.assertEqual(
            first_clearance["required_inputs"]["required_production_routed_step"],
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        )
        self.assertTrue(first_clearance["supplier_geometry_families"])
        self.assertIn(
            "python3 scripts/check_e1_phone_enclosure_mechanical_content.py",
            first_clearance["next_commands"],
        )
        self.assertIn(
            first_clearance["required_release_report"],
            first_clearance["next_artifacts"],
        )
        clearance_actions = report["routed_clearance_release_action_inventory"]
        self.assertEqual(report["summary"]["routed_clearance_release_action_count"], 12)
        self.assertEqual(len(clearance_actions), 12)
        self.assertTrue(all(row["release_credit"] is False for row in clearance_actions))
        self.assertIn(
            "python3 scripts/e1_phone_enclosure_readiness_gap_map.py --write-report",
            clearance_actions[0]["next_commands"],
        )
        self.assertEqual(
            clearance_actions[0]["required_inputs"]["supplier_3d_binding_report"],
            "board/kicad/e1-phone/production/reports/component-3d-binding.yaml",
        )
        self.assertEqual(
            clearance_actions[0]["routed_step_input_map"][
                "required_production_routed_step"
            ],
            "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        )
        self.assertIn(
            "board/kicad/e1-phone/production/reports/full-cad-boolean-interference-routed.yaml",
            clearance_actions[0]["next_artifacts"],
        )
        self.assertTrue(clearance_actions[0]["supplier_geometry_families"])
        self.assertTrue(
            all(
                family["release_credit"] is False
                for row in clearance_actions
                for family in row["supplier_geometry_families"]
            )
        )
        self.assertEqual(
            report["routed_board_release_intake_diagnostics"][0]["missing_artifacts"],
            [],
        )
        self.assertIn(
            "component_3d_model_manifest_approved:false",
            report["routed_board_release_intake_diagnostics"][0]["missing"],
        )
        self.assertEqual(
            report["summary"]["highest_risk_failed_clearance_case_ids"][:4],
            [
                "battery_to_pcb_islands",
                "haptic_to_battery",
                "split_interconnect_connectors_on_pcb_islands",
                "usb_shell_to_external_aperture",
            ],
        )
        first_article_fit_actions = report["first_article_physical_fit_action_inventory"]
        self.assertEqual(
            report["summary"]["first_article_physical_fit_action_count"],
            len(first_article_fit_actions),
        )
        self.assertEqual(len(first_article_fit_actions), 7)
        self.assertTrue(
            all(row["release_credit"] is False for row in first_article_fit_actions)
        )
        transcript_action = next(
            row
            for row in first_article_fit_actions
            if row["evidence_class"] == "executed_first_article_test_transcript"
        )
        self.assertEqual(
            transcript_action["path"],
            "board/kicad/e1-phone/production/test/first-article-test-transcript.json",
        )
        self.assertIn(
            "python3 scripts/check_e1_phone_first_article_content.py",
            transcript_action["next_commands"],
        )
        self.assertEqual(len(report["missing_release_evidence_blockers"]), 5)
        self.assertEqual(len(report["supplier_family_blockers"]), 6)
        self.assertEqual(len(report["physical_interface_blockers"]), 8)
        self.assertTrue(
            all(row["release_credit"] is False for row in report["supplier_family_blockers"])
        )
        self.assertTrue(
            all(row["release_credit"] is False for row in report["physical_interface_blockers"])
        )
        self.assertEqual(
            report["local_cad_validation_context"]["full_cad_boolean_interference"][
                "required_release_report"
            ],
            "board/kicad/e1-phone/production/reports/full-cad-boolean-interference-routed.yaml",
        )

    def test_aggregator_classifies_e1_phone_enclosure_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-enclosure-mechanical-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone enclosure", result.evidence)


class PdkAccessGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_access(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_pdk_access_gate.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn("STATUS: BLOCKED PDK access gate", combined)
        self.assertIn("advanced_targets=4", combined)
        self.assertIn("blocked=4", combined)
        self.assertIn("checklist_not_started=23", combined)
        self.assertIn("global_unmet=6", combined)

    def test_aggregator_classifies_pdk_access_as_blocked(self) -> None:
        spec = next(gate for gate in agg.GATES if gate.name == "pdk-access-gate")
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED PDK access gate", result.evidence)


class PdReleaseEvidenceGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_pd_evidence(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_pd_release_evidence.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn("STATUS: BLOCKED PD release evidence", combined)
        self.assertIn("manifests=8", combined)
        self.assertIn("release_ready=0", combined)
        self.assertIn("blocked=8", combined)
        self.assertIn("prohibited=8", combined)

    def test_aggregator_classifies_pd_release_evidence_as_blocked(self) -> None:
        spec = next(gate for gate in agg.GATES if gate.name == "pd-release-evidence-check")
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED PD release evidence", result.evidence)


if __name__ == "__main__":
    unittest.main()
