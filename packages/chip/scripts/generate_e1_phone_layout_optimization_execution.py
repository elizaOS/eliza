#!/usr/bin/env python3
"""Generate the fail-closed E1 phone layout optimization execution package."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml"

SCORECARD = ROOT / "board/kicad/e1-phone/board-optimization-scorecard.yaml"
LIVE_UTILIZATION = ROOT / "board/kicad/e1-phone/live-utilization-audit.yaml"
COMPONENT_ENVELOPE = ROOT / "board/kicad/e1-phone/component-envelope-fit-audit.yaml"
PLACEMENT_REPACK = ROOT / "board/kicad/e1-phone/placement-repack-candidate.yaml"
ROUTE_FEASIBILITY = ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml"
ROUTING_ACCEPTANCE = ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml"
ROUTED_RELEASE = ROOT / "board/kicad/e1-phone/routed-release-plan.yaml"
DISPLAY_FIT = ROOT / "board/kicad/e1-phone/display-fit.yaml"
RF_CLOSURE = ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml"
POWER_THERMAL = ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml"
ENCLOSURE_FIT = ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> Any:
    with path.open() as handle:
        return yaml.safe_load(handle)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main() -> int:
    scorecard = load_yaml(SCORECARD)
    live = load_yaml(LIVE_UTILIZATION)
    envelopes = load_yaml(COMPONENT_ENVELOPE)
    repack = load_yaml(PLACEMENT_REPACK)
    feasibility = load_yaml(ROUTE_FEASIBILITY)
    routing_acceptance = load_yaml(ROUTING_ACCEPTANCE)
    routed_release = load_yaml(ROUTED_RELEASE)
    display_fit = load_yaml(DISPLAY_FIT)
    rf = load_yaml(RF_CLOSURE)
    power = load_yaml(POWER_THERMAL)
    enclosure_fit = load_yaml(ENCLOSURE_FIT)

    score = scorecard["scorecard"]
    release_outputs = routed_release["required_release_output_manifest"]
    required_release_outputs = [
        {
            "id": key,
            "expected_path": item["expected_path"],
            "present": item["present"],
            "release_required": item["release_required"],
            "blocker": item["blocker"],
        }
        for key, item in release_outputs.items()
        if key
        in {
            "routed_kicad_pcb",
            "filled_zones",
            "pcb_drc_report",
            "si_pi_reports",
            "rf_reports",
            "power_thermal_measurements",
            "enclosure_clearance_report_using_routed_step",
            "factory_test_limits",
        }
    ]

    known_envelopes = envelopes["known_component_envelopes"]
    execution = {
        "schema": "eliza.e1_phone_layout_optimization_execution.v1",
        "status": "blocked_concept_layout_optimized_requires_supplier_footprints_trial_route_measurements_and_routed_step",
        "date": date.today().isoformat(),
        "claim_boundary": (
            "Execution package for preserving the optimized E1 phone size, placement, "
            "route-density, RF, power, thermal, factory-test, and enclosure constraints "
            "through EVT1 routing. This is not a routed PCB, not supplier footprint "
            "evidence, not SI/PI/RF/thermal signoff, and not enclosure release."
        ),
        "source_artifacts": [
            rel(path)
            for path in [
                SCORECARD,
                LIVE_UTILIZATION,
                COMPONENT_ENVELOPE,
                PLACEMENT_REPACK,
                ROUTE_FEASIBILITY,
                ROUTING_ACCEPTANCE,
                ROUTED_RELEASE,
                DISPLAY_FIT,
                RF_CLOSURE,
                POWER_THERMAL,
                ENCLOSURE_FIT,
            ]
        ],
        "upstream_status": {
            "board_optimization_scorecard": scorecard["status"],
            "live_utilization_audit": live["status"],
            "component_envelope_fit_audit": envelopes["status"],
            "placement_repack_candidate": repack["status"],
            "route_feasibility_density": feasibility["status"],
            "routing_acceptance": routing_acceptance["status"],
            "routed_release_plan": routed_release["status"],
            "display_fit": display_fit["status"],
            "rf_connectivity": rf["status"],
            "power_thermal": power["status"],
            "enclosure_fit_execution": enclosure_fit["status"],
        },
        "locked_concept_geometry": {
            "device_envelope_mm": scorecard["optimization_target"]["device_envelope_mm"],
            "board_bbox_mm": scorecard["optimization_target"]["board_bbox_mm"],
            "battery_window_mm": scorecard["optimization_target"]["battery_window_mm"],
            "display_outline_mm": score["display_fit"]["selected_display_outline_mm"],
            "display_clearance_mm": score["display_fit"][
                "clearance_in_device_envelope_mm"
            ],
            "physical_pcb_island_area_mm2": scorecard["optimization_target"][
                "physical_pcb_island_area_mm2"
            ],
        },
        "layout_pressure_closure": {
            "concept_route_shield_test_reserve_pct": live["route_reserve_pressure"][
                "concept_route_shield_test_reserve_pct"
            ],
            "target_unallocated_pct_after_layout": score["wasted_space"][
                "target_unallocated_pct_after_layout"
            ],
            "post_footprint_reserve_target_pct_range": score["wasted_space"][
                "post_footprint_reserve_target_pct_range"
            ],
            "live_courtyard_area_inside_physical_islands_pct": live[
                "live_footprint_courtyard_metrics"
            ]["courtyard_area_inside_physical_islands_pct"],
            "battery_window_intrusion_count": live["battery_window_intrusion_audit"][
                "intrusion_count"
            ],
            "active_region_overlap_count": repack["candidate_overlap_audit"][
                "overlap_count"
            ],
            "known_envelope_blockers_count": envelopes["routing_impact"][
                "known_envelope_blockers_count"
            ],
            "status": "blocked_until_supplier_footprints_routed_utilization_escape_density_and_drc_exist",
        },
        "performance_constraint_closure": {
            "route_density": score["route_density"],
            "power_efficiency": score["power_efficiency"],
            "thermal": score["thermal"],
            "rf_connectivity": score["rf_connectivity"],
            "factory_test_access": score["factory_test_access"],
        },
        "component_fit_policy": {
            "wifi_bluetooth_module": known_envelopes["wifi_bluetooth_module"],
            "display_module": known_envelopes["display_module"],
            "battery_pack": known_envelopes["battery_pack"],
            "side_button_primary_switch": known_envelopes["side_button_primary_switch"],
            "front_camera_alternate_junde": known_envelopes[
                "front_camera_alternate_junde"
            ],
            "front_and_rear_camera_primary": known_envelopes[
                "front_and_rear_camera_primary"
            ],
        },
        "placement_repack_policy": {
            "candidate_regions_mm": repack["candidate_regions_mm"],
            "battery_window_audit": repack["battery_window_audit"],
            "region_semantics_changes_required": repack[
                "region_semantics_changes_required"
            ],
            "required_before_routed_release": repack["required_before_routed_release"],
        },
        "routed_release_output_dependencies": required_release_outputs,
        "cross_checks": {
            "scorecard_geometry_matches_display_fit": (
                score["display_fit"]["selected_display_outline_mm"]
                == display_fit["selected_primary_display"]["outline_mm"]
                and score["display_fit"]["clearance_in_device_envelope_mm"]
                == display_fit["primary_clearance_in_current_envelope_mm"]
            ),
            "live_utilization_matches_scorecard_pressure": (
                live["route_reserve_pressure"]["concept_route_shield_test_reserve_pct"]
                == score["wasted_space"]["concept_route_shield_test_reserve_pct"]
            ),
            "route_density_matches_feasibility": (
                score["route_density"]["differential_pair_count_required"]
                == feasibility["interface_complexity_counts"][
                    "differential_pair_count_required"
                ]
                and score["route_density"]["rf_feed_count_required"]
                == feasibility["interface_complexity_counts"]["rf_feed_count_required"]
                and score["route_density"]["split_interconnect_min_contacts"]
                == feasibility["interface_complexity_counts"][
                    "split_interconnect_min_contacts"
                ]
            ),
            "repack_candidate_overlap_free_and_matches_active_matrix": (
                repack["candidate_overlap_audit"]["overlap_count"] == 0
                and repack["cross_checks"]["active_matrix_matches_candidate"]
            ),
            "battery_window_has_no_live_or_candidate_intrusions": (
                live["battery_window_intrusion_audit"]["intrusion_count"] == 0
                and repack["battery_window_audit"]["candidate_intrusion_count"] == 0
            ),
            "junde_camera_alternate_remains_rejected": (
                not known_envelopes["front_camera_alternate_junde"]["fit"]["fits_xy"]
                and repack["known_envelope_fit"][
                    "front_camera_junde_alternate_fits_candidate_region"
                ]
                is False
            ),
            "wifi_and_side_button_known_outlines_fit_regions": (
                known_envelopes["wifi_bluetooth_module"]["fit"]["fits_xy"]
                and known_envelopes["side_button_primary_switch"]["fit"]["fits_xy"]
            ),
            "release_outputs_all_blocked": all(
                not item["present"] and item["release_required"]
                for item in required_release_outputs
            ),
        },
        "release_blockers": [
            "supplier footprints, courtyards, component heights, and STEP models are missing",
            "routed courtyard utilization, escape-density, via-count, and DRC reports are missing",
            "screen/camera connector and primary camera XY/Z supplier drawings are missing",
            "power efficiency, thermal soak, RF, coexistence, SAR, and factory measurements are missing",
            "routed board STEP and enclosure clearance rerun are missing",
        ],
        "forbidden_claims": [
            "board_size_optimized_final",
            "layout_release_ready",
            "route_feasible",
            "wasted_space_final",
            "power_efficient",
            "thermal_closed",
            "rf_ready",
            "enclosure_ready",
            "fabrication_ready",
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
