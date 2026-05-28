from __future__ import annotations

import json
import math
import subprocess
import sys

from eliza_robot.asimov_1.fembot_controller_validation import (
    build_fembot_controller_validation_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_controller_validation_tracks_simulated_command_contract() -> None:
    report = build_fembot_controller_validation_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-controller-validation-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["local_controller_contract_ok"] is True
    assert report["summary"]["mujoco_controller_rollout_ok"] is True
    assert report["summary"]["actuator_order_ok"] is True
    assert report["summary"]["actuators_commanded"] == 25
    assert report["summary"]["finite_state_ok"] is True
    assert report["summary"]["joint_limit_ok"] is True
    assert report["summary"]["control_range_ok"] is True
    assert report["summary"]["motor_response_profile_ok"] is True
    assert report["summary"]["hardware_controller_validated"] is False
    assert math.isfinite(report["summary"]["trajectory_final_max_abs_error_rad"])
    assert report["summary"]["trajectory_final_max_abs_error_rad"] < 0.1
    assert report["summary"]["trajectory_final_median_abs_error_rad"] < 0.02
    assert 0.0 <= report["summary"]["trajectory_early_median_response_fraction"] < 0.5
    assert report["summary"]["trajectory_settled_median_response_fraction"] > report[
        "summary"
    ]["trajectory_early_median_response_fraction"]
    assert report["summary"]["trajectory_response_overshoot_count"] == 0
    assert report["summary"]["trajectory_max_final_response_fraction"] < 4.0
    assert "hardware motor-controller telemetry" in report["summary"][
        "acceptance_blocker"
    ]

    assert all(report["contract"]["checks"].values())
    assert report["rollout"]["actuator_joint_order"] == report["contract"]["details"][
        "firmware_joint_order"
    ]
    assert report["rollout"]["motor_response_profile_ok"] is True
    assert report["rollout"]["response_overshoot_count"] == 0
    assert report["rollout"]["joint_limit_violations"] == []
    assert report["rollout"]["control_range_violations"] == []


def test_fembot_controller_validation_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-controller-validation.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_controller_validation_proof.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-controller-validation-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"accepted": false' in proc.stdout
