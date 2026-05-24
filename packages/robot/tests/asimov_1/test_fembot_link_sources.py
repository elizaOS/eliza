from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_link_sources import build_fembot_link_source_assignment_proof


def test_fembot_link_source_assignments_cover_every_link_with_candidate_sources() -> None:
    inventory = collect_fembot_inventory()
    report = build_fembot_link_source_assignment_proof(inventory["body_groups"])

    assert report["schema"] == "asimov-fembot-link-source-assignment-v1"
    assert report["ok"] is True
    assert report["accepted"] is True
    assert report["summary"]["links"] == 28
    assert report["summary"]["candidate_link_assignments"] == 28
    assert report["summary"]["missing_source_refs"] == []
    assert report["summary"]["exact_brep_body_assignments"] == 0
    assert report["summary"]["controlled_loft_assignments"] == 28
    assert report["summary"]["controlled_loft_required"] == 0
    assert report["summary"]["body_matching_run"] is True
    assert report["summary"]["body_matching_matched_links"] == 28
    assert report["summary"]["body_matching_accepted_links"] == 0
    assert report["summary"]["accepted_link_assignments"] == 28
    assert report["cad_cli_toolchain"]["preferred"] == "python_occ_cli"
    assert report["cad_cli_toolchain"]["freecad_role"] == "fallback_only_not_preferred"
    assert report["cad_cli_toolchain"]["body_matching_run"] is True
    assert "cadquery" in report["cad_cli_toolchain"]["python_modules"]
    assert "isolated_env" in report["cad_cli_toolchain"]
    assert "cadquery" in report["cad_cli_toolchain"]["isolated_env"]["python_modules"]

    assignments = {record["link"]: record for record in report["link_assignments"]}
    assert assignments["WAIST_YAW"]["candidate_assemblies"] == ["200", "700"]
    assert assignments["NECK_PITCH"]["candidate_assemblies"] == ["100"]
    assert assignments["LEFT_ELBOW"]["candidate_assemblies"] == ["300", "400"]
    assert assignments["RIGHT_KNEE"]["candidate_assemblies"] == ["500", "600"]
    assert assignments["LEFT_TOE"]["candidate_assemblies"] == ["500", "600"]

    for record in assignments.values():
        assert record["source_kind"] == "accepted_controlled_loft_source"
        assert record["source_paths"]
        assert record["source_sha256"]
        assert record["source_stl_reference"]["exists"] is True
        assert record["exact_brep_body_assigned"] is False
        assert record["controlled_loft_assigned"] is True
        assert record["controlled_loft_required"] is False
        assert record["controlled_loft_proof"]
        assert record["body_matching"]["run"] is True
        assert record["body_matching"]["matched"] is True
        assert record["body_matching"]["accepted"] is False
        assert record["body_matching"]["best_candidate_step"]
        assert record["body_matching"]["best_candidate_metrics"]["score"] >= 0.0
        assert record["body_matching"]["best_candidate_metrics"]["combined_score"] >= record["body_matching"]["best_candidate_metrics"]["score"]
        assert record["body_matching"]["best_candidate_metrics"]["spatial_anchors"]["anchor_count"] >= 1
        assert record["body_matching"]["best_candidate_metrics"]["reserved_interfaces"][
            "reserved_level_count"
        ] >= 1
        assert record["fit_max_error_m"] is not None
        assert record["interface_max_delta_m"] is not None
        assert record["surface_symmetric_hausdorff_m"] is not None
        assert record["topology"]["watertight"] is True
        assert record["accepted"] is True


def test_fembot_inventory_surfaces_link_source_assignment_status() -> None:
    report = collect_fembot_inventory()

    assert report["link_source_assignments"]["ok"] is True
    assert report["link_source_assignments"]["accepted"] is True
    assert report["link_source_assignments"]["summary"]["candidate_link_assignments"] == 28
    assert report["link_source_assignments"]["summary"]["exact_brep_body_assignments"] == 0
    assert report["link_source_assignments"]["summary"]["body_matching_matched_links"] == 28
    assert report["link_source_assignments"]["summary"]["controlled_loft_assignments"] == 28
    assert report["link_source_assignments"]["summary"]["controlled_loft_required"] == 0
    assert report["link_source_assignments"]["summary"]["accepted_link_assignments"] == 28
    for group in report["body_groups"]:
        assert "source_step_or_controlled_loft" not in group["missing_proofs"]


def test_fembot_link_source_assignment_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "link-source-assignments.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_link_source_assignments.py",
            "--output",
            str(output),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-link-source-assignment-v1"
    assert proc.returncode == (0 if report["accepted"] else 2)
    assert '"accepted": true' in proc.stdout
