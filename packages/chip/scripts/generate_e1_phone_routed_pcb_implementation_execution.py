#!/usr/bin/env python3
"""Generate the fail-closed routed PCB implementation execution package."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"

ROUTING_ACCEPTANCE = ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml"
EVT1_ROUTING = ROOT / "board/kicad/e1-phone/evt1-routing-work-package.yaml"
ROUTE_FEASIBILITY = ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml"
PCB_AUDIT = ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml"
MANUFACTURING = ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml"
PRODUCTION = ROOT / "board/kicad/e1-phone/production-readiness.yaml"
ROUTED_RELEASE = ROOT / "board/kicad/e1-phone/routed-release-plan.yaml"
SUPPLIER_TO_KICAD = ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml"
EVT1_FOOTPRINT_CAPTURE = ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
DISPLAY_CAMERA_PINOUT = ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
USB_SIDEKEY_INTEGRATION = ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml"
USB_SIDEKEY_ACCEPTANCE = ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml"
SCHEMATIC_NETCLASS = ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml"
ROUTE_CORRIDOR = ROOT / "board/kicad/e1-phone/route-corridor-execution-package.yaml"
USB_ROUTE = ROOT / "board/kicad/e1-phone/usb-route-topology-resolution.yaml"
SPLIT_PIN_ALLOCATION = ROOT / "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml"
SPLIT_CONNECTOR_BINDING = ROOT / "board/kicad/e1-phone/split-interconnect-connector-binding.yaml"
MODULE_RF = ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml"
ENCLOSURE_FIT = ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml"
FACTORY_ACCEPTANCE = ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
CONCEPT_PCB = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def phase_record(phase: dict[str, Any], release_outputs: dict[str, Any]) -> dict[str, Any]:
    output_map = {
        "0_supplier_freeze": [
            "production_bom_avl",
            "fab_assembler_quote",
            "stackup_impedance_report",
        ],
        "1_schematic_and_netclass_capture": ["schematic_erc_report"],
        "2_placement_and_escape": [
            "routed_kicad_pcb",
            "pcb_drc_report",
            "si_pi_reports",
        ],
        "3_high_speed_rf_power_route": [
            "routed_kicad_pcb",
            "filled_zones",
            "pcb_drc_report",
            "si_pi_reports",
            "rf_reports",
            "power_thermal_measurements",
        ],
        "4_manufacturing_outputs": [
            "gerber_x2",
            "ipc_2581_or_odbpp",
            "nc_drill_slots",
            "position_file",
            "production_bom_avl",
            "assembly_drawing",
            "split_interconnect_assembly_drawing",
            "board_step_with_supplier_models",
            "factory_test_limits",
            "first_article_traveler",
            "fab_assembler_quote",
        ],
        "5_enclosure_routed_step_rerun": [
            "board_step_with_supplier_models",
            "enclosure_clearance_report_using_routed_step",
        ],
    }
    keys = output_map[phase["phase"]]
    return {
        "phase": phase["phase"],
        "current_status": phase["current_status"],
        "required_inputs_or_actions": phase["exit_criteria"],
        "expected_release_outputs": [
            {
                "id": key,
                "expected_path": release_outputs[key]["expected_path"],
                "present": release_outputs[key]["present"],
                "release_required": release_outputs[key]["release_required"],
                "blocker": release_outputs[key]["blocker"],
            }
            for key in keys
        ],
        "status": "blocked_no_release_outputs_present",
    }


def main() -> int:
    routing_acceptance = load_yaml(ROUTING_ACCEPTANCE)
    evt1 = load_yaml(EVT1_ROUTING)
    route_feasibility = load_yaml(ROUTE_FEASIBILITY)
    pcb_audit = load_yaml(PCB_AUDIT)
    manufacturing = load_yaml(MANUFACTURING)
    production = load_yaml(PRODUCTION)
    routed_release = load_yaml(ROUTED_RELEASE)
    supplier_to_kicad = load_yaml(SUPPLIER_TO_KICAD)
    footprint_capture = load_yaml(EVT1_FOOTPRINT_CAPTURE)
    display_camera_pinout = load_yaml(DISPLAY_CAMERA_PINOUT)
    usb_sidekey = load_yaml(USB_SIDEKEY_INTEGRATION)
    usb_sidekey_acceptance = load_yaml(USB_SIDEKEY_ACCEPTANCE)
    schematic_netclass = load_yaml(SCHEMATIC_NETCLASS)
    route_corridor = load_yaml(ROUTE_CORRIDOR)
    usb_route = load_yaml(USB_ROUTE)
    split_pin_allocation = load_yaml(SPLIT_PIN_ALLOCATION)
    split_connector_binding = load_yaml(SPLIT_CONNECTOR_BINDING)
    module_rf = load_yaml(MODULE_RF)
    enclosure_fit = load_yaml(ENCLOSURE_FIT)
    factory_acceptance = load_yaml(FACTORY_ACCEPTANCE)

    release_outputs = routed_release["required_release_output_manifest"]
    live_counts = pcb_audit["live_pcb_counts"]
    route_summary = routing_acceptance["routing_summary"]
    manufacturing_state = manufacturing["board_state_detected"]

    execution_phases = [
        phase_record(phase, release_outputs) for phase in evt1["route_phases"]
    ]
    output_manifest_closure = [
        {
            "id": key,
            "owner": item["owner"],
            "expected_path": item["expected_path"],
            "present": item["present"],
            "release_required": item["release_required"],
            "blocker": item["blocker"],
        }
        for key, item in release_outputs.items()
    ]

    domain_route_closure = [
        {
            "id": domain,
            "required_nets": item["required_nets"],
            "required_evidence": item["required_evidence"],
            "status": "blocked_no_routed_post_route_or_supplier_release_evidence",
        }
        for domain, item in routed_release["route_completion_requirements"].items()
    ]

    footprint_items = {
        item["function"]: item for item in footprint_capture["work_items"]
    }
    supplier_to_kicad_route_input_matrix = []
    for record in supplier_to_kicad["evidence_records"]:
        work_item = footprint_items[record["function"]]
        gate_inputs = work_item["supplier_gate_inputs_required"]
        supplier_to_kicad_route_input_matrix.append(
            {
                "function": record["function"],
                "primary_candidate": record["primary_candidate"],
                "package_binding": record["package_binding"],
                "rfq_intake_status": record["rfq_intake_status"],
                "supplier_to_kicad_status": record["current_status"],
                "footprint_capture_work_item": work_item["id"],
                "footprint_capture_status": work_item["status"],
                "refdes_group": work_item["refdes_group"],
                "planned_contract_net_count": len(work_item["planned_contract_nets"]),
                "required_supplier_input_count": len(record["required_supplier_inputs"]),
                "required_production_evidence": record["required_production_evidence"],
                "supplier_gate_inputs_required": gate_inputs,
                "all_supplier_gates_closed": all(gate_inputs.values()),
                "review_outputs": work_item["review_outputs"],
                "current_blocker": work_item["current_blocker"],
            }
        )

    display_camera_interfaces = {
        item["interface_id"]: item
        for item in display_camera_pinout["connector_pinout_execution"]
    }
    usb_c_required_nets = usb_sidekey["usb_c_port_context"]["required_nets"]
    side_key_required_nets = usb_sidekey["side_key_context"]["required_nets"]
    acceptance_items = {
        item["id"]: item for item in usb_sidekey_acceptance["acceptance_items"]
    }
    external_interface_hardware_closure = [
        {
            "id": "display_touch_fpc",
            "route_domain": "display_touch",
            "status": display_camera_interfaces["display_touch_fpc"]["status"],
            "source_candidate": display_camera_interfaces["display_touch_fpc"][
                "source_candidate"
            ],
            "refdes": display_camera_interfaces["display_touch_fpc"]["refdes"],
            "required_contract_nets": display_camera_interfaces["display_touch_fpc"][
                "required_contract_nets"
            ],
            "route_constraint_group_count": len(
                display_camera_interfaces["display_touch_fpc"][
                    "route_constraint_groups"
                ]
            ),
            "mechanical_capture_tasks": display_camera_interfaces["display_touch_fpc"][
                "mechanical_capture_tasks"
            ],
            "release_blocker": display_camera_interfaces["display_touch_fpc"][
                "status_note"
            ],
        },
        {
            "id": "rear_camera_fpc",
            "route_domain": "cameras",
            "status": display_camera_interfaces["rear_camera_fpc"]["status"],
            "source_candidate": display_camera_interfaces["rear_camera_fpc"][
                "source_candidate"
            ],
            "refdes": display_camera_interfaces["rear_camera_fpc"]["refdes"],
            "required_contract_nets": display_camera_interfaces["rear_camera_fpc"][
                "required_contract_nets"
            ],
            "route_constraint_group_count": len(
                display_camera_interfaces["rear_camera_fpc"][
                    "route_constraint_groups"
                ]
            ),
            "mechanical_capture_tasks": display_camera_interfaces["rear_camera_fpc"][
                "mechanical_capture_tasks"
            ],
            "release_blocker": display_camera_interfaces["rear_camera_fpc"][
                "status_note"
            ],
        },
        {
            "id": "front_camera_fpc",
            "route_domain": "cameras",
            "status": display_camera_interfaces["front_camera_fpc"]["status"],
            "source_candidate": display_camera_interfaces["front_camera_fpc"][
                "source_candidate"
            ],
            "refdes": display_camera_interfaces["front_camera_fpc"]["refdes"],
            "required_contract_nets": display_camera_interfaces["front_camera_fpc"][
                "required_contract_nets"
            ],
            "route_constraint_group_count": len(
                display_camera_interfaces["front_camera_fpc"][
                    "route_constraint_groups"
                ]
            ),
            "mechanical_capture_tasks": display_camera_interfaces["front_camera_fpc"][
                "mechanical_capture_tasks"
            ],
            "release_blocker": display_camera_interfaces["front_camera_fpc"][
                "status_note"
            ],
        },
        {
            "id": "usb_c_receptacle_evt0",
            "route_domain": "usb_c_power",
            "status": usb_sidekey["status"],
            "source_candidate": usb_sidekey["usb_c_port_context"][
                "selected_evt0_connector"
            ]["family"],
            "refdes": "J_USB_C",
            "required_contract_nets": usb_c_required_nets,
            "route_constraint_group_count": 1,
            "mechanical_capture_tasks": usb_sidekey["usb_c_port_context"][
                "mechanical_requirements"
            ],
            "acceptance_items": [
                acceptance_items["usb_c_connector_shell_load_path"],
                acceptance_items["usb_c_cutout_and_plug_keepout"],
                acceptance_items["usb2_cc_vbus_route_and_esd"],
                acceptance_items["pd_attach_and_charger_safety"],
            ],
            "release_blocker": "USB-C supplier, routed electrical, PD/charger, and enclosure load-path evidence are missing",
        },
        {
            "id": "side_buttons",
            "route_domain": "side_buttons",
            "status": usb_sidekey["status"],
            "source_candidate": usb_sidekey["side_key_context"][
                "primary_switch_family"
            ]["family"],
            "refdes": "SW_POWER_VOL",
            "required_contract_nets": side_key_required_nets,
            "route_constraint_group_count": 1,
            "mechanical_capture_tasks": usb_sidekey["side_key_context"][
                "mechanical_requirements"
            ],
            "acceptance_items": [
                acceptance_items["side_key_force_travel_and_solder_load"],
                acceptance_items["side_key_recovery_and_wake"],
            ],
            "release_blocker": "Power/volume key supplier, wake/recovery, force-travel, and enclosure load-path evidence are missing",
        },
    ]
    external_contract_nets_by_domain: dict[str, set[str]] = {}
    for item in external_interface_hardware_closure:
        external_contract_nets_by_domain.setdefault(item["route_domain"], set()).update(
            item["required_contract_nets"]
        )

    execution = {
        "schema": "eliza.e1_phone_routed_pcb_implementation_execution.v1",
        "status": "blocked_requires_supplier_footprints_schematic_erc_trial_route_drc_outputs_and_routed_step",
        "date": date.today().isoformat(),
        "claim_boundary": (
            "File-level execution package for converting the current E1 phone KiCad "
            "concept scaffold into an EVT1 routed PCB release. This is not a routed "
            "PCB, not ERC/DRC evidence, not SI/PI/RF signoff, not a manufacturing "
            "export package, not a routed STEP, and not enclosure-ready evidence."
        ),
        "source_artifacts": [
            rel(path)
            for path in [
                ROUTING_ACCEPTANCE,
                EVT1_ROUTING,
                ROUTE_FEASIBILITY,
                PCB_AUDIT,
                MANUFACTURING,
                PRODUCTION,
                ROUTED_RELEASE,
                SUPPLIER_TO_KICAD,
                EVT1_FOOTPRINT_CAPTURE,
                DISPLAY_CAMERA_PINOUT,
                USB_SIDEKEY_INTEGRATION,
                USB_SIDEKEY_ACCEPTANCE,
                SCHEMATIC_NETCLASS,
                ROUTE_CORRIDOR,
                USB_ROUTE,
                SPLIT_PIN_ALLOCATION,
                SPLIT_CONNECTOR_BINDING,
                MODULE_RF,
                ENCLOSURE_FIT,
                FACTORY_ACCEPTANCE,
                CONCEPT_PCB,
            ]
        ],
        "upstream_status": {
            "routing_acceptance": routing_acceptance["status"],
            "evt1_routing_work_package": evt1["status"],
            "route_feasibility_density": route_feasibility["status"],
            "pcb_implementation_audit": pcb_audit["status"],
            "manufacturing_closure": manufacturing["status"],
            "production_readiness": production["status"],
            "routed_release_plan": routed_release["status"],
            "supplier_to_kicad_evidence_map": supplier_to_kicad["status"],
            "evt1_footprint_capture_work_package": footprint_capture["status"],
            "display_camera_connector_pinout_execution": display_camera_pinout["status"],
            "usb_sidekey_integration": usb_sidekey["status"],
            "usb_sidekey_acceptance": usb_sidekey_acceptance["status"],
            "schematic_netclass_execution": schematic_netclass["status"],
            "route_corridor_execution": route_corridor["status"],
            "usb_route_topology": usb_route["status"],
            "split_pin_allocation": split_pin_allocation["status"],
            "split_connector_binding": split_connector_binding["status"],
            "module_rf_pinout_execution": module_rf["status"],
            "enclosure_fit_execution": enclosure_fit["status"],
            "factory_production_acceptance": factory_acceptance["status"],
        },
        "current_kicad_state": {
            "declared_net_count": live_counts["declared_net_count"],
            "footprint_count": live_counts["footprint_count"],
            "assigned_pad_net_count": live_counts["assigned_pad_net_count"],
            "net_class_count": live_counts["net_class_count"],
            "segment_count": live_counts["segment_count"],
            "zone_count": live_counts["zone_count"],
            "keepout_zone_count": live_counts["keepout_zone_count"],
            "rf_feed_count": live_counts["rf_feed_count"],
            "test_point_count": live_counts["test_point_count"],
            "has_tracks": manufacturing_state["has_tracks"],
            "has_filled_zones": manufacturing_state["has_filled_zones"],
            "has_production_outputs": manufacturing_state["has_production_outputs"],
            "kibot_outputs_are_skeleton_commented": manufacturing_state[
                "kibot_outputs_are_skeleton_commented"
            ],
        },
        "routing_pressure_snapshot": {
            "board_bbox_mm": route_summary["board_bbox_mm"],
            "physical_pcb_island_area_mm2": route_summary["physical_pcb_island_area_mm2"],
            "battery_window_mm": route_summary["battery_window_mm"],
            "placement_area_after_battery_and_antenna_keepouts_mm2": route_summary[
                "placement_area_after_battery_and_antenna_keepouts_mm2"
            ],
            "differential_pair_count_required": route_summary[
                "differential_pair_count_required"
            ],
            "split_interconnect_min_contacts": route_summary[
                "split_interconnect_min_contacts"
            ],
        },
        "routed_evt1_execution_phases": execution_phases,
        "domain_route_closure": domain_route_closure,
        "supplier_to_kicad_route_input_matrix": supplier_to_kicad_route_input_matrix,
        "external_interface_hardware_closure": external_interface_hardware_closure,
        "output_manifest_closure": output_manifest_closure,
        "module_and_rf_dependency": {
            "execution_status": module_rf["status"],
            "required_rf_nets": routed_release["rf_release_dependency"]["required_rf_nets"],
            "rf_feed_count": routed_release[
                "module_rf_pinout_execution_release_dependency"
            ]["rf_feed_count"],
            "release_blockers": routed_release[
                "module_rf_pinout_execution_release_dependency"
            ]["release_blockers"],
        },
        "enclosure_dependency": {
            "execution_status": enclosure_fit["status"],
            "requires_routed_board_step": routed_release["enclosure_release_dependency"][
                "requires_routed_board_step"
            ],
            "routed_step_blocker": routed_release["enclosure_release_dependency"][
                "routed_step_blocker"
            ],
        },
        "cross_checks": {
            "routing_acceptance_live_counts_match_pcb_audit": (
                route_summary["live_pcb_segment_count"] == live_counts["segment_count"]
                and route_summary["live_pcb_zone_count"] == live_counts["zone_count"]
                and route_summary["live_pcb_keepout_zone_count"]
                == live_counts["keepout_zone_count"]
                and route_summary["live_pcb_footprint_count"] == live_counts["footprint_count"]
                and route_summary["live_pcb_net_class_count"] == live_counts["net_class_count"]
            ),
            "manufacturing_state_matches_routed_release": (
                manufacturing_state["has_tracks"]
                == routed_release["current_board_state"]["has_tracks"]
                and manufacturing_state["has_filled_zones"]
                == routed_release["current_board_state"]["has_filled_zones"]
                and manufacturing_state["has_production_outputs"]
                == routed_release["current_board_state"]["has_production_outputs"]
            ),
            "routed_release_outputs_all_blocked": all(
                not item["present"] and item["release_required"]
                for item in release_outputs.values()
            ),
            "supplier_to_kicad_functions_match_footprint_capture": (
                sorted(item["function"] for item in supplier_to_kicad["evidence_records"])
                == sorted(footprint_items)
            ),
            "all_supplier_to_kicad_route_inputs_fail_closed": all(
                not item["all_supplier_gates_closed"]
                and item["supplier_to_kicad_status"].startswith("blocked_")
                and item["footprint_capture_status"].startswith("blocked_")
                for item in supplier_to_kicad_route_input_matrix
            ),
            "supplier_reviews_match_footprint_capture_outputs": all(
                record["required_production_evidence"]["pinout_review_signoff"]
                == footprint_items[record["function"]]["review_outputs"]["pinout_review"]
                and record["required_production_evidence"]["symbol_review"]
                == footprint_items[record["function"]]["review_outputs"]["symbol_review"]
                and record["required_production_evidence"]["footprint_review"]
                == footprint_items[record["function"]]["review_outputs"]["footprint_review"]
                and record["required_production_evidence"]["footprint_3d_binding"]
                == footprint_items[record["function"]]["review_outputs"][
                    "footprint_3d_binding"
                ]
                for record in supplier_to_kicad["evidence_records"]
            ),
            "display_camera_external_interfaces_fail_closed": all(
                item["status"].startswith("blocked_")
                for item in external_interface_hardware_closure
                if item["id"] in {
                    "display_touch_fpc",
                    "rear_camera_fpc",
                    "front_camera_fpc",
                }
            ),
            "usb_sidekey_external_interfaces_fail_closed": all(
                item["status"].startswith("blocked_")
                for item in external_interface_hardware_closure
                if item["id"] in {"usb_c_receptacle_evt0", "side_buttons"}
            ),
            "external_interface_release_domain_nets_are_in_contracts": all(
                set(
                    routed_release["route_completion_requirements"][
                        route_domain
                    ]["required_nets"]
                ).issubset(contract_nets)
                for route_domain, contract_nets in external_contract_nets_by_domain.items()
            ),
            "evt1_required_outputs_cover_routed_release_manifest": all(
                item["expected_path"] in evt1["required_release_outputs"]
                or key in {
                    "filled_zones",
                    "nc_drill_slots",
                    "stackup_impedance_report",
                    "power_thermal_measurements",
                    "factory_test_limits",
                    "first_article_traveler",
                    "fab_assembler_quote",
                }
                for key, item in release_outputs.items()
            ),
            "module_rf_execution_blocks_radio_route": module_rf["status"].startswith(
                "blocked_"
            ),
            "enclosure_fit_waits_for_routed_step": routed_release[
                "enclosure_release_dependency"
            ]["requires_routed_board_step"],
            "current_pcb_has_no_tracks_or_zones": (
                live_counts["segment_count"] == 0
                and live_counts["zone_count"] == 0
                and not manufacturing_state["has_tracks"]
                and not manufacturing_state["has_filled_zones"]
            ),
            "all_execution_phases_fail_closed": all(
                phase["current_status"].startswith("blocked_")
                and phase["status"].startswith("blocked_")
                for phase in execution_phases
            ),
        },
        "release_blockers": [
            "supplier pinouts, symbols, footprints, courtyards, and STEP models are not frozen",
            "supplier-to-KiCad evidence records and EVT1 footprint capture work items are all still blocked",
            "hierarchical schematic capture and ERC evidence are missing",
            "screen, camera, USB-C, and side-button connector pinouts remain blocked before routable schematic capture",
            "current KiCad PCB has placeholder footprints, zero routed segments, and zero filled zones",
            "supplier-footprint escape analysis and trial-route evidence are missing",
            "USB2 split-interconnect route topology is blocked until controlled-impedance flex or topology evidence exists",
            "cellular and Wi-Fi/Bluetooth module pinouts, reference layouts, firmware identity, and RF evidence are missing",
            "post-route DRC, length/skew, impedance, SI/PI, RF, power, thermal, and factory evidence are missing",
            "production Gerber or IPC-2581, drill, position, BOM/AVL, assembly, STEP, DFM/DFA, and quote outputs are missing",
            "routed board STEP has not been generated or rerun through enclosure clearance",
        ],
        "forbidden_claims": [
            "routed_pcb_ready",
            "evt1_route_ready",
            "drc_clean",
            "erc_clean",
            "production_outputs_ready",
            "fabrication_ready",
            "enclosure_ready",
            "factory_test_ready",
            "rf_ready",
            "power_thermal_ready",
            "end_to_end_phone_ready",
        ],
    }

    OUT.write_text(
        yaml.dump(
            execution,
            Dumper=IndentedSafeDumper,
            sort_keys=False,
            allow_unicode=False,
        )
    )
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
