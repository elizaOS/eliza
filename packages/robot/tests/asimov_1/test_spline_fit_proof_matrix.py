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
    assert matrix["ok"] is False
    assert matrix["counts"]["expected_links"] == 28
    assert matrix["counts"]["passed"] == 11
    assert matrix["counts"]["missing_or_failed"] == 17
    assert matrix["counts"]["failed_attempt_reports"] >= 17
    assert matrix["failure_reason_counts"]["interface"] > 0
    assert matrix["failure_reason_counts"]["topology"] > 0

    by_link = {record["link"]: record for record in matrix["records"]}
    assert by_link["LEFT_ANKLE_A"]["axis"] == "z"
    assert by_link["LEFT_ANKLE_A"]["ok"] is True
    assert by_link["LEFT_ANKLE_A"]["missing"] == []
    assert by_link["LEFT_SHOULDER_PITCH"]["axis"] == "y"
    assert by_link["LEFT_SHOULDER_PITCH"]["ok"] is True
    assert by_link["LEFT_SHOULDER_PITCH"]["missing"] == []
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_internal_rings_skipped"] == 0
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_failed_ring_count"] == 0
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_worst_ring_level"] is None
    assert by_link["LEFT_SHOULDER_PITCH"]["diagnostic_rings_fit"] == 59

    waist = by_link["WAIST_YAW"]
    assert waist["axis"] == "z"
    assert "proof" in waist["missing"]
    assert "spline_fit" in waist["missing"]
    assert waist["failed_attempt"] is not None
    assert any(reason.startswith("topology:") for reason in waist["failure_reasons"])
    assert waist["diagnostic_failed_ring_count"] == 0
    assert waist["diagnostic_worst_ring_level"] is None
    assert waist["diagnostic_nonmanifold_edges"] == 88


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

    assert proc.returncode == 2
    assert '"expected_links": 28' in proc.stdout
    assert '"ok": false' in proc.stdout


def test_spline_fit_repair_ranking_updates_after_loop_proofs() -> None:
    ranking = rank_spline_fit_repair_targets()

    assert ranking["schema"] == "asimov-1-spline-fit-repair-ranking-v1"
    assert ranking["counts"]["expected_links"] == 28
    assert ranking["counts"]["passed"] == 11
    assert ranking["counts"]["ranked_targets"] >= 5

    first = ranking["targets"][0]
    assert first["link"] == "RIGHT_HIP_YAW"
    assert first["category"] == "inherited_topology"
    assert first["failed_ring_count"] == 0
    assert first["boundary_edges"] == 0
    assert first["nonmanifold_edges"] == 7
    assert first["source_nonmanifold_edges"] == 7
    assert first["inherited_topology"] is True
    assert first["internal_rings_skipped"] == 0
    assert first["worst_ring_level"] is None
    by_link = {target["link"]: target for target in ranking["targets"]}
    assert by_link["RIGHT_TOE"]["category"] == "inherited_topology"
    assert by_link["RIGHT_TOE"]["nonmanifold_edges"] == 27
    assert by_link["RIGHT_TOE"]["source_nonmanifold_edges"] == 27


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
    assert '"ranked_targets": 3' in proc.stdout
    assert '"RIGHT_HIP_YAW"' in proc.stdout


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
            "WAIST_YAW",
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
    assert not (proof_dir / "WAIST_YAW.spline-fit.json").exists()
    assert (failed_dir / "WAIST_YAW.spline-fit.json").is_file()

    matrix = collect_spline_fit_proof_matrix(proof_root=proof_dir, failed_root=failed_dir)
    by_link = {record["link"]: record for record in matrix["records"]}
    assert by_link["LEFT_SHOULDER_PITCH"]["ok"] is True
    assert by_link["WAIST_YAW"]["ok"] is False
    assert by_link["WAIST_YAW"]["failed_attempt"] is not None
    assert any(reason.startswith("topology:") for reason in by_link["WAIST_YAW"]["failure_reasons"])
