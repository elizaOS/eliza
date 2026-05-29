from __future__ import annotations

import json
import subprocess
import sys

from eliza_robot.asimov_1.fembot_component_constraints import (
    build_fembot_component_constraint_coverage_proof,
)
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory
from eliza_robot.asimov_1.fembot_keepouts import build_fembot_keepout_proof


def test_fembot_component_constraints_name_required_hardware_families() -> None:
    inventory = collect_fembot_inventory()
    keepouts = build_fembot_keepout_proof(inventory["body_groups"])
    report = build_fembot_component_constraint_coverage_proof(
        inventory["body_groups"],
        keepout_report=keepouts,
    )

    assert report["schema"] == "asimov-fembot-component-constraint-coverage-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert report["summary"]["required_families"] == 9
    assert report["summary"]["covered_families"] == 9
    assert report["summary"]["accepted_families"] == 0
    assert report["summary"]["links_with_motor_keepouts"] > 0
    assert report["summary"]["links_with_joint_axis_keepouts"] > 0
    assert 0 < report["summary"]["links_with_collision_keepouts"] < 28
    assert report["summary"]["source_mesh_envelopes"] == 28
    assert report["summary"]["off_the_shelf_vendor_envelopes"] > 0
    assert report["summary"]["off_the_shelf_vendor_envelopes"] == 105
    assert report["summary"]["unique_off_the_shelf_vendor_envelopes"] == 67
    assert report["summary"]["duplicate_off_the_shelf_vendor_references"] == 38
    assert report["summary"]["unique_off_the_shelf_vendor_geometry_hashes"] == 46
    assert report["summary"]["duplicate_off_the_shelf_vendor_geometry_hashes"] == 10
    assert report["summary"]["duplicate_off_the_shelf_vendor_geometry_paths"] == 31
    assert report["summary"]["vendor_envelopes_with_step_product_metadata"] == 67
    assert report["summary"]["vendor_envelopes_with_supplier_codes"] == 8
    assert report["summary"]["unique_vendor_supplier_codes"] == 5
    assert report["summary"]["classified_vendor_supplier_codes"] == 5
    assert report["summary"]["unclassified_vendor_supplier_codes"] == 0
    assert report["summary"]["supplier_code_family_counts"] == {
        "bearing_or_ring": 3,
        "fastener_or_thread": 2,
    }
    assert report["summary"]["supplier_code_geometry_loaded_paths"] == 20
    assert report["summary"]["supplier_code_geometry_failed_paths"] == 0
    assert report["summary"]["unique_supplier_code_geometry_loaded_paths"] == 8
    assert report["summary"]["unique_supplier_code_geometry_failed_paths"] == 0
    assert report["summary"]["supplier_code_fit_margin_m"] == 0.002
    assert report["summary"]["supplier_code_generated_link_fit_checked"] == 70
    assert report["summary"]["supplier_code_generated_link_fit_pass"] == 34
    assert report["summary"]["supplier_code_generated_link_fit_fail"] == 36
    assert (
        report["summary"]["supplier_code_max_required_generated_extent_growth_m"]
        == 0.0264997322031618
    )
    assert report["summary"]["supplier_code_generated_links_checked"] == 14
    assert report["summary"]["supplier_code_generated_links_requiring_growth"] == 8
    assert report["summary"]["supplier_code_worst_growth_links"] == [
        "LEFT_KNEE",
        "RIGHT_KNEE",
        "LEFT_ANKLE_A",
        "RIGHT_ANKLE_A",
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
        "LEFT_HIP_ROLL",
        "RIGHT_HIP_ROLL",
    ]
    assert report["summary"]["vendor_envelopes_with_component_family_keywords"] == 0
    assert report["summary"]["vendor_envelopes_by_assembly"] == {
        "100": 5,
        "200": 5,
        "300": 7,
        "400": 7,
        "500": 19,
        "600": 19,
        "700": 5,
    }
    assert report["summary"]["missing_families"] == []
    assert report["summary"]["direct_drive_transmission_audited_joints"] == 27
    assert report["summary"]["wiring_service_access_corridors"] == 26

    families = {record["family"]: record for record in report["component_families"]}
    assert families["motor_actuator"]["covered_count"] == 25
    assert families["joint_axis"]["covered_count"] == 27
    assert families["collision_capsule"]["covered_count"] >= 30
    assert families["vendor_off_the_shelf"]["covered_count"] > 0
    assert families["vendor_off_the_shelf"]["covered_count"] == 67
    assert families["vendor_off_the_shelf"]["evidence_count"] == 67
    assert families["bearing_or_ring"]["covered_count"] == 3
    assert families["bearing_or_ring"]["clearance_geometry_present"] is True
    assert families["fastener_or_thread"]["covered_count"] == 2
    assert families["fastener_or_thread"]["clearance_geometry_present"] is True
    assert families["gear_or_pulley_or_belt"]["covered_count"] == 27
    assert families["gear_or_pulley_or_belt"]["clearance_geometry_present"] is True
    assert families["fastener_or_thread"]["accepted"] is False
    assert families["wiring_or_service_access"]["covered_count"] == 26
    assert families["wiring_or_service_access"]["clearance_geometry_present"] is True
    assert "bearing/ring supplier codes" in report["summary"]["acceptance_blocker"]
    assert report["vendor_envelope_summary"]["unique_vendor_envelopes"] == 67
    assert report["vendor_envelope_summary"]["duplicate_vendor_references"] == 38
    assert report["vendor_envelope_summary"]["unique_vendor_geometry_hashes"] == 46
    assert report["vendor_envelope_summary"]["duplicate_vendor_geometry_hashes"] == 10
    assert report["vendor_envelope_summary"]["duplicate_vendor_geometry_paths"] == 31
    assert (
        len(report["vendor_envelope_summary"]["duplicate_vendor_geometry_groups"])
        == 10
    )
    assert report["vendor_envelope_summary"]["vendor_envelopes_with_supplier_codes"] == 8
    assert report["vendor_envelope_summary"]["unique_vendor_supplier_codes"] == 5
    assert (
        report["vendor_envelope_summary"]["classified_vendor_supplier_codes"] == 5
    )
    assert (
        report["vendor_envelope_summary"]["unclassified_vendor_supplier_codes"] == 0
    )
    assert report["vendor_envelope_summary"]["supplier_code_family_counts"] == {
        "bearing_or_ring": 3,
        "fastener_or_thread": 2,
    }
    assert (
        report["vendor_envelope_summary"]["supplier_code_geometry_loaded_paths"]
        == 20
    )
    assert (
        report["vendor_envelope_summary"]["supplier_code_geometry_failed_paths"]
        == 0
    )
    assert (
        report["vendor_envelope_summary"]["unique_supplier_code_geometry_loaded_paths"]
        == 8
    )
    assert (
        report["vendor_envelope_summary"]["unique_supplier_code_geometry_failed_paths"]
        == 0
    )
    assert report["vendor_envelope_summary"]["supplier_code_fit_margin_m"] == 0.002
    assert (
        report["vendor_envelope_summary"]["supplier_code_generated_link_fit_checked"]
        == 70
    )
    assert (
        report["vendor_envelope_summary"]["supplier_code_generated_link_fit_pass"]
        == 34
    )
    assert (
        report["vendor_envelope_summary"]["supplier_code_generated_link_fit_fail"]
        == 36
    )
    assert (
        report["vendor_envelope_summary"][
            "supplier_code_max_required_generated_extent_growth_m"
        ]
        == 0.0264997322031618
    )
    assert (
        report["vendor_envelope_summary"]["supplier_code_generated_links_checked"]
        == 14
    )
    assert (
        report["vendor_envelope_summary"][
            "supplier_code_generated_links_requiring_growth"
        ]
        == 8
    )
    assert report["vendor_envelope_summary"]["supplier_code_worst_growth_links"] == [
        "LEFT_KNEE",
        "RIGHT_KNEE",
        "LEFT_ANKLE_A",
        "RIGHT_ANKLE_A",
        "LEFT_HIP_YAW",
        "RIGHT_HIP_YAW",
        "LEFT_HIP_ROLL",
        "RIGHT_HIP_ROLL",
    ]
    assert (
        report["vendor_envelope_summary"][
            "vendor_envelopes_with_component_family_keywords"
        ]
        == 0
    )
    assert len(report["vendor_envelope_summary"]["supplier_code_records"]) == 8
    assert report["vendor_envelope_summary"]["component_family_keyword_records"] == []
    supplier_targets = {
        target["supplier_code"]: target
        for target in report["vendor_envelope_summary"][
            "supplier_code_classification_targets"
        ]
    }
    assert set(supplier_targets) == {
        "1600-0515-0006",
        "1602-0032-0006",
        "2806-0005-0004",
        "2920-0001-0006",
        "91390A117",
    }
    assert all(
        target["classification"]["classification_required_for_acceptance"] is True
        for target in supplier_targets.values()
    )
    assert supplier_targets["1600-0515-0006"]["classification"]["family"] == "bearing_or_ring"
    assert (
        supplier_targets["1600-0515-0006"]["classification"]["classification_status"]
        == "geometry_inferred_from_step_assembly"
    )
    assert supplier_targets["1602-0032-0006"]["classification"]["family"] == "bearing_or_ring"
    assert supplier_targets["2920-0001-0006"]["classification"]["family"] == "bearing_or_ring"
    assert supplier_targets["2806-0005-0004"]["classification"]["family"] == "fastener_or_thread"
    assert supplier_targets["91390A117"]["classification"]["family"] == "fastener_or_thread"
    assert all(target["geometry_failed_count"] == 0 for target in supplier_targets.values())
    assert supplier_targets["1600-0515-0006"]["geometry_loaded_count"] == 4
    assert supplier_targets["1600-0515-0006"]["max_body_bbox_extent_m"] == 0.038
    assert supplier_targets["1600-0515-0006"]["generated_link_fit_pass_count"] == 8
    assert supplier_targets["1600-0515-0006"]["generated_link_fit_fail_count"] == 6
    assert (
        supplier_targets["1600-0515-0006"][
            "max_required_generated_extent_growth_m"
        ]
        == 0.0264997322031618
    )
    left_knee_1600 = next(
        report
        for report in supplier_targets["1600-0515-0006"][
            "generated_link_fit_reports"
        ]
        if report["link"] == "LEFT_KNEE"
    )
    assert left_knee_1600["required_sorted_extent_growth_m"] == [
        0.0,
        0.0264997322031618,
        0.0,
    ]
    assert (
        supplier_targets["2806-0005-0004"]["max_body_bbox_extent_m"]
        == 0.013500000200000003
    )
    assert supplier_targets["2806-0005-0004"]["generated_link_fit_pass_count"] == 6
    assert supplier_targets["2806-0005-0004"]["generated_link_fit_fail_count"] == 8
    failed_2806_links = {
        record["link"]
        for record in supplier_targets["2806-0005-0004"][
            "generated_link_fit_reports"
        ]
        if not record["orientation_agnostic_bbox_fit"]
    }
    assert {
        "LEFT_ANKLE_A",
        "LEFT_HIP_ROLL",
        "LEFT_HIP_YAW",
        "LEFT_KNEE",
        "RIGHT_ANKLE_A",
        "RIGHT_HIP_ROLL",
        "RIGHT_HIP_YAW",
        "RIGHT_KNEE",
    } == failed_2806_links
    assert any(
        {"500", "600"}.issubset(set(group["assemblies"]))
        for group in report["vendor_envelope_summary"]["duplicate_vendor_geometry_groups"]
    )
    link_growth = {
        record["link"]: record
        for record in report["vendor_envelope_summary"][
            "supplier_code_link_growth_summary"
        ]
    }
    assert len(link_growth) == 14
    assert link_growth["LEFT_KNEE"]["fit_fail_count"] == 5
    assert link_growth["LEFT_KNEE"]["max_required_extent_growth_m"] == 0.0264997322031618
    assert link_growth["LEFT_HIP_ROLL"]["fit_fail_count"] == 3
    assert link_growth["LEFT_TOE"]["requires_growth"] is False
    assert len(report["vendor_envelope_summary"]["duplicated_vendor_paths"]) == 38


def test_fembot_inventory_surfaces_component_constraint_status() -> None:
    report = collect_fembot_inventory()

    assert report["component_constraints"]["ok"] is True
    assert report["component_constraints"]["accepted"] is False
    assert report["component_constraints"]["summary"]["required_families"] == 9
    assert report["component_constraints"]["summary"]["source_mesh_envelopes"] == 28
    assert (
        report["component_constraints"]["summary"]["off_the_shelf_vendor_envelopes"]
        > 0
    )
    assert (
        report["component_constraints"]["summary"][
            "unique_off_the_shelf_vendor_envelopes"
        ]
        == 67
    )
    assert (
        report["component_constraints"]["summary"][
            "duplicate_off_the_shelf_vendor_references"
        ]
        == 38
    )
    assert (
        report["component_constraints"]["summary"][
            "unique_off_the_shelf_vendor_geometry_hashes"
        ]
        == 46
    )
    assert (
        report["component_constraints"]["summary"][
            "duplicate_off_the_shelf_vendor_geometry_hashes"
        ]
        == 10
    )
    assert (
        report["component_constraints"]["summary"][
            "vendor_envelopes_with_supplier_codes"
        ]
        == 8
    )
    assert (
        report["component_constraints"]["summary"]["unique_vendor_supplier_codes"]
        == 5
    )
    assert (
        report["component_constraints"]["summary"]["classified_vendor_supplier_codes"]
        == 5
    )
    assert (
        report["component_constraints"]["summary"][
            "unclassified_vendor_supplier_codes"
        ]
        == 0
    )
    assert (
        report["component_constraints"]["summary"]["supplier_code_family_counts"]
        == {"bearing_or_ring": 3, "fastener_or_thread": 2}
    )
    assert (
        report["component_constraints"]["summary"][
            "direct_drive_transmission_audited_joints"
        ]
        == 27
    )
    assert (
        report["component_constraints"]["summary"]["wiring_service_access_corridors"]
        == 26
    )
    assert (
        report["component_constraints"]["summary"][
            "unique_supplier_code_geometry_loaded_paths"
        ]
        == 8
    )
    assert (
        report["component_constraints"]["summary"][
            "unique_supplier_code_geometry_failed_paths"
        ]
        == 0
    )
    assert (
        report["component_constraints"]["summary"][
            "supplier_code_generated_link_fit_fail"
        ]
        == 36
    )
    assert (
        report["component_constraints"]["summary"][
            "supplier_code_max_required_generated_extent_growth_m"
        ]
        == 0.0264997322031618
    )
    assert (
        report["component_constraints"]["summary"][
            "supplier_code_generated_links_requiring_growth"
        ]
        == 8
    )
    assert (
        report["component_constraints"]["summary"][
            "vendor_envelopes_with_component_family_keywords"
        ]
        == 0
    )
    assert report["component_constraints"]["summary"]["missing_families"] == []


def test_fembot_component_constraints_cli_writes_gateable_proof(tmp_path) -> None:
    output = tmp_path / "fembot-component-constraints.json"
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/generate_asimov_fembot_component_constraints_proof.py",
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
    assert report["schema"] == "asimov-fembot-component-constraint-coverage-v1"
    assert report["ok"] is True
    assert report["accepted"] is False
    assert proc.returncode == 2
    assert '"accepted": false' in proc.stdout
