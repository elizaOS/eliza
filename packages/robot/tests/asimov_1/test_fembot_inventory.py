from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    FEMBOT_PROOF_TYPES,
    collect_fembot_inventory,
)


def test_fembot_inventory_groups_cover_asimov_links_once() -> None:
    links = [link for group_links in FEMBOT_BODY_GROUP_LINKS.values() for link in group_links]

    assert set(FEMBOT_BODY_GROUP_LINKS) == {"torso", "head", "arm", "leg", "foot"}
    assert len(links) == 28
    assert len(set(links)) == 28
    assert "WAIST_YAW" in FEMBOT_BODY_GROUP_LINKS["torso"]
    assert "NECK_PITCH" in FEMBOT_BODY_GROUP_LINKS["head"]
    assert "LEFT_ELBOW" in FEMBOT_BODY_GROUP_LINKS["arm"]
    assert "RIGHT_KNEE" in FEMBOT_BODY_GROUP_LINKS["leg"]
    assert "LEFT_TOE" in FEMBOT_BODY_GROUP_LINKS["foot"]


def test_fembot_inventory_is_stricter_than_visual_parametric_experiment() -> None:
    report = collect_fembot_inventory()

    assert report["schema"] == "asimov-fembot-inventory-v1"
    assert report["ok"] is True
    assert report["production_ready"] is False
    assert report["counts"]["body_groups"] == 5
    assert report["counts"]["links"] == 28
    assert report["counts"]["source_stl_links"] == 28
    assert report["counts"]["step_candidate_files"] > 0
    assert report["counts"]["proven_step_links"] == 0
    assert report["mujoco"]["static_ok"] is True

    groups = {group["group"]: group for group in report["body_groups"]}
    assert groups["torso"]["links"] == ["IMU_ORIGIN", "WAIST_YAW"]
    assert groups["head"]["assembly_candidates"] == ["100"]
    assert groups["arm"]["assembly_candidates"] == ["300", "400"]
    assert groups["leg"]["assembly_candidates"] == ["500", "600"]

    for group in groups.values():
        assert group["required_proofs"] == list(FEMBOT_PROOF_TYPES)
        assert "source_step_or_controlled_loft" in group["missing_proofs"]
        assert "manufacturing_process" in group["missing_proofs"]
        assert "collision_sweep" in group["missing_proofs"]
        assert group["step_candidate_count"] == len(group["step_candidates"])
        assert group["source_stl_count"] == len(group["links"])


def test_fembot_inventory_cli_can_gate_production_readiness() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/inventory_asimov_fembot.py",
            "--require-production-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert '"production_ready": false' in proc.stdout
