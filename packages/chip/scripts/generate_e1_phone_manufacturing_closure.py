#!/usr/bin/env python3
"""Generate fail-closed manufacturing closure for the E1 phone board package."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml"
PCB = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
KIBOT = ROOT / "board/kicad/e1-phone/kibot.yaml"
ROUTING = ROOT / "board/kicad/e1-phone/routing-constraints.yaml"
LAYOUT = ROOT / "board/kicad/e1-phone/layout-utilization.yaml"
MANIFEST = ROOT / "board/kicad/e1-phone/artifact-manifest.yaml"
PRODUCTION = ROOT / "board/kicad/e1-phone/production"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def has_any(path: Path) -> bool:
    return path.exists() and any(item.is_file() for item in path.rglob("*"))


def production_output_status() -> dict[str, dict[str, Any]]:
    outputs = {
        "gerber_x2": "production/gerbers",
        "ipc_2581": "production/ipc-2581",
        "drill": "production/gerbers",
        "bom_csv_or_ibom": "production/bom",
        "pick_and_place": "production/pos",
        "step": "production/step",
        "schematic_pdf": "production/pdf",
        "layout_pdf": "production/pdf",
        "assembly_drawing": "production/pdf",
        "dfm_dfa_report": "production/dfm",
        "fab_quote": "production/fab-quote",
    }
    return {
        name: {
            "path": f"board/kicad/e1-phone/{rel}",
            "present": has_any(ROOT / "board/kicad/e1-phone" / rel),
            "required_before_release": True,
        }
        for name, rel in outputs.items()
    }


def main() -> int:
    routing = load_yaml(ROUTING)
    layout = load_yaml(LAYOUT)
    manifest = load_yaml(MANIFEST)
    pcb_text = PCB.read_text()
    kibot_text = KIBOT.read_text()

    production_outputs = production_output_status()
    footprint_count = pcb_text.count('(footprint "E1Phone:')
    testpoint_count = pcb_text.count('(footprint "E1Phone:TP_')
    fiducial_count = pcb_text.count('(footprint "E1Phone:FID_')
    mounting_hole_count = pcb_text.count('(footprint "E1Phone:MH_')
    rf_match_count = pcb_text.count('(footprint "E1Phone:RF_MATCH_')
    rf_test_count = pcb_text.count('(footprint "E1Phone:RF_TP_')
    usb_protection_count = pcb_text.count('(footprint "E1Phone:USB_PROTECT_')
    usb_signal_test_count = pcb_text.count('(footprint "E1Phone:USB_TP_')
    side_key_support_count = pcb_text.count('(footprint "E1Phone:SIDE_KEY_ESD"') + pcb_text.count(
        '(footprint "E1Phone:SIDE_KEY_COND_'
    )
    generated_net_class_count = pcb_text.count('(net_class "E1Phone_')
    declared_nets = [
        line.split('"', 2)[1]
        for line in pcb_text.splitlines()
        if line.startswith("  (net ") and '"' in line and not line.startswith('  (net 0 ""')
    ]
    assigned_pad_net_count = sum(
        1 for line in pcb_text.splitlines() if line.strip().startswith("(pad ") and " (net " in line
    )
    net_id_by_name = {net: idx + 1 for idx, net in enumerate(declared_nets)}
    testpoint_nets_assigned = [
        net
        for net in routing["power_integrity"]["test_points_required"]
        if f'(footprint "E1Phone:TP_{net}"' in pcb_text
        and f'(net {net_id_by_name.get(net)} "{net}")' in pcb_text
    ]
    placement_placeholder_count = (
        footprint_count
        - testpoint_count
        - fiducial_count
        - mounting_hole_count
        - rf_match_count
        - rf_test_count
        - usb_protection_count
        - usb_signal_test_count
        - side_key_support_count
    )
    required_rf_nets = [item["net"] for item in routing["rf_layout"]["matching_networks_required"]]
    rf_matching_nets_assigned = [
        net
        for net in required_rf_nets
        if f'(footprint "E1Phone:RF_MATCH_{net}"' in pcb_text
        and f'(footprint "E1Phone:RF_TP_{net}"' in pcb_text
        and f'"{net}")' in pcb_text
    ]
    usb_support_nets_assigned = [
        net
        for net in ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN"]
        if f'"{net}")' in pcb_text
        and (
            f'(footprint "E1Phone:USB_TP_{net.replace("USB_", "").replace("VBUS", "VBUS")}"'
            in pcb_text
            or net in {"USB_DP", "USB_DN"}
        )
    ]
    out = {
        "schema": "eliza.e1_phone_manufacturing_closure.v1",
        "status": "blocked_manufacturing_requires_routed_pcb_and_fab_outputs",
        "date": "2026-05-20",
        "claim_boundary": (
            "Manufacturing closure plan only. This records the missing PCB fabrication, "
            "assembly, test, and supplier handoff evidence. It is not a Gerber, IPC-2581, "
            "drill, pick-and-place, BOM, STEP, DFM/DFA, fab quote, test plan, or "
            "fabrication-ready release package."
        ),
        "source_artifacts": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "board/kicad/e1-phone/kibot.yaml",
            "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
            "board/kicad/e1-phone/routing-constraints.yaml",
            "board/kicad/e1-phone/layout-utilization.yaml",
        ],
        "board_state_detected": {
            "has_kicad_footprints": "(footprint " in pcb_text,
            "has_tracks": "(segment " in pcb_text or "(arc " in pcb_text,
            "has_filled_zones": "(zone " in pcb_text,
            "has_test_point_footprints": testpoint_count > 0,
            "has_fiducials": fiducial_count > 0,
            "has_mounting_holes": mounting_hole_count > 0,
            "has_production_outputs": has_any(PRODUCTION),
            "kibot_outputs_are_skeleton_commented": "# outputs:" in kibot_text,
        },
        "non_release_pcb_implementation_scaffold": {
            "status": "placeholder_footprints_parse_and_render_not_fabrication_footprints",
            "placement_placeholder_footprints": placement_placeholder_count,
            "testpoint_placeholders": testpoint_count,
            "fiducial_placeholders": fiducial_count,
            "mounting_hole_placeholders": mounting_hole_count,
            "rf_matching_placeholders": rf_match_count,
            "rf_conducted_test_placeholders": rf_test_count,
            "rf_matching_nets_assigned": rf_matching_nets_assigned,
            "usb_c_protection_placeholders": usb_protection_count,
            "usb_c_signal_test_placeholders": usb_signal_test_count,
            "side_key_support_placeholders": side_key_support_count,
            "usb_c_support_nets_assigned": usb_support_nets_assigned,
            "declared_net_count": len(declared_nets),
            "generated_net_class_count": generated_net_class_count,
            "assigned_pad_net_count": assigned_pad_net_count,
            "testpoint_nets_assigned": testpoint_nets_assigned,
            "claim_boundary": (
                "Generated E1Phone:* footprints are explicit implementation placeholders. "
                "They provide KiCad objects, pads, courtyards, test access, fiducials, and "
                "mounting references for CAD/package integration, but they are excluded from "
                "BOM/PnP and must be replaced by supplier-derived land patterns before release."
            ),
        },
        "required_test_points_from_routing_constraints": routing["power_integrity"][
            "test_points_required"
        ],
        "layout_reserve_context": {
            "route_shield_test_reserve_area_mm2": layout["route_shield_test_reserve_area_mm2"],
            "route_shield_test_reserve_pct_of_placement_area": layout[
                "route_shield_test_reserve_pct_of_placement_area"
            ],
            "interpretation": layout["layout_pressure_assessment"]["interpretation"],
        },
        "production_outputs": production_outputs,
        "release_gates_seen": {
            name: gate["status"] for name, gate in manifest["release_gates"].items()
        },
        "manufacturing_requirements": [
            "routed KiCad PCB with real symbols, footprints, net classes, zones, and DRC evidence",
            "Gerber X2 or IPC-2581 fabrication package",
            "NC drill files and board stackup drawing",
            "pick-and-place file with side, rotation, and centroid convention documented",
            "production BOM or AVL with lifecycle, MOQ, substitute, and MPN data",
            "assembly drawing including polarity, do-not-populate, shield, and connector notes",
            "board STEP and enclosure STEP alignment review",
            "DFM/DFA review from the selected fabricator and assembler",
            "fab quote tied to layer count, impedance stackup, finish, HDI, and tolerance assumptions",
            "stencil, reflow, AOI, X-ray, and cleaning requirements",
            "bed-of-nails or flying-probe test plan with power-rail, USB-C, radio, display, camera, audio, and button coverage",
            "first-article limits for impedance coupons, rail power-up, thermal, RF conducted checks, and functional smoke",
        ],
        "release_blockers": [
            "routed KiCad PCB",
            "Gerber X2 or IPC-2581",
            "drill files",
            "pick-and-place",
            "BOM",
            "STEP",
            "DFM/DFA",
            "fab quote",
            "first article",
        ],
        "forbidden_claims": [
            "manufacturing_ready",
            "fabrication_ready",
            "dfm_ready",
            "assembly_ready",
            "test_ready",
            "enclosure_ready",
        ],
    }
    OUT.write_text(yaml.dump(out, Dumper=IndentedSafeDumper, sort_keys=False, width=100))
    missing = sum(1 for item in production_outputs.values() if not item["present"])
    print(f"generated {OUT}")
    print(f"status={out['status']} missing_production_outputs={missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
