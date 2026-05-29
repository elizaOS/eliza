from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_slimming_envelope import build_fembot_slimming_envelope_proof


def test_fembot_slimming_envelope_estimates_bounds_for_all_links() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_slimming_envelope_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-slimming-envelope-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["body_groups"] == 5
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["links_with_protected_anchors"] == 28
    assert report["summary"]["links_with_process_constraints"] == 28
    assert report["summary"]["process_active_limiter_links"] == 0
    assert report["summary"]["z_preserved_links"] == 28
    assert report["summary"]["candidate_total_xy_area_reduction_fraction"] is not None
    assert report["summary"]["candidate_total_xy_area_reduction_fraction"] > 0.0

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["link_count"] == 2
    assert groups["head"]["link_count"] == 2
    assert groups["arm"]["link_count"] == 10
    assert groups["leg"]["link_count"] == 12
    assert groups["foot"]["link_count"] == 2
    assert groups["arm"]["manufacturing_constraints"]["minimum_wall_thickness_m"] > 0.0
    assert groups["arm"]["manufacturing_constraints"]["requires_tool_access_check"] is True
    assert groups["head"]["manufacturing_constraints"]["requires_smoothness_check"] is True

    left_elbow = {
        record["link"]: record
        for group in report["body_groups"]
        for record in group["link_records"]
    }["LEFT_ELBOW"]
    assert left_elbow["protected_anchor_count"] >= 1
    assert left_elbow["manufacturing_constraints"]["minimum_envelope_extent_m"] > 0.0
    assert left_elbow["axis_constraints"]["z"]["preserve_current_extent"] is True
    assert left_elbow["axis_constraints"]["x"]["process_minimum_extent_m"] > 0.0
    assert left_elbow["axis_constraints"]["x"]["candidate_scale"] <= 1.0
    assert left_elbow["candidate_xy_area_reduction_fraction"] is not None


def test_fembot_slimming_envelope_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "slimming-envelope.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_slimming_envelope.py",
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
    assert report["schema"] == "asimov-fembot-slimming-envelope-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"z_preserved_links": 28' in proc.stdout
