from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_controller_telemetry import (
    build_fembot_controller_telemetry_plan_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_controller_telemetry_plan_requires_per_actuator_hardware_records() -> None:
    report = build_fembot_controller_telemetry_plan_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-controller-telemetry-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["actuators"] == 25
    assert report["summary"]["actuated_links"] == 25
    assert report["summary"]["non_actuated_links"] == [
        "IMU_ORIGIN",
        "LEFT_TOE",
        "RIGHT_TOE",
    ]
    assert report["summary"]["simulated_response_ok_actuators"] == 25
    assert report["summary"]["simulated_response_failure_actuators"] == 0
    assert report["summary"]["hardware_telemetry_present_actuators"] == 0
    assert report["summary"]["missing_hardware_telemetry_actuators"] == 25
    assert report["summary"]["required_telemetry_fields_per_actuator"] == 6
    assert report["summary"]["required_telemetry_records"] == 150
    assert report["summary"]["max_simulated_final_abs_error_rad"] < 0.1
    assert report["summary"]["max_simulated_response_fraction_abs"] < 4.0
    assert "timestamped hardware" in report["summary"]["acceptance_blocker"]

    first = report["actuators"][0]
    assert first["actuator_index"] == 0
    assert first["joint"].endswith("_joint")
    assert first["link"]
    assert first["simulated_response_ok"] is True
    assert first["hardware_telemetry_present"] is False
    assert first["required_telemetry_fields"] == [
        "commanded_target_rad",
        "measured_position_rad",
        "measured_velocity_rad_s",
        "current_or_torque",
        "control_latency_s",
        "temperature_c",
    ]


def test_fembot_controller_telemetry_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-controller-telemetry-plan.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_controller_telemetry_plan.py",
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
    assert report["schema"] == "asimov-fembot-controller-telemetry-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"missing_hardware_telemetry_actuators": 25' in proc.stdout
