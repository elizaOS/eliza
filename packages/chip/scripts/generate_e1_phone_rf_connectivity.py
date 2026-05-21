#!/usr/bin/env python3
"""Generate RF and wireless connectivity closure evidence for the E1 phone board."""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml"

# Full-wave EM solvers that could turn the S11/efficiency planning targets into
# em_simulated_not_chamber_measured values. None ships in this toolchain today.
EM_SOLVER_BINARIES = ("openEMS", "AppCSXCAD", "nec2c", "necpp", "meep")
EM_SOLVER_PY_MODULES = ("openEMS", "CSXCAD", "PyNEC", "meep", "skrf", "pyems")

SOURCES = {
    "routing": ROOT / "board/kicad/e1-phone/routing-constraints.yaml",
    "netlist": ROOT / "board/kicad/e1-phone/block-netlist.yaml",
    "matrix": ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml",
    "cellular": ROOT / "package/cellular/quectel-5g-redcap.yaml",
    "wifi_bt": ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml",
    "enclosure": ROOT / "docs/board/e1-phone-enclosure-interface.yaml",
    "mechanical_overlay": ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml",
    "cad_params": ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml",
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


def keepout_audit(overlay_keepouts: dict[str, Any], cad_radio: dict[str, Any], board_bbox: dict[str, float]) -> dict[str, Any]:
    """Geometric cad-estimate cross-check of routed antenna keepouts against the
    board outline and the CAD per-radio keepout envelopes. Not an EM solver."""
    board_w = float(board_bbox["width"])
    board_h = float(board_bbox["height"])
    cell_cad = cad_radio["cellular"]["antenna_keepout_mm"]
    wifi_cad = cad_radio["wifi_bt"]["antenna_keepout_mm"]
    audit: list[dict[str, Any]] = []
    for keepout_id, cad_len_w in (
        ("top_antenna_keepout", float(cell_cad[0])),
        ("bottom_antenna_keepout", float(cell_cad[0])),
        ("wifi_bt_side_antenna_keepout", float(wifi_cad[0])),
    ):
        rect = overlay_keepouts[keepout_id]["rect_mm"]
        x, y, w, h = float(rect["x"]), float(rect["y"]), float(rect["width"]), float(rect["height"])
        within_board = (x >= 0.0) and (y >= 0.0) and (x + w <= board_w) and (y + h <= board_h)
        # The CAD per-radio keepout is defined in the 78 mm device envelope; the
        # routed board is only 64 mm wide, so the clear edge length is bounded by
        # the board outline. A routed length shorter than the CAD width is the
        # expected coordinate-space difference, not a layout error: the antenna
        # plastic can extend past the board edge into the enclosure wall.
        audit.append(
            {
                "keepout_id": keepout_id,
                "routed_rect_mm": {"x": x, "y": y, "width": w, "height": h},
                "routed_clear_length_mm": round(w, 3),
                "routed_clear_area_mm2": round(w * h, 3),
                "cad_envelope_keepout_width_mm": round(cad_len_w, 3),
                "routed_within_64x132_board_outline": within_board,
                "board_edge_limits_routed_length_below_cad_envelope": w < cad_len_w,
                "max_board_clear_length_mm": round(board_w - 2.0 * x, 3),
            }
        )
    return {
        "evidence_class": "cad_estimate_geometric_cross_check_not_em_solver",
        "coordinate_note": (
            "Routed keepouts are in the 64x132 mm board frame; CAD per-radio "
            "antenna_keepout_mm is in the 78x153.6x11.8 mm device envelope. "
            "Routed clear length is bounded by the board outline and the antenna "
            "plastic edge extends past the board into the enclosure wall."
        ),
        "board_bbox_mm": {"width": board_w, "height": board_h},
        "device_envelope_mm": [78.0, 153.6, 11.8],
        "results": audit,
        "all_keepouts_within_board_outline": all(item["routed_within_64x132_board_outline"] for item in audit),
        "all_routed_lengths_bounded_by_board_edge": all(item["routed_clear_length_mm"] <= board_w for item in audit),
    }


# Band plan grounded in the selected module public specs: Quectel RG255C is a
# 3GPP Rel-17 5G RedCap Sub-6 module with LTE Cat-4 fallback and optional
# multi-constellation GNSS; Murata Type 2EA / Infineon CYW55573 is Wi-Fi 6E
# (2.4/5/6 GHz) 2x2 MIMO plus Bluetooth 5.3. Frequencies are public band-edge
# values; S11/efficiency numbers are pre-layout planning targets, not measured.
RF_BAND_PLAN = [
    {
        "net": "CELL_RF_MAIN",
        "role": "cellular_main_tx_rx",
        "bands": "LTE/NR Sub-6 low+mid band; exact matrix follows region SKU",
        "freq_range_mhz": [617, 3800],
        "target_s11_db_max": -6.0,
        "target_total_efficiency_pct_min": 35.0,
        "rationale": "Compact 64 mm-wide board with a 58 mm clear edge slot; low-band efficiency is limited by the small ground clearance, so a -6 dB worst-case S11 and 35% total-efficiency floor are realistic pre-tune planning targets.",
    },
    {
        "net": "CELL_RF_DIV",
        "role": "cellular_diversity_rx",
        "bands": "LTE/NR Sub-6 diversity, mirror of main band matrix",
        "freq_range_mhz": [617, 3800],
        "target_s11_db_max": -6.0,
        "target_total_efficiency_pct_min": 30.0,
        "rationale": "Diversity feed on the opposite plastic edge accepts lower efficiency than main; primary requirement is envelope-correlation and isolation from main, proven by VNA S21.",
    },
    {
        "net": "CELL_GNSS_RF",
        "role": "gnss_l1_rx",
        "bands": "GNSS L1 (GPS L1 / GLONASS L1 / Galileo E1)",
        "freq_range_mhz": [1559, 1610],
        "target_s11_db_max": -10.0,
        "target_total_efficiency_pct_min": 40.0,
        "rationale": "Narrow passive L1 band tunes tighter than the wideband cellular feeds; receive-only LNA path tolerates a -10 dB match, but desense from Wi-Fi 2.4 GHz 2nd harmonic and cellular harmonics is the dominant risk.",
    },
    {
        "net": "WIFI_BT_RF0",
        "role": "wifi6e_bt_chain0",
        "bands": "Wi-Fi 2.4/5/6 GHz + Bluetooth 5.3 (2.4 GHz)",
        "freq_range_mhz": [2400, 7125],
        "target_s11_db_max": -8.0,
        "target_total_efficiency_pct_min": 45.0,
        "rationale": "Tri-band 2x2 chain shares one feed across 2.4/5/6 GHz; a -8 dB band-worst-case S11 and 45% efficiency floor are achievable with a side-edge PIFA and pi matching network.",
    },
    {
        "net": "WIFI_BT_RF1",
        "role": "wifi6e_bt_chain1",
        "bands": "Wi-Fi 2.4/5/6 GHz 2x2 MIMO second chain",
        "freq_range_mhz": [2400, 7125],
        "target_s11_db_max": -8.0,
        "target_total_efficiency_pct_min": 45.0,
        "rationale": "Second MIMO chain must be spatially separated from chain0; envelope-correlation-coefficient and chain-to-chain isolation are supplier_defined and require measurement.",
    },
]


def probe_em_solvers() -> dict[str, Any]:
    """Detect a real full-wave EM solver in the local toolchain.

    The S11/total-efficiency numbers in RF_BAND_PLAN are pre-layout planning
    targets. The next honest rung up the evidence ladder (still below a physical
    VNA/chamber measurement) is a full-wave EM simulation of the antenna feeds.
    That requires an FDTD/MoM solver. This probe records which solvers are
    present so the artifact either carries an em_simulated tier or fails closed
    with a named tooling blocker -- it never fabricates S-parameters."""
    binaries = {name: shutil.which(name) for name in EM_SOLVER_BINARIES}
    modules = {
        name: bool(importlib.util.find_spec(name)) for name in EM_SOLVER_PY_MODULES
    }
    found_binaries = sorted(name for name, path in binaries.items() if path)
    found_modules = sorted(name for name, present in modules.items() if present)
    return {
        "available": bool(found_binaries) or bool(found_modules),
        "binaries": binaries,
        "found_binaries": found_binaries,
        "python_modules": modules,
        "found_python_modules": found_modules,
    }


def build_em_simulation(probe: dict[str, Any], cad_params: dict[str, Any]) -> dict[str, Any]:
    """Record the EM-simulation evidence tier.

    When no solver is available the block fails closed: it states the missing
    dependency, the exact tooling that would unblock it, and the model that
    would be run -- without emitting any simulated S-parameter. No EM solver is
    bundled in this toolchain today, so this is the path taken. If a solver is
    later added to tools/env.sh, this block is where the real
    em_simulated_not_chamber_measured sweep is wired in."""
    thickness_mm = float(cad_params["device"]["envelope_mm"][2])
    wall_mm = float(cad_params["device"].get("wall_thickness_mm", 0.0))
    board_w_mm = 64.0
    if probe["available"]:
        raise RuntimeError(
            "An EM solver is present on PATH/in the venv "
            f"(binaries={probe['found_binaries']}, modules={probe['found_python_modules']}), "
            "but the simulated S11/efficiency sweep wiring has not been implemented. "
            "Implement the openEMS/PyNEC model here rather than falling through to the "
            "blocked tier, so the artifact does not understate available evidence."
        )
    return {
        "evidence_class": "em_simulation_blocked_missing_solver",
        "status": "blocked",
        "rung_above": "planning_estimate_not_vna_measured",
        "rung_below": "vna_and_anechoic_chamber_measured",
        "reason": (
            "No full-wave EM solver (FDTD or MoM) is installed in this toolchain. "
            "The S11/total-efficiency planning targets in s11_and_efficiency_plan "
            "cannot be promoted to em_simulated_not_chamber_measured without one. "
            "No S-parameters are fabricated."
        ),
        "solver_probe": {
            "checked_binaries": list(EM_SOLVER_BINARIES),
            "checked_python_modules": list(EM_SOLVER_PY_MODULES),
            "found_binaries": probe["found_binaries"],
            "found_python_modules": probe["found_python_modules"],
        },
        "tooling_required_to_unblock": [
            "openEMS (FDTD) + CSXCAD/python-openEMS bindings, or",
            "an MoM solver (PyNEC/necpp) for the wire/PIFA approximation, or",
            "MEEP (FDTD) with the python bindings",
            "scikit-rf (skrf) to post-process the resulting Touchstone S-parameters",
        ],
        "unblock_command": "add openEMS + python-openEMS to external/ and tools/env.sh, then re-run make e1-phone-rf-connectivity",
        "intended_model_when_solver_present": {
            "structure": "side-fed planar inverted-F (PIFA) / monopole on a finite ground plane",
            "ground_plane_width_mm": board_w_mm,
            "substrate_thickness_mm": thickness_mm,
            "enclosure_wall_thickness_mm": wall_mm,
            "feeds_to_model": [
                {"net": "CELL_RF_MAIN", "bands_ghz": [0.617, 3.8], "geometry": "edge-slot PIFA in the cellular keepout"},
                {"net": "WIFI_BT_RF0", "bands_ghz": [2.4, 7.125], "geometry": "side-edge PIFA in the wifi_bt keepout"},
                {"net": "CELL_GNSS_RF", "bands_ghz": [1.559, 1.61], "geometry": "narrow L1 monopole/PIFA"},
            ],
            "outputs": "simulated S11 (return loss) and total efficiency vs the module band plans, tagged em_simulated_not_chamber_measured with solver name+version and mesh/boundary assumptions",
        },
        "residual_measurement": (
            "An EM simulation, when added, is still below a physical measurement. "
            "VNA S11/S21 and anechoic-chamber total-efficiency on a fabricated EVT0 "
            "board remain the binding evidence and are unchanged by this tier."
        ),
    }


def _placement_center(placement: dict[str, Any]) -> tuple[float, float]:
    region = placement["region_mm"]
    return (
        float(region["x"]) + float(region["width"]) / 2.0,
        float(region["y"]) + float(region["height"]) / 2.0,
    )


def build_plan_estimates(placements: dict[str, Any], cad_params: dict[str, Any]) -> dict[str, Any]:
    """Pre-layout planning estimates: S11/efficiency targets, feed spatial
    separation derived from the placement matrix and 11.8 mm envelope, and a
    SAR pre-scan planning estimate. All values are planning targets that a real
    EM/VNA/SAR-lab measurement must replace before any RF claim."""
    cell_center = _placement_center(placements["U_CELL"])
    wifi_center = _placement_center(placements["U_WIFI_BT"])
    module_center_separation_mm = round(
        ((cell_center[0] - wifi_center[0]) ** 2 + (cell_center[1] - wifi_center[1]) ** 2) ** 0.5, 2
    )
    thickness_mm = float(cad_params["device"]["envelope_mm"][2])
    wall_mm = float(cad_params["manufacturing"].get("rib_thickness_mm", 0.75))
    max_skin_temp_c = cad_params["tolerances"]["environmental_targets"]["max_skin_temp_c"]

    return {
        "s11_and_efficiency": {
            "evidence_class": "planning_estimate_not_vna_measured",
            "method": "pre-layout antenna budget keyed to module public band plan and board ground clearance",
            "per_feed": RF_BAND_PLAN,
            "residual_measurement": "VNA S11 per feed and chamber total-efficiency/realized-gain sweep on a routed EVT0 board with conducted access; planning targets are not pass criteria.",
        },
        "feed_isolation_plan": {
            "evidence_class": "planning_estimate_not_vna_measured",
            "module_center_separation_mm": module_center_separation_mm,
            "device_width_mm": float(cad_params["device"]["envelope_mm"][0]),
            "targets": [
                {"pair": "cellular_main_to_cellular_diversity", "target_isolation_db_min": 10.0, "basis": "opposite-edge feeds in a 78 mm-wide enclosure"},
                {"pair": "wifi_chain0_to_wifi_chain1", "target_isolation_db_min": 10.0, "basis": "2x2 MIMO chains, supplier-defined ECC requirement"},
                {"pair": "wifi_to_cellular_main", "target_isolation_db_min": 12.0, "basis": "cross-radio coexistence in compact midframe"},
            ],
            "residual_measurement": "VNA S21 isolation matrix across all feed pairs on a routed board.",
        },
        "sar_prescan_plan": {
            "evidence_class": "planning_estimate_not_sar_lab_measured",
            "device_thickness_mm": thickness_mm,
            "back_wall_thickness_mm": wall_mm,
            "body_separation_basis": "flush-back 11.8 mm slab held against torso; no metal midframe over antenna keepouts keeps the radiating edges closest to the plastic wall",
            "exposure_states": [
                {"state": "cellular_tx_max_against_body", "limit_standard": "FCC 1.6 W/kg 1g / CE 2.0 W/kg 10g", "status": "planning_estimate_requires_sar_lab"},
                {"state": "cellular_tx_plus_wifi_tx", "limit_standard": "simultaneous-transmission SAR aggregation", "status": "planning_estimate_requires_sar_lab"},
                {"state": "cellular_tx_plus_usb_c_charging", "limit_standard": "SAR with charging/thermal interaction", "status": "planning_estimate_requires_sar_lab"},
            ],
            "skin_temperature_coupling_c_max": max_skin_temp_c,
            "residual_measurement": "Near-field SAR scan in the final orange PC/ABS enclosure plastics with production antenna gains and modem transmit power; no SAR claim is permitted until measured.",
        },
    }


def main() -> int:
    routing = load_yaml(SOURCES["routing"])
    netlist = load_yaml(SOURCES["netlist"])
    matrix = load_yaml(SOURCES["matrix"])
    cellular = load_yaml(SOURCES["cellular"])
    wifi_bt = load_yaml(SOURCES["wifi_bt"])
    enclosure = load_yaml(SOURCES["enclosure"])
    overlay = load_yaml(SOURCES["mechanical_overlay"])
    cad_params = load_yaml(SOURCES["cad_params"])

    all_nets: set[str] = set()
    for block in netlist["blocks"]:
        all_nets.update(flatten_net_groups(block["nets"]))

    placements = {item["refdes_group"]: item for item in matrix["placements"]}
    routing_rf_nets = {item["net"] for item in routing["rf_layout"]["matching_networks_required"]}
    antenna_keepouts = {item["name"]: item for item in routing["rf_layout"]["antenna_keepouts"]}
    overlay_keepouts = {item["id"]: item for item in overlay["keepouts"]}
    required_rf_nets = {
        "CELL_RF_MAIN",
        "CELL_RF_DIV",
        "CELL_GNSS_RF",
        "WIFI_BT_RF0",
        "WIFI_BT_RF1",
    }
    required_high_speed = {
        "CELL_USB2_DP",
        "CELL_USB2_DN",
        "CELL_PCIE_TX_P",
        "CELL_PCIE_TX_N",
        "CELL_PCIE_RX_P",
        "CELL_PCIE_RX_N",
        "WIFI_PCIE_TX_P",
        "WIFI_PCIE_TX_N",
        "WIFI_PCIE_RX_P",
        "WIFI_PCIE_RX_N",
    }
    cellular_high_speed = {net for net in required_high_speed if net.startswith("CELL_")}
    required_control = {
        "CELL_RESET_N",
        "CELL_WAKE_AP",
        "AP_WAKE_CELL",
        "CELL_W_DISABLE_N",
        "USIM_CLK",
        "USIM_RST",
        "USIM_IO",
        "WIFI_EN",
        "BT_EN",
        "WIFI_IRQ",
        "WIFI_HOST_WAKE",
        "BT_UART_TX",
        "BT_UART_RX",
        "BT_UART_CTS_N",
        "BT_UART_RTS_N",
    }

    cellular_ports = cellular["host_interfaces"]["rf_ports"]
    wifi_specs = wifi_bt["vendor_public_specs"]
    interfaces = [
        {
            "name": "cellular_5g_redcap",
            "module": cellular["primary_first_phone"],
            "placement": placements["U_CELL"],
            "block": "U_CELL",
            "minimum_rf_ports": cellular_ports["minimum_first_board"],
            "production_rf_ports": cellular_ports["production_target"],
            "required_nets": sorted(
                {
                    "RF_VBAT",
                    "IO_1V8",
                    *cellular_high_speed.intersection(all_nets),
                    "CELL_RESET_N",
                    "CELL_WAKE_AP",
                    "AP_WAKE_CELL",
                    "CELL_W_DISABLE_N",
                    "USIM_CLK",
                    "USIM_RST",
                    "USIM_IO",
                    "CELL_RF_MAIN",
                    "CELL_RF_DIV",
                    "CELL_GNSS_RF",
                }
            ),
            "matching_networks_present": sorted(
                routing_rf_nets.intersection({"CELL_RF_MAIN", "CELL_RF_DIV", "CELL_GNSS_RF"})
            ),
            "layout_requirements": cellular["layout_requirements"],
            "release_blockers": cellular["release_blockers"],
        },
        {
            "name": "wifi6e_bluetooth_5p3",
            "module": {
                "vendor": wifi_specs["vendor"],
                "order_number": wifi_specs["order_number"],
                "chipset": wifi_specs["chipset"],
                "wireless": wifi_specs["wireless"],
                "package_mm": wifi_specs["package_mm"],
            },
            "placement": placements["U_WIFI_BT"],
            "block": "U_WIFI_BT",
            "required_nets": sorted(
                {
                    "RF_VBAT",
                    "IO_1V8",
                    "WIFI_PCIE_TX_P",
                    "WIFI_PCIE_TX_N",
                    "WIFI_PCIE_RX_P",
                    "WIFI_PCIE_RX_N",
                    "WIFI_SDIO_CLK",
                    "WIFI_SDIO_CMD",
                    "WIFI_SDIO_D0",
                    "WIFI_SDIO_D1",
                    "WIFI_SDIO_D2",
                    "WIFI_SDIO_D3",
                    "BT_UART_TX",
                    "BT_UART_RX",
                    "BT_UART_CTS_N",
                    "BT_UART_RTS_N",
                    "WIFI_EN",
                    "BT_EN",
                    "WIFI_IRQ",
                    "WIFI_HOST_WAKE",
                    "WIFI_BT_RF0",
                    "WIFI_BT_RF1",
                }
            ),
            "matching_networks_present": sorted(
                routing_rf_nets.intersection({"WIFI_BT_RF0", "WIFI_BT_RF1"})
            ),
            "layout_requirements": wifi_bt["layout_requirements"],
        },
    ]

    missing = sorted((required_rf_nets | required_high_speed | required_control) - all_nets)
    missing_matching = sorted(required_rf_nets - routing_rf_nets)
    missing_keepouts = sorted({"top_antenna", "bottom_antenna"} - set(antenna_keepouts))
    missing_overlay_keepouts = sorted(
        {"top_antenna_keepout", "bottom_antenna_keepout", "wifi_bt_side_antenna_keepout"}
        - set(overlay_keepouts)
    )
    top_edge_constraints = enclosure["edge_interfaces"]["top_edge"]["constraints"]
    bottom_edge_constraints = enclosure["edge_interfaces"]["bottom_edge"]["constraints"]

    audit = keepout_audit(overlay_keepouts, cad_params["radio"], matrix["board"]["bbox_mm"])
    plan_estimates = build_plan_estimates(placements, cad_params)
    em_simulation = build_em_simulation(probe_em_solvers(), cad_params)
    status = (
        "blocked_rf_requires_antenna_vendor_and_measurements"
        if missing or missing_matching or missing_keepouts or missing_overlay_keepouts
        else "planning_rf_connectivity_cross_checked_not_measured"
    )

    report = {
        "schema": "eliza.e1_phone_rf_connectivity_closure.v1",
        "status": status,
        "claim_boundary": (
            "Cross-checks radio module bindings, logical nets, RF matching "
            "requirements, antenna keepouts, and enclosure constraints. This is "
            "not RF layout signoff, VNA data, conducted/radiated test evidence, "
            "SAR evidence, or carrier certification."
        ),
        "source_files": [str(path.relative_to(ROOT)) for path in SOURCES.values()],
        "interfaces": interfaces,
        "required_rf_nets": sorted(required_rf_nets),
        "required_radio_high_speed_and_control_nets": sorted(
            required_high_speed | required_control
        ),
        "missing_required_nets": missing,
        "matching_networks_required": routing["rf_layout"]["matching_networks_required"],
        "missing_matching_networks": missing_matching,
        "antenna_keepouts": routing["rf_layout"]["antenna_keepouts"],
        "missing_antenna_keepouts": missing_keepouts,
        "mechanical_overlay_rf_keepouts_present": sorted(
            {"top_antenna_keepout", "bottom_antenna_keepout", "wifi_bt_side_antenna_keepout"}
            & set(overlay_keepouts)
        ),
        "missing_mechanical_overlay_rf_keepouts": missing_overlay_keepouts,
        "test_access": routing["rf_layout"]["test_access"],
        "enclosure_rf_constraints": {
            "top_edge": top_edge_constraints,
            "bottom_edge": bottom_edge_constraints,
        },
        "coexistence_risks": [
            "cellular main/diversity isolation inside compact 78 mm wide enclosure",
            "Wi-Fi 6E 2x2 antenna placement versus cellular top/bottom antennas",
            "GNSS desense from Wi-Fi/cellular harmonics and display/PMIC noise",
            "USB-C shell grounding interaction with bottom antenna feed",
            "SAR/skin-temperature interaction during modem transmit and charging",
        ],
        "coexistence_test_matrix": [
            {
                "case": "cellular_tx_vs_wifi_bt",
                "radios_active": ["cellular_tx", "wifi_2p4_or_5_or_6_ghz", "bluetooth"],
                "aggressor_victim": [
                    {"aggressor": "cellular_tx_n7_n38_2500_2700_mhz", "victim": "wifi_bt_2p4_ghz", "mechanism": "adjacent-band blocking and intermod near the 2.4 GHz edge"},
                    {"aggressor": "wifi_5_6_ghz_tx", "victim": "cellular_n77_n78_3300_3800_mhz", "mechanism": "out-of-band emission into NR mid-band"},
                ],
                "evidence_required": "conducted sensitivity/output-power delta and firmware coexistence log",
            },
            {
                "case": "cellular_tx_vs_gnss",
                "radios_active": ["cellular_tx", "gnss_optional"],
                "aggressor_victim": [
                    {"aggressor": "cellular_tx_harmonics", "victim": "gnss_l1_1575_mhz", "mechanism": "modem TX harmonic/spur landing in the L1 receive band"},
                ],
                "evidence_required": "GNSS C/N0 degradation and cellular harmonic/desense sweep",
            },
            {
                "case": "wifi_2x2_vs_cellular_antennas",
                "radios_active": [
                    "wifi_mimo_rf0",
                    "wifi_mimo_rf1",
                    "cellular_main",
                    "cellular_diversity",
                ],
                "aggressor_victim": [
                    {"aggressor": "wifi_2p4_ghz_2nd_harmonic_~4800_5000_mhz", "victim": "wifi_5_ghz_rx", "mechanism": "self-desense across MIMO chains"},
                    {"aggressor": "wifi_2p4_ghz_2nd_harmonic", "victim": "gnss_l1_1575_mhz", "mechanism": "classic 2.4 GHz harmonic vs GNSS L1 desense path"},
                ],
                "evidence_required": "VNA S21 isolation matrix and antenna efficiency report",
            },
            {
                "case": "charger_display_noise_vs_radios",
                "radios_active": [
                    "usb_c_charging",
                    "display_bias_on",
                    "cellular_idle_or_rx",
                    "wifi_rx",
                ],
                "aggressor_victim": [
                    {"aggressor": "usb_c_charging_switching_and_display_bias_boost", "victim": "gnss_l1_and_cellular_low_band_rx", "mechanism": "broadband conducted/radiated switching noise raising the receive noise floor"},
                ],
                "evidence_required": "noise-floor and packet-error-rate comparison with charger/display states toggled",
            },
        ],
        "antenna_keepout_audit": audit,
        "s11_and_efficiency_plan": plan_estimates["s11_and_efficiency"],
        "em_simulation": em_simulation,
        "feed_isolation_plan": plan_estimates["feed_isolation_plan"],
        "sar_prescan_plan": plan_estimates["sar_prescan_plan"],
        "antenna_feed_assignments": [
            {
                "net": "CELL_RF_MAIN",
                "role": "cellular_main",
                "candidate_zone": "top_or_bottom_plastic_edge_after_vendor_review",
                "requires_conducted_access": True,
            },
            {
                "net": "CELL_RF_DIV",
                "role": "cellular_diversity",
                "candidate_zone": "opposite_plastic_edge_or_side_slot_after_vendor_review",
                "requires_conducted_access": True,
            },
            {
                "net": "CELL_GNSS_RF",
                "role": "gnss_optional",
                "candidate_zone": "top_edge_or_dedicated_lna_path_if_desense_allows",
                "requires_conducted_access": True,
            },
            {
                "net": "WIFI_BT_RF0",
                "role": "wifi_bt_chain0",
                "candidate_zone": "side_plastic_or_top_edge_after_vendor_review",
                "requires_conducted_access": True,
            },
            {
                "net": "WIFI_BT_RF1",
                "role": "wifi_bt_chain1",
                "candidate_zone": "spatially_separated_side_or_bottom_edge_after_vendor_review",
                "requires_conducted_access": True,
            },
        ],
        "required_measurements_before_release": [
            "VNA S11/S21 on every antenna feed with EVT0 conducted access",
            "conducted cellular and Wi-Fi output power and sensitivity",
            "radiated pre-scan for FCC/CE/RED and module grant conditions",
            "coexistence test for Wi-Fi/Bluetooth/cellular/GNSS",
            "SAR and RF exposure pre-scan in final enclosure plastics",
            "carrier/PTCRB/GCF plan for selected region SKU",
        ],
        "residual_physical_measurements": {
            "note": "Every quantitative number in s11_and_efficiency_plan, feed_isolation_plan, and sar_prescan_plan is a pre-layout planning estimate. None is measured. The following physical/lab inputs remain blocking residuals and cannot be satisfied by this script.",
            "items": [
                "EM solver (HFSS/CST) antenna model on the routed 11.8 mm enclosure stack to convert efficiency/S11 targets into design values",
                "VNA S11 per feed and S21 isolation matrix on a fabricated EVT0 board with conducted access",
                "anechoic-chamber total-efficiency, realized-gain, and ECC measurement",
                "SAR-lab near-field scan in production orange PC/ABS plastics at module max transmit power",
            ],
        },
        "forbidden_claims": [
            "rf_ready",
            "cellular_ready",
            "wifi_ready",
            "bluetooth_ready",
            "gnss_ready",
            "carrier_ready",
            "sar_ready",
            "regulatory_ready",
        ],
    }

    OUT.write_text(yaml.dump(report, Dumper=IndentedSafeDumper, sort_keys=False))
    print(f"generated {OUT}")
    print(f"status={status} rf_nets={len(required_rf_nets)} missing={len(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
