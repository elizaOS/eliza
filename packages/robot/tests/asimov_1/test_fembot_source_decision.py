from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_source_decision import (
    build_fembot_source_decision_proof,
)


def test_fembot_source_decision_selects_controlled_lofts_over_rejected_breps() -> None:
    report = build_fembot_source_decision_proof()

    assert report["schema"] == "asimov-fembot-source-decision-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["decision_ready_links"] == 28
    assert report["summary"]["selected_controlled_loft_links"] == 28
    assert report["summary"]["exact_brep_ready_links"] == 0
    assert report["summary"]["rejected_step_brep_candidate_links"] == 28
    assert (
        report["summary"]["controlled_loft_beats_bbox_affine_brep_candidate_links"]
        == 28
    )

    for record in report["records"]:
        assert record["decision_ready"] is True
        assert record["selected_source_kind"] == "accepted_controlled_loft_source"
        assert record["selected_controlled_loft"] is True
        assert record["production_exact_brep_ready"] is False
        assert record["missing"] == []
        assert record["controlled_loft"]["accepted"] is True
        assert record["controlled_loft"]["surface_symmetric_hausdorff_m"] is not None
        assert record["best_step_brep_candidate"]["exported"] is True
        assert record["best_step_brep_candidate"]["accepted"] is False
        assert (
            record["best_step_brep_candidate"]["residual_classification"]
            == "shape_mismatch_after_bbox_alignment"
        )
        assert record["controlled_loft_beats_bbox_affine_brep_candidate"] is True
        assert (
            record["controlled_loft"]["surface_symmetric_hausdorff_m"]
            < record["best_step_brep_candidate"][
                "bbox_affine_aligned_symmetric_hausdorff_m"
            ]
        )


def test_fembot_source_decision_cli_gates_decision_and_exact_brep(tmp_path) -> None:
    output = tmp_path / "source-decision.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_source_decision_proof.py",
            "--output",
            str(output),
            "--require-decision-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["summary"]["decision_ready_links"] == 28
    assert '"selected_controlled_loft_links": 28' in proc.stdout

    exact = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_source_decision_proof.py",
            "--output",
            str(output),
            "--require-exact-brep-ready",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )
    assert exact.returncode == 2
    assert '"exact_brep_ready_links": 0' in exact.stdout
