#!/usr/bin/env python3
import json
from pathlib import Path

import generate_e1_phone_cad as cad


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

    assert width <= 78.5
    assert height <= 154.0
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


def test_evt0_phone_kicad_handoff_includes_mechanical_constraints(tmp_path, monkeypatch) -> None:
    params = cad.load_params()
    checks = cad.run_checks(params, cad.build_parts(params))
    monkeypatch.setattr(cad, "REVIEW_DIR", tmp_path)

    handoff = cad.write_kicad_mechanical_handoff(params, checks)
    constraint_ids = {item["id"] for item in handoff["constraints"]}

    assert "display_fpc_zone" in constraint_ids
    assert "usb_c_mechanical_capture" in constraint_ids
    assert "battery_window" in constraint_ids
    assert (tmp_path / "kicad-mechanical-handoff.json").is_file()


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
    for name in [
        "fit-check-report.json",
        "visual-review.json",
        "manufacturing_drawing.json",
        "mass-budget.json",
        "supplier-lock.json",
        "kicad-mechanical-handoff.json",
        "full_top_down.png",
        "mold_tooling.png",
    ]:
        (review / name).write_text("{}")

    visual = {"full_top_down.png": {"pass": True}, "mold_tooling.png": {"pass": True}}
    mass = cad.mass_budget(parts)
    supplier = cad.supplier_matrix(params)
    handoff = {
        "constraints": [
            {"id": "display_fpc_zone"},
            {"id": "usb_c_mechanical_capture"},
            {"id": "battery_window"},
        ]
    }
    cad.write_readiness_artifacts(params, parts, tooling, checks, visual, mass, supplier, handoff)
    readiness = json.loads((review / "manufacturing-readiness.json").read_text())

    assert readiness["overall_status"] == "cad_package_pass"
    assert readiness["manufacturing_release_ready"] is False
    assert readiness["subsystem_evidence_present"]["molded_orange_enclosure"]
    assert readiness["subsystem_evidence_present"]["rf_shielding_haptics_service"]
    assert readiness["subsystem_evidence_present"]["injection_mold_tooling"]
    assert readiness["required_outputs"]["supplier_lock"]
    assert readiness["required_outputs"]["kicad_mechanical_handoff"]
    assert "GD&T" in " ".join(readiness["why_not_release_ready"])
