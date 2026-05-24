from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from eliza_robot.asimov_1.spline_fit_proof import (
    collect_spline_fit_proof_matrix,
    rank_spline_fit_repair_targets,
)


def test_spline_fit_proof_matrix_lists_all_expected_links_and_current_gaps() -> None:
    matrix = collect_spline_fit_proof_matrix()

    assert matrix["schema"] == "asimov-1-spline-fit-proof-matrix-v1"
    assert matrix["ok"] is True
    assert matrix["counts"]["expected_links"] == 28
    assert matrix["counts"]["passed"] == 28
    assert matrix["counts"]["missing_or_failed"] == 0
    assert matrix["counts"]["failed_attempt_reports"] == 0
    assert matrix["counts"]["ring_integrity"] == 28
    assert matrix["failure_reason_counts"] == {}

    by_link = {record["link"]: record for record in matrix["records"]}
    assert by_link["LEFT_ANKLE_A"]["axis"] == "z"
    assert by_link["LEFT_ANKLE_A"]["ok"] is True
    assert by_link["LEFT_ANKLE_A"]["missing"] == []
    assert by_link["LEFT_ANKLE_A"]["diagnostic_rings_closed"] == by_link["LEFT_ANKLE_A"][
        "diagnostic_rings_fit"
    ]
    assert by_link["LEFT_ANKLE_A"]["diagnostic_rings_nondegenerate"] == by_link[
        "LEFT_ANKLE_A"
    ]["diagnostic_rings_fit"]
    assert by_link["LEFT_ANKLE_A"]["diagnostic_max_closure_gap_m"] == 0.0
    assert by_link["LEFT_ANKLE_A"]["diagnostic_min_fitted_ring_area_m2"] > 0.0
    assert by_link["LEFT_ANKLE_A"]["diagnostic_min_fitted_ring_perimeter_m"] > 0.0
    assert by_link["LEFT_SHOULDER_PITCH"]["axis"] == "y"
    assert by_link["LEFT_SHOULDER_PITCH"]["ok"] is True
    assert by_link["LEFT_SHOULDER_PITCH"]["missing"] == []
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_internal_rings_skipped"] == 0
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_failed_ring_count"] == 0
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_worst_ring_level"] is None
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_rings_fit"] == 70

    waist = by_link["WAIST_YAW"]
    assert waist["axis"] == "z"
    assert waist["ok"] is True
    assert waist["missing"] == []
    assert waist["failed_attempt"] is None
    assert waist["failure_reasons"] == []
    assert waist["diagnostic_failed_ring_count"] == 0
    assert waist["diagnostic_worst_ring_level"] is None
    assert waist["diagnostic_nonmanifold_edges"] == 0

    imu = by_link["IMU_ORIGIN"]
    assert imu["axis"] == "z"
    assert imu["ok"] is True
    assert imu["missing"] == []
    assert imu["failed_attempt"] is None
    assert imu["failure_reasons"] == []
    assert imu["diagnostic_nonmanifold_edges"] == 0

    shoulder_roll = by_link["LEFT_SHOULDER_ROLL"]
    assert shoulder_roll["ok"] is True
    assert shoulder_roll["missing"] == []
    assert shoulder_roll["failed_attempt"] is None
    assert shoulder_roll["failure_reasons"] == []
    assert shoulder_roll["diagnostic_nonmanifold_edges"] == 0
    assert shoulder_roll["surface_symmetric_hausdorff_m"] <= 0.02
    assert shoulder_roll["diagnostic_rings_closed"] == shoulder_roll[
        "diagnostic_rings_fit"
    ]
    assert shoulder_roll["diagnostic_rings_nondegenerate"] == shoulder_roll[
        "diagnostic_rings_fit"
    ]

    ankle_b = by_link["LEFT_ANKLE_B"]
    assert ankle_b["ok"] is True
    assert ankle_b["missing"] == []
    assert ankle_b["failed_attempt"] is None
    assert ankle_b["diagnostic_nonmanifold_edges"] == 0
    assert ankle_b["surface_symmetric_hausdorff_m"] <= 0.02

    left_elbow = by_link["LEFT_ELBOW"]
    assert left_elbow["ok"] is True
    assert left_elbow["missing"] == []
    assert left_elbow["failed_attempt"] is None
    assert left_elbow["diagnostic_rings_closed"] == left_elbow["diagnostic_rings_fit"]
    assert left_elbow["diagnostic_rings_nondegenerate"] == left_elbow["diagnostic_rings_fit"]
    assert left_elbow["interfaces_checked"] == 2


def test_spline_fit_proof_matrix_cli_can_require_all_links() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/validate_asimov1_spline_fit_proofs.py",
            "--require-all",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"expected_links": 28' in proc.stdout
    assert '"ok": true' in proc.stdout


def test_spline_fit_repair_ranking_updates_after_loop_proofs() -> None:
    ranking = rank_spline_fit_repair_targets()

    assert ranking["schema"] == "asimov-1-spline-fit-repair-ranking-v1"
    assert ranking["counts"]["expected_links"] == 28
    assert ranking["counts"]["passed"] == 28
    assert ranking["counts"]["ranked_targets"] == 0
    assert ranking["targets"] == []
    assert ranking["category_counts"] == {}


def test_spline_fit_repair_ranking_cli_supports_limit() -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/rank_asimov1_spline_fit_failures.py",
            "--limit",
            "3",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    assert '"ranked_targets": 0' in proc.stdout
    assert '"targets": []' in proc.stdout


def test_batch_spline_fit_generator_uses_connection_axes(tmp_path: Path) -> None:
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_spline_fit_proof.py",
            "--link",
            "LEFT_SHOULDER_PITCH",
            "--section-method",
            "plane_loops",
            "--output-dir",
            str(tmp_path),
            "--control-count",
            "64",
            "--max-error-m",
            "0.006",
            "--rms-error-m",
            "0.002",
            "--surface-distance-samples",
            "1000",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert '"links": 1' in proc.stdout
    assert '"passed": 1' in proc.stdout
    assert (tmp_path / "LEFT_SHOULDER_PITCH.spline-fit.json").is_file()


def test_batch_spline_fit_generator_can_separate_failed_attempts(tmp_path: Path) -> None:
    proof_dir = tmp_path / "proofs"
    failed_dir = tmp_path / "failed"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov1_spline_fit_proof.py",
            "--link",
            "LEFT_SHOULDER_PITCH",
            "--link",
            "LEFT_SHOULDER_ROLL",
            "--section-method",
            "plane_loops",
            "--output-dir",
            str(proof_dir),
            "--failed-output-dir",
            str(failed_dir),
            "--control-count",
            "64",
            "--max-error-m",
            "0.006",
            "--rms-error-m",
            "0.002",
            "--surface-distance-samples",
            "1000",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 2
    assert (proof_dir / "LEFT_SHOULDER_PITCH.spline-fit.json").is_file()
    assert not (proof_dir / "LEFT_SHOULDER_ROLL.spline-fit.json").exists()
    assert (failed_dir / "LEFT_SHOULDER_ROLL.spline-fit.json").is_file()

    matrix = collect_spline_fit_proof_matrix(proof_root=proof_dir, failed_root=failed_dir)
    by_link = {record["link"]: record for record in matrix["records"]}
    assert by_link["LEFT_SHOULDER_PITCH"]["ok"] is True
    assert by_link["LEFT_SHOULDER_ROLL"]["ok"] is False
    assert by_link["LEFT_SHOULDER_ROLL"]["failed_attempt"] is not None
    assert any(
        reason.startswith("topology:")
        for reason in by_link["LEFT_SHOULDER_ROLL"]["failure_reasons"]
    )
