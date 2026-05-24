from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_keepouts import build_fembot_keepout_proof


def test_fembot_keepout_proof_inventories_mjcf_and_vendor_envelopes() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_keepout_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-keepout-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["missing_links"] == []
    assert report["summary"]["mjcf_mesh_refs"] == 28
    assert report["summary"]["mjcf_position_actuators"] == 25
    assert report["summary"]["joint_keepouts"] == 27
    assert report["summary"]["actuator_keepouts"] == 25
    assert report["summary"]["collision_keepouts"] >= 30
    assert report["summary"]["source_mesh_envelopes"] == 28
    assert report["summary"]["off_the_shelf_vendor_envelopes"] > 0

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["component_count"] > 0
    assert groups["arm"]["component_count"] > groups["head"]["component_count"]
    assert groups["leg"]["component_count"] > groups["arm"]["component_count"]
    assert groups["foot"]["off_the_shelf_scaled"] is False
    assert groups["foot"]["minimum_clearance_m"] is None

    left_toe = {
        link_record["link"]: link_record
        for link_record in groups["foot"]["link_keepouts"]
    }["LEFT_TOE"]
    assert left_toe["source_mesh_envelope"]["bbox_extent_m"][0] > 0.0
    assert len(left_toe["collision_keepouts"]) >= 5
    assert left_toe["off_the_shelf_scaled"] is False
    assert left_toe["accepted"] is False


def test_fembot_inventory_surfaces_keepout_status() -> None:
    report = collect_fembot_inventory()

    assert report["keepouts"]["ok"] is True
    assert report["keepouts"]["accepted"] is False
    assert report["keepouts"]["summary"]["source_mesh_envelopes"] == 28
    for group in report["body_groups"]:
        assert "motor_bearing_ring_gear_pulley_fastener_keepouts" in group["missing_proofs"]


def test_fembot_keepout_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "keepouts.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_keepout_proof.py",
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
    assert report["schema"] == "asimov-fembot-keepout-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": false' in proc.stdout
