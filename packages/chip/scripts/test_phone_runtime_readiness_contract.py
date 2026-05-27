#!/usr/bin/env python3
"""Tests for scripts/check_phone_runtime_readiness_contract.py."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_phone_runtime_readiness_contract as gate  # noqa: E402

PERIPHERAL_HELPER_PATH = ROOT / "scripts/android/capture_simulated_peripheral_evidence.py"
peripheral_spec = importlib.util.spec_from_file_location(
    "capture_simulated_peripheral_evidence", PERIPHERAL_HELPER_PATH
)
assert peripheral_spec and peripheral_spec.loader
peripheral_helper = importlib.util.module_from_spec(peripheral_spec)
sys.modules[peripheral_spec.name] = peripheral_helper
peripheral_spec.loader.exec_module(peripheral_helper)


def report(name: str, *, status: str, allowed: bool) -> dict:
    return {
        "schema": f"eliza.{name}.v1",
        "status": status,
        "claim_boundary": "fixture",
        "summary": {"release_claim_allowed": allowed},
    }


def spec(name: str, status: str = "ready") -> gate.ScopeSpec:
    return gate.ScopeSpec(
        name=name,
        report_builder=lambda: report(name, status=status, allowed=status == "ready"),
        validator=lambda _report: [],
        required_status="ready",
        runtime_surface=f"{name} surface",
        required_runtime_evidence=("runtime proof",),
    )


class PhoneRuntimeReadinessContractTests(unittest.TestCase):
    def test_current_release_blocked_scope_reports_block_objective(self) -> None:
        blocked = gate.ScopeSpec(
            name="media",
            report_builder=lambda: report(
                "media", status="phone_media_pipeline_scope_release_blocked", allowed=False
            ),
            validator=lambda _report: [],
            required_status="phone_media_pipeline_runtime_ready",
            runtime_surface="display/camera",
            required_runtime_evidence=("HWC proof", "Camera HAL proof"),
        )
        with mock.patch.object(gate, "SCOPES", (blocked,)):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["summary"]["blockers"], 1)
        self.assertEqual(payload["findings"][0]["code"], "media_runtime_surface_blocked")
        self.assertEqual(
            payload["summary"]["blocker_dependency_counts"]["live_device_validation"],
            1,
        )
        self.assertEqual(payload["summary"]["runtime_capture_plan_count"], 1)
        self.assertEqual(payload["summary"]["runtime_evidence_collection_scope_count"], 1)
        self.assertEqual(payload["summary"]["blocked_runtime_evidence_file_count"], 0)
        self.assertEqual(payload["summary"]["highest_priority_capture_area"], "media")
        self.assertEqual(
            payload["findings"][0]["blocker_dependency"],
            "live_device_validation",
        )
        inventory = payload["runtime_evidence_collection_inventory"]
        self.assertEqual(len(inventory), 1)
        self.assertEqual(inventory[0]["scope"], "media")
        self.assertFalse(inventory[0]["release_credit"])
        self.assertIn(
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            inventory[0]["next_commands"],
        )

    def test_all_runtime_ready_scope_reports_pass(self) -> None:
        with mock.patch.object(gate, "SCOPES", (spec("media"), spec("security"))):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(payload["findings"], [])

    def test_invalid_scope_report_is_failure(self) -> None:
        invalid = gate.ScopeSpec(
            name="radio",
            report_builder=lambda: report("radio", status="ready", allowed=True),
            validator=lambda _report: ["bad schema"],
            required_status="ready",
            runtime_surface="radio",
            required_runtime_evidence=("radio proof",),
        )
        with mock.patch.object(gate, "SCOPES", (invalid,)):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "fail")
        self.assertEqual(payload["summary"]["failures"], 1)
        self.assertEqual(payload["findings"][0]["code"], "radio_scope_report_invalid")

    def test_missing_runtime_evidence_blocks_ready_scope(self) -> None:
        ready_without_file = gate.ScopeSpec(
            name="media",
            report_builder=lambda: report("media", status="ready", allowed=True),
            validator=lambda _report: [],
            required_status="ready",
            runtime_surface="display/camera",
            required_runtime_evidence=("HWC proof",),
            required_evidence_files=(
                gate.EvidenceSpec(
                    path=Path("/tmp/eliza-test-missing-runtime-evidence.json"),
                    description="fixture missing proof",
                    json_expectations=(("status", "eq", "PASS"),),
                ),
            ),
        )
        with mock.patch.object(gate, "SCOPES", (ready_without_file,)):
            payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["findings"][0]["code"], "media_runtime_evidence_incomplete")
        self.assertIn("missing", payload["findings"][0]["evidence"])
        inventory = payload["runtime_evidence_collection_inventory"]
        self.assertEqual(inventory[0]["scope"], "media")
        self.assertEqual(payload["summary"]["blocked_runtime_evidence_file_count"], 1)
        self.assertEqual(payload["summary"]["planned_evidence_missing_file_count"], 1)
        self.assertEqual(payload["summary"]["live_capture_unavailable_file_count"], 0)
        self.assertEqual(payload["summary"]["planned_evidence_incomplete_file_count"], 0)
        self.assertEqual(payload["summary"]["highest_priority_capture_area"], "media")
        self.assertEqual(
            inventory[0]["blocked_evidence_files"][0]["path"],
            "/tmp/eliza-test-missing-runtime-evidence.json",
        )
        self.assertEqual(
            inventory[0]["blocked_evidence_files"][0]["blocker_class"],
            "planned_evidence_missing",
        )
        self.assertEqual(
            inventory[0]["blocked_evidence_files"][0]["blocker_category"],
            "planned_missing_evidence",
        )
        self.assertEqual(
            inventory[0]["blocked_evidence_files"][0]["blocker_category_label"],
            "planned missing evidence",
        )
        self.assertFalse(inventory[0]["blocked_evidence_files"][0]["release_credit"])
        self.assertEqual(
            inventory[0]["blocked_evidence_files"][0]["expected_output_files"],
            ["/tmp/eliza-test-missing-runtime-evidence.json"],
        )
        self.assertTrue(
            inventory[0]["blocked_evidence_files"][0]["capture_commands"],
        )
        self.assertEqual(
            inventory[0]["blocked_evidence_files"][0]["validation_command"],
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
        )
        self.assertIn(
            {"path": "status", "op": "eq", "expected": "PASS"},
            inventory[0]["blocked_evidence_files"][0]["json_expectations"],
        )
        self.assertEqual(
            payload["runtime_capture_area_groups"][0]["blocked_evidence_class_counts"][
                "planned_evidence_missing"
            ],
            1,
        )

    def test_unavailable_live_capture_is_distinct_from_missing_planned_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "rear_camera_sim.log"
            evidence.write_text(
                "PROBE_ERROR=adb device unavailable: error: no devices/emulators found 2\n"
                "MISSING_MARKERS=CAPTURE_COUNT=2\n"
                "eliza-evidence: status=BLOCKED\n",
                encoding="utf-8",
            )
            live_unavailable = gate.ScopeSpec(
                name="media",
                report_builder=lambda: report("media", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="camera",
                required_runtime_evidence=("camera proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=evidence,
                        description="rear camera proof",
                        required_tokens=("eliza-evidence: status=PASS", "CAPTURE_COUNT="),
                        forbidden_tokens=("status=BLOCKED", "PROBE_ERROR"),
                    ),
                ),
            )
            with mock.patch.object(gate, "SCOPES", (live_unavailable,)):
                payload = gate.run_check(Namespace())

        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["summary"]["blocked_runtime_evidence_file_count"], 1)
        self.assertEqual(payload["summary"]["live_capture_unavailable_file_count"], 1)
        self.assertEqual(payload["summary"]["planned_evidence_missing_file_count"], 0)
        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(blocked_file["blocker_class"], "live_capture_unavailable")
        self.assertEqual(blocked_file["blocker_label"], "live capture unavailable")
        self.assertEqual(blocked_file["blocker_category"], "live_device_validation")
        self.assertEqual(blocked_file["blocker_category_label"], "live-device validation")
        group = payload["runtime_capture_area_groups"][0]
        self.assertEqual(group["capture_area"], "media")
        self.assertEqual(group["blocked_evidence_class_counts"]["live_capture_unavailable"], 1)
        self.assertEqual(group["blocked_evidence_category_counts"]["live_device_validation"], 1)
        self.assertIn(
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            group["next_commands"],
        )

    def test_present_non_live_incomplete_evidence_gets_planned_incomplete_category(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "power_trace.json"
            evidence.write_text(
                json.dumps({"status": "DRAFT", "result": 2}),
                encoding="utf-8",
            )
            incomplete = gate.ScopeSpec(
                name="power",
                report_builder=lambda: report("power", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="power thermal",
                required_runtime_evidence=("calibrated trace",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=evidence,
                        description="draft power trace",
                        json_expectations=(("status", "eq", "PASS"),),
                    ),
                ),
            )
            with mock.patch.object(gate, "SCOPES", (incomplete,)):
                payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(blocked_file["blocker_class"], "planned_evidence_incomplete")
        self.assertEqual(blocked_file["blocker_category"], "planned_incomplete_evidence")
        self.assertEqual(payload["summary"]["planned_incomplete_evidence_file_count"], 1)

    def test_template_manifest_converts_absent_planned_file_to_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            missing_evidence = tmp_root / "docs/evidence/android/security/rollback_rejection.log"
            manifest = (
                tmp_root / "docs/evidence/runtime/phone_runtime_planned_evidence_templates.json"
            )
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "eliza.phone_runtime_planned_evidence_templates.v1",
                        "release_credit": False,
                        "planned_evidence_templates": [
                            {
                                "expected_path": "docs/evidence/android/security/rollback_rejection.log",
                                "capture_status": "planned_incomplete",
                                "capture_commands": ['test -n "$ELIZA_ROLLBACK_REJECTION_COMMAND"'],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            templated = gate.ScopeSpec(
                name="security_lifecycle",
                report_builder=lambda: report("security", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="verified boot",
                required_runtime_evidence=("rollback proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=missing_evidence,
                        description="rollback proof",
                        required_tokens=("ROLLBACK_REJECTED=pass", "RESULT=0"),
                    ),
                ),
            )
            with (
                mock.patch.object(gate, "ROOT", tmp_root),
                mock.patch.object(gate, "PLANNED_EVIDENCE_TEMPLATE_MANIFEST", manifest),
                mock.patch.object(gate, "SCOPES", (templated,)),
            ):
                payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(blocked_file["blocker_class"], "planned_evidence_incomplete")
        self.assertEqual(blocked_file["blocker_category"], "planned_incomplete_evidence")
        self.assertEqual(
            blocked_file["planned_evidence_template"]["template_manifest"],
            "docs/evidence/runtime/phone_runtime_planned_evidence_templates.json",
        )
        self.assertEqual(payload["summary"]["planned_evidence_missing_file_count"], 0)
        self.assertEqual(payload["summary"]["planned_evidence_incomplete_file_count"], 1)

    def test_blocked_records_expose_requested_category_command_and_path_fields(self) -> None:
        missing_security = gate.ScopeSpec(
            name="security_lifecycle",
            report_builder=lambda: report("security", status="blocked", allowed=False),
            validator=lambda _report: [],
            required_status="ready",
            runtime_surface="verified boot",
            required_runtime_evidence=("tamper proof",),
            required_evidence_files=(
                gate.EvidenceSpec(
                    path=gate.ROOT / "docs/evidence/android/security/tampered_boot_rejection.log",
                    description="tampered boot proof",
                    required_tokens=("TAMPERED_BOOT_REJECTED=pass",),
                ),
            ),
        )
        with mock.patch.object(gate, "SCOPES", (missing_security,)):
            payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(blocked_file["blocker_category"], "planned_incomplete_evidence")
        self.assertEqual(
            blocked_file["expected_output_files"],
            ["docs/evidence/android/security/tampered_boot_rejection.log"],
        )
        self.assertTrue(blocked_file["capture_commands"])
        self.assertFalse(
            any("<lab command" in command for command in blocked_file["capture_commands"])
        )
        self.assertTrue(
            any(
                "ELIZA_TAMPERED_BOOT_REJECTION_COMMAND" in command
                for command in blocked_file["capture_commands"]
            )
        )

    def test_blocked_phone_runtime_inventory_maps_known_outputs_to_capture_commands(self) -> None:
        missing_peripheral = gate.ScopeSpec(
            name="media",
            report_builder=lambda: report("media", status="ready", allowed=True),
            validator=lambda _report: [],
            required_status="ready",
            runtime_surface="camera",
            required_runtime_evidence=("rear camera proof",),
            required_evidence_files=(
                gate.EvidenceSpec(
                    path=gate.ROOT / "docs/evidence/android/peripherals/rear_camera_sim.log",
                    description="rear camera fixture",
                    required_tokens=("eliza-evidence: status=PASS",),
                ),
            ),
        )
        with mock.patch.object(gate, "SCOPES", (missing_peripheral,)):
            payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(
            blocked_file["expected_output_files"],
            ["docs/evidence/android/peripherals/rear_camera_sim.log"],
        )
        self.assertFalse(blocked_file["release_credit"])
        self.assertTrue(
            any(
                "capture_simulated_peripheral_evidence.py" in command and "rear_camera" in command
                for command in blocked_file["capture_commands"]
            )
        )
        self.assertIn("prerequisites", blocked_file)
        self.assertIn(
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
            payload["prioritized_runtime_capture_plan"][0]["validation_commands"],
        )
        self.assertIn("expected_file_schema", blocked_file)
        self.assertIn("device_or_emulator_prerequisites", blocked_file)
        self.assertIn("fail_closed_validation_rule", blocked_file)
        self.assertEqual(
            blocked_file["capture_contract_manifest"],
            "docs/evidence/android/runtime/live_runtime_capture_contracts.json",
        )

    def test_live_capture_contract_manifest_supplies_schema_prereqs_and_rules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            manifest = (
                tmp_root / "docs/evidence/android/runtime/live_runtime_capture_contracts.json"
            )
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "eliza.android_live_runtime_capture_contracts.v1",
                        "release_credit": False,
                        "live_capture_contracts": [
                            {
                                "expected_path": "docs/evidence/android/peripherals/wifi_sim.log",
                                "expected_file_schema": "fixture wifi evidence schema",
                                "device_or_emulator_prerequisites": ["fixture booted adb target"],
                                "fail_closed_validation_rule": (
                                    "fixture fail closed unless PASS markers are present"
                                ),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            missing_wifi = gate.ScopeSpec(
                name="radio_sensor_pmic",
                report_builder=lambda: report("radio", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="wifi",
                required_runtime_evidence=("wifi proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=tmp_root / "docs/evidence/android/peripherals/wifi_sim.log",
                        description="wifi proof",
                        required_tokens=("eliza-evidence: status=PASS", "IP_CONNECTIVITY=pass"),
                    ),
                ),
            )
            with (
                mock.patch.object(gate, "ROOT", tmp_root),
                mock.patch.object(gate, "LIVE_CAPTURE_CONTRACT_MANIFEST", manifest),
                mock.patch.object(gate, "SCOPES", (missing_wifi,)),
            ):
                payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(blocked_file["expected_file_schema"], "fixture wifi evidence schema")
        self.assertEqual(
            blocked_file["device_or_emulator_prerequisites"],
            ["fixture booted adb target"],
        )
        self.assertEqual(
            blocked_file["fail_closed_validation_rule"],
            "fixture fail closed unless PASS markers are present",
        )
        self.assertEqual(
            blocked_file["capture_contract_manifest"],
            "docs/evidence/android/runtime/live_runtime_capture_contracts.json",
        )

    def test_live_capture_contract_precedence_marks_present_bad_file_as_live_blocker(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            manifest = (
                tmp_root / "docs/evidence/android/runtime/live_runtime_capture_contracts.json"
            )
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "eliza.android_live_runtime_capture_contracts.v1",
                        "release_credit": False,
                        "live_capture_contracts": [
                            {
                                "expected_path": "docs/evidence/android/peripherals/wifi_sim.log",
                                "expected_file_schema": "fixture wifi evidence schema",
                                "capture_commands": ["capture wifi fixture"],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            evidence = tmp_root / "docs/evidence/android/peripherals/wifi_sim.log"
            evidence.parent.mkdir(parents=True)
            evidence.write_text("eliza-evidence: status=BLOCKED\n", encoding="utf-8")
            wifi = gate.ScopeSpec(
                name="radio_sensor_pmic",
                report_builder=lambda: report("radio", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="wifi",
                required_runtime_evidence=("wifi proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=evidence,
                        description="wifi proof",
                        required_tokens=("eliza-evidence: status=PASS",),
                    ),
                ),
            )
            with (
                mock.patch.object(gate, "ROOT", tmp_root),
                mock.patch.object(gate, "LIVE_CAPTURE_CONTRACT_MANIFEST", manifest),
                mock.patch.object(gate, "SCOPES", (wifi,)),
            ):
                payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertEqual(blocked_file["path"], "docs/evidence/android/peripherals/wifi_sim.log")
        self.assertEqual(blocked_file["blocker_class"], "live_capture_unavailable")
        self.assertEqual(blocked_file["blocker_category"], "live_device_validation")
        self.assertIn("eliza-evidence: status=PASS", blocked_file["required_tokens"])
        self.assertIn(
            "docs/evidence/android/peripherals/wifi_sim.log missing token "
            "'eliza-evidence: status=PASS'",
            blocked_file["errors"],
        )
        self.assertEqual(
            blocked_file["capture_contract_manifest"],
            "docs/evidence/android/runtime/live_runtime_capture_contracts.json",
        )
        self.assertEqual(blocked_file["expected_file_schema"], "fixture wifi evidence schema")
        self.assertTrue(blocked_file["capture_commands"])
        self.assertTrue(
            any(
                "capture_simulated_peripheral_evidence.py" in cmd
                for cmd in blocked_file["capture_commands"]
            )
        )

    def test_current_live_device_blockers_all_have_executable_capture_contracts(self) -> None:
        expected = {
            "docs/evidence/android/eliza_launcher_runtime_evidence.json",
            "docs/evidence/android/peripherals/rear_camera_sim.log",
            "docs/evidence/android/peripherals/front_camera_sim.log",
            "docs/evidence/android/peripherals/wifi_sim.log",
            "docs/evidence/android/peripherals/bluetooth_sim.log",
            "docs/evidence/android/peripherals/cellular_5g_lte_sim.log",
            "docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log",
        }
        payload = gate.run_check(Namespace())
        blocked_files = {
            row["path"]: row
            for group in payload["runtime_evidence_collection_inventory"]
            for row in group["blocked_evidence_files"]
            if row["blocker_category"] == gate.LIVE_DEVICE_VALIDATION
        }

        self.assertEqual(set(blocked_files), expected)
        for path, row in blocked_files.items():
            self.assertTrue(row["capture_commands"], path)
            self.assertTrue(
                any(
                    command.startswith("python3 packages/chip/scripts/android/")
                    for command in row["capture_commands"]
                ),
                path,
            )
            self.assertIn("expected_file_schema", row)
            self.assertIn("device_or_emulator_prerequisites", row)
            self.assertIn("fail_closed_validation_rule", row)
            self.assertEqual(row["validation_commands"], [gate.PHONE_RUNTIME_VALIDATION_COMMAND])
            self.assertFalse(row["release_credit"])

    def test_peripheral_helper_markers_match_live_contract_schema(self) -> None:
        markers_by_component = {
            spec.component: set(spec.markers) for spec in peripheral_helper.SPECS
        }
        self.assertIn("PAIRING=pass", markers_by_component["bluetooth"])
        self.assertIn("DATA_ATTACH=pass", markers_by_component["cellular_5g_lte"])

    def test_peripheral_helper_missing_default_probe_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp) / "evidence"
            spec = peripheral_helper.PeripheralSpec(
                component="fixture_radio",
                env_var="ELIZA_FIXTURE_RADIO_SIM_COMMAND",
                log_name="fixture_radio.log",
                markers=("COMPONENT=fixture_radio", "RESULT=pass"),
                default_probe=str(Path(tmp) / "missing-probe.sh"),
            )
            with mock.patch.dict(
                peripheral_helper.os.environ,
                {"ELIZA_ANDROID_PERIPHERAL_OUT_DIR": str(output_root)},
                clear=False,
            ):
                status, path = peripheral_helper.capture_one(spec, timeout_seconds=1, dry_run=False)

            self.assertEqual(status, "blocked")
            self.assertEqual(path, output_root / "fixture_radio.log")
            text = path.read_text(encoding="utf-8")
            self.assertIn("canonical probe script is not present", text)
            self.assertIn("eliza-evidence: status=BLOCKED", text)
            self.assertIn("RESULT=2", text)

    def test_npu_hal_liveness_uses_fail_closed_capture_helper(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            manifest = (
                tmp_root / "docs/evidence/android/runtime/live_runtime_capture_contracts.json"
            )
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "eliza.android_live_runtime_capture_contracts.v1",
                        "release_credit": False,
                        "live_capture_contracts": [
                            {
                                "expected_path": "docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log",
                                "expected_file_schema": "NNAPI_SERVICE and E1_NPU_ACCELERATOR markers",
                                "device_or_emulator_prerequisites": ["booted adb target"],
                                "fail_closed_validation_rule": "must pass helper markers",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            npu = gate.ScopeSpec(
                name="power_thermal",
                report_builder=lambda: report("power", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="npu",
                required_runtime_evidence=("npu proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=tmp_root
                        / "docs/evidence/android/eliza_ai_soc_e1_npu_hal_liveness.log",
                        description="npu proof",
                        required_tokens=("eliza-evidence: status=PASS", "RESULT=0"),
                    ),
                ),
            )
            with (
                mock.patch.object(gate, "ROOT", tmp_root),
                mock.patch.object(gate, "LIVE_CAPTURE_CONTRACT_MANIFEST", manifest),
                mock.patch.object(gate, "SCOPES", (npu,)),
            ):
                payload = gate.run_check(Namespace())

        blocked_file = payload["runtime_evidence_collection_inventory"][0][
            "blocked_evidence_files"
        ][0]
        self.assertTrue(
            any(
                "capture_e1_npu_hal_liveness.py" in command
                for command in blocked_file["capture_commands"]
            )
        )
        self.assertIn("NNAPI_SERVICE", blocked_file["expected_file_schema"])

    def test_runtime_inventory_uses_repo_root_validation_commands(self) -> None:
        missing = gate.ScopeSpec(
            name="media",
            report_builder=lambda: report("media", status="ready", allowed=True),
            validator=lambda _report: [],
            required_status="ready",
            runtime_surface="display",
            required_runtime_evidence=("launcher proof",),
            required_evidence_files=(
                gate.EvidenceSpec(
                    path=gate.ROOT / "docs/evidence/android/eliza_launcher_runtime_evidence.json",
                    description="launcher proof",
                    json_expectations=(("status", "eq", "PASS"),),
                ),
            ),
        )
        with mock.patch.object(gate, "SCOPES", (missing,)):
            payload = gate.run_check(Namespace())

        inventory = payload["runtime_evidence_collection_inventory"][0]
        blocked_file = inventory["blocked_evidence_files"][0]
        self.assertEqual(
            blocked_file["validation_command"],
            "python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py",
        )
        self.assertEqual(
            blocked_file["validation_commands"],
            ["python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py"],
        )
        self.assertIn(
            "python3 packages/chip/scripts/aggregate_tapeout_readiness.py --scope phone --strict",
            inventory["next_commands"],
        )
        self.assertNotIn(
            "python3 scripts/check_phone_runtime_readiness_contract.py",
            inventory["next_commands"],
        )

    def test_prioritized_runtime_capture_plan_lists_live_evidence_without_release_credit(
        self,
    ) -> None:
        with mock.patch.object(
            gate,
            "SCOPES",
            (
                gate.ScopeSpec(
                    name="security_lifecycle",
                    report_builder=lambda: report("security", status="blocked", allowed=False),
                    validator=lambda _report: [],
                    required_status="ready",
                    runtime_surface="verified boot",
                    required_runtime_evidence=("rollback proof",),
                    required_evidence_files=(
                        gate.EvidenceSpec(
                            path=gate.ROOT
                            / "docs/evidence/android/security/rollback_rejection.log",
                            description="rollback proof",
                            required_tokens=("ROLLBACK_REJECTED=pass",),
                        ),
                    ),
                ),
                gate.ScopeSpec(
                    name="power_thermal",
                    report_builder=lambda: report("power", status="blocked", allowed=False),
                    validator=lambda _report: [],
                    required_status="ready",
                    runtime_surface="power thermal",
                    required_runtime_evidence=("sustained NPU trace",),
                    required_evidence_files=(
                        gate.EvidenceSpec(
                            path=gate.ROOT
                            / "docs/evidence/android/power/sustained_npu_power_thermal_trace.json",
                            description="power trace",
                            json_expectations=(("status", "eq", "PASS"),),
                        ),
                    ),
                ),
            ),
        ):
            payload = gate.run_check(Namespace())

        plan = payload["prioritized_runtime_capture_plan"]
        self.assertEqual(
            [row["capture_area"] for row in plan], ["security_lifecycle", "power_thermal"]
        )
        self.assertTrue(all(row["release_credit"] is False for row in plan))
        security = plan[0]
        self.assertIn(
            "docs/evidence/android/security/rollback_rejection.log",
            security["expected_output_files"],
        )
        self.assertTrue(
            any(
                "ELIZA_ROLLBACK_REJECTION_COMMAND" in command
                for command in security["capture_commands"]
            )
        )
        self.assertFalse(any("<lab command" in command for command in security["capture_commands"]))
        power = plan[1]
        self.assertIn(
            "docs/evidence/android/power/sustained_npu_power_thermal_trace.json",
            power["expected_output_files"],
        )
        self.assertTrue(
            any(
                "ELIZA_CALIBRATED_POWER_THERMAL_CAPTURE_COMMAND" in command
                for command in power["capture_commands"]
            )
        )

    def test_ready_scope_with_matching_json_runtime_evidence_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "launcher.json"
            evidence.write_text(
                '{"status":"PASS","result":0,"device":{"cpu_abi":"riscv64"},'
                '"agent":{"health_ready":true},'
                '"app":{"role_holders":{"android.app.role.HOME":["ai.elizaos.app"]}}}',
                encoding="utf-8",
            )
            ready_with_file = gate.ScopeSpec(
                name="media",
                report_builder=lambda: report("media", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="display/camera",
                required_runtime_evidence=("HWC proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=evidence,
                        description="fixture launcher proof",
                        json_expectations=(
                            ("status", "eq", "PASS"),
                            ("result", "eq", 0),
                            ("device.cpu_abi", "eq", "riscv64"),
                            ("agent.health_ready", "eq", True),
                            (
                                "app.role_holders.android.app.role.HOME",
                                "contains",
                                "ai.elizaos.app",
                            ),
                        ),
                    ),
                ),
            )
            with mock.patch.object(gate, "SCOPES", (ready_with_file,)):
                payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(payload["runtime_evidence_collection_inventory"], [])
        runtime_files = payload["evidence"]["scopes"]["media"]["runtime_evidence_files"]
        self.assertEqual(runtime_files[0]["status"], "pass")

    def test_launcher_package_expectation_comes_from_apk_payload_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            report_path = tmp_root / "build/reports/android_system_apk_payload.json"
            report_path.parent.mkdir(parents=True)
            report_path.write_text(
                json.dumps(
                    {
                        "schema": "eliza.android_system_apk_payload.v1",
                        "status": "pass",
                        "evidence": {
                            "provenance_android_package": "ai.milady.milady",
                            "vendor_ro_elizaos_home": "ai.milady.milady",
                        },
                    }
                ),
                encoding="utf-8",
            )
            evidence = tmp_root / "launcher.json"
            evidence.write_text(
                json.dumps(
                    {
                        "status": "PASS",
                        "app": {
                            "package_name": "ai.milady.milady",
                            "foreground_activity": "ai.milady.milady/.MainActivity",
                            "home_resolve_activity": "ai.milady.milady/.MainActivity",
                            "role_holders": {
                                "android.app.role.HOME": ["ai.milady.milady"],
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            dynamic_spec = gate.ScopeSpec(
                name="media",
                report_builder=lambda: report("media", status="ready", allowed=True),
                validator=lambda _report: [],
                required_status="ready",
                runtime_surface="display/camera",
                required_runtime_evidence=("launcher proof",),
                required_evidence_files=(
                    gate.EvidenceSpec(
                        path=evidence,
                        description="branded launcher proof",
                        json_expectations=(
                            ("status", "eq", "PASS"),
                            ("app.package_name", "eq", gate.ANDROID_PAYLOAD_PACKAGE_SENTINEL),
                            (
                                "app.role_holders.android.app.role.HOME",
                                "contains",
                                gate.ANDROID_PAYLOAD_PACKAGE_SENTINEL,
                            ),
                        ),
                    ),
                ),
            )
            with (
                mock.patch.object(gate, "ROOT", tmp_root),
                mock.patch.object(gate, "ANDROID_APK_PAYLOAD_REPORT", report_path),
                mock.patch.object(gate, "SCOPES", (dynamic_spec,)),
            ):
                payload = gate.run_check(Namespace())
        self.assertEqual(payload["status"], "pass")
        runtime_files = payload["evidence"]["scopes"]["media"]["runtime_evidence_files"]
        self.assertEqual(
            runtime_files[0]["json_expectations"],
            [
                {"path": "status", "op": "eq", "expected": "PASS"},
                {"path": "app.package_name", "op": "eq", "expected": "ai.milady.milady"},
                {
                    "path": "app.role_holders.android.app.role.HOME",
                    "op": "contains",
                    "expected": "ai.milady.milady",
                },
            ],
        )


if __name__ == "__main__":
    unittest.main()
