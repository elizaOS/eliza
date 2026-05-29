from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_hardware_measurements import (
    apply_fembot_hardware_measurement_evidence,
    build_fembot_hardware_measurement_requirements_proof,
    build_fembot_hardware_measurement_template,
    validate_fembot_hardware_measurement_evidence,
)
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory


def _valid_value_for_unit(unit: str) -> object:
    if unit == "kg":
        return 1.25
    if unit == "m":
        return 0.012
    if unit == "m_triplet":
        return [0.01, 0.02, 0.03]
    if unit == "kg_m2_triplet":
        return [0.001, 0.002, 0.003]
    return "measured fixture evidence"


def _valid_evidence_from_template(template: dict[str, object]) -> dict[str, object]:
    return {
        "measurements": [
            {
                "measurement_key": row["measurement_key"],
                "value": _valid_value_for_unit(str(row["expected_unit"])),
                "unit": row["expected_unit"],
                "source": "synthetic acceptance fixture",
                "source_type": "test_fixture",
            }
            for row in template["measurements"]
        ]
    }


def test_fembot_hardware_measurements_turn_clearance_gaps_into_required_dimensions() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_hardware_measurement_requirements_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-hardware-measurement-requirements-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["actuator_links"] == 25
    assert report["summary"]["joint_links"] == 27
    assert report["summary"]["vendor_envelope_links"] == 28
    assert report["summary"]["links_with_remediation_targets"] == 26
    assert report["summary"]["remediation_targets"] == 73
    assert report["summary"]["measurement_records"] == 1047
    assert report["summary"]["missing_measurement_records"] == 1047
    assert report["summary"]["family_counts"] == {
        "bearing_or_ring": 135,
        "component_specific_clearance": 219,
        "fastener_or_thread": 140,
        "gear_or_pulley_or_belt": 100,
        "mass_inertia_calibration": 112,
        "motor_actuator": 125,
        "vendor_off_the_shelf": 112,
        "wiring_or_service_access": 104,
    }
    assert report["summary"]["vendor_envelopes_with_supplier_codes"] == 8
    assert report["summary"]["vendor_envelopes_with_component_family_keywords"] == 0

    links = {record["link"]: record for record in report["links"]}
    waist = links["WAIST_YAW"]
    assert waist["actuator_link"] is True
    assert waist["joint_link"] is True
    assert waist["vendor_envelope_link"] is True
    assert waist["remediation_target_count"] > 0
    assert {
        "motor_actuator",
        "bearing_or_ring",
        "gear_or_pulley_or_belt",
        "fastener_or_thread",
        "wiring_or_service_access",
        "vendor_off_the_shelf",
        "component_specific_clearance",
        "mass_inertia_calibration",
    }.issubset(set(waist["families_required"]))

    left_toe = links["LEFT_TOE"]
    assert left_toe["actuator_link"] is False
    assert left_toe["joint_link"] is True
    assert left_toe["remediation_target_count"] == 0
    assert set(left_toe["families_required"]) == {
        "bearing_or_ring",
        "fastener_or_thread",
        "mass_inertia_calibration",
        "vendor_off_the_shelf",
    }

    template = build_fembot_hardware_measurement_template(report)
    assert template["schema"] == "asimov-fembot-hardware-measurement-template-v1"
    assert template["summary"]["rows"] == 1047
    assert template["summary"]["missing_rows"] == 1047
    assert template["summary"]["families"]["component_specific_clearance"] == 219
    assert template["summary"]["families"]["mass_inertia_calibration"] == 112
    first = template["measurements"][0]
    assert first["measurement_key"]
    assert first["value"] is None
    assert first["source"] is None
    assert first["source_type"] is None
    assert first["status"] == "empty"

    empty_validation = validate_fembot_hardware_measurement_evidence(
        report,
        {"measurements": []},
    )
    assert empty_validation["accepted"] is False
    assert empty_validation["summary"]["required_measurements"] == 1047
    assert empty_validation["summary"]["missing_measurements"] == 1047

    one_row_validation = validate_fembot_hardware_measurement_evidence(
        report,
        {
            "measurements": [
                {
                    "measurement_key": first["measurement_key"],
                    "value": _valid_value_for_unit(first["expected_unit"]),
                    "unit": first["expected_unit"],
                    "source": "test fixture",
                    "source_type": "test_fixture",
                }
            ]
        },
    )
    assert one_row_validation["summary"]["filled_measurements"] == 1
    assert one_row_validation["summary"]["missing_measurements"] == 1046
    assert one_row_validation["unknown_keys"] == []
    assert one_row_validation["invalid_measurements"] == []
    assert one_row_validation["provenance_errors"] == []

    accepted_report = apply_fembot_hardware_measurement_evidence(
        report,
        _valid_evidence_from_template(template),
    )
    assert accepted_report["accepted"] is True
    assert accepted_report["summary"]["accepted"] is True
    assert accepted_report["summary"]["accepted_measurement_records"] == 1047
    assert accepted_report["summary"]["missing_measurement_records"] == 0
    assert accepted_report["evidence_validation"]["accepted"] is True
    assert all(record["accepted"] is True for record in accepted_report["links"])
    assert all(record["accepted"] is True for record in accepted_report["body_groups"])


def test_fembot_hardware_measurements_reject_invalid_typed_values() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_hardware_measurement_requirements_proof(inventory["body_groups"])
    template = build_fembot_hardware_measurement_template(report)
    by_field = {row["field"]: row for row in template["measurements"]}
    mass = by_field["measured_link_mass_kg"]
    inertia = by_field["measured_diagonal_inertia_kg_m2"]

    validation = validate_fembot_hardware_measurement_evidence(
        report,
        {
            "measurements": [
                {
                    "measurement_key": mass["measurement_key"],
                    "value": "M3",
                    "unit": mass["expected_unit"],
                    "source": "test fixture",
                    "source_type": "test_fixture",
                },
                {
                    "measurement_key": inertia["measurement_key"],
                    "value": [0.001, -0.002, 0.003],
                    "unit": inertia["expected_unit"],
                    "source": "test fixture",
                    "source_type": "test_fixture",
                },
            ]
        },
    )

    assert validation["accepted"] is False
    assert validation["summary"]["filled_measurements"] == 0
    assert validation["summary"]["invalid_measurements"] == 2
    assert validation["summary"]["missing_measurements"] == 1047
    assert {row["measurement_key"] for row in validation["invalid_measurements"]} == {
        mass["measurement_key"],
        inertia["measurement_key"],
    }


def test_fembot_hardware_measurements_reject_missing_evidence_provenance() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_hardware_measurement_requirements_proof(inventory["body_groups"])
    first = build_fembot_hardware_measurement_template(report)["measurements"][0]

    validation = validate_fembot_hardware_measurement_evidence(
        report,
        {
            "measurements": [
                {
                    "measurement_key": first["measurement_key"],
                    "value": _valid_value_for_unit(first["expected_unit"]),
                    "unit": first["expected_unit"],
                    "source": "bench note without typed provenance",
                }
            ]
        },
    )

    assert validation["accepted"] is False
    assert validation["summary"]["filled_measurements"] == 0
    assert validation["summary"]["provenance_errors"] == 1
    assert validation["summary"]["missing_measurements"] == 1047
    assert validation["provenance_errors"][0]["measurement_key"] == first["measurement_key"]


def test_fembot_inventory_surfaces_hardware_measurement_status() -> None:
    report = collect_fembot_inventory()

    assert report["hardware_measurements"]["ok"] is True
    assert report["hardware_measurements"]["accepted"] is False
    assert report["hardware_measurements"]["summary"]["measurement_records"] == 1047
    assert report["hardware_measurements"]["summary"]["remediation_targets"] == 73
    assert (
        report["hardware_measurements"]["summary"]["family_counts"][
            "component_specific_clearance"
        ]
        == 219
    )
    assert (
        report["hardware_measurements"]["summary"]["family_counts"][
            "mass_inertia_calibration"
        ]
        == 112
    )
    for group in report["body_groups"]:
        assert "hardware_measurements" in group["required_proofs"]
        assert "hardware_measurements" in group["missing_proofs"]


def test_fembot_hardware_measurements_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-hardware-measurements.json"
    template_output = tmp_path / "fembot-hardware-measurement-template.json"
    validation_output = tmp_path / "fembot-hardware-measurement-validation.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_hardware_measurements_proof.py",
            "--output",
            str(output),
            "--template-output",
            str(template_output),
            "--validation-output",
            str(validation_output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    assert template_output.is_file()
    assert validation_output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    template = json.loads(template_output.read_text(encoding="utf-8"))
    validation = json.loads(validation_output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-hardware-measurement-requirements-v1"
    assert template["schema"] == "asimov-fembot-hardware-measurement-template-v1"
    assert validation["schema"] == "asimov-fembot-hardware-measurement-evidence-v1"
    assert template["summary"]["rows"] == report["summary"]["measurement_records"]
    assert validation["summary"]["required_measurements"] == template["summary"]["rows"]
    assert validation["summary"]["missing_measurements"] == template["summary"]["rows"]
    assert validation["summary"]["provenance_errors"] == 0
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"accepted": false' in proc.stdout


def test_fembot_hardware_measurements_cli_validates_partial_evidence(tmp_path) -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_hardware_measurement_requirements_proof(inventory["body_groups"])
    template = build_fembot_hardware_measurement_template(report)
    first = template["measurements"][0]
    evidence = {
        "measurements": [
            {
                "measurement_key": first["measurement_key"],
                "value": _valid_value_for_unit(first["expected_unit"]),
                "unit": first["expected_unit"],
                "source": "test fixture",
                "source_type": "test_fixture",
            },
            {
                "measurement_key": "unknown:key",
                "value": 1,
                "unit": "m",
                "source": "test fixture",
            },
        ]
    }
    evidence_path = tmp_path / "partial-evidence.json"
    evidence_path.write_text(json.dumps(evidence), encoding="utf-8")
    output = tmp_path / "fembot-hardware-measurements.json"
    template_output = tmp_path / "fembot-hardware-measurement-template.json"
    validation_output = tmp_path / "fembot-hardware-measurement-validation.json"

    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_hardware_measurements_proof.py",
            "--output",
            str(output),
            "--template-output",
            str(template_output),
            "--validation-output",
            str(validation_output),
            "--evidence",
            str(evidence_path),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert validation_output.is_file()
    validation = json.loads(validation_output.read_text(encoding="utf-8"))
    assert validation["accepted"] is False
    assert validation["summary"]["filled_measurements"] == 1
    assert validation["summary"]["unknown_measurements"] == 1
    assert validation["summary"]["missing_measurements"] == 1046
    assert validation["summary"]["provenance_errors"] == 0
    assert validation["unknown_keys"] == ["unknown:key"]
    assert proc.returncode == 2
    assert '"unknown_measurements": 1' in proc.stdout
