#!/usr/bin/env python3
import csv
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree as ET

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "board/kicad/e1-phone/artifact-manifest.yaml"
REPORT = ROOT / "build/reports/e1_phone_board_package.json"
PUBLIC_SOURCE_STATUS_RE = re.compile(r"^(public_listing|vendor_page)_observed_20\d{2}_\d{2}_\d{2}$")
BOARD_PACKAGE_PATH_RE = re.compile(r"board/kicad/e1-phone/[^\"'\s),\]}]+")
BLOCKED_CANDIDATE_INLINE_MARKERS = (
    "blocked local factory candidate, not release evidence",
    "blocked candidate, not release evidence",
    "supplier-return placeholder",
    "blocked_pending_supplier_return",
    "not_approved,blocked",
    "blocked,not_approved",
)
LINKED_EVIDENCE_REPORTS = (
    (
        "sourcing",
        "python3 scripts/check_e1_phone_supplier_return_content.py",
        "build/reports/e1_phone_supplier_return_content.json",
    ),
    (
        "layout_fabrication",
        "python3 scripts/check_e1_phone_routed_output_content.py",
        "build/reports/e1_phone_routed_output_content.json",
    ),
    (
        "manufacturing",
        "python3 scripts/check_e1_phone_factory_output_content.py",
        "build/reports/e1_phone_factory_output_content.json",
    ),
    (
        "manufacturing_validation",
        "python3 scripts/check_e1_phone_first_article_content.py",
        "build/reports/e1_phone_first_article_content.json",
    ),
    (
        "release_owner",
        "python3 scripts/check_e1_phone_fabrication_release.py",
        "build/reports/e1_phone_fabrication_release.json",
    ),
)
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "fabrication_claim_allowed": False,
    "board_fabrication_claim_allowed": False,
    "package_vendor_approval_claim_allowed": False,
    "first_article_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}


def load_yaml(path: Path):
    if not path.is_file():
        raise SystemExit(f"missing required artifact: {path.relative_to(ROOT)}")
    with path.open() as handle:
        return yaml.safe_load(handle)


def load_json_file(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def require_path(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"missing required artifact: {path}")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_blocked_candidate_artifact(path: Path) -> bool:
    if not path.exists():
        return False
    probe = path
    if path.is_dir():
        for name in ("release-manifest.yaml", "manifest.yaml"):
            candidate = path / name
            if candidate.is_file():
                probe = candidate
                break
        else:
            children = [child for child in path.rglob("*") if child.is_file()]
            return bool(children) and all(
                is_blocked_candidate_artifact(child) for child in children
            )
    if probe.is_file() and probe.suffix not in {".yaml", ".yml", ".json"}:
        for suffix in (".metadata.yaml", ".metadata.yml", ".metadata.json"):
            sidecar = probe.with_name(probe.name + suffix)
            if sidecar.is_file():
                probe = sidecar
                break
        else:
            try:
                sample = probe.read_bytes()[:4096].decode("utf-8", errors="ignore").lower()
            except Exception:
                return False
            return (
                any(marker in sample for marker in BLOCKED_CANDIDATE_INLINE_MARKERS)
                or (
                    "release_credit: false" in sample
                    and ("not supplier evidence" in sample or "placeholder" in sample)
                )
                or (
                    "release_credit" in sample
                    and "false" in sample
                    and "blocked_pending_supplier_return" in sample
                )
            )
    if not probe.is_file() or probe.suffix not in {".yaml", ".yml", ".json"}:
        return False
    try:
        data = (
            load_yaml(probe) if probe.suffix in {".yaml", ".yml"} else json.loads(probe.read_text())
        )
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    disposition = str(data.get("disposition", "")).lower()
    status = str(data.get("status", "")).lower()
    return (
        data.get("release_allowed") is False
        or data.get("release_credit") is False
        or disposition.startswith("blocked")
        or status.startswith("blocked")
    )


def is_release_artifact_present(path: Path) -> bool:
    return path.exists() and not is_blocked_candidate_artifact(path)


def collect_board_file_references(value: object) -> set[str]:
    refs: set[str] = set()
    if isinstance(value, dict):
        for nested in value.values():
            refs.update(collect_board_file_references(nested))
    elif isinstance(value, list):
        for nested in value:
            refs.update(collect_board_file_references(nested))
    elif isinstance(value, str):
        normalized = value.removeprefix("packages/chip/")
        for match in re.findall(r"board/kicad/e1-phone/[^\"'\s,)\]]+", normalized):
            refs.add(match.rstrip(".,:;"))
    return refs


def load_structured_file(path: Path) -> object | None:
    try:
        if path.suffix in {".yaml", ".yml"}:
            return load_yaml(path)
        if path.suffix == ".json":
            return json.loads(path.read_text())
    except Exception:
        return None
    return None


def is_public_source_status(value: object) -> bool:
    return isinstance(value, str) and PUBLIC_SOURCE_STATUS_RE.fullmatch(value) is not None


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
        "current_single_rigid_with_45x72_window": "reject_for_22p05wh_target",
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

    release_blockers = set(plan["release_blockers"])
    required_release_blockers = [
        ("exact connector circuit count and orderable mating part numbers not selected",),
        ("flex stackup, bend radius, stiffener, and strain relief not drawn",),
        ("USB2 and audio SI across the flex not simulated or measured",),
        ("power contact current rise and return allocation not reviewed",),
        (
            "bottom island decoupling, ESD, and test fixture edge pending KiCad capture",
            "bottom island decoupling, ESD, and test fixture edge not implemented in KiCad",
        ),
        ("assembly sequence for battery insertion and split-board connection not validated",),
    ]
    for blocker_aliases in required_release_blockers:
        if not release_blockers.intersection(blocker_aliases):
            raise SystemExit(
                f"top/bottom interconnect plan missing release blocker: {blocker_aliases[0]}"
            )
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
        "board/kicad/e1-phone/cellular-space-saving-downselect.yaml",
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
    cellular_record = procurement_items["cellular"]
    for alternate in [
        "Quectel_EG915Q_EG915U_LTE_Cat1bis_space_saving_branch",
        "Quectel_EG916Q_GL_LTE_Cat1bis_global_branch",
        "Fibocom_MC665_LTE_Cat1bis_second_vendor_branch",
    ]:
        if alternate not in cellular_record["alternates"]:
            raise SystemExit(f"procurement cellular missing space-saving alternate {alternate}")
    for required in [
        "smaller_module_orderable_mpn_and_lifecycle",
        "smaller_module_reference_layout_step_and_firmware_pack",
    ]:
        if required not in cellular_record["required_supplier_artifacts"]:
            raise SystemExit(f"procurement cellular missing space-saving artifact {required}")
    cellular_rfq = next(
        item for item in procurement["line_items"] if item["function"] == "cellular"
    )
    if not cellular_rfq["procurement_status"].startswith("blocked_region_sku_certification_scope"):
        raise SystemExit("procurement cellular status must include space-saving decision blocker")

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
        if not is_public_source_status(item.get("public_page_status")):
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


def check_supplier_source_verification() -> None:
    verification = load_yaml(ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml")
    audit = load_yaml(ROOT / "board/kicad/e1-phone/supplier-sourcing-audit.yaml")
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    display = load_yaml(ROOT / "package/display/v0-dsi-720x1280.yaml")
    camera = load_yaml(ROOT / "package/camera/oem-mipi-csi-modules.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    manifest = load_yaml(MANIFEST)

    if verification["schema"] != "eliza.e1_phone_supplier_source_verification.v1":
        raise SystemExit("supplier source verification schema diverges")
    if (
        verification["status"]
        != "public_sources_verified_not_supplier_approved_or_procurement_ready"
    ):
        raise SystemExit(
            f"unexpected supplier source verification status: {verification['status']}"
        )
    rel = "board/kicad/e1-phone/supplier-source-verification.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing supplier source verification artifact")
    for source in verification["source_artifacts"]:
        require_path(ROOT / source)

    policy = verification["verification_policy"]
    if policy["evidence_type"] != "public_listing_or_vendor_product_page":
        raise SystemExit("supplier source verification evidence type changed")
    if policy["source_use_limit"] != "sourcing_shortlist_and_rfq_seed_only":
        raise SystemExit("supplier source verification source-use limit changed")
    if policy["quote_quantities_required_next"] != intake["intake_policy"]["quote_quantities"]:
        raise SystemExit("supplier source verification quote quantities diverge from RFQ intake")
    if not policy["samples_required_before_pinout_or_footprint_freeze"]:
        raise SystemExit("supplier source verification must require samples before freeze")
    if not policy["signed_supplier_pack_required_before_evt1_route"]:
        raise SystemExit("supplier source verification must require supplier pack before route")
    if len(policy["required_next_artifacts"]) < 8:
        raise SystemExit("supplier source verification required artifact policy is too weak")

    sources = {item["id"]: item for item in verification["verified_sources"]}
    expected_sources = {
        "display_primary_chenghao_ch550fh01a_ct",
        "display_alternate_made_in_china_5p5_1080p_mipi_ctp",
        "display_alternate_alibaba_youritech_5p5_1080p_40pin",
        "display_alternate_alibaba_meta_055wu01",
        "display_alternate_made_in_china_e549_amoled",
        "rear_camera_primary_sincere_first_ov13855",
        "rear_camera_alternate_alibaba_ov13855_mipi",
        "front_camera_primary_sincere_first_gc5035",
        "front_camera_alternate_made_in_china_gc5035_mipi",
        "cellular_primary_quectel_rg255c",
        "wifi_bluetooth_primary_murata_type_2ea",
    }
    if set(sources) != expected_sources:
        raise SystemExit("supplier source verification source set diverges")
    if verification["cross_checks"]["source_count"] != len(sources):
        raise SystemExit("supplier source verification source count is stale")

    by_group: dict[str, list[dict]] = {}
    for source in sources.values():
        by_group.setdefault(source["group"], []).append(source)
        if not str(source.get("url", "")).startswith("https://"):
            raise SystemExit(f"supplier source verification source missing https URL: {source}")
        if not is_public_source_status(source.get("public_page_status")):
            raise SystemExit(f"supplier source verification source status stale: {source}")
        if not source.get("observed_public_fields"):
            raise SystemExit(
                f"supplier source verification source missing observed fields: {source}"
            )
        if len(source.get("still_missing_before_use", [])) < 4:
            raise SystemExit(
                f"supplier source verification source weak missing-evidence list: {source}"
            )
    expected_group_counts = {"display": 5, "camera": 4, "cellular": 1, "wifi_bluetooth": 1}
    if {group: len(items) for group, items in by_group.items()} != expected_group_counts:
        raise SystemExit("supplier source verification group counts diverge")
    for group in ["display", "camera"]:
        marketplaces = {item["marketplace_or_vendor"] for item in by_group[group]}
        if "Alibaba" not in marketplaces or "Made-in-China" not in marketplaces:
            raise SystemExit(
                f"supplier source verification missing marketplace diversity for {group}"
            )

    display_primary = sources["display_primary_chenghao_ch550fh01a_ct"]
    display_candidate = display["panel_candidates"][0]
    if display_primary["candidate"] != display_candidate["part"]:
        raise SystemExit("supplier source verification display primary diverges from package")
    if (
        display_primary["observed_public_fields"]["module_outline_mm"]
        != display_candidate["module_outline_mm"]
    ):
        raise SystemExit("supplier source verification display outline diverges from package")
    if (
        display_primary["observed_public_fields"]["active_area_mm"]
        != display_candidate["active_area_mm"]
    ):
        raise SystemExit("supplier source verification display active area diverges from package")
    if audit["selection_summary"]["screen_fit_basis"]["part"] != display_primary["candidate"]:
        raise SystemExit(
            "supplier source verification display primary diverges from sourcing audit"
        )

    rear_primary = sources["rear_camera_primary_sincere_first_ov13855"]
    rear_candidate = camera["rear_camera_primary"]["candidate_parts"][0]
    if rear_primary["candidate"] != rear_candidate["module"]:
        raise SystemExit("supplier source verification rear camera primary diverges from package")
    if rear_primary["observed_public_fields"]["resolution_mp"] != rear_candidate["resolution_mp"]:
        raise SystemExit("supplier source verification rear camera resolution diverges")
    if rear_primary["observed_public_fields"]["pinout"] != f"{rear_candidate['pin_count']}_pin":
        raise SystemExit("supplier source verification rear camera pin count diverges")

    front_primary = sources["front_camera_primary_sincere_first_gc5035"]
    front_candidate = camera["front_camera_primary"]["candidate_parts"][0]
    if front_primary["candidate"] != front_candidate["module"]:
        raise SystemExit("supplier source verification front camera primary diverges from package")
    if front_primary["observed_public_fields"]["resolution_px"] != front_candidate["resolution_px"]:
        raise SystemExit("supplier source verification front camera resolution diverges")
    if front_primary["observed_public_fields"]["pinout"] != f"{front_candidate['pin_count']}pin":
        raise SystemExit("supplier source verification front camera pin count diverges")

    cellular_primary = sources["cellular_primary_quectel_rg255c"]
    cellular_package = cellular["primary_first_phone"]
    if cellular_primary["candidate"] != "RG255C_series":
        raise SystemExit("supplier source verification cellular candidate changed")
    if (
        cellular_primary["observed_public_fields"]["peak_downlink_mbps"]
        != (cellular_package["public_features"]["peak_downlink_mbps"])
    ):
        raise SystemExit("supplier source verification cellular downlink field diverges")
    if (
        cellular_primary["observed_public_fields"]["interfaces"]
        != (cellular_package["public_features"]["host_interfaces"])
    ):
        raise SystemExit("supplier source verification cellular interfaces diverge")

    wifi_primary = sources["wifi_bluetooth_primary_murata_type_2ea"]
    wifi_package = wifi_bt["vendor_public_specs"]
    if wifi_primary["candidate"] != wifi_package["order_number"]:
        raise SystemExit("supplier source verification Wi-Fi/Bluetooth candidate diverges")
    if wifi_primary["observed_public_fields"]["dimensions_mm"] != wifi_package["package_mm"]:
        raise SystemExit("supplier source verification Wi-Fi/Bluetooth dimensions diverge")
    if wifi_primary["observed_public_fields"]["chipset"] != wifi_package["chipset"]:
        raise SystemExit("supplier source verification Wi-Fi/Bluetooth chipset diverges")

    revalidated_ids = {item["id"] for item in revalidation["revalidated_sources"]}
    for source_id in [
        "display_primary_chenghao_ch550fh01a_ct",
        "rear_camera_primary_sincere_first_ov13855",
        "front_camera_primary_sincere_first_gc5035",
    ]:
        if source_id not in revalidated_ids:
            raise SystemExit(f"supplier source verification primary not revalidated: {source_id}")

    intake_lines = {item["function"]: item for item in intake["rfq_lines"]}
    expected_intake_primary = {
        "display_touch": "CH550FH01A-CT",
        "rear_camera": "SF-XR3855A-A0_OV13855_or_OV13850_13MP_AF",
        "front_camera": "SF-G5035S60FY_GC5035_5MP_FF_MIPI",
        "cellular": "Quectel_RG255C_or_RM255C_5G_RedCap",
        "wifi_bluetooth": "Murata_LBEE5XV2EA-802_Type_2EA",
    }
    for function, candidate in expected_intake_primary.items():
        if intake_lines[function]["primary_candidate"] != candidate:
            raise SystemExit(f"supplier source verification RFQ primary changed: {function}")
        if not intake_lines[function]["intake_status"].startswith("blocked_"):
            raise SystemExit(f"supplier source verification RFQ line unexpectedly open: {function}")

    checks = verification["cross_checks"]
    for key in [
        "has_primary_display_public_dimensions",
        "has_display_alibaba_and_made_in_china_alternates",
        "has_rear_camera_public_pin_count_and_sensor_class",
        "has_front_camera_public_pin_count_and_sensor_class",
        "has_camera_alibaba_and_made_in_china_alternates",
        "has_cellular_vendor_page_with_lga_region_variants_and_host_interfaces",
        "has_wifi_bt_vendor_page_with_in_production_status_dimensions_and_interfaces",
        "all_records_have_https_urls",
        "all_records_remain_blocked_for_supplier_pack_before_use",
    ]:
        if checks[key] is not True:
            raise SystemExit(f"supplier source verification cross-check failed: {key}")
    for blocker in [
        "public pages are not supplier quote packs or approved AVL records",
        "signed 2D drawings, FPC pinouts, land patterns, and STEP models are missing",
        "physical samples and incoming inspection records are missing",
        "no orderable MPN has been approved for production BOM or KiCad footprint freeze",
    ]:
        if blocker not in verification["release_blockers"]:
            raise SystemExit(f"supplier source verification missing release blocker: {blocker}")
    for claim in [
        "supplier_approved",
        "public_sources_are_avl",
        "quote_ready",
        "samples_received",
        "pinouts_frozen",
        "footprints_frozen",
        "production_bom_ready",
        "fabrication_ready",
        "enclosure_ready",
    ]:
        if claim not in verification["forbidden_claims"]:
            raise SystemExit(f"supplier source verification missing forbidden claim {claim}")
    print(
        "supplier source verification ok: "
        f"{len(by_group['display'])} display, {len(by_group['camera'])} camera, "
        f"{len(by_group['cellular'])} cellular, {len(by_group['wifi_bluetooth'])} wifi/bt sources"
    )


def check_supplier_rfq_response_normalization() -> None:
    normalization = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    manifest = load_yaml(MANIFEST)
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    verification = load_yaml(ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml")
    revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    evidence_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    sample_gate = load_yaml(ROOT / "board/kicad/e1-phone/supplier-sample-release-gate.yaml")
    footprint_map = load_yaml(ROOT / "board/kicad/e1-phone/footprint-3d-model-library-map.yaml")
    routed = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    enclosure = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")

    if normalization["schema"] != "eliza.e1_phone_supplier_rfq_response_normalization.v1":
        raise SystemExit(
            f"unexpected supplier RFQ response normalization schema: {normalization['schema']}"
        )
    if (
        normalization["status"]
        != "blocked_response_normalization_ready_no_supplier_responses_received"
    ):
        raise SystemExit(
            f"unexpected supplier RFQ response normalization status: {normalization['status']}"
        )
    rel = "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing supplier RFQ response normalization artifact")
    for source in normalization["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "rfq_intake": intake["status"],
        "source_verification": verification["status"],
        "display_camera_source_revalidation": revalidation["status"],
        "rfq_transmittal_drafts": drafts["status"],
        "supplier_to_kicad_evidence_map": evidence_map["status"],
        "supplier_sample_release_gate": sample_gate["status"],
        "footprint_3d_model_library_map": footprint_map["status"],
        "routed_pcb_implementation": routed["status"],
        "enclosure_fit_execution": enclosure["status"],
    }
    if normalization["upstream_status"] != expected_upstream:
        raise SystemExit("supplier RFQ response normalization upstream snapshot is stale")

    response_schema = normalization["response_schema"]
    if response_schema["quote_quantities"] != intake["intake_policy"]["quote_quantities"]:
        raise SystemExit("supplier RFQ response normalization quote quantities diverge")
    if (
        response_schema["minimum_sample_lot_per_candidate"]
        != intake["intake_policy"]["minimum_sample_lot_per_candidate"]
    ):
        raise SystemExit("supplier RFQ response normalization sample lot diverges")
    if (
        response_schema["production_response_archive_root"]
        != "board/kicad/e1-phone/production/sourcing"
    ):
        raise SystemExit("supplier RFQ response normalization archive root changed")
    required_fields = set(response_schema["required_response_fields"])
    for field in [
        "orderable_manufacturer_part_number",
        "unit_price_10",
        "unit_price_100",
        "unit_price_1000",
        "lead_time_days_10",
        "lead_time_days_100",
        "lead_time_days_1000",
        "signed_2d_drawing_path",
        "pinout_or_pad_map_path",
        "recommended_land_pattern_path",
        "step_or_brep_model_path",
        "compliance_pack_index_path",
        "sample_lot_tracking",
        "incoming_inspection_path",
        "enclosure_datums_and_keepouts_path",
        "approved_by_ee",
        "approved_by_me",
        "approved_by_ops",
    ]:
        if field not in required_fields:
            raise SystemExit(f"supplier RFQ response normalization missing required field: {field}")
    if response_schema["all_boolean_gates_default_false"] is not True:
        raise SystemExit("supplier RFQ response normalization gates must default false")
    for gate in [
        "orderable_mpn_received",
        "signed_2d_drawing_received",
        "pinout_or_pad_map_received",
        "recommended_land_pattern_received",
        "step_or_brep_model_received",
        "sample_received_and_inspected",
        "compliance_pack_received",
        "pinout_symbol_footprint_reviews_complete",
        "enclosure_datums_reviewed",
        "quote_approved_for_evt1_buy",
    ]:
        if gate not in response_schema["required_boolean_gates"]:
            raise SystemExit(f"supplier RFQ response normalization missing boolean gate: {gate}")

    intake_lines = {item["function"]: item for item in intake["rfq_lines"]}
    draft_records = {item["function"]: item for item in drafts["drafts"]}
    evidence_records = {item["function"]: item for item in evidence_map["evidence_records"]}
    gate_records = {item["function"]: item for item in sample_gate["handoff_records"]}
    records = {item["function"]: item for item in normalization["response_records"]}
    expected_functions = set(intake_lines)
    if set(records) != expected_functions or set(records) != set(gate_records):
        raise SystemExit("supplier RFQ response normalization function set diverges")
    if len(records) != 10:
        raise SystemExit(
            f"supplier RFQ response normalization expected 10 records, got {len(records)}"
        )

    verified_ids = {item["id"] for item in verification["verified_sources"]}
    revalidated_ids = {item["id"] for item in revalidation["revalidated_sources"]}
    allowed_shortlist_ids = (
        verified_ids
        | revalidated_ids
        | {
            "display_alternate_alibaba_meta_055wu01",
            "rear_camera_primary_sincere_first_ov13850_30pin",
            "usb_c_receptacle_evt0_package_binding",
            "side_buttons_package_binding",
            "battery_pack_marketplace_quote_pool",
            "audio_package_binding",
            "top_bottom_interconnect_package_binding",
        }
    )
    response_packs_present: list[str] = []
    response_pack_placeholders_present: list[str] = []
    response_packs_missing: list[str] = []
    for function, record in records.items():
        intake_line = intake_lines[function]
        draft = draft_records[function]
        evidence = evidence_records[function]
        gate_record = gate_records[function]
        if record["status"] != "blocked_waiting_supplier_response_normalized_pack":
            raise SystemExit(
                f"supplier RFQ response normalization record unexpectedly open: {function}"
            )
        if record["primary_candidate"] != intake_line["primary_candidate"]:
            raise SystemExit(f"supplier RFQ response normalization candidate stale: {function}")
        if record["package_binding"] != intake_line["package_binding"]:
            raise SystemExit(
                f"supplier RFQ response normalization package binding stale: {function}"
            )
        if record["draft_path"] != draft["planned_archive_paths_after_send"]["draft"]:
            raise SystemExit(f"supplier RFQ response normalization draft path stale: {function}")
        if record["draft_path"] != gate_record["draft_path"]:
            raise SystemExit(
                f"supplier RFQ response normalization sample gate draft path stale: {function}"
            )
        if record["planned_response_pack"] != evidence["rfq_transmittal_draft"][
            "planned_release_archive"
        ].replace("rfq-transmittal.yaml", "rfq-response-pack.yaml"):
            raise SystemExit(
                f"supplier RFQ response normalization response pack path stale: {function}"
            )
        if record["planned_response_pack"] != gate_record["draft_path"].replace(
            "sourcing-drafts", "production/sourcing"
        ).replace("rfq-transmittal.yaml", "rfq-response-pack.yaml"):
            raise SystemExit(
                f"supplier RFQ response normalization response pack not coupled to sample gate: {function}"
            )
        if not set(record["public_source_ids"]) <= allowed_shortlist_ids:
            raise SystemExit(f"supplier RFQ response normalization unknown source id: {function}")
        if len(record["expected_supplier_return"]) < 6:
            raise SystemExit(
                f"supplier RFQ response normalization weak return requirements: {function}"
            )
        if len(record["routing_unlocks_blocked"]) < 4:
            raise SystemExit(
                f"supplier RFQ response normalization weak routing blockers: {function}"
            )
        if function == "cellular":
            if not record["expected_supplier_return"].get(
                "compact_lte_cat1_bis_alternate_quote_required"
            ):
                raise SystemExit(
                    "supplier RFQ response normalization missing compact cellular alternate quote"
                )
            if not any("compact alternate" in item for item in record["routing_unlocks_blocked"]):
                raise SystemExit(
                    "supplier RFQ response normalization missing compact cellular routing blocker"
                )
        response_pack = ROOT / record["planned_response_pack"]
        if response_pack.exists():
            try:
                response_pack_data = load_yaml(response_pack)
            except Exception:
                response_pack_data = {}
            if (
                isinstance(response_pack_data, dict)
                and response_pack_data.get("release_credit") is False
                and str(response_pack_data.get("schema", "")).endswith(
                    "supplier_return_intake_placeholder.v1"
                )
            ):
                response_pack_placeholders_present.append(record["planned_response_pack"])
            else:
                response_packs_present.append(record["planned_response_pack"])
        else:
            response_packs_missing.append(record["planned_response_pack"])

    browser_ids = {item["id"] for item in normalization["current_browser_refresh"]["sources"]}
    for source_id in [
        "display_primary_chenghao_ch550fh01a_ct",
        "display_alternate_alibaba_meta_055wu01",
        "rear_camera_primary_sincere_first_ov13855",
        "front_camera_primary_sincere_first_gc5035",
    ]:
        if source_id not in browser_ids:
            raise SystemExit(
                f"supplier RFQ response normalization missing browser refresh source: {source_id}"
            )
    if normalization["current_browser_refresh"]["use_limit"].find("do not replace") == -1:
        raise SystemExit("supplier RFQ response normalization browser source use limit weakened")

    outputs = normalization["normalization_outputs"]
    if outputs["expected_response_pack_count"] != len(records):
        raise SystemExit("supplier RFQ response normalization expected pack count stale")
    if outputs["present_response_pack_count"] != len(response_packs_present):
        raise SystemExit("supplier RFQ response normalization present pack count stale")
    release_missing_response_pack_count = len(response_packs_missing) + len(
        response_pack_placeholders_present
    )
    if outputs["missing_response_pack_count"] != release_missing_response_pack_count:
        raise SystemExit("supplier RFQ response normalization missing pack count stale")
    if response_packs_present:
        raise SystemExit(
            f"supplier RFQ response normalization response packs unexpectedly exist: {response_packs_present}"
        )
    if len(response_pack_placeholders_present) != len(records):
        raise SystemExit("supplier RFQ response normalization placeholder pack coverage stale")
    if outputs["every_planned_response_pack_absent"] is not True:
        raise SystemExit("supplier RFQ response normalization must remain fail-closed")

    for name, value in normalization["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"supplier RFQ response normalization cross-check failed: {name}")
    for blocker in [
        "no supplier RFQ has been sent or returned as production evidence",
        "normalized response packs for all 10 supplier functions are missing",
        "orderable MPNs, signed drawings, pinouts, land patterns, STEP models, samples, lifecycle, lead time, and price breaks are missing",
        "schematic capture, routing, factory release, and enclosure fit must remain blocked until response packs and reviews close",
    ]:
        if blocker not in normalization["release_blockers"]:
            raise SystemExit(f"supplier RFQ response normalization missing blocker: {blocker}")
    for claim in [
        "rfq_responses_received",
        "supplier_quotes_approved",
        "orderable_mpns_approved",
        "supplier_pinouts_ready",
        "supplier_footprints_ready",
        "supplier_step_models_bound",
        "kicad_capture_ready",
        "routed_layout_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in normalization["forbidden_claims"]:
            raise SystemExit(f"supplier RFQ response normalization missing forbidden claim {claim}")
    print(
        "supplier RFQ response normalization ok: "
        f"{len(records)} functions, {release_missing_response_pack_count} response packs absent"
    )


def check_supplier_rfq_transmittal_drafts() -> None:
    drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    source_verification = load_yaml(ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml")
    display_camera_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
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
    display_camera_rfq_matrix = display_camera_revalidation["rfq_readiness_matrix"]
    expected_display_camera_trace_keys = {
        "display_touch": "display_touch",
        "rear_camera": "rear_camera",
        "front_camera": "front_camera",
    }
    radio_stack = radio_selection["selected_wireless_stack"]
    radio_fit = radio_selection["placement_fit_decision"]
    radio_rf = radio_selection["rf_feed_contract"]
    usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    usb_route = usb_sidekey_selection["route_and_probe_contract"]
    expected_selected_hardware_traces = {
        "cellular": {
            "selection_source": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
            "selected_reference": (
                f"{radio_stack['cellular_performance_reference']['vendor']}_"
                f"{radio_stack['cellular_performance_reference']['family']}_"
                f"{radio_stack['cellular_performance_reference']['class']}"
            ),
            "selected_phone_form_factor": (
                radio_stack["cellular_performance_reference"]["selected_phone_form_factor"]
            ),
            "active_space_saving_rfq_branch": (
                radio_stack["cellular_space_saving_branch"]["preferred_candidate_id"]
            ),
            "current_region_fits_selected_reference": (
                radio_fit["cellular_current_region"]["fits_current_region"]
            ),
            "rf_feed_count_required": radio_rf["required_rf_feed_count"],
            "release_allowed_without_supplier_response_packs": (
                radio_selection["supplier_release_policy"][
                    "release_allowed_without_supplier_response_packs"
                ]
            ),
            "route_release_dependency": (
                "U_CELL_route_release_remain_blocked_until_top_rf_island_repack_or_smaller_supplier_approved_module"
            ),
        },
        "wifi_bluetooth": {
            "selection_source": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
            "selected_module": (
                f"{radio_stack['wifi_bluetooth_primary']['vendor']}_"
                f"{radio_stack['wifi_bluetooth_primary']['order_number']}_"
                f"{radio_stack['wifi_bluetooth_primary']['chipset']}"
            ),
            "wifi_standard": radio_stack["wifi_bluetooth_primary"]["wireless"]["wifi"],
            "bluetooth_standard": (radio_stack["wifi_bluetooth_primary"]["wireless"]["bluetooth"]),
            "current_region_fits_selected_module": (
                radio_fit["wifi_bluetooth_current_region"]["fits_current_region"]
            ),
            "rf_feed_count_required": len(radio_rf["wifi_bluetooth_ports"]),
            "release_allowed_without_supplier_response_packs": (
                radio_selection["supplier_release_policy"][
                    "release_allowed_without_supplier_response_packs"
                ]
            ),
            "route_release_dependency": (
                "U_WIFI_BT_route_release_remain_blocked_until_murata_design_pack_reference_layout_firmware_and_regulatory_scope"
            ),
        },
        "usb_c_receptacle_evt0": {
            "selection_source": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
            "selected_connector": (
                f"{usb_stack['usb_c_evt0_connector']['vendor']}_"
                f"{usb_stack['usb_c_evt0_connector']['family']}"
            ),
            "conditional_alternate": (
                f"{usb_stack['usb_c_conditional_alternate']['vendor']}_"
                f"{usb_stack['usb_c_conditional_alternate']['family']}"
            ),
            "pd_controller": usb_stack["usb_pd_controller"]["part"],
            "charger_power_path": usb_stack["charger_power_path"]["part"],
            "usb2_diff_pair_constraint": usb_route["usb2_diff_pair"]["routing_constraint"],
            "release_allowed_without_supplier_response_packs": (
                usb_sidekey_selection["bringup_and_release_policy"][
                    "release_allowed_without_supplier_response_packs"
                ]
            ),
            "route_release_dependency": (
                "J_USB_C_route_release_remain_blocked_until_signed_connector_drawing_step_shell_load_path_and_routed_board_step"
            ),
        },
        "side_buttons": {
            "selection_source": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
            "selected_side_key_family": (
                f"{usb_stack['side_key_primary']['vendor']}_"
                f"{usb_stack['side_key_primary']['family']}"
            ),
            "conditional_alternate": (
                f"{usb_stack['side_key_conditional_alternate']['vendor']}_"
                f"{usb_stack['side_key_conditional_alternate']['family']}"
            ),
            "external_buttons": (
                usb_sidekey_selection["placement_and_mechanical_policy"]["side_keys"][
                    "external_buttons"
                ]
            ),
            "side_key_bus_constraint": usb_route["side_key_bus"]["routing_constraint"],
            "release_allowed_without_supplier_response_packs": (
                usb_sidekey_selection["bringup_and_release_policy"][
                    "release_allowed_without_supplier_response_packs"
                ]
            ),
            "route_release_dependency": (
                "side_key_route_release_remain_blocked_until_switch_or_flex_drawing_force_travel_stack_wake_recovery_and_routed_step_clearance"
            ),
        },
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
        if (
            draft["request"]["required_supplier_artifacts"]
            != intake_line["required_supplier_artifacts"]
        ):
            raise SystemExit(f"supplier RFQ draft {function} requested artifacts diverge")
        if draft["request"]["board_dependency"] != intake_line["board_dependency"]:
            raise SystemExit(f"supplier RFQ draft {function} board dependency diverges")
        if function == "cellular":
            required_text = "smaller LTE Cat 1 bis alternate orderable MPN"
            if not any(
                required_text in item for item in draft["request"]["required_supplier_artifacts"]
            ):
                raise SystemExit("supplier RFQ draft missing compact cellular alternate request")
            if not any(
                "compact LTE Cat 1 bis alternate fit" in item
                for item in draft["request"]["board_dependency"]
            ):
                raise SystemExit("supplier RFQ draft missing compact cellular board dependency")
            candidate_names = {item["candidate"] for item in draft["recipient_candidates"]}
            for candidate in [
                "EG915Q_EG915U_or_EG916Q_GL_compact_LTE_Cat1bis",
                "MC665_compact_LTE_Cat1bis",
            ]:
                if candidate not in candidate_names:
                    raise SystemExit(
                        f"supplier RFQ draft missing compact cellular recipient {candidate}"
                    )
        if draft["request"]["quote_quantities"] != policy["quote_quantities"]:
            raise SystemExit(f"supplier RFQ draft {function} quote quantities diverge")
        if draft["request"]["minimum_sample_lot"] != policy["minimum_sample_lot_per_candidate"]:
            raise SystemExit(f"supplier RFQ draft {function} sample lot diverges")
        if (
            draft["request"]["required_response_format"]
            != intake_policy["required_response_format"]
        ):
            raise SystemExit(f"supplier RFQ draft {function} response format diverges")
        if (
            draft["request"]["accepted_document_languages"]
            != intake_policy["accepted_document_languages"]
        ):
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
        if function in expected_display_camera_trace_keys:
            trace = draft.get("source_revalidation_trace")
            if not trace:
                raise SystemExit(
                    f"supplier RFQ draft missing source revalidation trace: {function}"
                )
            rfq_key = expected_display_camera_trace_keys[function]
            matrix_item = display_camera_rfq_matrix[rfq_key]
            if trace["rfq_matrix_key"] != rfq_key:
                raise SystemExit(f"supplier RFQ source trace key stale: {function}")
            if trace["primary_revalidated_source_id"] != matrix_item["primary_source_id"]:
                raise SystemExit(f"supplier RFQ source trace primary stale: {function}")
            if trace["rfq_ready_from_public_page"] != matrix_item["rfq_ready_from_public_page"]:
                raise SystemExit(f"supplier RFQ source trace ready flag stale: {function}")
            if trace["production_release_ready"] != matrix_item["production_release_ready"]:
                raise SystemExit(f"supplier RFQ source trace release flag stale: {function}")
            if trace["route_release_dependency"] != matrix_item["route_release_dependency"]:
                raise SystemExit(f"supplier RFQ source trace dependency stale: {function}")
            if trace["production_release_ready"] is not False:
                raise SystemExit(
                    f"supplier RFQ source trace unexpectedly release-ready: {function}"
                )
            if "remain_blocked" not in trace["route_release_dependency"]:
                raise SystemExit(f"supplier RFQ source trace must remain blocked: {function}")
            if function == "display_touch" and (
                trace.get("supplemental_revalidated_source_id")
                != matrix_item["supplemental_public_source_id"]
            ):
                raise SystemExit("display RFQ source trace supplemental source stale")
            if function == "front_camera":
                rejected = display_camera_rfq_matrix["alibaba_camera_alternate"]
                if (
                    trace.get("rejected_alibaba_alternate_source_id")
                    != rejected["primary_source_id"]
                ):
                    raise SystemExit("front camera RFQ rejected Alibaba source trace stale")
                if (
                    trace.get("rejected_alibaba_alternate_rfq_ready_from_public_page")
                    != rejected["rfq_ready_from_public_page"]
                ):
                    raise SystemExit("front camera RFQ rejected Alibaba ready flag stale")
        if function in expected_selected_hardware_traces:
            trace = draft.get("selected_hardware_trace")
            if trace != expected_selected_hardware_traces[function]:
                raise SystemExit(f"supplier RFQ selected hardware trace stale: {function}")
            if trace["release_allowed_without_supplier_response_packs"] is not False:
                raise SystemExit(
                    f"supplier RFQ selected hardware trace unexpectedly releasable: {function}"
                )
            if "remain_blocked" not in trace["route_release_dependency"]:
                raise SystemExit(
                    f"supplier RFQ selected hardware trace must remain blocked: {function}"
                )

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
    source_verification = load_yaml(ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml")

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
        "display_primary_pdf_still_exposes",
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
        "display_primary_chenghao_ch550fh01a_ct_public_pdf",
        "display_alternate_alibaba_meta_055wu01",
        "display_alternate_made_in_china_e549_amoled",
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
    display_pdf = sources["display_primary_chenghao_ch550fh01a_ct_public_pdf"]
    if display_pdf["source_type"] != "direct_chenghao_pdf_opened_2026_05_21":
        raise SystemExit("display primary PDF source type is stale")
    pdf_fields = display_pdf["observed_public_fields"]
    if pdf_fields["model"] != display["observed_public_fields"]["model"]:
        raise SystemExit("display primary PDF model diverges from marketplace listing")
    if pdf_fields["module_outline_mm"] != display_fit["selected_primary_display"]["outline_mm"]:
        raise SystemExit("display primary PDF outline diverges from display fit")
    if pdf_fields["tft_interface"] != "4_lane_MIPI" or pdf_fields["ctp_interface"] != "I2C":
        raise SystemExit("display primary PDF interface fields changed")
    if pdf_fields["tft_driver_ic"] != "HX8399C" or pdf_fields["ctp_driver_ic"] != "GT911":
        raise SystemExit("display primary PDF driver fields changed")

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
    if (
        front["board_decision"]
        != "keep_as_front_camera_primary_class_pending_supplier_xy_z_drawing"
    ):
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

    rfq_matrix = revalidation["rfq_readiness_matrix"]
    expected_rfq_sources = {
        "display_touch": "display_primary_chenghao_ch550fh01a_ct",
        "display_alibaba_alternate": "display_alternate_alibaba_meta_055wu01",
        "display_amoled_alternate": "display_alternate_made_in_china_e549_amoled",
        "rear_camera": "rear_camera_primary_sincere_first_ov13855",
        "front_camera": "front_camera_primary_sincere_first_gc5035",
        "alibaba_camera_alternate": "front_camera_alternate_alibaba_junde_imx219",
    }
    if set(rfq_matrix) != set(expected_rfq_sources):
        raise SystemExit("display/camera RFQ readiness matrix set diverges")
    for item_id, source_id in expected_rfq_sources.items():
        item = rfq_matrix[item_id]
        if item["primary_source_id"] != source_id:
            raise SystemExit(f"display/camera RFQ matrix source stale: {item_id}")
        if item["production_release_ready"] is not False:
            raise SystemExit(f"display/camera RFQ matrix unexpectedly release-ready: {item_id}")
        if len(item.get("supplier_questions_to_send", [])) < 2:
            raise SystemExit(f"display/camera RFQ matrix questions too weak: {item_id}")
        if "remain_blocked" not in item["route_release_dependency"]:
            raise SystemExit(f"display/camera RFQ matrix dependency must stay blocked: {item_id}")
    display_rfq = rfq_matrix["display_touch"]
    if display_rfq["candidate_to_quote"] != display["observed_public_fields"]["model"]:
        raise SystemExit("display RFQ candidate diverges from observed public model")
    if (
        display_rfq["supplemental_public_source_id"]
        != "display_primary_chenghao_ch550fh01a_ct_public_pdf"
    ):
        raise SystemExit("display RFQ missing PDF supplemental source")
    if not {
        "qty_2_to_299",
        "qty_300_to_999",
        "qty_1000_plus",
    } <= set(display_rfq["observed_quote_basis"]["public_price_signal_usd"]):
        raise SystemExit("display RFQ price ladder too weak")
    if "HX8399C" not in " ".join(display_rfq["supplier_questions_to_send"]):
        raise SystemExit("display RFQ questions missing display driver request")
    rear_rfq = rfq_matrix["rear_camera"]
    if (
        rear_rfq["observed_quote_basis"]["public_pin_count"]
        != rear["observed_public_fields"]["pin_count"]
    ):
        raise SystemExit("rear camera RFQ pin-count diverges from public source")
    if (
        rear_rfq["observed_quote_basis"]["public_sensor_class"]
        != rear["observed_public_fields"]["sensor_class"]
    ):
        raise SystemExit("rear camera RFQ sensor diverges from public source")
    front_rfq = rfq_matrix["front_camera"]
    if (
        front_rfq["observed_quote_basis"]["public_pin_count"]
        != front["observed_public_fields"]["pin_count"]
    ):
        raise SystemExit("front camera RFQ pin-count diverges from public source")
    if (
        front_rfq["observed_quote_basis"]["public_mipi_lanes"]
        != front["observed_public_fields"]["mipi_lanes"]
    ):
        raise SystemExit("front camera RFQ MIPI lane count diverges from public source")
    alibaba_rfq = rfq_matrix["alibaba_camera_alternate"]
    if alibaba_rfq["rfq_ready_from_public_page"] is not False:
        raise SystemExit("Alibaba camera alternate must remain not RFQ-ready from current page")
    if (
        alibaba_rfq["observed_quote_basis"]["fit_result"]
        != "rejected_for_current_17_x_13_mm_camera_region"
    ):
        raise SystemExit("Alibaba camera alternate RFQ fit result stale")

    checks = revalidation["cross_checks"]
    for key in [
        "primary_display_matches_display_fit",
        "primary_display_fits_device_envelope",
        "front_camera_junde_alternate_still_rejected_by_active_matrix",
        "made_in_china_primary_display_verified",
        "display_pdf_datasheet_matches_primary_outline",
        "display_pdf_adds_driver_touch_controller_rfq_fields",
        "made_in_china_primary_camera_sources_verified",
        "alibaba_camera_alternate_not_promoted",
        "requires_quote_drawing_samples_before_release",
        "supplier_source_verification_still_fail_closed",
        "current_public_fields_revalidated_2026_05_21",
        "alibaba_direct_page_remains_shortlist_only_until_parseable_or_supplier_response",
        "rfq_matrix_tracks_display_camera_primary_sources",
        "rfq_matrix_keeps_alibaba_camera_alternate_out_of_current_layout_release",
    ]:
        if checks[key] is not True:
            raise SystemExit(f"display/camera source revalidation cross-check failed: {key}")
    if (
        source_verification["status"]
        != "public_sources_verified_not_supplier_approved_or_procurement_ready"
    ):
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


def check_display_envelope_downselect() -> None:
    downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    display_package = load_yaml(ROOT / "package/display/v0-dsi-720x1280.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    integration = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-oem-integration.yaml")
    layout = load_yaml(ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml")
    manifest = load_yaml(MANIFEST)

    if downselect["schema"] != "eliza.e1_phone_display_envelope_downselect.v1":
        raise SystemExit("display envelope downselect schema diverges")
    if (
        downselect["status"]
        != "blocked_display_envelope_downselect_requires_signed_display_stack_connector_and_routed_clearance"
    ):
        raise SystemExit(f"unexpected display envelope downselect status: {downselect['status']}")
    rel = "board/kicad/e1-phone/display-envelope-downselect.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing display envelope downselect")
    for artifact in [integration, layout]:
        if rel not in artifact["source_artifacts"]:
            raise SystemExit(
                "display envelope downselect is not cited by downstream layout/display gate"
            )
    for source in downselect["source_artifacts"]:
        require_path(ROOT / source)

    upstream = downselect["upstream_status"]
    expected_upstream = {
        "display_fit": display_fit["status"],
        "display_package": display_package["status"],
        "display_camera_source_revalidation": source_revalidation["status"],
        "display_camera_oem_integration": integration["status"],
        "layout_optimization_execution": layout["status"],
    }
    if upstream != expected_upstream:
        raise SystemExit("display envelope downselect upstream status stale")

    primary = downselect["selected_screen_decision"]
    package_primary = display_package["panel_candidates"][0]
    fit_primary = display_fit["selected_primary_display"]
    if primary["part"] != package_primary["part"] or primary["part"] != fit_primary["part"]:
        raise SystemExit("display envelope primary part diverges from package or display-fit")
    if primary["vendor"] != package_primary["vendor"]:
        raise SystemExit("display envelope primary vendor diverges from package")
    if primary["resolution"] != package_primary["resolution"]:
        raise SystemExit("display envelope primary resolution diverges from package")
    if primary["interface"] != package_primary["interface"]:
        raise SystemExit("display envelope primary interface diverges from package")
    if primary["board_use"] != "primary_display_and_device_envelope_anchor":
        raise SystemExit("display envelope primary board use changed")

    mechanical = downselect["mechanical_fit_decision"]
    if mechanical["current_device_envelope_mm"] != display_fit["current_device_envelope_mm"]:
        raise SystemExit("display envelope current device envelope diverges from display-fit")
    if mechanical["current_device_envelope_mm"] != manifest["design_target"]["device_envelope_mm"]:
        raise SystemExit("display envelope current device envelope diverges from manifest")
    if mechanical["primary_module_outline_mm"] != fit_primary["outline_mm"]:
        raise SystemExit("display envelope primary outline diverges from display-fit")
    if mechanical["primary_module_outline_mm"] != package_primary["module_outline_mm"]:
        raise SystemExit("display envelope primary outline diverges from display package")
    if mechanical["primary_active_area_mm"] != fit_primary["active_area_mm"]:
        raise SystemExit("display envelope active area diverges from display-fit")
    if (
        mechanical["minimum_envelope_for_primary_with_margin_mm"]
        != display_fit["minimum_envelope_for_primary_with_margin_mm"]
    ):
        raise SystemExit("display envelope minimum envelope diverges from display-fit")
    if (
        mechanical["clearance_in_current_envelope_mm"]
        != display_fit["primary_clearance_in_current_envelope_mm"]
    ):
        raise SystemExit("display envelope clearance diverges from display-fit")
    if mechanical["primary_fits_current_envelope"] != display_fit["primary_fits_current_envelope"]:
        raise SystemExit("display envelope fit flag diverges from display-fit")
    if (
        mechanical["board_fit_behind_primary_display"]
        != display_fit["board_fit_behind_primary_display"]
    ):
        raise SystemExit("display envelope board-behind-display fit diverges from display-fit")

    min_envelope = mechanical["minimum_envelope_for_primary_with_margin_mm"]
    outline = mechanical["primary_module_outline_mm"]
    expected_min_width = round(outline["width"] + 2 * min_envelope["side_margin_each_mm"], 2)
    expected_min_height = round(
        outline["height"] + 2 * min_envelope["top_bottom_margin_each_mm"], 2
    )
    if min_envelope["width"] != expected_min_width or min_envelope["height"] != expected_min_height:
        raise SystemExit("display envelope minimum dimensions are not derived from margins")
    clearance = mechanical["clearance_in_current_envelope_mm"]
    if clearance["width_clearance_mm"] < 0.8 or clearance["height_clearance_mm"] < 1.8:
        raise SystemExit("display envelope clearance regressed below planning threshold")

    alternates = downselect["alternate_policy"]
    forfuture = alternates["forfuture_fet_e549_hco1_amoled_class"]
    package_forfuture = display_package["panel_candidates"][2]
    if forfuture["known_outline_mm"] != package_forfuture["outline_mm"]:
        raise SystemExit("display envelope Forfuture outline diverges from display package")
    if not forfuture["fits_current_envelope"]:
        raise SystemExit("display envelope Forfuture known outline should fit current envelope")
    if "not_promoted" not in forfuture["board_decision"]:
        raise SystemExit("display envelope Forfuture alternate unexpectedly promoted")
    for alternate_id in [
        "meta_display_055wu01_class",
        "alibaba_ili7807d_5p5_1200nit_class",
        "lower_resolution_open_driver_alternates",
    ]:
        if "not_promoted" not in alternates[alternate_id]["board_decision"]:
            raise SystemExit(f"display envelope alternate unexpectedly promoted: {alternate_id}")

    gate = downselect["release_gate"]
    if len(gate["allowed_planning_claims"]) < 3 or len(gate["blocked_until"]) < 5:
        raise SystemExit("display envelope release gate is too weak")
    for key, value in downselect["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"display envelope downselect cross-check failed: {key}")
    for blocker in [
        "Signed display/touch 2D drawing, cover-lens stack, FPC exit datum, pinout, connector, STEP, and samples are missing.",
        "MIPI DSI route, length/skew, impedance, return-path, and DRC/SI evidence is missing.",
        "Display power sequence, touch probe, brightness, inrush, and bring-up logs are missing.",
        "Routed-board STEP does not yet prove display FPC bend, connector height, camera/top-speaker clearance, or enclosure tolerance.",
    ]:
        if blocker not in downselect["release_blockers"]:
            raise SystemExit(f"display envelope downselect missing blocker: {blocker}")
    for claim in [
        "display_size_final",
        "display_supplier_approved",
        "display_connector_ready",
        "display_pinout_frozen",
        "cover_glass_stack_ready",
        "mipi_dsi_routed",
        "display_bringup_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in downselect["forbidden_claims"]:
            raise SystemExit(f"display envelope downselect missing forbidden claim {claim}")
    print(
        "display envelope downselect ok: "
        f"{primary['part']} anchors {mechanical['current_device_envelope_mm']['width']}x"
        f"{mechanical['current_device_envelope_mm']['height']}mm, alternates fail-closed"
    )


def check_display_camera_connector_pinout_execution() -> None:
    execution = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )
    integration = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-oem-integration.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    schematic_netclass = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml"
    )
    block_netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    manifest = load_yaml(MANIFEST)

    if execution["schema"] != "eliza.e1_phone_display_camera_connector_pinout_execution.v1":
        raise SystemExit("display/camera connector pinout execution schema diverges")
    if (
        execution["status"]
        != "blocked_requires_supplier_display_camera_pinouts_connector_mpn_footprints_and_step"
    ):
        raise SystemExit(
            f"unexpected display/camera connector pinout execution status: {execution['status']}"
        )
    rel = "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing display/camera connector pinout execution artifact")
    for source in [
        "board/kicad/e1-phone/display-camera-oem-integration.yaml",
        "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml",
        "package/display/v0-dsi-720x1280.yaml",
        "package/camera/oem-mipi-csi-modules.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/schematic-netclass-execution-package.yaml",
        "board/kicad/e1-phone/display-camera-schematic-net-binding.yaml",
        "board/kicad/e1-phone/display-fit.yaml",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"display/camera connector pinout execution missing source {source}")
        require_path(ROOT / source)

    upstream = execution["upstream_status"]
    if upstream["display_camera_integration_status"] != integration["status"]:
        raise SystemExit("display/camera connector integration status stale")
    if upstream["source_revalidation_status"] != source_revalidation["status"]:
        raise SystemExit("display/camera connector source revalidation status stale")
    if upstream["schematic_netclass_status"] != schematic_netclass["status"]:
        raise SystemExit("display/camera connector netclass status stale")
    if upstream["display_fit_status"] != display_fit["status"]:
        raise SystemExit("display/camera connector display fit status stale")

    context = execution["selected_oem_context"]
    display_context = integration["display_oem_context"]
    camera_context = integration["camera_oem_context"]
    if context["display_part"] != display_context["selected_primary"]["part"]:
        raise SystemExit("display/camera connector display part stale")
    if context["display_outline_mm"] != display_fit["selected_primary_display"]["outline_mm"]:
        raise SystemExit("display/camera connector display outline stale")
    if context["display_clearance_mm"] != display_fit["primary_clearance_in_current_envelope_mm"]:
        raise SystemExit("display/camera connector display clearance stale")
    if context["rear_camera_module"] != camera_context["rear_primary"]["module"]:
        raise SystemExit("display/camera connector rear camera module stale")
    if context["rear_camera_public_pin_count"] != camera_context["rear_primary"]["pin_count"]:
        raise SystemExit("display/camera connector rear camera pin count stale")
    if context["front_camera_module"] != camera_context["front_primary"]["module"]:
        raise SystemExit("display/camera connector front camera module stale")
    if context["front_camera_public_pin_count"] != camera_context["front_primary"]["pin_count"]:
        raise SystemExit("display/camera connector front camera pin count stale")

    block_nets: set[str] = set()
    for block in block_netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    route_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    expected_interfaces = {
        "display_touch_fpc": {
            "refdes": "J_DISPLAY_TOUCH",
            "source_candidate": context["display_part"],
            "public_pin_count": None,
            "route_pair_count": 5,
        },
        "rear_camera_fpc": {
            "refdes": "J_CAM0",
            "source_candidate": context["rear_camera_module"],
            "public_pin_count": context["rear_camera_public_pin_count"],
            "route_pair_count": 5,
        },
        "front_camera_fpc": {
            "refdes": "J_CAM1",
            "source_candidate": context["front_camera_module"],
            "public_pin_count": context["front_camera_public_pin_count"],
            "route_pair_count": 3,
        },
    }
    records = {item["interface_id"]: item for item in execution["connector_pinout_execution"]}
    if set(records) != set(expected_interfaces):
        raise SystemExit("display/camera connector execution interface set diverges")
    total_contract_nets = 0
    for interface_id, expected in expected_interfaces.items():
        record = records[interface_id]
        if record["refdes"] != expected["refdes"]:
            raise SystemExit(f"display/camera connector refdes stale: {interface_id}")
        if record["source_candidate"] != expected["source_candidate"]:
            raise SystemExit(f"display/camera connector source candidate stale: {interface_id}")
        if record["public_pin_count"] != expected["public_pin_count"]:
            raise SystemExit(f"display/camera connector public pin count stale: {interface_id}")
        if (
            record["status"]
            != "blocked_waiting_supplier_pinout_connector_land_pattern_step_and_samples"
        ):
            raise SystemExit(
                f"display/camera connector interface unexpectedly open: {interface_id}"
            )
        if record["pin_assignment_state"] != "not_assigned_until_supplier_pinout_received":
            raise SystemExit(
                f"display/camera connector pin assignment not fail-closed: {interface_id}"
            )
        contract_nets = set(record["required_contract_nets"])
        total_contract_nets += len(contract_nets)
        missing_nets = sorted(contract_nets - block_nets)
        if missing_nets:
            raise SystemExit(
                f"display/camera connector required nets missing from block netlist "
                f"for {interface_id}: {missing_nets}"
            )
        route_groups = record["route_constraint_groups"]
        if len(route_groups) != expected["route_pair_count"]:
            raise SystemExit(f"display/camera connector route pair count stale: {interface_id}")
        for group in route_groups:
            route_pair = route_pairs[group["name"]]
            for key in ["nets", "class", "max_length_mm", "intra_pair_skew_mm_max"]:
                if group[key] != route_pair[key]:
                    raise SystemExit(
                        f"display/camera connector route constraint stale: "
                        f"{interface_id} {group['name']} {key}"
                    )
        for task_key in [
            "symbol_capture_tasks",
            "footprint_capture_tasks",
            "mechanical_capture_tasks",
        ]:
            if len(record[task_key]) < 3:
                raise SystemExit(
                    f"display/camera connector execution task list too weak: "
                    f"{interface_id} {task_key}"
                )
        if not record.get("status_note"):
            raise SystemExit(f"display/camera connector missing status note: {interface_id}")

    gap_ids = {item["interface_id"] for item in execution["pinout_gap_matrix"]}
    if gap_ids != set(expected_interfaces):
        raise SystemExit("display/camera connector pinout gap matrix diverges")
    for item in execution["pinout_gap_matrix"]:
        if len(item["missing_before_symbol_capture"]) < 3:
            raise SystemExit(
                f"display/camera connector pinout gap too weak: {item['interface_id']}"
            )
    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"display/camera connector cross-check failed: {key}")
    for blocker in [
        "display/touch FPC exact pin count, lane order, mating connector, and STEP model are missing",
        "rear and front camera FPC exact pin orders, mating connectors, and STEP models are missing",
        "KiCad connector symbols and supplier land patterns are not captured",
        "MIPI DSI/CSI escape, length/skew, impedance, return-path, and DRC/SI reports are missing",
        "sample inspection, display bring-up, camera capture, and routed-board enclosure clearance evidence are missing",
    ]:
        if blocker not in execution["release_blockers"]:
            raise SystemExit(f"display/camera connector missing blocker: {blocker}")
    for claim in [
        "display_pinout_frozen",
        "camera_pinout_frozen",
        "display_connector_ready",
        "camera_connector_ready",
        "supplier_footprints_ready",
        "mipi_routed",
        "erc_clean",
        "drc_clean",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in execution["forbidden_claims"]:
            raise SystemExit(f"display/camera connector missing forbidden claim {claim}")
    print(
        "display/camera connector pinout execution ok: "
        f"{len(records)} interfaces, {total_contract_nets} contract nets fail-closed"
    )


def check_display_camera_schematic_net_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-schematic-net-binding.yaml")
    manifest = load_yaml(MANIFEST)
    integration = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-oem-integration.yaml")
    connector = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")

    if binding["schema"] != "eliza.e1_phone_display_camera_schematic_net_binding.v1":
        raise SystemExit(f"unexpected display/camera net binding schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_display_camera_net_binding_requires_supplier_pinouts_real_schematic_route_bringup_and_capture"
    ):
        raise SystemExit(f"unexpected display/camera net binding status: {binding['status']}")
    rel = "board/kicad/e1-phone/display-camera-schematic-net-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing display/camera schematic net binding")
    if rel not in integration["source_artifacts"]:
        raise SystemExit("display/camera integration must cite schematic net binding")
    if rel not in connector["source_artifacts"]:
        raise SystemExit("display/camera connector execution must cite schematic net binding")
    for source in [
        "board/kicad/e1-phone/display-camera-oem-integration.yaml",
        "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml",
        "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/display-fit.yaml",
        "package/display/v0-dsi-720x1280.yaml",
        "package/camera/oem-mipi-csi-modules.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"display/camera net binding missing source {source}")
        require_path(ROOT / source)

    context = binding["interface_context"]
    display_context = integration["display_oem_context"]
    camera_context = integration["camera_oem_context"]
    if context["display_part"] != display_context["selected_primary"]["part"]:
        raise SystemExit("display/camera net binding display part stale")
    if context["display_outline_mm"] != display_fit["selected_primary_display"]["outline_mm"]:
        raise SystemExit("display/camera net binding display outline stale")
    if context["display_clearance_mm"] != display_fit["primary_clearance_in_current_envelope_mm"]:
        raise SystemExit("display/camera net binding display clearance stale")
    if context["rear_camera_module"] != camera_context["rear_primary"]["module"]:
        raise SystemExit("display/camera net binding rear camera stale")
    if context["front_camera_module"] != camera_context["front_primary"]["module"]:
        raise SystemExit("display/camera net binding front camera stale")
    if (
        context["display_connector_region_mm"]
        != display_context["external_interface_review"]["region_mm"]
    ):
        raise SystemExit("display/camera net binding display region stale")
    if (
        context["camera_connector_region_mm"]
        != camera_context["external_interface_review"]["region_mm"]
    ):
        raise SystemExit("display/camera net binding camera region stale")

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    route_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    probe_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    connector_records = {
        item["interface_id"]: item for item in connector["connector_pinout_execution"]
    }

    blocks = binding["schematic_blocks"]
    if set(blocks) != set(connector_records):
        raise SystemExit("display/camera net binding schematic block set diverges")
    for interface_id, block in blocks.items():
        source = connector_records[interface_id]
        for key in ["refdes", "source_candidate", "schematic_sheet", "required_contract_nets"]:
            if block[key] != source[key]:
                raise SystemExit(f"display/camera net binding stale for {interface_id}: {key}")
        if block["status"] != source["status"]:
            raise SystemExit(f"display/camera net binding status stale: {interface_id}")
        missing = sorted(net for net in block["required_contract_nets"] if net not in block_nets)
        if missing:
            raise SystemExit(f"display/camera net binding {interface_id} missing nets {missing}")
        if len(block["required_local_parts"]) < 4:
            raise SystemExit(f"display/camera net binding local parts too weak: {interface_id}")
        if (
            interface_id != "display_touch_fpc"
            and block["public_pin_count"] != source["public_pin_count"]
        ):
            raise SystemExit(f"display/camera net binding public pin count stale: {interface_id}")

    mipi_class = routing["impedance_classes"]["mipi_dphy_diff"]
    route_bindings = binding["mipi_route_bindings"]
    for interface_id, route_binding in route_bindings.items():
        source_groups = {
            item["name"]: item
            for item in connector_records[interface_id]["route_constraint_groups"]
        }
        if set(route_binding["route_groups"]) != set(source_groups):
            raise SystemExit(f"display/camera net binding route groups stale: {interface_id}")
        if route_binding["impedance_class"] != "mipi_dphy_diff":
            raise SystemExit(f"display/camera net binding route class stale: {interface_id}")
        if route_binding["target_impedance_ohm_diff"] != mipi_class["impedance_ohm"]:
            raise SystemExit(f"display/camera net binding impedance stale: {interface_id}")
        lengths = {item["max_length_mm"] for item in source_groups.values()}
        skews = {item["intra_pair_skew_mm_max"] for item in source_groups.values()}
        if route_binding["max_length_mm"] not in lengths or len(lengths) != 1:
            raise SystemExit(f"display/camera net binding length stale: {interface_id}")
        if route_binding["intra_pair_skew_mm_max"] not in skews or len(skews) != 1:
            raise SystemExit(f"display/camera net binding skew stale: {interface_id}")
        for group_name in route_binding["route_groups"]:
            route_pair = route_pairs[group_name]
            source_group = source_groups[group_name]
            for key in ["nets", "class", "max_length_mm", "intra_pair_skew_mm_max"]:
                if source_group[key] != route_pair[key]:
                    raise SystemExit(
                        f"display/camera net binding route constraint stale: {interface_id} {group_name} {key}"
                    )

    probes = binding["factory_probe_bindings"]
    if probes["display_touch"] != probe_domains["display_touch"]["nets"]:
        raise SystemExit("display/camera display probe binding diverges from factory probe map")
    if probes["cameras"] != probe_domains["cameras"]["nets"]:
        raise SystemExit("display/camera camera probe binding diverges from factory probe map")
    for group_name in ["display_touch", "cameras", "extra_first_article_observability"]:
        missing = sorted(net for net in probes[group_name] if net not in block_nets)
        if missing:
            raise SystemExit(f"display/camera probe binding {group_name} missing nets {missing}")

    for criterion in [
        "KiCad schematic contains non-placeholder connector symbols for display touch rear camera and front camera FPCs",
        "DSI and CSI pairs use mipi_dphy_diff constraints and EVT1 stackup/coupon target",
        "routed board STEP includes display stack camera modules FPC exits connector heights and bend keepouts",
    ]:
        if criterion not in binding["evt1_capture_exit_criteria"]:
            raise SystemExit(f"display/camera net binding missing exit criterion: {criterion}")
    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"display/camera net binding cross-check failed: {key}")
    for blocker in [
        "display/touch FPC exact pin count, lane order, mating connector, and STEP model are missing",
        "rear and front camera FPC exact pin orders, mating connectors, and STEP models are missing",
        "routed DSI/CSI copper, DRC/ERC, length/skew, impedance, and return-path evidence are missing",
        "display bring-up, touch probe, camera capture, image-quality, and routed enclosure clearance evidence are missing",
    ]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"display/camera net binding missing blocker: {blocker}")
    for claim in [
        "display_schematic_ready",
        "camera_schematic_ready",
        "display_pinout_frozen",
        "camera_pinout_frozen",
        "display_connector_ready",
        "camera_connector_ready",
        "mipi_routed",
        "display_works",
        "camera_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"display/camera net binding missing forbidden claim {claim}")
    print(
        "display/camera schematic net binding ok: "
        f"{len(blocks)} connectors, {sum(len(v['route_groups']) for v in route_bindings.values())} MIPI groups fail-closed"
    )


def check_display_camera_acceptance() -> None:
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml")
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
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
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
        "display_alternate_screen_branch_release_gate",
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


def check_usb_sidekey_selection_wiring_decision() -> None:
    decision = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml")
    manifest = load_yaml(MANIFEST)
    usb_binding = load_yaml(ROOT / "package/usb-c/e1-phone-usb-c-port.yaml")
    pd_binding = load_yaml(ROOT / "package/usb-pd/tps65987.yaml")
    charger_binding = load_yaml(ROOT / "package/charger/max77860.yaml")
    side_buttons = load_yaml(ROOT / "package/human-interface/side-buttons.yaml")
    revalidation = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-source-revalidation.yaml")
    mechanical = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml")
    integration = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    binding = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-schematic-net-binding.yaml")
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    supplier_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )

    if decision["schema"] != "eliza.e1_phone_usb_sidekey_selection_wiring_decision.v1":
        raise SystemExit("USB/side-key selection/wiring decision schema diverges")
    if (
        decision["status"]
        != "blocked_usb_sidekey_selection_requires_supplier_drawings_real_schematic_route_measurements_and_enclosure_load_path"
    ):
        raise SystemExit(f"unexpected USB/side-key selection status: {decision['status']}")
    rel = "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing USB/side-key selection/wiring decision")
    for artifact in [integration, binding, acceptance]:
        if rel not in artifact["source_artifacts"]:
            raise SystemExit("USB/side-key selection/wiring decision is not cited downstream")
    for source in decision["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "usb_c_package": usb_binding["status"],
        "usb_pd_package": pd_binding["status"],
        "charger_package": charger_binding["status"],
        "side_buttons_package": side_buttons["status"],
        "usb_sidekey_source_revalidation": revalidation["status"],
        "usb_sidekey_mechanical_decision": mechanical["status"],
        "usb_sidekey_integration": integration["status"],
        "usb_sidekey_schematic_net_binding": binding["status"],
        "usb_sidekey_acceptance": acceptance["status"],
        "placement_interface_matrix": placement["status"],
        "supplier_rfq_response_normalization": supplier_responses["status"],
    }
    if decision["upstream_status"] != expected_upstream:
        raise SystemExit("USB/side-key selection upstream status stale")

    selected = decision["selected_hardware_stack"]
    if (
        selected["usb_c_evt0_connector"]["family"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["family"]
    ):
        raise SystemExit("USB/side-key selected EVT0 connector stale")
    if (
        selected["usb_c_evt0_connector"]["active_contacts"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["active_contacts"]
    ):
        raise SystemExit("USB/side-key EVT0 connector active contacts stale")
    if (
        selected["usb_c_conditional_alternate"]["family"]
        != usb_binding["connector_strategy"]["production_superspeed"]["family"]
    ):
        raise SystemExit("USB/side-key USB-C alternate stale")
    if len(selected["usb_c_conditional_alternate"]["promote_only_if"]) < 3:
        raise SystemExit("USB/side-key USB-C alternate gate too weak")
    if selected["usb_pd_controller"]["part"] != pd_binding["part"]:
        raise SystemExit("USB/side-key PD controller stale")
    if selected["charger_power_path"]["part"] != charger_binding["part"]:
        raise SystemExit("USB/side-key charger stale")
    if (
        selected["charger_power_path"]["charge_current_max_a"]
        != charger_binding["charge_profile"]["charge_current_max_a"]
    ):
        raise SystemExit("USB/side-key charger current stale")
    if selected["side_key_primary"]["family"] != side_buttons["primary_switch_family"]["family"]:
        raise SystemExit("USB/side-key side-switch primary stale")
    if (
        selected["side_key_primary"]["dimensions_mm"]
        != side_buttons["primary_switch_family"]["dimensions_mm"]
    ):
        raise SystemExit("USB/side-key side-switch dimensions stale")
    if (
        selected["side_key_conditional_alternate"]["family"]
        != side_buttons["alternate_switch_family"]["family"]
    ):
        raise SystemExit("USB/side-key side-switch alternate stale")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    mech = decision["placement_and_mechanical_policy"]
    if mech["usb_c"]["board_region_mm"] != placements["J_USB_C"]["region_mm"]:
        raise SystemExit("USB/side-key USB region diverges from placement matrix")
    if mech["usb_c"]["board_region_mm"] != usb_binding["placement"]["board_region_mm"]:
        raise SystemExit("USB/side-key USB region diverges from package")
    usb_region = mech["usb_c"]["board_region_mm"]
    if (
        usb_region["y"] + usb_region["height"]
        != manifest["design_target"]["board_bbox_mm"]["height"]
    ):
        raise SystemExit("USB/side-key USB region must terminate at bottom edge")
    if mech["side_keys"]["connector_region_mm"] != placements["SW_POWER_VOL"]["region_mm"]:
        raise SystemExit("USB/side-key connector region diverges from placement matrix")
    if (
        mech["side_keys"]["actuator_spine_region_mm"]
        != side_buttons["mechanical_target"]["board_region_mm"]
    ):
        raise SystemExit("USB/side-key actuator spine region diverges from package")
    if mech["side_keys"]["external_buttons"] != manifest["design_target"]["side_buttons"]:
        raise SystemExit("USB/side-key external buttons diverge from manifest")

    all_block_nets: set[str] = set()
    for block in netlist["blocks"]:
        all_block_nets.update(flatten_net_groups(block["nets"]))
    wiring = decision["wiring_contract"]
    if wiring["usb_c_required_nets"] != integration["usb_c_port_context"]["required_nets"]:
        raise SystemExit("USB/side-key USB-C wiring diverges from integration")
    if (
        wiring["pd_required_nets"]
        != integration["usb_pd_and_charger_context"]["pd_controller"]["required_nets"]
    ):
        raise SystemExit("USB/side-key PD wiring diverges from integration")
    if (
        wiring["charger_required_nets"]
        != integration["usb_pd_and_charger_context"]["charger"]["required_nets"]
    ):
        raise SystemExit("USB/side-key charger wiring diverges from integration")
    if (
        wiring["side_key_required_nets"]
        != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"]["required_nets"]
    ):
        raise SystemExit("USB/side-key side-key wiring diverges from package")
    if (
        wiring["side_key_recommended_min_contacts"]
        != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"][
            "recommended_min_contacts"
        ]
    ):
        raise SystemExit("USB/side-key contact budget stale")
    for key in [
        "usb_c_required_nets",
        "pd_required_nets",
        "charger_required_nets",
        "side_key_required_nets",
    ]:
        missing = sorted(set(wiring[key]) - all_block_nets)
        if missing:
            raise SystemExit(
                f"USB/side-key wiring nets missing from block netlist: {key} {missing}"
            )

    route_probe = decision["route_and_probe_contract"]
    diff_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}
    usb_route = route_probe["usb2_diff_pair"]
    if usb_route["nets"] != diff_pairs["USB_DP_DN"]["nets"]:
        raise SystemExit("USB/side-key USB2 route nets diverge")
    if (
        usb_route["impedance_ohm_diff"]
        != routing["impedance_classes"]["usb2_diff"]["impedance_ohm"]
    ):
        raise SystemExit("USB/side-key USB2 impedance stale")
    if usb_route["max_length_mm"] != diff_pairs["USB_DP_DN"]["max_length_mm"]:
        raise SystemExit("USB/side-key USB2 length stale")
    side_route = route_probe["side_key_bus"]
    if not set(single_ended["SIDE_KEYS"]["nets"]).issubset(side_route["nets"]):
        raise SystemExit("USB/side-key side-key route nets diverge")
    if side_route["max_length_mm"] != single_ended["SIDE_KEYS"]["max_length_mm"]:
        raise SystemExit("USB/side-key side-key route length stale")
    probe_nets = set(route_probe["factory_probe_required_nets"])
    probe_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    covered_probe_nets = (
        set(probe_domains["usb_c"]["nets"])
        | set(probe_domains["buttons_sensors_nfc"]["nets"])
        | set(probe_domains["power_rails"]["nets"])
    )
    if not probe_nets.issubset(covered_probe_nets):
        raise SystemExit("USB/side-key factory probe coverage stale")

    release = decision["bringup_and_release_policy"]
    if (
        release["supplier_response_packs_received"]
        != supplier_responses["normalization_outputs"]["present_response_pack_count"]
    ):
        raise SystemExit("USB/side-key supplier response count stale")
    if release["release_allowed_without_supplier_response_packs"] is not False:
        raise SystemExit("USB/side-key supplier response policy unexpectedly open")
    if len(release["required_before_layout_release"]) < 5:
        raise SystemExit("USB/side-key release policy too weak")

    for key, value in decision["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB/side-key selection cross-check failed: {key}")
    for blocker in [
        "USB-C connector signed drawing, land pattern, STEP, shell stake datum, insertion-force data, and plug overmold sweep are missing.",
        "USB-PD controller firmware/configuration, CC attach, dead-battery boot, PPS/EPR, Type-C class, and HAL evidence are missing.",
        "Charger schematic, I2C readback, NTC/ID readback, CC/CV cycle, JEITA hot/cold, current-limit, and thermal validation are missing.",
        "Side-key switch/flex drawing, force/travel sample data, enclosure load path, wake/recovery combo logs, and debounce/leakage review are missing.",
        "Routed USB2/CC/VBUS/charger/side-key copper, DRC/ERC/SI/PI evidence, routed STEP, and enclosure clearance rerun are missing.",
    ]:
        if blocker not in decision["release_blockers"]:
            raise SystemExit(f"USB/side-key selection missing blocker: {blocker}")
    for claim in [
        "usb_sidekey_selection_final",
        "usb_c_ready",
        "pd_ready",
        "charging_ready",
        "side_buttons_ready",
        "power_key_wake_ready",
        "recovery_key_combo_ready",
        "waterproof_ready",
        "superspeed_ready",
        "routed_pcb_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in decision["forbidden_claims"]:
            raise SystemExit(f"USB/side-key selection missing forbidden claim {claim}")
    print(
        "USB/side-key selection/wiring decision ok: "
        f"usb={selected['usb_c_evt0_connector']['family']} "
        f"pd={selected['usb_pd_controller']['part']} "
        f"charger={selected['charger_power_path']['part']} "
        f"buttons={len(mech['side_keys']['external_buttons'])} fail-closed"
    )


def check_usb_sidekey_mechanical_decision() -> None:
    decision = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml")
    manifest = load_yaml(MANIFEST)
    usb_binding = load_yaml(ROOT / "package/usb-c/e1-phone-usb-c-port.yaml")
    side_buttons = load_yaml(ROOT / "package/human-interface/side-buttons.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-source-revalidation.yaml"
    )
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    enclosure = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-placement-closure.yaml")
    height = load_yaml(ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml")
    supplier_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )

    if decision["schema"] != "eliza.e1_phone_usb_sidekey_mechanical_decision.v1":
        raise SystemExit("USB/side-key mechanical decision schema diverges")
    if (
        decision["status"]
        != "blocked_usb_sidekey_mechanical_decision_requires_supplier_drawings_routed_step_and_measurements"
    ):
        raise SystemExit(
            f"unexpected USB/side-key mechanical decision status: {decision['status']}"
        )
    rel = "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing USB/side-key mechanical decision")
    for source in decision["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "usb_c_package": usb_binding["status"],
        "side_buttons_package": side_buttons["status"],
        "usb_sidekey_source_revalidation": source_revalidation["status"],
        "placement_interface_matrix": placement["status"],
        "enclosure_placement": enclosure["status"],
        "component_height_step_integration": height["status"],
        "supplier_rfq_response_normalization": supplier_responses["status"],
    }
    if decision["upstream_status"] != expected_upstream:
        raise SystemExit("USB/side-key mechanical decision upstream status stale")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    usb_policy = decision["usb_mechanical_policy"]
    if usb_policy["active_region_refdes"] != "J_USB_C":
        raise SystemExit("USB/side-key mechanical decision USB refdes changed")
    if usb_policy["active_region_mm"] != placements["J_USB_C"]["region_mm"]:
        raise SystemExit("USB/side-key mechanical decision USB region stale")
    usb_region = usb_policy["active_region_mm"]
    if (
        usb_region["y"] + usb_region["height"]
        != manifest["design_target"]["board_bbox_mm"]["height"]
    ):
        raise SystemExit(
            "USB/side-key mechanical decision USB region must terminate at bottom edge"
        )
    if (
        usb_policy["selected_evt0_connector"]["family"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["family"]
    ):
        raise SystemExit("USB/side-key mechanical decision EVT0 connector family stale")
    if (
        usb_policy["selected_evt0_connector"]["active_contacts"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["active_contacts"]
    ):
        raise SystemExit("USB/side-key mechanical decision EVT0 active contact count stale")
    if (
        usb_policy["conditional_production_alternate"]["family"]
        != usb_binding["connector_strategy"]["production_superspeed"]["family"]
    ):
        raise SystemExit("USB/side-key mechanical decision production alternate stale")
    if len(usb_policy["conditional_production_alternate"]["promote_only_if"]) < 3:
        raise SystemExit("USB/side-key mechanical decision USB alternate promotion gate too weak")
    if len(usb_policy["required_mechanical_capture"]) < 4:
        raise SystemExit("USB/side-key mechanical decision USB capture list too weak")

    side_policy = decision["side_key_mechanical_policy"]
    if side_policy["active_connector_refdes"] != "SW_POWER_VOL":
        raise SystemExit("USB/side-key mechanical decision side-key refdes changed")
    if side_policy["active_connector_region_mm"] != placements["SW_POWER_VOL"]["region_mm"]:
        raise SystemExit("USB/side-key mechanical decision side-key connector region stale")
    if (
        side_policy["actuator_spine_region_mm"]
        != side_buttons["mechanical_target"]["board_region_mm"]
    ):
        raise SystemExit("USB/side-key mechanical decision side-key actuator region stale")
    if (
        side_policy["selected_primary_switch"]["family"]
        != side_buttons["primary_switch_family"]["family"]
    ):
        raise SystemExit("USB/side-key mechanical decision primary switch family stale")
    if (
        side_policy["selected_primary_switch"]["dimensions_mm"]
        != side_buttons["primary_switch_family"]["dimensions_mm"]
    ):
        raise SystemExit("USB/side-key mechanical decision primary switch dimensions stale")
    if (
        side_policy["conditional_alternate_switch"]["family"]
        != side_buttons["alternate_switch_family"]["family"]
    ):
        raise SystemExit("USB/side-key mechanical decision alternate switch family stale")
    if len(side_policy["conditional_alternate_switch"]["promote_only_if"]) < 3:
        raise SystemExit(
            "USB/side-key mechanical decision side-key alternate promotion gate too weak"
        )
    if len(side_policy["required_mechanical_capture"]) < 4:
        raise SystemExit("USB/side-key mechanical decision side-key capture list too weak")

    dependency = decision["release_dependency"]
    if (
        dependency["supplier_response_packs_received"]
        != supplier_responses["normalization_outputs"]["present_response_pack_count"]
    ):
        raise SystemExit("USB/side-key mechanical decision supplier response count stale")
    for key in [
        "supplier_response_required_before_footprint_release",
        "routed_board_step_required_before_enclosure_release",
    ]:
        if dependency[key] is not True:
            raise SystemExit(f"USB/side-key mechanical decision must require {key}")
    if len(dependency["acceptance_measurements_required"]) < 5:
        raise SystemExit("USB/side-key mechanical decision acceptance measurement list too weak")
    for key, value in decision["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB/side-key mechanical decision cross-check failed: {key}")
    for blocker in [
        "USB-C exact signed drawing, land pattern, STEP, shell stake dimensions, insertion-force data, and lifecycle evidence are missing",
        "waterproof or superspeed USB-C alternate cannot be promoted without exact MPN, gasket/cutout datum, USB3/DP routing, and SI evidence",
        "side-key exact MPN, force-travel curve, land pattern, STEP, lifecycle evidence, and sample lot are missing",
        "side-key flex or enclosure load-path drawing with plunger, rib, elastomer, or stiffener datum is missing",
    ]:
        if blocker not in decision["release_blockers"]:
            raise SystemExit(f"USB/side-key mechanical decision missing blocker: {blocker}")
    for claim in [
        "usb_c_mechanical_ready",
        "usb_c_waterproof_ready",
        "usb_c_superspeed_ready",
        "side_key_mechanical_ready",
        "side_buttons_ready",
        "power_key_wake_ready",
        "recovery_key_combo_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in decision["forbidden_claims"]:
            raise SystemExit(f"USB/side-key mechanical decision missing forbidden claim {claim}")
    print(
        "USB/side-key mechanical decision ok: "
        f"usb={usb_policy['selected_evt0_connector']['family']} "
        f"side={side_policy['selected_primary_switch']['family']} fail-closed"
    )


def check_usb_sidekey_integration() -> None:
    integration = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    manifest = load_yaml(MANIFEST)
    usb_binding = load_yaml(ROOT / "package/usb-c/e1-phone-usb-c-port.yaml")
    pd_binding = load_yaml(ROOT / "package/usb-pd/tps65987.yaml")
    charger_binding = load_yaml(ROOT / "package/charger/max77860.yaml")
    side_buttons = load_yaml(ROOT / "package/human-interface/side-buttons.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    external_review = load_yaml(ROOT / "board/kicad/e1-phone/external-interface-design-review.yaml")
    load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-source-revalidation.yaml")
    mechanical_decision = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml"
    )
    sequence = load_yaml(ROOT / "board/kicad/e1-phone/power-sequence-bringup-closure.yaml")
    power = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    height = load_yaml(ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml")

    if integration["schema"] != "eliza.e1_phone_usb_sidekey_integration.v1":
        raise SystemExit("USB/side-key integration schema diverges")
    if (
        integration["status"]
        != "blocked_requires_usb_c_pd_charger_sidekey_routed_and_measured_evidence"
    ):
        raise SystemExit(f"unexpected USB/side-key integration status: {integration['status']}")
    rel = "board/kicad/e1-phone/usb-sidekey-integration.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing USB/side-key integration artifact")
    for source in [
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "package/usb-c/e1-phone-usb-c-port.yaml",
        "package/usb-pd/tps65987.yaml",
        "package/charger/max77860.yaml",
        "package/human-interface/side-buttons.yaml",
        "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "board/kicad/e1-phone/external-interface-design-review.yaml",
        "board/kicad/e1-phone/usb-sidekey-source-revalidation.yaml",
        "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/power-sequence-bringup-closure.yaml",
        "board/kicad/e1-phone/power-thermal-budget.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/component-height-step-integration.yaml",
        "board/kicad/e1-phone/usb-sidekey-schematic-net-binding.yaml",
    ]:
        if source not in integration["source_artifacts"]:
            raise SystemExit(f"USB/side-key integration missing source {source}")
        require_path(ROOT / source)

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    reviews = {item["name"]: item for item in external_review["interface_reviews"]}
    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    diff_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}

    usb_context = integration["usb_c_port_context"]
    if usb_context["port_count"] != manifest["design_target"]["usb_c_ports"]:
        raise SystemExit("USB/side-key integration port count stale")
    if usb_context["manifest_port_count"] != manifest["design_target"]["usb_c_ports"]:
        raise SystemExit("USB/side-key integration manifest port count stale")
    if usb_context["active_matrix_region_mm"] != placements["J_USB_C"]["region_mm"]:
        raise SystemExit("USB/side-key integration active USB-C region stale")
    if usb_context["placement"]["board_region_mm"] != usb_binding["placement"]["board_region_mm"]:
        raise SystemExit("USB/side-key integration USB-C binding region stale")
    if (
        usb_context["external_interface_region_mm"]
        != reviews["usb_c_charge_data_debug"]["region_mm"]
    ):
        raise SystemExit("USB/side-key integration USB-C external review region stale")
    if usb_context["active_matrix_region_mm"] != usb_binding["placement"]["board_region_mm"]:
        raise SystemExit("USB-C package binding no longer matches active placement matrix")
    usb_region = usb_context["active_matrix_region_mm"]
    if (
        usb_region["y"] + usb_region["height"]
        != manifest["design_target"]["board_bbox_mm"]["height"]
    ):
        raise SystemExit("USB-C region must terminate at bottom board edge")
    if usb_context["selected_evt0_connector"] != usb_binding["connector_strategy"]["evt0_low_risk"]:
        raise SystemExit("USB/side-key integration EVT0 connector binding stale")
    if (
        usb_context["selected_evt0_connector"]["family"]
        != mechanical_decision["usb_mechanical_policy"]["selected_evt0_connector"]["family"]
    ):
        raise SystemExit("USB/side-key integration mechanical USB decision stale")
    if (
        usb_context["production_alternate"]
        != usb_binding["connector_strategy"]["production_superspeed"]
    ):
        raise SystemExit("USB/side-key integration production USB-C alternate stale")
    if usb_context["required_blocks"] != usb_binding["electrical_topology"]["required_blocks"]:
        raise SystemExit("USB/side-key integration USB-C required blocks stale")
    missing_usb_nets = sorted(set(usb_context["required_nets"]) - block_nets)
    if missing_usb_nets:
        raise SystemExit(f"USB/side-key integration USB-C nets missing: {missing_usb_nets}")
    for requirement in usb_binding["layout_closure_requirements"]["bringup_test_access"]:
        if requirement not in usb_context["bringup_test_access"]:
            raise SystemExit("USB/side-key integration missing USB-C bring-up access requirement")

    power_context = integration["usb_pd_and_charger_context"]
    if power_context["pd_controller"]["part"] != pd_binding["part"]:
        raise SystemExit("USB/side-key integration PD controller part stale")
    if power_context["pd_controller"]["vendor"] != pd_binding["vendor"]:
        raise SystemExit("USB/side-key integration PD controller vendor stale")
    if power_context["pd_controller"]["status"] != pd_binding["status"]:
        raise SystemExit("USB/side-key integration PD controller status stale")
    if (
        power_context["pd_controller"]["power_sequence_status"]
        != pd_binding["power_sequence"]["status"]
    ):
        raise SystemExit("USB/side-key integration PD sequence status stale")
    if set(power_context["pd_controller"]["required_nets"]) < set(usb_context["required_nets"]) - {
        "GND",
        "SHIELD_GND",
    }:
        raise SystemExit("USB/side-key integration PD required nets too weak")
    if power_context["charger"]["part"] != charger_binding["part"]:
        raise SystemExit("USB/side-key integration charger part stale")
    if power_context["charger"]["vendor"] != charger_binding["vendor"]:
        raise SystemExit("USB/side-key integration charger vendor stale")
    if power_context["charger"]["status"] != charger_binding["status"]:
        raise SystemExit("USB/side-key integration charger status stale")
    if (
        power_context["charger"]["charge_current_max_a"]
        != charger_binding["charge_profile"]["charge_current_max_a"]
    ):
        raise SystemExit("USB/side-key integration charger current stale")
    if (
        power_context["charger"]["power_sequence_status"]
        != charger_binding["power_sequence"]["status"]
    ):
        raise SystemExit("USB/side-key integration charger sequence status stale")
    sequence_steps = {
        item["id"]: item
        for item in sequence["rail_sequence_steps"]
        if item["id"]
        in {"usb_pd_dead_battery_attach", "charger_sys_precharge", "pmic_aon_and_ap_rails"}
    }
    context_steps = {item["id"]: item for item in power_context["power_sequence_steps_required"]}
    if context_steps != sequence_steps:
        raise SystemExit("USB/side-key integration power sequence steps stale")
    if power_context["power_thermal_status"] != power["status"]:
        raise SystemExit("USB/side-key integration power thermal status stale")
    for step in power_context["power_sequence_steps_required"]:
        if not step["current_status"].startswith("blocked_"):
            raise SystemExit(f"USB/side-key integration power step unexpectedly open: {step['id']}")
        if not step.get("required_evidence") or len(step["required_evidence"]) < 3:
            raise SystemExit(f"USB/side-key integration power step evidence too weak: {step['id']}")

    side_context = integration["side_key_context"]
    if side_context["manifest_side_buttons"] != manifest["design_target"]["side_buttons"]:
        raise SystemExit("USB/side-key integration side-button manifest list stale")
    if side_context["actuator_spine_placement"] != side_buttons["mechanical_target"]["placement"]:
        raise SystemExit("USB/side-key integration side-button placement stale")
    if (
        side_context["actuator_spine_region_mm"]
        != side_buttons["mechanical_target"]["board_region_mm"]
    ):
        raise SystemExit("USB/side-key integration side-button actuator region stale")
    if side_context["active_matrix_connector_region_mm"] != placements["SW_POWER_VOL"]["region_mm"]:
        raise SystemExit("USB/side-key integration side-key connector region stale")
    if side_context["external_interface_region_mm"] != reviews["side_power_volume"]["region_mm"]:
        raise SystemExit("USB/side-key integration side-key external review region stale")
    if side_context["primary_switch_family"] != side_buttons["primary_switch_family"]:
        raise SystemExit("USB/side-key integration primary side-switch binding stale")
    if (
        side_context["primary_switch_family"]["family"]
        != mechanical_decision["side_key_mechanical_policy"]["selected_primary_switch"]["family"]
    ):
        raise SystemExit("USB/side-key integration mechanical side-key decision stale")
    if side_context["alternate_switch_family"] != side_buttons["alternate_switch_family"]:
        raise SystemExit("USB/side-key integration alternate side-switch binding stale")
    flex_budget = side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"]
    if sorted(side_context["required_nets"]) != sorted(flex_budget["required_nets"]):
        raise SystemExit("USB/side-key integration side-key required nets stale")
    if side_context["recommended_min_contacts"] != flex_budget["recommended_min_contacts"]:
        raise SystemExit("USB/side-key integration side-key contact budget stale")
    if sorted(side_context["required_nets"]) != sorted(placements["SW_POWER_VOL"]["required_nets"]):
        raise SystemExit("USB/side-key integration side-key placement nets stale")
    missing_side_nets = sorted(set(side_context["required_nets"]) - block_nets)
    if missing_side_nets:
        raise SystemExit(f"USB/side-key integration side-key nets missing: {missing_side_nets}")

    route_context = integration["routing_and_height_context"]
    if route_context["usb_diff_pair"] != diff_pairs["USB_DP_DN"]:
        raise SystemExit("USB/side-key integration USB diff-pair route stale")
    if route_context["side_key_control_route"]["source_section"] != "single_ended_buses":
        raise SystemExit("USB/side-key integration side-key route source stale")
    route_copy = dict(route_context["side_key_control_route"])
    route_copy.pop("source_section")
    if route_copy != single_ended["SIDE_KEYS"]:
        raise SystemExit("USB/side-key integration side-key route stale")
    if (
        route_context["power_test_points_required"]
        != routing["power_integrity"]["test_points_required"]
    ):
        raise SystemExit("USB/side-key integration power test-point list stale")
    height_models = {item["model"] for item in height["height_critical_models"]}
    if set(route_context["height_models_required"]) - height_models:
        raise SystemExit("USB/side-key integration height model requirement stale")

    factory = integration["factory_and_validation_requirements"]
    required_test_nets = {
        "VBUS",
        "USB_CC1",
        "USB_CC2",
        "USB_DP",
        "USB_DN",
        "SHIELD_GND",
        *side_context["required_nets"],
    }
    if set(factory["required_test_access_nets"]) != required_test_nets:
        raise SystemExit("USB/side-key integration factory test access nets stale")
    for output in factory["required_release_outputs"]:
        if not output.startswith(
            ("board/kicad/e1-phone/production/", "mechanical/e1-phone/review/")
        ):
            raise SystemExit(
                f"USB/side-key integration release output path escapes allowed roots: {output}"
            )
        if output == "mechanical/e1-phone/review/routed-board-clearance.json":
            routed_clearance = load_yaml(ROOT / output)
            if routed_clearance["status"] not in {
                "blocked_waiting_for_routed_board_step",
                "blocked_waiting_for_physical_routed_board_clearance_result",
            }:
                raise SystemExit(
                    "USB/side-key integration routed clearance output unexpectedly open"
                )
            if routed_clearance["complete_clearance_result_count"] != 0:
                raise SystemExit("USB/side-key integration routed clearance has release results")
        elif is_release_artifact_present(ROOT / output):
            raise SystemExit(
                f"USB/side-key integration release output unexpectedly exists: {output}"
            )
    if integration["required_release_outputs"] != factory["required_release_outputs"]:
        raise SystemExit("USB/side-key integration top-level release outputs stale")

    for key, value in integration["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB/side-key integration cross-check failed: {key}")
    for blocker in [
        "USB-C receptacle drawing, land pattern, shell load path, ESD, and STEP evidence missing",
        "USB-PD controller firmware, CC attach, dead-battery boot, PPS, and Type-C class logs missing",
        "charger CC/CV cycle, NTC/pack-ID readback, JEITA, current-limit, and surge validation missing",
        "side-key flex or switch drawing, force/travel, ESD, wake, and recovery-combo evidence missing",
        "routed schematic, ERC, routed PCB, DRC, SI/PI, and enclosure clearance rerun missing",
    ]:
        if blocker not in integration["release_blockers"]:
            raise SystemExit(f"USB/side-key integration missing blocker: {blocker}")
    for claim in [
        "EPR_active",
        "Health_HAL_VINTF_compatible",
        "JEITA_compliant",
        "OTG_active",
        "PD_negotiating",
        "PPS_active",
        "charging_active",
        "charging_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
        "fabrication_ready",
        "pd_ready",
        "power_key_wake_ready",
        "recovery_key_combo_ready",
        "side_buttons_ready",
        "superspeed_ready",
        "usb_c_ready",
        "usb_sidekey_ready",
        "usb_typec_HAL_compatible",
        "waterproof_ready",
    ]:
        if claim not in integration["forbidden_claims"]:
            raise SystemExit(f"USB/side-key integration missing forbidden claim {claim}")
    print(
        "USB/side-key integration ok: "
        f"{usb_context['port_count']} port, {len(side_context['manifest_side_buttons'])} buttons fail-closed"
    )


def check_usb_sidekey_schematic_net_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-schematic-net-binding.yaml")
    manifest = load_yaml(MANIFEST)
    integration = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    usb_binding = load_yaml(ROOT / "package/usb-c/e1-phone-usb-c-port.yaml")
    pd_binding = load_yaml(ROOT / "package/usb-pd/tps65987.yaml")
    charger_binding = load_yaml(ROOT / "package/charger/max77860.yaml")
    side_buttons = load_yaml(ROOT / "package/human-interface/side-buttons.yaml")

    if binding["schema"] != "eliza.e1_phone_usb_sidekey_schematic_net_binding.v1":
        raise SystemExit(f"unexpected USB/side-key net binding schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_usb_sidekey_net_binding_requires_real_schematic_footprints_route_and_measurements"
    ):
        raise SystemExit(f"unexpected USB/side-key net binding status: {binding['status']}")
    rel = "board/kicad/e1-phone/usb-sidekey-schematic-net-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing USB/side-key schematic net binding")
    if rel not in integration["source_artifacts"]:
        raise SystemExit("USB/side-key integration must cite schematic net binding")
    if rel not in acceptance["source_artifacts"]:
        raise SystemExit("USB/side-key acceptance must cite schematic net binding")
    for source in [
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/usb-sidekey-integration.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "package/usb-c/e1-phone-usb-c-port.yaml",
        "package/usb-pd/tps65987.yaml",
        "package/charger/max77860.yaml",
        "package/human-interface/side-buttons.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"USB/side-key schematic net binding missing source {source}")
        require_path(ROOT / source)

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    diff_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}
    probe_domains = {item["id"]: item for item in factory_probe["probe_domains"]}

    context = binding["interface_context"]
    usb_context = integration["usb_c_port_context"]
    side_context = integration["side_key_context"]
    if context["usb_c_port_count"] != manifest["design_target"]["usb_c_ports"]:
        raise SystemExit("USB/side-key net binding port count diverges from manifest")
    if context["usb_c_region_mm"] != usb_context["active_matrix_region_mm"]:
        raise SystemExit("USB/side-key net binding USB-C region stale")
    if context["side_key_connector_region_mm"] != side_context["active_matrix_connector_region_mm"]:
        raise SystemExit("USB/side-key net binding side-key connector region stale")
    if context["side_key_actuator_spine_region_mm"] != side_context["actuator_spine_region_mm"]:
        raise SystemExit("USB/side-key net binding side-key actuator region stale")
    if (
        context["selected_usb_connector_family"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["family"]
    ):
        raise SystemExit("USB/side-key net binding USB connector family stale")
    if context["pd_controller"] != pd_binding["part"]:
        raise SystemExit("USB/side-key net binding PD part stale")
    if context["charger"] != charger_binding["part"]:
        raise SystemExit("USB/side-key net binding charger part stale")
    if context["side_switch_family"] != side_buttons["primary_switch_family"]["family"]:
        raise SystemExit("USB/side-key net binding side-switch family stale")

    blocks = binding["schematic_blocks"]
    expected_blocks = {
        "usb_c_receptacle",
        "usb_pd_controller",
        "charger_power_path",
        "side_key_flex_or_switches",
    }
    if set(blocks) != expected_blocks:
        raise SystemExit("USB/side-key schematic block set diverges")
    expected_usb_nets = {"VBUS", "GND", "SHIELD_GND", "USB_DP", "USB_DN", "USB_CC1", "USB_CC2"}
    if set(blocks["usb_c_receptacle"]["required_nets"]) != expected_usb_nets:
        raise SystemExit("USB-C receptacle net binding is stale")
    if set(blocks["usb_pd_controller"]["required_nets"]) != set(
        integration["usb_pd_and_charger_context"]["pd_controller"]["required_nets"]
    ):
        raise SystemExit("PD controller net binding diverges from integration")
    if set(blocks["charger_power_path"]["required_nets"]) != set(
        integration["usb_pd_and_charger_context"]["charger"]["required_nets"]
    ):
        raise SystemExit("charger net binding diverges from integration")
    if sorted(blocks["side_key_flex_or_switches"]["required_nets"]) != sorted(
        side_context["required_nets"]
    ):
        raise SystemExit("side-key net binding diverges from integration")
    if (
        blocks["side_key_flex_or_switches"]["recommended_min_contacts"]
        != side_context["recommended_min_contacts"]
    ):
        raise SystemExit("side-key net binding contact budget stale")
    for block_name, block in blocks.items():
        missing = sorted(net for net in block["required_nets"] if net not in block_nets)
        if missing:
            raise SystemExit(f"USB/side-key schematic block {block_name} missing nets {missing}")
        if not block["status"].startswith("blocked_"):
            raise SystemExit(f"USB/side-key schematic block unexpectedly open: {block_name}")
        if len(block["required_local_parts"]) < 3:
            raise SystemExit(f"USB/side-key schematic block local parts too weak: {block_name}")

    routes = binding["net_route_bindings"]
    usb_route = routes["usb2_diff_pair"]
    if usb_route["nets"] != diff_pairs["USB_DP_DN"]["nets"]:
        raise SystemExit("USB/side-key net binding USB2 nets diverge from routing constraints")
    if (
        usb_route["impedance_ohm_diff"]
        != routing["impedance_classes"]["usb2_diff"]["impedance_ohm"]
    ):
        raise SystemExit("USB/side-key net binding USB2 impedance stale")
    if usb_route["max_length_mm"] != diff_pairs["USB_DP_DN"]["max_length_mm"]:
        raise SystemExit("USB/side-key net binding USB2 max length stale")
    if usb_route["intra_pair_skew_mm_max"] != diff_pairs["USB_DP_DN"]["intra_pair_skew_mm_max"]:
        raise SystemExit("USB/side-key net binding USB2 skew stale")
    side_route = routes["side_keys"]
    if not set(single_ended["SIDE_KEYS"]["nets"]).issubset(side_route["nets"]):
        raise SystemExit("USB/side-key net binding side-key bus diverges")
    if side_route["max_length_mm"] != single_ended["SIDE_KEYS"]["max_length_mm"]:
        raise SystemExit("USB/side-key net binding side-key max length stale")
    for route_name, route in routes.items():
        missing = sorted(net for net in route["nets"] if net not in block_nets)
        if missing:
            raise SystemExit(f"USB/side-key route binding {route_name} missing nets {missing}")
        if route["factory_probe_required"] is not True:
            raise SystemExit(f"USB/side-key route binding must require factory probe: {route_name}")
        if not route["required_validation"]:
            raise SystemExit(f"USB/side-key route binding missing validation: {route_name}")

    probes = binding["factory_probe_bindings"]
    if probes["usb_c"] != probe_domains["usb_c"]["nets"]:
        raise SystemExit("USB/side-key USB-C probe binding diverges from factory probe map")
    if not set(["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "AON_1V8"]).issubset(
        probe_domains["buttons_sensors_nfc"]["nets"]
    ):
        raise SystemExit("factory probe map missing side-key observable nets")
    if not set(["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N", "AON_1V8"]).issubset(probes["side_keys"]):
        raise SystemExit("USB/side-key probe binding missing side-key nets")
    if not set(["VBUS", "VBAT", "SYS"]).issubset(probe_domains["power_rails"]["nets"]):
        raise SystemExit("factory probe map missing charger power rails")
    for group, nets in probes.items():
        if group == "required_fixture_notes":
            continue
        missing = sorted(net for net in nets if net not in block_nets)
        if missing:
            raise SystemExit(f"USB/side-key probe binding {group} missing nets {missing}")
    if len(probes["required_fixture_notes"]) < 3:
        raise SystemExit("USB/side-key probe binding fixture notes too weak")

    for criterion in [
        "KiCad schematic contains non-placeholder symbols for USB-C receptacle, PD controller, charger, ESD/TVS, side-key connector or switches",
        "USB2 pair uses the usb2_diff route class and EVT1 stackup/coupon target",
        "factory-probe-map.yaml covers USB-C, charger, and side-key nets or records fixture alternatives",
    ]:
        if criterion not in binding["evt1_capture_exit_criteria"]:
            raise SystemExit(f"USB/side-key net binding missing exit criterion: {criterion}")
    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB/side-key net binding cross-check failed: {key}")
    for blocker in [
        "KiCad schematic still lacks real USB-C, PD, charger, ESD/TVS, and side-key symbols",
        "routed USB2/CC/VBUS/charger/side-key copper and DRC/ERC evidence are missing",
        "PD attach, charger CC/CV, side-key wake/recovery, and force/travel measurements are missing",
    ]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"USB/side-key net binding missing blocker: {blocker}")
    for claim in [
        "usb_c_schematic_ready",
        "charging_schematic_ready",
        "side_key_schematic_ready",
        "usb_c_ready",
        "charging_ready",
        "side_buttons_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"USB/side-key net binding missing forbidden claim {claim}")
    print(
        "USB/side-key schematic net binding ok: "
        f"{len(blocks)} blocks, {len(routes)} route bindings fail-closed"
    )


def check_usb_sidekey_acceptance() -> None:
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    integration = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    revalidation = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-source-revalidation.yaml")
    mechanical_decision = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml"
    )
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
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/usb-sidekey-integration.yaml",
        "board/kicad/e1-phone/usb-sidekey-schematic-net-binding.yaml",
        "board/kicad/e1-phone/usb-sidekey-source-revalidation.yaml",
        "board/kicad/e1-phone/usb-sidekey-mechanical-decision.yaml",
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
    if (
        summary["side_key_actuator_spine_region_mm"]
        != side_buttons["mechanical_target"]["board_region_mm"]
    ):
        raise SystemExit("USB/side-key acceptance actuator spine region stale")
    if (
        summary["side_key_required_nets"]
        != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"]["required_nets"]
    ):
        raise SystemExit("USB/side-key acceptance side-key required nets stale")
    if (
        summary["side_key_recommended_min_contacts"]
        != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"][
            "recommended_min_contacts"
        ]
    ):
        raise SystemExit("USB/side-key acceptance side-key contact budget stale")
    if (
        summary["pd_controller"]
        != integration["usb_pd_and_charger_context"]["pd_controller"]["part"]
    ):
        raise SystemExit("USB/side-key acceptance PD controller stale")
    if summary["charger"] != integration["usb_pd_and_charger_context"]["charger"]["part"]:
        raise SystemExit("USB/side-key acceptance charger stale")
    if (
        usb_context["selected_evt0_connector"]["family"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["family"]
    ):
        raise SystemExit("USB/side-key acceptance EVT0 connector family stale")
    if (
        mechanical_decision["status"]
        != "blocked_usb_sidekey_mechanical_decision_requires_supplier_drawings_routed_step_and_measurements"
    ):
        raise SystemExit("USB/side-key acceptance mechanical decision unexpectedly open")
    if (
        summary["usb_c_region_mm"]
        != mechanical_decision["usb_mechanical_policy"]["active_region_mm"]
    ):
        raise SystemExit("USB/side-key acceptance mechanical USB region stale")
    if (
        summary["side_key_connector_region_mm"]
        != mechanical_decision["side_key_mechanical_policy"]["active_connector_region_mm"]
    ):
        raise SystemExit("USB/side-key acceptance mechanical side-key region stale")

    if revalidation["schema"] != "eliza.e1_phone_usb_sidekey_source_revalidation.v1":
        raise SystemExit("USB/side-key source revalidation schema diverges")
    if revalidation["status"] != "public_sources_revalidated_usb_sidekey_not_supplier_approved":
        raise SystemExit(f"unexpected USB/side-key source status: {revalidation['status']}")
    if (
        revalidation["browser_revalidation_context"]["method"]
        != "manual_browser_open_and_search_on_2026_05_21"
    ):
        raise SystemExit("USB/side-key source revalidation method is stale")
    if (
        revalidation["browser_revalidation_context"]["current_browser_result"]["checked_date"]
        != "2026-05-21"
    ):
        raise SystemExit("USB/side-key source revalidation date is stale")
    source_records = {item["id"]: item for item in revalidation["revalidated_sources"]}
    required_source_ids = {
        "usb_evt0_gct_usb4105",
        "usb_production_molex_port_on_waterproof",
        "side_switch_primary_panasonic_evq_p7",
        "side_switch_alternate_ck_kmr2",
    }
    if set(source_records) != required_source_ids:
        raise SystemExit("USB/side-key source set diverges")
    evt0 = source_records["usb_evt0_gct_usb4105"]
    if (
        evt0["observed_public_fields"]["family"]
        != usb_binding["connector_strategy"]["evt0_low_risk"]["family"]
    ):
        raise SystemExit("USB-C EVT0 source family diverges from package binding")
    if (
        evt0["observed_public_fields"]["active_contacts"]
        != usb_context["selected_evt0_connector"]["active_contacts"]
    ):
        raise SystemExit("USB-C EVT0 source active-contact count stale")
    production = source_records["usb_production_molex_port_on_waterproof"]
    if (
        production["observed_public_fields"]["features"]
        != usb_binding["connector_strategy"]["production_superspeed"]["features"]
    ):
        raise SystemExit("USB-C production alternate source features stale")
    side_primary = source_records["side_switch_primary_panasonic_evq_p7"]
    if (
        side_primary["observed_public_fields"]["dimensions_mm"]
        != side_buttons["primary_switch_family"]["dimensions_mm"]
    ):
        raise SystemExit("side-key primary source dimensions stale")
    if (
        side_primary["observed_public_fields"]["travel_mm"]
        != side_buttons["primary_switch_family"]["travel_mm"]
    ):
        raise SystemExit("side-key primary source travel stale")
    side_alt = source_records["side_switch_alternate_ck_kmr2"]
    if (
        side_alt["observed_public_fields"]["dimensions_mm"]
        != side_buttons["alternate_switch_family"]["dimensions_mm"]
    ):
        raise SystemExit("side-key alternate source dimensions stale")
    for key, value in revalidation["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"USB/side-key source revalidation cross-check failed: {key}")

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
        f"{len(items)} acceptance items blocked, {len(source_records)} public sources checked, "
        f"port_count={summary['usb_c_port_count']}"
    )


def check_radio_module_selection_wiring_decision() -> None:
    decision = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-source-revalidation.yaml"
    )
    envelope_gate = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml"
    )
    cellular_downselect = load_yaml(
        ROOT / "board/kicad/e1-phone/cellular-space-saving-downselect.yaml"
    )
    integration = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-integration.yaml")
    execution = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")
    schematic = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-schematic-net-binding.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    supplier_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if decision["schema"] != "eliza.e1_phone_radio_module_selection_wiring_decision.v1":
        raise SystemExit("radio module selection/wiring decision schema diverges")
    if (
        decision["status"]
        != "blocked_radio_module_selection_requires_supplier_design_packs_region_decision_routed_rf_and_firmware_evidence"
    ):
        raise SystemExit(f"unexpected radio module selection status: {decision['status']}")
    rel = "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing radio module selection/wiring decision")
    for artifact in [integration, execution, schematic]:
        if rel not in artifact["source_artifacts"]:
            raise SystemExit("radio module selection/wiring decision is not cited downstream")
    for source in decision["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "cellular_package": cellular["status"],
        "wifi_bluetooth_package": wifi_bt["status"],
        "radio_module_source_revalidation": source_revalidation["status"],
        "radio_module_envelope_orderability_gate": envelope_gate["status"],
        "cellular_space_saving_downselect": cellular_downselect["status"],
        "radio_module_integration": integration["status"],
        "module_rf_pinout_execution": execution["status"],
        "radio_module_schematic_net_binding": schematic["status"],
        "placement_interface_matrix": placement["status"],
        "supplier_rfq_response_normalization": supplier_responses["status"],
    }
    if decision["upstream_status"] != expected_upstream:
        raise SystemExit("radio module selection upstream status stale")

    selected = decision["selected_wireless_stack"]
    cell_ref = selected["cellular_performance_reference"]
    cell_pkg = cellular["primary_first_phone"]
    if cell_ref["vendor"] != cell_pkg["vendor"] or cell_ref["family"] != cell_pkg["family"]:
        raise SystemExit("radio module selected cellular reference diverges from package")
    if cell_ref["class"] != cell_pkg["class"]:
        raise SystemExit("radio module selected cellular class diverges from package")
    if (
        cell_ref["public_envelope_mm"]
        != cell_pkg["public_2026_brochure_fields"]["rg255c_lga_dimensions_mm"]
    ):
        raise SystemExit("radio module selected cellular envelope diverges from package")
    if "do_not_route_release" not in cell_ref["board_decision"]:
        raise SystemExit("radio module selected cellular reference must remain release-blocked")

    branch = selected["cellular_space_saving_branch"]
    preferred = cellular_downselect["downselect_policy"]["primary_space_saving_branch"]
    candidates = {item["id"]: item for item in cellular_downselect["space_saving_candidates"]}
    if branch["preferred_candidate_id"] != preferred:
        raise SystemExit("radio module space-saving branch diverges from cellular downselect")
    preferred_candidate = candidates[preferred]
    if branch["class"] != preferred_candidate["class"]:
        raise SystemExit("radio module space-saving class diverges from cellular downselect")
    if branch["public_envelope_mm"] != preferred_candidate["public_envelope_mm"]:
        raise SystemExit("radio module space-saving envelope diverges from cellular downselect")
    if "not_production_substitute" not in branch["board_decision"]:
        raise SystemExit("radio module space-saving branch unexpectedly promoted")

    wifi_selected = selected["wifi_bluetooth_primary"]
    wifi_pkg = wifi_bt["vendor_public_specs"]
    for key in ["vendor", "order_number", "chipset", "wireless"]:
        if wifi_selected[key] != wifi_pkg[key]:
            raise SystemExit(f"radio module selected Wi-Fi/Bluetooth field stale: {key}")
    if wifi_selected["public_envelope_mm"] != wifi_pkg["package_mm"]:
        raise SystemExit("radio module selected Wi-Fi/Bluetooth envelope diverges")
    if "pending" not in wifi_selected["board_decision"]:
        raise SystemExit("radio module Wi-Fi/Bluetooth selection must remain supplier-gated")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    fit = decision["placement_fit_decision"]
    cell_fit = fit["cellular_current_region"]
    gate_cell_fit = envelope_gate["placement_region_fit"]["cellular_primary_lga_vs_u_cell"]
    if cell_fit["placement_region_mm"] != placements["U_CELL"]["region_mm"]:
        raise SystemExit("radio module cellular fit placement diverges from matrix")
    if cell_fit["selected_lga_envelope_mm"] != gate_cell_fit["module_envelope_mm"]:
        raise SystemExit("radio module cellular fit envelope diverges from envelope gate")
    if cell_fit["fits_current_region"] != gate_cell_fit["fit"]["fits_xy"]:
        raise SystemExit("radio module cellular fit flag diverges from envelope gate")
    if cell_fit["fits_current_region"]:
        raise SystemExit("radio module cellular selected LGA must not fit current placeholder")
    for key in ["width_shortfall_mm", "height_shortfall_mm"]:
        if cell_fit[key] != gate_cell_fit["fit"][key]:
            raise SystemExit(f"radio module cellular fit shortfall stale: {key}")

    wifi_fit = fit["wifi_bluetooth_current_region"]
    gate_wifi_fit = envelope_gate["placement_region_fit"]["wifi_bluetooth_primary_smt_vs_u_wifi_bt"]
    if wifi_fit["placement_region_mm"] != placements["U_WIFI_BT"]["region_mm"]:
        raise SystemExit("radio module Wi-Fi/Bluetooth fit placement diverges from matrix")
    if wifi_fit["selected_module_envelope_mm"] != gate_wifi_fit["module_envelope_mm"]:
        raise SystemExit("radio module Wi-Fi/Bluetooth fit envelope diverges from envelope gate")
    if wifi_fit["fits_current_region"] != gate_wifi_fit["fit"]["fits_xy"]:
        raise SystemExit("radio module Wi-Fi/Bluetooth fit flag diverges from envelope gate")
    for key in ["width_clearance_mm", "height_clearance_mm"]:
        if wifi_fit[key] != gate_wifi_fit["fit"][key]:
            raise SystemExit(f"radio module Wi-Fi/Bluetooth clearance stale: {key}")

    all_block_nets: set[str] = set()
    for block in netlist["blocks"]:
        all_block_nets.update(flatten_net_groups(block["nets"]))
    wiring = decision["host_wiring_contract"]
    cell_contracts = [
        item["contract"] for item in cellular["host_interfaces"]["cellular_module"]["required"]
    ]
    wifi_contracts = (
        [item["contract"] for item in wifi_bt["host_interfaces"]["wifi_primary"]["signals"]]
        + [item["contract"] for item in wifi_bt["host_interfaces"]["bluetooth"]["signals"]]
        + [item["contract"] for item in wifi_bt["host_interfaces"]["control"]["signals"]]
    )
    if wiring["cellular_required_host_contracts"] != cell_contracts:
        raise SystemExit("radio module cellular host wiring diverges from package")
    if wiring["wifi_bluetooth_required_host_contracts"] != wifi_contracts:
        raise SystemExit("radio module Wi-Fi/Bluetooth host wiring diverges from package")
    for key in [
        "cellular_required_host_contracts",
        "cellular_required_power_control_nets",
        "cellular_sim_esim_nets",
        "wifi_bluetooth_required_host_contracts",
        "wifi_bluetooth_required_power_control_nets",
    ]:
        missing = sorted(set(wiring[key]) - all_block_nets)
        if missing:
            raise SystemExit(
                f"radio module wiring nets missing from block netlist: {key} {missing}"
            )

    rf_contract = decision["rf_feed_contract"]
    rf_feeds = {item["net"]: item for item in execution["rf_feed_execution"]}
    if sorted(rf_contract["required_rf_nets"]) != sorted(rf_feeds):
        raise SystemExit("radio module RF feed contract diverges from execution")
    if rf_contract["required_rf_feed_count"] != len(rf_contract["required_rf_nets"]):
        raise SystemExit("radio module RF feed count stale")
    for net in rf_contract["required_rf_nets"]:
        if net not in all_block_nets:
            raise SystemExit(f"radio module RF feed missing from netlist: {net}")
    routing_pairs = {item["name"] for item in routing["differential_pairs"]}
    for pair in [
        "CELL_USB2_DP_DN",
        "CELL_PCIE_TX",
        "CELL_PCIE_RX",
        "WIFI_PCIE_TX",
        "WIFI_PCIE_RX",
    ]:
        if pair not in routing_pairs:
            raise SystemExit(f"radio module selection missing routing pair {pair}")

    factory = decision["firmware_identity_factory_contract"]
    execution_factory = execution["factory_firmware_identity_execution"]
    if factory["required_traceability_fields"] != execution_factory["traceability_fields_required"]:
        raise SystemExit("radio module factory traceability diverges from execution")
    if len(factory["missing_firmware_artifacts"]) < 3:
        raise SystemExit("radio module firmware missing-artifact list too weak")
    supplier = decision["supplier_release_policy"]
    if (
        supplier["supplier_response_packs_received"]
        != supplier_responses["normalization_outputs"]["present_response_pack_count"]
    ):
        raise SystemExit("radio module supplier response count stale")
    if supplier["release_allowed_without_supplier_response_packs"] is not False:
        raise SystemExit("radio module supplier response policy unexpectedly open")
    if len(supplier["required_before_layout_release"]) < 4:
        raise SystemExit("radio module supplier release policy too weak")

    for key, value in decision["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"radio module selection cross-check failed: {key}")
    for blocker in [
        "Cellular 5G RedCap reference module does not fit the current 14 x 14 mm U_CELL region.",
        "Cellular branch is unresolved between top-island repack for RG255C LGA and smaller LTE Cat 1 bis supplier-approved module.",
        "Cellular exact region SKU, band matrix, hardware design guide, pad map, reference layout, STEP, firmware, carrier/PTCRB/GCF plan, and SAR scope are missing.",
        "Murata Type 2EA pinout, land pattern, reference layout, STEP, firmware/NVRAM/CLM/license, regulatory database, and modular approval review are missing.",
        "Routed RF geometry, matching networks, conducted access, antenna tune, VNA/coexistence/SAR evidence, and factory RF limits are missing.",
    ]:
        if blocker not in decision["release_blockers"]:
            raise SystemExit(f"radio module selection missing blocker: {blocker}")
    for claim in [
        "radio_module_selection_final",
        "cellular_region_ready",
        "cellular_ready",
        "wifi_ready",
        "bluetooth_ready",
        "rf_ready",
        "carrier_ready",
        "sar_ready",
        "regulatory_ready",
        "firmware_ready",
        "factory_rf_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in decision["forbidden_claims"]:
            raise SystemExit(f"radio module selection missing forbidden claim {claim}")
    print(
        "radio module selection/wiring decision ok: "
        f"cellular_fit={cell_fit['fits_current_region']} wifi_fit={wifi_fit['fits_current_region']} "
        f"rf_feeds={rf_contract['required_rf_feed_count']} fail-closed"
    )


def check_radio_module_integration() -> None:
    integration = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-integration.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    wifi_gates = load_yaml(ROOT / "package/wifi/evidence-gates.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-source-revalidation.yaml"
    )
    module_host = load_yaml(ROOT / "board/kicad/e1-phone/module-host-integration-closure.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    rf_coexistence = load_yaml(ROOT / "board/kicad/e1-phone/rf-antenna-coexistence-closure.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    power_sequence = load_yaml(ROOT / "board/kicad/e1-phone/power-sequence-bringup-closure.yaml")
    component_height = load_yaml(
        ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml"
    )
    supplier_source = load_yaml(ROOT / "board/kicad/e1-phone/supplier-source-verification.yaml")
    supplier_to_kicad = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    manifest = load_yaml(MANIFEST)

    if integration["schema"] != "eliza.e1_phone_radio_module_integration.v1":
        raise SystemExit("radio module integration schema diverges")
    if (
        integration["status"]
        != "blocked_requires_module_pinout_firmware_rf_measurement_and_regulatory_evidence"
    ):
        raise SystemExit(f"unexpected radio module integration status: {integration['status']}")
    rel = "board/kicad/e1-phone/radio-module-integration.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing radio module integration artifact")
    for source in integration["source_artifacts"]:
        require_path(ROOT / source)

    public = integration["public_source_refresh"]
    if public["cellular"]["vendor"] != cellular["primary_first_phone"]["vendor"]:
        raise SystemExit("radio module integration cellular vendor stale")
    if public["cellular"]["family"] != cellular["primary_first_phone"]["family"]:
        raise SystemExit("radio module integration cellular family stale")
    if (
        public["cellular"]["observed_public_fields"]
        != cellular["primary_first_phone"]["public_features"]
    ):
        raise SystemExit("radio module integration cellular public fields stale")
    if public["cellular"]["sourcing_url"] != cellular["primary_first_phone"]["sourcing_url"]:
        raise SystemExit("radio module integration cellular source URL stale")
    if public["wifi_bluetooth"]["vendor"] != wifi_bt["vendor_public_specs"]["vendor"]:
        raise SystemExit("radio module integration Wi-Fi/Bluetooth vendor stale")
    if public["wifi_bluetooth"]["order_number"] != wifi_bt["vendor_public_specs"]["order_number"]:
        raise SystemExit("radio module integration Wi-Fi/Bluetooth order number stale")
    for key in [
        "chipset",
        "wireless",
        "interfaces",
        "package_mm",
        "certification_note",
        "sourcing_url",
    ]:
        if public["wifi_bluetooth"][key] != wifi_bt["vendor_public_specs"][key]:
            raise SystemExit(f"radio module integration Wi-Fi/Bluetooth public field stale: {key}")
    if (
        source_revalidation["status"]
        != "public_sources_revalidated_radio_modules_not_supplier_approved"
    ):
        raise SystemExit("radio module integration source revalidation status stale")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    host_records = {item["id"]: item for item in module_host["integration_records"]}
    rf_interfaces = {item["name"]: item for item in rf["interfaces"]}
    block_nets_by_id = {
        block["id"]: flatten_net_groups(block["nets"]) for block in netlist["blocks"]
    }
    all_block_nets: set[str] = set()
    for nets in block_nets_by_id.values():
        all_block_nets.update(nets)
    modules = integration["module_integration"]
    if set(modules) != {"cellular_5g_redcap", "wifi6e_bluetooth_5p3"}:
        raise SystemExit("radio module integration module set diverges")

    cellular_module = modules["cellular_5g_redcap"]
    if cellular_module["status"] != cellular["status"]:
        raise SystemExit("radio module integration cellular status stale")
    if cellular_module["placement"] != placements["U_CELL"]:
        raise SystemExit("radio module integration cellular placement stale")
    if cellular_module["module_host_record"] != host_records["cellular_5g_redcap_module"]:
        raise SystemExit("radio module integration cellular host record stale")
    cellular_rf_record = dict(rf_interfaces["cellular_5g_redcap"])
    cellular_rf_module = dict(cellular_rf_record["module"])
    cellular_rf_module.pop("public_2026_brochure_fields", None)
    cellular_rf_module.pop("public_source_revalidation", None)
    cellular_rf_record["module"] = cellular_rf_module
    if cellular_module["rf_connectivity_record"] != cellular_rf_record:
        raise SystemExit("radio module integration cellular RF record stale")
    if set(cellular_module["required_contracts"]) - all_block_nets:
        raise SystemExit("radio module integration cellular contracts missing from block netlist")
    if cellular_module["block_netlist_nets"] != sorted(block_nets_by_id["U_CELL"]):
        raise SystemExit("radio module integration cellular block nets stale")
    if not set(cellular_module["sim_esim_nets"]).issubset(block_nets_by_id["U_SIM_ESIM"]):
        raise SystemExit("radio module integration SIM/eSIM nets stale")
    if cellular_module["power_sequence_status"] != cellular["power_sequence"]["status"]:
        raise SystemExit("radio module integration cellular power sequence stale")
    if cellular_module["release_blockers"] != cellular["release_blockers"]:
        raise SystemExit("radio module integration cellular release blockers stale")

    wifi_module = modules["wifi6e_bluetooth_5p3"]
    if wifi_module["status"] != wifi_bt["status"]:
        raise SystemExit("radio module integration Wi-Fi/Bluetooth status stale")
    if wifi_module["placement"] != placements["U_WIFI_BT"]:
        raise SystemExit("radio module integration Wi-Fi/Bluetooth placement stale")
    if wifi_module["module_host_record"] != host_records["wifi_bluetooth_module"]:
        raise SystemExit("radio module integration Wi-Fi/Bluetooth host record stale")
    wifi_rf_record = dict(rf_interfaces["wifi6e_bluetooth_5p3"])
    wifi_rf_module = dict(wifi_rf_record["module"])
    wifi_rf_module.pop("product_brief_public_fields", None)
    wifi_rf_module.pop("public_source_revalidation", None)
    wifi_rf_record["module"] = wifi_rf_module
    if wifi_module["rf_connectivity_record"] != wifi_rf_record:
        raise SystemExit("radio module integration Wi-Fi/Bluetooth RF record stale")
    if set(wifi_module["required_contracts"]) - all_block_nets:
        raise SystemExit(
            "radio module integration Wi-Fi/Bluetooth contracts missing from block netlist"
        )
    if wifi_module["block_netlist_nets"] != sorted(block_nets_by_id["U_WIFI_BT"]):
        raise SystemExit("radio module integration Wi-Fi/Bluetooth block nets stale")
    if wifi_module["wifi_evidence_gate_status"] != wifi_gates["status"]:
        raise SystemExit("radio module integration Wi-Fi evidence gate status stale")
    gate_blockers = {item["id"]: item for item in wifi_gates["product_release_blockers"]}
    if set(wifi_module["wifi_release_blockers"]) != set(gate_blockers):
        raise SystemExit("radio module integration Wi-Fi blocker set diverges")
    for blocker_id, blocker in wifi_module["wifi_release_blockers"].items():
        gate = gate_blockers[blocker_id]
        if blocker["artifact_class"] != gate["artifact_class"]:
            raise SystemExit(f"radio module integration Wi-Fi blocker class stale: {blocker_id}")
        if blocker["status"] != gate["status"] or blocker["status"] != "blocked":
            raise SystemExit(
                f"radio module integration Wi-Fi blocker unexpectedly open: {blocker_id}"
            )
        if blocker["evidence_required"] != gate["evidence_required"]:
            raise SystemExit(f"radio module integration Wi-Fi blocker evidence stale: {blocker_id}")
    if wifi_module["release_forbidden_claims"] != wifi_bt["forbidden_claims"]:
        raise SystemExit("radio module integration Wi-Fi forbidden claims stale")

    rf_plan = integration["rf_feed_and_antenna_integration"]
    if sorted(rf_plan["required_rf_nets"]) != sorted(rf["required_rf_nets"]):
        raise SystemExit("radio module integration RF nets diverge from RF closure")
    coexistence_nets = [item["net"] for item in rf_coexistence["antenna_feed_plan"]]
    if sorted(rf_plan["required_rf_nets"]) != sorted(coexistence_nets):
        raise SystemExit("radio module integration RF nets diverge from coexistence closure")
    if rf_plan["antenna_feed_count"] != len(rf_plan["antenna_feed_plan"]):
        raise SystemExit("radio module integration antenna feed count stale")
    if rf_plan["antenna_feed_count"] != len(rf_plan["required_rf_nets"]):
        raise SystemExit("radio module integration antenna feed count diverges")
    if rf_plan["matching_networks_required"] != routing["rf_layout"]["matching_networks_required"]:
        raise SystemExit("radio module integration matching networks stale")
    factory_radios = next(item for item in factory_probe["probe_domains"] if item["id"] == "radios")
    factory_rf_nets = [net for net in factory_radios["nets"] if net in rf_plan["required_rf_nets"]]
    if sorted(rf_plan["required_rf_nets"]) != sorted(factory_rf_nets):
        raise SystemExit("radio module integration factory RF coverage stale")
    for feed in rf_plan["antenna_feed_plan"]:
        if feed["net"] not in all_block_nets:
            raise SystemExit(
                f"radio module integration RF feed missing from block netlist: {feed['net']}"
            )
        for key in [
            "matching_network_required",
            "conducted_access_required",
            "factory_calibration_required",
        ]:
            if feed[key] is not True:
                raise SystemExit(
                    f"radio module integration RF feed missing requirement: {feed['net']} {key}"
                )
        if not feed["status"].startswith("blocked_"):
            raise SystemExit(f"radio module integration RF feed unexpectedly open: {feed['net']}")

    evidence = integration["firmware_regulatory_and_factory_evidence"]
    if sorted(evidence["wifi_evidence_gate_blockers"]) != sorted(gate_blockers):
        raise SystemExit("radio module integration firmware gate blocker list stale")
    if len(evidence["cellular_required"]) < 5 or len(evidence["wifi_bt_required"]) < 6:
        raise SystemExit("radio module integration firmware/regulatory evidence too weak")
    for script in evidence["aosp_probe_scripts"]:
        require_path(ROOT / script)

    deps = integration["power_thermal_and_enclosure_dependencies"]
    if deps["power_sequence_status"] != power_sequence["status"]:
        raise SystemExit("radio module integration power dependency stale")
    if deps["component_height_step_status"] != component_height["status"]:
        raise SystemExit("radio module integration component-height dependency stale")
    if deps["routed_release_status"] != routed_release["status"]:
        raise SystemExit("radio module integration routed-release dependency stale")
    for key in [
        "requires_rf_vbat_burst_profile",
        "requires_final_enclosure_plastic_metal_stack_review",
        "requires_radio_shield_and_antenna_step_models",
    ]:
        if deps[key] is not True:
            raise SystemExit(f"radio module integration dependency must require {key}")
    supplier = integration["supplier_data_dependencies"]
    if supplier["supplier_source_status"] != supplier_source["status"]:
        raise SystemExit("radio module integration supplier-source status stale")
    if supplier["supplier_to_kicad_status"] != supplier_to_kicad["status"]:
        raise SystemExit("radio module integration supplier-to-KiCad status stale")
    if len(supplier["required_supplier_outputs"]) < 6:
        raise SystemExit("radio module integration supplier output list too weak")

    for output in integration["required_release_outputs"]:
        if output in {
            "package/wifi/evidence/firmware",
            "package/wifi/evidence/regulatory",
            "package/cellular/evidence/carrier-certification",
        }:
            if is_release_artifact_present(ROOT / output):
                raise SystemExit(
                    f"radio module integration evidence directory unexpectedly exists: {output}"
                )
        elif is_release_artifact_present(ROOT / output):
            raise SystemExit(
                f"radio module integration release output unexpectedly exists: {output}"
            )
    for key, value in integration["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"radio module integration cross-check failed: {key}")
    for blocker in [
        "cellular module region SKU, band matrix, hardware design guide, STEP, RF feed rules, and SIM/eSIM path are missing",
        "Wi-Fi/Bluetooth footprint, firmware/NVRAM/CLM, license, country-code, and modular approval scope are missing",
        "routed RF feed geometry, matching networks, via fences, shields, and conducted access are missing",
        "VNA, conducted RF, coexistence, GNSS desense, SAR pre-scan, and carrier/PTCRB/GCF evidence are missing",
        "factory RF calibration procedure, test limits, and first-article transcript are missing",
        "Android/Linux cellular, Wi-Fi, and Bluetooth bring-up logs are missing",
    ]:
        if blocker not in integration["release_blockers"]:
            raise SystemExit(f"radio module integration missing blocker: {blocker}")
    for claim in [
        "radio_modules_integrated",
        "cellular_ready",
        "wifi_ready",
        "bluetooth_ready",
        "gnss_ready",
        "rf_ready",
        "carrier_ready",
        "sar_ready",
        "regulatory_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in integration["forbidden_claims"]:
            raise SystemExit(f"radio module integration missing forbidden claim {claim}")
    print(
        "radio module integration ok: "
        f"{len(modules)} modules, {rf_plan['antenna_feed_count']} RF feeds fail-closed"
    )


def check_radio_module_envelope_orderability_gate() -> None:
    gate = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-source-revalidation.yaml"
    )
    integration = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-integration.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    envelopes = load_yaml(ROOT / "board/kicad/e1-phone/component-envelope-fit-audit.yaml")
    feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    trial = load_yaml(ROOT / "board/kicad/e1-phone/trial-route-input-matrix.yaml")
    supplier_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if gate["schema"] != "eliza.e1_phone_radio_module_envelope_orderability_gate.v1":
        raise SystemExit("radio module envelope/orderability gate schema diverges")
    if gate["status"] != "blocked_cellular_region_too_small_and_supplier_design_packs_missing":
        raise SystemExit(f"unexpected radio module envelope/orderability status: {gate['status']}")
    rel = "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing radio module envelope/orderability gate artifact")
    for source in gate["source_artifacts"]:
        require_path(ROOT / source)

    upstream = gate["upstream_status"]
    expected_statuses = {
        "radio_module_source_revalidation": source_revalidation["status"],
        "radio_module_integration": integration["status"],
        "placement_interface_matrix": placement["status"],
        "component_envelope_fit_audit": envelopes["status"],
        "route_feasibility_density": feasibility["status"],
        "trial_route_input_matrix": trial["status"],
        "supplier_rfq_response_normalization": supplier_responses["status"],
    }
    for key, value in expected_statuses.items():
        if upstream[key] != value:
            raise SystemExit(f"radio module envelope/orderability upstream status stale: {key}")

    public = gate["public_module_envelopes"]
    cellular_public = public["cellular_primary_lga"]
    cellular_pkg = cellular["primary_first_phone"]
    cellular_brochure = cellular_pkg["public_2026_brochure_fields"]
    if cellular_public["vendor"] != cellular_pkg["vendor"]:
        raise SystemExit("radio module envelope/orderability cellular vendor stale")
    if cellular_public["family"] != cellular_pkg["family"]:
        raise SystemExit("radio module envelope/orderability cellular family stale")
    if cellular_public["envelope_mm"] != cellular_brochure["rg255c_lga_dimensions_mm"]:
        raise SystemExit("radio module envelope/orderability cellular LGA dimensions stale")
    if cellular_public["public_source"] != cellular_brochure["url"]:
        raise SystemExit("radio module envelope/orderability cellular public source stale")

    lab_fallback = public["cellular_lab_fallback_m2"]
    if (
        lab_fallback["public_envelopes_mm"]["rg255c_m2"]
        != cellular_brochure["rg255c_m2_dimensions_mm"]
    ):
        raise SystemExit("radio module envelope/orderability RG255C M.2 fallback stale")
    if (
        lab_fallback["public_envelopes_mm"]["rm255c_gl_m2"]
        != cellular_brochure["rm255c_gl_m2_dimensions_mm"]
    ):
        raise SystemExit("radio module envelope/orderability RM255C-GL M.2 fallback stale")
    if lab_fallback["board_use"] != "lab_dev_bringup_only_not_phone_layout_primary":
        raise SystemExit(
            "radio module envelope/orderability M.2 fallback must not be phone primary"
        )

    wifi_public = public["wifi_bluetooth_primary_smt"]
    wifi_specs = wifi_bt["vendor_public_specs"]
    if wifi_public["vendor"] != wifi_specs["vendor"]:
        raise SystemExit("radio module envelope/orderability Wi-Fi vendor stale")
    if wifi_public["order_number"] != wifi_specs["order_number"]:
        raise SystemExit("radio module envelope/orderability Wi-Fi order number stale")
    if wifi_public["envelope_mm"] != wifi_specs["package_mm"]:
        raise SystemExit("radio module envelope/orderability Wi-Fi dimensions stale")
    if wifi_public["public_source"] != wifi_specs["sourcing_url"]:
        raise SystemExit("radio module envelope/orderability Wi-Fi public source stale")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    fits = gate["placement_region_fit"]
    cellular_fit = fits["cellular_primary_lga_vs_u_cell"]
    wifi_fit = fits["wifi_bluetooth_primary_smt_vs_u_wifi_bt"]

    def check_region_fit(record: dict, refdes: str, envelope: dict) -> None:
        region = placements[refdes]["region_mm"]
        if record["placement_refdes_group"] != refdes:
            raise SystemExit(f"radio module envelope/orderability refdes stale: {refdes}")
        if record["placement_region_mm"] != region:
            raise SystemExit(f"radio module envelope/orderability region stale: {refdes}")
        if record["module_envelope_mm"] != envelope:
            raise SystemExit(f"radio module envelope/orderability envelope stale: {refdes}")
        fit = record["fit"]
        width_shortfall = max(0.0, round(envelope["width"] - region["width"], 3))
        height_shortfall = max(0.0, round(envelope["height"] - region["height"], 3))
        rotated_width_shortfall = max(0.0, round(envelope["height"] - region["width"], 3))
        rotated_height_shortfall = max(0.0, round(envelope["width"] - region["height"], 3))
        if fit["fits_width"] != (width_shortfall == 0.0):
            raise SystemExit(f"radio module envelope/orderability width fit stale: {refdes}")
        if fit["fits_height"] != (height_shortfall == 0.0):
            raise SystemExit(f"radio module envelope/orderability height fit stale: {refdes}")
        if fit["fits_xy"] != (width_shortfall == 0.0 and height_shortfall == 0.0):
            raise SystemExit(f"radio module envelope/orderability XY fit stale: {refdes}")
        if fit["fits_rotated"] != (
            rotated_width_shortfall == 0.0 and rotated_height_shortfall == 0.0
        ):
            raise SystemExit(f"radio module envelope/orderability rotated fit stale: {refdes}")
        if fit["rotated_width_shortfall_mm"] != rotated_width_shortfall:
            raise SystemExit(f"radio module envelope/orderability rotated width stale: {refdes}")
        if fit["rotated_height_shortfall_mm"] != rotated_height_shortfall:
            raise SystemExit(f"radio module envelope/orderability rotated height stale: {refdes}")
        if "width_shortfall_mm" in fit and fit["width_shortfall_mm"] != width_shortfall:
            raise SystemExit(f"radio module envelope/orderability width shortfall stale: {refdes}")
        if "height_shortfall_mm" in fit and fit["height_shortfall_mm"] != height_shortfall:
            raise SystemExit(f"radio module envelope/orderability height shortfall stale: {refdes}")
        if "width_clearance_mm" in fit and fit["width_clearance_mm"] != round(
            region["width"] - envelope["width"], 3
        ):
            raise SystemExit(f"radio module envelope/orderability width clearance stale: {refdes}")
        if "height_clearance_mm" in fit and fit["height_clearance_mm"] != round(
            region["height"] - envelope["height"], 3
        ):
            raise SystemExit(f"radio module envelope/orderability height clearance stale: {refdes}")

    check_region_fit(
        cellular_fit,
        "U_CELL",
        cellular_brochure["rg255c_lga_dimensions_mm"],
    )
    check_region_fit(wifi_fit, "U_WIFI_BT", wifi_specs["package_mm"])
    if cellular_fit["fit"]["fits_xy"] or cellular_fit["fit"]["fits_rotated"]:
        raise SystemExit("radio module envelope/orderability must block current cellular region")
    if not wifi_fit["fit"]["fits_xy"]:
        raise SystemExit("radio module envelope/orderability Wi-Fi public outline should still fit")
    if not cellular_fit["consequence"].startswith("current_u_cell_region_invalid"):
        raise SystemExit(
            "radio module envelope/orderability missing cellular invalid-region consequence"
        )

    consequence = gate["route_and_enclosure_consequence"]
    for key in [
        "current_cellular_region_invalid_for_selected_lga",
        "current_wifi_region_accepts_public_outline_only",
        "m2_cellular_fallback_allowed_only_for_lab_bringup",
        "top_island_repack_or_smaller_cellular_module_required_before_evt1_route",
        "routed_step_and_enclosure_rerun_required_after_radio_region_change",
    ]:
        if consequence[key] is not True:
            raise SystemExit(f"radio module envelope/orderability consequence must require {key}")

    supplier_dependency = gate["supplier_response_dependency"]
    if supplier_dependency["supplier_rfq_response_packs_received"] != 0:
        raise SystemExit(
            "radio module envelope/orderability must not claim supplier responses received"
        )
    if supplier_dependency["release_allowed_without_supplier_response_packs"] is not False:
        raise SystemExit("radio module envelope/orderability must block without supplier responses")
    if (
        supplier_responses["normalization_outputs"]["present_response_pack_count"]
        != supplier_dependency["supplier_rfq_response_packs_received"]
    ):
        raise SystemExit("radio module envelope/orderability supplier response count stale")
    if (
        len(
            gate["orderability_and_design_pack_requirements"][
                "cellular_required_before_layout_release"
            ]
        )
        < 6
    ):
        raise SystemExit("radio module envelope/orderability cellular requirements too weak")
    if (
        len(
            gate["orderability_and_design_pack_requirements"][
                "wifi_bluetooth_required_before_layout_release"
            ]
        )
        < 5
    ):
        raise SystemExit("radio module envelope/orderability Wi-Fi requirements too weak")

    for key, value in gate["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"radio module envelope/orderability cross-check failed: {key}")
    for blocker in [
        "selected Quectel RG255C LGA public envelope is 29.0 x 32.0 mm and does not fit the current 14.0 x 14.0 mm U_CELL region",
        "exact cellular region SKU, orderable MPN, band matrix, hardware design guide, LGA pad map, land pattern, STEP, and reference layout are missing",
        "Murata Type 2EA land pattern, reference layout, STEP, firmware/NVRAM/CLM/license, regulatory database, and antenna gain review are missing",
        "no supplier response packs have been received for the radio modules or antenna design",
    ]:
        if blocker not in gate["release_blockers"]:
            raise SystemExit(f"radio module envelope/orderability missing blocker: {blocker}")
    for claim in [
        "cellular_region_ready",
        "radio_modules_fit",
        "modules_wired_final",
        "rf_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in gate["forbidden_claims"]:
            raise SystemExit(f"radio module envelope/orderability missing forbidden claim {claim}")
    print(
        "radio module envelope/orderability gate ok: "
        f"cellular_fit={cellular_fit['fit']['fits_xy']} "
        f"cellular_shortfall={cellular_fit['fit']['width_shortfall_mm']}x"
        f"{cellular_fit['fit']['height_shortfall_mm']}mm "
        f"wifi_fit={wifi_fit['fit']['fits_xy']}"
    )


def check_cellular_top_island_repack_feasibility() -> None:
    feasibility = load_yaml(
        ROOT / "board/kicad/e1-phone/cellular-top-island-repack-feasibility.yaml"
    )
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    utilization = load_yaml(ROOT / "board/kicad/e1-phone/layout-utilization.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    repack = load_yaml(ROOT / "board/kicad/e1-phone/placement-repack-candidate.yaml")
    envelopes = load_yaml(ROOT / "board/kicad/e1-phone/component-envelope-fit-audit.yaml")
    radio_gate = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml"
    )
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    battery = load_yaml(ROOT / "package/battery/e1-phone-17p3wh-pack.yaml")
    battery_options = load_yaml(ROOT / "board/kicad/e1-phone/battery-layout-options.yaml")
    route_feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    manifest = load_yaml(MANIFEST)

    if feasibility["schema"] != "eliza.e1_phone_cellular_top_island_repack_feasibility.v1":
        raise SystemExit("cellular top-island feasibility schema diverges")
    if (
        feasibility["status"]
        != "blocked_selected_lga_overfills_current_top_island_without_repack_or_module_change"
    ):
        raise SystemExit(
            f"unexpected cellular top-island feasibility status: {feasibility['status']}"
        )
    rel = "board/kicad/e1-phone/cellular-top-island-repack-feasibility.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing cellular top-island repack feasibility")
    for source in feasibility["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "placement_interface_matrix": placement["status"],
        "placement_repack_candidate": repack["status"],
        "component_envelope_fit_audit": envelopes["status"],
        "radio_module_envelope_orderability_gate": radio_gate["status"],
        "battery_layout_options": battery_options["status"],
        "route_feasibility_density": route_feasibility["status"],
    }
    if feasibility["upstream_status"] != expected_upstream:
        raise SystemExit("cellular top-island feasibility upstream status stale")

    geometry = feasibility["locked_geometry"]
    metrics_regions = {
        item["name"]: item for item in metrics["mainboard_outline_concept"]["copper_regions"]
    }
    top_region = metrics_regions["top_logic_rf"]
    bottom_region = metrics_regions["bottom_io_audio"]
    if geometry["board_bbox_mm"] != metrics["mainboard_outline_concept"]["bounding_box_mm"]:
        raise SystemExit("cellular top-island feasibility board bbox diverges from metrics")
    if geometry["board_bbox_mm"] != utilization["board_bbox_mm"]:
        raise SystemExit("cellular top-island feasibility board bbox diverges from utilization")
    expected_top = {
        "x": top_region["x_mm"],
        "y": top_region["y_mm"],
        "width": top_region["width_mm"],
        "height": top_region["height_mm"],
        "area_mm2": top_region["area_mm2"],
    }
    if geometry["top_island_mm"] != expected_top:
        raise SystemExit("cellular top-island feasibility top island geometry stale")
    expected_bottom = {
        "x": bottom_region["x_mm"],
        "y": bottom_region["y_mm"],
        "width": bottom_region["width_mm"],
        "height": bottom_region["height_mm"],
        "area_mm2": bottom_region["area_mm2"],
    }
    if geometry["bottom_island_mm"] != expected_bottom:
        raise SystemExit("cellular top-island feasibility bottom island geometry stale")
    if geometry["battery_window_mm"] != utilization["battery_window_mm"]:
        raise SystemExit("cellular top-island feasibility battery window diverges from utilization")
    if (
        geometry["battery_window_mm"]["width"]
        != battery["target_pack"]["public_reference_dimensions_mm"]["width"]
        or geometry["battery_window_mm"]["height"]
        != battery["target_pack"]["public_reference_dimensions_mm"]["height"]
    ):
        raise SystemExit("cellular top-island feasibility battery window diverges from pack")
    expected_gap = round(
        geometry["battery_window_mm"]["y"]
        - (geometry["top_island_mm"]["y"] + geometry["top_island_mm"]["height"]),
        3,
    )
    if geometry["top_to_battery_gap_mm"] != expected_gap:
        raise SystemExit("cellular top-island feasibility top-to-battery gap stale")

    module = feasibility["selected_cellular_module"]
    lga = cellular["primary_first_phone"]["public_2026_brochure_fields"]["rg255c_lga_dimensions_mm"]
    if module["public_unrotated_envelope_mm"] != lga:
        raise SystemExit("cellular top-island feasibility unrotated envelope stale")
    expected_rotated = {
        "width": lga["height"],
        "height": lga["width"],
        "thickness": lga["thickness"],
    }
    if module["public_rotated_envelope_mm"] != expected_rotated:
        raise SystemExit("cellular top-island feasibility rotated envelope stale")
    rotated_area = round(expected_rotated["width"] * expected_rotated["height"], 3)
    if module["rotated_area_mm2"] != rotated_area:
        raise SystemExit("cellular top-island feasibility rotated area stale")
    expected_share = round(rotated_area * 100.0 / geometry["top_island_mm"]["area_mm2"], 1)
    if module["share_of_top_island_pct"] != expected_share:
        raise SystemExit("cellular top-island feasibility top island share stale")
    vertical_clearance = round(geometry["top_island_mm"]["height"] - expected_rotated["height"], 3)
    if module["vertical_clearance_if_rotated_in_top_island_mm"] != vertical_clearance:
        raise SystemExit("cellular top-island feasibility vertical clearance stale")
    if module["battery_gap_remaining_if_rotated_at_y0_mm"] != geometry["top_to_battery_gap_mm"]:
        raise SystemExit("cellular top-island feasibility battery gap after rotation stale")
    if (
        module["public_unrotated_envelope_mm"]
        != radio_gate["public_module_envelopes"]["cellular_primary_lga"]["envelope_mm"]
    ):
        raise SystemExit("cellular top-island feasibility diverges from radio gate")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    top_refdes = [
        "U_CELL",
        "U_WIFI_BT",
        "U_SOC_LPDDR_UFS",
        "U_PMIC_CHARGER",
        "SW_POWER_VOL",
        "J_BATTERY",
        "J_DISPLAY_TOUCH",
        "J_CAM0_CAM1",
        "J_TOP_BOTTOM_FLEX_TOP",
    ]
    expected_areas = {
        refdes: round(
            placements[refdes]["region_mm"]["width"] * placements[refdes]["region_mm"]["height"],
            3,
        )
        for refdes in top_refdes
    }
    pressure = feasibility["current_top_island_region_pressure"]
    if pressure["current_top_region_area_mm2"] != expected_areas:
        raise SystemExit("cellular top-island feasibility current top region areas stale")
    current_total = round(sum(expected_areas.values()), 3)
    if pressure["current_top_region_total_mm2"] != current_total:
        raise SystemExit("cellular top-island feasibility current top total stale")
    current_pct = round(current_total * 100.0 / geometry["top_island_mm"]["area_mm2"], 1)
    if pressure["current_top_region_total_pct_of_top_island"] != current_pct:
        raise SystemExit("cellular top-island feasibility current top percentage stale")
    replaced_total = round(current_total - expected_areas["U_CELL"] + rotated_area, 3)
    if pressure["top_region_total_with_rotated_rg255c_replacing_placeholder_mm2"] != replaced_total:
        raise SystemExit("cellular top-island feasibility rotated replacement total stale")
    replaced_pct = round(replaced_total * 100.0 / geometry["top_island_mm"]["area_mm2"], 1)
    if pressure["top_region_total_with_rotated_rg255c_pct_of_top_island"] != replaced_pct:
        raise SystemExit("cellular top-island feasibility rotated replacement percentage stale")
    overage = round(replaced_total - geometry["top_island_mm"]["area_mm2"], 3)
    if pressure["over_top_island_before_rf_keepouts_mm2"] != overage:
        raise SystemExit("cellular top-island feasibility top island overage stale")
    if overage <= 0:
        raise SystemExit(
            "cellular top-island feasibility must remain blocked on top island overage"
        )

    conflict = feasibility["conflict_summary"]
    expected_conflict = {
        "unrotated_rg255c_lga_fits_top_island": (
            lga["width"] <= geometry["top_island_mm"]["width"]
            and lga["height"] <= geometry["top_island_mm"]["height"]
        ),
        "rotated_rg255c_lga_fits_top_island_outline_only": (
            expected_rotated["width"] <= geometry["top_island_mm"]["width"]
            and expected_rotated["height"] <= geometry["top_island_mm"]["height"]
        ),
        "rotated_rg255c_lga_leaves_vertical_keepout_margin": vertical_clearance > 0,
        "rotated_rg255c_plus_current_top_regions_fit_by_area": replaced_total
        <= geometry["top_island_mm"]["area_mm2"],
        "preserves_64x87_battery_window": True,
    }
    for key, expected in expected_conflict.items():
        if conflict[key] != expected:
            raise SystemExit(f"cellular top-island feasibility conflict summary stale: {key}")
    if not conflict["conclusion"].startswith("current_64x29_top_island_cannot_claim"):
        raise SystemExit(
            "cellular top-island feasibility conclusion must reject current top island"
        )

    options = {item["id"]: item for item in feasibility["decision_options"]}
    expected_options = {
        "select_smaller_orderable_cellular_lga_or_lcc",
        "repack_top_island_around_rotated_rg255c",
        "increase_top_island_height_keep_board_height_and_bottom_island",
        "increase_board_or_device_height",
        "m2_cellular_lab_only",
    }
    if set(options) != expected_options:
        raise SystemExit("cellular top-island feasibility decision option set diverges")
    if not options["select_smaller_orderable_cellular_lga_or_lcc"]["status"].startswith(
        "preferred_"
    ):
        raise SystemExit("cellular top-island feasibility must prefer smaller module parallel path")
    if options["m2_cellular_lab_only"]["status"] != "allowed_for_lab_carrier_testing_only":
        raise SystemExit("cellular top-island feasibility M.2 option must stay lab-only")
    if len(feasibility["recommended_next_actions"]) < 4:
        raise SystemExit("cellular top-island feasibility next actions too weak")

    for key, value in feasibility["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"cellular top-island feasibility cross-check failed: {key}")
    for blocker in [
        "rotated RG255C LGA consumes 928 mm2, 50.0 percent of the current 64 x 29 mm top island, before RF keepouts",
        "replacing the current U_CELL placeholder with rotated RG255C raises top-island rectangular demand to 1987 mm2 against 1856 mm2 available",
        "no supplier RG255C LGA reference layout, RF keepout, land pattern, STEP, or antenna review exists",
        "M.2 cellular fallback is lab-only and cannot support enclosure-ready phone layout claims",
    ]:
        if blocker not in feasibility["release_blockers"]:
            raise SystemExit(f"cellular top-island feasibility missing blocker: {blocker}")
    for claim in [
        "cellular_top_island_fit_ready",
        "selected_cellular_module_layout_ready",
        "top_island_repack_ready",
        "route_feasible",
        "rf_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in feasibility["forbidden_claims"]:
            raise SystemExit(f"cellular top-island feasibility missing forbidden claim: {claim}")
    print(
        "cellular top-island repack feasibility ok: "
        f"rotated_area={rotated_area}mm2 top_share={expected_share}% "
        f"top_overage={overage}mm2"
    )


def check_cellular_space_saving_downselect() -> None:
    downselect = load_yaml(ROOT / "board/kicad/e1-phone/cellular-space-saving-downselect.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    top_island = load_yaml(
        ROOT / "board/kicad/e1-phone/cellular-top-island-repack-feasibility.yaml"
    )
    radio_gate = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml"
    )
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    procurement = load_yaml(ROOT / "board/kicad/e1-phone/procurement-readiness.yaml")
    supplier_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if downselect["schema"] != "eliza.e1_phone_cellular_space_saving_downselect.v1":
        raise SystemExit("cellular space-saving downselect schema diverges")
    if (
        downselect["status"]
        != "blocked_space_saving_lte_alternates_need_supplier_packs_and_performance_decision"
    ):
        raise SystemExit(
            f"unexpected cellular space-saving downselect status: {downselect['status']}"
        )
    rel = "board/kicad/e1-phone/cellular-space-saving-downselect.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing cellular space-saving downselect")
    if rel not in procurement["source_artifacts"]:
        raise SystemExit("procurement readiness must cite cellular space-saving downselect")
    if rel not in top_island["source_artifacts"]:
        raise SystemExit("top-island feasibility must cite cellular space-saving downselect")
    for source in downselect["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "cellular_package": cellular["status"],
        "cellular_top_island_repack_feasibility": top_island["status"],
        "radio_module_envelope_orderability_gate": radio_gate["status"],
        "placement_interface_matrix": placement["status"],
        "procurement_readiness": procurement["status"],
        "supplier_rfq_response_normalization": supplier_responses["status"],
    }
    if downselect["upstream_status"] != expected_upstream:
        raise SystemExit("cellular space-saving downselect upstream status stale")

    context = downselect["decision_context"]
    rg255c = cellular["primary_first_phone"]["public_2026_brochure_fields"][
        "rg255c_lga_dimensions_mm"
    ]
    if context["current_primary_envelope_mm"] != rg255c:
        raise SystemExit("cellular space-saving downselect current primary envelope stale")
    primary_area = round(rg255c["width"] * rg255c["height"], 3)
    if context["current_primary_area_mm2"] != primary_area:
        raise SystemExit("cellular space-saving downselect primary area stale")
    if (
        context["current_primary_top_island_overage_mm2"]
        != top_island["current_top_island_region_pressure"][
            "over_top_island_before_rf_keepouts_mm2"
        ]
    ):
        raise SystemExit("cellular space-saving downselect top-island overage stale")
    placement_regions = {
        item["refdes_group"]: item["region_mm"] for item in placement["placements"]
    }
    if context["old_placeholder_region_mm"] != placement_regions["U_CELL"]:
        raise SystemExit("cellular space-saving downselect placeholder region stale")
    placeholder_area = round(
        placement_regions["U_CELL"]["width"] * placement_regions["U_CELL"]["height"], 3
    )
    if context["old_placeholder_area_mm2"] != placeholder_area:
        raise SystemExit("cellular space-saving downselect placeholder area stale")
    if context["top_island_area_mm2"] != top_island["locked_geometry"]["top_island_mm"]["area_mm2"]:
        raise SystemExit("cellular space-saving downselect top island area stale")
    if (
        context["current_top_region_total_mm2"]
        != top_island["current_top_island_region_pressure"]["current_top_region_total_mm2"]
    ):
        raise SystemExit("cellular space-saving downselect current top total stale")

    package_candidates = {
        item["id"]: item for item in cellular["phone_layout_space_saving_alternates"]["candidates"]
    }
    candidates = {item["id"]: item for item in downselect["space_saving_candidates"]}
    expected_candidates = {
        "quectel_eg915q_na_or_eg915u_class",
        "quectel_eg916q_gl",
        "fibocom_mc665",
        "simcom_a7680c_china_only_size_reference",
    }
    if set(candidates) != expected_candidates or set(package_candidates) != expected_candidates:
        raise SystemExit("cellular space-saving candidate set diverges")

    top_area = context["top_island_area_mm2"]
    top_current = context["current_top_region_total_mm2"]
    for candidate_id, candidate in candidates.items():
        package_candidate = package_candidates[candidate_id]
        if candidate["public_envelope_mm"] != package_candidate["public_envelope_mm"]:
            raise SystemExit(
                f"cellular space-saving envelope diverges from package: {candidate_id}"
            )
        if candidate["source_url"] != package_candidate["public_source"]:
            raise SystemExit(
                f"cellular space-saving source URL diverges from package: {candidate_id}"
            )
        envelope = candidate["public_envelope_mm"]
        area = round(envelope["width"] * envelope["height"], 2)
        if candidate["area_mm2"] != area:
            raise SystemExit(f"cellular space-saving candidate area stale: {candidate_id}")
        savings = round(primary_area - area, 2)
        if candidate["area_savings_vs_rg255c_mm2"] != savings:
            raise SystemExit(f"cellular space-saving candidate savings stale: {candidate_id}")
        pct_savings = round(savings * 100.0 / primary_area, 1)
        if candidate["percent_area_savings_vs_rg255c"] != pct_savings:
            raise SystemExit(
                f"cellular space-saving candidate savings percent stale: {candidate_id}"
            )
        top_total = round(top_current - placeholder_area + area, 2)
        if candidate["top_island_total_if_replacing_placeholder_mm2"] != top_total:
            raise SystemExit(f"cellular space-saving candidate top total stale: {candidate_id}")
        remaining = round(top_area - top_total, 2)
        if candidate["top_island_remaining_before_rf_keepouts_mm2"] != remaining:
            raise SystemExit(f"cellular space-saving candidate top remaining stale: {candidate_id}")
        fits_placeholder = (
            envelope["width"] <= placement_regions["U_CELL"]["width"]
            and envelope["height"] <= placement_regions["U_CELL"]["height"]
        ) or (
            envelope["height"] <= placement_regions["U_CELL"]["width"]
            and envelope["width"] <= placement_regions["U_CELL"]["height"]
        )
        if candidate["fits_current_14x14_placeholder"] != fits_placeholder:
            raise SystemExit(f"cellular space-saving placeholder fit stale: {candidate_id}")
        fits_24x20 = (envelope["width"] <= 24.0 and envelope["height"] <= 20.0) or (
            envelope["height"] <= 24.0 and envelope["width"] <= 20.0
        )
        if candidate["fits_repacked_24x20_region_outline_only"] != fits_24x20:
            raise SystemExit(f"cellular space-saving 24x20 fit stale: {candidate_id}")
        if area >= primary_area:
            raise SystemExit(
                f"cellular space-saving candidate is not smaller than RG255C: {candidate_id}"
            )

    policy = downselect["downselect_policy"]
    if policy["primary_space_saving_branch"] != "quectel_eg915q_na_or_eg915u_class":
        raise SystemExit("cellular space-saving primary branch changed unexpectedly")
    if not any(
        "LTE Cat 1 bis" in item for item in policy["accepted_tradeoffs_before_supplier_review"]
    ):
        raise SystemExit(
            "cellular space-saving downselect must explicitly record LTE Cat 1 bis tradeoff"
        )
    for forbidden in [
        "claim current U_CELL is ready",
        "use M.2 cellular in the phone enclosure",
        "approve any alternate without supplier design pack and samples",
    ]:
        if forbidden not in policy["not_allowed"]:
            raise SystemExit(
                f"cellular space-saving downselect missing not-allowed rule: {forbidden}"
            )
    if supplier_responses["normalization_outputs"]["present_response_pack_count"] != 0:
        raise SystemExit(
            "cellular space-saving downselect must not claim supplier responses received"
        )
    if len(downselect["rfq_updates_required"]) < 4:
        raise SystemExit("cellular space-saving downselect RFQ updates too weak")
    for name, value in downselect["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"cellular space-saving downselect cross-check failed: {name}")
    for blocker in [
        "no smaller cellular module has an approved supplier response pack, sample, land pattern, STEP, firmware pack, or antenna review",
        "LTE Cat 1 bis branch reduces cellular performance versus the current 5G RedCap reference",
        "current U_CELL 14 x 14 mm region still fits none of the shortlisted modules",
        "carrier/PTCRB/GCF/SAR scope must be restarted for any selected alternate",
    ]:
        if blocker not in downselect["release_blockers"]:
            raise SystemExit(f"cellular space-saving downselect missing blocker: {blocker}")
    for claim in [
        "cellular_alternate_selected",
        "cellular_region_ready",
        "cellular_ready",
        "carrier_ready",
        "rf_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in downselect["forbidden_claims"]:
            raise SystemExit(f"cellular space-saving downselect missing forbidden claim: {claim}")
    best = candidates[policy["primary_space_saving_branch"]]
    print(
        "cellular space-saving downselect ok: "
        f"{len(candidates)} candidates, primary={policy['primary_space_saving_branch']} "
        f"remaining_top_area={best['top_island_remaining_before_rf_keepouts_mm2']}mm2"
    )


def check_camera_module_fit_downselect() -> None:
    downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    camera = load_yaml(ROOT / "package/camera/oem-mipi-csi-modules.yaml")
    source_revalidation = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml"
    )
    integration = load_yaml(ROOT / "board/kicad/e1-phone/display-camera-oem-integration.yaml")
    connector = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )
    envelopes = load_yaml(ROOT / "board/kicad/e1-phone/component-envelope-fit-audit.yaml")
    repack = load_yaml(ROOT / "board/kicad/e1-phone/placement-repack-candidate.yaml")
    supplier_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    manifest = load_yaml(MANIFEST)

    if downselect["schema"] != "eliza.e1_phone_camera_module_fit_downselect.v1":
        raise SystemExit("camera module fit downselect schema diverges")
    if (
        downselect["status"]
        != "blocked_camera_module_xy_z_downselect_requires_supplier_drawings_and_samples"
    ):
        raise SystemExit(f"unexpected camera module fit downselect status: {downselect['status']}")
    rel = "board/kicad/e1-phone/camera-module-fit-downselect.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing camera module fit downselect")
    if rel not in envelopes["source_artifacts"]:
        raise SystemExit("component envelope audit must cite camera module fit downselect")
    if rel not in repack["source_artifacts"]:
        raise SystemExit("placement repack candidate must cite camera module fit downselect")
    for source in downselect["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "camera_package": camera["status"],
        "display_camera_source_revalidation": source_revalidation["status"],
        "display_camera_oem_integration": integration["status"],
        "display_camera_connector_pinout_execution": connector["status"],
        "component_envelope_fit_audit": envelopes["status"],
        "placement_repack_candidate": repack["status"],
        "supplier_rfq_response_normalization": supplier_responses["status"],
    }
    if downselect["upstream_status"] != expected_upstream:
        raise SystemExit("camera module fit downselect upstream status stale")

    region = downselect["fit_context"]["active_camera_region_mm"]
    repack_region = repack["candidate_regions_mm"]["J_CAM0_CAM1"]
    if {key: region[key] for key in ["x", "y", "width", "height"]} != repack_region:
        raise SystemExit("camera module fit downselect active region diverges from repack")
    area = round(region["width"] * region["height"], 2)
    if region["area_mm2"] != area:
        raise SystemExit("camera module fit downselect active region area stale")

    rear = downselect["candidate_fit"]["rear_primary_sincere_first_sf_xr3855a_a0"]
    rear_pkg = camera["rear_camera_primary"]["candidate_parts"][0]
    if rear["module"] != rear_pkg["module"]:
        raise SystemExit("camera module fit downselect rear module stale")
    for key in ["sensor", "pin_count", "focus"]:
        if rear["public_fields_available"][key] != rear_pkg[key]:
            raise SystemExit(f"camera module fit downselect rear public field stale: {key}")
    if rear["public_xy_envelope_mm"] != "unknown_supplier_drawing_required":
        raise SystemExit("camera module fit downselect rear XY must remain supplier-gated")

    front = downselect["candidate_fit"]["front_primary_sincere_first_sf_g5035s60fy"]
    front_pkg = camera["front_camera_primary"]["candidate_parts"][0]
    if front["module"] != front_pkg["module"]:
        raise SystemExit("camera module fit downselect front module stale")
    for key in ["sensor", "pin_count", "focus"]:
        if front["public_fields_available"][key] != front_pkg[key]:
            raise SystemExit(f"camera module fit downselect front public field stale: {key}")
    if front["public_xy_envelope_mm"] != "unknown_supplier_drawing_required":
        raise SystemExit("camera module fit downselect front XY must remain supplier-gated")

    junde = downselect["candidate_fit"]["front_alternate_alibaba_junde_imx219"]
    junde_pkg = camera["front_camera_primary"]["candidate_parts"][1]
    if junde["source_url"] != junde_pkg["sourcing_url"]:
        raise SystemExit("camera module fit downselect Junde source URL stale")
    if junde["public_envelope_mm"] != junde_pkg["module_size_mm"]:
        raise SystemExit("camera module fit downselect Junde envelope stale")
    envelope = junde["public_envelope_mm"]
    if junde["area_mm2"] != round(envelope["width"] * envelope["height"], 2):
        raise SystemExit("camera module fit downselect Junde area stale")
    if junde["active_region_area_mm2"] != area:
        raise SystemExit("camera module fit downselect active region area copy stale")
    fit = junde["fit"]
    width_shortfall = max(0.0, round(envelope["width"] - region["width"], 3))
    height_shortfall = max(0.0, round(envelope["height"] - region["height"], 3))
    rotated_width_shortfall = max(0.0, round(envelope["height"] - region["width"], 3))
    rotated_height_shortfall = max(0.0, round(envelope["width"] - region["height"], 3))
    expected_fit = {
        "fits_width": width_shortfall == 0.0,
        "fits_height": height_shortfall == 0.0,
        "width_shortfall_mm": width_shortfall,
        "height_shortfall_mm": height_shortfall,
        "fits_xy": width_shortfall == 0.0 and height_shortfall == 0.0,
        "fits_rotated": rotated_width_shortfall == 0.0 and rotated_height_shortfall == 0.0,
        "rotated_width_shortfall_mm": rotated_width_shortfall,
        "rotated_height_shortfall_mm": rotated_height_shortfall,
    }
    if fit != expected_fit:
        raise SystemExit("camera module fit downselect Junde fit stale")
    envelope_junde = envelopes["known_component_envelopes"]["front_camera_alternate_junde"]
    if envelope_junde["fit"]["width_shortfall_mm"] != width_shortfall:
        raise SystemExit("camera module fit downselect diverges from component envelope width")
    if envelope_junde["fit"]["height_shortfall_mm"] != height_shortfall:
        raise SystemExit("camera module fit downselect diverges from component envelope height")
    if repack["known_envelope_fit"]["front_camera_junde_alternate_fits_candidate_region"]:
        raise SystemExit("camera module fit downselect must keep Junde alternate rejected")

    policy = downselect["downselect_policy"]
    if (
        policy["selected_routing_branch"]
        != "sincere_first_phone_style_front_and_rear_modules_pending_supplier_xy_z_drawings"
    ):
        raise SystemExit("camera module fit downselect selected branch changed")
    if "front_alternate_alibaba_junde_imx219" not in policy["rejected_for_current_region"]:
        raise SystemExit("camera module fit downselect must reject Junde alternate")
    if len(policy["required_supplier_artifacts_before_camera_region_release"]) < 5:
        raise SystemExit("camera module fit downselect supplier artifact list too weak")
    if supplier_responses["normalization_outputs"]["present_response_pack_count"] != 0:
        raise SystemExit("camera module fit downselect must not claim supplier responses received")
    for key, value in downselect["layout_release_consequence"].items():
        if value is not True:
            raise SystemExit(f"camera module fit downselect consequence must require {key}")
    for key, value in downselect["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"camera module fit downselect cross-check failed: {key}")
    for blocker in [
        "primary front and rear camera module XY, z-height, FPC tail, connector, and lens-axis drawings are missing",
        "25 x 24 mm Alibaba/Junde IMX219 alternate exceeds the current 17 x 13 mm camera/FPC region in both orientations",
        "camera mating connector MPNs, land patterns, STEP models, driver notes, calibration flow, and samples are missing",
    ]:
        if blocker not in downselect["release_blockers"]:
            raise SystemExit(f"camera module fit downselect missing blocker: {blocker}")
    for claim in [
        "camera_module_selected",
        "camera_region_ready",
        "camera_footprints_ready",
        "camera_capture_ready",
        "enclosure_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in downselect["forbidden_claims"]:
            raise SystemExit(f"camera module fit downselect missing forbidden claim {claim}")
    print(
        "camera module fit downselect ok: "
        f"junde_fit={fit['fits_xy']} shortfall={width_shortfall}x{height_shortfall}mm"
    )


def check_radio_antenna_acceptance() -> None:
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml")
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
        if (
            item["status"]
            != "blocked_missing_supplier_route_firmware_regulatory_or_measurement_evidence"
        ):
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


def check_module_host_integration_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/module-host-integration-closure.yaml")
    manifest = load_yaml(MANIFEST)
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    bom = load_yaml(ROOT / "board/kicad/e1-phone/preliminary-bom.yaml")

    if closure["schema"] != "eliza.e1_phone_module_host_integration_closure.v1":
        raise SystemExit("module host integration closure schema diverges")
    if closure["status"] != "blocked_host_contracts_cross_checked_not_schematic_or_routed":
        raise SystemExit(f"unexpected module host integration closure status: {closure['status']}")
    rel = "board/kicad/e1-phone/module-host-integration-closure.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("module host integration closure missing from artifact manifest")

    for source in closure["source_artifacts"]:
        require_path(ROOT / source)

    expected_record_ids = {
        "display_touch_module",
        "rear_front_camera_modules",
        "cellular_5g_redcap_module",
        "wifi_bluetooth_module",
        "usb_c_charge_data_debug_port",
        "side_power_volume_buttons",
    }
    records = {record["id"]: record for record in closure["integration_records"]}
    if set(records) != expected_record_ids:
        raise SystemExit("module host integration closure record set diverges")

    bom_functions = {item["function"] for item in bom["major_items"]}
    placement_groups = {item["refdes_group"] for item in placement["placements"]}
    block_ids = {block["id"] for block in netlist["blocks"]}
    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))

    total_contracts = 0
    for record_id, record in records.items():
        contracts = record["required_contracts"]
        total_contracts += len(contracts)
        if record["host_contract_count"] != len(contracts):
            raise SystemExit(f"module host integration contract count stale: {record_id}")
        if not record.get("release_blocker"):
            raise SystemExit(f"module host integration missing release blocker: {record_id}")
        missing_bom = set(record["bom_functions"]) - bom_functions
        if missing_bom:
            raise SystemExit(
                f"module host integration missing BOM functions: {sorted(missing_bom)}"
            )
        missing_placements = set(record["placement_groups"]) - placement_groups
        if missing_placements:
            raise SystemExit(
                f"module host integration missing placement groups: {sorted(missing_placements)}"
            )
        missing_blocks = set(record["required_block_ids"]) - block_ids
        if missing_blocks:
            raise SystemExit(f"module host integration missing block IDs: {sorted(missing_blocks)}")
        for binding in record["package_bindings"]:
            require_path(ROOT / binding)
        missing_contracts = sorted(contract for contract in contracts if contract not in block_nets)
        if missing_contracts:
            raise SystemExit(
                f"module host integration contracts missing from block netlist "
                f"for {record_id}: {missing_contracts}"
            )

    if set(records["display_touch_module"]["required_contracts"]) < {
        "TOUCH_I2C_SCL",
        "TOUCH_I2C_SDA",
        "TOUCH_IRQ_N",
        "TOUCH_RESET_N",
    }:
        raise SystemExit("module host integration display touch contract is incomplete")
    if set(records["rear_front_camera_modules"]["required_contracts"]) < {
        "CAM0_I2C_SCL",
        "CAM0_I2C_SDA",
        "CAM1_I2C_SCL",
        "CAM1_I2C_SDA",
    }:
        raise SystemExit("module host integration camera I2C contracts are incomplete")
    if records["cellular_5g_redcap_module"]["package_bindings"] != [
        "package/cellular/quectel-5g-redcap.yaml"
    ]:
        raise SystemExit("module host integration cellular binding is no longer module-scoped")
    if records["wifi_bluetooth_module"]["package_bindings"] != [
        "package/wifi/murata-type-2ea-wifi6e.yaml"
    ]:
        raise SystemExit(
            "module host integration Wi-Fi/Bluetooth binding is no longer module-scoped"
        )

    for key, value in closure["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"module host integration closure cross-check failed: {key}")
    for output in closure["required_release_outputs"]:
        if not output.startswith("board/kicad/e1-phone/production/reports/"):
            raise SystemExit(
                f"module host integration release output path escapes reports: {output}"
            )
        if is_release_artifact_present(ROOT / output):
            raise SystemExit(
                f"module host integration release output unexpectedly exists: {output}"
            )
    for blocker in [
        "package host contracts are planning bindings, not supplier-approved pinouts",
        "KiCad schematic has not replaced scaffold symbols with supplier connectors and modules",
        "routed board, ERC, DRC, SI/PI, RF, and measured bring-up logs are missing",
        "firmware, driver, regulatory, and factory-test evidence are missing",
        "enclosure clearance still depends on routed board STEP with supplier component models",
    ]:
        if blocker not in closure["release_blockers"]:
            raise SystemExit(f"module host integration closure missing blocker: {blocker}")
    for claim in [
        "modules_wired_in_final",
        "display_touch_ready",
        "camera_ready",
        "cellular_ready",
        "wifi_ready",
        "bluetooth_ready",
        "usb_c_ready",
        "side_buttons_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"module host integration closure missing forbidden claim {claim}")
    print(
        "module host integration closure ok: "
        f"{len(records)} records, {total_contracts} host contracts fail-closed"
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
    radio_antenna = load_yaml(ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml")
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
    if (
        summary["cellular_host_interfaces"]
        != cellular["host_interfaces"]["cellular_module"]["required"]
    ):
        raise SystemExit("module host integration cellular host interfaces stale")
    if (
        summary["wifi_host_preferred_bus"]
        != wifi_bt["host_interfaces"]["wifi_primary"]["preferred_bus"]
    ):
        raise SystemExit("module host integration Wi-Fi preferred bus stale")
    if (
        summary["wifi_host_fallback_bus"]
        != wifi_bt["host_interfaces"]["wifi_primary"]["fallback_bus"]
    ):
        raise SystemExit("module host integration Wi-Fi fallback bus stale")
    if (
        summary["bluetooth_preferred_bus"]
        != wifi_bt["host_interfaces"]["bluetooth"]["preferred_bus"]
    ):
        raise SystemExit("module host integration Bluetooth bus stale")
    if sorted(summary["host_wireless_shared_nets"]) != sorted(
        set(summary["host_wireless_shared_nets"])
    ):
        raise SystemExit("module host integration host-wireless nets contain duplicates")
    missing_host_nets = sorted(
        net for net in summary["host_wireless_shared_nets"] if net not in block_nets
    )
    if missing_host_nets:
        raise SystemExit(f"module host integration host-wireless nets missing: {missing_host_nets}")
    for pair in summary["routing_pair_names_required"]:
        if pair not in pair_names:
            raise SystemExit(f"module host integration routing pair missing: {pair}")
    if set(summary["factory_probe_domains_covering_modules"]) - set(factory_domains):
        raise SystemExit("module host integration factory probe domains stale")
    if (
        summary["factory_traceability_fields"]
        != factory_probe["fixture_policy"]["operator_visible_traceability_required"]
    ):
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
        if (
            item["status"]
            != "blocked_missing_host_module_pinout_route_firmware_identity_or_factory_evidence"
        ):
            raise SystemExit(
                f"module host integration acceptance item unexpectedly open: {item_id}"
            )
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
    usb_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
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
    if (
        intake["status"]
        != "blocked_supplier_drawing_intake_required_before_real_footprints_or_route"
    ):
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
        if set(record["production_evidence_paths"]) != set(
            evidence["required_production_evidence"]
        ):
            raise SystemExit(
                f"supplier drawing intake record {function} production evidence keys diverge"
            )
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
        if function == "cellular":
            required_artifact = "smaller LTE Cat 1 bis alternate orderable MPN"
            if not any(
                required_artifact in item for item in record["supplier_artifacts_requested"]
            ):
                raise SystemExit(
                    "supplier drawing intake missing compact cellular alternate artifact"
                )
            if "compact_lte_alternate_package_datum" not in record["mechanical_datums_required"]:
                raise SystemExit(
                    "supplier drawing intake missing compact cellular mechanical datum"
                )
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


def check_supplier_sample_release_gate() -> None:
    gate = load_yaml(ROOT / "board/kicad/e1-phone/supplier-sample-release-gate.yaml")
    manifest = load_yaml(MANIFEST)
    component_models = load_yaml(
        ROOT / "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml"
    )
    rfq = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-intake.yaml")
    rfq_drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    supplier_map = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml")
    load_yaml(ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml")
    drawing_intake = load_yaml(ROOT / "board/kicad/e1-phone/supplier-drawing-intake-checklist.yaml")
    procurement = load_yaml(ROOT / "board/kicad/e1-phone/procurement-readiness.yaml")
    freeze = load_yaml(ROOT / "board/kicad/e1-phone/pinout-footprint-freeze.yaml")
    footprint_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    schematic_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-capture-readiness-binding.yaml"
    )
    routed_layout = load_yaml(ROOT / "board/kicad/e1-phone/routed-layout-readiness-binding.yaml")
    production_factory = load_yaml(
        ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml"
    )
    load_yaml(ROOT / "board/kicad/e1-phone/supplier-sample-release-gate.yaml")
    enclosure_fit = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")

    if gate["schema"] != "eliza.e1_phone_supplier_sample_release_gate.v1":
        raise SystemExit(f"unexpected supplier sample release gate schema: {gate['schema']}")
    if (
        gate["status"]
        != "blocked_supplier_samples_response_packs_and_reviews_required_before_layout_release"
    ):
        raise SystemExit(f"unexpected supplier sample release gate status: {gate['status']}")
    rel = "board/kicad/e1-phone/supplier-sample-release-gate.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing supplier sample release gate artifact")
    for source in gate["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "rfq_intake": rfq["status"],
        "rfq_transmittal_drafts": rfq_drafts["status"],
        "supplier_to_kicad_evidence_map": supplier_map["status"],
        "supplier_drawing_intake": drawing_intake["status"],
        "procurement_readiness": procurement["status"],
        "pinout_footprint_freeze": freeze["status"],
        "evt1_footprint_capture": footprint_capture["status"],
        "schematic_capture_readiness": schematic_capture["status"],
        "routed_layout_readiness": routed_layout["status"],
        "production_factory_release": production_factory["status"],
        "enclosure_fit_execution": enclosure_fit["status"],
    }
    if gate["upstream_status"] != expected_upstream:
        raise SystemExit("supplier sample release gate upstream status snapshot is stale")

    policy = gate["gate_policy"]
    if (
        policy["minimum_sample_lot_per_candidate"]
        != rfq["intake_policy"]["minimum_sample_lot_per_candidate"]
    ):
        raise SystemExit("supplier sample release gate sample lot diverges from RFQ intake")
    if not policy["sample_receipt_required_before_pinout_freeze"]:
        raise SystemExit("supplier sample release gate must require samples before pinout freeze")
    for key in [
        "supplier_response_pack_required_before_symbol_or_footprint_capture",
        "supplier_step_model_required_before_routed_board_step_export",
        "incoming_sample_inspection_required_before_release",
        "production_archive_required_before_factory_or_enclosure_release",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"supplier sample release gate policy unexpectedly open: {key}")

    drawing_required_keys = set(
        drawing_intake["intake_policy"]["all_core_paths_required_before_real_footprint"]
    )
    evidence_required_keys = {
        key
        for item in supplier_map["evidence_records"]
        for key in item["required_production_evidence"]
    }
    if set(policy["required_evidence_keys"]) != evidence_required_keys:
        raise SystemExit("supplier sample release gate evidence keys diverge from supplier map")
    if not drawing_required_keys < evidence_required_keys:
        raise SystemExit("supplier sample release gate lost drawing-intake core keys")

    records = {item["function"]: item for item in gate["handoff_records"]}
    evidence_records = {item["function"]: item for item in supplier_map["evidence_records"]}
    drawing_records = {item["function"]: item for item in drawing_intake["intake_records"]}
    supplier_lane_surrogate_paths = {
        item["file"]
        for item in component_models.get("supplier_lane_surrogate_steps", {}).values()
        if item.get("status") == "present_local_surrogate_step_not_supplier_approved"
        and item.get("release_credit") is False
    }
    if set(records) != set(evidence_records) or set(records) != set(drawing_records):
        raise SystemExit(
            "supplier sample release gate functions diverge from supplier evidence maps"
        )
    if len(records) != 10:
        raise SystemExit(f"supplier sample release gate expected 10 records, got {len(records)}")

    release_present_paths: list[str] = []
    blocked_or_local_candidate_paths: list[str] = []
    local_surrogate_step_paths: list[str] = []
    missing_paths: list[str] = []
    for function, record in records.items():
        evidence = evidence_records[function]
        drawing = drawing_records[function]
        if record["status"] != "blocked_waiting_supplier_response_pack_sample_and_reviews":
            raise SystemExit(f"supplier sample release record unexpectedly open: {function}")
        for key in ["primary_candidate", "freeze_record", "draft_path"]:
            expected = (
                evidence["rfq_transmittal_draft"]["planned_draft_path"]
                if key == "draft_path"
                else evidence[key]
            )
            if record[key] != expected:
                raise SystemExit(f"supplier sample release record {function} {key} diverges")
        if record["draft_path"] != drawing["draft_path"]:
            raise SystemExit(f"supplier sample release record {function} draft path stale")
        if set(evidence["required_production_evidence"]) != evidence_required_keys:
            raise SystemExit(f"supplier sample release evidence key set stale: {function}")
        if set(drawing["gate_state"]) != drawing_required_keys:
            raise SystemExit(f"supplier sample release drawing gate key set stale: {function}")
        if any(drawing["gate_state"].values()):
            raise SystemExit(f"supplier sample release drawing gate unexpectedly open: {function}")
        if record["required_evidence_key_count"] != len(evidence_required_keys):
            raise SystemExit(f"supplier sample release record {function} key count stale")
        if record["present_evidence_key_count"] != 0:
            raise SystemExit(f"supplier sample release record {function} has release evidence")
        if record["missing_evidence_key_count"] != len(evidence_required_keys):
            raise SystemExit(f"supplier sample release record {function} missing count stale")
        if record["sample_required_before_layout"] is not True:
            raise SystemExit(
                f"supplier sample release record {function} allows layout without sample"
            )
        if not record["blocks_layout_domains"]:
            raise SystemExit(f"supplier sample release record {function} missing layout blockers")

        for evidence_path in evidence["required_production_evidence"].values():
            path = ROOT / evidence_path
            if evidence_path in supplier_lane_surrogate_paths:
                local_surrogate_step_paths.append(evidence_path)
                blocked_or_local_candidate_paths.append(evidence_path)
            elif is_release_artifact_present(path):
                release_present_paths.append(evidence_path)
            elif path.exists():
                blocked_or_local_candidate_paths.append(evidence_path)
            else:
                missing_paths.append(evidence_path)

    inventory = gate["evidence_inventory"]
    expected_total = len(records) * len(evidence_required_keys)
    if inventory["function_count"] != len(records):
        raise SystemExit("supplier sample release inventory function count stale")
    if inventory["evidence_keys_per_function"] != len(evidence_required_keys):
        raise SystemExit("supplier sample release inventory per-function count stale")
    if inventory["required_evidence_path_count"] != expected_total:
        raise SystemExit("supplier sample release inventory required path count stale")
    if inventory["present_evidence_path_count"] != len(release_present_paths):
        raise SystemExit("supplier sample release inventory present path count stale")
    if inventory.get("blocked_or_local_candidate_evidence_path_count") != len(
        blocked_or_local_candidate_paths
    ):
        raise SystemExit("supplier sample release inventory blocked path count stale")
    if inventory.get("local_surrogate_step_path_count") != len(local_surrogate_step_paths):
        raise SystemExit("supplier sample release inventory local surrogate step count stale")
    release_missing_evidence_path_count = len(missing_paths) + len(blocked_or_local_candidate_paths)
    if inventory["missing_evidence_path_count"] != release_missing_evidence_path_count:
        raise SystemExit("supplier sample release inventory missing path count stale")
    if release_present_paths:
        raise SystemExit(
            "supplier sample release approved production evidence unexpectedly exists: "
            f"{release_present_paths}"
        )
    if inventory["every_required_production_path_absent"] is not False:
        raise SystemExit("supplier sample release absent-path flag stale")
    if inventory.get("every_required_production_path_absent_or_blocked") is not True:
        raise SystemExit("supplier sample release gate must remain fail-closed")

    for key, value in gate["release_coupling"].items():
        if value is not True:
            raise SystemExit(f"supplier sample release coupling unexpectedly open: {key}")
    for name, value in gate["cross_checks"].items():
        expected_value = name != "every_required_evidence_path_is_absent"
        if value is not expected_value:
            raise SystemExit(f"supplier sample release cross-check failed: {name}")
    for blocker in [
        "RFQ transmittals are drafts and have not been sent or archived as production evidence",
        "supplier response packs, signed drawings, exact pinouts, land patterns, supplier-approved STEP models, and samples are missing",
        "incoming sample inspection and compliance packs are missing",
        "pinout, symbol, footprint, and 3D binding reviews are missing",
        "routed layout, factory release, and enclosure clearance cannot close without supplier evidence",
    ]:
        if blocker not in gate["release_blockers"]:
            raise SystemExit(f"supplier sample release gate missing blocker: {blocker}")
    for claim in [
        "supplier_samples_received",
        "supplier_response_pack_complete",
        "supplier_drawings_approved",
        "supplier_pinouts_ready",
        "supplier_footprints_ready",
        "supplier_step_models_bound",
        "kicad_capture_ready",
        "layout_ready",
        "factory_release_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in gate["forbidden_claims"]:
            raise SystemExit(f"supplier sample release gate missing forbidden claim {claim}")
    print(
        "supplier sample release gate ok: "
        f"{len(records)} functions, {len(missing_paths)} production evidence paths absent, "
        f"{len(blocked_or_local_candidate_paths)} blocked/local candidates"
    )


def check_footprint_3d_model_library_map() -> None:
    library_map = load_yaml(ROOT / "board/kicad/e1-phone/footprint-3d-model-library-map.yaml")
    manifest = load_yaml(MANIFEST)
    symbol_footprint = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    )
    footprint_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    height_step = load_yaml(ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    pad_pin_audit = load_yaml(
        ROOT / "board/kicad/e1-phone/development-pad-pin-coverage-audit-2026-05-22.yaml"
    )
    component_model_manifest = load_yaml(
        ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
    )

    if library_map["schema"] != "eliza.e1_phone_footprint_3d_model_library_map.v1":
        raise SystemExit(f"unexpected footprint/3D map schema: {library_map['schema']}")
    if library_map["status"] != "library_match_preparation_with_local_routed_candidate_not_release":
        raise SystemExit(f"unexpected footprint/3D map status: {library_map['status']}")
    rel = "board/kicad/e1-phone/footprint-3d-model-library-map.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing footprint/3D model library map")
    for artifact in [symbol_footprint, footprint_capture, height_step]:
        if rel not in artifact["source_artifacts"]:
            raise SystemExit(
                "footprint/3D model library map is not cited by downstream closure artifact"
            )

    provenance = library_map["toolchain_provenance"]
    if provenance["active_binary_ships_3d_models"] is not False:
        raise SystemExit("footprint/3D map must record active KiCad binary lacks bundled 3D models")
    library_roots_present = all(
        (ROOT / provenance[key]).exists()
        for key in ["footprint_library_root", "model_library_root"]
    )
    if provenance["footprint_library_count_pretty"] < 100:
        raise SystemExit("footprint/3D map footprint library count unexpectedly weak")
    if provenance["model_library_count_3dshapes"] < 50:
        raise SystemExit("footprint/3D map model library count unexpectedly weak")

    components = library_map["components"]
    by_function = {item["function"]: item for item in components}
    required_functions = {
        "usb_c_receptacle",
        "tactile_switches_side_buttons",
        "mems_microphones",
        "display_lcd_ctp_fpc_connector",
        "smt_passives_R_C_0402_0201",
        "rear_flash_torch_led",
        "wifi_bluetooth_module",
        "cellular_modem",
        "soc",
        "pmic",
    }
    if not required_functions <= set(by_function):
        raise SystemExit(
            f"footprint/3D map missing required functions: {sorted(required_functions - set(by_function))}"
        )

    status_counts: dict[str, int] = {}
    for item in components:
        status = item["status"]
        status_counts[status] = status_counts.get(status, 0) + 1
        if status == "matched":
            for key in ["footprint_path", "model_path", "step_path"]:
                value = item[key]
                paths = value if isinstance(value, list) else [value]
                for rel_path in paths:
                    if library_roots_present and not (ROOT / rel_path).exists():
                        raise SystemExit(
                            f"footprint/3D map matched artifact missing for {item['function']}: {rel_path}"
                        )
        elif status == "matched_footprint_only":
            footprint_path = item["footprint_path"]
            if library_roots_present and not (ROOT / footprint_path).exists():
                raise SystemExit(
                    f"footprint/3D map footprint-only artifact missing for {item['function']}: {footprint_path}"
                )
            for key in ["model_path", "step_path"]:
                if item[key] != "footprint_ref_present_model_file_missing":
                    raise SystemExit(
                        f"footprint/3D map footprint-only model state changed for {item['function']}"
                    )
        elif status != "needs_custom_or_supplier_step":
            raise SystemExit(f"footprint/3D map unknown component status: {status}")

    summary = library_map["summary"]
    if status_counts.get("matched", 0) != summary["matched_footprint_and_3d_model"]:
        raise SystemExit("footprint/3D map matched summary count stale")
    if (
        status_counts.get("matched_footprint_only", 0)
        != summary["matched_footprint_only_model_missing"]
    ):
        raise SystemExit("footprint/3D map footprint-only summary count stale")
    if summary["total_bom_lines_considered"] < len(components):
        raise SystemExit("footprint/3D map total BOM line count stale")
    expected_routed_board = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
    routed_board_text = expected_routed_board.read_text(encoding="utf-8")
    if summary.get("concept_board_placeholder_footprint_count") != 87:
        raise SystemExit("footprint/3D map concept placeholder count stale")
    concept_board = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
    concept_board_text = concept_board.read_text(encoding="utf-8")
    if summary.get("concept_board_placeholder_marker_count") != (
        concept_board_text.count("E1_PHONE_PLACEHOLDER")
    ):
        raise SystemExit("footprint/3D map concept placeholder marker count stale")
    if summary.get("routed_local_development_footprint_count") != 89:
        raise SystemExit("footprint/3D map routed development footprint count stale")
    if summary.get("routed_local_development_placeholder_marker_count") != (
        routed_board_text.count("E1_PHONE_PLACEHOLDER")
    ):
        raise SystemExit("footprint/3D map routed placeholder marker count stale")
    if summary.get("routed_local_development_non_release_pattern_count") != (
        routed_board_text.count("NON_RELEASE_DEVELOPMENT_PATTERN")
    ):
        raise SystemExit("footprint/3D map routed development pattern count stale")
    models = component_model_manifest.get("models", [])
    if not isinstance(models, list):
        raise SystemExit("footprint/3D map component-model source missing models")
    visual_class_counts: dict[str, int] = {}
    for model in models:
        visual_class = str(model.get("visual_package_class") or "")
        visual_class_counts[visual_class] = visual_class_counts.get(visual_class, 0) + 1
    local_coverage = summary.get("local_development_pattern_coverage")
    if not isinstance(local_coverage, dict):
        raise SystemExit("footprint/3D map missing local development pattern coverage")
    expected_local_coverage = {
        "footprint_type_count_from_pad_audit": len(pad_pin_audit.get("records", [])),
        "footprint_type_pinout_bound_count_from_pad_audit": int(
            pad_pin_audit.get("pinout_bound_footprint_count") or 0
        ),
        "all_pinout_bound_footprint_types_have_terminal_contract": bool(
            pad_pin_audit.get("all_pinout_bound_footprints_have_terminal_contract")
        ),
        "explicit_support_pattern_type_count_from_pad_audit": int(
            pad_pin_audit.get("explicit_support_pattern_count") or 0
        ),
        "all_support_pattern_types_have_explicit_provenance": bool(
            pad_pin_audit.get("all_support_patterns_have_explicit_provenance")
        ),
        "component_model_instance_count": len(models),
        "component_model_pinout_bound_instance_count": sum(
            1 for model in models if model.get("pinout_file")
        ),
        "component_model_support_instance_count": sum(
            1 for model in models if not model.get("pinout_file")
        ),
        "component_model_visual_package_class_counts": visual_class_counts,
        "all_component_models_have_local_discrete_step_file": all(
            bool(model.get("local_discrete_step_file")) for model in models
        ),
        "all_component_models_import_as_solid": all(
            model.get("local_discrete_step_imported_as_solid") is True for model in models
        ),
        "all_component_model_bboxes_match_envelope": all(
            model.get("local_discrete_step_bbox_matches_envelope") is True for model in models
        ),
        "supplier_approved_component_model_count": sum(
            1 for model in models if model.get("supplier_approved") is True
        ),
        "release_credit_component_model_count": sum(
            1 for model in models if model.get("release_credit") is True
        ),
        "blocked_pending_supplier_step_or_verified_package_drawing_count": sum(
            1
            for model in models
            if model.get("model_binding_status")
            == "blocked_pending_supplier_step_or_verified_package_drawing"
        ),
    }
    for key, expected in expected_local_coverage.items():
        if local_coverage.get(key) != expected:
            raise SystemExit(f"footprint/3D map local development coverage stale: {key}")
    if local_coverage["component_model_instance_count"] != summary[
        "routed_local_development_footprint_count"
    ]:
        raise SystemExit("footprint/3D map component instance count diverges from routed board")
    if local_coverage["release_credit_component_model_count"] != 0:
        raise SystemExit("footprint/3D map must keep local component models non-release")
    if local_coverage["supplier_approved_component_model_count"] != 0:
        raise SystemExit("footprint/3D map must not claim supplier-approved component models")
    if "needs_custom_or_supplier_step" not in status_counts:
        raise SystemExit("footprint/3D map must preserve supplier-defined component class")

    if by_function["usb_c_receptacle"]["status"] != "matched":
        raise SystemExit("footprint/3D map USB-C exact match lost")
    if by_function["display_lcd_ctp_fpc_connector"]["status"] != "matched":
        raise SystemExit("footprint/3D map display FPC connector candidate match lost")
    if by_function["tactile_switches_side_buttons"]["status"] != "matched_footprint_only":
        raise SystemExit("footprint/3D map side-button footprint-only state lost")
    if by_function["mems_microphones"]["status"] != "matched_footprint_only":
        raise SystemExit("footprint/3D map MEMS microphone footprint-only state lost")
    for function in ["wifi_bluetooth_module", "cellular_modem", "soc", "pmic"]:
        if by_function[function]["status"] != "needs_custom_or_supplier_step":
            raise SystemExit(f"footprint/3D map must keep {function} supplier-defined")

    state = symbol_footprint["current_kicad_state"]
    if state["supplier_3d_model_binding_present"] is not False:
        raise SystemExit("footprint/3D map cannot imply supplier 3D binding is present")
    if state["footprint_library_release_present"] is not False:
        raise SystemExit("footprint/3D map cannot imply release footprint library is present")
    if pcb_audit["live_pcb_counts"]["segment_count"] != 0:
        raise SystemExit("footprint/3D map cannot coexist with routed live PCB claims")
    if pcb_audit["live_pcb_counts"]["footprint_count"] != 87:
        raise SystemExit("footprint/3D map placeholder footprint count stale")

    for name, value in library_map["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"footprint/3D map cross-check failed: {name}")
    for blocker in [
        "local catalog matches do not replace supplier pinouts, signed drawings, land patterns, or sample inspection",
        "side-button and MEMS microphone 3D bodies are missing from the local KiCad model subset",
        "SoC, memory, PMIC, cellular, Wi-Fi/Bluetooth, battery, cameras, audio, and interconnect footprints remain supplier-defined",
        "no local library match has been assigned to the production schematic or PCB",
        "routed board STEP with supplier component models is missing",
    ]:
        if blocker not in library_map["release_blockers"]:
            raise SystemExit(f"footprint/3D map missing blocker: {blocker}")
    for claim in [
        "footprint_library_ready",
        "supplier_footprints_ready",
        "supplier_3d_models_ready",
        "symbols_ready",
        "erc_clean",
        "drc_clean",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in library_map["forbidden_claims"]:
            raise SystemExit(f"footprint/3D map missing forbidden claim {claim}")
    print(
        "footprint/3D model library map ok: "
        f"{status_counts.get('matched', 0)} matched, "
        f"{status_counts.get('matched_footprint_only', 0)} footprint-only, "
        f"{status_counts.get('needs_custom_or_supplier_step', 0)} supplier-defined"
    )


def check_schematic_symbol_footprint_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml")
    manifest = load_yaml(MANIFEST)
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")

    if closure["schema"] != "eliza.e1_phone_schematic_symbol_footprint_closure.v1":
        raise SystemExit(f"unexpected schematic symbol/footprint schema: {closure['schema']}")
    if closure["status"] != "blocked_requires_real_kicad_symbols_supplier_footprints_and_erc":
        raise SystemExit(f"unexpected schematic symbol/footprint status: {closure['status']}")
    rel = "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing schematic-symbol-footprint closure artifact")
    for source in closure["source_artifacts"]:
        require_path(ROOT / source)

    schematic_dir = ROOT / "board/kicad/e1-phone/schematic"
    schematic_paths = sorted(schematic_dir.glob("*.kicad_sch"))
    schematic_text = "\n".join(path.read_text() for path in schematic_paths)
    pcb_text = (ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb").read_text()
    state = closure["current_kicad_state"]
    live_counts = pcb_audit["live_pcb_counts"]
    observed = {
        "schematic_sheet_count": len(schematic_paths),
        "schematic_symbol_count": len(re.findall(r"\(symbol \(lib_id ", schematic_text)),
        "schematic_text_item_count": len(re.findall(r'\(text "', schematic_text)),
        "pcb_declared_net_count": len(re.findall(r"\n  \(net \d+ ", pcb_text)),
        "pcb_placeholder_footprint_count": len(re.findall(r'\(footprint "E1Phone:', pcb_text)),
        "pcb_track_or_zone_count": (
            live_counts["segment_count"]
            + live_counts["zone_count"]
            + live_counts["keepout_zone_count"]
        ),
    }
    for key, value in observed.items():
        if state[key] != value:
            raise SystemExit(
                f"schematic symbol/footprint closure count stale for {key}: {state[key]} != {value}"
            )
    if state["pcb_placeholder_footprint_count"] != live_counts["footprint_count"]:
        raise SystemExit("schematic symbol/footprint closure footprint count diverges")
    if state["schematic_symbol_count"] <= 0 and state["schematic_text_item_count"] <= 0:
        raise SystemExit("schematic symbol/footprint closure lost scaffold content")
    for key in [
        "erc_report_present",
        "footprint_library_release_present",
        "symbol_library_release_present",
        "supplier_3d_model_binding_present",
    ]:
        if state[key] is not False:
            raise SystemExit(f"schematic symbol/footprint closure must keep {key} false")
    if state["schematic_evidence_class"] != "non_release_symbol_scaffold_not_erc_checked":
        raise SystemExit("schematic symbol/footprint closure evidence class is stale")
    if state["pcb_evidence_class"] != "non_release_placeholder_footprint_floorplan":
        raise SystemExit("schematic symbol/footprint closure PCB evidence class is stale")

    closures = closure["major_symbol_footprint_closures"]
    required_domains = {
        "usb_c_charge_data_debug",
        "display_touch",
        "front_rear_cameras",
        "radios_cellular_wifi_bt_gnss",
        "power_battery_pmic_thermal",
        "side_buttons_audio_haptics_split_interconnect",
    }
    if {item["domain"] for item in closures} != required_domains:
        raise SystemExit("schematic symbol/footprint closure domain set diverges")
    for item in closures:
        for key in ["required_supplier_inputs", "required_kicad_outputs"]:
            if not item[key]:
                raise SystemExit(
                    f"schematic symbol/footprint closure {item['domain']} missing {key}"
                )
        if not item["current_status"].startswith("blocked_"):
            raise SystemExit(
                f"schematic symbol/footprint closure domain unexpectedly open: {item['domain']}"
            )
    for name, value in closure["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"schematic symbol/footprint cross-check failed: {name}")
    for claim in [
        "schematic_ready",
        "symbols_ready",
        "footprints_ready",
        "erc_clean",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"schematic symbol/footprint closure missing claim {claim}")
    print(
        "schematic symbol/footprint closure ok: "
        f"{state['schematic_symbol_count']} schematic symbols, "
        f"{state['schematic_text_item_count']} text scaffold items, "
        f"{state['pcb_placeholder_footprint_count']} placeholder footprints blocked"
    )


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
    if (
        work["status"]
        != "blocked_evt1_footprint_capture_requires_supplier_intake_reviews_and_real_kicad_libraries"
    ):
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
        if (
            function == "cellular"
            and "compact_lte_alternate_package_datum" not in item["mechanical_datums_required"]
        ):
            raise SystemExit("EVT1 footprint capture missing compact cellular mechanical datum")
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
    execution = load_yaml(ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml")
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
    if (
        execution["status"]
        != "blocked_requires_supplier_symbols_netclass_capture_erc_and_trial_route"
    ):
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
                    raise SystemExit(
                        f"schematic netclass placement diverges: {domain} {refdes} {key}"
                    )
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
                raise SystemExit(
                    f"schematic netclass output path not under production reports: {path}"
                )
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


def check_schematic_capture_readiness_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/schematic-capture-readiness-binding.yaml")
    manifest = load_yaml(MANIFEST)
    symbol_footprint = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-symbol-footprint-closure.yaml"
    )
    netclass = load_yaml(ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml")
    footprint_work = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    subsystem_paths = {
        "display_camera": "board/kicad/e1-phone/display-camera-schematic-net-binding.yaml",
        "usb_sidekey": "board/kicad/e1-phone/usb-sidekey-schematic-net-binding.yaml",
        "radio_module": "board/kicad/e1-phone/radio-module-schematic-net-binding.yaml",
        "core_power_compute": "board/kicad/e1-phone/core-power-compute-schematic-net-binding.yaml",
        "audio_haptic": "board/kicad/e1-phone/audio-haptic-schematic-net-binding.yaml",
        "split_interconnect": "board/kicad/e1-phone/split-interconnect-schematic-net-binding.yaml",
    }
    subsystem_bindings = {key: load_yaml(ROOT / rel) for key, rel in subsystem_paths.items()}
    erc_closure_path = ROOT / "board/kicad/e1-phone/erc/erc-closure.md"
    erc_report_path = ROOT / "board/kicad/e1-phone/erc/erc-report.json"
    erc_closure_text = erc_closure_path.read_text()
    erc_report = json.loads(erc_report_path.read_text())

    if binding["schema"] != "eliza.e1_phone_schematic_capture_readiness_binding.v1":
        raise SystemExit(f"unexpected schematic capture readiness schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_schematic_capture_requires_real_symbols_supplier_pinouts_footprints_erc_and_trial_route"
    ):
        raise SystemExit(f"unexpected schematic capture readiness status: {binding['status']}")
    rel = "board/kicad/e1-phone/schematic-capture-readiness-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing schematic capture readiness binding")
    if rel not in netclass["source_artifacts"]:
        raise SystemExit(
            "schematic netclass execution must cite schematic capture readiness binding"
        )
    for source in binding["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "schematic_symbol_footprint_status": symbol_footprint["status"],
        "schematic_netclass_execution_status": netclass["status"],
        "evt1_footprint_capture_status": footprint_work["status"],
        "display_camera_binding_status": subsystem_bindings["display_camera"]["status"],
        "usb_sidekey_binding_status": subsystem_bindings["usb_sidekey"]["status"],
        "radio_module_binding_status": subsystem_bindings["radio_module"]["status"],
        "core_power_compute_binding_status": subsystem_bindings["core_power_compute"]["status"],
        "audio_haptic_binding_status": subsystem_bindings["audio_haptic"]["status"],
        "split_interconnect_binding_status": subsystem_bindings["split_interconnect"]["status"],
    }
    if binding["upstream_status"] != expected_upstream:
        raise SystemExit("schematic capture readiness upstream status snapshot is stale")

    inventory = {item["id"]: item for item in binding["binding_inventory"]}
    if set(inventory) != set(subsystem_paths):
        raise SystemExit("schematic capture readiness binding inventory diverges")
    domain_set = {item["domain"] for item in netclass["domain_execution"]}
    covered_domains = set()
    for key, item in inventory.items():
        expected_artifact = subsystem_paths[key]
        if item["artifact"] != expected_artifact:
            raise SystemExit(f"schematic capture readiness artifact stale: {key}")
        if item["artifact"] not in binding["source_artifacts"]:
            raise SystemExit(f"schematic capture readiness source list missing {key}")
        if not subsystem_bindings[key]["status"].startswith("blocked_"):
            raise SystemExit(f"schematic capture readiness subsystem unexpectedly open: {key}")
        if not item["current_gate"]:
            raise SystemExit(f"schematic capture readiness weak current gate: {key}")
        covered_domains.update(item["domains_covered"])
    if not covered_domains.issubset(domain_set):
        raise SystemExit(
            f"schematic capture readiness references unknown domains: {sorted(covered_domains - domain_set)}"
        )
    if not domain_set.issubset(covered_domains | {"factory_test"}):
        raise SystemExit(
            f"schematic capture readiness missed schematic domains: {sorted(domain_set - covered_domains)}"
        )

    policy = binding["production_capture_policy"]
    if policy["domain_count"] != len(domain_set):
        raise SystemExit("schematic capture readiness domain count stale")
    if policy["subsystem_binding_count"] != len(inventory):
        raise SystemExit("schematic capture readiness subsystem count stale")
    for key in [
        "requires_all_subsystem_bindings_before_symbol_capture",
        "requires_supplier_pinout_before_pin_number_assignment",
        "requires_symbol_electrical_type_review_before_erc",
        "requires_footprint_3d_binding_before_trial_route",
        "requires_production_erc_not_demo_erc_before_release",
        "requires_trial_route_before_routed_pcb_release",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"schematic capture readiness policy must require {key}")

    erc_state = binding["erc_state"]
    if erc_state["demo_erc_artifact"] != "board/kicad/e1-phone/erc/erc-closure.md":
        raise SystemExit("schematic capture readiness demo ERC artifact stale")
    if erc_state["demo_erc_evidence_class"] != "non_release_demo_erc":
        raise SystemExit("schematic capture readiness demo ERC class stale")
    if "non_release_demo_erc" not in erc_closure_text:
        raise SystemExit("schematic capture readiness demo ERC closure missing evidence class")
    if "does **not** satisfy production ERC" not in erc_closure_text:
        raise SystemExit("schematic capture readiness demo ERC closure must reject release use")
    violations = [
        violation for sheet in erc_report["sheets"] for violation in sheet.get("violations", [])
    ]
    if erc_state["demo_erc_zero_violations"] is not True or violations:
        raise SystemExit("schematic capture readiness demo ERC violation state stale")
    release_erc = ROOT / erc_state["production_erc_artifact"]
    if erc_state["production_erc_present"] is not False or release_erc.exists():
        raise SystemExit("schematic capture readiness production ERC state stale")
    if (
        erc_state["production_erc_required_before_release"] is not True
        or erc_state["demo_erc_may_not_satisfy_release_gate"] is not True
    ):
        raise SystemExit("schematic capture readiness must require production ERC")
    if symbol_footprint["current_kicad_state"]["erc_report_present"] is not False:
        raise SystemExit("schematic capture readiness symbol closure ERC state unexpectedly open")

    outputs = binding["release_required_outputs"]
    expected_schematic_outputs = {
        f"board/kicad/e1-phone/production/reports/schematic-review/{domain}.yaml"
        for domain in domain_set
    }
    if not expected_schematic_outputs.issubset(set(outputs)):
        raise SystemExit("schematic capture readiness missing per-domain schematic outputs")
    for path in [
        "board/kicad/e1-phone/production/reports/erc/production-root.json",
        "board/kicad/e1-phone/production/reports/pinout-review-signoff.yaml",
        "board/kicad/e1-phone/production/reports/footprint-3d-model-binding.yaml",
    ]:
        if path not in outputs:
            raise SystemExit(f"schematic capture readiness missing release output {path}")

    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"schematic capture readiness cross-check failed: {key}")
    for blocker in [
        "real KiCad symbols and wires have not replaced the schematic text scaffold",
        "ERC reports and signed waivers are missing for production schematic symbols",
        "demo ERC is non-release evidence only and cannot satisfy the production ERC gate",
        "routed copper, DRC, SI/PI/RF, factory, and enclosure clearance evidence are missing",
    ]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"schematic capture readiness missing blocker: {blocker}")
    for claim in [
        "schematic_ready",
        "schematic_capture_complete",
        "symbols_ready",
        "footprints_ready",
        "erc_clean",
        "netclasses_ready",
        "trial_route_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"schematic capture readiness missing forbidden claim {claim}")
    print(
        "schematic capture readiness binding ok: "
        f"{len(inventory)} subsystem bindings, {len(domain_set)} domains fail-closed"
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
    rf_required = {item["net"]: item for item in routing["rf_layout"]["matching_networks_required"]}
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
    if summary["total_corridor_count"] != len(diff_corridors) + len(rf_corridors) + len(
        power_corridors
    ):
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

    placement_records = {
        item["refdes_group"]: item["region_mm"] for item in placement["placements"]
    }
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
        if violation["over_by_mm"] != round(
            corridor["concept_manhattan_length_mm"] - corridor["max_length_mm"], 3
        ):
            raise SystemExit(f"route corridor length violation overage stale: {violation['id']}")
        if "change topology" not in violation["required_decision"]:
            raise SystemExit(
                f"route corridor violation missing topology decision: {violation['id']}"
            )
    if [item["constraint_pair"] for item in recorded_violations] != ["USB_DP_DN"]:
        raise SystemExit(
            "route corridor must keep USB_DP_DN as the explicit concept length violation"
        )

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
    if (
        summary["differential_pair_corridor_count"]
        != route_summary["differential_pair_count_required"]
    ):
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


def check_trial_route_input_matrix() -> None:
    matrix = load_yaml(ROOT / "board/kicad/e1-phone/trial-route-input-matrix.yaml")
    manifest = load_yaml(MANIFEST)
    response = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml")
    sample_gate = load_yaml(ROOT / "board/kicad/e1-phone/supplier-sample-release-gate.yaml")
    footprint_map = load_yaml(ROOT / "board/kicad/e1-phone/footprint-3d-model-library-map.yaml")
    repack = load_yaml(ROOT / "board/kicad/e1-phone/placement-repack-candidate.yaml")
    feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    stackup = load_yaml(ROOT / "board/kicad/e1-phone/evt1-stackup-impedance-coupon-plan.yaml")
    schematic_netclass = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-netclass-execution-package.yaml"
    )
    routed = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    enclosure = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")

    if matrix["schema"] != "eliza.e1_phone_trial_route_input_matrix.v1":
        raise SystemExit(f"unexpected trial route input matrix schema: {matrix['schema']}")
    if (
        matrix["status"]
        != "blocked_trial_route_inputs_missing_supplier_packs_footprints_stackup_and_escape_reviews"
    ):
        raise SystemExit(f"unexpected trial route input matrix status: {matrix['status']}")
    rel = "board/kicad/e1-phone/trial-route-input-matrix.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing trial route input matrix")
    for source in matrix["source_artifacts"]:
        require_path(ROOT / source)
    for downstream in [feasibility, routed]:
        if rel not in downstream["source_artifacts"]:
            raise SystemExit(
                "trial route input matrix missing from downstream route source artifacts"
            )

    expected_upstream = {
        "supplier_response_normalization": response["status"],
        "supplier_sample_release_gate": sample_gate["status"],
        "footprint_3d_model_library_map": footprint_map["status"],
        "placement_repack_candidate": repack["status"],
        "route_feasibility_density": feasibility["status"],
        "stackup_coupon_plan": stackup["status"],
        "schematic_netclass_execution": schematic_netclass["status"],
        "routed_pcb_implementation": routed["status"],
        "enclosure_fit_execution": enclosure["status"],
        "pcb_implementation_audit": pcb_audit["status"],
    }
    if matrix["upstream_status"] != expected_upstream:
        raise SystemExit("trial route input matrix upstream status snapshot is stale")

    geometry = matrix["locked_geometry"]
    pressure = feasibility["geometry_pressure"]
    if geometry["board_bbox_mm"] != pressure["board_bbox_mm"]:
        raise SystemExit("trial route matrix board geometry diverges from feasibility")
    if geometry["battery_window_mm"] != pressure["battery_window_mm"]:
        raise SystemExit("trial route matrix battery window diverges from feasibility")
    if geometry["physical_pcb_island_area_mm2"] != pressure["physical_pcb_island_area_mm2"]:
        raise SystemExit("trial route matrix physical island area diverges")
    if (
        geometry["split_interconnect_min_contacts"]
        != feasibility["interface_complexity_counts"]["split_interconnect_min_contacts"]
    ):
        raise SystemExit("trial route matrix split interconnect budget diverges")

    state = matrix["current_kicad_route_state"]
    counts = pcb_audit["live_pcb_counts"]
    if state["footprint_count"] != counts["footprint_count"]:
        raise SystemExit("trial route matrix footprint count stale")
    if state["segment_count"] != counts["segment_count"]:
        raise SystemExit("trial route matrix segment count stale")
    if state["zone_count"] != counts["zone_count"]:
        raise SystemExit("trial route matrix zone count stale")
    if state["has_routed_copper"] is not False or state["has_routed_step"] is not False:
        raise SystemExit("trial route matrix must not imply routed copper or routed STEP")

    response_records = {item["function"]: item for item in response["response_records"]}
    gate_records = {item["function"]: item for item in sample_gate["handoff_records"]}
    response_packs = {item["planned_response_pack"] for item in response_records.values()}
    placement_regions = set(repack["candidate_regions_mm"])
    known_route_classes = set(routing["impedance_classes"])
    known_route_classes.update(item["class"] for item in routing["differential_pairs"])
    known_route_classes.update(
        {
            "i2c_control",
            "display_bias_power",
            "camera_power",
            "cc_sbu_control",
            "side_key_gpio",
            "high_current_power",
            "sdio",
            "uart_control",
            "lpddr",
            "ufs",
            "regulator_feedback",
            "i2s_audio",
            "pdm_microphone",
            "haptic_power",
            "speaker_power",
            "audio_control",
            "test_access",
            "enclosure_clearance",
            "manufacturing_outputs",
        }
    )
    domains = {item["id"]: item for item in matrix["trial_route_domains"]}
    expected_domains = {
        "display_touch",
        "front_rear_cameras",
        "usb_c_and_side_keys",
        "cellular_wifi_bluetooth_rf",
        "compute_memory_power",
        "audio_haptics_acoustic",
        "top_bottom_interconnect",
        "factory_test_and_enclosure",
    }
    if set(domains) != expected_domains:
        raise SystemExit("trial route matrix domain set diverges")
    seen_functions: set[str] = set()
    referenced_response_packs: set[str] = set()
    for domain_id, domain in domains.items():
        if domain["status"] != "blocked_missing_supplier_response_footprint_and_escape_review":
            raise SystemExit(f"trial route matrix domain unexpectedly open: {domain_id}")
        seen_functions.update(domain["supplier_functions"])
        unknown_functions = sorted(set(domain["supplier_functions"]) - set(response_records))
        if unknown_functions:
            raise SystemExit(
                f"trial route matrix unknown supplier functions: {domain_id} {unknown_functions}"
            )
        unknown_regions = sorted(set(domain["placement_regions"]) - placement_regions)
        if unknown_regions:
            raise SystemExit(
                f"trial route matrix unknown placement regions: {domain_id} {unknown_regions}"
            )
        unknown_classes = sorted(set(domain["route_classes_required"]) - known_route_classes)
        if unknown_classes:
            raise SystemExit(
                f"trial route matrix unknown route classes: {domain_id} {unknown_classes}"
            )
        if len(domain["required_pre_route_inputs"]) < 4:
            raise SystemExit(f"trial route matrix weak input list: {domain_id}")
        if not domain["escape_review_required"]:
            raise SystemExit(f"trial route matrix missing escape review: {domain_id}")
        required = domain["response_pack_required"]
        if required == "all_supplier_response_packs":
            referenced_response_packs.update(response_packs)
        else:
            paths = required if isinstance(required, list) else [required]
            for path in paths:
                if path not in response_packs:
                    raise SystemExit(
                        f"trial route matrix response pack path stale: {domain_id} {path}"
                    )
                referenced_response_packs.add(path)
    if set(response_records) - seen_functions:
        raise SystemExit("trial route matrix does not cover all supplier functions")
    if referenced_response_packs != response_packs:
        raise SystemExit("trial route matrix does not cover all response packs")
    if set(gate_records) != set(response_records):
        raise SystemExit("trial route matrix supplier sample gate function set diverges")

    present_response_packs = sorted(
        path for path in response_packs if is_release_artifact_present(ROOT / path)
    )
    placeholder_response_packs = sorted(
        path
        for path in response_packs
        if (ROOT / path).exists() and not is_release_artifact_present(ROOT / path)
    )
    missing_response_packs = sorted(path for path in response_packs if not (ROOT / path).exists())
    inventory = matrix["input_inventory"]
    if inventory["trial_route_domain_count"] != len(domains):
        raise SystemExit("trial route matrix domain count stale")
    if inventory["supplier_function_count"] != len(response_records):
        raise SystemExit("trial route matrix supplier function count stale")
    if inventory["planned_response_pack_count"] != len(response_packs):
        raise SystemExit("trial route matrix response pack count stale")
    if inventory["present_response_pack_count"] != len(present_response_packs):
        raise SystemExit("trial route matrix present response pack count stale")
    release_missing_response_pack_count = len(missing_response_packs) + len(
        placeholder_response_packs
    )
    if inventory["missing_response_pack_count"] != release_missing_response_pack_count:
        raise SystemExit("trial route matrix missing response pack count stale")
    if inventory["routed_segment_count"] != counts["segment_count"]:
        raise SystemExit("trial route matrix routed segment count stale")
    if inventory["routed_zone_count"] != counts["zone_count"]:
        raise SystemExit("trial route matrix routed zone count stale")
    if present_response_packs:
        raise SystemExit(
            f"trial route matrix response packs unexpectedly exist: {present_response_packs}"
        )
    if (
        inventory["every_response_pack_absent"] is not True
        or inventory["trial_route_allowed"] is not False
    ):
        raise SystemExit("trial route matrix must remain fail-closed")

    allowed_placeholders = matrix.get("allowed_fail_closed_placeholder_outputs", {})
    for output in matrix["required_trial_route_outputs"]:
        path = ROOT / output
        if not path.exists():
            continue
        if not is_release_artifact_present(path):
            continue
        placeholder = allowed_placeholders.get(output)
        if placeholder is None:
            raise SystemExit(f"trial route output unexpectedly exists: {output}")
        output_data = load_yaml(path)
        if output_data["status"] != placeholder["required_status"]:
            raise SystemExit(f"trial route placeholder output unexpectedly open: {output}")
    reports = feasibility["trial_route_exit_criteria"]["required_measurements_or_reports"]
    if "trial_route_input_matrix_cross_check" not in reports:
        raise SystemExit("route feasibility missing trial route input matrix cross-check")
    for name, value in matrix["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"trial route matrix cross-check failed: {name}")
    for blocker in [
        "supplier response packs, signed drawings, pinouts, land patterns, and STEP models are missing",
        "exact SoC, memory, PMIC, battery, camera, display, radio, USB-C, side-key, audio, and interconnect footprints are not captured",
        "compact 64 x 132 mm route has not been trial-routed, DRC checked, or measured",
        "field-solved stackup, impedance coupons, SI/PI/RF reports, factory limits, and routed STEP clearance are missing",
    ]:
        if blocker not in matrix["release_blockers"]:
            raise SystemExit(f"trial route matrix missing blocker: {blocker}")
    for claim in [
        "trial_route_ready",
        "route_feasible",
        "supplier_inputs_complete",
        "footprint_capture_ready",
        "routed_pcb_ready",
        "drc_clean",
        "si_pi_rf_closed",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in matrix["forbidden_claims"]:
            raise SystemExit(f"trial route matrix missing forbidden claim {claim}")
    print(
        "trial route input matrix ok: "
        f"{len(domains)} domains, {release_missing_response_pack_count} response packs absent"
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
    if (
        topology["status"]
        != "blocked_usb2_route_topology_requires_controlled_impedance_flex_or_topology_change"
    ):
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
    expected_overage = round(
        usb_corridor["concept_manhattan_length_mm"] - usb_constraint["max_length_mm"], 3
    )
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
    if (
        "direct concept path exceeds USB2 length target before supplier footprints or flex stackup"
        not in direct["why_not_ready"]
    ):
        raise SystemExit("USB direct topology missing length blocker")

    recommended = options["controlled_impedance_side_flex_with_signed_usb_si"]
    if (
        recommended["status"]
        != "recommended_resolution_path_but_blocked_until_supplier_stackup_and_trial_route"
    ):
        raise SystemExit("USB recommended topology status changed")
    evidence = recommended["evidence"]
    if evidence["preserves_bottom_center_port"] is not True:
        raise SystemExit("USB recommended topology must preserve bottom port")
    if evidence["preserves_selected_screen_and_battery_geometry"] is not True:
        raise SystemExit("USB recommended topology must preserve screen and battery geometry")
    if evidence["must_replace_current_direct_corridor"] != usb_corridor["id"]:
        raise SystemExit("USB recommended topology corridor dependency stale")
    if (
        evidence["must_update_top_bottom_interconnect_pinout"]
        != "USB_DP_USB_DN_flanked_by_ground_or_return"
    ):
        raise SystemExit("USB recommended topology interconnect policy changed")
    decision = topology["recommended_resolution"]
    if decision["selected_option"] != "controlled_impedance_side_flex_with_signed_usb_si":
        raise SystemExit("USB topology selected option changed")
    if (
        decision["decision_status"]
        != "blocked_waiting_supplier_flex_connector_stackup_trial_route_and_usb_si"
    ):
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
            raise SystemExit(
                f"USB topology SI measurement must block release: {measurement.get('id')}"
            )
        if not measurement.get("required_artifact"):
            raise SystemExit(
                f"USB topology SI measurement missing artifact: {measurement.get('id')}"
            )
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
            raise SystemExit(
                f"USB route SI template evidence class diverges: {row['measurement_id']}"
            )
        if row["measured_value"] or row["pass"] or row["reviewer"] or row["result_artifact"]:
            raise SystemExit(
                f"USB route SI template must remain blank until physical evidence: {row['measurement_id']}"
            )
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
    allocation = load_yaml(ROOT / "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml")
    binding = load_yaml(ROOT / "board/kicad/e1-phone/split-interconnect-connector-binding.yaml")
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
    if (
        binding["status"]
        != "blocked_placeholder_connectors_bound_to_pin_allocation_not_supplier_release"
    ):
        raise SystemExit(
            f"unexpected split interconnect connector binding status: {binding['status']}"
        )
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
    package_buses = {
        bus["name"]: set(bus["nets"]) for bus in package["required_cross_island_buses"]
    }
    pin_buses: dict[str, set[str]] = {}
    for item in pins:
        pin_buses.setdefault(item["bus"], set()).add(item["net"])
    for bus_name, nets in plan_buses.items():
        if bus_name not in pin_buses:
            raise SystemExit(f"split interconnect allocation missing bus {bus_name}")
        missing = sorted((nets - {"GND"}) - active_nets)
        if missing:
            raise SystemExit(
                f"split interconnect allocation dropped plan bus nets {bus_name}: {missing}"
            )
        if bus_name in package_buses and not package_buses[bus_name].issubset(
            active_nets | {"GND"}
        ):
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
    if (
        usb_group["target_differential_impedance_ohm"]
        != impedance_classes[usb_constraint["class"]]["impedance_ohm"]
    ):
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
        if (
            not group["pins"]
            or not group["return_pins"]
            or not group["status"].startswith("blocked_")
        ):
            raise SystemExit(f"split interconnect power group is weak: {name}")
    fixture = allocation["test_access_mapping"]["bottom_fixture_visible_rails"]
    for rail in ["VBUS", "VBAT", "SYS", "AON_1V8", "IO_1V8", "RF_VBAT", "GND"]:
        if rail not in fixture or not fixture[rail]:
            raise SystemExit(f"split interconnect fixture rail missing: {rail}")
    if (
        allocation["test_access_mapping"]["status"]
        != "blocked_waiting_bottom_fixture_pad_coordinates_and_production_limits"
    ):
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
        if (
            item["status"]
            != "blocked_placeholder_binding_waiting_supplier_land_pattern_and_schematic_symbol"
        ):
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


def check_split_interconnect_schematic_net_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/split-interconnect-schematic-net-binding.yaml")
    manifest = load_yaml(MANIFEST)
    plan = load_yaml(ROOT / "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml")
    allocation = load_yaml(ROOT / "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml")
    connector_binding = load_yaml(
        ROOT / "board/kicad/e1-phone/split-interconnect-connector-binding.yaml"
    )
    topology = load_yaml(ROOT / "board/kicad/e1-phone/usb-route-topology-resolution.yaml")
    block_netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    package = load_yaml(ROOT / "package/interconnect/e1-phone-top-bottom-flex.yaml")

    if binding["schema"] != "eliza.e1_phone_split_interconnect_schematic_net_binding.v1":
        raise SystemExit(f"unexpected split interconnect net binding schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_split_interconnect_net_binding_requires_supplier_connector_flex_stackup_real_symbols_route_si_and_enclosure_evidence"
    ):
        raise SystemExit(f"unexpected split interconnect net binding status: {binding['status']}")
    rel = "board/kicad/e1-phone/split-interconnect-schematic-net-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing split interconnect schematic net binding")
    if rel not in allocation["source_artifacts"]:
        raise SystemExit("split interconnect allocation must cite schematic net binding")
    if rel not in connector_binding["source_artifacts"]:
        raise SystemExit("split interconnect connector binding must cite schematic net binding")
    for source in [
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml",
        "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml",
        "board/kicad/e1-phone/split-interconnect-connector-binding.yaml",
        "board/kicad/e1-phone/usb-route-topology-resolution.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/schematic/split_interconnect.kicad_sch",
        "package/interconnect/e1-phone-top-bottom-flex.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"split interconnect net binding missing source {source}")
        require_path(ROOT / source)

    pins = allocation["pin_allocation"]
    pins_by_contact = {item["contact"]: item for item in pins}
    active_nets = {item["net"] for item in pins if item["net"] != "NC"}
    contact_budget = allocation["contact_budget"]
    known_nets = set()
    for block in block_netlist["blocks"]:
        known_nets.update(flatten_net_groups(block["nets"]))
    for domain in block_netlist["voltage_domains"]:
        known_nets.add(domain["name"])
    probe_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    route_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}
    power_groups = {item["name"]: item for item in allocation["power_contact_groups"]}
    controlled = {item["name"]: item for item in allocation["controlled_impedance_groups"]}

    context = binding["interface_context"]
    if context["selected_topology"] != plan["selected_topology"]:
        raise SystemExit("split interconnect net binding topology stale")
    if context["preferred_interconnect_family"] != plan["preferred_interconnect_family"]:
        raise SystemExit("split interconnect net binding preferred family stale")
    if (
        context["exact_part_number_status"]
        != allocation["connector_context"]["exact_part_number_status"]
    ):
        raise SystemExit("split interconnect net binding part-number state stale")
    if context["contact_count"] != contact_budget["allocated_contact_count"]:
        raise SystemExit("split interconnect net binding contact count stale")
    if (
        context["active_unique_crossing_net_count"]
        != contact_budget["active_unique_crossing_net_count"]
    ):
        raise SystemExit("split interconnect net binding active net count stale")
    if (
        context["ground_or_return_pin_count"]
        != contact_budget["allocated_ground_or_return_pin_count"]
    ):
        raise SystemExit("split interconnect net binding return count stale")
    if context["spare_pin_count"] != contact_budget["allocated_spare_pin_count"]:
        raise SystemExit("split interconnect net binding spare count stale")
    if context["schematic_sheet"] != connector_binding["schematic_binding"]["sheet"]:
        raise SystemExit("split interconnect net binding schematic sheet stale")
    if (
        context["schematic_evidence_class"]
        != connector_binding["schematic_binding"]["evidence_class"]
    ):
        raise SystemExit("split interconnect net binding schematic evidence class stale")

    required_nets = set(allocation["required_cross_island_net_coverage"]["required_nets"])
    blocks = binding["schematic_connector_blocks"]
    if set(blocks) != {"J_TOP_BOTTOM_FLEX_TOP", "J_TOP_BOTTOM_FLEX_BOTTOM"}:
        raise SystemExit("split interconnect net binding connector block set diverges")
    for refdes, block in blocks.items():
        if block["package_binding"] != "package/interconnect/e1-phone-top-bottom-flex.yaml":
            raise SystemExit(f"split interconnect net binding package stale: {refdes}")
        if block["required_contacts"] != contact_budget["allocated_contact_count"]:
            raise SystemExit(f"split interconnect net binding contact count stale: {refdes}")
        if set(block["required_active_nets"]) != required_nets:
            raise SystemExit(f"split interconnect net binding active nets stale: {refdes}")
        if set(block["required_active_nets"]) != active_nets:
            raise SystemExit(
                f"split interconnect net binding active nets differ from pin table: {refdes}"
            )
        if not block["status"].startswith("blocked_"):
            raise SystemExit(
                f"split interconnect net binding connector unexpectedly open: {refdes}"
            )
        if len(block["required_local_parts"]) < 4:
            raise SystemExit(f"split interconnect net binding release evidence too weak: {refdes}")

    plan_buses = {bus["name"]: set(bus["nets"]) for bus in plan["cross_island_buses"]}
    package_buses = {
        bus["name"]: set(bus["nets"]) for bus in package["required_cross_island_buses"]
    }
    bus_bindings = binding["bus_bindings"]
    expected_bus_names = set(plan_buses) | {"SPARE_EVT_REWORK"}
    if set(bus_bindings) != expected_bus_names:
        raise SystemExit("split interconnect net binding bus set diverges")
    for bus_name, bus in bus_bindings.items():
        contacts = bus["contacts"]
        pin_nets = {pins_by_contact[contact]["net"] for contact in contacts}
        active_for_contacts = pin_nets - {"NC"}
        if set(bus["active_nets"]) != active_for_contacts:
            raise SystemExit(f"split interconnect net binding active nets stale for {bus_name}")
        for contact in contacts:
            if pins_by_contact[contact]["bus"] != bus_name:
                raise SystemExit(
                    f"split interconnect net binding contact assigned to wrong bus: {contact}"
                )
        if bus_name in plan_buses:
            missing_from_contacts = (plan_buses[bus_name] - {"GND"}) - active_for_contacts
            if missing_from_contacts and not missing_from_contacts.issubset(active_nets):
                raise SystemExit(
                    f"split interconnect net binding dropped plan bus nets: {bus_name}"
                )
        if bus_name in package_buses:
            missing_from_contacts = (package_buses[bus_name] - {"GND"}) - active_for_contacts
            if missing_from_contacts and not missing_from_contacts.issubset(active_nets):
                raise SystemExit(
                    f"split interconnect net binding dropped package bus nets: {bus_name}"
                )
        if not bus["required_validation"]:
            raise SystemExit(f"split interconnect net binding missing validation: {bus_name}")
    usb = bus_bindings["USB2_FROM_BOTTOM_PORT_TO_TOP_SOC_PD"]
    if usb["controlled_impedance_group"] != "USB_DP_DN":
        raise SystemExit("split interconnect USB2 controlled group stale")
    if (
        usb["target_differential_impedance_ohm"]
        != routing["impedance_classes"]["usb2_diff"]["impedance_ohm"]
    ):
        raise SystemExit("split interconnect USB2 impedance target stale")
    if controlled["USB_DP_DN"]["nets"] != ["GND", "USB_DP", "USB_DN", "GND"]:
        raise SystemExit("split interconnect USB2 controlled group no longer flanked")
    if route_pairs["USB_DP_DN"]["nets"] != ["USB_DP", "USB_DN"]:
        raise SystemExit("split interconnect USB2 route pair stale")
    audio = bus_bindings["AUDIO_DIGITAL_TO_BOTTOM_CODEC_MICS"]
    if audio["routing_constraint_refs"] != ["AUDIO_I2S_PDM", "AUDIO_I2C_IRQ"]:
        raise SystemExit("split interconnect audio route refs stale")
    for bus_name in audio["routing_constraint_refs"]:
        if bus_name not in single_ended:
            raise SystemExit(f"split interconnect audio bus missing routing constraint: {bus_name}")
    for group_name in bus_bindings["POWER_FROM_TOP_CHARGER_TO_BOTTOM_IO"]["power_contact_groups"]:
        if group_name not in power_groups:
            raise SystemExit(
                f"split interconnect power group missing from allocation: {group_name}"
            )
    for group_name in bus_bindings["HAPTIC_AND_FACTORY_TEST"]["power_contact_groups"]:
        if group_name not in power_groups:
            raise SystemExit(
                f"split interconnect haptic power group missing from allocation: {group_name}"
            )

    if not active_nets.issubset(known_nets):
        raise SystemExit(
            f"split interconnect net binding has unknown nets: {sorted(active_nets - known_nets)}"
        )
    probes = binding["factory_probe_bindings"]
    if probes["split_board_interconnect"] != probe_domains["split_board_interconnect"]["nets"]:
        raise SystemExit("split interconnect factory probe binding stale")
    fixture = allocation["test_access_mapping"]["bottom_fixture_visible_rails"]
    if set(probes["bottom_fixture_visible_rails"]) != set(fixture):
        raise SystemExit("split interconnect bottom fixture rail list stale")
    if len(probes["required_fixture_notes"]) < 3:
        raise SystemExit("split interconnect fixture notes too weak")
    if (
        topology["recommended_resolution"]["selected_option"]
        != "controlled_impedance_side_flex_with_signed_usb_si"
    ):
        raise SystemExit("split interconnect net binding USB topology stale")

    for criterion in [
        "KiCad schematic contains non-placeholder 49-contact or greater top and bottom connector symbols with reviewed electrical pin types",
        "split-interconnect-pin-allocation.yaml is converted into symbol pins footprint pads and flex pinout with mirrored-contact review",
        "USB_DP and USB_DN remain flanked by return contacts and pass stackup coupon TDR eye attach ADB and fastboot evidence",
        "routed board STEP includes top connector bottom connector flex stiffeners strain relief and enclosure clearance rerun",
    ]:
        if criterion not in binding["evt1_capture_exit_criteria"]:
            raise SystemExit(f"split interconnect net binding missing exit criterion: {criterion}")
    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"split interconnect net binding cross-check failed: {key}")
    for blocker in [
        "schematic split-interconnect sheet is still a text scaffold, not real 49-pin connector symbols",
        "flex stackup, bend radius, stiffener, strain relief, and assembly drawing are missing",
        "USB2 impedance, length, skew, eye, attach, ADB, and fastboot evidence are missing",
        "routed copper, DRC/ERC, and enclosure clearance evidence are missing",
    ]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"split interconnect net binding missing blocker: {blocker}")
    for claim in [
        "schematic_connector_symbols_ready",
        "interconnect_pinout_frozen",
        "connector_selected",
        "flex_stackup_ready",
        "split_interconnect_routed",
        "split_board_routed",
        "usb_si_closed",
        "audio_si_closed",
        "erc_clean",
        "drc_clean",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"split interconnect net binding missing forbidden claim {claim}")
    print(
        "split interconnect schematic net binding ok: "
        f"{context['contact_count']} contacts, {len(bus_bindings)} bus groups fail-closed"
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
        "connector mated height and stiffener stack must clear the 11.8 mm flush-back enclosure",
        "strain relief or clamp must be defined before drop/torsion testing",
    ]:
        if requirement not in interconnect["assembly_closure_requirements"]:
            raise SystemExit(
                f"split-board interface closure missing assembly requirement {requirement}"
            )
    print(f"interface closure ok: {len(interfaces)} enclosure/internal interfaces cross-checked")


def check_external_interface_design_review() -> None:
    review = load_yaml(ROOT / "board/kicad/e1-phone/external-interface-design-review.yaml")
    manifest = load_yaml(MANIFEST)
    interface_closure = load_yaml(ROOT / "board/kicad/e1-phone/interface-closure.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    display = load_yaml(ROOT / "package/display/v0-dsi-720x1280.yaml")
    camera = load_yaml(ROOT / "package/camera/oem-mipi-csi-modules.yaml")
    usb = load_yaml(ROOT / "package/usb-c/e1-phone-usb-c-port.yaml")
    side_buttons = load_yaml(ROOT / "package/human-interface/side-buttons.yaml")

    if review["schema"] != "eliza.e1_phone_external_interface_design_review.v1":
        raise SystemExit(f"unexpected external interface design review schema: {review['schema']}")
    if (
        review["status"]
        != "blocked_requires_supplier_drawings_routed_pcb_and_measured_interface_validation"
    ):
        raise SystemExit(f"unexpected external interface design review status: {review['status']}")
    rel = "board/kicad/e1-phone/external-interface-design-review.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing external-interface-design-review artifact")
    for source in review["source_artifacts"]:
        require_path(ROOT / source)

    shared = review["shared_geometry"]
    if shared["device_envelope_mm"] != manifest["design_target"]["device_envelope_mm"]:
        raise SystemExit("external interface review device envelope diverges from manifest")
    if shared["board_bbox_mm"] != manifest["design_target"]["board_bbox_mm"]:
        raise SystemExit("external interface review board bbox diverges from manifest")
    if (
        shared["selected_display_outline_mm"]
        != display_fit["selected_primary_display"]["outline_mm"]
    ):
        raise SystemExit("external interface review display outline diverges")
    if (
        shared["selected_display_active_area_mm"]
        != display_fit["selected_primary_display"]["active_area_mm"]
    ):
        raise SystemExit("external interface review display active area diverges")
    if shared["battery_window_mm"] != {"x": 0.0, "y": 29.5, "width": 64.0, "height": 87.0}:
        raise SystemExit("external interface review battery window is stale")

    placements = {item["refdes_group"]: item for item in placement["placements"]}
    closure = {item["name"]: item for item in interface_closure["interfaces"]}
    reviews = {item["name"]: item for item in review["interface_reviews"]}
    expected = {
        "display_touch": {
            "placement": "J_DISPLAY_TOUCH",
            "closure": "top_right_display_touch_fpc",
            "package": "package/display/v0-dsi-720x1280.yaml",
        },
        "usb_c_charge_data_debug": {
            "placement": "J_USB_C",
            "closure": "single_bottom_usb_c_charge_data_debug",
            "package": "package/usb-c/e1-phone-usb-c-port.yaml",
        },
        "side_power_volume": {
            "placement": "SW_POWER_VOL",
            "closure": "left_edge_power_volume_buttons",
            "package": "package/human-interface/side-buttons.yaml",
        },
        "front_rear_camera_fpcs": {
            "placement": "J_CAM0_CAM1",
            "closure": "top_right_front_rear_camera_fpcs",
            "package": "package/camera/oem-mipi-csi-modules.yaml",
        },
    }
    if set(reviews) != set(expected):
        raise SystemExit("external interface review interface set diverges")
    for name, spec in expected.items():
        item = reviews[name]
        placement_item = placements[spec["placement"]]
        closure_item = closure[spec["closure"]]
        if item["placement_refdes_group"] != spec["placement"]:
            raise SystemExit(f"external interface review placement stale: {name}")
        if item["interface_closure_ref"] != spec["closure"]:
            raise SystemExit(f"external interface review closure ref stale: {name}")
        if item["package_binding"] != spec["package"]:
            raise SystemExit(f"external interface review package binding stale: {name}")
        if item["region_mm"] != placement_item["region_mm"]:
            raise SystemExit(f"external interface review region diverges: {name}")
        if item["region_mm"] != closure_item["region_mm"]:
            raise SystemExit(f"external interface review closure region diverges: {name}")
        if not set(item["required_nets"]).issubset(set(closure_item["required_nets"])):
            raise SystemExit(f"external interface review nets not in interface closure: {name}")
        if not item["layout_requirements"] or not item["mechanical_requirements"]:
            raise SystemExit(f"external interface review lacks hardware requirements: {name}")
        if not item["validation_required_before_release"]:
            raise SystemExit(f"external interface review lacks release validation: {name}")
        if not item["status"].startswith("blocked_"):
            raise SystemExit(f"external interface review unexpectedly open: {name}")

    display_candidate = reviews["display_touch"]["selected_supplier_candidate"]
    primary_display = display["panel_candidates"][0]
    if display_candidate["part"] != primary_display["part"]:
        raise SystemExit("external interface review display candidate diverges")
    if display_candidate["vendor"] != primary_display["vendor"]:
        raise SystemExit("external interface review display vendor diverges")
    usb_candidate = reviews["usb_c_charge_data_debug"]["selected_supplier_candidate"]
    if usb_candidate["family"] != usb["connector_strategy"]["evt0_low_risk"]["family"]:
        raise SystemExit("external interface review USB-C candidate diverges")
    side_candidate = reviews["side_power_volume"]["selected_supplier_candidate"]
    if side_candidate["family"] != side_buttons["primary_switch_family"]["family"]:
        raise SystemExit("external interface review side-key candidate diverges")
    camera_candidates = reviews["front_rear_camera_fpcs"]["selected_supplier_candidates"]
    if (
        camera_candidates["rear"]["module"]
        != camera["rear_camera_primary"]["candidate_parts"][0]["module"]
    ):
        raise SystemExit("external interface review rear camera candidate diverges")
    if (
        camera_candidates["front"]["module"]
        != camera["front_camera_primary"]["candidate_parts"][0]["module"]
    ):
        raise SystemExit("external interface review front camera candidate diverges")
    if reviews["usb_c_charge_data_debug"]["port_count"] != manifest["design_target"]["usb_c_ports"]:
        raise SystemExit("external interface review USB-C port count diverges")
    if (
        reviews["side_power_volume"]["recommended_min_contacts"]
        != side_buttons["layout_closure_requirements"]["side_key_flex_pin_budget"][
            "recommended_min_contacts"
        ]
    ):
        raise SystemExit("external interface review side-key contact budget diverges")

    matrix = review["validation_matrix"]
    for key, value in matrix.items():
        if key.endswith("_required") and value is not True:
            raise SystemExit(f"external interface review must require {key}")
        if (key.endswith("_complete") or key == "supplier_docs_received") and value is not False:
            raise SystemExit(f"external interface review must keep {key} false")
    for name, value in review["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"external interface review cross-check failed: {name}")
    for claim in [
        "external_interfaces_ready",
        "display_touch_ready",
        "usb_c_ready",
        "side_buttons_ready",
        "power_key_wake_ready",
        "recovery_key_combo_ready",
        "camera_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in review["forbidden_claims"]:
            raise SystemExit(f"external interface review missing forbidden claim {claim}")
    print(f"external interface design review ok: {len(reviews)} interfaces fail-closed")


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
    cad_envelope = env["cad_device_envelope_mm"]
    if {
        "width": cad_envelope["width"],
        "height": cad_envelope["height"],
    } != {
        "width": expected_envelope["width"],
        "height": expected_envelope["height"],
    }:
        raise SystemExit("enclosure placement CAD envelope width/height diverges from metrics")
    if (
        cad_envelope["max_thickness"] < expected_envelope["max_thickness"]
        or cad_envelope["max_thickness"] > 12.8
    ):
        raise SystemExit("enclosure placement CAD envelope thickness outside flush-back bounds")
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
        "RF antenna/SAR validation in final enclosure plastics and metal stack",
    ]:
        if blocker not in closure["release_blockers"]:
            raise SystemExit(f"enclosure placement missing release blocker {blocker}")
    if not any(
        "formal" in blocker and "tolerance stack" in blocker and "battery swelling" in blocker
        for blocker in closure["release_blockers"]
    ):
        raise SystemExit("enclosure placement missing formal tolerance-stack release blocker")
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
    integration = load_yaml(ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml")
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
    if (
        integration["status"]
        != "blocked_requires_supplier_step_models_routed_board_step_and_clearance_rerun"
    ):
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
    selected_width_height = [selected_env["width"], selected_env["height"]]
    compact_width_height = compact["current_envelope_mm"][:2]
    compact_thickness = compact["current_envelope_mm"][2]
    if compact_width_height != selected_width_height:
        raise SystemExit("component height compactness envelope diverges from tolerance stack")
    if compact_thickness > 12.8:
        raise SystemExit("component height compactness thickness is outside flush-back bounds")
    if (
        compact_thickness != selected_env["max_thickness"]
        and f"{compact_thickness} mm" not in compact["decision"]
    ):
        raise SystemExit("component height compactness thickness change lacks explicit decision")

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
    routed_board_state_key_map = {
        "production_concept_has_tracks": "has_tracks",
        "production_concept_has_filled_zones": "has_filled_zones",
        "has_production_step": "has_production_step",
        "production_concept_placeholder_marker_count": "placeholder_marker_count",
    }
    for key, board_key in routed_board_state_key_map.items():
        if routed[key] != board_state[board_key]:
            raise SystemExit(f"component height routed board context stale: {key}")
    if (
        routed["concept_split_island_geometry_matches_kicad"]
        != board_step["concept_split_island_geometry"]["matches"]
    ):
        raise SystemExit("component height split island geometry status stale")
    if routed["production_concept_has_tracks"] or routed["has_production_step"]:
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
        for key in [
            "rfq_package_id",
            "rfq_package_ready",
            "required_evidence",
            "missing_supplier_items",
            "pass",
        ]:
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
            if model not in concept_case_names and step_validation["status"] != "blocked":
                raise SystemExit(f"component height concept model not in STEP validation: {model}")
        elif item["concept_step_path"] is not None:
            raise SystemExit(
                f"component height missing concept STEP should have null path: {model}"
            )

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
    if (
        route_dep["trial_route_reports_required"]
        != route_feasibility["trial_route_exit_criteria"]["required_measurements_or_reports"]
    ):
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
        "local real-footprint routed STEP exists for visual review only; supplier-approved production STEP with component 3D models is missing",
        "routed-board clearance rerun has not passed",
        "concept STEP envelopes are not supplier-approved geometry",
        "full CAD boolean interference report using routed board and supplier models is missing",
        "component height and courtyard data are not bound to production KiCad footprints",
    ]:
        if blocker not in integration["release_blockers"]:
            raise SystemExit(f"component height missing release blocker: {blocker}")
    if not any(
        "supplier STEP/B-rep models" in blocker for blocker in integration["release_blockers"]
    ):
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
    routing_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml")
    power_bringup = load_yaml(ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    module_host = load_yaml(
        ROOT / "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml"
    )
    display_camera = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-acceptance-checklist.yaml"
    )
    usb_sidekey = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    radio_antenna = load_yaml(ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml")
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    board_step = load_yaml(ROOT / "mechanical/e1-phone/review/board-step-readiness.json")
    routed_clearance = load_yaml(ROOT / "mechanical/e1-phone/review/routed-board-clearance.json")

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
    incomplete_cases = [
        item["case_id"] for item in routed_clearance["result_cases"] if not item["pass"]
    ]
    if blockers["missing_or_incomplete_clearance_cases"] != incomplete_cases:
        raise SystemExit("enclosure fit execution incomplete clearance cases stale")
    if blockers["required_height_models"] != routed_clearance["required_height_models"]:
        raise SystemExit("enclosure fit execution required height model list stale")
    if blockers["production_step_files"] != board_step["production_step_files"]:
        raise SystemExit("enclosure fit execution production STEP list stale")
    if (
        blockers["production_concept_placeholder_marker_count"]
        != board_step["board_state_detected"]["placeholder_marker_count"]
    ):
        raise SystemExit("enclosure fit execution placeholder count stale")
    if (
        blockers["production_concept_has_tracks"]
        != manufacturing["board_state_detected"]["has_tracks"]
    ):
        raise SystemExit("enclosure fit execution routed track state stale")
    if (
        blockers["production_concept_has_filled_zones"]
        != manufacturing["board_state_detected"]["has_filled_zones"]
    ):
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
        "local routed KiCad PCB candidate exists, but DRC/ERC reports are non-release and blocked by 2304 DRC rows and 366 ERC rows",
        "supplier STEP or B-rep models for height-critical parts are missing",
        "local routed real-footprint STEP exists for visual review only; supplier-approved routed board STEP has not passed enclosure CAD import or clearance",
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


def check_power_sequence_bringup_closure() -> None:
    closure = load_yaml(ROOT / "board/kicad/e1-phone/power-sequence-bringup-closure.yaml")
    budget = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    module_host = load_yaml(ROOT / "board/kicad/e1-phone/module-host-integration-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    usb_pd = load_yaml(ROOT / "package/usb-pd/tps65987.yaml")
    charger = load_yaml(ROOT / "package/charger/max77860.yaml")
    pmic = load_yaml(ROOT / "package/pmic/da9063.yaml")
    manifest = load_yaml(MANIFEST)

    if closure["schema"] != "eliza.e1_phone_power_sequence_bringup_closure.v1":
        raise SystemExit("power sequence bring-up closure schema diverges")
    if closure["status"] != "blocked_requires_routed_schematic_first_power_and_scope_logs":
        raise SystemExit(f"unexpected power sequence bring-up status: {closure['status']}")
    rel = "board/kicad/e1-phone/power-sequence-bringup-closure.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing power sequence bring-up closure artifact")
    for source in closure["source_artifacts"]:
        require_path(ROOT / source)

    policy = closure["first_power_policy"]
    if policy["usb_pd_input_profiles_allowed"] != budget["usb_c_power_path"]["pd_sink_profiles"]:
        raise SystemExit("power sequence PD input profiles stale")
    for key in [
        "battery_pack_required_before_charge_current_above_500ma",
        "stop_on_overcurrent_or_unsequenced_rail",
        "oscilloscope_required",
        "thermal_camera_required_for_charge_and_modem_burst",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"power sequence first-power policy must require {key}")
    if policy["bench_supply_current_limit_ma_initial"] > 100:
        raise SystemExit("power sequence initial bench current limit too high")

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))
    factory_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    steps = {item["id"]: item for item in closure["rail_sequence_steps"]}
    expected_steps = {
        "pre_power_shorts",
        "usb_pd_dead_battery_attach",
        "charger_sys_precharge",
        "pmic_aon_and_ap_rails",
        "display_touch_rails",
        "camera_rails",
        "radio_rails",
        "audio_haptic_rails",
    }
    if set(steps) != expected_steps:
        raise SystemExit("power sequence rail step set diverges")
    for step_id, step in steps.items():
        if not step["current_status"].startswith("blocked_"):
            raise SystemExit(f"power sequence rail step unexpectedly open: {step_id}")
        if len(step["required_evidence"]) < 3:
            raise SystemExit(f"power sequence rail step evidence too weak: {step_id}")
        missing_nets = sorted(set(step["required_nets"]) - block_nets)
        if missing_nets:
            raise SystemExit(f"power sequence rail step nets missing for {step_id}: {missing_nets}")
        for source in step["source_artifacts"]:
            require_path(ROOT / source)

    if (
        steps["pre_power_shorts"]["required_nets"]
        != routing["power_integrity"]["test_points_required"]
    ):
        raise SystemExit("power sequence pre-power rail test points stale")
    if steps["pre_power_shorts"]["required_nets"] != factory_domains["power_rails"]["nets"]:
        raise SystemExit("power sequence factory power rail coverage stale")
    if "usb_c" not in factory_domains or "buttons_sensors_nfc" not in factory_domains:
        raise SystemExit("power sequence factory coverage missing USB/button domains")

    host_records = {item["id"]: item for item in module_host["integration_records"]}
    display_contracts = set(host_records["display_touch_module"]["required_contracts"])
    camera_contracts = set(host_records["rear_front_camera_modules"]["required_contracts"])
    radio_contracts = set(host_records["cellular_5g_redcap_module"]["required_contracts"])
    radio_contracts.update(host_records["wifi_bluetooth_module"]["required_contracts"])
    if not set(steps["display_touch_rails"]["required_nets"]) <= display_contracts | block_nets:
        raise SystemExit("power sequence display rail contract coverage stale")
    if not set(steps["camera_rails"]["required_nets"]) <= camera_contracts | block_nets:
        raise SystemExit("power sequence camera rail contract coverage stale")
    if not set(steps["radio_rails"]["required_nets"]) <= radio_contracts | block_nets:
        raise SystemExit("power sequence radio rail contract coverage stale")

    package_status = closure["package_power_sequence_status"]
    for function in ["pmic", "charger", "usb_pd", "display", "camera", "cellular", "audio"]:
        if package_status[function] != "required_not_implemented":
            raise SystemExit(f"power sequence package unexpectedly implemented: {function}")
    if package_status["usb_pd"] != usb_pd["power_sequence"]["status"]:
        raise SystemExit("power sequence USB-PD package status stale")
    if package_status["charger"] != charger["power_sequence"]["status"]:
        raise SystemExit("power sequence charger package status stale")
    if package_status["pmic"] != pmic["power_sequence"]["status"]:
        raise SystemExit("power sequence PMIC package status stale")
    if package_status != budget["package_power_sequence_status"]:
        raise SystemExit("power sequence package status diverges from power budget")

    for measurement in [
        "rail_boot_idle_suspend_scope_captures_for_each_power_domain",
        "usb_c_pd_attach_pps_and_current_limit_log",
        "charger_cc_cv_cycle_battery_ntc_and_pack_id_log",
        "pmic_regulator_summary_fault_irq_and_probe_transcript",
        "display_camera_radio_audio_functional_rail_enable_logs",
        "regulator_efficiency_and_load_step_report",
        "thirty_minute_thermal_soak_under_cpu_npu_camera_modem_and_charger",
    ]:
        if measurement not in closure["required_measurements"]:
            raise SystemExit(f"power sequence missing measurement: {measurement}")
    release_manifest = routed_release["required_release_output_manifest"]
    fixture_outputs = factory_probe["fixture_policy"]["outputs_required_before_release"]
    for output in closure["required_release_outputs"]:
        if (
            output not in release_manifest
            and output not in fixture_outputs
            and not output.startswith("board/kicad/e1-phone/production/reports/")
        ):
            raise SystemExit(f"power sequence release output path escapes reports: {output}")
        if is_release_artifact_present(ROOT / output):
            raise SystemExit(f"power sequence release output unexpectedly exists: {output}")
    if production["status"] == "production_ready":
        raise SystemExit("power sequence cannot see production ready")

    for key, value in closure["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"power sequence cross-check failed: {key}")
    for blocker in [
        "routed schematic and ERC evidence missing",
        "real PMIC, charger, USB-PD, battery, display, camera, radio, and audio footprints and pinouts missing",
        "first-power current-limit, oscilloscope, and thermal logs missing",
        "regulator efficiency, load-step, and charge-cycle logs missing",
        "rail sequencing firmware, device-tree, and probe transcripts missing",
    ]:
        if blocker not in closure["release_blockers"]:
            raise SystemExit(f"power sequence missing blocker: {blocker}")
    for claim in [
        "first_power_ready",
        "rail_sequence_validated",
        "charging_ready",
        "power_thermal_ready",
        "battery_safe",
        "end_to_end_phone_ready",
    ]:
        if claim not in closure["forbidden_claims"]:
            raise SystemExit(f"power sequence missing forbidden claim {claim}")
    print(
        "power sequence bring-up closure ok: "
        f"{len(steps)} rail steps, {len(closure['required_measurements'])} measurements fail-closed"
    )


def check_power_bringup_acceptance() -> None:
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml")
    budget = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    sequence = load_yaml(ROOT / "board/kicad/e1-phone/power-sequence-bringup-closure.yaml")
    battery_layout = load_yaml(ROOT / "board/kicad/e1-phone/battery-layout-options.yaml")
    usb_sidekey = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    routing_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml")
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
        "board/kicad/e1-phone/core-power-compute-schematic-net-binding.yaml",
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
    if (
        summary["battery_window_fit_status"]
        != budget["battery_target"]["battery_window_fit_status"]
    ):
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
    if (
        summary["pd_sink_profiles"]
        != sequence["first_power_policy"]["usb_pd_input_profiles_allowed"]
    ):
        raise SystemExit("power bring-up acceptance first-power PD profiles stale")
    if summary["pd_power_margin_w"] != budget["usb_c_power_path"]["pd_power_margin_w"]:
        raise SystemExit("power bring-up acceptance PD margin stale")
    if summary["pd_power_margin_w"] <= 0:
        raise SystemExit("power bring-up acceptance PD margin must remain positive")
    if summary["max_charge_current_a"] != charger["charge_profile"]["charge_current_max_a"]:
        raise SystemExit("power bring-up acceptance charger current stale")
    if (
        summary["runtime_video_call_hours_target"]
        != budget["runtime_estimates_from_selected_pack_target"]["video_call_hours_at_target"]
    ):
        raise SystemExit("power bring-up acceptance runtime estimate stale")
    if summary["skin_limit_c"] != budget["power_targets"]["thermal_skin_limit_c"]:
        raise SystemExit("power bring-up acceptance skin limit stale")

    pre_power_step = next(
        item for item in sequence["rail_sequence_steps"] if item["id"] == "pre_power_shorts"
    )
    if summary["rail_test_points_required"] != pre_power_step["required_nets"]:
        raise SystemExit("power bring-up acceptance rail test points stale")
    factory_power = next(
        item for item in factory_probe["probe_domains"] if item["id"] == "power_rails"
    )
    if summary["rail_test_points_required"] != factory_power["nets"]:
        raise SystemExit("power bring-up acceptance factory rail coverage stale")
    if summary["first_power_policy"] != sequence["first_power_policy"]:
        raise SystemExit("power bring-up acceptance first-power policy stale")
    if summary["package_power_sequence_status"] != sequence["package_power_sequence_status"]:
        raise SystemExit("power bring-up acceptance package sequence status stale")
    if any(
        value != "required_not_implemented"
        for value in summary["package_power_sequence_status"].values()
    ):
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
        if (
            item["status"]
            != "blocked_missing_routed_schematic_layout_first_power_charge_thermal_or_factory_evidence"
        ):
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


def check_core_power_compute_schematic_net_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/core-power-compute-schematic-net-binding.yaml")
    manifest = load_yaml(MANIFEST)
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    sequence = load_yaml(ROOT / "board/kicad/e1-phone/power-sequence-bringup-closure.yaml")
    acceptance = load_yaml(ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml")
    budget = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    usb_pd = load_yaml(ROOT / "package/usb-pd/tps65987.yaml")
    charger = load_yaml(ROOT / "package/charger/max77860.yaml")
    pmic = load_yaml(ROOT / "package/pmic/da9063.yaml")
    battery = load_yaml(ROOT / "package/battery/e1-phone-17p3wh-pack.yaml")

    if binding["schema"] != "eliza.e1_phone_core_power_compute_schematic_net_binding.v1":
        raise SystemExit(f"unexpected core power/compute binding schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_core_power_compute_binding_requires_real_schematic_erc_route_pi_first_power_and_factory_evidence"
    ):
        raise SystemExit(f"unexpected core power/compute binding status: {binding['status']}")
    rel = "board/kicad/e1-phone/core-power-compute-schematic-net-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing core power/compute schematic net binding")
    if rel not in sequence["source_artifacts"]:
        raise SystemExit("power sequence must cite core power/compute binding")
    if rel not in acceptance["source_artifacts"]:
        raise SystemExit("power acceptance must cite core power/compute binding")
    for source in [
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/power-sequence-bringup-closure.yaml",
        "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml",
        "board/kicad/e1-phone/power-thermal-budget.yaml",
        "package/usb-pd/tps65987.yaml",
        "package/charger/max77860.yaml",
        "package/pmic/da9063.yaml",
        "package/battery/e1-phone-17p3wh-pack.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"core power/compute binding missing source {source}")
        require_path(ROOT / source)

    context = binding["core_context"]
    summary = acceptance["power_summary"]
    if context["pmic"] != pmic["part"] or context["pmic"] != summary["pmic"]:
        raise SystemExit("core binding PMIC stale")
    if context["charger"] != charger["part"] or context["charger"] != summary["charger"]:
        raise SystemExit("core binding charger stale")
    if (
        context["usb_pd_controller"] != usb_pd["part"]
        or context["usb_pd_controller"] != summary["usb_pd_controller"]
    ):
        raise SystemExit("core binding USB-PD stale")
    if context["battery_pack_class"] != battery["target_pack"]["primary_candidate"]:
        raise SystemExit("core binding battery pack stale")
    if context["battery_energy_wh"] != battery["target_pack"]["energy_wh_target"]:
        raise SystemExit("core binding battery energy stale")
    if context["battery_reference_mm"] != battery["target_pack"]["public_reference_dimensions_mm"]:
        raise SystemExit("core binding battery dimensions stale")
    if (
        context["first_power_current_limit_ma_initial"]
        != sequence["first_power_policy"]["bench_supply_current_limit_ma_initial"]
    ):
        raise SystemExit("core binding first-power current limit stale")

    blocks_by_id = {block["id"]: block for block in netlist["blocks"]}
    all_block_nets: set[str] = set()
    block_nets_by_id = {}
    for block_id, block in blocks_by_id.items():
        nets = flatten_net_groups(block["nets"])
        block_nets_by_id[block_id] = nets
        all_block_nets.update(nets)
    blocks = binding["schematic_blocks"]
    for block_name, block in blocks.items():
        block_id = block["block_id"]
        if block_id not in blocks_by_id:
            raise SystemExit(f"core binding references unknown block {block_id}")
        if block["package_binding"] != blocks_by_id[block_id]["package_binding"]:
            raise SystemExit(f"core binding package binding stale: {block_name}")
        missing = sorted(set(block["required_nets"]) - all_block_nets)
        if missing:
            raise SystemExit(f"core binding {block_name} missing nets {missing}")
        if not set(block["required_nets"]).issubset(block_nets_by_id[block_id] | all_block_nets):
            raise SystemExit(f"core binding {block_name} nets not represented")
        if len(block["required_local_parts"]) < 3:
            raise SystemExit(f"core binding local parts too weak: {block_name}")
        if not block["status"].startswith("blocked_"):
            raise SystemExit(f"core binding block unexpectedly open: {block_name}")

    rails = binding["rail_bindings"]
    factory_power = next(
        item for item in factory_probe["probe_domains"] if item["id"] == "power_rails"
    )
    if rails["factory_power_probe_required"] != factory_power["nets"]:
        raise SystemExit("core binding factory power probe list stale")
    if rails["factory_power_probe_required"] != sequence["rail_sequence_steps"][0]["required_nets"]:
        raise SystemExit("core binding pre-power rail list stale")
    if rails["factory_power_probe_required"] != routing["power_integrity"]["test_points_required"]:
        raise SystemExit("core binding routing rail test points stale")
    for rail in rails["always_or_input"] + rails["pmic_outputs"] + rails["display_bias"]:
        if rail not in all_block_nets:
            raise SystemExit(f"core binding rail missing from netlist: {rail}")
    high_current_names = {item["name"] for item in routing["power_integrity"]["high_current_paths"]}
    if set(rails["high_current_paths"]) != high_current_names:
        raise SystemExit("core binding high-current path set diverges")

    route_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}
    compute = binding["compute_route_bindings"]
    for group in compute["memory_diff_pairs"]["route_groups"]:
        if route_pairs[group]["max_length_mm"] != compute["memory_diff_pairs"]["max_length_mm"]:
            raise SystemExit(f"core binding memory diff length stale: {group}")
    for group in compute["ufs_diff_pairs"]["route_groups"]:
        if route_pairs[group]["max_length_mm"] != compute["ufs_diff_pairs"]["max_length_mm"]:
            raise SystemExit(f"core binding UFS diff length stale: {group}")
    if single_ended["LPDDR_CA"]["max_length_mm"] != compute["lpddr_ca_bus"]["max_length_mm"]:
        raise SystemExit("core binding LPDDR CA length stale")
    if single_ended["DEBUG_BOOT"]["max_length_mm"] != compute["debug_boot_bus"]["max_length_mm"]:
        raise SystemExit("core binding debug boot length stale")
    for group in (
        compute["memory_diff_pairs"]["route_groups"] + compute["ufs_diff_pairs"]["route_groups"]
    ):
        missing = sorted(set(route_pairs[group]["nets"]) - all_block_nets)
        if missing:
            raise SystemExit(f"core binding route group {group} missing nets {missing}")
    for bus in ["LPDDR_CA", "DEBUG_BOOT"]:
        missing = sorted(set(single_ended[bus]["nets"]) - all_block_nets)
        if missing:
            raise SystemExit(f"core binding bus {bus} missing nets {missing}")

    first_power = binding["first_power_bindings"]
    if first_power["first_power_policy"] != {
        key: sequence["first_power_policy"][key]
        for key in [
            "bench_supply_current_limit_ma_initial",
            "stop_on_overcurrent_or_unsequenced_rail",
            "oscilloscope_required",
            "thermal_camera_required_for_charge_and_modem_burst",
        ]
    }:
        raise SystemExit("core binding first-power policy stale")
    sequence_steps = {item["id"] for item in sequence["rail_sequence_steps"]}
    if not set(first_power["required_sequence_steps"]).issubset(sequence_steps):
        raise SystemExit("core binding required sequence steps stale")
    for measurement in first_power["required_measurements"]:
        if measurement not in sequence["required_measurements"]:
            raise SystemExit(f"core binding missing sequence measurement {measurement}")
    if budget["package_power_sequence_status"] != sequence["package_power_sequence_status"]:
        raise SystemExit("core binding package sequence status diverges")

    for criterion in [
        "KiCad schematic contains non-placeholder symbols for USB-PD charger battery PMIC SoC LPDDR UFS reset boot and debug",
        "factory-probe-map.yaml covers all required pre-power rails and debug or fixture alternatives are recorded",
        "ERC DRC PI load-step first-power charge-cycle and regulator-summary evidence are archived before release",
    ]:
        if criterion not in binding["evt1_capture_exit_criteria"]:
            raise SystemExit(f"core binding missing exit criterion: {criterion}")
    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"core binding cross-check failed: {key}")
    for blocker in acceptance["release_blockers"]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"core binding missing acceptance blocker: {blocker}")
    for claim in [
        "core_schematic_ready",
        "first_power_ready",
        "rail_sequence_validated",
        "charging_ready",
        "battery_safe",
        "pmic_ready",
        "memory_training_ready",
        "ufs_ready",
        "power_thermal_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"core binding missing forbidden claim {claim}")
    print(
        "core power/compute schematic net binding ok: "
        f"{len(blocks)} blocks, {len(rails['factory_power_probe_required'])} rail probes fail-closed"
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
    runtime = budget["runtime_estimates_from_selected_pack_target"]
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
    revalidation = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-source-revalidation.yaml")
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
    if revalidation["schema"] != "eliza.e1_phone_radio_module_source_revalidation.v1":
        raise SystemExit("radio module source revalidation schema diverges")
    if revalidation["status"] != "public_sources_revalidated_radio_modules_not_supplier_approved":
        raise SystemExit(f"unexpected radio module source status: {revalidation['status']}")
    context = revalidation["browser_revalidation_context"]
    if context["method"] != "manual_browser_search_and_open_on_2026_05_21":
        raise SystemExit("radio module source revalidation method is stale")
    if context["current_browser_result"]["checked_date"] != "2026-05-21":
        raise SystemExit("radio module source revalidation date is stale")
    radio_sources = {item["id"]: item for item in revalidation["revalidated_sources"]}
    required_radio_sources = {
        "cellular_primary_quectel_rg255c_vendor_page",
        "cellular_quectel_2026_product_brochure",
        "wifi_bluetooth_primary_murata_type_2ea_vendor_page",
        "wifi_bluetooth_murata_type_2ea_product_brief",
    }
    if set(radio_sources) != required_radio_sources:
        raise SystemExit("radio module source set diverges")
    cell_page = radio_sources["cellular_primary_quectel_rg255c_vendor_page"]
    if (
        cell_page["observed_public_fields"]["family"]
        not in cellular["primary_first_phone"]["family"]
    ):
        raise SystemExit("cellular vendor source family diverges from package binding")
    if (
        cell_page["observed_public_fields"]["host_interfaces"]
        != cellular["primary_first_phone"]["public_features"]["host_interfaces"]
    ):
        raise SystemExit("cellular vendor source host interfaces stale")
    cell_brochure = radio_sources["cellular_quectel_2026_product_brochure"]
    brochure_fields = cellular["primary_first_phone"]["public_2026_brochure_fields"]
    if (
        cell_brochure["observed_public_fields"]["rg255c_lga_dimensions_mm"]
        != brochure_fields["rg255c_lga_dimensions_mm"]
    ):
        raise SystemExit("cellular brochure LGA dimensions stale")
    if (
        cell_brochure["observed_public_fields"]["rm255c_gl_m2_dimensions_mm"]
        != brochure_fields["rm255c_gl_m2_dimensions_mm"]
    ):
        raise SystemExit("cellular brochure M.2 fallback dimensions stale")
    wifi_page = radio_sources["wifi_bluetooth_primary_murata_type_2ea_vendor_page"]
    if (
        wifi_page["observed_public_fields"]["order_number"]
        != wifi_bt["vendor_public_specs"]["order_number"]
    ):
        raise SystemExit("Wi-Fi/Bluetooth vendor source order number stale")
    if (
        wifi_page["observed_public_fields"]["package_mm"]
        != wifi_bt["vendor_public_specs"]["package_mm"]
    ):
        raise SystemExit("Wi-Fi/Bluetooth vendor source package dimensions stale")
    wifi_brief = radio_sources["wifi_bluetooth_murata_type_2ea_product_brief"]
    if (
        wifi_brief["observed_public_fields"]["wifi_interface"]
        != wifi_bt["vendor_public_specs"]["product_brief_public_fields"]["wifi_interface"]
    ):
        raise SystemExit("Wi-Fi/Bluetooth product brief interface fields stale")
    if (
        wifi_brief["observed_public_fields"]["wifi_max_data_rate_mbps"]
        != wifi_bt["vendor_public_specs"]["product_brief_public_fields"]["wifi_max_data_rate_mbps"]
    ):
        raise SystemExit("Wi-Fi/Bluetooth product brief data rate stale")
    for key, value in revalidation["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"radio module source revalidation cross-check failed: {key}")
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
        f"{len(interfaces)} radio interfaces, {len(radio_sources)} radio public sources, "
        f"{len(closure['required_rf_nets'])} RF nets, "
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
    if (
        closure["status"]
        != "blocked_requires_vendor_rf_review_routed_layout_and_measured_antenna_data"
    ):
        raise SystemExit(f"unexpected RF antenna coexistence status: {closure['status']}")
    if (
        "board/kicad/e1-phone/rf-antenna-coexistence-closure.yaml"
        not in manifest["current_artifacts"]["planning"]
    ):
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
        raise SystemExit(
            f"RF antenna closure references missing block nets: {sorted(rf_nets - block_nets)}"
        )

    keepouts = {item["id"]: item for item in overlay["keepouts"]}
    required_keepouts = {
        "top_antenna_keepout",
        "bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
    }
    if not required_keepouts.issubset(keepouts):
        raise SystemExit("RF antenna closure missing mechanical RF keepouts")
    for feed in feeds.values():
        if feed["keepout_ref"] not in keepouts:
            raise SystemExit(
                f"RF antenna feed keepout missing from mechanical overlay: {feed['net']}"
            )
        for key in [
            "matching_network_required",
            "conducted_access_required",
            "factory_calibration_required",
        ]:
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
    if set(production["factory_test_coverage_required"]["radios"]) != set(
        factory_domains["radios"]["nets"]
    ):
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


def check_audio_haptic_schematic_net_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/audio-haptic-schematic-net-binding.yaml")
    manifest = load_yaml(MANIFEST)
    closure = load_yaml(ROOT / "board/kicad/e1-phone/audio-acoustic-closure.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    interconnect_plan = load_yaml(ROOT / "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml")
    pin_allocation = load_yaml(ROOT / "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml")
    audio_package = load_yaml(ROOT / "package/audio/v0-codec.yaml")
    interconnect_package = load_yaml(ROOT / "package/interconnect/e1-phone-top-bottom-flex.yaml")

    if binding["schema"] != "eliza.e1_phone_audio_haptic_schematic_net_binding.v1":
        raise SystemExit(f"unexpected audio/haptic net binding schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_audio_haptic_net_binding_requires_real_schematic_acoustic_parts_route_hal_and_measurements"
    ):
        raise SystemExit(f"unexpected audio/haptic net binding status: {binding['status']}")
    rel = "board/kicad/e1-phone/audio-haptic-schematic-net-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing audio/haptic schematic net binding")
    if rel not in closure["source_artifacts"]:
        raise SystemExit("audio/acoustic closure must cite audio/haptic schematic net binding")
    for source in [
        "board/kicad/e1-phone/artifact-manifest.yaml",
        "board/kicad/e1-phone/audio-acoustic-closure.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/top-bottom-interconnect-plan.yaml",
        "board/kicad/e1-phone/split-interconnect-pin-allocation.yaml",
        "package/audio/v0-codec.yaml",
        "package/interconnect/e1-phone-top-bottom-flex.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"audio/haptic net binding missing source {source}")
        require_path(ROOT / source)

    all_block_nets: set[str] = set()
    block_nets_by_id = {}
    for block in netlist["blocks"]:
        nets = flatten_net_groups(block["nets"])
        block_nets_by_id[block["id"]] = nets
        all_block_nets.update(nets)
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}
    probe_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    cross_buses = {item["name"]: item for item in interconnect_plan["cross_island_buses"]}
    allocated_nets = {item["net"] for item in pin_allocation["pin_allocation"]}

    context = binding["interface_context"]
    components = closure["audio_components"]
    if context["codec"] != audio_package["codec"]["part"]:
        raise SystemExit("audio/haptic net binding codec stale")
    if context["smart_amp"] != audio_package["smart_amp"]["part"]:
        raise SystemExit("audio/haptic net binding smart amp stale")
    if context["microphone_part"] != components["microphone_part"]:
        raise SystemExit("audio/haptic net binding microphone part stale")
    if context["microphone_count"] != components["microphone_count"]:
        raise SystemExit("audio/haptic net binding microphone count stale")
    if context["placement_region_mm"] != components["placement_region_mm"]:
        raise SystemExit("audio/haptic net binding placement region stale")
    if context["split_board_required"] is not True:
        raise SystemExit("audio/haptic net binding must require split-board routing")

    blocks = binding["schematic_blocks"]
    expected_blocks = {
        "audio_codec",
        "smart_speaker_amp",
        "pdm_microphone_array",
        "speaker_receiver_acoustics",
        "haptic_lra_driver_or_actuator",
    }
    if set(blocks) != expected_blocks:
        raise SystemExit("audio/haptic schematic block set diverges")
    if blocks["audio_codec"]["selected_part"] != audio_package["codec"]["part"]:
        raise SystemExit("audio/haptic codec block selected part stale")
    if blocks["smart_speaker_amp"]["selected_part"] != audio_package["smart_amp"]["part"]:
        raise SystemExit("audio/haptic amp block selected part stale")
    mic = audio_package["voice_pickup"]["mics"][0]
    if blocks["pdm_microphone_array"]["selected_part"] != mic["part"]:
        raise SystemExit("audio/haptic mic block selected part stale")
    if blocks["pdm_microphone_array"]["microphone_count"] != mic["count"]:
        raise SystemExit("audio/haptic mic block count stale")
    required_audio_nets = set(closure["required_audio_nets"])
    for block_name, block in blocks.items():
        missing = sorted(net for net in block["required_nets"] if net not in all_block_nets)
        if missing:
            raise SystemExit(f"audio/haptic schematic block {block_name} missing nets {missing}")
        if not set(block["required_nets"]).issubset(required_audio_nets):
            raise SystemExit(f"audio/haptic schematic block has nets outside closure: {block_name}")
        if not block["status"].startswith("blocked_"):
            raise SystemExit(f"audio/haptic schematic block unexpectedly open: {block_name}")
        if len(block["required_local_parts"]) < 4:
            raise SystemExit(f"audio/haptic schematic block local parts too weak: {block_name}")

    host_interfaces = audio_package["host_interfaces"]
    expected_i2s = [item["contract"] for item in host_interfaces["i2s"]["signals"]]
    expected_pdm = [item["contract"] for item in host_interfaces["pdm"]["signals"]]
    expected_i2c = [item["contract"] for item in host_interfaces["i2c_control"]["signals"]]
    expected_interrupts = [item["contract"] for item in host_interfaces["interrupts"]["signals"]]
    routes = binding["net_route_bindings"]
    audio_bus = single_ended["AUDIO_I2S_PDM"]
    if routes["audio_i2s_pdm"]["nets"] != expected_i2s + expected_pdm:
        raise SystemExit("audio/haptic I2S/PDM route binding diverges from package host interface")
    for key in ["max_length_mm", "group_skew_mm_max", "keepaway"]:
        if routes["audio_i2s_pdm"][key] != audio_bus[key]:
            raise SystemExit(f"audio/haptic I2S/PDM route binding stale: {key}")
    if routes["audio_i2s_pdm"]["nets"] != audio_bus["nets"]:
        raise SystemExit("audio/haptic I2S/PDM route binding diverges from routing constraints")
    audio_i2c_irq = single_ended["AUDIO_I2C_IRQ"]
    if routes["audio_i2c_irq"]["nets"] != expected_i2c + expected_interrupts:
        raise SystemExit("audio/haptic I2C/IRQ route binding diverges from package host interface")
    if routes["audio_i2c_irq"]["nets"] != audio_i2c_irq["nets"]:
        raise SystemExit("audio/haptic I2C/IRQ route binding diverges from routing constraints")
    for key in ["max_length_mm", "pullups_to"]:
        if routes["audio_i2c_irq"][key] != audio_i2c_irq[key]:
            raise SystemExit(f"audio/haptic I2C/IRQ route binding stale: {key}")
    if not set(routes["speaker_output"]["nets"]).issubset(block_nets_by_id["U_AUDIO_HAPTIC"]):
        raise SystemExit("audio/haptic speaker output nets missing from audio block")
    if not set(routes["haptic_output"]["nets"]).issubset(all_block_nets):
        raise SystemExit("audio/haptic output route nets missing from block netlist")

    plan_audio_nets = set(cross_buses["AUDIO_DIGITAL_TO_BOTTOM_CODEC_MICS"]["nets"])
    plan_haptic_nets = set(cross_buses["HAPTIC_AND_FACTORY_TEST"]["nets"])
    plan_power_nets = set(cross_buses["POWER_FROM_TOP_CHARGER_TO_BOTTOM_IO"]["nets"])
    split_nets = set(routes["split_board_audio_haptic"]["nets"])
    if not plan_audio_nets.issubset(split_nets):
        raise SystemExit("audio/haptic split route missing planned audio cross-island nets")
    if not {"HAPTIC_OUT", "SYS", "IO_1V8"}.issubset(split_nets & plan_haptic_nets):
        raise SystemExit("audio/haptic split route missing planned haptic nets")
    if not {"VDD_AUDIO_3V3", "VDD_AMP_3V3", "GND"}.issubset(split_nets & plan_power_nets):
        raise SystemExit("audio/haptic split route missing planned audio power nets")
    if not split_nets.issubset(allocated_nets):
        missing = sorted(split_nets - allocated_nets)
        raise SystemExit(f"audio/haptic split route nets missing from pin allocation: {missing}")
    required_cross = {
        item["name"]: set(item["nets"])
        for item in interconnect_package["required_cross_island_buses"]
    }
    if not required_cross["AUDIO_DIGITAL_TO_BOTTOM_CODEC_MICS"].issubset(split_nets):
        raise SystemExit("audio/haptic split route diverges from interconnect package")
    for route_name, route in routes.items():
        missing = sorted(net for net in route["nets"] if net not in all_block_nets)
        if missing:
            raise SystemExit(f"audio/haptic route binding {route_name} missing nets {missing}")
        if route["factory_probe_required"] is not True:
            raise SystemExit(f"audio/haptic route binding must require factory probe: {route_name}")
        if not route["required_validation"]:
            raise SystemExit(f"audio/haptic route binding missing validation: {route_name}")

    probes = binding["factory_probe_bindings"]
    if probes["audio_haptics"] != probe_domains["audio_haptics"]["nets"]:
        raise SystemExit("audio/haptic factory probe binding stale")
    split_probe = set(probe_domains["split_board_interconnect"]["nets"])
    if not set(probes["split_board_interconnect_audio_haptic"]).issubset(split_probe):
        raise SystemExit("audio/haptic split-board probe binding diverges from factory map")
    for group, nets in probes.items():
        if group == "required_fixture_notes":
            continue
        missing = sorted(net for net in nets if net not in all_block_nets)
        if missing:
            raise SystemExit(f"audio/haptic probe binding {group} missing nets {missing}")
    if len(probes["required_fixture_notes"]) < 3:
        raise SystemExit("audio/haptic probe binding fixture notes too weak")

    for criterion in [
        "KiCad schematic contains non-placeholder codec, smart amp, PDM microphone, speaker or receiver, and haptic driver or actuator symbols",
        "AUDIO_I2S_PDM and AUDIO_I2C_IRQ buses use routing-constraints.yaml limits and split-board continuity review",
        "factory-probe-map.yaml covers audio, haptic, and split-board audio continuity fixtures or records fixture alternatives",
        "ALSA codec, smart-amp, PDM microphone, Android Audio HAL, speaker, microphone, and haptic measurements are attached before release",
    ]:
        if criterion not in binding["evt1_capture_exit_criteria"]:
            raise SystemExit(f"audio/haptic net binding missing exit criterion: {criterion}")
    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"audio/haptic net binding cross-check failed: {key}")
    for blocker in closure["release_blockers"]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"audio/haptic net binding missing closure blocker: {blocker}")
    for claim in [
        "audio_schematic_ready",
        "haptic_schematic_ready",
        "audio_ready",
        "speaker_ready",
        "microphone_ready",
        "haptics_ready",
        "audio_hal_ready",
        "acoustic_enclosure_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"audio/haptic net binding missing forbidden claim {claim}")
    print(
        "audio/haptic schematic net binding ok: "
        f"{len(blocks)} blocks, {len(routes)} route bindings fail-closed"
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
    if "board/kicad/e1-phone/kibot.yaml" not in closure["source_artifacts"]:
        raise SystemExit("manufacturing closure must cite the kibot config as a source artifact")
    kibot_path = ROOT / "board/kicad/e1-phone/kibot.yaml"
    require_path(kibot_path)
    kibot = load_yaml(kibot_path)
    if set(kibot) != {"kibot"} or kibot["kibot"].get("version") != 1:
        raise SystemExit(
            "kibot config is no longer a commented skeleton; update manufacturing closure "
            "evidence instead of leaving the fail-closed gate unchanged"
        )
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
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    camera_downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )

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
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    ]:
        if source not in readiness["source_artifacts"]:
            raise SystemExit(f"production readiness missing supplier source {source}")

    if (
        "RFQs sent and supplier response packs archived for every high-risk function"
        not in readiness["board_revision_policy"]["revision_lock_requires"]
    ):
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

    usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    radio_stack = radio_selection["selected_wireless_stack"]
    expected_selected_hardware = {
        "display_touch": display_downselect["selected_screen_decision"]["part"],
        "rear_front_cameras": "Sincere_First_OV13855_rear_and_GC5035_front",
        "usb_c_power_sidekeys": "_".join(
            [
                usb_stack["usb_c_evt0_connector"]["vendor"],
                usb_stack["usb_c_evt0_connector"]["family"],
                usb_stack["usb_pd_controller"]["part"],
                usb_stack["charger_power_path"]["part"],
                usb_stack["side_key_primary"]["vendor"],
                usb_stack["side_key_primary"]["family"],
            ]
        ),
        "cellular": f"{radio_stack['cellular_performance_reference']['vendor']}_"
        f"{radio_stack['cellular_performance_reference']['family']}_RedCap_reference",
        "wifi_bluetooth": f"{radio_stack['wifi_bluetooth_primary']['vendor']}_"
        f"{radio_stack['wifi_bluetooth_primary']['order_number']}",
    }
    expected_sources = {
        "display_touch": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "rear_front_cameras": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "usb_c_power_sidekeys": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "cellular": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "wifi_bluetooth": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    }
    constraints = readiness["selected_hardware_production_constraints"]
    if (
        constraints["status"]
        != "blocked_until_selected_hardware_stackup_coupon_factory_and_avl_evidence_exist"
    ):
        raise SystemExit("production readiness selected hardware constraint status stale")
    records = {item["function"]: item for item in constraints["functions"]}
    if set(records) != set(expected_selected_hardware):
        raise SystemExit("production readiness selected hardware constraint set diverges")
    if constraints["function_count"] != len(records):
        raise SystemExit("production readiness selected hardware constraint count stale")
    for function, selected in expected_selected_hardware.items():
        record = records[function]
        if record["selected_hardware"] != selected:
            raise SystemExit(f"production readiness selected hardware stale: {function}")
        if record["source_artifact"] != expected_sources[function]:
            raise SystemExit(f"production readiness selected hardware source stale: {function}")
        if not record["status"].startswith("blocked_missing_"):
            raise SystemExit(
                f"production readiness selected hardware unexpectedly open: {function}"
            )
        if not set(record["required_coupon_groups"]).issubset(readiness["impedance_coupon_plan"]):
            raise SystemExit(
                f"production readiness selected hardware coupon group unknown: {function}"
            )
        if not set(record["required_factory_coverage"]).issubset(coverage):
            raise SystemExit(f"production readiness selected hardware coverage unknown: {function}")
        if not set(record["required_production_outputs"]).issubset(
            readiness["production_output_requirements"]
        ):
            raise SystemExit(f"production readiness selected hardware output unknown: {function}")
        if len(record["required_production_outputs"]) < 3:
            raise SystemExit(
                f"production readiness selected hardware output list too weak: {function}"
            )
    if (
        camera_downselect["status"]
        != "blocked_camera_module_xy_z_downselect_requires_supplier_drawings_and_samples"
    ):
        raise SystemExit("production readiness camera downselect status unexpectedly changed")
    if radio_selection["placement_fit_decision"]["cellular_current_region"]["fits_current_region"]:
        raise SystemExit("production readiness cannot pass with unresolved cellular fit")

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


def check_evt1_stackup_impedance_coupon_plan() -> None:
    plan = load_yaml(ROOT / "board/kicad/e1-phone/evt1-stackup-impedance-coupon-plan.yaml")
    manifest = load_yaml(MANIFEST)
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    readiness = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    routed = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")

    if plan["schema"] != "eliza.e1_phone_evt1_stackup_impedance_coupon_plan.v1":
        raise SystemExit(f"unexpected EVT1 stackup coupon schema: {plan['schema']}")
    if (
        plan["status"]
        != "blocked_evt1_stackup_coupon_plan_requires_fabricator_field_solver_quote_and_trial_route"
    ):
        raise SystemExit(f"unexpected EVT1 stackup coupon status: {plan['status']}")
    artifact_path = "board/kicad/e1-phone/evt1-stackup-impedance-coupon-plan.yaml"
    if artifact_path not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("artifact manifest missing EVT1 stackup coupon plan")
    for source in [
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/route-feasibility-density.yaml",
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
    ]:
        if source not in plan["source_artifacts"]:
            raise SystemExit(f"EVT1 stackup coupon plan missing source {source}")
    if artifact_path not in readiness["source_artifacts"]:
        raise SystemExit("production readiness must cite EVT1 stackup coupon plan")
    if artifact_path not in feasibility["source_artifacts"]:
        raise SystemExit("route feasibility must cite EVT1 stackup coupon plan")
    if artifact_path not in routed["source_artifacts"]:
        raise SystemExit("routed PCB execution must cite EVT1 stackup coupon plan")

    target = plan["stackup_target"]
    if target["name"] != routing["stackup"]["target"]:
        raise SystemExit("EVT1 stackup target diverges from routing constraints")
    if target["board_thickness_mm"] != readiness["stackup_request"]["board_thickness_mm"]:
        raise SystemExit("EVT1 stackup board thickness diverges from production readiness")
    if target["layer_count"] != len(routing["stackup"]["layer_roles"]):
        raise SystemExit("EVT1 stackup layer count diverges from routing constraints")
    if target["layer_roles"] != routing["stackup"]["layer_roles"]:
        raise SystemExit("EVT1 stackup layer roles diverge from routing constraints")
    if not target["hdi_assumptions"]["microvias_or_via_in_pad_allowed_for_soc_memory_escape"]:
        raise SystemExit("EVT1 stackup must allow HDI escape for SoC/memory")
    if target["hdi_assumptions"]["final_trace_width_gap_source"] != "fabricator_field_solver":
        raise SystemExit("EVT1 stackup must keep final trace geometry field-solver sourced")

    block_nets: set[str] = set()
    for block in netlist["blocks"]:
        block_nets.update(flatten_net_groups(block["nets"]))

    coupons = plan["impedance_coupon_requests"]
    readiness_coupons = readiness["impedance_coupon_plan"]
    if set(coupons) != set(readiness_coupons):
        raise SystemExit("EVT1 stackup coupon groups diverge from production readiness")
    expected_classes = {
        "usb2_90_ohm": "usb2_diff",
        "mipi_dphy_100_ohm": "mipi_dphy_diff",
        "pcie_85_ohm": "pcie_diff",
        "rf_50_ohm": "rf_single",
    }
    for name, coupon in coupons.items():
        if not coupon["fabricator_field_solver_required"]:
            raise SystemExit(f"EVT1 coupon must require field solver: {name}")
        if not coupon["coupon_id"].startswith("E1_EVT1_CPN_"):
            raise SystemExit(f"EVT1 coupon id is not namespaced: {name}")
        if coupon["required_nets"] != readiness_coupons[name]["nets"]:
            raise SystemExit(f"EVT1 coupon nets diverge from production readiness: {name}")
        missing = sorted(net for net in coupon["required_nets"] if net not in block_nets)
        if missing:
            raise SystemExit(f"EVT1 coupon {name} references missing nets {missing}")
        if name in expected_classes:
            klass = routing["impedance_classes"][expected_classes[name]]
            if coupon["routing_class"] != expected_classes[name]:
                raise SystemExit(f"EVT1 coupon routing class stale: {name}")
            if coupon["target_impedance_ohm"] != klass["impedance_ohm"]:
                raise SystemExit(f"EVT1 coupon impedance diverges from routing constraints: {name}")
            if coupon["tolerance_pct"] != klass["tolerance_pct"]:
                raise SystemExit(f"EVT1 coupon tolerance diverges from routing constraints: {name}")

    reports = feasibility["trial_route_exit_criteria"]["required_measurements_or_reports"]
    if "evt1_stackup_coupon_plan_cross_check" not in reports:
        raise SystemExit("route feasibility missing EVT1 stackup coupon cross-check report")
    for requirement in [
        "fabricator stackup drawing with dielectric constants and loss tangent",
        "field-solved trace width and gap table for every coupon ID",
        "impedance coupon geometry and panel placement",
    ]:
        if requirement not in plan["quote_package_requirements"]:
            raise SystemExit(f"EVT1 stackup quote package missing requirement: {requirement}")
    bindings = plan["route_release_bindings"]
    if not bindings["blocks_fabrication_claims_until_fabricator_response"]:
        raise SystemExit(
            "EVT1 stackup plan must block fabrication claims until fabricator response"
        )
    if not bindings["blocks_enclosure_claims_until_routed_step_clearance_rerun"]:
        raise SystemExit("EVT1 stackup plan must block enclosure claims until routed STEP rerun")
    for key, value in plan["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"EVT1 stackup cross-check failed: {key}")
    for blocker in [
        "fabricator field-solver stackup and impedance table are missing",
        "coupon drawings and panel placement are missing",
        "routed copper, DRC, and length/skew reports are missing",
    ]:
        if blocker not in plan["release_blockers"]:
            raise SystemExit(f"EVT1 stackup plan missing blocker: {blocker}")
    for claim in [
        "stackup_approved",
        "impedance_closed",
        "coupon_ready",
        "trial_route_ready",
        "routed_pcb_ready",
        "fabrication_ready",
        "enclosure_ready",
    ]:
        if claim not in plan["forbidden_claims"]:
            raise SystemExit(f"EVT1 stackup plan missing forbidden claim {claim}")
    print(
        "EVT1 stackup/coupon plan ok: "
        f"{target['layer_count']} layers, {len(coupons)} coupon groups fail-closed"
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
    if (
        "board/kicad/e1-phone/factory-probe-map.yaml"
        not in manifest["current_artifacts"]["planning"]
    ):
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
        "board/kicad/e1-phone/production/test/fixture-quote/traceability-and-programming-flow.pdf",
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

    if (
        domains["power_rails"]["nets"]
        != manufacturing["required_test_points_from_routing_constraints"]
    ):
        raise SystemExit("factory probe power rail nets diverge from manufacturing test points")
    if (
        domains["power_rails"]["nets"]
        != production["factory_test_coverage_required"]["power_rails"]
    ):
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
        "secure provisioning and traceability flow pending factory process definition",
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
    routing_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml")
    power_bringup = load_yaml(ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml")
    supplier = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    production_factory = load_yaml(
        ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml"
    )
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    camera_downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )

    if acceptance["schema"] != "eliza.e1_phone_factory_production_acceptance_checklist.v1":
        raise SystemExit("factory production acceptance schema diverges")
    if (
        acceptance["status"]
        != "blocked_factory_production_acceptance_requires_routed_outputs_fixture_limits_quotes_and_first_article"
    ):
        raise SystemExit(f"unexpected factory production acceptance status: {acceptance['status']}")
    for source in [
        "board/kicad/e1-phone/production-readiness.yaml",
        "board/kicad/e1-phone/manufacturing-closure.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/routing-acceptance-checklist.yaml",
        "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml",
        "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/production-factory-release-execution.yaml",
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
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
    if summary["factory_coverage_group_count"] != len(production["factory_test_coverage_required"]):
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
        if (
            item["status"]
            != "blocked_missing_routed_outputs_fixture_limits_quotes_or_first_article_evidence"
        ):
            raise SystemExit(f"factory production acceptance item unexpectedly open: {item_id}")
        if not item.get("required_evidence") or not item.get("blocker"):
            raise SystemExit(f"factory production acceptance item too weak: {item_id}")

    expected_usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    expected_radio_stack = radio_selection["selected_wireless_stack"]
    expected_selected_hardware = {
        "display_touch": display_downselect["selected_screen_decision"]["part"],
        "rear_front_cameras": "Sincere_First_OV13855_rear_and_GC5035_front",
        "usb_c_power_sidekeys": "_".join(
            [
                expected_usb_stack["usb_c_evt0_connector"]["vendor"],
                expected_usb_stack["usb_c_evt0_connector"]["family"],
                expected_usb_stack["usb_pd_controller"]["part"],
                expected_usb_stack["charger_power_path"]["part"],
                expected_usb_stack["side_key_primary"]["vendor"],
                expected_usb_stack["side_key_primary"]["family"],
            ]
        ),
        "cellular": f"{expected_radio_stack['cellular_performance_reference']['vendor']}_"
        f"{expected_radio_stack['cellular_performance_reference']['family']}_RedCap_reference",
        "wifi_bluetooth": f"{expected_radio_stack['wifi_bluetooth_primary']['vendor']}_"
        f"{expected_radio_stack['wifi_bluetooth_primary']['order_number']}",
    }
    expected_sources = {
        "display_touch": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "rear_front_cameras": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "usb_c_power_sidekeys": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "cellular": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "wifi_bluetooth": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    }
    selected_acceptance = acceptance["selected_hardware_factory_acceptance"]
    production_coupling = {
        item["function"]: item
        for item in production_factory["selected_hardware_release_coupling"]["functions"]
    }
    selected_records = {item["function"]: item for item in selected_acceptance["functions"]}
    if (
        selected_acceptance["status"]
        != "blocked_until_selected_hardware_fixture_limits_identity_and_first_article_signoff_exist"
    ):
        raise SystemExit("factory selected hardware acceptance status stale")
    if (
        selected_acceptance["source_coupling"]
        != "board/kicad/e1-phone/production-factory-release-execution.yaml"
    ):
        raise SystemExit("factory selected hardware acceptance source coupling stale")
    if set(selected_records) != set(expected_selected_hardware):
        raise SystemExit("factory selected hardware acceptance set diverges")
    if selected_acceptance["function_count"] != len(selected_records):
        raise SystemExit("factory selected hardware acceptance count stale")
    for function, selected in expected_selected_hardware.items():
        record = selected_records[function]
        if record["selected_hardware"] != selected:
            raise SystemExit(f"factory selected hardware stale: {function}")
        if record["source_artifact"] != expected_sources[function]:
            raise SystemExit(f"factory selected hardware source stale: {function}")
        if record["selected_hardware"] != production_coupling[function]["selected_hardware"]:
            raise SystemExit(
                f"factory selected hardware diverges from production coupling: {function}"
            )
        if not record["status"].startswith("blocked_missing_"):
            raise SystemExit(f"factory selected hardware acceptance unexpectedly open: {function}")
        if not set(record["required_acceptance_items"]).issubset(acceptance_items):
            raise SystemExit(
                f"factory selected hardware references unknown acceptance item: {function}"
            )
        if not set(record["required_fixture_domains"]).issubset(probe_domain_ids):
            raise SystemExit(
                f"factory selected hardware references unknown fixture domain: {function}"
            )
        if len(record["required_acceptance_items"]) < 5:
            raise SystemExit(f"factory selected hardware acceptance too weak: {function}")
    if (
        camera_downselect["status"]
        != "blocked_camera_module_xy_z_downselect_requires_supplier_drawings_and_samples"
    ):
        raise SystemExit("factory selected hardware camera downselect status unexpectedly changed")
    if radio_selection["placement_fit_decision"]["cellular_current_region"]["fits_current_region"]:
        raise SystemExit("factory selected hardware cannot pass with unresolved cellular fit")

    for key, value in acceptance["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"factory production acceptance cross-check failed: {key}")
    for blocker in [
        "routed DRC-clean PCB and production fabrication outputs are missing",
        "production BOM/AVL, pick-and-place, assembly drawings, stencil, and supplier approval packs are missing",
        "factory fixture coordinates, factory limits, RF calibration, traceability, and first-article transcript are missing",
        "selected display, camera, USB-C/power/side-key, cellular, and Wi-Fi/Bluetooth factory acceptance evidence is missing",
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
    execution = load_yaml(ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    supplier = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    routed_pcb = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    camera_downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
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
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
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
            raise SystemExit(
                f"production/factory release output has unknown acceptance item: {output_id}"
            )

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
    if (
        fixture["fixture_outputs_required"]
        != factory_probe["fixture_policy"]["outputs_required_before_release"]
    ):
        raise SystemExit("production/factory fixture outputs diverge from factory probe policy")
    probe_domains = [item["id"] for item in factory_probe["probe_domains"]]
    if fixture["probe_domains_blocked"] != probe_domains:
        raise SystemExit("production/factory probe domain execution stale")
    if set(probe_domains) != set(production["factory_test_coverage_required"]):
        raise SystemExit("production/factory probe domains diverge from production coverage")

    expected_usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    expected_radio_stack = radio_selection["selected_wireless_stack"]
    expected_selected_hardware = {
        "display_touch": display_downselect["selected_screen_decision"]["part"],
        "rear_front_cameras": "Sincere_First_OV13855_rear_and_GC5035_front",
        "usb_c_power_sidekeys": "_".join(
            [
                expected_usb_stack["usb_c_evt0_connector"]["vendor"],
                expected_usb_stack["usb_c_evt0_connector"]["family"],
                expected_usb_stack["usb_pd_controller"]["part"],
                expected_usb_stack["charger_power_path"]["part"],
                expected_usb_stack["side_key_primary"]["vendor"],
                expected_usb_stack["side_key_primary"]["family"],
            ]
        ),
        "cellular": f"{expected_radio_stack['cellular_performance_reference']['vendor']}_"
        f"{expected_radio_stack['cellular_performance_reference']['family']}_RedCap_reference",
        "wifi_bluetooth": f"{expected_radio_stack['wifi_bluetooth_primary']['vendor']}_"
        f"{expected_radio_stack['wifi_bluetooth_primary']['order_number']}",
    }
    expected_sources = {
        "display_touch": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "rear_front_cameras": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "usb_c_power_sidekeys": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "cellular": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "wifi_bluetooth": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    }
    coupling = execution["selected_hardware_release_coupling"]
    if (
        coupling["status"]
        != "blocked_until_selected_hardware_identity_avl_fixture_and_first_article_evidence_exist"
    ):
        raise SystemExit("production/factory selected hardware coupling status stale")
    records = {item["function"]: item for item in coupling["functions"]}
    if set(records) != set(expected_selected_hardware):
        raise SystemExit("production/factory selected hardware coupling set diverges")
    if coupling["function_count"] != len(records):
        raise SystemExit("production/factory selected hardware coupling count stale")
    for function, selected in expected_selected_hardware.items():
        record = records[function]
        if record["selected_hardware"] != selected:
            raise SystemExit(f"production/factory selected hardware stale: {function}")
        if record["source_artifact"] != expected_sources[function]:
            raise SystemExit(f"production/factory selected hardware source stale: {function}")
        if not record["status"].startswith("blocked_missing_selected_"):
            raise SystemExit(f"production/factory selected hardware unexpectedly open: {function}")
        for output_id in record["required_release_outputs"]:
            if output_id not in release_outputs:
                raise SystemExit(
                    f"production/factory selected hardware unknown release output: {function} {output_id}"
                )
            if release_outputs[output_id]["present"] is not False:
                raise SystemExit(
                    f"production/factory selected hardware output unexpectedly present: {function} {output_id}"
                )
        for domain in record["required_fixture_domains"]:
            if domain not in probe_domains:
                raise SystemExit(
                    f"production/factory selected hardware unknown fixture domain: {function} {domain}"
                )
        if len(record["required_traceability"]) < 3:
            raise SystemExit(
                f"production/factory selected hardware traceability too weak: {function}"
            )
    if (
        camera_downselect["status"]
        != "blocked_camera_module_xy_z_downselect_requires_supplier_drawings_and_samples"
    ):
        raise SystemExit("production/factory camera downselect status unexpectedly changed")
    if radio_selection["placement_fit_decision"]["cellular_current_region"]["fits_current_region"]:
        raise SystemExit(
            "production/factory cannot release while selected cellular region fit is unresolved"
        )

    for key, value in execution["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"production/factory release execution cross-check failed: {key}")
    for blocker in [
        "routed KiCad PCB, ERC, DRC, zones, and route reports are missing",
        "supplier response packs, signed drawings, pinouts, footprints, STEP models, and AVL are missing",
        "fabrication, assembly, stackup, impedance, DFM/DFA, and quote outputs are missing",
        "fixture coordinates, factory limits, RF calibration procedure, and first-article transcript are missing",
        "selected display, camera, USB-C/power/side-key, cellular, and Wi-Fi/Bluetooth production traceability evidence is missing",
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
            raise SystemExit(
                f"production/factory release execution missing forbidden claim {claim}"
            )
    print(
        "production/factory release execution ok: "
        f"{len(release_outputs)} release outputs, {len(probe_domains)} probe domains blocked"
    )


def check_pcb_implementation_audit() -> None:
    audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    placement = load_yaml(ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml")
    manifest = load_yaml(MANIFEST)
    pcb_path = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
    pcb_text = pcb_path.read_text()

    if audit["schema"] != "eliza.e1_phone_pcb_implementation_audit.v1":
        raise SystemExit("PCB implementation audit schema diverges")
    if audit["status"] != "blocked_live_kicad_pcb_scaffold_audited_not_routed":
        raise SystemExit(f"unexpected PCB implementation audit status: {audit['status']}")
    rel = "board/kicad/e1-phone/pcb-implementation-audit.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing PCB implementation audit artifact")
    for source in audit["source_artifacts"]:
        require_path(ROOT / source)

    counts = audit["live_pcb_counts"]
    live_footprint_count = len(re.findall(r'\(footprint "E1Phone:', pcb_text))
    live_segment_count = len(re.findall(r"\n\s*\(segment\b", pcb_text))
    live_arc_count = len(re.findall(r"\n\s*\(arc\b", pcb_text))
    live_zone_count = len(re.findall(r"\n\s*\(zone\b", pcb_text))
    live_keepout_zone_count = len(re.findall(r"\n\s*\(keepout\b", pcb_text))
    live_copper_zone_count = live_zone_count - live_keepout_zone_count
    if counts["footprint_count"] != live_footprint_count:
        raise SystemExit("PCB implementation audit footprint count stale")
    if counts["segment_count"] != live_segment_count:
        raise SystemExit("PCB implementation audit segment count stale")
    if counts["arc_count"] != live_arc_count:
        raise SystemExit("PCB implementation audit arc count stale")
    if counts["zone_count"] != live_copper_zone_count:
        raise SystemExit("PCB implementation audit copper zone count stale")
    if counts["keepout_zone_count"] != live_keepout_zone_count:
        raise SystemExit("PCB implementation audit keepout zone count stale")
    if counts["segment_count"] or counts["arc_count"] or counts["zone_count"]:
        raise SystemExit(
            "PCB implementation audit cannot remain scaffold-only after routed copper appears"
        )
    if counts["test_point_count"] != len(routing["power_integrity"]["test_points_required"]):
        raise SystemExit(
            "PCB implementation audit test-point count diverges from routing constraints"
        )
    if counts["rf_feed_count"] != len(routing["rf_layout"]["matching_networks_required"]):
        raise SystemExit("PCB implementation audit RF feed count diverges from routing constraints")

    net_coverage = audit["net_coverage"]
    for key in [
        "missing_block_netlist_nets",
        "extra_named_pcb_nets",
        "missing_routing_constraint_diff_pair_nets",
    ]:
        if net_coverage[key]:
            raise SystemExit(f"PCB implementation audit net coverage gap: {key}")

    placement_count = len(placement["placements"])
    if audit["placement_coverage"]["placement_group_count"] != placement_count:
        raise SystemExit("PCB implementation audit placement group count stale")
    if audit["placement_coverage"]["missing_placement_placeholder_footprints"]:
        raise SystemExit("PCB implementation audit missing placement placeholders")

    net_classes = audit["net_class_coverage"]
    required_classes = {
        "E1Phone_USB2_90R",
        "E1Phone_MIPI_DPHY_100R",
        "E1Phone_PCIE_85R",
        "E1Phone_RF_50R",
        "E1Phone_SDIO_50R",
        "E1Phone_LPDDR_LENGTH_MATCHED",
        "E1Phone_UFS_MPHY",
        "E1Phone_POWER",
        "E1Phone_USB_CC_PD_CONTROL",
        "E1Phone_DISPLAY_CAMERA_CONTROL",
        "E1Phone_WIRELESS_CONTROL_BT_UART",
        "E1Phone_POWER_SENSE_CONTROL",
        "E1Phone_DEBUG_BOOT",
        "E1Phone_AUDIO_CONTROL_AON",
        "E1Phone_AUDIO_ANALOG_HAPTIC",
        "E1Phone_SIM_NFC_SENSOR",
    }
    if set(net_classes["required_net_classes"]) != required_classes:
        raise SystemExit("PCB implementation audit required net-class set diverges")
    for key in ["missing_net_classes", "unassigned_named_nets", "duplicate_net_class_assignments"]:
        if net_classes[key]:
            raise SystemExit(f"PCB implementation audit net-class coverage gap: {key}")
    if (
        sum(net_classes["net_class_membership_counts"].values())
        != counts["explicitly_classed_net_count"]
    ):
        raise SystemExit("PCB implementation audit net-class membership count stale")

    keepouts = audit["keepout_zone_coverage"]
    required_keepouts = {
        "battery_window",
        "bottom_antenna",
        "display_fpc_bend",
        "front_camera_earpiece",
        "haptic_lra",
        "loudspeaker_mic_ports",
        "rear_camera",
        "side_buttons",
        "sim_tray",
        "top_antenna",
        "usb_c_shell",
    }
    if set(keepouts["required_keepout_zones"]) != required_keepouts:
        raise SystemExit("PCB implementation audit required keepout set diverges")
    if set(keepouts["present_keepout_zones"]) != required_keepouts:
        raise SystemExit("PCB implementation audit present keepout set diverges")
    if keepouts["missing_keepout_zones"] or keepouts["copper_zone_count"] != 0:
        raise SystemExit("PCB implementation audit keepout/copper-zone coverage changed")

    support_groups = audit["objective_support_group_coverage"]
    expected_groups = {
        "usb_c",
        "side_keys",
        "display_touch",
        "cameras",
        "radios",
        "audio_haptics",
        "power_management",
        "compute_storage_debug",
        "identity_sensor",
    }
    if set(support_groups) != expected_groups:
        raise SystemExit("PCB implementation audit objective support groups diverge")
    for group, item in support_groups.items():
        if item["present"] is not True or item["missing"]:
            raise SystemExit(f"PCB implementation audit support group incomplete: {group}")
        if len(item["required_footprints"]) < 3:
            raise SystemExit(f"PCB implementation audit support group too weak: {group}")

    split = audit["split_interconnect_status"]
    for refdes in ["J_TOP_BOTTOM_FLEX_TOP", "J_TOP_BOTTOM_FLEX_BOTTOM"]:
        item = split[refdes]
        if item["present"] is not True:
            raise SystemExit(f"PCB implementation audit split connector missing: {refdes}")
        if item["pad_count"] < item["required_min_pads"] or item["required_min_pads"] != 49:
            raise SystemExit(f"PCB implementation audit split connector pad budget stale: {refdes}")
        if not all(item["critical_nets_present"].values()):
            raise SystemExit(
                f"PCB implementation audit split connector missing critical nets: {refdes}"
            )

    board_state = audit["board_state"]
    expected_board_state = {
        "has_tracks": False,
        "has_filled_zones": False,
        "has_keepout_zones": True,
        "has_real_production_outputs": False,
    }
    if board_state != expected_board_state:
        raise SystemExit("PCB implementation audit board state changed")
    manufacturing_state = manufacturing["board_state_detected"]
    if board_state["has_tracks"] != manufacturing_state["has_tracks"]:
        raise SystemExit("PCB implementation audit track state diverges from manufacturing closure")
    if board_state["has_filled_zones"] != manufacturing_state["has_filled_zones"]:
        raise SystemExit("PCB implementation audit zone state diverges from manufacturing closure")
    if board_state["has_real_production_outputs"] != manufacturing_state["has_production_outputs"]:
        raise SystemExit("PCB implementation audit production output state diverges")
    if production["status"] != "blocked_requires_routed_board_supplier_data_and_factory_quotes":
        raise SystemExit("PCB implementation audit production readiness unexpectedly unblocked")

    for key, value in audit["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"PCB implementation audit cross-check failed: {key}")
    for output in [
        "board/kicad/e1-phone/production/reports/pcb-implementation-audit.yaml",
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb",
        "board/kicad/e1-phone/production/reports/drc.json",
        "board/kicad/e1-phone/production/reports/erc.json",
        "board/kicad/e1-phone/production/reports/routed-courtyard-utilization.yaml",
        "board/kicad/e1-phone/production/step/routed-board-with-components.step",
    ]:
        if output not in audit["required_release_outputs"]:
            raise SystemExit(f"PCB implementation audit missing release output {output}")
    for blocker in [
        "production concept source has no release-approved routed copper segments or filled zones",
        "supplier connector/module land patterns and STEP models have not replaced placeholders",
        "DRC, ERC, SI/PI, RF, fabrication, assembly, and routed enclosure clearance evidence are missing",
    ]:
        if blocker not in audit["release_blockers"]:
            raise SystemExit(f"PCB implementation audit missing release blocker: {blocker}")
    for claim in [
        "routed_pcb_ready",
        "supplier_footprints_loaded",
        "drc_clean",
        "erc_clean",
        "production_outputs_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in audit["forbidden_claims"]:
            raise SystemExit(f"PCB implementation audit missing forbidden claim {claim}")
    print(
        "PCB implementation audit ok: "
        f"{counts['footprint_count']} placeholders, {counts['declared_net_count']} nets, "
        "0 routed segments fail-closed"
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
    radio_antenna = load_yaml(ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml")
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
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/module-host-integration-acceptance-checklist.yaml",
        "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/radio-module-schematic-net-binding.yaml",
        "package/cellular/quectel-5g-redcap.yaml",
        "package/wifi/murata-type-2ea-wifi6e.yaml",
    ]:
        if source not in execution["source_artifacts"]:
            raise SystemExit(f"module RF pinout execution missing source {source}")

    blocks = {block["id"]: block for block in block_netlist["blocks"]}
    block_nets = {block_id: flatten_net_groups(block["nets"]) for block_id, block in blocks.items()}
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
    traceability = execution["factory_firmware_identity_execution"]["traceability_fields_required"]
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


def check_radio_module_schematic_net_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-schematic-net-binding.yaml")
    integration = load_yaml(ROOT / "board/kicad/e1-phone/radio-module-integration.yaml")
    execution = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")
    module_host = load_yaml(ROOT / "board/kicad/e1-phone/module-host-integration-closure.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    block_netlist = load_yaml(ROOT / "board/kicad/e1-phone/block-netlist.yaml")
    cellular = load_yaml(ROOT / "package/cellular/quectel-5g-redcap.yaml")
    wifi_bt = load_yaml(ROOT / "package/wifi/murata-type-2ea-wifi6e.yaml")
    manifest = load_yaml(MANIFEST)

    if binding["schema"] != "eliza.e1_phone_radio_module_schematic_net_binding.v1":
        raise SystemExit(f"unexpected radio module net binding schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_radio_module_net_binding_requires_supplier_pinouts_real_schematic_rf_route_firmware_and_factory_evidence"
    ):
        raise SystemExit(f"unexpected radio module net binding status: {binding['status']}")
    rel = "board/kicad/e1-phone/radio-module-schematic-net-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing radio module schematic net binding")
    if rel not in integration["source_artifacts"]:
        raise SystemExit("radio module integration must cite schematic net binding")
    if rel not in execution["source_artifacts"]:
        raise SystemExit("module RF pinout execution must cite schematic net binding")
    for source in [
        "board/kicad/e1-phone/radio-module-integration.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/module-rf-pinout-execution.yaml",
        "board/kicad/e1-phone/module-host-integration-closure.yaml",
        "board/kicad/e1-phone/rf-connectivity-closure.yaml",
        "board/kicad/e1-phone/routing-constraints.yaml",
        "board/kicad/e1-phone/factory-probe-map.yaml",
        "board/kicad/e1-phone/block-netlist.yaml",
        "package/cellular/quectel-5g-redcap.yaml",
        "package/wifi/murata-type-2ea-wifi6e.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"radio module net binding missing source {source}")
        require_path(ROOT / source)

    all_block_nets: set[str] = set()
    block_nets_by_id = {}
    for block in block_netlist["blocks"]:
        nets = flatten_net_groups(block["nets"])
        block_nets_by_id[block["id"]] = nets
        all_block_nets.update(nets)
    route_pairs = {item["name"]: item for item in routing["differential_pairs"]}
    single_ended = {item["name"]: item for item in routing["single_ended_buses"]}
    probe_domains = {item["id"]: item for item in factory_probe["probe_domains"]}
    execution_records = {item["id"]: item for item in execution["module_pinout_execution"]}
    host_records = {item["id"]: item for item in module_host["integration_records"]}
    rf_feeds = {item["net"]: item for item in execution["rf_feed_execution"]}

    context = binding["interface_context"]
    if context["cellular"]["vendor"] != cellular["primary_first_phone"]["vendor"]:
        raise SystemExit("radio module net binding cellular vendor stale")
    if context["cellular"]["family"] != cellular["primary_first_phone"]["family"]:
        raise SystemExit("radio module net binding cellular family stale")
    if (
        context["cellular"]["placement_region_mm"]
        != integration["module_integration"]["cellular_5g_redcap"]["placement"]["region_mm"]
    ):
        raise SystemExit("radio module net binding cellular placement stale")
    if context["wifi_bluetooth"]["vendor"] != wifi_bt["vendor_public_specs"]["vendor"]:
        raise SystemExit("radio module net binding Wi-Fi/Bluetooth vendor stale")
    if context["wifi_bluetooth"]["order_number"] != wifi_bt["vendor_public_specs"]["order_number"]:
        raise SystemExit("radio module net binding Wi-Fi/Bluetooth order number stale")
    if context["wifi_bluetooth"]["chipset"] != wifi_bt["vendor_public_specs"]["chipset"]:
        raise SystemExit("radio module net binding Wi-Fi/Bluetooth chipset stale")
    if (
        context["wifi_bluetooth"]["placement_region_mm"]
        != integration["module_integration"]["wifi6e_bluetooth_5p3"]["placement"]["region_mm"]
    ):
        raise SystemExit("radio module net binding Wi-Fi/Bluetooth placement stale")

    blocks = binding["schematic_blocks"]
    if set(blocks) != set(execution_records):
        raise SystemExit("radio module net binding schematic block set diverges")
    for module_id, block in blocks.items():
        source = execution_records[module_id]
        for key in [
            "refdes_group",
            "package_binding",
            "required_host_contracts",
            "required_power_control_nets",
            "required_rf_nets",
            "status",
        ]:
            if block[key] != source[key]:
                raise SystemExit(f"radio module net binding stale for {module_id}: {key}")
        if module_id == "cellular_5g_redcap_module":
            if block["selected_family"] != source["selected_family"]:
                raise SystemExit("radio module net binding cellular selected family stale")
            if block["sim_esim_nets"] != source["sim_esim_nets"]:
                raise SystemExit("radio module net binding SIM/eSIM nets stale")
        else:
            if block["selected_order_number"] != source["selected_order_number"]:
                raise SystemExit("radio module net binding Wi-Fi/Bluetooth selected order stale")
        required = (
            set(block["required_host_contracts"])
            | set(block["required_power_control_nets"])
            | set(block["required_rf_nets"])
            | set(block.get("sim_esim_nets", []))
        )
        missing = sorted(required - all_block_nets)
        if missing:
            raise SystemExit(f"radio module net binding {module_id} missing nets {missing}")
        if len(block["required_local_parts"]) < 4:
            raise SystemExit(f"radio module net binding local parts too weak: {module_id}")
        host_id = (
            "cellular_5g_redcap_module"
            if module_id.startswith("cellular")
            else "wifi_bluetooth_module"
        )
        if len(block["required_host_contracts"]) > host_records[host_id]["host_contract_count"]:
            raise SystemExit(
                f"radio module net binding host contract count impossible: {module_id}"
            )

    routes = binding["host_route_bindings"]
    route_expectations = {
        "cellular_usb2": ("usb2_diff", 90),
        "cellular_pcie": ("pcie_diff", 85),
        "wifi_pcie": ("pcie_diff", 85),
    }
    for route_name, (klass_name, impedance) in route_expectations.items():
        route = routes[route_name]
        if route["impedance_class"] != klass_name:
            raise SystemExit(f"radio module route class stale: {route_name}")
        if route["target_impedance_ohm_diff"] != impedance:
            raise SystemExit(f"radio module route impedance stale: {route_name}")
        for group_name in route["route_groups"]:
            pair = route_pairs[group_name]
            if pair["class"] != klass_name:
                raise SystemExit(f"radio module route group class diverges: {group_name}")
            if not set(pair["nets"]).issubset(all_block_nets):
                raise SystemExit(f"radio module route group nets missing: {group_name}")
    if routes["wifi_sdio_fallback"]["single_ended_bus"] != "WIFI_SDIO":
        raise SystemExit("radio module Wi-Fi SDIO fallback route stale")
    if single_ended["WIFI_SDIO"]["max_length_mm"] != 35:
        raise SystemExit("radio module Wi-Fi SDIO length constraint changed unexpectedly")
    if routes["sim_esim"]["single_ended_bus"] != "USIM_ESIM":
        raise SystemExit("radio module SIM/eSIM route stale")
    if not set(single_ended["USIM_ESIM"]["nets"]).issubset(block_nets_by_id["U_SIM_ESIM"]):
        raise SystemExit("radio module SIM/eSIM route nets missing from block")

    rf_bindings = binding["rf_feed_bindings"]
    if set(rf_bindings) != set(rf["required_rf_nets"]):
        raise SystemExit("radio module RF binding set diverges from RF closure")
    for net, item in rf_bindings.items():
        feed = rf_feeds[net]
        for key in ["role", "near"]:
            if item[key] != feed[key]:
                raise SystemExit(f"radio module RF binding stale for {net}: {key}")
        if item["impedance_ohm"] != routing["impedance_classes"]["rf_single"]["impedance_ohm"]:
            raise SystemExit(f"radio module RF impedance stale: {net}")
        if item["requires_matching_network"] != feed["requires_pi_or_t_matching_network"]:
            raise SystemExit(f"radio module RF matching requirement stale: {net}")
        if (
            item["requires_conducted_access_before_matching"]
            != feed["requires_conducted_access_before_matching"]
        ):
            raise SystemExit(f"radio module RF conducted access stale: {net}")
        if net not in all_block_nets:
            raise SystemExit(f"radio module RF net missing from block netlist: {net}")

    probes = binding["factory_probe_bindings"]
    if probes["radios"] != probe_domains["radios"]["nets"]:
        raise SystemExit("radio module factory radio probe binding stale")
    if (
        probes["identity_traceability"]
        != factory_probe["fixture_policy"]["operator_visible_traceability_required"]
    ):
        raise SystemExit("radio module identity traceability stale")
    factory_exec = execution["factory_firmware_identity_execution"]
    if probes["identity_traceability"] != factory_exec["traceability_fields_required"]:
        raise SystemExit("radio module identity execution traceability stale")
    if probes["required_test_modes"] != factory_exec["factory_test_modes_missing"]:
        raise SystemExit("radio module factory test mode list stale")
    for net in probes["radios"]:
        if net not in all_block_nets:
            raise SystemExit(f"radio module factory probe net missing from netlist: {net}")

    for criterion in [
        "KiCad schematic contains non-placeholder cellular Wi-Fi Bluetooth SIM/eSIM RF matching and conducted-access symbols",
        "cellular USB2 PCIe SIM/eSIM and Wi-Fi PCIe SDIO Bluetooth UART nets are assigned to reviewed pins",
        "all RF feeds have 50 ohm geometry matching networks conducted access via fence and ground-reference review",
        "factory test can read modem identity Wi-Fi MAC Bluetooth MAC SIM/eSIM status and RF calibration results",
    ]:
        if criterion not in binding["evt1_capture_exit_criteria"]:
            raise SystemExit(f"radio module net binding missing exit criterion: {criterion}")
    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"radio module net binding cross-check failed: {key}")
    for blocker in execution["release_blockers"]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"radio module net binding missing execution blocker: {blocker}")
    for claim in [
        "cellular_schematic_ready",
        "wifi_bluetooth_schematic_ready",
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
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"radio module net binding missing forbidden claim {claim}")
    print(
        "radio module schematic net binding ok: "
        f"{len(blocks)} modules, {len(rf_bindings)} RF feeds fail-closed"
    )


def check_routed_release_plan() -> None:
    plan = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    manifest = load_yaml(ROOT / "board/kicad/e1-phone/artifact-manifest.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    module_rf_pinout = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")

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


def check_routed_board_step_export_contract() -> None:
    contract = load_yaml(ROOT / "board/kicad/e1-phone/routed-board-step-export-contract.yaml")
    manifest = load_yaml(MANIFEST)
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    routed_execution = load_yaml(
        ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"
    )
    component_height = load_yaml(
        ROOT / "board/kicad/e1-phone/component-height-step-integration.yaml"
    )
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )
    enclosure_fit = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")
    layout_utilization = load_yaml(ROOT / "board/kicad/e1-phone/layout-utilization.yaml")
    board_step = load_yaml(ROOT / "mechanical/e1-phone/review/board-step-readiness.json")
    routed_clearance = load_yaml(ROOT / "mechanical/e1-phone/review/routed-board-clearance.json")
    full_cad_boolean = load_yaml(
        ROOT / "mechanical/e1-phone/review/full-cad-boolean-interference.json"
    )

    rel = "board/kicad/e1-phone/routed-board-step-export-contract.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing routed board STEP export contract")
    if contract["schema"] != "eliza.e1_phone_routed_board_step_export_contract.v1":
        raise SystemExit("routed board STEP export contract schema diverges")
    if (
        contract["status"]
        != "blocked_requires_routed_kicad_step_supplier_3d_models_and_clearance_rerun"
    ):
        raise SystemExit(f"unexpected routed board STEP export status: {contract['status']}")
    for source in contract["source_artifacts"]:
        require_path(ROOT / source)
    for source in [
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    ]:
        if source not in contract["source_artifacts"]:
            raise SystemExit(f"routed board STEP export missing selected hardware source: {source}")

    state = contract["current_state"]
    expected_state = {
        "routed_release_status": routed_release["status"],
        "routed_pcb_execution_status": routed_execution["status"],
        "component_height_step_status": component_height["status"],
        "enclosure_fit_status": enclosure_fit["status"],
        "board_step_readiness_status": board_step["status"],
        "routed_board_clearance_status": routed_clearance["status"],
        "full_cad_boolean_status": full_cad_boolean["overall_status"],
    }
    for key, value in expected_state.items():
        if state[key] != value:
            raise SystemExit(f"routed board STEP export state stale: {key}")
    board_state = board_step["board_state_detected"]
    detailed_step_candidate = board_step.get("detailed_routed_step_candidate", {})
    if not isinstance(detailed_step_candidate, dict):
        raise SystemExit("routed board STEP export missing detailed candidate context")
    if state["concept_pcb_only"] is not True or state["production_step_present"]:
        raise SystemExit("routed board STEP export contract must remain fail-closed")
    if state["placeholder_footprints_present"] != (board_state["placeholder_marker_count"] > 0):
        raise SystemExit("routed board STEP export placeholder state stale")
    local_step_context = state.get("local_development_step_context")
    if not isinstance(local_step_context, dict):
        raise SystemExit("routed board STEP export local development STEP context missing")
    expected_local_step_context = {
        "source_step": detailed_step_candidate.get("source_step"),
        "candidate_production_step_copy": detailed_step_candidate.get("path"),
        "candidate_production_step_present_but_blocked": detailed_step_candidate.get("present"),
        "source_step_sha256": detailed_step_candidate.get("source_step_sha256"),
        "source_step_size_bytes": detailed_step_candidate.get("source_step_size_bytes"),
        "candidate_step_sha256": detailed_step_candidate.get("sha256"),
        "candidate_step_size_bytes": detailed_step_candidate.get("size_bytes"),
        "footprint_envelope_count": detailed_step_candidate.get("footprint_envelope_count"),
        "pad_contact_visual_count": detailed_step_candidate.get("pad_contact_visual_count"),
        "route_segment_visual_count": detailed_step_candidate.get("route_segment_visual_count"),
        "route_segment_net_name_count": detailed_step_candidate.get("route_segment_net_name_count"),
        "route_segment_trace_bound_count": detailed_step_candidate.get(
            "route_segment_trace_bound_count"
        ),
        "route_segment_trace_unbound_count": detailed_step_candidate.get(
            "route_segment_trace_unbound_count"
        ),
        "controlled_impedance_segment_visual_count": detailed_step_candidate.get(
            "controlled_impedance_segment_visual_count"
        ),
        "board_segment_count": detailed_step_candidate.get("segment_count"),
        "via_net_name_count": detailed_step_candidate.get("via_net_name_count"),
        "route_visual_record_count": detailed_step_candidate.get("route_visual_record_count"),
        "via_visual_record_count": detailed_step_candidate.get("via_visual_record_count"),
        "filled_copper_zone_record_count": detailed_step_candidate.get(
            "filled_copper_zone_record_count"
        ),
        "filled_copper_zone_filled_polygon_count": detailed_step_candidate.get(
            "filled_copper_zone_filled_polygon_count"
        ),
        "component_model_record_count": detailed_step_candidate.get("component_model_record_count"),
        "cad_connection_record_count": detailed_step_candidate.get("cad_connection_record_count"),
        "all_route_records_have_net_layer_class_and_source": detailed_step_candidate.get(
            "all_route_records_have_net_layer_class_and_source"
        ),
        "all_component_records_have_local_step": detailed_step_candidate.get(
            "all_component_records_have_local_step"
        ),
        "all_connection_records_have_cad_step": detailed_step_candidate.get(
            "all_connection_records_have_cad_step"
        ),
    }
    for key, expected in expected_local_step_context.items():
        if local_step_context.get(key) != expected:
            raise SystemExit(f"routed board STEP export local candidate context stale: {key}")
    for required_flag in [
        "candidate_matches_routed_output_manifest",
        "candidate_matches_development_source",
    ]:
        if detailed_step_candidate.get(required_flag) is not True:
            raise SystemExit(f"routed board STEP export candidate linkage failed: {required_flag}")
    full_cad_state_map = {
        "full_cad_boolean_parts_loaded": "parts_loaded",
        "full_cad_boolean_pair_count_brep_evaluated": "pair_count_brep_evaluated",
        "full_cad_boolean_unintentional_clash_count": "unintentional_clash_count",
        "full_cad_boolean_scope_result_count": "scope_result_count",
        "full_cad_boolean_passing_scope_result_count": "passing_scope_result_count",
    }
    full_cad_expected = {
        "parts_loaded": int(full_cad_boolean.get("parts_loaded") or 0),
        "pair_count_brep_evaluated": int(full_cad_boolean.get("pair_count_brep_evaluated") or 0),
        "unintentional_clash_count": len(full_cad_boolean.get("unintentional_clashes") or []),
        "scope_result_count": len(full_cad_boolean.get("scope_results") or []),
        "passing_scope_result_count": sum(
            1
            for result in full_cad_boolean.get("scope_results") or []
            if result.get("status") == "pass"
        ),
    }
    for state_key, expected_key in full_cad_state_map.items():
        if int(state[state_key]) != full_cad_expected[expected_key]:
            raise SystemExit(f"routed board STEP export full-CAD state stale: {state_key}")

    export = contract["export_contract"]
    release_outputs = routed_release["required_release_output_manifest"]
    if export["required_kicad_source"] != release_outputs["routed_kicad_pcb"]["expected_path"]:
        raise SystemExit("routed board STEP source path diverges from release plan")
    release_step_dir = release_outputs["board_step_with_supplier_models"]["expected_path"]
    if not export["required_step_output"].startswith(f"{release_step_dir}/"):
        raise SystemExit("routed board STEP output path diverges from release plan")
    if "--subst-models" not in export["export_command"]["command"]:
        raise SystemExit("routed board STEP export must substitute supplier 3D models")
    if "--include-tracks" not in export["export_command"]["command"]:
        raise SystemExit("routed board STEP export must include routed copper")
    if export["board_geometry_required"]["placeholder_footprints_allowed"] is not False:
        raise SystemExit("routed board STEP contract cannot allow placeholder footprints")
    if not export["board_geometry_required"]["production_tracks_required"]:
        raise SystemExit("routed board STEP contract must require routed tracks")
    geometry_required = export["board_geometry_required"]
    edge_cut_islands = layout_utilization["edge_cut_islands"]
    if len(edge_cut_islands) != 2:
        raise SystemExit("layout utilization must expose exactly two split-board islands")
    expected_geometry = {
        "board_bbox_mm": {
            "width": layout_utilization["board_bbox_mm"]["width"],
            "height": layout_utilization["board_bbox_mm"]["height"],
        },
        "top_island_mm": edge_cut_islands[0],
        "bottom_island_mm": edge_cut_islands[1],
        "battery_window_mm": layout_utilization["battery_window_mm"],
    }
    for key, expected in expected_geometry.items():
        if geometry_required.get(key) != expected:
            raise SystemExit(f"routed board STEP contract geometry stale: {key}")

    selected_bindings = {item["function"]: item for item in export["selected_hardware_3d_binding"]}
    expected_usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    expected_radio_stack = radio_selection["selected_wireless_stack"]
    expected_selected_hardware = {
        "display_touch": display_downselect["selected_screen_decision"]["part"],
        "rear_front_cameras": "Sincere_First_OV13855_rear_and_GC5035_front",
        "usb_c_side_buttons": "_".join(
            [
                expected_usb_stack["usb_c_evt0_connector"]["vendor"],
                expected_usb_stack["usb_c_evt0_connector"]["family"],
                expected_usb_stack["usb_pd_controller"]["part"],
                expected_usb_stack["charger_power_path"]["part"],
                expected_usb_stack["side_key_primary"]["vendor"],
                expected_usb_stack["side_key_primary"]["family"],
            ]
        ),
        "cellular": f"{expected_radio_stack['cellular_performance_reference']['vendor']}_"
        f"{expected_radio_stack['cellular_performance_reference']['family']}_RedCap_reference",
        "wifi_bluetooth": f"{expected_radio_stack['wifi_bluetooth_primary']['vendor']}_"
        f"{expected_radio_stack['wifi_bluetooth_primary']['order_number']}",
    }
    expected_sources = {
        "display_touch": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "rear_front_cameras": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "usb_c_side_buttons": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "cellular": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "wifi_bluetooth": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    }
    if set(selected_bindings) != set(expected_selected_hardware):
        raise SystemExit("routed board STEP selected hardware binding set diverges")
    for function, selected in expected_selected_hardware.items():
        binding = selected_bindings[function]
        if binding["selected_hardware"] != selected:
            raise SystemExit(f"routed board STEP selected hardware stale: {function}")
        if binding["source_artifact"] != expected_sources[function]:
            raise SystemExit(f"routed board STEP selected hardware source stale: {function}")
        if not binding["status"].startswith("blocked_missing_"):
            raise SystemExit(
                f"routed board STEP selected hardware binding unexpectedly open: {function}"
            )
        if len(binding["required_models"]) < 2 or len(binding["required_before_step_export"]) < 3:
            raise SystemExit(f"routed board STEP selected hardware binding too weak: {function}")
    if (
        "signed display/touch STEP or B-rep model with cover-lens, FPC exit, stiffener, and connector datum"
        not in selected_bindings["display_touch"]["required_before_step_export"]
    ):
        raise SystemExit("routed board STEP display binding missing supplier STEP requirement")
    if (
        "top-island repack or smaller supplier-approved module branch closed before routed placement"
        not in selected_bindings["cellular"]["required_before_step_export"]
    ):
        raise SystemExit("routed board STEP cellular binding missing repack/alternate gate")

    required_height_models = set(routed_clearance["required_height_models"])
    modeled = {
        model
        for family in export["required_3d_model_families"]
        for model in family["required_models"]
    }
    if not required_height_models.issubset(modeled):
        missing = sorted(required_height_models - modeled)
        raise SystemExit(f"routed board STEP export missing height models: {missing}")
    clearance_case_ids = {item["case_id"] for item in routed_clearance["rerun_matrix"]}
    for family in export["required_3d_model_families"]:
        if family["supplier_step_required"] is not True:
            raise SystemExit(f"routed board STEP family must require supplier STEP: {family['id']}")
        for case_id in family["clearance_case_ids"]:
            if case_id not in clearance_case_ids:
                raise SystemExit(
                    f"routed board STEP family references unknown clearance case: {case_id}"
                )

    required_checks = {
        item["id"]: item for item in contract["post_export_acceptance"]["required_checks"]
    }
    for check_id in [
        "step_file_present_and_importable",
        "kicad_board_has_tracks_and_zones",
        "supplier_3d_models_bound",
        "mechanical_handoff_transform_recorded",
        "routed_board_clearance_rerun_passed",
        "full_cad_boolean_interference_passed",
    ]:
        if check_id not in required_checks:
            raise SystemExit(f"routed board STEP export missing post-export check {check_id}")
    for blocker in [
        "production routed KiCad PCB source is present only as non-release local candidate evidence",
        "candidate routed board STEP exists for review only; supplier-approved production STEP export is missing",
        "supplier component STEP/B-rep models are missing",
        "routed-board clearance rerun is blocked",
        "full CAD boolean interference using routed board and supplier geometry is blocked",
    ]:
        if blocker not in contract["release_blockers"]:
            raise SystemExit(f"routed board STEP export missing release blocker: {blocker}")
    for claim in [
        "routed_board_step_ready",
        "supplier_3d_models_loaded",
        "routed_clearance_passed",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in contract["forbidden_claims"]:
            raise SystemExit(f"routed board STEP export missing forbidden claim {claim}")
    print(
        "routed board STEP export contract ok: "
        f"{len(export['required_3d_model_families'])} model families, "
        f"{len(required_checks)} post-export checks fail-closed"
    )


def check_screen_back_camera_collision_review() -> None:
    full_cad = load_yaml(ROOT / "mechanical/e1-phone/review/full-cad-boolean-interference.json")
    camera = load_yaml(ROOT / "mechanical/e1-phone/review/camera-validation.json")
    for path in [
        "mechanical/e1-phone/out/screen_cover_glass.step",
        "mechanical/e1-phone/out/display_lcm.step",
        "mechanical/e1-phone/out/orange_side_frame.step",
        "mechanical/e1-phone/out/rear_camera_shell_aperture.step",
        "mechanical/e1-phone/out/rear_camera_lens_window.step",
        "mechanical/e1-phone/out/rear_camera_optical_sight_tunnel.step",
        "mechanical/e1-phone/out/rear_camera_module.step",
        "mechanical/e1-phone/out/rear_camera_cover_glass.step",
        "mechanical/e1-phone/out/front_camera_module.step",
    ]:
        require_path(ROOT / path)

    required_scope_ids = {
        "screen_stack_to_orange_rails",
        "front_camera_earpiece_under_glass_stack",
        "rear_camera_window_baffle_adhesive_stack",
    }
    required_pairs = [
        ("screen_stack_to_orange_rails", ("display_lcm", "screen_cover_glass")),
        ("screen_stack_to_orange_rails", ("display_lcm", "orange_side_frame")),
        ("screen_stack_to_orange_rails", ("screen_cover_glass", "orange_side_frame")),
        ("front_camera_earpiece_under_glass_stack", ("front_camera_module", "earpiece_receiver")),
        ("front_camera_earpiece_under_glass_stack", ("front_camera_module", "screen_cover_glass")),
        ("rear_camera_window_baffle_adhesive_stack", ("rear_camera_module", "orange_back_shell")),
        (
            "rear_camera_window_baffle_adhesive_stack",
            ("rear_camera_module", "rear_camera_cover_glass"),
        ),
    ]
    if full_cad.get("concept_aabb_interference_count") is not None:
        if full_cad.get("concept_aabb_interference_count") != 0:
            raise SystemExit("full CAD concept AABB scan still reports interference")
        if int(full_cad.get("concept_aabb_pair_check_count") or 0) < 16:
            raise SystemExit("full CAD concept AABB scan is missing screen/back coverage")
        scope_by_id = {scope["id"]: scope for scope in full_cad.get("scope_cases", [])}
        if not required_scope_ids.issubset(scope_by_id):
            raise SystemExit("full CAD review missing screen/front/rear camera scopes")
        for scope_id in required_scope_ids:
            scope = scope_by_id[scope_id]
            for flag in ["required_parts_present", "concept_clearance_pass", "early_aabb_fit_pass"]:
                if scope.get(flag) is not True:
                    raise SystemExit(f"full CAD review scope {scope_id} failed {flag}")

        pair_results = {
            (check["scope_id"], tuple(check["pair"])): check
            for scope in full_cad.get("scope_cases", [])
            for check in scope.get("concept_aabb_pair_checks", [])
        }
        for key in required_pairs:
            result = pair_results.get(key)
            if not result:
                raise SystemExit(f"full CAD review missing required AABB pair: {key}")
            if result.get("pass") is not True or int(result.get("interference_count") or 0) != 0:
                raise SystemExit(f"full CAD review AABB pair collision remains: {key}")
    else:
        if full_cad.get("overall_status") != "pass":
            raise SystemExit("full CAD B-rep boolean interference report is not passing")
        if full_cad.get("release_credit") is not False:
            raise SystemExit("full CAD B-rep boolean report must not grant release credit")
        if full_cad.get("release_blocked") is not True:
            raise SystemExit("full CAD B-rep boolean report must remain release-blocked")
        if full_cad.get("release_blocker_category") != "routed_supplier_boolean_rerun_missing":
            raise SystemExit("full CAD B-rep boolean release blocker category stale")
        if full_cad.get("unintentional_clashes"):
            raise SystemExit("full CAD B-rep boolean report still has unintentional clashes")
        if int(full_cad.get("parts_loaded") or 0) < 200:
            raise SystemExit("full CAD B-rep boolean report is missing part coverage")
        if int(full_cad.get("pair_count_brep_evaluated") or 0) < 900:
            raise SystemExit("full CAD B-rep boolean report is missing pair coverage")
        scope_by_id = {scope["case"]: scope for scope in full_cad.get("scope_results", [])}
        if not required_scope_ids.issubset(scope_by_id):
            raise SystemExit("full CAD B-rep review missing screen/front/rear camera scopes")
        for scope_id in required_scope_ids:
            scope = scope_by_id[scope_id]
            if scope.get("status") != "pass" or scope.get("parts_missing"):
                raise SystemExit(f"full CAD B-rep review scope {scope_id} is not passing")
        pair_results = {}
        for scope in full_cad.get("scope_results", []):
            scope_id = scope.get("case")
            for sample in scope.get("sample_pairs", []):
                pair = tuple(sample.get("parts", []))
                pair_results[(scope_id, pair)] = sample
                pair_results[(scope_id, tuple(reversed(pair)))] = sample
        for key in required_pairs:
            result = pair_results.get(key)
            if not result:
                raise SystemExit(f"full CAD B-rep review missing required pair: {key}")
            if float(result.get("interference_volume_mm3") or 0.0) != 0.0:
                raise SystemExit(f"full CAD B-rep pair collision remains: {key}")

    camera_cases = {case["id"]: case for case in camera.get("cases", [])}
    for case_id in [
        "rear_camera_back_shell_aperture",
        "rear_flash_back_shell_aperture",
        "front_under_glass_margin",
        "camera_interface_strategy",
        "rear_camera_z_stack",
    ]:
        if camera_cases.get(case_id, {}).get("pass") is not True:
            raise SystemExit(f"camera validation case not passing: {case_id}")
    rear_aperture = camera_cases["rear_camera_back_shell_aperture"]["actual"]
    if rear_aperture.get("optical_sight_tunnel_present") is not True:
        raise SystemExit("rear camera back aperture lacks optical sight tunnel")
    if int(rear_aperture.get("bezel_part_count") or 0) != 4:
        raise SystemExit("rear camera back aperture bezel is incomplete")
    interface = camera_cases["camera_interface_strategy"]["actual"]
    if interface.get("rear_flush_buried_window") is not True:
        raise SystemExit("rear camera is not validated as flush and buried")
    if interface.get("front_under_cover_glass") is not True:
        raise SystemExit("front camera is not validated under cover glass")

    print(
        "screen/back camera collision review ok: "
        f"{len(required_pairs)} required AABB pairs, rear aperture through-window present"
    )


def check_routed_pcb_implementation_execution() -> None:
    execution = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    manifest = load_yaml(MANIFEST)
    routing_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml")
    evt1 = load_yaml(ROOT / "board/kicad/e1-phone/evt1-routing-work-package.yaml")
    route_feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    production = load_yaml(ROOT / "board/kicad/e1-phone/production-readiness.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    supplier_to_kicad = load_yaml(ROOT / "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml")
    footprint_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    display_camera_pinout = load_yaml(
        ROOT / "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml"
    )
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    camera_downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    usb_sidekey = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-integration.yaml")
    usb_sidekey_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )
    module_rf = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")

    if execution["schema"] != "eliza.e1_phone_routed_pcb_implementation_execution.v1":
        raise SystemExit("routed PCB implementation execution schema diverges")
    if (
        execution["status"]
        != "blocked_requires_supplier_footprints_schematic_erc_trial_route_drc_outputs_and_routed_step"
    ):
        raise SystemExit(
            f"unexpected routed PCB implementation execution status: {execution['status']}"
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
        "board/kicad/e1-phone/first-article-route-execution-order.yaml",
        "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
        "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml",
        "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml",
        "board/kicad/e1-phone/usb-sidekey-integration.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/schematic-netclass-execution-package.yaml",
        "board/kicad/e1-phone/route-corridor-execution-package.yaml",
        "board/kicad/e1-phone/trial-route-input-matrix.yaml",
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
    for source in [
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    ]:
        if source not in evt1["source_artifacts"]:
            raise SystemExit(f"EVT1 routing work package missing selected hardware source {source}")

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
            raise SystemExit(f"routed PCB implementation manufacturing state diverges for {key}")
    if state["segment_count"] != 0 or state["zone_count"] != 0:
        raise SystemExit("routed PCB implementation must remain blocked with no route")
    if state["has_tracks"] or state["has_filled_zones"] or state["has_production_outputs"]:
        raise SystemExit("routed PCB implementation cannot claim routed/manufacturing state")
    routed_candidate = execution.get("local_routed_kicad_candidate_state")
    if not isinstance(routed_candidate, dict):
        raise SystemExit("routed PCB implementation missing local routed KiCad candidate state")
    routed_candidate_path = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
    routed_candidate_text = routed_candidate_path.read_text(encoding="utf-8")
    expected_routed_candidate_counts = {
        "present": True,
        "footprint_count": routed_candidate_text.count('(footprint "'),
        "placeholder_marker_count": routed_candidate_text.count(
            "placeholder_not_fabrication_footprint"
        ),
        "segment_count": routed_candidate_text.count("\n  (segment "),
        "via_count": routed_candidate_text.count("\n  (via "),
        "zone_count": routed_candidate_text.count("\n  (zone "),
        "filled_zone_count": routed_candidate_text.count("(filled_polygon"),
    }
    for key, value in expected_routed_candidate_counts.items():
        if routed_candidate.get(key) != value:
            raise SystemExit(f"routed PCB implementation candidate count stale: {key}")
    if routed_candidate["release_credit"] is not False:
        raise SystemExit("routed PCB implementation candidate cannot claim release credit")
    if (
        routed_candidate["segment_count"] <= 0
        or routed_candidate["via_count"] <= 0
        or routed_candidate["placeholder_marker_count"] != 0
    ):
        raise SystemExit("routed PCB implementation candidate must show routed local copper")

    pressure = execution["routing_pressure_snapshot"]
    route_summary = routing_acceptance["routing_summary"]
    if pressure["board_bbox_mm"] != route_summary["board_bbox_mm"]:
        raise SystemExit("routed PCB implementation board pressure bbox diverges")
    if pressure["battery_window_mm"] != route_summary["battery_window_mm"]:
        raise SystemExit("routed PCB implementation battery window diverges")
    if (
        pressure["differential_pair_count_required"]
        != route_feasibility["interface_complexity_counts"]["differential_pair_count_required"]
    ):
        raise SystemExit("routed PCB implementation differential pair count diverges")
    if (
        pressure["split_interconnect_min_contacts"]
        != route_feasibility["interface_complexity_counts"]["split_interconnect_min_contacts"]
    ):
        raise SystemExit("routed PCB implementation split contact count diverges")

    phase_status = {phase["phase"]: phase["current_status"] for phase in evt1["route_phases"]}
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
                raise SystemExit(f"routed PCB implementation output path diverges: {output['id']}")
            if output["present"] or not output["release_required"]:
                raise SystemExit(
                    f"routed PCB implementation output must be blocked: {output['id']}"
                )

    selected_sequence = evt1["selected_hardware_route_sequence"]
    if (
        selected_sequence["status"]
        != "blocked_selected_hardware_route_sequence_requires_supplier_footprints_pinouts_stackup_trial_route_and_drc"
    ):
        raise SystemExit("EVT1 selected hardware route sequence status stale")
    expected_sources = {
        "display": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "camera": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "usb_sidekey": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "radio": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    }
    if selected_sequence["source_decisions"] != expected_sources:
        raise SystemExit("EVT1 selected hardware route sequence source decisions stale")
    if selected_sequence["sequence_is_ordered"] is not True:
        raise SystemExit("EVT1 selected hardware route sequence must be ordered")
    steps = selected_sequence["route_sequence"]
    expected_step_ids = [
        "display_touch_mipi_anchor",
        "camera_csi_pair",
        "usb_c_power_sidekey_spine",
        "radio_rf_and_host_escape",
        "factory_probe_and_enclosure_step_route",
    ]
    if [item["id"] for item in steps] != expected_step_ids:
        raise SystemExit("EVT1 selected hardware route sequence order diverges")
    if [item["order"] for item in steps] != list(range(len(expected_step_ids))):
        raise SystemExit("EVT1 selected hardware route sequence indices diverge")
    step_map = {item["id"]: item for item in steps}
    display_part = display_downselect["selected_screen_decision"]["part"]
    if step_map["display_touch_mipi_anchor"]["selected_hardware"] != display_part:
        raise SystemExit("EVT1 display route sequence selected hardware stale")
    if step_map["camera_csi_pair"]["selected_hardware"] != (
        "Sincere_First_OV13855_rear_and_GC5035_front"
    ):
        raise SystemExit("EVT1 camera route sequence selected hardware stale")
    if not camera_downselect["status"].startswith("blocked_"):
        raise SystemExit("EVT1 camera route sequence unexpectedly has unblocked camera downselect")
    usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    expected_usb_selected = (
        f"{usb_stack['usb_c_evt0_connector']['vendor']}_{usb_stack['usb_c_evt0_connector']['family']}_"
        f"{usb_stack['usb_pd_controller']['part']}_{usb_stack['charger_power_path']['part']}_"
        f"{usb_stack['side_key_primary']['vendor']}_{usb_stack['side_key_primary']['family']}"
    )
    if step_map["usb_c_power_sidekey_spine"]["selected_hardware"] != expected_usb_selected:
        raise SystemExit("EVT1 USB/side-key route sequence selected hardware stale")
    radio_stack = radio_selection["selected_wireless_stack"]
    expected_radio_selected = (
        f"{radio_stack['cellular_performance_reference']['vendor']}_"
        f"{radio_stack['cellular_performance_reference']['family']}_RedCap_reference_plus_"
        f"{radio_stack['wifi_bluetooth_primary']['vendor']}_"
        f"{radio_stack['wifi_bluetooth_primary']['order_number']}"
    )
    if step_map["radio_rf_and_host_escape"]["selected_hardware"] != expected_radio_selected:
        raise SystemExit("EVT1 radio route sequence selected hardware stale")
    for step in steps:
        if step["blocked"] is not True:
            raise SystemExit(
                f"EVT1 selected hardware route sequence unexpectedly open: {step['id']}"
            )
        if len(step.get("required_before_route", [])) < 3:
            raise SystemExit(
                f"EVT1 selected hardware route sequence pre-route list too weak: {step['id']}"
            )
        for evidence_path in step.get("required_release_evidence", []):
            if not str(evidence_path).startswith("board/kicad/e1-phone/production/"):
                raise SystemExit(
                    f"EVT1 selected hardware route sequence evidence path outside production tree: {step['id']}"
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

    supplier_records = {item["function"]: item for item in supplier_to_kicad["evidence_records"]}
    footprint_items = {item["function"]: item for item in footprint_capture["work_items"]}
    route_inputs = {
        item["function"]: item for item in execution["supplier_to_kicad_route_input_matrix"]
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
        if item["required_production_evidence"] != supplier_record["required_production_evidence"]:
            raise SystemExit(f"routed PCB implementation production evidence stale: {function}")
        if item["supplier_gate_inputs_required"] != footprint_item["supplier_gate_inputs_required"]:
            raise SystemExit(f"routed PCB implementation supplier gates stale: {function}")
        if item["all_supplier_gates_closed"]:
            raise SystemExit(
                f"routed PCB implementation supplier gates unexpectedly closed: {function}"
            )
        if not item["supplier_to_kicad_status"].startswith("blocked_"):
            raise SystemExit(
                f"routed PCB implementation supplier input unexpectedly open: {function}"
            )
        if not item["footprint_capture_status"].startswith("blocked_"):
            raise SystemExit(
                f"routed PCB implementation footprint input unexpectedly open: {function}"
            )
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
        item["interface_id"]: item for item in display_camera_pinout["connector_pinout_execution"]
    }
    usb_acceptance_items = {item["id"]: item for item in usb_sidekey_acceptance["acceptance_items"]}
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
    if (
        usb_item["mechanical_capture_tasks"]
        != usb_sidekey["usb_c_port_context"]["mechanical_requirements"]
    ):
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
        if (
            usb_acceptance_items[acceptance_id]["status"]
            != "blocked_missing_routed_supplier_or_measured_evidence"
        ):
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
    if (
        side_item["mechanical_capture_tasks"]
        != usb_sidekey["side_key_context"]["mechanical_requirements"]
    ):
        raise SystemExit("side-button external interface mechanical requirements stale")
    side_acceptance_ids = {item["id"] for item in side_item["acceptance_items"]}
    if side_acceptance_ids != {
        "side_key_force_travel_and_solder_load",
        "side_key_recovery_and_wake",
    }:
        raise SystemExit("side-button external interface acceptance items stale")
    for acceptance_id in side_acceptance_ids:
        if (
            usb_acceptance_items[acceptance_id]["status"]
            != "blocked_missing_routed_supplier_or_measured_evidence"
        ):
            raise SystemExit(f"side-button acceptance unexpectedly unblocked: {acceptance_id}")
    if not usb_item["status"].startswith("blocked_") or not side_item["status"].startswith(
        "blocked_"
    ):
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
    if (
        module_dep["required_rf_nets"]
        != routed_release["rf_release_dependency"]["required_rf_nets"]
    ):
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
            raise SystemExit(f"routed PCB implementation missing forbidden claim {claim}")
    print(
        "routed PCB implementation execution ok: "
        f"{len(execution_phases)} phases, {len(manifest_outputs)} release outputs blocked"
    )


def check_routed_layout_readiness_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/routed-layout-readiness-binding.yaml")
    manifest = load_yaml(MANIFEST)
    schematic_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-capture-readiness-binding.yaml"
    )
    routed_execution = load_yaml(
        ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml"
    )
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    step_contract = load_yaml(ROOT / "board/kicad/e1-phone/routed-board-step-export-contract.yaml")
    enclosure_fit = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    production_factory = load_yaml(
        ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml"
    )
    scorecard = load_yaml(ROOT / "board/kicad/e1-phone/board-optimization-scorecard.yaml")
    layout_optimization = load_yaml(
        ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml"
    )
    post_route_validation = load_yaml(
        ROOT / "board/kicad/e1-phone/post-route-validation-binding.yaml"
    )
    supplier_rfq_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    component_models = load_yaml(
        ROOT / "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml"
    )
    supplier_lane_surrogate_paths = {
        item["file"]
        for item in component_models.get("supplier_lane_surrogate_steps", {}).values()
        if item.get("status") == "present_local_surrogate_step_not_supplier_approved"
        and item.get("release_credit") is False
    }

    def phase_release_artifact_present(path: Path) -> bool:
        rel_path = path.relative_to(ROOT).as_posix()
        if rel_path in supplier_lane_surrogate_paths:
            return False
        return is_release_artifact_present(path)

    if binding["schema"] != "eliza.e1_phone_routed_layout_readiness_binding.v1":
        raise SystemExit(f"unexpected routed layout readiness schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_layout_readiness_requires_routed_pcb_drc_si_pi_rf_factory_outputs_and_enclosure_clearance"
    ):
        raise SystemExit(f"unexpected routed layout readiness status: {binding['status']}")
    rel = "board/kicad/e1-phone/routed-layout-readiness-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing routed layout readiness binding")
    if rel not in routed_execution["source_artifacts"]:
        raise SystemExit("routed PCB implementation must cite routed layout readiness binding")
    for source in binding["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "schematic_capture_readiness": schematic_capture["status"],
        "routed_pcb_implementation": routed_execution["status"],
        "routed_release_plan": routed_release["status"],
        "pcb_implementation_audit": pcb_audit["status"],
        "routed_board_step_export": step_contract["status"],
        "enclosure_fit_execution": enclosure_fit["status"],
        "manufacturing_closure": manufacturing["status"],
        "factory_production_acceptance": factory_acceptance["status"],
        "production_factory_release_execution": production_factory["status"],
        "board_optimization_scorecard": scorecard["status"],
        "layout_optimization_execution": layout_optimization["status"],
        "post_route_validation_binding": post_route_validation["status"],
        "supplier_rfq_response_normalization": supplier_rfq_responses["status"],
    }
    if binding["upstream_status"] != expected_upstream:
        raise SystemExit("routed layout readiness upstream status snapshot is stale")

    state = binding["current_live_layout_state"]
    live_counts = pcb_audit["live_pcb_counts"]
    execution_state = routed_execution["current_kicad_state"]
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
        if state[key] != live_counts[key] or state[key] != execution_state[key]:
            raise SystemExit(f"routed layout readiness live count stale: {key}")
    for key in ["has_tracks", "has_filled_zones", "has_production_outputs"]:
        if state[key] != routed_release["current_board_state"][key]:
            raise SystemExit(f"routed layout readiness board state stale: {key}")
        if state[key] is not False:
            raise SystemExit(f"routed layout readiness cannot claim {key}")
    if (
        state["concept_placeholder_footprints"]
        != routed_release["current_board_state"]["concept_placeholder_footprints"]
    ):
        raise SystemExit("routed layout readiness placeholder count stale")
    if state["board_revision"] != routed_release["current_board_state"]["revision"]:
        raise SystemExit("routed layout readiness board revision stale")
    if (
        state["required_release_revision"]
        != routed_release["current_board_state"]["release_revision_required_before_fab"]
    ):
        raise SystemExit("routed layout readiness release revision stale")

    output_gate = binding["release_output_gate"]
    release_outputs = routed_release["required_release_output_manifest"]
    if output_gate["required_output_count"] != len(release_outputs):
        raise SystemExit("routed layout readiness output count stale")
    present_count = sum(1 for item in release_outputs.values() if item["present"])
    if output_gate["present_output_count"] != present_count or present_count != 0:
        raise SystemExit("routed layout readiness present output count stale")
    if set(output_gate["required_output_ids"]) != set(release_outputs):
        raise SystemExit("routed layout readiness output ID set diverges")
    if (
        output_gate["ready_to_fabricate"] != routed_release["ready_to_fabricate"]
        or output_gate["ready_for_enclosure"] != routed_release["ready_for_enclosure"]
        or output_gate["ready_for_factory_test"] != routed_release["ready_for_factory_test"]
    ):
        raise SystemExit("routed layout readiness ready flags stale")
    if any(
        [
            output_gate["ready_to_fabricate"],
            output_gate["ready_for_enclosure"],
            output_gate["ready_for_factory_test"],
        ]
    ):
        raise SystemExit("routed layout readiness unexpectedly open")

    domain_gate = binding["layout_domain_gate"]
    routed_domains = {item["id"]: item for item in routed_execution["domain_route_closure"]}
    if domain_gate["required_domain_count"] != len(routed_domains):
        raise SystemExit("routed layout readiness domain count stale")
    if domain_gate["blocked_domain_count"] != len(routed_domains):
        raise SystemExit("routed layout readiness blocked domain count stale")
    if set(domain_gate["required_domains"]) != set(routed_domains):
        raise SystemExit("routed layout readiness domain set diverges")
    for domain, item in routed_domains.items():
        if not item["status"].startswith("blocked_"):
            raise SystemExit(f"routed layout readiness domain unexpectedly open: {domain}")

    enclosure_gate = binding["enclosure_gate"]
    if enclosure_gate["requires_routed_board_step"] is not True:
        raise SystemExit("routed layout readiness must require routed board STEP")
    if enclosure_gate["requires_supplier_3d_models"] is not True:
        raise SystemExit("routed layout readiness must require supplier 3D models")
    if enclosure_gate["requires_routed_clearance_rerun"] is not True:
        raise SystemExit("routed layout readiness must require routed clearance rerun")
    if enclosure_gate["requires_full_cad_boolean_interference_pass"] is not True:
        raise SystemExit("routed layout readiness must require CAD boolean pass")
    if (
        enclosure_gate["production_step_present"]
        != step_contract["current_state"]["production_step_present"]
    ):
        raise SystemExit("routed layout readiness STEP presence stale")
    if enclosure_gate["production_step_present"] or enclosure_gate["routed_clearance_passed"]:
        raise SystemExit("routed layout readiness enclosure gate unexpectedly open")
    if step_contract["current_state"]["routed_board_clearance_status"] not in {
        "blocked_waiting_for_routed_board_step",
        "blocked_waiting_for_physical_routed_board_clearance_result",
    }:
        raise SystemExit("routed layout readiness routed clearance status stale")

    factory_gate = binding["factory_gate"]
    for key in [
        "requires_routed_probe_coordinates",
        "requires_factory_test_limits",
        "requires_first_article_traveler",
        "requires_fab_assembler_quote",
    ]:
        if factory_gate[key] is not True:
            raise SystemExit(f"routed layout readiness factory gate must require {key}")
    if factory_gate["ready_for_factory_test"] != routed_release["ready_for_factory_test"]:
        raise SystemExit("routed layout readiness factory ready flag stale")
    if factory_gate["ready_for_factory_test"]:
        raise SystemExit("routed layout readiness factory gate unexpectedly open")

    for key, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"routed layout readiness cross-check failed: {key}")
    for blocker in [
        "production routed KiCad PCB source is present only as non-release local candidate evidence",
        "local routed KiCad candidate has copper segments but no release-approved zones, DRC, or signoff",
        "no release-approved routed copper, filled zones, or DRC evidence",
        "candidate routed board STEP exists for review only; supplier-approved production STEP export is missing",
        "routed-board clearance rerun is blocked",
    ]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"routed layout readiness missing blocker: {blocker}")
    for claim in [
        "routed_pcb_ready",
        "layout_ready",
        "drc_clean",
        "si_pi_ready",
        "rf_ready",
        "production_outputs_ready",
        "routed_board_step_ready",
        "factory_test_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"routed layout readiness missing forbidden claim {claim}")
    print(
        "routed layout readiness binding ok: "
        f"{len(release_outputs)} outputs, {len(routed_domains)} domains fail-closed"
    )


def check_first_article_route_execution_order() -> None:
    order = load_yaml(ROOT / "board/kicad/e1-phone/first-article-route-execution-order.yaml")
    manifest = load_yaml(MANIFEST)
    supplier_gate = load_yaml(ROOT / "board/kicad/e1-phone/supplier-sample-release-gate.yaml")
    footprint_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/evt1-footprint-capture-work-package.yaml"
    )
    schematic_capture = load_yaml(
        ROOT / "board/kicad/e1-phone/schematic-capture-readiness-binding.yaml"
    )
    evt1_route = load_yaml(ROOT / "board/kicad/e1-phone/evt1-routing-work-package.yaml")
    routed_pcb = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    routed_layout = load_yaml(ROOT / "board/kicad/e1-phone/routed-layout-readiness-binding.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    routed_step = load_yaml(ROOT / "board/kicad/e1-phone/routed-board-step-export-contract.yaml")
    production_factory = load_yaml(
        ROOT / "board/kicad/e1-phone/production-factory-release-execution.yaml"
    )
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    enclosure_fit = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")
    readiness = load_yaml(ROOT / "board/kicad/e1-phone/end-to-end-readiness.yaml")
    supplier_rfq_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )
    component_models = load_yaml(
        ROOT / "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml"
    )
    supplier_lane_surrogate_paths = {
        item["file"]
        for item in component_models.get("supplier_lane_surrogate_steps", {}).values()
        if item.get("status") == "present_local_surrogate_step_not_supplier_approved"
        and item.get("release_credit") is False
    }

    def phase_release_artifact_present(path: Path) -> bool:
        rel_path = path.relative_to(ROOT).as_posix()
        if rel_path in supplier_lane_surrogate_paths:
            return False
        return is_release_artifact_present(path)

    if order["schema"] != "eliza.e1_phone_first_article_route_execution_order.v1":
        raise SystemExit(f"unexpected first-article route order schema: {order['schema']}")
    if (
        order["status"]
        != "blocked_first_article_route_requires_ordered_supplier_schematic_layout_factory_and_enclosure_evidence"
    ):
        raise SystemExit(f"unexpected first-article route order status: {order['status']}")
    rel = "board/kicad/e1-phone/first-article-route-execution-order.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing first-article route execution order artifact")
    if rel not in routed_pcb["source_artifacts"]:
        raise SystemExit("routed PCB implementation must cite first-article route order")
    if rel not in readiness["source_artifacts"]:
        raise SystemExit("end-to-end readiness must cite first-article route order")
    for source in order["source_artifacts"]:
        require_path(ROOT / source)

    expected_upstream = {
        "supplier_sample_release_gate": supplier_gate["status"],
        "evt1_footprint_capture": footprint_capture["status"],
        "schematic_capture_readiness": schematic_capture["status"],
        "evt1_routing_work_package": evt1_route["status"],
        "routed_pcb_implementation": routed_pcb["status"],
        "routed_layout_readiness": routed_layout["status"],
        "routed_release_plan": routed_release["status"],
        "routed_board_step_export": routed_step["status"],
        "production_factory_release": production_factory["status"],
        "factory_production_acceptance": factory_acceptance["status"],
        "enclosure_fit_execution": enclosure_fit["status"],
        "end_to_end_readiness": readiness["status"],
        "supplier_rfq_response_normalization": supplier_rfq_responses["status"],
    }
    if order["upstream_status"] != expected_upstream:
        raise SystemExit("first-article route order upstream status snapshot is stale")

    policy = order["execution_policy"]
    for key in [
        "sequence_is_strict",
        "no_phase_may_start_until_prior_phase_exit_evidence_is_present",
        "no_fabrication_outputs_without_routed_pcb_and_drc",
        "no_factory_limits_without_routed_probe_coordinates_and_first_article_measurements",
        "no_enclosure_release_without_routed_board_step_supplier_models_and_clearance_rerun",
        "all_phases_fail_closed_until_evidence_exists",
    ]:
        if policy[key] is not True:
            raise SystemExit(f"first-article route policy unexpectedly open: {key}")
    if policy["release_revision"] != routed_release["release_target"]:
        raise SystemExit("first-article route release revision diverges from routed release target")
    if policy["current_revision"] != routed_release["current_board_state"]["revision"]:
        raise SystemExit("first-article route current revision diverges from routed release state")

    phases = order["ordered_phases"]
    expected_phase_ids = [
        "supplier_response_and_samples",
        "footprint_symbol_and_3d_capture",
        "schematic_netclass_and_erc_capture",
        "placement_escape_and_trial_route",
        "high_speed_rf_power_route_and_drc",
        "manufacturing_release_outputs",
        "factory_fixture_and_first_article",
        "routed_step_and_enclosure_clearance",
        "final_readiness_decision",
    ]
    if [phase["id"] for phase in phases] != expected_phase_ids:
        raise SystemExit("first-article route phase order diverges")
    if [phase["order"] for phase in phases] != list(range(len(expected_phase_ids))):
        raise SystemExit("first-article route phase indices are not contiguous")
    for phase in phases:
        status_key = phase["source_status_key"]
        if phase["current_status"] != expected_upstream[status_key]:
            raise SystemExit(f"first-article route phase status stale: {phase['id']}")
        if phase["blocked"] is not True:
            raise SystemExit(f"first-article route phase unexpectedly unblocked: {phase['id']}")
        present = 0
        for evidence in phase["required_exit_evidence"]:
            if "*" in evidence:
                present += sum(
                    1 for path in ROOT.glob(evidence) if phase_release_artifact_present(path)
                )
            elif phase_release_artifact_present(ROOT / evidence):
                present += 1
        if phase["present_exit_evidence_count"] != present:
            raise SystemExit(f"first-article route phase evidence count stale: {phase['id']}")
        if present != 0:
            raise SystemExit(
                f"first-article route phase has release evidence before gate closure: {phase['id']}"
            )
        for next_phase in phase["must_complete_before"]:
            if next_phase not in expected_phase_ids:
                raise SystemExit(
                    f"first-article route phase references unknown successor: {next_phase}"
                )

    handoff = order["route_to_enclosure_handoff"]
    if (
        handoff["status"]
        != "blocked_until_routed_pcb_drc_step_supplier_models_and_clearance_release_exist"
    ):
        raise SystemExit("first-article route-to-enclosure handoff status stale")
    if handoff["route_phase"] != "high_speed_rf_power_route_and_drc":
        raise SystemExit("first-article route-to-enclosure handoff route phase stale")
    if handoff["enclosure_phase"] != "routed_step_and_enclosure_clearance":
        raise SystemExit("first-article route-to-enclosure handoff enclosure phase stale")
    if handoff["handoff_is_strict"] is not True:
        raise SystemExit("first-article route-to-enclosure handoff must be strict")
    if handoff["enclosure_claim_allowed_before_all_handoff_evidence"] is not False:
        raise SystemExit("first-article route-to-enclosure handoff opened enclosure claim")

    release_manifest = routed_release["required_release_output_manifest"]
    route_evidence = {
        item["release_output_id"]: item for item in handoff["required_route_evidence"]
    }
    expected_route_ids = ["routed_kicad_pcb", "pcb_drc_report", "filled_zones"]
    if set(route_evidence) != set(expected_route_ids):
        raise SystemExit("first-article route handoff route evidence set diverges")
    for output_id in expected_route_ids:
        item = route_evidence[output_id]
        expected_path = release_manifest[output_id]["expected_path"]
        if item["expected_path"] != expected_path:
            raise SystemExit(f"first-article route handoff path stale: {output_id}")
        present = is_release_artifact_present(ROOT / expected_path)
        if item["present"] != present:
            raise SystemExit(f"first-article route handoff presence stale: {output_id}")
        if present:
            raise SystemExit(f"first-article route handoff unexpectedly has evidence: {output_id}")

    step_contract = routed_step["export_contract"]
    step_evidence = {item["evidence_id"]: item for item in handoff["required_step_evidence"]}
    expected_step_paths = {
        "required_step_output": step_contract["required_step_output"],
        "required_component_model_directory": step_contract["required_component_model_directory"],
        "required_report_output": step_contract["required_report_output"],
    }
    if set(step_evidence) != set(expected_step_paths):
        raise SystemExit("first-article route handoff STEP evidence set diverges")
    for evidence_id, expected_path in expected_step_paths.items():
        item = step_evidence[evidence_id]
        if item["source_contract"] != "routed-board-step-export-contract.yaml":
            raise SystemExit(f"first-article route handoff STEP source stale: {evidence_id}")
        if item["expected_path"] != expected_path:
            raise SystemExit(f"first-article route handoff STEP path stale: {evidence_id}")
        present = is_release_artifact_present(ROOT / expected_path)
        if item["present"] != present:
            raise SystemExit(f"first-article route handoff STEP presence stale: {evidence_id}")
        if present:
            raise SystemExit(
                f"first-article route handoff unexpectedly has STEP evidence: {evidence_id}"
            )

    mechanical_evidence = {
        item.get("release_output_id") or item.get("post_export_check_id"): item
        for item in handoff["required_mechanical_release_evidence"]
    }
    expected_mechanical = {
        "enclosure_clearance_report_using_routed_step": {
            "expected_path": release_manifest["enclosure_clearance_report_using_routed_step"][
                "expected_path"
            ],
            "production_release_path": (
                "board/kicad/e1-phone/production/reports/routed-board-clearance-release.yaml"
            ),
        },
        "full_cad_boolean_interference_passed": {
            "expected_path": "mechanical/e1-phone/review/full-cad-boolean-interference.json",
            "production_release_path": (
                "board/kicad/e1-phone/production/reports/full-cad-boolean-interference-release.yaml"
            ),
        },
    }
    if set(mechanical_evidence) != set(expected_mechanical):
        raise SystemExit("first-article route handoff mechanical evidence set diverges")
    for evidence_id, expected in expected_mechanical.items():
        item = mechanical_evidence[evidence_id]
        for key, value in expected.items():
            if item[key] != value:
                raise SystemExit(
                    f"first-article route handoff mechanical path stale: {evidence_id}"
                )
        release_present = is_release_artifact_present(ROOT / expected["production_release_path"])
        if item["present"] != release_present:
            raise SystemExit(
                f"first-article route handoff mechanical presence stale: {evidence_id}"
            )
        if release_present:
            raise SystemExit(
                f"first-article route handoff unexpectedly has mechanical release evidence: {evidence_id}"
            )
    for blocker in [
        "routed KiCad PCB and DRC evidence are absent",
        "zone-fill report is absent",
        "routed STEP with supplier component models is absent",
        "routed-board clearance release report is absent",
        "full CAD boolean interference release report is absent",
    ]:
        if blocker not in handoff["blocked_by"]:
            raise SystemExit(f"first-article route handoff missing blocker: {blocker}")

    production_outputs = production_factory["release_output_execution"]
    inventory = order["release_output_inventory"]
    if inventory["routed_release_required_output_count"] != len(release_manifest):
        raise SystemExit("first-article route routed release output count stale")
    if inventory["routed_release_present_output_count"] != sum(
        1 for item in release_manifest.values() if item["present"]
    ):
        raise SystemExit("first-article route routed release present count stale")
    if inventory["production_factory_required_output_count"] != len(production_outputs):
        raise SystemExit("first-article route production factory output count stale")
    if inventory["production_factory_present_output_count"] != sum(
        1 for item in production_outputs if item["present"]
    ):
        raise SystemExit("first-article route production factory present count stale")
    release_gate = routed_layout["release_output_gate"]
    for key in ["ready_to_fabricate", "ready_for_enclosure", "ready_for_factory_test"]:
        inventory_key = f"routed_layout_{key}"
        if inventory[inventory_key] != release_gate[key]:
            raise SystemExit(f"first-article route readiness flag stale: {inventory_key}")
        if inventory[inventory_key] is not False:
            raise SystemExit(
                f"first-article route readiness flag unexpectedly true: {inventory_key}"
            )

    for name, value in order["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"first-article route cross-check failed: {name}")
    for blocker in [
        "supplier response packs, samples, signed drawings, pinouts, land patterns, and STEP models are missing",
        "KiCad symbols, footprints, 3D bindings, and ERC evidence are missing",
        "routed PCB, DRC, filled zones, SI/PI/RF/power reports, and production outputs are missing",
        "factory probe coordinates, limits, fixture program, first-article transcript, and fab quote are missing",
        "routed board STEP, supplier-model enclosure clearance rerun, and final readiness decision are missing",
    ]:
        if blocker not in order["release_blockers"]:
            raise SystemExit(f"first-article route order missing blocker: {blocker}")
    for claim in [
        "route_sequence_complete",
        "evt1_route_ready",
        "routed_pcb_ready",
        "manufacturing_outputs_ready",
        "factory_first_article_ready",
        "routed_step_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in order["forbidden_claims"]:
            raise SystemExit(f"first-article route order missing forbidden claim {claim}")
    print(
        "first-article route execution order ok: "
        f"{len(phases)} phases blocked, {inventory['routed_release_required_output_count']} release outputs absent"
    )


def check_post_route_validation_binding() -> None:
    binding = load_yaml(ROOT / "board/kicad/e1-phone/post-route-validation-binding.yaml")
    manifest = load_yaml(MANIFEST)
    routing_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/routing-acceptance-checklist.yaml")
    power_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/power-bringup-acceptance-checklist.yaml"
    )
    radio_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-antenna-acceptance-checklist.yaml"
    )
    factory_acceptance = load_yaml(
        ROOT / "board/kicad/e1-phone/factory-production-acceptance-checklist.yaml"
    )
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    routed_layout = load_yaml(ROOT / "board/kicad/e1-phone/routed-layout-readiness-binding.yaml")
    first_article_order = load_yaml(
        ROOT / "board/kicad/e1-phone/first-article-route-execution-order.yaml"
    )
    routed_step = load_yaml(ROOT / "board/kicad/e1-phone/routed-board-step-export-contract.yaml")
    enclosure_fit = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-fit-execution-package.yaml")
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    camera_downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )
    pcb_audit = load_yaml(ROOT / "board/kicad/e1-phone/pcb-implementation-audit.yaml")
    supplier_rfq_responses = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-rfq-response-normalization.yaml"
    )

    if binding["schema"] != "eliza.e1_phone_post_route_validation_binding.v1":
        raise SystemExit(f"unexpected post-route validation schema: {binding['schema']}")
    if (
        binding["status"]
        != "blocked_post_route_validation_requires_routed_drc_si_pi_rf_power_factory_and_enclosure_evidence"
    ):
        raise SystemExit(f"unexpected post-route validation status: {binding['status']}")
    rel = "board/kicad/e1-phone/post-route-validation-binding.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing post-route validation binding")
    if rel not in routed_layout["source_artifacts"]:
        raise SystemExit("routed layout readiness must cite post-route validation binding")
    for source in binding["source_artifacts"]:
        require_path(ROOT / source)
    for source in [
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    ]:
        if source not in binding["source_artifacts"]:
            raise SystemExit(f"post-route validation missing selected hardware source: {source}")

    expected_upstream = {
        "routing_acceptance": routing_acceptance["status"],
        "power_bringup_acceptance": power_acceptance["status"],
        "radio_antenna_acceptance": radio_acceptance["status"],
        "factory_production_acceptance": factory_acceptance["status"],
        "routed_release_plan": routed_release["status"],
        "routed_layout_readiness": routed_layout["status"],
        "first_article_route_execution_order": first_article_order["status"],
        "routed_board_step_export": routed_step["status"],
        "enclosure_fit_execution": enclosure_fit["status"],
        "pcb_implementation_audit": pcb_audit["status"],
        "supplier_rfq_response_normalization": supplier_rfq_responses["status"],
    }
    if binding["upstream_status"] != expected_upstream:
        raise SystemExit("post-route validation upstream status snapshot is stale")

    state = binding["live_pcb_validation_state"]
    live_counts = pcb_audit["live_pcb_counts"]
    for key in [
        "declared_net_count",
        "footprint_count",
        "segment_count",
        "zone_count",
        "keepout_zone_count",
    ]:
        if state[key] != live_counts[key]:
            raise SystemExit(f"post-route validation live PCB count stale: {key}")
    expected_flags = {
        "has_tracks": live_counts["segment_count"] > 0,
        "has_filled_zones": live_counts["zone_count"] > 0,
        "has_production_outputs": False,
    }
    for key, expected in expected_flags.items():
        if state[key] != expected:
            raise SystemExit(f"post-route validation release state stale: {key}")
        if state[key] is not False:
            raise SystemExit(f"post-route validation unexpectedly allows {key}")
    if state["validation_allowed"] is not False:
        raise SystemExit("post-route validation must remain blocked before routed outputs")

    routed_candidate = binding.get("local_routed_candidate_validation_state")
    if not isinstance(routed_candidate, dict):
        raise SystemExit("post-route validation missing local routed candidate state")
    for rel_path_key in [
        "board_file",
        "real_footprint_board_file",
        "real_footprint_binding",
        "source_binding",
    ]:
        require_path(ROOT / routed_candidate[rel_path_key])
    routed_candidate_path = ROOT / routed_candidate["board_file"]
    real_footprint_path = ROOT / routed_candidate["real_footprint_board_file"]
    routed_candidate_bytes = routed_candidate_path.read_bytes()
    real_footprint_bytes = real_footprint_path.read_bytes()
    routed_candidate_text = routed_candidate_bytes.decode("utf-8")
    expected_routed_candidate_state = {
        "board_sha256": hashlib.sha256(routed_candidate_bytes).hexdigest(),
        "real_footprint_board_sha256": hashlib.sha256(real_footprint_bytes).hexdigest(),
        "matches_real_footprint_board": routed_candidate_bytes == real_footprint_bytes,
        "footprint_count": routed_candidate_text.count('(footprint "'),
        "legacy_e1phone_footprint_ref_count": routed_candidate_text.count('(footprint "E1Phone:'),
        "placeholder_marker_count": routed_candidate_text.count(
            "placeholder_not_fabrication_footprint"
        ),
        "segment_count": routed_candidate_text.count("\n  (segment "),
        "via_count": routed_candidate_text.count("\n  (via "),
        "zone_count": routed_candidate_text.count("\n  (zone "),
        "filled_zone_count": routed_candidate_text.count("(filled_polygon"),
        "has_tracks": routed_candidate_text.count("\n  (segment ") > 0,
        "has_filled_zones": routed_candidate_text.count("(filled_polygon") > 0,
        "has_production_outputs": False,
        "validation_allowed": False,
        "release_credit": False,
        "release_state": "blocked_local_routed_real_footprint_candidate_not_release",
    }
    for key, expected in expected_routed_candidate_state.items():
        if routed_candidate.get(key) != expected:
            raise SystemExit(f"post-route validation local routed candidate state stale: {key}")
    if (
        int(routed_candidate["segment_count"]) <= 0
        or int(routed_candidate["via_count"]) <= 0
        or int(routed_candidate["filled_zone_count"]) <= 0
    ):
        raise SystemExit("post-route validation local routed candidate lacks route evidence")

    outputs = binding["required_validation_outputs"]
    present_outputs = [
        name for name, rel_path in outputs.items() if is_release_artifact_present(ROOT / rel_path)
    ]
    inventory = binding["validation_output_inventory"]
    if inventory["required_output_count"] != len(outputs):
        raise SystemExit("post-route validation output count stale")
    if inventory["present_output_count"] != len(present_outputs):
        raise SystemExit("post-route validation present output count stale")
    if inventory["missing_output_count"] != len(outputs) - len(present_outputs):
        raise SystemExit("post-route validation missing output count stale")
    if present_outputs:
        raise SystemExit(f"post-route validation outputs unexpectedly present: {present_outputs}")
    if inventory["every_required_output_absent"] is not True:
        raise SystemExit("post-route validation must record all outputs absent")

    routing_items = {item["id"] for item in routing_acceptance["acceptance_items"]}
    power_items = {item["id"] for item in power_acceptance["acceptance_items"]}
    radio_items = {item["id"] for item in radio_acceptance["acceptance_items"]}
    factory_items = {item["id"] for item in factory_acceptance["acceptance_items"]}
    known_items = routing_items | power_items | radio_items | factory_items
    domains = binding["validation_domains"]
    if len(domains) != 6:
        raise SystemExit("post-route validation domain count changed")
    for domain in domains:
        if not domain["status"].startswith("blocked_"):
            raise SystemExit(f"post-route validation domain unexpectedly open: {domain['id']}")
        if domain["source_acceptance_item"] not in known_items:
            raise SystemExit(
                f"post-route validation domain references unknown acceptance item: {domain['id']}"
            )
        for output_key in domain["required_outputs"]:
            if output_key not in outputs:
                raise SystemExit(
                    f"post-route validation domain references unknown output: {output_key}"
                )

    expected_usb_stack = usb_sidekey_selection["selected_hardware_stack"]
    expected_radio_stack = radio_selection["selected_wireless_stack"]
    expected_selected_hardware = {
        "display_touch": display_downselect["selected_screen_decision"]["part"],
        "rear_front_cameras": "Sincere_First_OV13855_rear_and_GC5035_front",
        "usb_c_power_sidekeys": "_".join(
            [
                expected_usb_stack["usb_c_evt0_connector"]["vendor"],
                expected_usb_stack["usb_c_evt0_connector"]["family"],
                expected_usb_stack["usb_pd_controller"]["part"],
                expected_usb_stack["charger_power_path"]["part"],
                expected_usb_stack["side_key_primary"]["vendor"],
                expected_usb_stack["side_key_primary"]["family"],
            ]
        ),
        "cellular": f"{expected_radio_stack['cellular_performance_reference']['vendor']}_"
        f"{expected_radio_stack['cellular_performance_reference']['family']}_RedCap_reference",
        "wifi_bluetooth": f"{expected_radio_stack['wifi_bluetooth_primary']['vendor']}_"
        f"{expected_radio_stack['wifi_bluetooth_primary']['order_number']}",
    }
    expected_sources = {
        "display_touch": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "rear_front_cameras": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "usb_c_power_sidekeys": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "cellular": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "wifi_bluetooth": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
    }
    expected_domains_by_function = {
        "display_touch": "high_speed_si_pi",
        "rear_front_cameras": "high_speed_si_pi",
        "usb_c_power_sidekeys": "power_thermal",
        "cellular": "rf_wireless",
        "wifi_bluetooth": "rf_wireless",
    }
    matrix = {item["function"]: item for item in binding["selected_hardware_validation_matrix"]}
    if set(matrix) != set(expected_selected_hardware):
        raise SystemExit("post-route selected hardware validation matrix set diverges")
    domain_ids = {domain["id"] for domain in domains}
    for function, item in matrix.items():
        if item["selected_hardware"] != expected_selected_hardware[function]:
            raise SystemExit(f"post-route selected hardware value stale: {function}")
        if item["source_artifact"] != expected_sources[function]:
            raise SystemExit(f"post-route selected hardware source stale: {function}")
        if item["validation_domain"] != expected_domains_by_function[function]:
            raise SystemExit(f"post-route selected hardware domain stale: {function}")
        if item["validation_domain"] not in domain_ids:
            raise SystemExit(f"post-route selected hardware unknown domain: {function}")
        if not item["status"].startswith("blocked_missing_"):
            raise SystemExit(f"post-route selected hardware unexpectedly open: {function}")
        for output_key in item["required_outputs"]:
            if output_key not in outputs:
                raise SystemExit(
                    f"post-route selected hardware references unknown output: {function} {output_key}"
                )
        if "routed_board_step" not in item["required_outputs"]:
            raise SystemExit(f"post-route selected hardware missing routed STEP output: {function}")
        if "routed_clearance_release" not in item["required_outputs"]:
            raise SystemExit(
                f"post-route selected hardware missing enclosure clearance output: {function}"
            )
        if len(item["required_evidence"]) < 3:
            raise SystemExit(f"post-route selected hardware evidence too weak: {function}")
        present_evidence = [
            path for path in item["required_evidence"] if is_release_artifact_present(ROOT / path)
        ]
        if present_evidence:
            raise SystemExit(
                f"post-route selected hardware evidence unexpectedly present: {present_evidence}"
            )
    if (
        camera_downselect["status"]
        != "blocked_camera_module_xy_z_downselect_requires_supplier_drawings_and_samples"
    ):
        raise SystemExit("post-route camera downselect status unexpectedly changed")
    if radio_selection["placement_fit_decision"]["cellular_current_region"]["fits_current_region"]:
        raise SystemExit(
            "post-route validation cannot pass while cellular region still fits falsely"
        )

    handoff = binding["route_to_enclosure_validation_handoff"]
    if (
        handoff["status"]
        != "blocked_until_route_validation_outputs_and_routed_step_clearance_release_exist"
    ):
        raise SystemExit("post-route validation route-to-enclosure handoff status stale")
    if (
        handoff["source_execution_order"]
        != "board/kicad/e1-phone/first-article-route-execution-order.yaml"
    ):
        raise SystemExit("post-route validation handoff source execution order stale")
    if (
        handoff["route_handoff_status"]
        != first_article_order["route_to_enclosure_handoff"]["status"]
    ):
        raise SystemExit("post-route validation handoff route status stale")
    if handoff["validation_allowed_before_handoff_complete"] is not False:
        raise SystemExit("post-route validation handoff unexpectedly allows validation")
    required_handoff_keys = [
        "routed_kicad_pcb",
        "pcb_drc_report",
        "zone_fill_report",
        "routed_board_step",
        "routed_clearance_release",
    ]
    if handoff["required_output_keys"] != required_handoff_keys:
        raise SystemExit("post-route validation handoff output key order diverges")
    expected_handoff_paths = {key: outputs[key] for key in required_handoff_keys}
    if handoff["required_output_paths"] != expected_handoff_paths:
        raise SystemExit("post-route validation handoff output paths stale")
    handoff_present = [
        key
        for key, rel_path in handoff["required_output_paths"].items()
        if is_release_artifact_present(ROOT / rel_path)
    ]
    if handoff["present_output_count"] != len(handoff_present):
        raise SystemExit("post-route validation handoff present count stale")
    if handoff["missing_output_count"] != len(required_handoff_keys) - len(handoff_present):
        raise SystemExit("post-route validation handoff missing count stale")
    if handoff_present:
        raise SystemExit(
            f"post-route validation handoff outputs unexpectedly present: {handoff_present}"
        )
    for flag in [
        "enclosure_release_blocked",
        "fabrication_release_blocked",
        "factory_release_blocked",
    ]:
        if handoff[flag] is not True:
            raise SystemExit(f"post-route validation handoff unexpectedly opened {flag}")

    release_outputs = routed_release["required_release_output_manifest"]
    for key in [
        "schematic_erc_report",
        "pcb_drc_report",
        "routed_kicad_pcb",
        "filled_zones",
        "si_pi_reports",
        "rf_reports",
        "power_thermal_measurements",
        "factory_test_limits",
        "first_article_traveler",
        "board_step_with_supplier_models",
        "enclosure_clearance_report_using_routed_step",
    ]:
        if key not in release_outputs:
            raise SystemExit(f"post-route validation missing routed release output {key}")
        if release_outputs[key]["present"] is not False:
            raise SystemExit(f"post-route validation release output unexpectedly present: {key}")

    release_gate = routed_layout["release_output_gate"]
    coupling = binding["release_coupling"]
    if coupling["blocks_ready_to_fabricate"] != (not release_gate["ready_to_fabricate"]):
        raise SystemExit("post-route validation fabrication coupling stale")
    if coupling["blocks_ready_for_enclosure"] != (not release_gate["ready_for_enclosure"]):
        raise SystemExit("post-route validation enclosure coupling stale")
    if coupling["blocks_ready_for_factory_test"] != (not release_gate["ready_for_factory_test"]):
        raise SystemExit("post-route validation factory coupling stale")
    if coupling["blocks_end_to_end_phone_ready"] is not True:
        raise SystemExit("post-route validation must block end-to-end readiness")

    for name, value in binding["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"post-route validation cross-check failed: {name}")
    for blocker in [
        "local routed KiCad PCB candidate exists, but release DRC/ERC/zone-fill evidence is blocked by 2304 DRC rows, 366 ERC rows, and no signed waivers",
        "post-route SI/PI length, skew, impedance, return-path, current-density, and load-step evidence is missing",
        "RF VNA, conducted, coexistence, regulatory, SAR, and factory RF calibration evidence is missing",
        "USB-C PD, charger, battery, PMIC, rail sequencing, thermal soak, and power factory limits are missing",
        "factory probe coordinates, test limits, first-article transcript, and traveler are missing",
        "selected display, camera, USB-C/power/side-key, cellular, and Wi-Fi/Bluetooth validation evidence is missing",
        "routed board STEP, supplier models, and enclosure clearance release evidence are missing",
    ]:
        if blocker not in binding["release_blockers"]:
            raise SystemExit(f"post-route validation missing blocker: {blocker}")
    for claim in [
        "post_route_validated",
        "drc_clean",
        "erc_clean",
        "si_pi_ready",
        "rf_ready",
        "power_thermal_ready",
        "factory_test_ready",
        "first_article_ready",
        "routed_step_ready",
        "fabrication_ready",
        "enclosure_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in binding["forbidden_claims"]:
            raise SystemExit(f"post-route validation missing forbidden claim {claim}")
    print(
        "post-route validation binding ok: "
        f"{len(domains)} domains blocked, {len(outputs)} validation outputs absent"
    )


def check_board_optimization_scorecard() -> None:
    scorecard = load_yaml(ROOT / "board/kicad/e1-phone/board-optimization-scorecard.yaml")
    metrics = load_yaml(ROOT / "docs/board/e1-phone-mainboard-metrics.yaml")
    utilization = load_yaml(ROOT / "board/kicad/e1-phone/layout-utilization.yaml")
    display_fit = load_yaml(ROOT / "board/kicad/e1-phone/display-fit.yaml")
    feasibility = load_yaml(ROOT / "board/kicad/e1-phone/route-feasibility-density.yaml")
    routing = load_yaml(ROOT / "board/kicad/e1-phone/routing-constraints.yaml")
    rf = load_yaml(ROOT / "board/kicad/e1-phone/rf-connectivity-closure.yaml")
    power = load_yaml(ROOT / "board/kicad/e1-phone/power-thermal-budget.yaml")
    enclosure = load_yaml(ROOT / "board/kicad/e1-phone/enclosure-placement-closure.yaml")
    external = load_yaml(ROOT / "board/kicad/e1-phone/external-interface-design-review.yaml")
    factory_probe = load_yaml(ROOT / "board/kicad/e1-phone/factory-probe-map.yaml")
    manifest = load_yaml(MANIFEST)

    if scorecard["schema"] != "eliza.e1_phone_board_optimization_scorecard.v1":
        raise SystemExit("board optimization scorecard schema diverges")
    if scorecard["status"] != "blocked_concept_optimized_but_not_routed_or_enclosure_ready":
        raise SystemExit(f"unexpected board optimization scorecard status: {scorecard['status']}")
    rel = "board/kicad/e1-phone/board-optimization-scorecard.yaml"
    if rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing board optimization scorecard artifact")
    for source in scorecard["source_artifacts"]:
        require_path(ROOT / source)

    target = scorecard["optimization_target"]
    if (
        target["device_envelope_mm"]
        != metrics["industrial_design_assumptions"]["device_envelope_mm"]
    ):
        raise SystemExit("board optimization device envelope diverges from metrics")
    if target["device_envelope_mm"] != display_fit["current_device_envelope_mm"]:
        raise SystemExit("board optimization device envelope diverges from display fit")
    if target["board_bbox_mm"] != metrics["mainboard_outline_concept"]["bounding_box_mm"]:
        raise SystemExit("board optimization board bbox diverges from metrics")
    if target["board_bbox_mm"] != utilization["board_bbox_mm"]:
        raise SystemExit("board optimization board bbox diverges from layout utilization")
    if (
        target["physical_pcb_island_area_mm2"]
        != utilization["physical_pcb_area_from_edge_cuts_mm2"]
    ):
        raise SystemExit("board optimization physical PCB island area diverges")
    if target["battery_window_mm"] != utilization["battery_window_mm"]:
        raise SystemExit("board optimization battery window diverges from layout utilization")
    metrics_battery = metrics["industrial_design_assumptions"]["selected_battery_reference_pack_mm"]
    if target["selected_battery_reference_mm"] != metrics_battery:
        raise SystemExit("board optimization battery reference diverges from metrics")
    if (
        target["target_stackup"]
        != metrics["mainboard_outline_concept"]["recommended_layer_stackup"]
    ):
        raise SystemExit("board optimization stackup target diverges from metrics")

    display = scorecard["scorecard"]["display_fit"]
    if (
        display["selected_display_outline_mm"]
        != display_fit["selected_primary_display"]["outline_mm"]
    ):
        raise SystemExit("board optimization display outline diverges")
    if display["active_area_mm"] != display_fit["selected_primary_display"]["active_area_mm"]:
        raise SystemExit("board optimization display active area diverges")
    if (
        display["clearance_in_device_envelope_mm"]
        != display_fit["primary_clearance_in_current_envelope_mm"]
    ):
        raise SystemExit("board optimization display clearance diverges")
    if display["status"] != "pass_for_concept":
        raise SystemExit("board optimization display fit must remain concept-only pass")

    board_size = scorecard["scorecard"]["board_size"]
    if (
        board_size["pcb_area_of_bbox_pct"]
        != metrics["mainboard_outline_concept"]["pcb_area_utilization_of_bounding_box_pct"]
    ):
        raise SystemExit("board optimization PCB area percentage diverges")
    behind = display_fit["board_fit_behind_primary_display"]
    if (
        board_size["board_width_margin_from_display_outline_mm"]
        != behind["width_margin_from_display_outline_mm"]
    ):
        raise SystemExit("board optimization board width margin diverges")
    if (
        board_size["board_height_margin_from_display_outline_mm"]
        != behind["height_margin_from_display_outline_mm"]
    ):
        raise SystemExit("board optimization board height margin diverges")
    if board_size["topology"] != metrics["mainboard_outline_concept"]["architecture"]:
        raise SystemExit("board optimization topology diverges")

    wasted = scorecard["scorecard"]["wasted_space"]
    if (
        wasted["concept_route_shield_test_reserve_area_mm2"]
        != utilization["route_shield_test_reserve_area_mm2"]
    ):
        raise SystemExit("board optimization reserve area diverges")
    if (
        wasted["concept_route_shield_test_reserve_pct"]
        != utilization["route_shield_test_reserve_pct_of_placement_area"]
    ):
        raise SystemExit("board optimization reserve percentage diverges")
    if (
        wasted["target_unallocated_pct_after_layout"]
        != metrics["placement_area_budget"]["target_unallocated_pct_after_layout"]
    ):
        raise SystemExit("board optimization wasted-space target diverges")
    if (
        wasted["post_footprint_reserve_target_pct_range"]
        != feasibility["geometry_pressure"]["post_footprint_reserve_target_pct_range"]
    ):
        raise SystemExit("board optimization post-footprint reserve target diverges")
    if not (
        wasted["target_unallocated_pct_after_layout"]["min_pct"]
        <= wasted["concept_route_shield_test_reserve_pct"]
        <= wasted["target_unallocated_pct_after_layout"]["max_pct"]
    ):
        raise SystemExit("board optimization concept reserve outside target pressure band")

    route = scorecard["scorecard"]["route_density"]
    route_counts = feasibility["interface_complexity_counts"]
    for key in [
        "differential_pair_count_required",
        "high_speed_domains",
        "single_ended_bus_count_required",
        "rf_feed_count_required",
        "factory_power_test_points_required",
        "split_interconnect_min_contacts",
        "declared_concept_net_count",
        "assigned_concept_pad_net_count",
    ]:
        if route[key] != route_counts[key]:
            raise SystemExit(f"board optimization route-density field stale: {key}")
    if route["differential_pair_count_required"] != len(routing["differential_pairs"]):
        raise SystemExit("board optimization diff-pair count diverges from routing constraints")
    if route["rf_feed_count_required"] != len(routing["rf_layout"]["matching_networks_required"]):
        raise SystemExit("board optimization RF feed count diverges from routing constraints")
    if not route["status"].startswith("blocked_"):
        raise SystemExit("board optimization route density unexpectedly open")

    power_eff = scorecard["scorecard"]["power_efficiency"]
    power_targets = power["power_targets"]
    if power_eff["battery_energy_wh"] != power["battery_target"]["nominal_energy_wh"]:
        raise SystemExit("board optimization battery energy diverges from power budget")
    if power_eff["pd_power_margin_w"] != power["usb_c_power_path"]["pd_power_margin_w"]:
        raise SystemExit("board optimization PD power margin diverges")
    if (
        power_eff["charge_path_peak_efficiency_pct_min"]
        != power_targets["charge_path_peak_efficiency_pct_min"]
    ):
        raise SystemExit("board optimization charge efficiency target diverges")
    if power_eff["buck_peak_efficiency_pct_min"] != power_targets["buck_peak_efficiency_pct_min"]:
        raise SystemExit("board optimization buck efficiency target diverges")
    runtime = power["runtime_estimates_from_selected_pack_target"]
    if power_eff["video_call_hours_at_target"] != runtime["video_call_hours_at_target"]:
        raise SystemExit("board optimization video-call runtime diverges")
    if (
        power_eff["sustained_ai_hours_at_skin_limited_budget"]
        != runtime["sustained_ai_hours_at_skin_limited_budget"]
    ):
        raise SystemExit("board optimization sustained-AI runtime diverges")

    thermal = scorecard["scorecard"]["thermal"]
    thermal_budget = power["thermal_management"]
    if thermal["skin_limit_c"] != thermal_budget["skin_limit_c"]:
        raise SystemExit("board optimization thermal skin limit diverges")
    if (
        thermal["sustained_ai_workload_skin_limited_w"]
        != power_targets["sustained_ai_workload_skin_limited_w"]
    ):
        raise SystemExit("board optimization thermal workload target diverges")
    if thermal["hotspot_risks"] != [
        "soc_lpddr_ufs_cluster",
        "pmic_charger_power_path",
        "redcap_modem_tx_bursts",
        "display_bias_and_backlight",
    ]:
        raise SystemExit("board optimization thermal hotspot risks changed")
    if not thermal["status"].startswith("blocked_"):
        raise SystemExit("board optimization thermal section unexpectedly open")

    rf_section = scorecard["scorecard"]["rf_connectivity"]
    if rf_section["rf_feed_count_required"] != len(rf["required_rf_nets"]):
        raise SystemExit("board optimization RF feed count diverges from RF closure")
    if rf_section["rf_feed_count_required"] != len(
        routing["rf_layout"]["matching_networks_required"]
    ):
        raise SystemExit("board optimization RF feed count diverges from RF matching networks")
    for required in ["VNA", "SAR", "carrier"]:
        if not any(required in item for item in rf_section["required_measurements"]):
            raise SystemExit(f"board optimization RF measurements missing {required}")
    if not rf_section["status"].startswith("blocked_"):
        raise SystemExit("board optimization RF section unexpectedly open")

    enclosure_fit = scorecard["scorecard"]["enclosure_fit"]
    fit = enclosure["fit_and_clearance"]
    if enclosure_fit["cad_fit_status"] != fit["fit_status"]:
        raise SystemExit("board optimization enclosure fit status diverges")
    if enclosure_fit["assembly_clearance_status"] != fit["assembly_clearance_status"]:
        raise SystemExit("board optimization enclosure clearance status diverges")
    if enclosure_fit["checked_clearance_cases"] != fit["checked_clearance_cases"]:
        raise SystemExit("board optimization enclosure clearance count diverges")
    if enclosure_fit["step_artifact_count"] != len(enclosure["step_artifacts"]):
        raise SystemExit("board optimization enclosure STEP count diverges")
    if enclosure_fit["status"] != "pass_for_concept_blocked_for_release":
        raise SystemExit("board optimization enclosure status must stay concept-only")

    factory = scorecard["scorecard"]["factory_test_access"]
    probe_domains = factory_probe["probe_domains"]
    if factory["probe_domains"] != len(probe_domains):
        raise SystemExit("board optimization factory probe domain count diverges")
    power_rails = next(item for item in probe_domains if item["id"] == "power_rails")
    if factory["power_test_points_required"] != power_rails["nets"]:
        raise SystemExit("board optimization power test-point list diverges")
    if (
        factory["power_test_points_required"]
        != power["power_layout_closure"]["rail_test_points_required"]
    ):
        raise SystemExit("board optimization power test points diverge from power budget")
    if not factory["status"].startswith("blocked_"):
        raise SystemExit("board optimization factory-test section unexpectedly open")

    if external["shared_geometry"]["device_envelope_mm"] != target["device_envelope_mm"]:
        raise SystemExit("board optimization target diverges from external interface geometry")
    if (
        external["shared_geometry"]["selected_display_outline_mm"]
        != display["selected_display_outline_mm"]
    ):
        raise SystemExit(
            "board optimization display target diverges from external interface review"
        )

    if scorecard["optimization_decision"]["current_conclusion"] != (
        "keep_78p0_x_153p6_device_and_64p0_x_132p0_split_board_for_evt1_trial_route"
    ):
        raise SystemExit("board optimization decision changed")
    if len(scorecard["optimization_decision"]["do_not_reduce_below_current_envelope_until"]) < 3:
        raise SystemExit("board optimization reduction guardrails too weak")
    for output in [
        "board/kicad/e1-phone/production/reports/board-optimization-scorecard.yaml",
        "board/kicad/e1-phone/production/reports/routed-courtyard-utilization.yaml",
        "board/kicad/e1-phone/production/reports/escape-density-via-count.yaml",
        "board/kicad/e1-phone/production/reports/power-thermal/rail-efficiency-and-soak.json",
        "board/kicad/e1-phone/production/reports/rf/antenna-coexistence-sar-prescan",
        "mechanical/e1-phone/review/routed-board-clearance.json",
    ]:
        if output not in scorecard["required_release_outputs"]:
            raise SystemExit(f"board optimization missing release output {output}")
    for key, value in scorecard["cross_checks"].items():
        if value is not True:
            raise SystemExit(f"board optimization cross-check failed: {key}")
    for blocker in [
        "routed KiCad PCB, DRC, filled zones, and post-route reports are missing",
        "real supplier footprints, courtyards, and STEP models are missing",
        "routed-courtyard utilization and escape-density reports are missing",
        "SI/PI, power efficiency, thermal soak, RF, coexistence, and SAR evidence are missing",
        "routed board STEP and formal enclosure tolerance stack are missing",
        "factory probe coordinates, limits, and first-article transcript are missing",
    ]:
        if blocker not in scorecard["release_blockers"]:
            raise SystemExit(f"board optimization missing release blocker: {blocker}")
    for claim in [
        "board_size_optimized_final",
        "wasted_space_final",
        "route_feasible",
        "power_efficient",
        "thermal_closed",
        "rf_ready",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in scorecard["forbidden_claims"]:
            raise SystemExit(f"board optimization missing forbidden claim {claim}")
    print(
        "board optimization scorecard ok: "
        f"reserve={wasted['concept_route_shield_test_reserve_pct']}%, "
        f"diff_pairs={route['differential_pair_count_required']}, "
        f"rf_feeds={rf_section['rf_feed_count_required']} fail-closed"
    )


def check_layout_optimization_execution() -> None:
    execution = load_yaml(ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml")
    manifest = load_yaml(MANIFEST)
    scorecard = load_yaml(ROOT / "board/kicad/e1-phone/board-optimization-scorecard.yaml")
    live = load_yaml(ROOT / "board/kicad/e1-phone/live-utilization-audit.yaml")
    envelopes = load_yaml(ROOT / "board/kicad/e1-phone/component-envelope-fit-audit.yaml")
    radio_envelope = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml"
    )
    cellular_top_island = load_yaml(
        ROOT / "board/kicad/e1-phone/cellular-top-island-repack-feasibility.yaml"
    )
    display_downselect = load_yaml(ROOT / "board/kicad/e1-phone/display-envelope-downselect.yaml")
    camera_downselect = load_yaml(ROOT / "board/kicad/e1-phone/camera-module-fit-downselect.yaml")
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )
    usb_sidekey_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
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
        "board/kicad/e1-phone/radio-module-envelope-orderability-gate.yaml",
        "board/kicad/e1-phone/cellular-top-island-repack-feasibility.yaml",
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/placement-repack-candidate.yaml",
        "board/kicad/e1-phone/route-feasibility-density.yaml",
        "board/kicad/e1-phone/trial-route-input-matrix.yaml",
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
        "radio_module_envelope_orderability_gate": radio_envelope["status"],
        "cellular_top_island_repack_feasibility": cellular_top_island["status"],
        "display_envelope_downselect": display_downselect["status"],
        "camera_module_fit_downselect": camera_downselect["status"],
        "radio_module_selection_wiring_decision": radio_selection["status"],
        "usb_sidekey_selection_wiring_decision": usb_sidekey_selection["status"],
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
    if geometry["display_clearance_mm"] != display_fit["primary_clearance_in_current_envelope_mm"]:
        raise SystemExit("layout optimization display clearance diverges")
    if (
        geometry["display_outline_mm"]
        != display_downselect["mechanical_fit_decision"]["primary_module_outline_mm"]
    ):
        raise SystemExit("layout optimization display outline diverges from display downselect")
    if (
        geometry["display_clearance_mm"]
        != display_downselect["mechanical_fit_decision"]["clearance_in_current_envelope_mm"]
    ):
        raise SystemExit("layout optimization display clearance diverges from display downselect")

    pressure = execution["layout_pressure_closure"]
    if (
        pressure["concept_route_shield_test_reserve_pct"]
        != live["route_reserve_pressure"]["concept_route_shield_test_reserve_pct"]
    ):
        raise SystemExit("layout optimization live reserve pressure stale")
    if pressure["battery_window_intrusion_count"] != 0:
        raise SystemExit("layout optimization battery window has live intrusions")
    if (
        pressure["active_region_overlap_count"]
        != repack["candidate_overlap_audit"]["overlap_count"]
    ):
        raise SystemExit("layout optimization active-region overlap count stale")
    if (
        pressure["known_envelope_blockers_count"]
        != envelopes["routing_impact"]["known_envelope_blockers_count"]
    ):
        raise SystemExit("layout optimization known-envelope blocker count stale")
    if not pressure["status"].startswith("blocked_"):
        raise SystemExit("layout optimization pressure closure unexpectedly unblocked")

    trace = execution["hardware_decision_traceability"]
    expected_trace_sources = {
        "display_size_anchor": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "camera_module_fit": "board/kicad/e1-phone/camera-module-fit-downselect.yaml",
        "radio_module_selection": "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "usb_sidekey_selection": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
    }
    if {key: value["source"] for key, value in trace.items()} != expected_trace_sources:
        raise SystemExit("layout optimization hardware decision traceability sources diverge")
    if (
        trace["display_size_anchor"]["selected_part"]
        != display_downselect["selected_screen_decision"]["part"]
    ):
        raise SystemExit("layout optimization display decision trace stale")
    if (
        trace["camera_module_fit"]["rejected_public_alternate"]
        not in camera_downselect["candidate_fit"]
    ):
        raise SystemExit("layout optimization camera decision trace stale")
    if (
        trace["radio_module_selection"]["primary_cellular_reference"]
        != f"Quectel_{radio_selection['selected_wireless_stack']['cellular_performance_reference']['family']}_5G_RedCap"
    ):
        raise SystemExit("layout optimization radio cellular decision trace stale")
    if (
        trace["radio_module_selection"]["wifi_bluetooth_primary"]
        != "Murata_LBEE5XV2EA_802_Type_2EA"
    ):
        raise SystemExit("layout optimization Wi-Fi/Bluetooth decision trace stale")
    if trace["usb_sidekey_selection"]["usb_evt0_connector"] != "GCT_USB4105":
        raise SystemExit("layout optimization USB decision trace stale")
    if (
        trace["usb_sidekey_selection"]["pd_controller"]
        != usb_sidekey_selection["selected_hardware_stack"]["usb_pd_controller"]["part"]
    ):
        raise SystemExit("layout optimization PD decision trace stale")
    if (
        trace["usb_sidekey_selection"]["charger"]
        != usb_sidekey_selection["selected_hardware_stack"]["charger_power_path"]["part"]
    ):
        raise SystemExit("layout optimization charger decision trace stale")
    for item_id, item in trace.items():
        if not item["status"].startswith("blocked_") or not item.get("layout_dependency"):
            raise SystemExit(f"layout optimization hardware trace must remain blocked: {item_id}")

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
        "cellular_primary_lga_module",
        "wifi_bluetooth_module",
        "display_module",
        "battery_pack",
        "side_button_primary_switch",
        "front_camera_alternate_junde",
        "front_and_rear_camera_primary",
    ]:
        if component_policy[key] != envelopes["known_component_envelopes"][key]:
            raise SystemExit(f"layout optimization component policy stale: {key}")
    if component_policy["cellular_primary_lga_module"]["fit"]["fits_xy"]:
        raise SystemExit(
            "layout optimization must reject the oversized cellular LGA in current U_CELL"
        )
    if (
        component_policy["cellular_primary_lga_module"]["fit"]["width_shortfall_mm"]
        != radio_envelope["placement_region_fit"]["cellular_primary_lga_vs_u_cell"]["fit"][
            "width_shortfall_mm"
        ]
    ):
        raise SystemExit(
            "layout optimization cellular width shortfall diverges from radio envelope gate"
        )
    if (
        component_policy["cellular_primary_lga_module"]["fit"]["height_shortfall_mm"]
        != radio_envelope["placement_region_fit"]["cellular_primary_lga_vs_u_cell"]["fit"][
            "height_shortfall_mm"
        ]
    ):
        raise SystemExit(
            "layout optimization cellular height shortfall diverges from radio envelope gate"
        )
    if (
        cellular_top_island["current_top_island_region_pressure"][
            "over_top_island_before_rf_keepouts_mm2"
        ]
        <= 0
    ):
        raise SystemExit("layout optimization must inherit cellular top island overage blocker")
    if component_policy["front_camera_alternate_junde"]["fit"]["fits_xy"]:
        raise SystemExit("layout optimization must reject the oversized Junde camera alternate")
    if (
        component_policy["front_camera_alternate_junde"]["fit"]
        != camera_downselect["candidate_fit"]["front_alternate_alibaba_junde_imx219"]["fit"]
    ):
        raise SystemExit("layout optimization camera alternate fit diverges from camera downselect")
    if not camera_downselect["status"].startswith("blocked_"):
        raise SystemExit("layout optimization camera downselect unexpectedly unblocked")
    if not component_policy["wifi_bluetooth_module"]["fit"]["fits_xy"]:
        raise SystemExit("layout optimization Wi-Fi/Bluetooth known outline no longer fits")

    placement = execution["placement_repack_policy"]
    if placement["candidate_regions_mm"] != repack["candidate_regions_mm"]:
        raise SystemExit("layout optimization placement candidate regions stale")
    if placement["battery_window_audit"]["candidate_intrusion_count"] != 0:
        raise SystemExit("layout optimization placement candidate intrudes into battery")
    if len(placement["region_semantics_changes_required"]) < 4:
        raise SystemExit("layout optimization must preserve region-semantics changes")

    release_outputs = {item["id"]: item for item in execution["routed_release_output_dependencies"]}
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
    usb_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml"
    )
    usb_acceptance = load_yaml(ROOT / "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml")
    radio_selection = load_yaml(
        ROOT / "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml"
    )
    module_rf = load_yaml(ROOT / "board/kicad/e1-phone/module-rf-pinout-execution.yaml")
    routed_release = load_yaml(ROOT / "board/kicad/e1-phone/routed-release-plan.yaml")
    routed_pcb = load_yaml(ROOT / "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml")
    first_article_order = load_yaml(
        ROOT / "board/kicad/e1-phone/first-article-route-execution-order.yaml"
    )
    post_route_validation = load_yaml(
        ROOT / "board/kicad/e1-phone/post-route-validation-binding.yaml"
    )
    layout = load_yaml(ROOT / "board/kicad/e1-phone/layout-optimization-execution.yaml")
    supplier_sample_gate = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-sample-release-gate.yaml"
    )
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
        "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml",
        "board/kicad/e1-phone/display-camera-connector-pinout-execution.yaml",
        "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/usb-sidekey-acceptance-checklist.yaml",
        "board/kicad/e1-phone/radio-module-selection-wiring-decision.yaml",
        "board/kicad/e1-phone/module-rf-pinout-execution.yaml",
        "board/kicad/e1-phone/routed-release-plan.yaml",
        "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
        "board/kicad/e1-phone/first-article-route-execution-order.yaml",
        "board/kicad/e1-phone/post-route-validation-binding.yaml",
        "board/kicad/e1-phone/layout-optimization-execution.yaml",
        "board/kicad/e1-phone/supplier-sample-release-gate.yaml",
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
        "usb_sidekey_selection_wiring_decision_status": usb_selection["status"],
        "usb_sidekey_acceptance_status": usb_acceptance["status"],
        "radio_module_selection_wiring_decision_status": radio_selection["status"],
        "module_rf_pinout_execution_status": module_rf["status"],
        "routed_release_plan_status": routed_release["status"],
        "routed_pcb_implementation_execution_status": routed_pcb["status"],
        "first_article_route_execution_order_status": first_article_order["status"],
        "post_route_validation_binding_status": post_route_validation["status"],
        "layout_optimization_execution_status": layout["status"],
        "supplier_sample_release_gate_status": supplier_sample_gate["status"],
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
        "popular_screen_size_fit": "board/kicad/e1-phone/display-envelope-downselect.yaml",
        "screen_camera_oem_sourcing": "board/kicad/e1-phone/display-camera-oem-source-revalidation.yaml",
        "usb_c_power_volume_hardware": "board/kicad/e1-phone/usb-sidekey-selection-wiring-decision.yaml",
        "off_the_shelf_wireless_modules": "board/kicad/e1-phone/wireless-module-release-execution.yaml",
        "board_size_power_rf_thermal_optimization": "board/kicad/e1-phone/layout-optimization-execution.yaml",
        "supplier_footprints_pinouts_and_3d_models": "board/kicad/e1-phone/supplier-to-kicad-evidence-map.yaml",
        "schematic_and_pcb_routed_release": "board/kicad/e1-phone/routed-pcb-implementation-execution.yaml",
        "component_height_and_enclosure_step": "board/kicad/e1-phone/enclosure-fit-execution-package.yaml",
        "manufacturing_and_factory_release": "board/kicad/e1-phone/production-factory-release-execution.yaml",
    }
    for objective, evidence_path in expected_evidence.items():
        if objectives[objective]["evidence_artifact"] != evidence_path:
            raise SystemExit(f"end-to-end readiness evidence artifact stale: {objective}")

    selected_usb = objectives["usb_c_power_volume_hardware"].get("selected_stack", {})
    usb_stack = usb_selection["selected_hardware_stack"]
    expected_usb_stack = {
        "usb_c_connector": f"{usb_stack['usb_c_evt0_connector']['vendor']}_{usb_stack['usb_c_evt0_connector']['family']}",
        "usb_pd_controller": usb_stack["usb_pd_controller"]["part"],
        "charger_power_path": usb_stack["charger_power_path"]["part"],
        "side_key_primary": (
            f"{usb_stack['side_key_primary']['vendor']}_{usb_stack['side_key_primary']['family']}"
        ),
    }
    if selected_usb != expected_usb_stack:
        raise SystemExit("end-to-end readiness USB/sidekey selected stack stale")

    selected_radio = objectives["off_the_shelf_wireless_modules"].get("selected_stack", {})
    radio_stack = radio_selection["selected_wireless_stack"]
    expected_radio_stack = {
        "cellular_performance_reference": (
            f"{radio_stack['cellular_performance_reference']['vendor']}_"
            f"{radio_stack['cellular_performance_reference']['family']}_"
            f"{radio_stack['cellular_performance_reference']['class']}"
        ),
        "active_space_saving_rfq_branch": (
            radio_stack["cellular_space_saving_branch"]["preferred_candidate_id"]
        ),
        "wifi_bluetooth_primary": (
            f"{radio_stack['wifi_bluetooth_primary']['vendor']}_"
            f"{radio_stack['wifi_bluetooth_primary']['order_number']}_"
            f"{radio_stack['wifi_bluetooth_primary']['chipset']}"
        ),
        "rf_feed_count_required": radio_selection["rf_feed_contract"]["required_rf_feed_count"],
    }
    if selected_radio != expected_radio_stack:
        raise SystemExit("end-to-end readiness radio selected stack stale")

    selected_gate = readiness["selected_hardware_post_route_gate"]
    post_route_matrix = post_route_validation["selected_hardware_validation_matrix"]
    post_route_functions = [item["function"] for item in post_route_matrix]
    expected_functions = [
        "display_touch",
        "rear_front_cameras",
        "usb_c_power_sidekeys",
        "cellular",
        "wifi_bluetooth",
    ]
    if (
        selected_gate["source_artifact"]
        != "board/kicad/e1-phone/post-route-validation-binding.yaml"
    ):
        raise SystemExit("end-to-end selected hardware gate source stale")
    if selected_gate["status"] != post_route_validation["status"]:
        raise SystemExit("end-to-end selected hardware post-route status stale")
    if selected_gate["required_functions"] != expected_functions:
        raise SystemExit("end-to-end selected hardware function order diverges")
    if post_route_functions != expected_functions:
        raise SystemExit("end-to-end selected hardware functions diverge from post-route matrix")
    if selected_gate["required_function_count"] != len(post_route_matrix):
        raise SystemExit("end-to-end selected hardware function count stale")
    blocked_count = sum(1 for item in post_route_matrix if item["status"].startswith("blocked_"))
    if selected_gate["blocked_function_count"] != blocked_count:
        raise SystemExit("end-to-end selected hardware blocked count stale")
    if blocked_count != len(post_route_matrix):
        raise SystemExit("end-to-end selected hardware matrix unexpectedly open")
    matrix_domains = sorted({item["validation_domain"] for item in post_route_matrix})
    if selected_gate["required_validation_domains"] != matrix_domains:
        raise SystemExit("end-to-end selected hardware validation domains stale")
    post_route_outputs = post_route_validation["required_validation_outputs"]
    expected_output_paths = [
        post_route_outputs["si_pi_report_directory"],
        post_route_outputs["rf_report_directory"],
        post_route_outputs["power_thermal_report_directory"],
        post_route_outputs["supplier_component_3d_model_manifest"],
        post_route_outputs["routed_board_step"],
        post_route_outputs["routed_clearance_release"],
    ]
    if selected_gate["release_required_outputs"] != expected_output_paths:
        raise SystemExit("end-to-end selected hardware release outputs stale")
    evidence_paths = [
        evidence for item in post_route_matrix for evidence in item["required_evidence"]
    ]
    present_evidence = [path for path in evidence_paths if is_release_artifact_present(ROOT / path)]
    if present_evidence:
        raise SystemExit(
            f"end-to-end selected hardware evidence unexpectedly present: {present_evidence}"
        )
    if selected_gate["all_selected_hardware_evidence_absent"] is not True:
        raise SystemExit("end-to-end selected hardware gate must record absent evidence")
    if selected_gate["blocks_end_to_end_phone_ready"] is not True:
        raise SystemExit("end-to-end selected hardware gate must block final readiness")

    production_gate = readiness["selected_hardware_production_gate"]
    production_coupling = production_factory["selected_hardware_release_coupling"]
    production_records = production_coupling["functions"]
    production_functions = [item["function"] for item in production_records]
    if (
        production_gate["source_artifact"]
        != "board/kicad/e1-phone/production-factory-release-execution.yaml"
    ):
        raise SystemExit("end-to-end selected hardware production gate source stale")
    if production_gate["status"] != production_coupling["status"]:
        raise SystemExit("end-to-end selected hardware production gate status stale")
    if production_gate["required_functions"] != expected_functions:
        raise SystemExit("end-to-end selected hardware production function order diverges")
    if production_functions != expected_functions:
        raise SystemExit("end-to-end production hardware functions diverge from release coupling")
    if production_gate["required_function_count"] != production_coupling["function_count"]:
        raise SystemExit("end-to-end selected hardware production count stale")
    production_blocked_count = sum(
        1 for item in production_records if item["status"].startswith("blocked_")
    )
    if production_gate["blocked_function_count"] != production_blocked_count:
        raise SystemExit("end-to-end selected hardware production blocked count stale")
    if production_blocked_count != len(production_records):
        raise SystemExit("end-to-end selected hardware production coupling unexpectedly open")
    fixture_domains = sorted(
        {domain for item in production_records for domain in item["required_fixture_domains"]}
    )
    if production_gate["required_fixture_domains"] != fixture_domains:
        raise SystemExit("end-to-end selected hardware production fixture domains stale")
    output_ids = sorted(
        {output for item in production_records for output in item["required_release_outputs"]}
    )
    if production_gate["release_output_ids"] != output_ids:
        raise SystemExit("end-to-end selected hardware production output IDs stale")
    release_output_execution = {
        item["id"]: item for item in production_factory["release_output_execution"]
    }
    for output_id in output_ids:
        if output_id not in release_output_execution:
            raise SystemExit(f"end-to-end selected hardware production output missing: {output_id}")
        if release_output_execution[output_id]["present"]:
            raise SystemExit(
                f"end-to-end selected hardware production output unexpectedly present: {output_id}"
            )
    if production_gate["all_selected_hardware_traceability_absent"] is not True:
        raise SystemExit("end-to-end selected hardware production gate must record absent evidence")
    if production_gate["blocks_end_to_end_phone_ready"] is not True:
        raise SystemExit("end-to-end selected hardware production gate must block final readiness")

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


def check_supplier_pinout_evidence() -> None:
    pinout_dir = ROOT / "board/kicad/e1-phone/supplier-pinouts"
    manifest = load_yaml(pinout_dir / "pinout-evidence-manifest.yaml")
    if manifest["schema"] != "eliza.e1_phone_supplier_pinout_manifest.v1":
        raise SystemExit(f"unexpected supplier pinout manifest schema: {manifest['schema']}")
    for source in manifest["source_artifacts"]:
        require_path(ROOT / source)
    captured = manifest["captured_pinouts"]
    if not captured:
        raise SystemExit("supplier pinout manifest captured nothing")
    allowed_evidence_classes = set(manifest["cross_checks"]["captured_files_evidence_class"])
    public_pinout_evidence_classes = {
        "public_supplier_datasheet",
        "public_som_connector_pinout",
        "public_hardware_design_pdf",
    }
    if not allowed_evidence_classes <= public_pinout_evidence_classes:
        raise SystemExit(
            "supplier pinout manifest declares a non-public evidence class: "
            f"{sorted(allowed_evidence_classes)}"
        )
    seen_files = set()
    complete_pin_table_files = 0
    for entry in captured:
        rel = pinout_dir / entry["file"]
        require_path(rel)
        seen_files.add(entry["file"])
        pinout = load_yaml(rel)
        if pinout["schema"] not in {
            "eliza.e1_phone_supplier_pinout.v1",
            "eliza.e1_phone_supplier_pinout_som.v1",
        }:
            raise SystemExit(f"unexpected pinout schema in {entry['file']}: {pinout['schema']}")
        if pinout["evidence_class"] not in allowed_evidence_classes:
            raise SystemExit(
                f"supplier pinout {entry['file']} is not public-datasheet evidence: "
                f"{pinout['evidence_class']}"
            )
        if "evidence_class" in entry and entry["evidence_class"] != pinout["evidence_class"]:
            raise SystemExit(f"supplier pinout manifest evidence class diverges: {entry['file']}")
        source_doc = pinout.get("source_doc")
        if isinstance(source_doc, str):
            urls = [source_doc]
        elif isinstance(source_doc, list):
            urls = [item["url"] if isinstance(item, dict) else item for item in source_doc]
        else:
            urls = []
        if not any(str(url).startswith("http") for url in urls):
            raise SystemExit(f"supplier pinout {entry['file']} lacks a public source_doc URL")
        pins = pinout.get("pins")
        mechanical = pinout.get("mechanical", {})
        expected_pin_count = (
            mechanical.get("electrical_pad_count_with_exposed_pads")
            or mechanical.get("pin_count")
            or mechanical.get("bump_count")
        )
        if isinstance(pins, list) and expected_pin_count and len(pins) == int(expected_pin_count):
            complete_pin_table_files += 1
            completeness = str(entry.get("completeness", ""))
            if "interface_groups_only" in completeness:
                raise SystemExit(
                    "supplier pinout manifest completeness is stale for a full pin table: "
                    f"{entry['file']}"
                )

    on_disk = {p.name for p in pinout_dir.glob("*-pinout.yaml")}
    if on_disk != seen_files:
        raise SystemExit(
            "supplier pinout directory and manifest diverge: "
            f"on_disk_only={sorted(on_disk - seen_files)} manifest_only={sorted(seen_files - on_disk)}"
        )

    cross_checks = manifest["cross_checks"]
    if cross_checks["total_captured"] != len(captured):
        raise SystemExit("supplier pinout manifest total_captured stale")
    if cross_checks["every_captured_file_present_on_disk"] is not True:
        raise SystemExit("supplier pinout manifest must keep every captured file present on disk")
    if cross_checks["every_captured_file_cites_public_url"] is not True:
        raise SystemExit(
            "supplier pinout manifest must keep every captured file public-source-cited"
        )
    if cross_checks.get("complete_pin_table_file_count") != complete_pin_table_files:
        raise SystemExit("supplier pinout manifest complete_pin_table_file_count stale")
    if cross_checks["pinout_footprint_freeze_yaml_untouched"] is not True:
        raise SystemExit(
            "supplier pinout capture must not promote the pinout-footprint-freeze gate"
        )

    for claim in [
        "production_release_evidence_ready",
        "pinout_reviews_complete",
        "symbols_ready",
        "footprints_ready",
    ]:
        if claim not in manifest["forbidden_claims"]:
            raise SystemExit(f"supplier pinout manifest missing forbidden claim: {claim}")
    if not manifest["release_blockers_unchanged"]:
        raise SystemExit("supplier pinout manifest must preserve production-release blockers")
    print(
        f"supplier pinout evidence ok: {len(captured)} public-datasheet pinouts captured, "
        "production-release gate unchanged"
    )


# Files under board/kicad/e1-phone/ that are intentionally owned by a gate or
# test other than this structural check. Each entry names the owning flow so the
# orphan report below stays a deliberate allow-list, not a silent escape hatch.
NON_BOARD_PACKAGE_OWNED_FILES = {
    # Non-release routing demonstration set: generated by
    # scripts/generate_e1_phone_routed_mainboard_demo.py and validated by
    # scripts/test_generate_e1_phone_cad.py.
    "board/kicad/e1-phone/pcb-implementation-audit-demo.yaml": "generate_e1_phone_routed_mainboard_demo.py",
    "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-bom.csv": "generate_e1_phone_routed_mainboard_demo.py",
    "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-demo-pos.csv": "generate_e1_phone_routed_mainboard_demo.py",
}


def collect_board_package_paths(value: object) -> set[str]:
    paths: set[str] = set()
    if isinstance(value, dict):
        for item in value.values():
            paths.update(collect_board_package_paths(item))
    elif isinstance(value, list):
        for item in value:
            paths.update(collect_board_package_paths(item))
    elif isinstance(value, str) and value.startswith("board/kicad/e1-phone/"):
        paths.add(value)
    return paths


def collect_referenced_board_paths(seed_paths: set[str]) -> set[str]:
    consumed = set(seed_paths)
    pending = list(sorted(consumed))
    processed: set[str] = set()
    while pending:
        rel = pending.pop()
        if rel in processed:
            continue
        processed.add(rel)
        path = ROOT / rel
        if path.is_dir():
            release_manifest = path / "release-manifest.yaml"
            if release_manifest.is_file():
                candidate = str(release_manifest.relative_to(ROOT))
                if candidate not in consumed:
                    consumed.add(candidate)
                    pending.append(candidate)
            continue
        if not path.is_file() or path.suffix not in {".yaml", ".yml", ".json"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        for candidate in BOARD_PACKAGE_PATH_RE.findall(text):
            if candidate not in consumed:
                consumed.add(candidate)
                pending.append(candidate)
    return consumed


def check_no_orphaned_board_files() -> None:
    board_dir = ROOT / "board/kicad/e1-phone"
    manifest = load_yaml(MANIFEST)

    consumed: set[str] = set()
    for paths in manifest["current_artifacts"].values():
        consumed.update(paths)

    source = Path(__file__).read_text()
    consumed.update(BOARD_PACKAGE_PATH_RE.findall(source))
    consumed.update(NON_BOARD_PACKAGE_OWNED_FILES)

    # The RFQ transmittal drafts are addressed by computed paths, not string
    # literals, but the gate already loads each one via check_supplier_rfq_transmittal_drafts.
    # Treat the authoritative draft index as the consumption record.
    drafts = load_yaml(ROOT / "board/kicad/e1-phone/supplier-rfq-transmittal-drafts.yaml")
    consumed.update(drafts["generated_draft_files"])

    supplier_intake = load_yaml(
        ROOT / "board/kicad/e1-phone/production/sourcing/"
        "supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
    )
    consumed.add(
        "board/kicad/e1-phone/production/sourcing/"
        "supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
    )
    for record in supplier_intake["template_records"]:
        for key in ("template", "expected_return_archive"):
            if key in record:
                consumed.add(record[key])
        for key in ("expected_return_archives",):
            for archive in record.get(key, []):
                consumed.add(archive)
        archive_paths = []
        if "expected_return_archive" in record:
            archive_paths.append(record["expected_return_archive"])
        archive_paths.extend(record.get("expected_return_archives", []))
        for archive in archive_paths:
            base_dir = Path(archive).parent
            for filename in record["required_return_files"]:
                consumed.add(str(base_dir / filename))

    pinout_manifest = load_yaml(
        ROOT / "board/kicad/e1-phone/supplier-pinouts/pinout-evidence-manifest.yaml"
    )
    consumed.add("board/kicad/e1-phone/supplier-pinouts/pinout-evidence-manifest.yaml")
    for entry in pinout_manifest["captured_pinouts"]:
        consumed.add(f"board/kicad/e1-phone/supplier-pinouts/{entry['file']}")
    consumed = collect_referenced_board_paths(consumed)

    # Follow explicit file references from already-owned YAML/JSON artifacts.
    # This lets generated candidate manifests own their fail-closed placeholder
    # outputs without forcing every generated path into this checker as a literal.
    while True:
        discovered: set[str] = set()
        for rel in list(consumed):
            path = ROOT / rel
            if not path.is_file():
                continue
            data = load_structured_file(path)
            if data is None:
                continue
            discovered.update(collect_board_file_references(data))
        new_refs = discovered - consumed
        if not new_refs:
            break
        consumed.update(new_refs)

    orphans = []
    for path in sorted(board_dir.rglob("*")):
        if not path.is_file() or path.suffix not in {".yaml", ".yml", ".csv"}:
            continue
        rel = str(path.relative_to(ROOT))
        if rel == str(MANIFEST.relative_to(ROOT)):
            continue
        if rel.endswith(".metadata.yaml") and rel.removesuffix(".metadata.yaml") in consumed:
            continue
        if rel not in consumed:
            orphans.append(rel)

    if orphans:
        raise SystemExit(
            "BLOCKED: board package has orphaned evidence files consumed by no gate or test: "
            + ", ".join(orphans)
            + " (register each in board/kicad/e1-phone/artifact-manifest.yaml, add a check, "
            "or list it in NON_BOARD_PACKAGE_OWNED_FILES with its owning flow)"
        )
    print("orphan report ok: every board YAML/CSV is consumed by a gate, test, or named owner")


def check_release_gates_fail_closed(manifest: dict) -> None:
    gates = manifest["release_gates"]
    for name, gate in gates.items():
        status = str(gate["status"])
        if status == "missing":
            continue
        if not status.startswith("blocked_"):
            raise SystemExit(f"release gate {name} unexpectedly open: {status}")
        if gate.get("release_allowed") is not False:
            raise SystemExit(f"release gate {name} must explicitly keep release_allowed=false")
    routed_pcb = gates["routed_pcb"]
    enclosure = gates["enclosure"]
    if routed_pcb["status"] != "blocked_local_routed_candidate_not_release":
        raise SystemExit("routed_pcb release gate status must track local non-release candidate")
    if routed_pcb.get("local_candidate_evidence", {}).get("release_credit") is not False:
        raise SystemExit("routed_pcb local candidate evidence cannot grant release credit")
    if int(routed_pcb.get("local_candidate_evidence", {}).get("segment_count") or 0) != 306:
        raise SystemExit("routed_pcb release gate local route segment count stale")
    if enclosure["status"] != (
        "blocked_local_cad_incomplete_and_release_requires_supplier_models_routed_clearance_and_first_article"
    ):
        raise SystemExit("enclosure release gate status must track local CAD/release blocker split")
    if enclosure.get("local_candidate_evidence", {}).get("release_credit") is not False:
        raise SystemExit("enclosure local candidate evidence cannot grant release credit")
    if enclosure.get("local_candidate_evidence", {}).get("full_cad_boolean_status") != "pass":
        raise SystemExit("enclosure release gate full CAD boolean status stale")
    print("release gates ok: fabrication/enclosure readiness remains fail-closed")


def category_counts_from_report(report: dict) -> dict[str, int]:
    summary = report.get("summary")
    if not isinstance(summary, dict):
        return {
            "external_supplier_dependencies": 0,
            "missing_approval_metadata": 0,
            "present_blocked_placeholders": 0,
            "true_missing_artifacts": 0,
        }

    fabrication_categories = summary.get("fabrication_release_blocker_categories")
    if isinstance(fabrication_categories, dict):
        return {
            "external_supplier_dependencies": int(
                fabrication_categories.get("external_supplier_dependencies")
                or fabrication_categories.get("external_supplier_dependency")
                or 0
            ),
            "missing_approval_metadata": int(
                fabrication_categories.get("missing_approval_metadata") or 0
            ),
            "present_blocked_placeholders": int(
                fabrication_categories.get("present_blocked_placeholders")
                or fabrication_categories.get("present_blocked_placeholder")
                or 0
            ),
            "true_missing_artifacts": int(
                fabrication_categories.get("true_missing_artifacts") or 0
            ),
        }

    external_supplier = summary.get("external_supplier_dependencies")
    supplier_external_count = 0
    if isinstance(external_supplier, dict):
        supplier_external_count = int(external_supplier.get("external_supplier_return_rows") or 0)

    supplier_categories = summary.get("supplier_return_blocker_categories")
    if isinstance(supplier_categories, dict):
        return {
            "external_supplier_dependencies": supplier_external_count,
            "missing_approval_metadata": int(
                supplier_categories.get("missing_approval_metadata") or 0
            ),
            "present_blocked_placeholders": int(
                supplier_categories.get("candidate_present_but_blocked") or 0
            )
            + int(supplier_categories.get("present_unapproved_or_placeholder") or 0),
            "true_missing_artifacts": int(
                supplier_categories.get("true_missing_supplier_return_artifacts") or 0
            ),
        }

    return {
        "external_supplier_dependencies": 0,
        "missing_approval_metadata": int(summary.get("missing_approval_metadata_count") or 0),
        "present_blocked_placeholders": int(
            summary.get("candidate_present_blocked_count")
            or summary.get("candidate_present_but_blocked_count")
            or summary.get("blocked_present_count")
            or summary.get("blocked_required_present_count")
            or summary.get("blocked")
            or 0
        ),
        "true_missing_artifacts": int(
            summary.get("true_missing_generated_output_count")
            or summary.get("true_missing_factory_output_count")
            or summary.get("missing_artifact_count")
            or summary.get("missing_outputs")
            or summary.get("missing")
            or 0
        ),
    }


def linked_report_inventory() -> list[dict]:
    inventory = []
    for owner, command, report_rel in LINKED_EVIDENCE_REPORTS:
        report_path = ROOT / report_rel
        entry = {
            "owner": owner,
            "report": report_rel,
            "report_present": report_path.is_file(),
            "validation_command": command,
            "release_credit": False,
        }
        if report_path.is_file():
            try:
                report = load_json_file(report_path)
            except Exception as exc:
                entry.update({"status": "unreadable", "error": str(exc)})
            else:
                if isinstance(report, dict):
                    entry.update(
                        {
                            "status": report.get("status", "unknown"),
                            "report_summary": report.get("summary", {}),
                            "report_generated_utc": report.get("generated_utc"),
                            "report_mtime_ns": report_path.stat().st_mtime_ns,
                            "blocker_categories": category_counts_from_report(report),
                            "action": (
                                "Resolve this linked production evidence report with real approved "
                                "artifacts; board-package structural consistency alone cannot unlock "
                                "fabrication."
                            ),
                        }
                    )
        inventory.append(entry)
    return inventory


def write_board_package_report(manifest: dict) -> None:
    inventory = linked_report_inventory()
    linked_categories = {
        "external_supplier_dependencies": 0,
        "missing_approval_metadata": 0,
        "present_blocked_placeholders": 0,
        "true_missing_artifacts": 0,
    }
    for item in inventory:
        categories = item.get("blocker_categories")
        if not isinstance(categories, dict):
            continue
        for key in linked_categories:
            linked_categories[key] += int(categories.get(key) or 0)

    fabrication_report = ROOT / "build/reports/e1_phone_fabrication_release.json"
    fabrication_summary = {}
    fabrication_payload = {}
    if fabrication_report.is_file():
        loaded = load_json_file(fabrication_report)
        if isinstance(loaded, dict):
            fabrication_payload = loaded
            if isinstance(loaded.get("summary"), dict):
                fabrication_summary = loaded["summary"]

    manifest_blocked_gate_ids = [
        name
        for name, gate in manifest["release_gates"].items()
        if str(gate.get("status", "")).startswith("blocked_")
    ]
    fabrication_blocked_gate_ids = []
    blocked_inventory = fabrication_payload.get("blocked_evidence_inventory")
    if isinstance(blocked_inventory, list):
        fabrication_blocked_gate_ids = sorted(
            {
                str(item.get("gate"))
                for item in blocked_inventory
                if isinstance(item, dict) and item.get("gate")
            }
        )
    blocked_gate_ids = fabrication_blocked_gate_ids or manifest_blocked_gate_ids
    report = {
        "schema": "eliza.e1_phone_board_package_report.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "status": "blocked",
        "claim_boundary": "board_package_structural_check_only_not_fabrication_release_evidence",
        **FALSE_CLAIM_FLAGS,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "summary": {
            "structural_package_checks": "pass",
            "fabrication_ready": False,
            "release_evidence_complete": False,
            "release_state": fabrication_summary.get("release_state", "blocked_fail_closed"),
            "blocked_gate_ids": blocked_gate_ids,
            "manifest_blocked_gate_ids": manifest_blocked_gate_ids,
            "blocked_release_gate_count": int(
                fabrication_summary.get("blocked_release_gate_count") or len(blocked_gate_ids)
            ),
            "total_blocker_count": int(fabrication_summary.get("total_blocker_count") or 0),
            "unique_blocker_count": int(fabrication_summary.get("unique_blocker_count") or 0),
            "linked_evidence_blocker_categories": linked_categories,
        },
        "source_inputs": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "board/kicad/e1-phone/production/readiness/fabrication-enclosure-e2e-release-gate-2026-05-22.yaml",
            *[report_rel for _, _, report_rel in LINKED_EVIDENCE_REPORTS],
        ],
        "validation_commands": [
            "python3 scripts/check_e1_phone_board_package.py",
            *[command for _, command, _ in LINKED_EVIDENCE_REPORTS],
        ],
        "next_unblock_commands": [command for _, command, _ in LINKED_EVIDENCE_REPORTS],
        "blocked_evidence_inventory": inventory,
        "findings": [
            {
                "severity": "blocker",
                "code": "e1_phone_fabrication_enclosure_e2e_release_evidence_incomplete",
                "evidence": (
                    "board/kicad/e1-phone/production/readiness/"
                    "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"
                ),
                "message": (
                    "Structural package checks passed, but fabrication/enclosure/e2e release "
                    "evidence remains incomplete."
                ),
                "next_step": (
                    "Collect real routed PCB, fabrication, supplier, enclosure, first-article, "
                    "and factory release evidence before claiming fabrication readiness."
                ),
            }
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_board_package_failure_report(message: object) -> None:
    report = {
        "schema": "eliza.e1_phone_board_package_report.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "status": "blocked",
        "claim_boundary": "board_package_structural_check_only_not_fabrication_release_evidence",
        **FALSE_CLAIM_FLAGS,
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "summary": {
            "structural_package_checks": "blocked",
            "fabrication_ready": False,
            "release_evidence_complete": False,
            "failure_message": str(message),
        },
        "source_inputs": [
            "board/kicad/e1-phone/artifact-manifest.yaml",
            "scripts/check_e1_phone_board_package.py",
        ],
        "validation_commands": ["python3 scripts/check_e1_phone_board_package.py"],
        "next_unblock_commands": ["python3 scripts/check_e1_phone_board_package.py"],
        "findings": [
            {
                "severity": "blocker",
                "code": "e1_phone_board_package_structural_check_blocked",
                "evidence": "python3 scripts/check_e1_phone_board_package.py",
                "message": str(message),
                "next_step": (
                    "Refresh or repair the stale board, routed STEP, CAD, sourcing, or "
                    "release-intake dependency named by this failure, then rerun the board "
                    "package checker."
                ),
            }
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def check_release_evidence_manufacturing_candidate_propagation() -> None:
    manufacturing = load_yaml(ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml")
    presence = load_yaml(
        ROOT / "board/kicad/e1-phone/production/readiness/"
        "production-factory-required-output-presence-inventory-2026-05-22.yaml"
    )
    content = load_yaml(
        ROOT / "board/kicad/e1-phone/production/readiness/"
        "release-evidence-content-contract-2026-05-22.yaml"
    )
    objective = load_yaml(
        ROOT / "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml"
    )
    unblock = load_yaml(
        ROOT / "board/kicad/e1-phone/e1-phone-readiness-unblock-register-2026-05-22.yaml"
    )
    public_cad_intake = load_yaml(
        ROOT / "board/kicad/e1-phone/public-cad-source-intake-2026-05-28.yaml"
    )
    public_bom_cost = load_yaml(
        ROOT / "mechanical/e1-phone/review/bom-public-market-cost-bands-2026-05-28.yaml"
    )

    manufacturing_state = manufacturing["board_state_detected"]
    expected = {
        "manufacturing_closure_has_production_outputs": manufacturing_state[
            "has_production_outputs"
        ],
        "manufacturing_closure_release_output_count": manufacturing_state["release_output_count"],
        "manufacturing_closure_has_blocked_candidate_outputs": manufacturing_state[
            "has_blocked_candidate_outputs"
        ],
        "manufacturing_closure_blocked_candidate_output_file_count": manufacturing_state[
            "blocked_candidate_output_file_count"
        ],
    }
    presence_summary = presence["summary"]
    for key, value in expected.items():
        if presence_summary[key] != value:
            raise SystemExit(f"production presence manufacturing closure field stale: {key}")
    if presence_summary["manufacturing_closure_release_output_count"] != 0:
        raise SystemExit("production presence cannot count blocked candidates as release outputs")
    if presence_summary["manufacturing_closure_blocked_candidate_output_file_count"] <= 0:
        raise SystemExit("production presence lost blocked candidate output count")

    contracts = {item["id"]: item for item in content["content_contracts"]}
    production_contract = contracts["production_factory_outputs"]
    for key, value in expected.items():
        if production_contract[key] != value:
            raise SystemExit(f"release content production contract stale: {key}")
    content_summary = content["summary"]
    if (
        content_summary["production_manufacturing_closure_release_output_count"]
        != expected["manufacturing_closure_release_output_count"]
    ):
        raise SystemExit("release content summary release output count stale")
    if (
        content_summary["production_manufacturing_closure_blocked_candidate_output_file_count"]
        != expected["manufacturing_closure_blocked_candidate_output_file_count"]
    ):
        raise SystemExit("release content summary blocked candidate count stale")
    if (
        content_summary["production_manufacturing_closure_has_blocked_candidate_outputs"]
        is not True
    ):
        raise SystemExit("release content summary must preserve blocked candidate visibility")

    objective_summary = objective["summary"]
    if (
        objective_summary["manufacturing_closure_release_output_count"]
        != expected["manufacturing_closure_release_output_count"]
    ):
        raise SystemExit("objective audit release output count stale")
    if (
        objective_summary["manufacturing_closure_blocked_candidate_output_file_count"]
        != expected["manufacturing_closure_blocked_candidate_output_file_count"]
    ):
        raise SystemExit("objective audit blocked candidate count stale")
    if objective_summary["manufacturing_closure_has_blocked_candidate_outputs"] is not True:
        raise SystemExit("objective audit must show blocked candidate outputs")

    unblock_summary = unblock["summary"]
    if (
        unblock_summary["production_presence_release_output_count"]
        != expected["manufacturing_closure_release_output_count"]
    ):
        raise SystemExit("unblock register release output count stale")
    if (
        unblock_summary["production_presence_blocked_candidate_output_file_count"]
        != expected["manufacturing_closure_blocked_candidate_output_file_count"]
    ):
        raise SystemExit("unblock register blocked candidate count stale")
    if unblock_summary["production_presence_has_blocked_candidate_outputs"] is not True:
        raise SystemExit("unblock register must show blocked candidate outputs")

    public_cad_summary = public_cad_intake["summary"]
    public_bom_summary = public_bom_cost["summary"]
    expected_public_sourcing = {
        "public_sourcing_intake_ready": True,
        "public_cad_source_record_count": int(public_cad_summary.get("record_count") or 0),
        "public_cad_source_step_or_3d_observed_count": int(
            public_cad_summary.get("public_step_or_3d_observed_count") or 0
        ),
        "public_cad_source_footprint_or_eda_observed_count": int(
            public_cad_summary.get("public_footprint_or_eda_observed_count") or 0
        ),
        "public_cad_source_local_downloaded_hashed_count": int(
            public_cad_summary.get("local_downloaded_hashed_count") or 0
        ),
        "public_cad_source_release_credit_record_count": int(
            public_cad_summary.get("release_credit_record_count") or 0
        ),
        "public_market_bom_cost_category_count": int(public_bom_summary.get("category_count") or 0),
        "public_market_bom_cost_volume_count": int(public_bom_summary.get("volume_count") or 0),
        "public_market_bom_cost_avl_quote_count": int(
            public_bom_summary.get("avl_quote_count") or 0
        ),
        "public_market_bom_cost_signed_supplier_quote_count": int(
            public_bom_summary.get("signed_supplier_quote_count") or 0
        ),
        "public_sourcing_release_credit": False,
        "public_sourcing_release_allowed": False,
    }
    for report_name, summary in (
        ("release content", content_summary),
        ("unblock register", unblock_summary),
    ):
        for key, expected_value in expected_public_sourcing.items():
            if summary.get(key) != expected_value:
                raise SystemExit(f"{report_name} public sourcing summary stale: {key}")
    if (
        content["content_acceptance_policy"].get(
            "public_cad_and_market_bom_intake_is_release_evidence"
        )
        is not False
    ):
        raise SystemExit("release content must reject public CAD/BOM intake as release evidence")

    print(
        "release evidence manufacturing candidate propagation ok: "
        f"{expected['manufacturing_closure_blocked_candidate_output_file_count']} "
        "blocked candidate files, 0 release outputs"
    )


def check_objective_completion_trace_manifests() -> None:
    objective = load_yaml(
        ROOT / "board/kicad/e1-phone/e1-phone-objective-completion-audit-2026-05-22.yaml"
    )
    routed_matrix = load_yaml(
        ROOT / "board/kicad/e1-phone/production/readiness/"
        "routed-board-release-acceptance-matrix-2026-05-22.yaml"
    )
    mechanical = load_yaml(
        ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
    )
    detail = objective.get("detailed_trace_manifests", {})
    if not isinstance(detail, dict):
        raise SystemExit("objective audit detailed trace manifests missing")
    context = routed_matrix["candidate_end_to_end_context"]
    visual = context["routed_step_visual_detail"]
    component_summary = context["component_model_manifest_summary"]
    mechanical_component = mechanical["component_model_directory_ready"]
    local_cad = mechanical["local_enclosure_cad_ready"]
    supplier_lane_surrogates = mechanical_component["supplier_lane_surrogate_records"]
    expected_lists = {
        "route_visual_records": visual["route_visual_records"],
        "via_visual_records": visual["via_visual_records"],
        "filled_copper_zone_records": visual["filled_copper_zone_records"],
        "component_model_record_manifest": component_summary["component_model_record_manifest"],
        "mechanical_component_model_record_manifest": mechanical_component[
            "component_model_record_manifest"
        ],
        "supplier_lane_surrogate_records": supplier_lane_surrogates,
        "cad_connection_record_manifest": local_cad["cad_connection_record_manifest"],
    }
    for key, expected in expected_lists.items():
        if detail.get(key) != expected:
            raise SystemExit(f"objective audit detailed trace manifest stale: {key}")
        count_key = key.removesuffix("s") + "_count"
        if key.endswith("_manifest"):
            count_key = key.removesuffix("_manifest") + "_count"
        if detail.get(count_key) != len(expected):
            raise SystemExit(f"objective audit detailed trace count stale: {count_key}")
    expected_flags = {
        "all_route_records_have_net_layer_class_and_source": all(
            record.get("net")
            and record.get("layer")
            and record.get("route_classes")
            and record.get("source_domains")
            for record in visual["route_visual_records"]
        ),
        "all_component_records_have_local_step_and_release_credit_false": all(
            record.get("local_discrete_step_file")
            and int(record.get("local_discrete_step_bytes") or 0) > 0
            and record.get("release_credit") is False
            for record in component_summary["component_model_record_manifest"]
        ),
        "all_connection_records_have_cad_step_and_release_credit_false": all(
            record.get("cad_part")
            and int(record.get("cad_step_bytes") or 0) > 0
            and record.get("release_credit") is False
            for record in local_cad["cad_connection_record_manifest"]
        ),
        "all_supplier_lane_surrogates_have_hash_size_components_and_release_credit_false": all(
            record.get("file")
            and record.get("file_present") is True
            and record.get("hash_matches_file") is True
            and record.get("size_matches_file") is True
            and record.get("release_credit") is False
            and int(record.get("component_reference_count") or 0) > 0
            and record.get("component_reference_count")
            == record.get("manifest_model_reference_count")
            and record.get("all_component_records_release_credit_false") is True
            and record.get("all_component_records_reference_this_surrogate") is True
            for record in supplier_lane_surrogates
        ),
        "release_credit": False,
    }
    for key, expected in expected_flags.items():
        if detail.get(key) is not expected:
            raise SystemExit(f"objective audit detailed trace flag stale: {key}")
    print(
        "objective detailed trace manifests ok: "
        f"{len(visual['route_visual_records'])} routes, "
        f"{len(component_summary['component_model_record_manifest'])} component models, "
        f"{len(supplier_lane_surrogates)} supplier surrogate lanes, "
        f"{len(local_cad['cad_connection_record_manifest'])} CAD connections"
    )


def check_development_pattern_pinout_step_coverage() -> None:
    board_path = (
        ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
    )
    routed_board_path = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
    real_footprint_binding_path = (
        ROOT / "board/kicad/e1-phone/real-footprint-development-board-binding-2026-05-22.yaml"
    )
    step_intake_path = (
        ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
    )
    routed_intake_path = (
        ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"
    )
    component_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
    )
    pad_audit_path = (
        ROOT / "board/kicad/e1-phone/development-pad-pin-coverage-audit-2026-05-22.yaml"
    )
    traceability_path = ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
    public_cad_intake_path = ROOT / "board/kicad/e1-phone/public-cad-source-intake-2026-05-28.yaml"
    public_bom_cost_path = (
        ROOT / "mechanical/e1-phone/review/bom-public-market-cost-bands-2026-05-28.yaml"
    )

    for path in [
        board_path,
        routed_board_path,
        real_footprint_binding_path,
        step_intake_path,
        routed_intake_path,
        component_manifest_path,
        pad_audit_path,
        traceability_path,
        public_cad_intake_path,
        public_bom_cost_path,
    ]:
        require_path(path)

    board_text = board_path.read_text(encoding="utf-8")
    routed_board_text = routed_board_path.read_text(encoding="utf-8")
    real_footprint_binding = load_yaml(real_footprint_binding_path)
    step_intake = load_yaml(step_intake_path)
    routed_intake = load_yaml(routed_intake_path)
    component_manifest = load_yaml(component_manifest_path)
    pad_audit = load_yaml(pad_audit_path)
    traceability = load_yaml(traceability_path)
    public_cad_intake = load_yaml(public_cad_intake_path)
    public_bom_cost = load_yaml(public_bom_cost_path)
    trace_summary = traceability.get("summary", {})
    cad_connection_summary = component_manifest.get("cad_connection_coverage", {})
    source_board_path = ROOT / real_footprint_binding["source_board"]
    output_board_path = ROOT / real_footprint_binding["output_board"]
    require_path(source_board_path)
    require_path(output_board_path)
    expected_binding_hashes = {
        "source_board_sha256": hashlib.sha256(source_board_path.read_bytes()).hexdigest(),
        "output_board_sha256": hashlib.sha256(output_board_path.read_bytes()).hexdigest(),
    }
    for key, expected in expected_binding_hashes.items():
        if real_footprint_binding.get(key) != expected:
            raise SystemExit(f"real-footprint development board binding hash stale: {key}")
    if output_board_path != board_path:
        raise SystemExit("real-footprint development board binding output path diverges")
    if not isinstance(trace_summary, dict):
        raise SystemExit("KiCad/CAD traceability summary missing")
    if not isinstance(cad_connection_summary, dict):
        raise SystemExit("component manifest CAD connection coverage missing")
    if public_cad_intake.get("schema") != "eliza.e1_phone_public_cad_source_intake.v1":
        raise SystemExit("public CAD source intake schema stale")
    if (
        public_cad_intake.get("release_credit") is not False
        or public_cad_intake.get("release_allowed") is not False
    ):
        raise SystemExit("public CAD source intake must remain non-release evidence")
    public_cad_records = public_cad_intake.get("records", [])
    if not isinstance(public_cad_records, list) or not public_cad_records:
        raise SystemExit("public CAD source intake records missing")
    public_cad_summary = public_cad_intake.get("summary", {})
    if not isinstance(public_cad_summary, dict):
        raise SystemExit("public CAD source intake summary missing")
    if int(public_cad_summary.get("record_count") or 0) != len(public_cad_records):
        raise SystemExit("public CAD source intake record count stale")
    if int(public_cad_summary.get("release_credit_record_count") or 0) != sum(
        1
        for record in public_cad_records
        if isinstance(record, dict) and record.get("release_credit") is True
    ):
        raise SystemExit("public CAD source intake release-credit count stale")
    if int(public_cad_summary.get("release_credit_record_count") or 0) != 0:
        raise SystemExit("public CAD source intake may not grant release credit")
    if int(public_cad_summary.get("local_downloaded_hashed_count") or 0) != sum(
        1
        for record in public_cad_records
        if isinstance(record, dict)
        and record.get("local_download_status") == "downloaded_and_hashed"
    ):
        raise SystemExit("public CAD source intake local download count stale")
    if int(public_cad_summary.get("public_step_or_3d_observed_count") or 0) != sum(
        1
        for record in public_cad_records
        if isinstance(record, dict)
        and "observed" in str(record.get("public_step_or_3d_status") or "")
    ):
        raise SystemExit("public CAD source intake STEP/3D observed count stale")
    if int(public_cad_summary.get("public_footprint_or_eda_observed_count") or 0) != sum(
        1
        for record in public_cad_records
        if isinstance(record, dict)
        and (
            "observed" in str(record.get("public_footprint_status") or "")
            or "candidate" in str(record.get("public_footprint_status") or "")
        )
    ):
        raise SystemExit("public CAD source intake footprint/EDA observed count stale")
    if int(public_cad_summary.get("manufacturer_step_link_observed_count") or 0) != sum(
        1
        for record in public_cad_records
        if isinstance(record, dict)
        and "manufacturer_step" in str(record.get("public_step_or_3d_status") or "")
    ):
        raise SystemExit("public CAD source intake manufacturer STEP count stale")
    for record in public_cad_records:
        if not isinstance(record, dict):
            raise SystemExit("public CAD source intake record must be a mapping")
        for key in [
            "id",
            "category",
            "exact_mpn",
            "manufacturer",
            "official_or_authorized_sources",
            "public_step_or_3d_status",
            "public_footprint_status",
            "local_download_status",
            "release_credit",
            "required_next_actions",
        ]:
            if key not in record:
                raise SystemExit(f"public CAD source intake record missing {key}")
        if record.get("release_credit") is not False:
            raise SystemExit(
                f"public CAD source intake record grants release credit: {record['id']}"
            )
        if not isinstance(record.get("official_or_authorized_sources"), list) or not record.get(
            "official_or_authorized_sources"
        ):
            raise SystemExit(f"public CAD source intake record lacks sources: {record['id']}")
        if not isinstance(record.get("required_next_actions"), list) or not record.get(
            "required_next_actions"
        ):
            raise SystemExit(f"public CAD source intake record lacks next actions: {record['id']}")
        if record.get("local_download_status") == "downloaded_and_hashed":
            downloaded_artifacts = record.get("downloaded_artifacts")
            if not isinstance(downloaded_artifacts, list) or not downloaded_artifacts:
                raise SystemExit(
                    f"public CAD source intake downloaded record lacks artifacts: {record['id']}"
                )
            for artifact in downloaded_artifacts:
                if not isinstance(artifact, dict):
                    raise SystemExit(
                        f"public CAD source intake downloaded artifact must be a mapping: {record['id']}"
                    )
                artifact_path = artifact.get("path")
                if not isinstance(artifact_path, str) or not artifact_path.startswith(
                    "board/kicad/e1-phone/"
                ):
                    raise SystemExit(
                        f"public CAD source intake downloaded artifact path invalid: {record['id']}"
                    )
                artifact_abs = ROOT / artifact_path
                if not artifact_abs.is_file():
                    raise SystemExit(
                        f"public CAD source intake downloaded artifact missing: {artifact_path}"
                    )
                if int(artifact.get("bytes") or 0) != artifact_abs.stat().st_size:
                    raise SystemExit(
                        f"public CAD source intake downloaded artifact size stale: {artifact_path}"
                    )
                expected_sha = artifact.get("sha256")
                actual_sha = hashlib.sha256(artifact_abs.read_bytes()).hexdigest()
                if expected_sha != actual_sha:
                    raise SystemExit(
                        f"public CAD source intake downloaded artifact hash stale: {artifact_path}"
                    )
    if public_bom_cost.get("schema") != "eliza.e1_phone_public_market_bom_cost_bands.v1":
        raise SystemExit("public market BOM cost band schema stale")
    if public_bom_cost.get("status") != "public_market_cost_bands_not_avl_quote":
        raise SystemExit("public market BOM cost bands must remain non-AVL")
    public_bom_summary = public_bom_cost.get("summary", {})
    public_bom_records = public_bom_cost.get("records", [])
    if not isinstance(public_bom_summary, dict) or not isinstance(public_bom_records, list):
        raise SystemExit("public market BOM cost band summary/records missing")
    if int(public_bom_summary.get("category_count") or 0) != len(public_bom_records):
        raise SystemExit("public market BOM cost category count stale")
    if public_bom_summary.get("release_credit") is not False:
        raise SystemExit("public market BOM cost bands may not grant release credit")
    if int(public_bom_summary.get("avl_quote_count") or 0) != 0:
        raise SystemExit("public market BOM cost bands may not count AVL quotes")
    if int(public_bom_summary.get("signed_supplier_quote_count") or 0) != 0:
        raise SystemExit("public market BOM cost bands may not count signed supplier quotes")
    expected_volumes = [100, 1000, 10000, 100000, 1000000]
    if public_bom_cost.get("volume_columns") != expected_volumes:
        raise SystemExit("public market BOM cost volume columns stale")
    if int(public_bom_summary.get("volume_count") or 0) != len(expected_volumes):
        raise SystemExit("public market BOM cost volume count stale")
    subtotal = public_bom_cost.get("subtotal_researched_categories_usd", {})
    discount = public_bom_cost.get("discount_vs_100_unit_baseline_pct", {})
    if not isinstance(subtotal, dict) or not isinstance(discount, dict):
        raise SystemExit("public market BOM cost subtotal/discount mappings missing")
    for volume in expected_volumes:
        if volume not in subtotal or volume not in discount:
            raise SystemExit(f"public market BOM cost missing volume rollup: {volume}")
    for record in public_bom_records:
        if not isinstance(record, dict):
            raise SystemExit("public market BOM cost record must be a mapping")
        for key in [
            "category",
            "supplier_examples",
            "public_evidence_summary",
            "cost_band_usd",
            "release_caveat",
        ]:
            if key not in record:
                raise SystemExit(f"public market BOM cost record missing {key}")
        cost_band = record.get("cost_band_usd")
        if not isinstance(cost_band, dict):
            raise SystemExit(
                f"public market BOM cost record lacks cost bands: {record['category']}"
            )
        for volume in expected_volumes:
            band = cost_band.get(volume)
            if not isinstance(band, list) or len(band) != 2 or float(band[0]) > float(band[1]):
                raise SystemExit(
                    f"public market BOM cost invalid band for {record['category']} @ {volume}"
                )

    footprint_refs = re.findall(r'\(footprint "([^"]+)"', board_text)
    routed_footprint_refs = re.findall(r'\(footprint "([^"]+)"', routed_board_text)
    if len(footprint_refs) != 89:
        raise SystemExit(
            f"real-footprint development board footprint count stale: {len(footprint_refs)}"
        )
    if footprint_refs != routed_footprint_refs:
        raise SystemExit("routed board and real-footprint board footprint lists diverge")
    if any(ref.startswith("E1Phone:") for ref in footprint_refs):
        raise SystemExit("real-footprint development board still references E1Phone placeholders")
    if not all(ref.startswith("e1-phone-dev:") for ref in footprint_refs):
        raise SystemExit(
            "real-footprint development board has non-development footprint references"
        )
    for forbidden in [
        "placeholder_not_fabrication_footprint",
        "E1_PHONE_PLACEHOLDER",
        "PLACEHOLDER",
        "TO" + "DO",
        "FIX" + "ME",
    ]:
        if forbidden in board_text or forbidden in routed_board_text:
            raise SystemExit(f"development routed board contains forbidden marker: {forbidden}")
    development_pattern_tag_count = board_text.count("NON_RELEASE_DEVELOPMENT_PATTERN")
    if development_pattern_tag_count != len(footprint_refs):
        raise SystemExit(
            "every development footprint must carry explicit non-release pattern provenance"
        )

    footprints = step_intake.get("footprints", [])
    models = component_manifest.get("models", [])
    pad_records = pad_audit.get("records", [])
    if (
        not isinstance(footprints, list)
        or not isinstance(models, list)
        or not isinstance(pad_records, list)
    ):
        raise SystemExit("development pattern/pinout inputs must contain lists")
    if len(footprints) != len(footprint_refs) or len(models) != len(footprint_refs):
        raise SystemExit("footprint STEP intake, model manifest, and KiCad board counts diverge")
    footprint_refs_from_intake = {item["reference"] for item in footprints}
    model_refs = {item["reference"] for item in models}
    if len(footprint_refs_from_intake) != len(footprints) or len(model_refs) != len(models):
        raise SystemExit("development footprint/model references must be unique")
    if footprint_refs_from_intake != model_refs:
        raise SystemExit("development STEP intake and component model references diverge")
    trace_footprint_records = traceability.get("footprint_traceability", [])
    if not isinstance(trace_footprint_records, list):
        raise SystemExit("KiCad/CAD traceability footprint records missing")
    trace_step_instances_by_footprint = {
        record["footprint"]: int(record.get("step_instance_count") or 0)
        for record in trace_footprint_records
    }
    if len(trace_step_instances_by_footprint) != len(trace_footprint_records):
        raise SystemExit("KiCad/CAD traceability footprint records contain duplicates")
    model_instances_by_footprint: dict[str, int] = {}
    for model in models:
        model_instances_by_footprint[model["footprint"]] = (
            model_instances_by_footprint.get(model["footprint"], 0) + 1
        )
    if trace_step_instances_by_footprint != model_instances_by_footprint:
        raise SystemExit("traceability STEP instance distribution diverges from component models")
    if int(trace_summary.get("step_footprint_instance_count") or 0) != len(models):
        raise SystemExit("KiCad/CAD traceability STEP instance count stale")

    pad_record_by_footprint = {record["footprint"]: record for record in pad_records}
    if len(pad_record_by_footprint) != len(pad_records):
        raise SystemExit("development pad/pin coverage audit has duplicate footprint records")
    pending_pad_records = pad_audit.get("pending_supplier_pad_map_or_order_records", [])
    if not isinstance(pending_pad_records, list):
        raise SystemExit("development pad/pin audit pending supplier records missing")
    expected_pending_pad_records = [
        {
            "footprint": record["footprint"],
            "footprint_file": record["footprint_file"],
            "footprint_status": record["footprint_status"],
            "pinout_file": record["pinout_file"],
            "pinout_status": record["pinout_status"],
            "coverage": record["coverage"],
            "expected_pin_count": record["expected_pin_count"],
            "electrical_pad_count": record["electrical_pad_count"],
            "missing_expected_pads": record["missing_expected_pads"],
            "extra_footprint_pads": record["extra_footprint_pads"],
            "land_pattern_basis": record["land_pattern_basis"],
            "local_terminal_contract_source": record["local_terminal_contract_source"],
            "step_binding_status": record["step_binding_status"],
            "release_allowed": record["release_allowed"],
        }
        for record in pad_records
        if "pending" in str(record.get("coverage") or "")
        or record.get("footprint_status") == "geometry_only_pending_supplier_pad_map"
    ]
    if pending_pad_records != expected_pending_pad_records:
        raise SystemExit("development pad/pin audit pending supplier records stale")
    if int(pad_audit.get("pending_supplier_pad_map_or_order_count") or 0) != len(
        pending_pad_records
    ):
        raise SystemExit("development pad/pin audit pending supplier count stale")
    package_conflict_records = pad_audit.get("public_candidate_package_conflict_records", [])
    if not isinstance(package_conflict_records, list):
        raise SystemExit("development pad/pin audit package conflict records missing")
    expected_package_conflict_records = [
        {
            "footprint": record["footprint"],
            "footprint_file": record["footprint_file"],
            "footprint_status": record["footprint_status"],
            "pinout_file": record["pinout_file"],
            "coverage": record["coverage"],
            "electrical_pad_count": record["electrical_pad_count"],
            "manifest_pin_count": record["manifest_pin_count"],
            **record["package_conflict_detail"],
            "release_allowed": record["release_allowed"],
        }
        for record in pad_records
        if record.get("package_conflict")
    ]
    if package_conflict_records != expected_package_conflict_records:
        raise SystemExit("development pad/pin audit package conflict records stale")
    if int(pad_audit.get("public_candidate_package_conflict_count") or 0) != len(
        package_conflict_records
    ):
        raise SystemExit("development pad/pin audit package conflict count stale")

    total_pad_visual_count = 0
    pinout_bound_model_count = 0
    support_pattern_model_count = 0
    pattern_bound_model_count = 0
    terminal_contract_or_no_electrical_count = 0
    terminal_contract_bound_model_count = 0
    total_pad_contract_visual_count = 0
    uncovered_pad_visual_count = 0
    for model in models:
        reference = model["reference"]
        footprint = model["footprint"]
        if footprint not in pad_record_by_footprint:
            raise SystemExit(f"component model missing pad audit footprint record: {reference}")
        pad_record = pad_record_by_footprint[footprint]
        if int(model.get("pad_count") or 0) != int(model.get("pad_visual_count") or 0):
            raise SystemExit(f"component model pad visual count stale: {reference}")
        if len(model.get("pad_contract_records", [])) != int(model.get("pad_visual_count") or 0):
            raise SystemExit(f"component model pad contract record count stale: {reference}")
        if model.get("all_pad_visuals_have_contract") is not True:
            raise SystemExit(f"component model has uncovered pad visuals: {reference}")
        if int(model.get("pad_contract_covered_count") or 0) != int(
            model.get("pad_visual_count") or 0
        ):
            raise SystemExit(f"component model pad contract coverage stale: {reference}")
        if model.get("uncovered_pad_visuals"):
            raise SystemExit(f"component model lists uncovered pad visuals: {reference}")
        if int(model.get("electrical_pad_count") or 0) != int(
            pad_record.get("electrical_pad_count") or 0
        ):
            raise SystemExit(f"component model electrical pad count diverges: {reference}")
        if int(model.get("mechanical_pad_count") or 0) != int(
            pad_record.get("mechanical_pad_count") or 0
        ):
            raise SystemExit(f"component model mechanical pad count diverges: {reference}")
        if bool(model.get("pinout_file")) != bool(pad_record.get("pinout_file")):
            raise SystemExit(f"component model pinout binding diverges: {reference}")
        if bool(model.get("pinout_bound")) != bool(model.get("pinout_file")):
            raise SystemExit(f"component model pinout_bound flag diverges: {reference}")
        expected_support_pattern_bound = bool(
            model.get("support_pattern_has_explicit_provenance")
        )
        if bool(model.get("support_pattern_bound")) != expected_support_pattern_bound:
            raise SystemExit(f"component model support_pattern_bound flag diverges: {reference}")
        expected_pattern_bound = bool(model.get("pinout_file")) or expected_support_pattern_bound
        if bool(model.get("pattern_bound")) != expected_pattern_bound:
            raise SystemExit(f"component model pattern_bound flag diverges: {reference}")
        if not model.get("pattern_binding_status"):
            raise SystemExit(f"component model lacks pattern binding status: {reference}")
        if model.get("pinout_file") and int(model.get("terminal_contract_count") or 0) <= 0:
            raise SystemExit(f"pinout-bound component model lacks terminal contract: {reference}")
        expected_terminal_contract_bound = (
            int(model.get("electrical_pad_count") or 0) == 0
            or int(model.get("terminal_contract_count") or 0) > 0
        )
        if bool(model.get("terminal_contract_bound")) != expected_terminal_contract_bound:
            raise SystemExit(
                f"component model terminal_contract_bound flag diverges: {reference}"
            )
        if model.get("support_pattern_has_explicit_provenance") and not model.get(
            "land_pattern_basis"
        ):
            raise SystemExit(f"support pattern model lacks land-pattern basis: {reference}")
        if (
            int(model.get("electrical_pad_count") or 0) == 0
            or int(model.get("terminal_contract_count") or 0) > 0
        ):
            terminal_contract_or_no_electrical_count += 1
        pinout_bound_model_count += 1 if model.get("pinout_file") else 0
        support_pattern_model_count += (
            1 if model.get("support_pattern_has_explicit_provenance") else 0
        )
        pattern_bound_model_count += 1 if model.get("pattern_bound") else 0
        terminal_contract_bound_model_count += 1 if model.get("terminal_contract_bound") else 0
        total_pad_visual_count += int(model.get("pad_visual_count") or 0)
        total_pad_contract_visual_count += int(model.get("pad_contract_covered_count") or 0)
        uncovered_pad_visual_count += len(model.get("uncovered_pad_visuals", []))

    model_binding = component_manifest["model_to_footprint_binding"]
    package_summary = component_manifest["package_visual_summary"]
    terminal_binding = component_manifest["terminal_contract_binding"]
    for key in [
        "all_models_have_reference",
        "all_models_have_footprint",
        "all_models_have_layer",
        "all_models_have_at_mm",
        "all_model_pad_counts_match_visuals",
    ]:
        if model_binding.get(key) is not True:
            raise SystemExit(f"component model footprint binding flag not closed: {key}")
    for key in [
        "all_models_have_visual_package_class",
        "all_package_visual_counts_match_step_intake",
    ]:
        if package_summary.get(key) is not True:
            raise SystemExit(f"component package visual summary flag not closed: {key}")
    for key in [
        "all_pinout_bound_models_have_terminal_contract",
        "all_pinout_bound_model_contracts_match_pad_visuals",
        "all_support_pattern_models_have_explicit_provenance",
        "all_models_have_pattern_binding",
        "all_models_have_terminal_contract_binding",
        "all_model_pad_visuals_have_contract",
        "all_non_signal_pad_contracts_match_pad_visuals",
        "all_npth_mechanical_features_have_contract",
    ]:
        if terminal_binding.get(key) is not True:
            raise SystemExit(f"component terminal binding flag not closed: {key}")
    expected_summary = {
        "component_model_count": len(models),
        "pad_contact_visual_count": total_pad_visual_count,
        "pinout_bound_model_count": pinout_bound_model_count,
        "support_pattern_model_count": support_pattern_model_count,
        "pattern_bound_model_count": pattern_bound_model_count,
        "terminal_contract_bound_model_count": terminal_contract_bound_model_count,
        "models_with_terminal_contract_or_no_electrical_pads_count": (
            terminal_contract_or_no_electrical_count
        ),
        "total_pad_contract_visual_count": total_pad_contract_visual_count,
        "uncovered_pad_visual_count": uncovered_pad_visual_count,
    }
    if component_manifest["component_model_count"] != expected_summary["component_model_count"]:
        raise SystemExit("component model manifest component count stale")
    if (
        component_manifest["pad_contact_visual_count"]
        != expected_summary["pad_contact_visual_count"]
    ):
        raise SystemExit("component model manifest pad visual count stale")
    for key in [
        "pinout_bound_model_count",
        "support_pattern_model_count",
        "pattern_bound_model_count",
        "terminal_contract_bound_model_count",
        "models_with_terminal_contract_or_no_electrical_pads_count",
        "total_pad_contract_visual_count",
        "uncovered_pad_visual_count",
    ]:
        if terminal_binding[key] != expected_summary[key]:
            raise SystemExit(f"component terminal binding summary stale: {key}")

    if int(step_intake.get("footprint_envelope_count") or 0) != len(footprint_refs):
        raise SystemExit("real-footprint STEP intake footprint count stale")
    if int(step_intake.get("pad_contact_visual_count") or 0) != total_pad_visual_count:
        raise SystemExit("real-footprint STEP intake pad visual count stale")
    if int(step_intake.get("e1phone_footprint_refs") or 0) != 0:
        raise SystemExit("real-footprint STEP intake still reports E1Phone refs")
    if int(step_intake.get("development_footprint_refs") or 0) != len(footprint_refs):
        raise SystemExit("real-footprint STEP intake development footprint count stale")
    if (
        int(routed_intake.get("segment_count") or 0) <= 0
        or int(routed_intake.get("via_count") or 0) <= 0
    ):
        raise SystemExit("routed development board lacks routed segments or vias")
    if int(routed_intake.get("local_copper_zone_filled_polygon_count") or 0) <= 0:
        raise SystemExit("routed development board lacks local filled copper zones")
    for key in [
        "incomplete_footprint_count",
        "incomplete_cad_connection_count",
        "missing_captured_pinout_file_count",
        "incomplete_captured_pinout_detail_count",
    ]:
        if int(trace_summary.get(key) or 0) != 0:
            raise SystemExit(f"KiCad/CAD traceability still has local gap: {key}")
    if trace_summary.get("all_support_patterns_have_explicit_provenance") is not True:
        raise SystemExit("KiCad/CAD traceability support patterns lack explicit provenance")
    if int(trace_summary.get("cad_connection_mechanical_envelope_defined_count") or 0) != int(
        cad_connection_summary.get("mechanical_envelope_defined_count") or 0
    ):
        raise SystemExit("KiCad/CAD traceability CAD connection mechanical envelope count stale")
    if trace_summary.get("cad_connection_all_records_have_mechanical_envelope") is not True:
        raise SystemExit("KiCad/CAD traceability CAD connections lack mechanical envelopes")
    if trace_summary.get("cad_connection_mechanical_envelope_release_credit") is not False:
        raise SystemExit(
            "KiCad/CAD traceability CAD connection mechanical envelopes must stay non-release"
        )

    print(
        "development pattern/pinout/STEP coverage ok: "
        f"{len(models)} model instances, {pinout_bound_model_count} pinout-bound, "
        f"{support_pattern_model_count} support patterns, {total_pad_visual_count} pad visuals"
    )


def check_enclosure_readiness_gap_map_consistency() -> None:
    gap_path = (
        ROOT
        / "board/kicad/e1-phone/production/readiness/enclosure-readiness-gap-map-2026-05-22.yaml"
    )
    gap = load_yaml(gap_path)
    board_step = json.loads(
        (ROOT / "mechanical/e1-phone/review/board-step-readiness.json").read_text()
    )
    routed_clearance = json.loads(
        (ROOT / "mechanical/e1-phone/review/routed-board-clearance.json").read_text()
    )
    routed_matrix = load_yaml(
        ROOT
        / "board/kicad/e1-phone/production/readiness/routed-board-release-acceptance-matrix-2026-05-22.yaml"
    )
    supplier_matrix = load_yaml(
        ROOT
        / "board/kicad/e1-phone/production/sourcing/readiness/supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
    )
    first_article = load_yaml(
        ROOT
        / "board/kicad/e1-phone/production/test/readiness/e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
    )
    factory_inventory = load_yaml(
        ROOT
        / "board/kicad/e1-phone/production/readiness/production-factory-required-output-presence-inventory-2026-05-22.yaml"
    )

    if gap["schema"] != "eliza.e1_phone_enclosure_readiness_gap_map.v1":
        raise SystemExit("enclosure readiness gap map schema diverges")
    if gap["status"] != "blocked_fail_closed_diagnostic_only":
        raise SystemExit(f"unexpected enclosure readiness gap map status: {gap['status']}")
    for rel in gap["inputs"].values():
        require_path(ROOT / rel)
    policy = gap["fail_closed_policy"]
    for key in [
        "release_allowed",
        "release_credit",
        "candidate_or_concept_cad_counts_as_release_evidence",
        "presence_only_counts_as_release_evidence",
    ]:
        if policy.get(key) is not False:
            raise SystemExit(f"enclosure readiness gap policy unexpectedly open: {key}")
    if policy.get("external_supplier_and_physical_fit_evidence_required") is not True:
        raise SystemExit("enclosure readiness gap map must require external/physical evidence")

    summary = gap["summary"]
    supplier_summary = supplier_matrix["summary"]
    routed_summary = routed_matrix["summary"]
    first_article_summary = first_article["summary"]
    factory_summary = factory_inventory["summary"]
    expected_summary = {
        "release_allowed": False,
        "release_credit": False,
        "production_routed_step_release_count": len(
            board_step.get("approved_production_step_files", [])
        ),
        "candidate_routed_step_count": len(
            gap["routed_board_clearance_gap"].get("candidate_routed_step_paths", [])
        ),
        "clearance_results_complete": routed_clearance["complete_clearance_result_count"],
        "clearance_results_expected": routed_clearance["expected_clearance_case_count"],
        "blocked_clearance_case_count": len(
            gap["routed_board_clearance_gap"].get("blocked_clearance_cases", [])
        ),
        "supplier_return_blocked_lane_count": supplier_summary.get(
            "blocked_supplier_return_lane_count",
            supplier_summary["supplier_lane_or_function_count"],
        ),
        "supplier_return_present_but_not_release_evidence_count": (
            supplier_summary["present_supplier_return_evidence_count"]
        ),
        "first_article_missing_required_non_template_count": first_article_summary[
            "missing_required_non_template_row_count"
        ],
        "first_article_template_row_count": first_article_summary["template_row_count"],
        "first_article_present_unvalidated_count": first_article_summary[
            "present_required_non_template_row_count"
        ],
    }
    for key, expected in expected_summary.items():
        if summary.get(key) != expected:
            raise SystemExit(f"enclosure readiness gap summary stale: {key}")

    routed_gap = gap["routed_board_clearance_gap"]
    if routed_gap["board_step_status"] != board_step["status"]:
        raise SystemExit("enclosure readiness gap board-step status stale")
    if routed_gap["routed_clearance_status"] != routed_clearance["status"]:
        raise SystemExit("enclosure readiness gap routed-clearance status stale")
    if routed_gap["production_routed_step_release_count"] != 0:
        raise SystemExit("enclosure readiness gap cannot count candidate STEP as release")
    if (
        routed_gap["clearance_results_complete"]
        != routed_clearance["complete_clearance_result_count"]
    ):
        raise SystemExit("enclosure readiness gap clearance completion count stale")
    if (
        len(routed_gap["blocked_clearance_cases"])
        != routed_clearance["expected_clearance_case_count"]
    ):
        raise SystemExit("enclosure readiness gap blocked clearance case count stale")

    detailed_candidate = board_step["detailed_routed_step_candidate"]
    missing_evidence = {row["gate"]: row for row in gap["mechanical_missing_release_evidence"]}
    intake = missing_evidence.get("routed_board_step_intake", {})
    intake_candidate = intake.get("detailed_routed_step_candidate", {})
    for key in [
        "path",
        "present",
        "sha256",
        "size_bytes",
        "source_step",
        "source_step_sha256",
        "source_step_size_bytes",
        "route_count",
        "segment_count",
        "footprint_envelope_count",
        "pad_contact_visual_count",
        "route_segment_visual_count",
        "route_segment_net_name_count",
        "route_segment_trace_bound_count",
        "route_segment_trace_unbound_count",
        "controlled_impedance_segment_visual_count",
        "via_net_name_count",
    ]:
        if intake_candidate.get(key) != detailed_candidate.get(key):
            raise SystemExit(f"enclosure readiness gap detailed STEP candidate stale: {key}")
    if intake_candidate.get("release_credit") is not False:
        raise SystemExit("enclosure readiness gap candidate STEP cannot grant release credit")

    release_unblock_rows = gap.get("fabrication_enclosure_unblock_action_inventory", [])
    approval_rows = gap.get("approval_metadata_action_inventory", [])
    if summary["release_unblock_blocked_row_count"] != sum(
        int(row.get("blocked_rows") or 0) for row in release_unblock_rows
    ):
        raise SystemExit("enclosure readiness gap unblock row count stale")
    routed_release_row = {
        row["id"]: row for row in release_unblock_rows if isinstance(row, dict) and row.get("id")
    }.get("routed_board_release_outputs")
    if not routed_release_row:
        raise SystemExit("enclosure readiness gap missing routed release action row")
    if routed_release_row["blocked_rows"] != (
        routed_summary["candidate_present_blocked_required_output_path_count"]
        + routed_summary["missing_required_output_path_count"]
    ):
        raise SystemExit("enclosure readiness gap routed release blocked row count stale")
    routed_approval_row = {
        row["family"]: row for row in approval_rows if isinstance(row, dict) and row.get("family")
    }.get("routed_release_approvals")
    if not routed_approval_row:
        raise SystemExit("enclosure readiness gap missing routed approval action row")
    if routed_approval_row["blocked_rows"] != routed_release_row["blocked_rows"]:
        raise SystemExit("enclosure readiness gap routed approval count diverges")
    if factory_summary["missing_required_output_path_count"] != 0:
        raise SystemExit("factory output inventory unexpectedly missing generated candidate paths")

    print(
        "enclosure readiness gap map ok: "
        f"{summary['blocked_clearance_case_count']} clearance cases, "
        f"{summary['release_unblock_blocked_row_count']} blocked release rows"
    )


def check_component_model_directory_filesystem_coverage() -> None:
    manifest_path = (
        ROOT / "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml"
    )
    surrogate_detail_path = (
        ROOT / "mechanical/e1-phone/review/supplier-step-surrogate-intake-detail.json"
    )
    component_dir = manifest_path.parent
    manifest = load_yaml(manifest_path)
    require_path(surrogate_detail_path)
    surrogate_detail = json.loads(surrogate_detail_path.read_text(encoding="utf-8"))

    if manifest["schema"] != "eliza.e1_phone_local_component_model_directory.v1":
        raise SystemExit("component model directory manifest schema diverges")
    if manifest["status"] != "blocked_local_component_model_directory_not_supplier_steps":
        raise SystemExit(f"unexpected component model directory status: {manifest['status']}")
    if manifest["release_allowed"] is not False:
        raise SystemExit("component model directory cannot be release-allowed")

    records = manifest.get("model_records")
    if not isinstance(records, list):
        raise SystemExit("component model directory records must be a list")
    if manifest["model_record_count"] != len(records):
        raise SystemExit("component model directory record count stale")
    if manifest["component_model_count"] != len(records):
        raise SystemExit("component model directory model count stale")

    filesystem_steps = {
        child.relative_to(ROOT).as_posix()
        for child in component_dir.glob("*.local-envelope.step")
        if child.is_file()
    }
    filesystem_metadata = {
        child.name for child in component_dir.glob("*.local-model.json") if child.is_file()
    }
    record_steps = {str(record.get("local_discrete_step_file") or "") for record in records}
    record_metadata = {str(record.get("metadata") or "") for record in records}
    if "" in record_steps or "" in record_metadata:
        raise SystemExit("component model directory contains blank record file references")
    if filesystem_steps != record_steps:
        missing = sorted(record_steps - filesystem_steps)
        extra = sorted(filesystem_steps - record_steps)
        raise SystemExit(
            "component model directory STEP filesystem drift: "
            f"missing={missing[:3]} extra={extra[:3]}"
        )
    if filesystem_metadata != record_metadata:
        missing = sorted(record_metadata - filesystem_metadata)
        extra = sorted(filesystem_metadata - record_metadata)
        raise SystemExit(
            "component model directory metadata filesystem drift: "
            f"missing={missing[:3]} extra={extra[:3]}"
        )

    local_step_bytes_total = 0
    imported_solid_count = 0
    bbox_match_count = 0
    pinout_bound_count = 0
    support_pattern_count = 0
    pattern_bound_count = 0
    terminal_contract_model_count = 0
    terminal_contract_bound_count = 0
    terminal_contract_total = 0
    local_step_bound_count = 0
    total_pad_contract_visual_count = 0
    uncovered_pad_visual_count = 0
    non_signal_pad_contract_total = 0
    npth_contract_total = 0
    npth_contract_model_count = 0
    release_credit_false_count = 0
    supplier_approved_count = 0
    references: set[str] = set()

    for record in records:
        reference = str(record.get("reference") or "")
        if not reference:
            raise SystemExit("component model directory record missing reference")
        if reference in references:
            raise SystemExit(f"duplicate component model directory reference: {reference}")
        references.add(reference)

        local_step = ROOT / str(record["local_discrete_step_file"])
        metadata_path = component_dir / str(record["metadata"])
        require_path(local_step)
        require_path(metadata_path)
        if record.get("local_discrete_step_sha256") != file_sha256(local_step):
            raise SystemExit(f"component model local STEP hash stale: {reference}")
        local_step_bytes = local_step.stat().st_size
        if int(record.get("local_discrete_step_bytes") or 0) != local_step_bytes:
            raise SystemExit(f"component model local STEP size stale: {reference}")
        if record.get("metadata_sha256") != file_sha256(metadata_path):
            raise SystemExit(f"component model metadata hash stale: {reference}")

        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("schema") != "eliza.e1_phone_local_component_model_record.v1":
            raise SystemExit(f"component model metadata schema stale: {reference}")
        for key in [
            "reference",
            "footprint",
            "source_routed_step",
            "source_routed_step_sha256",
            "source_routed_step_bytes",
            "combined_step_assembly_name",
            "local_discrete_step_file",
            "local_discrete_step_sha256",
            "local_discrete_step_bytes",
            "local_discrete_step_import_status",
            "local_discrete_step_solid_type",
            "local_discrete_step_imported_as_solid",
            "local_discrete_step_bbox_matches_envelope",
            "expected_supplier_step_file",
            "supplier_sourcing_lane",
            "supplier_step_intake_status",
            "supplier_approved",
            "public_cad_step_overlay_status",
            "public_cad_step_overlay_file",
            "public_cad_step_overlay_sha256",
            "public_cad_step_overlay_bytes",
            "public_cad_source_record",
            "public_cad_step_overlay_release_credit",
            "pad_contract_covered_count",
            "all_pad_visuals_have_contract",
            "terminal_contract_bound",
            "support_pattern_bound",
            "pattern_bound",
            "pattern_binding_status",
            "local_step_bound",
            "release_credit",
        ]:
            if metadata.get(key) != record.get(key):
                raise SystemExit(f"component model metadata diverges for {reference}: {key}")
        if metadata.get("status") != "blocked_local_development_envelope_not_supplier_step":
            raise SystemExit(f"component model metadata unexpectedly open: {reference}")
        if metadata.get("supplier_approved") is not False:
            raise SystemExit(
                f"component model metadata supplier approved unexpectedly: {reference}"
            )
        if (
            metadata.get("release_credit") is not False
            or metadata.get("release_allowed") is not False
        ):
            raise SystemExit(f"component model metadata has release credit: {reference}")
        if record.get("local_discrete_step_import_status") == "pass":
            imported_solid_count += 1
        if record.get("local_discrete_step_solid_type") != "Solid":
            raise SystemExit(f"component model local STEP not a solid: {reference}")
        if record.get("local_discrete_step_imported_as_solid") is not True:
            raise SystemExit(
                f"component model local STEP imported-as-solid flag stale: {reference}"
            )
        expected_local_step_bound = (
            record.get("local_discrete_step_imported_as_solid") is True
            and record.get("local_discrete_step_bbox_matches_envelope") is True
            and bool(record.get("local_discrete_step_file"))
        )
        if bool(record.get("local_step_bound")) != expected_local_step_bound:
            raise SystemExit(f"component model local_step_bound flag stale: {reference}")
        if record.get("pattern_bound") is not True:
            raise SystemExit(f"component model pattern binding missing: {reference}")
        if record.get("terminal_contract_bound") is not True:
            raise SystemExit(f"component model terminal contract binding missing: {reference}")
        if record.get("local_discrete_step_bbox_matches_envelope") is True:
            bbox_match_count += 1
        if record.get("local_step_bound") is True:
            local_step_bound_count += 1
        local_step_bytes_total += local_step_bytes
        pinout_bound_count += 1 if record.get("pinout_bound") else 0
        support_pattern_count += 1 if record.get("support_pattern_has_explicit_provenance") else 0
        pattern_bound_count += 1 if record.get("pattern_bound") else 0
        terminal_count = int(record.get("terminal_contract_count") or 0)
        if terminal_count > 0:
            terminal_contract_model_count += 1
        terminal_contract_bound_count += 1 if record.get("terminal_contract_bound") else 0
        terminal_contract_total += terminal_count
        total_pad_contract_visual_count += int(record.get("pad_contract_covered_count") or 0)
        if record.get("all_pad_visuals_have_contract") is not True:
            raise SystemExit(f"component model directory has uncovered pad visuals: {reference}")
        uncovered_pad_visual_count += len(metadata.get("uncovered_pad_visuals") or [])
        non_signal_pad_contract_total += int(record.get("non_signal_pad_contract_count") or 0)
        npth_count = int(record.get("npth_mechanical_feature_contract_count") or 0)
        npth_contract_total += npth_count
        if npth_count:
            npth_contract_model_count += 1
        release_credit_false_count += 1 if record.get("release_credit") is False else 0
        supplier_approved_count += 1 if record.get("supplier_approved") is True else 0

    expected_counts = {
        "local_discrete_step_file_count": len(filesystem_steps),
        "local_discrete_step_imported_solid_count": imported_solid_count,
        "local_discrete_step_bbox_match_count": bbox_match_count,
        "local_discrete_step_bytes_total": local_step_bytes_total,
        "pinout_bound_model_record_count": pinout_bound_count,
        "support_pattern_model_record_count": support_pattern_count,
        "pattern_bound_model_record_count": pattern_bound_count,
        "terminal_contract_model_record_count": terminal_contract_model_count,
        "terminal_contract_bound_model_record_count": terminal_contract_bound_count,
        "terminal_contract_total_count": terminal_contract_total,
        "local_step_bound_model_record_count": local_step_bound_count,
        "total_pad_contract_visual_count": total_pad_contract_visual_count,
        "uncovered_pad_visual_count": uncovered_pad_visual_count,
        "non_signal_pad_contract_total_count": non_signal_pad_contract_total,
        "npth_mechanical_feature_contract_total_count": npth_contract_total,
        "models_with_npth_mechanical_feature_contract_count": npth_contract_model_count,
        "supplier_approved_model_count": supplier_approved_count,
    }
    for key, expected in expected_counts.items():
        if manifest[key] != expected:
            raise SystemExit(f"component model directory summary stale: {key}")
    if release_credit_false_count != len(records):
        raise SystemExit("component model directory records must all have release_credit=false")
    for key in [
        "all_model_records_present",
        "all_model_records_source_routed_step_bound",
        "all_model_records_have_combined_step_locator",
        "all_model_records_have_local_discrete_step_file",
        "all_model_records_have_local_step_binding",
        "all_local_discrete_step_files_import_as_solids",
        "all_local_discrete_step_bboxes_match_envelopes",
        "all_model_records_have_expected_supplier_step_file",
        "all_records_release_credit_false",
        "all_record_local_step_hashes_match_files",
        "all_record_local_step_sizes_match_files",
        "all_record_metadata_hashes_match_files",
        "all_model_pad_visuals_have_contract",
        "all_model_records_have_pattern_binding",
        "all_model_records_have_terminal_contract_binding",
    ]:
        if manifest.get(key) is not True:
            raise SystemExit(f"component model directory boolean not closed: {key}")

    lane_surrogates = manifest.get("supplier_lane_surrogate_steps")
    if not isinstance(lane_surrogates, dict):
        raise SystemExit("component model directory surrogate lane map must be a mapping")
    if manifest["supplier_lane_surrogate_step_count"] != len(lane_surrogates):
        raise SystemExit("component model directory surrogate lane count stale")
    if not isinstance(surrogate_detail, dict):
        raise SystemExit("supplier surrogate intake detail must be a JSON object")
    expected_surrogate_header = {
        "schema": "eliza.e1_phone_supplier_step_surrogate_intake_detail.v1",
        "present": True,
        "source_manifest": "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml",
        "status": "blocked_local_surrogate_steps_not_supplier_approved",
        "supplier_lane_surrogate_step_count": len(lane_surrogates),
        "supplier_step_intake_local_surrogate_count": manifest[
            "supplier_step_intake_local_surrogate_count"
        ],
        "supplier_step_intake_not_applicable_count": manifest[
            "supplier_step_intake_not_applicable_count"
        ],
        "supplier_step_intake_missing_count": manifest["supplier_step_intake_missing_count"],
        "supplier_step_intake_release_candidate_count": manifest[
            "supplier_step_intake_release_candidate_count"
        ],
        "supplier_step_intake_lane_counts": manifest["supplier_step_intake_lane_counts"],
        "component_model_record_count": len(records),
        "all_lane_surrogates_present": True,
        "all_lane_surrogate_hashes_match": True,
        "all_lane_surrogate_sizes_match": True,
        "all_lane_surrogates_release_credit_false": True,
        "all_lane_component_reference_counts_match_manifest": True,
        "all_lane_component_records_release_credit_false": True,
        "all_lane_component_records_reference_surrogate": True,
        "release_credit": False,
        "release_allowed": False,
    }
    for key, expected in expected_surrogate_header.items():
        if surrogate_detail.get(key) != expected:
            raise SystemExit(f"supplier surrogate intake detail stale: {key}")
    detail_lane_records = surrogate_detail.get("lane_records")
    if not isinstance(detail_lane_records, list):
        raise SystemExit("supplier surrogate intake detail lane records must be a list")
    detail_lane_by_name = {
        str(record.get("lane") or ""): record
        for record in detail_lane_records
        if isinstance(record, dict)
    }
    if set(detail_lane_by_name) != set(lane_surrogates):
        raise SystemExit("supplier surrogate intake detail lane set stale")

    records_by_intake_file: dict[str, list[dict]] = {}
    for record in records:
        records_by_intake_file.setdefault(
            str(record.get("supplier_step_intake_file") or ""), []
        ).append(record)
    for lane, item in lane_surrogates.items():
        if item.get("status") != "present_local_surrogate_step_not_supplier_approved":
            raise SystemExit(f"component model surrogate lane unexpectedly open: {lane}")
        if item.get("release_credit") is not False:
            raise SystemExit(f"component model surrogate lane has release credit: {lane}")
        surrogate_path = ROOT / str(item.get("file") or "")
        require_path(surrogate_path)
        if item.get("sha256") != file_sha256(surrogate_path):
            raise SystemExit(f"component model surrogate lane hash stale: {lane}")
        if int(item.get("bytes") or 0) != surrogate_path.stat().st_size:
            raise SystemExit(f"component model surrogate lane size stale: {lane}")
        lane_record = detail_lane_by_name[lane]
        lane_components = sorted(
            records_by_intake_file.get(str(item.get("file") or ""), []),
            key=lambda record: str(record.get("reference") or ""),
        )
        expected_lane_record = {
            "lane": lane,
            "status": item.get("status"),
            "file": item.get("file"),
            "file_present": True,
            "sha256": item.get("sha256"),
            "actual_sha256": file_sha256(surrogate_path),
            "bytes": int(item.get("bytes") or 0),
            "actual_bytes": surrogate_path.stat().st_size,
            "hash_matches_file": True,
            "size_matches_file": True,
            "release_credit": False,
            "component_reference_count": len(lane_components),
            "manifest_model_reference_count": int(item.get("model_reference_count") or 0),
            "component_references": [
                str(record.get("reference") or "") for record in lane_components
            ],
            "expected_supplier_step_files": sorted(
                {
                    str(record.get("expected_supplier_step_file") or "")
                    for record in lane_components
                    if record.get("expected_supplier_step_file")
                }
            ),
            "footprints": sorted(
                {
                    str(record.get("footprint") or "")
                    for record in lane_components
                    if record.get("footprint")
                }
            ),
            "supplier_step_intake_statuses": sorted(
                {
                    str(record.get("supplier_step_intake_status") or "")
                    for record in lane_components
                    if record.get("supplier_step_intake_status")
                }
            ),
            "all_component_records_release_credit_false": all(
                record.get("release_credit") is False for record in lane_components
            ),
            "all_component_records_reference_this_surrogate": all(
                record.get("supplier_step_intake_file") == item.get("file")
                for record in lane_components
            ),
        }
        if lane_record != expected_lane_record:
            raise SystemExit(f"supplier surrogate intake detail lane stale: {lane}")

    print(
        "component model directory filesystem coverage ok: "
        f"{len(records)} records, {len(filesystem_steps)} local STEP files, "
        f"{len(lane_surrogates)} surrogate supplier lanes fail-closed"
    )


def check_routed_board_step_intake_template() -> None:
    intake_path = ROOT / "mechanical/e1-phone/review/routed-board-step-intake-template.csv"
    intake_detail_path = ROOT / "mechanical/e1-phone/review/routed-board-step-intake-detail.json"
    kicad_preflight_path = ROOT / "mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json"
    coverage_path = ROOT / "mechanical/e1-phone/review/cad-connection-coverage.json"
    board_step_path = ROOT / "mechanical/e1-phone/review/board-step-readiness.json"
    traceability_path = ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
    candidate_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
    )
    step_intake_path = (
        ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
    )
    component_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
    )
    for path in [
        intake_path,
        intake_detail_path,
        kicad_preflight_path,
        coverage_path,
        board_step_path,
        traceability_path,
        candidate_manifest_path,
        step_intake_path,
        component_manifest_path,
    ]:
        require_path(path)

    rows = list(csv.DictReader(intake_path.read_text(encoding="utf-8").splitlines()))
    if len(rows) != 1:
        raise SystemExit("routed-board STEP intake template must contain one local candidate row")
    row = rows[0]
    intake_detail = json.loads(intake_detail_path.read_text(encoding="utf-8"))
    kicad_preflight = json.loads(kicad_preflight_path.read_text(encoding="utf-8"))
    coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
    board_step = load_yaml(board_step_path)
    traceability = load_yaml(traceability_path)
    candidate_manifest = load_yaml(candidate_manifest_path)
    step_intake = load_yaml(step_intake_path)
    component_manifest = load_yaml(component_manifest_path)
    if not isinstance(coverage, dict):
        raise SystemExit("CAD connection coverage must be a JSON object")
    if not isinstance(traceability, dict) or not isinstance(traceability.get("summary"), dict):
        raise SystemExit("KiCad/CAD traceability matrix summary missing")
    if not isinstance(candidate_manifest, dict):
        raise SystemExit("routed output candidate manifest must be a YAML mapping")
    if not isinstance(component_manifest, dict):
        raise SystemExit("component 3D model manifest must be a YAML mapping")
    if not isinstance(intake_detail, dict):
        raise SystemExit("routed-board STEP intake detail must be a JSON object")
    if not isinstance(kicad_preflight, dict):
        raise SystemExit("routed-board KiCad CLI preflight must be a JSON object")
    if not isinstance(board_step, dict):
        raise SystemExit("board STEP readiness must be a JSON object")
    detailed_candidate = board_step.get("detailed_routed_step_candidate", {})
    if not isinstance(detailed_candidate, dict):
        raise SystemExit("board STEP detailed routed candidate must be a mapping")
    if (
        board_step.get("routed_board_step_intake_detail")
        != "mechanical/e1-phone/review/routed-board-step-intake-detail.json"
    ):
        raise SystemExit("board STEP readiness missing routed-board intake detail path")
    if (
        board_step.get("routed_board_kicad_cli_preflight")
        != "mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json"
    ):
        raise SystemExit("board STEP readiness missing routed-board KiCad CLI preflight path")
    expected_preflight = {
        "schema": "eliza.e1_phone_routed_board_kicad_cli_preflight.v1",
        "tool": "kicad-cli",
        "available": True,
        "sch_erc_available": True,
        "pcb_drc_available": True,
        "pcb_step_export_available": True,
        "required_release_commands_available": True,
        "step_export_status": "available_not_release_validated",
        "release_credit": False,
    }
    for field, expected in expected_preflight.items():
        if kicad_preflight.get(field) != expected:
            raise SystemExit(
                f"routed-board KiCad CLI preflight stale: {field} "
                f"expected {expected!r} got {kicad_preflight.get(field)!r}"
            )
    if kicad_preflight.get("drc_status") not in {
        "blocked_kicad_cli_drc_violations",
        "blocked_kicad_cli_drc_not_run",
    }:
        raise SystemExit("routed-board KiCad CLI preflight stale: drc_status")
    if kicad_preflight.get("erc_status") not in {
        "blocked_kicad_cli_erc_violations",
        "blocked_kicad_cli_erc_not_run",
    }:
        raise SystemExit("routed-board KiCad CLI preflight stale: erc_status")
    local_reports = kicad_preflight.get("local_non_release_reports")
    if not isinstance(local_reports, dict):
        raise SystemExit("routed-board KiCad CLI preflight missing local report evidence")
    expected_local_report_counts = {
        "drc": {
            "output": ROOT / "mechanical/e1-phone/review/local-kicad-cli/routed-drc.json",
            "violations_key": "violations",
            "unconnected_key": "unconnected_items",
        },
        "erc": {
            "output": ROOT / "mechanical/e1-phone/review/local-kicad-cli/e1-phone-erc.json",
            "violations_key": "sheets",
        },
    }
    for report_id, expected_report in expected_local_report_counts.items():
        report = local_reports.get(report_id)
        if not isinstance(report, dict):
            raise SystemExit(f"routed-board KiCad CLI preflight missing {report_id} report")
        output_path = expected_report["output"]
        require_path(output_path)
        if report.get("output") != str(output_path.relative_to(ROOT)):
            raise SystemExit(f"routed-board KiCad CLI {report_id} output path stale")
        if report.get("output_present") is not True:
            raise SystemExit(f"routed-board KiCad CLI {report_id} output not marked present")
        if int(report.get("output_bytes") or 0) != output_path.stat().st_size:
            raise SystemExit(f"routed-board KiCad CLI {report_id} output size stale")
        if report.get("output_sha256") != file_sha256(output_path):
            raise SystemExit(f"routed-board KiCad CLI {report_id} output hash stale")
        parsed_report = json.loads(output_path.read_text(encoding="utf-8"))
        if not isinstance(parsed_report, dict):
            raise SystemExit(f"routed-board KiCad CLI {report_id} output is not JSON object")
        if report_id == "drc":
            violations = parsed_report.get("violations", [])
            unconnected = parsed_report.get("unconnected_items", [])
            if int(report.get("violation_count") or 0) != (
                len(violations) if isinstance(violations, list) else 0
            ):
                raise SystemExit("routed-board KiCad CLI DRC violation count stale")
            if int(report.get("unconnected_item_count") or 0) != (
                len(unconnected) if isinstance(unconnected, list) else 0
            ):
                raise SystemExit("routed-board KiCad CLI DRC unconnected count stale")
        else:
            sheets = parsed_report.get("sheets", [])
            violation_count = sum(
                len(sheet.get("violations", []))
                for sheet in sheets
                if isinstance(sheet, dict) and isinstance(sheet.get("violations", []), list)
            )
            if int(report.get("violation_count") or 0) != violation_count:
                raise SystemExit("routed-board KiCad CLI ERC violation count stale")
        if report.get("release_credit") is not False:
            raise SystemExit(f"routed-board KiCad CLI {report_id} report must be non-release")
    triage_path_value = kicad_preflight.get("local_triage_report")
    if triage_path_value != "mechanical/e1-phone/review/local-kicad-cli/drc-erc-triage.json":
        raise SystemExit("routed-board KiCad CLI triage report path stale")
    triage_path = ROOT / triage_path_value
    triage_md_path = triage_path.with_suffix(".md")
    require_path(triage_path)
    require_path(triage_md_path)
    if kicad_preflight.get("local_triage_report_sha256") != file_sha256(triage_path):
        raise SystemExit("routed-board KiCad CLI triage report hash stale")
    triage = json.loads(triage_path.read_text(encoding="utf-8"))
    if not isinstance(triage, dict):
        raise SystemExit("routed-board KiCad CLI triage report is not a JSON object")
    if triage.get("schema") != "eliza.e1_phone_local_kicad_cli_drc_erc_triage.v1":
        raise SystemExit("routed-board KiCad CLI triage schema stale")
    if triage.get("release_credit") is not False:
        raise SystemExit("routed-board KiCad CLI triage must be non-release")
    if triage.get("source_hashes", {}).get("drc_sha256") != file_sha256(
        ROOT / "mechanical/e1-phone/review/local-kicad-cli/routed-drc.json"
    ):
        raise SystemExit("routed-board KiCad CLI triage DRC source hash stale")
    if triage.get("source_hashes", {}).get("erc_sha256") != file_sha256(
        ROOT / "mechanical/e1-phone/review/local-kicad-cli/e1-phone-erc.json"
    ):
        raise SystemExit("routed-board KiCad CLI triage ERC source hash stale")
    if int(triage.get("drc", {}).get("total_count") or 0) != (
        int(local_reports["drc"].get("violation_count") or 0)
        + int(local_reports["drc"].get("unconnected_item_count") or 0)
    ):
        raise SystemExit("routed-board KiCad CLI triage DRC total stale")
    if int(triage.get("erc", {}).get("total_count") or 0) != int(
        local_reports["erc"].get("violation_count") or 0
    ):
        raise SystemExit("routed-board KiCad CLI triage ERC total stale")
    for required_drc_type in ["clearance", "unconnected_items", "solder_mask_bridge"]:
        if required_drc_type not in triage.get("drc", {}).get("by_type", {}):
            raise SystemExit(f"routed-board KiCad CLI triage missing DRC type {required_drc_type}")
    for required_erc_type in ["global_label_dangling", "pin_not_connected"]:
        if required_erc_type not in triage.get("erc", {}).get("by_type", {}):
            raise SystemExit(f"routed-board KiCad CLI triage missing ERC type {required_erc_type}")

    visual_detail = candidate_manifest.get("routed_step_visual_detail", {})
    if not isinstance(visual_detail, dict):
        raise SystemExit("routed output candidate manifest visual detail missing")
    route_visual_records = visual_detail.get("route_visual_records")
    via_visual_records = visual_detail.get("via_visual_records")
    filled_zone_records = visual_detail.get("filled_copper_zone_records")
    if (
        not isinstance(route_visual_records, list)
        or len(route_visual_records) != int(step_intake.get("route_segment_visual_count") or 0)
        or not isinstance(via_visual_records, list)
        or len(via_visual_records) != int(step_intake.get("via_visual_count") or 0)
        or not isinstance(filled_zone_records, list)
        or len(filled_zone_records) != int(step_intake.get("filled_copper_zone_visual_count") or 0)
    ):
        raise SystemExit("routed output candidate visual record manifests are stale")
    routed_visual_flags = {
        "route_visual_all_records_have_route_id": True,
        "route_visual_all_records_have_net": True,
        "route_visual_all_records_have_layer": True,
        "route_visual_all_records_have_route_class": True,
        "route_visual_all_records_have_source_domain": True,
        "via_visual_all_records_have_net": True,
        "via_visual_all_records_have_layers": True,
        "filled_copper_zone_all_records_have_net": True,
        "filled_copper_zone_all_records_have_bbox": True,
        "release_credit": False,
    }
    for key, expected in routed_visual_flags.items():
        if visual_detail.get(key) != expected:
            raise SystemExit(f"routed output candidate visual detail stale: {key}")
    if int(visual_detail.get("route_visual_record_count") or 0) != len(route_visual_records):
        raise SystemExit("routed output candidate route visual count stale")
    if int(visual_detail.get("via_visual_record_count") or 0) != len(via_visual_records):
        raise SystemExit("routed output candidate via visual count stale")
    if int(visual_detail.get("filled_copper_zone_record_count") or 0) != len(filled_zone_records):
        raise SystemExit("routed output candidate filled-zone visual count stale")
    expected_filled_polygon_count = sum(
        int(record.get("filled_polygon_count") or 0) for record in filled_zone_records
    )
    if expected_filled_polygon_count != int(
        step_intake.get("filled_copper_zone_polygon_count") or 0
    ):
        raise SystemExit("routed output candidate filled-zone polygon source count stale")
    if int(visual_detail.get("filled_copper_zone_filled_polygon_count") or 0) != (
        expected_filled_polygon_count
    ):
        raise SystemExit("routed output candidate filled-zone polygon count stale")
    models = component_manifest.get("models", [])
    if not isinstance(models, list):
        raise SystemExit("component 3D model manifest models must be a list")
    trace_summary = traceability["summary"]
    expected_fields = {
        "release_id": "LOCAL-ROUTED-CANDIDATE-2026-05-22",
        "kicad_pcb_path": "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb",
        "routed_step_artifact": (
            "board/kicad/e1-phone/production/step/routed-board-with-components.step"
        ),
        "source_board_sha256": str(candidate_manifest.get("source_board_sha256") or ""),
        "source_step_artifact": str(candidate_manifest.get("source_step") or ""),
        "source_step_sha256": str(candidate_manifest.get("source_step_sha256") or ""),
        "kicad_cli_preflight_artifact": (
            "mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json"
        ),
        "kicad_cli_available": "true",
        "drc_status": str(kicad_preflight.get("drc_status") or ""),
        "erc_status": str(kicad_preflight.get("erc_status") or ""),
        "component_3d_model_manifest": (
            "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
        ),
        "component_model_count": str(len(models)),
        "pad_contact_visual_count": str(int(visual_detail.get("pad_contact_visual_count") or 0)),
        "route_segment_visual_count": str(
            int(visual_detail.get("route_segment_visual_count") or 0)
        ),
        "route_segment_net_name_count": str(
            int(visual_detail.get("route_segment_net_name_count") or 0)
        ),
        "route_segment_trace_bound_count": str(
            int(visual_detail.get("route_segment_trace_bound_count") or 0)
        ),
        "route_segment_trace_unbound_count": str(
            int(visual_detail.get("route_segment_trace_unbound_count") or 0)
        ),
        "controlled_impedance_segment_visual_count": str(
            int(visual_detail.get("controlled_impedance_segment_visual_count") or 0)
        ),
        "via_net_name_count": str(int(visual_detail.get("via_net_name_count") or 0)),
        "cad_connection_count": str(int(coverage.get("passing_connection_count") or 0)),
        "kicad_cad_traceability_matrix": (
            "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
        ),
        "traceability_status": str(traceability.get("status") or ""),
        "traceability_gap_count": str(
            sum(
                int(trace_summary.get(field) or 0)
                for field in [
                    "incomplete_footprint_count",
                    "incomplete_cad_connection_count",
                    "missing_captured_pinout_file_count",
                    "incomplete_captured_pinout_detail_count",
                ]
            )
        ),
        "enclosure_clearance_rerun_artifact": (
            "mechanical/e1-phone/review/routed-board-clearance.json"
        ),
        "evidence_class": "blocked_local_candidate_outputs_not_release",
        "release_credit": "false",
    }
    for field, expected in expected_fields.items():
        if str(row.get(field, "")).strip() != expected:
            raise SystemExit(
                f"routed-board STEP intake template stale: {field} "
                f"expected {expected!r} got {row.get(field)!r}"
            )

    routed_step_path = ROOT / row["routed_step_artifact"]
    require_path(routed_step_path)
    if row.get("routed_step_sha256", "").strip() != file_sha256(routed_step_path):
        raise SystemExit("routed-board STEP intake template routed STEP hash stale")
    if row.get("release_credit", "").strip().lower() != "false":
        raise SystemExit("local routed-board STEP intake must remain fail-closed")

    detail_expected_fields = {
        "schema": "eliza.e1_phone_routed_board_step_intake_detail.v1",
        "csv_intake": "mechanical/e1-phone/review/routed-board-step-intake-template.csv",
        "release_id": row["release_id"],
        "evidence_class": row["evidence_class"],
        "routed_step_artifact": row["routed_step_artifact"],
        "routed_step_sha256": row["routed_step_sha256"],
        "kicad_cli_preflight": "mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json",
        "kicad_cli_available": True,
        "drc_status": str(kicad_preflight.get("drc_status") or ""),
        "erc_status": str(kicad_preflight.get("erc_status") or ""),
        "release_credit": False,
        "route_visual_record_count": int(row["route_segment_visual_count"]),
        "component_model_record_count": int(row["component_model_count"]),
        "cad_connection_record_count": int(row["cad_connection_count"]),
    }
    for field, expected in detail_expected_fields.items():
        if intake_detail.get(field) != expected:
            raise SystemExit(
                f"routed-board STEP intake detail stale: {field} "
                f"expected {expected!r} got {intake_detail.get(field)!r}"
            )
    detailed_record_keys = [
        "route_visual_records",
        "via_visual_records",
        "filled_copper_zone_records",
        "component_model_record_manifest",
        "cad_connection_record_manifest",
    ]
    for key in detailed_record_keys:
        if intake_detail.get(key) != detailed_candidate.get(key):
            raise SystemExit(f"routed-board STEP intake detail record list stale: {key}")
    detailed_count_keys = [
        "route_visual_record_count",
        "via_visual_record_count",
        "filled_copper_zone_record_count",
        "filled_copper_zone_filled_polygon_count",
        "component_model_record_count",
        "cad_connection_record_count",
    ]
    for key in detailed_count_keys:
        if int(intake_detail.get(key) or 0) != int(detailed_candidate.get(key) or 0):
            raise SystemExit(f"routed-board STEP intake detail count stale: {key}")
    detailed_flag_keys = [
        "all_route_records_have_net_layer_class_and_source",
        "all_component_records_have_local_step",
        "all_connection_records_have_cad_step",
    ]
    for key in detailed_flag_keys:
        if intake_detail.get(key) is not True or detailed_candidate.get(key) is not True:
            raise SystemExit(f"routed-board STEP intake detail flag stale: {key}")

    print(
        "routed-board STEP intake template ok: "
        f"{row['cad_connection_count']} CAD connections, "
        f"{row['component_model_count']} component models, "
        f"{intake_detail['route_visual_record_count']} detailed route records"
    )


def check_routed_board_clearance_release_intake() -> None:
    intake_path = ROOT / "mechanical/e1-phone/review/routed-board-clearance-release-intake.yaml"
    board_step_path = ROOT / "mechanical/e1-phone/review/board-step-readiness.json"
    candidate_metadata_path = (
        ROOT
        / "board/kicad/e1-phone/production/step/routed-board-with-components.step.metadata.yaml"
    )
    component_directory_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/step/component-models/release-manifest.yaml"
    )
    component_model_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
    )
    for path in [
        intake_path,
        board_step_path,
        candidate_metadata_path,
        component_directory_manifest_path,
        component_model_manifest_path,
    ]:
        require_path(path)

    def repo_path_from_packaged(value: str) -> Path:
        return ROOT / value.removeprefix("packages/chip/")

    intake = load_yaml(intake_path)
    board_step = load_yaml(board_step_path)
    candidate_metadata = load_yaml(candidate_metadata_path)
    component_directory_manifest = load_yaml(component_directory_manifest_path)
    component_model_manifest = load_yaml(component_model_manifest_path)
    detailed_candidate = board_step.get("detailed_routed_step_candidate", {})
    if intake["schema"] != "eliza.e1_phone_routed_board_clearance_release_intake.v1":
        raise SystemExit("routed-board clearance release intake schema diverges")
    if (
        intake["status"]
        != "local_candidate_intake_blocked_waiting_supplier_geometry_and_clearance_measurements"
    ):
        raise SystemExit(f"unexpected routed-board clearance intake status: {intake['status']}")

    metadata = intake["intake_metadata"]
    expected_paths = {
        "routed_pcb_path": (
            "packages/chip/board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
        ),
        "routed_board_step_path": (
            "packages/chip/board/kicad/e1-phone/production/step/routed-board-with-components.step"
        ),
        "component_model_bundle_path": (
            "packages/chip/board/kicad/e1-phone/production/step/component-models/"
            "release-manifest.yaml"
        ),
        "component_model_manifest_path": (
            "packages/chip/board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
        ),
    }
    for key, expected in expected_paths.items():
        if metadata.get(key) != expected:
            raise SystemExit(f"routed-board clearance intake path stale: {key}")
        require_path(repo_path_from_packaged(expected))

    expected_hashes = {
        "routed_pcb_sha256": metadata["routed_pcb_path"],
        "routed_board_step_sha256": metadata["routed_board_step_path"],
        "component_model_bundle_sha256": metadata["component_model_bundle_path"],
        "component_model_manifest_sha256": metadata["component_model_manifest_path"],
    }
    for hash_key, path_value in expected_hashes.items():
        actual = file_sha256(repo_path_from_packaged(path_value))
        if metadata.get(hash_key) != actual:
            raise SystemExit(f"routed-board clearance intake hash stale: {hash_key}")
    step_file = repo_path_from_packaged(metadata["routed_board_step_path"])
    if metadata.get("routed_board_step_size_bytes") != step_file.stat().st_size:
        raise SystemExit("routed-board clearance intake STEP size stale")
    if metadata.get("routed_board_step_sha256") != detailed_candidate.get("sha256"):
        raise SystemExit(
            "routed-board clearance intake STEP hash diverges from board-step readiness"
        )
    if candidate_metadata.get("artifact_sha256") != metadata.get("routed_board_step_sha256"):
        raise SystemExit("routed-board clearance intake STEP hash diverges from metadata sidecar")

    context = intake.get("local_candidate_context", {})
    routed_step_visual_detail = candidate_metadata.get("routed_step_visual_detail", {})
    if not isinstance(routed_step_visual_detail, dict):
        routed_step_visual_detail = {}
    expected_context = {
        "evidence_class": "blocked_local_candidate_outputs_not_release",
        "release_credit": False,
        "routed_output_metadata": (
            "packages/chip/board/kicad/e1-phone/production/step/"
            "routed-board-with-components.step.metadata.yaml"
        ),
        "board_step_readiness": (
            "packages/chip/mechanical/e1-phone/review/board-step-readiness.json"
        ),
        "kicad_cli_preflight": (
            "packages/chip/mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json"
        ),
        "route_count": detailed_candidate.get("route_count"),
        "segment_count": detailed_candidate.get("segment_count"),
        "via_count": routed_step_visual_detail.get("board_via_count"),
        "component_model_count": component_model_manifest.get("component_model_count"),
        "cad_connection_count": detailed_candidate.get("cad_connection_record_count"),
    }
    for key, expected in expected_context.items():
        if context.get(key) != expected:
            raise SystemExit(f"routed-board clearance intake local candidate context stale: {key}")
    if component_directory_manifest.get("release_allowed") is not False:
        raise SystemExit("component model directory must remain non-release")

    cases = intake.get("clearance_cases", [])
    if len(cases) != 12:
        raise SystemExit("routed-board clearance intake must track 12 clearance cases")
    if any(case.get("pass") is not False or case.get("result") != "not_reviewed" for case in cases):
        raise SystemExit("routed-board clearance intake must keep all cases unpassed")
    expected_flags = {
        "routed_board_step_present": True,
        "routed_board_step_release_credit": False,
        "routed_board_step_blocked_local_candidate": True,
        "supplier_geometry_complete": False,
        "boolean_interference_passed": False,
        "all_clearance_cases_measured": False,
        "all_clearance_cases_passed": False,
        "reviewer_signed": False,
        "release_allowed": False,
    }
    flags = intake["release_flags"]
    flag_key: str
    flag_expected: bool
    for flag_key, flag_expected in expected_flags.items():
        if flags.get(flag_key) != flag_expected:
            raise SystemExit(f"routed-board clearance intake release flag stale: {flag_key}")
    for claim in [
        "routed_clearance_passed",
        "enclosure_ready",
        "fabrication_ready",
        "end_to_end_phone_ready",
    ]:
        if claim not in intake["forbidden_claims"]:
            raise SystemExit(f"routed-board clearance intake missing forbidden claim {claim}")
    print(
        "routed-board clearance release intake ok: "
        f"local STEP candidate present, {len(cases)} clearance cases unpassed fail-closed"
    )


def check_kicad_cad_stub_audit() -> None:
    audit_rel = "board/kicad/e1-phone/kicad-cad-end-to-end-stub-audit-2026-05-22.yaml"
    audit = load_yaml(ROOT / audit_rel)
    manifest = load_yaml(MANIFEST)
    coverage = json.loads(
        (ROOT / "mechanical/e1-phone/review/cad-connection-coverage.json").read_text()
    )
    assembly = json.loads((ROOT / "mechanical/e1-phone/out/assembly-manifest.json").read_text())
    traceability = load_yaml(
        ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
    )
    candidate = load_yaml(
        ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
    )
    component_manifest = load_yaml(
        ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
    )
    mechanical_inventory = load_yaml(
        ROOT / "mechanical/e1-phone/review/mechanical-cad-evidence-inventory-2026-05-22.yaml"
    )
    public_cad_intake = load_yaml(
        ROOT / "board/kicad/e1-phone/public-cad-source-intake-2026-05-28.yaml"
    )
    public_bom_cost = load_yaml(
        ROOT / "mechanical/e1-phone/review/bom-public-market-cost-bands-2026-05-28.yaml"
    )
    step_intake = load_yaml(
        ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
    )
    board_step = load_yaml(ROOT / "mechanical/e1-phone/review/board-step-readiness.json")
    full_cad_boolean = load_yaml(
        ROOT / "mechanical/e1-phone/review/full-cad-boolean-interference.json"
    )

    if audit_rel not in manifest["current_artifacts"]["planning"]:
        raise SystemExit("manifest missing KiCad/CAD end-to-end stub audit")
    if audit["schema"] != "eliza.e1_phone_kicad_cad_end_to_end_stub_audit.v1":
        raise SystemExit("KiCad/CAD stub audit schema diverges")
    if audit["status"] != "blocked_external_evidence_required_after_local_cad_geometry_fix":
        raise SystemExit(f"unexpected KiCad/CAD stub audit status: {audit['status']}")

    state = audit["kicad_package_state"]
    trace_summary = traceability["summary"]
    candidate_coverage = candidate["cad_connection_coverage"]
    candidate_trace = candidate["kicad_cad_traceability"]
    candidate_source_binding = candidate["routed_candidate_source_binding"]
    component_coverage = component_manifest["cad_connection_coverage"]

    routed_candidate_text = (
        ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb"
    ).read_text(encoding="utf-8")
    concept_text = (
        ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
    ).read_text(encoding="utf-8")
    expected_live_state = {
        "footprint_count": concept_text.count('(footprint "'),
        "placeholder_not_fabrication_footprint_markers": concept_text.count(
            "placeholder_not_fabrication_footprint"
        ),
        "local_routed_kicad_candidate_segment_count": routed_candidate_text.count("\n  (segment "),
        "local_routed_kicad_candidate_via_count": routed_candidate_text.count("\n  (via "),
        "local_routed_kicad_candidate_matches_real_footprint_source": candidate_source_binding[
            "candidate_matches_source_board"
        ],
        "local_routed_kicad_candidate_zero_placeholder_real_footprint_board": candidate_source_binding[
            "candidate_is_zero_placeholder_real_footprint_board"
        ],
        "local_routed_kicad_candidate_placeholder_markers": routed_candidate_text.count(
            "placeholder_not_fabrication_footprint"
        ),
        "local_routed_kicad_candidate_legacy_e1phone_footprint_refs": routed_candidate_text.count(
            '(footprint "E1Phone:'
        ),
        "local_routed_kicad_candidate_footprint_count": routed_candidate_text.count('(footprint "'),
        "local_routed_kicad_candidate_zone_count": routed_candidate_text.count("\n  (zone "),
        "local_routed_kicad_candidate_filled_zone_count": routed_candidate_text.count(
            "(filled_polygon"
        ),
        "detailed_routed_step_candidate_bytes": candidate["source_step_size_bytes"],
        "detailed_routed_step_candidate_release_credit": candidate["release_credit"],
        "real_footprint_development_step_envelope_count": step_intake["footprint_envelope_count"],
        "real_footprint_development_step_pad_contact_visual_count": step_intake[
            "pad_contact_visual_count"
        ],
        "real_footprint_development_step_route_segment_visual_count": step_intake[
            "route_segment_visual_count"
        ],
        "real_footprint_development_step_route_segment_net_name_count": step_intake[
            "route_segment_net_name_count"
        ],
        "real_footprint_development_step_route_segment_trace_bound_count": step_intake[
            "route_segment_trace_bound_count"
        ],
        "real_footprint_development_step_route_segment_trace_unbound_count": step_intake[
            "route_segment_trace_unbound_count"
        ],
        "real_footprint_development_step_controlled_impedance_segment_visual_count": step_intake[
            "controlled_impedance_segment_visual_count"
        ],
        "real_footprint_development_step_via_net_name_count": step_intake["via_net_name_count"],
        "board_step_readiness_status": board_step["status"],
        "full_cad_boolean_status": full_cad_boolean["overall_status"],
        "full_cad_boolean_parts_loaded": int(full_cad_boolean.get("parts_loaded") or 0),
        "full_cad_boolean_pair_count_brep_evaluated": int(
            full_cad_boolean.get("pair_count_brep_evaluated") or 0
        ),
        "full_cad_boolean_unintentional_clash_count": len(
            full_cad_boolean.get("unintentional_clashes") or []
        ),
        "full_cad_boolean_scope_result_count": len(full_cad_boolean.get("scope_results") or []),
        "full_cad_boolean_passing_scope_result_count": sum(
            1
            for result in full_cad_boolean.get("scope_results") or []
            if result.get("status") == "pass"
        ),
        "full_cad_boolean_release_credit": False,
    }
    for key, expected in expected_live_state.items():
        if state[key] != expected:
            raise SystemExit(f"KiCad/CAD stub audit live state stale: {key}")

    public_sourcing = mechanical_inventory.get("public_sourcing_intake_ready", {})
    public_cad_summary = public_cad_intake.get("summary", {})
    public_bom_summary = public_bom_cost.get("summary", {})
    if not isinstance(public_sourcing, dict):
        raise SystemExit("KiCad/CAD stub audit missing mechanical public sourcing context")
    if not isinstance(public_cad_summary, dict) or not isinstance(public_bom_summary, dict):
        raise SystemExit("KiCad/CAD stub audit public sourcing summaries missing")
    expected_public_sourcing_state = {
        "public_sourcing_intake_ready": public_sourcing.get("ready") is True,
        "public_sourcing_intake_scope": public_sourcing.get("scope"),
        "public_cad_source_record_count": int(
            public_sourcing.get("public_cad_source_record_count") or 0
        ),
        "public_cad_source_step_or_3d_observed_count": int(
            public_sourcing.get("public_cad_source_step_or_3d_observed_count") or 0
        ),
        "public_cad_source_footprint_or_eda_observed_count": int(
            public_sourcing.get("public_cad_source_footprint_or_eda_observed_count") or 0
        ),
        "public_cad_source_local_downloaded_hashed_count": int(
            public_sourcing.get("public_cad_source_local_downloaded_hashed_count") or 0
        ),
        "public_cad_source_release_credit_record_count": int(
            public_sourcing.get("public_cad_source_release_credit_record_count") or 0
        ),
        "public_market_bom_cost_category_count": int(
            public_sourcing.get("public_market_bom_cost_category_count") or 0
        ),
        "public_market_bom_cost_volume_count": int(
            public_sourcing.get("public_market_bom_cost_volume_count") or 0
        ),
        "public_market_bom_cost_avl_quote_count": int(
            public_sourcing.get("public_market_bom_cost_avl_quote_count") or 0
        ),
        "public_market_bom_cost_signed_supplier_quote_count": int(
            public_sourcing.get("public_market_bom_cost_signed_supplier_quote_count") or 0
        ),
        "public_sourcing_intake_release_credit": public_sourcing.get("release_credit") is True,
        "public_sourcing_intake_release_allowed": public_sourcing.get("release_allowed") is True,
    }
    for key, expected in expected_public_sourcing_state.items():
        if state[key] != expected:
            raise SystemExit(f"KiCad/CAD stub audit public sourcing state stale: {key}")
    if state["public_cad_source_record_count"] != int(public_cad_summary.get("record_count") or 0):
        raise SystemExit("KiCad/CAD stub audit public CAD record count stale")
    if state["public_market_bom_cost_category_count"] != int(
        public_bom_summary.get("category_count") or 0
    ):
        raise SystemExit("KiCad/CAD stub audit public BOM category count stale")
    if state["public_sourcing_intake_release_credit"] is not False:
        raise SystemExit("KiCad/CAD stub audit cannot grant public sourcing release credit")
    if state["public_sourcing_intake_release_allowed"] is not False:
        raise SystemExit("KiCad/CAD stub audit cannot allow public sourcing release")

    assembly_terminal_count = sum(
        1 for part in assembly if part.get("role") == "connection terminal"
    )
    connection_solid_names = {
        connection["cad_part"]
        for connection in coverage["connections"]
        if connection.get("cad_part_present")
    }
    assembly_connection_solid_count = sum(
        1 for part in assembly if part.get("name") in connection_solid_names
    )
    connection_release_boundary = coverage.get("release_boundary_summary")
    if not isinstance(connection_release_boundary, dict):
        raise SystemExit("KiCad/CAD stub audit missing connection release-boundary summary")
    critical_interface_groups = connection_release_boundary.get("critical_interface_connection_ids")
    if not isinstance(critical_interface_groups, dict):
        raise SystemExit("KiCad/CAD stub audit missing critical interface connection groups")
    required_critical_groups = {
        "display_touch",
        "rear_camera",
        "front_camera",
        "usb_power_battery",
        "cellular_wifi_rf",
        "nfc",
        "audio_haptic_sensor",
        "shield_ground",
        "board_to_board",
    }
    if set(critical_interface_groups) != required_critical_groups:
        raise SystemExit("KiCad/CAD stub audit critical interface groups diverge")
    expected_connection_state = {
        "cad_connection_coverage_required_count": coverage["required_connection_count"],
        "cad_connection_coverage_passing_count": coverage["passing_connection_count"],
        "cad_connection_coverage_required_terminal_marker_count": coverage[
            "required_connection_terminal_marker_count"
        ],
        "cad_connection_coverage_passing_terminal_pair_count": coverage[
            "passing_connection_terminal_pair_count"
        ],
        "cad_connection_coverage_required_solid_step_part_count": coverage[
            "required_connection_solid_step_part_count"
        ],
        "cad_connection_coverage_passing_solid_step_part_set_count": coverage[
            "passing_connection_solid_step_part_set_count"
        ],
        "cad_connection_coverage_solid_step_part_bytes_total": coverage[
            "connection_solid_step_part_bytes_total"
        ],
        "cad_connection_coverage_assembly_manifest_part_count": len(assembly),
        "cad_connection_coverage_assembly_manifest_terminal_marker_count": assembly_terminal_count,
        "cad_connection_coverage_assembly_manifest_solid_step_part_count": (
            assembly_connection_solid_count + assembly_terminal_count
        ),
        "cad_connection_coverage_assembly_manifest_missing_solid_step_part_count": 0,
        "cad_connection_coverage_represented_net_count_total": coverage[
            "represented_net_count_total"
        ],
        "cad_connection_coverage_represented_route_record_count_total": coverage[
            "represented_route_record_count_total"
        ],
        "cad_connection_coverage_represented_route_records_with_layer_count_total": coverage[
            "represented_route_records_with_layer_count_total"
        ],
        "cad_connection_coverage_represented_route_records_with_source_domain_count_total": (
            coverage["represented_route_records_with_source_domain_count_total"]
        ),
        "cad_connection_coverage_represented_route_records_with_route_class_count_total": (
            coverage["represented_route_records_with_route_class_count_total"]
        ),
        "cad_connection_coverage_represented_route_classification_gap_count": coverage[
            "represented_route_classification_gap_count"
        ],
        "cad_connection_coverage_all_represented_routes_have_layer_source_and_class": coverage[
            "all_represented_routes_have_layer_source_and_class"
        ],
        "cad_connection_coverage_record_count": len(coverage["connections"]),
        "cad_connection_coverage_record_manifest_id_count": len(
            {str(connection.get("id")) for connection in coverage["connections"]}
        ),
        "cad_connection_coverage_represented_net_list_total": sum(
            len(connection.get("represented_nets") or []) for connection in coverage["connections"]
        ),
        "cad_connection_coverage_represented_route_id_list_total": sum(
            len(connection.get("represented_route_ids") or [])
            for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_records_have_represented_nets": all(
            connection.get("represented_nets") for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_records_have_represented_routes": all(
            connection.get("represented_route_ids") for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_represented_nets_match_routed_nets": coverage[
            "all_represented_nets_have_route_trace"
        ],
        "cad_connection_coverage_all_represented_routes_match_counts": all(
            int(connection.get("represented_route_count") or 0)
            == len(connection.get("represented_route_ids") or [])
            for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_records_have_terminal_markers": all(
            connection.get("terminal_markers_present") is True
            for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_records_have_solid_step_parts": all(
            connection.get("solid_step_parts_present") is True
            for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_records_have_cad_step_bytes": all(
            int(connection.get("cad_step_bytes") or 0) > 1000
            for connection in coverage["connections"]
        ),
        "cad_connection_coverage_all_records_have_cad_parts": all(
            connection.get("cad_part_present") is True for connection in coverage["connections"]
        ),
        "cad_connection_coverage_mechanical_envelope_defined_count": coverage[
            "mechanical_envelope_defined_count"
        ],
        "cad_connection_coverage_all_records_have_mechanical_envelope": all(
            isinstance(connection.get("mechanical_envelope"), dict)
            and connection["mechanical_envelope"].get("basis")
            and connection["mechanical_envelope"].get("release_credit") is False
            for connection in coverage["connections"]
        ),
        "cad_connection_coverage_mechanical_envelope_release_credit": coverage[
            "mechanical_envelope_release_credit"
        ],
        "cad_connection_coverage_all_records_release_credit_false": all(
            connection.get("release_credit") is False for connection in coverage["connections"]
        ),
        "cad_connection_coverage_physical_medium_counts": coverage["physical_medium_counts"],
        "cad_connection_coverage_electrical_class_counts": coverage["electrical_class_counts"],
        "cad_connection_coverage_controlled_impedance_count": coverage[
            "controlled_impedance_connection_count"
        ],
        "cad_connection_coverage_controlled_impedance_requirement_defined_count": coverage[
            "controlled_impedance_requirement_defined_count"
        ],
        "cad_connection_coverage_bend_radius_requirement_defined_count": coverage[
            "bend_radius_requirement_defined_count"
        ],
        "cad_connection_coverage_supplier_release_required_count": coverage[
            "supplier_release_required_connection_count"
        ],
        "cad_connection_coverage_release_boundary_summary": connection_release_boundary,
        "cad_connection_coverage_release_credit": coverage["release_credit"],
    }
    for key, expected in expected_connection_state.items():
        if state[key] != expected:
            raise SystemExit(f"KiCad/CAD stub audit connection state stale: {key}")

    for key in [
        "required_connection_count",
        "passing_connection_count",
        "required_connection_terminal_marker_count",
        "passing_connection_terminal_pair_count",
        "required_connection_solid_step_part_count",
        "passing_connection_solid_step_part_set_count",
        "connection_solid_step_part_bytes_total",
        "represented_net_count_total",
        "represented_route_record_count_total",
        "represented_route_records_with_layer_count_total",
        "represented_route_records_with_source_domain_count_total",
        "represented_route_records_with_route_class_count_total",
        "represented_route_classification_gap_count",
        "all_represented_routes_have_layer_source_and_class",
        "mechanical_envelope_defined_count",
        "mechanical_envelope_release_credit",
        "controlled_impedance_connection_count",
        "controlled_impedance_requirement_defined_count",
        "bend_radius_requirement_defined_count",
        "supplier_release_required_connection_count",
        "release_boundary_summary",
        "physical_medium_counts",
        "electrical_class_counts",
        "release_credit",
    ]:
        if candidate_coverage[key] != coverage[key]:
            raise SystemExit(f"routed-output candidate CAD coverage stale: {key}")
        if component_coverage[key] != coverage[key]:
            raise SystemExit(f"component manifest CAD coverage stale: {key}")
    if candidate_coverage["assembly_manifest_part_count"] != len(assembly):
        raise SystemExit("routed-output candidate assembly part count stale")
    if component_coverage["assembly_manifest_part_count"] != len(assembly):
        raise SystemExit("component manifest assembly part count stale")

    traceability_key_map = {
        "routed_output_candidate_traceability_footprint_library_count": ("footprint_library_count"),
        "routed_output_candidate_traceability_board_instance_count": ("board_bound_instance_count"),
        "routed_output_candidate_traceability_step_instance_count": (
            "step_footprint_instance_count"
        ),
        "routed_output_candidate_traceability_captured_pinout_file_count": (
            "captured_pinout_file_count"
        ),
        "routed_output_candidate_traceability_pinout_bound_footprint_count": (
            "pinout_bound_footprint_count"
        ),
        "routed_output_candidate_traceability_cad_connection_count": "cad_connection_count",
        "routed_output_candidate_traceability_cad_connection_represented_route_count_total": (
            "cad_connection_represented_route_count_total"
        ),
        "routed_output_candidate_traceability_cad_connection_represented_route_record_count_total": (
            "cad_connection_represented_route_record_count_total"
        ),
        "routed_output_candidate_traceability_cad_connection_represented_route_records_with_layer_count_total": (
            "cad_connection_represented_route_records_with_layer_count_total"
        ),
        "routed_output_candidate_traceability_cad_connection_represented_route_records_with_source_domain_count_total": (
            "cad_connection_represented_route_records_with_source_domain_count_total"
        ),
        "routed_output_candidate_traceability_cad_connection_represented_route_records_with_route_class_count_total": (
            "cad_connection_represented_route_records_with_route_class_count_total"
        ),
        "routed_output_candidate_traceability_cad_connection_represented_route_classification_gap_count": (
            "cad_connection_represented_route_classification_gap_count"
        ),
        "routed_output_candidate_traceability_explicit_support_pattern_count": (
            "explicit_support_pattern_count"
        ),
    }
    traceability_gap_count = sum(
        int(trace_summary.get(field) or 0)
        for field in [
            "incomplete_footprint_count",
            "incomplete_cad_connection_count",
            "missing_captured_pinout_file_count",
            "incomplete_captured_pinout_detail_count",
        ]
    )
    if state["routed_output_candidate_traceability_gap_count"] != traceability_gap_count:
        raise SystemExit("KiCad/CAD stub audit aggregate traceability gap count stale")
    if candidate_trace.get("status") != traceability.get("status"):
        raise SystemExit("routed-output candidate traceability status stale")
    if (
        traceability_gap_count == 0
        and traceability.get("status") != "local_traceability_complete_not_release"
    ):
        raise SystemExit("KiCad/CAD traceability status must reflect zero local gaps")
    if traceability_gap_count != 0 and not str(traceability.get("status", "")).startswith(
        "blocked_"
    ):
        raise SystemExit("KiCad/CAD traceability status must remain blocked while gaps exist")
    for audit_key, trace_key in traceability_key_map.items():
        if state[audit_key] != trace_summary[trace_key]:
            raise SystemExit(f"KiCad/CAD stub audit traceability stale: {audit_key}")
        if trace_key in candidate_trace and candidate_trace[trace_key] != trace_summary[trace_key]:
            raise SystemExit(f"routed-output candidate traceability stale: {trace_key}")
    for audit_key, trace_key in [
        (
            "routed_output_candidate_traceability_all_pinout_bound_footprints_have_terminal_contract",
            "all_pinout_bound_footprints_have_terminal_contract",
        ),
        (
            "routed_output_candidate_traceability_all_support_patterns_have_explicit_provenance",
            "all_support_patterns_have_explicit_provenance",
        ),
        (
            "routed_output_candidate_traceability_cad_connection_all_represented_routes_have_layer_source_and_class",
            "cad_connection_all_represented_routes_have_layer_source_and_class",
        ),
    ]:
        if state[audit_key] != trace_summary[trace_key]:
            raise SystemExit(f"KiCad/CAD stub audit traceability flag stale: {audit_key}")

    for audit_key, trace_key in [
        (
            "routed_output_candidate_traceability_cad_connection_physical_medium_counts",
            "cad_connection_physical_medium_counts",
        ),
        (
            "routed_output_candidate_traceability_cad_connection_controlled_impedance_count",
            "cad_connection_controlled_impedance_count",
        ),
        (
            "routed_output_candidate_traceability_cad_connection_controlled_impedance_requirement_defined_count",
            "cad_connection_controlled_impedance_requirement_defined_count",
        ),
        (
            "routed_output_candidate_traceability_cad_connection_bend_radius_requirement_defined_count",
            "cad_connection_bend_radius_requirement_defined_count",
        ),
        (
            "routed_output_candidate_traceability_cad_connection_supplier_release_required_count",
            "cad_connection_supplier_release_required_count",
        ),
    ]:
        if state[audit_key] != trace_summary[trace_key]:
            raise SystemExit(f"KiCad/CAD stub audit CAD traceability stale: {audit_key}")

    sweep = audit["literal_todo_stub_sweep"]
    scanned_files = sweep["scanned_code_files"]
    if sweep["scanned_code_file_count"] != len(scanned_files):
        raise SystemExit("KiCad/CAD stub audit scanned file count stale")
    expected_marker_classes = [
        "explicit_code_task_markers",
        "explicit_fixme_markers",
        "unresolved_implementation_phrases",
        "unresolved_release_fields",
    ]
    if sweep.get("searched_marker_classes") != expected_marker_classes:
        raise SystemExit("KiCad/CAD stub audit marker-class scope stale")
    task_marker = "TO" + "DO"
    fix_marker = "FIX" + "ME"
    literal_marker_hits = []
    for rel in scanned_files:
        path = ROOT / rel
        require_path(path)
        text = path.read_text(encoding="utf-8")
        if task_marker in text or fix_marker in text:
            literal_marker_hits.append(rel)
    if literal_marker_hits or sweep["local_code_todo_or_fixme_count"] != 0:
        raise SystemExit(
            "KiCad/CAD stub audit found actionable code task markers: "
            + ", ".join(literal_marker_hits)
        )
    if sweep["local_code_actionable_marker_count"] != 0:
        raise SystemExit("KiCad/CAD stub audit cannot claim actionable marker closure")
    if sweep.get("local_code_marker_hit_count") != sweep.get(
        "local_code_marker_guard_or_prose_count"
    ) + sweep.get("local_code_actionable_marker_count"):
        raise SystemExit("KiCad/CAD stub audit marker accounting is internally stale")
    remaining_placeholder_hits = sweep["remaining_hits_are_fail_closed_evidence_placeholders"]
    seen_placeholder_hits: set[tuple[str, str]] = set()
    for hit in remaining_placeholder_hits:
        marker_path = ROOT / hit["path"]
        marker = str(hit.get("marker") or "")
        disposition = str(hit.get("disposition") or "")
        placeholder_key: tuple[str, str] = (str(hit.get("path") or ""), marker)
        if placeholder_key in seen_placeholder_hits:
            raise SystemExit(
                f"KiCad/CAD stub audit duplicate placeholder marker record: {placeholder_key}"
            )
        seen_placeholder_hits.add(placeholder_key)
        require_path(marker_path)
        if not marker:
            raise SystemExit(f"KiCad/CAD stub audit placeholder hit lacks marker: {hit}")
        if marker not in marker_path.read_text(encoding="utf-8"):
            raise SystemExit(f"KiCad/CAD stub audit placeholder marker not source-backed: {hit}")
        if not disposition:
            raise SystemExit(f"KiCad/CAD stub audit placeholder hit lacks disposition: {hit}")
        if not (
            disposition.startswith("requires_")
            or disposition.startswith("external_")
            or disposition.startswith("explicit_")
        ):
            raise SystemExit(
                f"KiCad/CAD stub audit placeholder hit disposition is not fail-closed: {hit}"
            )

    blockers = {item["id"]: item for item in audit["remaining_blockers"]}
    for blocker_id in [
        "supplier_land_patterns_and_3d_models",
        "routed_kicad_release_board",
        "routed_board_release_intake",
        "physical_routed_board_clearance_results",
    ]:
        if blockers[blocker_id]["local_action_available"] is not False:
            raise SystemExit(f"KiCad/CAD stub audit blocker unexpectedly local: {blocker_id}")
    if audit["decision"]["current_cad_is_not_valid_for"] != (
        "fabrication_release_or_final_routed_board_clearance"
    ):
        raise SystemExit("KiCad/CAD stub audit decision boundary is stale")

    print(
        "KiCad/CAD stub audit ok: "
        f"{coverage['required_connection_count']} connections, "
        f"{len(assembly)} CAD parts, {len(scanned_files)} code files swept"
    )


def check_routed_layout_si_drc_burndown() -> None:
    burndown = load_yaml(
        ROOT / "board/kicad/e1-phone/routed-layout-si-drc-burndown-2026-05-22.yaml"
    )
    if burndown.get("schema") != "eliza.e1_phone_routed_layout_si_drc_burndown.v1":
        raise SystemExit("unexpected routed layout SI/DRC burndown schema")
    if not str(burndown.get("status", "")).startswith("blocked_"):
        raise SystemExit("routed layout SI/DRC burndown must remain blocked")
    for rel in [
        "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb",
        "mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json",
        "mechanical/e1-phone/review/local-kicad-cli/drc-erc-triage.json",
    ]:
        if rel not in burndown["source_artifacts"]:
            raise SystemExit(f"routed layout SI/DRC burndown missing source artifact: {rel}")
        require_path(ROOT / rel)

    candidate = burndown.get("local_routed_candidate_state")
    if not isinstance(candidate, dict):
        raise SystemExit("routed layout SI/DRC burndown missing local candidate state")
    board_path = ROOT / candidate["board_file"]
    step_path = ROOT / candidate["local_step_file"]
    preflight_path = ROOT / candidate["kicad_cli_preflight"]
    triage_path = ROOT / candidate["local_triage_report"]
    for path in [board_path, step_path, preflight_path, triage_path]:
        require_path(path)
    board_text = board_path.read_text(encoding="utf-8")
    expected_candidate = {
        "board_sha256": file_sha256(board_path),
        "local_step_sha256": file_sha256(step_path),
        "footprint_count": board_text.count('(footprint "'),
        "segment_count": board_text.count("\n  (segment "),
        "via_count": board_text.count("\n  (via "),
        "zone_count": board_text.count("\n  (zone "),
        "filled_zone_count": board_text.count("(filled_polygon"),
        "has_tracks": board_text.count("\n  (segment ") > 0,
        "has_filled_zones": board_text.count("(filled_polygon") > 0,
        "has_local_step": step_path.is_file(),
        "release_credit": False,
    }
    for key, expected in expected_candidate.items():
        if candidate.get(key) != expected:
            raise SystemExit(f"routed layout SI/DRC local candidate state stale: {key}")
    if candidate["segment_count"] <= 0 or candidate["filled_zone_count"] <= 0:
        raise SystemExit("routed layout SI/DRC local candidate must expose route geometry")

    preflight = load_json_file(preflight_path)
    triage = load_json_file(triage_path)
    if preflight.get("drc_status") != candidate.get("local_kicad_drc_status"):
        raise SystemExit("routed layout SI/DRC DRC status stale")
    if preflight.get("erc_status") != candidate.get("local_kicad_erc_status"):
        raise SystemExit("routed layout SI/DRC ERC status stale")
    local_reports = preflight.get("local_non_release_reports", {})
    drc_report = local_reports.get("drc", {})
    erc_report = local_reports.get("erc", {})
    expected_drc_total = int(drc_report.get("violation_count") or 0) + int(
        drc_report.get("unconnected_item_count") or 0
    )
    expected_erc_total = int(erc_report.get("violation_count") or 0)
    if candidate.get("local_drc_violation_count") != int(drc_report.get("violation_count") or 0):
        raise SystemExit("routed layout SI/DRC violation count stale")
    if candidate.get("local_drc_unconnected_item_count") != int(
        drc_report.get("unconnected_item_count") or 0
    ):
        raise SystemExit("routed layout SI/DRC unconnected count stale")
    if candidate.get("local_drc_total_count") != expected_drc_total:
        raise SystemExit("routed layout SI/DRC total DRC count stale")
    if candidate.get("local_erc_total_count") != expected_erc_total:
        raise SystemExit("routed layout SI/DRC total ERC count stale")
    if triage.get("drc", {}).get("total_count") != expected_drc_total:
        raise SystemExit("routed layout SI/DRC triage DRC total stale")
    if triage.get("erc", {}).get("total_count") != expected_erc_total:
        raise SystemExit("routed layout SI/DRC triage ERC total stale")
    if triage.get("release_credit") is not False:
        raise SystemExit("routed layout SI/DRC triage must be non-release")
    lineage = candidate.get("drc_erc_evidence_lineage")
    if not isinstance(lineage, dict):
        raise SystemExit("routed layout SI/DRC missing DRC/ERC evidence lineage")
    expected_lineage = {
        "raw_local_drc_report": "mechanical/e1-phone/review/local-kicad-cli/routed-drc.json",
        "raw_local_drc_report_sha256": file_sha256(
            ROOT / "mechanical/e1-phone/review/local-kicad-cli/routed-drc.json"
        ),
        "raw_local_erc_report": "mechanical/e1-phone/review/local-kicad-cli/e1-phone-erc.json",
        "raw_local_erc_report_sha256": file_sha256(
            ROOT / "mechanical/e1-phone/review/local-kicad-cli/e1-phone-erc.json"
        ),
        "local_triage_report": "mechanical/e1-phone/review/local-kicad-cli/drc-erc-triage.json",
        "local_triage_report_sha256": file_sha256(triage_path),
        "preflight_report": "mechanical/e1-phone/review/routed-board-kicad-cli-preflight.json",
        "production_drc_report_path": "board/kicad/e1-phone/production/reports/drc.json",
        "production_erc_report_path": "board/kicad/e1-phone/production/reports/erc.json",
        "production_report_paths_are_candidate_metadata": True,
        "production_report_raw_kicad_payload_required_for_release": True,
        "local_drc_violation_count": int(drc_report.get("violation_count") or 0),
        "local_drc_unconnected_item_count": int(drc_report.get("unconnected_item_count") or 0),
        "local_drc_total_count": expected_drc_total,
        "local_erc_total_count": expected_erc_total,
        "release_credit": False,
    }
    for key, expected in expected_lineage.items():
        if lineage.get(key) != expected:
            raise SystemExit(f"routed layout SI/DRC evidence lineage stale: {key}")
    preflight_lineage = preflight.get("drc_erc_evidence_lineage", {})
    if isinstance(preflight_lineage, dict):
        for key, expected in expected_lineage.items():
            if preflight_lineage.get(key) != expected:
                raise SystemExit(f"routed KiCad preflight evidence lineage stale: {key}")

    output_map = {item["id"]: item for item in burndown["required_kicad_routed_board_outputs"]}
    if output_map["routed_kicad_pcb"].get("local_candidate_present") is not True:
        raise SystemExit("routed layout SI/DRC must record local routed board candidate")
    if output_map["routed_kicad_pcb"].get("present") is not False:
        raise SystemExit("routed layout SI/DRC routed candidate cannot be release-present")
    if output_map["schematic_erc_report"].get("local_non_release_total_count") != expected_erc_total:
        raise SystemExit("routed layout SI/DRC ERC output count stale")
    if output_map["pcb_drc_report"].get("local_non_release_total_count") != expected_drc_total:
        raise SystemExit("routed layout SI/DRC DRC output count stale")
    if output_map["routed_step_with_supplier_models"].get("local_candidate_present") is not True:
        raise SystemExit("routed layout SI/DRC must record local STEP candidate")
    if output_map["routed_step_with_supplier_models"].get("present") is not False:
        raise SystemExit("routed layout SI/DRC local STEP cannot be release-present")

    drc_erc = burndown["validation_evidence_required"]["drc_erc"]
    for rel in drc_erc["local_non_release_artifacts"]:
        require_path(ROOT / rel)
    if drc_erc.get("local_drc_total_count") != expected_drc_total:
        raise SystemExit("routed layout SI/DRC validation DRC total stale")
    if drc_erc.get("local_erc_total_count") != expected_erc_total:
        raise SystemExit("routed layout SI/DRC validation ERC total stale")
    if drc_erc.get("present") is not False:
        raise SystemExit("routed layout SI/DRC local reports cannot satisfy release evidence")
    if not str(drc_erc.get("local_status", "")).startswith("blocked_"):
        raise SystemExit("routed layout SI/DRC local status must remain blocked")

    if burndown["execution_policy"]["fabrication_release_allowed"] is not False:
        raise SystemExit("routed layout SI/DRC unexpectedly allows fabrication release")
    if "drc_clean" not in burndown["forbidden_claims"]:
        raise SystemExit("routed layout SI/DRC missing forbidden DRC-clean claim")
    print(
        "routed layout SI/DRC burndown ok: "
        f"local_route_segments={candidate['segment_count']} "
        f"local_drc_rows={expected_drc_total} local_erc_rows={expected_erc_total} "
        "release blocked"
    )


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
    check_supplier_source_verification()
    check_supplier_rfq_response_normalization()
    check_supplier_rfq_transmittal_drafts()
    check_display_camera_source_revalidation()
    check_display_envelope_downselect()
    check_display_camera_connector_pinout_execution()
    check_display_camera_schematic_net_binding()
    check_display_camera_acceptance()
    check_usb_sidekey_mechanical_decision()
    check_usb_sidekey_selection_wiring_decision()
    check_usb_sidekey_integration()
    check_usb_sidekey_schematic_net_binding()
    check_usb_sidekey_acceptance()
    check_radio_module_selection_wiring_decision()
    check_radio_module_integration()
    check_radio_module_envelope_orderability_gate()
    check_cellular_top_island_repack_feasibility()
    check_cellular_space_saving_downselect()
    check_camera_module_fit_downselect()
    check_radio_antenna_acceptance()
    check_module_host_integration_closure()
    check_module_host_integration_acceptance()
    check_pinout_footprint_freeze()
    check_supplier_drawing_intake()
    check_supplier_sample_release_gate()
    check_footprint_3d_model_library_map()
    check_schematic_symbol_footprint_closure()
    check_evt1_footprint_capture_work_package()
    check_schematic_netclass_execution_package()
    check_schematic_capture_readiness_binding()
    check_route_corridor_execution_package()
    check_trial_route_input_matrix()
    check_usb_route_topology_resolution()
    check_routed_layout_si_drc_burndown()
    check_split_interconnect_pin_allocation_and_binding()
    check_split_interconnect_schematic_net_binding()
    check_interface_closure()
    check_external_interface_design_review()
    check_enclosure_placement_closure()
    check_component_height_step_integration()
    check_enclosure_fit_execution_package()
    check_power_sequence_bringup_closure()
    check_power_bringup_acceptance()
    check_core_power_compute_schematic_net_binding()
    check_power_thermal_budget()
    check_rf_connectivity_closure()
    check_rf_antenna_coexistence_closure()
    check_module_rf_pinout_execution()
    check_radio_module_schematic_net_binding()
    check_audio_acoustic_closure()
    check_audio_haptic_schematic_net_binding()
    check_manufacturing_closure()
    check_production_readiness()
    check_evt1_stackup_impedance_coupon_plan()
    check_factory_probe_map()
    check_factory_production_acceptance()
    check_production_factory_release_execution()
    check_pcb_implementation_audit()
    check_block_netlist_and_routing()
    check_mechanical_overlay()
    check_schematic_scaffold()
    check_pcb_text()
    check_routed_release_plan()
    check_routed_board_step_export_contract()
    check_screen_back_camera_collision_review()
    check_routed_pcb_implementation_execution()
    check_routed_layout_readiness_binding()
    check_first_article_route_execution_order()
    check_post_route_validation_binding()
    check_board_optimization_scorecard()
    check_layout_optimization_execution()
    check_end_to_end_readiness()
    check_supplier_pinout_evidence()
    check_release_evidence_manufacturing_candidate_propagation()
    check_objective_completion_trace_manifests()
    check_development_pattern_pinout_step_coverage()
    check_enclosure_readiness_gap_map_consistency()
    check_component_model_directory_filesystem_coverage()
    check_routed_board_step_intake_template()
    check_routed_board_clearance_release_intake()
    check_kicad_cad_stub_audit()
    check_release_gates_fail_closed(manifest)
    check_no_orphaned_board_files()
    write_board_package_report(manifest)
    raise SystemExit(
        "E1 phone board package structurally consistent; fabrication release remains blocked"
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit as exc:
        if exc.code and not isinstance(exc.code, int):
            if str(exc.code) != (
                "E1 phone board package structurally consistent; fabrication release remains blocked"
            ):
                write_board_package_failure_report(exc.code)
            print(f"STATUS: BLOCKED E1 phone board package validation: {exc.code}")
            raise SystemExit(2) from exc
        raise
