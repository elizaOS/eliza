#!/usr/bin/env python3
"""Generate a non-release STEP assembly from the real-footprint dev board."""

from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
BOARD = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
LIB = ROOT / "board/kicad/e1-phone/e1-phone-dev.pretty"
PARAMS = ROOT / "mechanical/e1-phone/cad/e1_phone_params.yaml"
OUT_STEP = ROOT / "board/kicad/e1-phone/pcb/fab-demo/e1-phone-mainboard-real-footprint-development.step"
MANIFEST = ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"

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


def footprint_size(name: str) -> tuple[float, float]:
    mod = (LIB / f"{name}.kicad_mod").read_text(encoding="utf-8")
    rects = re.findall(
        r'\(fp_rect \(start ([^)]+)\) \(end ([^)]+)\).*?\(layer "F\.CrtYd"\)',
        mod,
        flags=re.S,
    )
    if not rects:
        rects = re.findall(r'\(fp_rect \(start ([^)]+)\) \(end ([^)]+)\)', mod, flags=re.S)
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


def parse_pads(block: str, footprint_x: float, footprint_y: float, footprint_rot: float) -> list[dict[str, object]]:
    pads: list[dict[str, object]] = []
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


def parse_footprints(text: str) -> list[dict[str, object]]:
    records = []
    for block in blocks(text):
        header = re.search(r'\(footprint "e1-phone-dev:([^"]+)" \(layer "([^"]+)"\)', block)
        at = re.search(r'\(at ([^\)]+)\)', block)
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


def parse_segments(text: str) -> list[dict[str, object]]:
    segments: list[dict[str, object]] = []
    segment_re = re.compile(
        r'\(segment \(start ([^)]+)\) \(end ([^)]+)\) \(width ([^\s)]+)\) \(layer "([^"]+)"\)',
        re.S,
    )
    for match in segment_re.finditer(text):
        start_text, end_text, width, layer = match.groups()
        sx, sy = [float(v) for v in start_text.split()[:2]]
        ex, ey = [float(v) for v in end_text.split()[:2]]
        segments.append(
            {
                "start_mm": {"x": round(sx, 3), "y": round(sy, 3)},
                "end_mm": {"x": round(ex, 3), "y": round(ey, 3)},
                "width_mm": round(float(width), 3),
                "layer": layer,
            }
        )
    return segments


def parse_vias(text: str) -> list[dict[str, object]]:
    vias: list[dict[str, object]] = []
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
            }
        )
    return vias


def main() -> int:
    import cadquery as cq

    board_text = BOARD.read_text(encoding="utf-8")
    params = yaml.safe_load(PARAMS.read_text(encoding="utf-8"))
    pcb = params["pcb"]
    board_w, board_h, board_t = [float(v) for v in pcb["outline_mm"]]
    top_w, top_h, _ = [float(v) for v in pcb["top_island_outline_mm"]]
    bot_w, bot_h, _ = [float(v) for v in pcb["bottom_island_outline_mm"]]
    top_y = float(pcb["top_island_center_y_mm"])
    bot_y = float(pcb["bottom_island_center_y_mm"])
    z_top = board_t / 2.0
    z_bot = -board_t / 2.0

    assembly = cq.Assembly(name="e1_phone_real_footprint_development_board")
    board_color = cq.Color(0.05, 0.28, 0.12, 1.0)
    assembly.add(cq.Workplane("XY").box(top_w, top_h, board_t).translate((0, top_y, 0)), name="pcb_top_island", color=board_color)
    assembly.add(cq.Workplane("XY").box(bot_w, bot_h, board_t).translate((0, bot_y, 0)), name="pcb_bottom_island", color=board_color)

    records = parse_footprints(board_text)
    segments = parse_segments(board_text)
    vias = parse_vias(board_text)
    comp_color = cq.Color(0.02, 0.02, 0.018, 1.0)
    pad_color = cq.Color(0.95, 0.76, 0.28, 1.0)
    route_color = cq.Color(0.80, 0.45, 0.18, 1.0)
    metal_color = cq.Color(0.78, 0.72, 0.55, 1.0)
    copper_thickness = 0.035
    for idx, item in enumerate(records, start=1):
        env = item["envelope_mm"]
        x = float(item["at_mm"]["x"]) - board_w / 2.0
        y = board_h / 2.0 - float(item["at_mm"]["y"])
        h = max(float(env["height"]), 0.02)
        z = z_top + copper_thickness + h / 2.0 if item["layer"] == "F.Cu" else z_bot - copper_thickness - h / 2.0
        color = metal_color if item["footprint"] in {"TESTPOINT_1MM_DEV", "FIDUCIAL_1MM_DEV", "MOUNTING_HOLE_1P2_DEV"} else comp_color
        shape = cq.Workplane("XY").box(max(float(env["width"]), 0.05), max(float(env["depth"]), 0.05), h).translate((x, y, z))
        assembly.add(shape, name=f"{idx:02d}_{item['reference']}_{item['footprint']}", color=color)
        for pad_idx, pad in enumerate(item["pads"], start=1):
            pad_x = float(pad["at_mm"]["x"]) - board_w / 2.0
            pad_y = board_h / 2.0 - float(pad["at_mm"]["y"])
            pad_z = z_top + copper_thickness / 2.0 if "F.Cu" in str(pad["layers"]) else z_bot - copper_thickness / 2.0
            pad_w = max(float(pad["size_mm"]["width"]), 0.035)
            pad_h = max(float(pad["size_mm"]["height"]), 0.035)
            pad_rot = -float(pad["at_mm"]["rotation"])
            if pad["shape"] == "circle":
                pad_shape = cq.Workplane("XY").circle(max(pad_w, pad_h) / 2.0).extrude(copper_thickness)
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
        route_z = z_top + copper_thickness * 1.7 if segment["layer"] == "F.Cu" else z_bot - copper_thickness * 1.7
        route_shape = (
            cq.Workplane("XY")
            .box(length, width, copper_thickness)
            .rotate((0, 0, 0), (0, 0, 1), angle)
            .translate((mid_x, mid_y, route_z))
        )
        assembly.add(route_shape, name=f"route_{seg_idx:03d}_{segment['layer']}", color=route_color)

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
        assembly.add(barrel, name=f"via_{via_idx:03d}_net_{via['net_id']}", color=pad_color)

    OUT_STEP.parent.mkdir(parents=True, exist_ok=True)
    assembly.save(str(OUT_STEP))
    pad_count = sum(int(item["pad_count"]) for item in records)
    report = {
        "schema": "eliza.e1_phone_real_footprint_development_step_intake.v1",
        "date": "2026-05-22",
        "status": "development_step_generated_not_release",
        "claim_boundary": (
            "CadQuery-generated non-release routed-board STEP from the real-footprint "
            "development KiCad board. It places development footprint envelopes, visible "
            "pad/contact solids, and visible routed copper-segment solids from KiCad "
            "coordinates. It is not a native KiCad production STEP, not supplier 3D-model "
            "complete, and not fabrication/enclosure release evidence."
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
        "via_count": len(vias),
        "via_visual_count": len(vias),
        "e1phone_footprint_refs": board_text.count('(footprint "E1Phone:'),
        "development_footprint_refs": board_text.count('(footprint "e1-phone-dev:'),
        "visual_detail": {
            "component_envelopes": len(records),
            "pad_contacts": pad_count,
            "route_segments": len(segments),
            "vias": len(vias),
            "copper_thickness_mm": copper_thickness,
        },
        "footprints": records,
        "segments": segments,
        "vias": vias,
        "release_blockers_preserved": [
            "STEP is generated from development footprint envelopes, not signed supplier 3D models",
            "native KiCad STEP export is unavailable in this environment",
            "production DRC/ERC/SI/PI/RF/factory evidence is absent",
            "enclosure clearance must be rerun with the production routed-board STEP",
        ],
    }
    MANIFEST.write_text(yaml.safe_dump(report, sort_keys=False))
    print(f"wrote {OUT_STEP.relative_to(ROOT)}")
    print(f"footprint_envelopes={len(records)} segments={report['segment_count']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
