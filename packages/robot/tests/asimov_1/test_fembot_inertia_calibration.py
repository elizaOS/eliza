from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inertia_calibration import (
    build_fembot_inertia_calibration_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_inertia_calibration_maps_cad_mass_to_compiled_mujoco_bodies() -> None:
    report = build_fembot_inertia_calibration_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-inertia-calibration-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["compiled_body_records"] == 28
    assert report["summary"]["missing_compiled_links"] == []
    assert report["summary"]["missing_material_links"] == []
    assert report["summary"]["calibration_ready"] is True
    assert report["summary"]["hardware_measured_links"] == 0
    assert report["summary"]["hardware_measurement_schema"] is None
    assert report["summary"]["hardware_measurement_required_links"] == 0
    assert len(report["summary"]["missing_hardware_links"]) == 28
    assert report["summary"]["cad_mass_estimate_kg"] > 0.0
    assert report["summary"]["compiled_total_mass_kg"] > 0.0
    assert report["summary"]["max_abs_mass_relative_delta_vs_cad"] > 0.0
    assert report["summary"]["max_abs_inertia_relative_delta_vs_cad"] > 0.0
    assert report["summary"]["mass_relative_delta_tolerance"] == 0.10
    assert report["summary"]["inertia_relative_delta_tolerance"] == 0.25
    assert report["summary"]["mass_out_of_tolerance_count"] == 26
    assert report["summary"]["inertia_out_of_tolerance_count"] == 25
    assert len(report["summary"]["mass_out_of_tolerance_links"]) == 26
    assert len(report["summary"]["inertia_out_of_tolerance_links"]) == 25
    assert report["summary"]["total_required_added_mass_to_match_compiled_kg"] > 0.0
    assert report["summary"]["max_required_added_mass_to_match_compiled_kg"] > 0.0
    assert report["summary"]["max_mass_scale_to_compiled"] > 1.0
    assert report["summary"]["max_inertia_scale_to_compiled"] > 1.0
    assert "hardware-identified mass/inertia measurements are missing" in report["summary"][
        "acceptance_blocker"
    ]

    records = {record["link"]: record for record in report["link_inertia_records"]}
    assert records["IMU_ORIGIN"]["body"] == "pelvis_link"
    assert records["LEFT_ANKLE_A"]["body"] == "left_ankle_pitch_link"
    assert records["LEFT_ANKLE_B"]["body"] == "left_ankle_roll_link"
    assert records["LEFT_KNEE"]["compiled_mass_kg"] > 0.0
    assert records["LEFT_KNEE"]["cad_material_mass_estimate_kg"] > 0.0
    assert records["LEFT_KNEE"]["required_added_mass_to_match_compiled_kg"] > 0.0
    assert records["LEFT_KNEE"]["mass_scale_to_compiled"] > 1.0
    assert records["LEFT_KNEE"]["mass_within_tolerance"] is False
    assert records["LEFT_KNEE"]["inertia_within_tolerance"] is False
    assert records["LEFT_KNEE"]["calibration_action"] == "hardware_measurement_required"
    assert records["LEFT_KNEE"]["hardware_measurement_present"] is False


def test_fembot_inertia_calibration_consumes_hardware_requirement_report_shape() -> None:
    report = build_fembot_inertia_calibration_proof(
        _body_groups(),
        hardware_measurements={
            "schema": "asimov-fembot-hardware-measurement-requirements-v1",
            "links": [
                {
                    "link": "LEFT_KNEE",
                    "measurement_count": 42,
                    "missing_measurement_count": 42,
                    "accepted": False,
                }
            ],
        },
    )

    assert report["summary"]["hardware_measurement_schema"] == (
        "asimov-fembot-hardware-measurement-requirements-v1"
    )
    assert report["summary"]["hardware_measurement_required_links"] == 1
    assert report["summary"]["hardware_measured_links"] == 0
    assert len(report["summary"]["missing_hardware_links"]) == 28
    records = {record["link"]: record for record in report["link_inertia_records"]}
    assert records["LEFT_KNEE"]["hardware_measurement_requirement_count"] == 42
    assert records["LEFT_KNEE"]["hardware_measurement_missing_count"] == 42
    assert records["LEFT_KNEE"]["hardware_measurement_present"] is False


def test_fembot_inertia_calibration_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-inertia-calibration.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_inertia_calibration_proof.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["hardware_measurement_schema"] == (
        "asimov-fembot-hardware-measurement-requirements-v1"
    )
    assert report["summary"]["hardware_measurement_required_links"] == 28
    assert report["summary"]["hardware_measured_links"] == 0
    assert '"accepted": false' in proc.stdout
