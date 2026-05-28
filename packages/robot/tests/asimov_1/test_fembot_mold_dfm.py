from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    collect_fembot_inventory,
)
from eliza_robot.asimov_1.fembot_mold_dfm import build_fembot_mold_dfm_proof


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_mold_dfm_screens_smooth_loft_processes() -> None:
    report = build_fembot_mold_dfm_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-mold-dfm-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["smooth_shell_records"] == 26
    assert report["summary"]["torso_head_shell_records"] == 4
    assert report["summary"]["limb_shell_records"] == 22
    assert report["summary"]["injection_min_wall_m"] == 0.0015
    assert report["summary"]["vacuform_min_wall_m"] == 0.00075
    assert report["summary"]["max_injection_screen_draw_ratio"] == 8.0
    assert report["summary"]["injection_wall_failures"] == 26
    assert report["summary"]["injection_wall_adjustment_preview_shells"] == 26
    assert report["summary"]["injection_wall_adjustment_preview_wall_ok_shells"] == 26
    assert report["summary"]["injection_wall_adjustment_preview_height_preserved_shells"] == 26
    assert report["summary"]["injection_wall_adjustment_preview_parametric_editable_shells"] == 26
    assert report["summary"]["injection_wall_adjustment_preview_cavity_clearance_failures"] == 22
    assert report["summary"]["injection_wall_adjustment_max_wall_increase_m"] > 0.0
    assert report["summary"]["injection_wall_adjustment_max_outward_growth_if_used_m"] > 0.0
    assert report["summary"]["injection_draw_ratio_screen_failures"] == 0
    assert report["summary"]["vacuform_draw_ratio_failures"] == 2
    assert report["summary"]["internal_cavity_clearance_failures"] == 0
    assert report["summary"]["internal_cavity_pre_clearance_failures"] == 26
    assert report["summary"]["full_cavity_clearance_verified_shells"] == 26
    assert report["summary"]["split_line_candidate_shells"] == 26
    assert report["summary"]["trim_flange_candidate_shells"] == 4
    assert report["summary"]["decorative_cutout_free_shells"] == 26
    assert report["summary"]["smooth_chest_no_cutout_loft_links"] == ["WAIST_YAW"]
    assert report["summary"]["draft_proven_shells"] == 0
    assert report["summary"]["undercut_proven_shells"] == 0
    assert report["summary"]["split_line_proven_shells"] == 0
    assert report["summary"]["injection_candidate_shells"] == 0
    assert report["summary"]["vacuform_candidate_shells"] == 0
    assert "draft, undercut, split-line" in report["summary"]["acceptance_blocker"]

    shells = {record["link"]: record for record in report["shells"]}
    assert shells["IMU_ORIGIN"]["recommended_process"] == (
        "molded_shell_candidate_needs_draft_split_and_parting_proof"
    )
    assert shells["IMU_ORIGIN"]["internal_cavity_pre_clearance_violation_count"] > 0
    assert shells["IMU_ORIGIN"]["internal_cavity_violation_count"] == 0
    assert shells["IMU_ORIGIN"]["full_cavity_clearance_verified"] is True
    assert shells["IMU_ORIGIN"]["vacuform"]["wall_ok"] is True
    assert shells["IMU_ORIGIN"]["injection_molding"]["wall_ok"] is False
    assert shells["IMU_ORIGIN"]["injection_wall_shortfall_m"] > 0.0
    assert shells["IMU_ORIGIN"]["injection_wall_adjustment_preview"]["adjusted_wall_ok"] is True
    assert (
        shells["IMU_ORIGIN"]["injection_wall_adjustment_preview"]["height_preserved"]
        is True
    )
    assert (
        shells["IMU_ORIGIN"]["injection_wall_adjustment_preview"]["parametric_editable"]
        is True
    )
    assert (
        shells["IMU_ORIGIN"]["injection_wall_adjustment_preview"][
            "internal_cavity_clearance_ok_after_inward"
        ]
        is False
    )
    assert shells["IMU_ORIGIN"]["injection_molding"]["draw_ratio_screen_ok"] is True
    assert shells["IMU_ORIGIN"]["injection_molding"]["split_line_candidate"] is True
    assert shells["IMU_ORIGIN"]["vacuform"]["trim_flange_candidate"] is True
    assert shells["WAIST_YAW"]["smooth_chest_no_cutout_loft"] is True
    assert shells["WAIST_YAW"]["decorative_cutout_free"] is True
    assert shells["WAIST_YAW"]["injection_molding"]["draw_ratio_screen_ok"] is True
    assert shells["LEFT_ELBOW"]["recommended_process"] == (
        "split_structural_shell_or_additive_reference_before_production"
    )


def test_fembot_inventory_surfaces_mold_dfm_status() -> None:
    report = collect_fembot_inventory()

    assert report["mold_dfm"]["ok"] is True
    assert report["mold_dfm"]["accepted"] is False
    assert report["mold_dfm"]["summary"]["smooth_shell_records"] == 26
    assert report["mold_dfm"]["summary"]["torso_head_shell_records"] == 4
    assert report["mold_dfm"]["summary"]["smooth_chest_no_cutout_loft_links"] == ["WAIST_YAW"]
    assert report["mold_dfm"]["summary"]["decorative_cutout_free_shells"] == 26
    assert report["mold_dfm"]["summary"]["trim_flange_candidate_shells"] == 4
    assert report["mold_dfm"]["summary"]["internal_cavity_clearance_failures"] == 0
    assert report["mold_dfm"]["summary"]["internal_cavity_pre_clearance_failures"] == 26
    assert report["mold_dfm"]["summary"]["full_cavity_clearance_verified_shells"] == 26
    assert (
        report["mold_dfm"]["summary"][
            "injection_wall_adjustment_preview_wall_ok_shells"
        ]
        == 26
    )
    assert report["mold_dfm"]["summary"]["injection_candidate_shells"] == 0
    assert report["mold_dfm"]["summary"]["vacuform_candidate_shells"] == 0


def test_fembot_mold_dfm_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-mold-dfm.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_mold_dfm_proof.py",
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
    assert report["schema"] == "asimov-fembot-mold-dfm-proof-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"accepted": false' in proc.stdout
