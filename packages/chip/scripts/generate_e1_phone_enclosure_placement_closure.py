#!/usr/bin/env python3
"""Generate PCB-to-enclosure placement closure for the E1 phone package."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/enclosure-placement-closure.yaml"
METRICS = ROOT / "docs/board/e1-phone-mainboard-metrics.yaml"
ENCLOSURE = ROOT / "docs/board/e1-phone-enclosure-interface.yaml"
DISPLAY_FIT = ROOT / "board/kicad/e1-phone/display-fit.yaml"
OVERLAY = ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml"
FIT = ROOT / "mechanical/e1-phone/review/fit-check-report.json"
CLEARANCE = ROOT / "mechanical/e1-phone/review/assembly-clearance.json"
HANDOFF = ROOT / "mechanical/e1-phone/review/kicad-mechanical-handoff.json"
SOLID = ROOT / "mechanical/e1-phone/review/solid-cad-handoff.json"
READINESS = ROOT / "mechanical/e1-phone/review/manufacturing-readiness.json"
ASSEMBLY_MANIFEST = ROOT / "mechanical/e1-phone/out/assembly-manifest.json"
MECH_OUT = ROOT / "mechanical/e1-phone/out"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def load_json(path: Path) -> Any:
    with path.open() as handle:
        return json.load(handle)


def file_status(rel: str) -> dict[str, Any]:
    path = ROOT / rel
    return {
        "path": rel,
        "present": path.is_file(),
        "bytes": path.stat().st_size if path.is_file() else 0,
    }


def round_mm(value: float) -> float:
    rounded = round(value, 3)
    return rounded + 0.0 if rounded != 0 else 0.0


def rss(values: list[float]) -> float:
    """Root-sum-square combination for independent statistical tolerance contributors."""
    return sum(value * value for value in values) ** 0.5


def z_stack_budget(fit: dict[str, Any], enclosure: dict[str, Any]) -> dict[str, Any]:
    """Cross-check the front-to-back component height stack against the flush-back
    interior depth budget using the EVT0 CAD fit-check z-coordinates, then carry an
    explicit end-of-life worst case: LiPo swell plus the molded/placement tolerance
    stack-up.

    The fit-check report carries the interior z-coordinates that the CAD solver placed
    at the flush-back thickness. Those coordinates are the load-bearing geometry: every
    derived gap is recomputed here so this closure fails closed if the CAD drifts away
    from the published envelope.

    The CAD geometry uses a two-gap battery channel: a small static gap on the display
    side that must never close (closing it cracks the panel) and a larger swell void on
    the back-shell side that absorbs cell growth. The worst-case proof tracks both:
    swell is vented to the back void by design, so the failure modes are (a) the back
    void closing past zero (back-shell bulge at end of life) and (b) tolerance eroding
    the display-side static gap to zero (panel crack). A single nominal "residual = 0"
    number hides both; this function reports the swelled, tolerance-loaded residual for
    each.
    """
    device = fit["params"]["device"]
    envelope_thickness = float(device["envelope_mm"][2])
    wall = float(device["wall_thickness_mm"])
    battery = fit["params"]["battery"]
    clearance_case = fit["checks"]["battery_display_and_wall_clearance"]

    display_back_z = float(clearance_case["display_lcm_back_z_mm"])
    battery_front_z = float(clearance_case["battery_front_z_mm"])
    battery_back_z = float(clearance_case["battery_back_z_mm"])
    back_inner_wall_z = float(clearance_case["back_inner_wall_z_mm"])
    front_static_gap_required = float(clearance_case["required_front_static_gap_mm"])
    back_swell_gap_required = float(clearance_case["required_back_swell_gap_mm"])

    interior_depth = envelope_thickness - 2.0 * wall
    display_to_back_wall_span = display_back_z - back_inner_wall_z
    battery_thickness = battery_front_z - battery_back_z
    display_to_battery_gap = display_back_z - battery_front_z
    battery_to_back_wall_gap = battery_back_z - back_inner_wall_z
    occupied = battery_thickness + display_to_battery_gap + battery_to_back_wall_gap
    interior_residual = display_to_back_wall_span - occupied

    # LiPo pouch swell: 8-10 percent of cell thickness over service life.
    swell_pct_low = 8.0
    swell_pct_high = 10.0
    swell_low_mm = battery_thickness * swell_pct_low / 100.0
    swell_high_mm = battery_thickness * swell_pct_high / 100.0
    declared_swell_void_mm = float(battery.get("battery_swell_gap_mm", battery_to_back_wall_gap))

    # Stack-up tolerance budget from the CAD process-contributor table. Each contributor
    # can erode the swell void or the static gap; plastic shrink applies to the molded
    # interior depth that sets the back inner wall position.
    contributors = fit["params"]["tolerances"]["process_contributors"]
    shrink_pct = float(contributors["plastic_shrink_pct"])
    shrink_mm = interior_depth * shrink_pct / 100.0
    mold_mm = float(contributors["mold_dimension_tolerance_mm"])
    adhesive_mm = float(contributors["adhesive_cure_variance_mm"])
    placement_mm = float(contributors["assembly_placement_mm"])
    datasheet_mm = float(contributors["component_datasheet_typical_mm"])
    reflow_mm = float(contributors["solder_reflow_connector_float_mm"])

    # Contributors that can shift the battery body and the back inner wall together and
    # therefore erode the back swell void at worst case.
    back_void_terms = [shrink_mm, mold_mm, adhesive_mm, placement_mm, datasheet_mm, reflow_mm]
    tol_back_arith = sum(back_void_terms)
    tol_back_rss = rss(back_void_terms)

    # Contributors that can erode the display-side static gap (panel-crack guard): the
    # battery seat placement, the cell datasheet z-tolerance, and the display bond cure.
    front_gap_terms = [placement_mm, datasheet_mm, adhesive_mm]
    tol_front_arith = sum(front_gap_terms)
    tol_front_rss = rss(front_gap_terms)

    # Worst-case back swell void: swell vents to the back void, tolerance erodes it.
    back_void_residual_arith = battery_to_back_wall_gap - swell_high_mm - tol_back_arith
    back_void_residual_rss = battery_to_back_wall_gap - swell_high_mm - tol_back_rss

    # Worst-case display-side static gap: swell is vented away from the panel by design,
    # so only tolerance erodes this gap. Closing it to <= 0 cracks the panel.
    front_gap_residual_arith = display_to_battery_gap - tol_front_arith
    front_gap_residual_rss = display_to_battery_gap - tol_front_rss

    # Fail-closed gate: use the conservative arithmetic worst case. The panel must stay
    # uncracked (front gap > 0) AND the back void must not bulge the shell (back void
    # residual >= 0) at end-of-life worst case.
    panel_protected = round_mm(front_gap_residual_arith) > 0.0
    back_void_holds = round_mm(back_void_residual_arith) >= 0.0
    fits_worst_case = panel_protected and back_void_holds

    interface_battery_thickness = enclosure["z_stack_target"]["front_to_back"]
    interface_battery_layer = next(
        (layer for layer in interface_battery_thickness if layer["name"] == "battery_pack"),
        None,
    )
    interface_battery_target = (
        interface_battery_layer["thickness_mm"] if interface_battery_layer else None
    )

    gaps_meet_minimum = (
        round_mm(display_to_battery_gap) >= front_static_gap_required
        and round_mm(battery_to_back_wall_gap) >= back_swell_gap_required
    )
    span_fits_interior = round_mm(display_to_back_wall_span) <= round_mm(interior_depth) + 1e-6

    discrepancies = []
    fit_battery_thickness = float(battery["envelope_mm"][2])
    if abs(round_mm(battery_thickness) - fit_battery_thickness) > 0.01:
        discrepancies.append(
            "battery_z_extent_from_clearance_case "
            f"{round_mm(battery_thickness)}_mm != battery_param_thickness "
            f"{fit_battery_thickness}_mm"
        )
    if interface_battery_target not in {None, "5.6", 5.6}:
        discrepancies.append(
            "enclosure_interface_z_stack battery_pack thickness_mm "
            f"'{interface_battery_target}' differs from fit-check battery "
            f"{fit_battery_thickness} mm; reconcile the interface baseline before tolerance stack"
        )
    # The metrics/enclosure interface baselines still carry an 11.8 mm envelope while the
    # CAD source-of-truth has moved to the swelled depth; surface that drift explicitly.
    interface_envelope_thickness = float(
        enclosure["coordinate_system"]["device_envelope"]["max_thickness"]
    )
    if abs(interface_envelope_thickness - envelope_thickness) > 0.01:
        discrepancies.append(
            "enclosure_interface device_envelope max_thickness "
            f"{interface_envelope_thickness}_mm differs from fit-check CAD envelope "
            f"{round_mm(envelope_thickness)}_mm; the enclosure-interface baseline must be "
            "raised to the swell-void depth before tolerance-stack signoff"
        )

    # Honest mitigation accounting: if the back void is over budget at worst case, state
    # the over-budget and the exact upstream input that must change. The void itself is a
    # CAD input owned by generate_e1_phone_cad.py (battery_swell_gap_mm); this closure
    # cannot widen it, so it flags the required upstream delta and fails closed.
    over_budget_mm = round_mm(-back_void_residual_arith) if not back_void_holds else 0.0
    mitigation: list[str] = []
    if not back_void_holds:
        required_void_mm = round_mm(swell_high_mm + tol_back_arith)
        mitigation.append(
            "back_swell_void over budget by "
            f"{over_budget_mm} mm at worst case (10 percent swell {round_mm(swell_high_mm)} mm "
            f"+ arithmetic tolerance {round_mm(tol_back_arith)} mm vs declared void "
            f"{round_mm(battery_to_back_wall_gap)} mm)"
        )
        mitigation.append(
            "UPSTREAM FIX REQUIRED in mechanical/e1-phone/cad/e1_phone_params.yaml "
            f"battery.battery_swell_gap_mm: raise from {round_mm(declared_swell_void_mm)} mm to "
            f">= {required_void_mm} mm (and grow device envelope_mm[2] by the same delta), or "
            "tighten the tolerance class, or specify a back-void compressible foam pad with a "
            "documented compression set that absorbs the over-budget without preloading the cell"
        )
    if not panel_protected:
        mitigation.append(
            "display-side static gap erodes to "
            f"{round_mm(front_gap_residual_arith)} mm at worst case; tighten battery seat "
            "placement/datasheet z-tolerance or increase the static gap to protect the panel"
        )

    return {
        "claim_boundary": (
            "Component height stack vs flush-back interior depth from EVT0 CAD "
            "fit-check z-coordinates, carried to an end-of-life worst case with explicit "
            "LiPo swell and the molded/placement tolerance stack-up. This is a CAD-estimate "
            "proof using datasheet-typical tolerances, not a measured tolerance stack with "
            "gasket compression, foam compression set, or supplier z-height signoff."
        ),
        "device_thickness_mm": round_mm(envelope_thickness),
        "wall_thickness_mm": round_mm(wall),
        "interior_depth_between_walls_mm": round_mm(interior_depth),
        "front_to_back_z_coordinates_mm": {
            "display_lcm_back_z": round_mm(display_back_z),
            "battery_front_z": round_mm(battery_front_z),
            "battery_back_z": round_mm(battery_back_z),
            "back_inner_wall_z": round_mm(back_inner_wall_z),
        },
        "derived_stack_mm": {
            "battery_thickness": round_mm(battery_thickness),
            "display_to_battery_gap": round_mm(display_to_battery_gap),
            "battery_to_back_wall_gap": round_mm(battery_to_back_wall_gap),
            "occupied_display_back_to_back_wall": round_mm(occupied),
            "display_back_to_back_wall_span": round_mm(display_to_back_wall_span),
            "nominal_interior_residual_margin": round_mm(interior_residual),
            "front_static_gap_required": front_static_gap_required,
            "back_swell_gap_required": back_swell_gap_required,
        },
        "battery_swell_allowance_mm": {
            "basis": "LiPo pouch swells 8-10 percent in thickness over service life",
            "swell_pct_range": [swell_pct_low, swell_pct_high],
            "swell_low_mm": round_mm(swell_low_mm),
            "swell_high_mm": round_mm(swell_high_mm),
            "declared_back_swell_void_mm": round_mm(declared_swell_void_mm),
            "swell_vented_to": "back_shell_side_void (display-side static gap unaffected)",
        },
        "stack_tolerance_budget_mm": {
            "evidence_class": fit["params"]["tolerances"]["evidence_class"],
            "process_class": fit["params"]["tolerances"]["process_class"],
            "contributors": {
                "plastic_shrink_on_interior_depth": round_mm(shrink_mm),
                "mold_dimension_tolerance": mold_mm,
                "adhesive_cure_variance": adhesive_mm,
                "assembly_placement": placement_mm,
                "component_datasheet_typical": datasheet_mm,
                "solder_reflow_connector_float": reflow_mm,
            },
            "back_void_tolerance_arithmetic_mm": round_mm(tol_back_arith),
            "back_void_tolerance_rss_mm": round_mm(tol_back_rss),
            "front_gap_tolerance_arithmetic_mm": round_mm(tol_front_arith),
            "front_gap_tolerance_rss_mm": round_mm(tol_front_rss),
        },
        "worst_case_residual_mm": {
            "back_swell_void_arithmetic": round_mm(back_void_residual_arith),
            "back_swell_void_rss": round_mm(back_void_residual_rss),
            "display_static_gap_arithmetic": round_mm(front_gap_residual_arith),
            "display_static_gap_rss": round_mm(front_gap_residual_rss),
            "gate_basis": "arithmetic worst case (fail-closed); RSS shown for reference only",
        },
        "interface_z_stack_battery_target_mm": interface_battery_target,
        "fits_flush_back_budget": bool(span_fits_interior and gaps_meet_minimum),
        "fits_worst_case_swell_and_tolerance": bool(fits_worst_case),
        "panel_protected_at_worst_case": bool(panel_protected),
        "back_void_holds_at_worst_case": bool(back_void_holds),
        "worst_case_over_budget_mm": over_budget_mm,
        "mitigation": mitigation,
        "gaps_meet_minimum": gaps_meet_minimum,
        "discrepancies": discrepancies,
    }


def main() -> int:
    metrics = load_yaml(METRICS)
    enclosure = load_yaml(ENCLOSURE)
    display_fit = load_yaml(DISPLAY_FIT)
    overlay = load_yaml(OVERLAY)
    fit = load_json(FIT)
    clearance = load_json(CLEARANCE)
    handoff = load_json(HANDOFF)
    solid = load_json(SOLID)
    readiness = load_json(READINESS)
    assembly_manifest = load_json(ASSEMBLY_MANIFEST)

    z_stack = z_stack_budget(fit, enclosure)

    required_step_parts = [
        "e1-phone-solid-assembly.step",
        "main_pcb.step",
        "display_lcm.step",
        "screen_cover_glass.step",
        "battery_pouch.step",
        "usb_c_receptacle.step",
        "usb_c_external_aperture.step",
        "power_button_cap.step",
        "volume_button_cap.step",
        "rear_camera_module.step",
        "front_camera_module.step",
        "bottom_speaker_module.step",
        "bottom_speaker_acoustic_chamber.step",
        "bottom_mic.step",
        "top_mic.step",
        "earpiece_receiver.step",
        "haptic_lra.step",
        "split_interconnect_top_connector.step",
        "split_interconnect_bottom_connector.step",
        "split_interconnect_side_flex.step",
        "split_interconnect_top_flex_tail.step",
        "split_interconnect_bottom_flex_tail.step",
        "cellular_top_antenna_keepout.step",
        "cellular_bottom_antenna_keepout.step",
        "wifi_bt_side_antenna_keepout.step",
    ]
    step_artifacts = {
        name: file_status(f"mechanical/e1-phone/out/{name}") for name in required_step_parts
    }
    clearance_cases = clearance["cases"]
    failed_clearance_cases = [case["id"] for case in clearance_cases if not case["pass"]]
    handoff_constraints = {item["id"]: item for item in handoff["constraints"]}
    overlay_ids = [item["id"] for item in overlay["keepouts"]]
    fit_checks = fit["checks"]
    critical_fit_checks = [
        "component_presence",
        "pcb_edge_clearance",
        "screen_mount_margin",
        "usb_c_insertion_envelope",
        "bottom_io_acoustic_apertures",
        "button_force_and_travel",
        "button_pressure_support",
        "screen_mount_and_connection",
        "camera_speaker_behind_glass",
        "rf_antenna_keepouts",
        "shielding_haptics_service",
        "kicad_outline_integration",
    ]
    failed_fit_checks = [
        name for name in critical_fit_checks if not fit_checks.get(name, {}).get("pass", False)
    ]
    missing_steps = [name for name, status in step_artifacts.items() if not status["present"]]

    out = {
        "schema": "eliza.e1_phone_enclosure_placement_closure.v1",
        "status": "enclosure_placement_cross_checked_not_release_ready",
        "date": "2026-05-20",
        "claim_boundary": (
            "Concept PCB-to-enclosure placement closure only. This uses generated EVT0 CAD, "
            "STEP envelope parts, display fit, KiCad outline handoff, and parameterized "
            "clearance checks. It is not final enclosure readiness, routed-board STEP, "
            "supplier B-rep validation, tolerance-stack signoff, drop/insertion-load test, "
            "RF-in-enclosure validation, or water/dust ingress evidence."
        ),
        "source_artifacts": [
            "docs/board/e1-phone-mainboard-metrics.yaml",
            "docs/board/e1-phone-enclosure-interface.yaml",
            "board/kicad/e1-phone/display-fit.yaml",
            "board/kicad/e1-phone/mechanical-overlay.yaml",
            "mechanical/e1-phone/review/fit-check-report.json",
            "mechanical/e1-phone/review/assembly-clearance.json",
            "mechanical/e1-phone/review/kicad-mechanical-handoff.json",
            "mechanical/e1-phone/review/solid-cad-handoff.json",
            "mechanical/e1-phone/review/manufacturing-readiness.json",
            "mechanical/e1-phone/out/assembly-manifest.json",
        ],
        "envelope_cross_check": {
            "metrics_device_envelope_mm": metrics["industrial_design_assumptions"][
                "device_envelope_mm"
            ],
            "enclosure_device_envelope_mm": enclosure["coordinate_system"]["device_envelope"],
            "cad_device_envelope_mm": {
                "width": fit["params"]["device"]["envelope_mm"][0],
                "height": fit["params"]["device"]["envelope_mm"][1],
                "max_thickness": fit["params"]["device"]["envelope_mm"][2],
            },
            "display_primary_fits_current_envelope": display_fit["primary_fits_current_envelope"],
            "display_clearance_mm": display_fit["primary_clearance_in_current_envelope_mm"],
        },
        "component_height_stack_vs_interior_depth": z_stack,
        "pcb_to_cad_handoff": {
            "pcb_source": handoff["pcb_source"],
            "kicad_outline_check": handoff["kicad_outline_check"],
            "constraint_count": len(handoff["constraints"]),
            "constraint_ids": sorted(handoff_constraints),
            "next_kicad_edits": handoff["next_kicad_edits"],
        },
        "mechanical_overlay_sync": {
            "keepout_count": len(overlay_ids),
            "keepout_ids": overlay_ids,
            "projected_tokens": overlay["projected_into_kicad_pcb"]["required_tokens"],
        },
        "step_artifacts": step_artifacts,
        "missing_step_artifacts": missing_steps,
        "assembly_manifest_part_count": len(assembly_manifest),
        "solid_cad_handoff": {
            "status": solid["status"],
            "tool_available": solid["tool_available"],
            "assembly_step": solid["assembly_step"],
            "assembly_step_bytes": solid["assembly_step_bytes"],
            "part_count": solid["part_count"],
            "linked_fit_status": solid["linked_fit_status"],
            "remaining_blockers": solid["remaining_blockers"],
        },
        "fit_and_clearance": {
            "fit_status": fit["status"],
            "failed_fit_checks": failed_fit_checks,
            "assembly_clearance_status": clearance["status"],
            "checked_clearance_cases": clearance["checked_case_count"],
            "failed_clearance_cases": failed_clearance_cases,
        },
        "manufacturing_readiness_context": {
            "overall_status": readiness["overall_status"],
            "manufacturing_release_ready": readiness["manufacturing_release_ready"],
            "why_not_release_ready": readiness["why_not_release_ready"],
            "all_cad_checks_pass": readiness["all_cad_checks_pass"],
            "visual_review_pass": readiness["visual_review_pass"],
        },
        "placement_interfaces_closed_for_concept": [
            "5.5 inch display CTP outline against 78.0 x 153.6 mm envelope",
            "64.0 x 132.0 mm KiCad Edge.Cuts against CAD main_pcb envelope",
            "bottom-center USB-C aperture and receptacle envelope",
            "side power and volume cap/actuator keepout",
            "battery pouch window and PCB island clearance",
            "front and rear camera module envelopes",
            "speaker, microphones, earpiece, haptic, SIM/service, and antenna keepouts",
        ],
        "release_blockers": [
            "routed KiCad board STEP with final component 3D models",
            "supplier display, camera, USB-C, button, battery, speaker, and radio STEP/B-rep models",
            (
                "battery-swell + tolerance worst case is OVER BUDGET by "
                f"{z_stack['worst_case_over_budget_mm']} mm on the back swell void: "
                f"{z_stack['mitigation'][1]}"
                if not z_stack["fits_worst_case_swell_and_tolerance"]
                else "formal flush-back tolerance stack with gasket compression and supplier z-heights"
            ),
            "full CAD boolean interference check using supplier geometry",
            "USB-C insertion/removal load test into enclosure saddle",
            "side-button load-path and cycle test",
            "drop, torsion, thermal expansion, water/dust ingress, and acoustic leak review",
            "RF antenna/SAR validation in final enclosure plastics and metal stack",
        ],
        "forbidden_claims": [
            "enclosure_ready",
            "mechanical_release_ready",
            "routed_board_step_ready",
            "tolerance_stack_closed",
            "drop_tested",
            "waterproof_ready",
            "rf_in_enclosure_ready",
            "fabrication_ready",
        ],
    }
    OUT.write_text(yaml.dump(out, Dumper=IndentedSafeDumper, sort_keys=False, width=100))
    print(f"generated {OUT}")
    print(
        f"status={out['status']} step_artifacts={len(step_artifacts)} "
        f"clearance_cases={clearance['checked_case_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
