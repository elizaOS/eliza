#!/usr/bin/env python3
"""Generate a non-release STEP assembly from the real-footprint dev board."""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict, cast

import yaml

ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
LIB = ROOT / "board/kicad/e1-phone/e1-phone-dev.pretty"
PARAMS = ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml"
OUT_STEP = (
    ROOT / "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-real-footprint-development.step"
)
MANIFEST = ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
ROUTED_INTAKE = ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"

HEIGHTS_MM = {
    "GCT_USB4105_GF_A_DEV": 3.25,
    "PANASONIC_EVQ_P7_DEV": 1.7,
    "DISPLAY_40P_0P30_DEV": 1.15,
    "CAMERA_24P_0P50_DEV": 1.0,
    "CAMERA_30P_0P50_DEV": 1.0,
    "HIROSE_DF40_80P_0P4_DEV": 1.0,
    "BATTERY_4P_1P00_DEV": 1.6,
    "TI_TPS65987_RSH_56QFN_DEV": 0.9,
    "ADI_MAX77860_WLP81_DEV": 0.65,
    "AUDIO_CODEC_QFN48_DEV": 0.9,
    "MURATA_TYPE_2EA_GEOMETRY_DEV": 1.7,
    "QUECTEL_RG255C_GEOMETRY_DEV": 2.4,
    "SODIMM_260P_0P5_COMPUTE_SOM_DEV": 4.0,
    "ESD_ARRAY_6CH_DEV": 0.55,
    "TVS_DIODE_2P_DEV": 0.7,
    "TESTPOINT_1MM_DEV": 0.05,
    "FIDUCIAL_1MM_DEV": 0.03,
    "MOUNTING_HOLE_1P2_DEV": 0.02,
    "R0402_DEV": 0.35,
    "C0402_DEV": 0.35,
    "L0402_DEV": 0.45,
    "PI_MATCH_0402_DEV": 0.45,
    "RC_ARRAY_4CH_DEV": 0.55,
    "SHUNT_1206_DEV": 0.65,
    "USIM_ESD_LEVELSHIFT_DEV": 0.55,
    "ESIM_LGA_DEV": 0.9,
    "NFC_CONTROLLER_QFN_DEV": 0.9,
    "NFC_LOOP_MATCH_DEV": 0.45,
    "SENSOR_HUB_QFN_DEV": 0.9,
    "BACKLIGHT_BIAS_POWER_DEV": 0.9,
    "HAPTIC_DRIVER_WLCSP_DEV": 0.55,
    "FUEL_GAUGE_WLCSP_DEV": 0.55,
}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def blocks(text: str) -> list[str]:
    records: list[str] = []
    for match in re.finditer(r'\n\s*\(footprint "e1-phone-dev:', text):
        start = match.start()
        depth = 0
        in_string = False
        escape = False
        for idx in range(start, len(text)):
            ch = text[idx]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    records.append(text[start : idx + 1])
                    break
    return records


def net_ids(text: str) -> dict[int, str]:
    return {int(num): name for num, name in re.findall(r'\(net\s+(\d+)\s+"([^"]+)"\)', text)}


def route_lookup() -> dict[tuple[str, tuple[float, float], tuple[float, float]], dict[str, object]]:
    if not ROUTED_INTAKE.is_file():
        return {}
    intake = yaml.safe_load(ROUTED_INTAKE.read_text(encoding="utf-8")) or {}
    lookup: dict[tuple[str, tuple[float, float], tuple[float, float]], dict[str, object]] = {}
    for route in intake.get("routes", []):
        if not isinstance(route, dict):
            continue
        points = route.get("points_mm", [])
        if not isinstance(points, list):
            continue
        net = str(route.get("net") or route.get("canonical_net") or "")
        for start, end in zip(points, points[1:], strict=False):
            if not isinstance(start, dict) or not isinstance(end, dict):
                continue
            a = (round(float(start["x"]), 3), round(float(start["y"]), 3))
            b = (round(float(end["x"]), 3), round(float(end["y"]), 3))
            lookup[(net, a, b)] = route
            lookup[(net, b, a)] = route
    return lookup


def footprint_size(name: str) -> tuple[float, float]:
    mod = (LIB / f"{name}.kicad_mod").read_text(encoding="utf-8")
    rects = re.findall(
        r'\(fp_rect \(start ([^)]+)\) \(end ([^)]+)\).*?\(layer "F\.CrtYd"\)',
        mod,
        flags=re.S,
    )
    if not rects:
        rects = re.findall(r"\(fp_rect \(start ([^)]+)\) \(end ([^)]+)\)", mod, flags=re.S)
    if not rects:
        return (1.0, 1.0)
    start, end = rects[-1]
    x1, y1 = (float(v) for v in start.split()[:2])
    x2, y2 = (float(v) for v in end.split()[:2])
    return (abs(x2 - x1), abs(y2 - y1))


def rotate_size(width: float, height: float, degrees: float) -> tuple[float, float]:
    theta = math.radians(degrees % 180)
    c = abs(math.cos(theta))
    s = abs(math.sin(theta))
    return (width * c + height * s, width * s + height * c)


class Point2D(TypedDict):
    x: float
    y: float


class PadPose(TypedDict):
    x: float
    y: float
    rotation: float


class Size2D(TypedDict):
    width: float
    height: float


class PadRecord(TypedDict):
    name: str
    type: str
    shape: str
    at_mm: PadPose
    size_mm: Size2D
    layers: str


class FootprintPose(TypedDict):
    x: float
    y: float
    rotation: float


class Envelope(TypedDict):
    width: float
    depth: float
    height: float


class FootprintRecord(TypedDict):
    reference: str
    footprint: str
    layer: str
    at_mm: FootprintPose
    envelope_mm: Envelope
    pad_count: int
    pads: list[PadRecord]


class SegmentRecord(TypedDict):
    start_mm: Point2D
    end_mm: Point2D
    width_mm: float
    layer: str
    net_id: int
    net: str
    route_id: str
    route_classes: list[str]
    source_domains: list[str]
    controlled_impedance_targets_ohm: list[float]


class ViaRecord(TypedDict):
    at_mm: Point2D
    size_mm: float
    drill_mm: float
    layers: list[str]
    net_id: int
    net: str


def parse_pads(
    block: str, footprint_x: float, footprint_y: float, footprint_rot: float
) -> list[PadRecord]:
    pads: list[PadRecord] = []
    pad_re = re.compile(
        r'\(pad "([^"]*)" ([^\s)]+) ([^\s)]+) \(at ([^)]+)\) \(size ([^)]+)\)[\s\S]*?\(layers ([^)]+)\)',
        re.S,
    )
    cos_r = math.cos(math.radians(footprint_rot))
    sin_r = math.sin(math.radians(footprint_rot))
    for match in pad_re.finditer(block):
        name, pad_type, shape, at_text, size_text, layer_text = match.groups()
        at_parts = [float(v) for v in at_text.split()]
        size_parts = [float(v) for v in size_text.split()]
        local_x = at_parts[0]
        local_y = at_parts[1]
        local_rot = at_parts[2] if len(at_parts) > 2 else 0.0
        x = footprint_x + local_x * cos_r - local_y * sin_r
        y = footprint_y + local_x * sin_r + local_y * cos_r
        pads.append(
            {
                "name": name,
                "type": pad_type,
                "shape": shape,
                "at_mm": {
                    "x": round(x, 3),
                    "y": round(y, 3),
                    "rotation": round((footprint_rot + local_rot) % 360, 3),
                },
                "size_mm": {"width": round(size_parts[0], 3), "height": round(size_parts[1], 3)},
                "layers": layer_text,
            }
        )
    return pads


def parse_footprints(text: str) -> list[FootprintRecord]:
    records: list[FootprintRecord] = []
    for block in blocks(text):
        header = re.search(r'\(footprint "e1-phone-dev:([^"]+)" \(layer "([^"]+)"\)', block)
        at = re.search(r"\(at ([^\)]+)\)", block)
        ref = re.search(r'\(fp_text reference "([^"]+)"', block)
        if not header or not at:
            continue
        name = header.group(1)
        layer = header.group(2)
        at_parts = [float(v) for v in at.group(1).split()]
        x = at_parts[0]
        y = at_parts[1]
        rot = at_parts[2] if len(at_parts) > 2 else 0.0
        width, depth = rotate_size(*footprint_size(name), rot)
        pads = parse_pads(block, x, y, rot)
        records.append(
            {
                "reference": ref.group(1) if ref else name,
                "footprint": name,
                "layer": layer,
                "at_mm": {"x": round(x, 3), "y": round(y, 3), "rotation": round(rot, 3)},
                "envelope_mm": {
                    "width": round(width, 3),
                    "depth": round(depth, 3),
                    "height": round(HEIGHTS_MM.get(name, 0.5), 3),
                },
                "pad_count": len(pads),
                "pads": pads,
            }
        )
    return records


def parse_segments(
    text: str,
    net_name_by_id: dict[int, str],
    routed_lookup: dict[tuple[str, tuple[float, float], tuple[float, float]], dict[str, object]],
) -> list[SegmentRecord]:
    segments: list[SegmentRecord] = []
    segment_re = re.compile(
        r'\(segment \(start ([^)]+)\) \(end ([^)]+)\) \(width ([^\s)]+)\) \(layer "([^"]+)"\) \(net (\d+)\)',
        re.S,
    )
    for match in segment_re.finditer(text):
        start_text, end_text, width, layer, net_id_text = match.groups()
        sx, sy = [float(v) for v in start_text.split()[:2]]
        ex, ey = [float(v) for v in end_text.split()[:2]]
        net_id = int(net_id_text)
        net_name = net_name_by_id.get(net_id, "")
        start = (round(sx, 3), round(sy, 3))
        end = (round(ex, 3), round(ey, 3))
        route = routed_lookup.get((net_name, start, end), {})
        route_id: str = str(route.get("id", ""))
        route_classes: list[str] = cast(list[str], route.get("route_classes", []))
        source_domains: list[str] = cast(list[str], route.get("source_domains", []))
        controlled_impedance_targets_ohm: list[float] = cast(
            list[float], route.get("controlled_impedance_targets_ohm", [])
        )
        segments.append(
            {
                "start_mm": {"x": round(sx, 3), "y": round(sy, 3)},
                "end_mm": {"x": round(ex, 3), "y": round(ey, 3)},
                "width_mm": round(float(width), 3),
                "layer": layer,
                "net_id": net_id,
                "net": net_name,
                "route_id": route_id,
                "route_classes": route_classes,
                "source_domains": source_domains,
                "controlled_impedance_targets_ohm": controlled_impedance_targets_ohm,
            }
        )
    return segments


def parse_vias(text: str, net_name_by_id: dict[int, str]) -> list[ViaRecord]:
    vias: list[ViaRecord] = []
    via_re = re.compile(
        r'\(via \(at ([^)]+)\) \(size ([^\s)]+)\) \(drill ([^\s)]+)\) \(layers "([^"]+)" "([^"]+)"\) \(net (\d+)\)',
        re.S,
    )
    for match in via_re.finditer(text):
        at_text, size, drill, layer_a, layer_b, net_id = match.groups()
        x, y = [float(v) for v in at_text.split()[:2]]
        vias.append(
            {
                "at_mm": {"x": round(x, 3), "y": round(y, 3)},
                "size_mm": round(float(size), 3),
                "drill_mm": round(float(drill), 3),
                "layers": [layer_a, layer_b],
                "net_id": int(net_id),
                "net": net_name_by_id.get(int(net_id), ""),
            }
        )
    return vias


def sexpr_blocks(text: str, head: str) -> list[str]:
    records: list[str] = []
    for match in re.finditer(rf"(?m)^\s*\({re.escape(head)}", text):
        start = match.start()
        depth = 0
        in_string = False
        escape = False
        for idx in range(start, len(text)):
            ch = text[idx]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0:
                    records.append(text[start : idx + 1])
                    break
    return records


def parse_zones(text: str, net_name_by_id: dict[int, str]) -> list[dict[str, object]]:
    zones: list[dict[str, object]] = []
    for index, block in enumerate(sexpr_blocks(text, "zone "), start=1):
        is_keepout = "(keepout " in block
        filled_polygon_count = block.count("(filled_polygon")
        if is_keepout or filled_polygon_count <= 0:
            continue
        points = [
            (float(x), float(y))
            for x, y in re.findall(r"\(xy\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)", block)
        ]
        if len(points) < 3:
            continue
        layers_match = re.search(r"\(layers\s+([^)]+)\)", block)
        layers = re.findall(r'"([^"]+)"', layers_match.group(1)) if layers_match else []
        net_match = re.search(r"\(net\s+(-?\d+)\)", block)
        net_id = int(net_match.group(1)) if net_match else -1
        net_name_match = re.search(r'\(net_name\s+"([^"]*)"\)', block)
        net_name = net_name_match.group(1) if net_name_match else net_name_by_id.get(net_id, "")
        name_match = re.search(r'\(name\s+"([^"]*)"\)', block)
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        zones.append(
            {
                "index": index,
                "name": name_match.group(1) if name_match else f"zone_{index:03d}",
                "net_id": net_id,
                "net": net_name,
                "layers": layers,
                "polygon_point_count": len(points),
                "filled_polygon_count": filled_polygon_count,
                "points_mm": [{"x": round(x, 3), "y": round(y, 3)} for x, y in points],
                "bbox_mm": {
                    "x_min": round(min(xs), 3),
                    "y_min": round(min(ys), 3),
                    "x_max": round(max(xs), 3),
                    "y_max": round(max(ys), 3),
                    "width": round(max(xs) - min(xs), 3),
                    "height": round(max(ys) - min(ys), 3),
                },
            }
        )
    return zones


def board_context() -> dict[str, object]:
    board_text = BOARD.read_text(encoding="utf-8")
    params = yaml.safe_load(PARAMS.read_text(encoding="utf-8"))
    net_name_by_id = net_ids(board_text)
    routed_lookup = route_lookup()
    return {
        "board_text": board_text,
        "params": params,
        "records": parse_footprints(board_text),
        "net_name_by_id": net_name_by_id,
        "segments": parse_segments(board_text, net_name_by_id, routed_lookup),
        "vias": parse_vias(board_text, net_name_by_id),
        "zones": parse_zones(board_text, net_name_by_id),
    }


def common_report(
    *,
    board_text: str,
    records: Sequence[FootprintRecord],
    segments: Sequence[SegmentRecord],
    vias: Sequence[ViaRecord],
    zones: Sequence[dict[str, object]],
    generator_backend: str,
) -> dict[str, object]:
    pad_count = sum(item["pad_count"] for item in records)
    routed_trace_bound_count = sum(1 for segment in segments if segment.get("route_id"))
    controlled_impedance_segment_count = sum(
        1 for segment in segments if segment.get("controlled_impedance_targets_ohm")
    )
    segment_net_names = sorted(
        {str(segment.get("net")) for segment in segments if segment.get("net")}
    )
    via_net_names = sorted({str(via.get("net")) for via in vias if via.get("net")})
    zone_net_names = sorted({str(zone.get("net")) for zone in zones if zone.get("net")})
    return {
        "schema": "eliza.e1_phone_real_footprint_development_step_intake.v1",
        "date": "2026-05-22",
        "status": "development_step_generated_not_release",
        "generator_backend": generator_backend,
        "claim_boundary": (
            "Generated non-release routed-board STEP from the real-footprint development "
            "KiCad board. It places development footprint envelopes, visible pad/contact "
            "solids, visible routed copper-segment solids, vias, and local filled copper "
            "zone sheets from KiCad coordinates. It is not a native KiCad production STEP, "
            "not supplier 3D-model complete, and not fabrication/enclosure release evidence."
        ),
        "source_board": str(BOARD.relative_to(ROOT)),
        "output_step": str(OUT_STEP.relative_to(ROOT)),
        "board_sha256": sha256(BOARD),
        "step_sha256": sha256(OUT_STEP),
        "board_island_count": 2,
        "footprint_envelope_count": len(records),
        "pad_contact_visual_count": pad_count,
        "segment_count": len(segments),
        "route_segment_visual_count": len(segments),
        "route_segment_net_name_count": len(segment_net_names),
        "route_segment_trace_bound_count": routed_trace_bound_count,
        "route_segment_trace_unbound_count": len(segments) - routed_trace_bound_count,
        "controlled_impedance_segment_visual_count": controlled_impedance_segment_count,
        "via_count": len(vias),
        "via_visual_count": len(vias),
        "via_net_name_count": len(via_net_names),
        "filled_copper_zone_visual_count": len(zones),
        "filled_copper_zone_polygon_count": sum(
            cast(int, zone.get("filled_polygon_count", 0) or 0) for zone in zones
        ),
        "filled_copper_zone_net_name_count": len(zone_net_names),
        "e1phone_footprint_refs": board_text.count('(footprint "E1Phone:'),
        "development_footprint_refs": board_text.count('(footprint "e1-phone-dev:'),
        "visual_detail": {
            "component_envelopes": len(records),
            "pad_contacts": pad_count,
            "route_segments": len(segments),
            "route_segments_with_net_names": len([item for item in segments if item.get("net")]),
            "route_segments_bound_to_routed_intake": routed_trace_bound_count,
            "controlled_impedance_route_segments": controlled_impedance_segment_count,
            "vias": len(vias),
            "vias_with_net_names": len([item for item in vias if item.get("net")]),
            "filled_copper_zones": len(zones),
            "filled_copper_zone_polygons": sum(
                int(cast(int, zone.get("filled_polygon_count", 0) or 0)) for zone in zones
            ),
            "copper_thickness_mm": 0.035,
        },
        "segment_net_names": segment_net_names,
        "via_net_names": via_net_names,
        "filled_copper_zone_net_names": zone_net_names,
        "footprints": records,
        "segments": segments,
        "vias": vias,
        "filled_copper_zones": zones,
        "release_blockers_preserved": [
            "STEP is generated from development footprint envelopes, not signed supplier 3D models",
            "native KiCad STEP export is unavailable in this environment",
            "production DRC/ERC/SI/PI/RF/factory evidence is absent",
            "enclosure clearance must be rerun with the production routed-board STEP",
        ],
    }


def write_manifest(report: dict[str, object]) -> None:
    MANIFEST.write_text(yaml.safe_dump(report, sort_keys=False))


def generate_with_ocp(context: dict[str, object]) -> dict[str, object]:
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopoDS import TopoDS_Compound

    board_text = str(context["board_text"])
    params = cast(dict[str, object], context["params"])
    records = cast(list[FootprintRecord], context["records"])
    segments = cast(list[SegmentRecord], context["segments"])
    vias = cast(list[ViaRecord], context["vias"])
    zones = cast(list[dict[str, object]], context["zones"])
    pcb = cast(dict[str, object], params["pcb"])
    board_w, board_h, board_t = cast(list[float], pcb["outline_mm"])
    top_w, top_h, _ = cast(list[float], pcb["top_island_outline_mm"])
    bot_w, bot_h, _ = cast(list[float], pcb["bottom_island_outline_mm"])
    top_y = cast(float, pcb["top_island_center_y_mm"])
    bot_y = cast(float, pcb["bottom_island_center_y_mm"])
    z_top = board_t / 2.0
    z_bot = -board_t / 2.0
    copper_thickness = 0.035

    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)

    def add_shape(shape: object) -> None:
        builder.Add(compound, shape)

    def add_box_center(cx: float, cy: float, cz: float, sx: float, sy: float, sz: float) -> None:
        sx = max(float(sx), 0.01)
        sy = max(float(sy), 0.01)
        sz = max(float(sz), 0.01)
        add_shape(
            BRepPrimAPI_MakeBox(
                gp_Pnt(cx - sx / 2.0, cy - sy / 2.0, cz - sz / 2.0),
                sx,
                sy,
                sz,
            ).Shape()
        )

    def transform_shape(shape: object, trsf: object) -> object:
        return BRepBuilderAPI_Transform(shape, trsf, True).Shape()

    def add_rotated_box(
        cx: float,
        cy: float,
        cz: float,
        sx: float,
        sy: float,
        sz: float,
        angle_degrees: float,
    ) -> None:
        shape = BRepPrimAPI_MakeBox(gp_Pnt(-sx / 2.0, -sy / 2.0, -sz / 2.0), sx, sy, sz).Shape()
        rotate = gp_Trsf()
        rotate.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(angle_degrees))
        move = gp_Trsf()
        move.SetTranslation(gp_Vec(cx, cy, cz))
        shape = transform_shape(shape, rotate)
        shape = transform_shape(shape, move)
        add_shape(shape)

    add_box_center(0, top_y, 0, top_w, top_h, board_t)
    add_box_center(0, bot_y, 0, bot_w, bot_h, board_t)

    for item in records:
        env = item["envelope_mm"]
        x = float(item["at_mm"]["x"]) - board_w / 2.0
        y = board_h / 2.0 - float(item["at_mm"]["y"])
        h = max(float(env["height"]), 0.02)
        z = (
            z_top + copper_thickness + h / 2.0
            if item["layer"] == "F.Cu"
            else z_bot - copper_thickness - h / 2.0
        )
        add_box_center(x, y, z, float(env["width"]), float(env["depth"]), h)
        for pad in item["pads"]:
            pad_x = float(pad["at_mm"]["x"]) - board_w / 2.0
            pad_y = board_h / 2.0 - float(pad["at_mm"]["y"])
            pad_z = (
                z_top + copper_thickness / 2.0
                if "F.Cu" in str(pad["layers"])
                else z_bot - copper_thickness / 2.0
            )
            add_rotated_box(
                pad_x,
                pad_y,
                pad_z,
                max(float(pad["size_mm"]["width"]), 0.035),
                max(float(pad["size_mm"]["height"]), 0.035),
                copper_thickness,
                -float(pad["at_mm"]["rotation"]),
            )

    for segment in segments:
        sx = float(segment["start_mm"]["x"])
        sy = float(segment["start_mm"]["y"])
        ex = float(segment["end_mm"]["x"])
        ey = float(segment["end_mm"]["y"])
        dx = ex - sx
        dy = ey - sy
        length = math.hypot(dx, dy)
        if length <= 0.001:
            continue
        mid_x = (sx + ex) / 2.0 - board_w / 2.0
        mid_y = board_h / 2.0 - (sy + ey) / 2.0
        angle = -math.degrees(math.atan2(dy, dx))
        route_z = (
            z_top + copper_thickness * 1.7
            if segment["layer"] == "F.Cu"
            else z_bot - copper_thickness * 1.7
        )
        add_rotated_box(
            mid_x,
            mid_y,
            route_z,
            length,
            max(float(segment["width_mm"]), 0.035),
            copper_thickness,
            angle,
        )

    for via in vias:
        x = float(via["at_mm"]["x"]) - board_w / 2.0
        y = board_h / 2.0 - float(via["at_mm"]["y"])
        radius = max(float(via["size_mm"]) / 2.0, 0.05)
        height = board_t + copper_thickness * 2.0
        shape = BRepPrimAPI_MakeCylinder(radius, height).Shape()
        move = gp_Trsf()
        move.SetTranslation(gp_Vec(x, y, -height / 2.0))
        add_shape(transform_shape(shape, move))

    for zone in zones:
        bbox = cast(dict[str, float], zone["bbox_mm"])
        x = bbox["x_min"] + bbox["width"] / 2.0 - board_w / 2.0
        y = board_h / 2.0 - (bbox["y_min"] + bbox["height"] / 2.0)
        layers = cast(list[str], zone.get("layers", []))
        visual_layers = [
            layer for layer in layers if layer in {"F.Cu", "B.Cu", "In1.GND", "In8.GND"}
        ]
        for layer in visual_layers or ["F.Cu"]:
            if layer == "F.Cu":
                z = z_top + copper_thickness * 2.4
            elif layer == "B.Cu":
                z = z_bot - copper_thickness * 2.4
            elif layer == "In1.GND":
                z = board_t * 0.25
            else:
                z = -board_t * 0.25
            add_box_center(x, y, z, bbox["width"], bbox["height"], copper_thickness)

    OUT_STEP.parent.mkdir(parents=True, exist_ok=True)
    writer = STEPControl_Writer()
    writer.Transfer(compound, STEPControl_AsIs)
    status = writer.Write(str(OUT_STEP))
    if status != IFSelect_RetDone:
        raise RuntimeError(f"OCP STEP write failed: {status}")

    report = common_report(
        board_text=board_text,
        records=records,
        segments=segments,
        vias=vias,
        zones=zones,
        generator_backend="ocp",
    )
    write_manifest(report)
    return report


def generate_with_cadquery(context: dict[str, object]) -> dict[str, object]:
    import cadquery as cq

    board_text = str(context["board_text"])
    params = cast(dict[str, object], context["params"])
    records = cast(list[FootprintRecord], context["records"])
    segments = cast(list[SegmentRecord], context["segments"])
    vias = cast(list[ViaRecord], context["vias"])
    zones = cast(list[dict[str, object]], context["zones"])

    pcb = cast(dict[str, object], params["pcb"])
    board_w, board_h, board_t = cast(list[float], pcb["outline_mm"])
    top_w, top_h, _ = cast(list[float], pcb["top_island_outline_mm"])
    bot_w, bot_h, _ = cast(list[float], pcb["bottom_island_outline_mm"])
    top_y = cast(float, pcb["top_island_center_y_mm"])
    bot_y = cast(float, pcb["bottom_island_center_y_mm"])
    z_top = board_t / 2.0
    z_bot = -board_t / 2.0

    assembly = cq.Assembly(name="e1_phone_real_footprint_development_board")
    board_color = cq.Color(0.05, 0.28, 0.12, 1.0)
    assembly.add(
        cq.Workplane("XY").box(top_w, top_h, board_t).translate((0, top_y, 0)),
        name="pcb_top_island",
        color=board_color,
    )
    assembly.add(
        cq.Workplane("XY").box(bot_w, bot_h, board_t).translate((0, bot_y, 0)),
        name="pcb_bottom_island",
        color=board_color,
    )

    comp_color = cq.Color(0.02, 0.02, 0.018, 1.0)
    pad_color = cq.Color(0.95, 0.76, 0.28, 1.0)
    route_color = cq.Color(0.80, 0.45, 0.18, 1.0)
    zone_color = cq.Color(0.52, 0.30, 0.12, 0.55)
    metal_color = cq.Color(0.78, 0.72, 0.55, 1.0)
    copper_thickness = 0.035
    for idx, item in enumerate(records, start=1):
        env = item["envelope_mm"]
        x = float(item["at_mm"]["x"]) - board_w / 2.0
        y = board_h / 2.0 - float(item["at_mm"]["y"])
        h = max(float(env["height"]), 0.02)
        z = (
            z_top + copper_thickness + h / 2.0
            if item["layer"] == "F.Cu"
            else z_bot - copper_thickness - h / 2.0
        )
        color = (
            metal_color
            if item["footprint"]
            in {"TESTPOINT_1MM_DEV", "FIDUCIAL_1MM_DEV", "MOUNTING_HOLE_1P2_DEV"}
            else comp_color
        )
        shape = (
            cq.Workplane("XY")
            .box(max(float(env["width"]), 0.05), max(float(env["depth"]), 0.05), h)
            .translate((x, y, z))
        )
        assembly.add(shape, name=f"{idx:02d}_{item['reference']}_{item['footprint']}", color=color)
        for pad_idx, pad in enumerate(item["pads"], start=1):
            pad_x = float(pad["at_mm"]["x"]) - board_w / 2.0
            pad_y = board_h / 2.0 - float(pad["at_mm"]["y"])
            pad_z = (
                z_top + copper_thickness / 2.0
                if "F.Cu" in str(pad["layers"])
                else z_bot - copper_thickness / 2.0
            )
            pad_w = max(float(pad["size_mm"]["width"]), 0.035)
            pad_h = max(float(pad["size_mm"]["height"]), 0.035)
            pad_rot = -float(pad["at_mm"]["rotation"])
            if pad["shape"] == "circle":
                pad_shape = (
                    cq.Workplane("XY").circle(max(pad_w, pad_h) / 2.0).extrude(copper_thickness)
                )
                pad_shape = pad_shape.translate((pad_x, pad_y, pad_z - copper_thickness / 2.0))
            else:
                pad_shape = (
                    cq.Workplane("XY")
                    .box(pad_w, pad_h, copper_thickness)
                    .rotate((0, 0, 0), (0, 0, 1), pad_rot)
                    .translate((pad_x, pad_y, pad_z))
                )
            assembly.add(
                pad_shape,
                name=f"{idx:02d}_{item['reference']}_pad_{pad_idx:03d}_{str(pad['name']) or 'mech'}",
                color=pad_color,
            )

    for seg_idx, segment in enumerate(segments, start=1):
        sx = float(segment["start_mm"]["x"])
        sy = float(segment["start_mm"]["y"])
        ex = float(segment["end_mm"]["x"])
        ey = float(segment["end_mm"]["y"])
        dx = ex - sx
        dy = ey - sy
        length = math.hypot(dx, dy)
        if length <= 0.001:
            continue
        mid_x = (sx + ex) / 2.0 - board_w / 2.0
        mid_y = board_h / 2.0 - (sy + ey) / 2.0
        angle = -math.degrees(math.atan2(dy, dx))
        width = max(float(segment["width_mm"]), 0.035)
        route_z = (
            z_top + copper_thickness * 1.7
            if segment["layer"] == "F.Cu"
            else z_bot - copper_thickness * 1.7
        )
        route_shape = (
            cq.Workplane("XY")
            .box(length, width, copper_thickness)
            .rotate((0, 0, 0), (0, 0, 1), angle)
            .translate((mid_x, mid_y, route_z))
        )
        route_name = re.sub(
            r"[^A-Za-z0-9_]+",
            "_",
            f"route_{seg_idx:03d}_{segment.get('net') or 'net'}_{segment['layer']}",
        )
        assembly.add(route_shape, name=route_name, color=route_color)

    for via_idx, via in enumerate(vias, start=1):
        x = float(via["at_mm"]["x"]) - board_w / 2.0
        y = board_h / 2.0 - float(via["at_mm"]["y"])
        radius = max(float(via["size_mm"]) / 2.0, 0.05)
        drill_radius = max(float(via["drill_mm"]) / 2.0, 0.02)
        barrel = (
            cq.Workplane("XY")
            .circle(radius)
            .circle(drill_radius)
            .extrude(board_t + copper_thickness * 2.0)
            .translate((x, y, -board_t / 2.0 - copper_thickness))
        )
        via_name = re.sub(
            r"[^A-Za-z0-9_]+",
            "_",
            f"via_{via_idx:03d}_{via.get('net') or ('net_' + str(via['net_id']))}",
        )
        assembly.add(barrel, name=via_name, color=pad_color)

    for zone_idx, zone in enumerate(zones, start=1):
        bbox = cast(dict[str, float], zone["bbox_mm"])
        x = bbox["x_min"] + bbox["width"] / 2.0 - board_w / 2.0
        y = board_h / 2.0 - (bbox["y_min"] + bbox["height"] / 2.0)
        layers = cast(list[str], zone.get("layers", []))
        visual_layers = [
            layer for layer in layers if layer in {"F.Cu", "B.Cu", "In1.GND", "In8.GND"}
        ]
        for layer in visual_layers or ["F.Cu"]:
            if layer == "F.Cu":
                z = z_top + copper_thickness * 2.4
            elif layer == "B.Cu":
                z = z_bot - copper_thickness * 2.4
            elif layer == "In1.GND":
                z = board_t * 0.25
            else:
                z = -board_t * 0.25
            zone_shape = (
                cq.Workplane("XY")
                .box(
                    max(bbox["width"], 0.05),
                    max(bbox["height"], 0.05),
                    copper_thickness,
                )
                .translate((x, y, z))
            )
            zone_name = re.sub(
                r"[^A-Za-z0-9_]+",
                "_",
                f"zone_{zone_idx:03d}_{zone.get('net') or 'net'}_{layer}",
            )
            assembly.add(zone_shape, name=zone_name, color=zone_color)

    OUT_STEP.parent.mkdir(parents=True, exist_ok=True)
    assembly.save(str(OUT_STEP))
    report = common_report(
        board_text=board_text,
        records=records,
        segments=segments,
        vias=vias,
        zones=zones,
        generator_backend="cadquery",
    )
    write_manifest(report)
    return report


def main() -> int:
    context = board_context()
    try:
        report = generate_with_cadquery(context)
    except ModuleNotFoundError as exc:
        if exc.name != "cadquery":
            raise
        report = generate_with_ocp(context)
    print(f"wrote {OUT_STEP.relative_to(ROOT)}")
    print(
        f"footprint_envelopes={report['footprint_envelope_count']} "
        f"segments={report['segment_count']} zones={report['filled_copper_zone_visual_count']} "
        f"backend={report['generator_backend']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
