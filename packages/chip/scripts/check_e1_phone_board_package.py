#!/usr/bin/env python3
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
    if battery_target["approximate_capacity_mah_at_nominal"] != 4500:
        raise SystemExit(f"unexpected battery capacity target: {battery_target}")
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
        raise SystemExit("mechanical CAD battery must match the selected 17.3 Wh pack class")
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
        "current_single_rigid_with_45x72_window": "reject_for_17p3wh_target",
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
        "connector mated height and stiffener stack must clear the 9.6 mm enclosure",
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
        "formal 9.6 mm tolerance stack with gasket compression and battery swelling",
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


def check_power_thermal_budget() -> None:
    budget = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    if budget["status"] != "blocked_power_thermal_requires_real_schematic_and_measurement":
        raise SystemExit(f"unexpected power/thermal budget status: {budget['status']}")
    if budget["missing_required_nets_by_rail"]:
        raise SystemExit(f"power/thermal rail net gaps: {budget['missing_required_nets_by_rail']}")
    usb = budget["usb_c_power_path"]
    if not usb["passes_evt0_pd_power_margin"] or usb["pd_power_margin_w"] <= 0:
        raise SystemExit(f"USB-C PD charge power margin is insufficient: {usb}")
    runtime = budget["runtime_estimates_from_17p3wh_target"]
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
    if closure["status"] != "planning_rf_connectivity_cross_checked_not_measured":
        raise SystemExit(f"unexpected RF connectivity status: {closure['status']}")
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


def check_routed_release_plan() -> None:
    plan = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manifest = load_yaml(ROOT / "board/kicad/e1-phone/artifact-manifest.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")

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
    check_pinout_footprint_freeze()
    check_interface_closure()
    check_enclosure_placement_closure()
    check_power_thermal_budget()
    check_rf_connectivity_closure()
    check_audio_acoustic_closure()
    check_manufacturing_closure()
    check_production_readiness()
    check_block_netlist_and_routing()
    check_mechanical_overlay()
    check_schematic_scaffold()
    check_pcb_text()
    check_routed_release_plan()
    check_release_gates_fail_closed(manifest)
    print("E1 phone board package structurally consistent; not fabrication ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
