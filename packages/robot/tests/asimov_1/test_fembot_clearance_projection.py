from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_clearance_projection import build_fembot_clearance_projection_proof
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory


def test_fembot_clearance_projection_checks_slimming_against_keepout_points() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_clearance_projection_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-clearance-projection-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["body_groups"] == 5
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["keepout_points"] > 0
    assert report["summary"]["violation_links"] > 0
    assert report["summary"]["violations"] >= report["summary"]["violation_links"]
    assert report["summary"]["minimum_projected_clearance_m"] is not None
    assert report["summary"]["adjusted_violation_links"] == 0
    assert report["summary"]["adjusted_violations"] == 0
    assert report["summary"]["adjusted_minimum_projected_clearance_m"] >= 0.0
    assert report["summary"]["adjusted_area_increase_fraction"] is not None
    assert report["summary"]["adjusted_area_increase_fraction"] > 0.0

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["arm"]["keepout_point_count"] > 0
    assert groups["leg"]["keepout_point_count"] > groups["arm"]["keepout_point_count"]

    left_toe = {
        record["link"]: record for record in report["link_clearance"]
    }["LEFT_TOE"]
    assert left_toe["keepout_point_count"] >= 5
    assert left_toe["minimum_projected_clearance_m"] is not None
    assert left_toe["adjusted_violation_count"] == 0
    assert left_toe["adjusted_bbox_extent_m"][0] >= left_toe["candidate_bbox_extent_m"][0]
    assert left_toe["projected_points"]
    assert all(point["component_radius_m"] >= 0.0 for point in left_toe["adjusted_projected_points"])
    assert left_toe["accepted"] is False


def test_fembot_clearance_projection_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "clearance-projection.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_clearance_projection.py",
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
    assert report["schema"] == "asimov-fembot-clearance-projection-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
