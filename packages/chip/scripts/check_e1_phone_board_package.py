#!/usr/bin/env python3
import csv
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "board/kicad/e1-phone/artifact-manifest.yaml"


def load_yaml(path: Path):
    with path.open() as handle:
        return yaml.safe_load(handle)


def require_path(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"missing required artifact: {path}")


def nonwhite_percent(path: Path) -> float:
    image = Image.open(path).convert("RGB")
    width, height = image.size
    data = image.tobytes()
    nonwhite = 0
    for index in range(0, len(data), 3):
        red, green, blue = data[index], data[index + 1], data[index + 2]
        if not (red > 245 and green > 245 and blue > 245):
            nonwhite += 1
    return nonwhite * 100.0 / (width * height)


def check_manifest_paths(manifest: dict) -> None:
    groups = manifest["current_artifacts"]
    for group, paths in groups.items():
        for rel in paths:
            path = ROOT / rel
            require_path(path)
            if path.suffix in {".yaml", ".yml"}:
                load_yaml(path)
            elif path.suffix == ".svg":
                ET.parse(path)
            elif path.suffix == ".png":
                pct = nonwhite_percent(path)
                min_pct = 0.5 if "preview/schematic/" in rel else 2.0
                if pct < min_pct:
                    raise SystemExit(f"blank or nearly blank PNG: {path} nonwhite={pct:.2f}%")
            elif path.suffix == ".html":
                text = path.read_text()
                if "<html" not in text or ".svg" not in text:
                    raise SystemExit(f"invalid HTML preview artifact: {path}")
            elif path.suffix == ".kicad_pro":
                json.loads(path.read_text())
            elif path.suffix == ".kicad_sch":
                text = path.read_text()
                if text.count("(") != text.count(")") or "(kicad_sch" not in text:
                    raise SystemExit(f"invalid KiCad schematic scaffold syntax: {path}")
            print(f"{group} ok: {rel}")


def check_metrics() -> None:
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    utilization = load_yaml(ROOT / "board/kicad/e1-phone/layout-utilization.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    enclosure = load_yaml(ROOT / "docs/board/e1-phone-enclosure-interface.yaml")
    battery = load_yaml(ROOT / "package/battery/e1-phone-17p3wh-pack.yaml")
    power = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    manifest = load_yaml(MANIFEST)
    bbox = metrics["mainboard_outline_concept"]["bounding_box_mm"]
    if bbox["width"] != 64.0 or bbox["height"] != 132.0:
        raise SystemExit(f"unexpected board bbox: {bbox}")
    derived_bbox = utilization["board_bbox_mm"]
    if derived_bbox["width"] != bbox["width"] or derived_bbox["height"] != bbox["height"]:
        raise SystemExit(f"layout utilization bbox diverges from metrics: {derived_bbox} vs {bbox}")
    battery_window = utilization["battery_window_mm"]
    if battery_window["width"] != 64.0 or battery_window["height"] != 87.0:
        raise SystemExit(f"unexpected derived battery window: {battery_window}")
    derived_metrics = metrics["derived_concept_geometry"]
    for key in [
        "physical_pcb_area_after_battery_window_mm2",
        "antenna_keepout_area_mm2",
        "placement_area_after_battery_and_antenna_keepouts_mm2",
        "route_shield_test_reserve_pct_of_placement_area",
    ]:
        if derived_metrics[key] != utilization[key]:
            raise SystemExit(f"metrics derived geometry {key} diverges from layout utilization")
    wasted = metrics["placement_area_budget"]["estimated_unallocated_or_wasted_pct_of_board"]
    if not (10.0 <= wasted <= 18.0):
        raise SystemExit(f"wasted area target out of range: {wasted}")
    reserve = utilization["route_shield_test_reserve_pct_of_placement_area"]
    if utilization["status"] != "concept_area_pressure_plausible_not_routed":
        raise SystemExit(
            f"layout utilization must expose split-island pressure: {utilization['status']}"
        )
    if not (10.0 <= reserve <= 18.0):
        raise SystemExit(
            f"split-island concept reserve must stay in target pressure band: {reserve}"
        )
    envelope = metrics["industrial_design_assumptions"]["device_envelope_mm"]
    if envelope != manifest["design_target"]["device_envelope_mm"]:
        raise SystemExit(f"metrics and manifest device envelope diverge: {envelope}")
    if envelope != enclosure["coordinate_system"]["device_envelope"]:
        raise SystemExit(f"metrics and enclosure device envelope diverge: {envelope}")
    display_envelope = display_fit["current_device_envelope_mm"]
    if display_envelope != envelope:
        raise SystemExit(f"display fit and metrics device envelope diverge: {display_envelope}")
    if not display_fit["primary_fits_current_envelope"]:
        raise SystemExit(
            "selected primary 5.5 inch CTP display does not fit current device envelope"
        )
    battery_target = battery["target_pack"]
    metrics_battery = metrics["power_efficiency_targets"]["battery"]
    power_battery = power["battery_target"]
    selected_pack = battery_target["primary_candidate"]
    if "TBD" in selected_pack:
        raise SystemExit("battery pack binding primary candidate must not remain TBD")
    if selected_pack != metrics_battery["selected_pack_class"]:
        raise SystemExit("metrics battery selected pack diverges from battery binding")
    if selected_pack != power_battery["selected_pack_class"]:
        raise SystemExit("power budget battery selected pack diverges from battery binding")
    if (
        battery_target["approximate_capacity_mah_at_nominal"]
        != metrics_battery["target_capacity_mah"]
    ):
        raise SystemExit("metrics battery capacity diverges from battery binding")
    if battery_target["approximate_capacity_mah_at_nominal"] != power_battery["capacity_mah"]:
        raise SystemExit("power budget battery capacity diverges from battery binding")
    if battery_target["approximate_capacity_mah_at_nominal"] < 4500:
        raise SystemExit(f"battery capacity target regressed below baseline: {battery_target}")
    if battery_target["energy_wh_target"] != metrics_battery["nominal_energy_wh"]:
        raise SystemExit("metrics battery energy diverges from battery binding")
    if battery_target["energy_wh_target"] != power_battery["nominal_energy_wh"]:
        raise SystemExit("power budget battery energy diverges from battery binding")
    if battery_target["energy_wh_target"] < 17.3:
        raise SystemExit(f"battery target energy too low: {battery_target}")
    reference_pack = battery_target["public_reference_dimensions_mm"]
    if (
        reference_pack
        != metrics["industrial_design_assumptions"]["selected_battery_reference_pack_mm"]
    ):
        raise SystemExit("metrics battery reference dimensions diverge from battery binding")
    if reference_pack != power_battery["public_reference_dimensions_mm"]:
        raise SystemExit("power budget battery reference dimensions diverge from battery binding")
    if (
        reference_pack["width"] != battery_window["width"]
        or reference_pack["height"] != battery_window["height"]
    ):
        raise SystemExit(
            "selected battery reference must match the KiCad concept full-width cavity"
        )
    if battery_target["current_board_battery_window_mm"] != {
        "width": battery_window["width"],
        "height": battery_window["height"],
    }:
        raise SystemExit("battery binding current board window is stale")
    if "cavity" not in battery_target["fit_status"]:
        raise SystemExit(f"battery binding must record cavity fit status: {battery_target}")
    if (
        "battery_cavity_resize_or_custom_pack_decision"
        not in metrics_battery["required_missing_parts"]
    ):
        raise SystemExit("metrics must block release on battery cavity/custom-pack decision")
    evidence = battery.get("public_sourcing_evidence", [])
    if len(evidence) < 3:
        raise SystemExit("battery binding needs at least three sourcing evidence records")
    source_hosts = " ".join(item["url"] for item in evidence)
    for required_host in ["alibaba.com", "made-in-china.com"]:
        if required_host not in source_hosts:
            raise SystemExit(f"battery sourcing evidence missing {required_host}")
    primary_clearance = display_fit["primary_clearance_in_current_envelope_mm"]
    if (
        primary_clearance["width_clearance_mm"] < 0.8
        or primary_clearance["height_clearance_mm"] < 1.8
    ):
        raise SystemExit(f"insufficient display enclosure clearance: {primary_clearance}")
    print(
        f"metrics ok: board={bbox['width']}x{bbox['height']}mm "
        f"wasted_target={wasted}% concept_reserve={reserve}% "
        f"display_clearance={primary_clearance['width_clearance_mm']}x"
        f"{primary_clearance['height_clearance_mm']}mm "
        f"battery_ref={reference_pack['width']}x{reference_pack['height']}x"
        f"{reference_pack['thickness']}mm"
    )


def check_battery_layout_options() -> None:
    options = load_yaml(ROOT / "board/kicad/e1-phone/battery-layout-options.yaml")
    battery = load_yaml(ROOT / "package/battery/e1-phone-17p3wh-pack.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    enclosure = load_yaml(ROOT / "docs/board/e1-phone-enclosure-interface.yaml")
    utilization = load_yaml(ROOT / "board/kicad/e1-phone/layout-utilization.yaml")
    cad = load_yaml(ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml")
    bom = load_yaml(ROOT / "board/kicad/e1-phone/preliminary-bom.yaml")

    if options["status"] != "blocked_routed_split_board_and_supplier_pack_evidence_required":
        raise SystemExit(f"unexpected battery layout option status: {options['status']}")
    for rel in [
        "package/battery/e1-phone-17p3wh-pack.yaml",
        "docs/board/e1-phone-mainboard-metrics.yaml",
        "docs/board/e1-phone-enclosure-interface.yaml",
        "mechanical/e1-phone/cad/e1_phone_params.yaml",
        "board/kicad/e1-phone/layout-utilization.yaml",
        "board/kicad/e1-phone/preliminary-bom.yaml",
    ]:
        if rel not in options["source_artifacts"]:
            raise SystemExit(f"battery layout options missing source artifact {rel}")

    reference = battery["target_pack"]["public_reference_dimensions_mm"]
    selected = options["selected_energy_reference"]
    if selected["pack_class"] != battery["target_pack"]["primary_candidate"]:
        raise SystemExit("battery layout option pack diverges from battery binding")
    if (
        selected["pack_class"]
        != metrics["power_efficiency_targets"]["battery"]["selected_pack_class"]
    ):
        raise SystemExit("battery layout option pack diverges from metrics")
    if selected["pack_class"] not in {
        item["primary"] for item in bom["major_items"] if item["function"] == "battery_pack"
    }:
        raise SystemExit("battery layout option pack diverges from preliminary BOM")
    if selected["public_reference_dimensions_mm"] != reference:
        raise SystemExit("battery layout selected dimensions diverge from battery binding")

    geometry = options["current_geometry"]
    if (
        geometry["device_envelope_mm"]
        != metrics["industrial_design_assumptions"]["device_envelope_mm"]
    ):
        raise SystemExit("battery layout device envelope diverges from metrics")
    if geometry["device_envelope_mm"] != enclosure["coordinate_system"]["device_envelope"]:
        raise SystemExit("battery layout device envelope diverges from enclosure interface")
    metrics_bbox = metrics["mainboard_outline_concept"]["bounding_box_mm"]
    if geometry["board_bbox_mm"] != {
        "width": metrics_bbox["width"],
        "height": metrics_bbox["height"],
    }:
        raise SystemExit("battery layout board bbox diverges from metrics")
    board_window = geometry["board_battery_window_mm"]
    if board_window != {
        "width": utilization["battery_window_mm"]["width"],
        "height": utilization["battery_window_mm"]["height"],
    }:
        raise SystemExit("battery layout board window diverges from layout utilization")
    cad_battery = cad["battery"]["envelope_mm"]
    if geometry["cad_selected_battery_mm"] != {
        "width": cad_battery[0],
        "height": cad_battery[1],
        "thickness": cad_battery[2],
    }:
        raise SystemExit("battery layout CAD selected battery diverges from mechanical params")
    if geometry.get("cad_topology") != "top_bottom_pcb_islands_with_full_width_battery_cavity":
        raise SystemExit(f"battery layout CAD topology is stale: {geometry.get('cad_topology')}")

    deltas = options["fit_deltas_vs_selected_pack"]
    expected_shortfall = {
        "width": round(reference["width"] - board_window["width"], 3),
        "height": round(reference["height"] - board_window["height"], 3),
        "area_mm2": round(
            reference["width"] * reference["height"]
            - board_window["width"] * board_window["height"],
            3,
        ),
    }
    if deltas["board_window_shortfall_mm"] != expected_shortfall:
        raise SystemExit(
            "battery layout board-window shortfall is stale: "
            f"{deltas['board_window_shortfall_mm']} vs {expected_shortfall}"
        )
    expected_cad_delta = {
        "width": round(reference["width"] - cad_battery[0], 3),
        "height": round(reference["height"] - cad_battery[1], 3),
        "thickness": round(reference["thickness"] - cad_battery[2], 3),
    }
    if deltas["cad_selected_pack_delta_mm"] != expected_cad_delta:
        raise SystemExit("battery layout CAD selected-pack delta is stale")
    if expected_cad_delta != {"width": 0.0, "height": 0.0, "thickness": 0.0}:
        raise SystemExit("mechanical CAD battery must match the selected pack class")
    if not deltas["selected_pack_fits_current_board_window"]:
        raise SystemExit(
            "battery layout must record that the KiCad concept cavity now fits the pack"
        )
    if not deltas["selected_pack_fits_current_cad"]:
        raise SystemExit("battery layout must record that CAD now fits the selected pack")

    layout_options = {item["id"]: item for item in options["layout_options"]}
    for option_id in [
        "keep_45x72_window_reduce_capacity",
        "enlarge_cavity_for_64x87_pack",
        "custom_narrow_17wh_pack",
    ]:
        if option_id not in layout_options:
            raise SystemExit(f"battery layout options missing {option_id}")
    if options["recommended_next_step"]["decision"] != (
        "run_evt0_repack_for_64x87_energy_reference_and_parallel_quote_custom_narrow_pack"
    ):
        raise SystemExit("battery layout options lost the recommended EVT0 repack decision")
    for blocker in [
        "supplier pack drawing, PCM tail drawing, NTC curve, and connector pinout are not approved",
        "split-island KiCad concept is not routed or DRC clean",
        "no enclosure tolerance stack with measured battery swelling allowance",
    ]:
        if blocker not in options["release_blockers"]:
            raise SystemExit(f"battery layout options missing release blocker {blocker}")
    for claim in [
        "battery_layout_closed",
        "battery_pack_fits_current_board",
        "enclosure_ready",
        "charging_ready",
    ]:
        if claim not in options["forbidden_claims"]:
            raise SystemExit(f"battery layout options missing forbidden claim {claim}")
    print(
        "battery layout options ok: "
        f"selected={reference['width']}x{reference['height']}mm "
        f"window_shortfall={expected_shortfall['width']}x{expected_shortfall['height']}mm"
    )


def check_board_topology_decision() -> None:
    decision = load_yaml(ROOT / "board/kicad/e1-phone/board-topology-decision.yaml")
    battery_options = load_yaml(ROOT / "board/kicad/e1-phone/battery-layout-options.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    overlay = load_yaml(ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml")
    enclosure = load_yaml(ROOT / "docs/board/e1-phone-enclosure-interface.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    battery = load_yaml(ROOT / "package/battery/e1-phone-17p3wh-pack.yaml")

    if (
        decision["status"]
        != "blocked_split_island_concept_requires_routing_interconnect_and_assembly_validation"
    ):
        raise SystemExit(f"unexpected board topology decision status: {decision['status']}")
    for rel in [
        "board/kicad/e1-phone/battery-layout-options.yaml",
        "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml",
        "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "board/kicad/e1-phone/mechanical-overlay.yaml",
        "docs/board/e1-phone-enclosure-interface.yaml",
        "docs/board/e1-phone-mainboard-metrics.yaml",
        "package/battery/e1-phone-17p3wh-pack.yaml",
    ]:
        if rel not in decision["source_artifacts"]:
            raise SystemExit(f"board topology decision missing source artifact {rel}")

    anchors = decision["fixed_product_anchors"]
    if (
        anchors["device_envelope_mm"]
        != metrics["industrial_design_assumptions"]["device_envelope_mm"]
    ):
        raise SystemExit("board topology device envelope diverges from metrics")
    if anchors["device_envelope_mm"] != enclosure["coordinate_system"]["device_envelope"]:
        raise SystemExit("board topology device envelope diverges from enclosure interface")
    board_bbox = placement["board"]["bbox_mm"]
    if anchors["board_bbox_mm"] != {"width": board_bbox["width"], "height": board_bbox["height"]}:
        raise SystemExit("board topology bbox diverges from placement matrix")
    selected_battery = battery["target_pack"]["public_reference_dimensions_mm"]
    if anchors["selected_battery_mm"] != selected_battery:
        raise SystemExit("board topology selected battery diverges from battery binding")
    if (
        anchors["selected_battery_mm"]
        != battery_options["selected_energy_reference"]["public_reference_dimensions_mm"]
    ):
        raise SystemExit("board topology selected battery diverges from battery layout options")

    constraints = decision["topology_constraints"]
    if not constraints["selected_battery_width_equals_board_width"]:
        raise SystemExit("board topology must record full-width selected battery constraint")
    if selected_battery["width"] != board_bbox["width"]:
        raise SystemExit("selected battery width no longer equals current board width")
    if not constraints["full_width_battery_requires_top_bottom_board_islands_or_rigid_flex"]:
        raise SystemExit(
            "board topology must require split islands or rigid-flex for full-width pack"
        )
    if not constraints["concept_battery_keepout_matches_selected_64x87_pack"]:
        raise SystemExit("board topology must record the updated KiCad concept battery keepout")
    if not constraints["current_side_key_spine_intrudes_into_full_width_battery_zone"]:
        raise SystemExit("board topology must record side-key/full-width-pack conflict")
    if not constraints["cad_haptic_repacked_outside_full_width_battery_zone"]:
        raise SystemExit("board topology must record the CAD haptic repack")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    side_keys = placements["SW_POWER_VOL"]["region_mm"]
    battery_window = overlay["keepouts"][0]["rect_mm"]
    side_key_overlaps_battery = (
        side_keys["x"] < battery_window["x"] + battery_window["width"]
        and side_keys["x"] + side_keys["width"] > battery_window["x"]
        and side_keys["y"] < battery_window["y"] + battery_window["height"]
        and side_keys["y"] + side_keys["height"] > battery_window["y"]
    )
    if side_key_overlaps_battery:
        raise SystemExit(
            "active side-key placement still intrudes into the full-width battery cavity"
        )
    side_key_side = placements["SW_POWER_VOL"]["side"]
    if "side_key_flex" not in side_key_side and "top_island" not in side_key_side:
        raise SystemExit("side-key placement must route through the top island or a side-key flex")

    topologies = {item["id"]: item for item in decision["evaluated_topologies"]}
    expected = {
        "current_single_rigid_with_45x72_window": "reject_for_22p45wh_target",
        "single_rigid_c_shape_full_width_64x87_window": "reject_geometry_conflict",
        "top_bottom_rigid_islands_with_flex_or_board_to_board": "preferred_evt0_repack_candidate",
        "two_board_stack_with_battery_rear_pocket": "fallback_if_top_bottom_islands_fail",
        "custom_narrow_pack_single_rigid": "parallel_procurement_fallback",
    }
    for topology_id, expected_decision in expected.items():
        if topology_id not in topologies:
            raise SystemExit(f"board topology decision missing {topology_id}")
        if topologies[topology_id]["decision"] != expected_decision:
            raise SystemExit(f"board topology {topology_id} decision changed unexpectedly")
    selected = decision["selected_topology_for_next_repack"]
    if selected["id"] != "top_bottom_rigid_islands_with_flex_or_board_to_board":
        raise SystemExit("board topology selected repack must preserve top/bottom island decision")
    for required_change in [
        "replace current center-window board with top and bottom rigid islands",
        "move side buttons to a side-key flex or enclosure-mounted switch subassembly",
        "relocate SIM/service away from the full-width battery zone",
        "define board-to-board or rigid-flex interconnect for USB/audio/power/control",
    ]:
        if required_change not in selected["required_pcb_changes"]:
            raise SystemExit(f"board topology missing required PCB change: {required_change}")
    for blocker in [
        "split-island Edge.Cuts are concept rectangles, not routed rigid-flex fabrication data",
        "no routed copper, zones, vias, or DRC evidence for split-island topology",
        "side-key and SIM/service strategy needs supplier flex and enclosure validation",
        "exact rigid-flex or board-to-board connector stackup not selected",
    ]:
        if blocker not in decision["release_blockers"]:
            raise SystemExit(f"board topology missing release blocker: {blocker}")
    for claim in [
        "board_topology_closed",
        "rigid_flex_ready",
        "selected_battery_fits_current_pcb",
        "enclosure_ready",
        "fabrication_ready",
    ]:
        if claim not in decision["forbidden_claims"]:
            raise SystemExit(f"board topology missing forbidden claim {claim}")
    print(
        "board topology decision ok: "
        f"selected={selected['id']} battery_width={selected_battery['width']}mm"
    )


def check_top_bottom_interconnect_plan() -> None:
    plan = load_yaml(ROOT / "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml")
    binding = load_yaml(ROOT / "package/interconnect/e1-phone-top-bottom-flex.yaml")
    decision = load_yaml(ROOT / "board/kicad/e1-phone/board-topology-decision.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")

    if plan["status"] != "blocked_interconnect_requires_connector_stackup_and_si":
        raise SystemExit(f"unexpected top/bottom interconnect status: {plan['status']}")
    if binding["status"] != "planning_binding_no_connector_stack_selected":
        raise SystemExit(f"unexpected interconnect binding status: {binding['status']}")

    for rel in [
        "board/kicad/e1-phone/board-topology-decision.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "package/interconnect/e1-phone-top-bottom-flex.yaml",
        "package/usb-c/e1-phone-usb-c-port.yaml",
        "package/audio/v0-codec.yaml",
    ]:
        if rel not in plan["source_artifacts"]:
            raise SystemExit(f"top/bottom interconnect plan missing source artifact {rel}")

    selected_topology = decision["selected_topology_for_next_repack"]["id"]
    if plan["selected_topology"] != selected_topology:
        raise SystemExit("top/bottom interconnect plan diverges from selected board topology")
    if plan["preferred_interconnect_family"] != binding["primary_candidate"]["family"]:
        raise SystemExit("top/bottom interconnect preferred family diverges from package binding")
    fallback_families = set(plan["fallback_interconnect_families"])
    if not {"Hirose_FH58_signal_flex_plus_power_tabs", "Molex_SlimStack_two_board_stack"}.issubset(
        fallback_families
    ):
        raise SystemExit("top/bottom interconnect plan lost required fallback families")

    plan_buses = {bus["name"]: bus for bus in plan["cross_island_buses"]}
    for bus in binding["required_cross_island_buses"]:
        if bus["name"] not in plan_buses:
            raise SystemExit(f"top/bottom interconnect plan missing bus {bus['name']}")
        if not set(bus["nets"]).issubset(set(plan_buses[bus["name"]]["nets"])):
            raise SystemExit(f"top/bottom interconnect plan dropped nets from bus {bus['name']}")

    available_nets: set[str] = set()
    for block in netlist["blocks"]:
        available_nets.update(flatten_net_groups(block["nets"]))
    for domain in netlist["voltage_domains"]:
        available_nets.add(domain["name"])
    available_nets.update(netlist["required_shared_nets"].get("power", []))

    routing_refs = {item["name"] for item in routing["differential_pairs"]}
    routing_refs.update(item["name"] for item in routing["single_ended_buses"])
    for bus in plan["cross_island_buses"]:
        missing_nets = sorted(set(bus["nets"]) - available_nets)
        if missing_nets:
            raise SystemExit(
                f"top/bottom interconnect bus {bus['name']} has unknown nets: {missing_nets}"
            )
        unknown_refs = sorted(set(bus["routing_constraint_refs"]) - routing_refs)
        if unknown_refs:
            raise SystemExit(
                f"top/bottom interconnect bus {bus['name']} has unknown constraints: {unknown_refs}"
            )

    required_bus_nets = {
        "USB2_FROM_BOTTOM_PORT_TO_TOP_SOC_PD": {"USB_DP", "USB_DN", "VBUS", "GND"},
        "POWER_FROM_TOP_CHARGER_TO_BOTTOM_IO": {
            "SYS",
            "AON_1V8",
            "IO_1V8",
            "VDD_AUDIO_3V3",
            "VDD_AMP_3V3",
            "GND",
        },
        "AUDIO_DIGITAL_TO_BOTTOM_CODEC_MICS": {
            "I2S_BCLK",
            "I2S_LRCLK",
            "I2S_DOUT",
            "I2S_DIN",
            "PDM_CLK",
            "PDM_DAT",
        },
        "HAPTIC_AND_FACTORY_TEST": {"HAPTIC_OUT", "VBUS", "VBAT", "SYS", "RF_VBAT"},
    }
    for bus_name, required_nets in required_bus_nets.items():
        if not required_nets.issubset(set(plan_buses[bus_name]["nets"])):
            raise SystemExit(f"top/bottom interconnect bus {bus_name} lost required nets")

    stack = plan["candidate_connector_stack"]
    if stack["primary"]["family"] != "Hirose_BM28":
        raise SystemExit("top/bottom interconnect primary connector must stay Hirose BM28 class")
    if not {
        "exact_circuit_count_and_power_contact_count",
        "mating_pair_orderable_part_numbers",
    }.issubset(set(stack["primary"]["unresolved"])):
        raise SystemExit(
            "top/bottom interconnect primary must remain blocked on exact orderable pair"
        )
    if stack["signal_flex_alternate"]["family"] != "Hirose_FH58":
        raise SystemExit(
            "top/bottom interconnect signal-flex alternate must stay Hirose FH58 class"
        )
    if stack["stacked_board_fallback"]["family"] != "Molex_SlimStack_ACB6_Plus_or_equivalent":
        raise SystemExit(
            "top/bottom interconnect stacked-board fallback must stay Molex SlimStack class"
        )

    budget = plan["minimum_pin_budget"]
    computed_min = (
        budget["signal_or_power_nets_counted"]
        + budget["required_ground_or_return_pins_min"]
        + budget["required_spares_min"]
    )
    if budget["recommended_contacts_min"] < computed_min:
        raise SystemExit("top/bottom interconnect contact budget is undercounted")

    for blocker in [
        "exact connector circuit count and orderable mating part numbers not selected",
        "flex stackup, bend radius, stiffener, and strain relief not drawn",
        "USB2 and audio SI across the flex not simulated or measured",
        "power contact current rise and return allocation not reviewed",
        "bottom island decoupling, ESD, and test fixture edge not implemented in KiCad",
        "assembly sequence for battery insertion and split-board connection not validated",
    ]:
        if blocker not in plan["release_blockers"]:
            raise SystemExit(f"top/bottom interconnect plan missing release blocker: {blocker}")
    for claim in [
        "interconnect_ready",
        "rigid_flex_ready",
        "usb_si_closed",
        "bottom_island_ready",
        "enclosure_ready",
    ]:
        if claim not in plan["forbidden_claims"]:
            raise SystemExit(f"top/bottom interconnect plan missing forbidden claim {claim}")
    print(
        "top/bottom interconnect plan ok: "
        f"preferred={plan['preferred_interconnect_family']} "
        f"buses={len(plan_buses)} contacts_min={budget['recommended_contacts_min']}"
    )


def check_matrix_and_bom() -> None:
    matrix = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    bom = load_yaml(ROOT / "board/kicad/e1-phone/preliminary-bom.yaml")
    placements = {item["refdes_group"]: item for item in matrix["placements"]}
    required = {
        "J_USB_C",
        "SW_POWER_VOL",
        "J_DISPLAY_TOUCH",
        "J_CAM0_CAM1",
        "U_CELL",
        "U_WIFI_BT",
        "U_PMIC_CHARGER",
        "J_BATTERY",
        "U_SOC_LPDDR_UFS",
        "U_AUDIO_SPK_MIC",
        "J_TOP_BOTTOM_FLEX_TOP",
        "J_TOP_BOTTOM_FLEX_BOTTOM",
    }
    missing = sorted(required - set(placements))
    if missing:
        raise SystemExit(f"missing placement groups: {missing}")
    functions = {item["function"] for item in bom["major_items"]}
    for function in [
        "display_touch",
        "rear_camera",
        "cellular",
        "wifi_bluetooth",
        "usb_c_receptacle_evt0",
        "side_buttons",
        "battery_pack",
        "top_bottom_interconnect",
    ]:
        if function not in functions:
            raise SystemExit(f"missing preliminary BOM function: {function}")
    print(f"placement matrix ok: {len(placements)} groups")
    print(f"preliminary bom ok: {len(bom['major_items'])} major items")


def check_procurement_readiness() -> None:
    procurement = load_yaml(ROOT / "board/kicad/e1-phone/procurement-readiness.yaml")
    bom = load_yaml(ROOT / "board/kicad/e1-phone/preliminary-bom.yaml")
    freeze = load_yaml(ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml")

    if procurement["status"] != "blocked_preliminary_bom_not_avl_or_purchase_order":
        raise SystemExit(f"unexpected procurement readiness status: {procurement['status']}")
    for rel in [
        "board/kicad/e1-phone/preliminary-bom.yaml",
        "board/kicad/e1-phone/supplier-sourcing-audit.yaml",
        "board/kicad/e1-phone/pinout-footprint-freeze.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
    ]:
        if rel not in procurement["source_artifacts"]:
            raise SystemExit(f"procurement readiness missing source artifact {rel}")
    policy = procurement["procurement_policy"]
    if policy["minimum_quote_quantity"] < 10 or policy["preferred_quote_quantity"] < 100:
        raise SystemExit(f"procurement readiness quote quantities are too weak: {policy}")
    for required in [
        "manufacturer_part_number",
        "supplier_part_number_or_orderable_sku",
        "quoted_unit_price_and_moq",
        "lead_time_and_lifecycle_statement",
        "recommended_footprint_or_connector_pinout",
    ]:
        if required not in policy["required_supplier_artifacts"]:
            raise SystemExit(f"procurement policy missing required artifact {required}")

    bom_items = {item["function"]: item for item in bom["major_items"]}
    procurement_items = {item["function"]: item for item in procurement["line_items"]}
    missing_procurement = sorted(set(bom_items) - set(procurement_items))
    extra_procurement = sorted(set(procurement_items) - set(bom_items))
    if missing_procurement or extra_procurement:
        raise SystemExit(
            "procurement readiness functions diverge from preliminary BOM: "
            f"missing={missing_procurement} extra={extra_procurement}"
        )
    for function, bom_item in bom_items.items():
        record = procurement_items[function]
        if record["selected_primary"] != bom_item["primary"]:
            raise SystemExit(f"procurement primary diverges from BOM for {function}")
        if record["procurement_status"].startswith("ready"):
            raise SystemExit(f"procurement record unexpectedly ready for {function}: {record}")
        if len(record["required_supplier_artifacts"]) < 4:
            raise SystemExit(f"procurement record has weak artifact list for {function}: {record}")
        if "risk_class" not in record:
            raise SystemExit(f"procurement record missing risk class for {function}")
    front_camera = bom_items["front_camera"]
    if "TBD" in front_camera["primary"]:
        raise SystemExit("front camera BOM primary must not remain TBD")
    battery_pack = bom_items["battery_pack"]
    if "TBD" in battery_pack["primary"]:
        raise SystemExit("battery pack BOM primary must not remain TBD")
    if len(bom_items["display_touch"].get("alternates", [])) < 3:
        raise SystemExit("display BOM must preserve at least three alternates")
    if len(front_camera.get("alternates", [])) < 1:
        raise SystemExit("front camera BOM must preserve at least one alternate")
    if len(battery_pack.get("alternates", [])) < 2:
        raise SystemExit("battery BOM must preserve marketplace and OEM alternates")

    freeze_by_function = {item["bom_function"]: item for item in freeze["freeze_records"]}
    for function in [
        "display_touch",
        "rear_camera",
        "front_camera",
        "cellular",
        "wifi_bluetooth",
        "usb_c_receptacle_evt0",
        "side_buttons",
        "battery_pack",
        "audio_codec_amp_mics",
        "top_bottom_interconnect",
    ]:
        if function not in freeze_by_function:
            raise SystemExit(f"procurement readiness missing freeze record for {function}")
    checks = procurement["cross_checks"]
    for key in [
        "every_preliminary_bom_function_has_procurement_record",
        "every_procurement_record_is_blocked",
        "front_camera_no_longer_tbd",
        "display_has_three_or_more_alternates",
        "production_bom_not_ready",
    ]:
        if not checks[key]:
            raise SystemExit(f"procurement readiness failed cross-check {key}")
    for blocker in [
        "supplier_quotes_not_captured",
        "samples_not_received",
        "AVL_not_approved",
        "production_BOM_not_generated_from_KiCad",
    ]:
        if blocker not in procurement["release_blockers"]:
            raise SystemExit(f"procurement readiness missing release blocker {blocker}")
    for claim in [
        "procurement_ready",
        "AVL_ready",
        "production_BOM_ready",
        "supplier_selected",
        "alternates_approved",
        "purchase_order_ready",
    ]:
        if claim not in procurement["forbidden_claims"]:
            raise SystemExit(f"procurement readiness missing forbidden claim {claim}")
    print(
        "procurement readiness ok: "
        f"{len(procurement_items)} line items blocked, "
        f"front_camera={front_camera['primary']}"
    )


def check_supplier_sourcing_audit() -> None:
    audit = load_yaml(ROOT / "board/kicad/e1-phone/supplier-sourcing-audit.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    if audit["status"] != "sourcing_supported_by_public_listings_not_procurement_ready":
        raise SystemExit(f"unexpected supplier sourcing audit status: {audit['status']}")
    summary = audit["selection_summary"]
    if (
        summary["device_envelope_mm"]
        != metrics["industrial_design_assumptions"]["device_envelope_mm"]
    ):
        raise SystemExit("supplier sourcing audit device envelope diverges from metrics")
    if summary["mainboard_bbox_mm"] != metrics["mainboard_outline_concept"]["bounding_box_mm"]:
        raise SystemExit("supplier sourcing audit board bbox diverges from metrics")
    if not audit["cross_checks"]["display_primary_fits_current_envelope"]:
        raise SystemExit("supplier sourcing audit no longer proves primary display envelope fit")
    if (
        audit["cross_checks"]["display_clearance_mm"]
        != display_fit["primary_clearance_in_current_envelope_mm"]
    ):
        raise SystemExit("supplier sourcing audit display clearance diverges from display-fit")
    evidence = audit["public_sourcing_evidence"]
    validation = audit.get("public_source_validation", {})
    if validation.get("checked_date") != audit["date"]:
        raise SystemExit(
            f"supplier sourcing validation date diverges from audit date: {validation}"
        )
    validated_sources = validation.get("validated_sources", [])
    if len(validated_sources) < 7:
        raise SystemExit("supplier sourcing audit has too few validated public-source records")
    validated_groups = {item.get("group") for item in validated_sources}
    for group in ["display", "camera", "cellular", "wifi_bluetooth"]:
        if group not in validated_groups:
            raise SystemExit(f"supplier sourcing validation missing group {group}")
    for item in validated_sources:
        if not str(item.get("url", "")).startswith("https://"):
            raise SystemExit(f"supplier sourcing validation source missing https URL: {item}")
        if item.get("public_page_status") not in {
            "public_listing_observed_2026_05_20",
            "vendor_page_observed_2026_05_20",
        }:
            raise SystemExit(f"supplier sourcing validation source stale/unrecognized: {item}")
        if len(item.get("observed_fields", [])) < 4:
            raise SystemExit(f"supplier sourcing validation has weak observed fields: {item}")
        if not item.get("blocking_gap") or not item.get("layout_use"):
            raise SystemExit(
                f"supplier sourcing validation missing layout/blocking context: {item}"
            )
    minimum_counts = {
        "display": 4,
        "camera": 5,
        "cellular": 2,
        "wifi_bluetooth": 1,
    }
    for group, count in minimum_counts.items():
        if len(evidence[group]) < count:
            raise SystemExit(f"supplier sourcing audit has too few {group} sources")
        for item in evidence[group]:
            url = item.get("url", "")
            if not url.startswith("https://"):
                raise SystemExit(f"supplier sourcing audit source missing https URL: {item}")
            if not item.get("observed_public_specs"):
                raise SystemExit(f"supplier sourcing audit source missing observed specs: {item}")
    checks = audit["cross_checks"]
    for key in [
        "has_alibaba_display_evidence",
        "has_made_in_china_display_evidence",
        "has_high_brightness_display_alternate",
        "has_thin_amoled_display_alternate",
        "has_camera_marketplace_evidence",
        "has_front_camera_candidate_evidence",
        "has_alibaba_camera_evidence",
        "has_cellular_primary_vendor_evidence",
        "has_wifi_bt_primary_vendor_evidence",
    ]:
        if not checks[key]:
            raise SystemExit(f"supplier sourcing audit missing cross-check {key}")
    display_roles = {item["procurement_role"] for item in evidence["display"]}
    for role in [
        "primary_mechanical_anchor",
        "high_brightness_display_alternate",
        "thin_display_power_alternate",
    ]:
        if role not in display_roles:
            raise SystemExit(f"supplier sourcing audit missing display role {role}")
    camera_roles = {item["procurement_role"] for item in evidence["camera"]}
    for role in [
        "rear_camera_primary_pin_count_class",
        "rear_camera_4lane_alternate",
        "front_camera_primary_class",
        "front_camera_or_lab_bringup_alternate",
    ]:
        if role not in camera_roles:
            raise SystemExit(f"supplier sourcing audit missing camera role {role}")
    for blocker in [
        "supplier_contact_and_quote_not_captured",
        "samples_not_ordered_or_received",
        "exact_pinouts_not_received",
        "supplier_2d_drawings_not_received",
        "regulatory_certification_scope_not_confirmed",
    ]:
        if blocker not in audit["release_blockers"]:
            raise SystemExit(f"supplier sourcing audit missing release blocker {blocker}")
    for claim in [
        "supplier_selected",
        "samples_ordered",
        "avl_ready",
        "pinouts_frozen",
        "footprints_frozen",
        "fabrication_ready",
    ]:
        if claim not in audit["forbidden_claims"]:
            raise SystemExit(f"supplier sourcing audit missing forbidden claim {claim}")
    print(
        "supplier sourcing audit ok: "
        f"{len(evidence['display'])} display, {len(evidence['camera'])} camera, "
        f"{len(evidence['cellular'])} cellular, {len(evidence['wifi_bluetooth'])} wifi/bt sources"
    )


def check_supplier_rfq_transmittal_drafts() -> None:
    drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    source_verification = load_yaml(ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml")
    evidence_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")

    if drafts["schema"] != "eliza.e1_phone_supplier_rfq_transmittal_drafts.v1":
        raise SystemExit(f"unexpected supplier RFQ transmittal schema: {drafts['schema']}")
    if drafts["status"] != "drafts_prepared_not_sent_not_supplier_evidence":
        raise SystemExit(f"unexpected supplier RFQ transmittal status: {drafts['status']}")
    for rel in drafts["source_artifacts"]:
        require_path(ROOT / rel)
    if "not sent RFQs" not in drafts["claim_boundary"]:
        raise SystemExit("supplier RFQ transmittal claim boundary must stay fail-closed")

    policy = drafts["draft_policy"]
    intake_policy = intake["intake_policy"]
    if policy["quote_quantities"] != intake_policy["quote_quantities"]:
        raise SystemExit("supplier RFQ draft quote quantities diverge from intake")
    if (
        policy["minimum_sample_lot_per_candidate"]
        != intake_policy["minimum_sample_lot_per_candidate"]
    ):
        raise SystemExit("supplier RFQ draft sample lot diverges from intake")
    if not policy["sample_receipt_required_before_pinout_freeze"]:
        raise SystemExit("supplier RFQ drafts must require samples before pinout freeze")
    if policy["send_status"] != "not_sent":
        raise SystemExit("supplier RFQ drafts unexpectedly marked sent")
    if policy["production_archive_status"] != "not_archived":
        raise SystemExit("supplier RFQ drafts unexpectedly marked production archived")

    intake_lines = {item["function"]: item for item in intake["rfq_lines"]}
    evidence_records = {item["function"]: item for item in evidence_map["evidence_records"]}
    master_drafts = {item["function"]: item for item in drafts["drafts"]}
    if set(master_drafts) != set(intake_lines):
        raise SystemExit("supplier RFQ drafts diverge from RFQ intake functions")
    if set(master_drafts) != set(evidence_records):
        raise SystemExit("supplier RFQ drafts diverge from supplier-to-KiCad evidence map")
    if len(master_drafts) != 10:
        raise SystemExit(f"supplier RFQ drafts expected 10 functions, got {len(master_drafts)}")
    if set(drafts["generated_draft_files"]) != {
        item["planned_archive_paths_after_send"]["draft"] for item in master_drafts.values()
    }:
        raise SystemExit("supplier RFQ generated draft file list diverges from draft records")

    public_source_ids = {item["id"] for item in source_verification["verified_sources"]}
    required_gate_keys = {
        "orderable_mpn_received",
        "signed_2d_drawing_received",
        "pinout_or_pad_map_received",
        "recommended_land_pattern_received",
        "step_or_brep_model_received",
        "sample_received_and_inspected",
        "compliance_pack_received",
        "pinout_symbol_footprint_reviews_complete",
    }
    forbidden_claims = {
        "rfq_sent",
        "supplier_response_received",
        "supplier_approved",
        "pinouts_frozen",
        "footprints_frozen",
        "step_models_bound",
        "production_archive_complete",
        "routed_pcb_ready",
        "enclosure_ready",
    }

    for function, draft in master_drafts.items():
        intake_line = intake_lines[function]
        evidence = evidence_records[function]
        if draft["status"] != "draft_not_sent_not_supplier_evidence":
            raise SystemExit(f"supplier RFQ draft unexpectedly open: {function}")
        for key in ["primary_candidate", "package_binding"]:
            if draft[key] != intake_line[key]:
                raise SystemExit(f"supplier RFQ draft {function} {key} diverges from intake")
            if draft[key] != evidence[key]:
                raise SystemExit(f"supplier RFQ draft {function} {key} diverges from evidence map")
        if draft["source_basis"] != intake_line["marketplace_or_vendor_basis"]:
            raise SystemExit(f"supplier RFQ draft {function} source basis diverges from intake")
        if draft["request"]["required_supplier_artifacts"] != intake_line["required_supplier_artifacts"]:
            raise SystemExit(f"supplier RFQ draft {function} requested artifacts diverge")
        if draft["request"]["board_dependency"] != intake_line["board_dependency"]:
            raise SystemExit(f"supplier RFQ draft {function} board dependency diverges")
        if draft["request"]["quote_quantities"] != policy["quote_quantities"]:
            raise SystemExit(f"supplier RFQ draft {function} quote quantities diverge")
        if draft["request"]["minimum_sample_lot"] != policy["minimum_sample_lot_per_candidate"]:
            raise SystemExit(f"supplier RFQ draft {function} sample lot diverges")
        if draft["request"]["required_response_format"] != intake_policy["required_response_format"]:
            raise SystemExit(f"supplier RFQ draft {function} response format diverges")
        if draft["request"]["accepted_document_languages"] != intake_policy["accepted_document_languages"]:
            raise SystemExit(f"supplier RFQ draft {function} document languages diverge")
        if set(draft["acceptance_gate_before_kicad_use"]) != required_gate_keys:
            raise SystemExit(f"supplier RFQ draft {function} gate key set changed")
        if any(draft["acceptance_gate_before_kicad_use"].values()):
            raise SystemExit(f"supplier RFQ draft {function} has a closed gate before evidence")
        if not draft["recipient_candidates"]:
            raise SystemExit(f"supplier RFQ draft {function} has no recipient candidates")
        for source_id in draft["verified_public_source_ids"]:
            if source_id not in public_source_ids:
                raise SystemExit(f"supplier RFQ draft {function} unknown source id {source_id}")
        for candidate in draft["recipient_candidates"]:
            if not str(candidate.get("url", "")).startswith("https://"):
                raise SystemExit(f"supplier RFQ draft {function} recipient missing https URL")
            if not candidate.get("public_page_status"):
                raise SystemExit(f"supplier RFQ draft {function} recipient missing page status")

        archive_paths = draft["planned_archive_paths_after_send"]
        if archive_paths["draft"] != evidence["rfq_transmittal_draft"]["planned_draft_path"]:
            raise SystemExit(f"supplier RFQ draft {function} planned draft path diverges")
        if (
            archive_paths["release_archive"]
            != evidence["required_production_evidence"]["rfq_transmittal"]
        ):
            raise SystemExit(f"supplier RFQ draft {function} release archive path diverges")
        if (
            archive_paths["supplier_response_pack"]
            != evidence["required_production_evidence"]["rfq_response_pack"]
        ):
            raise SystemExit(f"supplier RFQ draft {function} response pack path diverges")

        draft_path = ROOT / archive_paths["draft"]
        require_path(draft_path)
        draft_file = load_yaml(draft_path)
        if draft_file["schema"] != "eliza.e1_phone_supplier_rfq_transmittal_draft.v1":
            raise SystemExit(f"supplier RFQ draft file schema diverges: {function}")
        if draft_file["status"] != draft["status"]:
            raise SystemExit(f"supplier RFQ draft file status diverges: {function}")
        if draft_file["date"] != drafts["date"]:
            raise SystemExit(f"supplier RFQ draft file date diverges: {function}")
        if draft_file["draft"] != draft:
            raise SystemExit(f"supplier RFQ draft file content diverges: {function}")
        if set(draft_file["forbidden_claims"]) != forbidden_claims:
            raise SystemExit(f"supplier RFQ draft file forbidden claims changed: {function}")

    print(f"supplier RFQ transmittal drafts ok: {len(master_drafts)} draft files fail-closed")


def check_display_camera_source_revalidation() -> None:
    revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    source_verification = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml"
    )

    if revalidation["schema"] != "eliza.e1_phone_display_camera_oem_source_revalidation.v1":
        raise SystemExit("display/camera source revalidation schema diverges")
    if revalidation["status"] != "public_sources_revalidated_screen_camera_not_supplier_approved":
        raise SystemExit(
            f"unexpected display/camera source revalidation status: {revalidation['status']}"
        )
    context = revalidation["browser_revalidation_context"]
    if context["method"] != "manual_browser_open_and_search_on_2026_05_21":
        raise SystemExit("display/camera source revalidation method is stale")
    current = context["current_browser_result"]
    if current["checked_date"] != "2026-05-21":
        raise SystemExit("display/camera source revalidation date is stale")
    for key in [
        "display_primary_page_still_exposes",
        "rear_camera_primary_page_still_exposes",
        "front_camera_primary_page_still_exposes",
    ]:
        if len(current[key]) < 6:
            raise SystemExit(f"display/camera current source evidence too weak: {key}")
    if "shortlist evidence only" not in current["alibaba_display_alternate_result"]:
        raise SystemExit("Alibaba fallback must remain shortlist-only")

    sources = {item["id"]: item for item in revalidation["revalidated_sources"]}
    required_sources = {
        "display_primary_chenghao_ch550fh01a_ct",
        "rear_camera_primary_sincere_first_ov13855",
        "front_camera_primary_sincere_first_gc5035",
        "front_camera_alternate_alibaba_junde_imx219",
    }
    if set(sources) != required_sources:
        raise SystemExit("display/camera revalidation source set diverges")
    display = sources["display_primary_chenghao_ch550fh01a_ct"]
    if display["source_type"] != "direct_made_in_china_page_opened_2026_05_21":
        raise SystemExit("display primary source type is stale")
    if display["observed_public_fields"]["model"] != "CH550FH01A-CT":
        raise SystemExit("display primary model changed")
    if display["observed_public_fields"]["resolution"] != "1080x1920":
        raise SystemExit("display primary resolution changed")
    if (
        display["observed_public_fields"]["module_outline_mm"]
        != display_fit["selected_primary_display"]["outline_mm"]
    ):
        raise SystemExit("display primary outline diverges from display fit")
    if display["board_decision"] != "keep_as_primary_display_mechanical_anchor":
        raise SystemExit("display primary board decision changed")

    rear = sources["rear_camera_primary_sincere_first_ov13855"]
    if rear["source_type"] != "direct_made_in_china_page_opened_2026_05_21":
        raise SystemExit("rear camera source type is stale")
    if rear["observed_public_fields"]["pin_count"] != 24:
        raise SystemExit("rear camera pin-count source changed")
    if rear["observed_public_fields"]["resolution_mp"] != 13:
        raise SystemExit("rear camera resolution source changed")
    if rear["board_decision"] != "keep_as_rear_camera_primary_class_pending_supplier_xy_z_drawing":
        raise SystemExit("rear camera board decision changed")

    front = sources["front_camera_primary_sincere_first_gc5035"]
    if front["source_type"] != "direct_made_in_china_page_opened_2026_05_21":
        raise SystemExit("front camera source type is stale")
    if front["observed_public_fields"]["pin_count"] != 30:
        raise SystemExit("front camera pin-count source changed")
    if front["observed_public_fields"]["mipi_lanes"] != 2:
        raise SystemExit("front camera MIPI lane source changed")
    if front["board_decision"] != "keep_as_front_camera_primary_class_pending_supplier_xy_z_drawing":
        raise SystemExit("front camera board decision changed")

    alibaba = sources["front_camera_alternate_alibaba_junde_imx219"]
    if alibaba["source_type"] != "alibaba_direct_url_opened_not_machine_parsed_2026_05_21":
        raise SystemExit("Alibaba alternate source type is stale")
    if alibaba["fit_result"]["fits_xy"]:
        raise SystemExit("Alibaba Junde alternate must remain rejected by XY fit")
    if not alibaba["fit_result"]["width_shortfall_mm"] > 0:
        raise SystemExit("Alibaba Junde alternate width shortfall missing")
    if revalidation["layout_decisions"]["alibaba_junde_imx219"] != (
        "not_promoted_due_to_25x24_mm_envelope_and_parser_inaccessibility"
    ):
        raise SystemExit("Alibaba Junde layout decision changed")

    checks = revalidation["cross_checks"]
    for key in [
        "primary_display_matches_display_fit",
        "primary_display_fits_device_envelope",
        "front_camera_junde_alternate_still_rejected_by_active_matrix",
        "made_in_china_primary_display_verified",
        "made_in_china_primary_camera_sources_verified",
        "alibaba_camera_alternate_not_promoted",
        "requires_quote_drawing_samples_before_release",
        "supplier_source_verification_still_fail_closed",
        "current_public_fields_revalidated_2026_05_21",
        "alibaba_direct_page_remains_shortlist_only_until_parseable_or_supplier_response",
    ]:
        if checks[key] is not True:
            raise SystemExit(f"display/camera source revalidation cross-check failed: {key}")
    if source_verification["status"] != "public_sources_verified_not_supplier_approved_or_procurement_ready":
        raise SystemExit("source verification must remain fail-closed")
    for claim in [
        "display_supplier_approved",
        "camera_supplier_approved",
        "camera_region_ready",
        "display_connector_ready",
        "supplier_footprints_ready",
        "samples_received",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in revalidation["forbidden_claims"]:
            raise SystemExit(f"display/camera revalidation missing forbidden claim {claim}")
    print(
        "display/camera source revalidation ok: "
        f"{len(sources)} public sources checked, Alibaba fallback remains shortlist-only"
    )


def check_display_camera_acceptance() -> None:
    acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml"
    )
    integration = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-oem-integration.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    pinout_execution = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )

    if acceptance["schema"] != "eliza.e1_phone_display_camera_acceptance_checklist.v1":
        raise SystemExit("display/camera acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_display_camera_acceptance_requires_supplier_route_bringup_capture_and_clearance"
    ):
        raise SystemExit(f"unexpected display/camera acceptance status: {acceptance['status']}")
    for source in [
        "board/kicad/e1-phone/display-camera-oem-integration.yaml",
        "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml",
        "board/kicad/e1-phone/display-fit.yaml",
        "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml",
        "package/display/v0-dsi-720x1280.yaml",
        "package/camera/oem-mipi-csi-modules.yaml",
    ]:
        if source not in acceptance["source_artifacts"]:
            raise SystemExit(f"display/camera acceptance missing source {source}")
        require_path(ROOT / source)

    summary = acceptance["interface_summary"]
    display_context = integration["display_oem_context"]
    camera_context = integration["camera_oem_context"]
    if summary["display_part"] != display_context["selected_primary"]["part"]:
        raise SystemExit("display/camera acceptance display part stale")
    if summary["display_resolution"] != display_context["selected_primary"]["resolution"]:
        raise SystemExit("display/camera acceptance display resolution stale")
    if summary["display_outline_mm"] != display_fit["selected_primary_display"]["outline_mm"]:
        raise SystemExit("display/camera acceptance display outline stale")
    if summary["device_envelope_mm"] != display_fit["current_device_envelope_mm"]:
        raise SystemExit("display/camera acceptance device envelope stale")
    if summary["display_clearance_mm"] != display_fit["primary_clearance_in_current_envelope_mm"]:
        raise SystemExit("display/camera acceptance display clearance stale")
    if summary["display_fits_current_envelope"] != display_fit["primary_fits_current_envelope"]:
        raise SystemExit("display/camera acceptance fit flag stale")
    if summary["rear_camera_module"] != camera_context["rear_primary"]["module"]:
        raise SystemExit("display/camera acceptance rear camera module stale")
    if summary["rear_camera_sensor"] != camera_context["rear_primary"]["sensor"]:
        raise SystemExit("display/camera acceptance rear camera sensor stale")
    if summary["rear_camera_pin_count"] != camera_context["rear_primary"]["pin_count"]:
        raise SystemExit("display/camera acceptance rear camera pin count stale")
    if summary["front_camera_module"] != camera_context["front_primary"]["module"]:
        raise SystemExit("display/camera acceptance front camera module stale")
    if summary["front_camera_sensor"] != camera_context["front_primary"]["sensor"]:
        raise SystemExit("display/camera acceptance front camera sensor stale")
    if summary["front_camera_pin_count"] != camera_context["front_primary"]["pin_count"]:
        raise SystemExit("display/camera acceptance front camera pin count stale")
    if summary["connector_pinout_execution_status"] != pinout_execution["status"]:
        raise SystemExit("display/camera acceptance connector execution status stale")
    if summary["connector_pinout_execution_record_count"] != len(
        pinout_execution["connector_pinout_execution"]
    ):
        raise SystemExit("display/camera acceptance connector execution count stale")
    if summary["integration_status"] != integration["status"]:
        raise SystemExit("display/camera acceptance integration status stale")

    for _, draft_path in acceptance["supplier_draft_links"].items():
        require_path(ROOT / draft_path)
    expected_items = {
        "display_supplier_pack_and_sample",
        "display_fpc_pinout_symbol_footprint",
        "mipi_dsi_route_si_and_return_path",
        "display_touch_power_sequence_and_bringup",
        "rear_camera_supplier_pack_and_sample",
        "front_camera_supplier_pack_and_sample",
        "mipi_csi_route_power_and_clocking",
        "camera_capture_iq_and_calibration",
        "display_camera_z_stack_and_enclosure_clearance",
    }
    items = {item["id"]: item for item in acceptance["acceptance_items"]}
    if set(items) != expected_items:
        raise SystemExit("display/camera acceptance item set diverges")
    for item_id, item in items.items():
        if item["status"] != "blocked_missing_supplier_route_bringup_capture_or_clearance_evidence":
            raise SystemExit(f"display/camera acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"display/camera acceptance item too weak: {item_id}")

    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"display/camera acceptance cross-check failed: {key}")
    for blocker in [
        "Display/touch and camera supplier drawings, pinouts, connector land patterns, STEP models, and samples missing",
        "Display/camera connector pinout execution package is blocked until supplier pinouts and connector MPNs arrive",
        "Routed MIPI DSI/CSI length-skew, impedance, return-path, and DRC/SI evidence missing",
        "Display touch bring-up, camera capture, image-quality, and calibration evidence missing",
        "Routed-board STEP z-stack and enclosure clearance report missing for display and camera modules",
    ]:
        if blocker not in acceptance["release_blockers"]:
            raise SystemExit(f"display/camera acceptance missing blocker: {blocker}")
    for claim in [
        "display_camera_oem_ready",
        "display_touch_ready",
        "camera_ready",
        "mipi_routed",
        "supplier_pack_received",
        "pinouts_frozen",
        "footprints_frozen",
        "step_models_bound",
        "display_bringup_ready",
        "camera_capture_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in acceptance["forbidden_claims"]:
            raise SystemExit(f"display/camera acceptance missing forbidden claim {claim}")
    print(
        "display/camera acceptance ok: "
        f"{len(items)} acceptance items blocked, display={summary['display_part']}"
    )


def check_usb_sidekey_acceptance() -> None:
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    integration = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    usb_binding = load_yaml(ROOT / "package/usb-c/e1-phone-usb-c-port.yaml")
    side_buttons = load_yaml(ROOT / "package/human-interface/side-buttons.yaml")

    if acceptance["schema"] != "eliza.e1_phone_usb_sidekey_acceptance_checklist.v1":
        raise SystemExit("USB/side-key acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_usb_c_sidekey_acceptance_requires_supplier_route_enclosure_and_measurements"
    ):
        raise SystemExit(f"unexpected USB/side-key acceptance status: {acceptance['status']}")
    for source in [
        "board/kicad/e1-phone/usb-sidekey-integration.yaml",
        "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml",
        "package/usb-c/e1-phone-usb-c-port.yaml",
        "package/human-interface/side-buttons.yaml",
    ]:
        if source not in acceptance["source_artifacts"]:
            raise SystemExit(f"USB/side-key acceptance missing source {source}")
        require_path(ROOT / source)

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    summary = acceptance["interface_summary"]
    usb_context = integration["usb_c_port_context"]
    side_context = integration["side_key_context"]
    if summary["usb_c_port_count"] != usb_context["port_count"]:
        raise SystemExit("USB/side-key acceptance port count stale")
    if summary["usb_c_port_count"] != usb_binding["port_count"]:
        raise SystemExit("USB/side-key acceptance port count diverges from package")
    if summary["usb_c_region_mm"] != placements["J_USB_C"]["region_mm"]:
        raise SystemExit("USB/side-key acceptance USB-C region stale")
    if summary["usb_c_region_mm"] != usb_context["active_matrix_region_mm"]:
        raise SystemExit("USB/side-key acceptance USB-C integration region stale")
    if summary["side_buttons"] != side_context["manifest_side_buttons"]:
        raise SystemExit("USB/side-key acceptance side-button list stale")
    if summary["side_buttons"] != list(side_buttons["logical_buttons"]):
        raise SystemExit("USB/side-key acceptance side-button package list stale")
    if summary["side_key_connector_region_mm"] != placements["SW_POWER_VOL"]["region_mm"]:
        raise SystemExit("USB/side-key acceptance side-key connector region stale")
    if summary["side_key_actuator_spine_region_mm"] != side_buttons["mechanical_target"]["board_region_mm"]:
        raise SystemExit("USB/side-key acceptance actuator spine region stale")
    if summary["side_key_required_nets"] != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"]["required_nets"]:
        raise SystemExit("USB/side-key acceptance side-key required nets stale")
    if (
        summary["side_key_recommended_min_contacts"]
        != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"][
            "recommended_min_contacts"
        ]
    ):
        raise SystemExit("USB/side-key acceptance side-key contact budget stale")
    if summary["pd_controller"] != integration["usb_pd_and_charger_context"]["pd_controller"]["part"]:
        raise SystemExit("USB/side-key acceptance PD controller stale")
    if summary["charger"] != integration["usb_pd_and_charger_context"]["charger"]["part"]:
        raise SystemExit("USB/side-key acceptance charger stale")
    if usb_context["selected_evt0_connector"]["family"] != usb_binding["connector_strategy"]["evt0_low_risk"]["family"]:
        raise SystemExit("USB/side-key acceptance EVT0 connector family stale")

    for _, draft_path in acceptance["supplier_draft_links"].items():
        require_path(ROOT / draft_path)
    expected_items = {
        "usb_c_connector_shell_load_path",
        "usb_c_cutout_and_plug_keepout",
        "usb2_cc_vbus_route_and_esd",
        "pd_attach_and_charger_safety",
        "side_key_force_travel_and_solder_load",
        "side_key_recovery_and_wake",
    }
    items = {item["id"]: item for item in acceptance["acceptance_items"]}
    if set(items) != expected_items:
        raise SystemExit("USB/side-key acceptance item set diverges")
    for item_id, item in items.items():
        if item["status"] != "blocked_missing_routed_supplier_or_measured_evidence":
            raise SystemExit(f"USB/side-key acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"USB/side-key acceptance item too weak: {item_id}")

    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB/side-key acceptance cross-check failed: {key}")
    for blocker in [
        "USB-C and side-button supplier drawings, pinouts, land patterns, and STEP files missing",
        "routed PCB, DRC/ERC, SI/PI, VBUS/CC/USB2 validation, and PD logs missing",
        "button force/travel, wake/recovery, and enclosure load-path evidence missing",
    ]:
        if blocker not in acceptance["release_blockers"]:
            raise SystemExit(f"USB/side-key acceptance missing blocker: {blocker}")
    for claim in [
        "usb_c_ready",
        "charging_ready",
        "side_buttons_ready",
        "power_key_wake_ready",
        "recovery_key_combo_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in acceptance["forbidden_claims"]:
            raise SystemExit(f"USB/side-key acceptance missing forbidden claim {claim}")
    print(
        "USB/side-key acceptance ok: "
        f"{len(items)} acceptance items blocked, port_count={summary['usb_c_port_count']}"
    )


def check_radio_antenna_acceptance() -> None:
    acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
    )
    radio = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-integration.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")

    if acceptance["schema"] != "eliza.e1_phone_radio_antenna_acceptance_checklist.v1":
        raise SystemExit("radio antenna acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_radio_antenna_acceptance_requires_supplier_route_firmware_regulatory_and_measurements"
    ):
        raise SystemExit(f"unexpected radio antenna acceptance status: {acceptance['status']}")
    for source in [
        "board/kicad/e1-phone/radio-module-integration.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml",
        "package/cellular/quectel-5g-redcap.yaml",
        "package/wifi/murata-type-2ea-wifi6e.yaml",
    ]:
        if source not in acceptance["source_artifacts"]:
            raise SystemExit(f"radio antenna acceptance missing source {source}")
        require_path(ROOT / source)

    summary = acceptance["interface_summary"]
    if summary["cellular_module_family"] != cellular["primary_first_phone"]["family"]:
        raise SystemExit("radio antenna acceptance cellular family stale")
    if summary["cellular_vendor"] != cellular["primary_first_phone"]["vendor"]:
        raise SystemExit("radio antenna acceptance cellular vendor stale")
    if summary["cellular_package_status"] != cellular["status"]:
        raise SystemExit("radio antenna acceptance cellular package status stale")
    if summary["wifi_bluetooth_order_number"] != wifi_bt["vendor_public_specs"]["order_number"]:
        raise SystemExit("radio antenna acceptance Wi-Fi/Bluetooth order number stale")
    if summary["wifi_bluetooth_chipset"] != wifi_bt["vendor_public_specs"]["chipset"]:
        raise SystemExit("radio antenna acceptance Wi-Fi/Bluetooth chipset stale")
    if summary["wifi_bluetooth_package_status"] != wifi_bt["status"]:
        raise SystemExit("radio antenna acceptance Wi-Fi/Bluetooth package status stale")
    if summary["required_rf_nets"] != rf["required_rf_nets"]:
        raise SystemExit("radio antenna acceptance required RF nets stale")
    if summary["antenna_feed_count"] != len(rf["antenna_feed_assignments"]):
        raise SystemExit("radio antenna acceptance antenna feed count stale")
    if summary["route_release_status"] != radio["status"]:
        raise SystemExit("radio antenna acceptance route release status stale")
    if summary["rf_connectivity_status"] != rf["status"]:
        raise SystemExit("radio antenna acceptance RF connectivity status stale")
    for _, draft_path in acceptance["supplier_draft_links"].items():
        require_path(ROOT / draft_path)

    expected_items = {
        "cellular_region_sku_band_matrix",
        "cellular_antenna_main_div_gnss_feeds",
        "wifi6e_bt_2x2_antenna_feeds",
        "rf_matching_conducted_access_and_vna",
        "coexistence_gnss_desense_and_usb_charging_states",
        "firmware_driver_nvram_clm_and_country_code",
        "regulatory_carrier_ptcrb_gcf_sar_prescan",
        "factory_rf_calibration_and_first_article_limits",
    }
    items = {item["id"]: item for item in acceptance["acceptance_items"]}
    if set(items) != expected_items:
        raise SystemExit("radio antenna acceptance item set diverges")
    for item_id, item in items.items():
        if item["status"] != "blocked_missing_supplier_route_firmware_regulatory_or_measurement_evidence":
            raise SystemExit(f"radio antenna acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"radio antenna acceptance item too weak: {item_id}")
    if len(rf["coexistence_test_matrix"]) < 4:
        raise SystemExit("radio antenna acceptance RF coexistence matrix too weak")
    if len(rf["required_measurements_before_release"]) < 6:
        raise SystemExit("radio antenna acceptance measurement release list too weak")
    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"radio antenna acceptance cross-check failed: {key}")
    for blocker in [
        "Cellular and Wi-Fi/Bluetooth supplier reference layouts, firmware packs, and authorization artifacts missing",
        "Antenna feeds, matching networks, conducted access, and routed-board RF measurements missing",
        "Coexistence, GNSS desense, regulatory, carrier, SAR, and factory RF evidence missing",
    ]:
        if blocker not in acceptance["release_blockers"]:
            raise SystemExit(f"radio antenna acceptance missing blocker: {blocker}")
    for claim in [
        "cellular_ready",
        "wifi_ready",
        "bluetooth_ready",
        "gnss_ready",
        "rf_ready",
        "carrier_ready",
        "sar_ready",
        "regulatory_ready",
        "factory_rf_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in acceptance["forbidden_claims"]:
            raise SystemExit(f"radio antenna acceptance missing forbidden claim {claim}")
    print(
        "radio antenna acceptance ok: "
        f"{len(items)} acceptance items blocked, {summary['antenna_feed_count']} RF feeds"
    )


def check_module_host_integration_acceptance() -> None:
    acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml"
    )
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    bom = load_yaml(ROOT / "board/kicad/e1-phone/preliminary-bom.yaml")
    procurement = load_yaml(ROOT / "board/kicad/e1-phone/procurement-readiness.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    radio = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-integration.yaml")
    radio_antenna = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
    )
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")

    if acceptance["schema"] != "eliza.e1_phone_module_host_integration_acceptance_checklist.v1":
        raise SystemExit("module host integration acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_module_host_integration_requires_supplier_pinouts_routed_host_buses_firmware_identity_and_factory_evidence"
    ):
        raise SystemExit(
            f"unexpected module host integration acceptance status: {acceptance['status']}"
        )
    for source in [
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "board/kicad/e1-phone/preliminary-bom.yaml",
        "board/kicad/e1-phone/procurement-readiness.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/radio-module-integration.yaml",
        "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "package/cellular/quectel-5g-redcap.yaml",
        "package/wifi/murata-type-2ea-wifi6e.yaml",
    ]:
        if source not in acceptance["source_artifacts"]:
            raise SystemExit(f"module host integration acceptance missing source {source}")
        require_path(ROOT / source)

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    bom_items = {item["function"]: item for item in bom["major_items"]}
    procurement_items = {item["function"]: item for item in procurement["line_items"]}
    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    pair_names = {item["name"] for item in routing["differential_pairs"]}
    factory_domains = {item["id"]: item for item in factory_probe["probe_domains"]}

    summary = acceptance["module_host_summary"]
    if summary["cellular_primary"] != procurement_items["cellular"]["selected_primary"]:
        raise SystemExit("module host integration cellular primary stale")
    if summary["wifi_bluetooth_primary"] != procurement_items["wifi_bluetooth"]["selected_primary"]:
        raise SystemExit("module host integration Wi-Fi/Bluetooth primary stale")
    if summary["cellular_package_status"] != cellular["status"]:
        raise SystemExit("module host integration cellular package status stale")
    if summary["wifi_bluetooth_package_status"] != wifi_bt["status"]:
        raise SystemExit("module host integration Wi-Fi/Bluetooth package status stale")
    if summary["radio_module_status"] != radio["status"]:
        raise SystemExit("module host integration radio status stale")
    if summary["radio_antenna_acceptance_status"] != radio_antenna["status"]:
        raise SystemExit("module host integration radio acceptance status stale")
    if summary["procurement_status"] != procurement["status"]:
        raise SystemExit("module host integration procurement status stale")
    if (
        summary["cellular_procurement_status"]
        != procurement_items["cellular"]["procurement_status"]
    ):
        raise SystemExit("module host integration cellular procurement status stale")
    if (
        summary["wifi_bluetooth_procurement_status"]
        != procurement_items["wifi_bluetooth"]["procurement_status"]
    ):
        raise SystemExit("module host integration Wi-Fi/Bluetooth procurement status stale")
    if summary["soc_region_mm"] != placements["U_SOC_LPDDR_UFS"]["region_mm"]:
        raise SystemExit("module host integration SoC placement stale")
    if summary["cellular_region_mm"] != placements["U_CELL"]["region_mm"]:
        raise SystemExit("module host integration cellular placement stale")
    if summary["wifi_bluetooth_region_mm"] != placements["U_WIFI_BT"]["region_mm"]:
        raise SystemExit("module host integration Wi-Fi/Bluetooth placement stale")
    if summary["cellular_host_interfaces"] != cellular["host_interfaces"]["cellular_module"]["required"]:
        raise SystemExit("module host integration cellular host interfaces stale")
    if summary["wifi_host_preferred_bus"] != wifi_bt["host_interfaces"]["wifi_primary"]["preferred_bus"]:
        raise SystemExit("module host integration Wi-Fi preferred bus stale")
    if summary["wifi_host_fallback_bus"] != wifi_bt["host_interfaces"]["wifi_primary"]["fallback_bus"]:
        raise SystemExit("module host integration Wi-Fi fallback bus stale")
    if summary["bluetooth_preferred_bus"] != wifi_bt["host_interfaces"]["bluetooth"]["preferred_bus"]:
        raise SystemExit("module host integration Bluetooth bus stale")
    if sorted(summary["host_wireless_shared_nets"]) != sorted(set(summary["host_wireless_shared_nets"])):
        raise SystemExit("module host integration host-wireless nets contain duplicates")
    missing_host_nets = sorted(net for net in summary["host_wireless_shared_nets"] if net not in block_nets)
    if missing_host_nets:
        raise SystemExit(f"module host integration host-wireless nets missing: {missing_host_nets}")
    for pair in summary["routing_pair_names_required"]:
        if pair not in pair_names:
            raise SystemExit(f"module host integration routing pair missing: {pair}")
    if set(summary["factory_probe_domains_covering_modules"]) - set(factory_domains):
        raise SystemExit("module host integration factory probe domains stale")
    if summary["factory_traceability_fields"] != factory_probe["fixture_policy"]["operator_visible_traceability_required"]:
        raise SystemExit("module host integration factory traceability stale")
    for function in ["cellular", "wifi_bluetooth"]:
        if function not in bom_items or function not in procurement_items:
            raise SystemExit(f"module host integration missing BOM/procurement function {function}")

    expected_items = {
        "application_processor_package_memory_storage_freeze",
        "cellular_module_host_bus_sim_esim_and_identity",
        "wifi_bluetooth_host_bus_firmware_and_mac_identity",
        "host_bus_routing_si_and_power_states",
        "module_firmware_driver_linux_android_bringup",
        "factory_provisioning_secure_identity_and_test_modes",
    }
    items = {item["id"]: item for item in acceptance["acceptance_items"]}
    if set(items) != expected_items:
        raise SystemExit("module host integration acceptance item set diverges")
    for item_id, item in items.items():
        if item["status"] != "blocked_missing_host_module_pinout_route_firmware_identity_or_factory_evidence":
            raise SystemExit(f"module host integration acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"module host integration acceptance item too weak: {item_id}")
    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"module host integration cross-check failed: {key}")
    for blocker in [
        "production AP, LPDDR, and UFS package data has not replaced the scaffold binding",
        "cellular and Wi-Fi/Bluetooth supplier pinouts, land patterns, reference layouts, STEP models, firmware packs, and licenses are missing",
        "host buses, RF feeds, SIM/eSIM, power states, and factory identity paths are not routed or measured",
        "Linux/Android module bring-up logs, regulatory provisioning, RF calibration, and first-article provisioning evidence are missing",
    ]:
        if blocker not in acceptance["release_blockers"]:
            raise SystemExit(f"module host integration missing blocker: {blocker}")
    for claim in [
        "module_host_ready",
        "application_processor_ready",
        "cellular_ready",
        "wifi_ready",
        "bluetooth_ready",
        "firmware_ready",
        "identity_provisioning_ready",
        "factory_test_ready",
        "routed_pcb_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in acceptance["forbidden_claims"]:
            raise SystemExit(f"module host integration missing forbidden claim {claim}")
    print(
        "module host integration acceptance ok: "
        f"{len(items)} acceptance items blocked, {len(summary['host_wireless_shared_nets'])} host nets"
    )


def check_pinout_footprint_freeze() -> None:
    freeze = load_yaml(ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml")
    if freeze["status"] != "blocked_pinout_footprint_freeze_missing_supplier_evidence":
        raise SystemExit(f"unexpected pinout/footprint freeze status: {freeze['status']}")
    records = {item["name"]: item for item in freeze["freeze_records"]}
    required = {
        "display_touch_fpc",
        "rear_camera_fpc",
        "front_camera_fpc",
        "usb_c_receptacle",
        "side_power_volume_controls",
        "cellular_module",
        "battery_pack_connector",
        "wifi_bluetooth_module",
        "audio_speaker_microphone_flexes",
        "top_bottom_interconnect_pair",
    }
    missing = sorted(required - set(records))
    if missing:
        raise SystemExit(f"pinout/footprint freeze missing records: {missing}")
    cross_checks = freeze["cross_checks"]
    if cross_checks["missing_package_bindings"]:
        raise SystemExit(
            f"pinout/footprint freeze missing package bindings: {cross_checks['missing_package_bindings']}"
        )
    if cross_checks["missing_required_nets"]:
        raise SystemExit(
            f"pinout/footprint freeze required nets missing from block netlist: {cross_checks['missing_required_nets']}"
        )
    for name, record in records.items():
        if record["status"] != "blocked_waiting_supplier_pinout_footprint_mechanical_data":
            raise SystemExit(f"pinout/footprint record {name} unexpectedly not blocked")
        if record["missing_contract_nets"]:
            raise SystemExit(f"pinout/footprint record {name} has missing nets")
        if len(record["supplier_evidence_required"]) < 5:
            raise SystemExit(f"pinout/footprint record {name} has weak supplier evidence")
        if not record["mechanical_datums_required"]:
            raise SystemExit(f"pinout/footprint record {name} missing mechanical datums")
    for claim in [
        "pinout_frozen",
        "footprints_frozen",
        "routed_pcb_ready",
        "enclosure_ready",
        "fabrication_ready",
    ]:
        if claim not in freeze["forbidden_claims"]:
            raise SystemExit(f"pinout/footprint freeze missing forbidden claim {claim}")
    print(f"pinout/footprint freeze ok: {len(records)} blocked supplier records cross-checked")


def check_supplier_drawing_intake() -> None:
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml")
    supplier_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    rfq = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    rfq_drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    freeze = load_yaml(ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml")
    display_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml"
    )
    usb_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml"
    )
    module_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml"
    )
    radio_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
    )
    power_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml"
    )
    if intake["schema"] != "eliza.e1_phone_supplier_drawing_intake_checklist.v1":
        raise SystemExit(f"unexpected supplier drawing intake schema: {intake['schema']}")
    if intake["status"] != "blocked_supplier_drawing_intake_required_before_real_footprints_or_route":
        raise SystemExit(f"unexpected supplier drawing intake status: {intake['status']}")
    for rel in intake["source_artifacts"]:
        require_path(ROOT / rel)
    expected_upstream = {
        "rfq_status": rfq["status"],
        "rfq_drafts_status": rfq_drafts["status"],
        "supplier_to_kicad_status": supplier_map["status"],
        "pinout_freeze_status": freeze["status"],
        "display_camera_acceptance_status": display_acceptance["status"],
        "usb_sidekey_acceptance_status": usb_acceptance["status"],
        "module_host_acceptance_status": module_acceptance["status"],
        "radio_antenna_acceptance_status": radio_acceptance["status"],
        "power_bringup_acceptance_status": power_acceptance["status"],
    }
    if intake["upstream_status"] != expected_upstream:
        raise SystemExit("supplier drawing intake upstream status snapshot is stale")
    policy = intake["intake_policy"]
    if not policy["sample_receipt_required_before_pinout_freeze"]:
        raise SystemExit("supplier drawing intake must require samples before pinout freeze")
    if policy["minimum_sample_lot_per_candidate"] < 5:
        raise SystemExit("supplier drawing intake sample lot is too small")
    required_core_paths = {
        "rfq_response_pack",
        "signed_2d_drawing",
        "pinout_or_pad_map",
        "recommended_land_pattern",
        "step_or_brep_model",
        "sample_inspection",
        "compliance_pack",
        "pinout_review_signoff",
        "symbol_review",
        "footprint_review",
        "footprint_3d_binding",
    }
    if set(policy["all_core_paths_required_before_real_footprint"]) != required_core_paths:
        raise SystemExit("supplier drawing intake core evidence key set changed")
    records = {item["function"]: item for item in intake["intake_records"]}
    evidence_records = {item["function"]: item for item in supplier_map["evidence_records"]}
    if set(records) != set(evidence_records):
        raise SystemExit("supplier drawing intake functions diverge from supplier-to-KiCad map")
    if len(records) != 10:
        raise SystemExit(f"supplier drawing intake expected 10 records, got {len(records)}")
    expected_hard_blockers = {
        "display_touch",
        "rear_camera",
        "front_camera",
        "cellular",
        "wifi_bluetooth",
        "usb_c_receptacle_evt0",
        "battery_pack",
        "top_bottom_interconnect",
    }
    if set(intake["hard_blocker_functions"]) != expected_hard_blockers:
        raise SystemExit("supplier drawing intake hard-blocker set changed")
    for function, record in records.items():
        evidence = evidence_records[function]
        if record["status"] != "blocked_waiting_supplier_response_pack_and_reviews":
            raise SystemExit(f"supplier drawing intake record {function} unexpectedly not blocked")
        if record["missing_required_evidence_keys"]:
            raise SystemExit(f"supplier drawing intake record {function} has missing evidence keys")
        if set(record["gate_state"]) != required_core_paths:
            raise SystemExit(f"supplier drawing intake record {function} gate keys changed")
        if any(record["gate_state"].values()):
            raise SystemExit(f"supplier drawing intake record {function} has open supplier gates")
        if set(record["production_evidence_paths"]) != set(evidence["required_production_evidence"]):
            raise SystemExit(f"supplier drawing intake record {function} production evidence keys diverge")
        if record["production_evidence_paths"] != evidence["required_production_evidence"]:
            raise SystemExit(f"supplier drawing intake record {function} evidence paths diverge")
        if record["draft_path"] != evidence["rfq_transmittal_draft"]["planned_draft_path"]:
            raise SystemExit(f"supplier drawing intake record {function} draft path diverges")
        require_path(ROOT / record["draft_path"])
        for key in ["primary_candidate", "package_binding", "freeze_record"]:
            if record[key] != evidence[key]:
                raise SystemExit(f"supplier drawing intake record {function} {key} diverges")
        if record["supplier_artifacts_requested"] != evidence["required_supplier_inputs"]:
            raise SystemExit(f"supplier drawing intake record {function} requested inputs diverge")
        if not record["mechanical_datums_required"]:
            raise SystemExit(f"supplier drawing intake record {function} missing mechanical datums")
        if not record["planned_contract_nets"]:
            raise SystemExit(f"supplier drawing intake record {function} missing planned nets")
        if not record["review_packages_required"]:
            raise SystemExit(f"supplier drawing intake record {function} missing review packages")
        if "missing" not in record["current_blocker"]:
            raise SystemExit(f"supplier drawing intake record {function} weak blocker text")
    for name, value in intake["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"supplier drawing intake cross-check failed: {name}")
    for claim in [
        "supplier_drawings_intake_complete",
        "pinouts_ready_for_symbol_capture",
        "footprints_ready_for_layout",
        "routed_pcb_ready",
        "enclosure_ready",
        "fabrication_ready",
    ]:
        if claim not in intake["forbidden_claims"]:
            raise SystemExit(f"supplier drawing intake missing forbidden claim {claim}")
    print(f"supplier drawing intake ok: {len(records)} fail-closed supplier records")


def check_evt1_footprint_capture_work_package() -> None:
    work = load_yaml(ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml")
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml")
    freeze = load_yaml(ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml")
    symbol_footprint = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    )
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    if work["schema"] != "eliza.e1_phone_evt1_footprint_capture_work_package.v1":
        raise SystemExit(f"unexpected EVT1 footprint capture schema: {work['schema']}")
    if work["status"] != "blocked_evt1_footprint_capture_requires_supplier_intake_reviews_and_real_kicad_libraries":
        raise SystemExit(f"unexpected EVT1 footprint capture status: {work['status']}")
    for rel in work["source_artifacts"]:
        require_path(ROOT / rel)
    expected_upstream = {
        "supplier_intake_status": intake["status"],
        "pinout_freeze_status": freeze["status"],
        "symbol_footprint_status": symbol_footprint["status"],
    }
    if work["upstream_status"] != expected_upstream:
        raise SystemExit("EVT1 footprint capture upstream status snapshot is stale")
    intake_records = {item["function"]: item for item in intake["intake_records"]}
    work_items = {item["function"]: item for item in work["work_items"]}
    if set(work_items) != set(intake_records):
        raise SystemExit("EVT1 footprint capture functions diverge from supplier intake")
    policy = work["capture_policy"]
    if policy["work_item_count"] != len(work_items):
        raise SystemExit("EVT1 footprint capture work item count diverges from policy")
    if policy["diff_pair_count_to_preserve"] != len(routing["differential_pairs"]):
        raise SystemExit("EVT1 footprint capture differential pair count is stale")
    for key in [
        "requires_supplier_gate_closed_before_editing_production_footprints",
        "requires_pinout_symbol_footprint_3d_reviews",
        "requires_erc_and_drc_after_placeholder_replacement",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"EVT1 footprint capture policy must require {key}")
    placements = {item["refdes_group"]: item["region_mm"] for item in placement["placements"]}
    expected_review_keys = {
        "pinout_review": "pinout_review_signoff",
        "symbol_review": "symbol_review",
        "footprint_review": "footprint_review",
        "footprint_3d_binding": "footprint_3d_binding",
    }
    for function, item in work_items.items():
        intake_record = intake_records[function]
        if item["status"] != "blocked_waiting_supplier_intake_and_review":
            raise SystemExit(f"EVT1 footprint capture item {function} unexpectedly not blocked")
        for key in ["criticality", "primary_candidate", "package_binding"]:
            if item[key] != intake_record[key]:
                raise SystemExit(f"EVT1 footprint capture item {function} {key} diverges")
        if item["planned_contract_nets"] != intake_record["planned_contract_nets"]:
            raise SystemExit(f"EVT1 footprint capture item {function} nets diverge from intake")
        if item["mechanical_datums_required"] != intake_record["mechanical_datums_required"]:
            raise SystemExit(f"EVT1 footprint capture item {function} datums diverge from intake")
        if item["supplier_gate_inputs_required"] != intake_record["gate_state"]:
            raise SystemExit(f"EVT1 footprint capture item {function} supplier gates diverge")
        if any(item["supplier_gate_inputs_required"].values()):
            raise SystemExit(f"EVT1 footprint capture item {function} has open supplier gates")
        refdes_group = item["refdes_group"]
        if isinstance(refdes_group, list):
            expected_region = {refdes: placements[refdes] for refdes in refdes_group}
        else:
            expected_region = placements[refdes_group]
        if item["placement_region_mm"] != expected_region:
            raise SystemExit(f"EVT1 footprint capture item {function} placement region diverges")
        for task_key in [
            "symbol_tasks",
            "footprint_tasks",
            "layout_rule_tasks",
            "domain_required_kicad_outputs",
        ]:
            if not item[task_key]:
                raise SystemExit(f"EVT1 footprint capture item {function} missing {task_key}")
        expected_review_outputs = {
            review_key: intake_record["production_evidence_paths"][evidence_key]
            for review_key, evidence_key in expected_review_keys.items()
        }
        if item["review_outputs"] != expected_review_outputs:
            raise SystemExit(f"EVT1 footprint capture item {function} review outputs diverge")
        if "placeholder footprints" not in item["current_blocker"]:
            raise SystemExit(f"EVT1 footprint capture item {function} weak blocker text")
    for name, value in work["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"EVT1 footprint capture cross-check failed: {name}")
    for claim in [
        "evt1_footprint_capture_complete",
        "symbols_ready",
        "footprints_ready",
        "step_models_bound",
        "routed_pcb_ready",
        "enclosure_ready",
        "fabrication_ready",
    ]:
        if claim not in work["forbidden_claims"]:
            raise SystemExit(f"EVT1 footprint capture missing forbidden claim {claim}")
    print(f"EVT1 footprint capture ok: {len(work_items)} blocked KiCad capture work items")


def check_schematic_netclass_execution_package() -> None:
    execution = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml"
    )
    block_netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    symbol_footprint = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    )
    supplier_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml")
    footprint_work = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if execution["schema"] != "eliza.e1_phone_schematic_netclass_execution_package.v1":
        raise SystemExit("schematic netclass execution schema diverges")
    if execution["status"] != "blocked_requires_supplier_symbols_netclass_capture_erc_and_trial_route":
        raise SystemExit(f"unexpected schematic netclass execution status: {execution['status']}")
    rel = "board/kicad/e1-phone/schematic-netclass-execution-package.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing schematic netclass execution artifact")
    for source in execution["source_artifacts"]:
        require_path(ROOT / source)
    expected_upstream = {
        "symbol_footprint_status": symbol_footprint["status"],
        "supplier_to_kicad_status": supplier_map["status"],
        "supplier_intake_status": intake["status"],
        "evt1_footprint_capture_status": footprint_work["status"],
        "block_netlist_status": block_netlist["status"],
        "routing_constraints_status": routing["status"],
    }
    if execution["upstream_status"] != expected_upstream:
        raise SystemExit("schematic netclass execution upstream status snapshot is stale")

    policy = execution["execution_policy"]
    domains = {item["domain"]: item for item in execution["domain_execution"]}
    expected_domains = {
        "display_touch",
        "front_rear_cameras",
        "usb_c_charge_data_debug",
        "side_buttons",
        "power_battery_pmic_thermal",
        "radios_cellular_wifi_bt_gnss",
        "audio_haptics",
        "split_interconnect",
        "compute_storage",
        "factory_test",
    }
    if set(domains) != expected_domains:
        raise SystemExit("schematic netclass execution domain set diverges")
    if policy["domain_count"] != len(domains):
        raise SystemExit("schematic netclass execution domain count diverges")
    for key in [
        "requires_real_hierarchical_symbols_before_route",
        "requires_kicad_netclass_assignment_before_trial_route",
        "requires_erc_report_before_routed_release",
        "requires_supplier_footprint_escape_proof_before_route_acceptance",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"schematic netclass execution policy must require {key}")

    routing_diff_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    if sorted(policy["diff_pair_names_to_capture"]) != sorted(routing_diff_pairs):
        raise SystemExit("schematic netclass execution diff-pair capture set diverges")
    routing_buses = {item["name"]: item for item in routing["single_ended_buses"]}
    routing_test_points = set(routing["power_integrity"]["test_points_required"])
    placements = {item["refdes_group"]: item for item in placement["placements"]}
    block_ids = {item["id"] for item in block_netlist["blocks"]}

    def collect_nets(value):
        if isinstance(value, str):
            return {value}
        if isinstance(value, list):
            nets = set()
            for item in value:
                nets.update(collect_nets(item))
            return nets
        if isinstance(value, dict):
            nets = set()
            for item in value.values():
                nets.update(collect_nets(item))
            return nets
        return set()

    known_nets = collect_nets(block_netlist["voltage_domains"])
    known_nets.update(collect_nets(block_netlist["blocks"]))
    known_nets.update(collect_nets(block_netlist["required_shared_nets"]))
    known_nets.update(collect_nets(placement["placements"]))
    known_nets.update(collect_nets(routing["differential_pairs"]))
    known_nets.update(collect_nets(routing["single_ended_buses"]))
    known_nets.update(routing_test_points)
    footprint_ids = {item["id"] for item in footprint_work["work_items"]}
    required_tasks = {
        "replace text scaffold with real hierarchical symbols and wires",
        "assign exact supplier pin numbers and electrical types",
        "bind nets to KiCad net classes and differential-pair rules from routing-constraints.yaml",
        "cross-probe schematic nets against placement-interface-matrix.yaml and block-netlist.yaml",
        "run ERC and record signed waivers or clean report",
        "run supplier-footprint escape/trial-route proof before accepting routing",
    }
    expected_output_keys = {
        "schematic_review",
        "netclass_assignment",
        "erc_result",
        "trial_route_proof",
    }

    for domain, item in domains.items():
        if item["status"] != "blocked_waiting_symbol_netclass_erc_and_trial_route_evidence":
            raise SystemExit(f"schematic netclass domain unexpectedly open: {domain}")
        if not item["schematic_sheets"]:
            raise SystemExit(f"schematic netclass domain missing sheets: {domain}")
        for sheet in item["schematic_sheets"]:
            require_path(ROOT / "board/kicad/e1-phone/schematic" / sheet)
        if not set(item["refdes_groups"]).intersection(block_ids | set(placements)):
            raise SystemExit(f"schematic netclass domain has no known refdes groups: {domain}")
        for record in item["placement_records"]:
            refdes = record["refdes_group"]
            if refdes not in placements:
                raise SystemExit(f"schematic netclass placement refdes unknown: {refdes}")
            matrix_record = placements[refdes]
            for key in ["region_mm", "side", "constraints"]:
                if record[key] != matrix_record[key]:
                    raise SystemExit(f"schematic netclass placement diverges: {domain} {refdes} {key}")
        missing_nets = sorted(set(item["required_nets"]) - known_nets)
        if missing_nets:
            raise SystemExit(f"schematic netclass domain {domain} has unknown nets: {missing_nets}")
        assignments = item["netclass_assignments_required"]
        for pair in assignments["differential_pairs"]:
            name = pair["name"]
            if name not in routing_diff_pairs:
                raise SystemExit(f"schematic netclass unknown differential pair {name}")
            route_pair = routing_diff_pairs[name]
            for key in ["nets", "class", "max_length_mm", "intra_pair_skew_mm_max"]:
                if pair[key] != route_pair[key]:
                    raise SystemExit(f"schematic netclass differential pair diverges: {name} {key}")
        for bus in assignments["single_ended_buses"]:
            name = bus["name"]
            if name not in routing_buses:
                raise SystemExit(f"schematic netclass unknown single-ended bus {name}")
            for key, value in bus.items():
                if routing_buses[name].get(key) != value:
                    raise SystemExit(f"schematic netclass single-ended bus diverges: {name} {key}")
        if not set(assignments["power_test_points"]).issubset(routing_test_points):
            raise SystemExit(f"schematic netclass unknown power test point in domain {domain}")
        unknown_work_items = sorted(set(item["upstream_footprint_work_items"]) - footprint_ids)
        if unknown_work_items:
            raise SystemExit(
                f"schematic netclass domain {domain} references unknown footprint work items: "
                f"{unknown_work_items}"
            )
        if set(item["execution_tasks"]) != required_tasks:
            raise SystemExit(f"schematic netclass domain task list diverges: {domain}")
        outputs = item["release_outputs_required"]
        if set(outputs) != expected_output_keys:
            raise SystemExit(f"schematic netclass release output keys diverge: {domain}")
        for key, path in outputs.items():
            expected_suffix = {
                "schematic_review": f"schematic-review/{domain}.yaml",
                "netclass_assignment": f"netclass-assignment/{domain}.yaml",
                "erc_result": f"erc/{domain}.json",
                "trial_route_proof": f"trial-route/{domain}.yaml",
            }[key]
            if not path.endswith(expected_suffix):
                raise SystemExit(f"schematic netclass output path diverges: {domain} {key}")
            if not path.startswith("board/kicad/e1-phone/production/reports/"):
                raise SystemExit(f"schematic netclass output path not under production reports: {path}")
        if "scaffold-level" not in item["current_blocker"] or "ERC" not in item["current_blocker"]:
            raise SystemExit(f"schematic netclass domain has weak blocker text: {domain}")

    captured_pairs = {
        pair["name"]
        for item in domains.values()
        for pair in item["netclass_assignments_required"]["differential_pairs"]
    }
    if captured_pairs != set(routing_diff_pairs):
        raise SystemExit("schematic netclass domain assignments do not cover all diff pairs")
    for name, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"schematic netclass execution cross-check failed: {name}")
    for blocker in [
        "real KiCad symbols and wires have not replaced the schematic text scaffold",
        "supplier pinouts and land patterns are not accepted for production capture",
        "KiCad net classes and differential-pair assignments have not been implemented",
        "ERC reports and signed waivers are missing",
        "supplier-footprint escape and trial-route evidence is missing for all domains",
    ]:
        if blocker not in execution["release_blockers"]:
            raise SystemExit(f"schematic netclass execution missing blocker: {blocker}")
    for claim in [
        "schematic_ready",
        "netclasses_ready",
        "erc_clean",
        "trial_route_ready",
        "routed_pcb_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(f"schematic netclass execution missing forbidden claim {claim}")
    print(
        "schematic netclass execution ok: "
        f"{len(domains)} domains, {len(captured_pairs)} diff pairs fail-closed"
    )


def check_route_corridor_execution_package() -> None:
    corridors = load_yaml(ROOT / "board/kicad/e1-phone/route-corridor-execution-package.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    schematic_netclass = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml"
    )
    feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    manifest = load_yaml(MANIFEST)

    if corridors["schema"] != "eliza.e1_phone_route_corridor_execution_package.v1":
        raise SystemExit("route corridor execution schema diverges")
    if corridors["status"] != "blocked_requires_supplier_footprints_escape_route_and_drc":
        raise SystemExit(f"unexpected route corridor execution status: {corridors['status']}")
    rel = "board/kicad/e1-phone/route-corridor-execution-package.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing route corridor execution artifact")
    for source in corridors["source_artifacts"]:
        require_path(ROOT / source)

    upstream = corridors["upstream_state"]
    counts = pcb_audit["live_pcb_counts"]
    expected_upstream = {
        "pcb_audit_status": pcb_audit["status"],
        "declared_net_count": counts["declared_net_count"],
        "explicitly_classed_net_count": counts["explicitly_classed_net_count"],
        "segment_count": counts["segment_count"],
        "copper_zone_count": counts["zone_count"],
        "keepout_zone_count": counts["keepout_zone_count"],
        "schematic_netclass_status": schematic_netclass["status"],
        "route_feasibility_status": feasibility["status"],
    }
    if upstream != expected_upstream:
        raise SystemExit("route corridor upstream state snapshot is stale")

    diff_corridors = {
        item["constraint_pair"]: item for item in corridors["differential_pair_corridors"]
    }
    rf_corridors = {item["net"]: item for item in corridors["rf_feed_corridors"]}
    power_corridors = {
        item["constraint"]: item for item in corridors["high_current_power_corridors"]
    }
    routing_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    rf_required = {
        item["net"]: item for item in routing["rf_layout"]["matching_networks_required"]
    }
    power_required = {
        item["name"]: item for item in routing["power_integrity"]["high_current_paths"]
    }
    summary = corridors["corridor_summary"]
    if summary["differential_pair_corridor_count"] != len(diff_corridors):
        raise SystemExit("route corridor differential pair count stale")
    if summary["rf_feed_corridor_count"] != len(rf_corridors):
        raise SystemExit("route corridor RF feed count stale")
    if summary["high_current_power_corridor_count"] != len(power_corridors):
        raise SystemExit("route corridor power corridor count stale")
    if summary["total_corridor_count"] != len(diff_corridors) + len(rf_corridors) + len(power_corridors):
        raise SystemExit("route corridor total count stale")
    if summary["keepout_zone_count_used"] != counts["keepout_zone_count"]:
        raise SystemExit("route corridor keepout count diverges from live PCB audit")
    if summary["all_corridors_blocked"] is not True:
        raise SystemExit("route corridor summary must remain blocked")
    if set(diff_corridors) != set(routing_pairs):
        raise SystemExit("route corridor differential pair set diverges from routing constraints")
    if set(rf_corridors) != set(rf_required):
        raise SystemExit("route corridor RF feed set diverges from routing constraints")
    if set(power_corridors) != set(power_required):
        raise SystemExit("route corridor high-current path set diverges from routing constraints")

    placement_records = {item["refdes_group"]: item["region_mm"] for item in placement["placements"]}
    keepouts = set(routing["mechanical_keepouts"])
    keepouts.update(item["name"] for item in routing["rf_layout"]["antenna_keepouts"])

    def center(region: dict) -> dict:
        return {
            "x": round(region["x"] + region["width"] / 2, 3),
            "y": round(region["y"] + region["height"] / 2, 3),
        }

    class_to_netclass = {
        "usb2_diff": "E1Phone_USB2_90R",
        "mipi_dphy_diff": "E1Phone_MIPI_DPHY_100R",
        "pcie_diff": "E1Phone_PCIE_85R",
        "memory_diff": "E1Phone_LPDDR_LENGTH_MATCHED",
        "ufs_diff": "E1Phone_UFS_MPHY",
    }
    required_diff_route_steps = {
        "supplier pad escape and via-in-pad policy",
        "return-path and reference-plane continuity review",
        "post-route length/skew report generated from KiCad",
    }
    violations = []
    for name, item in diff_corridors.items():
        constraint = routing_pairs[name]
        if item["status"] != "blocked_waiting_supplier_footprints_and_trial_route":
            raise SystemExit(f"route corridor diff pair unexpectedly open: {name}")
        if item["route_type"] != "differential_pair":
            raise SystemExit(f"route corridor diff pair has wrong route type: {name}")
        if item["id"] != f"corridor_diff_{name}":
            raise SystemExit(f"route corridor diff pair id diverges: {name}")
        expected_netclass = class_to_netclass[constraint["class"]]
        if item["netclass"] != expected_netclass:
            raise SystemExit(f"route corridor netclass diverges: {name}")
        for key in ["nets", "max_length_mm", "intra_pair_skew_mm_max"]:
            if item[key] != constraint[key]:
                raise SystemExit(f"route corridor diff pair constraint diverges: {name} {key}")
        for ref_key, center_key in [
            ("from_refdes_group", "from_center_mm"),
            ("to_refdes_group", "to_center_mm"),
        ]:
            refdes = item[ref_key]
            if refdes not in placement_records:
                raise SystemExit(f"route corridor unknown placement refdes: {name} {refdes}")
            if item[center_key] != center(placement_records[refdes]):
                raise SystemExit(f"route corridor center diverges: {name} {center_key}")
        rect = item["candidate_corridor_rect_mm"]
        if rect["width"] <= 0 or rect["height"] <= 0:
            raise SystemExit(f"route corridor has invalid rectangle: {name}")
        if not set(item["intersecting_keepout_zones_to_review"]).issubset(keepouts):
            raise SystemExit(f"route corridor unknown keepout in diff pair: {name}")
        if set(item["required_before_route"]) != required_diff_route_steps:
            raise SystemExit(f"route corridor required route steps diverge: {name}")
        if item["concept_manhattan_length_mm"] > item["max_length_mm"]:
            violations.append(item)

    recorded_violations = corridors["concept_length_limit_violations"]
    if len(violations) != summary["concept_length_limit_violation_count"]:
        raise SystemExit("route corridor length violation count diverges")
    if len(recorded_violations) != len(violations):
        raise SystemExit("route corridor recorded violation count diverges")
    for violation in recorded_violations:
        corridor = diff_corridors[violation["constraint_pair"]]
        for key in ["id", "concept_manhattan_length_mm", "max_length_mm"]:
            if violation[key] != corridor[key]:
                raise SystemExit(f"route corridor length violation stale: {violation['id']} {key}")
        if violation["over_by_mm"] != round(corridor["concept_manhattan_length_mm"] - corridor["max_length_mm"], 3):
            raise SystemExit(f"route corridor length violation overage stale: {violation['id']}")
        if "change topology" not in violation["required_decision"]:
            raise SystemExit(f"route corridor violation missing topology decision: {violation['id']}")
    if [item["constraint_pair"] for item in recorded_violations] != ["USB_DP_DN"]:
        raise SystemExit("route corridor must keep USB_DP_DN as the explicit concept length violation")

    required_rf_route_steps = {
        "module vendor reference layout imported",
        "matching network and conducted access geometry reviewed by RF",
        "VNA and conducted RF evidence captured after first article",
    }
    for net, item in rf_corridors.items():
        if item["status"] != "blocked_waiting_rf_reference_layout_matching_and_vna":
            raise SystemExit(f"route corridor RF feed unexpectedly open: {net}")
        if item["route_type"] != "rf_feed" or item["netclass"] != "E1Phone_RF_50R":
            raise SystemExit(f"route corridor RF feed class/type diverges: {net}")
        if item["id"] != f"corridor_rf_{net}":
            raise SystemExit(f"route corridor RF feed id diverges: {net}")
        allowed_sources = set(str(rf_required[net]["near"]).split("_or_"))
        if item["from_refdes_group"] not in allowed_sources:
            raise SystemExit(f"route corridor RF feed source diverges: {net}")
        if item["to_antenna_keepout"] not in keepouts:
            raise SystemExit(f"route corridor RF feed antenna keepout unknown: {net}")
        if item["from_center_mm"] != center(placement_records[item["from_refdes_group"]]):
            raise SystemExit(f"route corridor RF feed center diverges: {net}")
        if set(item["required_before_route"]) != required_rf_route_steps:
            raise SystemExit(f"route corridor RF required steps diverge: {net}")

    required_power_route_steps = {
        "charger/PMIC/battery connector supplier footprints",
        "current-limit and copper-width calculation",
        "thermal spreading and return-current review",
    }
    for name, item in power_corridors.items():
        if item["status"] != "blocked_waiting_power_tree_footprints_current_budget_and_trial_route":
            raise SystemExit(f"route corridor power path unexpectedly open: {name}")
        if item["route_type"] != "high_current_power" or item["netclass"] != "E1Phone_POWER":
            raise SystemExit(f"route corridor power type/class diverges: {name}")
        if item["id"] != f"corridor_power_{name}":
            raise SystemExit(f"route corridor power id diverges: {name}")
        for ref_key, center_key in [
            ("from_refdes_group", "from_center_mm"),
            ("to_refdes_group", "to_center_mm"),
        ]:
            refdes = item[ref_key]
            if refdes not in placement_records:
                raise SystemExit(f"route corridor power unknown placement refdes: {name} {refdes}")
            if item[center_key] != center(placement_records[refdes]):
                raise SystemExit(f"route corridor power center diverges: {name} {center_key}")
        if set(item["required_before_route"]) != required_power_route_steps:
            raise SystemExit(f"route corridor power required steps diverge: {name}")

    route_summary = feasibility["interface_complexity_counts"]
    if summary["differential_pair_corridor_count"] != route_summary["differential_pair_count_required"]:
        raise SystemExit("route corridor diff count diverges from feasibility model")
    if summary["rf_feed_corridor_count"] != route_summary["rf_feed_count_required"]:
        raise SystemExit("route corridor RF count diverges from feasibility model")
    for name, value in corridors["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"route corridor cross-check failed: {name}")
    for claim in [
        "trial_route_ready",
        "routed_pcb_ready",
        "drc_clean",
        "si_pi_ready",
        "rf_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in corridors["forbidden_claims"]:
            raise SystemExit(f"route corridor missing forbidden claim {claim}")
    print(
        "route corridor execution ok: "
        f"{summary['total_corridor_count']} corridors, USB overage={recorded_violations[0]['over_by_mm']}mm"
    )


def check_usb_route_topology_resolution() -> None:
    topology = load_yaml(ROOT / "board/kicad/e1-phone/usb-route-topology-resolution.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    corridors = load_yaml(ROOT / "board/kicad/e1-phone/route-corridor-execution-package.yaml")
    usb_sidekey = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    interconnect = load_yaml(ROOT / "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    manifest = load_yaml(MANIFEST)

    if topology["schema"] != "eliza.e1_phone_usb_route_topology_resolution.v1":
        raise SystemExit("USB route topology schema diverges")
    if topology["status"] != "blocked_usb2_route_topology_requires_controlled_impedance_flex_or_topology_change":
        raise SystemExit(f"unexpected USB route topology status: {topology['status']}")
    rel = "board/kicad/e1-phone/usb-route-topology-resolution.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing USB route topology artifact")
    for source in topology["source_artifacts"]:
        require_path(ROOT / source)

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    routing_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    corridor_pairs = {
        item["constraint_pair"]: item for item in corridors["differential_pair_corridors"]
    }
    problem = topology["current_problem"]
    usb_region = placements["J_USB_C"]["region_mm"]
    soc_region = placements["U_SOC_LPDDR_UFS"]["region_mm"]
    usb_corridor = corridor_pairs["USB_DP_DN"]
    usb_constraint = routing_pairs["USB_DP_DN"]
    if problem["constraint_pair"] != "USB_DP_DN":
        raise SystemExit("USB topology must resolve USB_DP_DN")
    if problem["usb_c_region_mm"] != usb_region:
        raise SystemExit("USB topology USB-C region diverges from placement matrix")
    if problem["soc_region_mm"] != soc_region:
        raise SystemExit("USB topology SoC region diverges from placement matrix")
    if problem["max_length_mm"] != usb_constraint["max_length_mm"]:
        raise SystemExit("USB topology max length diverges from routing constraints")
    if problem["concept_manhattan_length_mm"] != usb_corridor["concept_manhattan_length_mm"]:
        raise SystemExit("USB topology length diverges from route corridor")
    expected_overage = round(usb_corridor["concept_manhattan_length_mm"] - usb_constraint["max_length_mm"], 3)
    if problem["over_by_mm"] != expected_overage or expected_overage <= 0:
        raise SystemExit("USB topology overage must match blocked route-corridor violation")
    if problem["route_corridor_status"] != corridors["status"]:
        raise SystemExit("USB topology route corridor status stale")
    if problem["usb_sidekey_status"] != usb_sidekey["status"]:
        raise SystemExit("USB topology side-key integration status stale")
    if problem["interconnect_status"] != interconnect["status"]:
        raise SystemExit("USB topology interconnect status stale")

    options = {item["id"]: item for item in topology["topology_options"]}
    expected_options = {
        "keep_usb_bottom_and_top_soc_direct_or_flex",
        "move_usb_c_or_soc_to_same_rigid_island",
        "add_bottom_usb2_bridge_or_debug_controller",
        "controlled_impedance_side_flex_with_signed_usb_si",
    }
    if set(options) != expected_options:
        raise SystemExit("USB topology option set diverges")
    direct = options["keep_usb_bottom_and_top_soc_direct_or_flex"]
    if direct["status"] != "rejected_for_evt1_until_usb_si_waiver_or_topology_change":
        raise SystemExit("USB direct topology must remain rejected for EVT1")
    direct_evidence = direct["evidence"]
    for key in ["direct_concept_manhattan_length_mm", "max_length_mm", "over_by_mm"]:
        problem_key = {
            "direct_concept_manhattan_length_mm": "concept_manhattan_length_mm",
            "max_length_mm": "max_length_mm",
            "over_by_mm": "over_by_mm",
        }[key]
        if direct_evidence[key] != problem[problem_key]:
            raise SystemExit(f"USB direct topology evidence stale: {key}")
    if direct_evidence["split_rigid_segments"]["requires_flex_length_supplier_stackup"] is not True:
        raise SystemExit("USB direct topology must require supplier flex stackup")
    if "direct concept path exceeds USB2 length target before supplier footprints or flex stackup" not in direct["why_not_ready"]:
        raise SystemExit("USB direct topology missing length blocker")

    recommended = options["controlled_impedance_side_flex_with_signed_usb_si"]
    if recommended["status"] != "recommended_resolution_path_but_blocked_until_supplier_stackup_and_trial_route":
        raise SystemExit("USB recommended topology status changed")
    evidence = recommended["evidence"]
    if evidence["preserves_bottom_center_port"] is not True:
        raise SystemExit("USB recommended topology must preserve bottom port")
    if evidence["preserves_selected_screen_and_battery_geometry"] is not True:
        raise SystemExit("USB recommended topology must preserve screen and battery geometry")
    if evidence["must_replace_current_direct_corridor"] != usb_corridor["id"]:
        raise SystemExit("USB recommended topology corridor dependency stale")
    if evidence["must_update_top_bottom_interconnect_pinout"] != "USB_DP_USB_DN_flanked_by_ground_or_return":
        raise SystemExit("USB recommended topology interconnect policy changed")
    decision = topology["recommended_resolution"]
    if decision["selected_option"] != "controlled_impedance_side_flex_with_signed_usb_si":
        raise SystemExit("USB topology selected option changed")
    if decision["decision_status"] != "blocked_waiting_supplier_flex_connector_stackup_trial_route_and_usb_si":
        raise SystemExit("USB topology decision must remain blocked")
    required_updates = set(decision["required_design_updates"])
    for update in [
        "replace current direct USB_DP_DN corridor with routed side/flex corridor geometry",
        "freeze split-interconnect pinout with USB_DP/USB_DN adjacent to ground returns",
        "place USB2 ESD, CC ESD, VBUS TVS, and PD controller around bottom USB-C without long stubs",
        "generate post-route length/skew/impedance report and USB2 attach/ADB/fastboot bring-up logs",
    ]:
        if update not in required_updates:
            raise SystemExit(f"USB topology missing required update: {update}")
    si_acceptance = topology.get("usb2_si_acceptance")
    if not isinstance(si_acceptance, dict):
        raise SystemExit("USB topology missing SI acceptance gate")
    si_template_rel = si_acceptance.get("evidence_template")
    if si_template_rel != "board/kicad/e1-phone/usb-route-si-results-template.csv":
        raise SystemExit("USB topology SI template path diverges")
    if si_template_rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing USB route SI template artifact")
    si_template_path = ROOT / si_template_rel
    require_path(si_template_path)
    if si_acceptance.get("required_evidence_class") != "physical_usb2_route_si_result":
        raise SystemExit("USB topology SI evidence class must require physical results")
    if si_acceptance.get("pass_status") != "blocked_no_usb2_route_si_results":
        raise SystemExit("USB topology SI pass status must remain fail-closed")
    measurements = si_acceptance.get("measurements")
    if not isinstance(measurements, list) or len(measurements) < 8:
        raise SystemExit("USB topology SI acceptance must define at least 8 measurements")
    if si_acceptance.get("expected_measurement_count") != len(measurements):
        raise SystemExit("USB topology SI expected count diverges")
    expected_si_ids = {
        "routed_usb2_total_length_mm",
        "routed_usb2_intra_pair_skew_mm",
        "flex_or_pcb_diff_impedance_ohm",
        "return_via_or_ground_contact_spacing_mm",
        "usb2_insertion_loss_240mhz_db",
        "usb2_eye_height_mv",
        "usb_attach_adb_fastboot_pass_count",
        "routed_usb_enclosure_clearance_interference_count",
    }
    measurement_by_id = {item["id"]: item for item in measurements}
    if set(measurement_by_id) != expected_si_ids:
        raise SystemExit("USB topology SI measurement set diverges")
    for measurement in measurements:
        if measurement.get("release_blocker") is not True:
            raise SystemExit(f"USB topology SI measurement must block release: {measurement.get('id')}")
        if not measurement.get("required_artifact"):
            raise SystemExit(f"USB topology SI measurement missing artifact: {measurement.get('id')}")
    with si_template_path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != len(measurements):
        raise SystemExit("USB route SI template row count diverges")
    required_fields = {
        "measurement_id",
        "domain",
        "unit",
        "min",
        "max",
        "measured_value",
        "pass",
        "reviewer",
        "evidence_class",
        "required_artifact",
        "result_artifact",
        "notes",
    }
    if set(rows[0]) != required_fields:
        raise SystemExit("USB route SI template field set diverges")
    for row in rows:
        measurement = measurement_by_id.get(row["measurement_id"])
        if measurement is None:
            raise SystemExit(f"USB route SI template has unknown row: {row['measurement_id']}")
        if row["domain"] != measurement["domain"] or row["unit"] != measurement["unit"]:
            raise SystemExit(f"USB route SI template domain/unit stale: {row['measurement_id']}")
        if row["evidence_class"] != "physical_usb2_route_si_result":
            raise SystemExit(f"USB route SI template evidence class diverges: {row['measurement_id']}")
        if row["measured_value"] or row["pass"] or row["reviewer"] or row["result_artifact"]:
            raise SystemExit(f"USB route SI template must remain blank until physical evidence: {row['measurement_id']}")
    split_status = pcb_audit["split_interconnect_status"]
    for refdes in ["J_TOP_BOTTOM_FLEX_TOP", "J_TOP_BOTTOM_FLEX_BOTTOM"]:
        status = split_status[refdes]
        if status["pad_count"] < 49:
            raise SystemExit(f"USB topology split interconnect pad budget too small: {refdes}")
        for net in ["USB_DP", "USB_DN", "VBUS"]:
            if status["critical_nets_present"][net] is not True:
                raise SystemExit(f"USB topology split interconnect missing {net}: {refdes}")
    if pcb_audit["live_pcb_counts"]["segment_count"] != 0:
        raise SystemExit("USB topology cannot claim routed USB while live PCB has segments")
    for name, value in topology["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB topology cross-check failed: {name}")
    for claim in [
        "usb_route_ready",
        "usb_si_closed",
        "usb_debug_ready",
        "routing_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in topology["forbidden_claims"]:
            raise SystemExit(f"USB topology missing forbidden claim {claim}")
    print(
        "USB route topology ok: "
        f"{decision['selected_option']} blocked, USB overage={problem['over_by_mm']}mm"
    )


def check_split_interconnect_pin_allocation_and_binding() -> None:
    allocation = load_yaml(
        ROOT / "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml"
    )
    binding = load_yaml(
        ROOT / "board/kicad/e1-phone/split-interconnect-connector-binding.yaml"
    )
    plan = load_yaml(ROOT / "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml")
    topology = load_yaml(ROOT / "board/kicad/e1-phone/usb-route-topology-resolution.yaml")
    block_netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    package = load_yaml(ROOT / "package/interconnect/e1-phone-top-bottom-flex.yaml")
    symbol_footprint = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    )
    supplier_intake = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if allocation["schema"] != "eliza.e1_phone_split_interconnect_pin_allocation.v1":
        raise SystemExit("split interconnect allocation schema diverges")
    if allocation["status"] != "blocked_requires_connector_part_numbers_flex_stackup_si_and_drc":
        raise SystemExit(f"unexpected split interconnect allocation status: {allocation['status']}")
    if binding["schema"] != "eliza.e1_phone_split_interconnect_connector_binding.v1":
        raise SystemExit("split interconnect connector binding schema diverges")
    if binding["status"] != "blocked_placeholder_connectors_bound_to_pin_allocation_not_supplier_release":
        raise SystemExit(f"unexpected split interconnect connector binding status: {binding['status']}")
    for rel in [
        "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml",
        "board/kicad/e1-phone/split-interconnect-connector-binding.yaml",
    ]:
        if rel not in manifest["current_artifacts"]["planning"]:
            raise SystemExit(f"manifest missing split interconnect artifact {rel}")
    for source in allocation["source_artifacts"] + binding["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "top_bottom_interconnect_status": plan["status"],
        "usb_route_topology_status": topology["status"],
        "interconnect_binding_status": package["status"],
        "pcb_split_interconnect_status": pcb_audit["split_interconnect_status"],
    }
    if allocation["upstream_status"] != expected_upstream:
        raise SystemExit("split interconnect allocation upstream snapshot is stale")
    expected_binding_upstream = {
        "split_interconnect_pin_allocation_status": allocation["status"],
        "pcb_audit_status": pcb_audit["status"],
        "symbol_footprint_status": symbol_footprint["status"],
        "supplier_intake_status": supplier_intake["status"],
    }
    if binding["upstream_status"] != expected_binding_upstream:
        raise SystemExit("split interconnect connector binding upstream snapshot is stale")

    context = allocation["connector_context"]
    if context["selected_topology"] != plan["selected_topology"]:
        raise SystemExit("split interconnect selected topology diverges from plan")
    if context["preferred_interconnect_family"] != plan["preferred_interconnect_family"]:
        raise SystemExit("split interconnect preferred family diverges from plan")
    if context["primary_candidate_family"] != package["primary_candidate"]["family"]:
        raise SystemExit("split interconnect primary family diverges from package")
    if context["exact_part_number_status"] != "not_selected":
        raise SystemExit("split interconnect exact part number must remain unselected")
    for refdes, pad_count in context["footprint_pad_budget"].items():
        if pad_count != pcb_audit["split_interconnect_status"][refdes]["pad_count"]:
            raise SystemExit(f"split interconnect pad budget stale for {refdes}")

    pins = allocation["pin_allocation"]
    contacts = [item["contact"] for item in pins]
    budget = allocation["contact_budget"]
    if contacts != list(range(1, budget["allocated_contact_count"] + 1)):
        raise SystemExit("split interconnect contacts must be contiguous")
    if budget["recommended_contacts_min"] != plan["minimum_pin_budget"]["recommended_contacts_min"]:
        raise SystemExit("split interconnect recommended contact count diverges from plan")
    if budget["allocated_contact_count"] != len(pins):
        raise SystemExit("split interconnect allocated contact count stale")
    ground_count = sum(1 for item in pins if item["net"] in {"GND", "SHIELD_GND"})
    spare_count = sum(1 for item in pins if item["net"] == "NC")
    active_nets = {item["net"] for item in pins if item["net"] != "NC"}
    if ground_count != budget["allocated_ground_or_return_pin_count"]:
        raise SystemExit("split interconnect ground/return count stale")
    if ground_count < budget["required_ground_or_return_pins_min"]:
        raise SystemExit("split interconnect ground/return count below minimum")
    if spare_count != budget["allocated_spare_pin_count"]:
        raise SystemExit("split interconnect spare count stale")
    if spare_count < budget["required_spares_min"]:
        raise SystemExit("split interconnect spare count below minimum")
    if len(active_nets) != budget["active_unique_crossing_net_count"]:
        raise SystemExit("split interconnect active unique net count stale")

    plan_buses = {bus["name"]: set(bus["nets"]) for bus in plan["cross_island_buses"]}
    package_buses = {bus["name"]: set(bus["nets"]) for bus in package["required_cross_island_buses"]}
    pin_buses = {}
    for item in pins:
        pin_buses.setdefault(item["bus"], set()).add(item["net"])
    for bus_name, nets in plan_buses.items():
        if bus_name not in pin_buses:
            raise SystemExit(f"split interconnect allocation missing bus {bus_name}")
        missing = sorted((nets - {"GND"}) - active_nets)
        if missing:
            raise SystemExit(f"split interconnect allocation dropped plan bus nets {bus_name}: {missing}")
        if bus_name in package_buses and not package_buses[bus_name].issubset(active_nets | {"GND"}):
            raise SystemExit(f"split interconnect allocation dropped package bus nets {bus_name}")

    coverage = allocation["required_cross_island_net_coverage"]
    if set(coverage["required_nets"]) != set(coverage["allocated_nets"]):
        raise SystemExit("split interconnect required and allocated net sets diverge")
    if coverage["missing_required_nets"] or coverage["unknown_allocated_nets"]:
        raise SystemExit("split interconnect cross-island net coverage has gaps")
    if set(coverage["allocated_nets"]) != active_nets:
        raise SystemExit("split interconnect allocated active nets diverge from pin table")

    known_nets = set()
    for block in block_netlist["blocks"]:
        known_nets.update(flatten_net_groups(block["nets"]))
    for domain in block_netlist["voltage_domains"]:
        known_nets.add(domain["name"])
    unknown_active = sorted(active_nets - known_nets)
    if unknown_active:
        raise SystemExit(f"split interconnect allocation has unknown active nets: {unknown_active}")

    controlled = {item["name"]: item for item in allocation["controlled_impedance_groups"]}
    usb_group = controlled["USB_DP_DN"]
    if usb_group["pins"] != [1, 2, 3, 4] or usb_group["nets"] != ["GND", "USB_DP", "USB_DN", "GND"]:
        raise SystemExit("split interconnect USB2 group must stay ground-DP-DN-ground")
    usb_constraint = {item["name"]: item for item in routing["differential_pairs"]}["USB_DP_DN"]
    impedance_classes = routing["impedance_classes"]
    if usb_group["target_differential_impedance_ohm"] != impedance_classes[usb_constraint["class"]]["impedance_ohm"]:
        raise SystemExit("split interconnect USB2 impedance diverges from routing constraints")
    if usb_group["status"] != "blocked_waiting_supplier_flex_stackup_impedance_coupon_and_usb_si":
        raise SystemExit("split interconnect USB2 controlled-impedance group unexpectedly open")
    audio_group = controlled["AUDIO_I2S_PDM_CLOCKS"]
    if "I2S_BCLK" not in audio_group["nets"] or "PDM_CLK" not in audio_group["nets"]:
        raise SystemExit("split interconnect audio controlled group missing clock nets")

    power_groups = {item["name"]: item for item in allocation["power_contact_groups"]}
    if set(power_groups) != {"VBUS", "SYS", "AUDIO_POWER", "BATTERY_AND_RF_SERVICE"}:
        raise SystemExit("split interconnect power contact groups changed")
    for name, group in power_groups.items():
        if not group["pins"] or not group["return_pins"] or not group["status"].startswith("blocked_"):
            raise SystemExit(f"split interconnect power group is weak: {name}")
    fixture = allocation["test_access_mapping"]["bottom_fixture_visible_rails"]
    for rail in ["VBUS", "VBAT", "SYS", "AON_1V8", "IO_1V8", "RF_VBAT", "GND"]:
        if rail not in fixture or not fixture[rail]:
            raise SystemExit(f"split interconnect fixture rail missing: {rail}")
    if allocation["test_access_mapping"]["status"] != "blocked_waiting_bottom_fixture_pad_coordinates_and_production_limits":
        raise SystemExit("split interconnect fixture mapping unexpectedly open")

    policy = binding["binding_policy"]
    if policy["contact_count"] != budget["allocated_contact_count"]:
        raise SystemExit("split interconnect binding contact count diverges")
    for key in [
        "top_and_bottom_connectors_use_same_logical_pin_order",
        "mated_flex_mirror_review_required_before_supplier_release",
        "placeholder_pad_order_can_drive_trial_route_only",
        "supplier_land_pattern_required_before_fabrication",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"split interconnect binding policy must require {key}")
    bindings = {item["refdes"]: item for item in binding["connector_bindings"]}
    if set(bindings) != {"J_TOP_BOTTOM_FLEX_TOP", "J_TOP_BOTTOM_FLEX_BOTTOM"}:
        raise SystemExit("split interconnect binding refdes set diverges")
    for refdes, item in bindings.items():
        pcb_status = pcb_audit["split_interconnect_status"][refdes]
        if item["status"] != "blocked_placeholder_binding_waiting_supplier_land_pattern_and_schematic_symbol":
            raise SystemExit(f"split interconnect binding unexpectedly open: {refdes}")
        if not item["schematic_ref_present"] or not item["pcb_placeholder_present"]:
            raise SystemExit(f"split interconnect binding missing placeholder evidence: {refdes}")
        if item["allocated_contact_count"] != budget["allocated_contact_count"]:
            raise SystemExit(f"split interconnect binding allocation count stale: {refdes}")
        if item["pcb_pad_count"] != pcb_status["pad_count"]:
            raise SystemExit(f"split interconnect binding pad count stale: {refdes}")
        if not item["pad_order_matches_allocation"] or item["mismatched_contacts"]:
            raise SystemExit(f"split interconnect binding pad order mismatch: {refdes}")
        if item["usb2_contacts"] != {"USB_DP": [2], "USB_DN": [3], "near_returns": [1, 4]}:
            raise SystemExit(f"split interconnect binding USB2 contacts diverge: {refdes}")
        if len(item["required_release_evidence"]) < 5:
            raise SystemExit(f"split interconnect binding release evidence too weak: {refdes}")
    schematic_binding = binding["schematic_binding"]
    if (
        schematic_binding["evidence_class"] != "non_release_text_scaffold"
        or not schematic_binding["top_connector_text_present"]
        or not schematic_binding["bottom_connector_text_present"]
        or schematic_binding["real_symbol_present"]
        or schematic_binding["erc_ready"]
    ):
        raise SystemExit("split interconnect schematic binding must remain non-release scaffold")
    pcb_binding = binding["pcb_binding"]
    if (
        pcb_binding["evidence_class"] != "non_release_placeholder_footprints"
        or not pcb_binding["all_placeholder_pad_orders_match_allocation"]
        or not pcb_binding["top_bottom_same_logical_pin_order"]
        or pcb_binding["mirrored_contact_mismatches"]
        or pcb_binding["real_supplier_land_pattern_present"]
        or pcb_binding["drc_ready"]
    ):
        raise SystemExit("split interconnect PCB binding must remain placeholder-only")

    for name, value in allocation["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"split interconnect allocation cross-check failed: {name}")
    for name, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"split interconnect binding cross-check failed: {name}")
    for claim in [
        "interconnect_pinout_frozen",
        "connector_selected",
        "flex_stackup_ready",
        "usb_si_closed",
        "split_board_routed",
        "routing_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in allocation["forbidden_claims"]:
            raise SystemExit(f"split interconnect allocation missing forbidden claim {claim}")
    for claim in [
        "schematic_connector_symbols_ready",
        "supplier_footprints_ready",
        "pinmap_release_ready",
        "split_interconnect_routed",
        "usb_si_closed",
        "erc_clean",
        "drc_clean",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"split interconnect binding missing forbidden claim {claim}")
    print(
        "split interconnect allocation/binding ok: "
        f"{len(pins)} contacts, {ground_count} returns, {spare_count} spares"
    )


def check_interface_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/interface-closure.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    if closure["status"] != "planning_interfaces_cross_checked_not_fabrication_ready":
        raise SystemExit(f"unexpected interface closure status: {closure['status']}")
    if (
        closure["device_envelope_mm"]
        != metrics["industrial_design_assumptions"]["device_envelope_mm"]
    ):
        raise SystemExit("interface closure device envelope diverges from metrics")
    closure_bbox = closure["board_bbox_mm"]
    metrics_bbox = metrics["mainboard_outline_concept"]["bounding_box_mm"]
    if (
        closure_bbox["width"] != metrics_bbox["width"]
        or closure_bbox["height"] != metrics_bbox["height"]
    ):
        raise SystemExit("interface closure board bbox diverges from metrics")
    required = {
        "single_bottom_usb_c_charge_data_debug",
        "left_edge_power_volume_buttons",
        "top_right_display_touch_fpc",
        "top_right_front_rear_camera_fpcs",
        "top_bottom_split_board_interconnect",
    }
    interfaces = {item["name"]: item for item in closure["interfaces"]}
    missing = sorted(required - set(interfaces))
    if missing:
        raise SystemExit(f"interface closure missing interfaces: {missing}")
    for name, item in interfaces.items():
        if not item["passes_planning_gate"]:
            raise SystemExit(f"interface closure planning gate failed for {name}")
        if item["missing_required_nets"] or item["missing_required_constraints"]:
            raise SystemExit(f"interface closure has unresolved planning gaps for {name}")
    blockers = closure["release_blockers"]
    for blocker in [
        "exact supplier connector pinouts",
        "real KiCad symbols and footprints",
        "routed DRC-clean",
        "STEP fit",
        "top/bottom interconnect",
    ]:
        if not any(blocker in item for item in blockers):
            raise SystemExit(f"interface closure missing release blocker: {blocker}")
    interconnect = interfaces["top_bottom_split_board_interconnect"]
    usb_interface = interfaces["single_bottom_usb_c_charge_data_debug"]
    button_interface = interfaces["left_edge_power_volume_buttons"]
    for key in ["connector_escape", "power_path", "bringup_test_access"]:
        if key not in usb_interface.get("layout_closure_requirements", {}):
            raise SystemExit(f"USB-C interface closure missing layout requirement group {key}")
    for net in ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN", "SHIELD_GND"]:
        test_access = usb_interface["layout_closure_requirements"]["bringup_test_access"]
        if not any(net in str(item) for item in test_access):
            raise SystemExit(f"USB-C interface closure missing bring-up test access for {net}")
    side_key_budget = button_interface.get("layout_closure_requirements", {}).get(
        "side_key_flex_pin_budget", {}
    )
    if side_key_budget.get("recommended_min_contacts", 0) < 8:
        raise SystemExit(f"side-key flex pin budget too weak: {side_key_budget}")
    for net in ["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "AON_1V8", "GND"]:
        if net not in side_key_budget.get("required_nets", []):
            raise SystemExit(f"side-key interface closure missing required net {net}")
    for key in ["actuator_stack", "bringup_test_access"]:
        if key not in button_interface.get("layout_closure_requirements", {}):
            raise SystemExit(f"side-key interface closure missing layout requirement group {key}")
    for net in ["USB_DP", "USB_DN", "VBUS", "SYS", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"]:
        if net not in interconnect["nets_present_in_block_or_matrix"]:
            raise SystemExit(f"split-board interface closure missing crossing net {net}")
    for requirement in [
        "battery must insert without overstressing the mated top/bottom flex",
        "connector mated height and stiffener stack must clear the 11.2 mm flush-back enclosure",
        "strain relief or clamp must be defined before drop/torsion testing",
    ]:
        if requirement not in interconnect["assembly_closure_requirements"]:
            raise SystemExit(
                f"split-board interface closure missing assembly requirement {requirement}"
            )
    print(f"interface closure ok: {len(interfaces)} enclosure/internal interfaces cross-checked")


def check_enclosure_placement_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-placement-closure.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    if closure["status"] != "enclosure_placement_cross_checked_not_release_ready":
        raise SystemExit(f"unexpected enclosure placement status: {closure['status']}")
    env = closure["envelope_cross_check"]
    expected_envelope = metrics["industrial_design_assumptions"]["device_envelope_mm"]
    if env["metrics_device_envelope_mm"] != expected_envelope:
        raise SystemExit("enclosure placement metrics envelope diverges from metrics")
    if env["enclosure_device_envelope_mm"] != expected_envelope:
        raise SystemExit("enclosure placement enclosure envelope diverges from metrics")
    if env["cad_device_envelope_mm"] != expected_envelope:
        raise SystemExit("enclosure placement CAD envelope diverges from metrics")
    if not env["display_primary_fits_current_envelope"]:
        raise SystemExit("enclosure placement lost primary display fit")
    if env["display_clearance_mm"] != display_fit["primary_clearance_in_current_envelope_mm"]:
        raise SystemExit("enclosure placement display clearance diverges from display-fit")
    handoff = closure["pcb_to_cad_handoff"]
    if not handoff["kicad_outline_check"]["pass"]:
        raise SystemExit("enclosure placement KiCad outline does not match CAD")
    if handoff["kicad_outline_check"]["kicad_edge_cuts_mm"] != [64.0, 132.0]:
        raise SystemExit("enclosure placement KiCad outline size changed unexpectedly")
    required_constraints = {
        "board_outline",
        "display_fpc_zone",
        "usb_c_mechanical_capture",
        "side_key_stack",
        "battery_window",
        "redcap_module_zone",
        "speaker_mic_ports",
        "mechanical_overlay",
    }
    missing_constraints = sorted(required_constraints - set(handoff["constraint_ids"]))
    if missing_constraints:
        raise SystemExit(f"enclosure placement missing handoff constraints: {missing_constraints}")
    required_step_parts = {
        "e1-phone-solid-assembly.step",
        "main_pcb.step",
        "display_lcm.step",
        "screen_cover_glass.step",
        "battery_pouch.step",
        "usb_c_receptacle.step",
        "power_button_cap.step",
        "volume_button_cap.step",
        "rear_camera_module.step",
        "front_camera_module.step",
        "bottom_speaker_module.step",
        "earpiece_receiver.step",
        "haptic_lra.step",
        "split_interconnect_top_connector.step",
        "split_interconnect_bottom_connector.step",
        "split_interconnect_side_flex.step",
        "split_interconnect_top_flex_tail.step",
        "split_interconnect_bottom_flex_tail.step",
    }
    missing_step_records = sorted(required_step_parts - set(closure["step_artifacts"]))
    if missing_step_records:
        raise SystemExit(f"enclosure placement missing STEP records: {missing_step_records}")
    if closure["missing_step_artifacts"]:
        raise SystemExit(
            f"enclosure placement missing STEP files: {closure['missing_step_artifacts']}"
        )
    for name, status in closure["step_artifacts"].items():
        if not status["present"] or status["bytes"] <= 0:
            raise SystemExit(f"enclosure placement invalid STEP artifact {name}: {status}")
    solid = closure["solid_cad_handoff"]
    if (
        solid["status"] != "generated"
        or not solid["tool_available"]
        or solid["part_count"] < 50
        or solid["linked_fit_status"] != "pass"
    ):
        raise SystemExit(f"enclosure placement solid CAD handoff is weak: {solid}")
    fit = closure["fit_and_clearance"]
    if (
        fit["fit_status"] != "pass"
        or fit["assembly_clearance_status"] != "pass"
        or fit["failed_fit_checks"]
        or fit["failed_clearance_cases"]
        or fit["checked_clearance_cases"] < 10
    ):
        raise SystemExit(f"enclosure placement fit/clearance failed: {fit}")
    readiness = closure["manufacturing_readiness_context"]
    if not readiness["all_cad_checks_pass"] or not readiness["visual_review_pass"]:
        raise SystemExit(f"enclosure placement CAD readiness checks failed: {readiness}")
    if readiness["manufacturing_release_ready"]:
        raise SystemExit(
            "enclosure placement must remain blocked until real release evidence exists"
        )
    for blocker in [
        "routed KiCad board STEP with final component 3D models",
        "supplier display, camera, USB-C, button, battery, speaker, and radio STEP/B-rep models",
        "formal 11.2 mm flush-back tolerance stack with gasket compression and battery swelling",
        "RF antenna/SAR validation in final enclosure plastics and metal stack",
    ]:
        if blocker not in closure["release_blockers"]:
            raise SystemExit(f"enclosure placement missing release blocker {blocker}")
    for claim in [
        "enclosure_ready",
        "mechanical_release_ready",
        "routed_board_step_ready",
        "tolerance_stack_closed",
        "fabrication_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"enclosure placement missing forbidden claim {claim}")
    print(
        "enclosure placement ok: "
        f"{len(closure['step_artifacts'])} STEP artifacts, "
        f"{fit['checked_clearance_cases']} clearance cases, release blocked"
    )


def check_component_height_step_integration() -> None:
    integration = load_yaml(
        ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml"
    )
    enclosure = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-placement-closure.yaml")
    tolerance = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-tolerance-stack-closure.yaml")
    route_feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    evt1_route = load_yaml(ROOT / "board/kicad/e1-phone/evt1-routing-work-package.yaml")
    supplier_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    symbol_footprint = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    )
    board_step = load_yaml(ROOT / "mechanical/e1-phone/review/board-step-readiness.json")
    routed_clearance = load_yaml(ROOT / "mechanical/e1-phone/review/routed-board-clearance.json")
    supplier_evidence = load_yaml(
        ROOT / "mechanical/e1-phone/review/supplier-evidence-acceptance.json"
    )
    step_validation = load_yaml(ROOT / "mechanical/e1-phone/review/step-validation.json")
    compactness = load_yaml(ROOT / "mechanical/e1-phone/review/compactness-optimization.json")
    manifest = load_yaml(MANIFEST)

    if integration["schema"] != "eliza.e1_phone_component_height_step_integration.v1":
        raise SystemExit("component height STEP integration schema diverges")
    if integration["status"] != "blocked_requires_supplier_step_models_routed_board_step_and_clearance_rerun":
        raise SystemExit(f"unexpected component height STEP status: {integration['status']}")
    rel = "board/kicad/e1-phone/component-height-step-integration.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing component height STEP integration artifact")
    for source in integration["source_artifacts"]:
        require_path(ROOT / source)

    compact = integration["compactness_context"]
    for key in [
        "status",
        "current_envelope_mm",
        "width_excess_over_bound_mm",
        "height_excess_over_bound_mm",
        "area_excess_over_bound_mm2",
        "decision",
    ]:
        if compact[key] != compactness[key]:
            raise SystemExit(f"component height compactness context stale: {key}")
    selected_env = tolerance["selected_envelope_mm"]
    if compact["current_envelope_mm"] != [
        selected_env["width"],
        selected_env["height"],
        selected_env["max_thickness"],
    ]:
        raise SystemExit("component height compactness envelope diverges from tolerance stack")

    concept = integration["concept_step_context"]
    if concept["enclosure_placement_status"] != enclosure["status"]:
        raise SystemExit("component height enclosure placement status stale")
    if concept["step_validation_status"] != step_validation["status"]:
        raise SystemExit("component height step validation status stale")
    if concept["validated_step_count"] != step_validation["validated_count"]:
        raise SystemExit("component height validated STEP count stale")
    assembly = step_validation.get("assembly")
    if assembly is None:
        for key in ["assembly_step", "assembly_step_imported", "assembly_step_bbox_span_mm"]:
            if concept[key] is not None:
                raise SystemExit(f"component height assembly context must stay blocked: {key}")
    else:
        if concept["assembly_step"] != assembly["step"]:
            raise SystemExit("component height assembly STEP path stale")
        if concept["assembly_step_imported"] != assembly["imported"]:
            raise SystemExit("component height assembly import status stale")
        if concept["assembly_step_bbox_span_mm"] != assembly["bbox_span_mm"]:
            raise SystemExit("component height assembly bbox stale")
    if concept["concept_step_artifact_count"] != len(enclosure["step_artifacts"]):
        raise SystemExit("component height concept STEP artifact count stale")
    if concept["missing_concept_step_artifacts"]:
        raise SystemExit("component height concept STEP artifacts missing")
    if concept["concept_is_release_evidence"] is not False:
        raise SystemExit("component height concept STEP must not be release evidence")

    routed = integration["routed_board_step_context"]
    board_state = board_step["board_state_detected"]
    if routed["board_step_readiness_status"] != board_step["status"]:
        raise SystemExit("component height board STEP readiness status stale")
    if routed["routed_board_clearance_status"] != routed_clearance["status"]:
        raise SystemExit("component height routed clearance status stale")
    if routed["production_step_files"] != board_step["production_step_files"]:
        raise SystemExit("component height production STEP files stale")
    for key in ["has_tracks", "has_filled_zones", "has_production_step", "placeholder_marker_count"]:
        if routed[key] != board_state[key]:
            raise SystemExit(f"component height routed board context stale: {key}")
    if routed["concept_split_island_geometry_matches_kicad"] != board_step["concept_split_island_geometry"]["matches"]:
        raise SystemExit("component height split island geometry status stale")
    if routed["has_tracks"] or routed["has_production_step"]:
        raise SystemExit("component height cannot claim routed tracks or production STEP")

    supplier = integration["supplier_geometry_context"]
    if supplier["supplier_evidence_status"] != supplier_evidence["status"]:
        raise SystemExit("component height supplier evidence status stale")
    if supplier["expected_family_count"] != supplier_evidence["expected_family_count"]:
        raise SystemExit("component height supplier family count stale")
    if supplier["complete_family_count"] != supplier_evidence["complete_family_count"]:
        raise SystemExit("component height complete supplier family count stale")
    if supplier["supplier_to_kicad_status"] != supplier_map["status"]:
        raise SystemExit("component height supplier-to-KiCad status stale")
    if supplier["schematic_symbol_footprint_status"] != symbol_footprint["status"]:
        raise SystemExit("component height symbol/footprint status stale")
    supplier_cases = {case["id"]: case for case in supplier["supplier_cases"]}
    evidence_families = {case["id"]: case for case in supplier_evidence["families"]}
    if set(supplier_cases) != set(evidence_families):
        raise SystemExit("component height supplier family set diverges")
    for family_id, case in supplier_cases.items():
        evidence = evidence_families[family_id]
        for key in ["rfq_package_id", "rfq_package_ready", "required_evidence", "missing_supplier_items", "pass"]:
            if case[key] != evidence[key]:
                raise SystemExit(f"component height supplier case stale: {family_id} {key}")
        if case["returned_basic_evidence"] is not False or case["pass"] is not False:
            raise SystemExit(f"component height supplier case unexpectedly complete: {family_id}")

    height_models = {item["model"]: item for item in integration["height_critical_models"]}
    required_models = set(routed_clearance["required_height_models"])
    if set(height_models) != required_models:
        raise SystemExit("component height critical model set diverges from routed clearance")
    concept_case_names = {case["name"] for case in step_validation["cases"]}
    for model, item in height_models.items():
        if item["supplier_step_required"] is not True:
            raise SystemExit(f"component height model does not require supplier STEP: {model}")
        if item["routed_board_clearance_required"] is not True:
            raise SystemExit(f"component height model does not require routed clearance: {model}")
        if item["status"] != "blocked_supplier_step_and_routed_clearance_required":
            raise SystemExit(f"component height model unexpectedly open: {model}")
        if item["concept_step_available"]:
            require_path(ROOT / item["concept_step_path"])
            if (
                model not in concept_case_names
                and step_validation["status"] != "blocked"
            ):
                raise SystemExit(f"component height concept model not in STEP validation: {model}")
        elif item["concept_step_path"] is not None:
            raise SystemExit(f"component height missing concept STEP should have null path: {model}")

    matrix = {item["case_id"]: item for item in integration["routed_clearance_rerun_matrix"]}
    rerun_matrix = {item["case_id"]: item for item in routed_clearance["rerun_matrix"]}
    if set(matrix) != set(rerun_matrix):
        raise SystemExit("component height routed clearance rerun matrix diverges")
    for case_id, item in matrix.items():
        rerun = rerun_matrix[case_id]
        for key in [
            "concept_clearance_pass",
            "concept_actual_mm",
            "concept_required_mm",
            "concept_margin_mm",
            "rerun_priority",
        ]:
            if item[key] != rerun[key]:
                raise SystemExit(f"component height routed clearance case stale: {case_id} {key}")
        if item["requires_routed_step_rerun"] is not True:
            raise SystemExit(f"component height clearance case must require rerun: {case_id}")
    if routed_clearance["complete_clearance_result_count"] != 0:
        raise SystemExit("component height cannot have completed clearance results")

    route_dep = integration["route_dependency_context"]
    if route_dep["route_feasibility_status"] != route_feasibility["status"]:
        raise SystemExit("component height route feasibility status stale")
    if route_dep["evt1_routing_status"] != evt1_route["status"]:
        raise SystemExit("component height EVT1 route status stale")
    if route_dep["trial_route_reports_required"] != route_feasibility["trial_route_exit_criteria"]["required_measurements_or_reports"]:
        raise SystemExit("component height trial-route report list stale")
    for output in route_dep["evt1_required_release_outputs"]:
        if output not in evt1_route["required_release_outputs"]:
            raise SystemExit(f"component height EVT1 release output not in route package: {output}")

    for output in [
        "board/kicad/e1-phone/production/reports/component-height-step-integration.yaml",
        "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "mechanical/e1-phone/review/routed-board-clearance.json",
        "mechanical/e1-phone/review/supplier-evidence-acceptance.json",
        "mechanical/e1-phone/review/step-validation.json",
        "mechanical/e1-phone/review/full-cad-boolean-interference.json",
    ]:
        if output not in integration["required_release_outputs"]:
            raise SystemExit(f"component height missing release output {output}")
    for blocker in [
        "routed KiCad board STEP with component 3D models is missing",
        "routed-board clearance rerun has not passed",
        "concept STEP envelopes are not supplier-approved geometry",
        "full CAD boolean interference report using routed board and supplier models is missing",
        "component height and courtyard data are not bound to production KiCad footprints",
    ]:
        if blocker not in integration["release_blockers"]:
            raise SystemExit(f"component height missing release blocker: {blocker}")
    if not any("supplier STEP/B-rep models" in blocker for blocker in integration["release_blockers"]):
        raise SystemExit("component height missing supplier STEP/B-rep release blocker")
    for claim in [
        "component_heights_closed",
        "supplier_step_models_loaded",
        "routed_board_step_ready",
        "routed_clearance_passed",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in integration["forbidden_claims"]:
            raise SystemExit(f"component height missing forbidden claim {claim}")
    print(
        "component height/STEP integration ok: "
        f"{len(height_models)} height models, {len(matrix)} routed-clearance reruns blocked"
    )


def check_enclosure_fit_execution_package() -> None:
    execution = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")
    manifest = load_yaml(MANIFEST)
    tolerance = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-tolerance-stack-closure.yaml")
    component_height = load_yaml(
        ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml"
    )
    supplier_intake = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml"
    )
    footprint_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    routing_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml"
    )
    power_bringup = load_yaml(
        ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml"
    )
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    module_host = load_yaml(
        ROOT / "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml"
    )
    display_camera = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml"
    )
    usb_sidekey = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml"
    )
    radio_antenna = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
    )
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    board_step = load_yaml(ROOT / "mechanical/e1-phone/review/board-step-readiness.json")
    routed_clearance = load_yaml(
        ROOT / "mechanical/e1-phone/review/routed-board-clearance.json"
    )

    if execution["schema"] != "eliza.e1_phone_enclosure_fit_execution_package.v1":
        raise SystemExit("enclosure fit execution schema diverges")
    if (
        execution["status"]
        != "blocked_requires_routed_board_step_supplier_geometry_and_physical_fit_results"
    ):
        raise SystemExit(f"unexpected enclosure fit execution status: {execution['status']}")
    rel = "board/kicad/e1-phone/enclosure-fit-execution-package.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing enclosure fit execution package")
    for source in [
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "board/kicad/e1-phone/enclosure-tolerance-stack-closure.yaml",
        "board/kicad/e1-phone/component-height-step-integration.yaml",
        "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml",
        "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml",
        "board/kicad/e1-phone/routing-acceptance-checklist.yaml",
        "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml",
        "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml",
        "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml",
        "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "mechanical/e1-phone/review/board-step-readiness.json",
        "mechanical/e1-phone/review/routed-board-clearance.json",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"enclosure fit execution missing source {source}")
        require_path(ROOT / source)

    upstream = execution["upstream_status"]
    expected_upstream = {
        "artifact_manifest_status": manifest["status"],
        "enclosure_tolerance_status": tolerance["status"],
        "component_height_status": component_height["status"],
        "supplier_intake_status": supplier_intake["status"],
        "evt1_footprint_capture_status": footprint_capture["status"],
        "routing_acceptance_status": routing_acceptance["status"],
        "power_bringup_acceptance_status": power_bringup["status"],
        "manufacturing_status": manufacturing["status"],
        "board_step_readiness_status": board_step["status"],
        "routed_board_clearance_status": routed_clearance["status"],
        "module_host_acceptance_status": module_host["status"],
    }
    for key, value in expected_upstream.items():
        if upstream[key] != value:
            raise SystemExit(f"enclosure fit execution upstream status stale: {key}")

    policy = execution["enclosure_fit_policy"]
    if policy["ready_for_enclosure_allowed"]:
        raise SystemExit("enclosure fit execution cannot allow enclosure release")
    for required_flag in [
        "requires_routed_kicad_board",
        "requires_supplier_3d_models",
        "requires_all_clearance_cases_measured",
        "requires_no_boolean_interference",
        "requires_physical_fit_and_functional_logs",
    ]:
        if policy[required_flag] is not True:
            raise SystemExit(f"enclosure fit execution missing policy flag {required_flag}")
    if policy["expected_clearance_case_count"] != routed_clearance["expected_clearance_case_count"]:
        raise SystemExit("enclosure fit execution clearance case count stale")
    if (
        policy["complete_clearance_result_count"]
        != routed_clearance["complete_clearance_result_count"]
    ):
        raise SystemExit("enclosure fit execution complete clearance count stale")

    blockers = execution["current_blockers"]
    result_cases = [item["case_id"] for item in routed_clearance["result_cases"]]
    incomplete_cases = [item["case_id"] for item in routed_clearance["result_cases"] if not item["pass"]]
    if blockers["missing_or_incomplete_clearance_cases"] != incomplete_cases:
        raise SystemExit("enclosure fit execution incomplete clearance cases stale")
    if blockers["required_height_models"] != routed_clearance["required_height_models"]:
        raise SystemExit("enclosure fit execution required height model list stale")
    if blockers["production_step_files"] != board_step["production_step_files"]:
        raise SystemExit("enclosure fit execution production STEP list stale")
    if blockers["placeholder_marker_count"] != board_step["board_state_detected"]["placeholder_marker_count"]:
        raise SystemExit("enclosure fit execution placeholder count stale")
    if blockers["has_tracks"] != manufacturing["board_state_detected"]["has_tracks"]:
        raise SystemExit("enclosure fit execution routed track state stale")
    if blockers["has_filled_zones"] != manufacturing["board_state_detected"]["has_filled_zones"]:
        raise SystemExit("enclosure fit execution zone state stale")
    if blockers["has_production_step"]:
        raise SystemExit("enclosure fit execution unexpectedly sees production STEP")
    if len(result_cases) != policy["expected_clearance_case_count"]:
        raise SystemExit("routed-board clearance result case count diverges")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    domains = {item["id"]: item for item in execution["execution_domains"]}
    expected_domains = {
        "display_touch_stack": display_camera["status"],
        "front_rear_camera_stack": display_camera["status"],
        "usb_c_side_buttons_bottom_io": usb_sidekey["status"],
        "battery_power_thermal_stack": power_bringup["status"],
        "radios_antennas_modules": radio_antenna["status"],
        "audio_haptics_split_interconnect": factory_acceptance["status"],
    }
    if set(domains) != set(expected_domains):
        raise SystemExit("enclosure fit execution domain set diverges")
    for domain_id, expected_status in expected_domains.items():
        domain = domains[domain_id]
        if domain["acceptance_status"] != expected_status:
            raise SystemExit(f"enclosure fit execution domain status stale: {domain_id}")
        if not domain["acceptance_status"].startswith("blocked_"):
            raise SystemExit(f"enclosure fit execution domain unexpectedly open: {domain_id}")
        if not domain["must_preserve"] or not domain["release_evidence_required"]:
            raise SystemExit(f"enclosure fit execution domain too weak: {domain_id}")
        for refdes in domain["placement_refs"]:
            if refdes not in placements:
                raise SystemExit(f"enclosure fit execution unknown placement ref {refdes}")
            if domain["active_regions_mm"][refdes] != placements[refdes]["region_mm"]:
                raise SystemExit(f"enclosure fit execution placement region stale: {refdes}")

    for output in [
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb",
        "board/kicad/e1-phone/production/reports/drc.json",
        "board/kicad/e1-phone/production/step/e1-phone-mainboard-routed.step",
        "mechanical/e1-phone/review/routed-board-clearance.json",
        "mechanical/e1-phone/review/full-cad-boolean-interference.json",
        "mechanical/e1-phone/review/enclosure-fit-first-article.yaml",
        "board/kicad/e1-phone/production/pdf/assembly.pdf",
    ]:
        if output not in execution["required_release_outputs"]:
            raise SystemExit(f"enclosure fit execution missing release output {output}")
    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"enclosure fit execution cross-check failed: {key}")
    for blocker in [
        "routed KiCad PCB and DRC report are missing",
        "supplier STEP or B-rep models for height-critical parts are missing",
        "routed board STEP has not been exported or imported into enclosure CAD",
        "routed-board clearance, boolean interference, and physical fit results are missing",
        "display, USB-C, side-key, camera, radio, battery, acoustic, and interconnect functional evidence is missing",
    ]:
        if blocker not in execution["release_blockers"]:
            raise SystemExit(f"enclosure fit execution missing blocker: {blocker}")
    for claim in [
        "enclosure_ready",
        "routed_board_step_ready",
        "boolean_interference_clear",
        "physical_fit_verified",
        "fabrication_ready",
        "factory_test_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(f"enclosure fit execution missing forbidden claim {claim}")
    print(
        "enclosure fit execution ok: "
        f"{len(domains)} domains, {len(incomplete_cases)} routed-board clearance cases blocked"
    )


def check_power_bringup_acceptance() -> None:
    acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml"
    )
    budget = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    sequence = load_yaml(ROOT / "board/kicad/e1-phone/power-sequence-bringup-closure.yaml")
    battery_layout = load_yaml(ROOT / "board/kicad/e1-phone/battery-layout-options.yaml")
    usb_sidekey = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    routing_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml"
    )
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    usb_pd = load_yaml(ROOT / "package/usb-pd/tps65987.yaml")
    charger = load_yaml(ROOT / "package/charger/max77860.yaml")
    pmic = load_yaml(ROOT / "package/pmic/da9063.yaml")
    battery = load_yaml(ROOT / "package/battery/e1-phone-17p3wh-pack.yaml")

    if acceptance["schema"] != "eliza.e1_phone_power_bringup_acceptance_checklist.v1":
        raise SystemExit("power bring-up acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_power_bringup_acceptance_requires_routed_schematic_first_power_charge_thermal_and_factory_evidence"
    ):
        raise SystemExit(f"unexpected power bring-up acceptance status: {acceptance['status']}")
    for source in [
        "board/kicad/e1-phone/power-thermal-budget.yaml",
        "board/kicad/e1-phone/power-sequence-bringup-closure.yaml",
        "board/kicad/e1-phone/battery-layout-options.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/routing-acceptance-checklist.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "package/usb-pd/tps65987.yaml",
        "package/charger/max77860.yaml",
        "package/pmic/da9063.yaml",
        "package/battery/e1-phone-17p3wh-pack.yaml",
    ]:
        if source not in acceptance["source_artifacts"]:
            raise SystemExit(f"power bring-up acceptance missing source {source}")
        require_path(ROOT / source)

    summary = acceptance["power_summary"]
    if summary["battery_pack_class"] != budget["battery_target"]["selected_pack_class"]:
        raise SystemExit("power bring-up acceptance battery pack class stale")
    if summary["battery_pack_class"] != battery["target_pack"]["primary_candidate"]:
        raise SystemExit("power bring-up acceptance battery pack binding stale")
    if summary["battery_energy_wh"] != budget["battery_target"]["nominal_energy_wh"]:
        raise SystemExit("power bring-up acceptance battery energy stale")
    if summary["battery_window_fit_status"] != budget["battery_target"]["battery_window_fit_status"]:
        raise SystemExit("power bring-up acceptance battery fit status stale")
    if summary["battery_layout_status"] != battery_layout["status"]:
        raise SystemExit("power bring-up acceptance battery layout status stale")
    if summary["usb_pd_controller"] != usb_pd["part"]:
        raise SystemExit("power bring-up acceptance USB-PD controller stale")
    if summary["usb_pd_binding_status"] != usb_pd["status"]:
        raise SystemExit("power bring-up acceptance USB-PD status stale")
    if summary["charger"] != charger["part"]:
        raise SystemExit("power bring-up acceptance charger stale")
    if summary["charger_binding_status"] != charger["status"]:
        raise SystemExit("power bring-up acceptance charger status stale")
    if summary["pmic"] != pmic["part"]:
        raise SystemExit("power bring-up acceptance PMIC stale")
    if summary["pmic_binding_status"] != pmic["status"]:
        raise SystemExit("power bring-up acceptance PMIC status stale")
    if summary["pd_sink_profiles"] != budget["usb_c_power_path"]["pd_sink_profiles"]:
        raise SystemExit("power bring-up acceptance PD profiles stale")
    if summary["pd_sink_profiles"] != sequence["first_power_policy"]["usb_pd_input_profiles_allowed"]:
        raise SystemExit("power bring-up acceptance first-power PD profiles stale")
    if summary["pd_power_margin_w"] != budget["usb_c_power_path"]["pd_power_margin_w"]:
        raise SystemExit("power bring-up acceptance PD margin stale")
    if summary["pd_power_margin_w"] <= 0:
        raise SystemExit("power bring-up acceptance PD margin must remain positive")
    if summary["max_charge_current_a"] != charger["charge_profile"]["charge_current_max_a"]:
        raise SystemExit("power bring-up acceptance charger current stale")
    if (
        summary["runtime_video_call_hours_target"]
        != budget["runtime_estimates_from_22p45wh_target"]["video_call_hours_at_target"]
    ):
        raise SystemExit("power bring-up acceptance runtime estimate stale")
    if summary["skin_limit_c"] != budget["power_targets"]["thermal_skin_limit_c"]:
        raise SystemExit("power bring-up acceptance skin limit stale")

    pre_power_step = next(
        item for item in sequence["rail_sequence_steps"] if item["id"] == "pre_power_shorts"
    )
    if summary["rail_test_points_required"] != pre_power_step["required_nets"]:
        raise SystemExit("power bring-up acceptance rail test points stale")
    factory_power = next(item for item in factory_probe["probe_domains"] if item["id"] == "power_rails")
    if summary["rail_test_points_required"] != factory_power["nets"]:
        raise SystemExit("power bring-up acceptance factory rail coverage stale")
    if summary["first_power_policy"] != sequence["first_power_policy"]:
        raise SystemExit("power bring-up acceptance first-power policy stale")
    if summary["package_power_sequence_status"] != sequence["package_power_sequence_status"]:
        raise SystemExit("power bring-up acceptance package sequence status stale")
    if any(value != "required_not_implemented" for value in summary["package_power_sequence_status"].values()):
        raise SystemExit("power bring-up acceptance package sequence unexpectedly implemented")
    if summary["routing_acceptance_status"] != routing_acceptance["status"]:
        raise SystemExit("power bring-up acceptance routing status stale")
    if summary["usb_sidekey_acceptance_status"] != usb_sidekey["status"]:
        raise SystemExit("power bring-up acceptance USB/side-key status stale")
    if summary["factory_probe_status"] != factory_probe["status"]:
        raise SystemExit("power bring-up acceptance factory probe status stale")

    expected_items = {
        "routed_power_schematic_and_erc",
        "usb_pd_attach_dead_battery_and_policy",
        "charger_battery_pack_ntc_id_and_safety",
        "pmic_regulator_sequence_suspend_resume",
        "high_current_layout_pi_and_load_step",
        "display_camera_radio_audio_rail_enable_logs",
        "thermal_soak_charge_modem_and_skin_limit",
        "factory_power_limits_and_first_article_transcript",
    }
    items = {item["id"]: item for item in acceptance["acceptance_items"]}
    if set(items) != expected_items:
        raise SystemExit("power bring-up acceptance item set diverges")
    for item_id, item in items.items():
        if item["status"] != "blocked_missing_routed_schematic_layout_first_power_charge_thermal_or_factory_evidence":
            raise SystemExit(f"power bring-up acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"power bring-up acceptance item too weak: {item_id}")
    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"power bring-up acceptance cross-check failed: {key}")
    for blocker in [
        "routed power schematic, ERC, supplier pinouts, and PMIC/charger/fuel-gauge footprints missing",
        "PD attach, charger, battery pack, PMIC, rail sequence, and first-power logs missing",
        "post-route PI, load-step, current density, thermal soak, and skin-temperature evidence missing",
        "factory power limits, probe coordinates, and first-article transcript missing",
    ]:
        if blocker not in acceptance["release_blockers"]:
            raise SystemExit(f"power bring-up acceptance missing blocker: {blocker}")
    for claim in [
        "first_power_ready",
        "rail_sequence_validated",
        "charging_ready",
        "battery_safe",
        "pmic_ready",
        "power_thermal_ready",
        "factory_power_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in acceptance["forbidden_claims"]:
            raise SystemExit(f"power bring-up acceptance missing forbidden claim {claim}")
    print(
        "power bring-up acceptance ok: "
        f"{len(items)} acceptance items blocked, {len(summary['rail_test_points_required'])} rail test points"
    )


def check_power_thermal_budget() -> None:
    budget = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    if budget["status"] != "blocked_power_thermal_requires_real_schematic_and_measurement":
        raise SystemExit(f"unexpected power/thermal budget status: {budget['status']}")
    if budget["missing_required_nets_by_rail"]:
        raise SystemExit(f"power/thermal rail net gaps: {budget['missing_required_nets_by_rail']}")
    usb = budget["usb_c_power_path"]
    if not usb["passes_evt0_pd_power_margin"] or usb["pd_power_margin_w"] <= 0:
        raise SystemExit(f"USB-C PD charge power margin is insufficient: {usb}")
    runtime = budget["runtime_estimates_from_22p45wh_target"]
    if runtime["video_call_hours_at_target"] < 5.0:
        raise SystemExit(f"video-call runtime target unexpectedly weak: {runtime}")
    if budget["thermal_management"]["skin_limit_c"] != 43:
        raise SystemExit("thermal skin limit must remain 43 C")
    layout = budget.get("power_layout_closure", {})
    high_current = {item["name"]: item for item in layout.get("high_current_paths", [])}
    for path in ["VBUS_to_charger", "charger_to_battery_and_sys", "RF_VBAT_to_cellular"]:
        if path not in high_current:
            raise SystemExit(f"power/thermal budget missing high-current path {path}")
        record = high_current[path]
        if len(record.get("nets", [])) < 3 or not record.get("verification_required"):
            raise SystemExit(f"power/thermal high-current path is weak: {record}")
    for rail in ["VBUS", "VBAT", "SYS", "RF_VBAT"]:
        if rail not in layout.get("minimum_bulk_capacitance_targets", {}):
            raise SystemExit(f"power/thermal budget missing bulk capacitance target {rail}")
    required_tps = ["VBUS", "VBAT", "SYS", "AON_1V8", "IO_1V8", "RF_VBAT"]
    for net in required_tps:
        if net not in layout.get("rail_test_points_required", []):
            raise SystemExit(f"power/thermal budget missing rail test point {net}")
    thermal = budget["thermal_management"]
    sensor_plan = thermal.get("sensor_placement_plan", {})
    for sensor in thermal["required_sensors"]:
        if sensor not in sensor_plan:
            raise SystemExit(f"thermal sensor placement missing {sensor}")
    spreading = thermal.get("spreading_layout_plan", {})
    if (
        "vapor_chamber_trigger" not in spreading
        or len(spreading.get("board_layout_actions", [])) < 4
    ):
        raise SystemExit(f"thermal spreading plan too weak: {spreading}")
    for status in budget["package_power_sequence_status"].values():
        if status != "required_not_implemented":
            raise SystemExit("power sequence evidence unexpectedly changed; update release gates")
    for claim in ["power_efficient", "thermal_closed", "charging_ready"]:
        if claim not in budget["must_not_claim"]:
            raise SystemExit(f"power/thermal budget missing forbidden claim {claim}")
    print(
        "power/thermal budget ok: "
        f"pd_margin={usb['pd_power_margin_w']}W "
        f"video_call={runtime['video_call_hours_at_target']}h "
        f"status={budget['status']}"
    )


def check_rf_connectivity_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    if closure["status"] != "planning_rf_connectivity_cross_checked_not_measured":
        raise SystemExit(f"unexpected RF connectivity status: {closure['status']}")
    if str(cellular["as_of"]) != "2026-05-21":
        raise SystemExit("cellular module binding public source check is stale")
    if str(wifi_bt["as_of"]) != "2026-05-21":
        raise SystemExit("Wi-Fi/Bluetooth module binding public source check is stale")
    cell_revalidation = cellular["primary_first_phone"]["public_source_revalidation"]
    if str(cell_revalidation["checked_date"]) != "2026-05-21":
        raise SystemExit("cellular public source revalidation date is stale")
    if cell_revalidation["source_type"] != "direct_quectel_vendor_page_opened":
        raise SystemExit("cellular public source type changed")
    for field in [
        "RG255C series 5G RedCap module",
        "LGA form factor and small size",
        "223 Mbps downlink and 123 Mbps uplink maximum data-rate signal",
        "USB 2.0, PCIe 2.0, PCM, UART, SGMII, and SPI interfaces",
        "Windows, Linux, and Android USB driver resources",
    ]:
        if field not in cell_revalidation["observed_public_fields"]:
            raise SystemExit(f"cellular public source missing field: {field}")
    if len(cell_revalidation["still_missing_before_use"]) < 4:
        raise SystemExit("cellular public source must remain blocked on supplier inputs")
    wifi_revalidation = wifi_bt["vendor_public_specs"]["public_source_revalidation"]
    if str(wifi_revalidation["checked_date"]) != "2026-05-21":
        raise SystemExit("Wi-Fi/Bluetooth public source revalidation date is stale")
    if wifi_revalidation["source_type"] != "direct_murata_vendor_page_opened":
        raise SystemExit("Wi-Fi/Bluetooth public source type changed")
    for field in [
        "LBEE5XV2EA-802 Type 2EA module",
        "In Production product status",
        "Infineon CYW55573 chipset",
        "Wi-Fi 6E 2x2 MIMO over 2.4 GHz, 5 GHz, and 6 GHz",
        "Bluetooth 5.3 BR/EDR/LE",
        "PCIe and SDIO Wi-Fi host interfaces",
        "12.5 x 9.4 x 1.2 mm shielded resin SMT package",
    ]:
        if field not in wifi_revalidation["observed_public_fields"]:
            raise SystemExit(f"Wi-Fi/Bluetooth public source missing field: {field}")
    if len(wifi_revalidation["still_missing_before_use"]) < 4:
        raise SystemExit("Wi-Fi/Bluetooth public source must remain blocked on supplier inputs")
    if closure["missing_required_nets"]:
        raise SystemExit(f"RF connectivity missing nets: {closure['missing_required_nets']}")
    if closure["missing_matching_networks"]:
        raise SystemExit(
            f"RF connectivity missing matching networks: {closure['missing_matching_networks']}"
        )
    if closure["missing_antenna_keepouts"] or closure["missing_mechanical_overlay_rf_keepouts"]:
        raise SystemExit("RF antenna keepouts are not consistently represented")
    interfaces = {item["name"]: item for item in closure["interfaces"]}
    for name in ["cellular_5g_redcap", "wifi6e_bluetooth_5p3"]:
        if name not in interfaces:
            raise SystemExit(f"RF connectivity missing interface {name}")
        layout = interfaces[name].get("layout_requirements", {})
        for key in ["module_placement", "antenna_plan", "coexistence_requirements"]:
            if key not in layout:
                raise SystemExit(f"RF connectivity {name} missing layout requirement {key}")
        if not layout["antenna_plan"].get("conducted_access_required_before_matching_network"):
            raise SystemExit(f"RF connectivity {name} must require conducted access")
    cellular_layout = interfaces["cellular_5g_redcap"]["layout_requirements"]
    for net in ["CELL_RF_MAIN", "CELL_RF_DIV", "CELL_GNSS_RF"]:
        if net not in cellular_layout["antenna_plan"].get("matching_required", []):
            raise SystemExit(f"cellular RF layout missing matching requirement {net}")
    wifi_layout = interfaces["wifi6e_bluetooth_5p3"]["layout_requirements"]
    for net in ["WIFI_BT_RF0", "WIFI_BT_RF1"]:
        if net not in wifi_layout["antenna_plan"].get("matching_required", []):
            raise SystemExit(f"Wi-Fi/Bluetooth RF layout missing matching requirement {net}")
    if len(closure.get("antenna_feed_assignments", [])) != len(closure["required_rf_nets"]):
        raise SystemExit("RF closure antenna feed assignments do not cover every RF net")
    for item in closure.get("antenna_feed_assignments", []):
        if item["net"] not in closure["required_rf_nets"] or not item["requires_conducted_access"]:
            raise SystemExit(f"RF antenna feed assignment is weak: {item}")
    matrix = closure.get("coexistence_test_matrix", [])
    if len(matrix) < 4:
        raise SystemExit("RF closure coexistence matrix is too small")
    for case in [
        "cellular_tx_vs_wifi_bt",
        "cellular_tx_vs_gnss",
        "wifi_2x2_vs_cellular_antennas",
        "charger_display_noise_vs_radios",
    ]:
        if case not in {item["case"] for item in matrix}:
            raise SystemExit(f"RF closure missing coexistence case {case}")
    for claim in ["rf_ready", "cellular_ready", "wifi_ready", "carrier_ready", "sar_ready"]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"RF closure missing forbidden claim {claim}")
    measurements = closure["required_measurements_before_release"]
    for required in ["VNA", "SAR", "carrier"]:
        if not any(required in item for item in measurements):
            raise SystemExit(f"RF closure missing measurement requirement containing {required}")
    print(
        "rf connectivity ok: "
        f"{len(interfaces)} radio interfaces, {len(closure['required_rf_nets'])} RF nets, "
        "measurement release blockers preserved"
    )


def check_rf_antenna_coexistence_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/rf-antenna-coexistence-closure.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    overlay = load_yaml(ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    manifest = load_yaml(MANIFEST)

    if closure["schema"] != "eliza.e1_phone_rf_antenna_coexistence_closure.v1":
        raise SystemExit("RF antenna coexistence closure schema diverges")
    if closure["status"] != "blocked_requires_vendor_rf_review_routed_layout_and_measured_antenna_data":
        raise SystemExit(f"unexpected RF antenna coexistence status: {closure['status']}")
    if "board/kicad/e1-phone/rf-antenna-coexistence-closure.yaml" not in manifest[
        "current_artifacts"
    ]["planning"]:
        raise SystemExit("manifest missing RF antenna coexistence closure")
    for source in [
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/mechanical-overlay.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/module-host-integration-closure.yaml",
        "board/kicad/e1-phone/power-sequence-bringup-closure.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "package/cellular/quectel-5g-redcap.yaml",
        "package/wifi/murata-type-2ea-wifi6e.yaml",
        "docs/board/e1-phone-enclosure-interface.yaml",
    ]:
        if source not in closure["source_artifacts"]:
            raise SystemExit(f"RF antenna coexistence closure missing source {source}")
        require_path(ROOT / source)

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    rf_nets = set(rf["required_rf_nets"])
    feeds = {item["net"]: item for item in closure["antenna_feed_plan"]}
    if set(feeds) != rf_nets:
        raise SystemExit("RF antenna feed plan diverges from RF connectivity required nets")
    if rf_nets - block_nets:
        raise SystemExit(f"RF antenna closure references missing block nets: {sorted(rf_nets - block_nets)}")

    keepouts = {item["id"]: item for item in overlay["keepouts"]}
    required_keepouts = {"top_antenna_keepout", "bottom_antenna_keepout", "wifi_bt_side_antenna_keepout"}
    if not required_keepouts.issubset(keepouts):
        raise SystemExit("RF antenna closure missing mechanical RF keepouts")
    for feed in feeds.values():
        if feed["keepout_ref"] not in keepouts:
            raise SystemExit(f"RF antenna feed keepout missing from mechanical overlay: {feed['net']}")
        for key in ["matching_network_required", "conducted_access_required", "factory_calibration_required"]:
            if feed[key] is not True:
                raise SystemExit(f"RF antenna feed missing {key}: {feed['net']}")
        if not feed["status"].startswith("blocked_"):
            raise SystemExit(f"RF antenna feed unexpectedly open: {feed['net']}")

    matching_nets = {item["net"] for item in routing["rf_layout"]["matching_networks_required"]}
    if matching_nets != rf_nets:
        raise SystemExit("RF antenna matching networks diverge from routing constraints")
    rf_class = routing["impedance_classes"]["rf_single"]
    if rf_class["impedance_ohm"] != 50:
        raise SystemExit("RF antenna closure requires 50 ohm RF net class")
    if set(rf_class["applies_to"]) != rf_nets:
        raise SystemExit("RF net class does not cover every RF feed")

    factory_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    if not rf_nets.issubset(set(factory_domains["radios"]["nets"])):
        raise SystemExit("factory probe radio domain does not cover all RF feeds")
    if set(production["factory_test_coverage_required"]["radios"]) != set(factory_domains["radios"]["nets"]):
        raise SystemExit("RF antenna closure factory coverage diverges from production readiness")
    if routed_release["required_release_output_manifest"]["rf_reports"]["expected_path"] != (
        "board/kicad/e1-phone/production/reports/rf"
    ):
        raise SystemExit("RF release report path changed")

    public = closure["public_source_refresh"]
    if public["cellular"]["vendor"] != cellular["primary_first_phone"]["vendor"]:
        raise SystemExit("RF antenna cellular source vendor stale")
    if public["wifi_bluetooth"]["primary"] != wifi_bt["vendor_public_specs"]["order_number"]:
        raise SystemExit("RF antenna Wi-Fi/Bluetooth source order number stale")
    if len(public["cellular"]["observed_public_fields"]) < 6:
        raise SystemExit("RF antenna cellular public fields too weak")
    if len(public["wifi_bluetooth"]["observed_public_fields"]) < 7:
        raise SystemExit("RF antenna Wi-Fi/Bluetooth public fields too weak")

    if len(closure["required_isolation_and_tuning_evidence"]) < 7:
        raise SystemExit("RF antenna isolation/tuning evidence list too weak")
    if len(closure["firmware_regulatory_artifacts_required"]) < 6:
        raise SystemExit("RF firmware/regulatory evidence list too weak")
    for output in [
        "board/kicad/e1-phone/production/test/rf-calibration-procedure.pdf",
        "board/kicad/e1-phone/production/test/factory-test-limits.yaml",
        "board/kicad/e1-phone/production/test/first-article-test-transcript.json",
        "board/kicad/e1-phone/production/reports/rf/vna-s11-s21.json",
        "board/kicad/e1-phone/production/reports/rf/coexistence-matrix.json",
        "board/kicad/e1-phone/production/reports/rf-antenna-coexistence-closure.yaml",
    ]:
        if output not in closure["factory_rf_outputs_required"]:
            raise SystemExit(f"RF antenna closure missing factory RF output {output}")

    for key, value in closure["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"RF antenna coexistence cross-check failed: {key}")
    for blocker in [
        "antenna vendor review and tuned matching values are missing",
        "routed 50 ohm RF feed geometry, via fence, return path, and conducted access are missing",
        "VNA S11/S21, conducted RF, coexistence, GNSS desense, and SAR pre-scan evidence are missing",
        "factory RF calibration procedure, test limits, and first-article transcript are missing",
    ]:
        if blocker not in closure["release_blockers"]:
            raise SystemExit(f"RF antenna coexistence closure missing blocker: {blocker}")
    for claim in [
        "rf_ready",
        "antenna_tuned",
        "cellular_ready",
        "wifi_ready",
        "bluetooth_ready",
        "gnss_ready",
        "carrier_ready",
        "sar_ready",
        "regulatory_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"RF antenna coexistence closure missing forbidden claim {claim}")
    print(
        "RF antenna/coexistence closure ok: "
        f"{len(feeds)} feeds, {len(closure['factory_rf_outputs_required'])} RF outputs blocked"
    )


def check_audio_acoustic_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/audio-acoustic-closure.yaml")
    if closure["status"] != "planning_audio_acoustic_cross_checked_not_measured":
        raise SystemExit(f"unexpected audio/acoustic status: {closure['status']}")
    if closure["missing_required_nets"]:
        raise SystemExit(f"audio/acoustic closure missing nets: {closure['missing_required_nets']}")
    if closure["missing_routing_buses"] or closure["routing_missing_nets"]:
        raise SystemExit(
            "audio/acoustic closure has incomplete routing buses: "
            f"{closure['missing_routing_buses']} {closure['routing_missing_nets']}"
        )
    constraints = closure["acoustic_constraints_found"]
    for name, present in constraints.items():
        if not present:
            raise SystemExit(f"audio/acoustic enclosure constraint missing: {name}")
    if closure["missing_mechanical_keepouts"]:
        raise SystemExit(
            f"audio/acoustic mechanical keepouts missing: {closure['missing_mechanical_keepouts']}"
        )
    if closure["missing_supplier_evidence_records"]:
        raise SystemExit(
            "audio/acoustic freeze record missing supplier evidence fields: "
            f"{closure['missing_supplier_evidence_records']}"
        )
    components = closure["audio_components"]
    if components["microphone_count"] < 2:
        raise SystemExit("audio/acoustic closure must preserve at least two microphones")
    for claim in [
        "audio_ready",
        "speaker_ready",
        "microphone_ready",
        "haptics_ready",
        "audio_hal_ready",
        "acoustic_enclosure_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"audio/acoustic closure missing forbidden claim {claim}")
    print(
        "audio/acoustic closure ok: "
        f"{len(closure['required_audio_nets'])} nets, "
        f"{components['microphone_count']} microphones, codec={components['codec']}"
    )


def check_manufacturing_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    required_rf_nets = [item["net"] for item in routing["rf_layout"]["matching_networks_required"]]
    if closure["status"] != "blocked_manufacturing_requires_routed_pcb_and_fab_outputs":
        raise SystemExit(f"unexpected manufacturing closure status: {closure['status']}")
    if (
        closure["required_test_points_from_routing_constraints"]
        != routing["power_integrity"]["test_points_required"]
    ):
        raise SystemExit("manufacturing closure test-point list diverges from routing constraints")
    state = closure["board_state_detected"]
    for key in [
        "has_tracks",
        "has_filled_zones",
        "has_production_outputs",
    ]:
        if state[key]:
            raise SystemExit(
                f"manufacturing closure detected {key}; update release evidence instead of "
                "leaving the concept fail-closed gate unchanged"
            )
    for key in [
        "has_kicad_footprints",
        "has_test_point_footprints",
        "has_fiducials",
        "has_mounting_holes",
    ]:
        if not state[key]:
            raise SystemExit(f"manufacturing closure expected PCB implementation scaffold {key}")
    scaffold = closure["non_release_pcb_implementation_scaffold"]
    if scaffold["status"] != "placeholder_footprints_parse_and_render_not_fabrication_footprints":
        raise SystemExit(f"unexpected PCB implementation scaffold status: {scaffold['status']}")
    if scaffold["placement_placeholder_footprints"] < 10:
        raise SystemExit(f"too few placement placeholder footprints: {scaffold}")
    if scaffold["testpoint_placeholders"] != len(
        closure["required_test_points_from_routing_constraints"]
    ):
        raise SystemExit(
            f"testpoint placeholder count diverges from routing constraints: {scaffold}"
        )
    if scaffold["fiducial_placeholders"] < 3 or scaffold["mounting_hole_placeholders"] < 4:
        raise SystemExit(f"fiducial/mounting scaffold is incomplete: {scaffold}")
    if scaffold["rf_matching_placeholders"] != len(required_rf_nets):
        raise SystemExit(
            f"RF matching placeholder count diverges from routing constraints: {scaffold}"
        )
    if scaffold["rf_conducted_test_placeholders"] != len(required_rf_nets):
        raise SystemExit(
            f"RF conducted test placeholder count diverges from routing constraints: {scaffold}"
        )
    if scaffold["rf_matching_nets_assigned"] != required_rf_nets:
        raise SystemExit(
            f"RF matching/test placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["usb_c_protection_placeholders"] < 3:
        raise SystemExit(f"USB-C protection scaffold is incomplete: {scaffold}")
    if scaffold["usb_c_signal_test_placeholders"] < 5:
        raise SystemExit(f"USB-C signal test scaffold is incomplete: {scaffold}")
    if scaffold["side_key_support_placeholders"] < 4:
        raise SystemExit(f"side-key ESD/debounce scaffold is incomplete: {scaffold}")
    if scaffold["usb_c_support_nets_assigned"] != [
        "VBUS",
        "USB_CC1",
        "USB_CC2",
        "USB_DP",
        "USB_DN",
    ]:
        raise SystemExit(
            f"USB-C support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["display_support_placeholders"] < 3:
        raise SystemExit(f"display/touch support scaffold is incomplete: {scaffold}")
    if scaffold["camera_support_placeholders"] < 4:
        raise SystemExit(f"camera support scaffold is incomplete: {scaffold}")
    if scaffold["display_support_nets_assigned"] != [
        "DSI_CLK_P",
        "DSI_D0_P",
        "DISP_AVDD_5V5",
        "DISP_AVEE_N5V5",
        "DISP_BL_EN",
        "DISP_BL_PWM",
        "DISP_RESET_N",
        "TOUCH_I2C_SCL",
        "TOUCH_I2C_SDA",
    ]:
        raise SystemExit(
            f"display support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["camera_support_nets_assigned"] != [
        "CAM0_CSI_CLK_P",
        "CAM1_CSI_CLK_P",
        "CAM_AVDD_2V8",
        "CAM_DVDD_1V2",
        "CAM0_RESET_N",
        "CAM1_RESET_N",
        "CAM0_PWDN",
        "CAM0_I2C_SCL",
        "CAM1_I2C_SCL",
    ]:
        raise SystemExit(
            f"camera support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["audio_support_placeholders"] < 6:
        raise SystemExit(f"audio support scaffold is incomplete: {scaffold}")
    if scaffold["haptic_support_placeholders"] < 1:
        raise SystemExit(f"haptic support scaffold is incomplete: {scaffold}")
    if scaffold["power_management_support_placeholders"] < 12:
        raise SystemExit(f"power management support scaffold is incomplete: {scaffold}")
    if scaffold["compute_storage_support_placeholders"] < 6:
        raise SystemExit(f"compute/storage support scaffold is incomplete: {scaffold}")
    if scaffold["identity_sensor_support_placeholders"] < 6:
        raise SystemExit(f"SIM/eSIM/NFC/sensor support scaffold is incomplete: {scaffold}")
    if scaffold["audio_support_nets_assigned"] != [
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
    ]:
        raise SystemExit(
            f"audio support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["haptic_support_nets_assigned"] != ["HAPTIC_OUT", "SYS", "IO_1V8"]:
        raise SystemExit(
            f"haptic support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["power_management_support_nets_assigned"] != [
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
    ]:
        raise SystemExit(
            f"power management support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["compute_storage_support_nets_assigned"] != [
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
    ]:
        raise SystemExit(
            f"compute/storage support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["identity_sensor_support_nets_assigned"] != [
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
    ]:
        raise SystemExit(
            f"SIM/eSIM/NFC/sensor support placeholders are not assigned to required nets: {scaffold}"
        )
    if scaffold["declared_net_count"] < 180:
        raise SystemExit(f"PCB implementation scaffold has too few declared nets: {scaffold}")
    if scaffold["generated_net_class_count"] < 10:
        raise SystemExit(f"PCB implementation scaffold has too few KiCad net classes: {scaffold}")
    if scaffold["assigned_pad_net_count"] < 80:
        raise SystemExit(
            f"PCB implementation scaffold pads are not sufficiently netted: {scaffold}"
        )
    if (
        scaffold["testpoint_nets_assigned"]
        != closure["required_test_points_from_routing_constraints"]
    ):
        raise SystemExit(f"testpoint pads are not assigned to required nets: {scaffold}")
    if not state["kibot_outputs_are_skeleton_commented"]:
        raise SystemExit("manufacturing closure expects kibot outputs to remain a skeleton")
    outputs = closure["production_outputs"]
    required_outputs = {
        "gerber_x2",
        "ipc_2581",
        "drill",
        "bom_csv_or_ibom",
        "pick_and_place",
        "step",
        "schematic_pdf",
        "layout_pdf",
        "assembly_drawing",
        "dfm_dfa_report",
        "fab_quote",
    }
    missing_outputs = sorted(required_outputs - set(outputs))
    if missing_outputs:
        raise SystemExit(f"manufacturing closure missing output records: {missing_outputs}")
    present = [name for name, item in outputs.items() if item["present"]]
    if present:
        raise SystemExit(f"manufacturing closure found production outputs unexpectedly: {present}")
    for blocker in [
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
    ]:
        if blocker not in closure["release_blockers"]:
            raise SystemExit(f"manufacturing closure missing release blocker {blocker}")
    scaffold = closure["non_release_pcb_implementation_scaffold"]
    if scaffold["split_interconnect_placeholders"] != 2:
        raise SystemExit("manufacturing closure must see both split interconnect placeholders")
    for net in ["USB_DP", "USB_DN", "VBUS", "SYS", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"]:
        if net not in scaffold["split_interconnect_nets_assigned"]:
            raise SystemExit(f"manufacturing closure split interconnect missing net {net}")
    for claim in [
        "manufacturing_ready",
        "fabrication_ready",
        "dfm_ready",
        "assembly_ready",
        "test_ready",
        "enclosure_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"manufacturing closure missing forbidden claim {claim}")
    print(
        "manufacturing closure ok: "
        f"{len(outputs)} production outputs blocked, "
        f"{len(closure['required_test_points_from_routing_constraints'])} test points required"
    )


def check_production_readiness() -> None:
    readiness = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    closure = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    rfq = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    rfq_drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    supplier_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")

    if readiness["status"] != "blocked_requires_routed_board_supplier_data_and_factory_quotes":
        raise SystemExit(f"unexpected production readiness status: {readiness['status']}")
    if readiness["stackup_request"]["target"] != routing["stackup"]["target"]:
        raise SystemExit("production readiness stackup target diverges from routing constraints")
    if readiness["stackup_request"]["evt0_minimum"] != routing["stackup"]["evt0_minimum"]:
        raise SystemExit("production readiness EVT0 stackup diverges from routing constraints")
    if readiness["stackup_request"]["board_thickness_mm"] != 0.8:
        raise SystemExit("production readiness must preserve 0.8 mm board target")
    if "board/kicad/e1-phone/manufacturing-closure.yaml" not in readiness["source_artifacts"]:
        raise SystemExit("production readiness must cite manufacturing closure")
    if "board/kicad/e1-phone/production-readiness.yaml" not in closure["source_artifacts"]:
        raise SystemExit("manufacturing closure must cite production readiness")
    for source in [
        "board/kicad/e1-phone/supplier-rfq-intake.yaml",
        "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml",
        "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
    ]:
        if source not in readiness["source_artifacts"]:
            raise SystemExit(f"production readiness missing supplier source {source}")

    if "RFQs sent and supplier response packs archived for every high-risk function" not in readiness[
        "board_revision_policy"
    ]["revision_lock_requires"]:
        raise SystemExit("production readiness missing RFQ archive revision lock")
    if rfq["status"] != "blocked_waiting_supplier_quote_drawing_sample_and_approval_packs":
        raise SystemExit("production readiness RFQ intake status unexpectedly changed")
    if rfq_drafts["status"] != "drafts_prepared_not_sent_not_supplier_evidence":
        raise SystemExit("production readiness RFQ draft status unexpectedly changed")
    if supplier_map["status"] != "blocked_supplier_evidence_not_ready_for_kicad_capture":
        raise SystemExit("production readiness supplier evidence status unexpectedly changed")

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))

    for group_name, item in readiness["impedance_coupon_plan"].items():
        if not item["coupon_required"]:
            raise SystemExit(f"production readiness coupon not required for {group_name}")
        missing = sorted(net for net in item["nets"] if net not in block_nets)
        if missing:
            raise SystemExit(f"production readiness coupon {group_name} missing nets {missing}")
    if len(readiness["impedance_coupon_plan"]) < 5:
        raise SystemExit("production readiness has too few impedance coupon groups")
    if "split_board_flex_usb2_audio" not in readiness["impedance_coupon_plan"]:
        raise SystemExit("production readiness missing split-board flex coupon group")
    for net in ["USB_DP", "USB_DN", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"]:
        if net not in readiness["impedance_coupon_plan"]["split_board_flex_usb2_audio"]["nets"]:
            raise SystemExit(f"split-board flex coupon group missing net {net}")

    coverage = readiness["factory_test_coverage_required"]
    required_coverage = {
        "power_rails",
        "usb_c",
        "display_touch",
        "cameras",
        "radios",
        "audio_haptics",
        "split_board_interconnect",
        "buttons_sensors_nfc",
        "compute_storage_debug",
    }
    missing_coverage = sorted(required_coverage - set(coverage))
    if missing_coverage:
        raise SystemExit(f"production readiness missing factory coverage {missing_coverage}")
    for group_name, nets in coverage.items():
        missing = sorted(net for net in nets if net not in block_nets)
        if missing:
            raise SystemExit(f"production readiness coverage {group_name} missing nets {missing}")
    if coverage["power_rails"] != closure["required_test_points_from_routing_constraints"]:
        raise SystemExit(
            "production readiness power rail test coverage diverges from routing constraints"
        )

    for required in [
        "Gerber X2 or IPC-2581 with stackup notes",
        "production BOM/AVL with MPN, lifecycle, MOQ, lead time, and substitutes",
        "split-board interconnect assembly drawing with mating order, stiffener, strain relief, and inspection notes",
        "DFM/DFA report from selected fab and assembler",
        "first-article traveler, current-limit table, and stop-on-fail instructions",
    ]:
        if required not in readiness["production_output_requirements"]:
            raise SystemExit(f"production readiness missing output requirement: {required}")
    for blocker in [
        "real supplier footprints and pinouts missing",
        "routed copper and filled zones missing",
        "ERC/DRC evidence missing",
        "factory test fixture and probe map missing",
    ]:
        if blocker not in readiness["release_blockers"]:
            raise SystemExit(f"production readiness missing release blocker: {blocker}")
    for net in ["USB_DP", "USB_DN", "VBUS", "SYS", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"]:
        if net not in coverage["split_board_interconnect"]:
            raise SystemExit(f"production readiness split-board test coverage missing net {net}")
    for claim in [
        "production_ready",
        "enclosure_ready",
        "fabrication_ready",
        "assembly_ready",
        "factory_test_ready",
        "impedance_closed",
    ]:
        if claim not in readiness["forbidden_claims"]:
            raise SystemExit(f"production readiness missing forbidden claim {claim}")
    print(
        "production readiness ok: "
        f"{len(readiness['impedance_coupon_plan'])} coupon groups, "
        f"{len(coverage)} factory-test coverage groups, release blocked"
    )


def check_factory_probe_map() -> None:
    probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    power = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    interconnect = load_yaml(ROOT / "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml")
    manifest = load_yaml(MANIFEST)

    if probe["schema"] != "eliza.e1_phone_factory_probe_map.v1":
        raise SystemExit(f"unexpected factory probe map schema: {probe['schema']}")
    if probe["status"] != "blocked_requires_routed_board_fixture_and_first_article_limits":
        raise SystemExit(f"unexpected factory probe map status: {probe['status']}")
    if "board/kicad/e1-phone/factory-probe-map.yaml" not in manifest["current_artifacts"][
        "planning"
    ]:
        raise SystemExit("manifest missing factory probe map artifact")
    for rel in probe["source_artifacts"]:
        require_path(ROOT / rel)
    for source in [
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/power-thermal-budget.yaml",
        "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml",
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
    ]:
        if source not in probe["source_artifacts"]:
            raise SystemExit(f"factory probe map missing source {source}")

    policy = probe["fixture_policy"]
    if policy["fixture_release_requires_routed_pcb"] is not True:
        raise SystemExit("factory probe fixture release must require routed PCB")
    if policy["probe_coordinates_source"] != "routed_kicad_pcb_after_DRC_clean":
        raise SystemExit("factory probe coordinates source must remain routed-PCB gated")
    if policy["stop_on_fail_required"] is not True:
        raise SystemExit("factory probe map must require stop-on-fail")
    for traceability_key in [
        "board_serial",
        "imei_or_modem_identifier",
        "wifi_mac",
        "bluetooth_mac",
        "secure_key_provisioning_result",
        "fixture_id",
        "test_software_revision",
    ]:
        if traceability_key not in policy["operator_visible_traceability_required"]:
            raise SystemExit(f"factory probe map missing traceability key {traceability_key}")
    for output in [
        "board/kicad/e1-phone/production/test/factory-test-limits.yaml",
        "board/kicad/e1-phone/production/test/probe-coordinates.csv",
        "board/kicad/e1-phone/production/test/ict-or-flying-probe-program",
        "board/kicad/e1-phone/production/test/rf-calibration-procedure.pdf",
        "board/kicad/e1-phone/production/test/first-article-test-transcript.json",
    ]:
        if output not in policy["outputs_required_before_release"]:
            raise SystemExit(f"factory probe map missing release output {output}")

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))

    domains = {item["id"]: item for item in probe["probe_domains"]}
    if set(domains) != set(production["factory_test_coverage_required"]):
        raise SystemExit("factory probe domains diverge from production readiness coverage")
    if len(domains) != 9:
        raise SystemExit(f"factory probe expected 9 domains, got {len(domains)}")
    for domain_id, item in domains.items():
        coverage_nets = production["factory_test_coverage_required"][domain_id]
        if item["nets"] != coverage_nets:
            raise SystemExit(f"factory probe domain nets diverge from production: {domain_id}")
        missing = sorted(net for net in item["nets"] if net not in block_nets)
        if missing:
            raise SystemExit(f"factory probe domain {domain_id} references missing nets {missing}")
        if not item["method"] or not item["expected_limits_source"]:
            raise SystemExit(f"factory probe domain missing method/limits source: {domain_id}")
        if len(item["required_checks"]) < 5:
            raise SystemExit(f"factory probe domain has weak required checks: {domain_id}")
        if not item["release_status"].startswith("blocked_"):
            raise SystemExit(f"factory probe domain unexpectedly open: {domain_id}")

    if domains["power_rails"]["nets"] != manufacturing["required_test_points_from_routing_constraints"]:
        raise SystemExit("factory probe power rail nets diverge from manufacturing test points")
    if domains["power_rails"]["nets"] != production["factory_test_coverage_required"]["power_rails"]:
        raise SystemExit("factory probe power rail nets diverge from production coverage")
    if set(domains["radios"]["nets"][:5]) != set(rf["required_rf_nets"]):
        raise SystemExit("factory probe radio RF nets diverge from RF closure")
    route_pair_names = {pair["name"] for pair in routing["differential_pairs"]}
    for pair_name in ["USB_DP_DN", "DSI_CLK", "CAM0_CSI_CLK", "CAM1_CSI_CLK"]:
        if pair_name not in route_pair_names:
            raise SystemExit(f"factory probe expected route pair missing: {pair_name}")
    split_nets = set(domains["split_board_interconnect"]["nets"])
    interconnect_nets = set()
    for bus in interconnect["cross_island_buses"]:
        interconnect_nets.update(bus["nets"])
    for net in ["USB_DP", "USB_DN", "VBUS", "SYS", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"]:
        if net not in split_nets or net not in interconnect_nets:
            raise SystemExit(f"factory probe split interconnect missing cross-island net {net}")
    if power["status"] != "blocked_power_thermal_requires_real_schematic_and_measurement":
        raise SystemExit("factory probe power/thermal status unexpectedly changed")

    for key, value in probe["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"factory probe map cross-check failed: {key}")
    for blocker in [
        "routed PCB probe coordinates missing",
        "fixture and pogo-pin accessibility not validated against enclosure and component heights",
        "factory-test limits not derived from first article measurements",
        "RF conducted and shield-box procedures not approved",
        "secure provisioning and traceability flow not implemented",
    ]:
        if blocker not in probe["release_blockers"]:
            raise SystemExit(f"factory probe map missing blocker: {blocker}")
    for claim in [
        "factory_test_ready",
        "fixture_ready",
        "probe_map_released",
        "first_article_limits_ready",
        "RF_calibration_ready",
        "production_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in probe["forbidden_claims"]:
            raise SystemExit(f"factory probe map missing forbidden claim {claim}")
    print(f"factory probe map ok: {len(domains)} domains, {len(block_nets)} block-netlist nets")


def check_factory_production_acceptance() -> None:
    acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    routing_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml"
    )
    power_bringup = load_yaml(
        ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml"
    )
    supplier = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")

    if acceptance["schema"] != "eliza.e1_phone_factory_production_acceptance_checklist.v1":
        raise SystemExit("factory production acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_factory_production_acceptance_requires_routed_outputs_fixture_limits_quotes_and_first_article"
    ):
        raise SystemExit(
            f"unexpected factory production acceptance status: {acceptance['status']}"
        )
    for source in [
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/routing-acceptance-checklist.yaml",
        "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml",
        "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/production-factory-release-execution.yaml",
    ]:
        if source not in acceptance["source_artifacts"]:
            raise SystemExit(f"factory production acceptance missing source {source}")

    summary = acceptance["factory_production_summary"]
    expected_statuses = {
        "production_readiness_status": production["status"],
        "manufacturing_status": manufacturing["status"],
        "factory_probe_status": factory_probe["status"],
        "routing_acceptance_status": routing_acceptance["status"],
        "power_bringup_acceptance_status": power_bringup["status"],
        "supplier_evidence_status": supplier["status"],
        "routed_release_status": routed_release["status"],
    }
    for key, value in expected_statuses.items():
        if summary[key] != value:
            raise SystemExit(f"factory production acceptance summary stale: {key}")
    if summary["release_target"] != routed_release["release_target"]:
        raise SystemExit("factory production acceptance release target diverges")
    if summary["stackup_target"] != production["stackup_request"]["target"]:
        raise SystemExit("factory production acceptance stackup target diverges")
    if summary["board_thickness_mm"] != production["stackup_request"]["board_thickness_mm"]:
        raise SystemExit("factory production acceptance board thickness diverges")
    if summary["impedance_coupon_group_count"] != len(production["impedance_coupon_plan"]):
        raise SystemExit("factory production acceptance coupon count stale")
    if (
        summary["factory_coverage_group_count"]
        != len(production["factory_test_coverage_required"])
    ):
        raise SystemExit("factory production acceptance coverage count stale")
    if summary["required_production_output_count"] != len(
        production["production_output_requirements"]
    ):
        raise SystemExit("factory production acceptance production output count stale")
    if summary["manufacturing_output_count"] != len(manufacturing["production_outputs"]):
        raise SystemExit("factory production acceptance manufacturing output count stale")

    blocked_outputs = sorted(
        name
        for name, item in manufacturing["production_outputs"].items()
        if not item["present"] and item["required_before_release"]
    )
    if summary["manufacturing_outputs_present"] != []:
        raise SystemExit("factory production acceptance unexpectedly sees outputs present")
    if summary["manufacturing_outputs_blocked"] != blocked_outputs:
        raise SystemExit("factory production acceptance blocked output list stale")

    probe_domain_ids = [item["id"] for item in factory_probe["probe_domains"]]
    if summary["factory_probe_domain_count"] != len(probe_domain_ids):
        raise SystemExit("factory production acceptance probe domain count stale")
    if summary["factory_probe_domain_ids"] != probe_domain_ids:
        raise SystemExit("factory production acceptance probe domain ids stale")
    if summary["factory_probe_domains_blocked"] != probe_domain_ids:
        raise SystemExit("factory production acceptance blocked probe domain ids stale")
    if set(probe_domain_ids) != set(production["factory_test_coverage_required"]):
        raise SystemExit("factory probe domains diverge from production coverage")
    if (
        summary["fixture_traceability_fields"]
        != factory_probe["fixture_policy"]["operator_visible_traceability_required"]
    ):
        raise SystemExit("factory production acceptance traceability fields stale")
    if (
        summary["fixture_outputs_required"]
        != factory_probe["fixture_policy"]["outputs_required_before_release"]
    ):
        raise SystemExit("factory production acceptance fixture outputs stale")
    if summary["routed_release_ready_flags"] != {
        "ready_to_fabricate": routed_release["ready_to_fabricate"],
        "ready_for_enclosure": routed_release["ready_for_enclosure"],
        "ready_for_factory_test": routed_release["ready_for_factory_test"],
    }:
        raise SystemExit("factory production acceptance routed release flags stale")
    if any(summary["routed_release_ready_flags"].values()):
        raise SystemExit("factory production acceptance cannot see release flags true")

    expected_acceptance_ids = {
        "fabricator_stackup_impedance_and_coupon_quote",
        "fabrication_outputs_gerber_ipc_drill",
        "assembly_outputs_bom_pnp_drawings_stencil",
        "supplier_avl_lifecycle_and_substitutes",
        "fixture_probe_coordinates_and_accessibility",
        "factory_test_limits_and_stop_on_fail",
        "rf_calibration_and_wireless_identity_traceability",
        "first_article_traveler_measurements_and_signoff",
        "routed_board_step_dfa_enclosure_and_dfm_quote",
    }
    acceptance_items = {item["id"]: item for item in acceptance["acceptance_items"]}
    if set(acceptance_items) != expected_acceptance_ids:
        raise SystemExit("factory production acceptance item set diverges")
    for item_id, item in acceptance_items.items():
        if item["status"] != "blocked_missing_routed_outputs_fixture_limits_quotes_or_first_article_evidence":
            raise SystemExit(f"factory production acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"factory production acceptance item too weak: {item_id}")

    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"factory production acceptance cross-check failed: {key}")
    for blocker in [
        "routed DRC-clean PCB and production fabrication outputs are missing",
        "production BOM/AVL, pick-and-place, assembly drawings, stencil, and supplier approval packs are missing",
        "factory fixture coordinates, factory limits, RF calibration, traceability, and first-article transcript are missing",
        "routed board STEP, enclosure clearance rerun, and final mechanical production signoff are missing",
    ]:
        if blocker not in acceptance["release_blockers"]:
            raise SystemExit(f"factory production acceptance missing blocker: {blocker}")
    for claim in [
        "production_ready",
        "fabrication_ready",
        "assembly_ready",
        "factory_test_ready",
        "fixture_ready",
        "first_article_ready",
        "impedance_closed",
        "bom_avl_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in acceptance["forbidden_claims"]:
            raise SystemExit(f"factory production acceptance missing forbidden claim {claim}")
    print(
        "factory production acceptance ok: "
        f"{len(acceptance_items)} acceptance items, {len(probe_domain_ids)} probe domains blocked"
    )


def check_production_factory_release_execution() -> None:
    execution = load_yaml(
        ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml"
    )
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    supplier = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    routed_pcb = load_yaml(
        ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if execution["schema"] != "eliza.e1_phone_production_factory_release_execution.v1":
        raise SystemExit("production/factory release execution schema diverges")
    if (
        execution["status"]
        != "blocked_requires_routed_release_supplier_packs_fab_assembly_fixture_and_first_article"
    ):
        raise SystemExit(f"unexpected production/factory release status: {execution['status']}")
    if (
        "board/kicad/e1-phone/production-factory-release-execution.yaml"
        not in manifest["current_artifacts"]["planning"]
    ):
        raise SystemExit("manifest missing production/factory release execution artifact")
    for source in [
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
        "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"production/factory release execution missing source {source}")
        require_path(ROOT / source)

    expected_status = {
        "production_readiness_status": production["status"],
        "manufacturing_status": manufacturing["status"],
        "factory_production_acceptance_status": factory_acceptance["status"],
        "routed_release_status": routed_release["status"],
        "factory_probe_status": factory_probe["status"],
        "supplier_evidence_status": supplier["status"],
        "routed_pcb_implementation_status": routed_pcb["status"],
    }
    if execution["upstream_status"] != expected_status:
        raise SystemExit("production/factory release execution upstream status stale")

    policy = execution["execution_policy"]
    if policy["release_revision"] != routed_release["release_target"]:
        raise SystemExit("production/factory release execution release target diverges")
    for key in [
        "fabrication_output_generation_requires_routed_pcb",
        "assembly_output_generation_requires_supplier_avl_and_bom",
        "fixture_release_requires_probe_coordinates_from_routed_pcb",
        "factory_limits_require_first_article_measurements",
        "enclosure_release_requires_routed_board_step_with_supplier_models",
        "all_outputs_fail_closed_until_present",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"production/factory release execution policy must require {key}")

    acceptance_items = {item["id"] for item in factory_acceptance["acceptance_items"]}
    release_outputs = {item["id"]: item for item in execution["release_output_execution"]}
    if set(release_outputs) != set(routed_release["required_release_output_manifest"]):
        raise SystemExit("production/factory release output execution diverges from release plan")
    for output_id, item in release_outputs.items():
        plan_item = routed_release["required_release_output_manifest"][output_id]
        if item["owner"] != plan_item["owner"]:
            raise SystemExit(f"production/factory release owner stale: {output_id}")
        if item["expected_path"] != plan_item["expected_path"]:
            raise SystemExit(f"production/factory release output path stale: {output_id}")
        if item["release_required"] != plan_item["release_required"]:
            raise SystemExit(f"production/factory release required flag stale: {output_id}")
        if item["present"] != plan_item["present"]:
            raise SystemExit(f"production/factory release present flag stale: {output_id}")
        if item["present"]:
            raise SystemExit(f"production/factory release output unexpectedly present: {output_id}")
        if item["acceptance_item"] not in acceptance_items:
            raise SystemExit(f"production/factory release output has unknown acceptance item: {output_id}")

    manufacturing_outputs = {
        item["id"]: item for item in execution["manufacturing_output_execution"]
    }
    if set(manufacturing_outputs) != set(manufacturing["production_outputs"]):
        raise SystemExit("production/factory manufacturing output execution diverges")
    for output_id, item in manufacturing_outputs.items():
        manufacturing_item = manufacturing["production_outputs"][output_id]
        if manufacturing_item["present"]:
            raise SystemExit(f"manufacturing output unexpectedly present: {output_id}")
        if not manufacturing_item["required_before_release"]:
            raise SystemExit(f"manufacturing output unexpectedly not release-required: {output_id}")
        if item["routed_release_output"] not in routed_release["required_release_output_manifest"]:
            raise SystemExit(f"manufacturing output mapping target missing: {output_id}")

    fixture = execution["factory_fixture_execution"]
    if fixture["fixture_outputs_required"] != factory_probe["fixture_policy"][
        "outputs_required_before_release"
    ]:
        raise SystemExit("production/factory fixture outputs diverge from factory probe policy")
    probe_domains = [item["id"] for item in factory_probe["probe_domains"]]
    if fixture["probe_domains_blocked"] != probe_domains:
        raise SystemExit("production/factory probe domain execution stale")
    if set(probe_domains) != set(production["factory_test_coverage_required"]):
        raise SystemExit("production/factory probe domains diverge from production coverage")

    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"production/factory release execution cross-check failed: {key}")
    for blocker in [
        "routed KiCad PCB, ERC, DRC, zones, and route reports are missing",
        "supplier response packs, signed drawings, pinouts, footprints, STEP models, and AVL are missing",
        "fabrication, assembly, stackup, impedance, DFM/DFA, and quote outputs are missing",
        "fixture coordinates, factory limits, RF calibration procedure, and first-article transcript are missing",
        "routed board STEP and enclosure clearance rerun are missing",
    ]:
        if blocker not in execution["release_blockers"]:
            raise SystemExit(f"production/factory release execution missing blocker: {blocker}")
    for claim in [
        "production_factory_release_ready",
        "fabrication_ready",
        "assembly_ready",
        "factory_test_ready",
        "first_article_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(f"production/factory release execution missing forbidden claim {claim}")
    print(
        "production/factory release execution ok: "
        f"{len(release_outputs)} release outputs, {len(probe_domains)} probe domains blocked"
    )


def check_mechanical_overlay() -> None:
    overlay = load_yaml(ROOT / "board/kicad/e1-phone/mechanical-overlay.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    pcb = (ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb").read_text()

    required_ids = {
        "battery_window",
        "usb_c_shell_capture",
        "display_fpc_bend_keepout",
        "side_key_actuator_keepout",
        "rear_camera_z_keepout",
        "front_camera_earpiece_keepout",
        "haptic_lra_keepout",
        "sim_tray_keepout",
        "top_antenna_keepout",
        "bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
    }
    keepouts = {item["id"]: item for item in overlay["keepouts"]}
    overlay_envelope = overlay["coordinate_system"]["device_envelope_reference"]
    metrics_envelope = metrics["industrial_design_assumptions"]["device_envelope_mm"]
    if overlay_envelope != metrics_envelope:
        raise SystemExit("mechanical overlay device envelope diverges from metrics")
    missing = sorted(required_ids - set(keepouts))
    if missing:
        raise SystemExit(f"mechanical overlay missing keepouts: {missing}")
    routing_keepouts = routing["mechanical_keepouts"]
    for key in ["display_fpc_bend", "haptic_lra", "sim_tray", "front_camera_earpiece"]:
        if key not in routing_keepouts:
            raise SystemExit(f"routing constraints missing mechanical keepout {key}")
    for token in [
        "MECH_KEEP_USB_C_CAPTURE",
        "MECH_KEEP_SIDE_KEY_ACTUATOR",
        "MECH_KEEP_DISPLAY_FPC",
        "MECH_KEEP_HAPTIC_LRA",
        "MECH_KEEP_SIM_TRAY",
        "MECH_KEEP_RF_TOP",
        "MECH_KEEP_RF_BOTTOM",
    ]:
        if token not in pcb:
            raise SystemExit(f"PCB concept missing mechanical overlay token {token}")
    for token in [
        "MECH_KEEP_USB_C_CAPTURE",
        "MECH_KEEP_SIDE_KEY_ACTUATOR",
    ]:
        if token not in overlay["projected_into_kicad_pcb"]["required_tokens"]:
            raise SystemExit(f"mechanical overlay missing projected token {token}")
    print(f"mechanical overlay ok: {len(keepouts)} keepouts projected into KiCad")


def flatten_net_groups(net_groups: dict) -> set[str]:
    nets: set[str] = set()
    for value in net_groups.values():
        if isinstance(value, list):
            nets.update(str(item) for item in value)
    return nets


def check_block_netlist_and_routing() -> None:
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")

    block_nets: dict[str, set[str]] = {}
    net_to_blocks: dict[str, set[str]] = {}
    for block in netlist["blocks"]:
        nets = flatten_net_groups(block["nets"])
        block_nets[block["id"]] = nets
        for net in nets:
            net_to_blocks.setdefault(net, set()).add(block["id"])

    required_blocks = {
        "J_USB_C",
        "U_USB_PD",
        "U_CHARGER",
        "J_BATTERY",
        "U_PMIC",
        "U_SOC",
        "U_LPDDR_UFS",
        "J_DISPLAY_TOUCH",
        "J_CAM0",
        "J_CAM1",
        "U_CELL",
        "U_SIM_ESIM",
        "U_NFC_SENSOR",
        "U_WIFI_BT",
        "SW_SIDE_KEYS",
        "U_AUDIO_HAPTIC",
        "J_TOP_BOTTOM_FLEX_TOP",
        "J_TOP_BOTTOM_FLEX_BOTTOM",
    }
    missing_blocks = sorted(required_blocks - set(block_nets))
    if missing_blocks:
        raise SystemExit(f"block netlist missing blocks: {missing_blocks}")

    for category, nets in netlist["required_shared_nets"].items():
        for net in nets:
            blocks = net_to_blocks.get(net, set())
            if len(blocks) < 2:
                raise SystemExit(
                    f"required shared net {net} ({category}) only appears in {sorted(blocks)}"
                )

    all_nets = set(net_to_blocks)
    for pair in routing["differential_pairs"]:
        for net in pair["nets"]:
            if net not in all_nets:
                raise SystemExit(f"routing pair {pair['name']} references missing net {net}")
        if pair["max_length_mm"] <= 0:
            raise SystemExit(f"routing pair {pair['name']} has invalid max length")

    for bus in routing["single_ended_buses"]:
        for net in bus["nets"]:
            if net not in all_nets:
                raise SystemExit(f"single-ended bus {bus['name']} references missing net {net}")

    print(f"block netlist ok: {len(block_nets)} blocks, {len(all_nets)} unique nets")
    print(f"routing constraints ok: {len(routing['differential_pairs'])} differential pairs")


def check_pcb_text() -> None:
    pcb = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
    text = pcb.read_text()
    for token in ["(end 64 132)", "5G REDCAP", "VOL+", "VOL-", "PWR", "USB-C"]:
        if token not in text:
            raise SystemExit(f"PCB concept missing token {token}: {pcb}")
    for token in [
        '(footprint "E1Phone:J_USB_C"',
        '(footprint "E1Phone:TP_VBUS"',
        '(footprint "E1Phone:FID_TL"',
        '(footprint "E1Phone:MH_TL"',
        '(net 0 "")',
        '"VBUS"',
        '"USB_DP"',
        '"DSI_CLK_P"',
        '"CAM0_CSI_CLK_P"',
        '"CELL_PCIE_TX_P"',
        '"WIFI_PCIE_TX_P"',
        '"LPDDR_CK_P"',
        '"UFS_TX_P"',
        '"JTAG_TCK"',
        '"USIM_DET"',
        '"NFC_I2C_SCL"',
        '"SENSOR_I2C_SCL"',
        '(net_class "E1Phone_USB2_90R"',
        '(net_class "E1Phone_MIPI_DPHY_100R"',
        '(net_class "E1Phone_PCIE_85R"',
        '(net_class "E1Phone_RF_50R"',
        '(net_class "E1Phone_LPDDR_LENGTH_MATCHED"',
        '(net_class "E1Phone_UFS_MPHY"',
        '(net_class "E1Phone_SIM_NFC_SENSOR"',
        '(add_net "CELL_RF_MAIN")',
        '(add_net "WIFI_BT_RF0")',
        '(footprint "E1Phone:RF_MATCH_CELL_RF_MAIN"',
        '(footprint "E1Phone:RF_TP_CELL_RF_MAIN"',
        '(footprint "E1Phone:RF_MATCH_WIFI_BT_RF0"',
        '(footprint "E1Phone:RF_TP_WIFI_BT_RF0"',
        '(footprint "E1Phone:USB_PROTECT_USB2_ESD"',
        '(footprint "E1Phone:USB_PROTECT_CC_ESD"',
        '(footprint "E1Phone:USB_PROTECT_VBUS_TVS"',
        '(footprint "E1Phone:USB_TP_DP"',
        '(footprint "E1Phone:SIDE_KEY_ESD"',
        '(footprint "E1Phone:SIDE_KEY_COND_PWR_KEY_N"',
        '(footprint "E1Phone:DISPLAY_DSI_ESD"',
        '(footprint "E1Phone:DISPLAY_TOUCH_CTRL_ESD"',
        '(footprint "E1Phone:DISPLAY_BIAS_BACKLIGHT"',
        '(footprint "E1Phone:CAMERA_CSI0_ESD"',
        '(footprint "E1Phone:CAMERA_CSI1_ESD"',
        '(footprint "E1Phone:CAMERA_POWER_SEQUENCE"',
        '(footprint "E1Phone:CAMERA_I2C_AF_PULLUPS"',
        '(footprint "E1Phone:AUDIO_CODEC_RAIL_DECOUPLING"',
        '(footprint "E1Phone:AUDIO_AMP_RAIL_DECOUPLING"',
        '(footprint "E1Phone:AUDIO_I2S_PDM_DAMPING"',
        '(footprint "E1Phone:AUDIO_I2C_IRQ_PULLUPS"',
        '(footprint "E1Phone:AUDIO_MIC_BIAS_ESD"',
        '(footprint "E1Phone:AUDIO_SPK_OUTPUT_PROTECT"',
        '(footprint "E1Phone:HAPTIC_DRIVER_OUTPUT"',
        '(footprint "E1Phone:POWER_USBPD_LOCAL_RAIL"',
        '(footprint "E1Phone:POWER_CHARGER_INPUT_FILTER"',
        '(footprint "E1Phone:POWER_CHARGER_BATTERY_SENSE"',
        '(footprint "E1Phone:POWER_FUEL_GAUGE_PLACEHOLDER"',
        '(footprint "E1Phone:POWER_PMIC_CONTROL_PULLUPS"',
        '(footprint "E1Phone:POWER_PMIC_INPUT_DECOUPLING"',
        '(footprint "E1Phone:POWER_AP_RAIL_DECOUPLING"',
        '(footprint "E1Phone:POWER_RF_RAIL_DECOUPLING"',
        '(footprint "E1Phone:POWER_CAMERA_RAIL_DECOUPLING"',
        '(footprint "E1Phone:POWER_DISPLAY_RAIL_DECOUPLING"',
        '(footprint "E1Phone:POWER_AON_BUTTON_WAKE_DECOUPLING"',
        '(footprint "E1Phone:POWER_HIGH_CURRENT_SHUNT_PLACEHOLDERS"',
        '(footprint "E1Phone:COMPUTE_SOC_LOCAL_DECOUPLING"',
        '(footprint "E1Phone:COMPUTE_LPDDR_CK_DQS_TERM"',
        '(footprint "E1Phone:COMPUTE_LPDDR_CA_DAMPING"',
        '(footprint "E1Phone:COMPUTE_LPDDR_DQ_ESCAPE"',
        '(footprint "E1Phone:COMPUTE_UFS_MPHY_ESD_TERM"',
        '(footprint "E1Phone:COMPUTE_DEBUG_BOOT_STRAPS"',
        '(footprint "E1Phone:PHONE_IDENTITY_USIM_ESD_LEVELSHIFT"',
        '(footprint "E1Phone:PHONE_IDENTITY_ESIM_PLACEHOLDER"',
        '(footprint "E1Phone:PHONE_IDENTITY_GNSS_LNA_SAW"',
        '(footprint "E1Phone:PHONE_IDENTITY_NFC_CONTROLLER"',
        '(footprint "E1Phone:PHONE_IDENTITY_NFC_LOOP_MATCH"',
        '(footprint "E1Phone:PHONE_IDENTITY_SENSOR_HUB"',
        '(footprint "E1Phone:J_TOP_BOTTOM_FLEX_TOP"',
        '(footprint "E1Phone:J_TOP_BOTTOM_FLEX_BOTTOM"',
    ]:
        if token not in text:
            raise SystemExit(f"PCB concept missing implementation scaffold token {token}: {pcb}")
    if text.count("(") != text.count(")"):
        raise SystemExit(f"unbalanced KiCad PCB syntax: {pcb}")
    for ref in ["J_TOP_BOTTOM_FLEX_TOP", "J_TOP_BOTTOM_FLEX_BOTTOM"]:
        match = re.search(
            rf'\(footprint "E1Phone:{ref}".*?\n  \)',
            text,
            flags=re.DOTALL,
        )
        if not match:
            raise SystemExit(f"PCB concept missing split-board interconnect footprint {ref}: {pcb}")
        block = match.group(0)
        pad_count = len(re.findall(r'\n    \(pad "', block))
        if pad_count < 49:
            raise SystemExit(f"split-board interconnect {ref} has too few pads: {pad_count}")
        for net in ["USB_DP", "USB_DN", "VBUS", "SYS", "I2S_BCLK", "PDM_CLK", "HAPTIC_OUT"]:
            if f'"{net}"' not in block:
                raise SystemExit(f"split-board interconnect {ref} missing net {net}")
    print(
        "pcb concept ok: optimized envelope, labels, placeholder footprints, test/fiducial/mounting scaffold present"
    )


def check_schematic_scaffold() -> None:
    schematic_dir = ROOT / "board/kicad/e1-phone/schematic"
    expected = {
        "e1-phone.kicad_sch": [
            "Root schematic scaffold",
            "Generated sheets",
            "Required shared power nets",
        ],
        "power_usb.kicad_sch": ["J_USB_C", "U_USB_PD", "U_CHARGER", "J_BATTERY", "U_PMIC"],
        "compute.kicad_sch": ["U_SOC", "CAM0_CSI_D0_P", "DSI_D0_P"],
        "display_camera.kicad_sch": ["J_DISPLAY_TOUCH", "J_CAM0", "J_CAM1"],
        "radios.kicad_sch": ["U_CELL", "U_WIFI_BT", "CELL_PCIE_TX_P"],
        "audio_buttons.kicad_sch": ["SW_SIDE_KEYS", "U_AUDIO_HAPTIC", "PWR_KEY_N"],
        "split_interconnect.kicad_sch": [
            "J_TOP_BOTTOM_FLEX_TOP",
            "J_TOP_BOTTOM_FLEX_BOTTOM",
            "USB_DP",
            "USB_DN",
            "VBUS",
            "SYS",
            "I2S_BCLK",
            "HAPTIC_OUT",
        ],
    }
    for filename, tokens in expected.items():
        path = schematic_dir / filename
        require_path(path)
        text = path.read_text()
        if text.count("(") != text.count(")"):
            raise SystemExit(f"unbalanced schematic scaffold syntax: {path}")
        for token in tokens:
            if token not in text:
                raise SystemExit(f"schematic scaffold {filename} missing token {token}")
    project = json.loads((ROOT / "board/kicad/e1-phone/e1-phone.kicad_pro").read_text())
    variables = project.get("text_variables", {})
    if variables.get("claim_boundary") != "non_release_phone_schematic_scaffold":
        raise SystemExit("KiCad project missing non-release schematic claim boundary")
    print(f"schematic scaffold ok: {len(expected)} KiCad sheets plus project")


def check_module_rf_pinout_execution() -> None:
    execution = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")
    radio_antenna = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
    )
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    block_netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    manifest = load_yaml(MANIFEST)

    if (
        execution["status"]
        != "blocked_requires_cellular_wifi_module_pinouts_reference_layouts_rf_feeds_firmware_and_factory_evidence"
    ):
        raise SystemExit(f"unexpected module RF pinout execution status: {execution['status']}")
    rel = "board/kicad/e1-phone/module-rf-pinout-execution.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing module RF pinout execution artifact")
    for source in [
        "board/kicad/e1-phone/radio-module-integration.yaml",
        "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml",
        "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "package/cellular/quectel-5g-redcap.yaml",
        "package/wifi/murata-type-2ea-wifi6e.yaml",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"module RF pinout execution missing source {source}")

    blocks = {block["id"]: block for block in block_netlist["blocks"]}
    block_nets = {
        block_id: flatten_net_groups(block["nets"]) for block_id, block in blocks.items()
    }
    cell_nets = block_nets["U_CELL"] | block_nets["U_SIM_ESIM"]
    wifi_nets = block_nets["U_WIFI_BT"]
    placements = {item["refdes_group"]: item for item in placement["placements"]}
    routing_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    cellular_contracts = [
        item["contract"] for item in cellular["host_interfaces"]["cellular_module"]["required"]
    ]
    wifi_contracts = (
        [item["contract"] for item in wifi_bt["host_interfaces"]["wifi_primary"]["signals"]]
        + [item["contract"] for item in wifi_bt["host_interfaces"]["bluetooth"]["signals"]]
        + [item["contract"] for item in wifi_bt["host_interfaces"]["control"]["signals"]]
    )
    context = execution["selected_module_context"]
    if context["cellular"]["family"] != cellular["primary_first_phone"]["family"]:
        raise SystemExit("module RF execution cellular family diverges")
    if context["cellular"]["placement_region_mm"] != placements["U_CELL"]["region_mm"]:
        raise SystemExit("module RF execution cellular placement diverges")
    if context["wifi_bluetooth"]["order_number"] != wifi_bt["vendor_public_specs"]["order_number"]:
        raise SystemExit("module RF execution Wi-Fi/Bluetooth order number diverges")
    if context["wifi_bluetooth"]["placement_region_mm"] != placements["U_WIFI_BT"]["region_mm"]:
        raise SystemExit("module RF execution Wi-Fi/Bluetooth placement diverges")

    records = {item["id"]: item for item in execution["module_pinout_execution"]}
    if sorted(records) != ["cellular_5g_redcap_module", "wifi6e_bluetooth_5p3_module"]:
        raise SystemExit("module RF execution record ids diverge")
    if records["cellular_5g_redcap_module"]["required_host_contracts"] != cellular_contracts:
        raise SystemExit("module RF execution cellular contracts diverge")
    if not set(cellular_contracts).issubset(cell_nets):
        raise SystemExit("module RF execution cellular contracts missing from block netlist")
    if records["wifi6e_bluetooth_5p3_module"]["required_host_contracts"] != wifi_contracts:
        raise SystemExit("module RF execution Wi-Fi/Bluetooth contracts diverge")
    if not set(wifi_contracts).issubset(wifi_nets):
        raise SystemExit("module RF execution Wi-Fi/Bluetooth contracts missing from block netlist")
    for pair in [
        "CELL_USB2_DP_DN",
        "CELL_PCIE_TX",
        "CELL_PCIE_RX",
        "WIFI_PCIE_TX",
        "WIFI_PCIE_RX",
    ]:
        if pair not in routing_pairs:
            raise SystemExit(f"module RF execution missing routing pair {pair}")
    rf_feed_nets = [item["net"] for item in execution["rf_feed_execution"]]
    if sorted(rf_feed_nets) != sorted(rf["required_rf_nets"]):
        raise SystemExit("module RF execution RF feed nets diverge from RF closure")
    if sorted(rf_feed_nets) != sorted(radio_antenna["interface_summary"]["required_rf_nets"]):
        raise SystemExit("module RF execution RF feed nets diverge from radio antenna checklist")
    for feed in execution["rf_feed_execution"]:
        if not feed["requires_pi_or_t_matching_network"]:
            raise SystemExit(f"module RF feed missing matching network requirement: {feed['net']}")
        if not feed["requires_conducted_access_before_matching"]:
            raise SystemExit(f"module RF feed missing conducted access: {feed['net']}")
        if not feed["status"].startswith("blocked_"):
            raise SystemExit(f"module RF feed unexpectedly unblocked: {feed['net']}")
    traceability = execution["factory_firmware_identity_execution"][
        "traceability_fields_required"
    ]
    if traceability != factory_probe["fixture_policy"]["operator_visible_traceability_required"]:
        raise SystemExit("module RF execution traceability fields diverge")
    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"module RF execution cross-check failed: {key}")
    for claim in [
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
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(f"module RF execution missing forbidden claim {claim}")
    print(
        "module RF pinout execution ok: "
        f"{len(records)} module records, {len(execution['rf_feed_execution'])} RF feeds blocked"
    )


def check_routed_release_plan() -> None:
    plan = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manifest = load_yaml(ROOT / "board/kicad/e1-phone/artifact-manifest.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    module_rf_pinout = load_yaml(
        ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml"
    )

    if plan["status"] != "blocked_routed_release_requires_real_route_and_supplier_outputs":
        raise SystemExit(f"unexpected routed release plan status: {plan['status']}")
    if plan["release_target"] != "EVT1-routed-first-article":
        raise SystemExit(f"unexpected routed release target: {plan['release_target']}")
    if (
        "board/kicad/e1-phone/routed-release-plan.yaml"
        not in manifest["current_artifacts"]["planning"]
    ):
        raise SystemExit(
            "artifact manifest must list routed-release-plan.yaml as planning evidence"
        )
    for rel in [
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/pinout-footprint-freeze.yaml",
        "board/kicad/e1-phone/procurement-readiness.yaml",
        "board/kicad/e1-phone/enclosure-placement-closure.yaml",
        "board/kicad/e1-phone/power-thermal-budget.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/module-rf-pinout-execution.yaml",
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
    ]:
        if rel not in plan["source_artifacts"]:
            raise SystemExit(f"routed release plan missing source artifact {rel}")

    state = plan["current_board_state"]
    manufacturing_state = manufacturing["board_state_detected"]
    for key in [
        "has_kicad_footprints",
        "has_tracks",
        "has_filled_zones",
        "has_production_outputs",
        "kibot_outputs_are_skeleton_commented",
    ]:
        if state[key] != manufacturing_state[key]:
            raise SystemExit(f"routed release plan board state diverges for {key}")
    if state["revision"] != production["board_revision_policy"]["current_revision"]:
        raise SystemExit("routed release plan revision diverges from production readiness")
    if (
        state["release_revision_required_before_fab"]
        != production["board_revision_policy"]["release_revision_required_before_fab"]
    ):
        raise SystemExit("routed release required revision diverges from production readiness")
    for key in ["has_tracks", "has_filled_zones", "has_production_outputs"]:
        if state[key]:
            raise SystemExit(f"routed release plan cannot be blocked while {key} is true")
    if state["artifact_manifest_status"] != "blocked_not_fabrication_ready":
        raise SystemExit("routed release plan artifact status must remain blocked")

    outputs = plan["required_release_output_manifest"]
    required_outputs = {
        "schematic_erc_report",
        "pcb_drc_report",
        "routed_kicad_pcb",
        "filled_zones",
        "gerber_x2",
        "ipc_2581_or_odbpp",
        "nc_drill_slots",
        "stackup_impedance_report",
        "position_file",
        "production_bom_avl",
        "assembly_drawing",
        "split_interconnect_assembly_drawing",
        "board_step_with_supplier_models",
        "enclosure_clearance_report_using_routed_step",
        "si_pi_reports",
        "rf_reports",
        "power_thermal_measurements",
        "factory_test_limits",
        "first_article_traveler",
        "fab_assembler_quote",
    }
    missing_outputs = sorted(required_outputs - set(outputs))
    if missing_outputs:
        raise SystemExit(f"routed release plan missing output records: {missing_outputs}")
    for name, item in outputs.items():
        for key in ["owner", "source", "expected_path", "present", "release_required", "blocker"]:
            if key not in item:
                raise SystemExit(f"routed release output {name} missing {key}")
        if item["present"] or not item["release_required"] or not item["blocker"]:
            raise SystemExit(f"routed release output must remain blocked and required: {name}")

    requirements = plan["route_completion_requirements"]
    required_domains = {
        "usb_c_power",
        "display_touch",
        "cameras",
        "radios",
        "side_buttons",
        "audio_haptics",
        "split_interconnect",
        "battery",
        "compute_storage",
        "manufacturing",
    }
    missing_domains = sorted(required_domains - set(requirements))
    if missing_domains:
        raise SystemExit(f"routed release plan missing route domains: {missing_domains}")
    for domain, item in requirements.items():
        if not item.get("required_nets") or not item.get("required_evidence"):
            raise SystemExit(f"routed release domain is too weak: {domain}")
    if (
        requirements["manufacturing"]["required_nets"]
        != production["factory_test_coverage_required"]["power_rails"]
    ):
        raise SystemExit(
            "routed release manufacturing nets diverge from factory power rail coverage"
        )
    for net in routing["power_integrity"]["test_points_required"]:
        if net not in plan["power_thermal_release_dependency"]["required_test_points"]:
            raise SystemExit(f"routed release power dependency missing test point {net}")
    if plan["rf_release_dependency"]["required_rf_nets"] != rf["required_rf_nets"]:
        raise SystemExit("routed release RF dependency diverges from RF closure")
    for required in ["VNA", "SAR", "carrier"]:
        if not any(
            required in item for item in plan["rf_release_dependency"]["requires_measurements"]
        ):
            raise SystemExit(f"routed release RF dependency missing measurement {required}")
    module_rf_dep = plan["module_rf_pinout_execution_release_dependency"]
    if module_rf_dep["execution_status"] != module_rf_pinout["status"]:
        raise SystemExit("routed release module RF execution status diverges")
    if (
        module_rf_dep["selected_cellular"]
        != module_rf_pinout["selected_module_context"]["cellular"]["family"]
    ):
        raise SystemExit("routed release module RF cellular selection diverges")
    if (
        module_rf_dep["selected_wifi_bluetooth"]
        != module_rf_pinout["selected_module_context"]["wifi_bluetooth"]["order_number"]
    ):
        raise SystemExit("routed release module RF Wi-Fi/Bluetooth selection diverges")
    if module_rf_dep["rf_feed_count"] != len(module_rf_pinout["rf_feed_execution"]):
        raise SystemExit("routed release module RF feed count diverges")
    if module_rf_dep["module_execution_record_ids"] != [
        item["id"] for item in module_rf_pinout["module_pinout_execution"]
    ]:
        raise SystemExit("routed release module RF execution records diverge")
    if module_rf_dep["required_rf_nets"] != [
        item["net"] for item in module_rf_pinout["rf_feed_execution"]
    ]:
        raise SystemExit("routed release module RF nets diverge")

    for flag in ["ready_to_fabricate", "ready_for_enclosure", "ready_for_factory_test"]:
        if plan[flag]:
            raise SystemExit(f"routed release plan must keep {flag} false")
    for claim in [
        "fabrication_ready",
        "enclosure_ready",
        "routed_release_ready",
        "factory_test_ready",
        "production_ready",
        "carrier_ready",
        "power_thermal_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in plan["forbidden_claims"]:
            raise SystemExit(f"routed release plan missing forbidden claim {claim}")
    print(
        "routed release plan ok: "
        f"{len(outputs)} release outputs blocked, {len(requirements)} route domains tracked"
    )


def check_routed_pcb_implementation_execution() -> None:
    execution = load_yaml(
        ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"
    )
    manifest = load_yaml(MANIFEST)
    routing_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml"
    )
    evt1 = load_yaml(ROOT / "board/kicad/e1-phone/evt1-routing-work-package.yaml")
    route_feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    supplier_to_kicad = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml"
    )
    footprint_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    display_camera_pinout = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )
    usb_sidekey = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    usb_sidekey_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml"
    )
    module_rf = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")

    if (
        execution["schema"]
        != "eliza.e1_phone_routed_pcb_implementation_execution.v1"
    ):
        raise SystemExit("routed PCB implementation execution schema diverges")
    if (
        execution["status"]
        != "blocked_requires_supplier_footprints_schematic_erc_trial_route_drc_outputs_and_routed_step"
    ):
        raise SystemExit(
            "unexpected routed PCB implementation execution status: "
            f"{execution['status']}"
        )
    rel = "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing routed PCB implementation execution artifact")
    for source in [
        "board/kicad/e1-phone/routing-acceptance-checklist.yaml",
        "board/kicad/e1-phone/evt1-routing-work-package.yaml",
        "board/kicad/e1-phone/route-feasibility-density.yaml",
        "board/kicad/e1-phone/pcb-implementation-audit.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
        "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml",
        "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml",
        "board/kicad/e1-phone/usb-sidekey-integration.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/schematic-netclass-execution-package.yaml",
        "board/kicad/e1-phone/route-corridor-execution-package.yaml",
        "board/kicad/e1-phone/usb-route-topology-resolution.yaml",
        "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml",
        "board/kicad/e1-phone/split-interconnect-connector-binding.yaml",
        "board/kicad/e1-phone/module-rf-pinout-execution.yaml",
        "board/kicad/e1-phone/enclosure-fit-execution-package.yaml",
        "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml",
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"routed PCB implementation execution missing source {source}")

    upstream = execution["upstream_status"]
    expected_statuses = {
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
        "module_rf_pinout_execution": module_rf["status"],
    }
    for key, value in expected_statuses.items():
        if upstream[key] != value:
            raise SystemExit(f"routed PCB implementation upstream status stale: {key}")

    live_counts = pcb_audit["live_pcb_counts"]
    state = execution["current_kicad_state"]
    for key in [
        "declared_net_count",
        "footprint_count",
        "assigned_pad_net_count",
        "net_class_count",
        "segment_count",
        "zone_count",
        "keepout_zone_count",
        "rf_feed_count",
        "test_point_count",
    ]:
        if state[key] != live_counts[key]:
            raise SystemExit(f"routed PCB implementation KiCad count diverges for {key}")
    manufacturing_state = manufacturing["board_state_detected"]
    for key in [
        "has_tracks",
        "has_filled_zones",
        "has_production_outputs",
        "kibot_outputs_are_skeleton_commented",
    ]:
        if state[key] != manufacturing_state[key]:
            raise SystemExit(
                f"routed PCB implementation manufacturing state diverges for {key}"
            )
    if state["segment_count"] != 0 or state["zone_count"] != 0:
        raise SystemExit("routed PCB implementation must remain blocked with no route")
    if state["has_tracks"] or state["has_filled_zones"] or state["has_production_outputs"]:
        raise SystemExit("routed PCB implementation cannot claim routed/manufacturing state")

    pressure = execution["routing_pressure_snapshot"]
    route_summary = routing_acceptance["routing_summary"]
    if pressure["board_bbox_mm"] != route_summary["board_bbox_mm"]:
        raise SystemExit("routed PCB implementation board pressure bbox diverges")
    if pressure["battery_window_mm"] != route_summary["battery_window_mm"]:
        raise SystemExit("routed PCB implementation battery window diverges")
    if (
        pressure["differential_pair_count_required"]
        != route_feasibility["interface_complexity_counts"][
            "differential_pair_count_required"
        ]
    ):
        raise SystemExit("routed PCB implementation differential pair count diverges")
    if (
        pressure["split_interconnect_min_contacts"]
        != route_feasibility["interface_complexity_counts"][
            "split_interconnect_min_contacts"
        ]
    ):
        raise SystemExit("routed PCB implementation split contact count diverges")

    phase_status = {
        phase["phase"]: phase["current_status"] for phase in evt1["route_phases"]
    }
    execution_phases = {
        phase["phase"]: phase for phase in execution["routed_evt1_execution_phases"]
    }
    if sorted(execution_phases) != sorted(phase_status):
        raise SystemExit("routed PCB implementation phases diverge from EVT1 work package")
    release_outputs = routed_release["required_release_output_manifest"]
    for phase_name, phase in execution_phases.items():
        if phase["current_status"] != phase_status[phase_name]:
            raise SystemExit(f"routed PCB implementation phase status stale: {phase_name}")
        if not phase["status"].startswith("blocked_"):
            raise SystemExit(f"routed PCB implementation phase unexpectedly open: {phase_name}")
        for output in phase["expected_release_outputs"]:
            release_output = release_outputs[output["id"]]
            if output["expected_path"] != release_output["expected_path"]:
                raise SystemExit(
                    f"routed PCB implementation output path diverges: {output['id']}"
                )
            if output["present"] or not output["release_required"]:
                raise SystemExit(
                    f"routed PCB implementation output must be blocked: {output['id']}"
                )

    domains = {item["id"]: item for item in execution["domain_route_closure"]}
    if set(domains) != set(routed_release["route_completion_requirements"]):
        raise SystemExit("routed PCB implementation domain closure diverges")
    for domain, item in routed_release["route_completion_requirements"].items():
        if domains[domain]["required_nets"] != item["required_nets"]:
            raise SystemExit(f"routed PCB implementation domain nets stale: {domain}")
        if domains[domain]["required_evidence"] != item["required_evidence"]:
            raise SystemExit(f"routed PCB implementation domain evidence stale: {domain}")
        if not domains[domain]["status"].startswith("blocked_"):
            raise SystemExit(f"routed PCB implementation domain unexpectedly open: {domain}")

    supplier_records = {
        item["function"]: item for item in supplier_to_kicad["evidence_records"]
    }
    footprint_items = {
        item["function"]: item for item in footprint_capture["work_items"]
    }
    route_inputs = {
        item["function"]: item
        for item in execution["supplier_to_kicad_route_input_matrix"]
    }
    if sorted(route_inputs) != sorted(supplier_records):
        raise SystemExit("routed PCB implementation supplier matrix diverges")
    if sorted(route_inputs) != sorted(footprint_items):
        raise SystemExit("routed PCB implementation footprint matrix diverges")
    for function, item in route_inputs.items():
        supplier_record = supplier_records[function]
        footprint_item = footprint_items[function]
        if item["primary_candidate"] != supplier_record["primary_candidate"]:
            raise SystemExit(f"routed PCB implementation supplier candidate stale: {function}")
        if item["package_binding"] != supplier_record["package_binding"]:
            raise SystemExit(f"routed PCB implementation package binding stale: {function}")
        if item["supplier_to_kicad_status"] != supplier_record["current_status"]:
            raise SystemExit(f"routed PCB implementation supplier status stale: {function}")
        if item["footprint_capture_work_item"] != footprint_item["id"]:
            raise SystemExit(f"routed PCB implementation footprint work item stale: {function}")
        if item["footprint_capture_status"] != footprint_item["status"]:
            raise SystemExit(f"routed PCB implementation footprint status stale: {function}")
        if item["planned_contract_net_count"] != len(footprint_item["planned_contract_nets"]):
            raise SystemExit(f"routed PCB implementation net count stale: {function}")
        if item["required_supplier_input_count"] != len(
            supplier_record["required_supplier_inputs"]
        ):
            raise SystemExit(f"routed PCB implementation supplier input count stale: {function}")
        if item["required_production_evidence"] != supplier_record[
            "required_production_evidence"
        ]:
            raise SystemExit(f"routed PCB implementation production evidence stale: {function}")
        if item["supplier_gate_inputs_required"] != footprint_item[
            "supplier_gate_inputs_required"
        ]:
            raise SystemExit(f"routed PCB implementation supplier gates stale: {function}")
        if item["all_supplier_gates_closed"]:
            raise SystemExit(f"routed PCB implementation supplier gates unexpectedly closed: {function}")
        if not item["supplier_to_kicad_status"].startswith("blocked_"):
            raise SystemExit(f"routed PCB implementation supplier input unexpectedly open: {function}")
        if not item["footprint_capture_status"].startswith("blocked_"):
            raise SystemExit(f"routed PCB implementation footprint input unexpectedly open: {function}")
        for review_key, evidence_key in [
            ("pinout_review", "pinout_review_signoff"),
            ("symbol_review", "symbol_review"),
            ("footprint_review", "footprint_review"),
            ("footprint_3d_binding", "footprint_3d_binding"),
        ]:
            if (
                item["review_outputs"][review_key]
                != supplier_record["required_production_evidence"][evidence_key]
            ):
                raise SystemExit(
                    f"routed PCB implementation review output stale: {function} {review_key}"
                )

    display_camera_interfaces = {
        item["interface_id"]: item
        for item in display_camera_pinout["connector_pinout_execution"]
    }
    usb_acceptance_items = {
        item["id"]: item for item in usb_sidekey_acceptance["acceptance_items"]
    }
    external_interfaces = {
        item["id"]: item for item in execution["external_interface_hardware_closure"]
    }
    expected_external_ids = {
        "display_touch_fpc",
        "rear_camera_fpc",
        "front_camera_fpc",
        "usb_c_receptacle_evt0",
        "side_buttons",
    }
    if set(external_interfaces) != expected_external_ids:
        raise SystemExit("routed PCB implementation external interface matrix diverges")
    external_contract_nets_by_domain: dict[str, set[str]] = {}
    for item in external_interfaces.values():
        external_contract_nets_by_domain.setdefault(item["route_domain"], set()).update(
            item["required_contract_nets"]
        )
    for interface_id in ["display_touch_fpc", "rear_camera_fpc", "front_camera_fpc"]:
        item = external_interfaces[interface_id]
        source = display_camera_interfaces[interface_id]
        if item["status"] != source["status"]:
            raise SystemExit(f"external interface status stale: {interface_id}")
        if item["source_candidate"] != source["source_candidate"]:
            raise SystemExit(f"external interface source candidate stale: {interface_id}")
        if item["refdes"] != source["refdes"]:
            raise SystemExit(f"external interface refdes stale: {interface_id}")
        if item["required_contract_nets"] != source["required_contract_nets"]:
            raise SystemExit(f"external interface contract nets stale: {interface_id}")
        if item["route_constraint_group_count"] != len(source["route_constraint_groups"]):
            raise SystemExit(f"external interface route group count stale: {interface_id}")
        if item["mechanical_capture_tasks"] != source["mechanical_capture_tasks"]:
            raise SystemExit(f"external interface mechanical tasks stale: {interface_id}")
        if not item["status"].startswith("blocked_"):
            raise SystemExit(f"external interface unexpectedly unblocked: {interface_id}")
    for route_domain, contract_nets in external_contract_nets_by_domain.items():
        release_nets = routed_release["route_completion_requirements"][route_domain][
            "required_nets"
        ]
        if not set(release_nets).issubset(contract_nets):
            raise SystemExit(
                f"external interface release nets missing from contract: {route_domain}"
            )

    usb_item = external_interfaces["usb_c_receptacle_evt0"]
    if usb_item["status"] != usb_sidekey["status"]:
        raise SystemExit("USB-C external interface status stale")
    if (
        usb_item["source_candidate"]
        != usb_sidekey["usb_c_port_context"]["selected_evt0_connector"]["family"]
    ):
        raise SystemExit("USB-C external interface source candidate stale")
    if usb_item["required_contract_nets"] != usb_sidekey["usb_c_port_context"]["required_nets"]:
        raise SystemExit("USB-C external interface nets stale")
    if usb_item["mechanical_capture_tasks"] != usb_sidekey["usb_c_port_context"]["mechanical_requirements"]:
        raise SystemExit("USB-C external interface mechanical requirements stale")
    usb_acceptance_ids = {item["id"] for item in usb_item["acceptance_items"]}
    if usb_acceptance_ids != {
        "usb_c_connector_shell_load_path",
        "usb_c_cutout_and_plug_keepout",
        "usb2_cc_vbus_route_and_esd",
        "pd_attach_and_charger_safety",
    }:
        raise SystemExit("USB-C external interface acceptance items stale")
    for acceptance_id in usb_acceptance_ids:
        if usb_acceptance_items[acceptance_id]["status"] != "blocked_missing_routed_supplier_or_measured_evidence":
            raise SystemExit(f"USB-C acceptance unexpectedly unblocked: {acceptance_id}")

    side_item = external_interfaces["side_buttons"]
    if side_item["status"] != usb_sidekey["status"]:
        raise SystemExit("side-button external interface status stale")
    if (
        side_item["source_candidate"]
        != usb_sidekey["side_key_context"]["primary_switch_family"]["family"]
    ):
        raise SystemExit("side-button external interface source candidate stale")
    if side_item["required_contract_nets"] != usb_sidekey["side_key_context"]["required_nets"]:
        raise SystemExit("side-button external interface nets stale")
    if side_item["mechanical_capture_tasks"] != usb_sidekey["side_key_context"]["mechanical_requirements"]:
        raise SystemExit("side-button external interface mechanical requirements stale")
    side_acceptance_ids = {item["id"] for item in side_item["acceptance_items"]}
    if side_acceptance_ids != {
        "side_key_force_travel_and_solder_load",
        "side_key_recovery_and_wake",
    }:
        raise SystemExit("side-button external interface acceptance items stale")
    for acceptance_id in side_acceptance_ids:
        if usb_acceptance_items[acceptance_id]["status"] != "blocked_missing_routed_supplier_or_measured_evidence":
            raise SystemExit(f"side-button acceptance unexpectedly unblocked: {acceptance_id}")
    if not usb_item["status"].startswith("blocked_") or not side_item["status"].startswith("blocked_"):
        raise SystemExit("USB-C/side-button interfaces must remain fail-closed")

    manifest_outputs = {item["id"]: item for item in execution["output_manifest_closure"]}
    if set(manifest_outputs) != set(release_outputs):
        raise SystemExit("routed PCB implementation output manifest diverges from release plan")
    for key, item in release_outputs.items():
        if manifest_outputs[key]["expected_path"] != item["expected_path"]:
            raise SystemExit(f"routed PCB implementation release output path stale: {key}")
        if manifest_outputs[key]["present"] or not manifest_outputs[key]["release_required"]:
            raise SystemExit(f"routed PCB implementation release output must be blocked: {key}")

    module_dep = execution["module_and_rf_dependency"]
    if module_dep["execution_status"] != module_rf["status"]:
        raise SystemExit("routed PCB implementation module RF dependency status stale")
    if module_dep["required_rf_nets"] != routed_release["rf_release_dependency"]["required_rf_nets"]:
        raise SystemExit("routed PCB implementation RF dependency nets stale")
    if module_dep["rf_feed_count"] != len(module_rf["rf_feed_execution"]):
        raise SystemExit("routed PCB implementation RF feed count stale")
    enclosure_dep = execution["enclosure_dependency"]
    if not enclosure_dep["requires_routed_board_step"]:
        raise SystemExit("routed PCB implementation must require routed board STEP")

    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"routed PCB implementation cross-check failed: {key}")
    for claim in [
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
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(
                f"routed PCB implementation missing forbidden claim {claim}"
            )
    print(
        "routed PCB implementation execution ok: "
        f"{len(execution_phases)} phases, {len(manifest_outputs)} release outputs blocked"
    )


def check_layout_optimization_execution() -> None:
    execution = load_yaml(ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml")
    manifest = load_yaml(MANIFEST)
    scorecard = load_yaml(ROOT / "board/kicad/e1-phone/board-optimization-scorecard.yaml")
    live = load_yaml(ROOT / "board/kicad/e1-phone/live-utilization-audit.yaml")
    envelopes = load_yaml(ROOT / "board/kicad/e1-phone/component-envelope-fit-audit.yaml")
    repack = load_yaml(ROOT / "board/kicad/e1-phone/placement-repack-candidate.yaml")
    feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")

    if execution["schema"] != "eliza.e1_phone_layout_optimization_execution.v1":
        raise SystemExit("layout optimization execution schema diverges")
    if (
        execution["status"]
        != "blocked_concept_layout_optimized_requires_supplier_footprints_trial_route_measurements_and_routed_step"
    ):
        raise SystemExit(f"unexpected layout optimization execution status: {execution['status']}")
    rel = "board/kicad/e1-phone/layout-optimization-execution.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing layout optimization execution artifact")
    for source in [
        "board/kicad/e1-phone/board-optimization-scorecard.yaml",
        "board/kicad/e1-phone/live-utilization-audit.yaml",
        "board/kicad/e1-phone/component-envelope-fit-audit.yaml",
        "board/kicad/e1-phone/placement-repack-candidate.yaml",
        "board/kicad/e1-phone/route-feasibility-density.yaml",
        "board/kicad/e1-phone/routing-acceptance-checklist.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/display-fit.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/power-thermal-budget.yaml",
        "board/kicad/e1-phone/enclosure-fit-execution-package.yaml",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"layout optimization execution missing source {source}")

    upstream = execution["upstream_status"]
    expected_statuses = {
        "board_optimization_scorecard": scorecard["status"],
        "live_utilization_audit": live["status"],
        "component_envelope_fit_audit": envelopes["status"],
        "placement_repack_candidate": repack["status"],
        "route_feasibility_density": feasibility["status"],
        "routed_release_plan": routed_release["status"],
        "display_fit": display_fit["status"],
    }
    for key, value in expected_statuses.items():
        if upstream[key] != value:
            raise SystemExit(f"layout optimization upstream status stale: {key}")

    geometry = execution["locked_concept_geometry"]
    target = scorecard["optimization_target"]
    if geometry["device_envelope_mm"] != target["device_envelope_mm"]:
        raise SystemExit("layout optimization device envelope diverges")
    if geometry["board_bbox_mm"] != target["board_bbox_mm"]:
        raise SystemExit("layout optimization board bbox diverges")
    if geometry["battery_window_mm"] != target["battery_window_mm"]:
        raise SystemExit("layout optimization battery window diverges")
    if geometry["display_outline_mm"] != display_fit["selected_primary_display"]["outline_mm"]:
        raise SystemExit("layout optimization display outline diverges")
    if (
        geometry["display_clearance_mm"]
        != display_fit["primary_clearance_in_current_envelope_mm"]
    ):
        raise SystemExit("layout optimization display clearance diverges")

    pressure = execution["layout_pressure_closure"]
    if (
        pressure["concept_route_shield_test_reserve_pct"]
        != live["route_reserve_pressure"]["concept_route_shield_test_reserve_pct"]
    ):
        raise SystemExit("layout optimization live reserve pressure stale")
    if pressure["battery_window_intrusion_count"] != 0:
        raise SystemExit("layout optimization battery window has live intrusions")
    if pressure["active_region_overlap_count"] != repack["candidate_overlap_audit"]["overlap_count"]:
        raise SystemExit("layout optimization active-region overlap count stale")
    if pressure["known_envelope_blockers_count"] != envelopes["routing_impact"]["known_envelope_blockers_count"]:
        raise SystemExit("layout optimization known-envelope blocker count stale")
    if not pressure["status"].startswith("blocked_"):
        raise SystemExit("layout optimization pressure closure unexpectedly unblocked")

    performance = execution["performance_constraint_closure"]
    for key in [
        "route_density",
        "power_efficiency",
        "thermal",
        "rf_connectivity",
        "factory_test_access",
    ]:
        if performance[key] != scorecard["scorecard"][key]:
            raise SystemExit(f"layout optimization performance section stale: {key}")

    component_policy = execution["component_fit_policy"]
    for key in [
        "wifi_bluetooth_module",
        "display_module",
        "battery_pack",
        "side_button_primary_switch",
        "front_camera_alternate_junde",
        "front_and_rear_camera_primary",
    ]:
        if component_policy[key] != envelopes["known_component_envelopes"][key]:
            raise SystemExit(f"layout optimization component policy stale: {key}")
    if component_policy["front_camera_alternate_junde"]["fit"]["fits_xy"]:
        raise SystemExit("layout optimization must reject the oversized Junde camera alternate")
    if not component_policy["wifi_bluetooth_module"]["fit"]["fits_xy"]:
        raise SystemExit("layout optimization Wi-Fi/Bluetooth known outline no longer fits")

    placement = execution["placement_repack_policy"]
    if placement["candidate_regions_mm"] != repack["candidate_regions_mm"]:
        raise SystemExit("layout optimization placement candidate regions stale")
    if placement["battery_window_audit"]["candidate_intrusion_count"] != 0:
        raise SystemExit("layout optimization placement candidate intrudes into battery")
    if len(placement["region_semantics_changes_required"]) < 3:
        raise SystemExit("layout optimization must preserve region-semantics changes")

    release_outputs = {
        item["id"]: item for item in execution["routed_release_output_dependencies"]
    }
    for key in [
        "routed_kicad_pcb",
        "filled_zones",
        "pcb_drc_report",
        "si_pi_reports",
        "rf_reports",
        "power_thermal_measurements",
        "enclosure_clearance_report_using_routed_step",
        "factory_test_limits",
    ]:
        if key not in release_outputs:
            raise SystemExit(f"layout optimization missing release output dependency {key}")
        plan_output = routed_release["required_release_output_manifest"][key]
        if release_outputs[key]["expected_path"] != plan_output["expected_path"]:
            raise SystemExit(f"layout optimization release output path stale: {key}")
        if release_outputs[key]["present"] or not release_outputs[key]["release_required"]:
            raise SystemExit(f"layout optimization release output unexpectedly present: {key}")

    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"layout optimization cross-check failed: {key}")
    for claim in [
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
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(f"layout optimization missing forbidden claim {claim}")
    print(
        "layout optimization execution ok: "
        f"{len(component_policy)} component policies, {len(release_outputs)} release outputs blocked"
    )


def check_end_to_end_readiness() -> None:
    readiness = load_yaml(ROOT / "board/kicad/e1-phone/end-to-end-readiness.yaml")
    manifest = load_yaml(MANIFEST)
    display_source = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    display_pinout = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )
    usb_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml"
    )
    module_rf = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    routed_pcb = load_yaml(
        ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"
    )
    layout = load_yaml(ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml")
    production_factory = load_yaml(
        ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml"
    )

    if readiness["schema"] != "eliza.e1_phone_end_to_end_readiness.v1":
        raise SystemExit("end-to-end readiness schema diverges")
    if readiness["status"] != "blocked_not_end_to_end_ready_or_enclosure_ready":
        raise SystemExit(f"unexpected end-to-end readiness status: {readiness['status']}")
    rel = "board/kicad/e1-phone/end-to-end-readiness.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing end-to-end readiness artifact")

    required_sources = [
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml",
        "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/module-rf-pinout-execution.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
        "board/kicad/e1-phone/layout-optimization-execution.yaml",
        "board/kicad/e1-phone/production-factory-release-execution.yaml",
    ]
    for source in required_sources:
        if source not in readiness["source_artifacts"]:
            raise SystemExit(f"end-to-end readiness missing source {source}")
        require_path(ROOT / source)

    board_state = readiness["current_board_state"]
    expected_board_state = {
        "artifact_manifest_status": manifest["status"],
        "display_camera_source_revalidation_status": display_source["status"],
        "display_camera_connector_pinout_execution_status": display_pinout["status"],
        "usb_sidekey_acceptance_status": usb_acceptance["status"],
        "module_rf_pinout_execution_status": module_rf["status"],
        "routed_release_plan_status": routed_release["status"],
        "routed_pcb_implementation_execution_status": routed_pcb["status"],
        "layout_optimization_execution_status": layout["status"],
        "production_factory_release_execution_status": production_factory["status"],
    }
    for key, value in expected_board_state.items():
        if board_state.get(key) != value:
            raise SystemExit(f"end-to-end readiness current board state stale: {key}")

    required_objectives = {
        "popular_screen_size_fit",
        "screen_camera_oem_sourcing",
        "usb_c_power_volume_hardware",
        "off_the_shelf_wireless_modules",
        "board_size_power_rf_thermal_optimization",
        "supplier_footprints_pinouts_and_3d_models",
        "schematic_and_pcb_routed_release",
        "component_height_and_enclosure_step",
        "manufacturing_and_factory_release",
    }
    objectives = readiness["objective_requirements"]
    if set(objectives) != required_objectives:
        raise SystemExit("end-to-end readiness objective set diverges")
    for objective, item in objectives.items():
        if item["objective_satisfied"] is not False:
            raise SystemExit(f"end-to-end objective unexpectedly satisfied: {objective}")
        if item["release_required"] is not True:
            raise SystemExit(f"end-to-end objective unexpectedly not release-required: {objective}")
        if not item.get("blockers"):
            raise SystemExit(f"end-to-end objective missing blockers: {objective}")
        if not item.get("required_release_outputs"):
            raise SystemExit(f"end-to-end objective missing release outputs: {objective}")
        evidence = load_yaml(ROOT / item["evidence_artifact"])
        if item["current_status"] != evidence["status"]:
            raise SystemExit(f"end-to-end objective status stale: {objective}")

    expected_evidence = {
        "screen_camera_oem_sourcing": "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml",
        "usb_c_power_volume_hardware": "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "off_the_shelf_wireless_modules": "board/kicad/e1-phone/module-rf-pinout-execution.yaml",
        "board_size_power_rf_thermal_optimization": "board/kicad/e1-phone/layout-optimization-execution.yaml",
        "schematic_and_pcb_routed_release": "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
        "manufacturing_and_factory_release": "board/kicad/e1-phone/production-factory-release-execution.yaml",
    }
    for objective, evidence_path in expected_evidence.items():
        if objectives[objective]["evidence_artifact"] != evidence_path:
            raise SystemExit(f"end-to-end readiness evidence artifact stale: {objective}")

    decision = readiness["release_decision"]
    for flag in [
        "ready_to_fabricate",
        "ready_for_enclosure",
        "ready_for_factory_test",
        "end_to_end_phone_ready",
    ]:
        if decision[flag]:
            raise SystemExit(f"end-to-end readiness must keep {flag} false")
    for key, value in readiness["objective_traceability_cross_checks"].items():
        if value is not True:
            raise SystemExit(f"end-to-end traceability cross-check failed: {key}")
    for key, value in readiness["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"end-to-end readiness cross-check failed: {key}")
    for claim in [
        "end_to_end_phone_ready",
        "fabrication_ready",
        "enclosure_ready",
        "production_ready",
        "factory_test_ready",
        "supplier_pack_complete",
        "routed_pcb_ready",
        "carrier_ready",
        "power_thermal_ready",
        "rf_ready",
    ]:
        if claim not in readiness["forbidden_claims"]:
            raise SystemExit(f"end-to-end readiness missing forbidden claim {claim}")
    print(
        "end-to-end readiness ok: "
        f"{len(objectives)} objectives blocked, {len(required_sources)} current execution sources traced"
    )


def check_release_gates_fail_closed(manifest: dict) -> None:
    gates = manifest["release_gates"]
    for name, gate in gates.items():
        if gate["status"] != "missing":
            raise SystemExit(f"release gate {name} unexpectedly not fail-closed: {gate['status']}")
    print("release gates ok: fabrication/enclosure readiness remains fail-closed")


def main() -> int:
    manifest = load_yaml(MANIFEST)
    if manifest["status"] != "blocked_not_fabrication_ready":
        raise SystemExit(
            f"manifest must remain fail-closed until real evidence exists: {manifest['status']}"
        )
    check_manifest_paths(manifest)
    check_metrics()
    check_battery_layout_options()
    check_board_topology_decision()
    check_top_bottom_interconnect_plan()
    check_matrix_and_bom()
    check_procurement_readiness()
    check_supplier_sourcing_audit()
    check_supplier_rfq_transmittal_drafts()
    check_display_camera_source_revalidation()
    check_display_camera_acceptance()
    check_usb_sidekey_acceptance()
    check_radio_antenna_acceptance()
    check_module_host_integration_acceptance()
    check_pinout_footprint_freeze()
    check_supplier_drawing_intake()
    check_evt1_footprint_capture_work_package()
    check_schematic_netclass_execution_package()
    check_route_corridor_execution_package()
    check_usb_route_topology_resolution()
    check_split_interconnect_pin_allocation_and_binding()
    check_interface_closure()
    check_enclosure_placement_closure()
    check_component_height_step_integration()
    check_enclosure_fit_execution_package()
    check_power_bringup_acceptance()
    check_power_thermal_budget()
    check_rf_connectivity_closure()
    check_rf_antenna_coexistence_closure()
    check_module_rf_pinout_execution()
    check_audio_acoustic_closure()
    check_manufacturing_closure()
    check_production_readiness()
    check_factory_probe_map()
    check_factory_production_acceptance()
    check_production_factory_release_execution()
    check_block_netlist_and_routing()
    check_mechanical_overlay()
    check_schematic_scaffold()
    check_pcb_text()
    check_routed_release_plan()
    check_routed_pcb_implementation_execution()
    check_layout_optimization_execution()
    check_end_to_end_readiness()
    check_release_gates_fail_closed(manifest)
    print("E1 phone board package structurally consistent; not fabrication ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
