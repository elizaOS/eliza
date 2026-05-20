#!/usr/bin/env python3
"""Generate the fail-closed routed-board release plan for the E1 phone PCB."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/routed-release-plan.yaml"

MANUFACTURING = ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml"
PRODUCTION = ROOT / "board/kicad/e1-phone/production-readiness.yaml"
MANIFEST = ROOT / "board/kicad/e1-phone/artifact-manifest.yaml"
ROUTING = ROOT / "board/kicad/e1-phone/routing-constraints.yaml"
PINOUT = ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml"
PROCUREMENT = ROOT / "board/kicad/e1-phone/procurement-readiness.yaml"
ENCLOSURE = ROOT / "board/kicad/e1-phone/enclosure-placement-closure.yaml"
POWER_THERMAL = ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml"
RF = ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml"
PCB = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def output_item(
    *,
    owner: str,
    expected_path: str,
    blocker: str,
    source: str,
) -> dict[str, Any]:
    return {
        "owner": owner,
        "source": source,
        "expected_path": expected_path,
        "present": False,
        "release_required": True,
        "blocker": blocker,
    }


def main() -> int:
    manufacturing = load_yaml(MANUFACTURING)
    production = load_yaml(PRODUCTION)
    manifest = load_yaml(MANIFEST)
    routing = load_yaml(ROUTING)
    pinout = load_yaml(PINOUT)
    procurement = load_yaml(PROCUREMENT)
    enclosure = load_yaml(ENCLOSURE)
    power_thermal = load_yaml(POWER_THERMAL)
    rf = load_yaml(RF)
    pcb_text = PCB.read_text()

    current_state = manufacturing["board_state_detected"]
    release_outputs = {
        "schematic_erc_report": output_item(
            owner="ee",
            source="kicad-cli sch erc",
            expected_path="board/kicad/e1-phone/production/reports/erc.json",
            blocker="hierarchical schematic has scaffold symbols and no ERC evidence",
        ),
        "pcb_drc_report": output_item(
            owner="layout",
            source="kicad-cli pcb drc",
            expected_path="board/kicad/e1-phone/production/reports/drc.json",
            blocker="PCB has no routed copper, filled zones, or DRC evidence",
        ),
        "routed_kicad_pcb": output_item(
            owner="layout",
            source="KiCad PCB editor",
            expected_path="board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb",
            blocker="current KiCad PCB is a concept placeholder scaffold",
        ),
        "filled_zones": output_item(
            owner="layout",
            source="KiCad PCB editor",
            expected_path="board/kicad/e1-phone/production/reports/zone-fill.json",
            blocker="no copper zones are present in the current board state",
        ),
        "gerber_x2": output_item(
            owner="fabrication",
            source="KiCad or KiBot export",
            expected_path="board/kicad/e1-phone/production/gerbers",
            blocker="fabrication Gerbers have not been generated",
        ),
        "ipc_2581_or_odbpp": output_item(
            owner="fabrication",
            source="KiCad, KiBot, or assembler export",
            expected_path="board/kicad/e1-phone/production/ipc-2581",
            blocker="assembler-neutral manufacturing package has not been generated",
        ),
        "nc_drill_slots": output_item(
            owner="fabrication",
            source="KiCad or KiBot export",
            expected_path="board/kicad/e1-phone/production/gerbers",
            blocker="NC drill and slot outputs have not been generated",
        ),
        "stackup_impedance_report": output_item(
            owner="fabrication",
            source="selected fabricator field solver and quote",
            expected_path="board/kicad/e1-phone/production/stackup",
            blocker="fabricator stackup, impedance table, and coupon geometry missing",
        ),
        "position_file": output_item(
            owner="assembly",
            source="KiCad or KiBot export",
            expected_path="board/kicad/e1-phone/production/pos",
            blocker="pick-and-place output with convention notes missing",
        ),
        "production_bom_avl": output_item(
            owner="sourcing",
            source="KiCad BOM plus procurement AVL",
            expected_path="board/kicad/e1-phone/production/bom",
            blocker="production BOM/AVL with exact MPNs, lifecycle, MOQ, lead time, and substitutes missing",
        ),
        "assembly_drawing": output_item(
            owner="assembly",
            source="KiCad plot plus assembly notes",
            expected_path="board/kicad/e1-phone/production/pdf/assembly.pdf",
            blocker="assembly drawing with polarity, shield, DNP, connector, and inspection notes missing",
        ),
        "split_interconnect_assembly_drawing": output_item(
            owner="mechanical_assembly",
            source="KiCad, flex vendor drawing, and enclosure CAD",
            expected_path="board/kicad/e1-phone/production/pdf/split-interconnect-assembly.pdf",
            blocker="top/bottom flex mating order, stiffener, strain relief, and inspection drawing missing",
        ),
        "board_step_with_supplier_models": output_item(
            owner="mechanical",
            source="KiCad STEP export with vendor 3D models",
            expected_path="board/kicad/e1-phone/production/step",
            blocker="routed board STEP with supplier connector/module/shield models missing",
        ),
        "enclosure_clearance_report_using_routed_step": output_item(
            owner="mechanical",
            source="enclosure CAD clearance run",
            expected_path="mechanical/e1-phone/review/routed-board-clearance.json",
            blocker="current enclosure fit uses concept CAD, not routed-board STEP with final component heights",
        ),
        "si_pi_reports": output_item(
            owner="signal_power_integrity",
            source="post-route SI/PI simulation and review",
            expected_path="board/kicad/e1-phone/production/reports/si-pi",
            blocker="USB, MIPI, PCIe, LPDDR, UFS, power-rail, and return-path reports missing",
        ),
        "rf_reports": output_item(
            owner="rf",
            source="VNA, conducted RF, coexistence, SAR pre-scan",
            expected_path="board/kicad/e1-phone/production/reports/rf",
            blocker="antenna matching, conducted, coexistence, GNSS, and SAR evidence missing",
        ),
        "power_thermal_measurements": output_item(
            owner="validation",
            source="first-article bench logs",
            expected_path="board/kicad/e1-phone/production/reports/power-thermal",
            blocker="rail sequencing, load-step, charge, discharge, and thermal measurements missing",
        ),
        "factory_test_limits": output_item(
            owner="test",
            source="factory test specification",
            expected_path="board/kicad/e1-phone/production/test/factory-test-limits.yaml",
            blocker="factory limits for rails, USB-C, radios, display, cameras, audio, buttons, and split interconnect missing",
        ),
        "first_article_traveler": output_item(
            owner="manufacturing",
            source="EVT1 first-article build record",
            expected_path="board/kicad/e1-phone/production/first-article",
            blocker="first-article traveler, current limits, stop-on-fail rules, and signoff missing",
        ),
        "fab_assembler_quote": output_item(
            owner="sourcing",
            source="selected fabricator and assembler quote",
            expected_path="board/kicad/e1-phone/production/fab-quote",
            blocker="quote tied to layer count, HDI, impedance, finish, tolerances, assembly, and test missing",
        ),
    }

    route_completion = {
        "usb_c_power": {
            "required_nets": ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN", "SHIELD_GND"],
            "required_evidence": [
                "Type-C receptacle land pattern and shell capture from supplier drawing",
                "VBUS input protection, charger path, USB-PD controller, and current-limit validation",
                "USB2 differential routing, ESD placement, and bring-up test access",
            ],
        },
        "display_touch": {
            "required_nets": ["DSI_CLK_P", "DSI_D0_P", "DISP_AVDD_5V5", "DISP_AVEE_N5V5", "TOUCH_I2C_SCL"],
            "required_evidence": [
                "selected display/touch FPC pinout converted into real KiCad connector symbol and footprint",
                "MIPI D-PHY post-route length/impedance review",
                "display FPC bend and enclosure clearance with supplier model",
            ],
        },
        "cameras": {
            "required_nets": ["CAM0_CSI_CLK_P", "CAM1_CSI_CLK_P", "CAM_AVDD_2V8", "CAM_DVDD_1V2"],
            "required_evidence": [
                "front and rear camera FPC pinouts and land patterns",
                "CSI route and power-sequence review",
                "module z-height, lens window, and alignment clearance in enclosure",
            ],
        },
        "radios": {
            "required_nets": ["CELL_RF_MAIN", "CELL_RF_DIV", "CELL_GNSS_RF", "WIFI_BT_RF0", "WIFI_BT_RF1"],
            "required_evidence": [
                "cellular and Wi-Fi/Bluetooth module reference layout adherence",
                "50 ohm feed, matching, conducted access, and antenna keepout closure",
                "coexistence, GNSS desense, regulatory, carrier, and SAR pre-scan evidence",
            ],
        },
        "side_buttons": {
            "required_nets": ["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "AON_1V8", "GND"],
            "required_evidence": [
                "side-key flex pinout and ESD/debounce land patterns",
                "actuator stack tolerance, force, ingress, and test access review",
            ],
        },
        "audio_haptics": {
            "required_nets": ["I2S_BCLK", "PDM_CLK", "SPK_P", "SPK_N", "HAPTIC_OUT"],
            "required_evidence": [
                "codec, amplifier, microphones, speaker, and haptic supplier footprints",
                "acoustic chamber, port, mesh, gasket, and enclosure leakage validation",
            ],
        },
        "split_interconnect": {
            "required_nets": ["USB_DP", "USB_DN", "VBUS", "SYS", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"],
            "required_evidence": [
                "top and bottom connector supplier land patterns and mating-height stack",
                "flex cable pinout, stiffener, bend, strain relief, and continuity test",
            ],
        },
        "battery": {
            "required_nets": ["VBAT", "BAT_NTC", "BAT_ID", "GND"],
            "required_evidence": [
                "supplier pack drawing including swelling, PCM, tab, NTC, connector, and tolerance stack",
                "cavity insertion/removal and thermal expansion clearance in enclosure",
            ],
        },
        "compute_storage": {
            "required_nets": ["LPDDR_CK_P", "LPDDR_DQS_P", "UFS_REFCLK_P", "UFS_TX_P", "UFS_RX_P", "JTAG_TCK"],
            "required_evidence": [
                "SoC, LPDDR, UFS, boot strap, and debug exact footprints",
                "post-route memory/storage SI and boot-mode bring-up coverage",
            ],
        },
        "manufacturing": {
            "required_nets": production["factory_test_coverage_required"]["power_rails"],
            "required_evidence": production["production_output_requirements"],
        },
    }

    plan = {
        "schema": "eliza.e1_phone_routed_release_plan.v1",
        "status": "blocked_routed_release_requires_real_route_and_supplier_outputs",
        "date": date.today().isoformat(),
        "release_target": "EVT1-routed-first-article",
        "claim_boundary": (
            "Routed release checklist only. This is not a fabrication package, not a "
            "routed PCB, not enclosure-ready evidence, and not factory-test release evidence."
        ),
        "source_artifacts": [
            str(path.relative_to(ROOT))
            for path in [
                MANUFACTURING,
                PRODUCTION,
                MANIFEST,
                ROUTING,
                PINOUT,
                PROCUREMENT,
                ENCLOSURE,
                POWER_THERMAL,
                RF,
                PCB,
            ]
        ],
        "current_board_state": {
            "revision": production["board_revision_policy"]["current_revision"],
            "release_revision_required_before_fab": production["board_revision_policy"][
                "release_revision_required_before_fab"
            ],
            "has_kicad_footprints": current_state["has_kicad_footprints"],
            "has_tracks": current_state["has_tracks"],
            "has_filled_zones": current_state["has_filled_zones"],
            "has_production_outputs": current_state["has_production_outputs"],
            "kibot_outputs_are_skeleton_commented": current_state[
                "kibot_outputs_are_skeleton_commented"
            ],
            "concept_placeholder_footprints": pcb_text.count('(footprint "E1Phone:'),
            "manufacturing_status": manufacturing["status"],
            "production_status": production["status"],
            "artifact_manifest_status": manifest["status"],
        },
        "supplier_data_context": {
            "pinout_status": pinout["status"],
            "procurement_status": procurement["status"],
            "display_fit_status": manifest["release_gates"]["schematic"]["status"],
        },
        "required_release_output_manifest": release_outputs,
        "route_completion_requirements": route_completion,
        "enclosure_release_dependency": {
            "current_status": enclosure["status"],
            "requires_routed_board_step": True,
            "routed_step_blocker": "enclosure fit must be rerun with routed PCB STEP and final component models",
        },
        "power_thermal_release_dependency": {
            "current_status": power_thermal["status"],
            "requires_measurements": True,
            "required_test_points": manufacturing["required_test_points_from_routing_constraints"],
        },
        "rf_release_dependency": {
            "current_status": rf["status"],
            "required_rf_nets": rf["required_rf_nets"],
            "requires_measurements": rf["required_measurements_before_release"],
        },
        "ready_to_fabricate": False,
        "ready_for_enclosure": False,
        "ready_for_factory_test": False,
        "forbidden_claims": [
            "fabrication_ready",
            "enclosure_ready",
            "routed_release_ready",
            "factory_test_ready",
            "production_ready",
            "carrier_ready",
            "power_thermal_ready",
            "end_to_end_phone_ready",
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as handle:
        yaml.dump(plan, handle, Dumper=IndentedSafeDumper, sort_keys=False, width=110)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
