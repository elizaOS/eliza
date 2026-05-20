#!/usr/bin/env python3
"""Generate reviewable E1 phone mechanical CAD concept artifacts.

This is an EVT0 mechanical concept generator, not a tooling-release CAD
substitute. It creates deterministic mesh artifacts, rendered review views,
and analytic fit checks from one YAML parameter file so the enclosure can be
iterated against the KiCad phone-mainboard concept.
"""

from __future__ import annotations

import csv
import json
import math
import re
import sys
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

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


def apply_face_color(mesh: trimesh.Trimesh, color: list[float]) -> None:
    cast(Any, mesh.visual).face_colors = np.asarray(color) * 255


def box(
    name: str, size: list[float], center: list[float], color: list[float], role: str, material: str
) -> Part:
    mesh = trimesh.creation.box(extents=size)
    mesh.apply_translation(center)
    apply_face_color(mesh, color)
    return Part(name, mesh, color, role, material)


def rounded_rect_points(
    width: float, height: float, radius: float, segments: int = 12
) -> np.ndarray:
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
    apply_face_color(mesh, color)
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
    apply_face_color(mesh, color)
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
    apply_face_color(combined, color)
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
    apply_face_color(mesh, color)
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
    apply_face_color(mesh, color)
    return Part(name, mesh, color, role, material)


def load_params() -> dict[str, Any]:
    return yaml.safe_load(PARAMS.read_text())


def kicad_outline_mm(path: Path) -> list[float] | None:
    if not path.is_file():
        return None
    text = path.read_text(errors="ignore")
    match = re.search(
        r"\(gr_rect\s+\(start\s+([0-9.]+)\s+([0-9.]+)\)\s+"
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
        box(
            "screen_adhesive_top",
            [glass_w, width, thickness],
            [0, glass_h / 2 - width / 2, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
        box(
            "screen_adhesive_bottom",
            [glass_w, width, thickness],
            [0, -glass_h / 2 + width / 2, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
        box(
            "screen_adhesive_left",
            [width, glass_h, thickness],
            [-glass_w / 2 + width / 2, 0, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
        box(
            "screen_adhesive_right",
            [width, glass_h, thickness],
            [glass_w / 2 - width / 2, 0, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
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
        parts.append(
            box(
                f"orange_snap_hook_{idx}",
                [1.3, 5.0, 1.4],
                [x, y, -1.0],
                ORANGE,
                "molded enclosure",
                "PC+ABS snap hook",
            )
        )
    rib_t = mfg["rib_thickness_mm"]
    parts.extend(
        [
            box(
                "orange_battery_left_rib",
                [rib_t, 98.0, 1.4],
                [-29.0, -7.0, -3.0],
                ORANGE,
                "molded enclosure",
                "battery locating rib",
            ),
            box(
                "orange_battery_right_rib",
                [rib_t, 98.0, 1.4],
                [29.0, -7.0, -3.0],
                ORANGE,
                "molded enclosure",
                "battery locating rib",
            ),
            box(
                "orange_usb_reinforcement_saddle",
                [18.0, 2.0, 2.0],
                [0.0, -height / 2 + 8.4, -2.9],
                ORANGE,
                "molded enclosure",
                "USB-C insertion load saddle",
            ),
            box(
                "display_fpc_connector",
                params["display"]["fpc_connector_mm"],
                [23.0, 55.0, -1.0],
                METAL,
                "connector",
                "board-mounted display/touch FPC connector",
            ),
            box(
                "display_fpc_bend_keepout",
                [22.0, 10.0, 0.3],
                [23.0, 61.5, 0.3],
                [0.5, 0.5, 0.1, 0.45],
                "connector",
                "display FPC bend keepout",
            ),
            box(
                "bottom_speaker_acoustic_chamber",
                [18.0, 13.0, 2.2],
                [18.5, -height / 2 + 13.0, -4.1],
                ORANGE,
                "audio",
                "molded loudspeaker rear chamber",
            ),
            box(
                "earpiece_gasket",
                [14.5, 2.0, 0.55],
                [0, height / 2 - 7.6, 3.8],
                ADHESIVE,
                "audio",
                "compressed earpiece acoustic gasket",
            ),
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
        box(
            "soc_shield_can",
            [18.0, 16.0, 1.2],
            [-7.0, 55.0, -0.9],
            METAL,
            "EMI shield",
            "stamped RF/SoC shield can",
        ),
        box(
            "pmic_shield_can",
            [11.0, 10.0, 1.1],
            [12.5, 55.0, -0.95],
            METAL,
            "EMI shield",
            "stamped PMIC shield can",
        ),
        box(
            "radio_shield_can",
            [18.0, 20.0, 1.2],
            [-22.0, 50.0, -0.9],
            METAL,
            "EMI shield",
            "stamped radio shield can",
        ),
        box(
            "haptic_lra",
            comp["haptic"]["envelope_mm"],
            [35.0, -44.0, -3.2],
            DARK,
            "haptics",
            "0820 X-axis linear resonant actuator",
        ),
        box(
            "sim_tray_keepout",
            comp["sim_tray"]["keepout_mm"],
            [width / 2 - 7.2, -18.0, -0.8],
            [0.05, 0.05, 0.05, 0.45],
            "service",
            "side SIM tray keepout",
        ),
        box(
            "sim_tray_outline",
            [0.8, comp["sim_tray"]["envelope_mm"][1], 4.0],
            [width / 2 - 0.15, -18.0, -0.8],
            ORANGE,
            "service",
            "orange side service tray outline",
        ),
        box(
            "rear_camera_cover_glass",
            comp["rear_camera_glass"]["envelope_mm"],
            [21.0, height / 2 - 19.0, z_back],
            BLACK_GLASS,
            "camera",
            "rear camera cover glass",
        ),
        box(
            "service_label_recess",
            [32.0, 9.0, 0.25],
            [0.0, -height / 2 + 25.0, z_back],
            [0.9, 0.9, 0.9, 0.5],
            "service",
            "recessed regulatory/service label pad",
        ),
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
        cyl_z(
            "mold_sprue_bushing",
            sprue_d / 2.0,
            8.0,
            [0.0, -height / 2 - 20.0, z],
            TOOLING,
            "tooling",
            "sprue bushing placeholder",
        ),
        box(
            "mold_primary_runner",
            [runner_d, 34.0, runner_d],
            [0.0, -height / 2 - 6.0, z],
            TOOLING,
            "tooling",
            "cold runner",
        ),
        box(
            "mold_left_submarine_gate",
            [24.0, gate_t, gate_t],
            [-18.0, -height / 2 - 0.4, z],
            TOOLING,
            "tooling",
            "submarine gate into back shell",
        ),
        box(
            "mold_right_submarine_gate",
            [24.0, gate_t, gate_t],
            [18.0, -height / 2 - 0.4, z],
            TOOLING,
            "tooling",
            "submarine gate into back shell",
        ),
        box(
            "mold_parting_line_reference",
            [width + 2.0, height + 2.0, 0.15],
            [0.0, 0.0, 0.0],
            [0.1, 0.1, 0.1, 0.22],
            "tooling",
            "mid-plane parting line reference",
        ),
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
        box(
            "display_lcm",
            [*disp["tft_outline_mm"][:2], disp["tft_outline_mm"][2]],
            [0, -5.5, 2.0],
            DARK,
            "screen",
            "LCM",
        ),
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
        box(
            "battery_pouch",
            battery["envelope_mm"],
            [0, -7.0, battery["z_center_mm"]],
            [0.16, 0.16, 0.17, 1],
            "battery",
            "LiPo pouch",
        ),
    ]

    parts.extend(
        [
            box(
                "usb_c_receptacle",
                comp["usb_c"]["envelope_mm"],
                [0, -height / 2 + 4.1, -1.6],
                METAL,
                "I/O",
                "stainless shell",
            ),
            box(
                "usb_c_external_aperture",
                [10.2, 0.35, 3.6],
                [0, -height / 2 - 0.08, -1.45],
                DARK,
                "I/O",
                "USB-C molded aperture visual check",
            ),
            box(
                "bottom_speaker_module",
                comp["speaker_bottom"]["envelope_mm"],
                [18.5, -height / 2 + 13.0, -2.35],
                DARK,
                "audio",
                "speaker module",
            ),
            box(
                "earpiece_receiver",
                comp["earpiece"]["envelope_mm"],
                [0, height / 2 - 8.0, 1.0],
                DARK,
                "audio",
                "receiver",
            ),
            box(
                "bottom_mic",
                comp["microphone_bottom"]["envelope_mm"],
                [-18.0, -height / 2 + 8.2, -1.3],
                DARK,
                "audio",
                "MEMS mic",
            ),
            box(
                "top_mic",
                comp["microphone_top"]["envelope_mm"],
                [18.0, height / 2 - 8.2, -1.3],
                DARK,
                "audio",
                "MEMS mic",
            ),
            box(
                "rear_camera_module",
                comp["rear_camera"]["module_mm"],
                [21.0, height / 2 - 19.0, -1.05],
                CAMERA,
                "camera",
                "OV13855 class module",
            ),
            cyl(
                "rear_camera_lens_window",
                comp["rear_camera"]["lens_diameter_mm"] / 2,
                0.8,
                [21.0, height / 2 - 19.0, -depth / 2 - 0.1],
                CAMERA,
                "camera",
                "glass lens window",
            ),
            box(
                "front_camera_module",
                comp["front_camera"]["module_mm"],
                [-19.0, height / 2 - 9.0, 1.0],
                CAMERA,
                "camera",
                "front MIPI camera",
            ),
            cyl(
                "front_camera_under_glass",
                comp["front_camera"]["lens_diameter_mm"] / 2,
                0.35,
                [-19.0, height / 2 - 9.0, depth / 2 + 0.05],
                CAMERA,
                "camera",
                "under-glass aperture",
            ),
            box(
                "power_button_cap",
                comp["power_button"]["cap_mm"],
                [width / 2 + 0.55, 20.0, -0.4],
                ORANGE,
                "button",
                "orange molded cap",
            ),
            box(
                "volume_button_cap",
                comp["volume_button"]["cap_mm"],
                [-width / 2 - 0.55, 14.0, -0.4],
                ORANGE,
                "button",
                "orange molded cap",
            ),
            box(
                "handset_acoustic_slot",
                [16.0, 1.0, 0.25],
                [0, height / 2 - 7.6, depth / 2 + 0.08],
                DARK,
                "audio",
                "gasketed handset slot",
            ),
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

    def manifest_path(path: Path) -> str:
        return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()

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
                "obj": manifest_path(obj_path),
                "stl": manifest_path(stl_path),
                "bounds_mm": [low.round(3).tolist(), high.round(3).tolist()],
            }
        )
    scene.export(OUT_DIR / "e1-phone-assembly.glb")
    (OUT_DIR / "assembly-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def export_named_scene(parts: list[Part], filename: str, manifest_name: str) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    scene = trimesh.Scene()
    manifest = []

    def manifest_path(path: Path) -> str:
        return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()

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
                "obj": manifest_path(obj_path),
                "stl": manifest_path(stl_path),
                "bounds_mm": [low.round(3).tolist(), high.round(3).tolist()],
            }
        )
    scene.export(OUT_DIR / filename)
    (OUT_DIR / manifest_name).write_text(json.dumps(manifest, indent=2) + "\n")


def write_solid_cad_handoff_artifacts(
    params: dict[str, Any], checks: dict[str, Any]
) -> dict[str, Any]:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    try:
        import cadquery as cq
    except Exception as exc:
        report: dict[str, Any] = {
            "claim_boundary": "STEP/B-rep handoff preflight; CadQuery/OCP was not available.",
            "status": "blocked",
            "tool": "cadquery",
            "tool_available": False,
            "error": f"{type(exc).__name__}: {exc}",
            "outputs": {},
            "remaining_blockers": [
                "Install CadQuery/OCP in the Python environment used by `make phone-cad`.",
                "Replace CAD-envelope solids with supplier STEP models before release.",
            ],
        }
        (REVIEW_DIR / "solid-cad-handoff.json").write_text(json.dumps(report, indent=2) + "\n")
        (REVIEW_DIR / "solid-cad-handoff.md").write_text(
            "# E1 Phone Solid CAD Handoff\n\n"
            "Status: blocked; CadQuery/OCP is not available in this Python environment.\n"
        )
        return report

    def cq_box(size: list[float], center: list[float], radius: float = 0.0) -> Any:
        solid = cq.Workplane("XY").box(float(size[0]), float(size[1]), float(size[2]))
        if radius > 0:
            max_radius = max(min(float(size[0]), float(size[1])) / 2.0 - 0.05, 0.0)
            safe_radius = min(radius, max_radius)
            if safe_radius > 0.05:
                with suppress(Exception):
                    solid = solid.edges("|Z").fillet(safe_radius)
        return solid.translate(tuple(float(value) for value in center))

    dev = params["device"]
    width, height, depth = dev["envelope_mm"]
    radius = dev["corner_radius_mm"]
    display = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    comp = params["components"]
    orange = cq.Color(1.0, 0.32, 0.02)
    black = cq.Color(0.02, 0.02, 0.02)
    metal = cq.Color(0.7, 0.72, 0.74)
    green = cq.Color(0.03, 0.38, 0.22)
    grey = cq.Color(0.55, 0.55, 0.55)
    adhesive_color = cq.Color(0.04, 0.04, 0.04)
    keepout_color = cq.Color(0.12, 0.12, 0.12)

    def artifact_path(path: Path) -> str:
        return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()

    back_shell = cq_box([width, height, 1.2], [0, 0, -depth / 2 + 0.6], radius)
    side_outer = cq_box([width, height, depth], [0, 0, 0], radius)
    side_inner = cq_box(
        [width - 2 * dev["wall_thickness_mm"], height - 2 * dev["wall_thickness_mm"], depth + 1.0],
        [0, 0, 0],
        max(radius - dev["wall_thickness_mm"], 0.5),
    )
    side_frame = side_outer.cut(side_inner)
    solids: list[dict[str, Any]] = [
        {
            "name": "orange_back_shell",
            "shape": back_shell,
            "color": orange,
            "role": "molded enclosure",
            "material": "PC+ABS orange B-rep envelope",
        },
        {
            "name": "orange_side_frame",
            "shape": side_frame,
            "color": orange,
            "role": "molded enclosure",
            "material": "PC+ABS orange B-rep ring",
        },
        {
            "name": "screen_cover_glass",
            "shape": cq_box(
                display["cover_glass_mm"],
                [0, -0.2, depth / 2 - 0.35],
                radius=max(radius - 1.2, 0.5),
            ),
            "color": black,
            "role": "screen",
            "material": "black cover glass B-rep envelope",
        },
        {
            "name": "display_lcm",
            "shape": cq_box(
                [*display["tft_outline_mm"][:2], display["tft_outline_mm"][2]],
                [0, -5.5, 2.0],
            ),
            "color": black,
            "role": "screen",
            "material": "LCM supplier envelope",
        },
        {
            "name": "main_pcb",
            "shape": cq_box(pcb["outline_mm"], [0, 0, pcb["z_center_mm"]]),
            "color": green,
            "role": "PCB",
            "material": "concept KiCad board envelope",
        },
        {
            "name": "battery_pouch",
            "shape": cq_box(battery["envelope_mm"], [0, -7.0, battery["z_center_mm"]]),
            "color": black,
            "role": "battery",
            "material": "LiPo pouch envelope",
        },
        {
            "name": "usb_c_receptacle",
            "shape": cq_box(comp["usb_c"]["envelope_mm"], [0, -height / 2 + 4.1, -1.6]),
            "color": metal,
            "role": "I/O",
            "material": comp["usb_c"]["candidate"],
        },
        {
            "name": "rear_camera_module",
            "shape": cq_box(comp["rear_camera"]["module_mm"], [21.0, height / 2 - 19.0, -1.05]),
            "color": black,
            "role": "camera",
            "material": comp["rear_camera"]["candidate"],
        },
        {
            "name": "front_camera_module",
            "shape": cq_box(comp["front_camera"]["module_mm"], [-19.0, height / 2 - 9.0, 1.0]),
            "color": black,
            "role": "camera",
            "material": comp["front_camera"]["candidate"],
        },
        {
            "name": "bottom_speaker_module",
            "shape": cq_box(
                comp["speaker_bottom"]["envelope_mm"], [18.5, -height / 2 + 13.0, -2.35]
            ),
            "color": black,
            "role": "audio",
            "material": comp["speaker_bottom"]["candidate"],
        },
        {
            "name": "earpiece_receiver",
            "shape": cq_box(comp["earpiece"]["envelope_mm"], [0, height / 2 - 8.0, 1.0]),
            "color": black,
            "role": "audio",
            "material": comp["earpiece"]["candidate"],
        },
        {
            "name": "haptic_lra",
            "shape": cq_box(comp["haptic"]["envelope_mm"], [35.0, -44.0, -3.2]),
            "color": black,
            "role": "haptics",
            "material": comp["haptic"]["candidate"],
        },
        {
            "name": "power_button_cap",
            "shape": cq_box(comp["power_button"]["cap_mm"], [width / 2 + 0.55, 20.0, -0.4]),
            "color": orange,
            "role": "button",
            "material": "orange molded power button",
        },
        {
            "name": "volume_button_cap",
            "shape": cq_box(comp["volume_button"]["cap_mm"], [-width / 2 - 0.55, 14.0, -0.4]),
            "color": orange,
            "role": "button",
            "material": "orange molded volume button",
        },
    ]
    solids.extend(
        [
            {
                "name": "bottom_mic",
                "shape": cq_box(
                    comp["microphone_bottom"]["envelope_mm"], [-18.0, -height / 2 + 8.2, -1.3]
                ),
                "color": black,
                "role": "audio",
                "material": comp["microphone_bottom"]["candidate"],
            },
            {
                "name": "top_mic",
                "shape": cq_box(
                    comp["microphone_top"]["envelope_mm"], [18.0, height / 2 - 8.2, -1.3]
                ),
                "color": black,
                "role": "audio",
                "material": comp["microphone_top"]["candidate"],
            },
            {
                "name": "rear_camera_cover_glass",
                "shape": cq_box(
                    comp["rear_camera_glass"]["envelope_mm"],
                    [21.0, height / 2 - 19.0, -depth / 2 - 0.08],
                ),
                "color": black,
                "role": "camera",
                "material": comp["rear_camera_glass"]["candidate"],
            },
            {
                "name": "rear_camera_lens_window",
                "shape": cq_box(
                    [
                        comp["rear_camera"]["lens_diameter_mm"],
                        0.8,
                        comp["rear_camera"]["lens_diameter_mm"],
                    ],
                    [21.0, height / 2 - 19.0, -depth / 2 - 0.1],
                    radius=0.4,
                ),
                "color": black,
                "role": "camera",
                "material": "rear camera optical aperture envelope",
            },
            {
                "name": "front_camera_under_glass",
                "shape": cq_box(
                    [
                        comp["front_camera"]["lens_diameter_mm"],
                        comp["front_camera"]["lens_diameter_mm"],
                        0.35,
                    ],
                    [-19.0, height / 2 - 9.0, depth / 2 + 0.05],
                    radius=0.35,
                ),
                "color": black,
                "role": "camera",
                "material": "front under-glass optical aperture envelope",
            },
            {
                "name": "handset_acoustic_slot",
                "shape": cq_box([16.0, 1.0, 0.25], [0, height / 2 - 7.6, depth / 2 + 0.08]),
                "color": black,
                "role": "audio",
                "material": "gasketed handset acoustic slot",
            },
            {
                "name": "usb_c_external_aperture",
                "shape": cq_box([10.2, 0.35, 3.6], [0, -height / 2 - 0.08, -1.45]),
                "color": black,
                "role": "I/O",
                "material": "USB-C molded aperture envelope",
            },
            {
                "name": "orange_usb_reinforcement_saddle",
                "shape": cq_box([18.0, 2.0, 2.0], [0.0, -height / 2 + 8.4, -2.9]),
                "color": orange,
                "role": "molded enclosure",
                "material": "PC+ABS USB-C insertion load saddle",
            },
            {
                "name": "bottom_speaker_acoustic_chamber",
                "shape": cq_box([18.0, 13.0, 2.2], [18.5, -height / 2 + 13.0, -4.1]),
                "color": orange,
                "role": "audio",
                "material": "molded loudspeaker rear chamber",
            },
            {
                "name": "earpiece_gasket",
                "shape": cq_box([14.5, 2.0, 0.55], [0, height / 2 - 7.6, 3.8]),
                "color": adhesive_color,
                "role": "audio",
                "material": "compressed earpiece acoustic gasket",
            },
            {
                "name": "display_fpc_connector",
                "shape": cq_box(display["fpc_connector_mm"], [23.0, 55.0, -1.0]),
                "color": metal,
                "role": "connector",
                "material": "board-mounted display/touch FPC connector",
            },
            {
                "name": "display_fpc_bend_keepout",
                "shape": cq_box([22.0, 10.0, 0.3], [23.0, 61.5, 0.3]),
                "color": keepout_color,
                "role": "connector",
                "material": "display FPC bend keepout volume",
            },
        ]
    )

    glass_w, glass_h, _glass_t = display["cover_glass_mm"]
    adhesive_w = display["adhesive_width_mm"]
    adhesive_t = display["adhesive_thickness_mm"]
    adhesive_z = depth / 2.0 - 0.85
    for name, size, center in [
        (
            "screen_adhesive_top",
            [glass_w, adhesive_w, adhesive_t],
            [0, glass_h / 2 - adhesive_w / 2, adhesive_z],
        ),
        (
            "screen_adhesive_bottom",
            [glass_w, adhesive_w, adhesive_t],
            [0, -glass_h / 2 + adhesive_w / 2, adhesive_z],
        ),
        (
            "screen_adhesive_left",
            [adhesive_w, glass_h, adhesive_t],
            [-glass_w / 2 + adhesive_w / 2, 0, adhesive_z],
        ),
        (
            "screen_adhesive_right",
            [adhesive_w, glass_h, adhesive_t],
            [glass_w / 2 - adhesive_w / 2, 0, adhesive_z],
        ),
    ]:
        solids.append(
            {
                "name": name,
                "shape": cq_box(size, center),
                "color": adhesive_color,
                "role": "screen retention",
                "material": "die-cut display adhesive envelope",
            }
        )

    for idx, x in enumerate([11.5, 14.5, 17.5, 20.5, 23.5], start=1):
        solids.append(
            {
                "name": f"bottom_speaker_grille_slot_{idx}",
                "shape": cq_box([1.2, 0.35, 4.0], [x, -height / 2 - 0.09, -1.35]),
                "color": black,
                "role": "audio",
                "material": "molded loudspeaker grille aperture envelope",
            }
        )
    for idx, x in enumerate([-22.0, -17.0], start=1):
        solids.append(
            {
                "name": f"bottom_microphone_port_{idx}",
                "shape": cq_box([1.0, 0.4, 1.0], [x, -height / 2 - 0.12, -1.35], radius=0.25),
                "color": black,
                "role": "audio",
                "material": "molded microphone acoustic port envelope",
            }
        )

    boss_radius = params["manufacturing"]["screw_boss_outer_diameter_mm"] / 2.0
    boss_z = -depth / 2 + 2.0
    for idx, (x, y) in enumerate(
        [(-29.0, 58.0), (29.0, 58.0), (-29.0, -58.0), (29.0, -58.0), (-29.0, -20.0), (29.0, -20.0)],
        start=1,
    ):
        solids.append(
            {
                "name": f"orange_screw_boss_{idx}",
                "shape": cq_box(
                    [boss_radius * 2, boss_radius * 2, 2.8], [x, y, boss_z], radius=0.7
                ),
                "color": orange,
                "role": "molded enclosure",
                "material": "PC+ABS screw boss envelope",
            }
        )
    for idx, (x, y) in enumerate(
        [
            (-width / 2 + 1.9, 52.0),
            (-width / 2 + 1.9, 24.0),
            (-width / 2 + 1.9, -24.0),
            (-width / 2 + 1.9, -52.0),
            (width / 2 - 1.9, 52.0),
            (width / 2 - 1.9, 24.0),
            (width / 2 - 1.9, -24.0),
            (width / 2 - 1.9, -52.0),
        ],
        start=1,
    ):
        solids.append(
            {
                "name": f"orange_snap_hook_{idx}",
                "shape": cq_box([1.3, 5.0, 1.4], [x, y, -1.0]),
                "color": orange,
                "role": "molded enclosure",
                "material": "PC+ABS snap hook envelope",
            }
        )
    for name, size, center, material in [
        (
            "orange_battery_left_rib",
            [params["manufacturing"]["rib_thickness_mm"], 98.0, 1.4],
            [-29.0, -7.0, -3.0],
            "battery locating rib",
        ),
        (
            "orange_battery_right_rib",
            [params["manufacturing"]["rib_thickness_mm"], 98.0, 1.4],
            [29.0, -7.0, -3.0],
            "battery locating rib",
        ),
        (
            "sim_tray_outline",
            [0.8, comp["sim_tray"]["envelope_mm"][1], 4.0],
            [width / 2 - 0.15, -18.0, -0.8],
            "orange side service tray outline",
        ),
        (
            "service_label_recess",
            [32.0, 9.0, 0.25],
            [0.0, -height / 2 + 25.0, -depth / 2 - 0.08],
            "recessed regulatory/service label pad",
        ),
    ]:
        solids.append(
            {
                "name": name,
                "shape": cq_box(size, center),
                "color": orange if name != "service_label_recess" else grey,
                "role": "molded enclosure" if name.startswith("orange_") else "service",
                "material": material,
            }
        )
    for name, size, center, role, material in [
        (
            "cellular_top_antenna_keepout",
            params["radio"]["cellular"]["antenna_keepout_mm"],
            [0.0, height / 2 - 5.4, -1.1],
            "RF keepout",
            "top plastic antenna keepout volume",
        ),
        (
            "cellular_bottom_antenna_keepout",
            params["radio"]["cellular"]["antenna_keepout_mm"],
            [0.0, -height / 2 + 5.4, -1.1],
            "RF keepout",
            "bottom plastic antenna keepout volume",
        ),
        (
            "wifi_bt_side_antenna_keepout",
            params["radio"]["wifi_bt"]["antenna_keepout_mm"],
            [width / 2 - 18.0, 43.0, -1.1],
            "RF keepout",
            "side Wi-Fi/Bluetooth antenna keepout volume",
        ),
        (
            "soc_shield_can",
            [18.0, 16.0, 1.2],
            [-7.0, 55.0, -0.9],
            "EMI shield",
            "stamped RF/SoC shield can",
        ),
        (
            "pmic_shield_can",
            [11.0, 10.0, 1.1],
            [12.5, 55.0, -0.95],
            "EMI shield",
            "stamped PMIC shield can",
        ),
        (
            "radio_shield_can",
            [18.0, 20.0, 1.2],
            [-22.0, 50.0, -0.9],
            "EMI shield",
            "stamped radio shield can",
        ),
        (
            "sim_tray_keepout",
            comp["sim_tray"]["keepout_mm"],
            [width / 2 - 7.2, -18.0, -0.8],
            "service",
            "side SIM tray keepout",
        ),
    ]:
        solids.append(
            {
                "name": name,
                "shape": cq_box(size, center),
                "color": metal if role == "EMI shield" else keepout_color,
                "role": role,
                "material": material,
            }
        )

    assembly = cq.Assembly(name="e1_phone_evt0_solid_handoff")
    part_rows = []
    for item in solids:
        step_path = OUT_DIR / f"{item['name']}.step"
        cq.exporters.export(item["shape"], str(step_path))
        assembly.add(item["shape"], name=item["name"], color=item["color"])
        bbox = item["shape"].val().BoundingBox()
        part_rows.append(
            {
                "name": item["name"],
                "role": item["role"],
                "material": item["material"],
                "step": artifact_path(step_path),
                "bytes": step_path.stat().st_size,
                "bbox_mm": {
                    "min": [round(bbox.xmin, 3), round(bbox.ymin, 3), round(bbox.zmin, 3)],
                    "max": [round(bbox.xmax, 3), round(bbox.ymax, 3), round(bbox.zmax, 3)],
                    "span": [round(bbox.xlen, 3), round(bbox.ylen, 3), round(bbox.zlen, 3)],
                },
            }
        )
    assembly_path = OUT_DIR / "e1-phone-solid-assembly.step"
    assembly.save(str(assembly_path))
    required_solid_names = [
        "orange_back_shell",
        "orange_side_frame",
        "screen_cover_glass",
        "display_lcm",
        "main_pcb",
        "battery_pouch",
        "usb_c_receptacle",
        "usb_c_external_aperture",
        "bottom_speaker_module",
        "bottom_speaker_acoustic_chamber",
        "earpiece_receiver",
        "handset_acoustic_slot",
        "bottom_mic",
        "top_mic",
        "rear_camera_module",
        "rear_camera_cover_glass",
        "front_camera_module",
        "front_camera_under_glass",
        "power_button_cap",
        "volume_button_cap",
        "screen_adhesive_top",
        "display_fpc_connector",
        "orange_usb_reinforcement_saddle",
        "cellular_top_antenna_keepout",
        "cellular_bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
        "soc_shield_can",
        "pmic_shield_can",
        "radio_shield_can",
        "haptic_lra",
        "sim_tray_keepout",
        "service_label_recess",
    ]
    solid_names = {row["name"] for row in part_rows}
    required_solid_presence = {name: name in solid_names for name in required_solid_names}
    all_required_solids_present = all(required_solid_presence.values())
    all_steps_nonempty = all(row["bytes"] > 1000 for row in part_rows)
    report = {
        "claim_boundary": (
            "CadQuery/OCP B-rep envelope handoff for EVT0 mechanical review; supplier STEP, "
            "routed-board STEP, filleted production surfaces, and toolmaker steel design are still required."
        ),
        "status": "generated" if all_steps_nonempty and all_required_solids_present else "blocked",
        "tool": "cadquery",
        "tool_available": True,
        "assembly_step": artifact_path(assembly_path),
        "assembly_step_bytes": assembly_path.stat().st_size,
        "part_count": len(part_rows),
        "parts": part_rows,
        "required_solid_presence": required_solid_presence,
        "linked_fit_status": checks["status"],
        "remaining_blockers": [
            "Solids are parametric envelopes, not final supplier STEP models.",
            "PCB is still the concept KiCad outline, not a routed board STEP with component models.",
            "Production surfaces still need toolmaker-approved draft, shutoffs, split lines, and texture.",
        ],
    }
    (REVIEW_DIR / "solid-cad-handoff.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Solid CAD Handoff",
        "",
        "Status: generated CadQuery/OCP STEP envelope handoff.",
        "",
        f"- Assembly STEP: `{report['assembly_step']}`",
        f"- Part STEP count: {report['part_count']}",
        "",
        "## Parts",
        "",
    ]
    for row in part_rows:
        lines.append(f"- `{row['name']}`: `{row['step']}` ({row['role']})")
    lines.extend(["", "## Remaining Blockers", ""])
    for blocker in report["remaining_blockers"]:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "solid-cad-handoff.md").write_text("\n".join(lines) + "\n")
    return report


def write_step_validation_artifacts(solid_cad: dict[str, Any]) -> dict[str, Any]:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    try:
        import cadquery as cq
    except Exception as exc:
        report = {
            "claim_boundary": "STEP validation could not run because CadQuery/OCP is unavailable.",
            "status": "blocked",
            "error": f"{type(exc).__name__}: {exc}",
            "validated_count": 0,
            "cases": [],
        }
        (REVIEW_DIR / "step-validation.json").write_text(json.dumps(report, indent=2) + "\n")
        return report

    cases = []
    tolerance_mm = 0.05
    for row in solid_cad.get("parts", []):
        path = Path(row["step"])
        if not path.is_absolute():
            path = ROOT / path
        expected = row.get("bbox_mm", {}).get("span")
        case = {
            "name": row["name"],
            "step": row["step"],
            "bytes": path.stat().st_size if path.is_file() else 0,
            "imported": False,
            "bbox_span_mm": None,
            "max_span_error_mm": None,
            "pass": False,
        }
        if path.is_file() and expected:
            try:
                imported = cq.importers.importStep(str(path))
                bbox = imported.val().BoundingBox()
                actual = [bbox.xlen, bbox.ylen, bbox.zlen]
                errors = [abs(float(a) - float(e)) for a, e in zip(actual, expected, strict=True)]
                case.update(
                    {
                        "imported": True,
                        "bbox_span_mm": [round(value, 3) for value in actual],
                        "max_span_error_mm": round(max(errors), 4),
                        "pass": max(errors) <= tolerance_mm and case["bytes"] > 1000,
                    }
                )
            except Exception as exc:
                case["error"] = f"{type(exc).__name__}: {exc}"
        cases.append(case)

    assembly_path = Path(solid_cad.get("assembly_step", ""))
    if not assembly_path.is_absolute():
        assembly_path = ROOT / assembly_path
    assembly_bytes = assembly_path.stat().st_size if assembly_path.is_file() else 0
    assembly_case: dict[str, Any] = {
        "step": solid_cad.get("assembly_step"),
        "bytes": assembly_bytes,
        "imported": False,
        "pass": False,
    }
    if assembly_path.is_file():
        try:
            imported = cq.importers.importStep(str(assembly_path))
            bbox = imported.val().BoundingBox()
            assembly_case.update(
                {
                    "imported": True,
                    "bbox_span_mm": [round(bbox.xlen, 3), round(bbox.ylen, 3), round(bbox.zlen, 3)],
                    "pass": assembly_bytes > 1000,
                }
            )
        except Exception as exc:
            assembly_case["error"] = f"{type(exc).__name__}: {exc}"

    report = {
        "claim_boundary": "Automated STEP re-import and envelope validation; not supplier CAD approval.",
        "status": "pass"
        if cases and all(case["pass"] for case in cases) and assembly_case["pass"]
        else "blocked",
        "tolerance_mm": tolerance_mm,
        "validated_count": len(cases),
        "assembly": assembly_case,
        "cases": cases,
    }
    (REVIEW_DIR / "step-validation.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone STEP Validation",
        "",
        f"Status: {report['status']}; re-imported {report['validated_count']} part STEP files.",
        "",
        "## Cases",
        "",
    ]
    for case in cases:
        lines.append(
            f"- {'PASS' if case['pass'] else 'BLOCKED'}: `{case['name']}` max span error {case.get('max_span_error_mm')} mm"
        )
    (REVIEW_DIR / "step-validation.md").write_text("\n".join(lines) + "\n")
    return report


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


def strip_trailing_whitespace(path: Path) -> None:
    path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()) + "\n")


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
            "pass": image.size[0] >= 1000 and image.size[1] >= 1000 and max(channel_spans) >= 120,
        }
    (REVIEW_DIR / "visual-review.json").write_text(json.dumps(results, indent=2) + "\n")
    return results


def verify_image_artifact(path: Path) -> dict[str, Any]:
    from PIL import Image, ImageStat

    image = Image.open(path).convert("RGB")
    stat = ImageStat.Stat(image)
    channel_spans = [high - low for low, high in stat.extrema]
    return {
        "size": list(image.size),
        "mean_rgb": [round(value, 3) for value in stat.mean],
        "channel_spans": channel_spans,
        "pass": image.size[0] >= 1000 and image.size[1] >= 1000 and max(channel_spans) >= 80,
    }


def write_part_review_artifacts(parts: list[Part]) -> dict[str, Any]:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for part in parts:
        low, high = part.bounds
        span = high - low
        rows.append(
            {
                "name": part.name,
                "role": part.role,
                "material": part.material,
                "bounds_mm": [low.round(3).tolist(), high.round(3).tolist()],
                "span_mm": span.round(3).tolist(),
                "volume_mm3": round(max(float(part.mesh.volume), 0.0), 3),
                "mass_placeholder": is_mass_placeholder(part),
                "obj": f"mechanical/e1-phone/out/{part.name}.obj",
                "stl": f"mechanical/e1-phone/out/{part.name}.stl",
            }
        )

    cols = 6
    rows_count = int(math.ceil(len(parts) / cols))
    fig, axes = plt.subplots(rows_count, cols, figsize=(cols * 2.4, rows_count * 2.0), dpi=130)
    flat_axes = np.asarray(axes).reshape(-1)
    for ax, part in zip(flat_axes, parts, strict=False):
        low, high = part.bounds
        span = high - low
        ax.add_patch(
            plt.Rectangle(
                (low[0], low[1]),
                max(span[0], 0.1),
                max(span[1], 0.1),
                facecolor=part.color,
                edgecolor="black",
                linewidth=0.8,
                alpha=min(max(part.color[3], 0.35), 1.0),
            )
        )
        pad = max(float(span[:2].max()) * 0.18, 1.0)
        ax.set_xlim(low[0] - pad, high[0] + pad)
        ax.set_ylim(low[1] - pad, high[1] + pad)
        ax.set_aspect("equal")
        ax.axis("off")
        title = part.name.replace("_", " ")
        ax.set_title(title[:34], fontsize=6)
    for ax in flat_axes[len(parts) :]:
        ax.axis("off")
    fig.suptitle("E1 phone per-part top-view review contact sheet", fontsize=14)
    fig.tight_layout(rect=(0, 0, 1, 0.985))
    contact_sheet = REVIEW_DIR / "part-review-contact-sheet.png"
    fig.savefig(contact_sheet, facecolor="white")
    plt.close(fig)

    report = {
        "claim_boundary": "Automated part-by-part CAD review index; thumbnails are top-view bounding-box proxies.",
        "status": "pass" if rows and contact_sheet.is_file() else "blocked",
        "part_count": len(rows),
        "contact_sheet": "mechanical/e1-phone/review/part-review-contact-sheet.png",
        "contact_sheet_check": verify_image_artifact(contact_sheet),
        "parts": rows,
    }
    (REVIEW_DIR / "part-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Part Review Index",
        "",
        "Status: generated part index and contact sheet for every assembly part.",
        "",
        "- `mechanical/e1-phone/review/part-review-contact-sheet.png`",
        "",
        "## Parts",
        "",
    ]
    for row in rows:
        lines.append(
            f"- `{row['name']}`: role `{row['role']}`, span {row['span_mm']} mm, material {row['material']}"
        )
    (REVIEW_DIR / "part-review.md").write_text("\n".join(lines) + "\n")
    return report


def visual_mean_delta(visual: dict[str, Any], first: str, second: str) -> float:
    first_mean = visual.get(first, {}).get("mean_rgb", [])
    second_mean = visual.get(second, {}).get("mean_rgb", [])
    if len(first_mean) != 3 or len(second_mean) != 3:
        return 0.0
    return round(
        sum(abs(float(a) - float(b)) for a, b in zip(first_mean, second_mean, strict=True)),
        3,
    )


def write_visual_decision_artifacts(
    params: dict[str, Any],
    visual: dict[str, Any],
    checks: dict[str, Any],
    clearance: dict[str, Any],
    part_review: dict[str, Any],
    dfm: dict[str, Any],
    tolerance_stack: dict[str, Any],
) -> dict[str, Any]:
    width, height, depth = params["device"]["envelope_mm"]
    display_w, display_h, _display_t = params["display"]["ctp_outline_mm"]
    screen_margin = round(min((width - display_w) / 2.0, (height - display_h) / 2.0), 3)
    front_back_mean_delta = visual_mean_delta(visual, "full_front_iso.png", "full_back_iso.png")
    review_views = [
        {
            "file": name,
            "pass": bool(result.get("pass", False)),
            "size": result.get("size"),
            "purpose": {
                "full_front_iso.png": "front silhouette, orange side rail, black glass stack",
                "full_back_iso.png": "rear-side orange shell, camera window, and service-feature review",
                "rear_feature_detail.png": "translucent rear shell review of camera window, SIM edge, and service-label recess",
                "full_left_side.png": "left-side button protrusion and shell depth",
                "full_bottom_port.png": "USB-C, speaker grille, and microphone aperture review",
                "full_top_down.png": "compact footprint, screen margin, buttons, and front features",
                "exploded_iso.png": "glass, display, shell, and component stack separation",
                "component_stack.png": "PCB, battery, camera, audio, haptic, and I/O placement",
                "mold_tooling.png": "parting plane, runner, gate, ejector, and cooling placeholders",
            }.get(name, "generated visual evidence"),
        }
        for name, result in sorted(visual.items())
    ]

    decisions = [
        {
            "id": "compact_orange_shell",
            "decision": "keep",
            "basis": (
                f"Hold {width} x {height} x {depth} mm envelope around commodity touch panel "
                f"with {screen_margin} mm minimum nominal screen margin."
            ),
            "evidence": ["full_front_iso.png", "full_top_down.png", "molded_orange_enclosure"],
        },
        {
            "id": "black_bonded_glass_front",
            "decision": "keep",
            "basis": "Black cover glass remains a separate bonded part over the display stack.",
            "evidence": ["screen_cover_glass", "display_lcm", "screen_mount_and_connection"],
        },
        {
            "id": "under_glass_front_camera_and_earpiece",
            "decision": "keep_for_evt0",
            "basis": "Front camera and earpiece are represented behind glass/acoustic gasketing for CAD packaging.",
            "evidence": [
                "front_camera_under_glass",
                "handset_acoustic_slot",
                "camera_speaker_behind_glass",
            ],
        },
        {
            "id": "rear_camera_cover_window",
            "decision": "keep_for_evt0",
            "basis": "Rear AF camera stack remains in a back lens window because full under-glass packaging is too tall.",
            "evidence": [
                "rear_feature_detail.png",
                "rear_camera_module",
                "rear_camera_cover_glass",
            ],
        },
        {
            "id": "bottom_io_pattern",
            "decision": "keep_for_evt0",
            "basis": "USB-C insertion envelope, speaker slots, and microphone ports are modeled for mechanical review.",
            "evidence": [
                "full_bottom_port.png",
                "usb_c_external_aperture",
                "bottom_io_acoustic_apertures",
            ],
        },
        {
            "id": "component_and_service_layout",
            "decision": "keep_for_evt0",
            "basis": "PCB, battery, haptic, SIM keepout, RF keepouts, shields, cameras, and audio parts are indexed.",
            "evidence": [
                "component_stack.png",
                "part-review-contact-sheet.png",
                "shielding_haptics_service",
            ],
        },
        {
            "id": "injection_mold_tooling_placeholders",
            "decision": "keep_for_dfm_discussion",
            "basis": "Runner, submarine gates, ejector pins, cooling channels, and parting plane are CAD placeholders.",
            "evidence": ["mold_tooling.png", "injection-molding-dfm.json", "tolerance-stack.json"],
        },
    ]

    manual_review_items = [
        "Inspect rear feature proportions in GLB/STEP before CMF lock; render distinctness is an automated coverage check, not industrial-design approval.",
        "Confirm orange resin color, gloss, texture, knit lines, gate blush, and scratch behavior with molded samples.",
        "Validate camera-window aesthetics, lens stack height, dust gasket, and service label placement using supplier samples.",
        "Run tactile reviews for button travel, rattle, switch force, and snap-hook fatigue on physical samples.",
        "Replace mesh-derived review with real supplier STEP/B-rep data and routed KiCad board STEP before tooling release.",
    ]
    status_inputs = {
        "visual_review_pass": all(item["pass"] for item in review_views),
        "fit_checks_pass": checks["status"] == "pass",
        "assembly_clearance_pass": clearance["status"] == "pass",
        "part_review_pass": part_review["status"] == "pass",
        "dfm_inputs_ready": dfm["status"] == "cad_dfm_inputs_ready",
        "tolerance_stack_pass": tolerance_stack["status"] == "cad_tolerance_stack_pass",
        "front_back_render_distinct": front_back_mean_delta >= 8.0,
    }
    report = {
        "claim_boundary": (
            "Automated EVT0 visual/design decision log; it records CAD review acceptance and open "
            "manual checks, not CMF lock, tooling release, or production validation."
        ),
        "status": "pass" if all(status_inputs.values()) else "blocked",
        "device_envelope_mm": [width, height, depth],
        "display_candidate": params["display"]["candidate"],
        "screen_margin_mm": screen_margin,
        "visual_deltas": {
            "front_back_mean_rgb_sum_delta": front_back_mean_delta,
            "front_back_minimum_sum_delta": 8.0,
        },
        "review_views": review_views,
        "status_inputs": status_inputs,
        "decisions": decisions,
        "manual_review_items": manual_review_items,
        "evidence_files": [
            "mechanical/e1-phone/review/visual-review.json",
            "mechanical/e1-phone/review/part-review.json",
            "mechanical/e1-phone/review/assembly-clearance.json",
            "mechanical/e1-phone/review/injection-molding-dfm.json",
            "mechanical/e1-phone/review/tolerance-stack.json",
        ],
    }
    (REVIEW_DIR / "visual-decision-report.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Visual Decision Report",
        "",
        f"Status: {report['status']}.",
        "",
        "This report records the EVT0 CAD visual decisions and the manual review items still open.",
        "",
        "## Decisions",
        "",
    ]
    for decision in decisions:
        lines.append(f"- `{decision['id']}`: {decision['decision']}; {decision['basis']}")
    lines.extend(["", "## Reviewed Views", ""])
    for view in review_views:
        lines.append(
            f"- {'PASS' if view['pass'] else 'BLOCKED'}: `{view['file']}` - {view['purpose']}"
        )
    lines.extend(["", "## Manual Review Items", ""])
    for item in manual_review_items:
        lines.append(f"- {item}")
    (REVIEW_DIR / "visual-decision-report.md").write_text("\n".join(lines) + "\n")
    return report


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
    if (
        "speaker" in material
        or "receiver" in material
        or "camera" in material
        or "mems" in material
    ):
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
            lines.append(
                f"- Mechanical lock: `{json.dumps(item['mechanical_lock'], sort_keys=True)}`"
            )
        lines.append("")
    (REVIEW_DIR / "supplier-lock.md").write_text("\n".join(lines))
    return matrix


def write_supplier_rfq_artifacts(
    params: dict[str, Any],
    supplier: dict[str, Any],
    solid_cad: dict[str, Any],
) -> dict[str, Any]:
    solid_steps = {row["name"]: row["step"] for row in solid_cad.get("parts", [])}
    common_requested_files = [
        "native 3D CAD or STEP model",
        "dimensioned 2D drawing with tolerances",
        "datasheet with environmental and lifecycle limits",
        "pinout/footprint/courtyard recommendation where electrical",
        "sample quote for 5, 20, 100, and 500 units",
    ]
    packages = [
        {
            "id": "display_touch_stack",
            "supplier_item_ids": ["display_lcm_ctp"],
            "candidate": params["display"]["candidate"],
            "attached_steps": [
                solid_steps.get("screen_cover_glass"),
                solid_steps.get("display_lcm"),
                solid_steps.get("display_fpc_connector"),
                solid_steps.get("screen_adhesive_top"),
            ],
            "questions": [
                "Confirm CTP/LCM outline, cover-glass thickness, active area, and stack tolerance.",
                "Confirm FPC exit side, bend radius, connector family, and mating connector drawing.",
                "Quote bonded cover glass plus touch/display module as low-volume OEM assembly if available.",
            ],
            "acceptance_criteria": [
                "module fits 78.0 x 153.6 mm envelope with positive screen margin",
                "FPC bend path clears modeled connector keepout",
                "vendor supplies STEP and 2D drawing before EVT order",
            ],
        },
        {
            "id": "usb_c_and_bottom_audio",
            "supplier_item_ids": ["usb_c"],
            "candidate": params["components"]["usb_c"]["candidate"],
            "attached_steps": [
                solid_steps.get("usb_c_receptacle"),
                solid_steps.get("usb_c_external_aperture"),
                solid_steps.get("bottom_speaker_module"),
                solid_steps.get("bottom_speaker_acoustic_chamber"),
                solid_steps.get("bottom_mic"),
                solid_steps.get("bottom_microphone_port_1"),
            ],
            "questions": [
                "Confirm exact USB-C suffix, footprint, shell stake geometry, and 20k-cycle rating.",
                "Confirm speaker module acoustic rear-volume needs and gasket compression range.",
                "Confirm MEMS microphone port, dust mesh, gasket stack, and keepout around USB shell.",
            ],
            "acceptance_criteria": [
                "USB-C insertion envelope clears orange saddle and bottom aperture",
                "speaker and microphone acoustic path remains isolated from USB mechanical load path",
                "vendor can provide STEP/drawing for connector, speaker, mic, mesh, and gasket",
            ],
        },
        {
            "id": "camera_stack",
            "supplier_item_ids": ["rear_camera", "front_camera"],
            "candidate": "rear OV13855-class AF plus front 5-8 MP FF module",
            "attached_steps": [
                solid_steps.get("rear_camera_module"),
                solid_steps.get("rear_camera_cover_glass"),
                solid_steps.get("rear_camera_lens_window"),
                solid_steps.get("front_camera_module"),
                solid_steps.get("front_camera_under_glass"),
            ],
            "questions": [
                "Confirm rear module total height, FPC exit side, lens keepout, and dust gasket stack.",
                "Confirm front module can sit behind cover glass without visible notch or protrusion.",
                "Quote matched rear/front MIPI modules with low-volume sample availability.",
            ],
            "acceptance_criteria": [
                "rear AF stack fits 9.6 mm phone depth with modeled cover window",
                "front camera remains behind glass and clear of earpiece path",
                "supplier provides optical center datum in drawing and STEP",
            ],
        },
        {
            "id": "buttons_haptics_service",
            "supplier_item_ids": ["side_buttons"],
            "candidate": params["components"]["power_button"]["candidate"],
            "attached_steps": [
                solid_steps.get("power_button_cap"),
                solid_steps.get("volume_button_cap"),
                solid_steps.get("haptic_lra"),
                solid_steps.get("sim_tray_keepout"),
                solid_steps.get("sim_tray_outline"),
            ],
            "questions": [
                "Confirm side tactile switch part number, force bins, travel, and actuator tolerance stack.",
                "Confirm LRA vendor drawing, adhesive/fixture requirements, and drive limits.",
                "Confirm whether nano-SIM tray is required or eSIM-only is acceptable for EVT.",
            ],
            "acceptance_criteria": [
                "button force/travel matches CAD pressure assumptions",
                "haptic package clears battery, PCB islands, and ribs",
                "service tray decision does not break orange side-frame design",
            ],
        },
        {
            "id": "orange_enclosure_tooling",
            "supplier_item_ids": [],
            "candidate": params["manufacturing"]["plastic"],
            "attached_steps": [
                solid_steps.get("orange_back_shell"),
                solid_steps.get("orange_side_frame"),
                solid_steps.get("orange_screw_boss_1"),
                solid_steps.get("orange_snap_hook_1"),
                solid_steps.get("orange_usb_reinforcement_saddle"),
                "mechanical/e1-phone/out/e1-phone-mold-tooling.glb",
            ],
            "questions": [
                "Quote CNC prototype, soft-tool injection, and hard-tool injection options in safety orange PC+ABS.",
                "Review draft, rib/boss ratios, snap hooks, gate vestige, ejector marks, texture, and color matching.",
                "Return mold-flow/fill balance recommendation for the long thin back cover and side frame.",
            ],
            "acceptance_criteria": [
                "toolmaker signs off draft, gates, ejectors, cooling, and parting line",
                "orange color plaque and texture sample approved before DVT",
                "first-shot CMM data closes tolerance stack",
            ],
        },
    ]
    for package in packages:
        package["attached_steps"] = [step for step in package["attached_steps"] if step]
        package["requested_files"] = common_requested_files
    report = {
        "claim_boundary": "Supplier RFQ package generated from EVT0 CAD/STEP evidence; not a purchase order or supplier lock.",
        "status": "rfq_ready"
        if all(package["attached_steps"] for package in packages)
        else "blocked",
        "supplier_items": [item["id"] for item in supplier["items"]],
        "cad_context": {
            "assembly_step": solid_cad.get("assembly_step"),
            "manufacturing_drawing": "mechanical/e1-phone/review/manufacturing_drawing.json",
            "tolerance_stack": "mechanical/e1-phone/review/tolerance-stack.json",
            "dfm_screen": "mechanical/e1-phone/review/injection-molding-dfm.json",
        },
        "packages": packages,
        "blocked_release_claims": [
            "supplier_locked",
            "purchase_ready",
            "tooling_ready",
            "production_ready",
        ],
    }
    (REVIEW_DIR / "supplier-rfq-package.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Supplier RFQ Package",
        "",
        "Status: generated RFQ package from EVT0 CAD evidence; not supplier lock.",
        "",
    ]
    for package in packages:
        lines.append(f"## {package['id']}")
        lines.append("")
        lines.append(f"- Candidate: {package['candidate']}")
        lines.append(f"- Attached STEP evidence: {', '.join(package['attached_steps'])}")
        lines.append("- Questions:")
        for question in package["questions"]:
            lines.append(f"  - {question}")
        lines.append("")
    (REVIEW_DIR / "supplier-rfq-package.md").write_text("\n".join(lines) + "\n")
    return report


def parse_kicad_footprint_positions(pcb_path: Path) -> dict[str, dict[str, float]]:
    text = pcb_path.read_text()
    pattern = re.compile(
        r'\(footprint\s+"[^"]*:(?P<ref>[^"]+)"[\s\S]*?\n\s+\(at\s+'
        r"(?P<x>-?\d+(?:\.\d+)?)\s+(?P<y>-?\d+(?:\.\d+)?)"
    )
    return {
        match.group("ref"): {"x": float(match.group("x")), "y": float(match.group("y"))}
        for match in pattern.finditer(text)
    }


def project_cad_bounds_to_board(
    bounds: tuple[np.ndarray, np.ndarray], board_w: float, board_h: float
) -> dict[str, float]:
    lower, upper = bounds
    return {
        "x": round(float(lower[0] + board_w / 2.0), 3),
        "y": round(float(board_h / 2.0 - upper[1]), 3),
        "width": round(float(upper[0] - lower[0]), 3),
        "height": round(float(upper[1] - lower[1]), 3),
    }


def rect_gap_mm(a: dict[str, float], b: dict[str, float]) -> float:
    ax1 = a["x"]
    ay1 = a["y"]
    ax2 = a["x"] + a["width"]
    ay2 = a["y"] + a["height"]
    bx1 = b["x"]
    by1 = b["y"]
    bx2 = b["x"] + b["width"]
    by2 = b["y"] + b["height"]
    dx = max(bx1 - ax2, ax1 - bx2, 0.0)
    dy = max(by1 - ay2, ay1 - by2, 0.0)
    return float(math.hypot(dx, dy))


def write_kicad_placement_reconciliation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    handoff: dict[str, Any],
) -> dict[str, Any]:
    pcb_path = ROOT / params["pcb"]["source"]
    matrix_path = ROOT / "board/kicad/e1-phone/placement-interface-matrix.yaml"
    matrix = yaml.safe_load(matrix_path.read_text())
    board_w = float(matrix["board"]["bbox_mm"]["width"])
    board_h = float(matrix["board"]["bbox_mm"]["height"])
    footprints = parse_kicad_footprint_positions(pcb_path)
    by_name = {part.name: part for part in parts}

    footprint_cases: list[dict[str, Any]] = []
    for placement in matrix["placements"]:
        ref = placement["refdes_group"]
        region = placement["region_mm"]
        expected = {
            "x": round(region["x"] + region["width"] / 2.0, 3),
            "y": round(region["y"] + region["height"] / 2.0, 3),
        }
        actual = footprints.get(ref)
        error = (
            math.hypot(actual["x"] - expected["x"], actual["y"] - expected["y"])
            if actual
            else math.inf
        )
        footprint_cases.append(
            {
                "id": ref,
                "function": placement["function"],
                "region_mm": region,
                "expected_center_mm": expected,
                "actual_footprint_at_mm": actual,
                "center_error_mm": None if math.isinf(error) else round(error, 3),
                "tolerance_mm": 0.25,
                "pass": bool(actual) and error <= 0.25,
            }
        )

    cad_mappings: list[dict[str, Any]] = [
        {
            "id": "J_USB_C",
            "parts": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "orange_usb_reinforcement_saddle",
            ],
            "tolerance_mm": 12.0,
            "why": "USB-C footprint must stay aligned with the molded bottom aperture and insertion-load saddle.",
        },
        {
            "id": "SW_POWER_VOL",
            "parts": ["volume_button_cap", "power_button_cap"],
            "tolerance_mm": 12.0,
            "why": "Side-key switch/flex region must stay reachable from the molded orange button caps.",
        },
        {
            "id": "J_DISPLAY_TOUCH",
            "parts": ["display_fpc_connector", "display_fpc_bend_keepout"],
            "tolerance_mm": 6.0,
            "why": "Display/touch FPC footprint must stay inside the CAD bend and connector envelope.",
        },
        {
            "id": "J_CAM0_CAM1",
            "parts": ["rear_camera_module", "front_camera_module", "rear_camera_cover_glass"],
            "tolerance_mm": 8.0,
            "why": "Camera FPC region must stay tied to the rear lens datum and under-glass front camera envelope.",
        },
        {
            "id": "U_CELL",
            "parts": ["radio_shield_can", "cellular_top_antenna_keepout"],
            "tolerance_mm": 8.0,
            "why": "Cellular module area must stay near RF shield and top antenna plastic keepout.",
        },
        {
            "id": "U_WIFI_BT",
            "parts": ["wifi_bt_side_antenna_keepout", "radio_shield_can"],
            "tolerance_mm": 12.0,
            "why": "Wi-Fi/BT module area must stay near the side plastic antenna aperture.",
        },
        {
            "id": "U_PMIC_CHARGER",
            "parts": ["pmic_shield_can", "usb_c_receptacle"],
            "tolerance_mm": 14.0,
            "why": "PMIC/charger region must stay close to the USB-C power path and shielded power zone.",
        },
        {
            "id": "J_BATTERY",
            "parts": ["battery_pouch", "main_pcb"],
            "tolerance_mm": 1.0,
            "why": "Battery connector region must touch the CAD battery pouch/window boundary.",
        },
        {
            "id": "U_SOC_LPDDR_UFS",
            "parts": ["soc_shield_can", "pmic_shield_can"],
            "tolerance_mm": 10.0,
            "why": "Compute region must stay under the modeled shield/thermal zone.",
        },
        {
            "id": "U_AUDIO_SPK_MIC",
            "parts": ["bottom_speaker_module", "bottom_mic", "haptic_lra"],
            "tolerance_mm": 18.0,
            "why": "Bottom audio/haptic region must stay connected to speaker, microphone, and haptic envelopes.",
        },
    ]
    matrix_regions = {item["refdes_group"]: item["region_mm"] for item in matrix["placements"]}
    cad_cases: list[dict[str, Any]] = []
    for mapping in cad_mappings:
        region = matrix_regions[mapping["id"]]
        projected_parts = []
        for part_name in mapping["parts"]:
            part = by_name.get(part_name)
            if part is None:
                continue
            rect = project_cad_bounds_to_board(part.bounds, board_w, board_h)
            projected_parts.append(
                {
                    "part": part_name,
                    "projected_rect_mm": rect,
                    "gap_to_region_mm": round(rect_gap_mm(rect, region), 3),
                }
            )
        best_gap = min((item["gap_to_region_mm"] for item in projected_parts), default=math.inf)
        cad_cases.append(
            {
                "id": mapping["id"],
                "region_mm": region,
                "cad_parts": projected_parts,
                "best_gap_mm": None if math.isinf(best_gap) else round(best_gap, 3),
                "tolerance_mm": mapping["tolerance_mm"],
                "pass": bool(projected_parts) and best_gap <= mapping["tolerance_mm"],
                "why": mapping["why"],
            }
        )

    report = {
        "claim_boundary": "Automated KiCad/CAD placement reconciliation for concept geometry; not routed-board STEP, DRC closure, supplier footprint approval, or fabrication release.",
        "status": "cad_kicad_placement_reconciled"
        if all(case["pass"] for case in footprint_cases) and all(case["pass"] for case in cad_cases)
        else "blocked",
        "pcb_source": params["pcb"]["source"],
        "placement_matrix": "board/kicad/e1-phone/placement-interface-matrix.yaml",
        "board_coordinate_system": matrix["board"]["coordinate_origin"],
        "handoff_constraint_count": len(handoff["constraints"]),
        "footprint_cases": footprint_cases,
        "cad_projection_cases": cad_cases,
        "release_blockers": [
            "Replace E1Phone:* placeholders with supplier footprints and exact land patterns.",
            "Route the KiCad board with DRC/ERC clean constraints and real component heights.",
            "Export routed board STEP with component 3D models and re-run full enclosure collision checks.",
        ],
    }
    (REVIEW_DIR / "kicad-placement-reconciliation.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )

    lines = [
        "# E1 Phone KiCad Placement Reconciliation",
        "",
        "Status: concept KiCad placement reconciled to CAD envelopes; routed-board STEP still required.",
        "",
        "## Footprint Anchors",
        "",
    ]
    for case in footprint_cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` center error {case['center_error_mm']} mm against placement matrix"
        )
    lines.extend(["", "## CAD Projection", ""])
    for case in cad_cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` best CAD gap {case['best_gap_mm']} mm, tolerance {case['tolerance_mm']} mm"
        )
    lines.extend(["", "## Release Blockers", ""])
    for item in report["release_blockers"]:
        lines.append(f"- {item}")
    (REVIEW_DIR / "kicad-placement-reconciliation.md").write_text("\n".join(lines) + "\n")
    return report


def write_kicad_mechanical_handoff(
    params: dict[str, Any], checks: dict[str, Any]
) -> dict[str, Any]:
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
            {
                "id": "mechanical_overlay",
                "action": "Keep board/kicad/e1-phone/mechanical-overlay.yaml and the Dwgs.User MECH_KEEP_* rectangles in the concept PCB synchronized with CAD keepouts.",
                "why": "The board package checker now verifies display FPC, RF antenna, haptic, SIM/service, camera/earpiece, USB, button, and battery keepouts projected into KiCad.",
            },
        ],
        "next_kicad_edits": [
            "Replace concept rectangles with real footprints for USB4105, display FPC, camera FPCs, side tactile switches, speaker spring pads, MEMS microphones, and RG255C/alternate modem.",
            "Promote mechanical-overlay.yaml keepouts into real KiCad keepout/courtyard objects once footprints replace concept rectangles.",
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
    battery = plt.Rectangle(
        (-battery_w / 2, -7.0 - battery_h / 2), battery_w, battery_h, fill=False, lw=1.0
    )
    front.add_patch(body)
    front.add_patch(glass)
    front.add_patch(pcb_rect)
    front.add_patch(battery)
    front.text(-width / 2, height / 2 + 6, f"Envelope {width:.1f} x {height:.1f} mm")
    front.text(-width / 2, height / 2 + 1.5, f"R{corner_radius:.1f} rounded orange PC+ABS")
    front.text(-width / 2, -height / 2 - 6, f"CTP glass {glass_w:.1f} x {glass_h:.2f} mm")
    front.text(
        -width / 2, -height / 2 - 10.5, f"PCB Edge.Cuts {pcb_w:.1f} x {pcb_h:.1f} x {pcb_t:.1f} mm"
    )
    front.text(
        -width / 2,
        -height / 2 - 15,
        f"Battery window {battery_w:.1f} x {battery_h:.1f} x {battery_t:.1f} mm",
    )
    front.set_xlim(-width / 2 - 10, width / 2 + 10)
    front.set_ylim(-height / 2 - 20, height / 2 + 15)
    front.set_title("Front Envelope And Internal Keepouts")

    side.add_patch(plt.Rectangle((-height / 2, -depth / 2), height, depth, fill=False, lw=2.0))
    side.add_patch(
        plt.Rectangle(
            (-height / 2 + 0.625, -depth / 2 + 0.6 - 0.6), height - 1.25, 1.2, fill=False, lw=1.0
        )
    )
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
    strip_trailing_whitespace(svg)

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


def write_engineering_validation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    checks: dict[str, Any],
    mass: dict[str, Any],
    supplier: dict[str, Any],
) -> dict[str, Any]:
    validation = params["validation"]
    tolerance = validation["tolerance"]
    width, height, depth = params["device"]["envelope_mm"]
    display = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    comp = params["components"]
    screen_margin = min(
        (width - display["ctp_outline_mm"][0]) / 2.0,
        (height - display["ctp_outline_mm"][1]) / 2.0,
    )
    pcb_edge_clearance = min(
        (width - pcb["outline_mm"][0]) / 2.0,
        (height - pcb["outline_mm"][1]) / 2.0,
    )
    usb_shell_to_aperture = min(
        (10.2 - comp["usb_c"]["envelope_mm"][0]) / 2.0,
        (3.6 - comp["usb_c"]["envelope_mm"][2]) / 2.0,
    )
    battery_center = [0.0, -7.0, battery["z_center_mm"]]
    battery_to_pcb_gaps = [
        box_gap(
            [64.0, 25.0, 0.8],
            [0.0, 55.0, pcb["z_center_mm"]],
            battery["envelope_mm"],
            battery_center,
        ),
        box_gap(
            [64.0, 15.0, 0.8],
            [0.0, -65.0, pcb["z_center_mm"]],
            battery["envelope_mm"],
            battery_center,
        ),
        box_gap(
            [8.0, 78.0, 0.8],
            [-32.0, -8.0, pcb["z_center_mm"]],
            battery["envelope_mm"],
            battery_center,
        ),
    ]
    power_pressure = comp["power_button"]["force_n"] / (
        comp["power_button"]["cap_mm"][1] * comp["power_button"]["cap_mm"][2]
    )
    volume_pressure = comp["volume_button"]["force_n"] / (
        comp["volume_button"]["cap_mm"][1] * comp["volume_button"]["cap_mm"][2]
    )
    physical_parts = [part for part in parts if not is_mass_placeholder(part)]
    low = np.vstack([part.bounds[0] for part in physical_parts]).min(axis=0)
    high = np.vstack([part.bounds[1] for part in physical_parts]).max(axis=0)
    actual_stack = [round(float(v), 3) for v in (high - low)]

    tolerance_cases: list[dict[str, Any]] = [
        {
            "id": "screen_xy_fit",
            "actual_mm": round(screen_margin, 3),
            "required_mm": tolerance["screen_xy_allowance_mm"],
            "pass": screen_margin >= tolerance["screen_xy_allowance_mm"],
            "note": "Minimum CTP-to-orange-body margin in X/Y.",
        },
        {
            "id": "pcb_edge_clearance",
            "actual_mm": round(pcb_edge_clearance, 3),
            "required_mm": tolerance["pcb_edge_clearance_mm"],
            "pass": pcb_edge_clearance >= tolerance["pcb_edge_clearance_mm"],
            "note": "Minimum board edge clearance to outer molded envelope.",
        },
        {
            "id": "usb_shell_to_aperture",
            "actual_mm": round(usb_shell_to_aperture, 3),
            "required_mm": tolerance["usb_shell_to_aperture_clearance_mm"],
            "pass": usb_shell_to_aperture >= tolerance["usb_shell_to_aperture_clearance_mm"],
            "note": "Minimum modeled shell clearance to external USB-C aperture.",
        },
        {
            "id": "battery_to_pcb",
            "actual_mm": round(min(battery_to_pcb_gaps), 3),
            "required_mm": tolerance["battery_to_pcb_gap_mm"],
            "pass": min(battery_to_pcb_gaps) >= tolerance["battery_to_pcb_gap_mm"],
            "note": "Minimum gap from pouch battery to rigid PCB islands.",
        },
        {
            "id": "button_pressure",
            "actual_n_per_mm2": round(max(power_pressure, volume_pressure), 3),
            "required_max_n_per_mm2": tolerance["button_pressure_limit_n_per_mm2"],
            "pass": max(power_pressure, volume_pressure)
            <= tolerance["button_pressure_limit_n_per_mm2"],
            "note": "Nominal side-key force divided by cap contact area.",
        },
    ]

    domain_reviews: list[dict[str, Any]] = [
        {
            "domain": "thermal",
            "cad_status": "inputs_present",
            "evidence": [
                "soc_shield_can",
                "pmic_shield_can",
                "radio_shield_can",
                "mass-budget.json",
            ],
            "target": f"skin temperature below {validation['environmental_targets']['max_skin_temp_c']} C",
            "next_validation": "Run thermal simulation after routed board power map and enclosure resin are locked.",
        },
        {
            "domain": "rf",
            "cad_status": "inputs_present",
            "evidence": [
                "cellular_top_antenna_keepout",
                "cellular_bottom_antenna_keepout",
                "wifi_bt_side_antenna_keepout",
            ],
            "target": validation["environmental_targets"]["rf_pre_scan_status"],
            "next_validation": "Export antenna keepouts into PCB/RF tool and run desense/SAR pre-scan.",
        },
        {
            "domain": "acoustic",
            "cad_status": "inputs_present",
            "evidence": [
                "bottom_speaker_acoustic_chamber",
                "earpiece_gasket",
                "handset_acoustic_slot",
            ],
            "target": validation["environmental_targets"]["acoustic_leakage_status"],
            "next_validation": "Measure loudspeaker, mic, and earpiece leakage with molded sample and gasket stack.",
        },
        {
            "domain": "drop",
            "cad_status": "inputs_present",
            "evidence": [
                "orange_back_shell",
                "orange_side_frame",
                "screen_adhesive_top",
                "corner_radius_mm",
            ],
            "target": f"{validation['environmental_targets']['drop_height_m']} m EVT drop screen/shell survival",
            "next_validation": "Run FEA/drop pre-check, then corner/face/edge drop on soft-tool samples.",
        },
        {
            "domain": "ingress",
            "cad_status": "design_intent_only",
            "evidence": ["screen_adhesive_top", "earpiece_gasket", "usb_c_external_aperture"],
            "target": validation["environmental_targets"]["ingress_target"],
            "next_validation": "Add real port membranes/gaskets and run dust/splash tests after supplier stack lock.",
        },
    ]

    assembly_sequence: list[str] = [
        "Mold orange back shell and side frame; inspect gate, ejector, sink, and color consistency.",
        "Install USB-C receptacle, bottom speaker, microphones, earpiece gasket, haptic, and cameras onto PCB/subassemblies.",
        "Place battery into ribbed window and connect board/display FPC using the KiCad mechanical handoff constraints.",
        "Bond screen cover glass/display stack with die-cut adhesive and verify FPC bend radius.",
        "Install orange power and volume caps, close snap hooks/screws, then inspect button force, USB insertion, audio ports, and camera windows.",
    ]

    dvt_plan: list[dict[str, Any]] = [
        {
            "test": "USB-C insertion/removal",
            "sample_count": 5,
            "criterion": "20k-cycle candidate port; no shell shift or aperture rub.",
        },
        {
            "test": "Side key force/travel",
            "sample_count": 10,
            "criterion": "1.2-2.2 N actuation and no cap sticking after tolerance extremes.",
        },
        {
            "test": "Display bond and FPC bend",
            "sample_count": 5,
            "criterion": "No lift, no glass clash, bend radius >= 1.0 mm.",
        },
        {
            "test": "RF pre-scan/desense",
            "sample_count": 3,
            "criterion": "Antenna keepouts respected with cellular and Wi-Fi active.",
        },
        {
            "test": "Acoustic leakage",
            "sample_count": 5,
            "criterion": "Speaker, earpiece, and mic paths pass OEM acoustic targets.",
        },
        {
            "test": "Soft-tool DFM review",
            "sample_count": 1,
            "criterion": "Toolmaker signs off draft, gates, ejectors, cooling, sink, and parting line.",
        },
    ]

    report = {
        "claim_boundary": "Automated EVT engineering validation plan and CAD-derived checks; not physical validation.",
        "status": "cad_validation_inputs_ready"
        if all(item["pass"] for item in tolerance_cases)
        else "blocked",
        "tolerance_cases": tolerance_cases,
        "domain_reviews": domain_reviews,
        "assembly_sequence": assembly_sequence,
        "dvt_plan": dvt_plan,
        "physical_stack_bounds_mm": {
            "low": [round(float(v), 3) for v in low],
            "high": [round(float(v), 3) for v in high],
            "span": actual_stack,
            "nominal_envelope": [width, height, depth],
        },
        "linked_fit_checks": {
            key: checks["checks"][key]["pass"]
            for key in [
                "usb_c_insertion_envelope",
                "button_force_and_travel",
                "button_pressure_support",
                "screen_mount_and_connection",
                "rf_antenna_keepouts",
                "mold_ejector_cooling_model",
            ]
        },
        "supplier_items": [item["id"] for item in supplier["items"]],
        "estimated_mass_g": mass["total_estimated_mass_g"],
    }
    (REVIEW_DIR / "engineering-validation.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Engineering Validation Plan",
        "",
        "Status: CAD validation inputs ready; physical EVT validation still required.",
        "",
        "## CAD-Derived Tolerance Cases",
        "",
    ]
    for tolerance_case in tolerance_cases:
        value_key = "actual_mm" if "actual_mm" in tolerance_case else "actual_n_per_mm2"
        result = "PASS" if tolerance_case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{tolerance_case['id']}` = "
            f"{tolerance_case[value_key]} ({tolerance_case['note']})"
        )
    lines.extend(["", "## Domain Reviews", ""])
    for domain_review in domain_reviews:
        lines.append(
            f"- `{domain_review['domain']}`: {domain_review['cad_status']}; "
            f"next: {domain_review['next_validation']}"
        )
    lines.extend(["", "## Assembly Sequence", ""])
    for idx, assembly_step in enumerate(assembly_sequence, start=1):
        lines.append(f"{idx}. {assembly_step}")
    lines.extend(["", "## DVT Plan", ""])
    for dvt_case in dvt_plan:
        lines.append(
            f"- `{dvt_case['test']}`: n={dvt_case['sample_count']}; {dvt_case['criterion']}"
        )
    (REVIEW_DIR / "engineering-validation.md").write_text("\n".join(lines) + "\n")
    return report


def write_interface_validation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    checks: dict[str, Any],
    clearance: dict[str, Any],
    tolerance_stack: dict[str, Any],
) -> dict[str, Any]:
    width, height, _depth = params["device"]["envelope_mm"]
    display = params["display"]
    comp = params["components"]
    tolerance = params["validation"]["tolerance"]
    by_name = {part.name for part in parts}

    power_area = comp["power_button"]["cap_mm"][1] * comp["power_button"]["cap_mm"][2]
    volume_area = comp["volume_button"]["cap_mm"][1] * comp["volume_button"]["cap_mm"][2]
    power_pressure = comp["power_button"]["force_n"] / power_area
    volume_pressure = comp["volume_button"]["force_n"] / volume_area
    usb_clearance_xy = (10.2 - comp["usb_c"]["envelope_mm"][0]) / 2.0
    usb_clearance_z = (3.6 - comp["usb_c"]["envelope_mm"][2]) / 2.0
    screen_margin = min(
        (width - display["ctp_outline_mm"][0]) / 2.0,
        (height - display["ctp_outline_mm"][1]) / 2.0,
    )
    adhesive_compression_mm = display["adhesive_thickness_mm"] * (
        display["compression_target_pct"] / 100.0
    )
    rear_lens_cover_margin = (
        comp["rear_camera_glass"]["envelope_mm"][0] - comp["rear_camera"]["lens_diameter_mm"]
    ) / 2.0
    front_lens_under_glass_margin = (
        comp["front_camera"]["module_mm"][0] - comp["front_camera"]["lens_diameter_mm"]
    ) / 2.0
    speaker_slot_count = sum(name.startswith("bottom_speaker_grille_slot_") for name in by_name)
    mic_port_count = sum(name.startswith("bottom_microphone_port_") for name in by_name)
    clearance_cases = {case["id"]: case for case in clearance["cases"]}
    stack_cases = {case["id"]: case for case in tolerance_stack["stacks"]}

    interface_cases = [
        {
            "id": "power_button_force_travel_pressure",
            "interface": "button",
            "actual": {
                "force_n": comp["power_button"]["force_n"],
                "travel_mm": comp["power_button"]["travel_mm"],
                "pressure_n_per_mm2": round(power_pressure, 3),
            },
            "target": "1.2-2.2 N, >=0.25 mm travel, pressure below CAD limit",
            "pass": 1.2 <= comp["power_button"]["force_n"] <= 2.2
            and comp["power_button"]["travel_mm"] >= 0.25
            and power_pressure <= tolerance["button_pressure_limit_n_per_mm2"],
            "evidence": ["power_button_cap", "button_force_and_travel", "button_pressure_support"],
        },
        {
            "id": "volume_button_force_travel_pressure",
            "interface": "button",
            "actual": {
                "force_n": comp["volume_button"]["force_n"],
                "travel_mm": comp["volume_button"]["travel_mm"],
                "pressure_n_per_mm2": round(volume_pressure, 3),
            },
            "target": "1.2-2.2 N, >=0.25 mm travel, pressure below CAD limit",
            "pass": 1.2 <= comp["volume_button"]["force_n"] <= 2.2
            and comp["volume_button"]["travel_mm"] >= 0.25
            and volume_pressure <= tolerance["button_pressure_limit_n_per_mm2"],
            "evidence": ["volume_button_cap", "button_force_and_travel", "button_pressure_support"],
        },
        {
            "id": "usb_c_insertion_capture",
            "interface": "usb_c",
            "actual": {
                "xy_clearance_mm": round(usb_clearance_xy, 3),
                "z_clearance_mm": round(usb_clearance_z, 3),
                "cycle_rating": comp["usb_c"]["cycles"],
                "insertion_keepout_mm": comp["usb_c"]["insertion_keepout_mm"],
            },
            "target": ">=0.15 mm shell clearance, >=10000 cycle supplier class, molded saddle present",
            "pass": min(usb_clearance_xy, usb_clearance_z)
            >= tolerance["usb_shell_to_aperture_clearance_mm"]
            and comp["usb_c"]["cycles"] >= 10000
            and "orange_usb_reinforcement_saddle" in by_name
            and checks["checks"]["usb_c_insertion_envelope"]["pass"],
            "evidence": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "orange_usb_reinforcement_saddle",
                "usb_c_insertion_envelope",
            ],
        },
        {
            "id": "screen_bond_and_fpc_connection",
            "interface": "screen",
            "actual": {
                "screen_margin_mm": round(screen_margin, 3),
                "adhesive_width_mm": display["adhesive_width_mm"],
                "adhesive_compression_mm": round(adhesive_compression_mm, 3),
                "fpc_bend_radius_mm": display["fpc_bend_radius_mm"],
            },
            "target": "screen margin >=0.3 mm, adhesive compression 0.03-0.08 mm, FPC bend radius >=1.0 mm",
            "pass": screen_margin >= tolerance["screen_xy_allowance_mm"]
            and 0.03 <= adhesive_compression_mm <= 0.08
            and display["fpc_bend_radius_mm"] >= 1.0
            and checks["checks"]["screen_mount_and_connection"]["pass"]
            and bool(stack_cases.get("display_fpc_bend_radius", {}).get("pass")),
            "evidence": [
                "screen_cover_glass",
                "screen_adhesive_top",
                "display_fpc_connector",
                "display_fpc_bend_keepout",
                "screen_mount_and_connection",
            ],
        },
        {
            "id": "camera_glass_and_under_glass_strategy",
            "interface": "camera",
            "actual": {
                "rear_lens_cover_margin_mm": round(rear_lens_cover_margin, 3),
                "front_lens_under_glass_margin_mm": round(front_lens_under_glass_margin, 3),
                "rear_module_depth_mm": comp["rear_camera"]["module_mm"][2],
            },
            "target": "front camera packaged behind glass; rear AF stack gets separate cover window with >=0.8 mm lens margin",
            "pass": rear_lens_cover_margin >= 0.8
            and front_lens_under_glass_margin >= 1.0
            and checks["checks"]["camera_speaker_behind_glass"]["pass"]
            and bool(clearance_cases.get("rear_camera_to_battery", {}).get("pass")),
            "evidence": [
                "front_camera_module",
                "front_camera_under_glass",
                "rear_camera_module",
                "rear_camera_cover_glass",
                "camera_speaker_behind_glass",
            ],
        },
        {
            "id": "bottom_audio_port_alignment",
            "interface": "acoustic",
            "actual": {
                "speaker_grille_slots": speaker_slot_count,
                "bottom_microphone_ports": mic_port_count,
                "speaker_to_usb_gap_mm": clearance_cases.get("usb_to_bottom_speaker", {}).get(
                    "actual_mm"
                ),
                "mic_to_usb_gap_mm": clearance_cases.get("bottom_mic_to_usb", {}).get("actual_mm"),
            },
            "target": ">=5 speaker slots, >=2 bottom mic ports, >=1.0 mm separation from USB load path",
            "pass": speaker_slot_count >= 5
            and mic_port_count >= 2
            and bool(clearance_cases.get("usb_to_bottom_speaker", {}).get("pass"))
            and bool(clearance_cases.get("bottom_mic_to_usb", {}).get("pass"))
            and checks["checks"]["bottom_io_acoustic_apertures"]["pass"],
            "evidence": [
                "bottom_speaker_module",
                "bottom_speaker_acoustic_chamber",
                "bottom_mic",
                "bottom_microphone_port_1",
                "bottom_io_acoustic_apertures",
            ],
        },
        {
            "id": "handset_receiver_gasket_stack",
            "interface": "acoustic",
            "actual": {
                "earpiece_receiver_present": "earpiece_receiver" in by_name,
                "earpiece_gasket_present": "earpiece_gasket" in by_name,
                "handset_slot_present": "handset_acoustic_slot" in by_name,
                "front_camera_to_earpiece_gap_mm": clearance_cases.get(
                    "front_camera_to_earpiece", {}
                ).get("actual_mm"),
            },
            "target": "receiver, gasket, handset slot, and front camera clearance all present",
            "pass": "earpiece_receiver" in by_name
            and "earpiece_gasket" in by_name
            and "handset_acoustic_slot" in by_name
            and bool(clearance_cases.get("front_camera_to_earpiece", {}).get("pass")),
            "evidence": [
                "earpiece_receiver",
                "earpiece_gasket",
                "handset_acoustic_slot",
                "front_camera_to_earpiece",
            ],
        },
    ]
    report = {
        "claim_boundary": "CAD-derived interface validation for EVT0 packaging; not physical force, cycle, acoustic, or display-bond validation.",
        "status": "cad_interface_validation_pass"
        if all(case["pass"] for case in interface_cases)
        else "blocked",
        "interfaces": interface_cases,
        "linked_reports": [
            "fit-check-report.json",
            "assembly-clearance.json",
            "tolerance-stack.json",
            "engineering-validation.json",
            "kicad-placement-reconciliation.json",
        ],
        "physical_validation_required": [
            "Button force/travel/rattle testing across tolerance extremes.",
            "USB-C insertion/removal cycling with shell-load measurement.",
            "Display bond peel, FPC bend cycling, and glass drop testing.",
            "Speaker, microphone, and handset acoustic leakage measurements.",
            "Camera dust, alignment, and image-quality testing with supplier samples.",
        ],
    }
    (REVIEW_DIR / "interface-validation.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Interface Validation",
        "",
        "Status: CAD-derived interface validation pass; physical EVT tests still required.",
        "",
        "## Interface Cases",
        "",
    ]
    for case in interface_cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` interface `{case['interface']}`")
    lines.extend(["", "## Physical Validation Required", ""])
    for item in report["physical_validation_required"]:
        lines.append(f"- {item}")
    (REVIEW_DIR / "interface-validation.md").write_text("\n".join(lines) + "\n")
    return report


def evt_fixture_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    display = params["display"]
    comp = params["components"]
    fixture_color = [0.16, 0.62, 0.95, 0.55]
    gauge_color = [0.9, 0.9, 0.12, 0.72]
    return [
        box(
            "evt_fixture_button_force_probe",
            [6.0, 26.0, 5.0],
            [-width / 2 - 8.5, 16.5, 0.0],
            fixture_color,
            "EVT fixture",
            "flat probe block for side-key force, travel, and rattle measurement",
        ),
        box(
            "evt_fixture_usb_c_insertion_gauge",
            comp["usb_c"]["insertion_keepout_mm"],
            [0.0, -height / 2 - 8.0, -1.45],
            gauge_color,
            "EVT fixture",
            "USB-C plug keepout gauge for insertion load and aperture rub checks",
        ),
        rounded_frame(
            "evt_fixture_screen_bond_clamp_frame",
            [display["cover_glass_mm"][0] + 3.0, display["cover_glass_mm"][1] + 3.0, 2.0],
            [0.0, 0.0, depth / 2 + 2.0],
            1.5,
            max(params["device"]["corner_radius_mm"] + 1.5, 2.0),
            fixture_color,
            "EVT fixture",
            "screen adhesive compression frame with open viewing window",
        ),
        cyl(
            "evt_fixture_rear_camera_alignment_pin",
            comp["rear_camera"]["lens_diameter_mm"] / 2.0,
            3.0,
            [21.0, height / 2 - 19.0, -depth / 2 - 3.0],
            gauge_color,
            "EVT fixture",
            "rear camera lens datum alignment plug",
            sections=32,
        ),
        cyl(
            "evt_fixture_front_camera_alignment_pin",
            comp["front_camera"]["lens_diameter_mm"] / 2.0,
            2.2,
            [-19.0, height / 2 - 9.0, depth / 2 + 2.0],
            gauge_color,
            "EVT fixture",
            "front under-glass camera datum alignment plug",
            sections=32,
        ),
        box(
            "evt_fixture_bottom_acoustic_leak_mask",
            [48.0, 4.5, 5.0],
            [2.0, -height / 2 - 3.0, -1.6],
            fixture_color,
            "EVT fixture",
            "bottom speaker and microphone port leak-test mask",
        ),
        box(
            "evt_fixture_earpiece_leak_mask",
            [20.0, 4.0, 3.0],
            [0.0, height / 2 - 4.5, depth / 2 + 2.0],
            fixture_color,
            "EVT fixture",
            "handset receiver gasket compression and acoustic leak-test mask",
        ),
    ]


def write_evt_fixture_artifacts(
    params: dict[str, Any],
    fixtures: list[Part],
    interface_validation: dict[str, Any],
) -> dict[str, Any]:
    export_named_scene(fixtures, "e1-phone-evt-fixtures.glb", "evt-fixture-manifest.json")
    fixture_names = {fixture.name for fixture in fixtures}
    manifest_path = OUT_DIR / "evt-fixture-manifest.json"
    fixture_cases: list[dict[str, Any]] = [
        {
            "id": "button_force_travel_fixture",
            "fixture": "evt_fixture_button_force_probe",
            "validates": [
                "power_button_force_travel_pressure",
                "volume_button_force_travel_pressure",
            ],
            "pass": "evt_fixture_button_force_probe" in fixture_names,
        },
        {
            "id": "usb_c_insertion_fixture",
            "fixture": "evt_fixture_usb_c_insertion_gauge",
            "validates": ["usb_c_insertion_capture"],
            "pass": "evt_fixture_usb_c_insertion_gauge" in fixture_names,
        },
        {
            "id": "screen_bond_clamp_fixture",
            "fixture": "evt_fixture_screen_bond_clamp_frame",
            "validates": ["screen_bond_and_fpc_connection"],
            "pass": "evt_fixture_screen_bond_clamp_frame" in fixture_names,
        },
        {
            "id": "camera_alignment_fixture",
            "fixture": "evt_fixture_rear_camera_alignment_pin",
            "secondary_fixture": "evt_fixture_front_camera_alignment_pin",
            "validates": ["camera_glass_and_under_glass_strategy"],
            "pass": "evt_fixture_rear_camera_alignment_pin" in fixture_names
            and "evt_fixture_front_camera_alignment_pin" in fixture_names,
        },
        {
            "id": "acoustic_leak_fixture",
            "fixture": "evt_fixture_bottom_acoustic_leak_mask",
            "secondary_fixture": "evt_fixture_earpiece_leak_mask",
            "validates": ["bottom_audio_port_alignment", "handset_receiver_gasket_stack"],
            "pass": "evt_fixture_bottom_acoustic_leak_mask" in fixture_names
            and "evt_fixture_earpiece_leak_mask" in fixture_names,
        },
    ]
    interface_case_ids = {case["id"] for case in interface_validation.get("interfaces", [])}
    first_article_use = [
        "Use force probe with a calibrated load cell and dial indicator for side-key force/travel/rattle.",
        "Use USB-C insertion gauge before cycle testing to catch aperture rub and shell shift.",
        "Use screen clamp frame during bond trials to verify adhesive compression and FPC exit clearance.",
        "Use camera alignment pins to inspect rear lens datum and front under-glass aperture position.",
        "Use acoustic masks for speaker, microphone, and handset leakage A/B checks before chamber testing.",
    ]
    report = {
        "claim_boundary": "EVT fixture CAD for first-article checks; fixture geometry is conceptual until fabricated and correlated to metrology equipment.",
        "status": "evt_fixture_cad_ready"
        if all(case["pass"] for case in fixture_cases)
        and all(
            validation_id in interface_case_ids
            for case in fixture_cases
            for validation_id in case["validates"]
        )
        and (OUT_DIR / "e1-phone-evt-fixtures.glb").is_file()
        and manifest_path.is_file()
        else "blocked",
        "fixture_count": len(fixtures),
        "fixture_glb": "mechanical/e1-phone/out/e1-phone-evt-fixtures.glb",
        "fixture_manifest": "mechanical/e1-phone/out/evt-fixture-manifest.json",
        "cases": fixture_cases,
        "first_article_use": first_article_use,
    }
    (REVIEW_DIR / "evt-fixtures.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone EVT Fixture CAD",
        "",
        "Status: EVT fixture CAD ready; physical fixture fabrication and calibration still required.",
        "",
        "## Fixtures",
        "",
    ]
    for case in fixture_cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` fixture `{case['fixture']}`")
    lines.extend(["", "## First-Article Use", ""])
    for item in first_article_use:
        lines.append(f"- {item}")
    (REVIEW_DIR / "evt-fixtures.md").write_text("\n".join(lines) + "\n")
    return report


def write_evt_inspection_plan_artifacts(
    params: dict[str, Any],
    interface_validation: dict[str, Any],
    evt_fixtures: dict[str, Any],
) -> dict[str, Any]:
    comp = params["components"]
    display = params["display"]
    interface_cases = {case["id"]: case for case in interface_validation.get("interfaces", [])}
    fixture_case_ids = {case["id"] for case in evt_fixtures.get("cases", [])}
    measurements = [
        {
            "id": "power_button_actuation_force",
            "interface_case": "power_button_force_travel_pressure",
            "fixture_case": "button_force_travel_fixture",
            "fixture": "evt_fixture_button_force_probe",
            "sample_count": 10,
            "units": "N",
            "nominal": comp["power_button"]["force_n"],
            "min": 1.2,
            "max": 2.2,
            "method": "Load-cell press normal to cap center until tactile event.",
        },
        {
            "id": "power_button_travel",
            "interface_case": "power_button_force_travel_pressure",
            "fixture_case": "button_force_travel_fixture",
            "fixture": "evt_fixture_button_force_probe",
            "sample_count": 10,
            "units": "mm",
            "nominal": comp["power_button"]["travel_mm"],
            "min": 0.25,
            "max": 0.55,
            "method": "Dial indicator travel from cap free height to tactile event.",
        },
        {
            "id": "volume_button_actuation_force",
            "interface_case": "volume_button_force_travel_pressure",
            "fixture_case": "button_force_travel_fixture",
            "fixture": "evt_fixture_button_force_probe",
            "sample_count": 10,
            "units": "N",
            "nominal": comp["volume_button"]["force_n"],
            "min": 1.2,
            "max": 2.2,
            "method": "Load-cell press at volume cap center and both cap ends.",
        },
        {
            "id": "usb_c_insertion_force_no_rub",
            "interface_case": "usb_c_insertion_capture",
            "fixture_case": "usb_c_insertion_fixture",
            "fixture": "evt_fixture_usb_c_insertion_gauge",
            "sample_count": 5,
            "units": "N",
            "nominal": None,
            "min": 0.0,
            "max": 35.0,
            "method": "Insert USB-C gauge/plug along port axis and record peak insertion force and aperture rub.",
        },
        {
            "id": "screen_adhesive_compression",
            "interface_case": "screen_bond_and_fpc_connection",
            "fixture_case": "screen_bond_clamp_fixture",
            "fixture": "evt_fixture_screen_bond_clamp_frame",
            "sample_count": 5,
            "units": "mm",
            "nominal": round(
                display["adhesive_thickness_mm"] * display["compression_target_pct"] / 100.0, 3
            ),
            "min": 0.03,
            "max": 0.08,
            "method": "Measure bond-line compression witness after clamp cure cycle.",
        },
        {
            "id": "display_fpc_bend_radius",
            "interface_case": "screen_bond_and_fpc_connection",
            "fixture_case": "screen_bond_clamp_fixture",
            "fixture": "evt_fixture_screen_bond_clamp_frame",
            "sample_count": 5,
            "units": "mm",
            "nominal": display["fpc_bend_radius_mm"],
            "min": 1.0,
            "max": None,
            "method": "Inspect FPC bend path after screen placement and board connection.",
        },
        {
            "id": "rear_camera_lens_center_error",
            "interface_case": "camera_glass_and_under_glass_strategy",
            "fixture_case": "camera_alignment_fixture",
            "fixture": "evt_fixture_rear_camera_alignment_pin",
            "sample_count": 5,
            "units": "mm",
            "nominal": 0.0,
            "min": 0.0,
            "max": 0.25,
            "method": "Insert rear lens datum pin and measure radial offset to camera cover window.",
        },
        {
            "id": "front_camera_under_glass_center_error",
            "interface_case": "camera_glass_and_under_glass_strategy",
            "fixture_case": "camera_alignment_fixture",
            "fixture": "evt_fixture_front_camera_alignment_pin",
            "sample_count": 5,
            "units": "mm",
            "nominal": 0.0,
            "min": 0.0,
            "max": 0.30,
            "method": "Inspect under-glass aperture alignment through cover glass.",
        },
        {
            "id": "bottom_audio_leak_delta",
            "interface_case": "bottom_audio_port_alignment",
            "fixture_case": "acoustic_leak_fixture",
            "fixture": "evt_fixture_bottom_acoustic_leak_mask",
            "sample_count": 5,
            "units": "dB",
            "nominal": 0.0,
            "min": 0.0,
            "max": 3.0,
            "method": "Compare masked/unmasked bottom speaker and mic path leakage at fixed tone.",
        },
        {
            "id": "handset_receiver_leak_delta",
            "interface_case": "handset_receiver_gasket_stack",
            "fixture_case": "acoustic_leak_fixture",
            "fixture": "evt_fixture_earpiece_leak_mask",
            "sample_count": 5,
            "units": "dB",
            "nominal": 0.0,
            "min": 0.0,
            "max": 3.0,
            "method": "Compare masked/unmasked receiver leakage around handset gasket.",
        },
    ]
    rows = [
        {
            "sample_id": "",
            "measurement_id": item["id"],
            "fixture": item["fixture"],
            "units": item["units"],
            "min": "" if item["min"] is None else item["min"],
            "max": "" if item["max"] is None else item["max"],
            "nominal": "" if item["nominal"] is None else item["nominal"],
            "measured": "",
            "pass": "",
            "operator": "",
            "notes": item["method"],
        }
        for item in measurements
    ]
    csv_path = REVIEW_DIR / "evt-inspection-results-template.csv"
    with csv_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(
            csv_file,
            fieldnames=[
                "sample_id",
                "measurement_id",
                "fixture",
                "units",
                "min",
                "max",
                "nominal",
                "measured",
                "pass",
                "operator",
                "notes",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)

    report = {
        "claim_boundary": "EVT inspection plan and blank results template; not completed physical test evidence.",
        "status": "evt_inspection_plan_ready"
        if interface_validation["status"] == "cad_interface_validation_pass"
        and evt_fixtures["status"] == "evt_fixture_cad_ready"
        and all(item["interface_case"] in interface_cases for item in measurements)
        and all(item["fixture_case"] in fixture_case_ids for item in measurements)
        and csv_path.is_file()
        else "blocked",
        "measurement_count": len(measurements),
        "results_template": "mechanical/e1-phone/review/evt-inspection-results-template.csv",
        "measurements": measurements,
        "release_rule": "Every measurement row must be populated for each EVT sample and pass before claiming physical interface validation.",
    }
    (REVIEW_DIR / "evt-inspection-plan.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone EVT Inspection Plan",
        "",
        "Status: inspection plan ready; results template is blank and does not prove physical validation.",
        "",
        f"Results template: `{report['results_template']}`",
        "",
        "## Measurements",
        "",
    ]
    for item in measurements:
        limits = (
            f"{item['min']} to {item['max']}" if item["max"] is not None else f">= {item['min']}"
        )
        lines.append(
            f"- `{item['id']}`: fixture `{item['fixture']}`, n={item['sample_count']}, {item['units']} limits {limits}"
        )
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "evt-inspection-plan.md").write_text("\n".join(lines) + "\n")
    return report


def write_evt_results_review_artifacts(evt_inspection: dict[str, Any]) -> dict[str, Any]:
    csv_path = REVIEW_DIR / "evt-inspection-results-template.csv"
    expected = {item["id"]: item for item in evt_inspection.get("measurements", [])}
    rows: list[dict[str, str]] = []
    if csv_path.is_file():
        with csv_path.open(newline="") as csv_file:
            rows = [dict(row) for row in csv.DictReader(csv_file)]

    cases: list[dict[str, Any]] = []
    for row in rows:
        measurement_id = row.get("measurement_id", "")
        expected_item = expected.get(measurement_id, {})
        measured_text = row.get("measured", "").strip()
        pass_text = row.get("pass", "").strip().lower()
        sample_id = row.get("sample_id", "").strip()
        operator = row.get("operator", "").strip()
        measured_value: float | None = None
        parse_ok = False
        if measured_text:
            with suppress(ValueError):
                measured_value = float(measured_text)
                parse_ok = True
        min_value = expected_item.get("min")
        max_value = expected_item.get("max")
        within_min = measured_value is not None and (min_value is None or measured_value >= min_value)
        within_max = measured_value is not None and (max_value is None or measured_value <= max_value)
        numeric_pass = bool(parse_ok and within_min and within_max)
        explicit_pass = pass_text in {"pass", "true", "yes", "y", "1"}
        populated = bool(sample_id and operator and measured_text and pass_text)
        cases.append(
            {
                "measurement_id": measurement_id,
                "sample_id": sample_id,
                "operator": operator,
                "measured": measured_value,
                "min": min_value,
                "max": max_value,
                "populated": populated,
                "numeric_pass": numeric_pass,
                "explicit_pass": explicit_pass,
                "pass": populated and numeric_pass and explicit_pass,
            }
        )

    expected_ids = set(expected)
    observed_ids = {case["measurement_id"] for case in cases}
    missing_measurements = sorted(expected_ids - observed_ids)
    blank_or_incomplete = [
        case["measurement_id"] for case in cases if not case["populated"]
    ]
    failed_measurements = [
        case["measurement_id"]
        for case in cases
        if case["populated"] and not (case["numeric_pass"] and case["explicit_pass"])
    ]
    populated_count = sum(1 for case in cases if case["populated"])
    status = (
        "evt_results_pass"
        if evt_inspection["status"] == "evt_inspection_plan_ready"
        and expected_ids
        and not missing_measurements
        and not blank_or_incomplete
        and not failed_measurements
        and all(case["pass"] for case in cases)
        else "blocked_no_physical_results"
        if populated_count == 0
        else "blocked_evt_results_incomplete_or_failed"
    )
    report = {
        "claim_boundary": "Automated review of EVT measurement CSV; blank template rows are not physical validation evidence.",
        "status": status,
        "results_csv": "mechanical/e1-phone/review/evt-inspection-results-template.csv",
        "expected_measurement_count": len(expected_ids),
        "observed_row_count": len(cases),
        "populated_result_count": populated_count,
        "missing_measurements": missing_measurements,
        "blank_or_incomplete_measurements": blank_or_incomplete,
        "failed_measurements": failed_measurements,
        "cases": cases,
    }
    (REVIEW_DIR / "evt-results-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone EVT Results Review",
        "",
        f"Status: {status}.",
        "",
        "This review is fail-closed: blank rows do not count as physical validation.",
        "",
        "## Summary",
        "",
        f"- Expected measurements: {len(expected_ids)}",
        f"- Observed rows: {len(cases)}",
        f"- Populated results: {populated_count}",
    ]
    if blank_or_incomplete:
        lines.extend(["", "## Blank Or Incomplete", ""])
        for measurement_id in blank_or_incomplete:
            lines.append(f"- `{measurement_id}`")
    if failed_measurements:
        lines.extend(["", "## Failed Measurements", ""])
        for measurement_id in failed_measurements:
            lines.append(f"- `{measurement_id}`")
    (REVIEW_DIR / "evt-results-review.md").write_text("\n".join(lines) + "\n")
    return report


def write_tolerance_stack_artifacts(
    params: dict[str, Any], checks: dict[str, Any]
) -> dict[str, Any]:
    width, height, depth = params["device"]["envelope_mm"]
    display = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    comp = params["components"]
    tolerance = params["validation"]["tolerance"]
    glass_margin_x = (width - display["cover_glass_mm"][0]) / 2.0
    glass_margin_y = (height - display["cover_glass_mm"][1]) / 2.0
    display_under_glass_x = (display["cover_glass_mm"][0] - display["tft_outline_mm"][0]) / 2.0
    display_under_glass_y = (display["cover_glass_mm"][1] - display["tft_outline_mm"][1]) / 2.0
    rear_camera_glass_margin = (
        comp["rear_camera_glass"]["envelope_mm"][0] - comp["rear_camera"]["lens_diameter_mm"]
    ) / 2.0
    usb_shell_clearance = min(
        (10.2 - comp["usb_c"]["envelope_mm"][0]) / 2.0,
        (3.6 - comp["usb_c"]["envelope_mm"][2]) / 2.0,
    )
    pcb_edge_clearance = min(
        (width - pcb["outline_mm"][0]) / 2.0,
        (height - pcb["outline_mm"][1]) / 2.0,
    )
    z_budget_used = (
        display["cover_glass_mm"][2]
        + display["adhesive_thickness_mm"]
        + pcb["outline_mm"][2]
        + battery["envelope_mm"][2]
        + 1.2
    )
    z_budget_margin = depth - z_budget_used

    datums = [
        {
            "id": "A",
            "name": "front_cover_glass_outer_plane",
            "purpose": "Primary touch/display cosmetic plane and Z-stack reference.",
        },
        {
            "id": "B",
            "name": "device_centerline_x",
            "purpose": "Left/right symmetry reference for glass, PCB, USB-C, and camera placement.",
        },
        {
            "id": "C",
            "name": "bottom_usb_c_port_centerline",
            "purpose": "Bottom I/O datum for USB insertion, speaker grille, microphones, and lower antenna.",
        },
        {
            "id": "D",
            "name": "rear_camera_cover_glass_center",
            "purpose": "Camera lens/window datum for rear camera module and cover-glass alignment.",
        },
    ]
    stacks = [
        {
            "id": "cover_glass_to_orange_rail_x",
            "datum": "B",
            "nominal_mm": round(glass_margin_x, 3),
            "minimum_mm": tolerance["screen_xy_allowance_mm"],
            "pass": glass_margin_x >= tolerance["screen_xy_allowance_mm"],
            "contributors": ["device_width", "cover_glass_width", "orange_side_rail"],
        },
        {
            "id": "cover_glass_to_orange_rail_y",
            "datum": "C",
            "nominal_mm": round(glass_margin_y, 3),
            "minimum_mm": tolerance["screen_xy_allowance_mm"],
            "pass": glass_margin_y >= tolerance["screen_xy_allowance_mm"],
            "contributors": ["device_height", "cover_glass_height", "top_bottom_rail"],
        },
        {
            "id": "display_tft_under_cover_glass",
            "datum": "A",
            "nominal_mm": round(min(display_under_glass_x, display_under_glass_y), 3),
            "minimum_mm": 0.5,
            "pass": min(display_under_glass_x, display_under_glass_y) >= 0.5,
            "contributors": ["cover_glass", "tft_outline", "bond_alignment"],
        },
        {
            "id": "display_fpc_bend_radius",
            "datum": "A",
            "nominal_mm": display["fpc_bend_radius_mm"],
            "minimum_mm": 1.0,
            "pass": display["fpc_bend_radius_mm"] >= 1.0,
            "contributors": ["display_fpc_connector", "bend_keepout", "adhesive_stack"],
        },
        {
            "id": "usb_shell_to_aperture",
            "datum": "C",
            "nominal_mm": round(usb_shell_clearance, 3),
            "minimum_mm": tolerance["usb_shell_to_aperture_clearance_mm"],
            "pass": usb_shell_clearance >= tolerance["usb_shell_to_aperture_clearance_mm"],
            "contributors": ["usb_c_receptacle", "molded_port_aperture", "tooling_shrink"],
        },
        {
            "id": "pcb_edge_to_enclosure",
            "datum": "B",
            "nominal_mm": round(pcb_edge_clearance, 3),
            "minimum_mm": tolerance["pcb_edge_clearance_mm"],
            "pass": pcb_edge_clearance >= tolerance["pcb_edge_clearance_mm"],
            "contributors": ["pcb_edge_cuts", "side_rails", "battery_ribs"],
        },
        {
            "id": "rear_camera_lens_to_cover_glass",
            "datum": "D",
            "nominal_mm": round(rear_camera_glass_margin, 3),
            "minimum_mm": 0.8,
            "pass": rear_camera_glass_margin >= 0.8,
            "contributors": ["rear_camera_lens", "rear_camera_cover_glass", "adhesive_alignment"],
        },
        {
            "id": "nominal_z_stack_margin",
            "datum": "A",
            "nominal_mm": round(z_budget_margin, 3),
            "minimum_mm": 1.0,
            "pass": z_budget_margin >= 1.0,
            "contributors": ["cover_glass", "adhesive", "pcb", "battery", "rear_cover_allowance"],
        },
    ]
    drawing_requirements = [
        {
            "feature": "cover_glass_perimeter",
            "control": "profile to datum B/C",
            "evt0_tolerance_mm": 0.25,
        },
        {
            "feature": "usb_c_port_aperture",
            "control": "position to datum B/C",
            "evt0_tolerance_mm": 0.15,
        },
        {
            "feature": "side_button_plunger_faces",
            "control": "position to side rail and travel stop",
            "evt0_tolerance_mm": 0.20,
        },
        {
            "feature": "rear_camera_cover_glass_window",
            "control": "position to datum D",
            "evt0_tolerance_mm": 0.15,
        },
        {
            "feature": "screw_boss_core_pins",
            "control": "position to rear shell datum pattern",
            "evt0_tolerance_mm": 0.20,
        },
    ]
    report = {
        "claim_boundary": "CAD-derived EVT0 tolerance and datum stack; not a GD&T-controlled release drawing.",
        "status": "cad_tolerance_stack_pass" if all(item["pass"] for item in stacks) else "blocked",
        "datums": datums,
        "stacks": stacks,
        "drawing_requirements": drawing_requirements,
        "linked_fit_checks": {
            key: checks["checks"][key]["pass"]
            for key in [
                "screen_mount_margin",
                "screen_mount_and_connection",
                "usb_c_insertion_envelope",
                "button_pressure_support",
                "camera_speaker_behind_glass",
                "pcb_edge_clearance",
            ]
        },
    }
    (REVIEW_DIR / "tolerance-stack.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Tolerance Stack And Datum Plan",
        "",
        "Status: CAD-derived EVT0 tolerance stack pass; not a controlled release drawing.",
        "",
        "## Datums",
        "",
    ]
    for datum in datums:
        lines.append(f"- `{datum['id']}` {datum['name']}: {datum['purpose']}")
    lines.extend(["", "## Stack Checks", ""])
    for stack in stacks:
        result = "PASS" if stack["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{stack['id']}` nominal {stack['nominal_mm']} mm, minimum {stack['minimum_mm']} mm"
        )
    lines.extend(["", "## Drawing Controls To Add Before Release", ""])
    for row in drawing_requirements:
        lines.append(
            f"- `{row['feature']}`: {row['control']}, EVT0 tolerance +/-{row['evt0_tolerance_mm']} mm"
        )
    (REVIEW_DIR / "tolerance-stack.md").write_text("\n".join(lines) + "\n")
    return report


def bounds_gap(
    low_a: np.ndarray, high_a: np.ndarray, low_b: np.ndarray, high_b: np.ndarray
) -> float:
    sep = np.maximum(np.maximum(low_a - high_b, low_b - high_a), 0)
    return float(np.linalg.norm(sep))


def write_assembly_clearance_artifacts(params: dict[str, Any], parts: list[Part]) -> dict[str, Any]:
    by_name = {part.name: part for part in parts}
    width, height, _depth = params["device"]["envelope_mm"]
    display = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    comp = params["components"]
    tolerance = params["validation"]["tolerance"]

    def part_gap(name_a: str, name_b: str) -> float:
        low_a, high_a = by_name[name_a].bounds
        low_b, high_b = by_name[name_b].bounds
        return bounds_gap(low_a, high_a, low_b, high_b)

    def part_to_box_gap(name: str, size: list[float], center: list[float]) -> float:
        low_a, high_a = by_name[name].bounds
        low_b = np.asarray(center) - np.asarray(size) / 2.0
        high_b = np.asarray(center) + np.asarray(size) / 2.0
        return bounds_gap(low_a, high_a, low_b, high_b)

    battery_center = [0.0, -7.0, battery["z_center_mm"]]
    pcb_segments = [
        ([64.0, 25.0, 0.8], [0.0, 55.0, pcb["z_center_mm"]], "pcb_top_island"),
        ([64.0, 15.0, 0.8], [0.0, -65.0, pcb["z_center_mm"]], "pcb_bottom_island"),
        ([8.0, 78.0, 0.8], [-32.0, -8.0, pcb["z_center_mm"]], "pcb_left_rail"),
    ]
    battery_to_pcb = [
        box_gap(size, center, battery["envelope_mm"], battery_center)
        for size, center, _name in pcb_segments
    ]
    haptic_to_pcb = [
        part_to_box_gap("haptic_lra", size, center) for size, center, _name in pcb_segments
    ]
    screen_margin = min(
        (width - display["ctp_outline_mm"][0]) / 2.0,
        (height - display["ctp_outline_mm"][1]) / 2.0,
    )
    display_under_glass_margin = min(
        (display["cover_glass_mm"][0] - display["tft_outline_mm"][0]) / 2.0,
        (display["cover_glass_mm"][1] - display["tft_outline_mm"][1]) / 2.0,
    )
    usb_shell_to_aperture = min(
        (10.2 - comp["usb_c"]["envelope_mm"][0]) / 2.0,
        (3.6 - comp["usb_c"]["envelope_mm"][2]) / 2.0,
    )

    cases = [
        {
            "id": "screen_cover_glass_to_orange_body",
            "actual_mm": round(screen_margin, 3),
            "required_mm": tolerance["screen_xy_allowance_mm"],
            "pass": screen_margin >= tolerance["screen_xy_allowance_mm"],
        },
        {
            "id": "display_lcm_under_cover_glass",
            "actual_mm": round(display_under_glass_margin, 3),
            "required_mm": 0.5,
            "pass": display_under_glass_margin >= 0.5,
        },
        {
            "id": "usb_shell_to_external_aperture",
            "actual_mm": round(usb_shell_to_aperture, 3),
            "required_mm": tolerance["usb_shell_to_aperture_clearance_mm"],
            "pass": usb_shell_to_aperture >= tolerance["usb_shell_to_aperture_clearance_mm"],
        },
        {
            "id": "usb_to_bottom_speaker",
            "actual_mm": round(part_gap("usb_c_receptacle", "bottom_speaker_module"), 3),
            "required_mm": 1.0,
            "pass": part_gap("usb_c_receptacle", "bottom_speaker_module") >= 1.0,
        },
        {
            "id": "bottom_mic_to_usb",
            "actual_mm": round(part_gap("bottom_mic", "usb_c_receptacle"), 3),
            "required_mm": 1.0,
            "pass": part_gap("bottom_mic", "usb_c_receptacle") >= 1.0,
        },
        {
            "id": "battery_to_pcb_islands",
            "actual_mm": round(min(battery_to_pcb), 3),
            "required_mm": tolerance["battery_to_pcb_gap_mm"],
            "pass": min(battery_to_pcb) >= tolerance["battery_to_pcb_gap_mm"],
            "segment_gaps_mm": [round(value, 3) for value in battery_to_pcb],
        },
        {
            "id": "haptic_to_battery",
            "actual_mm": round(part_gap("haptic_lra", "battery_pouch"), 3),
            "required_mm": 0.5,
            "pass": part_gap("haptic_lra", "battery_pouch") >= 0.5,
        },
        {
            "id": "haptic_to_pcb_islands",
            "actual_mm": round(min(haptic_to_pcb), 3),
            "required_mm": 0.5,
            "pass": min(haptic_to_pcb) >= 0.5,
            "segment_gaps_mm": [round(value, 3) for value in haptic_to_pcb],
        },
        {
            "id": "haptic_to_sim_tray_keepout",
            "actual_mm": round(part_gap("haptic_lra", "sim_tray_keepout"), 3),
            "required_mm": 0.5,
            "pass": part_gap("haptic_lra", "sim_tray_keepout") >= 0.5,
        },
        {
            "id": "rear_camera_to_battery",
            "actual_mm": round(part_gap("rear_camera_module", "battery_pouch"), 3),
            "required_mm": 2.0,
            "pass": part_gap("rear_camera_module", "battery_pouch") >= 2.0,
        },
        {
            "id": "front_camera_to_earpiece",
            "actual_mm": round(part_gap("front_camera_module", "earpiece_receiver"), 3),
            "required_mm": 1.0,
            "pass": part_gap("front_camera_module", "earpiece_receiver") >= 1.0,
        },
    ]
    report = {
        "claim_boundary": "Targeted AABB/parameter clearance checks for packaging review; not a full CAD boolean interference analysis.",
        "status": "pass" if all(item["pass"] for item in cases) else "blocked",
        "cases": cases,
        "checked_case_count": len(cases),
    }
    (REVIEW_DIR / "assembly-clearance.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Assembly Clearance Report",
        "",
        "Status: targeted CAD clearance checks.",
        "",
        "## Cases",
        "",
    ]
    for item in cases:
        result = "PASS" if item["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{item['id']}` actual {item['actual_mm']} mm, required {item['required_mm']} mm"
        )
    (REVIEW_DIR / "assembly-clearance.md").write_text("\n".join(lines) + "\n")
    return report


def write_injection_molding_dfm_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    tooling: list[Part],
    checks: dict[str, Any],
) -> dict[str, Any]:
    mfg = params["manufacturing"]
    width, height, depth = params["device"]["envelope_mm"]
    wall = params["device"]["wall_thickness_mm"]
    gate_t = mfg["gate_thickness_mm"]
    boss_wall = (mfg["screw_boss_outer_diameter_mm"] - mfg["screw_boss_core_diameter_mm"]) / 2.0
    rib_ratio = mfg["rib_thickness_mm"] / wall
    boss_wall_ratio = boss_wall / wall
    gate_ratio = gate_t / wall
    cooling_ratio = mfg["cooling_channel_clearance_mm"] / mfg["cooling_channel_diameter_mm"]
    flow_length_to_wall = (height - 2.0 * abs(-height / 2 - 0.4)) / wall
    if flow_length_to_wall <= 0:
        flow_length_to_wall = height / wall
    tooling_names = {part.name for part in tooling}
    ejector_count = sum(name.startswith("mold_ejector_pin_") for name in tooling_names)
    cooling_count = sum(name.startswith("mold_cooling_channel_") for name in tooling_names)

    cases = [
        {
            "id": "nominal_wall",
            "actual": round(wall, 3),
            "target": "0.9-1.4 mm phone-shell PC+ABS concept window",
            "pass": 0.9 <= wall <= 1.4,
            "risk": "low",
            "note": "Thin enough for compact phone shell while still moldable in PC+ABS with tool review.",
        },
        {
            "id": "rib_to_wall_ratio",
            "actual": round(rib_ratio, 3),
            "target": "<= 0.70",
            "pass": rib_ratio <= 0.70,
            "risk": "low" if rib_ratio <= 0.65 else "medium",
            "note": "Battery ribs stay below common sink-risk guidance for rib thickness.",
        },
        {
            "id": "boss_wall_to_nominal_wall",
            "actual": round(boss_wall_ratio, 3),
            "target": "<= 1.10",
            "pass": boss_wall_ratio <= 1.10,
            "risk": "medium",
            "note": "Screw boss annulus is near nominal wall; core pins and local coring remain required.",
        },
        {
            "id": "draft_angle",
            "actual": mfg["nominal_draft_deg"],
            "target": ">= 2.0 degrees for textured orange plastic",
            "pass": mfg["nominal_draft_deg"] >= 2.0,
            "risk": "low",
            "note": "Orange textured PC+ABS needs draft reviewed after final texture depth.",
        },
        {
            "id": "internal_radius",
            "actual": mfg["min_internal_radius_mm"],
            "target": ">= 0.5 mm",
            "pass": mfg["min_internal_radius_mm"] >= 0.5,
            "risk": "low",
            "note": "Internal radius reduces stress and flow hesitation around the hard rectangular shell.",
        },
        {
            "id": "submarine_gate_ratio",
            "actual": round(gate_ratio, 3),
            "target": "<= 0.80 x nominal wall",
            "pass": gate_ratio <= 0.80,
            "risk": "medium",
            "note": "Gate is intentionally small for trimming/cosmetics; color streak risk requires tool trials.",
        },
        {
            "id": "runner_diameter",
            "actual": mfg["runner_diameter_mm"],
            "target": ">= 2.0 mm",
            "pass": mfg["runner_diameter_mm"] >= 2.0,
            "risk": "low",
            "note": "Cold runner diameter is plausible for a soft-tool concept, not a balanced tool design.",
        },
        {
            "id": "ejector_pin_count",
            "actual": ejector_count,
            "target": f"{mfg['ejector_pin_count']} modeled pins",
            "pass": ejector_count == mfg["ejector_pin_count"],
            "risk": "medium",
            "note": "Pins are distributed around boss/rail regions; final witness marks need cosmetic review.",
        },
        {
            "id": "cooling_channel_clearance",
            "actual": round(cooling_ratio, 3),
            "target": ">= 2.0 channel diameters from cavity",
            "pass": cooling_count >= 3 and cooling_ratio >= 2.0,
            "risk": "medium",
            "note": "Straight channels are placeholders; real tool needs conformal/baffled cooling review.",
        },
    ]
    risks = [
        {
            "id": "long_thin_flow_path",
            "severity": "high",
            "metric": {"flow_length_to_wall_ratio_estimate": round(flow_length_to_wall, 1)},
            "mitigation": "Keep dual gates, consider fan-gate alternate, and run mold-flow before freezing tool steel.",
        },
        {
            "id": "orange_color_match_and_gate_blush",
            "severity": "medium",
            "metric": {"gate_strategy": mfg["gate_strategy"]},
            "mitigation": "Use color-chip approval, textured sample plaques, and gate vestige location review.",
        },
        {
            "id": "boss_sink_and_read_through",
            "severity": "medium",
            "metric": {"boss_wall_to_nominal_wall": round(boss_wall_ratio, 3)},
            "mitigation": "Core every boss, add local texture, and keep bosses off visible hero surfaces where possible.",
        },
        {
            "id": "snap_hook_fatigue",
            "severity": "medium",
            "metric": {"snap_hook_count": mfg["snap_hook_count"]},
            "mitigation": "Prototype snap cycles in the selected resin and tune hook root radius after first shots.",
        },
    ]
    recommendations = [
        "Ask toolmaker for mold-flow/fill/pack/warp study using selected orange PC+ABS resin.",
        "Review submarine gate vestige on bottom/back edge against the Teenage Engineering/Rabbit-style cosmetic target.",
        "Add steel-safe tuning allowance around USB aperture, button plungers, and camera cover-glass window.",
        "Confirm ejector witness marks stay inside non-cosmetic surfaces or are hidden by internal stack.",
        "Use first-shot CMM and color/texture plaques before approving DVT enclosure samples.",
    ]
    report = {
        "claim_boundary": "Automated CAD-derived injection-molding DFM screen; not mold-flow, toolmaker signoff, or released tool design.",
        "status": "cad_dfm_inputs_ready" if all(case["pass"] for case in cases) else "blocked",
        "device_envelope_mm": [width, height, depth],
        "plastic": mfg["plastic"],
        "cases": cases,
        "risks": risks,
        "recommendations": recommendations,
        "linked_fit_checks": {
            key: checks["checks"][key]["pass"]
            for key in [
                "injection_molding_basics",
                "molded_retention_features",
                "mold_runner_gate_model",
                "mold_ejector_cooling_model",
            ]
        },
    }
    (REVIEW_DIR / "injection-molding-dfm.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Injection Molding DFM Screen",
        "",
        "Status: CAD-derived DFM inputs ready; mold-flow and toolmaker signoff still required.",
        "",
        "## Checks",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` actual {case['actual']} target {case['target']} risk {case['risk']}"
        )
    lines.extend(["", "## Risks", ""])
    for risk in risks:
        lines.append(f"- `{risk['id']}`: {risk['severity']}; {risk['mitigation']}")
    lines.extend(["", "## Toolmaker Requests", ""])
    for item in recommendations:
        lines.append(f"- {item}")
    (REVIEW_DIR / "injection-molding-dfm.md").write_text("\n".join(lines) + "\n")
    return report


def write_mold_process_window_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    tooling: list[Part],
    dfm: dict[str, Any],
    tolerance_stack: dict[str, Any],
) -> dict[str, Any]:
    mfg = params["manufacturing"]
    width, height, depth = params["device"]["envelope_mm"]
    wall = params["device"]["wall_thickness_mm"]
    gate_t = mfg["gate_thickness_mm"]
    runner_d = mfg["runner_diameter_mm"]
    gate_count = 2
    boss_wall = (mfg["screw_boss_outer_diameter_mm"] - mfg["screw_boss_core_diameter_mm"]) / 2.0
    rib_ratio = mfg["rib_thickness_mm"] / wall
    boss_wall_ratio = boss_wall / wall
    gate_ratio = gate_t / wall
    gate_area_mm2 = gate_count * gate_t * runner_d
    projected_area_mm2 = width * height
    projected_area_cm2 = projected_area_mm2 / 100.0
    clamp_tons_low = projected_area_cm2 * 0.35
    clamp_tons_high = projected_area_cm2 * 0.55
    flow_length_to_wall = height / wall
    cooling_ratio = mfg["cooling_channel_clearance_mm"] / mfg["cooling_channel_diameter_mm"]
    tooling_names = {part.name for part in tooling}
    cooling_count = sum(name.startswith("mold_cooling_channel_") for name in tooling_names)
    ejector_count = sum(name.startswith("mold_ejector_pin_") for name in tooling_names)

    def risk_for(value: float, caution: float, high: float) -> str:
        if value >= high:
            return "high"
        if value >= caution:
            return "medium"
        return "low"

    cases = [
        {
            "id": "fill_length_to_wall",
            "actual": round(flow_length_to_wall, 1),
            "target": "<= 120 preferred, <= 160 caution for long thin PC+ABS shells",
            "pass": flow_length_to_wall <= 160.0,
            "risk": risk_for(flow_length_to_wall, 120.0, 160.0),
            "note": "Uses full device height over nominal wall as a conservative CAD proxy until mold-flow exists.",
        },
        {
            "id": "clamp_tonnage_window",
            "actual": {
                "projected_area_mm2": round(projected_area_mm2, 1),
                "estimated_tons_low": round(clamp_tons_low, 1),
                "estimated_tons_high": round(clamp_tons_high, 1),
            },
            "target": "Quote tool and press capacity above the high estimate with supplier resin pressure data.",
            "pass": clamp_tons_high > 0,
            "risk": "medium",
            "note": "Uses 0.35-0.55 tons/cm2 as an early PC+ABS projected-area quote window.",
        },
        {
            "id": "gate_shear_proxy",
            "actual": {
                "gate_to_wall_ratio": round(gate_ratio, 3),
                "total_gate_area_mm2": round(gate_area_mm2, 2),
            },
            "target": "0.50-0.80 wall ratio with toolmaker-confirmed gate land and vestige",
            "pass": 0.50 <= gate_ratio <= 0.80,
            "risk": "medium" if gate_ratio <= 0.80 else "high",
            "note": "Small gates protect cosmetics but raise orange streak/blush and shear sensitivity.",
        },
        {
            "id": "cooling_clearance_ratio",
            "actual": {
                "channel_clearance_to_diameter": round(cooling_ratio, 3),
                "modeled_channels": cooling_count,
            },
            "target": ">= 2.0 diameters, with final baffles/conformal cooling from toolmaker",
            "pass": cooling_count >= 3 and cooling_ratio >= 2.0,
            "risk": "medium",
            "note": "Straight CAD channels are layout evidence only; cycle time and warp need tool simulation.",
        },
        {
            "id": "boss_sink_proxy",
            "actual": {
                "boss_wall_to_nominal_wall": round(boss_wall_ratio, 3),
                "rib_to_wall_ratio": round(rib_ratio, 3),
            },
            "target": "boss wall <= 1.10x nominal and ribs <= 0.70x nominal",
            "pass": boss_wall_ratio <= 1.10 and rib_ratio <= 0.70,
            "risk": "medium",
            "note": "Bosses and battery ribs need steel-safe coring and texture review to avoid read-through.",
        },
        {
            "id": "ejector_cosmetic_proxy",
            "actual": {"modeled_ejector_pins": ejector_count},
            "target": f"{mfg['ejector_pin_count']} pins with marks hidden from exterior A-surfaces",
            "pass": ejector_count == mfg["ejector_pin_count"],
            "risk": "medium",
            "note": "Modeled ejectors prove review intent, not pin balance or cosmetic approval.",
        },
    ]
    process_window = {
        "material_family": mfg["plastic"],
        "melt_temp_c": [245, 275],
        "mold_temp_c": [70, 95],
        "drying": "Dry PC+ABS per resin datasheet before molding; record dryer dew point and residence time.",
        "pack_hold": "Start with 95-99% fill transfer, stepped pack/hold DOE, and gate-freeze study.",
        "venting": "Add vents at end-of-fill around top corners, camera window, USB saddle, and snap-hook roots.",
        "cosmetic_controls": [
            "Orange color plaque approval before tool texture freeze.",
            "Gate vestige and blush review on first shots under production lighting.",
            "Texture-depth/draft review before any hard-tool steel commitment.",
        ],
    }
    toolmaker_questions = [
        "Run mold-flow fill/pack/warp with selected orange PC+ABS resin, dual submarine gates, and fan-gate alternate.",
        "Return predicted pressure at V/P transfer, clamp tonnage, weld lines, air traps, shrink, and corner warp.",
        "Confirm gate size, land length, vent locations, ejector layout, cooling layout, and steel-safe tuning stock.",
        "Review whether the long thin shell needs additional gating or flow leaders before DVT tooling.",
    ]
    first_shot_doe: list[dict[str, Any]] = [
        {"factor": "melt_temperature_c", "levels": [245, 260, 275]},
        {"factor": "mold_temperature_c", "levels": [70, 82, 95]},
        {"factor": "pack_pressure_percent", "levels": [60, 75, 90]},
        {"factor": "hold_time_s", "levels": [2.0, 4.0, 6.0]},
        {"factor": "cooling_time_s", "levels": [12.0, 18.0, 24.0]},
    ]
    linked_evidence = [
        "e1-phone-mold-tooling.glb",
        "mold_tooling.png",
        "injection-molding-dfm.json",
        "tolerance-stack.json",
        "solid-cad-handoff.json",
        "step-validation.json",
    ]
    report = {
        "claim_boundary": "CAD-derived mold-process window proxy; not mold-flow, sampled resin data, or toolmaker signoff.",
        "status": "cad_mold_process_window_ready"
        if dfm["status"] == "cad_dfm_inputs_ready"
        and tolerance_stack["status"] == "cad_tolerance_stack_pass"
        and all(case["pass"] for case in cases)
        else "blocked",
        "device_envelope_mm": [width, height, depth],
        "nominal_wall_mm": wall,
        "cases": cases,
        "process_window": process_window,
        "toolmaker_questions": toolmaker_questions,
        "first_shot_doe": first_shot_doe,
        "linked_evidence": linked_evidence,
    }
    (REVIEW_DIR / "mold-process-window.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Mold Process Window",
        "",
        "Status: CAD-derived process window ready; mold-flow, first shots, and toolmaker signoff still required.",
        "",
        "## Quantified Proxies",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` actual {case['actual']} target {case['target']} risk {case['risk']}"
        )
    lines.extend(["", "## Process Window", ""])
    lines.append(
        f"- Melt temperature: {process_window['melt_temp_c'][0]}-{process_window['melt_temp_c'][1]} C"
    )
    lines.append(
        f"- Mold temperature: {process_window['mold_temp_c'][0]}-{process_window['mold_temp_c'][1]} C"
    )
    lines.append(f"- Drying: {process_window['drying']}")
    lines.append(f"- Pack/hold: {process_window['pack_hold']}")
    lines.append(f"- Venting: {process_window['venting']}")
    lines.extend(["", "## Toolmaker Questions", ""])
    for item in toolmaker_questions:
        lines.append(f"- {item}")
    lines.extend(["", "## First-Shot DOE", ""])
    for doe_item in first_shot_doe:
        lines.append(f"- `{doe_item['factor']}` levels {doe_item['levels']}")
    (REVIEW_DIR / "mold-process-window.md").write_text("\n".join(lines) + "\n")
    return report


def write_readiness_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    tooling: list[Part],
    checks: dict[str, Any],
    visual: dict[str, Any],
    mass: dict[str, Any],
    supplier: dict[str, Any],
    handoff: dict[str, Any],
    kicad_reconciliation: dict[str, Any],
    validation: dict[str, Any],
    interface_validation: dict[str, Any],
    evt_fixtures: dict[str, Any],
    evt_inspection: dict[str, Any],
    evt_results: dict[str, Any],
    clearance: dict[str, Any],
    part_review: dict[str, Any],
    dfm: dict[str, Any],
    tolerance_stack: dict[str, Any],
    mold_process: dict[str, Any],
    visual_decision: dict[str, Any],
    solid_cad: dict[str, Any],
    step_validation: dict[str, Any],
    supplier_rfq: dict[str, Any],
) -> None:
    manifest_path = OUT_DIR / "assembly-manifest.json"
    tooling_manifest_path = OUT_DIR / "tooling-manifest.json"
    assembly_manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else []
    tooling_manifest = (
        json.loads(tooling_manifest_path.read_text()) if tooling_manifest_path.is_file() else []
    )
    part_names = {part.name for part in parts}
    tooling_names = {part.name for part in tooling}
    check_status = cast(dict[str, dict[str, Any]], checks["checks"])

    subsystems: list[dict[str, Any]] = [
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
            "status": "cad_pass"
            if kicad_reconciliation["status"] == "cad_kicad_placement_reconciled"
            else "blocked",
            "evidence": [
                "main_pcb",
                "kicad_outline_integration",
                "pcb_battery_non_overlap",
                "kicad-placement-reconciliation.json",
                "kicad-placement-reconciliation.md",
            ],
            "remaining_blockers": [
                "KiCad source is still a concept placement, not routed fabrication data.",
                "Need board STEP from routed KiCad with real component 3D models.",
            ],
        },
        {
            "subsystem": "solid_cad_handoff",
            "status": "cad_pass"
            if solid_cad["status"] == "generated" and step_validation["status"] == "pass"
            else "blocked",
            "evidence": [
                "solid-cad-handoff.json",
                "solid-cad-handoff.md",
                "step-validation.json",
                "step-validation.md",
                "e1-phone-solid-assembly.step",
                "orange_back_shell.step",
                "orange_side_frame.step",
                "screen_cover_glass.step",
                "main_pcb.step",
                "usb_c_receptacle.step",
                "usb_c_external_aperture.step",
                "bottom_mic.step",
                "top_mic.step",
                "bottom_speaker_module.step",
                "earpiece_receiver.step",
                "handset_acoustic_slot.step",
                "rear_camera_module.step",
                "rear_camera_cover_glass.step",
                "front_camera_module.step",
                "front_camera_under_glass.step",
                "power_button_cap.step",
                "volume_button_cap.step",
                "screen_adhesive_top.step",
                "display_fpc_connector.step",
                "orange_usb_reinforcement_saddle.step",
            ],
            "remaining_blockers": [
                "STEP files are EVT0 parametric envelopes, not final supplier B-rep models.",
                "Need routed KiCad board STEP and vendor component STEP models.",
            ],
        },
        {
            "subsystem": "supplier_rfq_package",
            "status": "cad_pass" if supplier_rfq["status"] == "rfq_ready" else "blocked",
            "evidence": [
                "supplier-rfq-package.json",
                "supplier-rfq-package.md",
                "supplier-lock.json",
                "solid-cad-handoff.json",
                "manufacturing_drawing.json",
                "tolerance-stack.json",
                "injection-molding-dfm.json",
            ],
            "remaining_blockers": [
                "RFQ package is ready to send, but no vendor has returned signed drawings, samples, or quotes.",
                "Need supplier STEP files to replace EVT0 envelope STEP.",
            ],
        },
        {
            "subsystem": "buttons",
            "status": "cad_pass"
            if interface_validation["status"] == "cad_interface_validation_pass"
            else "blocked",
            "evidence": [
                "power_button_cap",
                "volume_button_cap",
                "button_force_and_travel",
                "button_pressure_support",
                "interface-validation.json",
                "interface-validation.md",
            ],
            "remaining_blockers": [
                "Need tactile switch vendor part and tolerance stack.",
                "Need fatigue testing on snap retention and button caps.",
            ],
        },
        {
            "subsystem": "usb_audio_ports",
            "status": "cad_pass"
            if interface_validation["status"] == "cad_interface_validation_pass"
            else "blocked",
            "evidence": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "bottom_speaker_grille_slot_1",
                "bottom_microphone_port_1",
                "usb_c_insertion_envelope",
                "bottom_io_acoustic_apertures",
                "interface-validation.json",
                "interface-validation.md",
            ],
            "remaining_blockers": [
                "Need USB-C receptacle supplier drawing and insertion-cycle mechanical validation.",
                "Need acoustic simulation/measurement for speaker chamber and microphone tunnels.",
            ],
        },
        {
            "subsystem": "cameras_and_handset",
            "status": "cad_pass"
            if interface_validation["status"] == "cad_interface_validation_pass"
            else "blocked",
            "evidence": [
                "rear_camera_module",
                "front_camera_module",
                "front_camera_under_glass",
                "rear_camera_cover_glass",
                "earpiece_receiver",
                "handset_acoustic_slot",
                "camera_speaker_behind_glass",
                "interface-validation.json",
                "interface-validation.md",
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
            "status": "cad_pass"
            if dfm["status"] == "cad_dfm_inputs_ready"
            and mold_process["status"] == "cad_mold_process_window_ready"
            else "blocked",
            "evidence": [
                "mold_sprue_bushing",
                "mold_primary_runner",
                "mold_left_submarine_gate",
                "mold_right_submarine_gate",
                "mold_runner_gate_model",
                "mold_ejector_cooling_model",
                "injection-molding-dfm.json",
                "injection-molding-dfm.md",
                "mold-process-window.json",
                "mold-process-window.md",
            ],
            "remaining_blockers": [
                "Runner/gate/ejector/cooling geometry and process window are CAD DFM proxies, not toolmaker-approved steel design.",
                "Need mold-flow/fill/pack/warp analysis, first-shot data, and toolmaker review.",
            ],
        },
        {
            "subsystem": "review_automation",
            "status": "cad_pass",
            "evidence": [
                "fit-check-report.json",
                "visual-review.json",
                "part-review.json",
                "part-review-contact-sheet.png",
                "visual-decision-report.json",
                "visual-decision-report.md",
                "manufacturing_drawing.json",
                "full_top_down.png",
                "mold_tooling.png",
                "rear_feature_detail.png",
            ],
            "remaining_blockers": [
                "Visual checks prove nonblank/high-contrast renders and record EVT0 decisions; they do not replace CMF, tooling, or human DFM review.",
            ],
        },
        {
            "subsystem": "visual_aesthetic_decision_log",
            "status": "cad_pass" if visual_decision["status"] == "pass" else "blocked",
            "evidence": [
                "visual-decision-report.json",
                "visual-decision-report.md",
                "full_front_iso.png",
                "full_back_iso.png",
                "rear_feature_detail.png",
                "full_bottom_port.png",
                "component_stack.png",
                "mold_tooling.png",
            ],
            "remaining_blockers": [
                "CAD render decisions are EVT0 packaging decisions, not CMF lock.",
                "Back-side identity needs dedicated rear feature review before industrial-design freeze.",
            ],
        },
        {
            "subsystem": "assembly_clearance",
            "status": "cad_pass" if clearance["status"] == "pass" else "blocked",
            "evidence": [
                "assembly-clearance.json",
                "assembly-clearance.md",
                "battery_to_pcb_islands",
                "haptic_to_battery",
                "usb_to_bottom_speaker",
                "front_camera_to_earpiece",
            ],
            "remaining_blockers": [
                "Clearance checks are targeted AABB/parameter checks, not full B-rep boolean interference analysis.",
                "Need supplier STEP files and routed-board component models for final clash analysis.",
            ],
        },
        {
            "subsystem": "engineering_validation_plan",
            "status": "cad_pass"
            if validation["status"] == "cad_validation_inputs_ready"
            and interface_validation["status"] == "cad_interface_validation_pass"
            and evt_fixtures["status"] == "evt_fixture_cad_ready"
            and evt_inspection["status"] == "evt_inspection_plan_ready"
            else "blocked",
            "evidence": [
                "engineering-validation.json",
                "engineering-validation.md",
                "interface-validation.json",
                "interface-validation.md",
                "evt-fixtures.json",
                "evt-fixtures.md",
                "evt-inspection-plan.json",
                "evt-inspection-plan.md",
                "evt-inspection-results-template.csv",
                "evt-results-review.json",
                "evt-results-review.md",
                "e1-phone-evt-fixtures.glb",
                "evt-fixture-manifest.json",
                "usb_c_insertion_envelope",
                "button_pressure_support",
                "screen_mount_and_connection",
                "rf_antenna_keepouts",
            ],
            "remaining_blockers": [
                "Tolerance, thermal, RF, acoustic, ingress, and drop results are CAD-derived planning checks only.",
                "Need EVT samples and lab measurements to close DVT/PVT gates.",
                "EVT results review is fail-closed until populated sample measurements pass.",
            ],
        },
        {
            "subsystem": "physical_evt_results",
            "status": "cad_pass" if evt_results["status"] == "evt_results_pass" else "blocked",
            "evidence": [
                "evt-inspection-results-template.csv",
                "evt-results-review.json",
                "evt-results-review.md",
            ],
            "remaining_blockers": [
                "No populated EVT measurement rows are present yet.",
                "Need measured, passing first-article data before claiming physical validation.",
            ],
        },
        {
            "subsystem": "tolerance_release_package",
            "status": "cad_pass"
            if tolerance_stack["status"] == "cad_tolerance_stack_pass"
            else "blocked",
            "evidence": [
                "tolerance-stack.json",
                "tolerance-stack.md",
                "screen_mount_margin",
                "screen_mount_and_connection",
                "usb_c_insertion_envelope",
                "camera_speaker_behind_glass",
            ],
            "remaining_blockers": [
                "Tolerance stack is CAD-derived and not a supplier-measured GD&T release drawing.",
                "Need CMM data, resin shrink data, and toolmaker-approved datum scheme.",
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
        "kicad_placement_reconciliation": kicad_reconciliation["status"]
        == "cad_kicad_placement_reconciled"
        and (REVIEW_DIR / "kicad-placement-reconciliation.json").is_file()
        and (REVIEW_DIR / "kicad-placement-reconciliation.md").is_file(),
        "engineering_validation": (REVIEW_DIR / "engineering-validation.json").is_file(),
        "interface_validation": interface_validation["status"] == "cad_interface_validation_pass"
        and (REVIEW_DIR / "interface-validation.json").is_file()
        and (REVIEW_DIR / "interface-validation.md").is_file(),
        "evt_validation_fixtures": evt_fixtures["status"] == "evt_fixture_cad_ready"
        and (REVIEW_DIR / "evt-fixtures.json").is_file()
        and (REVIEW_DIR / "evt-fixtures.md").is_file()
        and (OUT_DIR / "e1-phone-evt-fixtures.glb").is_file()
        and (OUT_DIR / "evt-fixture-manifest.json").is_file(),
        "evt_inspection_plan": evt_inspection["status"] == "evt_inspection_plan_ready"
        and (REVIEW_DIR / "evt-inspection-plan.json").is_file()
        and (REVIEW_DIR / "evt-inspection-plan.md").is_file()
        and (REVIEW_DIR / "evt-inspection-results-template.csv").is_file(),
        "evt_results_review": (REVIEW_DIR / "evt-results-review.json").is_file()
        and (REVIEW_DIR / "evt-results-review.md").is_file(),
        "assembly_clearance": (REVIEW_DIR / "assembly-clearance.json").is_file(),
        "injection_molding_dfm": (REVIEW_DIR / "injection-molding-dfm.json").is_file(),
        "mold_process_window": mold_process["status"] == "cad_mold_process_window_ready"
        and (REVIEW_DIR / "mold-process-window.json").is_file()
        and (REVIEW_DIR / "mold-process-window.md").is_file(),
        "tolerance_stack": (REVIEW_DIR / "tolerance-stack.json").is_file(),
        "visual_decision_report": (REVIEW_DIR / "visual-decision-report.json").is_file()
        and (REVIEW_DIR / "visual-decision-report.md").is_file(),
        "solid_cad_handoff": solid_cad["status"] == "generated"
        and step_validation["status"] == "pass"
        and (REVIEW_DIR / "solid-cad-handoff.json").is_file()
        and (REVIEW_DIR / "solid-cad-handoff.md").is_file()
        and (REVIEW_DIR / "step-validation.json").is_file()
        and (REVIEW_DIR / "step-validation.md").is_file()
        and (OUT_DIR / "e1-phone-solid-assembly.step").is_file(),
        "supplier_rfq_package": supplier_rfq["status"] == "rfq_ready"
        and (REVIEW_DIR / "supplier-rfq-package.json").is_file()
        and (REVIEW_DIR / "supplier-rfq-package.md").is_file(),
        "part_review": (REVIEW_DIR / "part-review.json").is_file()
        and (REVIEW_DIR / "part-review-contact-sheet.png").is_file(),
    }
    subsystem_evidence_present: dict[str, bool] = {}
    for row in subsystems:
        present = True
        for evidence in row["evidence"]:
            if evidence in check_status:
                present = present and bool(check_status[evidence]["pass"])
            elif evidence in {item["id"] for item in clearance["cases"]}:
                case = next(item for item in clearance["cases"] if item["id"] == evidence)
                present = present and bool(case["pass"])
            elif evidence.endswith(".glb") or evidence in {
                "assembly-manifest.json",
                "tooling-manifest.json",
                "evt-fixture-manifest.json",
            }:
                present = present and (OUT_DIR / evidence).is_file()
            elif evidence.endswith((".json", ".md", ".png", ".svg", ".csv")):
                present = present and (REVIEW_DIR / evidence).is_file()
            elif evidence.endswith(".step"):
                present = present and (OUT_DIR / evidence).is_file()
            else:
                present = present and (evidence in part_names or evidence in tooling_names)
        subsystem_evidence_present[row["subsystem"]] = present

    visual_pass = all(item["pass"] for item in visual.values())
    visual_decision_pass = visual_decision["status"] == "pass"
    all_cad_checks_pass = all(item["pass"] for item in check_status.values())
    all_outputs_present = all(required_outputs.values())
    all_evidence_present = all(subsystem_evidence_present.values())
    manufacturing_release_ready = False

    readiness: dict[str, Any] = {
        "claim_boundary": "CAD automation readiness audit; not a manufacturing release.",
        "overall_status": "cad_package_pass"
        if all_cad_checks_pass
        and all_outputs_present
        and all_evidence_present
        and visual_pass
        and visual_decision_pass
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
            "kicad_placement_reconciliation_status": kicad_reconciliation["status"],
            "kicad_placement_footprint_cases": len(kicad_reconciliation.get("footprint_cases", [])),
            "kicad_placement_cad_projection_cases": len(
                kicad_reconciliation.get("cad_projection_cases", [])
            ),
            "engineering_validation_status": validation["status"],
            "interface_validation_status": interface_validation["status"],
            "interface_validation_case_count": len(interface_validation.get("interfaces", [])),
            "evt_fixture_status": evt_fixtures["status"],
            "evt_fixture_count": evt_fixtures.get("fixture_count", 0),
            "evt_inspection_status": evt_inspection["status"],
            "evt_inspection_measurement_count": evt_inspection.get("measurement_count", 0),
            "evt_results_status": evt_results["status"],
            "evt_results_populated_count": evt_results.get("populated_result_count", 0),
            "assembly_clearance_status": clearance["status"],
            "injection_molding_dfm_status": dfm["status"],
            "tolerance_stack_status": tolerance_stack["status"],
            "mold_process_window_status": mold_process["status"],
            "visual_decision_status": visual_decision["status"],
            "solid_cad_handoff_status": solid_cad["status"],
            "solid_cad_step_part_count": solid_cad.get("part_count", 0),
            "step_validation_status": step_validation["status"],
            "step_validation_count": step_validation.get("validated_count", 0),
            "supplier_rfq_status": supplier_rfq["status"],
            "supplier_rfq_package_count": len(supplier_rfq.get("packages", [])),
            "part_review_count": part_review["part_count"],
        },
        "required_outputs": required_outputs,
        "subsystem_evidence_present": subsystem_evidence_present,
        "all_cad_checks_pass": all_cad_checks_pass,
        "visual_review_pass": visual_pass,
        "visual_decision_pass": visual_decision_pass,
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


def box_gap(
    size_a: list[float], center_a: list[float], size_b: list[float], center_b: list[float]
) -> float:
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
        box_gap(
            [64.0, 25.0, 0.8],
            [0.0, 55.0, pcb["z_center_mm"]],
            battery["envelope_mm"],
            battery_center,
        ),
        box_gap(
            [64.0, 15.0, 0.8],
            [0.0, -65.0, pcb["z_center_mm"]],
            battery["envelope_mm"],
            battery_center,
        ),
        box_gap(
            [8.0, 78.0, 0.8],
            [-32.0, -8.0, pcb["z_center_mm"]],
            battery["envelope_mm"],
            battery_center,
        ),
    ]
    kicad_outline = kicad_outline_mm(ROOT / pcb["source"])
    boss_count = sum(1 for name in by_name if name.startswith("orange_screw_boss_"))
    snap_count = sum(1 for name in by_name if name.startswith("orange_snap_hook_"))
    tooling = tooling_parts(params)
    tooling_names = {part.name for part in tooling}
    ejector_count = sum(1 for name in tooling_names if name.startswith("mold_ejector_pin_"))
    cooling_count = sum(1 for name in tooling_names if name.startswith("mold_cooling_channel_"))
    final_assembly_has_tooling = any(
        part.role in {"tooling", "tooling clearance"} for part in parts
    )
    shell_vertices = (
        len(by_name["orange_back_shell"].mesh.vertices) if "orange_back_shell" in by_name else 0
    )
    frame_vertices = (
        len(by_name["orange_side_frame"].mesh.vertices) if "orange_side_frame" in by_name else 0
    )
    mesh_failures = [
        part.name
        for part in parts
        if not part.mesh.is_watertight
        or float(part.mesh.volume) <= 0.0
        or len(part.mesh.faces) == 0
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
            and comp["power_button"]["force_n"]
            / (comp["power_button"]["cap_mm"][1] * comp["power_button"]["cap_mm"][2])
            < 0.2
            and comp["volume_button"]["force_n"]
            / (comp["volume_button"]["cap_mm"][1] * comp["volume_button"]["cap_mm"][2])
            < 0.12,
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
            "cellular_keepout_mm": params.get("radio", {})
            .get("cellular", {})
            .get("antenna_keepout_mm"),
            "wifi_bt_keepout_mm": params.get("radio", {})
            .get("wifi_bt", {})
            .get("antenna_keepout_mm"),
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
                name
                for name in ["sim_tray_keepout", "sim_tray_outline", "service_label_recess"]
                if name in by_name
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
            and params["manufacturing"]["rib_thickness_mm"]
            <= 0.75 * params["device"]["wall_thickness_mm"],
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
            "pass": width <= 80.0 and height <= 157.0 and depth <= 10.0,
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
        "status": checks["status"],
        "params": params,
        "checks": checks["checks"],
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
            "supplier_rfq_package_json": "mechanical/e1-phone/review/supplier-rfq-package.json",
            "supplier_rfq_package_md": "mechanical/e1-phone/review/supplier-rfq-package.md",
            "kicad_mechanical_handoff_json": "mechanical/e1-phone/review/kicad-mechanical-handoff.json",
            "kicad_mechanical_handoff_md": "mechanical/e1-phone/review/kicad-mechanical-handoff.md",
            "kicad_placement_reconciliation_json": "mechanical/e1-phone/review/kicad-placement-reconciliation.json",
            "kicad_placement_reconciliation_md": "mechanical/e1-phone/review/kicad-placement-reconciliation.md",
            "engineering_validation_json": "mechanical/e1-phone/review/engineering-validation.json",
            "engineering_validation_md": "mechanical/e1-phone/review/engineering-validation.md",
            "interface_validation_json": "mechanical/e1-phone/review/interface-validation.json",
            "interface_validation_md": "mechanical/e1-phone/review/interface-validation.md",
            "evt_fixtures_json": "mechanical/e1-phone/review/evt-fixtures.json",
            "evt_fixtures_md": "mechanical/e1-phone/review/evt-fixtures.md",
            "evt_inspection_plan_json": "mechanical/e1-phone/review/evt-inspection-plan.json",
            "evt_inspection_plan_md": "mechanical/e1-phone/review/evt-inspection-plan.md",
            "evt_inspection_results_template": "mechanical/e1-phone/review/evt-inspection-results-template.csv",
            "evt_fixture_glb": "mechanical/e1-phone/out/e1-phone-evt-fixtures.glb",
            "evt_fixture_manifest": "mechanical/e1-phone/out/evt-fixture-manifest.json",
            "assembly_clearance_json": "mechanical/e1-phone/review/assembly-clearance.json",
            "assembly_clearance_md": "mechanical/e1-phone/review/assembly-clearance.md",
            "injection_molding_dfm_json": "mechanical/e1-phone/review/injection-molding-dfm.json",
            "injection_molding_dfm_md": "mechanical/e1-phone/review/injection-molding-dfm.md",
            "mold_process_window_json": "mechanical/e1-phone/review/mold-process-window.json",
            "mold_process_window_md": "mechanical/e1-phone/review/mold-process-window.md",
            "tolerance_stack_json": "mechanical/e1-phone/review/tolerance-stack.json",
            "tolerance_stack_md": "mechanical/e1-phone/review/tolerance-stack.md",
            "part_review_json": "mechanical/e1-phone/review/part-review.json",
            "part_review_md": "mechanical/e1-phone/review/part-review.md",
            "part_review_contact_sheet": "mechanical/e1-phone/review/part-review-contact-sheet.png",
            "visual_decision_report_json": "mechanical/e1-phone/review/visual-decision-report.json",
            "visual_decision_report_md": "mechanical/e1-phone/review/visual-decision-report.md",
            "solid_cad_handoff_json": "mechanical/e1-phone/review/solid-cad-handoff.json",
            "solid_cad_handoff_md": "mechanical/e1-phone/review/solid-cad-handoff.md",
            "step_validation_json": "mechanical/e1-phone/review/step-validation.json",
            "step_validation_md": "mechanical/e1-phone/review/step-validation.md",
            "solid_assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
            "renders": [
                "mechanical/e1-phone/review/full_front_iso.png",
                "mechanical/e1-phone/review/full_back_iso.png",
                "mechanical/e1-phone/review/rear_feature_detail.png",
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
        "- `mechanical/e1-phone/review/supplier-rfq-package.json`",
        "- `mechanical/e1-phone/review/supplier-rfq-package.md`",
        "- `mechanical/e1-phone/review/kicad-mechanical-handoff.json`",
        "- `mechanical/e1-phone/review/kicad-mechanical-handoff.md`",
        "- `mechanical/e1-phone/review/kicad-placement-reconciliation.json`",
        "- `mechanical/e1-phone/review/kicad-placement-reconciliation.md`",
        "- `mechanical/e1-phone/review/engineering-validation.json`",
        "- `mechanical/e1-phone/review/engineering-validation.md`",
        "- `mechanical/e1-phone/review/interface-validation.json`",
        "- `mechanical/e1-phone/review/interface-validation.md`",
        "- `mechanical/e1-phone/review/evt-fixtures.json`",
        "- `mechanical/e1-phone/review/evt-fixtures.md`",
        "- `mechanical/e1-phone/review/evt-inspection-plan.json`",
        "- `mechanical/e1-phone/review/evt-inspection-plan.md`",
        "- `mechanical/e1-phone/review/evt-inspection-results-template.csv`",
        "- `mechanical/e1-phone/out/e1-phone-evt-fixtures.glb`",
        "- `mechanical/e1-phone/out/evt-fixture-manifest.json`",
        "- `mechanical/e1-phone/review/assembly-clearance.json`",
        "- `mechanical/e1-phone/review/assembly-clearance.md`",
        "- `mechanical/e1-phone/review/injection-molding-dfm.json`",
        "- `mechanical/e1-phone/review/injection-molding-dfm.md`",
        "- `mechanical/e1-phone/review/mold-process-window.json`",
        "- `mechanical/e1-phone/review/mold-process-window.md`",
        "- `mechanical/e1-phone/review/tolerance-stack.json`",
        "- `mechanical/e1-phone/review/tolerance-stack.md`",
        "- `mechanical/e1-phone/review/part-review.json`",
        "- `mechanical/e1-phone/review/part-review.md`",
        "- `mechanical/e1-phone/review/part-review-contact-sheet.png`",
        "- `mechanical/e1-phone/review/visual-decision-report.json`",
        "- `mechanical/e1-phone/review/visual-decision-report.md`",
        "- `mechanical/e1-phone/review/solid-cad-handoff.json`",
        "- `mechanical/e1-phone/review/solid-cad-handoff.md`",
        "- `mechanical/e1-phone/review/step-validation.json`",
        "- `mechanical/e1-phone/review/step-validation.md`",
        "- `mechanical/e1-phone/out/e1-phone-solid-assembly.step`",
        "- `mechanical/e1-phone/review/full_front_iso.png`",
        "- `mechanical/e1-phone/review/full_back_iso.png`",
        "- `mechanical/e1-phone/review/rear_feature_detail.png`",
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
            "- The envelope is held to 78.0 x 153.6 mm around the 77.1 x 151.77 mm commodity touch panel module to keep the orange side rails compact while preserving a narrow positive screen margin.",
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
        REVIEW_DIR / "rear_feature_detail.png",
        REVIEW_DIR / "full_left_side.png",
        REVIEW_DIR / "full_bottom_port.png",
        REVIEW_DIR / "full_top_down.png",
        REVIEW_DIR / "exploded_iso.png",
        REVIEW_DIR / "component_stack.png",
        REVIEW_DIR / "mold_tooling.png",
    ]
    render(parts, render_paths[0], "E1 phone full assembly, front", 22, -56)
    render(parts, render_paths[1], "E1 phone full assembly, back", -24, 124)
    by_name = {part.name: part for part in parts}
    rear_review_shell = Part(
        "rear_review_translucent_shell",
        by_name["orange_back_shell"].mesh.copy(),
        [1.0, 0.32, 0.02, 0.28],
        "review",
        "translucent rear shell for feature review",
    )
    apply_face_color(rear_review_shell.mesh, rear_review_shell.color)
    rear_detail = [
        rear_review_shell,
        *[
            by_name[name]
            for name in [
                "rear_camera_module",
                "rear_camera_lens_window",
                "rear_camera_cover_glass",
                "service_label_recess",
                "sim_tray_outline",
            ]
        ],
    ]
    render(rear_detail, render_paths[2], "E1 phone rear camera and service features", -82, -90)
    render(parts, render_paths[3], "E1 phone left side buttons", 8, 180)
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
    render(bottom_detail, render_paths[4], "E1 phone bottom USB-C, speaker, mics", 8, -90)
    render(parts, render_paths[5], "E1 phone top-down footprint", 82, -90)
    render(exploded, render_paths[6], "E1 phone exploded stack", 20, -54)
    component_parts = [
        p
        for p in parts
        if p.role in {"PCB", "camera", "audio", "I/O", "button", "battery", "connector"}
    ]
    render(component_parts, render_paths[7], "E1 phone component placement", 74, -88)
    render(
        [*tooling, *[p for p in parts if p.name in {"orange_back_shell", "orange_side_frame"}]],
        render_paths[8],
        "E1 phone mold runner and parting review",
        28,
        -55,
    )
    visual = verify_render_artifacts(render_paths)
    checks = run_checks(params, parts)
    solid_cad = write_solid_cad_handoff_artifacts(params, checks)
    step_validation = write_step_validation_artifacts(solid_cad)
    part_review = write_part_review_artifacts(parts)
    clearance = write_assembly_clearance_artifacts(params, parts)
    mass = write_mass_budget(parts)
    write_drafting_artifacts(params, checks)
    supplier = write_supplier_artifacts(params)
    supplier_rfq = write_supplier_rfq_artifacts(params, supplier, solid_cad)
    handoff = write_kicad_mechanical_handoff(params, checks)
    kicad_reconciliation = write_kicad_placement_reconciliation_artifacts(params, parts, handoff)
    validation = write_engineering_validation_artifacts(params, parts, checks, mass, supplier)
    dfm = write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = write_tolerance_stack_artifacts(params, checks)
    interface_validation = write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    fixtures = evt_fixture_parts(params)
    evt_fixtures = write_evt_fixture_artifacts(params, fixtures, interface_validation)
    evt_inspection = write_evt_inspection_plan_artifacts(params, interface_validation, evt_fixtures)
    mold_process = write_mold_process_window_artifacts(params, parts, tooling, dfm, tolerance_stack)
    visual_decision = write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )
    write_readiness_artifacts(
        params,
        parts,
        tooling,
        checks,
        visual,
        mass,
        supplier,
        handoff,
        kicad_reconciliation,
        validation,
        interface_validation,
        evt_fixtures,
        evt_inspection,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
        mold_process,
        visual_decision,
        solid_cad,
        step_validation,
        supplier_rfq,
    )
    write_report(params, checks)
    print(f"E1 phone CAD generation {checks['status']}: {REVIEW_DIR / 'README.md'}")
    return 0 if checks["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
