from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.fembot_mesh_traceability import (
    build_fembot_mesh_parametric_traceability_proof,
)


def test_fembot_mesh_traceability_tracks_controlled_loft_chain() -> None:
    report = build_fembot_mesh_parametric_traceability_proof()

    assert report["schema"] == "asimov-fembot-mesh-parametric-traceability-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["mesh_files"] == 28
    assert report["summary"]["traceability_ready_links"] == 28
    assert report["summary"]["controlled_loft_source_ready_links"] == 28
    assert report["summary"]["exact_brep_source_ready_links"] == 0
    assert report["summary"]["generated_stl_physics_ready_links"] == 28
    assert report["summary"]["mesh_artifact_free_links"] == 28
    assert report["summary"]["generated_stl_physics_ready"] is True
    assert report["summary"]["mujoco_mapped_links"] == 28
    assert report["summary"]["spline_fit_links"] == 28
    assert report["summary"]["attachment_interface_links"] == 28
    assert report["summary"]["topology_links"] == 28
    assert report["summary"]["surface_distance_links"] == 28
    assert report["summary"]["missing_traceability_links"] == 0
    assert report["summary"]["acceptance_blocker"] is None
    assert report["missing_by_link"] == {}

    by_link = {record["link"]: record for record in report["records"]}
    waist = by_link["WAIST_YAW"]
    assert waist["traceability_ready"] is True
    assert waist["accepted_source_assignment"] is True
    assert waist["controlled_loft_source_ready"] is True
    assert waist["exact_brep_source_ready"] is False
    assert waist["generated_stl_physics_ready"] is True
    assert waist["mesh_artifact_free"] is True
    assert waist["production_source_ready"] is True
    assert waist["mjcf_mesh_refs"]
    assert waist["source_assignment"]["fit_max_error_m"] is not None
    assert waist["source_assignment"]["interface_levels_m"]


def test_fembot_mesh_traceability_cli_can_gate_controlled_lofts() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mesh_traceability.py",
            "--require-controlled-loft-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"schema": "asimov-fembot-mesh-parametric-traceability-v1"' in proc.stdout
    assert '"traceability_ready_links": 28' in proc.stdout
    assert '"generated_stl_physics_ready": true' in proc.stdout


def test_fembot_mesh_traceability_cli_fails_exact_step_gate() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mesh_traceability.py",
            "--require-exact-step-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert '"exact_brep_source_ready_links": 0' in proc.stdout
