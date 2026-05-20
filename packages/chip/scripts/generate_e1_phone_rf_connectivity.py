#!/usr/bin/env python3
"""Generate RF and wireless connectivity closure evidence for the E1 phone board."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml"

SOURCES = {
    "routing": ROOT / "board/kicad/e1-phone/routing-constraints.yaml",
    "netlist": ROOT / "board/kicad/e1-phone/block-netlist.yaml",
    "matrix": ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml",
    "cellular": ROOT / "package/cellular/quectel-5g-redcap.yaml",
    "wifi_bt": ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml",
    "enclosure": ROOT / "docs/board/e1-phone-enclosure-interface.yaml",
    "mechanical_overlay": ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml",
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


def main() -> int:
    routing = load_yaml(SOURCES["routing"])
    netlist = load_yaml(SOURCES["netlist"])
    matrix = load_yaml(SOURCES["matrix"])
    cellular = load_yaml(SOURCES["cellular"])
    wifi_bt = load_yaml(SOURCES["wifi_bt"])
    enclosure = load_yaml(SOURCES["enclosure"])
    overlay = load_yaml(SOURCES["mechanical_overlay"])

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
                "evidence_required": "conducted sensitivity/output-power delta and firmware coexistence log",
            },
            {
                "case": "cellular_tx_vs_gnss",
                "radios_active": ["cellular_tx", "gnss_optional"],
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
                "evidence_required": "noise-floor and packet-error-rate comparison with charger/display states toggled",
            },
        ],
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
