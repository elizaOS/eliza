#!/usr/bin/env python3
"""Generate the supplier pinout and footprint freeze matrix for the E1 phone.

This is deliberately a release blocker, not a claim that the board is ready.
It converts the loose "supplier pinouts missing" item into a concrete,
machine-checkable list of drawings, pin maps, footprints, and mechanical data
that must be received before real KiCad symbols, footprints, routing, and STEP
enclosure placement can be frozen.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml"
PRELIM_BOM = ROOT / "board/kicad/e1-phone/preliminary-bom.yaml"
PLACEMENT = ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml"
NETLIST = ROOT / "board/kicad/e1-phone/block-netlist.yaml"
ROUTING = ROOT / "board/kicad/e1-phone/routing-constraints.yaml"


class NoAliasSafeDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True

    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def listify(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


def flatten_block_nets(netlist: dict[str, Any]) -> set[str]:
    nets: set[str] = set()
    for block in netlist["blocks"]:
        for group in block["nets"].values():
            if isinstance(group, list):
                nets.update(str(net) for net in group)
    return nets


def placement_by_refdes(placement: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["refdes_group"]: item for item in placement["placements"]}


def bom_by_function(bom: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["function"]: item for item in bom["major_items"]}


def expanded_nets(required: list[str], all_nets: set[str]) -> list[str]:
    aliases = {
        "CAM0_CSI": sorted(net for net in all_nets if net.startswith("CAM0_CSI_")),
        "CAM1_CSI": sorted(net for net in all_nets if net.startswith("CAM1_CSI_")),
        "CAM_IOVDD_1V8": ["IO_1V8"],
        "CELL_VBAT": ["RF_VBAT"],
        "CELL_VDDIO_1V8": ["IO_1V8"],
        "CELL_USB2": ["CELL_USB2_DP", "CELL_USB2_DN"],
        "CELL_PCIE": sorted(net for net in all_nets if net.startswith("CELL_PCIE_")),
        "USIM": ["USIM_CLK", "USIM_RST", "USIM_IO"],
        "WIFI_PCIE_OR_SDIO": sorted(
            net for net in all_nets if net.startswith("WIFI_PCIE_") or net.startswith("WIFI_SDIO_")
        ),
        "BT_UART": ["BT_UART_TX", "BT_UART_RX", "BT_UART_CTS_N", "BT_UART_RTS_N"],
        "VDDIO_1V8": ["IO_1V8"],
        "AP_RAILS": ["AP_CORE", "AP_IO", "AP_MEM"],
        "RF_RAILS": ["RF_VBAT", "CELL_VBAT", "CELL_VDDIO_1V8"],
        "CAM_RAILS": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM_IOVDD_1V8"],
        "DISP_RAILS": ["DISP_AVDD_5V5", "DISP_AVEE_N5V5", "DISP_IOVDD_1V8"],
        "I2S_OR_PCM": ["I2S_BCLK", "I2S_LRCLK", "I2S_DOUT", "I2S_DIN"],
        "PDM_MIC": ["PDM_CLK", "PDM_DAT"],
        "I2C_AUDIO": ["AUDIO_I2C_SCL", "AUDIO_I2C_SDA"],
        "AUDIO_IRQS": ["CODEC_INT", "AMP_INT"],
        "SPK_OUT": ["SPK_P", "SPK_N"],
        "HAPTIC_DRV": ["HAPTIC_OUT"],
    }
    out: list[str] = []
    for net in required:
        out.extend(aliases.get(net, [net]))
    return sorted(dict.fromkeys(out))


FREEZE_ITEMS = [
    {
        "name": "display_touch_fpc",
        "refdes_group": "J_DISPLAY_TOUCH",
        "bom_function": "display_touch",
        "footprint_strategy": "supplier_defined_40pin_or_equivalent_mipi_touch_fpc",
        "mechanical_datums": [
            "cover_glass_outline",
            "tft_outline",
            "fpc_exit_side",
            "stiffener_thickness",
            "minimum_bend_radius",
        ],
        "supplier_evidence_required": [
            "2d_dimensioned_drawing",
            "full_connector_pinout",
            "mating_connector_part_number",
            "fpc_stack_and_stiffener_drawing",
            "panel_init_sequence",
            "backlight_or_bias_power_spec",
            "touch_controller_pinout_and_i2c_address",
        ],
    },
    {
        "name": "rear_camera_fpc",
        "refdes_group": "J_CAM0_CAM1",
        "bom_function": "rear_camera",
        "footprint_strategy": "supplier_defined_24_to_30pin_mipi_csi_camera_fpc",
        "mechanical_datums": [
            "lens_axis_xy",
            "lens_z_height",
            "module_outline",
            "fpc_exit_side",
            "shield_can_height",
        ],
        "supplier_evidence_required": [
            "exact_fpc_pinout",
            "mating_connector_part_number",
            "lane_count_and_lane_order",
            "power_sequence_timing",
            "clock_frequency",
            "otp_calibration_flow",
            "v4l2_or_android_hal_driver_plan",
        ],
    },
    {
        "name": "front_camera_fpc",
        "refdes_group": "J_CAM0_CAM1",
        "bom_function": "front_camera",
        "footprint_strategy": "supplier_defined_small_mipi_csi_fpc_after_z_stack_freeze",
        "mechanical_datums": [
            "lens_axis_xy",
            "lens_z_height",
            "cover_glass_clearance",
            "fpc_exit_side",
        ],
        "supplier_evidence_required": [
            "selected_supplier_part_number",
            "exact_fpc_pinout",
            "mating_connector_part_number",
            "lane_count_and_lane_order",
            "power_sequence_timing",
            "clock_frequency",
        ],
    },
    {
        "name": "usb_c_receptacle",
        "refdes_group": "J_USB_C",
        "bom_function": "usb_c_receptacle_evt0",
        "footprint_strategy": "gct_usb4105_usb2_evt0_or_waterproof_usb3_variant_controlled",
        "mechanical_datums": [
            "shell_stake_locations",
            "midplane_height",
            "plug_overmold_clearance",
            "port_cutout",
            "enclosure_capture_surface",
        ],
        "supplier_evidence_required": [
            "datasheet_with_recommended_footprint",
            "3d_step_model",
            "mating_plug_clearance_drawing",
            "esd_layout_reference",
            "pd_cc_orientation_policy",
            "usb2_or_usb3_variant_decision",
        ],
    },
    {
        "name": "side_power_volume_controls",
        "refdes_group": "SW_POWER_VOL",
        "bom_function": "side_buttons",
        "footprint_strategy": "direct_side_push_tactile_or_side_key_flex_variant_controlled",
        "mechanical_datums": [
            "actuator_rib_geometry",
            "button_travel",
            "force_curve",
            "solder_joint_load_path",
            "left_side_keepout",
        ],
        "supplier_evidence_required": [
            "switch_datasheet_with_land_pattern",
            "actuator_stack_drawing",
            "wake_gpio_mapping",
            "recovery_combo_firmware_mapping",
            "lifetime_cycle_rating",
        ],
    },
    {
        "name": "cellular_module",
        "refdes_group": "U_CELL",
        "bom_function": "cellular",
        "footprint_strategy": "quectel_rg255c_lga_or_rm255c_m2_lab_variant",
        "mechanical_datums": [
            "module_land_pattern_or_m2_socket",
            "shield_can_height",
            "sim_or_esim_location",
            "antenna_feed_datum",
        ],
        "supplier_evidence_required": [
            "hardware_design_guide",
            "recommended_lga_or_socket_footprint",
            "region_sku_band_matrix",
            "usim_esim_reference_design",
            "antenna_reference_design",
            "certification_scope_statement",
            "peak_current_profile",
        ],
    },
    {
        "name": "battery_pack_connector",
        "refdes_group": "J_BATTERY",
        "bom_function": "battery_pack",
        "footprint_strategy": "4pin_battery_connector_or_soldered_pack_variant_after_pack_supplier_freeze",
        "mechanical_datums": [
            "pack_cell_outline",
            "pcm_tail_location",
            "connector_mating_direction",
            "compression_pad_stack",
            "swelling_clearance",
        ],
        "supplier_evidence_required": [
            "dimensioned_pack_drawing",
            "connector_pinout_and_mating_part",
            "ntc_beta_or_resistance_temperature_table",
            "pcm_protection_spec",
            "max_charge_discharge_current",
            "UN38_3_test_summary",
            "MSDS",
        ],
    },
    {
        "name": "wifi_bluetooth_module",
        "refdes_group": "U_WIFI_BT",
        "bom_function": "wifi_bluetooth",
        "footprint_strategy": "murata_type_2ea_reference_land_pattern_and_rf_feed",
        "mechanical_datums": [
            "module_land_pattern",
            "shield_can_height",
            "rf_feed_point",
            "antenna_keepout",
        ],
        "supplier_evidence_required": [
            "module_datasheet",
            "hardware_integration_guide",
            "recommended_land_pattern",
            "antenna_reference_design",
            "firmware_license_and_blobs",
            "regulatory_certification_scope",
            "coexistence_guidance",
        ],
    },
    {
        "name": "audio_speaker_microphone_flexes",
        "refdes_group": "U_AUDIO_SPK_MIC",
        "bom_function": "audio_codec_amp_mics",
        "footprint_strategy": "bottom_audio_flex_or_board_mount_codec_with_speaker_mic_contacts",
        "mechanical_datums": [
            "speaker_chamber",
            "mic_port_locations",
            "acoustic_gaskets",
            "haptic_mass_clearance",
        ],
        "supplier_evidence_required": [
            "speaker_box_drawing",
            "microphone_port_drawing",
            "codec_amp_reference_schematic",
            "haptic_lra_part_and_driver_choice",
            "acoustic_leakage_review",
        ],
    },
]


def main() -> int:
    bom = load_yaml(PRELIM_BOM)
    placement = load_yaml(PLACEMENT)
    netlist = load_yaml(NETLIST)
    routing = load_yaml(ROUTING)
    all_nets = flatten_block_nets(netlist)
    placements = placement_by_refdes(placement)
    bom_items = bom_by_function(bom)

    records = []
    missing_package_bindings = []
    missing_required_nets = {}
    missing_freeze_evidence = {}
    for item in FREEZE_ITEMS:
        placement_item = placements[str(item["refdes_group"])]
        bom_item = bom_items[str(item["bom_function"])]
        planned_nets = expanded_nets(listify(placement_item.get("required_nets")), all_nets)
        missing_nets = [net for net in planned_nets if net not in all_nets]
        if missing_nets:
            missing_required_nets[item["name"]] = missing_nets
        binding = listify(placement_item.get("package_binding"))
        for rel in binding:
            if not (ROOT / rel).exists():
                missing_package_bindings.append(rel)
        evidence = [
            {"name": name, "status": "missing_supplier_document"}
            for name in item["supplier_evidence_required"]
        ]
        missing_freeze_evidence[item["name"]] = [entry["name"] for entry in evidence]
        records.append(
            {
                "name": item["name"],
                "status": "blocked_waiting_supplier_pinout_footprint_mechanical_data",
                "refdes_group": item["refdes_group"],
                "bom_function": item["bom_function"],
                "selected_primary": bom_item["primary"],
                "alternates": list(bom_item.get("alternates", [])),
                "package_binding": binding,
                "placement_region_mm": copy.deepcopy(placement_item["region_mm"]),
                "footprint_strategy": item["footprint_strategy"],
                "planned_contract_nets": planned_nets,
                "missing_contract_nets": missing_nets,
                "mechanical_datums_required": item["mechanical_datums"],
                "supplier_evidence_required": evidence,
                "freeze_blockers": bom_item.get("freeze_blockers", []),
            }
        )

    rf_matching_nets = [
        entry["net"] for entry in routing["rf_layout"]["matching_networks_required"]
    ]
    out = {
        "schema": "eliza.e1_phone_pinout_footprint_freeze.v1",
        "status": "blocked_pinout_footprint_freeze_missing_supplier_evidence",
        "date": "2026-05-20",
        "claim_boundary": (
            "Supplier pinout, footprint, and mechanical freeze matrix only. "
            "No item is approved for fabrication until missing supplier documents, "
            "real KiCad symbols/footprints, routed DRC, and STEP fit evidence are closed."
        ),
        "source_artifacts": [
            "board/kicad/e1-phone/preliminary-bom.yaml",
            "board/kicad/e1-phone/placement-interface-matrix.yaml",
            "board/kicad/e1-phone/block-netlist.yaml",
            "board/kicad/e1-phone/routing-constraints.yaml",
        ],
        "freeze_records": records,
        "cross_checks": {
            "missing_package_bindings": sorted(set(missing_package_bindings)),
            "missing_required_nets": missing_required_nets,
            "rf_matching_nets_requiring_physical_footprints": rf_matching_nets,
            "records_with_missing_supplier_evidence": missing_freeze_evidence,
        },
        "promotion_requirements": [
            "replace scaffold symbols with real KiCad symbols from supplier pinouts",
            "replace concept rectangles with reviewed footprints and courtyards",
            "bind every connector pin to schematic nets and ERC-clean sheets",
            "route USB2, MIPI DSI/CSI, PCIe/SDIO, RF, side-key, and power nets",
            "export STEP assembly with exact connector, camera, display, and button models",
            "run DRC/ERC/SI/PI/DFM/RF checks before any fabrication-ready claim",
        ],
        "forbidden_claims": [
            "pinout_frozen",
            "footprints_frozen",
            "schematic_release_ready",
            "routed_pcb_ready",
            "enclosure_ready",
            "fabrication_ready",
        ],
    }
    OUT.write_text(yaml.dump(out, sort_keys=False, width=100, Dumper=NoAliasSafeDumper))
    print(f"generated {OUT}")
    print(f"status={out['status']} records={len(records)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
