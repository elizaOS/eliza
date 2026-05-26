from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_cavity_resolution import (
    build_fembot_cavity_resolution_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_cavity_resolution_classifies_height_preserving_and_redesign_links() -> None:
    report = build_fembot_cavity_resolution_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-cavity-resolution-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["source_fitted_links"] == 28
    assert report["summary"]["internal_cavity_violation_links"] == 26
    assert report["summary"]["internal_cavity_violation_points"] == 73
    assert report["summary"]["internal_cavity_violation_component_counts"] == {
        "collision_keepout": 28,
        "joint_axis": 21,
        "motor_actuator": 23,
        "site": 1,
    }
    assert report["summary"]["full_cavity_clearance_cleared_links"] == 26
    assert report["summary"]["height_preserving_resolution_links"] == 10
    assert report["summary"]["component_or_packaging_redesign_required_links"] == 16
    assert report["summary"]["unresolved_geometry_or_keepout_links"] == 0

    links = {record["link"]: record for record in report["links"]}
    assert links["LEFT_HIP_YAW"]["height_preserving_resolution_ready"] is True
    assert links["LEFT_HIP_YAW"]["requires_component_or_packaging_redesign"] is False
    assert links["NECK_YAW"]["requires_component_or_packaging_redesign"] is True
    assert links["NECK_YAW"]["full_cavity_z_expansion_m"] > 0.03
    assert links["LEFT_TOE"]["resolution_strategy"] == "already_clear"


def test_fembot_cavity_resolution_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-cavity-resolution.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_cavity_resolution_proof.py",
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
    assert report["schema"] == "asimov-fembot-cavity-resolution-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"component_or_packaging_redesign_required_links": 16' in proc.stdout
