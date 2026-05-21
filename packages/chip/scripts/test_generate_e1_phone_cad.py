#!/usr/bin/env python3
import csv
import importlib.util
import json
from io import StringIO
from pathlib import Path

import generate_e1_phone_cad as cad
import pytest

_cadquery_available = importlib.util.find_spec("cadquery") is not None


def passing_visual_review() -> dict[str, dict[str, object]]:
    visual = {
        name: {
            "pass": True,
            "size": [1350, 1650],
            "mean_rgb": [230.0, 226.0, 224.0],
            "channel_spans": [255, 160, 120],
        }
        for name in [
            "full_front_iso.png",
            "full_back_iso.png",
            "rear_feature_detail.png",
            "full_left_side.png",
            "full_bottom_port.png",
            "full_top_down.png",
            "exploded_iso.png",
            "component_stack.png",
            "component-review-audio.png",
            "component-review-io-buttons.png",
            "component-review-optical.png",
            "mold_tooling.png",
        ]
    }
    visual["full_front_iso.png"]["mean_rgb"] = [248.0, 244.0, 242.0]
    visual["full_back_iso.png"]["mean_rgb"] = [231.0, 224.0, 220.0]
    return visual


def test_evt0_phone_cad_checks_pass() -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    report = cad.run_checks(params, parts)

    assert report["status"] == "pass"
    assert report["checks"]["battery_display_and_wall_clearance"]["pass"]
    battery_clearance = report["checks"]["battery_display_and_wall_clearance"]
    assert battery_clearance["battery_to_display_gap_mm"] >= 0.15
    assert battery_clearance["battery_to_back_wall_gap_mm"] >= 0.6
    foam_management = report["checks"]["battery_back_void_foam_management"]
    assert foam_management["pass"]
    assert foam_management["foam_pad_present"]
    assert foam_management["foam_to_battery_free_gap_mm"] >= 0.25
    assert (
        foam_management["back_void_managed_capacity_mm"]
        >= foam_management["back_void_required_worst_case_mm"]
    )
    assert report["checks"]["camera_burial_clearance"]["pass"]
    assert report["checks"]["camera_burial_clearance"]["rear_camera_burial_clearance_mm"] >= 0.4
    assert report["checks"]["rear_camera_back_shell_aperture"]["pass"]
    rear_aperture = report["checks"]["rear_camera_back_shell_aperture"]
    assert rear_aperture["aperture_present"]
    assert rear_aperture["aperture_mm"][0] > rear_aperture["cover_glass_mm"][0]
    assert len(rear_aperture["bezel_parts"]) == 4
    assert report["checks"]["usb_saddle_to_speaker_chamber_wall"]["pass"]
    assert report["checks"]["usb_saddle_to_speaker_chamber_wall"]["actual_gap_mm"] >= 1.0
    assert params["device"]["envelope_mm"][2] == 12.7
    assert params["battery"]["envelope_mm"][2] == 5.6
    assert params["battery"]["capacity_mah"] == 5727
    optical = report["checks"]["camera_optical_seal_stack"]
    assert optical["pass"]
    assert optical["stray_light_septum_present"]
    assert optical["flash_camera_center_spacing_mm"] >= 6.0
    assert optical["flash_burial_clearance_mm"] >= 0.1
    assert params["components"]["power_button"]["travel_mm"] == 0.2
    assert params["components"]["volume_button"]["travel_mm"] == 0.2
    assert params["components"]["power_button"]["lcsc_part"] == "C318884"
    assert params["components"]["volume_button"]["standardized_mpn_primary"] == "XKB TS-1187A-B-A-B"
    assert report["checks"]["component_presence"]["pass"]
    assert report["checks"]["rounded_enclosure_geometry"]["pass"]
    assert report["checks"]["mesh_integrity"]["pass"]
    assert report["checks"]["usb_c_insertion_envelope"]["pass"]
    assert report["checks"]["usb_c_port_seal_stack"]["pass"]
    assert report["checks"]["bottom_io_acoustic_apertures"]["pass"]
    assert report["checks"]["button_force_and_travel"]["pass"]
    assert report["checks"]["button_pressure_support"]["pass"]
    assert report["checks"]["button_ingress_seal_stack"]["pass"]
    assert report["checks"]["screen_mount_and_connection"]["pass"]
    assert report["checks"]["camera_speaker_behind_glass"]["pass"]
    assert report["checks"]["camera_optical_seal_stack"]["pass"]
    assert report["checks"]["rf_antenna_keepouts"]["pass"]
    assert report["checks"]["shielding_haptics_service"]["pass"]
    assert report["checks"]["injection_molding_basics"]["pass"]
    assert report["checks"]["molded_retention_features"]["pass"]
    assert report["checks"]["mold_runner_gate_model"]["pass"]
    assert report["checks"]["mold_ejector_cooling_model"]["pass"]
    assert report["checks"]["final_assembly_excludes_tooling_markers"]["pass"]
    assert report["checks"]["kicad_outline_integration"]["pass"]
    assert report["checks"]["mass_budget"]["pass"]


def test_evt0_phone_cad_required_parts_are_named() -> None:
    params = cad.load_params()
    names = {part.name for part in cad.build_parts(params)}

    for required in {
        "orange_back_shell",
        "orange_side_frame",
        "screen_cover_glass",
        "main_pcb",
        "battery_back_void_foam_pad",
        "usb_c_receptacle",
        "bottom_speaker_module",
        "earpiece_receiver",
        "rear_camera_module",
        "rear_camera_shell_aperture",
        "orange_rear_camera_bezel_top",
        "orange_rear_camera_bezel_bottom",
        "orange_rear_camera_bezel_left",
        "orange_rear_camera_bezel_right",
        "front_camera_module",
        "rear_camera_cover_adhesive_top",
        "rear_camera_cover_adhesive_bottom",
        "rear_camera_cover_adhesive_left",
        "rear_camera_cover_adhesive_right",
        "rear_camera_light_baffle_top",
        "rear_camera_light_baffle_bottom",
        "rear_flash_camera_septum",
        "front_camera_black_mask_window",
        "power_button_cap",
        "volume_button_cap",
        "power_button_elastomer_gasket",
        "power_button_labyrinth_upper_rail",
        "power_button_labyrinth_lower_rail",
        "volume_button_elastomer_gasket",
        "volume_button_labyrinth_upper_rail",
        "volume_button_labyrinth_lower_rail",
        "handset_acoustic_slot",
        "screen_adhesive_top",
        "screen_adhesive_bottom",
        "display_fpc_connector",
        "orange_usb_reinforcement_saddle",
        "bottom_speaker_acoustic_chamber",
        "earpiece_gasket",
        "handset_acoustic_mesh",
        "usb_c_external_aperture",
        "usb_c_perimeter_gasket_top",
        "usb_c_perimeter_gasket_bottom",
        "usb_c_perimeter_gasket_left",
        "usb_c_perimeter_gasket_right",
        "usb_c_molded_drip_break_lip",
        "usb_c_internal_drain_shelf",
        "bottom_speaker_grille_slot_1",
        "bottom_speaker_dust_mesh",
        "bottom_microphone_port_1",
        "bottom_microphone_mesh_1",
        "bottom_microphone_mesh_2",
        "top_microphone_port",
        "top_microphone_mesh",
        "orange_screw_boss_1",
        "orange_snap_hook_1",
        "cellular_top_antenna_keepout",
        "cellular_bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
        "soc_shield_can",
        "pmic_shield_can",
        "radio_shield_can",
        "split_interconnect_top_connector",
        "split_interconnect_bottom_connector",
        "split_interconnect_side_flex",
        "split_interconnect_top_flex_tail",
        "split_interconnect_bottom_flex_tail",
        "haptic_lra",
        "sim_tray_keepout",
        "sim_tray_outline",
        "rear_camera_cover_glass",
        "service_label_recess",
    }:
        assert required in names


def test_evt0_phone_enclosure_uses_rounded_geometry() -> None:
    params = cad.load_params()
    parts = {part.name: part for part in cad.build_parts(params)}

    assert len(parts["orange_back_shell"].mesh.vertices) >= 96
    assert len(parts["orange_side_frame"].mesh.vertices) >= 192
    assert params["device"]["corner_radius_mm"] > 3 * params["device"]["wall_thickness_mm"]


def test_evt0_phone_tooling_parts_are_named() -> None:
    params = cad.load_params()
    names = {part.name for part in cad.tooling_parts(params)}

    for required in {
        "mold_sprue_bushing",
        "mold_primary_runner",
        "mold_left_submarine_gate",
        "mold_right_submarine_gate",
        "mold_parting_line_reference",
        "screw_core_pin_clearance_1",
        "mold_ejector_pin_1",
        "mold_cooling_channel_1",
    }:
        assert required in names


def test_evt0_phone_params_stay_under_compactness_limit() -> None:
    params = cad.load_params()
    width, height, depth = params["device"]["envelope_mm"]

    assert width <= 80.0
    assert height <= 157.0
    assert depth <= 12.8
    assert Path(cad.PARAMS).is_file()


def test_evt0_phone_compactness_optimization_audits_display_limited_envelope(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    report = cad.write_compactness_optimization_artifacts(params, parts, checks)
    case_ids = {case["id"] for case in report["cases"]}

    assert report["status"] == "cad_compactness_optimized"
    assert {
        "display_driven_width",
        "display_driven_height",
        "flush_back_molded_depth",
        "side_controls_do_not_resize_molded_body",
        "pcb_battery_do_not_drive_outer_envelope",
    }.issubset(case_ids)
    assert report["width_excess_over_bound_mm"] <= 1.0
    assert report["height_excess_over_bound_mm"] <= 1.5
    assert (
        report["lower_bounds"]["display_touch_panel_mm"][0] > params["display"]["ctp_outline_mm"][0]
    )
    assert "shorter display/CTP" in " ".join(report["next_reduction_options"])
    assert (tmp_path / "compactness-optimization.json").is_file()
    assert (tmp_path / "compactness-optimization.md").is_file()
    assert (tmp_path / "compactness-optimization.png").is_file()
    assert (tmp_path / "compactness-optimization.svg").is_file()


def test_evt0_phone_kicad_outline_matches_cad_pcb() -> None:
    params = cad.load_params()
    outline = cad.kicad_outline_mm(cad.ROOT / params["pcb"]["source"])

    assert outline == params["pcb"]["outline_mm"][:2]


def test_evt0_phone_mass_budget_has_physical_margin() -> None:
    params = cad.load_params()
    budget = cad.mass_budget(cad.build_parts(params))

    assert budget["total_estimated_mass_g"] <= params["device"]["target_mass_g"]
    assert budget["mass_by_role_g"]["molded enclosure"] > 0
    assert any(part["excluded_placeholder"] for part in budget["parts"])
    excluded = {part["name"] for part in budget["parts"] if part["excluded_placeholder"]}
    assert "cellular_top_antenna_keepout" in excluded
    assert "service_label_recess" in excluded


def test_evt0_phone_supplier_matrix_covers_mechanical_locks() -> None:
    params = cad.load_params()
    matrix = cad.supplier_matrix(params)
    ids = {item["id"] for item in matrix["items"]}

    assert {
        "display_lcm_ctp",
        "usb_c",
        "side_buttons",
        "cellular_redcap",
        "rear_camera",
        "front_camera",
    }.issubset(ids)
    usb = next(item for item in matrix["items"] if item["id"] == "usb_c")
    assert usb["mechanical_lock"]["mating_cycles"] >= 20000
    assert usb["distributor_url"]


def test_evt0_phone_supplier_rfq_package_maps_step_evidence(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    solid_cad = {
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
        "parts": [
            {"name": name, "step": f"mechanical/e1-phone/out/{name}.step"}
            for name in [
                "screen_cover_glass",
                "display_lcm",
                "display_fpc_connector",
                "screen_adhesive_top",
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "bottom_speaker_module",
                "bottom_speaker_acoustic_chamber",
                "bottom_mic",
                "bottom_microphone_port_1",
                "rear_camera_module",
                "rear_camera_cover_glass",
                "rear_camera_lens_window",
                "front_camera_module",
                "front_camera_under_glass",
                "power_button_cap",
                "volume_button_cap",
                "haptic_lra",
                "sim_tray_keepout",
                "sim_tray_outline",
                "split_interconnect_top_connector",
                "split_interconnect_bottom_connector",
                "split_interconnect_side_flex",
                "split_interconnect_top_flex_tail",
                "split_interconnect_bottom_flex_tail",
                "orange_back_shell",
                "orange_side_frame",
                "orange_screw_boss_1",
                "orange_snap_hook_1",
                "orange_usb_reinforcement_saddle",
            ]
        ],
    }

    rfq = cad.write_supplier_rfq_artifacts(params, supplier, solid_cad)
    package_ids = {package["id"] for package in rfq["packages"]}

    assert rfq["status"] == "rfq_ready"
    assert {
        "display_touch_stack",
        "usb_c_and_bottom_audio",
        "camera_stack",
        "buttons_haptics_service",
        "orange_enclosure_tooling",
    }.issubset(package_ids)
    assert all(package["attached_steps"] for package in rfq["packages"])
    assert any("toolmaker" in item for item in rfq["packages"][-1]["acceptance_criteria"])
    assert (tmp_path / "supplier-rfq-package.json").is_file()
    assert (tmp_path / "supplier-rfq-package.md").is_file()


def test_evt0_phone_supplier_response_review_fails_closed_until_vendor_returns(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    supplier_rfq = {
        "status": "rfq_ready",
        "packages": [
            {"id": "display_touch_stack", "supplier_item_ids": ["display_lcm_ctp"]},
            {"id": "usb_c_and_bottom_audio", "supplier_item_ids": ["usb_c"]},
            {"id": "camera_stack", "supplier_item_ids": ["rear_camera", "front_camera"]},
            {"id": "buttons_haptics_service", "supplier_item_ids": ["side_buttons"]},
            {"id": "orange_enclosure_tooling", "supplier_item_ids": []},
        ],
    }

    review = cad.write_supplier_response_artifacts(supplier, supplier_rfq)
    csv_text = (tmp_path / "supplier-response-template.csv").read_text()

    assert review["status"] == "blocked_no_supplier_responses"
    assert review["expected_response_count"] == len(supplier["items"]) + 1
    assert review["required_evidence_class"] == "physical_supplier_response"
    assert review["complete_response_count"] == 0
    assert "display_lcm_ctp" in review["missing_or_incomplete_items"]
    assert "orange_enclosure_tooling" in review["missing_or_incomplete_items"]
    assert "supplier_item_id,rfq_package_id,candidate,supplier_listing_or_portal_url" in csv_text
    assert "moq_units" in csv_text
    assert "mechanical_envelope_mm" in csv_text
    assert "pinout_or_process_artifact" in csv_text
    assert "evidence_class,required_evidence_artifacts" in csv_text
    assert "quote_artifact;drawing_2d_artifact;step_artifact;pinout_or_process_artifact" in csv_text
    assert "evidence_class=physical_supplier_response" in review["release_rule"]
    assert "MOQ <= 50" in review["release_rule"]
    assert review["cases"][0]["required_evidence_artifacts"]
    assert review["cases"][0]["quote_artifact_present"] is False
    assert review["cases"][0]["commercial_terms_pass"] is False
    assert review["cases"][0]["mechanical_traceability_pass"] is False
    assert (tmp_path / "supplier-response-review.json").is_file()
    assert (tmp_path / "supplier-response-review.md").is_file()


def test_evt0_phone_supplier_response_rejects_simulated_returns(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    supplier_rfq = {
        "status": "rfq_ready",
        "packages": [
            {"id": "display_touch_stack", "supplier_item_ids": ["display_lcm_ctp"]},
            {"id": "usb_c_and_bottom_audio", "supplier_item_ids": ["usb_c"]},
            {"id": "camera_stack", "supplier_item_ids": ["rear_camera", "front_camera"]},
            {"id": "buttons_haptics_service", "supplier_item_ids": ["side_buttons"]},
            {"id": "orange_enclosure_tooling", "supplier_item_ids": []},
        ],
    }

    cad.write_supplier_response_artifacts(supplier, supplier_rfq)
    template_text = (tmp_path / "supplier-response-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "vendor_name": "simulated vendor",
                "vendor_part_number": "SIM-PN",
                "supplier_listing_or_portal_url": "https://example.invalid/simulated",
                "moq_units": "10",
                "quote_returned": "yes",
                "quote_artifact": "simulated-quote.pdf",
                "drawing_2d_received": "yes",
                "drawing_2d_artifact": "simulated-drawing.pdf",
                "step_received": "yes",
                "step_artifact": "simulated-step.step",
                "mechanical_envelope_mm": "10 x 5 x 2",
                "pinout_or_process_artifact": "simulated-pinout.pdf",
                "footprint_or_tooling_artifact": "simulated-footprint.pdf",
                "sample_ordered": "yes",
                "sample_received": "yes",
                "sample_photo_or_inspection_artifact": "simulated-sample.png",
                "supplier_traceability_record": "simulated-trace.txt",
                "lead_time_days": "7",
                "unit_price_20": "1.23",
                "reviewer": "simulation",
                "evidence_class": "simulated_supplier_response_for_planning_not_release",
            }
        )
    with (tmp_path / "supplier-response-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_supplier_response_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_supplier_response_artifacts(supplier, supplier_rfq)

    assert review["status"] == "blocked_no_supplier_responses"
    assert (
        review["template_evidence_class"]
        == "simulated_supplier_response_for_planning_not_release"
    )
    assert review["complete_response_count"] == 0
    assert "display_lcm_ctp" in review["missing_or_incomplete_items"]
    assert review["cases"][0]["evidence_class_allowed"] is False
    assert review["cases"][0]["physical_evidence_pass"] is False
    assert review["cases"][0]["commercial_terms_pass"] is True
    assert review["cases"][0]["mechanical_traceability_pass"] is True


def test_evt0_phone_supplier_response_requires_low_moq_and_mechanical_traceability(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    supplier_rfq = {
        "status": "rfq_ready",
        "packages": [
            {"id": "display_touch_stack", "supplier_item_ids": ["display_lcm_ctp"]},
            {"id": "usb_c_and_bottom_audio", "supplier_item_ids": ["usb_c"]},
            {"id": "camera_stack", "supplier_item_ids": ["rear_camera", "front_camera"]},
            {"id": "buttons_haptics_service", "supplier_item_ids": ["side_buttons"]},
            {"id": "orange_enclosure_tooling", "supplier_item_ids": []},
        ],
    }
    cad.write_supplier_response_artifacts(supplier, supplier_rfq)
    template_text = (tmp_path / "supplier-response-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "supplier_listing_or_portal_url": row["supplier_listing_or_portal_url"]
                or "https://example.invalid/supplier-portal",
                "vendor_name": "physical vendor",
                "vendor_part_number": f"{row['supplier_item_id']}-PN",
                "moq_units": "100",
                "quote_returned": "yes",
                "quote_artifact": "quote.pdf",
                "drawing_2d_received": "yes",
                "drawing_2d_artifact": "drawing.pdf",
                "step_received": "yes",
                "step_artifact": "model.step",
                "mechanical_envelope_mm": "",
                "pinout_or_process_artifact": "pinout-or-process.pdf",
                "footprint_or_tooling_artifact": "footprint-or-tooling.pdf",
                "sample_ordered": "yes",
                "sample_received": "yes",
                "sample_photo_or_inspection_artifact": "sample.png",
                "supplier_traceability_record": "traceability.yaml",
                "lead_time_days": "21",
                "unit_price_20": "12.50",
                "reviewer": "supplier-reviewer",
                "evidence_class": "physical_supplier_response",
            }
        )
    with (tmp_path / "supplier-response-template.csv").open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_supplier_response_artifacts(supplier, supplier_rfq)

    assert review["status"] == "blocked_no_supplier_responses"
    assert review["cases"][0]["physical_evidence_pass"] is True
    assert review["cases"][0]["commercial_terms_pass"] is False
    assert review["cases"][0]["mechanical_traceability_pass"] is False

    for row in rows:
        row["moq_units"] = "20"
        row["mechanical_envelope_mm"] = "12.0 x 8.0 x 3.0"
    with (tmp_path / "supplier-response-template.csv").open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_supplier_response_artifacts(supplier, supplier_rfq)

    assert review["status"] == "supplier_responses_complete"
    assert review["complete_response_count"] == review["expected_response_count"]
    assert review["cases"][0]["moq_units"] == 20
    assert review["cases"][0]["mechanical_envelope_mm"] == [12.0, 8.0, 3.0]


def test_evt0_phone_supplier_evidence_acceptance_fails_closed_by_family(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    supplier_rfq = {
        "status": "rfq_ready",
        "packages": [
            {"id": "display_touch_stack", "supplier_item_ids": ["display_lcm_ctp"]},
            {"id": "usb_c_and_bottom_audio", "supplier_item_ids": ["usb_c"]},
            {"id": "camera_stack", "supplier_item_ids": ["rear_camera", "front_camera"]},
            {"id": "buttons_haptics_service", "supplier_item_ids": ["side_buttons"]},
            {"id": "orange_enclosure_tooling", "supplier_item_ids": []},
        ],
    }
    supplier_response = cad.write_supplier_response_artifacts(supplier, supplier_rfq)

    report = cad.write_supplier_evidence_acceptance_artifacts(
        supplier,
        supplier_rfq,
        supplier_response,
    )

    assert report["status"] == "blocked_no_supplier_evidence"
    assert report["source_status"]["supplier_rfq_status"] == "rfq_ready"
    assert report["source_status"]["supplier_response_status"] == (
        "blocked_no_supplier_responses"
    )
    assert report["expected_family_count"] == 6
    assert report["complete_family_count"] == 0
    assert "display_touch_stack" in report["missing_or_incomplete_families"]
    assert "wireless_modules" in report["missing_or_incomplete_families"]
    display = next(
        family for family in report["families"] if family["id"] == "display_touch_stack"
    )
    assert display["rfq_package_ready"] is True
    assert "step_model" in display["missing_required_evidence_keys"]
    assert display["items"][0]["response_case_present"] is True
    assert display["items"][0]["response_pass"] is False
    wireless = next(family for family in report["families"] if family["id"] == "wireless_modules")
    assert wireless["rfq_package_ready"] is True
    assert {"cellular_redcap", "wifi_bt"}.issubset(wireless["missing_supplier_items"])
    assert "supplier-returned quote" in report["claim_boundary"]
    assert "physical_supplier_response rows" in report["release_rule"]
    assert (tmp_path / "supplier-evidence-acceptance.json").is_file()
    assert (tmp_path / "supplier-evidence-acceptance.md").is_file()


def test_evt0_phone_end_to_end_objective_acceptance_joins_board_and_mechanical_gates(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    (tmp_path / "physical-process-validation-acceptance.json").write_text(
        json.dumps({"status": "blocked_no_physical_process_validation_results"})
    )
    (tmp_path / "cmf-release-acceptance.json").write_text(
        json.dumps({"status": "blocked_no_cmf_results"})
    )
    (tmp_path / "mold-flow-acceptance.json").write_text(
        json.dumps({"status": "mold_flow_results_pass"})
    )
    manufacturing_readiness = {
        "overall_status": "cad_package_pass",
        "manufacturing_release_ready": False,
    }
    board_step = {"status": "blocked_concept_pcb_no_routed_step"}
    routed_board_clearance = {"status": "blocked_waiting_for_routed_board_step"}
    supplier_evidence = {"status": "blocked_no_supplier_evidence"}
    full_cad_boolean = {"status": "blocked_boolean_interference_incomplete"}
    visual_review_coverage = {
        "status": "visual_review_coverage_acceptance_pass",
        "production_visual_signoff_ready": False,
    }
    toolmaker_signoff = {"status": "blocked_no_toolmaker_signoff"}

    report = cad.write_end_to_end_objective_acceptance_artifacts(
        manufacturing_readiness,
        board_step,
        routed_board_clearance,
        supplier_evidence,
        full_cad_boolean,
        visual_review_coverage,
        toolmaker_signoff,
    )

    assert report["status"] == "blocked_not_end_to_end_ready"
    assert report["board_end_to_end_source_present"] is True
    assert report["expected_board_objective_count"] >= 9
    assert report["complete_board_objective_count"] == 0
    assert report["expected_mechanical_gate_count"] == 8
    assert report["complete_mechanical_gate_count"] == 0
    assert "board:schematic_and_pcb_routed_release" in report["missing_or_incomplete_items"]
    assert "mechanical:supplier_family_lock" in report["missing_or_incomplete_items"]
    assert "mechanical:manufacturing_release_readiness" in report["missing_or_incomplete_items"]
    visual_case = next(
        case
        for case in report["mechanical_cases"]
        if case["id"] == "automated_visual_and_manual_cmf_signoff"
    )
    assert visual_case["pass"] is False
    assert "manufacturing_release_ready must be true" in report["release_rule"]
    assert (tmp_path / "end-to-end-objective-acceptance.json").is_file()
    assert (tmp_path / "end-to-end-objective-acceptance.md").is_file()


def test_evt0_phone_physical_process_validation_acceptance_aggregates_result_gates(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    gate_files = {
        "display-results-review.json": "blocked_no_display_results",
        "acoustic-results-review.json": "blocked_no_acoustic_results",
        "camera-results-review.json": "blocked_no_camera_results",
        "environmental-results-review.json": "blocked_no_environmental_results",
        "evt-results-review.json": "blocked_no_physical_results",
        "fixture-calibration-acceptance.json": "blocked_no_fixture_calibration_results",
        "mechanical-lifecycle-acceptance.json": "blocked_no_lifecycle_results",
        "gdt-fai-results-review.json": "blocked_no_fai_results",
        "unit-traceability-acceptance.json": "blocked_no_unit_traceability_results",
        "assembly-build-traveler.json": "blocked_no_assembly_build_results",
        "process-control-plan.json": "blocked_no_process_control_results",
    }
    template_files = [
        "display-results-template.csv",
        "acoustic-results-template.csv",
        "camera-results-template.csv",
        "environmental-results-template.csv",
        "evt-inspection-results-template.csv",
        "fixture-calibration-results-template.csv",
        "mechanical-lifecycle-results-template.csv",
        "gdt-fai-template.csv",
        "unit-traceability-results-template.csv",
        "assembly-build-results-template.csv",
        "process-control-results-template.csv",
    ]
    for name, status in gate_files.items():
        (tmp_path / name).write_text(
            json.dumps(
                {
                    "status": status,
                    "complete_result_count": 0,
                    "expected_measurement_count": 3,
                }
            )
        )
    for name in template_files:
        (tmp_path / name).write_text("sample_id,result\n")

    report = cad.write_physical_process_validation_acceptance_artifacts()

    assert report["status"] == "blocked_no_physical_process_validation_results"
    assert report["expected_gate_count"] == 11
    assert report["complete_gate_count"] == 0
    assert "display_touch_lab_results" in report["missing_or_incomplete_gates"]
    display = next(case for case in report["cases"] if case["id"] == "display_touch_lab_results")
    assert display["template_present"] is True
    assert display["review_present"] is True
    assert display["status"] == "blocked_no_display_results"
    assert display["pass"] is False
    assert "process-control results must all be populated" in report["release_rule"]
    assert (tmp_path / "physical-process-validation-acceptance.json").is_file()
    assert (tmp_path / "physical-process-validation-acceptance.md").is_file()


def test_evt0_phone_assembly_build_traveler_requires_physical_records(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    report = cad.write_assembly_build_traveler_artifacts(params, parts)

    assert report["status"] == "blocked_no_assembly_build_results"
    assert report["expected_step_count"] == 7
    assert report["cad_prerequisite_step_count"] == 7
    assert report["complete_result_count"] == 0
    assert report["required_evidence_class"] == "physical_assembly_build_record"
    assert "raw data" in report["release_rule"]
    csv_text = (tmp_path / "assembly-build-results-template.csv").read_text()
    assert "evidence_class" in csv_text
    assert "raw_data_artifact" in csv_text
    assert "lot_traceability_record" in csv_text

    with (tmp_path / "assembly-build-results-template.csv").open(newline="") as csv_file:
        rows = list(csv.DictReader(csv_file))
        fieldnames = list(rows[0].keys())
    for row in rows:
        row.update(
            {
                "build_id": "EVT0-BUILD-001",
                "unit_serial": f"E1-EVT0-{row['step_id']}",
                "operator": "first_article_operator",
                "measured_or_observed_result": "all required station outputs pass",
                "pass": "yes",
                "evidence_class": "physical_assembly_build_record",
                "raw_data_artifact": f"build/{row['step_id']}.csv",
                "photo_or_log_artifact": f"build/{row['step_id']}.jpg",
                "lot_traceability_record": f"lots/{row['step_id']}.yaml",
            }
        )
    with (tmp_path / "assembly-build-results-template.csv").open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    passing = cad.write_assembly_build_traveler_artifacts(params, parts)

    assert passing["status"] == "assembly_build_results_pass"
    assert passing["complete_result_count"] == passing["expected_step_count"]
    assert not passing["missing_or_incomplete_steps"]


def test_evt0_phone_process_control_plan_requires_factory_records(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    assembly = cad.write_assembly_build_traveler_artifacts(params, parts)
    supplier_response = {"status": "blocked_no_supplier_responses"}
    gdt_release = {"status": "gdt_release_package_ready"}

    report = cad.write_process_control_plan_artifacts(
        assembly,
        supplier_response,
        gdt_release,
    )

    assert report["status"] == "blocked_no_process_control_results"
    assert report["expected_control_count"] == 7
    assert report["cad_prerequisite_control_count"] == 7
    assert report["complete_result_count"] == 0
    assert report["required_evidence_class"] == "physical_process_control_record"
    assert "gauge ID" in report["release_rule"]
    csv_text = (tmp_path / "process-control-results-template.csv").read_text()
    assert "evidence_class" in csv_text
    assert "gauge_id" in csv_text
    assert "lot_traceability_record" in csv_text

    with (tmp_path / "process-control-results-template.csv").open(newline="") as csv_file:
        rows = list(csv.DictReader(csv_file))
        fieldnames = list(rows[0].keys())
    for row in rows:
        row.update(
            {
                "build_id": "EVT0-BUILD-001",
                "operator": "line_quality_operator",
                "gauge_id": f"GAUGE-{row['control_id']}",
                "measured_or_observed_result": "control outputs in limit",
                "pass": "yes",
                "evidence_class": "physical_process_control_record",
                "raw_data_artifact": f"process/{row['control_id']}.csv",
                "photo_or_log_artifact": f"process/{row['control_id']}.jpg",
                "lot_traceability_record": f"lots/{row['control_id']}.yaml",
            }
        )
    with (tmp_path / "process-control-results-template.csv").open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    passing = cad.write_process_control_plan_artifacts(
        assembly,
        supplier_response,
        gdt_release,
    )

    assert passing["status"] == "process_control_results_pass"
    assert passing["complete_result_count"] == passing["expected_control_count"]
    assert not passing["missing_or_incomplete_controls"]


@pytest.mark.skipif(not _cadquery_available, reason="cadquery not installed")
def test_evt0_phone_step_validation_reimports_step_files(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "OUT_DIR", tmp_path / "out")
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path / "review")
    cad.OUT_DIR.mkdir()
    cad.REVIEW_DIR.mkdir()

    solid_cad = cad.write_solid_cad_handoff_artifacts(params, checks)
    side_frame_cutouts = solid_cad["side_frame_external_cutouts"]
    assert side_frame_cutouts["status"] == "pass"
    assert side_frame_cutouts["cutout_count"] == 11
    assert side_frame_cutouts["removed_volume_mm3"] > 0
    assert {
        "usb_c_side_frame_cutout",
        "bottom_speaker_side_frame_cutout_1",
        "bottom_microphone_side_frame_cutout_1",
        "top_microphone_side_frame_cutout",
        "power_button_side_frame_cutout",
        "volume_button_side_frame_cutout",
    }.issubset({cutout["name"] for cutout in side_frame_cutouts["cutouts"]})
    validation = cad.write_step_validation_artifacts(solid_cad)

    assert validation["status"] == "pass"
    assert validation["validated_count"] == solid_cad["part_count"]
    assert validation["assembly"]["imported"]
    assert all(case["imported"] for case in validation["cases"])
    assert (
        max(case["max_span_error_mm"] for case in validation["cases"]) <= validation["tolerance_mm"]
    )
    assert (cad.REVIEW_DIR / "step-validation.json").is_file()
    assert (cad.REVIEW_DIR / "step-validation.md").is_file()


def test_evt0_phone_kicad_handoff_includes_mechanical_constraints(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    handoff = cad.write_kicad_mechanical_handoff(params, checks)
    reconciliation = cad.write_kicad_placement_reconciliation_artifacts(params, parts, handoff)
    constraint_ids = {item["id"] for item in handoff["constraints"]}
    footprint_ids = {item["id"] for item in reconciliation["footprint_cases"]}
    cad_projection_ids = {item["id"] for item in reconciliation["cad_projection_cases"]}

    assert "display_fpc_zone" in constraint_ids
    assert "usb_c_mechanical_capture" in constraint_ids
    assert "battery_window" in constraint_ids
    assert "mechanical_overlay" in constraint_ids
    assert reconciliation["status"] == "cad_kicad_placement_reconciled"
    assert {"J_USB_C", "J_DISPLAY_TOUCH", "J_CAM0_CAM1", "U_AUDIO_SPK_MIC"}.issubset(footprint_ids)
    assert {"J_USB_C", "SW_POWER_VOL", "J_BATTERY", "U_AUDIO_SPK_MIC"}.issubset(cad_projection_ids)
    assert all(item["pass"] for item in reconciliation["footprint_cases"])
    assert all(item["pass"] for item in reconciliation["cad_projection_cases"])
    assert (tmp_path / "kicad-mechanical-handoff.json").is_file()
    assert (tmp_path / "kicad-placement-reconciliation.json").is_file()
    assert (tmp_path / "kicad-placement-reconciliation.md").is_file()


def test_evt0_phone_engineering_validation_plan_tracks_evt_risks(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    mass = cad.mass_budget(parts)
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    validation = cad.write_engineering_validation_artifacts(params, parts, checks, mass, supplier)
    tolerance_ids = {item["id"] for item in validation["tolerance_cases"]}
    domains = {item["domain"] for item in validation["domain_reviews"]}

    assert validation["status"] == "cad_validation_inputs_ready"
    assert {"screen_xy_fit", "usb_shell_to_aperture", "battery_to_pcb"}.issubset(tolerance_ids)
    assert {"thermal", "rf", "acoustic", "drop", "ingress"}.issubset(domains)
    assert len(validation["assembly_sequence"]) >= 5
    assert any(item["test"] == "USB-C insertion/removal" for item in validation["dvt_plan"])
    assert (tmp_path / "engineering-validation.json").is_file()
    assert (tmp_path / "engineering-validation.md").is_file()


def test_evt0_phone_battery_swell_management_models_back_void_foam(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    report = cad.write_battery_swell_management_artifacts(
        params,
        parts,
        checks,
        clearance,
    )

    assert report["status"] == "cad_battery_swell_management_ready"
    assert report["foam_pad"]["part"] == "battery_back_void_foam_pad"
    assert report["foam_pad"]["compression_allowance_mm"] >= 0.142
    assert report["foam_pad"]["free_gap_to_pouch_mm"] >= 0.25
    assert report["worst_case_arithmetic"]["margin_mm"] >= 0.0
    assert report["checks"]["battery_back_void_foam_management"]["pass"]
    assert (tmp_path / "battery-swell-management.json").is_file()
    assert (tmp_path / "battery-swell-management.md").is_file()


def test_evt0_phone_interface_validation_tracks_named_mechanical_interfaces(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    report = cad.write_interface_validation_artifacts(
        params,
        parts,
        checks,
        clearance,
        tolerance_stack,
    )
    case_ids = {item["id"] for item in report["interfaces"]}
    interfaces = {item["interface"] for item in report["interfaces"]}

    assert report["status"] == "cad_interface_validation_pass"
    usb_case = next(
        item for item in report["interfaces"] if item["id"] == "usb_c_insertion_capture"
    )
    assert usb_case["pass"]
    assert "usb_c_port_seal_stack" in usb_case["evidence"]
    assert {
        "power_button_force_travel_pressure",
        "volume_button_force_travel_pressure",
        "usb_c_insertion_capture",
        "screen_bond_and_fpc_connection",
        "camera_glass_and_under_glass_strategy",
        "bottom_audio_port_alignment",
        "handset_receiver_gasket_stack",
    }.issubset(case_ids)
    assert {"button", "usb_c", "screen", "camera", "acoustic"}.issubset(interfaces)
    assert all(item["pass"] for item in report["interfaces"])
    assert any("USB-C insertion" in item for item in report["physical_validation_required"])
    assert (tmp_path / "interface-validation.json").is_file()
    assert (tmp_path / "interface-validation.md").is_file()


def test_evt0_phone_display_validation_quantifies_bond_fpc_and_lab_template(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    display = cad.write_display_validation_artifacts(
        params, parts, clearance, interface_validation, tolerance_stack
    )
    review = cad.write_display_results_review_artifacts(display)
    case_ids = {item["id"] for item in display["cases"]}
    measurement_ids = {item["measurement_id"] for item in display["measurements"]}
    csv_text = (tmp_path / "display-results-template.csv").read_text()

    assert display["status"] == "cad_display_validation_ready"
    assert {
        "display_module_envelope_fit",
        "tft_under_cover_glass",
        "adhesive_bond_geometry",
        "display_fpc_bend_and_connector",
        "screen_interface_validation",
    }.issubset(case_ids)
    assert {
        "display_bond_peel_n_per_mm",
        "screen_adhesive_compression_mm",
        "display_fpc_bend_radius_mm",
        "display_luminance_cd_m2",
        "touch_grid_dead_zones",
        "display_dsi_bringup_logs",
    }.issubset(measurement_ids)
    assert (
        "sample_id,measurement_id,unit,min,max,measured_value,pass,operator,evidence_class,required_evidence_artifacts,raw_data_artifact,fixture_calibration_certificate,photo_or_log_artifact,lot_traceability_record,notes"
        in csv_text
    )
    peel = next(
        item
        for item in display["measurements"]
        if item["measurement_id"] == "display_bond_peel_n_per_mm"
    )
    assert "display_peel_force_raw_csv" in peel["required_evidence_artifacts"]
    fpc = next(
        item
        for item in display["measurements"]
        if item["measurement_id"] == "display_fpc_bend_radius_mm"
    )
    assert "mated_fpc_bend_photo" in fpc["required_evidence_artifacts"]
    assert "display_peel_force_raw_csv;peel_fixture_calibration_certificate" in csv_text
    assert review["status"] == "blocked_no_display_results"
    assert review["complete_result_count"] == 0
    assert review["required_evidence_class"] == "physical_display_result"
    assert "display_bond_peel_n_per_mm" in review["blank_or_incomplete_measurements"]
    first_case = review["cases"][0]
    assert "display_peel_force_raw_csv" in first_case["required_evidence_artifacts"]
    assert first_case["raw_data_artifact_present"] is False
    assert "evidence_class=physical_display_result" in review["release_rule"]
    assert (tmp_path / "display-validation.json").is_file()
    assert (tmp_path / "display-validation.md").is_file()
    assert (tmp_path / "display-results-review.json").is_file()
    assert (tmp_path / "display-results-review.md").is_file()


def test_evt0_phone_mechanical_integration_sim_covers_usb_screen_and_buttons(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    display = cad.write_display_validation_artifacts(
        params, parts, clearance, interface_validation, tolerance_stack
    )
    sim = cad.write_mechanical_integration_sim_artifacts(
        params, parts, interface_validation, display
    )
    cases = {case["id"]: case for case in sim["cases"]}

    assert sim["status"] == "cad_mechanical_integration_sim_ready"
    assert sim["evidence_class"] == "deterministic_cad_simulation_not_physical_result"
    assert {
        "usb_c_insertion_load_planning",
        "screen_bond_clamp_and_fpc_planning",
        "side_button_force_pressure_planning",
    }.issubset(cases)
    assert cases["usb_c_insertion_load_planning"]["planning_pass"]
    assert (
        cases["usb_c_insertion_load_planning"]["actual"]["predicted_peak_insertion_force_n"]
        <= 35.0
    )
    assert cases["screen_bond_clamp_and_fpc_planning"]["planning_pass"]
    assert cases["screen_bond_clamp_and_fpc_planning"]["actual"]["compression_mm"] == 0.045
    assert cases["side_button_force_pressure_planning"]["planning_pass"]
    assert "physical USB insertion/cycle data" in sim["release_rule"]
    assert (tmp_path / "mechanical-integration-sim.json").is_file()
    assert (tmp_path / "mechanical-integration-sim.md").is_file()


def test_evt0_phone_display_results_reject_simulated_rows(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    display = cad.write_display_validation_artifacts(
        params, parts, clearance, interface_validation, tolerance_stack
    )
    csv_path = tmp_path / "display-results-template.csv"
    rows = list(csv.DictReader(StringIO(csv_path.read_text())))
    for row in rows:
        row["sample_id"] = "SIM-DISPLAY-1"
        row["measured_value"] = row["min"] or "1"
        if row["max"] and row["min"] == row["max"]:
            row["measured_value"] = row["min"]
        row["pass"] = "true"
        row["operator"] = "simulated display operator"
        row["raw_data_artifact"] = "simulated-display.csv"
        row["fixture_calibration_certificate"] = "simulated-display-cert.pdf"
        row["photo_or_log_artifact"] = "simulated-display-photo.png"
        row["lot_traceability_record"] = "simulated-display-lot.yaml"
    output = StringIO()
    writer = csv.DictWriter(output, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    csv_path.write_text(
        "# evidence_class: simulated_display_result_for_planning_not_release\n"
        + output.getvalue()
    )

    review = cad.write_display_results_review_artifacts(display)

    assert review["status"] == "blocked_no_display_results"
    assert (
        review["template_evidence_class"]
        == "simulated_display_result_for_planning_not_release"
    )
    assert "display_bond_peel_n_per_mm" in review["failed_measurements"]
    assert review["cases"][0]["evidence_class_allowed"] is False


def test_evt0_phone_acoustic_validation_quantifies_ports_and_lab_template(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    acoustic = cad.write_acoustic_validation_artifacts(
        params, parts, clearance, interface_validation
    )
    review = cad.write_acoustic_results_review_artifacts(acoustic)
    case_ids = {item["id"] for item in acoustic["cases"]}
    measurement_ids = {item["measurement_id"] for item in acoustic["measurements"]}
    csv_text = (tmp_path / "acoustic-results-template.csv").read_text()

    assert acoustic["status"] == "cad_acoustic_validation_ready"
    assert {
        "bottom_speaker_open_area",
        "bottom_speaker_rear_chamber",
        "bottom_microphone_porting",
        "acoustic_mesh_membranes",
        "usb_speaker_isolation",
        "earpiece_under_glass_path",
        "interface_acoustic_cases_pass",
    }.issubset(case_ids)
    assert {
        "bottom_speaker_spl_1khz_db",
        "bottom_mic_snr_db",
        "earpiece_spl_1khz_db",
        "earpiece_leak_delta_db",
    }.issubset(measurement_ids)
    assert (
        "sample_id,measurement_id,unit,min,max,measured_value,pass,operator,evidence_class,required_evidence_artifacts,raw_data_artifact,fixture_calibration_certificate,photo_or_log_artifact,lot_traceability_record,notes"
        in csv_text
    )
    assert "speaker_spl_raw_sweep_csv" in csv_text
    assert review["status"] == "blocked_no_acoustic_results"
    assert review["required_evidence_class"] == "physical_acoustic_result"
    assert review["complete_result_count"] == 0
    assert "bottom_speaker_spl_1khz_db" in review["blank_or_incomplete_measurements"]
    assert "evidence_class=physical_acoustic_result" in review["release_rule"]
    assert review["cases"][0]["required_evidence_artifacts"]
    assert review["cases"][0]["raw_data_artifact_present"] is False
    assert (tmp_path / "acoustic-validation.json").is_file()
    assert (tmp_path / "acoustic-validation.md").is_file()
    assert (tmp_path / "acoustic-results-review.json").is_file()
    assert (tmp_path / "acoustic-results-review.md").is_file()


def test_evt0_phone_acoustic_results_reject_simulated_rows(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    acoustic = cad.write_acoustic_validation_artifacts(
        params, parts, clearance, interface_validation
    )
    template_text = (tmp_path / "acoustic-results-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "sample_id": "SIM-001",
                "measured_value": row["min"] or row["max"],
                "pass": "pass",
                "operator": "simulation",
                "evidence_class": "simulated_acoustic_result_for_planning_not_release",
                "raw_data_artifact": "simulated-audio.csv",
                "fixture_calibration_certificate": "simulated-cal.pdf",
                "photo_or_log_artifact": "simulated-audio.log",
                "lot_traceability_record": "simulated-lot.txt",
            }
        )
    with (tmp_path / "acoustic-results-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_acoustic_result_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_acoustic_results_review_artifacts(acoustic)

    assert review["status"] == "blocked_no_acoustic_results"
    assert (
        review["template_evidence_class"]
        == "simulated_acoustic_result_for_planning_not_release"
    )
    assert review["complete_result_count"] == 0
    assert "bottom_speaker_spl_1khz_db" in review["failed_measurements"]
    assert review["cases"][0]["evidence_class_allowed"] is False


def test_evt0_phone_camera_validation_quantifies_optical_stack_and_lab_template(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    camera = cad.write_camera_validation_artifacts(params, parts, clearance, interface_validation)
    review = cad.write_camera_results_review_artifacts(camera)
    case_ids = {item["id"] for item in camera["cases"]}
    measurement_ids = {item["measurement_id"] for item in camera["measurements"]}
    csv_text = (tmp_path / "camera-results-template.csv").read_text()

    assert camera["status"] == "cad_camera_validation_ready"
    assert {
        "rear_camera_cover_window_margin",
        "rear_camera_back_shell_aperture",
        "rear_camera_z_stack",
        "front_under_glass_margin",
        "front_camera_earpiece_clearance",
        "camera_interface_strategy",
    }.issubset(case_ids)
    strategy = next(item for item in camera["cases"] if item["id"] == "camera_interface_strategy")
    assert strategy["actual"]["rear_cover_adhesive_count"] >= 4
    assert strategy["actual"]["rear_light_baffle_count"] >= 2
    assert strategy["actual"]["front_black_mask_present"]
    assert {
        "rear_camera_lens_center_error_mm",
        "front_camera_under_glass_center_error_mm",
        "rear_camera_focus_mtf50_lp_per_mm",
        "front_cover_glass_color_delta_e",
        "camera_streaming_bringup_logs",
    }.issubset(measurement_ids)
    assert (
        "sample_id,measurement_id,unit,min,max,measured_value,pass,operator,evidence_class,required_evidence_artifacts,raw_data_artifact,fixture_calibration_certificate,photo_or_log_artifact,lot_traceability_record,notes"
        in csv_text
    )
    assert "rear_camera_alignment_raw_csv" in csv_text
    assert review["status"] == "blocked_no_camera_results"
    assert review["required_evidence_class"] == "physical_camera_result"
    assert review["complete_result_count"] == 0
    assert "rear_camera_lens_center_error_mm" in review["blank_or_incomplete_measurements"]
    assert "evidence_class=physical_camera_result" in review["release_rule"]
    assert review["cases"][0]["required_evidence_artifacts"]
    assert review["cases"][0]["raw_data_artifact_present"] is False
    assert (tmp_path / "camera-validation.json").is_file()
    assert (tmp_path / "camera-validation.md").is_file()
    assert (tmp_path / "camera-results-review.json").is_file()
    assert (tmp_path / "camera-results-review.md").is_file()


def test_evt0_phone_camera_results_reject_simulated_rows(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    camera = cad.write_camera_validation_artifacts(params, parts, clearance, interface_validation)
    template_text = (tmp_path / "camera-results-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "sample_id": "SIM-001",
                "measured_value": row["min"] or row["max"],
                "pass": "pass",
                "operator": "simulation",
                "evidence_class": "simulated_camera_result_for_planning_not_release",
                "raw_data_artifact": "simulated-camera.csv",
                "fixture_calibration_certificate": "simulated-cal.pdf",
                "photo_or_log_artifact": "simulated-camera.log",
                "lot_traceability_record": "simulated-lot.txt",
            }
        )
    with (tmp_path / "camera-results-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_camera_result_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_camera_results_review_artifacts(camera)

    assert review["status"] == "blocked_no_camera_results"
    assert review["template_evidence_class"] == "simulated_camera_result_for_planning_not_release"
    assert review["complete_result_count"] == 0
    assert "rear_camera_lens_center_error_mm" in review["failed_measurements"]
    assert review["cases"][0]["evidence_class_allowed"] is False


def test_evt0_phone_environmental_validation_covers_thermal_rf_drop_ingress(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    mass = cad.mass_budget(parts)
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    validation = cad.write_engineering_validation_artifacts(params, parts, checks, mass, supplier)
    environmental = cad.write_environmental_validation_artifacts(
        params, parts, checks, clearance, validation
    )
    ingress = cad.write_ingress_path_review_artifacts(params, parts, environmental)
    review = cad.write_environmental_results_review_artifacts(environmental)
    case_ids = {item["id"] for item in environmental["cases"]}
    domains = {item["domain"] for item in environmental["cases"]}
    measurement_ids = {item["measurement_id"] for item in environmental["measurements"]}
    csv_text = (tmp_path / "environmental-results-template.csv").read_text()

    assert environmental["status"] == "cad_environmental_validation_ready"
    assert {
        "thermal_spreader_and_skin_temp_plan",
        "rf_keepout_and_prescan_plan",
        "drop_retention_and_corner_energy_plan",
        "ingress_path_and_gasket_plan",
    }.issubset(case_ids)
    assert {"thermal", "rf", "drop", "ingress"}.issubset(domains)
    assert {
        "max_skin_temp_video_call_c",
        "cellular_desense_delta_db",
        "wifi_bt_desense_delta_db",
        "sar_prescan_w_per_kg_1g",
        "drop_1m_functional_failures",
        "ip54_dust_ingress_functional_failures",
        "ip54_splash_ingress_functional_failures",
    }.issubset(measurement_ids)
    assert (
        "sample_id,measurement_id,domain,unit,min,max,measured_value,pass,operator,evidence_class,required_evidence_artifacts,raw_data_artifact,fixture_calibration_certificate,photo_or_log_artifact,lot_traceability_record,notes"
        in csv_text
    )
    assert "skin_temperature_raw_log" in csv_text
    assert "sar_prescan_raw_report" in csv_text
    assert review["status"] == "blocked_no_environmental_results"
    assert review["required_evidence_class"] == "physical_environmental_result"
    assert review["complete_result_count"] == 0
    assert "sar_prescan_w_per_kg_1g" in review["blank_or_incomplete_measurements"]
    assert "evidence_class=physical_environmental_result" in review["release_rule"]
    assert review["cases"][0]["required_evidence_artifacts"]
    assert review["cases"][0]["raw_data_artifact_present"] is False
    assert ingress["status"] == "cad_ingress_path_review_ready"
    assert ingress["path_count"] >= 8
    assert {
        "display_glass_perimeter",
        "bottom_speaker_grille",
        "bottom_microphone_ports",
        "top_microphone_port",
        "handset_earpiece_slot",
        "usb_c_bottom_aperture",
        "side_button_rails",
    }.issubset({path["id"] for path in ingress["paths"]})
    camera_path = next(path for path in ingress["paths"] if path["id"] == "rear_camera_window")
    assert camera_path["cad_pass"]
    assert {
        "rear_camera_cover_adhesive_top",
        "rear_camera_cover_adhesive_bottom",
        "rear_camera_cover_adhesive_left",
        "rear_camera_cover_adhesive_right",
        "rear_camera_light_baffle_top",
        "rear_camera_light_baffle_bottom",
    }.issubset(set(camera_path["seal_stack"]))
    usb_path = next(path for path in ingress["paths"] if path["id"] == "usb_c_bottom_aperture")
    assert usb_path["cad_pass"]
    assert {
        "usb_c_perimeter_gasket_top",
        "usb_c_perimeter_gasket_bottom",
        "usb_c_perimeter_gasket_left",
        "usb_c_perimeter_gasket_right",
        "usb_c_molded_drip_break_lip",
        "usb_c_internal_drain_shelf",
    }.issubset(set(usb_path["seal_stack"]))
    side_buttons = next(path for path in ingress["paths"] if path["id"] == "side_button_rails")
    assert side_buttons["cad_pass"]
    assert {
        "power_button_elastomer_gasket",
        "volume_button_elastomer_gasket",
        "power_button_labyrinth_upper_rail",
        "volume_button_labyrinth_lower_rail",
    }.issubset(set(side_buttons["seal_stack"]))
    assert all(case["pass"] for case in ingress["acoustic_mesh_overhang_cases"])
    assert (tmp_path / "environmental-validation.json").is_file()
    assert (tmp_path / "environmental-validation.md").is_file()
    assert (tmp_path / "ingress-path-review.json").is_file()
    assert (tmp_path / "ingress-path-review.md").is_file()
    assert (tmp_path / "environmental-results-review.json").is_file()
    assert (tmp_path / "environmental-results-review.md").is_file()


def test_evt0_phone_environmental_results_reject_simulated_rows(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    mass = cad.mass_budget(parts)
    supplier = cad.supplier_matrix(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    validation = cad.write_engineering_validation_artifacts(params, parts, checks, mass, supplier)
    environmental = cad.write_environmental_validation_artifacts(
        params, parts, checks, clearance, validation
    )
    template_text = (tmp_path / "environmental-results-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "sample_id": "SIM-001",
                "measured_value": row["min"] or row["max"],
                "pass": "pass",
                "operator": "simulation",
                "evidence_class": "simulated_environmental_result_for_planning_not_release",
                "raw_data_artifact": "simulated-environmental.csv",
                "fixture_calibration_certificate": "simulated-cal.pdf",
                "photo_or_log_artifact": "simulated-environmental.log",
                "lot_traceability_record": "simulated-lot.txt",
            }
        )
    with (tmp_path / "environmental-results-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_environmental_result_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_environmental_results_review_artifacts(environmental)

    assert review["status"] == "blocked_no_environmental_results"
    assert (
        review["template_evidence_class"]
        == "simulated_environmental_result_for_planning_not_release"
    )
    assert review["complete_result_count"] == 0
    assert "max_skin_temp_video_call_c" in review["failed_measurements"]
    assert review["cases"][0]["evidence_class_allowed"] is False


def test_evt0_phone_evt_fixture_cad_maps_to_interface_validation(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    out = tmp_path / "out"
    review = tmp_path / "review"
    out.mkdir()
    review.mkdir()
    monkeypatch.setattr(cad, "OUT_DIR", out)
    monkeypatch.setattr(cad, "REVIEW_DIR", review)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    fixtures = cad.evt_fixture_parts(params)
    report = cad.write_evt_fixture_artifacts(params, fixtures, interface_validation)
    case_ids = {item["id"] for item in report["cases"]}
    fixture_names = {fixture.name for fixture in fixtures}

    assert report["status"] == "evt_fixture_cad_ready"
    assert report["fixture_count"] == len(fixtures)
    assert {
        "evt_fixture_button_force_probe",
        "evt_fixture_usb_c_insertion_gauge",
        "evt_fixture_screen_bond_clamp_frame",
        "evt_fixture_rear_camera_alignment_pin",
        "evt_fixture_front_camera_alignment_pin",
        "evt_fixture_bottom_acoustic_leak_mask",
        "evt_fixture_earpiece_leak_mask",
    }.issubset(fixture_names)
    assert {
        "button_force_travel_fixture",
        "usb_c_insertion_fixture",
        "screen_bond_clamp_fixture",
        "camera_alignment_fixture",
        "acoustic_leak_fixture",
    }.issubset(case_ids)
    assert all(item["pass"] for item in report["cases"])
    assert (out / "e1-phone-evt-fixtures.glb").is_file()
    assert (out / "evt-fixture-manifest.json").is_file()
    assert (review / "evt-fixtures.json").is_file()
    assert (review / "evt-fixtures.md").is_file()


def test_evt0_phone_evt_inspection_plan_writes_results_template(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    out = tmp_path / "out"
    review = tmp_path / "review"
    out.mkdir()
    review.mkdir()
    monkeypatch.setattr(cad, "OUT_DIR", out)
    monkeypatch.setattr(cad, "REVIEW_DIR", review)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    fixtures = cad.evt_fixture_parts(params)
    evt_fixtures = cad.write_evt_fixture_artifacts(params, fixtures, interface_validation)
    plan = cad.write_evt_inspection_plan_artifacts(params, interface_validation, evt_fixtures)
    measurement_ids = {item["id"] for item in plan["measurements"]}
    csv_text = (review / "evt-inspection-results-template.csv").read_text()

    assert plan["status"] == "evt_inspection_plan_ready"
    assert {
        "power_button_actuation_force",
        "power_button_travel",
        "usb_c_insertion_force_no_rub",
        "screen_adhesive_compression",
        "display_fpc_bend_radius",
        "rear_camera_lens_center_error",
        "front_camera_under_glass_center_error",
        "bottom_audio_leak_delta",
        "handset_receiver_leak_delta",
    }.issubset(measurement_ids)
    assert plan["measurement_count"] >= 10
    assert (
        "sample_id,measurement_id,fixture,units,min,max,nominal,measured,pass,operator,evidence_class,required_evidence_artifacts,raw_data_artifact,fixture_calibration_certificate,photo_or_log_artifact,lot_traceability_record,notes"
        in csv_text
    )
    assert "USB-C" in csv_text
    assert "usb_c_insertion_force_raw_csv" in csv_text
    assert "screen_compression_witness_raw_csv" in csv_text
    assert (review / "evt-inspection-plan.json").is_file()
    assert (review / "evt-inspection-plan.md").is_file()


def test_evt0_phone_evt_results_review_fails_closed_on_blank_template(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    out = tmp_path / "out"
    review = tmp_path / "review"
    out.mkdir()
    review.mkdir()
    monkeypatch.setattr(cad, "OUT_DIR", out)
    monkeypatch.setattr(cad, "REVIEW_DIR", review)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    evt_fixtures = cad.write_evt_fixture_artifacts(
        params, cad.evt_fixture_parts(params), interface_validation
    )
    evt_inspection = cad.write_evt_inspection_plan_artifacts(
        params, interface_validation, evt_fixtures
    )
    review_report = cad.write_evt_results_review_artifacts(evt_inspection)

    assert review_report["status"] == "blocked_no_physical_results"
    assert review_report["expected_measurement_count"] >= 10
    assert review_report["expected_sample_result_count"] > review_report["expected_measurement_count"]
    assert review_report["required_evidence_class"] == "physical_evt_result"
    assert review_report["populated_result_count"] == 0
    assert "power_button_actuation_force" in review_report["sample_shortage_measurements"]
    assert "power_button_actuation_force" in review_report["blank_or_incomplete_measurements"]
    assert "evidence_class=physical_evt_result" in review_report["release_rule"]
    assert review_report["cases"][0]["required_evidence_artifacts"]
    assert review_report["cases"][0]["raw_data_artifact_present"] is False
    assert (review / "evt-results-review.json").is_file()
    assert (review / "evt-results-review.md").is_file()


def test_evt0_phone_evt_results_reject_simulated_rows(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    out = tmp_path / "out"
    review = tmp_path / "review"
    out.mkdir()
    review.mkdir()
    monkeypatch.setattr(cad, "OUT_DIR", out)
    monkeypatch.setattr(cad, "REVIEW_DIR", review)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    evt_fixtures = cad.write_evt_fixture_artifacts(
        params, cad.evt_fixture_parts(params), interface_validation
    )
    evt_inspection = cad.write_evt_inspection_plan_artifacts(
        params, interface_validation, evt_fixtures
    )
    template_text = (review / "evt-inspection-results-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "sample_id": "SIM-001",
                "measured": row["min"] or row["max"] or row["nominal"],
                "pass": "pass",
                "operator": "simulation",
                "evidence_class": "simulated_evt_result_for_planning_not_release",
                "raw_data_artifact": "simulated-evt.csv",
                "fixture_calibration_certificate": "simulated-cal.pdf",
                "photo_or_log_artifact": "simulated-evt.log",
                "lot_traceability_record": "simulated-lot.txt",
            }
        )
    with (review / "evt-inspection-results-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_evt_result_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review_report = cad.write_evt_results_review_artifacts(evt_inspection)

    assert review_report["status"] == "blocked_no_physical_results"
    assert review_report["template_evidence_class"] == "simulated_evt_result_for_planning_not_release"
    assert review_report["populated_result_count"] == len(rows)
    assert "power_button_actuation_force" in review_report["failed_measurements"]
    assert review_report["cases"][0]["evidence_class_allowed"] is False


def test_evt0_phone_evt_results_require_planned_sample_counts(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    out = tmp_path / "out"
    review = tmp_path / "review"
    out.mkdir()
    review.mkdir()
    monkeypatch.setattr(cad, "OUT_DIR", out)
    monkeypatch.setattr(cad, "REVIEW_DIR", review)

    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    evt_fixtures = cad.write_evt_fixture_artifacts(
        params, cad.evt_fixture_parts(params), interface_validation
    )
    evt_inspection = cad.write_evt_inspection_plan_artifacts(
        params, interface_validation, evt_fixtures
    )
    template_rows = list(
        csv.DictReader(StringIO((review / "evt-inspection-results-template.csv").read_text()))
    )

    def passing_row(row: dict[str, str], sample_index: int) -> dict[str, str]:
        expected = next(
            item for item in evt_inspection["measurements"] if item["id"] == row["measurement_id"]
        )
        measured = expected["nominal"]
        if measured is None:
            measured = expected["min"] if expected["min"] is not None else expected["max"]
        return {
            **row,
            "sample_id": f"EVT-{sample_index:03d}",
            "measured": str(measured),
            "pass": "pass",
            "operator": "evt-operator",
            "evidence_class": "physical_evt_result",
            "raw_data_artifact": f"raw/{row['measurement_id']}-{sample_index}.csv",
            "fixture_calibration_certificate": "cal/fixture-cert.pdf",
            "photo_or_log_artifact": f"photos/{row['measurement_id']}-{sample_index}.jpg",
            "lot_traceability_record": "lots/evt-unit-lots.yaml",
        }

    with (review / "evt-inspection-results-template.csv").open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(template_rows[0]))
        writer.writeheader()
        writer.writerows([passing_row(row, 1) for row in template_rows])

    review_report = cad.write_evt_results_review_artifacts(evt_inspection)

    assert review_report["status"] == "blocked_evt_results_incomplete_or_failed"
    assert review_report["complete_result_count"] == review_report["expected_measurement_count"]
    assert "power_button_actuation_force" in review_report["sample_shortage_measurements"]
    power_coverage = next(
        item
        for item in review_report["sample_coverage"]
        if item["measurement_id"] == "power_button_actuation_force"
    )
    assert power_coverage["passed_sample_count"] == 1
    assert power_coverage["required_sample_count"] == 10

    planned_rows: list[dict[str, str]] = []
    for row in template_rows:
        expected = next(
            item for item in evt_inspection["measurements"] if item["id"] == row["measurement_id"]
        )
        for sample_index in range(1, int(expected["sample_count"]) + 1):
            planned_rows.append(passing_row(row, sample_index))
    with (review / "evt-inspection-results-template.csv").open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(template_rows[0]))
        writer.writeheader()
        writer.writerows(planned_rows)

    review_report = cad.write_evt_results_review_artifacts(evt_inspection)

    assert review_report["status"] == "evt_results_pass"
    assert review_report["complete_result_count"] == review_report["expected_sample_result_count"]
    assert review_report["sample_shortage_measurements"] == []


def test_evt0_phone_clearance_and_part_review_cover_assembly(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    part_review = cad.write_part_review_artifacts(parts)
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    case_ids = {item["id"] for item in clearance["cases"]}

    assert part_review["status"] == "pass"
    assert part_review["part_count"] == len(parts)
    assert part_review["contact_sheet_check"]["pass"]
    assert part_review["exploded_contact_sheet_check"]["pass"]
    assert clearance["status"] == "pass"
    assert {
        "battery_to_pcb_islands",
        "battery_back_void_foam_to_pouch",
        "split_interconnect_flex_to_battery_edge",
        "split_interconnect_flex_within_side_rail",
        "split_interconnect_connectors_on_pcb_islands",
        "haptic_to_battery",
        "haptic_to_pcb_islands",
        "usb_to_bottom_speaker",
    }.issubset(case_ids)
    assert (tmp_path / "part-review-contact-sheet.png").is_file()
    assert (tmp_path / "part-explode-contact-sheet.png").is_file()
    assert (tmp_path / "assembly-clearance.json").is_file()


def test_evt0_phone_visual_decision_report_tracks_render_reviews(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    visual = passing_visual_review()
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    part_review = cad.write_part_review_artifacts(parts)
    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    report = cad.write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )

    assert report["status"] == "pass"
    assert report["automated_visual_status"] == "automated_visual_coverage_pass"
    assert report["manual_visual_signoff_status"] == "blocked_manual_visual_review_open"
    assert report["production_visual_signoff_ready"] is False
    assert report["open_manual_review_count"] == len(report["manual_review_items"])
    assert {view["file"] for view in report["review_views"]} == set(visual)
    decision_ids = {decision["id"] for decision in report["decisions"]}
    assert "compact_orange_shell" in decision_ids
    assert "under_glass_front_camera_and_earpiece" in decision_ids
    assert "rear_camera_cover_window" in decision_ids
    assert "bottom_io_pattern" in decision_ids
    assert "injection_mold_tooling_placeholders" in decision_ids
    assert report["status_inputs"]["front_back_render_distinct"]
    assert report["status_inputs"]["visual_design_gates_pass"]
    assert "hard_orange_shell_visible" in report["visual_design_gates"]
    assert "black_glass_front_visible" in report["visual_design_gates"]
    assert report["visual_design_gates"]["expected_review_view_coverage"]["pass"]
    assert report["visual_design_gates"]["component_family_detail_views"]["pass"]
    assert report["aesthetic_decisions"]
    assert report["technical_decisions"]
    assert report["visual_deltas"]["front_back_mean_rgb_sum_delta"] >= 8.0
    assert any("rear feature proportions" in item for item in report["manual_review_items"])
    assert "production visual/CMF signoff requires zero open manual review items" in report[
        "release_rule"
    ]
    assert (tmp_path / "visual-decision-report.json").is_file()
    assert (tmp_path / "visual-decision-report.md").is_file()


def test_evt0_phone_render_verification_rejects_blank_or_sparse_images(
    tmp_path, monkeypatch
) -> None:
    from PIL import Image, ImageDraw

    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    blank = tmp_path / "blank.png"
    sparse = tmp_path / "sparse.png"
    detailed = tmp_path / "detailed.png"

    Image.new("RGB", (1200, 1200), "white").save(blank)
    sparse_image = Image.new("RGB", (1200, 1200), "white")
    sparse_draw = ImageDraw.Draw(sparse_image)
    sparse_draw.line((0, 0, 1199, 1199), fill="black", width=2)
    sparse_image.save(sparse)

    detailed_image = Image.new("RGB", (1200, 1200), "white")
    detailed_draw = ImageDraw.Draw(detailed_image)
    for idx in range(80):
        x = 180 + (idx % 10) * 78
        y = 160 + (idx // 10) * 88
        color = (
            70 + (idx * 31) % 185,
            25 + (idx * 17) % 170,
            10 + (idx * 11) % 150,
        )
        detailed_draw.rectangle((x, y, x + 54, y + 44), fill=color, outline="black")
    detailed_draw.rounded_rectangle((160, 130, 1010, 890), radius=70, outline=(255, 82, 5), width=18)
    detailed_image.save(detailed)

    review = cad.verify_render_artifacts([blank, sparse, detailed])

    assert review["blank.png"]["pass"] is False
    assert review["blank.png"]["content_checks"]["nonwhite_coverage"] is False
    assert review["sparse.png"]["pass"] is False
    assert review["sparse.png"]["content_checks"]["nonwhite_coverage"] is False
    assert review["detailed.png"]["pass"] is True
    assert review["detailed.png"]["content_checks"]["occupied_bbox"] is True
    assert (tmp_path / "visual-review.json").is_file()


def test_evt0_phone_part_visual_coverage_maps_every_part_to_review_views(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    visual = passing_visual_review()
    part_review = cad.write_part_review_artifacts(parts)
    coverage = cad.write_part_visual_coverage_artifacts(visual, part_review)

    assert coverage["status"] == "part_visual_coverage_pass"
    assert coverage["expected_part_count"] == len(parts)
    assert coverage["covered_part_count"] == len(parts)
    assert coverage["missing_or_incomplete_parts"] == []
    assert "part-review-contact-sheet.png" in coverage["required_review_artifacts"]
    assert "part-explode-contact-sheet.png" in coverage["required_review_artifacts"]
    usb_case = next(case for case in coverage["cases"] if case["part"] == "usb_c_receptacle")
    assert "full_bottom_port.png" in usb_case["required_views"]
    assert "part-explode-contact-sheet.png" in usb_case["required_views"]
    button_case = next(case for case in coverage["cases"] if case["part"] == "power_button_cap")
    assert "full_left_side.png" in button_case["required_views"]
    assert button_case["exploded_contact_sheet_present"]
    assert (tmp_path / "part-visual-coverage.json").is_file()
    assert (tmp_path / "part-visual-coverage.md").is_file()

    blocked_visual = dict(visual)
    blocked_visual["full_bottom_port.png"] = {
        **blocked_visual["full_bottom_port.png"],
        "pass": False,
    }
    blocked = cad.write_part_visual_coverage_artifacts(blocked_visual, part_review)

    assert blocked["status"] == "blocked_part_visual_coverage_incomplete"
    assert "usb_c_receptacle" in blocked["missing_or_incomplete_parts"]


def test_evt0_phone_component_selection_review_reconciles_current_params(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    report = cad.write_component_selection_review_artifacts(params, checks)

    assert report["status"] == "cad_component_selection_review_ready"
    assert report["device_envelope_mm"] == params["device"]["envelope_mm"]
    assert report["component_count"] >= 12
    assert report["missing_or_failed_components"] == []
    cases = {case["id"]: case for case in report["cases"]}
    assert cases["side_buttons_single_sku"]["selected_component"] == "XKB TS-1187A-B-A-B"
    assert cases["usb_c_receptacle"]["pass"] is True
    assert cases["rear_flash_and_stray_light_septum"]["pass"] is True
    assert any(
        check["id"] == "camera_optical_seal_stack"
        for check in cases["rear_camera_and_flush_window"]["critical_checks"]
    )
    assert any(
        check["id"] == "rear_camera_back_shell_aperture"
        for check in cases["rear_camera_and_flush_window"]["critical_checks"]
    )
    assert "supplier drawings" in report["release_rule"]
    assert (tmp_path / "component-selection-review.json").is_file()
    assert (tmp_path / "component-selection-review.md").is_file()


def test_evt0_phone_visual_review_coverage_acceptance_tracks_required_artifacts(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    visual = passing_visual_review()
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    part_review = cad.write_part_review_artifacts(parts)
    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    visual_decision = cad.write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )
    part_visual_coverage = cad.write_part_visual_coverage_artifacts(visual, part_review)
    acceptance = cad.write_visual_review_coverage_acceptance_artifacts(
        visual, part_review, visual_decision, part_visual_coverage
    )

    assert acceptance["status"] == "visual_review_coverage_acceptance_pass"
    assert acceptance["automated_visual_coverage_ready"] is True
    assert acceptance["production_visual_signoff_ready"] is False
    assert acceptance["expected_view_count"] == 12
    assert acceptance["complete_view_count"] == 12
    assert acceptance["part_review_case"]["part_count"] == len(parts)
    assert acceptance["part_review_case"]["contact_sheet_pass"] is True
    assert acceptance["part_review_case"]["exploded_contact_sheet_pass"] is True
    assert acceptance["part_visual_coverage_case"]["covered_part_count"] == len(parts)
    assert acceptance["part_visual_coverage_case"]["pass"] is True
    assert acceptance["visual_decision_case"]["decision_count"] >= 7
    assert acceptance["visual_decision_case"]["open_manual_review_count"] > 0
    assert acceptance["expected_visual_gate_count"] == len(
        visual_decision["visual_design_gates"]
    )
    assert "Production visual/CMF signoff remains blocked" in acceptance["release_rule"]
    assert (tmp_path / "visual-review-coverage-acceptance.json").is_file()
    assert (tmp_path / "visual-review-coverage-acceptance.md").is_file()


def test_evt0_phone_cmf_release_acceptance_requires_physical_results(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    visual = passing_visual_review()
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    part_review = cad.write_part_review_artifacts(parts)
    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    visual_decision = cad.write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )
    part_visual_coverage = cad.write_part_visual_coverage_artifacts(visual, part_review)
    visual_coverage = cad.write_visual_review_coverage_acceptance_artifacts(
        visual, part_review, visual_decision, part_visual_coverage
    )
    toolmaker_signoff = {"status": "blocked_no_toolmaker_signoff"}

    report = cad.write_cmf_release_acceptance_artifacts(
        params, visual_decision, visual_coverage, dfm, toolmaker_signoff
    )

    assert report["status"] == "blocked_no_cmf_results"
    assert report["complete_criterion_count"] == 1
    assert report["production_complete_count"] == 0
    assert report["required_evidence_class"] == "physical_cmf_result"
    assert report["visual_gate"]["pass"] is True
    rendered_case = next(
        case for case in report["cases"] if case["id"] == "rendered_orange_identity_locked"
    )
    assert rendered_case["pass"] is True
    physical_cases = [case for case in report["cases"] if case["blocks_release"]]
    assert all(not case["result"]["evidence_class_allowed"] for case in physical_cases)
    assert all(not case["result"]["numeric_limit_pass"] for case in physical_cases)
    assert "orange_resin_color_plaque_delta_e" in report["missing_or_incomplete_criteria"]
    assert "Color plaque" in report["release_rule"]
    assert (tmp_path / "cmf-release-acceptance.json").is_file()
    assert (tmp_path / "cmf-release-acceptance.md").is_file()
    template_rows = list(csv.DictReader(StringIO((tmp_path / "cmf-results-template.csv").read_text())))
    assert template_rows
    assert "evidence_class" in template_rows[0]


def test_evt0_phone_cmf_release_acceptance_enforces_numeric_limits(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    visual = passing_visual_review()
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    part_review = cad.write_part_review_artifacts(parts)
    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    visual_decision = cad.write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )
    part_visual_coverage = cad.write_part_visual_coverage_artifacts(visual, part_review)
    visual_coverage = cad.write_visual_review_coverage_acceptance_artifacts(
        visual, part_review, visual_decision, part_visual_coverage
    )
    toolmaker_signoff = {"status": "blocked_no_toolmaker_signoff"}
    cad.write_cmf_release_acceptance_artifacts(
        params, visual_decision, visual_coverage, dfm, toolmaker_signoff
    )
    rows = [
        {
            "criterion_id": "orange_resin_color_plaque_delta_e",
            "sample_id": "cmf-plaque-orange-001",
            "artifact": "photos/cmf-plaque-orange-001.jpg",
            "measured_value": "delta_e=1.4",
            "accepted": "yes",
            "reviewer": "cmf-reviewer",
            "evidence_class": "physical_cmf_result",
            "notes": "approved resin lot",
        },
        {
            "criterion_id": "hard_touch_gloss_texture",
            "sample_id": "texture-plaque-001",
            "artifact": "photos/texture-plaque-001.jpg",
            "measured_value": "gloss_gu_60=12",
            "accepted": "yes",
            "reviewer": "cmf-reviewer",
            "evidence_class": "physical_cmf_result",
            "notes": "VDI texture plaque",
        },
        {
            "criterion_id": "scratch_and_hand_oil_visibility",
            "sample_id": "rub-sample-001",
            "artifact": "photos/rub-sample-001.jpg",
            "measured_value": "visible_defect_count=0",
            "accepted": "yes",
            "reviewer": "cmf-reviewer",
            "evidence_class": "physical_cmf_result",
            "notes": "after rub exposure",
        },
        {
            "criterion_id": "gate_blush_vestige_and_weld_line_visibility",
            "sample_id": "first-shot-001",
            "artifact": "photos/first-shot-001.jpg",
            "measured_value": "a_surface_visible_defects=0",
            "accepted": "yes",
            "reviewer": "cmf-reviewer",
            "evidence_class": "physical_cmf_result",
            "notes": "first-shot cosmetic review",
        },
        {
            "criterion_id": "rendered_orange_identity_locked",
            "sample_id": "",
            "artifact": "",
            "measured_value": "",
            "accepted": "",
            "reviewer": "",
            "evidence_class": "",
            "notes": "covered by visual gate",
        },
    ]
    template_path = tmp_path / "cmf-results-template.csv"
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    report = cad.write_cmf_release_acceptance_artifacts(
        params, visual_decision, visual_coverage, dfm, toolmaker_signoff
    )
    assert report["status"] == "cmf_release_complete"
    assert report["production_complete_count"] == 4
    color_case = next(
        case for case in report["cases"] if case["id"] == "orange_resin_color_plaque_delta_e"
    )
    assert color_case["result"]["parsed_measurements"]["delta_e"] == 1.4
    assert color_case["result"]["numeric_limit_pass"] is True

    rows[0]["measured_value"] = "delta_e=3.1"
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    report = cad.write_cmf_release_acceptance_artifacts(
        params, visual_decision, visual_coverage, dfm, toolmaker_signoff
    )
    assert report["status"] == "blocked_cmf_results_incomplete"
    color_case = next(
        case for case in report["cases"] if case["id"] == "orange_resin_color_plaque_delta_e"
    )
    assert color_case["result"]["numeric_limit_pass"] is False
    assert color_case["result"]["numeric_limit_failures"] == ["delta_e_above_2.0"]


def test_evt0_phone_injection_molding_dfm_screen_tracks_tooling_risks(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    case_ids = {item["id"] for item in dfm["cases"]}
    risk_ids = {item["id"] for item in dfm["risks"]}
    action_ids = {item["id"] for item in dfm["mold_action_plan"]}

    assert dfm["status"] == "cad_dfm_inputs_ready"
    assert {
        "nominal_wall",
        "rib_to_wall_ratio",
        "boss_wall_to_nominal_wall",
        "submarine_gate_ratio",
        "cooling_channel_clearance",
    }.issubset(case_ids)
    assert {
        "back_shell_main_draw",
        "screw_boss_core_pins",
        "snap_hook_release",
        "usb_c_bottom_aperture_shutoff",
        "side_button_openings",
        "camera_window_and_acoustic_slots",
    }.issubset(action_ids)
    assert all(item["pass"] for item in dfm["mold_action_plan"])
    assert dfm["release_blockers"]
    assert {"long_thin_flow_path", "orange_color_match_and_gate_blush"}.issubset(risk_ids)
    assert dfm["linked_fit_checks"]["mold_runner_gate_model"]
    assert (tmp_path / "injection-molding-dfm.json").is_file()
    assert (tmp_path / "injection-molding-dfm.md").is_file()


def test_evt0_phone_mold_process_window_quantifies_tooling_risks(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    mold_process = cad.write_mold_process_window_artifacts(
        params,
        parts,
        tooling,
        dfm,
        tolerance_stack,
    )
    case_ids = {item["id"] for item in mold_process["cases"]}

    assert mold_process["status"] == "cad_mold_process_window_ready"
    assert {
        "fill_length_to_wall",
        "clamp_tonnage_window",
        "gate_shear_proxy",
        "cooling_clearance_ratio",
        "boss_sink_proxy",
    }.issubset(case_ids)
    fill_case = next(item for item in mold_process["cases"] if item["id"] == "fill_length_to_wall")
    assert fill_case["risk"] in {"medium", "high"}
    assert any(
        "mold-flow" in item and "fill/pack/warp" in item
        for item in mold_process["toolmaker_questions"]
    )
    assert mold_process["first_shot_doe"]
    assert "mold_tooling.png" in mold_process["linked_evidence"]
    assert (tmp_path / "mold-process-window.json").is_file()
    assert (tmp_path / "mold-process-window.md").is_file()


def test_evt0_phone_tooling_action_register_links_dfm_to_toolmaker_returns(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    mold_process = cad.write_mold_process_window_artifacts(
        params,
        parts,
        tooling,
        dfm,
        tolerance_stack,
    )
    register = cad.write_tooling_action_register_artifacts(dfm, mold_process)
    csv_text = (tmp_path / "tooling-action-register.csv").read_text()
    action_ids = {item["id"] for item in register["actions"]}

    assert register["status"] == "cad_tooling_action_register_ready"
    assert register["physical_toolmaker_complete_count"] == 0
    assert "snap_hook_release" in action_ids
    assert "orange_cmf_texture_gate_review" in action_ids
    assert "first_shot_metrology_loop" in action_ids
    assert all(item["required_returned_evidence"] for item in register["actions"])
    assert "marked_up_tool_design" in csv_text
    assert "first_shot_cmm_report" in csv_text
    assert (tmp_path / "tooling-action-register.json").is_file()
    assert (tmp_path / "tooling-action-register.csv").is_file()
    assert (tmp_path / "tooling-action-register.md").is_file()


def test_evt0_phone_mold_flow_acceptance_fails_closed_without_physical_evidence(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    mold_process = cad.write_mold_process_window_artifacts(
        params,
        parts,
        tooling,
        dfm,
        tolerance_stack,
    )
    report = cad.write_mold_flow_acceptance_artifacts(params, dfm, mold_process)
    csv_text = (tmp_path / "mold-flow-results-template.csv").read_text()

    assert report["status"] == "blocked_no_mold_flow_results"
    assert report["input_deck_status"] == "mold_flow_input_deck_ready"
    assert report["required_evidence_class"] == "physical_mold_flow_result"
    assert report["complete_result_count"] == 0
    assert "fill_pressure_at_vp_transfer_mpa" in report["missing_or_incomplete_criteria"]
    assert "evidence_class" in csv_text
    assert "raw_simulation_archive" in csv_text
    assert "evidence_class=physical_mold_flow_result" in report["release_rule"]
    assert (tmp_path / "mold-flow-input-deck.json").is_file()
    assert (tmp_path / "mold-flow-input-deck.md").is_file()
    assert (tmp_path / "mold-flow-acceptance.json").is_file()
    assert (tmp_path / "mold-flow-acceptance.md").is_file()


def test_evt0_phone_mold_flow_acceptance_rejects_simulated_rows(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    mold_process = cad.write_mold_process_window_artifacts(
        params,
        parts,
        tooling,
        dfm,
        tolerance_stack,
    )
    cad.write_mold_flow_acceptance_artifacts(params, dfm, mold_process)
    template_text = (tmp_path / "mold-flow-results-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "toolmaker_name": "simulated mold-flow vendor",
                "evidence_class": "simulated_mold_flow_for_planning_not_release",
                "returned_artifact": "simulated-moldflow-report.pdf",
                "raw_simulation_archive": "simulated-moldflow.zip",
                "reviewer_acceptance_record": "simulated-acceptance.md",
                "resin_tooling_traceability_record": "simulated-traceability.yaml",
                "measured_or_predicted_value": "simulated pass",
                "accepted": "true",
                "reviewer": "simulation",
            }
        )
    with (tmp_path / "mold-flow-results-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_mold_flow_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    report = cad.write_mold_flow_acceptance_artifacts(params, dfm, mold_process)

    assert report["status"] == "blocked_no_mold_flow_results"
    assert report["template_evidence_class"] == "simulated_mold_flow_for_planning_not_release"
    assert report["complete_result_count"] == 0
    assert report["cases"][0]["evidence_class_allowed"] is False
    assert report["cases"][0]["physical_evidence_pass"] is False


def test_evt0_phone_toolmaker_signoff_package_fails_closed_without_returns(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    mold_process = cad.write_mold_process_window_artifacts(
        params,
        parts,
        tooling,
        dfm,
        tolerance_stack,
    )
    signoff = cad.write_toolmaker_signoff_artifacts(params, dfm, mold_process)
    csv_text = (tmp_path / "toolmaker-signoff-response-template.csv").read_text()

    assert signoff["package_status"] == "toolmaker_signoff_package_ready"
    assert signoff["status"] == "blocked_no_toolmaker_signoff"
    assert signoff["expected_response_count"] >= 7
    assert signoff["required_evidence_class"] == "physical_toolmaker_signoff"
    assert signoff["complete_response_count"] == 0
    assert "mold_flow_fill_pack_warp" in signoff["missing_or_incomplete_items"]
    assert "review_item_id,toolmaker_name,report_or_drawing_received" in csv_text
    assert "evidence_class,required_evidence_artifacts,returned_artifact" in csv_text
    assert "signed_moldflow_report" in csv_text
    assert "evidence_class=physical_toolmaker_signoff" in signoff["release_rule"]
    assert signoff["cases"][0]["required_evidence_artifacts"]
    assert signoff["cases"][0]["returned_artifact_present"] is False
    assert (tmp_path / "toolmaker-signoff-package.json").is_file()
    assert (tmp_path / "toolmaker-signoff-package.md").is_file()
    assert (tmp_path / "toolmaker-signoff-review.json").is_file()
    assert (tmp_path / "toolmaker-signoff-review.md").is_file()


def test_evt0_phone_toolmaker_signoff_rejects_simulated_returns(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    mold_process = cad.write_mold_process_window_artifacts(
        params,
        parts,
        tooling,
        dfm,
        tolerance_stack,
    )
    cad.write_toolmaker_signoff_artifacts(params, dfm, mold_process)
    template_text = (tmp_path / "toolmaker-signoff-response-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "toolmaker_name": "simulated toolmaker",
                "report_or_drawing_received": "yes",
                "accepted": "yes",
                "reviewer": "simulation",
                "evidence_class": "simulated_toolmaker_signoff_for_planning_not_release",
                "returned_artifact": "simulated-signed-report.pdf",
                "moldflow_or_tooling_data_artifact": "simulated-moldflow.zip",
                "reviewer_acceptance_record": "simulated-acceptance.md",
                "resin_cmf_or_tooling_traceability_record": "simulated-trace.txt",
                "measured_or_predicted_value": "simulated",
            }
        )
    with (tmp_path / "toolmaker-signoff-response-template.csv").open(
        "w", newline=""
    ) as csv_file:
        csv_file.write("# evidence_class: simulated_toolmaker_signoff_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    signoff = cad.write_toolmaker_signoff_artifacts(params, dfm, mold_process)

    assert signoff["status"] == "blocked_no_toolmaker_signoff"
    assert (
        signoff["template_evidence_class"]
        == "simulated_toolmaker_signoff_for_planning_not_release"
    )
    assert signoff["complete_response_count"] == 0
    assert "mold_flow_fill_pack_warp" in signoff["missing_or_incomplete_items"]
    assert signoff["cases"][0]["evidence_class_allowed"] is False
    assert signoff["cases"][0]["physical_evidence_pass"] is False


def test_evt0_phone_tolerance_stack_tracks_datums_and_release_controls(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    stack = cad.write_tolerance_stack_artifacts(params, checks)
    datum_ids = {item["id"] for item in stack["datums"]}
    stack_ids = {item["id"] for item in stack["stacks"]}
    drawing_features = {item["feature"] for item in stack["drawing_requirements"]}

    assert stack["status"] == "cad_tolerance_stack_pass"
    assert {"A", "B", "C", "D"}.issubset(datum_ids)
    assert {
        "cover_glass_to_orange_rail_x",
        "display_fpc_bend_radius",
        "usb_shell_to_aperture",
        "rear_camera_lens_to_cover_glass",
        "nominal_z_stack_margin",
    }.issubset(stack_ids)
    assert {"usb_c_port_aperture", "rear_camera_cover_glass_window"}.issubset(drawing_features)
    assert stack["linked_fit_checks"]["screen_mount_and_connection"]
    assert (tmp_path / "tolerance-stack.json").is_file()
    assert (tmp_path / "tolerance-stack.md").is_file()


def test_evt0_phone_gdt_release_package_writes_fai_characteristics(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    gdt = cad.write_gdt_release_package_artifacts(params, tolerance_stack)
    characteristic_ids = {item["characteristic_id"] for item in gdt["characteristics"]}
    fai_text = (tmp_path / "gdt-fai-template.csv").read_text()

    assert gdt["status"] == "gdt_release_package_ready"
    assert gdt["characteristic_count"] >= len(tolerance_stack["drawing_requirements"])
    assert {"CRIT-001", "STACK-006"}.issubset(characteristic_ids)
    assert "rear_camera_cover_glass_window" in fai_text
    assert "part_revision,sample_id,characteristic_id" in fai_text
    assert "evidence_class,required_evidence_artifacts,raw_measurement_artifact" in fai_text
    assert "fai_cmm_or_optical_raw_report" in fai_text
    assert (tmp_path / "gdt-release-package.json").is_file()
    assert (tmp_path / "gdt-release-package.md").is_file()


def test_evt0_phone_gdt_fai_results_review_fails_closed_on_blank_template(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    gdt = cad.write_gdt_release_package_artifacts(params, tolerance_stack)
    review = cad.write_gdt_fai_results_review_artifacts(gdt)

    assert review["status"] == "blocked_no_fai_results"
    assert review["expected_characteristic_count"] == gdt["characteristic_count"]
    assert review["required_evidence_class"] == "physical_fai_result"
    assert review["observed_row_count"] == gdt["characteristic_count"]
    assert review["complete_result_count"] == 0
    assert "CRIT-001" in review["blank_or_incomplete_characteristics"]
    assert "evidence_class=physical_fai_result" in review["release_rule"]
    assert review["cases"][0]["required_evidence_artifacts"]
    assert review["cases"][0]["raw_measurement_artifact_present"] is False
    assert (tmp_path / "gdt-fai-results-review.json").is_file()
    assert (tmp_path / "gdt-fai-results-review.md").is_file()


def test_evt0_phone_gdt_fai_results_reject_simulated_rows(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    gdt = cad.write_gdt_release_package_artifacts(params, tolerance_stack)
    template_text = (tmp_path / "gdt-fai-template.csv").read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    for row in rows:
        row.update(
            {
                "sample_id": "SIM-001",
                "measured_value": row["minimum_mm"] or "0.0",
                "pass": "pass",
                "inspector": "simulation",
                "evidence_class": "simulated_fai_result_for_planning_not_release",
                "raw_measurement_artifact": "simulated-fai.csv",
                "inspection_equipment_calibration_certificate": "simulated-cal.pdf",
                "inspection_photo_or_scan": "simulated-scan.png",
                "lot_traceability_record": "simulated-lot.txt",
            }
        )
    with (tmp_path / "gdt-fai-template.csv").open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: simulated_fai_result_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    review = cad.write_gdt_fai_results_review_artifacts(gdt)

    assert review["status"] == "blocked_no_fai_results"
    assert review["template_evidence_class"] == "simulated_fai_result_for_planning_not_release"
    assert review["complete_result_count"] == 0
    assert "CRIT-001" in review["blank_or_incomplete_characteristics"]
    assert review["cases"][0]["evidence_class_allowed"] is False


def test_evt0_phone_board_step_readiness_fails_closed_on_concept_pcb(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    kicad_reconciliation = {
        "status": "cad_kicad_placement_reconciled",
        "footprint_cases": [{"id": "J_USB_C"}],
        "cad_projection_cases": [{"id": "J_USB_C"}],
    }
    solid_cad = {
        "status": "generated",
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
    }

    report = cad.write_board_step_readiness_artifacts(params, kicad_reconciliation, solid_cad)
    case_map = {case["id"]: case for case in report["cases"]}

    assert report["status"] == "blocked_concept_pcb_no_routed_step"
    assert report["board_state_detected"]["has_tracks"] is False
    assert report["board_state_detected"]["has_production_step"] is False
    assert report["board_state_detected"]["has_complete_routed_board_release_intake"] is False
    assert report["board_state_detected"]["placeholder_marker_count"] > 0
    assert report["required_routed_board_evidence_class"] == "physical_routed_board_release"
    assert report["routed_board_intake_cases"][0]["evidence_class_allowed"] is False
    assert case_map["kicad_placement_reconciled_to_cad"]["pass"]
    assert not case_map["production_board_step_present"]["pass"]
    assert not case_map["routed_board_release_intake_complete"]["pass"]
    assert (tmp_path / "routed-board-step-intake-template.csv").is_file()
    assert (tmp_path / "board-step-readiness.json").is_file()
    assert (tmp_path / "board-step-readiness.md").is_file()


def test_evt0_phone_board_step_readiness_rejects_demo_routed_intake(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    kicad_reconciliation = {
        "status": "cad_kicad_placement_reconciled",
        "footprint_cases": [{"id": "J_USB_C"}],
        "cad_projection_cases": [{"id": "J_USB_C"}],
    }
    solid_cad = {
        "status": "generated",
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
    }
    cad.write_board_step_readiness_artifacts(params, kicad_reconciliation, solid_cad)
    intake_path = tmp_path / "routed-board-step-intake-template.csv"
    template_text = intake_path.read_text()
    rows = list(csv.DictReader(StringIO(template_text)))
    rows[0].update(
        {
            "release_id": "DEMO-ONLY",
            "kicad_pcb_path": "board/kicad/e1-phone/pcb/e1-phone-mainboard-demo.kicad_pcb",
            "routed_step_artifact": "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo.step",
            "drc_report_artifact": "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-job.gbrjob",
            "erc_report_artifact": "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-job.gbrjob",
            "gerber_job_artifact": "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-job.gbrjob",
            "pick_place_artifact": "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-pos.csv",
            "bom_artifact": "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-bom.csv",
            "component_3d_model_manifest": "board/kicad/e1-phone/artifact-manifest.yaml",
            "enclosure_clearance_rerun_artifact": "mechanical/e1-phone/review/board-step-readiness.json",
            "reviewer": "simulation",
            "evidence_class": "demo_routed_board_for_planning_not_release",
        }
    )
    with intake_path.open("w", newline="") as csv_file:
        csv_file.write("# evidence_class: demo_routed_board_for_planning_not_release\n")
        writer = csv.DictWriter(csv_file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    report = cad.write_board_step_readiness_artifacts(params, kicad_reconciliation, solid_cad)
    case_map = {case["id"]: case for case in report["cases"]}

    assert report["status"] == "blocked_concept_pcb_no_routed_step"
    assert report["routed_board_intake_template_evidence_class"] == (
        "demo_routed_board_for_planning_not_release"
    )
    assert report["routed_board_intake_cases"][0]["required_fields_present"] is True
    assert report["routed_board_intake_cases"][0]["artifact_paths_exist"] is True
    assert report["routed_board_intake_cases"][0]["evidence_class_allowed"] is False
    assert report["routed_board_intake_cases"][0]["pass"] is False
    assert case_map["routed_board_release_intake_complete"]["pass"] is False
    assert case_map["production_board_step_present"]["pass"] is False


def test_evt0_phone_routed_board_clearance_fails_closed_until_routed_step(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    monkeypatch.setattr(cad, "OUT_DIR", tmp_path)
    (tmp_path / "main_pcb.step").write_text("ISO-10303-21;" + ("x" * 1200))
    kicad_reconciliation = {
        "status": "cad_kicad_placement_reconciled",
        "footprint_cases": [{"id": "J_USB_C"}],
        "cad_projection_cases": [{"id": "J_USB_C"}],
    }
    solid_cad = {
        "status": "generated",
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
    }
    board_step = cad.write_board_step_readiness_artifacts(
        params, kicad_reconciliation, solid_cad
    )
    clearance = cad.write_assembly_clearance_artifacts(params, parts)

    report = cad.write_routed_board_clearance_artifacts(board_step, clearance, solid_cad)

    assert report["status"] == "blocked_waiting_for_routed_board_step"
    assert report["source_reviews"]["board_step_readiness_status"] == (
        "blocked_concept_pcb_no_routed_step"
    )
    assert report["expected_clearance_case_count"] >= 8
    assert report["complete_clearance_result_count"] == 0
    assert report["required_evidence_class"] == "physical_routed_board_clearance_result"
    assert report["cases"][0]["id"] == "routed_board_step_available_for_import"
    assert report["cases"][0]["pass"] is False
    assert report["result_cases"][0]["evidence_class_allowed"] is False
    assert "evidence_class=physical_routed_board_clearance_result" in report["release_rule"]
    assert (tmp_path / "routed-board-clearance-results-template.csv").is_file()
    assert (tmp_path / "routed-board-clearance.json").is_file()
    assert (tmp_path / "routed-board-clearance.md").is_file()


def test_evt0_phone_full_cad_boolean_interference_requires_physical_brep_inputs(
    tmp_path, monkeypatch
) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    checks = cad.run_checks(params, parts)
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)
    monkeypatch.setattr(cad, "OUT_DIR", tmp_path)
    (tmp_path / "main_pcb.step").write_text("ISO-10303-21;" + ("x" * 1200))
    kicad_reconciliation = {
        "status": "cad_kicad_placement_reconciled",
        "footprint_cases": [{"id": "J_USB_C"}],
        "cad_projection_cases": [{"id": "J_USB_C"}],
    }
    solid_cad = {
        "status": "generated",
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
    }
    step_validation = {"status": "pass", "validated_count": 62}
    supplier_response = {"status": "blocked_no_supplier_responses"}
    board_step = cad.write_board_step_readiness_artifacts(
        params, kicad_reconciliation, solid_cad
    )
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    routed_clearance = cad.write_routed_board_clearance_artifacts(
        board_step, clearance, solid_cad
    )

    report = cad.write_full_cad_boolean_interference_artifacts(
        parts,
        clearance,
        board_step,
        routed_clearance,
        supplier_response,
        solid_cad,
        step_validation,
    )

    assert report["status"] == "blocked_boolean_interference_incomplete"
    assert report["overall_status"] == "blocked_boolean_interference_incomplete"
    assert report["expected_scope_count"] == 10
    assert report["cad_prerequisite_scope_count"] >= 7
    assert report["concept_aabb_pair_check_count"] >= 12
    assert report["concept_aabb_interference_count"] == 0
    assert report["complete_result_count"] == 0
    assert report["prerequisites"]["solid_cad_generated"] is True
    assert report["prerequisites"]["concept_aabb_interference_scan_pass"] is True
    assert report["prerequisites"]["routed_board_step_ready"] is False
    assert report["prerequisites"]["supplier_brep_models_accepted"] is False
    battery_scope = next(
        case for case in report["scope_cases"] if case["id"] == "battery_pouch_pcb_flex_haptic"
    )
    assert battery_scope["required_parts_present"] is True
    assert battery_scope["concept_aabb_scan_pass"] is True
    assert all(check["component_pair_count"] >= 1 for check in battery_scope["concept_aabb_pair_checks"])
    assert report["required_evidence_class"] == (
        "physical_supplier_brep_boolean_interference_result"
    )
    assert "evidence_class=physical_supplier_brep_boolean_interference_result" in report[
        "release_rule"
    ]
    assert (tmp_path / "full-cad-boolean-interference-results-template.csv").is_file()
    assert (tmp_path / "full-cad-boolean-interference.json").is_file()
    assert (tmp_path / "full-cad-boolean-interference.md").is_file()


def test_evt0_phone_readiness_audit_tracks_release_boundary(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    parts = cad.build_parts(params)
    tooling = cad.tooling_parts(params)
    checks = cad.run_checks(params, parts)
    review = tmp_path / "review"
    out = tmp_path / "out"
    review.mkdir()
    out.mkdir()
    monkeypatch.setattr(cad, "REVIEW_DIR", review)
    monkeypatch.setattr(cad, "OUT_DIR", out)

    (out / "assembly-manifest.json").write_text(json.dumps([{"name": "assembly"}]))
    (out / "tooling-manifest.json").write_text(json.dumps([{"name": "tooling"}]))
    (out / "e1-phone-assembly.glb").write_bytes(b"glb")
    (out / "e1-phone-mold-tooling.glb").write_bytes(b"glb")
    (out / "e1-phone-evt-fixtures.glb").write_bytes(b"glb")
    for name in [
        "e1-phone-solid-assembly.step",
        "orange_back_shell.step",
        "orange_side_frame.step",
        "screen_cover_glass.step",
        "main_pcb.step",
        "battery_back_void_foam_pad.step",
        "usb_c_receptacle.step",
        "usb_c_external_aperture.step",
        "usb_c_perimeter_gasket_top.step",
        "usb_c_perimeter_gasket_bottom.step",
        "usb_c_perimeter_gasket_left.step",
        "usb_c_perimeter_gasket_right.step",
        "usb_c_molded_drip_break_lip.step",
        "usb_c_internal_drain_shelf.step",
        "bottom_mic.step",
        "top_mic.step",
        "bottom_speaker_module.step",
        "earpiece_receiver.step",
        "handset_acoustic_slot.step",
        "handset_acoustic_mesh.step",
        "bottom_speaker_dust_mesh.step",
        "bottom_microphone_mesh_1.step",
        "bottom_microphone_mesh_2.step",
        "top_microphone_port.step",
        "top_microphone_mesh.step",
        "rear_camera_module.step",
        "rear_camera_shell_aperture.step",
        "orange_rear_camera_bezel_top.step",
        "orange_rear_camera_bezel_bottom.step",
        "orange_rear_camera_bezel_left.step",
        "orange_rear_camera_bezel_right.step",
        "rear_camera_cover_glass.step",
        "rear_camera_cover_adhesive_top.step",
        "rear_camera_cover_adhesive_bottom.step",
        "rear_camera_cover_adhesive_left.step",
        "rear_camera_cover_adhesive_right.step",
        "rear_camera_light_baffle_top.step",
        "rear_camera_light_baffle_bottom.step",
        "front_camera_module.step",
        "front_camera_under_glass.step",
        "front_camera_black_mask_window.step",
        "power_button_cap.step",
        "volume_button_cap.step",
        "power_button_elastomer_gasket.step",
        "power_button_labyrinth_upper_rail.step",
        "power_button_labyrinth_lower_rail.step",
        "volume_button_elastomer_gasket.step",
        "volume_button_labyrinth_upper_rail.step",
        "volume_button_labyrinth_lower_rail.step",
        "screen_adhesive_top.step",
        "display_fpc_connector.step",
        "orange_usb_reinforcement_saddle.step",
        "split_interconnect_top_connector.step",
        "split_interconnect_bottom_connector.step",
        "split_interconnect_side_flex.step",
        "split_interconnect_top_flex_tail.step",
        "split_interconnect_bottom_flex_tail.step",
    ]:
        (out / name).write_text("ISO-10303-21;")
    (out / "evt-fixture-manifest.json").write_text(json.dumps([{"name": "fixture"}]))
    for name in [
        "fit-check-report.json",
        "visual-review.json",
        "manufacturing_drawing.json",
        "battery-swell-management.json",
        "battery-swell-management.md",
        "mass-budget.json",
        "compactness-optimization.json",
        "compactness-optimization.md",
        "compactness-optimization.png",
        "compactness-optimization.svg",
        "supplier-lock.json",
        "supplier-rfq-package.json",
        "supplier-rfq-package.md",
        "supplier-response-template.csv",
        "supplier-response-review.json",
        "supplier-response-review.md",
        "kicad-mechanical-handoff.json",
        "kicad-placement-reconciliation.json",
        "kicad-placement-reconciliation.md",
        "board-step-readiness.json",
        "board-step-readiness.md",
        "engineering-validation.json",
        "engineering-validation.md",
        "interface-validation.json",
        "interface-validation.md",
        "display-validation.json",
        "display-validation.md",
        "display-results-template.csv",
        "display-results-review.json",
        "display-results-review.md",
        "acoustic-validation.json",
        "acoustic-validation.md",
        "acoustic-results-template.csv",
        "acoustic-results-review.json",
        "acoustic-results-review.md",
        "camera-validation.json",
        "camera-validation.md",
        "camera-results-template.csv",
        "camera-results-review.json",
        "camera-results-review.md",
        "environmental-validation.json",
        "environmental-validation.md",
        "environmental-results-template.csv",
        "environmental-results-review.json",
        "environmental-results-review.md",
        "evt-fixtures.json",
        "evt-fixtures.md",
        "evt-inspection-plan.json",
        "evt-inspection-plan.md",
        "evt-inspection-results-template.csv",
        "evt-results-review.json",
        "evt-results-review.md",
        "assembly-clearance.json",
        "assembly-clearance.md",
        "injection-molding-dfm.json",
        "injection-molding-dfm.md",
        "mold-process-window.json",
        "mold-process-window.md",
        "tooling-action-register.json",
        "tooling-action-register.csv",
        "tooling-action-register.md",
        "toolmaker-signoff-package.json",
        "toolmaker-signoff-package.md",
        "toolmaker-signoff-response-template.csv",
        "toolmaker-signoff-review.json",
        "toolmaker-signoff-review.md",
        "tolerance-stack.json",
        "tolerance-stack.md",
        "gdt-release-package.json",
        "gdt-release-package.md",
        "gdt-fai-template.csv",
        "gdt-fai-results-review.json",
        "gdt-fai-results-review.md",
        "part-review.json",
        "part-review.md",
        "part-review-contact-sheet.png",
        "part-explode-contact-sheet.png",
        "solid-cad-handoff.json",
        "solid-cad-handoff.md",
        "step-validation.json",
        "step-validation.md",
        "full_front_iso.png",
        "full_back_iso.png",
        "rear_feature_detail.png",
        "full_left_side.png",
        "full_bottom_port.png",
        "component_stack.png",
        "full_top_down.png",
        "component-review-audio.png",
        "component-review-io-buttons.png",
        "component-review-optical.png",
        "mold_tooling.png",
    ]:
        (review / name).write_text("{}")

    visual = passing_visual_review()
    mass = cad.mass_budget(parts)
    compactness = cad.write_compactness_optimization_artifacts(params, parts, checks)
    supplier = cad.supplier_matrix(params)
    handoff = {
        "constraints": [
            {"id": "display_fpc_zone"},
            {"id": "usb_c_mechanical_capture"},
            {"id": "battery_window"},
        ]
    }
    kicad_reconciliation = {
        "status": "cad_kicad_placement_reconciled",
        "footprint_cases": [{"id": "J_USB_C"}],
        "cad_projection_cases": [{"id": "J_USB_C"}],
    }
    validation = cad.write_engineering_validation_artifacts(params, parts, checks, mass, supplier)
    clearance = cad.write_assembly_clearance_artifacts(params, parts)
    cad.write_battery_swell_management_artifacts(params, parts, checks, clearance)
    part_review = cad.write_part_review_artifacts(parts)
    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    gdt_release = cad.write_gdt_release_package_artifacts(params, tolerance_stack)
    gdt_fai_results = cad.write_gdt_fai_results_review_artifacts(gdt_release)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    display_validation = cad.write_display_validation_artifacts(
        params, parts, clearance, interface_validation, tolerance_stack
    )
    display_results = cad.write_display_results_review_artifacts(display_validation)
    mechanical_integration_sim = cad.write_mechanical_integration_sim_artifacts(
        params,
        parts,
        interface_validation,
        display_validation,
    )
    acoustic_validation = cad.write_acoustic_validation_artifacts(
        params, parts, clearance, interface_validation
    )
    acoustic_results = cad.write_acoustic_results_review_artifacts(acoustic_validation)
    camera_validation = cad.write_camera_validation_artifacts(
        params, parts, clearance, interface_validation
    )
    camera_results = cad.write_camera_results_review_artifacts(camera_validation)
    environmental_validation = cad.write_environmental_validation_artifacts(
        params, parts, checks, clearance, validation
    )
    ingress_path_review = cad.write_ingress_path_review_artifacts(
        params, parts, environmental_validation
    )
    environmental_results = cad.write_environmental_results_review_artifacts(
        environmental_validation
    )
    fixtures = cad.evt_fixture_parts(params)
    evt_fixtures = cad.write_evt_fixture_artifacts(params, fixtures, interface_validation)
    evt_inspection = cad.write_evt_inspection_plan_artifacts(
        params, interface_validation, evt_fixtures
    )
    evt_results = cad.write_evt_results_review_artifacts(evt_inspection)
    mold_process = cad.write_mold_process_window_artifacts(
        params, parts, tooling, dfm, tolerance_stack
    )
    toolmaker_signoff = cad.write_toolmaker_signoff_artifacts(params, dfm, mold_process)
    visual_decision = cad.write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )
    solid_cad = {
        "status": "generated",
        "part_count": 62,
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
    }
    step_validation = {"status": "pass", "validated_count": 62}
    board_step = {
        "status": "blocked_concept_pcb_no_routed_step",
        "board_state_detected": {
            "has_tracks": False,
            "has_production_step": False,
        },
    }
    supplier_rfq = {"status": "rfq_ready", "packages": [{"id": "display_touch_stack"}]}
    supplier_response = {
        "status": "blocked_no_supplier_responses",
        "complete_response_count": 0,
        "expected_response_count": len(supplier["items"]) + 1,
    }
    component_selection = cad.write_component_selection_review_artifacts(params, checks)
    cad.write_readiness_artifacts(
        params,
        parts,
        tooling,
        checks,
        visual,
        mass,
        compactness,
        supplier,
        handoff,
        kicad_reconciliation,
        validation,
        interface_validation,
        display_validation,
        display_results,
        mechanical_integration_sim,
        acoustic_validation,
        acoustic_results,
        camera_validation,
        camera_results,
        environmental_validation,
        ingress_path_review,
        environmental_results,
        evt_fixtures,
        evt_inspection,
        evt_results,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
        gdt_release,
        gdt_fai_results,
        mold_process,
        toolmaker_signoff,
        visual_decision,
        solid_cad,
        step_validation,
        board_step,
        supplier_rfq,
        supplier_response,
    )
    readiness = json.loads((review / "manufacturing-readiness.json").read_text())

    assert readiness["overall_status"] == "cad_package_pass"
    assert readiness["manufacturing_release_ready"] is False
    assert readiness["subsystem_evidence_present"]["molded_orange_enclosure"]
    assert readiness["subsystem_evidence_present"]["compact_envelope_optimization"]
    assert readiness["required_outputs"]["compactness_optimization"]
    assert readiness["subsystem_evidence_present"]["component_selection_review"]
    assert readiness["required_outputs"]["component_selection_review"]
    assert component_selection["status"] == "cad_component_selection_review_ready"
    assert readiness["subsystem_evidence_present"]["battery_swell_management"]
    assert readiness["required_outputs"]["battery_swell_management"]
    assert readiness["parameters"]["compactness_status"] == "cad_compactness_optimized"
    assert readiness["parameters"]["compactness_width_excess_mm"] <= 1.0
    assert readiness["parameters"]["compactness_height_excess_mm"] <= 1.5
    assert readiness["subsystem_evidence_present"]["rf_shielding_haptics_service"]
    assert readiness["required_outputs"]["kicad_placement_reconciliation"]
    assert readiness["required_outputs"]["mechanical_integration_sim"]
    assert (
        readiness["parameters"]["mechanical_integration_sim_status"]
        == "cad_mechanical_integration_sim_ready"
    )
    assert readiness["required_outputs"]["board_step_readiness"]
    assert (
        readiness["parameters"]["kicad_placement_reconciliation_status"]
        == "cad_kicad_placement_reconciled"
    )
    assert (
        readiness["parameters"]["board_step_readiness_status"]
        == "blocked_concept_pcb_no_routed_step"
    )
    assert readiness["parameters"]["board_step_has_tracks"] is False
    assert readiness["parameters"]["board_step_has_production_step"] is False
    assert readiness["subsystem_evidence_present"]["injection_mold_tooling"]
    assert readiness["subsystem_evidence_present"]["assembly_clearance"]
    assert readiness["subsystem_evidence_present"]["engineering_validation_plan"]
    assert readiness["required_outputs"]["interface_validation"]
    assert readiness["parameters"]["interface_validation_status"] == "cad_interface_validation_pass"
    assert readiness["parameters"]["interface_validation_case_count"] >= 7
    assert readiness["subsystem_evidence_present"]["screen_stack"]
    assert readiness["required_outputs"]["display_validation"]
    assert readiness["required_outputs"]["display_results_review"]
    assert readiness["parameters"]["display_validation_status"] == "cad_display_validation_ready"
    assert readiness["parameters"]["display_measurement_count"] >= 7
    assert readiness["parameters"]["display_results_status"] == "blocked_no_display_results"
    assert readiness["parameters"]["display_results_complete_count"] == 0
    assert readiness["subsystem_evidence_present"]["display_touch_results"]
    assert readiness["required_outputs"]["acoustic_validation"]
    assert readiness["required_outputs"]["acoustic_results_review"]
    assert readiness["parameters"]["acoustic_validation_status"] == "cad_acoustic_validation_ready"
    assert readiness["parameters"]["acoustic_measurement_count"] >= 7
    assert readiness["parameters"]["acoustic_results_status"] == "blocked_no_acoustic_results"
    assert readiness["parameters"]["acoustic_results_complete_count"] == 0
    assert readiness["required_outputs"]["camera_validation"]
    assert readiness["required_outputs"]["camera_results_review"]
    assert readiness["parameters"]["camera_validation_status"] == "cad_camera_validation_ready"
    assert readiness["parameters"]["camera_measurement_count"] >= 7
    assert readiness["parameters"]["camera_results_status"] == "blocked_no_camera_results"
    assert readiness["parameters"]["camera_results_complete_count"] == 0
    assert readiness["required_outputs"]["environmental_validation"]
    assert readiness["required_outputs"]["environmental_results_review"]
    assert (
        readiness["parameters"]["environmental_validation_status"]
        == "cad_environmental_validation_ready"
    )
    assert readiness["parameters"]["ingress_path_review_status"] == "cad_ingress_path_review_ready"
    assert readiness["parameters"]["ingress_path_count"] >= 8
    assert readiness["parameters"]["environmental_measurement_count"] >= 9
    assert (
        readiness["parameters"]["environmental_results_status"]
        == "blocked_no_environmental_results"
    )
    assert readiness["parameters"]["environmental_results_complete_count"] == 0
    assert readiness["subsystem_evidence_present"]["thermal_rf_drop_ingress_validation"]
    assert readiness["subsystem_evidence_present"]["environmental_lab_results"]
    assert readiness["required_outputs"]["evt_validation_fixtures"]
    assert readiness["parameters"]["evt_fixture_status"] == "evt_fixture_cad_ready"
    assert readiness["parameters"]["evt_fixture_count"] >= 7
    assert readiness["required_outputs"]["evt_inspection_plan"]
    assert readiness["parameters"]["evt_inspection_status"] == "evt_inspection_plan_ready"
    assert readiness["parameters"]["evt_inspection_measurement_count"] >= 10
    assert readiness["required_outputs"]["evt_results_review"]
    assert readiness["parameters"]["evt_results_status"] == "blocked_no_physical_results"
    assert readiness["parameters"]["evt_results_populated_count"] == 0
    assert readiness["subsystem_evidence_present"]["tolerance_release_package"]
    assert readiness["subsystem_evidence_present"]["physical_evt_results"]
    assert readiness["required_outputs"]["mold_process_window"]
    assert readiness["required_outputs"]["tooling_action_register"]
    assert readiness["parameters"]["mold_process_window_status"] == "cad_mold_process_window_ready"
    assert readiness["required_outputs"]["toolmaker_signoff_package"]
    assert readiness["parameters"]["toolmaker_signoff_status"] == "blocked_no_toolmaker_signoff"
    assert readiness["parameters"]["toolmaker_signoff_complete_count"] == 0
    assert readiness["subsystem_evidence_present"]["visual_aesthetic_decision_log"]
    assert readiness["subsystem_evidence_present"]["solid_cad_handoff"]
    assert readiness["subsystem_evidence_present"]["supplier_rfq_package"]
    assert readiness["subsystem_evidence_present"]["supplier_returned_evidence"]
    assert readiness["required_outputs"]["supplier_lock"]
    assert readiness["required_outputs"]["supplier_rfq_package"]
    assert readiness["required_outputs"]["supplier_response_review"]
    assert readiness["required_outputs"]["kicad_mechanical_handoff"]
    assert readiness["required_outputs"]["engineering_validation"]
    assert readiness["required_outputs"]["assembly_clearance"]
    assert readiness["required_outputs"]["injection_molding_dfm"]
    assert readiness["required_outputs"]["tolerance_stack"]
    assert readiness["required_outputs"]["gdt_release_package"]
    assert readiness["required_outputs"]["gdt_fai_results_review"]
    assert readiness["required_outputs"]["visual_decision_report"]
    assert readiness["required_outputs"]["solid_cad_handoff"]
    assert readiness["required_outputs"]["part_review"]
    assert readiness["parameters"]["injection_molding_dfm_status"] == "cad_dfm_inputs_ready"
    assert readiness["parameters"]["tolerance_stack_status"] == "cad_tolerance_stack_pass"
    assert readiness["parameters"]["gdt_release_status"] == "gdt_release_package_ready"
    assert readiness["parameters"]["gdt_characteristic_count"] >= len(
        tolerance_stack["drawing_requirements"]
    )
    assert readiness["parameters"]["gdt_fai_results_status"] == "blocked_no_fai_results"
    assert readiness["parameters"]["gdt_fai_results_complete_count"] == 0
    assert readiness["parameters"]["visual_decision_status"] == "pass"
    assert (
        readiness["parameters"]["automated_visual_status"]
        == "automated_visual_coverage_pass"
    )
    assert (
        readiness["parameters"]["manual_visual_signoff_status"]
        == "blocked_manual_visual_review_open"
    )
    assert readiness["parameters"]["production_visual_signoff_ready"] is False
    assert readiness["parameters"]["open_manual_visual_review_count"] > 0
    assert readiness["parameters"]["solid_cad_handoff_status"] == "generated"
    assert readiness["parameters"]["solid_cad_step_part_count"] >= 50
    assert readiness["parameters"]["step_validation_status"] == "pass"
    assert readiness["parameters"]["supplier_rfq_status"] == "rfq_ready"
    assert readiness["parameters"]["supplier_response_status"] == "blocked_no_supplier_responses"
    assert readiness["parameters"]["supplier_response_complete_count"] == 0
    assert "GD&T" in " ".join(readiness["why_not_release_ready"])


def test_evt0_phone_fit_report_writes_flat_check_schema(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    cad.write_report(params, checks)
    report = json.loads((tmp_path / "fit-check-report.json").read_text())

    assert report["status"] == "pass"
    assert report["checks"]["rf_antenna_keepouts"]["pass"]
    assert report["checks"]["mold_ejector_cooling_model"]["pass"]
    assert "status" not in report["checks"]
    assert (
        report["artifacts"]["routed_board_step_intake_template"]
        == "mechanical/e1-phone/review/routed-board-step-intake-template.csv"
    )
    assert (
        report["artifacts"]["visual_review_coverage_acceptance_json"]
        == "mechanical/e1-phone/review/visual-review-coverage-acceptance.json"
    )
    assert (
        report["artifacts"]["part_explode_contact_sheet"]
        == "mechanical/e1-phone/review/part-explode-contact-sheet.png"
    )
    assert (
        report["artifacts"]["component_selection_review_json"]
        == "mechanical/e1-phone/review/component-selection-review.json"
    )
    assert (
        report["artifacts"]["physical_process_validation_acceptance_json"]
        == "mechanical/e1-phone/review/physical-process-validation-acceptance.json"
    )
    assert (
        report["artifacts"]["tooling_action_register_json"]
        == "mechanical/e1-phone/review/tooling-action-register.json"
    )
    assert (
        report["artifacts"]["battery_swell_management_json"]
        == "mechanical/e1-phone/review/battery-swell-management.json"
    )
    assert (
        report["artifacts"]["end_to_end_objective_acceptance_json"]
        == "mechanical/e1-phone/review/end-to-end-objective-acceptance.json"
    )
    readme = (tmp_path / "README.md").read_text()
    assert "routed-board-step-intake-template.csv" in readme
    assert "visual-review-coverage-acceptance.json" in readme
    assert "tooling-action-register.json" in readme
    assert "battery-swell-management.json" in readme
    assert "physical-process-validation-acceptance.json" in readme
    assert "end-to-end-objective-acceptance.json" in readme
