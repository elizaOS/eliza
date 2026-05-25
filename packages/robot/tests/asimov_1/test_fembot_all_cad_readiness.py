from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_all_cad_readiness import (
    build_fembot_all_cad_readiness_proof,
)
from eliza_robot.asimov_1.fembot_inventory import (
    FEMBOT_BODY_GROUP_LINKS,
    collect_fembot_inventory,
)


def _body_groups() -> list[dict[str, object]]:
    return [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]


def test_fembot_all_cad_readiness_counts_remaining_stl_mesh_blocker() -> None:
    report = build_fembot_all_cad_readiness_proof(_body_groups())

    assert report["schema"] == "asimov-fembot-all-cad-readiness-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["links"] == 28
    assert report["summary"]["links_with_generated_step_reference"] == 28
    assert report["summary"]["missing_generated_step_links"] == []
    assert report["summary"]["parametric_part_scripts"] == 28
    assert report["summary"]["missing_parametric_part_scripts"] == []
    assert report["summary"]["waist_yaw_no_cutout_accepted"] is True
    assert report["summary"]["waist_yaw_generated_sections_ok"] is True
    assert report["summary"]["mjcf_mesh_assets"] == 0
    assert report["summary"]["mjcf_mesh_visual_geoms"] == 0
    assert report["summary"]["mjcf_stl_mesh_assets"] == 0
    assert report["summary"]["mjcf_stl_mesh_visual_geoms"] == 0
    assert report["summary"]["links_still_using_stl_mesh_assets"] == 0
    assert report["summary"]["no_stl_mesh_assets"] is True
    assert report["summary"]["primary_no_stl_mesh_assets"] is True
    assert report["summary"]["primary_mjcf_ok"] is True
    assert report["summary"]["primary_mjcf_nmesh"] == 0
    assert report["summary"]["primary_visual_mesh_replacement_ok"] is True
    assert report["summary"]["primary_visual_mesh_assets_removed"] == 28
    assert report["summary"]["primary_visual_mesh_geoms_replaced"] == 28
    assert report["summary"]["primary_visual_envelope_failures"] == 0
    assert report["summary"]["primary_visual_max_bbox_center_delta_m"] == 0.0
    assert report["summary"]["primary_visual_max_bbox_extent_delta_m"] == 0.0
    assert report["summary"]["primary_replacement_links"] == 28
    assert report["summary"]["primary_replacement_ok"] is True
    assert report["summary"]["no_stl_primitive_surrogate_ok"] is True
    assert report["summary"]["no_stl_primitive_surrogate_nmesh"] == 0
    assert report["summary"]["no_stl_primitive_surrogate_visual_replacements"] == 28
    assert report["summary"]["no_stl_primitive_surrogate_ellipsoid_visuals"] == 26
    assert report["summary"]["no_stl_primitive_surrogate_box_visuals"] == 2
    assert (
        report["summary"]["no_stl_primitive_surrogate_visual_envelope_matches_generated_cad"]
        is True
    )
    assert report["summary"]["no_stl_primitive_surrogate_visual_envelope_failures"] == 0
    assert report["summary"]["no_stl_primitive_surrogate_max_visual_bbox_center_delta_m"] == 0.0
    assert report["summary"]["no_stl_primitive_surrogate_max_visual_bbox_extent_delta_m"] == 0.0
    assert report["summary"]["all_cad_parametric_ready"] is False
    assert "primary MuJoCo model now compiles without STL mesh assets" in report["summary"]["acceptance_blocker"]
    assert report["cad_primitive_mjcf"]["ok"] is True
    assert report["cad_primitive_mjcf"]["summary"]["nmesh"] == 0
    assert report["waist_yaw_no_cutout"]["accepted"] is True
    assert len(report["parametric_part_scripts"]) == 28
    assert report["cad_primitive_mjcf"]["summary"]["visual_envelope_matches_generated_cad"] is True

    by_link = {record["link"]: record for record in report["mesh_assets"]}
    assert by_link == {}


def test_fembot_all_cad_readiness_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-all-cad-readiness.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_all_cad_readiness.py",
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
    assert report["schema"] == "asimov-fembot-all-cad-readiness-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"mjcf_stl_mesh_assets": 0' in proc.stdout
    assert '"primary_visual_mesh_geoms_replaced": 28' in proc.stdout


def test_fembot_inventory_surfaces_all_cad_no_stl_gap() -> None:
    report = collect_fembot_inventory()

    assert report["all_cad_readiness"]["ok"] is True
    assert report["all_cad_readiness"]["accepted"] is False
    assert report["all_cad_readiness"]["summary"]["links_with_generated_step_reference"] == 28
    assert report["all_cad_readiness"]["summary"]["parametric_part_scripts"] == 28
    assert report["all_cad_readiness"]["summary"]["missing_parametric_part_scripts"] == []
    assert report["all_cad_readiness"]["summary"]["waist_yaw_no_cutout_accepted"] is True
    assert report["all_cad_readiness"]["summary"]["mjcf_stl_mesh_assets"] == 0
    assert report["all_cad_readiness"]["summary"]["links_still_using_stl_mesh_assets"] == 0
    assert report["all_cad_readiness"]["summary"]["no_stl_mesh_assets"] is True
    assert report["all_cad_readiness"]["summary"]["primary_visual_mesh_geoms_replaced"] == 28
    assert report["all_cad_readiness"]["summary"]["primary_replacement_ok"] is True
    assert report["all_cad_readiness"]["summary"]["no_stl_primitive_surrogate_ok"] is True
    assert report["all_cad_readiness"]["summary"]["no_stl_primitive_surrogate_nmesh"] == 0
    assert (
        report["all_cad_readiness"]["summary"][
            "no_stl_primitive_surrogate_visual_envelope_matches_generated_cad"
        ]
        is True
    )
    assert (
        report["all_cad_readiness"]["summary"][
            "no_stl_primitive_surrogate_ellipsoid_visuals"
        ]
        == 26
    )
