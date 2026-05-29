from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from eliza_robot.asimov_1.lean_experiment import (
    BALL_HOUSING_LINKS,
    HIP_SPACING_EXPERIMENT_SCALE,
    LEAN_EXPERIMENT_SCHEMA,
    build_asimov1_lean_experiment_proof,
)


def test_lean_experiment_finds_arm_leg_ball_housing_safe_scales_without_mujoco() -> None:
    report = build_asimov1_lean_experiment_proof(
        generate_stl_fork=False,
        generate_repaired_fork=False,
        generate_mjcf_variant=False,
    )

    assert report["schema"] == LEAN_EXPERIMENT_SCHEMA
    assert report["ok"] is True
    assert report["summary"]["links"] == 22
    assert report["experimental_acceptance"]["ok"] is False
    assert report["summary"]["experimental_acceptance_ok"] is False
    assert report["parameters"]["hip_spacing_scale"] == HIP_SPACING_EXPERIMENT_SCALE
    assert report["summary"]["minimum_axis_clearance_margin_m"] >= -1.0e-12
    assert report["summary"]["thinning_sweep_ok"] is True
    assert report["summary"]["thinning_sweep_requested_scale_rejected_links"] >= 1
    assert report["thinning_sweep"]["links"] == report["summary"]["links"]

    categories = {record["category"]: record for record in report["categories"]}
    assert categories["arm"]["links"] == 10
    assert categories["leg"]["links"] == 12
    assert categories["ball_housing"]["links"] == len(BALL_HOUSING_LINKS)

    by_link = {record["link"]: record for record in report["links"]}
    assert by_link["LEFT_ELBOW"]["selected_non_spine_scale"] <= 1.0
    assert by_link["RIGHT_KNEE"]["selected_non_spine_scale"] <= 1.0
    assert "ball_housing" in by_link["LEFT_HIP_ROLL"]["categories"]
    assert all(record["z_height_preserved"] for record in report["links"])

    sweep_by_link = {
        record["link"]: record for record in report["thinning_sweep"]["records"]
    }
    assert sweep_by_link["LEFT_ELBOW"]["tested_scale_count"] >= 3
    assert sweep_by_link["LEFT_ELBOW"]["minimum_accepted_tested_scale"] is not None
    assert sweep_by_link["LEFT_ELBOW"]["contiguous_minimum_accepted_tested_scale"] is not None
    assert (
        sweep_by_link["LEFT_HIP_PITCH"]["contiguous_minimum_accepted_tested_scale"]
        >= sweep_by_link["LEFT_HIP_PITCH"]["frontier_safe_non_spine_scale"]
    )
    assert any(
        not test["accepted_by_sweep"]
        for record in report["thinning_sweep"]["records"]
        for test in record["tests"]
    )


def test_lean_experiment_cli_writes_gateable_proof_without_mujoco(tmp_path) -> None:
    output = tmp_path / "lean-experiment.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_lean_experiment.py",
            "--skip-stl",
            "--skip-repaired",
            "--skip-mujoco",
            "--output",
            str(output),
            "--require-ok",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == LEAN_EXPERIMENT_SCHEMA
    assert report["ok"] is True
    assert '"links": 22' in proc.stdout
    assert report["summary"]["thinning_sweep_ok"] is True
    assert report["summary"]["final_geometry_reduction_ok"] is True
    assert report["summary"]["ball_housing_reduction_ok"] is True
    assert report["summary"]["hip_spacing_sweep_ok"] is True
    assert report["hip_spacing_sweep"]["enabled"] is False


def test_lean_experiment_full_artifact_records_topology_and_repair_candidates() -> None:
    pytest.importorskip("trimesh")
    pytest.importorskip("mujoco")

    output = Path("cad/asimov-feminine/proofs/asimov-lean-experiment.json")
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_lean_experiment.py",
            "--output",
            str(output),
            "--require-ok",
        ],
        cwd=".",
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
        timeout=240,
    )

    assert proc.returncode == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["ok"] is True
    assert report["summary"]["stl_fork_ok"] is True
    assert report["experimental_acceptance"]["ok"] is True
    assert report["summary"]["experimental_acceptance_ok"] is True
    assert report["experimental_acceptance"]["production_accepted"] is False
    assert all(report["experimental_acceptance"]["checks"].values())
    assert report["summary"]["stl_fork_links"] == 28
    assert report["summary"]["stl_fork_transformed_links"] == 22
    assert report["summary"]["stl_fork_topology_preserved_links"] == 28
    assert report["summary"]["stl_fork_inherited_non_watertight_links"] >= 1
    assert report["summary"]["stl_fork_automatic_repair_safe_candidate_links"] >= 1
    assert report["summary"]["repaired_stl_fork_ok"] is True
    assert report["summary"]["repaired_stl_fork_promoted_safe_repair_links"] >= 1
    promoted_methods = report["summary"]["repaired_stl_fork_promoted_safe_repair_methods"]
    assert promoted_methods.get("IMU_ORIGIN") == "section_loft_envelope"
    assert promoted_methods.get("LEFT_ANKLE_B") == "section_loft_envelope"
    assert promoted_methods.get("RIGHT_ANKLE_B") == "section_loft_envelope"
    assert promoted_methods.get("LEFT_SHOULDER_ROLL") == "section_loft_envelope"
    assert promoted_methods.get("RIGHT_SHOULDER_ROLL") == "section_loft_envelope"
    assert promoted_methods.get("LEFT_TOE") == "component_convex_hulls"
    assert promoted_methods.get("RIGHT_TOE") == "component_convex_hulls"
    assert promoted_methods.get("LEFT_HIP_PITCH") == "section_loft_envelope"
    assert promoted_methods.get("RIGHT_HIP_PITCH") == "section_loft_envelope"
    assert report["summary"]["repaired_stl_fork_watertight_links"] == 28
    assert report["summary"]["repaired_stl_fork_remaining_non_watertight_links"] == 0
    assert report["summary"]["repaired_stl_fork_remaining_non_watertight_link_names"] == []
    assert report["summary"]["thinning_sweep_ok"] is True
    repaired_records = {record["link"]: record for record in report["repaired_stl_fork"]["records"]}
    for link in (
        "IMU_ORIGIN",
        "LEFT_ANKLE_B",
        "LEFT_HIP_PITCH",
        "LEFT_SHOULDER_ROLL",
        "RIGHT_ANKLE_B",
        "RIGHT_HIP_PITCH",
        "RIGHT_SHOULDER_ROLL",
    ):
        candidate = repaired_records[link]["promoted_safe_repair_candidate"]
        assert candidate["method"] == "section_loft_envelope"
        assert candidate["safe_candidate"] is True
        assert candidate["topology"]["watertight"] is True
        assert candidate["bbox_extent_delta_m"] <= candidate["bbox_extent_delta_limit_m"]
        assert candidate["interface_ok"] is True
        assert candidate["max_interface_bbox_delta_m"] <= candidate["interface_tolerance_m"]
        assert candidate["fit_metrics"]["max_p95_m"] <= candidate["fit_p95_limit_m"]
    assert report["summary"]["final_geometry_reduction_ok"] is True
    final_geometry = {
        record["link"]: record for record in report["final_geometry_reduction"]["records"]
    }
    assert final_geometry["LEFT_HIP_PITCH"]["volume_ratio"] < 1.0
    assert final_geometry["RIGHT_HIP_PITCH"]["volume_ratio"] < 1.0
    assert final_geometry["LEFT_ANKLE_B"]["volume_ratio"] < 1.0
    assert final_geometry["RIGHT_ANKLE_B"]["volume_ratio"] < 1.0
    assert report["summary"]["ball_housing_reduction_ok"] is True
    assert report["summary"]["ball_housing_reduction_links"] == len(BALL_HOUSING_LINKS)
    assert report["summary"]["ball_housing_volume_reduced_links"] == len(BALL_HOUSING_LINKS)
    assert report["summary"]["ball_housing_bbox_reduced_links"] >= 1
    ball_housing = {
        record["link"]: record for record in report["ball_housing_reduction"]["records"]
    }
    assert set(ball_housing) == BALL_HOUSING_LINKS
    assert all(record["ok"] for record in ball_housing.values())
    assert all(record["volume_reduced"] for record in ball_housing.values())
    assert (
        report["summary"]["repaired_stl_fork_watertight_links"]
        >= report["summary"]["stl_fork_watertight_links"]
    )
    defects = report["summary"]["repaired_stl_fork_remaining_topology_defects"]
    assert len(defects) == report["summary"]["repaired_stl_fork_remaining_non_watertight_links"]
    assert all("recommended_next_step" in defect for defect in defects)
    assert all("repair_experiments" in defect for defect in defects)
    assert report["summary"]["hip_spacing_mujoco_ok"] is True
    assert report["summary"]["hip_spacing_sweep_ok"] is True
    assert report["summary"]["hip_spacing_sweep_ok_scale_count"] >= 1
    assert report["summary"]["hip_spacing_sweep_minimum_ok_scale"] <= HIP_SPACING_EXPERIMENT_SCALE
    assert report["summary"]["hip_spacing_sweep_minimum_ok_spacing_m"] <= report["summary"][
        "hip_spacing_output_m"
    ]
    assert all(
        record["mass_inertia_ok"] and record["actuator_lag_ok"]
        for record in report["hip_spacing_sweep"]["records"]
        if record["ok"]
    )
    hip_sweep = {
        record["hip_spacing_scale"]: record
        for record in report["hip_spacing_sweep"]["records"]
    }
    assert hip_sweep[0.3]["ok"] is True
    assert hip_sweep[0.3]["initial_contact"]["nonfloor_contact_count"] == 0
    assert hip_sweep[0.25]["mujoco_ok"] is True
    assert hip_sweep[0.25]["ok"] is False
    assert hip_sweep[0.25]["initial_contact"]["nonfloor_contact_count"] > 0
    assert report["mujoco"]["source"]["mesh_dir"].endswith("stl-lean-experiment-repaired")
