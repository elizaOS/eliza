from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_body_matching import build_fembot_body_matching_proof
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory


def test_fembot_body_matching_ranks_step_bodies_against_all_source_links() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_body_matching_proof(
        inventory["body_groups"],
        max_files_per_group=1,
        top_matches_per_link=2,
    )

    assert report["schema"] == "asimov-fembot-body-matching-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["matched_links"] == 28
    assert report["summary"]["accepted_link_matches"] == 0
    assert report["summary"]["missing_source_stls"] == []
    assert report["summary"]["candidate_step_bodies"] >= 4
    assert report["summary"]["links_with_spatial_anchors"] == 28
    assert report["summary"]["best_match_anchor_rejected_links"] >= 1
    assert report["summary"]["links_with_reserved_interfaces"] == 28
    assert report["summary"]["best_match_interface_rejected_links"] >= 1
    assert report["summary"]["best_match_interface_residual_max_m"] is not None
    assert report["summary"]["best_match_interface_residual_max_m"] > 0.0
    assert report["summary"]["best_score_min"] is not None
    assert report["summary"]["best_score_max"] >= report["summary"]["best_score_min"]
    assert report["summary"]["best_combined_score_max"] >= report["summary"]["best_combined_score_min"]

    matches = {record["link"]: record for record in report["link_matches"]}
    assert matches["WAIST_YAW"]["group"] == "torso"
    assert matches["NECK_PITCH"]["group"] == "head"
    assert matches["LEFT_ELBOW"]["group"] == "arm"
    assert matches["RIGHT_KNEE"]["group"] == "leg"
    assert matches["LEFT_TOE"]["group"] == "foot"

    for record in matches.values():
        assert record["matched"] is True
        assert record["spatial_anchor_count"] >= 1
        assert record["reserved_interface_count"] >= 1
        assert record["source_interface_profiles_available"] >= 1
        assert record["best_match"]["source_step"]
        assert record["best_match"]["metrics"]["score"] >= 0.0
        assert record["best_match"]["metrics"]["combined_score"] >= record["best_match"]["metrics"]["score"]
        assert record["best_match"]["metrics"]["spatial_anchors"]["anchor_count"] >= 1
        interfaces = record["best_match"]["metrics"]["reserved_interfaces"]
        assert interfaces["reserved_level_count"] == record["reserved_interface_count"]
        assert interfaces["source_profiles_available"] == record["source_interface_profiles_available"]
        assert interfaces["candidate_containment_residual_max_m"] is not None
        assert len(interfaces["interfaces"]) == record["reserved_interface_count"]
        assert len(record["candidate_matches"]) <= 2
        assert record["blocking_reason"]


def test_fembot_body_matching_can_reuse_main_assembly_step_index() -> None:
    inventory = collect_fembot_inventory()
    step_index = {
        "schema": "asimov-fembot-step-body-index-v1",
        "ok": True,
        "source": {
            "main_step": "/tmp/ASIMOV_V1.STEP",
        },
        "summary": {
            "body_count": 0,
            "failed_step_files": 0,
            "main_assembly_loaded": True,
        },
        "body_groups": [],
        "main_assembly_step": {
            "path": "/tmp/ASIMOV_V1.STEP",
            "relative_path": "ASIMOV_V1.STEP",
            "sha256": "synthetic",
            "cad": {
                "loaded": True,
                "body_count": 1,
                "bodies": [
                    {
                        "index": 42,
                        "volume_mm3": 8_000_000_000.0,
                        "bbox_mm": {
                            "xmin": -1000.0,
                            "ymin": -1000.0,
                            "zmin": -1000.0,
                            "xmax": 1000.0,
                            "ymax": 1000.0,
                            "zmax": 2000.0,
                        },
                    }
                ],
            },
        },
    }

    report = build_fembot_body_matching_proof(
        inventory["body_groups"],
        step_index_report=step_index,
        include_main_assembly_candidates=True,
        top_matches_per_link=1,
    )

    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["matched_links"] == 28
    assert report["summary"]["candidate_step_bodies"] == 1
    assert report["summary"]["main_assembly_candidates_included"] is True
    assert report["summary"]["main_assembly_candidate_bodies"] == 1
    assert report["summary"]["main_assembly_loaded"] is True
    assert report["summary"]["links_with_reserved_interfaces"] == 28
    assert report["summary"]["best_match_interface_rejected_links"] == 0
    assert report["summary"]["best_match_interface_residual_max_m"] == 0.0
    for record in report["link_matches"]:
        assert record["matched"] is True
        assert record["best_match"]["source_scope"] == "main_assembly"
        assert record["best_match"]["cad_body_index"] == 42
        assert record["best_match"]["metrics"]["reserved_interfaces"][
            "candidate_interface_rejected"
        ] is False


def test_fembot_body_matching_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "body-matching.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_body_matching.py",
            "--output",
            str(output),
            "--max-files-per-group",
            "1",
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-body-matching-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"matched_links": 28' in proc.stdout
