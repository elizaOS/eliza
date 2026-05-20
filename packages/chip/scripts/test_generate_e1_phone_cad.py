#!/usr/bin/env python3
import importlib.util
import json
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
    assert report["checks"]["component_presence"]["pass"]
    assert report["checks"]["rounded_enclosure_geometry"]["pass"]
    assert report["checks"]["mesh_integrity"]["pass"]
    assert report["checks"]["usb_c_insertion_envelope"]["pass"]
    assert report["checks"]["bottom_io_acoustic_apertures"]["pass"]
    assert report["checks"]["button_force_and_travel"]["pass"]
    assert report["checks"]["button_pressure_support"]["pass"]
    assert report["checks"]["screen_mount_and_connection"]["pass"]
    assert report["checks"]["camera_speaker_behind_glass"]["pass"]
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
        "usb_c_receptacle",
        "bottom_speaker_module",
        "earpiece_receiver",
        "rear_camera_module",
        "front_camera_module",
        "power_button_cap",
        "volume_button_cap",
        "handset_acoustic_slot",
        "screen_adhesive_top",
        "screen_adhesive_bottom",
        "display_fpc_connector",
        "orange_usb_reinforcement_saddle",
        "bottom_speaker_acoustic_chamber",
        "earpiece_gasket",
        "usb_c_external_aperture",
        "bottom_speaker_grille_slot_1",
        "bottom_microphone_port_1",
        "orange_screw_boss_1",
        "orange_snap_hook_1",
        "cellular_top_antenna_keepout",
        "cellular_bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
        "soc_shield_can",
        "pmic_shield_can",
        "radio_shield_can",
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
    assert depth <= 10.0
    assert Path(cad.PARAMS).is_file()


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


@pytest.mark.skipif(not _cadquery_available, reason="cadquery not installed")
def test_evt0_phone_step_validation_reimports_step_files(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "OUT_DIR", tmp_path / "out")
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path / "review")
    cad.OUT_DIR.mkdir()
    cad.REVIEW_DIR.mkdir()

    solid_cad = cad.write_solid_cad_handoff_artifacts(params, checks)
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
        "sample_id,measurement_id,fixture,units,min,max,nominal,measured,pass,operator,notes"
        in csv_text
    )
    assert "USB-C" in csv_text
    assert (review / "evt-inspection-plan.json").is_file()
    assert (review / "evt-inspection-plan.md").is_file()


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
    assert clearance["status"] == "pass"
    assert {
        "battery_to_pcb_islands",
        "haptic_to_battery",
        "haptic_to_pcb_islands",
        "usb_to_bottom_speaker",
    }.issubset(case_ids)
    assert (tmp_path / "part-review-contact-sheet.png").is_file()
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
    assert {view["file"] for view in report["review_views"]} == set(visual)
    decision_ids = {decision["id"] for decision in report["decisions"]}
    assert "compact_orange_shell" in decision_ids
    assert "under_glass_front_camera_and_earpiece" in decision_ids
    assert "rear_camera_cover_window" in decision_ids
    assert "bottom_io_pattern" in decision_ids
    assert "injection_mold_tooling_placeholders" in decision_ids
    assert report["status_inputs"]["front_back_render_distinct"]
    assert report["visual_deltas"]["front_back_mean_rgb_sum_delta"] >= 8.0
    assert any("rear feature proportions" in item for item in report["manual_review_items"])
    assert (tmp_path / "visual-decision-report.json").is_file()
    assert (tmp_path / "visual-decision-report.md").is_file()


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

    assert dfm["status"] == "cad_dfm_inputs_ready"
    assert {
        "nominal_wall",
        "rib_to_wall_ratio",
        "boss_wall_to_nominal_wall",
        "submarine_gate_ratio",
        "cooling_channel_clearance",
    }.issubset(case_ids)
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
        "usb_c_receptacle.step",
        "usb_c_external_aperture.step",
        "bottom_mic.step",
        "top_mic.step",
        "bottom_speaker_module.step",
        "earpiece_receiver.step",
        "handset_acoustic_slot.step",
        "rear_camera_module.step",
        "rear_camera_cover_glass.step",
        "front_camera_module.step",
        "front_camera_under_glass.step",
        "power_button_cap.step",
        "volume_button_cap.step",
        "screen_adhesive_top.step",
        "display_fpc_connector.step",
        "orange_usb_reinforcement_saddle.step",
    ]:
        (out / name).write_text("ISO-10303-21;")
    (out / "evt-fixture-manifest.json").write_text(json.dumps([{"name": "fixture"}]))
    for name in [
        "fit-check-report.json",
        "visual-review.json",
        "manufacturing_drawing.json",
        "mass-budget.json",
        "supplier-lock.json",
        "supplier-rfq-package.json",
        "supplier-rfq-package.md",
        "kicad-mechanical-handoff.json",
        "kicad-placement-reconciliation.json",
        "kicad-placement-reconciliation.md",
        "engineering-validation.json",
        "engineering-validation.md",
        "interface-validation.json",
        "interface-validation.md",
        "evt-fixtures.json",
        "evt-fixtures.md",
        "evt-inspection-plan.json",
        "evt-inspection-plan.md",
        "evt-inspection-results-template.csv",
        "assembly-clearance.json",
        "assembly-clearance.md",
        "injection-molding-dfm.json",
        "injection-molding-dfm.md",
        "mold-process-window.json",
        "mold-process-window.md",
        "tolerance-stack.json",
        "tolerance-stack.md",
        "part-review.json",
        "part-review.md",
        "part-review-contact-sheet.png",
        "solid-cad-handoff.json",
        "solid-cad-handoff.md",
        "step-validation.json",
        "step-validation.md",
        "full_front_iso.png",
        "full_back_iso.png",
        "rear_feature_detail.png",
        "full_bottom_port.png",
        "component_stack.png",
        "full_top_down.png",
        "mold_tooling.png",
    ]:
        (review / name).write_text("{}")

    visual = passing_visual_review()
    mass = cad.mass_budget(parts)
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
    part_review = cad.write_part_review_artifacts(parts)
    dfm = cad.write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = cad.write_tolerance_stack_artifacts(params, checks)
    interface_validation = cad.write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    fixtures = cad.evt_fixture_parts(params)
    evt_fixtures = cad.write_evt_fixture_artifacts(params, fixtures, interface_validation)
    evt_inspection = cad.write_evt_inspection_plan_artifacts(
        params, interface_validation, evt_fixtures
    )
    mold_process = cad.write_mold_process_window_artifacts(
        params, parts, tooling, dfm, tolerance_stack
    )
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
        "part_count": 57,
        "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
    }
    step_validation = {"status": "pass", "validated_count": 57}
    supplier_rfq = {"status": "rfq_ready", "packages": [{"id": "display_touch_stack"}]}
    cad.write_readiness_artifacts(
        params,
        parts,
        tooling,
        checks,
        visual,
        mass,
        supplier,
        handoff,
        kicad_reconciliation,
        validation,
        interface_validation,
        evt_fixtures,
        evt_inspection,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
        mold_process,
        visual_decision,
        solid_cad,
        step_validation,
        supplier_rfq,
    )
    readiness = json.loads((review / "manufacturing-readiness.json").read_text())

    assert readiness["overall_status"] == "cad_package_pass"
    assert readiness["manufacturing_release_ready"] is False
    assert readiness["subsystem_evidence_present"]["molded_orange_enclosure"]
    assert readiness["subsystem_evidence_present"]["rf_shielding_haptics_service"]
    assert readiness["required_outputs"]["kicad_placement_reconciliation"]
    assert (
        readiness["parameters"]["kicad_placement_reconciliation_status"]
        == "cad_kicad_placement_reconciled"
    )
    assert readiness["subsystem_evidence_present"]["injection_mold_tooling"]
    assert readiness["subsystem_evidence_present"]["assembly_clearance"]
    assert readiness["subsystem_evidence_present"]["engineering_validation_plan"]
    assert readiness["required_outputs"]["interface_validation"]
    assert readiness["parameters"]["interface_validation_status"] == "cad_interface_validation_pass"
    assert readiness["parameters"]["interface_validation_case_count"] >= 7
    assert readiness["required_outputs"]["evt_validation_fixtures"]
    assert readiness["parameters"]["evt_fixture_status"] == "evt_fixture_cad_ready"
    assert readiness["parameters"]["evt_fixture_count"] >= 7
    assert readiness["required_outputs"]["evt_inspection_plan"]
    assert readiness["parameters"]["evt_inspection_status"] == "evt_inspection_plan_ready"
    assert readiness["parameters"]["evt_inspection_measurement_count"] >= 10
    assert readiness["subsystem_evidence_present"]["tolerance_release_package"]
    assert readiness["required_outputs"]["mold_process_window"]
    assert readiness["parameters"]["mold_process_window_status"] == "cad_mold_process_window_ready"
    assert readiness["subsystem_evidence_present"]["visual_aesthetic_decision_log"]
    assert readiness["subsystem_evidence_present"]["solid_cad_handoff"]
    assert readiness["subsystem_evidence_present"]["supplier_rfq_package"]
    assert readiness["required_outputs"]["supplier_lock"]
    assert readiness["required_outputs"]["supplier_rfq_package"]
    assert readiness["required_outputs"]["kicad_mechanical_handoff"]
    assert readiness["required_outputs"]["engineering_validation"]
    assert readiness["required_outputs"]["assembly_clearance"]
    assert readiness["required_outputs"]["injection_molding_dfm"]
    assert readiness["required_outputs"]["tolerance_stack"]
    assert readiness["required_outputs"]["visual_decision_report"]
    assert readiness["required_outputs"]["solid_cad_handoff"]
    assert readiness["required_outputs"]["part_review"]
    assert readiness["parameters"]["injection_molding_dfm_status"] == "cad_dfm_inputs_ready"
    assert readiness["parameters"]["tolerance_stack_status"] == "cad_tolerance_stack_pass"
    assert readiness["parameters"]["visual_decision_status"] == "pass"
    assert readiness["parameters"]["solid_cad_handoff_status"] == "generated"
    assert readiness["parameters"]["solid_cad_step_part_count"] >= 50
    assert readiness["parameters"]["step_validation_status"] == "pass"
    assert readiness["parameters"]["supplier_rfq_status"] == "rfq_ready"
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
