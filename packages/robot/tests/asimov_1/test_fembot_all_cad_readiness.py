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
    assert report["summary"]["generated_placeholder_reference_links"] == 0
    assert report["summary"]["generated_placeholder_reference_link_names"] == []
    assert report["summary"]["generated_source_fitted_controlled_loft_links"] == 28
    assert len(report["summary"]["generated_source_fitted_controlled_loft_link_names"]) == 28
    assert report["summary"]["source_shape_ready_links"] == 28
    assert report["summary"]["source_decision_exact_brep_ready_links"] == 0
    assert report["summary"]["source_decision_selected_controlled_loft_links"] == 28
    assert report["summary"]["source_decision_rejected_step_brep_candidate_links"] == 28
    assert report["summary"]["brep_surface_fit_accepted_link_fits"] == 0
    assert report["summary"]["brep_surface_fit_rejected_link_fits"] == 28
    assert report["summary"]["brep_surface_fit_shape_mismatch_links"] == 28
    assert report["summary"]["link_source_exact_brep_body_assignments"] == 0
    assert report["summary"]["link_source_controlled_loft_assignments"] == 28
    assert report["summary"]["source_shape_fit_ready"] is True
    assert report["summary"]["generated_cad_accepted"] is False
    assert report["summary"]["generated_internal_cavity_violation_links"] == 26
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
    assert report["summary"]["stl_mesh_assets_have_parametric_provenance"] is True
    assert report["summary"]["unproven_stl_mesh_asset_links"] == []
    assert report["summary"]["generated_stl_physics_allowed"] is True
    assert report["summary"]["generated_stl_physics_ready"] is True
    assert report["summary"]["generated_stl_physics_ready_links"] == 28
    assert report["summary"]["generated_stl_mesh_artifact_free_links"] == 28
    assert report["summary"]["generated_step_mesh_topology_ready"] is False
    assert report["summary"]["generated_step_mesh_accepted_topologies"] == 19
    assert (
        report["summary"][
            "generated_step_mesh_waist_single_shell_no_cutout_topology_links"
        ]
        == 1
    )
    assert report["summary"]["generated_step_mesh_topology_failure_links"] == 9
    assert report["summary"]["generated_step_mesh_repair_preview_accepted_topologies"] == 9
    assert report["summary"]["generated_step_mesh_repair_preview_envelope_preserved_links"] == 9
    assert (
        report["summary"][
            "generated_step_mesh_repair_preview_promotable_by_topology_and_envelope"
        ]
        is True
    )
    assert report["summary"]["generated_step_mesh_topology_resolved_links"] == 28
    assert report["summary"]["generated_step_mesh_topology_resolved_by_repair_preview_links"] == 9
    assert report["summary"]["generated_step_mesh_topology_unresolved_links"] == 0
    assert report["summary"]["generated_step_mesh_topology_unresolved_link_names"] == []
    assert report["summary"]["promoted_step_mesh_topology_ready"] is True
    assert report["summary"]["promoted_step_mesh_links"] == 28
    assert report["summary"]["promoted_step_mesh_original_step_links"] == 19
    assert report["summary"]["promoted_step_mesh_repair_preview_links"] == 9
    assert report["summary"]["promoted_step_mesh_accepted_meshes"] == 28
    assert report["summary"]["promoted_step_mesh_max_boundary_edges"] == 0
    assert report["summary"]["promoted_step_mesh_max_nonmanifold_edges"] == 0
    assert report["summary"]["promoted_step_mesh_max_degenerate_faces"] == 0
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
    assert "production-accepted" in report["summary"]["acceptance_blocker"]
    assert "internal cavity/keepout" in report["summary"]["acceptance_blocker"]
    assert report["source_shape_readiness"]["source_shape_fit_ready"] is True
    assert len(
        report["source_shape_readiness"]["generated_source_fitted_controlled_loft_links"]
    ) == 28
    assert report["source_shape_readiness"]["source_decision"]["accepted"] is False
    assert report["source_shape_readiness"]["brep_surface_fit"]["accepted"] is False
    assert (
        report["source_shape_readiness"]["link_source_assignment"]["summary"][
            "exact_brep_body_assignments"
        ]
        == 0
    )
    assert report["generated_topology"]["ok"] is True
    assert report["generated_topology"]["accepted"] is False
    assert report["topology_promotion"]["ok"] is True
    assert report["topology_promotion"]["accepted"] is True
    assert report["mesh_traceability"]["ok"] is True
    assert report["mesh_traceability"]["accepted"] is True
    assert report["mesh_traceability"]["summary"]["generated_stl_physics_ready"] is True
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
    assert '"generated_placeholder_reference_links": 0' in proc.stdout
    assert '"source_shape_fit_ready": true' in proc.stdout
    assert '"mjcf_stl_mesh_assets": 0' in proc.stdout
    assert '"generated_stl_physics_ready": true' in proc.stdout
    assert '"primary_visual_mesh_geoms_replaced": 28' in proc.stdout


def test_fembot_inventory_surfaces_all_cad_no_stl_gap() -> None:
    report = collect_fembot_inventory()

    assert report["all_cad_readiness"]["ok"] is True
    assert report["all_cad_readiness"]["accepted"] is False
    assert report["all_cad_readiness"]["summary"]["links_with_generated_step_reference"] == 28
    assert report["all_cad_readiness"]["summary"]["generated_placeholder_reference_links"] == 0
    assert (
        report["all_cad_readiness"]["summary"][
            "generated_source_fitted_controlled_loft_links"
        ]
        == 28
    )
    assert report["all_cad_readiness"]["summary"]["source_shape_fit_ready"] is True
    assert report["all_cad_readiness"]["summary"]["generated_cad_accepted"] is False
    assert report["all_cad_readiness"]["summary"]["brep_surface_fit_accepted_link_fits"] == 0
    assert report["all_cad_readiness"]["summary"]["parametric_part_scripts"] == 28
    assert report["all_cad_readiness"]["summary"]["missing_parametric_part_scripts"] == []
    assert report["all_cad_readiness"]["summary"]["waist_yaw_no_cutout_accepted"] is True
    assert report["all_cad_readiness"]["summary"]["mjcf_stl_mesh_assets"] == 0
    assert report["all_cad_readiness"]["summary"]["links_still_using_stl_mesh_assets"] == 0
    assert (
        report["all_cad_readiness"]["summary"][
            "stl_mesh_assets_have_parametric_provenance"
        ]
        is True
    )
    assert report["all_cad_readiness"]["summary"]["generated_stl_physics_ready"] is True
    assert report["all_cad_readiness"]["summary"]["generated_stl_physics_ready_links"] == 28
    assert (
        report["all_cad_readiness"]["summary"][
            "generated_stl_mesh_artifact_free_links"
        ]
        == 28
    )
    assert (
        report["all_cad_readiness"]["summary"]["generated_step_mesh_topology_ready"]
        is False
    )
    assert report["all_cad_readiness"]["summary"]["generated_step_mesh_topology_failure_links"] == 9
    assert report["all_cad_readiness"]["summary"]["generated_step_mesh_topology_resolved_links"] == 28
    assert report["all_cad_readiness"]["summary"]["generated_step_mesh_topology_unresolved_link_names"] == []
    assert report["all_cad_readiness"]["summary"]["promoted_step_mesh_topology_ready"] is True
    assert report["all_cad_readiness"]["summary"]["promoted_step_mesh_repair_preview_links"] == 9
    assert report["all_cad_readiness"]["summary"]["promoted_step_mesh_accepted_meshes"] == 28
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
