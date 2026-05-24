from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.constants import ASIMOV1_FULL_ACTION_DIM
from eliza_robot.asimov_1.fembot_assembly import build_fembot_assembly_proof
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS, collect_fembot_inventory


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_assembly_proof_measures_whole_robot_topology() -> None:
    report = build_fembot_assembly_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-assembly-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["height_m"] > 0.0
    assert report["summary"]["source_height_m"] > 0.0
    assert report["summary"]["height_delta_m"] >= 0.0
    assert report["summary"]["joint_count"] >= ASIMOV1_FULL_ACTION_DIM
    assert report["summary"]["actuator_count"] == ASIMOV1_FULL_ACTION_DIM
    assert report["summary"]["expected_actuator_count"] == ASIMOV1_FULL_ACTION_DIM
    assert report["summary"]["actuator_order_ok"] is True
    assert report["summary"]["visual_body_link_count"] == 28
    assert report["summary"]["generated_link_count"] == 28
    assert report["summary"]["missing_generated_links"] == []
    assert report["summary"]["mate_gap_max_m"] == 0.0
    assert report["summary"]["axis_delta_max_rad"] == 0.0
    assert report["summary"]["mujoco_static_dynamic_ok"] is True
    assert report["summary"]["structural_remediation_assembly_links"] == 6
    assert report["summary"]["structural_remediation_actuated_links"] == 6
    assert report["summary"]["structural_remediation_child_interface_links"] == 6
    assert report["summary"]["structural_remediation_height_preserved_links"] == 6
    assert report["summary"]["structural_remediation_center_preserved_links"] == 6
    assert report["summary"]["structural_remediation_residual_cavity_links"] == 6
    assert report["summary"]["structural_remediation_z_refinement_links"] == 2
    assert report["summary"]["structural_remediation_max_xy_area_increase_fraction"] > 1.4

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["generated_link_count"] == 2
    assert groups["arm"]["generated_link_count"] == 10
    assert groups["arm"]["structural_remediation_assembly_links"] == [
        "LEFT_SHOULDER_YAW",
        "RIGHT_SHOULDER_YAW",
    ]
    assert groups["leg"]["generated_link_count"] == 12
    assert groups["leg"]["structural_remediation_assembly_links"] == [
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
    ]

    impacts = {record["link"]: record for record in report["structural_remediation_assembly_impact"]}
    assert impacts["LEFT_KNEE"]["joint_names"] == ["left_knee_joint"]
    assert impacts["LEFT_KNEE"]["actuator_names"] == ["left_knee_joint"]
    assert impacts["LEFT_KNEE"]["child_links"] == ["LEFT_ANKLE_A"]
    assert impacts["LEFT_KNEE"]["height_preserved"] is True
    assert impacts["LEFT_KNEE"]["center_preserved"] is True
    assert impacts["LEFT_KNEE"]["xy_area_increase_fraction"] > 1.4
    assert impacts["LEFT_KNEE"]["internal_cavity_residual_violations"] == 4
    assert impacts["LEFT_SHOULDER_YAW"]["requires_z_pocket_or_component_refinement"] is True


def test_fembot_inventory_surfaces_assembly_status() -> None:
    report = collect_fembot_inventory()

    assert report["assembly"]["ok"] is True
    assert report["assembly"]["accepted"] is False
    assert report["assembly"]["summary"]["actuator_order_ok"] is True
    assert report["assembly"]["summary"]["generated_link_count"] == 28
    assert report["assembly"]["summary"]["visual_body_link_count"] == 28
    assert report["assembly"]["summary"]["structural_remediation_assembly_links"] == 6
    assert report["assembly"]["summary"]["structural_remediation_actuated_links"] == 6
    assert report["assembly"]["summary"]["structural_remediation_z_refinement_links"] == 2
    for group in report["body_groups"]:
        assert "whole_robot_assembly" in group["missing_proofs"]


def test_fembot_assembly_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "assembly.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_assembly_proof.py",
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
    assert report["schema"] == "asimov-fembot-assembly-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
