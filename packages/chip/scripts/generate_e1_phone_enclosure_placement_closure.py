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
            "formal 9.6 mm tolerance stack with gasket compression and battery swelling",
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
