#!/usr/bin/env python3
"""Generate the fail-closed module pinout and RF-feed execution package."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml"

RADIO_MODULE = ROOT / "board/kicad/e1-phone/radio-module-integration.yaml"
MODULE_HOST = ROOT / "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml"
RADIO_ANTENNA = ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
RF = ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml"
ROUTING = ROOT / "board/kicad/e1-phone/routing-constraints.yaml"
BLOCK_NETLIST = ROOT / "board/kicad/e1-phone/block-netlist.yaml"
PLACEMENT = ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml"
FACTORY_PROBE = ROOT / "board/kicad/e1-phone/factory-probe-map.yaml"
CELLULAR = ROOT / "package/cellular/quectel-5g-redcap.yaml"
WIFI_BT = ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def flatten_net_groups(groups: dict[str, list[str]]) -> set[str]:
    nets: set[str] = set()
    for values in groups.values():
        nets.update(values)
    return nets


def contracts(items: list[dict[str, Any]]) -> list[str]:
    return [item["contract"] for item in items]


def main() -> int:
    radio_module = load_yaml(RADIO_MODULE)
    module_host = load_yaml(MODULE_HOST)
    radio_antenna = load_yaml(RADIO_ANTENNA)
    rf = load_yaml(RF)
    routing = load_yaml(ROUTING)
    block_netlist = load_yaml(BLOCK_NETLIST)
    placement = load_yaml(PLACEMENT)
    factory_probe = load_yaml(FACTORY_PROBE)
    cellular = load_yaml(CELLULAR)
    wifi_bt = load_yaml(WIFI_BT)

    blocks = {block["id"]: block for block in block_netlist["blocks"]}
    placements = {item["refdes_group"]: item for item in placement["placements"]}
    routing_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    routing_buses = {item["name"]: item for item in routing["single_ended_buses"]}

    cellular_contracts = contracts(cellular["host_interfaces"]["cellular_module"]["required"])
    wifi_contracts = (
        contracts(wifi_bt["host_interfaces"]["wifi_primary"]["signals"])
        + contracts(wifi_bt["host_interfaces"]["bluetooth"]["signals"])
        + contracts(wifi_bt["host_interfaces"]["control"]["signals"])
    )
    cellular_rf_nets = ["CELL_RF_MAIN", "CELL_RF_DIV", "CELL_GNSS_RF"]
    wifi_rf_nets = ["WIFI_BT_RF0", "WIFI_BT_RF1"]

    s11_plan = {
        item["net"]: item for item in rf["s11_and_efficiency_plan"]["per_feed"]
    }
    rf_feed_execution = []
    for feed in rf["antenna_feed_assignments"]:
        matching = next(
            item for item in routing["rf_layout"]["matching_networks_required"] if item["net"] == feed["net"]
        )
        plan = s11_plan[feed["net"]]
        rf_feed_execution.append(
            {
                "net": feed["net"],
                "role": feed["role"],
                "candidate_zone": feed["candidate_zone"],
                "near": matching["near"],
                "band_plan": plan["bands"],
                "freq_range_mhz": plan["freq_range_mhz"],
                "planning_target_s11_db_max": plan["target_s11_db_max"],
                "planning_target_total_efficiency_pct_min": plan["target_total_efficiency_pct_min"],
                "planning_target_evidence_class": "planning_estimate_not_vna_measured",
                "requires_pi_or_t_matching_network": True,
                "requires_conducted_access_before_matching": feed["requires_conducted_access"],
                "requires_via_fence_and_continuous_ground_reference": True,
                "status": "blocked_waiting_reference_layout_antenna_vendor_review_vna_and_sar_evidence",
                "blocker": (
                    "RF feed is a logical net with a required matching-network placeholder; "
                    "the S11/efficiency targets are pre-layout planning estimates. No routed "
                    "50 ohm geometry, antenna tune, VNA data, or SAR evidence exists."
                ),
            }
        )

    cell_nets = flatten_net_groups(blocks["U_CELL"]["nets"]) | flatten_net_groups(
        blocks["U_SIM_ESIM"]["nets"]
    )
    wifi_nets = flatten_net_groups(blocks["U_WIFI_BT"]["nets"])

    module_records = [
        {
            "id": "cellular_5g_redcap_module",
            "refdes_group": "U_CELL",
            "package_binding": str(CELLULAR.relative_to(ROOT)),
            "selected_family": cellular["primary_first_phone"]["family"],
            "status": "blocked_waiting_region_sku_supplier_pinout_reference_layout_step_firmware_and_cert_plan",
            "placement_region_mm": placements["U_CELL"]["region_mm"],
            "required_host_contracts": cellular_contracts,
            "required_power_control_nets": [
                "RF_VBAT",
                "IO_1V8",
                "GND",
                "CELL_RESET_N",
                "CELL_W_DISABLE_N",
                "AP_WAKE_CELL",
                "CELL_WAKE_AP",
            ],
            "sim_esim_nets": [
                "USIM_VCC",
                "USIM_CLK",
                "USIM_RST",
                "USIM_IO",
                "USIM_DET",
                "ESIM_VCC",
                "ESIM_CLK",
                "ESIM_RST",
                "ESIM_IO",
            ],
            "required_rf_nets": cellular_rf_nets,
            "route_constraints": {
                "differential_pairs": {
                    name: routing_pairs[name]
                    for name in ["CELL_USB2_DP_DN", "CELL_PCIE_TX", "CELL_PCIE_RX"]
                },
                "single_ended_buses": {"USIM_ESIM": routing_buses["USIM_ESIM"]},
            },
            "required_supplier_inputs": [
                "exact regional SKU and band matrix",
                "supplier pinout, hardware design guide, land pattern, and STEP model",
                "reference layout and RF matching guidance",
                "modem firmware, Linux/Android driver package, and carrier test-mode procedure",
                "IMEI/modem identity and SIM/eSIM provisioning workflow",
            ],
            "blocker": "Cellular module cannot be captured or routed until supplier pinout, region SKU, firmware, RF, and certification inputs are frozen.",
        },
        {
            "id": "wifi6e_bluetooth_5p3_module",
            "refdes_group": "U_WIFI_BT",
            "package_binding": str(WIFI_BT.relative_to(ROOT)),
            "selected_order_number": wifi_bt["vendor_public_specs"]["order_number"],
            "status": "blocked_waiting_supplier_pinout_reference_layout_firmware_nvram_clm_and_regulatory_review",
            "placement_region_mm": placements["U_WIFI_BT"]["region_mm"],
            "required_host_contracts": wifi_contracts,
            "required_power_control_nets": [
                "RF_VBAT",
                "IO_1V8",
                "GND",
                "WIFI_EN",
                "BT_EN",
                "WIFI_IRQ",
                "WIFI_HOST_WAKE",
            ],
            "required_rf_nets": wifi_rf_nets,
            "route_constraints": {
                "differential_pairs": {
                    name: routing_pairs[name] for name in ["WIFI_PCIE_TX", "WIFI_PCIE_RX"]
                },
                "single_ended_buses": {"WIFI_SDIO": routing_buses["WIFI_SDIO"]},
                "bluetooth_uart_nets": contracts(wifi_bt["host_interfaces"]["bluetooth"]["signals"]),
            },
            "required_supplier_inputs": [
                "Murata Type 2EA pinout, land pattern, reference layout, and STEP model",
                "RF feed, keepout, and antenna matching rules",
                "CYW55573 firmware, NVRAM, CLM, license, and country-code archive",
                "Wi-Fi MAC and Bluetooth MAC provisioning workflow",
                "modular approval review for final antenna gains and enclosure plastics",
            ],
            "blocker": "Wi-Fi/Bluetooth module cannot be captured or routed until pinout, reference layout, firmware identity, and regulatory scope are frozen.",
        },
    ]

    traceability_fields = factory_probe["fixture_policy"]["operator_visible_traceability_required"]
    execution = {
        "schema": "eliza.e1_phone_module_rf_pinout_execution.v1",
        "status": "blocked_requires_cellular_wifi_module_pinouts_reference_layouts_rf_feeds_firmware_and_factory_evidence",
        "date": date.today().isoformat(),
        "claim_boundary": (
            "Execution package for turning selected off-the-shelf cellular and "
            "Wi-Fi/Bluetooth modules into KiCad symbols, footprints, RF feeds, "
            "firmware identity, and factory evidence. This is not a supplier "
            "pinout, not routed RF, not firmware release evidence, not regulatory "
            "or carrier approval, not SAR evidence, not a fabrication package, "
            "and not enclosure-ready evidence."
        ),
        "source_artifacts": [
            str(path.relative_to(ROOT))
            for path in [
                RADIO_MODULE,
                MODULE_HOST,
                RADIO_ANTENNA,
                RF,
                ROUTING,
                BLOCK_NETLIST,
                PLACEMENT,
                FACTORY_PROBE,
                CELLULAR,
                WIFI_BT,
            ]
        ],
        "upstream_status": {
            "radio_module": radio_module["status"],
            "module_host_acceptance": module_host["status"],
            "radio_antenna_acceptance": radio_antenna["status"],
            "rf_connectivity": rf["status"],
            "cellular_package": cellular["status"],
            "wifi_bluetooth_package": wifi_bt["status"],
        },
        "selected_module_context": {
            "cellular": {
                "vendor": cellular["primary_first_phone"]["vendor"],
                "family": cellular["primary_first_phone"]["family"],
                "class": cellular["primary_first_phone"]["class"],
                "placement_refdes_group": "U_CELL",
                "placement_region_mm": placements["U_CELL"]["region_mm"],
                "host_contract_count": len(cellular_contracts),
                "minimum_rf_ports": cellular["host_interfaces"]["rf_ports"]["minimum_first_board"],
                "rf_nets": cellular_rf_nets,
                "package_status": cellular["status"],
            },
            "wifi_bluetooth": {
                "vendor": wifi_bt["vendor_public_specs"]["vendor"],
                "order_number": wifi_bt["vendor_public_specs"]["order_number"],
                "chipset": wifi_bt["vendor_public_specs"]["chipset"],
                "package_mm": wifi_bt["vendor_public_specs"]["package_mm"],
                "placement_refdes_group": "U_WIFI_BT",
                "placement_region_mm": placements["U_WIFI_BT"]["region_mm"],
                "wifi_preferred_bus": wifi_bt["host_interfaces"]["wifi_primary"]["preferred_bus"],
                "wifi_fallback_bus": wifi_bt["host_interfaces"]["wifi_primary"]["fallback_bus"],
                "bluetooth_bus": wifi_bt["host_interfaces"]["bluetooth"]["preferred_bus"],
                "rf_nets": wifi_rf_nets,
                "package_status": wifi_bt["status"],
            },
        },
        "module_pinout_execution": module_records,
        "rf_feed_execution": rf_feed_execution,
        "factory_firmware_identity_execution": {
            "traceability_fields_required": traceability_fields,
            "firmware_artifacts_missing": [
                "Quectel modem firmware and carrier test-mode package",
                "Murata/Infineon CYW55573 firmware, NVRAM, CLM, and license archive",
                "Android/Linux device-tree, regulatory-domain, suspend/resume, and RF-kill logs",
            ],
            "factory_test_modes_missing": [
                "cellular boot and IMEI/modem identifier readback",
                "USIM/eSIM readback and provisioning result",
                "Wi-Fi conducted or shield-box TX/RX",
                "Bluetooth LE advertise/scan and RF-level test",
                "GNSS conducted or reradiated acquisition check",
            ],
            "status": "blocked_no_firmware_identity_or_factory_rf_test_release",
        },
        "cross_checks": {
            "cellular_and_wifi_modules_match_acceptance_summary": (
                module_host["module_host_summary"]["cellular_package_status"] == cellular["status"]
                and module_host["module_host_summary"]["wifi_bluetooth_package_status"] == wifi_bt["status"]
            ),
            "module_placements_match_active_matrix": (
                module_records[0]["placement_region_mm"] == placements["U_CELL"]["region_mm"]
                and module_records[1]["placement_region_mm"] == placements["U_WIFI_BT"]["region_mm"]
            ),
            "cellular_required_host_contracts_present_in_block_netlist": set(cellular_contracts).issubset(
                cell_nets
            ),
            "wifi_bt_required_host_contracts_present_in_block_netlist": set(wifi_contracts).issubset(
                wifi_nets
            ),
            "required_rf_nets_match_radio_antenna_acceptance": sorted(cellular_rf_nets + wifi_rf_nets)
            == sorted(radio_antenna["interface_summary"]["required_rf_nets"]),
            "all_rf_feeds_have_execution_records": sorted(item["net"] for item in rf_feed_execution)
            == sorted(rf["required_rf_nets"]),
            "all_rf_feeds_carry_planning_s11_efficiency_targets": all(
                "planning_target_s11_db_max" in item
                and "planning_target_total_efficiency_pct_min" in item
                for item in rf_feed_execution
            ),
            "rf_closure_exposes_keepout_audit_and_sar_plan": (
                "antenna_keepout_audit" in rf
                and "sar_prescan_plan" in rf
                and rf["antenna_keepout_audit"]["all_keepouts_within_board_outline"] is True
            ),
            "routing_constraints_cover_required_module_pairs": all(
                pair in routing_pairs
                for pair in [
                    "CELL_USB2_DP_DN",
                    "CELL_PCIE_TX",
                    "CELL_PCIE_RX",
                    "WIFI_PCIE_TX",
                    "WIFI_PCIE_RX",
                ]
            ),
            "factory_traceability_fields_include_radio_identity": all(
                field in traceability_fields
                for field in ["imei_or_modem_identifier", "wifi_mac", "bluetooth_mac"]
            ),
            "all_execution_records_fail_closed": all(
                item["status"].startswith("blocked_") for item in module_records + rf_feed_execution
            ),
            "packages_still_not_fabrication_ready": (
                "no_fabricated_board" in cellular["status"]
                and "no_fabricated_board" in wifi_bt["status"]
            ),
        },
        "release_blockers": [
            "cellular regional SKU, supplier pinout, land pattern, STEP, firmware, and carrier plan missing",
            "Wi-Fi/Bluetooth module pinout, land pattern, STEP, firmware, NVRAM/CLM, and regulatory scope missing",
            "RF matching networks and conducted access are requirements only; no 50 ohm routed geometry or VNA data exists",
            "factory RF calibration, identity provisioning, and first-article radio limits are missing",
            "routed PCB, DRC, SI/PI, RF, SAR, enclosure, and fabrication outputs are missing",
        ],
        "forbidden_claims": [
            "cellular_ready",
            "wifi_ready",
            "bluetooth_ready",
            "rf_ready",
            "regulatory_ready",
            "carrier_ready",
            "sar_ready",
            "module_host_ready",
            "factory_rf_ready",
            "routed_pcb_ready",
            "enclosure_ready",
            "fabrication_ready",
            "end_to_end_phone_ready",
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as handle:
        yaml.dump(execution, handle, Dumper=IndentedSafeDumper, sort_keys=False, width=110)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
