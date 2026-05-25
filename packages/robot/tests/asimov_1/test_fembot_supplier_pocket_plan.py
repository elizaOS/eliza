from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS, collect_fembot_inventory
from eliza_robot.asimov_1.fembot_supplier_pocket_plan import (
    build_fembot_supplier_pocket_plan_proof,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_supplier_pocket_plan_tracks_exact_vendor_pocket_gaps(tmp_path) -> None:
    report = build_fembot_supplier_pocket_plan_proof(
        _body_groups(),
        placement_proxy_root=tmp_path / "placement-proxy",
    )

    assert report["schema"] == "asimov-fembot-supplier-pocket-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links_requiring_supplier_pockets"] == 8
    assert report["summary"]["supplier_codes"] == 5
    assert report["summary"]["supplier_link_pocket_plans"] == 36
    assert report["summary"]["bbox_fit_after_adjustment"] == 36
    assert report["summary"]["bbox_fit_after_adjustment_failures"] == 0
    assert report["summary"]["candidate_placement_transforms"] == 36
    assert report["summary"]["candidate_placement_proxy_exports"] == 36
    assert report["summary"]["candidate_placement_proxy_reloads"] == 36
    assert report["summary"]["candidate_placement_proxy_failures"] == 0
    assert report["summary"]["candidate_placement_proxy_extent_tolerance_failures"] == 0
    assert report["summary"]["candidate_placement_proxy_single_solid_plans"] == 36
    assert report["summary"]["accepted_placement_transforms"] == 0
    assert report["summary"]["unassigned_placement_transforms"] == 0
    assert report["summary"]["mate_feature_candidate_plans"] == 36
    assert report["summary"]["mate_feature_unassigned_plans"] == 0
    assert report["summary"]["fastener_access_required_plans"] == 24
    assert report["summary"]["fastener_access_candidate_plans"] == 24
    assert report["summary"]["fastener_access_unverified_plans"] == 36
    assert report["summary"]["collision_precheck_candidate_plans"] == 36
    assert report["summary"]["collision_validation_missing_plans"] == 36
    assert report["summary"]["structural_precheck_candidate_plans"] == 36
    assert report["summary"]["structural_validation_missing_plans"] == 36

    plans = {
        (record["link"], record["supplier_code"]): record
        for record in report["pocket_plans"]
    }
    left_knee = plans["LEFT_KNEE", "1600-0515-0006"]
    assert left_knee["bbox_fit_after_adjustment"] is True
    assert left_knee["max_residual_extent_growth_m"] == 0.0
    assert left_knee["placement_frame"] == "generated_link_local_bbox_center"
    assert left_knee["placement_transform_m"]["source"] == (
        "generated_bbox_center_axis_aligned_hypothesis"
    )
    assert left_knee["placement_transform_m"]["accepted"] is False
    assert left_knee["placement_transform_m"]["translation_m"]
    assert left_knee["placement_transform_m"]["rotation_quat_xyzw"] == [0.0, 0.0, 0.0, 1.0]
    assert (
        left_knee["placement_transform_m"]["minimum_sorted_extent_slack_m"]
        >= 0.0
    )
    assert left_knee["placement_transform_accepted"] is False
    assert left_knee["supplier_family"] == "bearing_or_ring"
    assert left_knee["mate_feature_ids"] == [
        "LEFT_KNEE:1600-0515-0006:bbox-center",
        "LEFT_KNEE:1600-0515-0006:short-axis-x",
        "LEFT_KNEE:1600-0515-0006:long-axis-z",
    ]
    assert left_knee["mate_feature_assignment"]["candidate"] is True
    assert left_knee["mate_feature_assignment"]["accepted"] is False
    assert left_knee["fastener_access"]["required"] is False
    assert left_knee["collision_precheck"]["candidate"] is True
    assert left_knee["collision_precheck"]["accepted"] is False
    assert (
        left_knee["collision_precheck"]["adjusted_sorted_extent_clearance_margin_m"]
        >= 0.0
    )
    assert left_knee["collision_precheck_candidate"] is True
    assert left_knee["structural_precheck"]["candidate"] is True
    assert left_knee["structural_precheck"]["accepted"] is False
    assert left_knee["structural_precheck"]["minimum_safety_factor"] >= 1.05
    assert left_knee["structural_precheck_candidate"] is True
    assert left_knee["placement_proxy_step_path"]
    assert left_knee["placement_proxy_step_sha256"]
    assert left_knee["placement_proxy_reload_ok"] is True
    assert left_knee["placement_proxy_extent_within_tolerance"] is True
    assert left_knee["placement_proxy_solid_count"] == 1
    assert left_knee["source_geometry"]["body_count"] == 16
    assert left_knee["source_geometry"]["max_body_extent_m"] == 0.038
    assert left_knee["generated_step_sha256"]
    assert left_knee["accepted"] is False
    fastener = plans["LEFT_KNEE", "2806-0005-0004"]
    assert fastener["supplier_family"] == "fastener_or_thread"
    assert fastener["fastener_access"]["required"] is True
    assert fastener["fastener_access"]["candidate"] is True
    assert fastener["fastener_access"]["verified"] is False


def test_fembot_supplier_pocket_plan_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-supplier-pocket-plan.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_supplier_pocket_plan.py",
            "--output",
            str(output),
            "--placement-proxy-root",
            str(tmp_path / "placement-proxy"),
            "--require-accepted",
        ],
        cwd=".",
        text=True,
        capture_output=True,
        check=False,
    )

    assert output.is_file()
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema"] == "asimov-fembot-supplier-pocket-plan-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["candidate_placement_proxy_reloads"] == 36
    assert proc.returncode == 2
    assert '"supplier_link_pocket_plans": 36' in proc.stdout


def test_fembot_inventory_surfaces_supplier_pocket_plan_status() -> None:
    report = collect_fembot_inventory()

    assert report["supplier_pocket_plan"]["ok"] is True
    assert report["supplier_pocket_plan"]["accepted"] is False
    assert report["supplier_pocket_plan"]["summary"]["supplier_link_pocket_plans"] == 36
    assert report["supplier_pocket_plan"]["summary"]["bbox_fit_after_adjustment"] == 36
    assert (
        report["supplier_pocket_plan"]["summary"][
            "candidate_placement_proxy_reloads"
        ]
        == 36
    )
    assert (
        report["supplier_pocket_plan"]["summary"][
            "candidate_placement_transforms"
        ]
        == 36
    )
    assert report["supplier_pocket_plan"]["summary"]["accepted_placement_transforms"] == 0
    assert report["supplier_pocket_plan"]["summary"]["mate_feature_candidate_plans"] == 36
    assert report["supplier_pocket_plan"]["summary"]["mate_feature_unassigned_plans"] == 0
    assert report["supplier_pocket_plan"]["summary"]["fastener_access_candidate_plans"] == 24
