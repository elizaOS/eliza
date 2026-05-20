#!/usr/bin/env python3
"""Generate first-pass E1 phone power and thermal closure evidence."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml"

SOURCES = {
    "metrics": ROOT / "docs/board/e1-phone-mainboard-metrics.yaml",
    "netlist": ROOT / "board/kicad/e1-phone/block-netlist.yaml",
    "pmic": ROOT / "package/pmic/da9063.yaml",
    "charger": ROOT / "package/charger/max77860.yaml",
    "usb_pd": ROOT / "package/usb-pd/tps65987.yaml",
    "display": ROOT / "package/display/v0-dsi-720x1280.yaml",
    "camera": ROOT / "package/camera/oem-mipi-csi-modules.yaml",
    "cellular": ROOT / "package/cellular/quectel-5g-redcap.yaml",
    "wifi_bt": ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml",
    "audio": ROOT / "package/audio/v0-codec.yaml",
    "enclosure": ROOT / "docs/board/e1-phone-enclosure-interface.yaml",
    "routing": ROOT / "board/kicad/e1-phone/routing-constraints.yaml",
    "thermal_stack": ROOT / "docs/board/thermal-stack.md",
    "power_tree": ROOT / "docs/board/power-tree.md",
    "pdn_budget": ROOT / "docs/board/pdn-budget.md",
}


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        return yaml.safe_load(handle)


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def flatten_net_groups(groups: dict[str, Any]) -> set[str]:
    nets: set[str] = set()
    for value in groups.values():
        if isinstance(value, list):
            nets.update(str(item) for item in value)
    return nets


def round2(value: float) -> float:
    return round(value + 0.0, 2)


def main() -> int:
    metrics = load_yaml(SOURCES["metrics"])
    netlist = load_yaml(SOURCES["netlist"])
    pmic = load_yaml(SOURCES["pmic"])
    charger = load_yaml(SOURCES["charger"])
    usb_pd = load_yaml(SOURCES["usb_pd"])
    display = load_yaml(SOURCES["display"])
    camera = load_yaml(SOURCES["camera"])
    cellular = load_yaml(SOURCES["cellular"])
    audio = load_yaml(SOURCES["audio"])
    enclosure = load_yaml(SOURCES["enclosure"])
    routing = load_yaml(SOURCES["routing"])

    targets = metrics["power_efficiency_targets"]
    battery = targets["battery"]
    target_values = targets["targets"]
    nominal_energy_wh = battery["nominal_energy_wh"]
    video_call_w = target_values["video_call_avg_w_max"]
    sustained_w = target_values["sustained_ai_workload_skin_limited_w"]

    all_nets: set[str] = set()
    for block in netlist["blocks"]:
        all_nets.update(flatten_net_groups(block["nets"]))
    voltage_domains = {domain["name"]: domain for domain in netlist["voltage_domains"]}

    rail_budget = [
        {
            "rail": "VBUS",
            "source": "USB-C PD source through TPS65987",
            "nominal_v": "5_to_12_evt0",
            "load_or_role": "charger input and dead-battery boot",
            "required_nets": ["VBUS", "USB_CC1", "USB_CC2"],
        },
        {
            "rail": "VBAT",
            "source": "1S Li-ion/Li-polymer pack",
            "nominal_v": battery["nominal_voltage_v"],
            "load_or_role": "charger, PMIC system path, modem bursts",
            "required_nets": ["VBAT", "BAT_NTC", "BAT_ID"],
        },
        {
            "rail": "SYS",
            "source": "MAX77860 charger power path",
            "nominal_v": "3.6_to_4.4",
            "load_or_role": "PMIC input and system rail",
            "required_nets": ["SYS", "VBAT", "VBUS"],
        },
        {
            "rail": "AON_1V8",
            "source": "PMIC always-on LDO",
            "nominal_v": 1.8,
            "load_or_role": "power key, volume keys, always-on logic",
            "required_nets": ["AON_1V8", "PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N"],
        },
        {
            "rail": "IO_1V8",
            "source": "PMIC peripheral buck/LDO",
            "nominal_v": 1.8,
            "load_or_role": "display touch, cameras, radios, audio control",
            "required_nets": ["IO_1V8", "TOUCH_I2C_SCL", "CAM1_RESET_N", "WIFI_EN", "BT_EN"],
        },
        {
            "rail": "RF_VBAT",
            "source": "battery path or dedicated RF buck",
            "nominal_v": "3.3_to_4.4",
            "load_or_role": "cellular RedCap module and Wi-Fi/BT module",
            "required_nets": ["RF_VBAT", "CELL_RESET_N", "WIFI_EN"],
        },
        {
            "rail": "CAM_AVDD_2V8",
            "source": "PMIC camera LDO",
            "nominal_v": 2.8,
            "load_or_role": "rear/front camera analog rails",
            "required_nets": ["CAM_AVDD_2V8", "CAM0_RESET_N", "CAM1_RESET_N"],
        },
        {
            "rail": "CAM_DVDD_1V2",
            "source": "PMIC LDO or module regulator",
            "nominal_v": 1.2,
            "load_or_role": "camera digital core",
            "required_nets": ["CAM_DVDD_1V2"],
        },
        {
            "rail": "DISP_AVDD_5V5",
            "source": "display bias boost",
            "nominal_v": 5.5,
            "load_or_role": "LCD positive bias",
            "required_nets": ["DISP_AVDD_5V5", "DISP_RESET_N", "DISP_BL_EN"],
        },
        {
            "rail": "DISP_AVEE_N5V5",
            "source": "display bias inverter",
            "nominal_v": -5.5,
            "load_or_role": "LCD negative bias",
            "required_nets": ["DISP_AVEE_N5V5"],
        },
    ]

    for rail in rail_budget:
        rail["nets_present"] = sorted(net for net in rail["required_nets"] if net in all_nets)
        rail["missing_nets"] = sorted(set(rail["required_nets"]) - all_nets)

    pd_profiles = battery["usb_c"]["pd_sink_profiles"]
    pd_profile_power_w = {
        "5v_3a": 15.0,
        "9v_3a": 27.0,
        "12v_2p25a": 27.0,
    }
    max_pd_sink_w = max(pd_profile_power_w.get(profile, 0.0) for profile in pd_profiles)
    charge_power_w = (
        charger["charge_profile"]["charge_current_max_a"]
        * charger["charge_profile"]["float_voltage_v"]
    )
    charge_efficiency = target_values["charge_path_peak_efficiency_pct_min"] / 100.0
    input_power_for_max_charge_w = charge_power_w / charge_efficiency

    pmic_rails = pmic["rails"]
    buck_current_total_a = sum(
        rail["current_a_max"] for rail in pmic_rails if rail["type"] == "buck"
    )
    ldo_current_total_a = sum(rail["current_a_max"] for rail in pmic_rails if rail["type"] == "ldo")

    runtime_estimates = {
        "video_call_hours_at_target": round2(nominal_energy_wh / video_call_w),
        "sustained_ai_hours_at_skin_limited_budget": round2(nominal_energy_wh / sustained_w),
        "idle_display_on_hours_at_target": round2(
            nominal_energy_wh / target_values["idle_display_on_w_max"]
        ),
        "display_off_idle_days_at_target": round2(
            nominal_energy_wh / target_values["idle_display_off_w_max"] / 24.0
        ),
    }

    thermal = {
        "device_envelope_mm": enclosure["coordinate_system"]["device_envelope"],
        "skin_limit_c": target_values["thermal_skin_limit_c"],
        "sustained_skin_limited_budget_w": sustained_w,
        "z_stack_risk": enclosure["z_stack_target"]["risk"],
        "required_sensors": [
            "ntc_near_soc_ap_cluster",
            "ntc_near_pmic_or_modem_hot_zone",
            "skin_or_back_cover_ntc",
            "battery_pack_ntc",
        ],
        "required_spreading_stack": [
            "soc_tim",
            "graphite_spreader",
            "optional_vapor_chamber_after_simulation",
            "gap_pad_to_rear_cover",
        ],
    }
    routing_pi = routing["power_integrity"]
    power_layout_closure = {
        "high_current_paths": [
            {
                "name": "VBUS_to_charger",
                "nets": ["VBUS", "GND", "SHIELD_GND"],
                "source_constraint": routing_pi["high_current_paths"][0],
                "layout_rule": "route as a short wide copper path from USB-C/PD protection into charger input with minimized loop area",
                "verification_required": "post-route copper width/via count review plus first-power current-limit log",
            },
            {
                "name": "charger_to_battery_and_sys",
                "nets": ["VBAT", "SYS", "GND", "BAT_NTC", "BAT_ID"],
                "source_constraint": routing_pi["high_current_paths"][1],
                "layout_rule": "keep charger, battery connector, current sense, NTC, and SYS bulk capacitance on the shortest practical top/bottom island path",
                "verification_required": "pack-current scope capture and battery connector temperature check during 3 A charge",
            },
            {
                "name": "RF_VBAT_to_cellular",
                "nets": ["RF_VBAT", "GND", "CELL_RESET_N", "CELL_WAKE_AP"],
                "source_constraint": routing_pi["high_current_paths"][2],
                "layout_rule": "feed cellular burst current with local bulk/MLCC capacitance and return stitching isolated from MIPI/USB aggressors",
                "verification_required": "Quectel SKU burst-current profile and conducted TX load-step capture",
            },
        ],
        "decoupling_rules": routing_pi["decoupling"],
        "rail_test_points_required": routing_pi["test_points_required"],
        "minimum_bulk_capacitance_targets": {
            "VBUS": "22uF bulk plus 4x10uF MLCC near PD/charger input",
            "VBAT": "100uF bulk near charger/battery connector",
            "SYS": "22uF bulk plus 4x10uF MLCC at PMIC input island",
            "RF_VBAT": "module-vendor bulk plus high-frequency MLCC at cellular module pins",
        },
        "blocked_until": [
            "post-route PI simulation for VBUS, VBAT, SYS, RF_VBAT, AP rails, and IO_1V8",
            "fabricator stackup and copper/via current-rating confirmation",
            "supplier PMIC/charger layout review with real footprints",
        ],
    }
    thermal["sensor_placement_plan"] = {
        "ntc_near_soc_ap_cluster": "top island under graphite spreader near SoC/NPU shield",
        "ntc_near_pmic_or_modem_hot_zone": "top island between PMIC/charger and cellular shield",
        "skin_or_back_cover_ntc": "back-cover contact point under graphite/gap-pad stack",
        "battery_pack_ntc": "supplier pack thermistor on battery connector BAT_NTC",
    }
    thermal["spreading_layout_plan"] = {
        "top_island_heat_sources": ["SoC/NPU", "PMIC", "charger", "cellular RedCap PA bursts"],
        "mechanical_stack": thermal["required_spreading_stack"],
        "board_layout_actions": [
            "keep SoC/PMIC shield cans under continuous graphite path",
            "reserve ground via stitching under hot shields without cutting RF antenna keepouts",
            "keep battery pouch out of direct hot-spot pressure path",
            "add charger and modem temperature test points for EVT thermal soak",
        ],
        "vapor_chamber_trigger": "add vapor chamber if measured v0 sustained silicon power exceeds 4 W at 43 C skin",
    }

    blockers = [
        "selected battery pack drawing, protection board, NTC curve, and pack ID resistor",
        "fuel gauge selection and schematic/layout integration",
        "real PMIC rail assignment, current budget, decoupling, and load-step simulation",
        "display bias converter selection and panel inrush/sequence validation",
        "modem transmit-current burst budget from selected Quectel SKU datasheet",
        "thermal simulation and 30-minute CPU/NPU/camera/modem/charger soak evidence",
        "measured USB-C PD/PPS negotiation and charge-cycle logs",
    ]

    missing_by_rail = {
        rail["rail"]: rail["missing_nets"] for rail in rail_budget if rail["missing_nets"]
    }
    status = (
        "blocked_power_thermal_requires_real_schematic_and_measurement"
        if missing_by_rail or any("missing" in str(item) for item in [display, camera, cellular])
        else "planning_power_thermal_cross_checked_not_measured"
    )

    report = {
        "schema": "eliza.e1_phone_power_thermal_budget.v1",
        "status": status,
        "claim_boundary": (
            "Planning power and thermal budget only. This cross-checks selected "
            "package bindings, logical nets, and product targets; it is not a "
            "schematic review, PI simulation, thermal simulation, or measured board result."
        ),
        "source_files": [str(path.relative_to(ROOT)) for path in SOURCES.values()],
        "battery_target": {
            "capacity_mah": battery["target_capacity_mah"],
            "nominal_voltage_v": battery["nominal_voltage_v"],
            "nominal_energy_wh": nominal_energy_wh,
            "selected_pack_class": battery["selected_pack_class"],
            "public_reference_dimensions_mm": metrics["industrial_design_assumptions"][
                "selected_battery_reference_pack_mm"
            ],
            "battery_window_fit_status": (
                "sourced_17p3wh_pack_matches_64x87_concept_cavity_pending_supplier_and_routed_board_evidence"
            ),
            "required_missing_parts": battery["required_missing_parts"],
        },
        "usb_c_power_path": {
            "pd_controller": usb_pd["part"],
            "charger": charger["part"],
            "pd_sink_profiles": pd_profiles,
            "max_pd_sink_power_w": max_pd_sink_w,
            "max_charge_current_a": charger["charge_profile"]["charge_current_max_a"],
            "max_charge_power_at_cell_w": round2(charge_power_w),
            "estimated_input_power_for_max_charge_w": round2(input_power_for_max_charge_w),
            "charge_path_peak_efficiency_pct_min": target_values[
                "charge_path_peak_efficiency_pct_min"
            ],
            "pd_power_margin_w": round2(max_pd_sink_w - input_power_for_max_charge_w),
            "passes_evt0_pd_power_margin": max_pd_sink_w > input_power_for_max_charge_w,
        },
        "pmic_capacity_summary": {
            "pmic": pmic["part"],
            "buck_current_total_a": round2(buck_current_total_a),
            "ldo_current_total_a": round2(ldo_current_total_a),
            "buck_peak_efficiency_pct_min_target": target_values["buck_peak_efficiency_pct_min"],
            "rail_count": len(pmic_rails),
        },
        "rail_budget": rail_budget,
        "voltage_domains_present": sorted(voltage_domains),
        "runtime_estimates_from_17p3wh_target": runtime_estimates,
        "power_targets": target_values,
        "power_layout_closure": power_layout_closure,
        "thermal_management": thermal,
        "hotspot_sources": [
            "SoC/NPU top-center graphite path",
            "PMIC/charger top-mid and USB-C bottom edge",
            "Quectel RedCap transmit bursts near top-left RF edge",
            "display backlight/bias near top-right FPC",
            "Wi-Fi/Bluetooth coexistence region",
        ],
        "release_blockers": blockers,
        "missing_required_nets_by_rail": missing_by_rail,
        "package_power_sequence_status": {
            "pmic": pmic["power_sequence"]["status"],
            "charger": charger["power_sequence"]["status"],
            "usb_pd": usb_pd["power_sequence"]["status"],
            "display": display["power_sequence"]["status"],
            "camera": camera["power_sequence"]["status"],
            "cellular": cellular["power_sequence"]["status"],
            "audio": audio["power_sequence"]["status"],
        },
        "regulatory_and_measurement_evidence_required": targets["required_measurements"],
        "must_not_claim": [
            "power_efficient",
            "thermal_closed",
            "charging_ready",
            "battery_safe",
            "skin_temperature_safe",
        ],
    }

    OUT.write_text(yaml.dump(report, Dumper=IndentedSafeDumper, sort_keys=False))
    print(f"generated {OUT}")
    print(f"pd_margin_w={report['usb_c_power_path']['pd_power_margin_w']} status={status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
