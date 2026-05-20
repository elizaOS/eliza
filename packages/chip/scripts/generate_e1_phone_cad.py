#!/usr/bin/env python3
"""Generate reviewable E1 phone mechanical CAD concept artifacts.

This is an EVT0 mechanical concept generator, not a tooling-release CAD
substitute. It creates deterministic mesh artifacts, rendered review views,
and analytic fit checks from one YAML parameter file so the enclosure can be
iterated against the KiCad phone-mainboard concept.
"""

from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import matplotlib
import numpy as np
import trimesh
import yaml
from matplotlib import pyplot as plt
from matplotlib.patches import FancyBboxPatch
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

matplotlib.use("Agg")

ROOT = Path(__file__).resolve().parents[1]
CAD_DIR = ROOT / "mechanical/e1-phone/cad"
OUT_DIR = ROOT / "mechanical/e1-phone/out"
REVIEW_DIR = ROOT / "mechanical/e1-phone/review"
PARAMS = CAD_DIR / "e1_phone_params.yaml"

ORANGE = [1.0, 0.32, 0.02, 1.0]
BLACK_GLASS = [0.015, 0.018, 0.02, 0.72]
DARK = [0.06, 0.065, 0.07, 1.0]
PCB_GREEN = [0.03, 0.38, 0.22, 1.0]
METAL = [0.72, 0.74, 0.76, 1.0]
CAMERA = [0.02, 0.02, 0.025, 1.0]
ADHESIVE = [0.02, 0.02, 0.02, 0.55]
TOOLING = [0.16, 0.35, 0.95, 0.38]


@dataclass(frozen=True)
class Part:
    name: str
    mesh: trimesh.Trimesh
    color: list[float]
    role: str
    material: str

    @property
    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        return self.mesh.bounds[0], self.mesh.bounds[1]


def box(name: str, size: list[float], center: list[float], color: list[float], role: str, material: str) -> Part:
    mesh = trimesh.creation.box(extents=size)
    mesh.apply_translation(center)
    mesh.visual.face_colors = np.asarray(color) * 255
    return Part(name, mesh, color, role, material)


def rounded_rect_points(width: float, height: float, radius: float, segments: int = 12) -> np.ndarray:
    radius = min(radius, width / 2.0, height / 2.0)
    centers = [
        (width / 2.0 - radius, height / 2.0 - radius, 0.0, math.pi / 2.0),
        (-width / 2.0 + radius, height / 2.0 - radius, math.pi / 2.0, math.pi),
        (-width / 2.0 + radius, -height / 2.0 + radius, math.pi, 3.0 * math.pi / 2.0),
        (width / 2.0 - radius, -height / 2.0 + radius, 3.0 * math.pi / 2.0, 2.0 * math.pi),
    ]
    points: list[tuple[float, float]] = []
    for cx, cy, start, stop in centers:
        for angle in np.linspace(start, stop, segments, endpoint=False):
            points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return np.asarray(points)


def rounded_prism_mesh(width: float, height: float, depth: float, radius: float) -> trimesh.Trimesh:
    points = rounded_rect_points(width, height, radius)
    half = depth / 2.0
    bottom = np.column_stack([points, np.full(len(points), -half)])
    top = np.column_stack([points, np.full(len(points), half)])
    vertices = np.vstack([bottom, top])
    center_bottom = len(vertices)
    center_top = center_bottom + 1
    vertices = np.vstack([vertices, [0.0, 0.0, -half], [0.0, 0.0, half]])
    faces: list[list[int]] = []
    n = len(points)
    for idx in range(n):
        nxt = (idx + 1) % n
        faces.append([idx, nxt, n + nxt])
        faces.append([idx, n + nxt, n + idx])
        faces.append([center_bottom, nxt, idx])
        faces.append([center_top, n + idx, n + nxt])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def rounded_box(
    name: str,
    size: list[float],
    center: list[float],
    radius: float,
    color: list[float],
    role: str,
    material: str,
) -> Part:
    mesh = rounded_prism_mesh(size[0], size[1], size[2], radius)
    mesh.apply_translation(center)
    mesh.visual.face_colors = np.asarray(color) * 255
    return Part(name, mesh, color, role, material)


def rounded_frame(
    name: str,
    outer_size: list[float],
    center: list[float],
    wall: float,
    radius: float,
    color: list[float],
    role: str,
    material: str,
) -> Part:
    outer = rounded_rect_points(outer_size[0], outer_size[1], radius)
    inner = rounded_rect_points(
        outer_size[0] - 2.0 * wall,
        outer_size[1] - 2.0 * wall,
        max(radius - wall, 0.1),
    )
    half = outer_size[2] / 2.0
    n = len(outer)
    outer_bottom = np.column_stack([outer, np.full(n, -half)])
    outer_top = np.column_stack([outer, np.full(n, half)])
    inner_bottom = np.column_stack([inner, np.full(n, -half)])
    inner_top = np.column_stack([inner, np.full(n, half)])
    vertices = np.vstack([outer_bottom, outer_top, inner_bottom, inner_top])
    faces: list[list[int]] = []
    ob = 0
    ot = n
    ib = n * 2
    it = n * 3
    for idx in range(n):
        nxt = (idx + 1) % n
        faces.append([ob + idx, ob + nxt, ot + nxt])
        faces.append([ob + idx, ot + nxt, ot + idx])
        faces.append([ib + nxt, ib + idx, it + idx])
        faces.append([ib + nxt, it + idx, it + nxt])
        faces.append([ot + idx, ot + nxt, it + nxt])
        faces.append([ot + idx, it + nxt, it + idx])
        faces.append([ob + nxt, ob + idx, ib + idx])
        faces.append([ob + nxt, ib + idx, ib + nxt])
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.apply_translation(center)
    mesh.visual.face_colors = np.asarray(color) * 255
    return Part(name, mesh, color, role, material)


def composite_box_part(
    name: str,
    boxes: list[tuple[list[float], list[float]]],
    color: list[float],
    role: str,
    material: str,
) -> Part:
    meshes = []
    for size, center in boxes:
        mesh = trimesh.creation.box(extents=size)
        mesh.apply_translation(center)
        meshes.append(mesh)
    combined = trimesh.util.concatenate(meshes)
    combined.visual.face_colors = np.asarray(color) * 255
    return Part(name, combined, color, role, material)


def cyl(
    name: str,
    radius: float,
    depth: float,
    center: list[float],
    color: list[float],
    role: str,
    material: str,
    sections: int = 48,
) -> Part:
    mesh = trimesh.creation.cylinder(radius=radius, height=depth, sections=sections)
    mesh.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2.0, [1, 0, 0]))
    mesh.apply_translation(center)
    mesh.visual.face_colors = np.asarray(color) * 255
    return Part(name, mesh, color, role, material)


def cyl_z(
    name: str,
    radius: float,
    depth: float,
    center: list[float],
    color: list[float],
    role: str,
    material: str,
    sections: int = 48,
) -> Part:
    mesh = trimesh.creation.cylinder(radius=radius, height=depth, sections=sections)
    mesh.apply_translation(center)
    mesh.visual.face_colors = np.asarray(color) * 255
    return Part(name, mesh, color, role, material)


def load_params() -> dict[str, Any]:
    return yaml.safe_load(PARAMS.read_text())


def kicad_outline_mm(path: Path) -> list[float] | None:
    if not path.is_file():
        return None
    text = path.read_text(errors="ignore")
    match = re.search(
        r'\(gr_rect\s+\(start\s+([0-9.]+)\s+([0-9.]+)\)\s+'
        r'\(end\s+([0-9.]+)\s+([0-9.]+)\).*?\(layer\s+"Edge\.Cuts"\)',
        text,
        flags=re.DOTALL,
    )
    if not match:
        return None
    x1, y1, x2, y2 = [float(group) for group in match.groups()]
    return [abs(x2 - x1), abs(y2 - y1)]


def adhesive_gasket_parts(params: dict[str, Any]) -> list[Part]:
    disp = params["display"]
    glass_w, glass_h, _ = disp["cover_glass_mm"]
    width = disp["adhesive_width_mm"]
    thickness = disp["adhesive_thickness_mm"]
    z = params["device"]["envelope_mm"][2] / 2.0 - 0.85
    return [
        box("screen_adhesive_top", [glass_w, width, thickness], [0, glass_h / 2 - width / 2, z], ADHESIVE, "screen retention", "die-cut display adhesive"),
        box("screen_adhesive_bottom", [glass_w, width, thickness], [0, -glass_h / 2 + width / 2, z], ADHESIVE, "screen retention", "die-cut display adhesive"),
        box("screen_adhesive_left", [width, glass_h, thickness], [-glass_w / 2 + width / 2, 0, z], ADHESIVE, "screen retention", "die-cut display adhesive"),
        box("screen_adhesive_right", [width, glass_h, thickness], [glass_w / 2 - width / 2, 0, z], ADHESIVE, "screen retention", "die-cut display adhesive"),
    ]


def enclosure_feature_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    mfg = params["manufacturing"]
    boss_radius = mfg["screw_boss_outer_diameter_mm"] / 2.0
    boss_z = -depth / 2 + 2.0
    boss_points = [
        (-29.0, 58.0),
        (29.0, 58.0),
        (-29.0, -58.0),
        (29.0, -58.0),
        (-29.0, -20.0),
        (29.0, -20.0),
    ]
    snap_points = [
        (-width / 2 + 1.9, 52.0),
        (-width / 2 + 1.9, 24.0),
        (-width / 2 + 1.9, -24.0),
        (-width / 2 + 1.9, -52.0),
        (width / 2 - 1.9, 52.0),
        (width / 2 - 1.9, 24.0),
        (width / 2 - 1.9, -24.0),
        (width / 2 - 1.9, -52.0),
    ]
    parts: list[Part] = []
    for idx, (x, y) in enumerate(boss_points, start=1):
        parts.append(
            cyl_z(
                f"orange_screw_boss_{idx}",
                boss_radius,
                2.8,
                [x, y, boss_z],
                ORANGE,
                "molded enclosure",
                "PC+ABS screw boss, core pin required",
                sections=32,
            )
        )
    for idx, (x, y) in enumerate(snap_points, start=1):
        parts.append(box(f"orange_snap_hook_{idx}", [1.3, 5.0, 1.4], [x, y, -1.0], ORANGE, "molded enclosure", "PC+ABS snap hook"))
    rib_t = mfg["rib_thickness_mm"]
    parts.extend(
        [
            box("orange_battery_left_rib", [rib_t, 98.0, 1.4], [-29.0, -7.0, -3.0], ORANGE, "molded enclosure", "battery locating rib"),
            box("orange_battery_right_rib", [rib_t, 98.0, 1.4], [29.0, -7.0, -3.0], ORANGE, "molded enclosure", "battery locating rib"),
            box("orange_usb_reinforcement_saddle", [18.0, 2.0, 2.0], [0.0, -height / 2 + 8.4, -2.9], ORANGE, "molded enclosure", "USB-C insertion load saddle"),
            box("display_fpc_connector", params["display"]["fpc_connector_mm"], [23.0, 55.0, -1.0], METAL, "connector", "board-mounted display/touch FPC connector"),
            box("display_fpc_bend_keepout", [22.0, 10.0, 0.3], [23.0, 61.5, 0.3], [0.5, 0.5, 0.1, 0.45], "connector", "display FPC bend keepout"),
            box("bottom_speaker_acoustic_chamber", [18.0, 13.0, 2.2], [18.5, -height / 2 + 13.0, -4.1], ORANGE, "audio", "molded loudspeaker rear chamber"),
            box("earpiece_gasket", [14.5, 2.0, 0.55], [0, height / 2 - 7.6, 3.8], ADHESIVE, "audio", "compressed earpiece acoustic gasket"),
        ]
    )
    return parts


def advanced_phone_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    comp = params["components"]
    radio = params.get("radio", {})
    cellular_keepout = radio.get("cellular", {}).get("antenna_keepout_mm", [62.0, 6.0, 2.0])
    wifi_keepout = radio.get("wifi_bt", {}).get("antenna_keepout_mm", [34.0, 5.0, 2.0])
    z_inner = -1.1
    z_back = -depth / 2 - 0.08
    parts = [
        box(
            "cellular_top_antenna_keepout",
            cellular_keepout,
            [0.0, height / 2 - 5.4, z_inner],
            [0.12, 0.12, 0.12, 0.35],
            "RF keepout",
            "top plastic antenna keepout volume",
        ),
        box(
            "cellular_bottom_antenna_keepout",
            cellular_keepout,
            [0.0, -height / 2 + 5.4, z_inner],
            [0.12, 0.12, 0.12, 0.35],
            "RF keepout",
            "bottom plastic antenna keepout volume",
        ),
        box(
            "wifi_bt_side_antenna_keepout",
            wifi_keepout,
            [width / 2 - 18.0, 43.0, z_inner],
            [0.12, 0.12, 0.12, 0.35],
            "RF keepout",
            "side Wi-Fi/Bluetooth antenna keepout volume",
        ),
        box("soc_shield_can", [18.0, 16.0, 1.2], [-7.0, 55.0, -0.9], METAL, "EMI shield", "stamped RF/SoC shield can"),
        box("pmic_shield_can", [11.0, 10.0, 1.1], [12.5, 55.0, -0.95], METAL, "EMI shield", "stamped PMIC shield can"),
        box("radio_shield_can", [18.0, 20.0, 1.2], [-22.0, 50.0, -0.9], METAL, "EMI shield", "stamped radio shield can"),
        box("haptic_lra", comp["haptic"]["envelope_mm"], [-18.0, -48.0, -2.9], DARK, "haptics", "0820 X-axis linear resonant actuator"),
        box("sim_tray_keepout", comp["sim_tray"]["keepout_mm"], [width / 2 - 7.2, -28.0, -0.8], [0.05, 0.05, 0.05, 0.45], "service", "side SIM tray keepout"),
        box("sim_tray_outline", comp["sim_tray"]["envelope_mm"], [width / 2 + 0.1, -28.0, -0.8], ORANGE, "service", "orange side service tray outline"),
        box("rear_camera_cover_glass", comp["rear_camera_glass"]["envelope_mm"], [21.0, height / 2 - 19.0, z_back], BLACK_GLASS, "camera", "rear camera cover glass"),
        box("service_label_recess", [32.0, 9.0, 0.25], [0.0, -height / 2 + 25.0, z_back], [0.9, 0.9, 0.9, 0.5], "service", "recessed regulatory/service label pad"),
    ]
    return parts


def tooling_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    mfg = params["manufacturing"]
    z = -depth / 2 - 5.0
    runner_d = mfg["runner_diameter_mm"]
    sprue_d = mfg["sprue_diameter_mm"]
    gate_t = mfg["gate_thickness_mm"]
    boss_z = -depth / 2 + 2.05
    boss_points = [
        (-29.0, 58.0),
        (29.0, 58.0),
        (-29.0, -58.0),
        (29.0, -58.0),
        (-29.0, -20.0),
        (29.0, -20.0),
    ]
    parts = [
        cyl_z("mold_sprue_bushing", sprue_d / 2.0, 8.0, [0.0, -height / 2 - 20.0, z], TOOLING, "tooling", "sprue bushing placeholder"),
        box("mold_primary_runner", [runner_d, 34.0, runner_d], [0.0, -height / 2 - 6.0, z], TOOLING, "tooling", "cold runner"),
        box("mold_left_submarine_gate", [24.0, gate_t, gate_t], [-18.0, -height / 2 - 0.4, z], TOOLING, "tooling", "submarine gate into back shell"),
        box("mold_right_submarine_gate", [24.0, gate_t, gate_t], [18.0, -height / 2 - 0.4, z], TOOLING, "tooling", "submarine gate into back shell"),
        box("mold_parting_line_reference", [width + 2.0, height + 2.0, 0.15], [0.0, 0.0, 0.0], [0.1, 0.1, 0.1, 0.22], "tooling", "mid-plane parting line reference"),
    ]
    for idx, (x, y) in enumerate(boss_points, start=1):
        parts.append(
            cyl_z(
                f"screw_core_pin_clearance_{idx}",
                mfg["screw_boss_core_diameter_mm"] / 2.0,
                3.0,
                [x, y, boss_z],
                DARK,
                "tooling clearance",
                "modeled core-pin clearance marker",
                sections=24,
            )
        )
    ejector_points = [
        (-30.0, 60.0),
        (0.0, 60.0),
        (30.0, 60.0),
        (-30.0, 0.0),
        (30.0, 0.0),
        (-30.0, -60.0),
        (0.0, -60.0),
        (30.0, -60.0),
    ]
    for idx, (x, y) in enumerate(ejector_points, start=1):
        parts.append(
            cyl_z(
                f"mold_ejector_pin_{idx}",
                mfg["ejector_pin_diameter_mm"] / 2.0,
                2.0,
                [x, y, z + 2.0],
                TOOLING,
                "tooling",
                "ejector pin witness placeholder",
                sections=24,
            )
        )
    channel_y = [-height / 2 + 24.0, 0.0, height / 2 - 24.0]
    for idx, y in enumerate(channel_y, start=1):
        parts.append(
            cyl(
                f"mold_cooling_channel_{idx}",
                mfg["cooling_channel_diameter_mm"] / 2.0,
                width + 16.0,
                [0.0, y, z - mfg["cooling_channel_clearance_mm"]],
                TOOLING,
                "tooling",
                "straight cooling channel placeholder",
                sections=24,
            )
        )
    return parts


def build_parts(params: dict[str, Any], exploded: bool = False) -> list[Part]:
    dev = params["device"]
    disp = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    comp = params["components"]

    width, height, depth = dev["envelope_mm"]
    back_z = -depth / 2 + 0.6
    mid_z = -1.0
    front_z = depth / 2 - 0.35
    corner_radius = dev["corner_radius_mm"]
    wall = dev["wall_thickness_mm"]

    parts: list[Part] = [
        rounded_box(
            "orange_back_shell",
            [width, height, 1.2],
            [0, 0, back_z],
            corner_radius,
            ORANGE,
            "molded enclosure",
            "PC+ABS orange rounded back shell",
        ),
        rounded_frame(
            "orange_side_frame",
            [width, height, depth],
            [0.0, 0.0, 0.0],
            wall,
            corner_radius,
            ORANGE,
            "molded enclosure",
            "PC+ABS orange rounded perimeter frame",
        ),
        rounded_box(
            "screen_cover_glass",
            disp["cover_glass_mm"],
            [0, 0, front_z],
            max(corner_radius - 0.45, 0.1),
            BLACK_GLASS,
            "screen",
            "black rounded cover glass",
        ),
        box("display_lcm", [*disp["tft_outline_mm"][:2], disp["tft_outline_mm"][2]], [0, -5.5, 2.0], DARK, "screen", "LCM"),
        composite_box_part(
            "main_pcb",
            [
                ([64.0, 25.0, 0.8], [0.0, 55.0, pcb["z_center_mm"]]),
                ([64.0, 15.0, 0.8], [0.0, -65.0, pcb["z_center_mm"]]),
                ([8.0, 78.0, 0.8], [-32.0, -8.0, pcb["z_center_mm"]]),
            ],
            PCB_GREEN,
            "PCB",
            "8L HDI FR-4 with battery window",
        ),
        box("battery_pouch", battery["envelope_mm"], [0, -7.0, battery["z_center_mm"]], [0.16, 0.16, 0.17, 1], "battery", "LiPo pouch"),
    ]

    parts.extend(
        [
            box("usb_c_receptacle", comp["usb_c"]["envelope_mm"], [0, -height / 2 + 4.1, -1.6], METAL, "I/O", "stainless shell"),
            box("usb_c_external_aperture", [10.2, 0.35, 3.6], [0, -height / 2 - 0.08, -1.45], DARK, "I/O", "USB-C molded aperture visual check"),
            box("bottom_speaker_module", comp["speaker_bottom"]["envelope_mm"], [18.5, -height / 2 + 13.0, -2.35], DARK, "audio", "speaker module"),
            box("earpiece_receiver", comp["earpiece"]["envelope_mm"], [0, height / 2 - 8.0, 1.0], DARK, "audio", "receiver"),
            box("bottom_mic", comp["microphone_bottom"]["envelope_mm"], [-18.0, -height / 2 + 8.2, -1.3], DARK, "audio", "MEMS mic"),
            box("top_mic", comp["microphone_top"]["envelope_mm"], [18.0, height / 2 - 8.2, -1.3], DARK, "audio", "MEMS mic"),
            box("rear_camera_module", comp["rear_camera"]["module_mm"], [21.0, height / 2 - 19.0, -1.05], CAMERA, "camera", "OV13855 class module"),
            cyl("rear_camera_lens_window", comp["rear_camera"]["lens_diameter_mm"] / 2, 0.8, [21.0, height / 2 - 19.0, -depth / 2 - 0.1], CAMERA, "camera", "glass lens window"),
            box("front_camera_module", comp["front_camera"]["module_mm"], [-19.0, height / 2 - 9.0, 1.0], CAMERA, "camera", "front MIPI camera"),
            cyl("front_camera_under_glass", comp["front_camera"]["lens_diameter_mm"] / 2, 0.35, [-19.0, height / 2 - 9.0, depth / 2 + 0.05], CAMERA, "camera", "under-glass aperture"),
            box("power_button_cap", comp["power_button"]["cap_mm"], [width / 2 + 0.55, 20.0, -0.4], ORANGE, "button", "orange molded cap"),
            box("volume_button_cap", comp["volume_button"]["cap_mm"], [-width / 2 - 0.55, 14.0, -0.4], ORANGE, "button", "orange molded cap"),
            box("handset_acoustic_slot", [16.0, 1.0, 0.25], [0, height / 2 - 7.6, depth / 2 + 0.08], DARK, "audio", "gasketed handset slot"),
        ]
    )
    for idx, x in enumerate([11.5, 14.5, 17.5, 20.5, 23.5], start=1):
        parts.append(
            box(
                f"bottom_speaker_grille_slot_{idx}",
                [1.2, 0.35, 4.0],
                [x, -height / 2 - 0.09, -1.35],
                DARK,
                "audio",
                "molded loudspeaker grille slot",
            )
        )
    for idx, x in enumerate([-22.0, -17.0], start=1):
        parts.append(
            cyl(
                f"bottom_microphone_port_{idx}",
                0.45,
                0.4,
                [x, -height / 2 - 0.12, -1.35],
                DARK,
                "audio",
                "molded microphone acoustic port",
                sections=18,
            )
        )
    parts.extend(adhesive_gasket_parts(params))
    parts.extend(enclosure_feature_parts(params))
    parts.extend(advanced_phone_parts(params))
    if exploded:
        offsets = {
            "screen": 22.0,
            "screen retention": 18.5,
            "camera": 13.5,
            "audio": 8.0,
            "I/O": 5.5,
            "button": 4.0,
            "connector": 3.2,
            "PCB": 1.5,
            "battery": -7.0,
            "molded enclosure": -1.5,
            "RF keepout": -0.8,
            "EMI shield": 2.4,
            "haptics": -4.5,
            "service": -3.0,
            "tooling clearance": -2.0,
        }
        for part in parts:
            part.mesh.apply_translation([0.0, 0.0, offsets.get(part.role, 0.0)])
    return parts


def export_meshes(parts: list[Part]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()
    manifest = []
    for part in parts:
        obj_path = OUT_DIR / f"{part.name}.obj"
        stl_path = OUT_DIR / f"{part.name}.stl"
        part.mesh.export(obj_path)
        part.mesh.export(stl_path)
        scene.add_geometry(part.mesh, node_name=part.name, geom_name=part.name)
        low, high = part.bounds
        manifest.append(
            {
                "name": part.name,
                "role": part.role,
                "material": part.material,
                "obj": obj_path.relative_to(ROOT).as_posix(),
                "stl": stl_path.relative_to(ROOT).as_posix(),
                "bounds_mm": [low.round(3).tolist(), high.round(3).tolist()],
            }
        )
    scene.export(OUT_DIR / "e1-phone-assembly.glb")
    (OUT_DIR / "assembly-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def export_named_scene(parts: list[Part], filename: str, manifest_name: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()
    manifest = []
    for part in parts:
        obj_path = OUT_DIR / f"{part.name}.obj"
        stl_path = OUT_DIR / f"{part.name}.stl"
        part.mesh.export(obj_path)
        part.mesh.export(stl_path)
        scene.add_geometry(part.mesh, node_name=part.name, geom_name=part.name)
        low, high = part.bounds
        manifest.append(
            {
                "name": part.name,
                "role": part.role,
                "material": part.material,
                "obj": obj_path.relative_to(ROOT).as_posix(),
                "stl": stl_path.relative_to(ROOT).as_posix(),
                "bounds_mm": [low.round(3).tolist(), high.round(3).tolist()],
            }
        )
    scene.export(OUT_DIR / filename)
    (OUT_DIR / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n")


def render(parts: list[Part], path: Path, title: str, elev: float, azim: float) -> None:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    fig = plt.figure(figsize=(9, 11), dpi=150)
    ax = fig.add_subplot(111, projection="3d")
    for part in parts:
        vertices = part.mesh.vertices
        faces = part.mesh.faces
        collection = Poly3DCollection(vertices[faces], linewidths=0.15, edgecolors=(0, 0, 0, 0.18))
        collection.set_facecolor(part.color)
        ax.add_collection3d(collection)
    all_vertices = np.vstack([part.mesh.vertices for part in parts])
    mins = all_vertices.min(axis=0)
    maxs = all_vertices.max(axis=0)
    center = (mins + maxs) / 2.0
    span = float((maxs - mins).max()) * 0.58
    ax.set_xlim(center[0] - span, center[0] + span)
    ax.set_ylim(center[1] - span, center[1] + span)
    ax.set_zlim(center[2] - span, center[2] + span)
    ax.view_init(elev=elev, azim=azim)
    ax.set_title(title)
    ax.set_axis_off()
    ax.set_box_aspect((1, 1, 1))
    fig.tight_layout(pad=0)
    fig.savefig(path, transparent=False, facecolor="white")
    plt.close(fig)


def verify_render_artifacts(paths: list[Path]) -> dict[str, Any]:
    from PIL import Image, ImageStat

    results: dict[str, Any] = {}
    for path in paths:
        image = Image.open(path).convert("RGB")
        stat = ImageStat.Stat(image)
        extrema = stat.extrema
        channel_spans = [high - low for low, high in extrema]
        results[path.name] = {
            "size": list(image.size),
            "mean_rgb": [round(value, 3) for value in stat.mean],
            "channel_spans": channel_spans,
            "pass": image.size[0] >= 1000
            and image.size[1] >= 1000
            and max(channel_spans) >= 120,
        }
    (REVIEW_DIR / "visual-review.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


def part_density_g_per_cm3(part: Part) -> float:
    material = part.material.lower()
    if "pc+abs" in material or "adhesive" in material or "gasket" in material:
        return 1.15
    if "glass" in material:
        return 2.5
    if "fr-4" in material:
        return 1.85
    if "lipo" in material:
        return 2.65
    if "stainless" in material:
        return 7.8
    if "shield" in material or "stamped" in material:
        return 7.8
    if "connector" in material:
        return 3.0
    if "speaker" in material or "receiver" in material or "camera" in material or "mems" in material:
        return 2.2
    return 1.2


def is_mass_placeholder(part: Part) -> bool:
    placeholder_fragments = (
        "aperture",
        "grille_slot",
        "microphone_port",
        "handset_acoustic_slot",
        "bend_keepout",
        "antenna_keepout",
        "sim_tray_keepout",
        "service_label_recess",
    )
    return part.role in {"tooling", "tooling clearance", "review"} or any(
        fragment in part.name for fragment in placeholder_fragments
    )


def mass_budget(parts: list[Part]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    total = 0.0
    by_role: dict[str, float] = {}
    for part in parts:
        volume_mm3 = max(float(part.mesh.volume), 0.0)
        if is_mass_placeholder(part):
            mass_g = 0.0
            density = 0.0
        else:
            density = part_density_g_per_cm3(part)
            mass_g = volume_mm3 / 1000.0 * density
        total += mass_g
        by_role[part.role] = by_role.get(part.role, 0.0) + mass_g
        rows.append(
            {
                "name": part.name,
                "role": part.role,
                "volume_mm3": round(volume_mm3, 3),
                "density_g_per_cm3": round(density, 3),
                "mass_g": round(mass_g, 3),
                "excluded_placeholder": is_mass_placeholder(part),
            }
        )
    return {
        "claim_boundary": "Rough CAD mass estimate using nominal densities; not measured mass.",
        "total_estimated_mass_g": round(total, 2),
        "mass_by_role_g": {role: round(mass, 2) for role, mass in sorted(by_role.items())},
        "parts": rows,
    }


def write_mass_budget(parts: list[Part]) -> dict[str, Any]:
    budget = mass_budget(parts)
    (REVIEW_DIR / "mass-budget.json").write_text(json.dumps(budget, indent=2) + "\n")
    lines = [
        "# E1 Phone CAD Mass Budget",
        "",
        "Status: rough CAD estimate, not measured hardware mass.",
        "",
        f"Total estimated mass: {budget['total_estimated_mass_g']} g",
        "",
        "## By Role",
        "",
    ]
    for role, mass in budget["mass_by_role_g"].items():
        lines.append(f"- `{role}`: {mass} g")
    (REVIEW_DIR / "mass-budget.md").write_text("\n".join(lines) + "\n")
    return budget


def supplier_matrix(params: dict[str, Any]) -> dict[str, Any]:
    components = params["components"]
    display = params["display"]
    radio = params.get("radio", {})
    return {
        "claim_boundary": "Supplier shortlist for mechanical CAD lock; not a purchase order.",
        "accessed_date": "2026-05-20",
        "items": [
            {
                "id": "display_lcm_ctp",
                "role": "screen",
                "candidate": display["candidate"],
                "mechanical_lock": {
                    "cover_glass_mm": display["cover_glass_mm"],
                    "tft_outline_mm": display["tft_outline_mm"],
                    "active_area_mm": display["active_area_mm"],
                    "fpc_connector_mm": display["fpc_connector_mm"],
                    "fpc_bend_radius_mm": display["fpc_bend_radius_mm"],
                },
                "source_url": display["source_url"],
                "supplier_lock_state": "needs vendor drawing and sample quote",
            },
            {
                "id": "usb_c",
                "role": "usb",
                "candidate": components["usb_c"]["candidate"],
                "mechanical_lock": {
                    "envelope_mm": components["usb_c"]["envelope_mm"],
                    "insertion_keepout_mm": components["usb_c"]["insertion_keepout_mm"],
                    "mating_cycles": components["usb_c"]["cycles"],
                },
                "source_url": components["usb_c"]["source_url"],
                "distributor_url": components["usb_c"]["distributor_url"],
                "supplier_lock_state": "candidate active; needs exact selected suffix and footprint",
            },
            {
                "id": "side_buttons",
                "role": "power_volume_buttons",
                "candidate": components["power_button"]["candidate"],
                "mechanical_lock": {
                    "power_force_n": components["power_button"]["force_n"],
                    "volume_force_n": components["volume_button"]["force_n"],
                    "travel_mm": components["power_button"]["travel_mm"],
                    "cap_power_mm": components["power_button"]["cap_mm"],
                    "cap_volume_mm": components["volume_button"]["cap_mm"],
                },
                "source_url": components["power_button"]["source_url"],
                "supplier_lock_state": "needs exact Panasonic part number and flex/direct-PCB decision",
            },
            {
                "id": "cellular_redcap",
                "role": "radio",
                "candidate": radio.get("cellular", {}).get("candidate"),
                "mechanical_lock": {
                    "envelope_mm": radio.get("cellular", {}).get("envelope_mm"),
                    "mass_g": radio.get("cellular", {}).get("mass_g"),
                },
                "source_url": radio.get("cellular", {}).get("source_url"),
                "supplier_lock_state": "reserved for PCB/RF planning; not yet modeled as final phone antenna system",
            },
            {
                "id": "wifi_bt",
                "role": "radio",
                "candidate": radio.get("wifi_bt", {}).get("candidate"),
                "mechanical_lock": {},
                "source_url": radio.get("wifi_bt", {}).get("source_url"),
                "supplier_lock_state": "module candidate only; antenna and coax/feed geometry remain open",
            },
            {
                "id": "rear_camera",
                "role": "camera",
                "candidate": components["rear_camera"]["candidate"],
                "mechanical_lock": {
                    "module_mm": components["rear_camera"]["module_mm"],
                    "lens_diameter_mm": components["rear_camera"]["lens_diameter_mm"],
                },
                "source_url": "https://sincerefirst.en.made-in-china.com/product/WACpUrRYOVkc/China-Ov13855-Ov13850-CMOS-Sensor-Autofocus-13MP-Mipi-Camera-Module.html",
                "supplier_lock_state": "needs exact module drawing, FPC side, and lens stack height",
            },
            {
                "id": "front_camera",
                "role": "camera",
                "candidate": components["front_camera"]["candidate"],
                "mechanical_lock": {
                    "module_mm": components["front_camera"]["module_mm"],
                    "lens_diameter_mm": components["front_camera"]["lens_diameter_mm"],
                },
                "source_url": None,
                "supplier_lock_state": "placeholder envelope; needs Shenzhen/OEM module selection after cover-glass aperture decision",
            },
        ],
    }


def write_supplier_artifacts(params: dict[str, Any]) -> dict[str, Any]:
    matrix = supplier_matrix(params)
    (REVIEW_DIR / "supplier-lock.json").write_text(json.dumps(matrix, indent=2) + "\n")
    lines = [
        "# E1 Phone Supplier Lock Matrix",
        "",
        "Status: shortlist for CAD lock, not a purchase order.",
        "",
    ]
    for item in matrix["items"]:
        lines.append(f"## {item['id']}")
        lines.append("")
        lines.append(f"- Role: `{item['role']}`")
        lines.append(f"- Candidate: {item['candidate']}")
        lines.append(f"- Source: {item['source_url'] or 'TBD'}")
        if item.get("distributor_url"):
            lines.append(f"- Distributor: {item['distributor_url']}")
        lines.append(f"- Lock state: {item['supplier_lock_state']}")
        if item["mechanical_lock"]:
            lines.append(f"- Mechanical lock: `{json.dumps(item['mechanical_lock'], sort_keys=True)}`")
        lines.append("")
    (REVIEW_DIR / "supplier-lock.md").write_text("\n".join(lines))
    return matrix


def write_kicad_mechanical_handoff(params: dict[str, Any], checks: dict[str, Any]) -> dict[str, Any]:
    width, height, depth = params["device"]["envelope_mm"]
    display = params["display"]
    components = params["components"]
    radio = params.get("radio", {})
    handoff = {
        "claim_boundary": "Mechanical-to-KiCad constraints from EVT0 CAD; not routed PCB release.",
        "pcb_source": params["pcb"]["source"],
        "device_envelope_mm": [width, height, depth],
        "kicad_outline_check": checks["checks"]["kicad_outline_integration"],
        "constraints": [
            {
                "id": "board_outline",
                "action": "Keep Edge.Cuts at 64.0 x 132.0 mm until display or enclosure anchor changes.",
                "why": "CAD battery window, ribs, and side rails are derived from this board outline.",
            },
            {
                "id": "display_fpc_zone",
                "action": "Place display/touch FPC connector near x=23 mm, y=55 mm in CAD coordinates and preserve 22 x 10 mm bend keepout.",
                "why": f"{display['candidate']} uses the current cover-glass/TFT anchor and requires an FPC bend path into the phone.",
            },
            {
                "id": "usb_c_mechanical_capture",
                "action": "Use selected USB-C footprint with shell stakes and align receptacle mouth to bottom-center enclosure aperture.",
                "why": f"{components['usb_c']['candidate']} is modeled with {components['usb_c']['insertion_keepout_mm']} mm insertion keepout.",
            },
            {
                "id": "side_key_stack",
                "action": "Decide side-key flex versus direct PCB switches before schematic freeze; reserve left/right edge keepouts for power and volume actuators.",
                "why": "CAD button pressure checks assume side actuation and external orange caps.",
            },
            {
                "id": "battery_window",
                "action": "Keep the 55 x 92 x 4.1 mm battery window clear and do not route rigid PCB under the modeled pouch.",
                "why": "CAD non-overlap check uses segmented rigid board islands around this window.",
            },
            {
                "id": "redcap_module_zone",
                "action": "If using RG255C LGA, reserve at least 29 x 32 x 2.4 mm plus RF keepout and coax/feed transition near antenna plastic.",
                "why": radio.get("cellular", {}).get("candidate", "cellular module candidate"),
            },
            {
                "id": "speaker_mic_ports",
                "action": "Keep bottom speaker and MEMS microphone acoustic paths aligned to molded ports; avoid placing tall components under grille slots.",
                "why": "CAD now includes five speaker grille slots and two microphone ports.",
            },
        ],
        "next_kicad_edits": [
            "Replace concept rectangles with real footprints for USB4105, display FPC, camera FPCs, side tactile switches, speaker spring pads, MEMS microphones, and RG255C/alternate modem.",
            "Generate a board STEP with component 3D models and feed it back into mechanical/e1-phone instead of the current concept PCB mesh.",
            "Add courtyard/height metadata for all edge-facing connectors so enclosure collision checks can consume them automatically.",
        ],
    }
    (REVIEW_DIR / "kicad-mechanical-handoff.json").write_text(json.dumps(handoff, indent=2) + "\n")
    lines = [
        "# E1 Phone KiCad Mechanical Handoff",
        "",
        "Status: constraints from EVT0 CAD; not PCB release.",
        "",
    ]
    for constraint in handoff["constraints"]:
        lines.append(f"## {constraint['id']}")
        lines.append("")
        lines.append(f"- Action: {constraint['action']}")
        lines.append(f"- Why: {constraint['why']}")
        lines.append("")
    lines.append("## Next KiCad Edits")
    lines.append("")
    for item in handoff["next_kicad_edits"]:
        lines.append(f"- {item}")
    (REVIEW_DIR / "kicad-mechanical-handoff.md").write_text("\n".join(lines) + "\n")
    return handoff


def write_drafting_artifacts(params: dict[str, Any], checks: dict[str, Any]) -> None:
    width, height, depth = params["device"]["envelope_mm"]
    corner_radius = params["device"]["corner_radius_mm"]
    wall = params["device"]["wall_thickness_mm"]
    glass_w, glass_h, _ = params["display"]["cover_glass_mm"]
    pcb_w, pcb_h, pcb_t = params["pcb"]["outline_mm"]
    battery_w, battery_h, battery_t = params["battery"]["envelope_mm"]
    mfg = params["manufacturing"]

    fig, axes = plt.subplots(1, 2, figsize=(13.0, 8.0), dpi=140)
    front, side = axes
    for ax in axes:
        ax.set_aspect("equal")
        ax.axis("off")

    body = FancyBboxPatch(
        (-width / 2, -height / 2),
        width,
        height,
        boxstyle=f"round,pad=0,rounding_size={corner_radius}",
        fill=False,
        lw=2.0,
    )
    glass = FancyBboxPatch(
        (-glass_w / 2, -glass_h / 2),
        glass_w,
        glass_h,
        boxstyle=f"round,pad=0,rounding_size={max(corner_radius - 0.45, 0.1)}",
        fill=False,
        lw=1.2,
    )
    pcb_rect = plt.Rectangle((-pcb_w / 2, -pcb_h / 2), pcb_w, pcb_h, fill=False, lw=1.0, ls="--")
    battery = plt.Rectangle((-battery_w / 2, -7.0 - battery_h / 2), battery_w, battery_h, fill=False, lw=1.0)
    front.add_patch(body)
    front.add_patch(glass)
    front.add_patch(pcb_rect)
    front.add_patch(battery)
    front.text(-width / 2, height / 2 + 6, f"Envelope {width:.1f} x {height:.1f} mm")
    front.text(-width / 2, height / 2 + 1.5, f"R{corner_radius:.1f} rounded orange PC+ABS")
    front.text(-width / 2, -height / 2 - 6, f"CTP glass {glass_w:.1f} x {glass_h:.2f} mm")
    front.text(-width / 2, -height / 2 - 10.5, f"PCB Edge.Cuts {pcb_w:.1f} x {pcb_h:.1f} x {pcb_t:.1f} mm")
    front.text(-width / 2, -height / 2 - 15, f"Battery window {battery_w:.1f} x {battery_h:.1f} x {battery_t:.1f} mm")
    front.set_xlim(-width / 2 - 10, width / 2 + 10)
    front.set_ylim(-height / 2 - 20, height / 2 + 15)
    front.set_title("Front Envelope And Internal Keepouts")

    side.add_patch(plt.Rectangle((-height / 2, -depth / 2), height, depth, fill=False, lw=2.0))
    side.add_patch(plt.Rectangle((-height / 2 + 0.625, -depth / 2 + 0.6 - 0.6), height - 1.25, 1.2, fill=False, lw=1.0))
    side.add_patch(plt.Rectangle((-glass_h / 2, depth / 2 - 0.7), glass_h, 0.7, fill=False, lw=1.0))
    side.text(-height / 2, depth / 2 + 2.0, f"Z stack {depth:.1f} mm")
    side.text(-height / 2, -depth / 2 - 3.2, f"wall {wall:.2f} mm")
    side.text(-height / 2, -depth / 2 - 6.0, f"draft {mfg['nominal_draft_deg']:.1f} deg")
    side.text(-height / 2 + 34.0, -depth / 2 - 3.2, f"gate {mfg['gate_thickness_mm']:.2f} mm")
    side.text(-height / 2 + 34.0, -depth / 2 - 6.0, f"runner {mfg['runner_diameter_mm']:.1f} mm")
    side.text(-height / 2 + 74.0, -depth / 2 - 3.2, f"checks: {checks['status']}")
    side.set_xlim(-height / 2 - 10, height / 2 + 10)
    side.set_ylim(-depth / 2 - 12, depth / 2 + 8)
    side.set_title("Side Z Stack And Mold Notes")

    fig.tight_layout()
    png = REVIEW_DIR / "manufacturing_drawing.png"
    svg = REVIEW_DIR / "manufacturing_drawing.svg"
    fig.savefig(png, facecolor="white")
    fig.savefig(svg, facecolor="white")
    plt.close(fig)

    drawing = {
        "claim_boundary": "EVT0 mechanical drawing for review; not GD&T-controlled release drawing.",
        "units": "mm",
        "device_envelope_mm": params["device"]["envelope_mm"],
        "corner_radius_mm": corner_radius,
        "wall_thickness_mm": wall,
        "display_cover_glass_mm": params["display"]["cover_glass_mm"],
        "pcb_outline_mm": params["pcb"]["outline_mm"],
        "battery_envelope_mm": params["battery"]["envelope_mm"],
        "manufacturing": {
            "draft_deg": mfg["nominal_draft_deg"],
            "sprue_diameter_mm": mfg["sprue_diameter_mm"],
            "runner_diameter_mm": mfg["runner_diameter_mm"],
            "gate_thickness_mm": mfg["gate_thickness_mm"],
            "screw_boss_count": mfg["screw_boss_count"],
            "snap_hook_count": mfg["snap_hook_count"],
        },
    }
    (REVIEW_DIR / "manufacturing_drawing.json").write_text(json.dumps(drawing, indent=2) + "\n")


def write_readiness_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    tooling: list[Part],
    checks: dict[str, Any],
    visual: dict[str, Any],
    mass: dict[str, Any],
    supplier: dict[str, Any],
    handoff: dict[str, Any],
) -> None:
    manifest_path = OUT_DIR / "assembly-manifest.json"
    tooling_manifest_path = OUT_DIR / "tooling-manifest.json"
    assembly_manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else []
    tooling_manifest = json.loads(tooling_manifest_path.read_text()) if tooling_manifest_path.is_file() else []
    part_names = {part.name for part in parts}
    tooling_names = {part.name for part in tooling}
    check_status = checks["checks"]

    subsystems = [
        {
            "subsystem": "molded_orange_enclosure",
            "status": "cad_pass",
            "evidence": [
                "orange_back_shell",
                "orange_side_frame",
                "rounded_enclosure_geometry",
                "mesh_integrity",
                "mass_budget",
                "molded_retention_features",
                "manufacturing_drawing.json",
            ],
            "remaining_blockers": [
                "No vendor mold-flow simulation.",
                "No measured shrink/warp data for selected PC+ABS resin.",
                "No GD&T-controlled 2D release drawing.",
            ],
        },
        {
            "subsystem": "screen_stack",
            "status": "cad_pass",
            "evidence": [
                "screen_cover_glass",
                "display_lcm",
                "screen_adhesive_top",
                "display_fpc_connector",
                "screen_mount_and_connection",
            ],
            "remaining_blockers": [
                "Need supplier drawing and exact FPC exit direction.",
                "Need verified touch/display pinout and bend test with real sample.",
            ],
        },
        {
            "subsystem": "pcb_integration",
            "status": "cad_pass",
            "evidence": ["main_pcb", "kicad_outline_integration", "pcb_battery_non_overlap"],
            "remaining_blockers": [
                "KiCad source is still a concept placement, not routed fabrication data.",
                "Need board STEP from routed KiCad with real component 3D models.",
            ],
        },
        {
            "subsystem": "buttons",
            "status": "cad_pass",
            "evidence": [
                "power_button_cap",
                "volume_button_cap",
                "button_force_and_travel",
                "button_pressure_support",
            ],
            "remaining_blockers": [
                "Need tactile switch vendor part and tolerance stack.",
                "Need fatigue testing on snap retention and button caps.",
            ],
        },
        {
            "subsystem": "usb_audio_ports",
            "status": "cad_pass",
            "evidence": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "bottom_speaker_grille_slot_1",
                "bottom_microphone_port_1",
                "usb_c_insertion_envelope",
                "bottom_io_acoustic_apertures",
            ],
            "remaining_blockers": [
                "Need USB-C receptacle supplier drawing and insertion-cycle mechanical validation.",
                "Need acoustic simulation/measurement for speaker chamber and microphone tunnels.",
            ],
        },
        {
            "subsystem": "cameras_and_handset",
            "status": "cad_pass",
            "evidence": [
                "rear_camera_module",
                "front_camera_module",
                "front_camera_under_glass",
                "rear_camera_cover_glass",
                "earpiece_receiver",
                "handset_acoustic_slot",
                "camera_speaker_behind_glass",
            ],
            "remaining_blockers": [
                "Need exact camera module lens stack, FPC, and vendor keepout drawing.",
                "Need handset acoustic gasket compression test.",
            ],
        },
        {
            "subsystem": "rf_shielding_haptics_service",
            "status": "cad_pass",
            "evidence": [
                "cellular_top_antenna_keepout",
                "cellular_bottom_antenna_keepout",
                "wifi_bt_side_antenna_keepout",
                "soc_shield_can",
                "pmic_shield_can",
                "radio_shield_can",
                "haptic_lra",
                "sim_tray_keepout",
                "rf_antenna_keepouts",
                "shielding_haptics_service",
            ],
            "remaining_blockers": [
                "Need RF antenna simulation, SAR pre-scan, and desense test with final antennas.",
                "Need haptic actuator vendor drawing and drive calibration.",
                "Need SIM/eSIM product decision and serviceability review.",
            ],
        },
        {
            "subsystem": "injection_mold_tooling",
            "status": "cad_pass",
            "evidence": [
                "mold_sprue_bushing",
                "mold_primary_runner",
                "mold_left_submarine_gate",
                "mold_right_submarine_gate",
                "mold_runner_gate_model",
                "mold_ejector_cooling_model",
            ],
            "remaining_blockers": [
                "Runner/gate/ejector/cooling geometry is a placeholder, not toolmaker-approved steel design.",
                "Need mold-flow/fill balance analysis and toolmaker review.",
            ],
        },
        {
            "subsystem": "review_automation",
            "status": "cad_pass",
            "evidence": [
                "fit-check-report.json",
                "visual-review.json",
                "manufacturing_drawing.json",
                "full_top_down.png",
                "mold_tooling.png",
            ],
            "remaining_blockers": [
                "Visual checks prove nonblank/high-contrast renders only; they do not replace human DFM review.",
            ],
        },
    ]

    required_outputs = {
        "assembly_glb": (OUT_DIR / "e1-phone-assembly.glb").is_file(),
        "tooling_glb": (OUT_DIR / "e1-phone-mold-tooling.glb").is_file(),
        "assembly_manifest": bool(assembly_manifest),
        "tooling_manifest": bool(tooling_manifest),
        "fit_report": (REVIEW_DIR / "fit-check-report.json").is_file(),
        "visual_review": (REVIEW_DIR / "visual-review.json").is_file(),
        "manufacturing_drawing": (REVIEW_DIR / "manufacturing_drawing.json").is_file(),
        "mass_budget": (REVIEW_DIR / "mass-budget.json").is_file(),
        "supplier_lock": (REVIEW_DIR / "supplier-lock.json").is_file(),
        "kicad_mechanical_handoff": (REVIEW_DIR / "kicad-mechanical-handoff.json").is_file(),
    }
    subsystem_evidence_present: dict[str, bool] = {}
    for row in subsystems:
        present = True
        for evidence in row["evidence"]:
            if evidence in check_status:
                present = present and bool(check_status[evidence]["pass"])
            elif evidence.endswith((".json", ".png", ".svg")):
                present = present and (REVIEW_DIR / evidence).is_file()
            else:
                present = present and (evidence in part_names or evidence in tooling_names)
        subsystem_evidence_present[row["subsystem"]] = present

    visual_pass = all(item["pass"] for item in visual.values())
    all_cad_checks_pass = all(item["pass"] for item in check_status.values())
    all_outputs_present = all(required_outputs.values())
    all_evidence_present = all(subsystem_evidence_present.values())
    manufacturing_release_ready = False

    readiness = {
        "claim_boundary": "CAD automation readiness audit; not a manufacturing release.",
        "overall_status": "cad_package_pass"
        if all_cad_checks_pass and all_outputs_present and all_evidence_present and visual_pass
        else "blocked",
        "manufacturing_release_ready": manufacturing_release_ready,
        "why_not_release_ready": [
            "KiCad phone board remains concept/floorplan-level, not routed and fabricated.",
            "Supplier mechanical drawings and samples for display, cameras, USB-C, buttons, battery, and speakers are not locked.",
            "No mold-flow, thermal, acoustic, RF, drop, ingress, or tolerance-stack validation with physical samples.",
            "No GD&T-controlled release drawing package or toolmaker DFM signoff.",
        ],
        "parameters": {
            "device_envelope_mm": params["device"]["envelope_mm"],
            "corner_radius_mm": params["device"]["corner_radius_mm"],
            "plastic": params["manufacturing"]["plastic"],
            "display_candidate": params["display"]["candidate"],
            "pcb_source": params["pcb"]["source"],
            "estimated_mass_g": mass["total_estimated_mass_g"],
            "target_mass_g": params["device"]["target_mass_g"],
            "supplier_items": len(supplier["items"]),
            "kicad_handoff_constraints": len(handoff["constraints"]),
        },
        "required_outputs": required_outputs,
        "subsystem_evidence_present": subsystem_evidence_present,
        "all_cad_checks_pass": all_cad_checks_pass,
        "visual_review_pass": visual_pass,
        "subsystems": subsystems,
    }
    (REVIEW_DIR / "manufacturing-readiness.json").write_text(json.dumps(readiness, indent=2) + "\n")

    lines = [
        "# E1 Phone Manufacturing Readiness Audit",
        "",
        "Status: CAD package pass; manufacturing release blocked.",
        "",
        "This audit is generated from the CAD generator, fit checks, visual checks, and artifact manifests.",
        "",
        "## Release Boundary",
        "",
    ]
    for blocker in readiness["why_not_release_ready"]:
        lines.append(f"- BLOCKED: {blocker}")
    lines.extend(["", "## Subsystem Evidence", ""])
    for row in subsystems:
        present = subsystem_evidence_present[row["subsystem"]]
        lines.append(f"- {'PASS' if present else 'BLOCKED'}: `{row['subsystem']}`")
        lines.append(f"  Evidence: {', '.join(row['evidence'])}")
        lines.append(f"  Remaining: {'; '.join(row['remaining_blockers'])}")
    lines.extend(["", "## Required Outputs", ""])
    for name, present in required_outputs.items():
        lines.append(f"- {'PASS' if present else 'BLOCKED'}: `{name}`")
    (REVIEW_DIR / "manufacturing-readiness.md").write_text("\n".join(lines) + "\n")


def aabb_gap(a: Part, b: Part) -> float:
    amin, amax = a.bounds
    bmin, bmax = b.bounds
    sep = np.maximum(np.maximum(amin - bmax, bmin - amax), 0)
    return float(np.linalg.norm(sep))


def box_gap(size_a: list[float], center_a: list[float], size_b: list[float], center_b: list[float]) -> float:
    amin = np.asarray(center_a) - np.asarray(size_a) / 2.0
    amax = np.asarray(center_a) + np.asarray(size_a) / 2.0
    bmin = np.asarray(center_b) - np.asarray(size_b) / 2.0
    bmax = np.asarray(center_b) + np.asarray(size_b) / 2.0
    sep = np.maximum(np.maximum(amin - bmax, bmin - amax), 0)
    return float(np.linalg.norm(sep))


def run_checks(params: dict[str, Any], parts: list[Part]) -> dict[str, Any]:
    by_name = {part.name: part for part in parts}
    width, height, depth = params["device"]["envelope_mm"]
    display = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    comp = params["components"]

    required = [
        "orange_back_shell",
        "orange_side_frame",
        "screen_cover_glass",
        "display_lcm",
        "main_pcb",
        "battery_pouch",
        "usb_c_receptacle",
        "bottom_speaker_module",
        "earpiece_receiver",
        "bottom_mic",
        "top_mic",
        "rear_camera_module",
        "front_camera_module",
        "power_button_cap",
        "volume_button_cap",
        "handset_acoustic_slot",
        "screen_adhesive_top",
        "display_fpc_connector",
        "orange_usb_reinforcement_saddle",
        "bottom_speaker_acoustic_chamber",
        "earpiece_gasket",
        "usb_c_external_aperture",
        "bottom_speaker_grille_slot_1",
        "bottom_microphone_port_1",
        "cellular_top_antenna_keepout",
        "cellular_bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
        "soc_shield_can",
        "pmic_shield_can",
        "radio_shield_can",
        "haptic_lra",
        "sim_tray_keepout",
        "rear_camera_cover_glass",
        "service_label_recess",
    ]
    component_presence = {name: name in by_name for name in required}

    pcb_w, pcb_h, _ = pcb["outline_mm"]
    pcb_edge_clearance = min((width - pcb_w) / 2.0, (height - pcb_h) / 2.0)
    screen_margin = min(
        (width - display["ctp_outline_mm"][0]) / 2.0,
        (height - display["ctp_outline_mm"][1]) / 2.0,
    )
    usb_h = comp["usb_c"]["envelope_mm"][1]
    usb_port_center_y = -height / 2 + 4.1
    usb_insertion_clearance = usb_port_center_y - (-height / 2) + usb_h / 2.0
    battery_center = [0.0, -7.0, battery["z_center_mm"]]
    pcb_segment_gaps = [
        box_gap([64.0, 25.0, 0.8], [0.0, 55.0, pcb["z_center_mm"]], battery["envelope_mm"], battery_center),
        box_gap([64.0, 15.0, 0.8], [0.0, -65.0, pcb["z_center_mm"]], battery["envelope_mm"], battery_center),
        box_gap([8.0, 78.0, 0.8], [-32.0, -8.0, pcb["z_center_mm"]], battery["envelope_mm"], battery_center),
    ]
    kicad_outline = kicad_outline_mm(ROOT / pcb["source"])
    boss_count = sum(1 for name in by_name if name.startswith("orange_screw_boss_"))
    snap_count = sum(1 for name in by_name if name.startswith("orange_snap_hook_"))
    tooling = tooling_parts(params)
    tooling_names = {part.name for part in tooling}
    ejector_count = sum(1 for name in tooling_names if name.startswith("mold_ejector_pin_"))
    cooling_count = sum(1 for name in tooling_names if name.startswith("mold_cooling_channel_"))
    final_assembly_has_tooling = any(part.role in {"tooling", "tooling clearance"} for part in parts)
    shell_vertices = len(by_name["orange_back_shell"].mesh.vertices) if "orange_back_shell" in by_name else 0
    frame_vertices = len(by_name["orange_side_frame"].mesh.vertices) if "orange_side_frame" in by_name else 0
    mesh_failures = [
        part.name
        for part in parts
        if not part.mesh.is_watertight or float(part.mesh.volume) <= 0.0 or len(part.mesh.faces) == 0
    ]
    mass = mass_budget(parts)

    checks = {
        "component_presence": {
            "pass": all(component_presence.values()),
            "details": component_presence,
        },
        "pcb_edge_clearance": {
            "pass": pcb_edge_clearance >= pcb["edge_clearance_mm"],
            "actual_mm": round(pcb_edge_clearance, 3),
            "required_mm": pcb["edge_clearance_mm"],
        },
        "screen_mount_margin": {
            "pass": screen_margin >= 0.3,
            "actual_mm": round(screen_margin, 3),
            "required_mm": 0.3,
        },
        "rounded_enclosure_geometry": {
            "pass": params["device"]["corner_radius_mm"] >= 6.0
            and shell_vertices >= 96
            and frame_vertices >= 192
            and params["device"]["corner_radius_mm"] > 3.0 * params["device"]["wall_thickness_mm"],
            "corner_radius_mm": params["device"]["corner_radius_mm"],
            "wall_thickness_mm": params["device"]["wall_thickness_mm"],
            "back_shell_vertices": shell_vertices,
            "side_frame_vertices": frame_vertices,
        },
        "mesh_integrity": {
            "pass": not mesh_failures,
            "checked_parts": len(parts),
            "failures": mesh_failures,
        },
        "usb_c_insertion_envelope": {
            "pass": usb_insertion_clearance >= usb_h,
            "actual_mm": round(usb_insertion_clearance, 3),
            "required_mm": usb_h,
        },
        "bottom_io_acoustic_apertures": {
            "pass": "usb_c_external_aperture" in by_name
            and sum(1 for name in by_name if name.startswith("bottom_speaker_grille_slot_")) >= 5
            and sum(1 for name in by_name if name.startswith("bottom_microphone_port_")) >= 2,
            "speaker_grille_slots": sum(
                1 for name in by_name if name.startswith("bottom_speaker_grille_slot_")
            ),
            "microphone_ports": sum(
                1 for name in by_name if name.startswith("bottom_microphone_port_")
            ),
        },
        "button_force_and_travel": {
            "pass": 1.2 <= comp["power_button"]["force_n"] <= 2.2
            and 1.2 <= comp["volume_button"]["force_n"] <= 2.2
            and comp["power_button"]["travel_mm"] >= 0.25
            and comp["volume_button"]["travel_mm"] >= 0.25,
            "power": {
                "force_n": comp["power_button"]["force_n"],
                "travel_mm": comp["power_button"]["travel_mm"],
            },
            "volume": {
                "force_n": comp["volume_button"]["force_n"],
                "travel_mm": comp["volume_button"]["travel_mm"],
            },
        },
        "button_pressure_support": {
            "pass": "orange_snap_hook_5" in by_name
            and "orange_snap_hook_1" in by_name
            and comp["power_button"]["force_n"] / (comp["power_button"]["cap_mm"][1] * comp["power_button"]["cap_mm"][2]) < 0.2
            and comp["volume_button"]["force_n"] / (comp["volume_button"]["cap_mm"][1] * comp["volume_button"]["cap_mm"][2]) < 0.12,
            "power_pressure_n_per_mm2": round(
                comp["power_button"]["force_n"]
                / (comp["power_button"]["cap_mm"][1] * comp["power_button"]["cap_mm"][2]),
                4,
            ),
            "volume_pressure_n_per_mm2": round(
                comp["volume_button"]["force_n"]
                / (comp["volume_button"]["cap_mm"][1] * comp["volume_button"]["cap_mm"][2]),
                4,
            ),
        },
        "screen_mount_and_connection": {
            "pass": display["adhesive_width_mm"] >= 0.8
            and display["adhesive_thickness_mm"] <= 0.25
            and display["fpc_bend_radius_mm"] >= 1.0
            and "display_fpc_connector" in by_name
            and "display_fpc_bend_keepout" in by_name,
            "adhesive_width_mm": display["adhesive_width_mm"],
            "adhesive_thickness_mm": display["adhesive_thickness_mm"],
            "compression_target_pct": display["compression_target_pct"],
            "fpc_bend_radius_mm": display["fpc_bend_radius_mm"],
        },
        "camera_speaker_behind_glass": {
            "pass": "front_camera_under_glass" in by_name
            and "earpiece_gasket" in by_name
            and "rear_camera_cover_glass" in by_name,
            "front_camera": "behind cover glass at upper-left display border",
            "earpiece": "behind cover-glass acoustic slot with gasketed receiver",
            "rear_camera": "behind a separate rear cover glass window",
        },
        "rf_antenna_keepouts": {
            "pass": "cellular_top_antenna_keepout" in by_name
            and "cellular_bottom_antenna_keepout" in by_name
            and "wifi_bt_side_antenna_keepout" in by_name,
            "cellular_keepout_mm": params.get("radio", {}).get("cellular", {}).get("antenna_keepout_mm"),
            "wifi_bt_keepout_mm": params.get("radio", {}).get("wifi_bt", {}).get("antenna_keepout_mm"),
        },
        "shielding_haptics_service": {
            "pass": all(
                name in by_name
                for name in [
                    "soc_shield_can",
                    "pmic_shield_can",
                    "radio_shield_can",
                    "haptic_lra",
                    "sim_tray_keepout",
                    "service_label_recess",
                ]
            ),
            "shield_cans": sum(1 for name in by_name if name.endswith("_shield_can")),
            "service_features": [
                name for name in ["sim_tray_keepout", "sim_tray_outline", "service_label_recess"] if name in by_name
            ],
        },
        "pcb_battery_non_overlap": {
            "pass": min(pcb_segment_gaps) >= 0.5,
            "minimum_segment_gap_mm": round(min(pcb_segment_gaps), 3),
            "segment_gaps_mm": [round(gap, 3) for gap in pcb_segment_gaps],
            "note": "Checks each rigid PCB island against the battery window.",
        },
        "injection_molding_basics": {
            "pass": params["manufacturing"]["nominal_draft_deg"] >= 1.5
            and params["manufacturing"]["min_internal_radius_mm"] >= 0.5,
            "draft_deg": params["manufacturing"]["nominal_draft_deg"],
            "min_internal_radius_mm": params["manufacturing"]["min_internal_radius_mm"],
            "gate_strategy": params["manufacturing"]["gate_strategy"],
        },
        "molded_retention_features": {
            "pass": boss_count == params["manufacturing"]["screw_boss_count"]
            and snap_count == params["manufacturing"]["snap_hook_count"]
            and params["manufacturing"]["rib_thickness_mm"] <= 0.75 * params["device"]["wall_thickness_mm"],
            "screw_boss_count": boss_count,
            "snap_hook_count": snap_count,
            "rib_to_wall_ratio": round(
                params["manufacturing"]["rib_thickness_mm"] / params["device"]["wall_thickness_mm"],
                3,
            ),
        },
        "mold_runner_gate_model": {
            "pass": {
                "mold_sprue_bushing",
                "mold_primary_runner",
                "mold_left_submarine_gate",
                "mold_right_submarine_gate",
                "mold_parting_line_reference",
            }.issubset(tooling_names)
            and params["manufacturing"]["gate_thickness_mm"] <= 0.9
            and params["manufacturing"]["runner_diameter_mm"] >= 2.0,
            "sprue_diameter_mm": params["manufacturing"]["sprue_diameter_mm"],
            "runner_diameter_mm": params["manufacturing"]["runner_diameter_mm"],
            "gate_thickness_mm": params["manufacturing"]["gate_thickness_mm"],
        },
        "mold_ejector_cooling_model": {
            "pass": ejector_count == params["manufacturing"]["ejector_pin_count"]
            and cooling_count >= 3
            and params["manufacturing"]["cooling_channel_clearance_mm"] >= 6.0,
            "ejector_pin_count": ejector_count,
            "cooling_channel_count": cooling_count,
            "cooling_channel_diameter_mm": params["manufacturing"]["cooling_channel_diameter_mm"],
            "cooling_channel_clearance_mm": params["manufacturing"]["cooling_channel_clearance_mm"],
        },
        "final_assembly_excludes_tooling_markers": {
            "pass": not final_assembly_has_tooling,
            "tooling_marker_count": sum(
                1 for part in parts if part.role in {"tooling", "tooling clearance"}
            ),
        },
        "kicad_outline_integration": {
            "pass": kicad_outline is not None
            and abs(kicad_outline[0] - pcb["outline_mm"][0]) <= 0.05
            and abs(kicad_outline[1] - pcb["outline_mm"][1]) <= 0.05,
            "kicad_edge_cuts_mm": kicad_outline,
            "cad_pcb_outline_mm": pcb["outline_mm"][:2],
            "source": pcb["source"],
        },
        "device_compactness": {
            "pass": width <= 78.5 and height <= 154.0 and depth <= 10.0,
            "envelope_mm": [width, height, depth],
            "note": "Envelope is driven by 77.1 x 151.77 mm commodity CTP outline plus orange side rail.",
        },
        "mass_budget": {
            "pass": mass["total_estimated_mass_g"] <= params["device"]["target_mass_g"],
            "estimated_mass_g": mass["total_estimated_mass_g"],
            "target_mass_g": params["device"]["target_mass_g"],
            "note": "Rough CAD estimate; placeholder void markers excluded.",
        },
    }
    return {
        "status": "pass" if all(item["pass"] for item in checks.values()) else "blocked",
        "checks": checks,
    }


def write_report(params: dict[str, Any], checks: dict[str, Any]) -> None:
    report = {
        "claim_boundary": "EVT0 mechanical concept; not released tooling CAD or fabricated hardware.",
        "params": params,
        "checks": checks,
        "artifacts": {
            "assembly_glb": "mechanical/e1-phone/out/e1-phone-assembly.glb",
            "tooling_glb": "mechanical/e1-phone/out/e1-phone-mold-tooling.glb",
            "manifest": "mechanical/e1-phone/out/assembly-manifest.json",
            "tooling_manifest": "mechanical/e1-phone/out/tooling-manifest.json",
            "manufacturing_drawing_png": "mechanical/e1-phone/review/manufacturing_drawing.png",
            "manufacturing_drawing_svg": "mechanical/e1-phone/review/manufacturing_drawing.svg",
            "manufacturing_drawing_json": "mechanical/e1-phone/review/manufacturing_drawing.json",
            "manufacturing_readiness_json": "mechanical/e1-phone/review/manufacturing-readiness.json",
            "manufacturing_readiness_md": "mechanical/e1-phone/review/manufacturing-readiness.md",
            "mass_budget_json": "mechanical/e1-phone/review/mass-budget.json",
            "mass_budget_md": "mechanical/e1-phone/review/mass-budget.md",
            "supplier_lock_json": "mechanical/e1-phone/review/supplier-lock.json",
            "supplier_lock_md": "mechanical/e1-phone/review/supplier-lock.md",
            "kicad_mechanical_handoff_json": "mechanical/e1-phone/review/kicad-mechanical-handoff.json",
            "kicad_mechanical_handoff_md": "mechanical/e1-phone/review/kicad-mechanical-handoff.md",
            "renders": [
                "mechanical/e1-phone/review/full_front_iso.png",
                "mechanical/e1-phone/review/full_back_iso.png",
                "mechanical/e1-phone/review/full_left_side.png",
                "mechanical/e1-phone/review/full_bottom_port.png",
                "mechanical/e1-phone/review/full_top_down.png",
                "mechanical/e1-phone/review/exploded_iso.png",
                "mechanical/e1-phone/review/component_stack.png",
                "mechanical/e1-phone/review/mold_tooling.png",
            ],
        },
    }
    (REVIEW_DIR / "fit-check-report.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone EVT0 Mechanical CAD Review",
        "",
        "Status: automated EVT0 concept generation, not tooling release.",
        "",
        "## Generated Artifacts",
        "",
        "- `mechanical/e1-phone/out/e1-phone-assembly.glb`",
        "- `mechanical/e1-phone/out/e1-phone-mold-tooling.glb`",
        "- `mechanical/e1-phone/out/*.obj` and `*.stl` per component",
        "- `mechanical/e1-phone/review/manufacturing_drawing.png`",
        "- `mechanical/e1-phone/review/manufacturing_drawing.svg`",
        "- `mechanical/e1-phone/review/manufacturing_drawing.json`",
        "- `mechanical/e1-phone/review/manufacturing-readiness.json`",
        "- `mechanical/e1-phone/review/manufacturing-readiness.md`",
        "- `mechanical/e1-phone/review/mass-budget.json`",
        "- `mechanical/e1-phone/review/mass-budget.md`",
        "- `mechanical/e1-phone/review/supplier-lock.json`",
        "- `mechanical/e1-phone/review/supplier-lock.md`",
        "- `mechanical/e1-phone/review/kicad-mechanical-handoff.json`",
        "- `mechanical/e1-phone/review/kicad-mechanical-handoff.md`",
        "- `mechanical/e1-phone/review/full_front_iso.png`",
        "- `mechanical/e1-phone/review/full_back_iso.png`",
        "- `mechanical/e1-phone/review/full_left_side.png`",
        "- `mechanical/e1-phone/review/full_bottom_port.png`",
        "- `mechanical/e1-phone/review/full_top_down.png`",
        "- `mechanical/e1-phone/review/exploded_iso.png`",
        "- `mechanical/e1-phone/review/component_stack.png`",
        "- `mechanical/e1-phone/review/mold_tooling.png`",
        "- `mechanical/e1-phone/review/visual-review.json`",
        "- `mechanical/e1-phone/review/fit-check-report.json`",
        "",
        "## Fit Checks",
        "",
    ]
    for name, check in checks["checks"].items():
        result = "PASS" if check["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{name}`")
    lines.extend(
        [
            "",
            "## Manufacturing Notes",
            "",
            f"- Plastic: {params['manufacturing']['plastic']}.",
            f"- Nominal draft: {params['manufacturing']['nominal_draft_deg']} degrees.",
            f"- Gate strategy: {params['manufacturing']['gate_strategy']}.",
            f"- Parting line: {params['manufacturing']['parting_line']}.",
            f"- Sprue diameter: {params['manufacturing']['sprue_diameter_mm']} mm.",
            f"- Runner diameter: {params['manufacturing']['runner_diameter_mm']} mm.",
            f"- Gate thickness: {params['manufacturing']['gate_thickness_mm']} mm.",
            f"- Estimated CAD mass: {mass_budget(build_parts(params))['total_estimated_mass_g']} g.",
            "",
            "## Design Decisions From This Pass",
            "",
            "- The envelope is widened to 78.0 mm because the selected commodity touch panel is 77.1 mm wide; a 72 mm device envelope contradicts that supplier outline unless the display anchor changes.",
            "- Front camera and earpiece are kept behind the cover glass where practical. The rear camera stays exposed through a back lens window because the available AF module stack is too tall for full under-glass placement in a 9.6 mm phone.",
            "- Orange hard plastic is modeled as the entire molded shell and button material. The black glass remains a separate bonded part.",
            "- The enclosure now includes six screw bosses, eight snap hooks, battery ribs, a USB-C insertion saddle, display adhesive, display FPC connector keepout, and explicit cold-runner/submarine-gate placeholders for mold review.",
            "- The exterior shell and cover glass now use rounded-rectangle geometry tied to the 7.5 mm corner-radius parameter instead of square block placeholders.",
        ]
    )
    (REVIEW_DIR / "README.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    params = load_params()
    parts = build_parts(params, exploded=False)
    exploded = build_parts(params, exploded=True)
    tooling = tooling_parts(params)
    export_meshes(parts)
    export_named_scene(tooling, "e1-phone-mold-tooling.glb", "tooling-manifest.json")
    render_paths = [
        REVIEW_DIR / "full_front_iso.png",
        REVIEW_DIR / "full_back_iso.png",
        REVIEW_DIR / "full_left_side.png",
        REVIEW_DIR / "full_bottom_port.png",
        REVIEW_DIR / "full_top_down.png",
        REVIEW_DIR / "exploded_iso.png",
        REVIEW_DIR / "component_stack.png",
        REVIEW_DIR / "mold_tooling.png",
    ]
    render(parts, render_paths[0], "E1 phone full assembly, front", 22, -56)
    render(parts, render_paths[1], "E1 phone full assembly, back", 24, 124)
    render(parts, render_paths[2], "E1 phone left side buttons", 8, 180)
    _width, height, _depth = params["device"]["envelope_mm"]
    bottom_detail = [
        box(
            "bottom_edge_review_section",
            [60.0, 1.25, 6.0],
            [0.0, -height / 2 + 0.625, -1.4],
            ORANGE,
            "review",
            "bottom edge local review section",
        ),
        *[
            p
            for p in parts
            if p.name.startswith("usb_c")
            or p.name.startswith("bottom_speaker_grille_slot_")
            or p.name.startswith("bottom_microphone_port_")
        ],
    ]
    render(bottom_detail, render_paths[3], "E1 phone bottom USB-C, speaker, mics", 8, -90)
    render(parts, render_paths[4], "E1 phone top-down footprint", 82, -90)
    render(exploded, render_paths[5], "E1 phone exploded stack", 20, -54)
    component_parts = [
        p
        for p in parts
        if p.role in {"PCB", "camera", "audio", "I/O", "button", "battery", "connector"}
    ]
    render(component_parts, render_paths[6], "E1 phone component placement", 74, -88)
    render(
        [*tooling, *[p for p in parts if p.name in {"orange_back_shell", "orange_side_frame"}]],
        render_paths[7],
        "E1 phone mold runner and parting review",
        28,
        -55,
    )
    visual = verify_render_artifacts(render_paths)
    checks = run_checks(params, parts)
    mass = write_mass_budget(parts)
    write_drafting_artifacts(params, checks)
    supplier = write_supplier_artifacts(params)
    handoff = write_kicad_mechanical_handoff(params, checks)
    write_readiness_artifacts(params, parts, tooling, checks, visual, mass, supplier, handoff)
    write_report(params, checks)
    print(f"E1 phone CAD generation {checks['status']}: {REVIEW_DIR / 'README.md'}")
    return 0 if checks["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
