from __future__ import annotations

import pytest

from eliza_robot.asimov_1.spline_fit_proof import build_spline_fit_proof


def test_left_ankle_a_spline_fit_proves_every_fitted_ring() -> None:
    report = build_spline_fit_proof(
        link="LEFT_ANKLE_A",
        axis="z",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
    )

    assert report["schema"] == "asimov-1-spline-fit-proof-v1"
    assert report["fit_policy"]["control_sample_ratio"] <= report["fit_policy"][
        "max_control_sample_ratio"
    ]
    assert report["mesh_sha256"]
    assert report["output_mesh_sha256"]
    assert report["summary"]["ok"] is True
    assert report["summary"]["failure_reasons"] == []
    assert report["summary"]["section_coverage_ok"] is True
    assert report["summary"]["internal_rings_skipped"] == 0
    assert report["summary"]["rings_fit"] >= 3
    assert report["summary"]["rings_closed"] == report["summary"]["rings_fit"]
    assert report["summary"]["rings_nondegenerate"] == report["summary"]["rings_fit"]
    assert report["summary"]["max_closure_gap_m"] <= report["tolerances"]["spline_closure_tolerance_m"]
    assert report["summary"]["min_fitted_ring_area_m2"] >= report["tolerances"]["min_fitted_ring_area_m2"]
    assert report["summary"]["min_fitted_ring_perimeter_m"] >= report["tolerances"]["min_fitted_ring_perimeter_m"]
    assert report["summary"]["interfaces_checked"] == 2
    assert report["summary"]["interfaces_ok"] == 2
    assert report["summary"]["output_watertight"] is True
    assert report["summary"]["output_boundary_edges"] == 0
    assert report["summary"]["output_nonmanifold_edges"] == 0
    assert "source_topology" in report
    assert report["summary"]["max_error_m"] <= report["tolerances"]["max_error_m"]
    assert report["summary"]["max_rms_error_m"] <= report["tolerances"]["rms_error_m"]
    assert (
        report["summary"]["max_interface_bbox_delta_m"]
        <= report["tolerances"]["interface_tolerance_m"]
    )
    assert (
        report["summary"]["surface_symmetric_hausdorff_m"]
        <= report["tolerances"]["surface_distance_tolerance_m"]
    )
    assert all(ring["ok"] for ring in report["rings"])
    assert all(ring["closed_loop_ok"] for ring in report["rings"])
    assert all(ring["nondegenerate_loop_ok"] for ring in report["rings"])
    assert all(ring["closure_gap_m"] <= report["tolerances"]["spline_closure_tolerance_m"] for ring in report["rings"])
    assert all(ring["fitted_area_m2"] >= report["tolerances"]["min_fitted_ring_area_m2"] for ring in report["rings"])
    assert all(interface["ok"] for interface in report["interfaces"])
    assert report["topology"]["ok"] is True
    assert report["surface_distance"]["ok"] is True


def test_waist_yaw_default_radial_sections_report_actionable_fit_failures() -> None:
    report = build_spline_fit_proof(
        link="WAIST_YAW",
        axis="z",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["summary"]["ok"] is False
    reasons = report["summary"]["failure_reasons"]
    assert any(reason.startswith("spline_fit:") for reason in reasons)
    assert any(reason.startswith("section_coverage:") for reason in reasons)
    assert report["summary"]["interfaces_checked"] == 3
    assert report["summary"]["interfaces_ok"] == 3
    assert report["topology"]["ok"] is True


def test_plane_intersection_sections_separate_coverage_from_shape_error() -> None:
    report = build_spline_fit_proof(
        link="LEFT_SHOULDER_PITCH",
        axis="y",
        section_method="plane_intersection",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["section_method"] == "plane_intersection"
    assert report["summary"]["section_coverage_ok"] is True
    assert report["summary"]["internal_rings_skipped"] == 0
    assert any(
        reason.startswith("spline_fit:")
        for reason in report["summary"]["failure_reasons"]
    )


def test_plane_loop_sections_fit_non_radial_shoulder_contours() -> None:
    report = build_spline_fit_proof(
        link="LEFT_SHOULDER_PITCH",
        axis="y",
        section_method="plane_loops",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["section_method"] == "plane_loops"
    assert report["summary"]["ok"] is True
    assert report["summary"]["section_coverage_ok"] is True
    assert report["summary"]["internal_rings_skipped"] == 0
    assert report["summary"]["rings_fit"] > report["summary"]["levels_checked"]
    assert report["summary"]["failure_reasons"] == []
    assert any(ring["loop_index"] > 0 for ring in report["rings"])
    assert all(ring["loop_perimeter_m"] >= 0.005 for ring in report["rings"])


def test_plane_loop_sections_nudge_coplanar_intersection_degeneracy() -> None:
    report = build_spline_fit_proof(
        link="LEFT_HIP_ROLL",
        axis="z",
        section_method="plane_loops",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["summary"]["ok"] is True
    assert report["summary"]["section_coverage_ok"] is True
    assert report["summary"]["internal_rings_skipped"] == 0
    assert report["summary"]["nudged_levels"] == 1
    assert report["nudged_levels"] == [-0.04200000002980232]
    assert any(abs(ring["level_nudge_m"]) > 0.0 for ring in report["rings"])
    assert report["summary"]["failure_reasons"] == []


def test_plane_loop_sections_prove_repaired_toe_topology() -> None:
    report = build_spline_fit_proof(
        link="RIGHT_TOE",
        axis="x",
        section_method="plane_loops",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["summary"]["section_coverage_ok"] is True
    assert report["summary"]["internal_rings_skipped"] == 0
    assert not any(
        reason.startswith("spline_fit:")
        for reason in report["summary"]["failure_reasons"]
    )
    assert report["summary"]["source_nonmanifold_edges"] == 27
    assert report["summary"]["output_nonmanifold_edges"] == 0
    assert report["summary"]["output_boundary_edges"] == 0
    assert not any(
        reason.startswith("topology:")
        for reason in report["summary"]["failure_reasons"]
    )


def test_controlled_loft_validation_reports_repaired_shoulder_roll_ring_integrity() -> None:
    report = build_spline_fit_proof(
        link="LEFT_SHOULDER_ROLL",
        axis="z",
        section_method="plane_loops",
        validation_mesh_source="controlled_loft",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["validation_mesh_source"] == "controlled_loft"
    assert report["summary"]["interfaces_checked"] == 2
    assert report["summary"]["interfaces_ok"] == 2
    assert report["summary"]["controlled_loft_sections"] > 0
    assert report["summary"]["controlled_loft_triangles"] > 0
    assert report["summary"]["rings_closed"] == report["summary"]["rings_fit"]
    assert report["summary"]["rings_nondegenerate"] == report["summary"]["rings_fit"]
    assert not any(
        reason.startswith("spline_closure:")
        or reason.startswith("spline_degenerate:")
        for reason in report["summary"]["failure_reasons"]
    )
    assert report["summary"]["output_watertight"] is True
    assert report["summary"]["output_nonmanifold_edges"] == 0


def test_controlled_loft_footprint_guard_preserves_ankle_toe_interface() -> None:
    report = build_spline_fit_proof(
        link="LEFT_ANKLE_B",
        axis="x",
        section_method="plane_loops",
        validation_mesh_source="controlled_loft",
        control_count=64,
        max_error_m=0.006,
        rms_error_m=0.002,
        surface_distance_samples=1000,
    )

    assert report["summary"]["ok"] is True
    assert report["summary"]["failure_reasons"] == []
    assert report["summary"]["interface_footprint_levels"] == 1
    assert report["summary"]["interfaces_checked"] == 2
    assert report["summary"]["interfaces_ok"] == 2
    assert report["summary"]["output_watertight"] is True
    assert report["summary"]["output_nonmanifold_edges"] == 0
    assert (
        report["summary"]["surface_symmetric_hausdorff_m"]
        <= report["tolerances"]["surface_distance_tolerance_m"]
    )


def test_spline_fit_rejects_overfitted_control_ratio() -> None:
    with pytest.raises(ValueError, match="overfitted spline proofs"):
        build_spline_fit_proof(
            link="LEFT_ANKLE_A",
            axis="z",
            angular_samples=96,
            control_count=96,
        )
