from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS
from eliza_robot.asimov_1.fembot_mate_feature_specs import (
    build_fembot_mate_feature_specs_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_mate_feature_specs_define_parametric_joint_and_child_mates() -> None:
    report = build_fembot_mate_feature_specs_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-mate-feature-specs-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["parametric_mate_feature_spec_ready_links"] == 28
    assert report["summary"]["joint_feature_spec_records"] == 27
    assert report["summary"]["child_interface_datum_records"] == 27
    assert report["summary"]["feature_cut_step_links"] == 0
    assert report["summary"]["post_cut_collision_validated_links"] == 0
    assert report["summary"]["post_cut_structural_validated_links"] == 0

    links = {record["link"]: record for record in report["links"]}
    knee_joint = links["LEFT_KNEE"]["joint_feature_specs"][0]
    assert knee_joint["bore"]["type"] == "cylindrical_cut"
    assert knee_joint["bore"]["diameter_m"] > 0.0
    assert knee_joint["bearing_seat"]["outer_diameter_m"] > knee_joint["bore"]["diameter_m"]
    assert knee_joint["fastener_pattern"]["type"] == "four_point_bolt_circle"
    assert len(knee_joint["fastener_pattern"]["unit_offsets"]) == 4
    assert knee_joint["measurement_evidence_required"] is True
    assert links["WAIST_YAW"]["child_interface_datums"]
    assert links["IMU_ORIGIN"]["parametric_mate_feature_spec_ready"] is True


def test_fembot_mate_feature_specs_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-mate-feature-specs.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mate_feature_specs.py",
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
    assert report["schema"] == "asimov-fembot-mate-feature-specs-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert '"joint_feature_spec_records": 27' in proc.stdout
