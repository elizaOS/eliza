from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.collision_sweep import build_asimov1_collision_sweep_proof
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory


def test_asimov_collision_sweep_records_spatial_joint_range_contacts() -> None:
    report = build_asimov1_collision_sweep_proof()

    assert report["schema"] == "asimov-1-collision-sweep-proof-v1"
    assert report["ok"] is True
    assert report["summary"]["samples"] >= 80
    assert report["samples"][0]["label"] == "neutral"
    assert report["samples"][0]["accepted"] is True
    assert report["samples"][0]["approved_floor_contact_count"] >= 10
    assert report["summary"]["unapproved_contact_samples"] > 0
    assert report["summary"]["unapproved_contact_count"] > 0
    assert report["accepted"] is False


def test_asimov_collision_sweep_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "collision-sweep.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_collision_sweep_proof.py",
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
    assert report["schema"] == "asimov-1-collision-sweep-proof-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"schema": "asimov-1-collision-sweep-proof-v1"' in proc.stdout


def test_fembot_inventory_surfaces_collision_sweep_result() -> None:
    report = collect_fembot_inventory()

    assert report["collision_sweep"]["ok"] is True
    assert report["collision_sweep"]["accepted"] is False
    assert report["collision_sweep"]["summary"]["unapproved_contact_samples"] > 0
    assert report["fembot_collision_dynamics"]["ok"] is True
    assert report["fembot_collision_dynamics"]["accepted"] is False
    assert report["fembot_collision_dynamics"]["summary"]["generated_links"] == 28
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_unapproved_contact_samples"
        ]
        == 0
    )
    assert report["fembot_collision_dynamics"]["contact_pairs"] == []
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_geometry_substituted_in_mjcf"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["fembot_mass_inertia_ok"]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"]["fembot_actuator_lag_ok"]
        is True
    )
    assert report["fembot_collision_dynamics"]["summary"]["fembot_actuators_tracked"] == 25
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "fembot_promoted_contact_tuned_collider_contact_clean"
        ]
        is True
    )
    assert report["fembot_collision_dynamics"]["summary"]["foot_handling_accepted"] is True
    assert report["fembot_collision_dynamics"]["summary"]["inertia_calibration_ready"] is True
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "controller_simulation_validated"
        ]
        is True
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "controller_hardware_validated"
        ]
        is False
    )
    assert (
        report["fembot_collision_dynamics"]["summary"][
            "contact_tuning_clears_sampled_self_contacts_and_visual_fit"
        ]
        is True
    )
    for group in report["body_groups"]:
        assert "collision_sweep" in group["missing_proofs"]
