from __future__ import annotations

import subprocess
import sys

from eliza_robot.asimov_1.morphology_readiness import (
    collect_morphology_parameter_proof_matrix,
)


def test_morphology_parameter_proof_matrix_blocks_unproven_shape_controls() -> None:
    matrix = collect_morphology_parameter_proof_matrix()

    assert matrix["schema"] == "asimov-1-morphology-parameter-proof-matrix-v1"
    assert matrix["counts"]["parameters"] >= 8
    assert matrix["counts"]["geometry_ready"] == matrix["counts"]["parameters"]
    assert matrix["counts"]["mujoco_ready"] == matrix["counts"]["parameters"]
    assert matrix["counts"]["source_ready"] == matrix["counts"]["parameters"]
    assert matrix["counts"]["step_ready"] == 0
    assert matrix["counts"]["exact_brep_ready"] == 0
    assert matrix["counts"]["usable"] == matrix["counts"]["parameters"]
    assert matrix["counts"]["supplier_vendor_ready"] == 8
    assert matrix["counts"]["supplier_vendor_blocked"] == 0
    assert matrix["counts"]["supplier_vendor_exact_pocket_ready"] == 5
    assert matrix["counts"]["supplier_vendor_exact_pocket_blocked"] == 3
    assert matrix["counts"]["usable_with_exact_brep_source"] == 0
    assert matrix["counts"]["blocked"] == 0
    assert matrix["ok"] is True

    by_name = {record["name"]: record for record in matrix["records"]}
    bust = by_name["bust_front_gain"]
    assert bust["affected_link_count"] == 1
    assert bust["geometry_ready"] is True
    assert bust["mujoco_ready"] is True
    assert bust["source_ready"] is True
    assert bust["step_ready"] is False
    assert bust["exact_brep_ready"] is False
    assert bust["usable"] is True
    assert bust["usable_with_exact_brep_source"] is False
    waist_evidence = bust["link_evidence"][0]
    assert waist_evidence["link"] == "WAIST_YAW"
    assert waist_evidence["known_link"] is True
    assert waist_evidence["spline_fit"] is True
    assert waist_evidence["interface_preservation"] is True
    assert waist_evidence["topology"] is True
    assert waist_evidence["surface_distance"] is True
    assert waist_evidence["mujoco_load"] is True
    assert waist_evidence["accepted_source"] is True
    assert waist_evidence["accepted_controlled_loft_source"] is True
    assert waist_evidence["exact_brep_body_assigned"] is False
    assert waist_evidence["proven_against_step"] is False

    cinch = by_name["torso_waist_cinch_depth"]
    assert cinch["geometry_ready"] is True
    assert cinch["source_ready"] is True
    assert cinch["usable"] is True
    assert {evidence["link"] for evidence in cinch["link_evidence"]} == {
        "WAIST_YAW",
        "IMU_ORIGIN",
    }

    hip_spacing = by_name["hip_spacing_scale"]
    assert hip_spacing["geometry_ready"] is True
    assert hip_spacing["source_ready"] is True
    assert hip_spacing["usable"] is True
    assert hip_spacing["supplier_vendor_ready"] is True
    assert hip_spacing["supplier_vendor_exact_pocket_ready"] is True
    assert {evidence["link"] for evidence in hip_spacing["link_evidence"]} == {
        "IMU_ORIGIN",
        "LEFT_HIP_PITCH",
        "RIGHT_HIP_PITCH",
    }

    global_shell = by_name["global_shell_scale"]
    assert global_shell["usable"] is True
    assert global_shell["supplier_vendor_ready"] is True
    assert global_shell["supplier_vendor_blocked_links"] == []
    assert global_shell["supplier_vendor_exact_pocket_ready"] is False
    assert set(global_shell["supplier_vendor_bbox_preview_ready_links"]) == {
        "LEFT_ANKLE_A",
        "LEFT_HIP_ROLL",
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_ANKLE_A",
        "RIGHT_HIP_ROLL",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
    }
    assert set(global_shell["supplier_vendor_exact_pocket_blocked_links"]) == {
        "LEFT_ANKLE_A",
        "LEFT_HIP_ROLL",
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_ANKLE_A",
        "RIGHT_HIP_ROLL",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
    }
    calf = by_name["calf_back_bulge"]
    assert calf["supplier_vendor_ready"] is True
    assert calf["supplier_vendor_exact_pocket_ready"] is False
    assert set(calf["supplier_vendor_exact_pocket_blocked_links"]) == {
        "LEFT_KNEE",
        "RIGHT_KNEE",
    }


def test_morphology_parameter_readiness_cli_can_require_usable_controls() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/validate_asimov1_morphology_parameters.py",
            "--require-usable",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"schema": "asimov-1-morphology-parameter-proof-matrix-v1"' in proc.stdout
    assert '"source_ready": 8' in proc.stdout
    assert '"supplier_vendor_blocked": 0' in proc.stdout
    assert '"supplier_vendor_exact_pocket_blocked": 3' in proc.stdout
    assert '"usable": 8' in proc.stdout
    assert '"usable_with_exact_brep_source": 0' in proc.stdout


def test_morphology_parameter_readiness_cli_can_require_supplier_vendor_ready() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/validate_asimov1_morphology_parameters.py",
            "--require-supplier-vendor-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"supplier_vendor_ready": 8' in proc.stdout
    assert '"supplier_vendor_blocked": 0' in proc.stdout
    assert '"supplier_vendor_exact_pocket_blocked": 3' in proc.stdout
    assert '"name": "global_shell_scale"' in proc.stdout


def test_morphology_parameter_readiness_cli_can_require_exact_supplier_pockets() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/validate_asimov1_morphology_parameters.py",
            "--require-supplier-vendor-exact-pocket-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert '"supplier_vendor_ready": 8' in proc.stdout
    assert '"supplier_vendor_exact_pocket_ready": 5' in proc.stdout
    assert '"supplier_vendor_exact_pocket_blocked": 3' in proc.stdout
