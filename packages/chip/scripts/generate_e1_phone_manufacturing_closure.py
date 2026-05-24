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
    if not path.exists():
        return False
    return any(is_real_release_output(item) for item in path.rglob("*") if item.is_file())


def blocked_candidate_reason(path: Path) -> str:
    if path.name == "candidate-placeholder.txt":
        return "candidate_placeholder"
    candidates = [path]
    candidates.extend(
        sidecar
        for sidecar in (
            path.with_name(path.name + ".metadata.yaml"),
            path.with_name(path.name + ".metadata.yml"),
            path.with_name(path.name + ".metadata.json"),
        )
        if sidecar.exists()
    )
    for candidate in candidates:
        if not (
            candidate.name.startswith("release-manifest.")
            or candidate.name.endswith(".metadata.yaml")
            or candidate.name.endswith(".metadata.yml")
            or candidate.name.endswith(".metadata.json")
        ):
            continue
        try:
            data = yaml.safe_load(candidate.read_text())
        except Exception:
            data = None
        if not isinstance(data, dict):
            continue
        if data.get("release_allowed") is False:
            return "release_allowed_false"
        if str(data.get("status", "")).lower().startswith("blocked"):
            return "blocked_status"
        if str(data.get("disposition", "")).lower().startswith("blocked"):
            return "blocked_disposition"
    return ""


def blocked_candidate_files(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    out = []
    for item in sorted(path.rglob("*")):
        if not item.is_file():
            continue
        reason = blocked_candidate_reason(item)
        if reason:
            out.append({"path": str(item.relative_to(ROOT)), "reason": reason})
    return out


def is_real_release_output(path: Path) -> bool:
    if path.name == "candidate-placeholder.txt":
        return False
    explicit_metadata = False
    if path.name.startswith("release-manifest.") or path.name.endswith(".metadata.yaml"):
        explicit_metadata = True
        try:
            data = yaml.safe_load(path.read_text())
        except Exception:
            data = None
        if isinstance(data, dict) and (
            data.get("release_allowed") is False
            or str(data.get("status", "")).lower().startswith("blocked")
            or str(data.get("disposition", "")).lower().startswith("blocked")
        ):
            return False
    for sidecar in (
        path.with_name(path.name + ".metadata.yaml"),
        path.with_name(path.name + ".metadata.yml"),
        path.with_name(path.name + ".metadata.json"),
    ):
        if sidecar.exists():
            explicit_metadata = True
            try:
                data = yaml.safe_load(sidecar.read_text())
            except Exception:
                data = None
            if isinstance(data, dict) and (
                data.get("release_allowed") is False
                or str(data.get("status", "")).lower().startswith("blocked")
                or str(data.get("disposition", "")).lower().startswith("blocked")
            ):
                return False
            if isinstance(data, dict) and (
                data.get("release_allowed") is True
                and str(data.get("disposition", "")).lower() == "approved"
            ):
                return True
    if explicit_metadata:
        return False
    return False


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
    status = {}
    for name, rel in outputs.items():
        output_path = ROOT / "board/kicad/e1-phone" / rel
        blocked_candidates = blocked_candidate_files(output_path)
        status[name] = {
            "path": f"board/kicad/e1-phone/{rel}",
            "present": has_any(output_path),
            "blocked_candidate_present": bool(blocked_candidates),
            "blocked_candidate_file_count": len(blocked_candidates),
            "blocked_candidate_examples": blocked_candidates[:5],
            "required_before_release": True,
        }
    return status


def main() -> int:
    routing = load_yaml(ROUTING)
    layout = load_yaml(LAYOUT)
    manifest = load_yaml(MANIFEST)
    pcb_text = PCB.read_text()
    kibot_text = KIBOT.read_text()

    production_outputs = production_output_status()
    zone_total_count = pcb_text.count("(zone ")
    keepout_zone_count = pcb_text.count("(keepout ")
    copper_zone_count = zone_total_count - keepout_zone_count
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
    display_support_count = pcb_text.count('(footprint "E1Phone:DISPLAY_')
    camera_support_count = pcb_text.count('(footprint "E1Phone:CAMERA_')
    audio_support_count = pcb_text.count('(footprint "E1Phone:AUDIO_')
    haptic_support_count = pcb_text.count('(footprint "E1Phone:HAPTIC_')
    power_management_support_count = pcb_text.count('(footprint "E1Phone:POWER_')
    compute_storage_support_count = pcb_text.count('(footprint "E1Phone:COMPUTE_')
    identity_sensor_support_count = pcb_text.count('(footprint "E1Phone:PHONE_IDENTITY_')
    split_interconnect_placeholder_count = pcb_text.count('(footprint "E1Phone:J_TOP_BOTTOM_FLEX_')
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
        - display_support_count
        - camera_support_count
        - audio_support_count
        - haptic_support_count
        - power_management_support_count
        - compute_storage_support_count
        - identity_sensor_support_count
        - split_interconnect_placeholder_count
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
    display_support_nets_assigned = [
        net
        for net in [
            "DSI_CLK_P",
            "DSI_D0_P",
            "DISP_AVDD_5V5",
            "DISP_AVEE_N5V5",
            "DISP_BL_EN",
            "DISP_BL_PWM",
            "DISP_RESET_N",
            "TOUCH_I2C_SCL",
            "TOUCH_I2C_SDA",
        ]
        if f'"{net}")' in pcb_text
    ]
    camera_support_nets_assigned = [
        net
        for net in [
            "CAM0_CSI_CLK_P",
            "CAM1_CSI_CLK_P",
            "CAM_AVDD_2V8",
            "CAM_DVDD_1V2",
            "CAM0_RESET_N",
            "CAM1_RESET_N",
            "CAM0_PWDN",
            "CAM0_I2C_SCL",
            "CAM1_I2C_SCL",
        ]
        if f'"{net}")' in pcb_text
    ]
    audio_support_nets_assigned = [
        net
        for net in [
            "I2S_BCLK",
            "I2S_LRCLK",
            "I2S_DOUT",
            "I2S_DIN",
            "PDM_CLK",
            "PDM_DAT",
            "AUDIO_I2C_SCL",
            "AUDIO_I2C_SDA",
            "CODEC_INT",
            "AMP_INT",
            "SPK_P",
            "SPK_N",
            "VDD_AUDIO_3V3",
            "VDD_AMP_3V3",
            "SYS",
            "IO_1V8",
        ]
        if f'"{net}")' in pcb_text
    ]
    haptic_support_nets_assigned = [
        net for net in ["HAPTIC_OUT", "SYS", "IO_1V8"] if f'"{net}")' in pcb_text
    ]
    power_management_support_nets_assigned = [
        net
        for net in [
            "VBUS",
            "VBAT",
            "SYS",
            "VIN_3V3",
            "AON_1V8",
            "AP_0V8",
            "AP_1V1",
            "IO_1V8",
            "RF_VBAT",
            "CAM_AVDD_2V8",
            "CAM_DVDD_1V2",
            "DISP_AVDD_5V5",
            "DISP_AVEE_N5V5",
            "BAT_NTC",
            "BAT_ID",
            "PMIC_I2C_SCL",
            "PMIC_I2C_SDA",
            "PMIC_IRQ_N",
            "PMIC_RESET_N",
            "CHG_I2C_SCL",
            "CHG_I2C_SDA",
            "CHG_IRQ_N",
            "USBPD_I2C_SCL",
            "USBPD_I2C_SDA",
            "USBPD_IRQ_N",
            "USBPD_RESET",
        ]
        if f'"{net}")' in pcb_text
    ]
    compute_storage_support_nets_assigned = [
        net
        for net in [
            "LPDDR_CK_P",
            "LPDDR_CK_N",
            "LPDDR_CA0",
            "LPDDR_CA1",
            "LPDDR_CA2",
            "LPDDR_CA3",
            "LPDDR_DQ0",
            "LPDDR_DQ1",
            "LPDDR_DQ2",
            "LPDDR_DQ3",
            "LPDDR_DQS_P",
            "LPDDR_DQS_N",
            "LPDDR_RESET_N",
            "LPDDR_ZQ",
            "UFS_REFCLK_P",
            "UFS_REFCLK_N",
            "UFS_TX_P",
            "UFS_TX_N",
            "UFS_RX_P",
            "UFS_RX_N",
            "UFS_RESET_N",
            "JTAG_TCK",
            "JTAG_TMS",
            "JTAG_TDI",
            "JTAG_TDO",
            "JTAG_TRST_N",
            "BOOT_MODE0",
            "BOOT_MODE1",
            "BOOT_MODE2",
            "SOC_RESET_N",
            "AP_0V8",
            "AP_1V1",
            "IO_1V8",
        ]
        if f'"{net}")' in pcb_text
    ]
    identity_sensor_support_nets_assigned = [
        net
        for net in [
            "USIM_VCC",
            "USIM_CLK",
            "USIM_RST",
            "USIM_IO",
            "USIM_DET",
            "ESIM_VCC",
            "ESIM_CLK",
            "ESIM_RST",
            "ESIM_IO",
            "CELL_GNSS_RF",
            "NFC_I2C_SCL",
            "NFC_I2C_SDA",
            "NFC_IRQ_N",
            "NFC_EN",
            "NFC_RF_P",
            "NFC_RF_N",
            "SENSOR_I2C_SCL",
            "SENSOR_I2C_SDA",
            "IMU_INT",
            "ALS_PROX_INT",
            "BARO_INT",
            "MAG_INT",
            "AON_1V8",
            "IO_1V8",
            "RF_VBAT",
        ]
        if f'"{net}")' in pcb_text
    ]
    split_interconnect_nets_assigned = [
        net
        for net in [
            "USB_DP",
            "USB_DN",
            "USB_CC1",
            "USB_CC2",
            "VBUS",
            "SHIELD_GND",
            "SYS",
            "AON_1V8",
            "IO_1V8",
            "VDD_AUDIO_3V3",
            "VDD_AMP_3V3",
            "VBAT",
            "RF_VBAT",
            "I2S_BCLK",
            "I2S_LRCLK",
            "I2S_DOUT",
            "I2S_DIN",
            "PDM_CLK",
            "PDM_DAT",
            "AUDIO_I2C_SCL",
            "AUDIO_I2C_SDA",
            "CODEC_INT",
            "AMP_INT",
            "HAPTIC_OUT",
            "GND",
        ]
        if f'"{net}")' in pcb_text
        and '(footprint "E1Phone:J_TOP_BOTTOM_FLEX_TOP"' in pcb_text
        and '(footprint "E1Phone:J_TOP_BOTTOM_FLEX_BOTTOM"' in pcb_text
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
            "board/kicad/e1-phone/production-readiness.yaml",
            "board/kicad/e1-phone/procurement-readiness.yaml",
        ],
        "board_state_detected": {
            "has_kicad_footprints": "(footprint " in pcb_text,
            "has_tracks": "(segment " in pcb_text or "(arc " in pcb_text,
            "has_filled_zones": copper_zone_count > 0,
            "has_keepout_zones": keepout_zone_count > 0,
            "has_test_point_footprints": testpoint_count > 0,
            "has_fiducials": fiducial_count > 0,
            "has_mounting_holes": mounting_hole_count > 0,
            "has_production_outputs": any(item["present"] for item in production_outputs.values()),
            "release_output_count": sum(1 for item in production_outputs.values() if item["present"]),
            "has_blocked_candidate_outputs": any(
                item["blocked_candidate_present"] for item in production_outputs.values()
            ),
            "blocked_candidate_output_file_count": sum(
                item["blocked_candidate_file_count"] for item in production_outputs.values()
            ),
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
            "display_support_placeholders": display_support_count,
            "camera_support_placeholders": camera_support_count,
            "display_support_nets_assigned": display_support_nets_assigned,
            "camera_support_nets_assigned": camera_support_nets_assigned,
            "audio_support_placeholders": audio_support_count,
            "haptic_support_placeholders": haptic_support_count,
            "power_management_support_placeholders": power_management_support_count,
            "compute_storage_support_placeholders": compute_storage_support_count,
            "identity_sensor_support_placeholders": identity_sensor_support_count,
            "split_interconnect_placeholders": split_interconnect_placeholder_count,
            "audio_support_nets_assigned": audio_support_nets_assigned,
            "haptic_support_nets_assigned": haptic_support_nets_assigned,
            "power_management_support_nets_assigned": power_management_support_nets_assigned,
            "compute_storage_support_nets_assigned": compute_storage_support_nets_assigned,
            "identity_sensor_support_nets_assigned": identity_sensor_support_nets_assigned,
            "split_interconnect_nets_assigned": split_interconnect_nets_assigned,
            "declared_net_count": len(declared_nets),
            "generated_net_class_count": generated_net_class_count,
            "generated_keepout_zone_count": keepout_zone_count,
            "copper_zone_count": copper_zone_count,
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
            "split-board interconnect inspection and continuity coverage across top and bottom mating connectors",
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
            "split-board interconnect continuity and assembly inspection",
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
