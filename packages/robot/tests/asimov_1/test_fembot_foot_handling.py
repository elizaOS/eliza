from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_foot_handling import build_fembot_foot_handling_proof
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_foot_handling_preserves_floor_contact_and_flat_toe_plates() -> None:
    report = build_fembot_foot_handling_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-foot-handling-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["foot_collision_geoms_preserved"] is True
    assert report["summary"]["fembot_foot_collision_geoms"] >= 20
    assert report["summary"]["floor_contact_count"] > 0
    assert report["summary"]["neutral_floor_contact_count"] > 0
    assert report["summary"]["approved_floor_contact_count"] == report["summary"]["floor_contact_count"]
    assert report["summary"]["non_foot_floor_contact_count"] == 0
    assert report["summary"]["flat_foot_plate_count"] == 2
    assert report["summary"]["manufacturing_adjusted_foot_plate_count"] == 2
    assert report["summary"]["foot_flatness_ok_count"] == 2
    assert report["geom_preservation"]["missing_geoms"] == []
    assert report["geom_preservation"]["added_geoms"] == []
    assert report["geom_preservation"]["changed_geoms"] == []
    assert {record["link"] for record in report["foot_plates"]} == {"LEFT_TOE", "RIGHT_TOE"}
    for record in report["foot_plates"]:
        assert record["accepted"] is True
        assert record["shape_family"] == "flat_plate_envelope"
        assert record["surface_intent"] == "flat"
        assert record["material_class"] == "ALU_7075"
        assert record["nominal_wall_thickness_ok"] is False
        assert record["manufacturing_adjusted_wall_thickness_ok"] is True
        assert record["manufacturing_adjusted_process_floor_satisfied"] is True
        assert record["manufacturing_adjusted_height_delta_m"] == 0.0


def test_fembot_foot_handling_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-foot-handling.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_foot_handling_proof.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["accepted"] is True
    assert '"accepted": true' in proc.stdout
