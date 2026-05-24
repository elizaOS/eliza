from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.parametric_inventory import collect_asimov1_parametric_inventory


def test_asimov_parametric_inventory_separates_mesh_warps_from_proven_parametrics() -> None:
    report = collect_asimov1_parametric_inventory()

    assert report["schema"] == "asimov-1-parametric-inventory-v1"
    assert report["ok"] is True
    assert report["fully_parametric"] is False
    assert report["counts"]["mesh_files"] == 28
    assert report["counts"]["with_connection_specs"] == 28
    assert report["counts"]["with_part_scripts"] == 28
    assert report["counts"]["with_spline_fit_proofs"] == 11
    assert report["counts"]["with_interface_proofs"] == 11
    assert report["counts"]["with_topology_proofs"] == 11
    assert report["counts"]["with_surface_distance_proofs"] == 11
    assert report["counts"]["proven_parametric"] == 0
    assert report["statuses"].get("mesh_derived_parametric_unproven") == 25
    assert report["statuses"].get("non_parametric_mesh_warp") == 3

    waist = next(record for record in report["records"] if record["link"] == "WAIST_YAW")
    assert waist["current_method"] == "mesh_section_loft"
    assert waist["proven_against_step"] is False
    assert any("spline" in proof for proof in waist["required_proofs"])

    ankle = next(record for record in report["records"] if record["link"] == "LEFT_ANKLE_A")
    assert ankle["spline_fit_proven"] is True
    assert ankle["interface_proven"] is True
    assert ankle["topology_proven"] is True
    assert ankle["surface_distance_proven"] is True
    assert ankle["proven_against_step"] is False

    shoulder = next(
        record for record in report["records"] if record["link"] == "LEFT_SHOULDER_PITCH"
    )
    assert shoulder["spline_fit_proven"] is True
    assert shoulder["interface_proven"] is True
    assert shoulder["topology_proven"] is True
    assert shoulder["surface_distance_proven"] is True
    assert shoulder["proven_against_step"] is False

    for link in (
        "RIGHT_ANKLE_A",
        "LEFT_HIP_ROLL",
        "RIGHT_HIP_ROLL",
        "LEFT_SHOULDER_YAW",
        "RIGHT_SHOULDER_YAW",
        "LEFT_WRIST_YAW",
        "RIGHT_WRIST_YAW",
        "NECK_PITCH",
        "NECK_YAW",
    ):
        proven = next(record for record in report["records"] if record["link"] == link)
        assert proven["spline_fit_proven"] is True
        assert proven["interface_proven"] is True
        assert proven["topology_proven"] is True
        assert proven["surface_distance_proven"] is True
        assert proven["proven_against_step"] is False


def test_asimov_parametric_inventory_cli_can_gate_full_parametric_coverage() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/inventory_asimov1_parametric_meshes.py",
            "--require-fully-parametric",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert '"fully_parametric": false' in proc.stdout
