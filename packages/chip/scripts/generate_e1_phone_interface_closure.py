#!/usr/bin/env python3
"""Generate enclosure-facing interface closure evidence for the E1 phone board."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/interface-closure.yaml"


SOURCES = {
    "matrix": ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml",
    "netlist": ROOT / "board/kicad/e1-phone/block-netlist.yaml",
    "usb_c": ROOT / "package/usb-c/e1-phone-usb-c-port.yaml",
    "side_buttons": ROOT / "package/human-interface/side-buttons.yaml",
    "display": ROOT / "package/display/v0-dsi-720x1280.yaml",
    "camera": ROOT / "package/camera/oem-mipi-csi-modules.yaml",
    "interconnect": ROOT / "package/interconnect/e1-phone-top-bottom-flex.yaml",
    "enclosure": ROOT / "docs/board/e1-phone-enclosure-interface.yaml",
    "routing": ROOT / "board/kicad/e1-phone/routing-constraints.yaml",
}


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        return yaml.safe_load(handle)


def flatten_net_groups(groups: dict[str, Any]) -> set[str]:
    nets: set[str] = set()
    for value in groups.values():
        if isinstance(value, list):
            nets.update(str(item) for item in value)
    return nets


def placement_by_refdes(matrix: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["refdes_group"]: item for item in matrix["placements"]}


def block_by_id(netlist: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in netlist["blocks"]}


def report_interface(
    *,
    name: str,
    status: str,
    placement: dict[str, Any],
    blocks: list[dict[str, Any]],
    required_nets: set[str],
    required_constraints: set[str],
    required_mechanical: list[str],
    binding_paths: list[str],
    layout_requirements: dict[str, Any] | None = None,
) -> dict[str, Any]:
    block_nets = set().union(*(flatten_net_groups(block["nets"]) for block in blocks))
    placement_nets = set(placement["required_nets"])
    constraints = set(placement["constraints"])
    missing_nets = sorted(required_nets - block_nets - placement_nets)
    missing_constraints = sorted(required_constraints - constraints)
    return {
        "name": name,
        "status": status,
        "placement_refdes_group": placement["refdes_group"],
        "region_mm": placement["region_mm"],
        "side": placement["side"],
        "binding_paths": binding_paths,
        "block_ids": [block["id"] for block in blocks],
        "required_nets": sorted(required_nets),
        "nets_present_in_block_or_matrix": sorted((block_nets | placement_nets) & required_nets),
        "missing_required_nets": missing_nets,
        "required_constraints": sorted(required_constraints),
        "constraints_present": sorted(constraints & required_constraints),
        "missing_required_constraints": missing_constraints,
        "mechanical_closure_requirements": required_mechanical,
        "layout_closure_requirements": layout_requirements or {},
        "passes_planning_gate": not missing_nets and not missing_constraints,
    }


def report_split_interconnect(
    *,
    top_placement: dict[str, Any],
    bottom_placement: dict[str, Any],
    blocks: list[dict[str, Any]],
    required_nets: set[str],
    required_mechanical: list[str],
) -> dict[str, Any]:
    block_nets = set().union(*(flatten_net_groups(block["nets"]) for block in blocks))
    placement_nets = set(top_placement["required_nets"]) | set(bottom_placement["required_nets"])
    constraints = set(top_placement["constraints"]) | set(bottom_placement["constraints"])
    required_constraints = {
        "split_board_interconnect",
        "usb2_90ohm_across_flex",
        "power_return_interleave",
        "audio_keepaway",
    }
    missing_nets = sorted(required_nets - block_nets - placement_nets)
    missing_constraints = sorted(required_constraints - constraints)
    return {
        "name": "top_bottom_split_board_interconnect",
        "status": "planning_complete_connector_pair_not_selected",
        "placement_refdes_group": [
            top_placement["refdes_group"],
            bottom_placement["refdes_group"],
        ],
        "region_mm": {
            "top_mate": top_placement["region_mm"],
            "bottom_mate": bottom_placement["region_mm"],
        },
        "side": {
            "top_mate": top_placement["side"],
            "bottom_mate": bottom_placement["side"],
        },
        "binding_paths": ["package/interconnect/e1-phone-top-bottom-flex.yaml"],
        "block_ids": [block["id"] for block in blocks],
        "required_nets": sorted(required_nets),
        "nets_present_in_block_or_matrix": sorted((block_nets | placement_nets) & required_nets),
        "missing_required_nets": missing_nets,
        "required_constraints": sorted(required_constraints),
        "constraints_present": sorted(constraints & required_constraints),
        "missing_required_constraints": missing_constraints,
        "mechanical_closure_requirements": required_mechanical,
        "assembly_closure_requirements": [
            "battery must insert without overstressing the mated top/bottom flex",
            "connector mated height and stiffener stack must clear the 9.6 mm enclosure",
            "strain relief or clamp must be defined before drop/torsion testing",
            "bottom island service order must be documented before first article assembly",
        ],
        "passes_planning_gate": not missing_nets and not missing_constraints,
    }


def main() -> int:
    matrix = load_yaml(SOURCES["matrix"])
    netlist = load_yaml(SOURCES["netlist"])
    usb_c = load_yaml(SOURCES["usb_c"])
    side_buttons = load_yaml(SOURCES["side_buttons"])
    display = load_yaml(SOURCES["display"])
    camera = load_yaml(SOURCES["camera"])
    interconnect = load_yaml(SOURCES["interconnect"])
    enclosure = load_yaml(SOURCES["enclosure"])
    routing = load_yaml(SOURCES["routing"])

    placements = placement_by_refdes(matrix)
    blocks = block_by_id(netlist)

    interfaces = [
        report_interface(
            name="single_bottom_usb_c_charge_data_debug",
            status="planning_complete_for_evt0_usb2_pd_not_placed",
            placement=placements["J_USB_C"],
            blocks=[blocks["J_USB_C"], blocks["U_USB_PD"], blocks["U_CHARGER"], blocks["U_SOC"]],
            required_nets={"VBUS", "GND", "SHIELD_GND", "USB_DP", "USB_DN", "USB_CC1", "USB_CC2"},
            required_constraints={"mechanical_capture", "esd_near_connector", "90ohm_usb2_diff"},
            required_mechanical=usb_c["placement"]["enclosure_requirements"]
            + usb_c["manufacturing_requirements"],
            binding_paths=["package/usb-c/e1-phone-usb-c-port.yaml"],
            layout_requirements=usb_c["layout_closure_requirements"],
        ),
        report_interface(
            name="left_edge_power_volume_buttons",
            status="planning_complete_no_wake_validation",
            placement=placements["SW_POWER_VOL"],
            blocks=[blocks["SW_SIDE_KEYS"], blocks["U_SOC"], blocks["U_PMIC"]],
            required_nets={"PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "AON_1V8", "GND"},
            required_constraints={
                "wake_capable_power_key",
                "recovery_key_combo",
                "enclosure_actuator_rib",
            },
            required_mechanical=side_buttons["mechanical_target"]["enclosure_features"]
            + list(side_buttons["mechanical_target"]["serviceability"].values()),
            binding_paths=["package/human-interface/side-buttons.yaml"],
            layout_requirements=side_buttons["layout_closure_requirements"],
        ),
        report_interface(
            name="top_right_display_touch_fpc",
            status="planning_complete_pinout_supplier_request_required",
            placement=placements["J_DISPLAY_TOUCH"],
            blocks=[blocks["J_DISPLAY_TOUCH"], blocks["U_SOC"]],
            required_nets={
                "DSI_CLK_P",
                "DSI_CLK_N",
                "DSI_D0_P",
                "DSI_D0_N",
                "DSI_D1_P",
                "DSI_D1_N",
                "DSI_D2_P",
                "DSI_D2_N",
                "DSI_D3_P",
                "DSI_D3_N",
                "DISP_RESET_N",
                "DISP_TE",
                "DISP_BL_EN",
                "DISP_BL_PWM",
                "TOUCH_I2C_SCL",
                "TOUCH_I2C_SDA",
            },
            required_constraints={"100ohm_mipi_dphy", "fpc_bend_radius", "panel_bias_rails"},
            required_mechanical=[
                "selected panel outline must match board/kicad/e1-phone/display-fit.yaml",
                "FPC exit datum and connector pinout required before schematic freeze",
                "backlight bias rails and touch reset/IRQ must be assigned in real schematic",
            ],
            binding_paths=["package/display/v0-dsi-720x1280.yaml"],
        ),
        report_interface(
            name="top_right_front_rear_camera_fpcs",
            status="planning_complete_pinout_supplier_request_required",
            placement=placements["J_CAM0_CAM1"],
            blocks=[blocks["J_CAM0"], blocks["J_CAM1"], blocks["U_SOC"]],
            required_nets={
                "CAM0_CSI_CLK_P",
                "CAM0_CSI_D0_P",
                "CAM0_CSI_D1_P",
                "CAM0_CSI_D2_P",
                "CAM0_CSI_D3_P",
                "CAM1_CSI_CLK_P",
                "CAM1_CSI_D0_P",
                "CAM1_CSI_D1_P",
                "CAM0_MCLK",
                "CAM1_MCLK",
                "CAM0_RESET_N",
                "CAM1_RESET_N",
                "CAM_AVDD_2V8",
                "CAM_DVDD_1V2",
                "IO_1V8",
            },
            required_constraints={
                "100ohm_mipi_dphy",
                "camera_z_height",
                "lens_axis_datum",
                "af_vcm_supply",
            },
            required_mechanical=[
                "rear AF module lens z-height and axis datum required before ID freeze",
                "front camera module selected by cover glass and bezel clearance",
                "supplier FPC pinouts required before schematic symbol creation",
            ],
            binding_paths=["package/camera/oem-mipi-csi-modules.yaml"],
        ),
        report_split_interconnect(
            top_placement=placements["J_TOP_BOTTOM_FLEX_TOP"],
            bottom_placement=placements["J_TOP_BOTTOM_FLEX_BOTTOM"],
            blocks=[blocks["J_TOP_BOTTOM_FLEX_TOP"], blocks["J_TOP_BOTTOM_FLEX_BOTTOM"]],
            required_nets={
                "USB_DP",
                "USB_DN",
                "USB_CC1",
                "USB_CC2",
                "VBUS",
                "SHIELD_GND",
                "GND",
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
            },
            required_mechanical=interconnect["evidence_required_before_freeze"]
            + [
                interconnect["flex_stackup_requirements"]["target"],
                interconnect["flex_stackup_requirements"]["strain_relief"],
            ],
        ),
    ]

    report = {
        "schema": "eliza.e1_phone_interface_closure.v1",
        "status": "planning_interfaces_cross_checked_not_fabrication_ready",
        "claim_boundary": (
            "Cross-checks enclosure-facing interface plans against package bindings, "
            "placement regions, and logical block nets. This is not a supplier "
            "pinout, KiCad schematic, ERC/DRC result, or fabricated-board proof."
        ),
        "source_files": [str(path.relative_to(ROOT)) for path in SOURCES.values()],
        "device_envelope_mm": enclosure["coordinate_system"]["device_envelope"],
        "board_bbox_mm": matrix["board"]["bbox_mm"],
        "interfaces": interfaces,
        "routing_classes_referenced": {
            "differential_pair_count": len(routing["differential_pairs"]),
            "single_ended_bus_count": len(routing["single_ended_buses"]),
        },
        "display_supplier_state": display["panel_candidates"][0]["datasheet_status"],
        "camera_supplier_state": camera["status"],
        "release_blockers": [
            "exact supplier connector pinouts for USB-C footprint, display/touch FPC, rear camera, front camera, and side-key flex",
            "exact top/bottom interconnect mating connector part numbers, flex stackup, and strain relief",
            "real KiCad symbols and footprints with ERC-clean connectivity",
            "routed DRC-clean USB2, MIPI DSI, MIPI CSI, button wake, split-board interconnect, and power nets",
            "STEP fit proving USB-C port, side button actuators, display FPC, camera z-stack, and split-board flex service path",
        ],
    }

    failed = [item["name"] for item in interfaces if not item["passes_planning_gate"]]
    if failed:
        report["status"] = "blocked_planning_interface_gap"
        report["failed_interfaces"] = failed

    OUT.write_text(yaml.dump(report, Dumper=IndentedSafeDumper, sort_keys=False))
    print(f"generated {OUT}")
    print(f"interfaces={len(interfaces)} failed={len(failed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
