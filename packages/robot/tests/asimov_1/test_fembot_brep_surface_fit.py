from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_brep_surface_fit import (
    build_fembot_brep_surface_fit_proof,
)


def test_fembot_brep_surface_fit_rejects_ranked_step_candidates() -> None:
    report = build_fembot_brep_surface_fit_proof(
        max_sample_count=2_000,
        surface_candidates_per_link=3,
    )

    assert report["schema"] == "asimov-fembot-brep-surface-fit-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["best_candidate_unique_bodies"] >= 1
    assert report["summary"]["ranked_candidate_unique_bodies"] >= report["summary"]["best_candidate_unique_bodies"]
    assert report["summary"]["surface_candidates_per_link"] == 3
    assert report["summary"]["evaluated_candidate_fits"] >= 28
    assert report["summary"]["exported_candidate_fits"] == report["summary"]["evaluated_candidate_fits"]
    assert report["summary"]["accepted_candidate_fits"] == 0
    assert report["summary"]["exported_links"] == 28
    assert report["summary"]["accepted_link_fits"] == 0
    assert report["summary"]["rejected_link_fits"] == 28
    assert report["summary"]["symmetric_hausdorff_min_m"] is not None
    assert report["summary"]["symmetric_hausdorff_min_m"] > report["summary"]["surface_tolerance_m"]
    assert report["summary"]["symmetric_hausdorff_max_m"] >= report["summary"]["symmetric_hausdorff_min_m"]
    assert report["summary"]["center_aligned_symmetric_hausdorff_min_m"] is not None
    assert report["summary"]["bbox_affine_aligned_symmetric_hausdorff_min_m"] is not None
    assert (
        report["summary"]["bbox_affine_aligned_symmetric_hausdorff_min_m"]
        > report["summary"]["surface_tolerance_m"]
    )
    assert report["summary"]["bbox_affine_alignment_pass_candidate_fits"] == 0
    assert report["summary"]["bbox_affine_alignment_pass_links"] == 0
    assert report["summary"]["shape_mismatch_after_bbox_alignment_links"] == 28

    for record in report["link_fits"]:
        assert record["exported"] is True
        assert record["accepted"] is False
        assert record["evaluated_candidate_count"] >= 1
        assert record["exported_candidate_count"] == record["evaluated_candidate_count"]
        assert len(record["candidate_fits"]) == record["evaluated_candidate_count"]
        assert record["candidate_reuse_count"] >= 1
        assert record["symmetric_hausdorff_m"] > record["surface_tolerance_m"]
        assert record["center_aligned_symmetric_hausdorff_m"] > record["surface_tolerance_m"]
        assert record["bbox_affine_aligned_symmetric_hausdorff_m"] > record["surface_tolerance_m"]
        assert record["bbox_affine_alignment_would_pass"] is False
        assert record["residual_classification"] == "shape_mismatch_after_bbox_alignment"
        assert record["blocking_reason"] == "no ranked STEP body candidate satisfies source-STL surface-fit tolerance"
        for candidate in record["candidate_fits"]:
            assert candidate["exported"] is True
            assert candidate["accepted"] is False
            assert candidate["symmetric_hausdorff_m"] > candidate["surface_tolerance_m"]
            assert candidate["bbox_affine_alignment_would_pass"] is False
            assert candidate["residual_classification"] == "shape_mismatch_after_bbox_alignment"


def test_fembot_brep_surface_fit_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "brep-surface-fit.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_brep_surface_fit.py",
            "--output",
            str(output),
            "--max-sample-count",
            "2000",
            "--surface-candidates-per-link",
            "3",
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-brep-surface-fit-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"rejected_link_fits": 28' in proc.stdout
