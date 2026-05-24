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
    assert matrix["counts"]["usable"] == 0
    assert matrix["counts"]["blocked"] == matrix["counts"]["parameters"]

    by_name = {record["name"]: record for record in matrix["records"]}
    bust = by_name["bust_front_gain"]
    assert bust["affected_link_count"] == 1
    assert bust["missing_links"] == ["WAIST_YAW"]
    assert bust["geometry_ready"] is False
    assert bust["mujoco_ready"] is False
    assert bust["step_ready"] is False
    waist_evidence = bust["link_evidence"][0]
    assert waist_evidence["link"] == "WAIST_YAW"
    assert waist_evidence["known_link"] is True
    assert waist_evidence["missing"] == [
        "spline_fit",
        "interface_preservation",
        "topology",
        "surface_distance",
        "mujoco_load",
    ]


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

    assert proc.returncode == 2
    assert '"schema": "asimov-1-morphology-parameter-proof-matrix-v1"' in proc.stdout
    assert '"usable": 0' in proc.stdout
