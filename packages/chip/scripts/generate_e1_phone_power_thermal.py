#!/usr/bin/env python3
"""Generate first-pass E1 phone power and thermal closure evidence."""

from __future__ import annotations

import math
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
    charge_current_a = charger["charge_profile"]["charge_current_max_a"]
    float_voltage_v = charger["charge_profile"]["float_voltage_v"]
    termination_current_ma = charger["charge_profile"]["termination_current_ma"]
    charge_power_w = charge_current_a * float_voltage_v
    charge_efficiency = target_values["charge_path_peak_efficiency_pct_min"] / 100.0
    input_power_for_max_charge_w = charge_power_w / charge_efficiency

    pmic_rails = pmic["rails"]
    buck_current_total_a = sum(
        rail["current_a_max"] for rail in pmic_rails if rail["type"] == "buck"
    )
    ldo_current_total_a = sum(rail["current_a_max"] for rail in pmic_rails if rail["type"] == "ldo")

    battery_window_fit_status = (
        f"sourced_{str(nominal_energy_wh).replace('.', 'p')}wh_pack_matches_"
        "64x87x5p6_concept_cavity_pending_supplier_and_routed_board_evidence"
    )

    # Scenario power budget. Component figures are cad/datasheet estimates for
    # a Unisoc T606-class AP, RG255C RedCap modem, Type 2EA Wi-Fi/BT module, and
    # a 5.5" FHD MIPI LCM. Each scenario lists the dominant rail draws (W at the
    # battery) so the total can be traced to a part rather than a single number.
    # These are planning estimates, not measured; the 30-min soak gate stays open.
    scenario_power_w = {
        "idle_display_off_suspended": {
            "ap_soc_aon": 0.06,
            "lpddr_self_refresh": 0.03,
            "pmic_quiescent": 0.02,
            "wifi_bt_dtim_listen": 0.05,
            "modem_idle_paging": 0.06,
            "sensors_rtc": 0.02,
        },
        "idle_display_on_web_read": {
            "ap_soc_light": 0.30,
            "display_panel_backlight": 0.30,
            "lpddr_active": 0.06,
            "pmic_buck_loss": 0.05,
            "wifi_bt_connected_idle": 0.10,
            "modem_idle_paging": 0.06,
        },
        "video_call": {
            "ap_soc_codec_isp": 0.95,
            "display_panel_backlight": 0.45,
            "camera_isp_capture": 0.35,
            "modem_active_uplink": 0.70,
            "wifi_bt_active": 0.30,
            "audio_codec_amp": 0.20,
            "lpddr_active": 0.15,
            "pmic_buck_loss": 0.10,
        },
        "sustained_ai_skin_limited": {
            "ap_soc_cluster": 1.40,
            "npu_active": 1.20,
            "lpddr_bandwidth": 0.55,
            "display_panel_backlight": 0.35,
            "pmic_buck_loss": 0.25,
            "wifi_bt_idle": 0.10,
            "modem_idle_paging": 0.06,
        },
    }
    scenario_total_w = {name: round2(sum(rails.values())) for name, rails in scenario_power_w.items()}

    runtime_estimates = {
        "idle_display_off_idle_days_at_target": round2(
            nominal_energy_wh / target_values["idle_display_off_w_max"] / 24.0
        ),
        "idle_display_on_hours_at_target": round2(
            nominal_energy_wh / target_values["idle_display_on_w_max"]
        ),
        "video_call_hours_at_target": round2(nominal_energy_wh / video_call_w),
        "sustained_ai_hours_at_skin_limited_budget": round2(nominal_energy_wh / sustained_w),
        # Same scenarios evaluated against the bottom-up component sum rather than
        # the product target ceiling, so we can see headroom against the target.
        "idle_display_off_days_at_modeled_draw": round2(
            nominal_energy_wh / scenario_total_w["idle_display_off_suspended"] / 24.0
        ),
        "idle_display_on_hours_at_modeled_draw": round2(
            nominal_energy_wh / scenario_total_w["idle_display_on_web_read"]
        ),
        "video_call_hours_at_modeled_draw": round2(
            nominal_energy_wh / scenario_total_w["video_call"]
        ),
        "sustained_ai_hours_at_modeled_draw": round2(
            nominal_energy_wh / scenario_total_w["sustained_ai_skin_limited"]
        ),
    }

    # CC/CV charge model. CC phase delivers most of the capacity at the float
    # voltage ceiling; CV phase tapers from charge_current to termination. The
    # 0-80% / full times are first-order estimates (CC fraction ~0.7 of capacity,
    # CV tail dominated by the RC of the cell) pending a measured charge-cycle log.
    capacity_ah = battery["target_capacity_mah"] / 1000.0
    cc_phase_hours = round2((0.70 * capacity_ah) / charge_current_a)
    cv_phase_hours = round2((0.30 * capacity_ah) / (0.5 * charge_current_a))
    charge_model = {
        "topology": "cc_cv_1s_single_cell",
        "charge_current_a": charge_current_a,
        "float_voltage_v": float_voltage_v,
        "termination_current_ma": termination_current_ma,
        "max_charge_power_at_cell_w": round2(charge_power_w),
        "estimated_cc_phase_hours_to_cv_entry": cc_phase_hours,
        "estimated_cv_phase_hours_to_termination": cv_phase_hours,
        "estimated_full_charge_hours": round2(cc_phase_hours + cv_phase_hours),
        "estimated_0_to_80_pct_hours": round2((0.80 * capacity_ah) / charge_current_a),
        "thermal_derate_note": (
            "JEITA thermistor profile must reduce charge_current under hot/cold "
            "cell temperature; sustained 3 A into a 5727 mAh pack is ~0.52C and "
            "needs a measured pack-temperature rise before the rate is claimed."
        ),
        "evidence_class": "cad_estimate_charge_profile_not_measured",
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
            "graphite_pgs_spreader",
            "thin_vapor_chamber_modeled_pending_soak",
            "gap_pad_to_rear_cover",
        ],
    }

    # First-order lumped thermal model. The device dissipates roughly its input
    # power to ambient across the front glass + rear cover area. Total radiating
    # area uses the enclosure footprint front+back; resistance values are
    # planning estimates from comparable hard-plastic phone bodies (no chamber
    # data). skin_rise = power * R_skin_ambient; junction_rise adds the silicon
    # internal path on top of the skin. These are cad estimates pending a soak.
    envelope = enclosure["coordinate_system"]["device_envelope"]
    front_back_area_m2 = 2.0 * (envelope["width"] / 1000.0) * (envelope["height"] / 1000.0)
    ambient_c = 25.0
    r_skin_ambient_c_per_w = 9.0
    r_junction_to_skin_c_per_w = 4.5
    skin_limit_c = target_values["thermal_skin_limit_c"]
    allowed_rise_c = skin_limit_c - ambient_c
    sustained_skin_limited_power_w = round2(allowed_rise_c / r_skin_ambient_c_per_w)
    thermal["steady_state_model"] = {
        "method": "lumped_single_node_skin_plus_series_junction_path",
        "ambient_c": ambient_c,
        "radiating_front_back_area_m2": round(front_back_area_m2, 5),
        "r_skin_to_ambient_c_per_w": r_skin_ambient_c_per_w,
        "r_junction_to_skin_c_per_w": r_junction_to_skin_c_per_w,
        "skin_limit_c": skin_limit_c,
        "allowed_skin_rise_c": round2(allowed_rise_c),
        "max_sustained_power_for_skin_limit_w": sustained_skin_limited_power_w,
        "skin_rise_at_product_budget_c": round2(sustained_w * r_skin_ambient_c_per_w),
        "skin_temp_at_product_budget_c": round2(ambient_c + sustained_w * r_skin_ambient_c_per_w),
        "junction_temp_at_product_budget_c": round2(
            ambient_c + sustained_w * (r_skin_ambient_c_per_w + r_junction_to_skin_c_per_w)
        ),
        "junction_limit_c": 105.0,
        "junction_headroom_at_product_budget_c": round2(
            105.0 - (ambient_c + sustained_w * (r_skin_ambient_c_per_w + r_junction_to_skin_c_per_w))
        ),
        "skin_budget_margin_w": round2(sustained_skin_limited_power_w - sustained_w),
        "evidence_class": "cad_estimate_lumped_model_not_chamber_measured",
        "interpretation": (
            "BARE-BODY BASELINE (no engineered spreader): at the 4.0 W sustained "
            "product budget the modeled skin reaches ~61 C, which EXCEEDS the 43 C "
            "skin limit, and the bare body only sinks ~2.0 W to a 43 C skin at 25 C "
            "ambient. The 9.0 C/W lumped resistance is dominated by hotspot "
            "spreading from the small SoC/NPU footprint, not by the body-to-air "
            "term. The mitigation_model below resolves this with a graphite + "
            "thin-vapor-chamber spreader stack plus a DVFS sustained-power cap; a "
            "measured 30-minute soak must still validate the mitigated model "
            "before any thermal claim."
        ),
    }
    # Transient first-cut: thermal mass of the body sets how long a burst can run
    # before the skin reaches the limit. C_thermal estimated from device mass and
    # an effective specific heat for a glass/plastic/Li-poly stack.
    body_mass_kg = 0.180
    effective_specific_heat_j_per_kg_k = 900.0
    c_thermal_j_per_k = body_mass_kg * effective_specific_heat_j_per_kg_k
    tau_seconds = c_thermal_j_per_k * r_skin_ambient_c_per_w
    burst_power_w = 6.0
    # Time to reach skin limit under an adiabatic burst from ambient (upper bound;
    # real curve is the RC exponential, this is the linear early-time slope).
    time_to_skin_limit_s = round2(c_thermal_j_per_k * allowed_rise_c / burst_power_w)
    thermal["transient_model"] = {
        "method": "lumped_rc_first_order",
        "estimated_body_mass_kg": body_mass_kg,
        "effective_specific_heat_j_per_kg_k": effective_specific_heat_j_per_kg_k,
        "thermal_capacitance_j_per_k": round2(c_thermal_j_per_k),
        "time_constant_seconds": round2(tau_seconds),
        "burst_power_w": burst_power_w,
        "estimated_seconds_to_skin_limit_under_burst": time_to_skin_limit_s,
        "evidence_class": "cad_estimate_lumped_rc_not_chamber_measured",
        "interpretation": (
            "A 6 W burst from a cold start has roughly "
            f"{int(time_to_skin_limit_s)} s before the modeled skin reaches 43 C, "
            "after which DVFS must drop to the steady-state passive limit. The RC "
            "time constant and capacitance are planning estimates; the real curve "
            "needs an instrumented soak with skin and junction logging."
        ),
    }

    # Thermal mitigation model. The 9.0 C/W bare-body resistance decomposes into
    # a body-surface-to-ambient term (combined natural convection + radiation over
    # the front+back area) plus a hotspot SPREADING term from the small SoC/NPU
    # footprint into that area. The body-to-air term is fixed by geometry; the
    # spreading term is what an engineered spreader stack attacks.
    #
    # Surface-to-ambient: h_total combines natural convection (~7-8 W/m2K for a
    # vertical/handheld phone surface) and radiation (~5-6 W/m2K at ~310 K skin,
    # emissivity ~0.9 for painted/glass surfaces) -> ~13 W/m2K over front+back.
    h_surface_to_ambient_w_per_m2k = 13.0
    r_surface_to_ambient_c_per_w = round2(
        1.0 / (h_surface_to_ambient_w_per_m2k * front_back_area_m2)
    )
    # Hotspot geometry: combined SoC+NPU package footprint ~12x12 mm; the spreader
    # fans heat out to ~half the device area before it leaves to air.
    soc_npu_footprint_mm = 12.0
    source_radius_m = math.sqrt((soc_npu_footprint_mm / 1000.0) ** 2 / math.pi)
    spreader_radius_m = math.sqrt((front_back_area_m2 / 2.0) / math.pi)

    def disk_spreading_resistance_c_per_w(k_w_per_mk: float, thickness_m: float) -> float:
        # Thin-disk radial constriction/spreading resistance, R = ln(b/a)/(2*pi*k*t).
        return math.log(spreader_radius_m / source_radius_m) / (
            2.0 * math.pi * k_w_per_mk * thickness_m
        )

    # Series interface resistance: SoC TIM + graphite-to-cover gap pad, planning
    # estimate for a thin (<0.6 mm) gap-pad path under modest clamp pressure.
    r_tim_series_c_per_w = 0.4

    # Bare in-board copper plane (1 oz, 35 um) is a poor spreader: this is why the
    # baseline lumped resistance is hotspot-limited rather than surface-limited.
    r_spread_bare_copper_c_per_w = round2(disk_spreading_resistance_c_per_w(385.0, 35e-6))

    # Stage 1: pyrolytic graphite sheet (PGS), Panasonic EYG-S class. In-plane
    # conductivity 1500-1950 W/mK; 100 um single layer fits the 0.2-0.6 mm
    # graphite+gap-pad z-budget in the enclosure stack.
    graphite_k_w_per_mk = 1950.0
    graphite_thickness_m = 100e-6
    r_spread_graphite_c_per_w = round2(
        disk_spreading_resistance_c_per_w(graphite_k_w_per_mk, graphite_thickness_m)
    )
    r_skin_graphite_only_c_per_w = round2(
        r_spread_graphite_c_per_w + r_surface_to_ambient_c_per_w + r_tim_series_c_per_w
    )

    # Stage 2: add a thin vapor chamber. A 0.4 mm sintered-wick chamber fits inside
    # the 11.8 mm slab once the battery is the dominant z-consumer; its effective
    # in-plane conductivity (~8000 W/mK, conservative for thin chambers that are
    # often cited at 5000-20000) drives the spreading term toward negligible, so
    # the body-surface-to-ambient term sets the limit.
    vapor_chamber_k_w_per_mk = 8000.0
    vapor_chamber_thickness_m = 0.4e-3
    r_spread_vapor_chamber_c_per_w = round2(
        disk_spreading_resistance_c_per_w(vapor_chamber_k_w_per_mk, vapor_chamber_thickness_m)
    )
    r_skin_graphite_plus_vc_c_per_w = round2(
        r_spread_vapor_chamber_c_per_w
        + r_surface_to_ambient_c_per_w
        + r_tim_series_c_per_w
    )

    sustained_graphite_only_w = round2(allowed_rise_c / r_skin_graphite_only_c_per_w)
    sustained_graphite_plus_vc_w = round2(allowed_rise_c / r_skin_graphite_plus_vc_c_per_w)

    # DVFS sustained-power cap: hold sustained silicon at the modeled mitigated
    # passive limit so the modeled skin stays at or below 43 C. With the graphite +
    # vapor-chamber stack the passive limit lands above the 4.0 W product budget,
    # so the cap is set to the 4.0 W budget and the model reports the resulting
    # skin temp and the headroom to the mitigated passive ceiling.
    dvfs_sustained_cap_w = min(sustained_w, sustained_graphite_plus_vc_w)
    skin_at_dvfs_cap_c = round2(ambient_c + dvfs_sustained_cap_w * r_skin_graphite_plus_vc_c_per_w)
    junction_at_dvfs_cap_c = round2(
        ambient_c
        + dvfs_sustained_cap_w * (r_skin_graphite_plus_vc_c_per_w + r_junction_to_skin_c_per_w)
    )

    # Burst budget before throttle: reuse the lumped RC capacitance. From a cold
    # start the body can absorb a higher burst power for the time it takes the
    # modeled skin to climb from ambient to 43 C, after which DVFS clamps to the
    # sustained cap. Burst here is the same 6 W ceiling as the transient model.
    burst_seconds_before_throttle = round2(c_thermal_j_per_k * allowed_rise_c / burst_power_w)

    # Sustained-throughput tradeoff. The sustained_ai scenario spends
    # ap_soc_cluster + npu_active on compute; the rest is display/rail/radio
    # overhead that does not scale with the AI workload. The DVFS cap derates the
    # available compute power, and the implied AI throughput scales with the
    # compute-power fraction that survives the cap. Throughput is expressed as a
    # derate factor against the 3B-INT4 100 tok/s / 7B-INT4 30 tok/s SPEC TARGETS,
    # not as a measured rate.
    sustained_scenario = scenario_power_w["sustained_ai_skin_limited"]
    compute_power_w = round2(sustained_scenario["ap_soc_cluster"] + sustained_scenario["npu_active"])
    fixed_overhead_w = round2(scenario_total_w["sustained_ai_skin_limited"] - compute_power_w)
    capped_compute_power_w = round2(
        min(max(dvfs_sustained_cap_w - fixed_overhead_w, 0.0), compute_power_w)
    )
    compute_duty_or_derate = round(capped_compute_power_w / compute_power_w, 3)

    thermal["mitigation_model"] = {
        "method": "spreading_plus_surface_decomposition_with_graphite_and_thin_vapor_chamber",
        "ambient_c": ambient_c,
        "skin_limit_c": skin_limit_c,
        "allowed_skin_rise_c": round2(allowed_rise_c),
        "resistance_decomposition_c_per_w": {
            "bare_body_lumped_baseline": r_skin_ambient_c_per_w,
            "surface_to_ambient_fixed_by_geometry": r_surface_to_ambient_c_per_w,
            "hotspot_spread_bare_copper_plane": r_spread_bare_copper_c_per_w,
            "tim_and_gap_pad_series": r_tim_series_c_per_w,
            "h_surface_to_ambient_w_per_m2k": h_surface_to_ambient_w_per_m2k,
            "note": (
                "Combined natural-convection plus radiation over the front+back "
                "area sets ~3.2 C/W; the rest of the 9.0 C/W baseline is hotspot "
                "spreading through the bare copper plane (~30 C/W lateral)."
            ),
        },
        "spreader_stack": {
            "soc_npu_footprint_mm_square": soc_npu_footprint_mm,
            "graphite_pgs": {
                "part_class": "pyrolytic_graphite_sheet_panasonic_eyg_s_class",
                "in_plane_k_w_per_mk": graphite_k_w_per_mk,
                "thickness_um": round(graphite_thickness_m * 1e6, 1),
                "spreading_resistance_c_per_w": r_spread_graphite_c_per_w,
                "fits_z_budget_note": (
                    "100 um PGS fits the 0.2-0.6 mm graphite+gap-pad layer in the "
                    "enclosure z-stack."
                ),
            },
            "thin_vapor_chamber": {
                "form_factor": "sintered_wick_thin_chamber_0p4mm",
                "effective_in_plane_k_w_per_mk": vapor_chamber_k_w_per_mk,
                "thickness_mm": round(vapor_chamber_thickness_m * 1e3, 2),
                "spreading_resistance_c_per_w": r_spread_vapor_chamber_c_per_w,
                "feasibility_note": (
                    "0.4 mm chamber fits the 11.8 mm slab alongside the 5.6 mm "
                    "battery; effective k is held conservative (thin chambers are "
                    "often cited at 5000-20000 W/mK)."
                ),
            },
        },
        "effective_skin_resistance_c_per_w": {
            "graphite_only": r_skin_graphite_only_c_per_w,
            "graphite_plus_vapor_chamber": r_skin_graphite_plus_vc_c_per_w,
        },
        "mitigated_passive_sustained_w": {
            "graphite_only": sustained_graphite_only_w,
            "graphite_plus_vapor_chamber": sustained_graphite_plus_vc_w,
        },
        "dvfs_policy": {
            "sustained_power_cap_w": dvfs_sustained_cap_w,
            "skin_temp_at_cap_c": skin_at_dvfs_cap_c,
            "junction_temp_at_cap_c": junction_at_dvfs_cap_c,
            "junction_limit_c": 105.0,
            "skin_margin_to_limit_c": round2(skin_limit_c - skin_at_dvfs_cap_c),
            "burst_power_w": burst_power_w,
            "burst_seconds_before_throttle_from_cold": burst_seconds_before_throttle,
            "throttle_behavior": (
                "From a cold start the scheduler allows the 6 W burst for the "
                "modeled cold-start window, then clamps sustained silicon to the "
                f"{dvfs_sustained_cap_w} W cap so the modeled skin holds at "
                f"{skin_at_dvfs_cap_c} C, at or below the 43 C limit. The graphite "
                "+ vapor-chamber passive ceiling sits above the 4.0 W budget, so "
                "the cap is set by the product budget, not by the spreader."
            ),
        },
        "sustained_throughput_tradeoff": {
            "sustained_ai_compute_power_w": compute_power_w,
            "fixed_non_compute_overhead_w": fixed_overhead_w,
            "capped_compute_power_w": capped_compute_power_w,
            "compute_power_derate_factor": compute_duty_or_derate,
            "spec_target_reference": (
                "docs/spec-db/npu-2028-target.yaml: 3B INT4 100 tok/s sustained, "
                "7B INT4 30 tok/s sustained (TARGETS, not measured)."
            ),
            "implied_sustained_ai_throughput_note": (
                "At the "
                f"{dvfs_sustained_cap_w} W cap the full {compute_power_w} W AI "
                "compute budget survives (derate "
                f"{compute_duty_or_derate}x), so the modeled sustained AI workload "
                "runs at the 100% duty point against the spec tok/s targets. If a "
                "measured soak forces a lower cap, multiply the spec tok/s targets "
                "by the realized compute_power_derate_factor to get the honest "
                "sustained rate."
            ),
        },
        "evidence_class": "cad_estimate_model_not_measured",
        "residual_measurement_required": (
            "This mitigation is a CAD/material-property model. A 30-minute "
            "instrumented CPU/NPU/modem/camera thermal soak with skin, junction, "
            "and spreader-interface logging at 25 C ambient must validate the "
            "graphite + vapor-chamber resistances, the DVFS cap, and the burst "
            "window before any skin-temperature claim. The release gate stays open."
        ),
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
        "vapor_chamber_trigger": (
            "thin vapor chamber is modeled into the mitigation stack to bring the "
            "passive sustained ceiling above the 4 W budget at 43 C skin; a "
            "measured soak must confirm the modeled effective conductivity before "
            "the chamber is treated as validated rather than required"
        ),
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
            "battery_window_fit_status": battery_window_fit_status,
            "required_missing_parts": battery["required_missing_parts"],
        },
        "usb_c_power_path": {
            "pd_controller": usb_pd["part"],
            "charger": charger["part"],
            "pd_sink_profiles": pd_profiles,
            "max_pd_sink_power_w": max_pd_sink_w,
            "max_charge_current_a": charge_current_a,
            "max_charge_power_at_cell_w": round2(charge_power_w),
            "estimated_input_power_for_max_charge_w": round2(input_power_for_max_charge_w),
            "charge_path_peak_efficiency_pct_min": target_values[
                "charge_path_peak_efficiency_pct_min"
            ],
            "pd_power_margin_w": round2(max_pd_sink_w - input_power_for_max_charge_w),
            "passes_evt0_pd_power_margin": max_pd_sink_w > input_power_for_max_charge_w,
            "charge_model": charge_model,
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
        "scenario_power_budget_w": scenario_power_w,
        "scenario_total_power_w": scenario_total_w,
        "runtime_estimates_from_selected_pack_target": runtime_estimates,
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
    mitigation = thermal["mitigation_model"]["dvfs_policy"]
    print(f"generated {OUT}")
    print(f"pd_margin_w={report['usb_c_power_path']['pd_power_margin_w']} status={status}")
    print(
        "thermal_mitigation: bare_skin@4W="
        f"{thermal['steady_state_model']['skin_temp_at_product_budget_c']}C "
        f"mitigated_skin@cap={mitigation['skin_temp_at_cap_c']}C "
        f"cap={mitigation['sustained_power_cap_w']}W "
        f"limit={thermal['skin_limit_c']}C"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
