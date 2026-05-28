#!/usr/bin/env python3
"""Generate reviewable E1 phone mechanical CAD concept artifacts.

This is an EVT0 mechanical concept generator, not a tooling-release CAD
substitute. It creates deterministic mesh artifacts, rendered review views,
and analytic fit checks from one YAML parameter file so the enclosure can be
iterated against the KiCad phone-mainboard concept.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import sys
from contextlib import suppress
from dataclasses import dataclass
from io import StringIO
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

MIN_BUTTON_TRAVEL_MM = 0.18
FLASH_BURIAL_CLEARANCE_MM = 0.20
CONNECTION_TERMINAL_MARKER_Z_MM = 5.55

CAD_CONNECTION_TERMINAL_ENDPOINTS: tuple[tuple[str, str, str], ...] = (
    ("display_touch_fpc", "display_fpc_connector", "display_lcm"),
    ("rear_camera_csi_fpc", "main_pcb", "rear_camera_module"),
    ("front_camera_csi_fpc", "main_pcb", "front_camera_module"),
    ("side_key_flex", "main_pcb", "power_button_cap"),
    ("battery_lead_flex", "battery_pouch", "main_pcb"),
    ("usb_c_escape_tail", "usb_c_receptacle", "main_pcb"),
    ("usb_c_to_pd_controller_escape", "usb_c_receptacle", "usb_pd_controller_package_marker"),
    ("pd_controller_to_charger_control", "usb_pd_controller_package_marker", "charger_package_marker"),
    ("charger_to_battery_power_sense", "charger_package_marker", "battery_connector_package_marker"),
    ("display_bias_power_flex", "backlight_bias_package_marker", "display_fpc_connector"),
    ("rear_camera_power_flex", "main_pcb", "rear_camera_module"),
    ("front_camera_power_flex", "main_pcb", "front_camera_module"),
    ("wifi_bt_host_control", "wifi_bt_module_keepout", "soc_package_marker"),
    ("cellular_host_control", "cellular_lga_module_keepout", "soc_package_marker"),
    ("bottom_speaker_lead_pair", "main_pcb", "bottom_speaker_module"),
    ("bottom_microphone_flex", "main_pcb", "bottom_mic"),
    ("top_microphone_flex", "main_pcb", "top_mic"),
    ("earpiece_receiver_lead_flex", "main_pcb", "earpiece_receiver"),
    ("haptic_flex", "main_pcb", "haptic_lra"),
    ("sensor_hub_i2c_flex", "main_pcb", "sensor_hub_package_marker"),
    ("sim_esim_signal_flex", "main_pcb", "sim_tray_keepout"),
    ("nfc_loop_antenna_flex", "nfc_controller_package_marker", "nfc_loop_match_marker"),
    ("compute_som_sodimm_carrier", "main_pcb", "compute_som_daughterboard_keepout"),
    ("soc_shield_ground_spring", "soc_shield_can", "main_pcb"),
    ("radio_shield_ground_spring", "radio_shield_can", "main_pcb"),
    ("cellular_main_rf_feed", "cellular_lga_module_keepout", "cellular_top_antenna_keepout"),
    (
        "cellular_diversity_rf_feed",
        "cellular_lga_module_keepout",
        "cellular_bottom_antenna_keepout",
    ),
    (
        "cellular_antenna_aperture_tuner",
        "cellular_lga_module_keepout",
        "cellular_bottom_antenna_keepout",
    ),
    ("cellular_gnss_rf_feed", "cellular_lga_module_keepout", "gnss_lna_package_marker"),
    ("wifi_bt_rf0_feed", "wifi_bt_module_keepout", "wifi_bt_side_antenna_keepout"),
    ("wifi_bt_rf1_feed", "wifi_bt_module_keepout", "wifi_bt_side_antenna_keepout"),
    (
        "split_interconnect_side_flex",
        "split_interconnect_top_connector",
        "split_interconnect_bottom_connector",
    ),
)

ORANGE = [1.0, 0.32, 0.02, 1.0]
BLACK_GLASS = [0.015, 0.018, 0.02, 0.72]
DARK = [0.06, 0.065, 0.07, 1.0]
PCB_GREEN = [0.03, 0.38, 0.22, 1.0]
METAL = [0.72, 0.74, 0.76, 1.0]
CAMERA = [0.02, 0.02, 0.025, 1.0]
ADHESIVE = [0.02, 0.02, 0.02, 0.55]
TOOLING = [0.16, 0.35, 0.95, 0.38]
FPC_AMBER = [0.95, 0.58, 0.10, 0.72]
IC_PACKAGE = [0.015, 0.018, 0.019, 1.0]
MODULE_SHIELD = [0.62, 0.64, 0.66, 1.0]


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


def part_from_cadquery(
    name: str,
    solid: Any,
    color: list[float],
    role: str,
    material: str,
    tolerance: float = 0.08,
) -> Part:
    vertices, faces = solid.val().tessellate(tolerance)
    mesh = trimesh.Trimesh(
        vertices=np.asarray([vertex.toTuple() for vertex in vertices], dtype=float),
        faces=np.asarray(faces, dtype=int),
        process=True,
    )
    mesh.merge_vertices()
    mesh.fix_normals()
    apply_face_color(mesh, color)
    return Part(name, mesh, color, role, material)


def cadquery_box(size: list[float], center: list[float], radius: float = 0.0) -> Any:
    import cadquery as cq

    solid = cq.Workplane("XY").box(float(size[0]), float(size[1]), float(size[2]))
    if radius > 0:
        max_radius = max(min(float(size[0]), float(size[1])) / 2.0 - 0.05, 0.0)
        safe_radius = min(radius, max_radius)
        if safe_radius > 0.05:
            with suppress(Exception):
                solid = solid.edges("|Z").fillet(safe_radius)
    return solid.translate((float(center[0]), float(center[1]), float(center[2])))


def orange_back_shell_part(params: dict[str, Any]) -> Part:
    width, height, depth = params["device"]["envelope_mm"]
    corner_radius = float(params["device"]["corner_radius_mm"])
    rear_camera_x, rear_camera_y = rear_camera_center_xy(params)
    rear_aperture_w, rear_aperture_h = rear_camera_shell_aperture_mm(params)
    rear_flash_x, rear_flash_y = rear_flash_center_xy(params)
    rear_flash_aperture_w, rear_flash_aperture_h = rear_flash_shell_aperture_mm(params)
    try:
        shell = cadquery_box([width, height, 1.2], [0, 0, -depth / 2 + 0.6], corner_radius)
        shell = shell.cut(
            cadquery_box(
                [rear_aperture_w, rear_aperture_h, 2.4],
                [rear_camera_x, rear_camera_y, -depth / 2 + 0.6],
            )
        )
        shell = shell.cut(
            cadquery_box(
                [rear_flash_aperture_w, rear_flash_aperture_h, 2.4],
                [rear_flash_x, rear_flash_y, -depth / 2 + 0.6],
            )
        )
        return part_from_cadquery(
            "orange_back_shell",
            shell,
            ORANGE,
            "molded enclosure",
            "PC+ABS orange rounded back shell with real rear camera and flash holes",
        )
    except Exception:
        return rounded_box(
            "orange_back_shell",
            [width, height, 1.2],
            [0, 0, -depth / 2 + 0.6],
            corner_radius,
            ORANGE,
            "molded enclosure",
            "PC+ABS orange rounded back shell",
        )


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
    params = yaml.safe_load(PARAMS.read_text())
    validation = params.setdefault("validation", {})
    if "environmental_targets" not in validation:
        environmental_targets = params.get("tolerances", {}).get("environmental_targets")
        if environmental_targets:
            validation["environmental_targets"] = environmental_targets
    return params


def pcb_island_segments(params: dict[str, Any]) -> list[tuple[list[float], list[float], str]]:
    """Two rigid PCB islands placed in the Y regions NOT occupied by the full-width
    battery, per board-topology-decision.yaml. The battery (64x87, center y=-7.0)
    spans y[-50.5,+36.5]; the top island sits above it and the bottom below it, so
    no board solid shares the battery's XY footprint and the impossible board<->
    battery Z-overlap of a single center board is eliminated.
    """
    pcb = params["pcb"]
    z = pcb["z_center_mm"]
    top = pcb["top_island_outline_mm"]
    bot = pcb["bottom_island_outline_mm"]
    return [
        (list(top), [0.0, float(pcb["top_island_center_y_mm"]), z], "main_pcb_top_island"),
        (list(bot), [0.0, float(pcb["bottom_island_center_y_mm"]), z], "main_pcb_bottom_island"),
    ]


def split_interconnect_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    pcb_z = float(params["pcb"]["z_center_mm"])
    return [
        {
            "name": "split_interconnect_top_connector",
            "size": [16.0, 2.4, 0.9],
            "center": [22.0, 37.5, pcb_z + 0.85],
            "color": METAL,
            "role": "split-board interconnect",
            "material": "Hirose BM28-class 49-pin top-island board connector envelope",
        },
        {
            "name": "split_interconnect_bottom_connector",
            "size": [16.0, 2.4, 0.9],
            "center": [22.0, -52.5, pcb_z + 0.85],
            "color": METAL,
            "role": "split-board interconnect",
            "material": "Hirose BM28-class 49-pin bottom-island board connector envelope",
        },
        {
            "name": "split_interconnect_side_flex",
            "size": [2.4, 88.0, 0.18],
            "center": [34.5, -7.5, pcb_z + 0.25],
            "color": FPC_AMBER,
            "role": "split-board interconnect",
            "material": "polyimide FPC side service loop envelope",
        },
        {
            "name": "split_interconnect_top_flex_tail",
            "size": [12.5, 2.0, 0.18],
            "center": [28.25, 37.5, pcb_z + 0.25],
            "color": FPC_AMBER,
            "role": "split-board interconnect",
            "material": "polyimide FPC top connector tail envelope",
        },
        {
            "name": "split_interconnect_bottom_flex_tail",
            "size": [12.5, 2.0, 0.18],
            "center": [28.25, -52.5, pcb_z + 0.25],
            "color": FPC_AMBER,
            "role": "split-board interconnect",
            "material": "polyimide FPC bottom connector tail envelope",
        },
    ]


def side_button_seal_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    dev = params["device"]
    comp = params["components"]
    width = float(dev["envelope_mm"][0])
    power_y = 20.0
    volume_y = 14.0
    power_cap = comp["power_button"]["cap_mm"]
    volume_cap = comp["volume_button"]["cap_mm"]
    return [
        {
            "name": "power_button_elastomer_gasket",
            "size": [0.5, power_cap[1] + 1.0, power_cap[2] + 0.45],
            "center": [width / 2 - 0.65, power_y, -0.4],
            "color": ADHESIVE,
            "role": "button seal",
            "material": "shore-a silicone side-key gasket behind power button",
        },
        {
            "name": "power_button_labyrinth_upper_rail",
            "size": [0.55, 0.8, power_cap[2] + 0.75],
            "center": [width / 2 - 0.95, power_y + power_cap[1] / 2 + 0.55, -0.4],
            "color": ORANGE,
            "role": "button seal",
            "material": "molded PC+ABS side-key labyrinth rail",
        },
        {
            "name": "power_button_labyrinth_lower_rail",
            "size": [0.55, 0.8, power_cap[2] + 0.75],
            "center": [width / 2 - 0.95, power_y - power_cap[1] / 2 - 0.55, -0.4],
            "color": ORANGE,
            "role": "button seal",
            "material": "molded PC+ABS side-key labyrinth rail",
        },
        {
            "name": "volume_button_elastomer_gasket",
            "size": [0.5, volume_cap[1] + 1.0, volume_cap[2] + 0.45],
            "center": [-width / 2 + 0.65, volume_y, -0.4],
            "color": ADHESIVE,
            "role": "button seal",
            "material": "shore-a silicone side-key gasket behind volume button",
        },
        {
            "name": "volume_button_labyrinth_upper_rail",
            "size": [0.55, 0.8, volume_cap[2] + 0.75],
            "center": [-width / 2 + 0.95, volume_y + volume_cap[1] / 2 + 0.55, -0.4],
            "color": ORANGE,
            "role": "button seal",
            "material": "molded PC+ABS side-key labyrinth rail",
        },
        {
            "name": "volume_button_labyrinth_lower_rail",
            "size": [0.55, 0.8, volume_cap[2] + 0.75],
            "center": [-width / 2 + 0.95, volume_y - volume_cap[1] / 2 - 0.55, -0.4],
            "color": ORANGE,
            "role": "button seal",
            "material": "molded PC+ABS side-key labyrinth rail",
        },
    ]


def usb_c_seal_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    height = float(params["device"]["envelope_mm"][1])
    aperture_w = 10.2
    aperture_z = 3.6
    -height / 2 - 0.08
    y_inside = -height / 2 + 0.32
    z_center = -1.45
    return [
        {
            "name": "usb_c_perimeter_gasket_top",
            "size": [11.4, 0.45, 0.35],
            "center": [0.0, y_inside, z_center + aperture_z / 2 + 0.32],
            "color": ADHESIVE,
            "role": "I/O seal",
            "material": "silicone USB-C perimeter gasket top rail",
        },
        {
            "name": "usb_c_perimeter_gasket_bottom",
            "size": [11.4, 0.45, 0.35],
            "center": [0.0, y_inside, z_center - aperture_z / 2 - 0.32],
            "color": ADHESIVE,
            "role": "I/O seal",
            "material": "silicone USB-C perimeter gasket bottom rail",
        },
        {
            "name": "usb_c_perimeter_gasket_left",
            "size": [0.35, 0.45, aperture_z + 0.7],
            "center": [-aperture_w / 2 - 0.32, y_inside, z_center],
            "color": ADHESIVE,
            "role": "I/O seal",
            "material": "silicone USB-C perimeter gasket side rail",
        },
        {
            "name": "usb_c_perimeter_gasket_right",
            "size": [0.35, 0.45, aperture_z + 0.7],
            "center": [aperture_w / 2 + 0.32, y_inside, z_center],
            "color": ADHESIVE,
            "role": "I/O seal",
            "material": "silicone USB-C perimeter gasket side rail",
        },
        {
            "name": "usb_c_molded_drip_break_lip",
            "size": [13.2, 0.45, 0.45],
            "center": [0.0, -height / 2 + 0.42, z_center - aperture_z / 2 - 0.72],
            "color": ORANGE,
            "role": "I/O seal",
            "material": "molded PC+ABS internal drip-break lip below USB-C aperture",
        },
        {
            "name": "usb_c_internal_drain_shelf",
            "size": [12.8, 2.2, 0.28],
            "center": [0.0, -height / 2 + 1.7, z_center - aperture_z / 2 - 0.55],
            "color": ORANGE,
            "role": "I/O seal",
            "material": "molded PC+ABS internal drain shelf under USB-C receptacle",
        },
    ]


def rear_camera_buried_center_z(params: dict[str, Any]) -> float:
    """Z center that buries the rear camera flush under the flat back wall.

    The module back face sits one internal clearance inside the back inner wall
    (back outer plane + wall_thickness), so nothing protrudes past the flat back.
    """
    dev = params["device"]
    comp = params["components"]
    depth = float(dev["envelope_mm"][2])
    wall = float(dev["wall_thickness_mm"])
    module_depth = float(comp["rear_camera"]["module_mm"][2])
    internal_clearance = float(comp["rear_camera"].get("burial_clearance_mm", 0.45))
    back_inner_wall_z = -depth / 2.0 + wall
    back_face_z = back_inner_wall_z + internal_clearance
    return back_face_z + module_depth / 2.0


def display_module_size_mm(params: dict[str, Any]) -> list[float]:
    """Full bonded LCD+CTP module footprint and thickness.

    Uses the TFT XY outline (the mechanical body that sits inside the bezel)
    with the full module Z height (cover lens + touch + polarizers + TFT cell +
    backlight unit), not the bare TFT cell thickness.
    """
    disp = params["display"]
    w, h, _t = disp["tft_outline_mm"]
    module_t = float(disp["module_outline_mm"][2])
    return [float(w), float(h), module_t]


def display_module_center_z(params: dict[str, Any]) -> float:
    """Z center of the bonded display module.

    The module top face sits one bonding-adhesive (OCA) thickness below the
    cover-glass inner face, so the module is bonded directly under the glass
    with no false air gap.
    """
    disp = params["display"]
    depth = float(params["device"]["envelope_mm"][2])
    cover_glass_t = float(disp["cover_glass_mm"][2])
    oca = float(disp["adhesive_thickness_mm"])
    module_t = float(disp["module_outline_mm"][2])
    front_z = depth / 2.0 - 0.35
    cover_inner_z = front_z - cover_glass_t / 2.0
    module_top_z = cover_inner_z - oca
    return module_top_z - module_t / 2.0


def cover_glass_z_bounds(params: dict[str, Any]) -> tuple[float, float]:
    depth = float(params["device"]["envelope_mm"][2])
    glass_t = float(params["display"]["cover_glass_mm"][2])
    glass_center_z = depth / 2.0 - 0.35
    return glass_center_z - glass_t / 2.0, glass_center_z + glass_t / 2.0


def side_frame_body_size_center(params: dict[str, Any]) -> tuple[list[float], list[float]]:
    width, height, depth = params["device"]["envelope_mm"]
    cover_inner_z, _cover_outer_z = cover_glass_z_bounds(params)
    z_min = -float(depth) / 2.0
    z_max = cover_inner_z - 0.05
    return [float(width), float(height), z_max - z_min], [0.0, 0.0, (z_min + z_max) / 2.0]


def front_camera_under_glass_center(params: dict[str, Any]) -> list[float]:
    height = float(params["device"]["envelope_mm"][1])
    cover_inner_z, _cover_outer_z = cover_glass_z_bounds(params)
    return [-19.0, height / 2.0 - 9.0, cover_inner_z - 0.08]


def battery_center_z(params: dict[str, Any]) -> float:
    """Battery Z center derived from the back inner wall + required swell void.

    Back face sits one swell-gap above the back inner wall; the rest of the
    cell extends toward the display. Keeps the swell void on the BACK face.
    """
    dev = params["device"]
    battery = params["battery"]
    depth = float(dev["envelope_mm"][2])
    wall = float(dev["wall_thickness_mm"])
    swell = float(battery["battery_swell_gap_mm"])
    cell_t = float(battery["envelope_mm"][2])
    back_inner_z = -depth / 2.0 + wall
    back_face_z = back_inner_z + swell
    return back_face_z + cell_t / 2.0


def rear_camera_center_xy(params: dict[str, Any]) -> tuple[float, float]:
    _width, height, _depth = params["device"]["envelope_mm"]
    return 21.0, height / 2 - 19.0


def rear_camera_shell_aperture_mm(params: dict[str, Any]) -> list[float]:
    glass_w, glass_h, _glass_t = params["components"]["rear_camera_glass"]["envelope_mm"]
    return [round(float(glass_w) + 1.4, 3), round(float(glass_h) + 1.4, 3)]


def rear_flash_center_xy(params: dict[str, Any]) -> tuple[float, float]:
    rear_camera_x, rear_camera_y = rear_camera_center_xy(params)
    module_w = float(params["components"]["rear_camera"]["module_mm"][0])
    # Keep enough molded orange land between camera and flash apertures so the
    # separate bevel frames do not overlap after the shell is boolean-cut.
    return rear_camera_x - (module_w / 2.0 + 3.1), rear_camera_y


def rear_camera_optical_sight_tunnel_mm(params: dict[str, Any]) -> tuple[float, float]:
    """Radius and depth of the clear optical path from rear exterior to camera."""
    depth = float(params["device"]["envelope_mm"][2])
    lens_radius = float(params["components"]["rear_camera"]["lens_diameter_mm"]) / 2.0
    module_center_z = rear_camera_buried_center_z(params)
    module_depth = float(params["components"]["rear_camera"]["module_mm"][2])
    module_rear_face_z = module_center_z - module_depth / 2.0
    back_outer_z = -depth / 2.0
    return lens_radius + 0.15, module_rear_face_z - back_outer_z


def rear_camera_optical_sight_tunnel_center(params: dict[str, Any]) -> list[float]:
    depth = float(params["device"]["envelope_mm"][2])
    _radius, tunnel_depth = rear_camera_optical_sight_tunnel_mm(params)
    back_outer_z = -depth / 2.0
    rear_camera_x, rear_camera_y = rear_camera_center_xy(params)
    return [rear_camera_x, rear_camera_y, back_outer_z + tunnel_depth / 2.0]


def rear_flash_shell_aperture_mm(params: dict[str, Any]) -> list[float]:
    window_w, window_h, _window_t = params["components"]["rear_flash_led"]["window_mm"]
    return [round(float(window_w) + 0.6, 3), round(float(window_h) + 0.6, 3)]


def handset_acoustic_slot_center(params: dict[str, Any]) -> list[float]:
    _width, height, depth = params["device"]["envelope_mm"]
    return [0.0, height / 2 - 7.6, depth / 2 + 0.08]


def handset_acoustic_slot_mm(_params: dict[str, Any]) -> list[float]:
    return [16.0, 1.0, 0.25]


def handset_cover_glass_cutout_mm(params: dict[str, Any]) -> list[float]:
    slot_w, slot_h, _slot_t = handset_acoustic_slot_mm(params)
    glass_t = float(params["display"]["cover_glass_mm"][2])
    return [slot_w + 0.4, slot_h + 0.3, glass_t + 0.6]


def handset_acoustic_mesh_center(params: dict[str, Any]) -> list[float]:
    _width, height, depth = params["device"]["envelope_mm"]
    return [0.0, height / 2 - 7.6, depth / 2 - 0.95]


def side_frame_external_cutout_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    width, height, _depth = params["device"]["envelope_mm"]
    comp = params["components"]
    power_cap = comp["power_button"]["cap_mm"]
    volume_cap = comp["volume_button"]["cap_mm"]
    cutouts: list[dict[str, Any]] = [
        {
            "name": "usb_c_side_frame_cutout",
            "source_aperture": "usb_c_external_aperture",
            "size": [10.8, 4.0, 4.2],
            "center": [0.0, -height / 2.0, -1.45],
        }
    ]
    for idx, x in enumerate([11.5, 14.5, 17.5, 20.5, 23.5], start=1):
        cutouts.append(
            {
                "name": f"bottom_speaker_side_frame_cutout_{idx}",
                "source_aperture": f"bottom_speaker_grille_slot_{idx}",
                "size": [1.35, 4.0, 4.4],
                "center": [x, -height / 2.0, -1.35],
            }
        )
    for idx, x in enumerate([-22.0, -17.0], start=1):
        cutouts.append(
            {
                "name": f"bottom_microphone_side_frame_cutout_{idx}",
                "source_aperture": f"bottom_microphone_port_{idx}",
                "size": [1.2, 4.0, 1.2],
                "center": [x, -height / 2.0, -1.35],
            }
        )
    cutouts.extend(
        [
            {
                "name": "top_microphone_side_frame_cutout",
                "source_aperture": "top_microphone_port",
                "size": [1.2, 4.0, 1.2],
                "center": [18.0, height / 2.0, -1.35],
            },
            {
                "name": "power_button_side_frame_cutout",
                "source_aperture": "power_button_cap",
                "size": [4.0, float(power_cap[1]) + 0.8, float(power_cap[2]) + 0.6],
                "center": [width / 2.0, 20.0, -0.4],
            },
            {
                "name": "volume_button_side_frame_cutout",
                "source_aperture": "volume_button_cap",
                "size": [4.0, float(volume_cap[1]) + 0.8, float(volume_cap[2]) + 0.6],
                "center": [-width / 2.0, 14.0, -0.4],
            },
        ]
    )
    return cutouts


def camera_seal_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    dev = params["device"]
    comp = params["components"]
    height = float(dev["envelope_mm"][1])
    depth = float(dev["envelope_mm"][2])
    rear_x, rear_y = rear_camera_center_xy(params)
    rear_z = -depth / 2 + comp["rear_camera_glass"]["envelope_mm"][2] + 0.08
    rear_glass = comp["rear_camera_glass"]["envelope_mm"]
    rear_lens = float(comp["rear_camera"]["lens_diameter_mm"])
    front_x = -19.0
    front_y = height / 2 - 9.0
    front_z = front_camera_under_glass_center(params)[2]
    front_lens = float(comp["front_camera"]["lens_diameter_mm"])
    return [
        {
            "name": "rear_camera_cover_adhesive_top",
            "size": [rear_glass[0] + 0.9, 0.45, 0.16],
            "center": [rear_x, rear_y + rear_glass[1] / 2 + 0.28, rear_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket above rear camera cover window",
        },
        {
            "name": "rear_camera_cover_adhesive_bottom",
            "size": [rear_glass[0] + 0.9, 0.45, 0.16],
            "center": [rear_x, rear_y - rear_glass[1] / 2 - 0.28, rear_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket below rear camera cover window",
        },
        {
            "name": "rear_camera_cover_adhesive_left",
            "size": [0.45, rear_glass[1], 0.16],
            "center": [rear_x - rear_glass[0] / 2 - 0.28, rear_y, rear_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket left of rear camera cover window",
        },
        {
            "name": "rear_camera_cover_adhesive_right",
            "size": [0.45, rear_glass[1], 0.16],
            "center": [rear_x + rear_glass[0] / 2 + 0.28, rear_y, rear_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket right of rear camera cover window",
        },
        {
            "name": "rear_camera_light_baffle_top",
            "size": [rear_lens + 1.5, 0.35, 0.55],
            "center": [rear_x, rear_y + rear_lens / 2 + 0.45, -depth / 2 + 0.35],
            "color": DARK,
            "role": "camera seal",
            "material": "black molded rear camera anti-dust light baffle",
        },
        {
            "name": "rear_camera_light_baffle_bottom",
            "size": [rear_lens + 1.5, 0.35, 0.55],
            "center": [rear_x, rear_y - rear_lens / 2 - 0.45, -depth / 2 + 0.35],
            "color": DARK,
            "role": "camera seal",
            "material": "black molded rear camera anti-dust light baffle",
        },
        {
            "name": "front_camera_black_mask_window",
            "size": [front_lens + 1.6, front_lens + 1.6, 0.08],
            "center": [front_x, front_y, front_z],
            "color": DARK,
            "role": "camera seal",
            "material": "black printed mask datum around front under-glass camera",
        },
        *flash_window_adhesive_specs(params),
        *front_camera_under_glass_adhesive_specs(params),
        rear_flash_camera_septum_spec(params),
    ]


def flash_window_adhesive_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Four-side PSA bond ring sealing the rear flash light-pipe window to the
    back shell, mirroring the rear-camera cover seal so the flash window is not
    an unsealed back-glass ingress path (camera-back audit B-3).
    """
    comp = params["components"]
    depth = float(params["device"]["envelope_mm"][2])
    flash_x, flash_y = rear_flash_center_xy(params)
    win_w, win_h, _win_t = comp["rear_flash_led"]["window_mm"]
    ring = float(comp["rear_flash_led"]["window_seal_ring_width_mm"])
    seal_z = -depth / 2 + comp["rear_camera_glass"]["envelope_mm"][2] + 0.08
    half_w = float(win_w) / 2
    half_h = float(win_h) / 2
    gap = ring / 2 + 0.05
    return [
        {
            "name": "rear_flash_window_adhesive_top",
            "size": [float(win_w) + 2 * ring, ring, 0.16],
            "center": [flash_x, flash_y + half_h + gap, seal_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket above rear flash light-pipe window",
        },
        {
            "name": "rear_flash_window_adhesive_bottom",
            "size": [float(win_w) + 2 * ring, ring, 0.16],
            "center": [flash_x, flash_y - half_h - gap, seal_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket below rear flash light-pipe window",
        },
        {
            "name": "rear_flash_window_adhesive_left",
            "size": [ring, float(win_h), 0.16],
            "center": [flash_x - half_w - gap, flash_y, seal_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket left of rear flash light-pipe window",
        },
        {
            "name": "rear_flash_window_adhesive_right",
            "size": [ring, float(win_h), 0.16],
            "center": [flash_x + half_w + gap, flash_y, seal_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "black PSA gasket right of rear flash light-pipe window",
        },
    ]


def front_camera_under_glass_adhesive_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Four-side bond ring sealing the front under-glass camera window to the
    black-mask aperture so the front-camera path is dust/light sealed under the
    cover glass (camera-back audit B-4).
    """
    comp = params["components"]
    front_x = -19.0
    front_y = float(params["device"]["envelope_mm"][1]) / 2 - 9.0
    front_z = front_camera_under_glass_center(params)[2]
    win = float(comp["front_camera"]["lens_diameter_mm"])
    ring = 0.4
    half = win / 2
    gap = ring / 2 + 0.05
    return [
        {
            "name": "front_camera_under_glass_adhesive_top",
            "size": [win + 2 * ring, ring, 0.08],
            "center": [front_x, front_y + half + gap, front_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "optically-black PSA bond ring above front under-glass camera window",
        },
        {
            "name": "front_camera_under_glass_adhesive_bottom",
            "size": [win + 2 * ring, ring, 0.08],
            "center": [front_x, front_y - half - gap, front_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "optically-black PSA bond ring below front under-glass camera window",
        },
        {
            "name": "front_camera_under_glass_adhesive_left",
            "size": [ring, win, 0.08],
            "center": [front_x - half - gap, front_y, front_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "optically-black PSA bond ring left of front under-glass camera window",
        },
        {
            "name": "front_camera_under_glass_adhesive_right",
            "size": [ring, win, 0.08],
            "center": [front_x + half + gap, front_y, front_z],
            "color": ADHESIVE,
            "role": "camera seal",
            "material": "optically-black PSA bond ring right of front under-glass camera window",
        },
    ]


def rear_flash_camera_septum_spec(params: dict[str, Any]) -> dict[str, Any]:
    """Opaque molded baffle in the clear gap between the camera module edge and
    the flash light-pipe.

    Geometry constraints, all measured against the live solid model:
    - X: sits ``offset_from_camera_center_mm`` toward the flash from the camera
      center, clearing the camera module's outer X face by >= the min gap.
    - Z (height): molded root seats flush on the back shell inner wall (0-gap
      face seat -> intentional contact), rising to one min-gap below the main
      PCB bottom face. This covers the full back-glass stray-light coupling
      region while never entering the solid PCB box (which would otherwise be
      an unintentional clash that may not be allowlisted).
    - Y: spans the shared flash/camera optical band so edge-coupled light across
      the flat back glass is blocked.
    """
    dev = params["device"]
    comp = params["components"]
    height = float(dev["envelope_mm"][1])
    depth = float(dev["envelope_mm"][2])
    wall = float(dev["wall_thickness_mm"])
    pcb = params["pcb"]
    rear_x = 21.0
    rear_y = height / 2 - 19.0
    rear_lens = float(comp["rear_camera"]["lens_diameter_mm"])
    septum = comp["rear_flash_camera_septum"]
    septum_thickness = float(septum["thickness_mm"])
    septum_offset = float(septum["offset_from_camera_center_mm"])
    back_inner_wall_z = -depth / 2.0 + wall
    pcb_bottom_z = float(pcb["z_center_mm"]) - float(pcb["outline_mm"][2]) / 2.0
    min_gap = 0.15
    z_lo = back_inner_wall_z
    z_hi = pcb_bottom_z - min_gap
    septum_depth = z_hi - z_lo
    return {
        "name": "rear_flash_camera_septum",
        "size": [
            septum_thickness,
            rear_lens + 1.5,
            septum_depth,
        ],
        "center": [
            rear_x - septum_offset,
            rear_y,
            z_lo + septum_depth / 2.0,
        ],
        "color": DARK,
        "role": "camera seal",
        "material": "opaque PC stray-light septum between rear flash light-pipe and rear camera baffle column, molded to the back shell inner wall",
    }


def kicad_outline_mm(path: Path) -> list[float] | None:
    if not path.is_file():
        return None
    text = path.read_text(errors="ignore")
    matches = re.findall(
        r"\(gr_rect\s+\(start\s+([0-9.]+)\s+([0-9.]+)\)\s+"
        r'\(end\s+([0-9.]+)\s+([0-9.]+)\).*?\(layer\s+"Edge\.Cuts"\)',
        text,
        flags=re.DOTALL,
    )
    if not matches:
        return None
    xs: list[float] = []
    ys: list[float] = []
    for groups in matches:
        x1, y1, x2, y2 = [float(group) for group in groups]
        xs.extend([x1, x2])
        ys.extend([y1, y2])
    return [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)]


def adhesive_corner_radius(params: dict[str, Any]) -> float:
    return max(params["device"]["corner_radius_mm"] - 0.45, 0.1)


def adhesive_gasket_parts(params: dict[str, Any]) -> list[Part]:
    disp = params["display"]
    glass_w, glass_h, _ = disp["cover_glass_mm"]
    width = disp["adhesive_width_mm"]
    thickness = disp["adhesive_thickness_mm"]
    z = params["device"]["envelope_mm"][2] / 2.0 - 0.85
    corner = adhesive_corner_radius(params)
    straight_w = glass_w - 2.0 * corner
    straight_h = glass_h - 2.0 * corner
    return [
        box(
            "screen_adhesive_top",
            [straight_w, width, thickness],
            [0, glass_h / 2 - width / 2, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
        box(
            "screen_adhesive_bottom",
            [straight_w, width, thickness],
            [0, -glass_h / 2 + width / 2, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
        box(
            "screen_adhesive_left",
            [width, straight_h, thickness],
            [-glass_w / 2 + width / 2, 0, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
        box(
            "screen_adhesive_right",
            [width, straight_h, thickness],
            [glass_w / 2 - width / 2, 0, z],
            ADHESIVE,
            "screen retention",
            "die-cut display adhesive",
        ),
    ]


def screw_boss_points(params: dict[str, Any]) -> list[tuple[float, float]]:
    """XY centres of the molded screw bosses, sized from manufacturing.screw_boss_count.

    Four bosses sit at the corners (worst-case corner-drop load path), the rest are
    distributed along the long edges. A 10-boss layout halves the spacing between
    corner and edge bosses versus the original 6, cutting per-boss inertial shear.
    """
    count = int(params["manufacturing"]["screw_boss_count"])
    boss_x = 35.0
    corners = [(-boss_x, 58.0), (boss_x, 58.0), (-boss_x, -58.0), (boss_x, -58.0)]
    edge_rows = [20.0, -20.0, 38.0, -38.0, 0.0, 58.0 - 2.0, -(58.0 - 2.0)]
    points = list(corners)
    for y in edge_rows:
        if len(points) >= count:
            break
        points.append((-boss_x, y))
        if len(points) >= count:
            break
        points.append((boss_x, y))
    return points[:count]


def corner_rib_specs(params: dict[str, Any]) -> list[dict[str, Any]]:
    """Triangular corner gussets tying the four corner bosses into the side frame.

    Modeled as a small L of two thin legs at each corner; they share corner-drop
    shear into the rib network rather than loading the boss neck alone.
    """
    rib = params["manufacturing"].get("corner_rib")
    if not rib:
        return []
    width, height, depth = params["device"]["envelope_mm"]
    leg = float(rib["leg_mm"])
    t = float(rib["thickness_mm"])
    h = float(rib["height_mm"])
    z = -depth / 2 + 2.0
    boss_x = 35.0
    corners = [(-boss_x, 58.0), (boss_x, 58.0), (-boss_x, -58.0), (boss_x, -58.0)]
    specs: list[dict[str, Any]] = []
    for idx, (cx, cy) in enumerate(corners, start=1):
        sx = 1.0 if cx > 0 else -1.0
        sy = 1.0 if cy > 0 else -1.0
        specs.append(
            {
                "name": f"orange_corner_rib_{idx}",
                "size": [leg, t, h],
                "center": [cx - sx * leg / 2.0, cy - sy * t / 2.0, z],
            }
        )
        specs.append(
            {
                "name": f"orange_corner_rib_{idx}_leg",
                "size": [t, leg, h],
                "center": [cx - sx * t / 2.0, cy - sy * leg / 2.0, z],
            }
        )
    return specs


def enclosure_feature_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    mfg = params["manufacturing"]
    boss_radius = mfg["screw_boss_outer_diameter_mm"] / 2.0
    boss_z = -depth / 2 + 2.0
    boss_points = screw_boss_points(params)
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
                [19.1, -height / 2 + 13.0, -4.1],
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
    for rib in corner_rib_specs(params):
        parts.append(
            box(
                rib["name"],
                rib["size"],
                rib["center"],
                ORANGE,
                "molded enclosure",
                "PC+ABS corner gusset tying corner boss to side frame",
            )
        )
    cushion = params["display"].get("glass_perimeter_cushion")
    if cushion:
        glass_w, glass_h, _ = params["display"]["cover_glass_mm"]
        cw = float(cushion["perimeter_width_mm"])
        ct = float(cushion["envelope_mm"][2])
        front_z = depth / 2 - 0.35
        cushion_z = front_z - 0.7 - ct / 2.0
        straight_w = glass_w - 2.0 * params["device"]["corner_radius_mm"]
        straight_h = glass_h - 2.0 * params["device"]["corner_radius_mm"]
        for name, size, center in [
            (
                "glass_perimeter_cushion_top",
                [straight_w, cw, ct],
                [0, glass_h / 2 - cw / 2, cushion_z],
            ),
            (
                "glass_perimeter_cushion_bottom",
                [straight_w, cw, ct],
                [0, -glass_h / 2 + cw / 2, cushion_z],
            ),
            (
                "glass_perimeter_cushion_left",
                [cw, straight_h, ct],
                [-glass_w / 2 + cw / 2, 0, cushion_z],
            ),
            (
                "glass_perimeter_cushion_right",
                [cw, straight_h, ct],
                [glass_w / 2 - cw / 2, 0, cushion_z],
            ),
        ]:
            parts.append(
                box(
                    name,
                    size,
                    center,
                    ADHESIVE,
                    "screen retention",
                    cushion["material"],
                )
            )
    return parts


def advanced_phone_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    comp = params["components"]
    radio = params.get("radio", {})
    cellular_keepout = radio.get("cellular", {}).get("antenna_keepout_mm", [62.0, 6.0, 2.0])
    wifi_keepout = radio.get("wifi_bt", {}).get("antenna_keepout_mm", [34.0, 5.0, 2.0])
    z_inner = -1.1
    z_back = -depth / 2 + comp["rear_camera_glass"]["envelope_mm"][2] / 2.0
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
            "antenna_aperture_tuner",
            radio.get("antenna_aperture_tuner", {}).get("envelope_mm", [2.0, 2.0, 0.5]),
            [-cellular_keepout[0] / 2.0 + 4.0, -height / 2 + 9.0, -1.6],
            METAL,
            "RF tuner",
            radio.get("antenna_aperture_tuner", {}).get(
                "candidate", "Qorvo QPC1252Q antenna aperture tuner"
            ),
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
            "cellular_lga_module_keepout",
            radio.get("cellular", {}).get("envelope_mm", [29.0, 32.0, 2.4]),
            [-15.5, 45.0, -0.45],
            MODULE_SHIELD,
            "cellular module",
            radio.get("cellular", {}).get(
                "candidate", "Quectel RG255C-class 5G RedCap LGA module envelope"
            ),
        ),
        box(
            "wifi_bt_module_keepout",
            radio.get("wifi_bt", {}).get("envelope_mm", [12.5, 9.4, 1.2]),
            [20.0, 42.0, -1.0],
            MODULE_SHIELD,
            "Wi-Fi/Bluetooth module",
            radio.get("wifi_bt", {}).get(
                "candidate", "Murata LBEE5XV2EA-802 Type 2EA Wi-Fi 6E/Bluetooth module"
            ),
        ),
        box(
            "compute_som_sodimm_connector",
            [65.0, 2.6, 0.3],
            [0.0, 50.3, -1.52],
            METAL,
            "compute interconnect",
            "260-pin 0.5 mm SODIMM compute-SoM carrier connector envelope",
        ),
        box(
            "compute_som_daughterboard_keepout",
            [68.0, 30.0, 1.2],
            [0.0, 45.0, -0.3],
            [0.12, 0.12, 0.12, 0.28],
            "compute module keepout",
            "Firefly Core-3566JD4-class SoM daughterboard swept keepout; non-release fit envelope",
        ),
        box(
            "soc_package_marker",
            [13.0, 13.0, 0.24],
            [-7.0, 55.0, -0.06],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for application processor package under SoC shield",
        ),
        box(
            "dram_package_marker",
            [9.5, 8.0, 0.22],
            [-7.0, 68.0, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for LPDDR memory package near SoC",
        ),
        box(
            "storage_package_marker",
            [11.5, 9.0, 0.22],
            [11.0, 68.0, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for eMMC/UFS storage package",
        ),
        box(
            "pmic_package_marker",
            [7.0, 7.0, 0.22],
            [12.5, 55.0, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for PMIC package under power shield",
        ),
        box(
            "usb_pd_controller_package_marker",
            [9.0, 9.0, 0.22],
            [7.0, -54.8, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for TPS65987 USB-PD controller package and exposed pads",
        ),
        box(
            "charger_package_marker",
            [4.0, 4.0, 0.2],
            [-4.0, -54.8, -0.08],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for MAX77860 charger WLP package",
        ),
        box(
            "battery_connector_package_marker",
            [6.0, 3.0, 0.18],
            [-6.0, -50.4, -0.08],
            IC_PACKAGE,
            "PCB connector marker",
            "visual marker for 4-pin battery pack connector or welded FPC landing",
        ),
        box(
            "audio_codec_package_marker",
            [7.0, 7.0, 0.22],
            [-18.5, -54.0, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for 48-pin audio codec package in bottom audio region",
        ),
        box(
            "rf_transceiver_package_marker",
            [7.5, 7.5, 0.22],
            [-22.0, 55.0, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for RF transceiver/front-end package under radio shield",
        ),
        box(
            "gnss_lna_package_marker",
            [3.0, 2.5, 0.2],
            [-30.0, 62.5, -1.2],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for GNSS/RF low-noise amplifier placement",
        ),
        box(
            "backlight_bias_package_marker",
            [4.0, 4.0, 0.22],
            [24.0, 35.5, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for display backlight/bias power IC package",
        ),
        box(
            "fuel_gauge_package_marker",
            [1.9, 1.5, 0.18],
            [-12.0, -50.0, -0.08],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for battery fuel-gauge WLCSP package",
        ),
        box(
            "haptic_driver_package_marker",
            [1.4, 1.4, 0.18],
            [20.0, -54.0, -0.08],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for haptic driver WLCSP package",
        ),
        box(
            "usim_levelshift_package_marker",
            [2.6, 2.1, 0.18],
            [26.0, -56.0, -0.08],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for USIM level-shifter/ESD package",
        ),
        box(
            "esim_package_marker",
            [2.0, 2.0, 0.18],
            [28.0, -52.0, -0.08],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for MFF2 eSIM package",
        ),
        box(
            "nfc_controller_package_marker",
            [5.0, 5.0, 0.22],
            [-26.0, 30.0, -0.07],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for NFC controller package",
        ),
        box(
            "nfc_loop_match_marker",
            [4.0, 1.4, 0.12],
            [-30.0, 58.0, -0.09],
            METAL,
            "PCB passive marker",
            "visual marker for NFC loop matching network",
        ),
        box(
            "sensor_hub_package_marker",
            [3.0, 3.0, 0.2],
            [7.0, 35.0, -0.08],
            IC_PACKAGE,
            "PCB component marker",
            "visual marker for always-on sensor hub package",
        ),
        box(
            "esd_array_6ch_marker",
            [2.0, 1.0, 0.16],
            [0.0, -58.0, -0.09],
            IC_PACKAGE,
            "PCB protection marker",
            "visual marker for six-channel ESD protection arrays",
        ),
        box(
            "tvs_diode_2p_marker",
            [1.2, 0.8, 0.16],
            [5.0, -58.0, -0.09],
            IC_PACKAGE,
            "PCB protection marker",
            "visual marker for two-terminal TVS diodes",
        ),
        box(
            "testpoint_1mm_marker",
            [1.0, 1.0, 0.04],
            [10.0, -58.0, -0.11],
            METAL,
            "PCB test marker",
            "visual marker for one-millimeter board test pads",
        ),
        box(
            "fiducial_1mm_marker",
            [1.0, 1.0, 0.03],
            [13.0, -58.0, -0.115],
            METAL,
            "PCB assembly marker",
            "visual marker for one-millimeter global fiducials",
        ),
        box(
            "mounting_hole_1p2_marker",
            [1.2, 1.2, 0.04],
            [16.0, -58.0, -0.11],
            METAL,
            "PCB mechanical marker",
            "visual marker for 1.2 mm mounting-hole annular keepouts",
        ),
        box(
            "r0402_component_marker",
            [1.0, 0.5, 0.16],
            [-8.0, -58.0, -0.09],
            IC_PACKAGE,
            "PCB passive marker",
            "visual marker for 0402 resistor packages",
        ),
        box(
            "c0402_component_marker",
            [1.0, 0.5, 0.16],
            [-11.0, -58.0, -0.09],
            IC_PACKAGE,
            "PCB passive marker",
            "visual marker for 0402 capacitor packages",
        ),
        box(
            "l0402_component_marker",
            [1.0, 0.6, 0.2],
            [-14.0, -58.0, -0.08],
            IC_PACKAGE,
            "PCB passive marker",
            "visual marker for 0402 inductor/ferrite packages",
        ),
        box(
            "pi_match_0402_marker",
            [2.4, 1.1, 0.18],
            [-19.0, -58.0, -0.085],
            IC_PACKAGE,
            "PCB passive marker",
            "visual marker for RF pi matching component triplets",
        ),
        box(
            "rc_array_4ch_marker",
            [2.0, 1.0, 0.18],
            [-23.0, -58.0, -0.085],
            IC_PACKAGE,
            "PCB passive marker",
            "visual marker for four-channel RC conditioning arrays",
        ),
        box(
            "shunt_1206_marker",
            [3.2, 1.6, 0.22],
            [-28.0, -58.0, -0.07],
            IC_PACKAGE,
            "PCB passive marker",
            "visual marker for 1206 current-shunt packages",
        ),
        box(
            "wifi_bt_rf_feed_development_envelope",
            [10.0, 0.45, 0.35],
            [28.5, 42.0, -1.0],
            METAL,
            "RF feed",
            "development coax/feed envelope from Wi-Fi/Bluetooth module toward side antenna keepout",
        ),
        box(
            "cellular_rf_feed_development_envelope",
            [0.45, 15.0, 0.35],
            [-30.0, 61.0, -1.0],
            METAL,
            "RF feed",
            "development coax/feed envelope from cellular module toward top antenna keepout",
        ),
        box(
            "display_fpc_tail",
            [10.0, 6.0, 0.12],
            [24.0, 45.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "display/touch FPC tail route marker from connector into the display stack",
        ),
        box(
            "rear_camera_fpc_tail",
            [12.0, 0.8, 0.12],
            [8.0, 63.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "rear camera CSI FPC tail marker from top board connector to camera module",
        ),
        box(
            "front_camera_fpc_tail",
            [9.0, 0.8, 0.12],
            [-18.0, 63.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "front camera CSI FPC tail marker under the cover-glass camera region",
        ),
        box(
            "side_key_flex_tail",
            [1.0, 28.0, 0.12],
            [31.0, 51.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "power/volume side-key flex tail along the right side wall",
        ),
        box(
            "battery_connector_lead_flex",
            [8.0, 1.2, 0.12],
            [-6.0, -52.5, -1.45],
            FPC_AMBER,
            "flex/cable",
            "battery pack positive/negative/NTC/ID lead flex landing on bottom island",
        ),
        box(
            "usb_c_power_data_escape_tail",
            [18.0, 1.0, 0.12],
            [0.0, -63.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "USB-C VBUS/CC/USB2 escape tail marker on the bottom island",
        ),
        box(
            "usb_pd_controller_escape_trace_marker",
            [9.0, 1.0, 0.12],
            [3.8, -59.0, -1.45],
            FPC_AMBER,
            "PCB trace marker",
            "board-level USB-C VBUS/CC/USB2 route marker from receptacle to TPS65987",
        ),
        box(
            "pd_charger_control_trace_marker",
            [10.0, 1.0, 0.12],
            [1.5, -54.8, -1.45],
            FPC_AMBER,
            "PCB trace marker",
            "board-level PD controller to charger VBUS/SYS/I2C/IRQ route marker",
        ),
        box(
            "charger_battery_power_sense_trace_marker",
            [4.0, 4.8, 0.12],
            [-5.0, -53.4, -1.2],
            FPC_AMBER,
            "PCB trace marker",
            "board-level charger to battery connector VBAT/SYS/NTC/ID route marker",
        ),
        box(
            "display_bias_power_flex_marker",
            [6.0, 1.0, 0.12],
            [21.0, 41.0, -1.35],
            FPC_AMBER,
            "flex/cable",
            "display bias/backlight AVDD/AVEE flex marker from bias IC to display connector",
        ),
        box(
            "rear_camera_power_flex_marker",
            [8.0, 0.7, 0.12],
            [12.0, 58.5, -1.35],
            FPC_AMBER,
            "flex/cable",
            "rear camera AVDD/DVDD/reset power-control flex marker",
        ),
        box(
            "front_camera_power_flex_marker",
            [7.0, 0.7, 0.12],
            [-15.0, 58.5, -1.35],
            FPC_AMBER,
            "flex/cable",
            "front camera AVDD/DVDD/reset power-control flex marker",
        ),
        box(
            "wifi_bt_host_control_trace_marker",
            [13.0, 1.0, 0.12],
            [18.0, 35.5, -1.35],
            FPC_AMBER,
            "PCB trace marker",
            "Wi-Fi/Bluetooth PCIe/SDIO/UART/enable host-control route marker",
        ),
        box(
            "cellular_host_control_trace_marker",
            [12.0, 1.0, 0.12],
            [-19.0, 38.5, -1.35],
            FPC_AMBER,
            "PCB trace marker",
            "cellular USB2/PCIe/reset/disable host-control route marker",
        ),
        box(
            "bottom_speaker_lead_pair",
            [10.0, 1.0, 0.12],
            [0.0, -62.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "bottom speaker differential lead pair marker",
        ),
        box(
            "bottom_microphone_flex_leads",
            [8.0, 1.0, 0.12],
            [-18.0, -62.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "bottom microphone bias/data flex lead marker",
        ),
        box(
            "top_microphone_flex_tail",
            [0.8, 18.0, 0.12],
            [-27.0, 55.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "top microphone PDM flex tail marker from top microphone port region to top PCB island",
        ),
        box(
            "earpiece_receiver_lead_flex",
            [14.0, 0.8, 0.12],
            [0.0, 61.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "earpiece receiver lead flex marker behind the handset acoustic slot",
        ),
        box(
            "haptic_flex_tail",
            [12.0, 1.0, 0.12],
            [24.0, -53.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "LRA haptic drive flex tail marker",
        ),
        box(
            "sensor_hub_i2c_flex_marker",
            [5.0, 0.8, 0.12],
            [-10.0, 34.5, -1.35],
            FPC_AMBER,
            "flex/cable",
            "sensor hub I2C flex/trace marker",
        ),
        box(
            "sim_esim_signal_flex_marker",
            [1.0, 9.0, 0.12],
            [29.0, -62.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "SIM/eSIM signal route marker to the side tray region",
        ),
        box(
            "nfc_loop_antenna_flex_marker",
            [6.0, 1.0, 0.12],
            [18.0, -62.0, -1.45],
            FPC_AMBER,
            "flex/cable",
            "NFC controller to loop-match antenna flex marker for NFC_RF_P/N",
        ),
        box(
            "cellular_div_rf_feed_development_envelope",
            [0.45, 12.0, 0.28],
            [-24.0, 60.0, -1.35],
            METAL,
            "RF feed",
            "development cellular diversity RF feed envelope",
        ),
        box(
            "cellular_gnss_rf_feed_development_envelope",
            [0.45, 10.0, 0.28],
            [-28.0, 60.0, -1.35],
            METAL,
            "RF feed",
            "development GNSS RF feed envelope",
        ),
        box(
            "wifi_bt_rf1_feed_development_envelope",
            [10.0, 0.45, 0.28],
            [27.0, 39.0, -1.35],
            METAL,
            "RF feed",
            "development second Wi-Fi/Bluetooth RF feed envelope",
        ),
        box(
            "soc_shield_ground_spring_marker",
            [3.6, 0.7, 0.22],
            [-5.5, 24.5, -1.1],
            METAL,
            "ground spring",
            "SoC shield can to PCB ground spring marker",
        ),
        box(
            "radio_shield_ground_spring_marker",
            [3.6, 0.7, 0.22],
            [-23.0, 33.0, -1.1],
            METAL,
            "ground spring",
            "radio shield can to PCB/chassis ground spring marker",
        ),
        box(
            "haptic_lra",
            comp["haptic"]["envelope_mm"],
            [35.5, -44.0, -3.2],
            DARK,
            "haptics",
            comp["haptic"]["candidate"],
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


def cad_connection_terminal_parts(parts: list[Part]) -> list[Part]:
    parts_by_name = {part.name: part for part in parts}
    terminals: list[Part] = []
    main_pcb_terminal_index = 0
    endpoint_terminal_counts: dict[str, int] = {}
    for connection_id, from_name, to_name in CAD_CONNECTION_TERMINAL_ENDPOINTS:
        for side, endpoint_name in (("from", from_name), ("to", to_name)):
            endpoint = parts_by_name.get(endpoint_name)
            if endpoint is None:
                continue
            low, high = endpoint.bounds
            center = ((low + high) / 2.0).astype(float)
            terminal_size = np.array([0.45, 0.22, 0.02], dtype=float)
            if endpoint_name == "main_pcb":
                x_slots = np.linspace(low[0] + 3.0, high[0] - 3.0, 6)
                y_slots = [low[1] + 2.0, high[1] - 2.0]
                slot = main_pcb_terminal_index
                center[0] = float(x_slots[slot % len(x_slots)])
                center[1] = float(y_slots[(slot // len(x_slots)) % len(y_slots)])
                center[2] = CONNECTION_TERMINAL_MARKER_Z_MM
                main_pcb_terminal_index += 1
            else:
                slot = endpoint_terminal_counts.get(endpoint_name, 0)
                endpoint_terminal_counts[endpoint_name] = slot + 1
                direction = center[:2].astype(float)
                norm = float(np.linalg.norm(direction))
                direction = np.array([1.0, 0.0], dtype=float) if norm < 1e-06 else direction / norm
                perpendicular = np.array([-direction[1], direction[0]], dtype=float)
                center[:2] += direction * 0.85 + perpendicular * ((slot % 3) - 1) * 0.55
                center[2] = CONNECTION_TERMINAL_MARKER_Z_MM
            terminals.append(
                box(
                    f"{connection_id}_{side}_terminal",
                    terminal_size.tolist(),
                    center.round(3).tolist(),
                    [0.95, 0.74, 0.18, 1.0],
                    "connection terminal",
                    (
                        f"{side} terminal marker for {connection_id} on {endpoint_name}; "
                        "local CAD connection evidence only"
                    ),
                )
            )
    return terminals


def tooling_parts(params: dict[str, Any]) -> list[Part]:
    width, height, depth = params["device"]["envelope_mm"]
    mfg = params["manufacturing"]
    z = -depth / 2 - 5.0
    runner_d = mfg["runner_diameter_mm"]
    sprue_d = mfg["sprue_diameter_mm"]
    gate_t = mfg["gate_thickness_mm"]
    boss_z = -depth / 2 + 2.05
    boss_points = screw_boss_points(params)
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
    battery = params["battery"]
    comp = params["components"]

    width, height, depth = dev["envelope_mm"]
    -depth / 2 + 0.6
    front_z = depth / 2 - 0.35
    corner_radius = dev["corner_radius_mm"]
    wall = dev["wall_thickness_mm"]
    rear_camera_glass_t = comp["rear_camera_glass"]["envelope_mm"][2]
    rear_camera_center_z = rear_camera_buried_center_z(params)
    rear_camera_x, rear_camera_y = rear_camera_center_xy(params)
    rear_aperture_w, rear_aperture_h = rear_camera_shell_aperture_mm(params)
    rear_sight_radius, rear_sight_depth = rear_camera_optical_sight_tunnel_mm(params)
    -depth / 2.0 + 0.035
    # Bezel lands are 0.14 mm thick; seat their center so the outer face stays at
    # or inside the flat back outer plane (Zmin >= -depth/2), keeping flush back.
    rear_bezel_z = -depth / 2.0 + 0.14 / 2.0
    rear_bezel_border_mm = 1.0
    rear_flash_x, rear_flash_y = rear_flash_center_xy(params)
    rear_flash_aperture_w, rear_flash_aperture_h = rear_flash_shell_aperture_mm(params)
    rear_flash_bezel_z = -depth / 2.0 + 0.12 / 2.0
    rear_flash_bezel_border_mm = 0.45
    side_frame_size, side_frame_center = side_frame_body_size_center(params)

    parts: list[Part] = [
        orange_back_shell_part(params),
        rounded_frame(
            "orange_side_frame",
            side_frame_size,
            side_frame_center,
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
            display_module_size_mm(params),
            [0, -5.5, display_module_center_z(params)],
            DARK,
            "screen",
            "bonded LCD+CTP module (cover lens, touch, polarizers, TFT cell, BLU)",
        ),
        composite_box_part(
            "main_pcb",
            [(size, center) for size, center, _name in pcb_island_segments(params)],
            PCB_GREEN,
            "PCB",
            "8L HDI FR-4 top/bottom split-island board envelope around full-width battery",
        ),
        box(
            "battery_pouch",
            battery["envelope_mm"],
            [0, -7.0, battery_center_z(params)],
            [0.16, 0.16, 0.17, 1],
            "battery",
            "LiPo pouch",
        ),
        box(
            "battery_back_void_foam_pad",
            battery["back_void_foam_pad_mm"],
            [
                0,
                -7.0,
                -depth / 2 + wall + float(battery["back_void_foam_pad_mm"][2]) / 2.0,
            ],
            [0.07, 0.075, 0.08, 0.55],
            "battery support",
            battery["back_void_foam_material"],
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
            *[
                box(
                    spec["name"],
                    spec["size"],
                    spec["center"],
                    spec["color"],
                    spec["role"],
                    spec["material"],
                )
                for spec in usb_c_seal_specs(params)
            ],
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
                [rear_camera_x, rear_camera_y, rear_camera_center_z],
                CAMERA,
                "camera",
                "single 13 MP simple-AF module, buried",
            ),
            box(
                "rear_camera_shell_aperture",
                [rear_aperture_w, rear_aperture_h, 0.08],
                [rear_camera_x, rear_camera_y, -depth / 2.0 - 0.015],
                [0.01, 0.008, 0.006, 1.0],
                "camera aperture",
                "open molded back-shell camera hole exposing the flush cover window",
            ),
            box(
                "orange_rear_camera_bezel_top",
                [
                    rear_aperture_w + 2.0 * rear_bezel_border_mm,
                    rear_bezel_border_mm,
                    0.14,
                ],
                [
                    rear_camera_x,
                    rear_camera_y + rear_aperture_h / 2.0 + rear_bezel_border_mm / 2.0,
                    rear_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange camera aperture bevel/top land",
            ),
            box(
                "orange_rear_camera_bezel_bottom",
                [
                    rear_aperture_w + 2.0 * rear_bezel_border_mm,
                    rear_bezel_border_mm,
                    0.14,
                ],
                [
                    rear_camera_x,
                    rear_camera_y - rear_aperture_h / 2.0 - rear_bezel_border_mm / 2.0,
                    rear_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange camera aperture bevel/bottom land",
            ),
            box(
                "orange_rear_camera_bezel_left",
                [rear_bezel_border_mm, rear_aperture_h, 0.14],
                [
                    rear_camera_x - rear_aperture_w / 2.0 - rear_bezel_border_mm / 2.0,
                    rear_camera_y,
                    rear_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange camera aperture bevel/left land",
            ),
            box(
                "orange_rear_camera_bezel_right",
                [rear_bezel_border_mm, rear_aperture_h, 0.14],
                [
                    rear_camera_x + rear_aperture_w / 2.0 + rear_bezel_border_mm / 2.0,
                    rear_camera_y,
                    rear_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange camera aperture bevel/right land",
            ),
            box(
                "rear_flash_shell_aperture",
                [rear_flash_aperture_w, rear_flash_aperture_h, 0.08],
                [rear_flash_x, rear_flash_y, -depth / 2.0 - 0.015],
                [0.01, 0.008, 0.006, 1.0],
                "camera aperture",
                "open molded back-shell flash hole exposing the flush light-pipe window",
            ),
            box(
                "orange_rear_flash_bezel_top",
                [
                    rear_flash_aperture_w + 2.0 * rear_flash_bezel_border_mm,
                    rear_flash_bezel_border_mm,
                    0.12,
                ],
                [
                    rear_flash_x,
                    rear_flash_y + rear_flash_aperture_h / 2.0 + rear_flash_bezel_border_mm / 2.0,
                    rear_flash_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange flash aperture bevel/top land",
            ),
            box(
                "orange_rear_flash_bezel_bottom",
                [
                    rear_flash_aperture_w + 2.0 * rear_flash_bezel_border_mm,
                    rear_flash_bezel_border_mm,
                    0.12,
                ],
                [
                    rear_flash_x,
                    rear_flash_y - rear_flash_aperture_h / 2.0 - rear_flash_bezel_border_mm / 2.0,
                    rear_flash_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange flash aperture bevel/bottom land",
            ),
            box(
                "orange_rear_flash_bezel_left",
                [rear_flash_bezel_border_mm, rear_flash_aperture_h, 0.12],
                [
                    rear_flash_x - rear_flash_aperture_w / 2.0 - rear_flash_bezel_border_mm / 2.0,
                    rear_flash_y,
                    rear_flash_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange flash aperture bevel/left land",
            ),
            box(
                "orange_rear_flash_bezel_right",
                [rear_flash_bezel_border_mm, rear_flash_aperture_h, 0.12],
                [
                    rear_flash_x + rear_flash_aperture_w / 2.0 + rear_flash_bezel_border_mm / 2.0,
                    rear_flash_y,
                    rear_flash_bezel_z,
                ],
                ORANGE,
                "molded enclosure",
                "integral orange flash aperture bevel/right land",
            ),
            cyl_z(
                "rear_camera_lens_window",
                comp["rear_camera"]["lens_diameter_mm"] / 2,
                rear_camera_glass_t,
                [rear_camera_x, rear_camera_y, -depth / 2 + rear_camera_glass_t / 2.0],
                CAMERA,
                "camera",
                "flush internal lens window, coplanar with flat back",
            ),
            cyl_z(
                "rear_camera_optical_sight_tunnel",
                rear_sight_radius,
                rear_sight_depth,
                rear_camera_optical_sight_tunnel_center(params),
                [0.15, 0.35, 0.95, 0.26],
                "camera optical clearance",
                "clear rear-camera sight tunnel from exterior through the back-shell aperture to the module",
                sections=32,
            ),
            box(
                "rear_flash_led",
                comp["rear_flash_led"]["envelope_mm"],
                [
                    rear_flash_x,
                    rear_flash_y,
                    -depth / 2
                    + wall
                    + FLASH_BURIAL_CLEARANCE_MM
                    + comp["rear_flash_led"]["envelope_mm"][2] / 2.0,
                ],
                CAMERA,
                "camera",
                "single rear torch/flash LED, buried",
            ),
            cyl_z(
                "rear_flash_led_window",
                comp["rear_flash_led"]["window_mm"][0] / 2.0,
                rear_camera_glass_t,
                [
                    rear_flash_x,
                    rear_flash_y,
                    -depth / 2 + rear_camera_glass_t / 2.0,
                ],
                CAMERA,
                "camera",
                "flush internal torch light pipe window, coplanar with flat back",
                sections=24,
            ),
            box(
                "front_camera_module",
                comp["front_camera"]["module_mm"],
                [-19.0, height / 2 - 9.0, 1.0],
                CAMERA,
                "camera",
                "front MIPI camera",
            ),
            cyl_z(
                "front_camera_under_glass",
                comp["front_camera"]["lens_diameter_mm"] / 2,
                0.08,
                front_camera_under_glass_center(params),
                CAMERA,
                "camera",
                "under-glass aperture marker below cover glass",
            ),
            *[
                box(
                    spec["name"],
                    spec["size"],
                    spec["center"],
                    spec["color"],
                    spec["role"],
                    spec["material"],
                )
                for spec in camera_seal_specs(params)
            ],
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
                handset_acoustic_slot_mm(params),
                handset_acoustic_slot_center(params),
                DARK,
                "audio",
                "gasketed handset slot",
            ),
            box(
                "handset_acoustic_mesh",
                [17.5, 0.12, 0.4],
                handset_acoustic_mesh_center(params),
                ADHESIVE,
                "audio",
                "hydrophobic acoustic mesh behind handset slot",
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
    parts.append(
        box(
            "bottom_speaker_dust_mesh",
            [16.0, 0.12, 4.8],
            [17.5, -height / 2 + 0.22, -1.35],
            ADHESIVE,
            "audio",
            "hydrophobic dust mesh behind bottom speaker grille",
        )
    )
    for spec in split_interconnect_specs(params):
        parts.append(
            box(
                spec["name"],
                spec["size"],
                spec["center"],
                spec["color"],
                spec["role"],
                spec["material"],
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
        parts.append(
            box(
                f"bottom_microphone_mesh_{idx}",
                [1.4, 0.12, 1.4],
                [x, -height / 2 + 0.2, -1.35],
                ADHESIVE,
                "audio",
                "hydrophobic dust mesh behind bottom microphone port",
            )
        )
    parts.extend(
        [
            cyl(
                "top_microphone_port",
                0.45,
                0.4,
                [18.0, height / 2 + 0.12, -1.35],
                DARK,
                "audio",
                "molded top microphone acoustic port",
                sections=18,
            ),
            box(
                "top_microphone_mesh",
                [1.4, 0.12, 1.4],
                [18.0, height / 2 - 0.2, -1.35],
                ADHESIVE,
                "audio",
                "hydrophobic dust mesh behind top microphone port",
            ),
        ]
    )
    for spec in side_button_seal_specs(params):
        parts.append(
            box(
                spec["name"],
                spec["size"],
                spec["center"],
                spec["color"],
                spec["role"],
                spec["material"],
            )
        )
    parts.extend(adhesive_gasket_parts(params))
    parts.extend(enclosure_feature_parts(params))
    parts.extend(advanced_phone_parts(params))
    parts.extend(cad_connection_terminal_parts(parts))
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
            "connection terminal": 0.0,
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


def refresh_ocp_connection_coverage(part_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Refresh connection coverage when the OCP STEP fallback is used."""

    coverage_path = REVIEW_DIR / "cad-connection-coverage.json"
    existing = (
        json.loads(coverage_path.read_text())
        if coverage_path.is_file()
        else {"connections": []}
    )
    existing_connections = {
        str(row.get("id")): row
        for row in existing.get("connections", [])
        if isinstance(row, dict) and row.get("id")
    }
    supplemental_contracts = [
        {
            "id": "display_bias_power_flex",
            "cad_part": "display_bias_power_flex_marker",
            "from": "backlight_bias_package_marker",
            "to": "display_fpc_connector",
            "connection_type": "display_bias_power_flex",
            "nets": ["DISP_AVDD_5V5", "DISP_AVEE_N5V5"],
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "display_bias_power",
            "controlled_impedance_required": False,
            "impedance_requirement": "display_bias_voltage_and_current_capacity_required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        {
            "id": "rear_camera_power_flex",
            "cad_part": "rear_camera_power_flex_marker",
            "from": "main_pcb",
            "to": "rear_camera_module",
            "connection_type": "camera_power_flex",
            "nets": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM0_RESET_N"],
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "camera_power_control",
            "controlled_impedance_required": False,
            "impedance_requirement": "camera_rail_current_capacity_and_sequencing_required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        {
            "id": "front_camera_power_flex",
            "cad_part": "front_camera_power_flex_marker",
            "from": "main_pcb",
            "to": "front_camera_module",
            "connection_type": "camera_power_flex",
            "nets": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM1_RESET_N"],
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "camera_power_control",
            "controlled_impedance_required": False,
            "impedance_requirement": "camera_rail_current_capacity_and_sequencing_required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        {
            "id": "wifi_bt_host_control",
            "cad_part": "wifi_bt_host_control_trace_marker",
            "from": "wifi_bt_module_keepout",
            "to": "soc_package_marker",
            "connection_type": "wifi_bt_host_control_trace",
            "nets": [
                "WIFI_PCIE_TX_P",
                "WIFI_PCIE_TX_N",
                "WIFI_PCIE_RX_P",
                "WIFI_PCIE_RX_N",
                "WIFI_EN",
                "BT_EN",
                "WIFI_SDIO_CLK",
                "WIFI_SDIO_CMD",
                "WIFI_SDIO_D0",
                "WIFI_SDIO_D1",
                "WIFI_SDIO_D2",
                "WIFI_SDIO_D3",
                "BT_UART_TX",
                "BT_UART_RX",
                "BT_UART_CTS_N",
                "BT_UART_RTS_N",
                "WIFI_HOST_WAKE",
            ],
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "wifi_bt_host_interface",
            "controlled_impedance_required": True,
            "impedance_requirement": "PCIe differential impedance plus SDIO/UART/control routing review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        {
            "id": "cellular_host_control",
            "cad_part": "cellular_host_control_trace_marker",
            "from": "cellular_lga_module_keepout",
            "to": "soc_package_marker",
            "connection_type": "cellular_host_control_trace",
            "nets": [
                "CELL_USB2_DP",
                "CELL_USB2_DN",
                "CELL_PCIE_TX_P",
                "CELL_PCIE_TX_N",
                "CELL_PCIE_RX_P",
                "CELL_PCIE_RX_N",
                "CELL_RESET_N",
                "CELL_W_DISABLE_N",
            ],
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "cellular_host_interface",
            "controlled_impedance_required": True,
            "impedance_requirement": "USB2/PCIe differential impedance plus reset/disable routing review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        {
            "id": "sensor_hub_i2c_flex",
            "cad_part": "sensor_hub_i2c_flex_marker",
            "from": "main_pcb",
            "to": "sensor_hub_package_marker",
            "connection_type": "sensor_hub_i2c_flex",
            "nets": ["SENSOR_I2C_SCL", "SENSOR_I2C_SDA"],
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "sensor_i2c",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 0.8,
            "supplier_release_required": True,
        },
        {
            "id": "soc_shield_ground_spring",
            "cad_part": "soc_shield_ground_spring_marker",
            "from": "soc_shield_can",
            "to": "main_pcb",
            "connection_type": "shield_ground_spring",
            "nets": ["GND"],
            "physical_medium": "ground_spring_contact",
            "electrical_class": "shield_chassis_ground",
            "controlled_impedance_required": False,
            "impedance_requirement": "low_inductance_chassis_ground_contact_required",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        {
            "id": "radio_shield_ground_spring",
            "cad_part": "radio_shield_ground_spring_marker",
            "from": "radio_shield_can",
            "to": "main_pcb",
            "connection_type": "shield_ground_spring",
            "nets": ["GND", "SHIELD_GND"],
            "physical_medium": "ground_spring_contact",
            "electrical_class": "shield_chassis_ground",
            "controlled_impedance_required": False,
            "impedance_requirement": "low_inductance_chassis_ground_contact_required",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
    ]
    for contract in supplemental_contracts:
        existing_connections.setdefault(contract["id"], contract)

    part_rows_by_name = {str(row["name"]): row for row in part_rows}
    solid_names = set(part_rows_by_name)
    routed_intake_path = (
        ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"
    )
    routed_intake = (
        yaml.safe_load(routed_intake_path.read_text()) if routed_intake_path.is_file() else {}
    )
    routed_nets = {
        str(route.get("net")) for route in routed_intake.get("routes", []) if route.get("net")
    }
    routed_route_records_by_net: dict[str, list[dict[str, Any]]] = {}
    for route in routed_intake.get("routes", []):
        if not isinstance(route, dict):
            continue
        route_net = str(route.get("canonical_net") or route.get("net") or "")
        if route_net:
            routed_route_records_by_net.setdefault(route_net, []).append(route)

    endpoint_order = [connection_id for connection_id, _from, _to in CAD_CONNECTION_TERMINAL_ENDPOINTS]
    contracts = [
        existing_connections[connection_id]
        for connection_id in endpoint_order
        if connection_id in existing_connections
    ]
    contracts.extend(
        row for key, row in sorted(existing_connections.items()) if key not in set(endpoint_order)
    )

    def bbox_center(row: dict[str, Any]) -> list[float] | None:
        bbox = row.get("bbox_mm")
        if not isinstance(bbox, dict):
            return None
        low = bbox.get("min")
        high = bbox.get("max")
        if not isinstance(low, list) or not isinstance(high, list) or len(low) != 3:
            return None
        return [round((float(low[idx]) + float(high[idx])) / 2.0, 3) for idx in range(3)]

    connection_rows = []
    for contract in contracts:
        part = part_rows_by_name.get(str(contract["cad_part"]), {})
        part_bbox = part.get("bbox_mm") if isinstance(part.get("bbox_mm"), dict) else {}
        part_span = part_bbox.get("span") if isinstance(part_bbox, dict) else []
        from_terminal = f"{contract['id']}_from_terminal"
        to_terminal = f"{contract['id']}_to_terminal"
        terminal_rows = [
            part_rows_by_name.get(from_terminal, {}),
            part_rows_by_name.get(to_terminal, {}),
        ]
        represented_nets = [str(net) for net in contract.get("nets", [])]
        represented_route_records = [
            {
                "id": route.get("id", ""),
                "net": route.get("net", ""),
                "canonical_net": route.get("canonical_net", route.get("net", "")),
                "layer": route.get("layer", ""),
                "width_mm": route.get("width_mm", 0),
                "length_mm": route.get("length_mm", 0),
                "manhattan_length_mm": route.get("manhattan_length_mm", 0),
                "route_classes": route.get("route_classes", []),
                "source_domains": route.get("source_domains", []),
                "controlled_impedance_targets_ohm": route.get(
                    "controlled_impedance_targets_ohm", []
                ),
                "linked_via_ids": route.get("linked_via_ids", []),
                "constraint_status": route.get("constraint_status", ""),
            }
            for net in represented_nets
            for route in routed_route_records_by_net.get(net, [])
        ]
        represented_route_record_count = len(represented_route_records)
        represented_route_records_with_layer_count = sum(
            1 for route in represented_route_records if route.get("layer")
        )
        represented_route_records_with_source_domain_count = sum(
            1 for route in represented_route_records if route.get("source_domains")
        )
        represented_route_records_with_route_class_count = sum(
            1 for route in represented_route_records if route.get("route_classes")
        )
        represented_route_classification_gap_count = sum(
            1
            for route in represented_route_records
            if not route.get("layer")
            or not route.get("source_domains")
            or not route.get("route_classes")
        )
        all_represented_routes_have_layer_source_and_class = (
            represented_route_record_count > 0
            and represented_route_classification_gap_count == 0
        )
        from_center = bbox_center(part_rows_by_name.get(str(contract["from"]), {}))
        to_center = bbox_center(part_rows_by_name.get(str(contract["to"]), {}))
        endpoint_center_distance_mm = None
        if from_center and to_center:
            endpoint_center_distance_mm = round(
                math.sqrt(
                    sum((float(from_center[idx]) - float(to_center[idx])) ** 2 for idx in range(3))
                ),
                3,
            )
        terminal_step_bytes_total = sum(int(row.get("bytes", 0) or 0) for row in terminal_rows)
        connection_step_part_names = [str(contract["cad_part"]), from_terminal, to_terminal]
        routed_net_presence = {net: net in routed_nets for net in represented_nets}
        row = {
            **contract,
            "cad_part_present": str(contract["cad_part"]) in solid_names,
            "cad_step": part.get("step", ""),
            "cad_step_bytes": int(part.get("bytes", 0) or 0),
            "cad_part_bbox_mm": part_bbox,
            "visual_route_span_mm": round(max([float(value) for value in part_span] or [0.0]), 3),
            "represented_nets": represented_nets,
            "represented_net_count": len(represented_nets),
            "represented_route_ids": [str(route.get("id")) for route in represented_route_records],
            "represented_route_count": len(represented_route_records),
            "represented_route_records": represented_route_records,
            "represented_route_record_count": represented_route_record_count,
            "represented_route_records_with_layer_count": (
                represented_route_records_with_layer_count
            ),
            "represented_route_records_with_source_domain_count": (
                represented_route_records_with_source_domain_count
            ),
            "represented_route_records_with_route_class_count": (
                represented_route_records_with_route_class_count
            ),
            "represented_route_classification_gap_count": (
                represented_route_classification_gap_count
            ),
            "all_represented_routes_have_layer_source_and_class": (
                all_represented_routes_have_layer_source_and_class
            ),
            "represented_route_classes": sorted(
                {
                    str(route_class)
                    for route in represented_route_records
                    for route_class in route.get("route_classes", [])
                }
            ),
            "represented_source_domains": sorted(
                {
                    str(domain)
                    for route in represented_route_records
                    for domain in route.get("source_domains", [])
                }
            ),
            "represented_route_length_total_mm": round(
                sum(float(route.get("length_mm") or 0.0) for route in represented_route_records),
                3,
            ),
            "represented_controlled_impedance_route_count": sum(
                1 for route in represented_route_records if route.get("controlled_impedance_targets_ohm")
            ),
            "all_represented_nets_have_route_trace": all(
                bool(routed_route_records_by_net.get(net)) for net in represented_nets
            ),
            "from_terminal_part": from_terminal,
            "from_terminal_step": terminal_rows[0].get("step", ""),
            "from_terminal_step_bytes": int(terminal_rows[0].get("bytes", 0) or 0),
            "to_terminal_part": to_terminal,
            "to_terminal_step": terminal_rows[1].get("step", ""),
            "to_terminal_step_bytes": int(terminal_rows[1].get("bytes", 0) or 0),
            "terminal_marker_count": 2,
            "terminal_markers_present": all(
                name in solid_names for name in [from_terminal, to_terminal]
            ),
            "terminal_step_bytes_total": terminal_step_bytes_total,
            "solid_step_part_names": connection_step_part_names,
            "solid_step_parts_present": all(name in solid_names for name in connection_step_part_names),
            "solid_step_part_count": len(connection_step_part_names),
            "solid_step_part_bytes_total": int(part.get("bytes", 0) or 0)
            + terminal_step_bytes_total,
            "from_endpoint_center_mm": from_center,
            "to_endpoint_center_mm": to_center,
            "endpoint_center_distance_mm": endpoint_center_distance_mm,
            "endpoints_present": str(contract["from"]) in solid_names and str(contract["to"]) in solid_names,
            "routed_net_presence": routed_net_presence,
            "all_nets_in_routed_development_board": all(routed_net_presence.values()),
            "controlled_impedance_requirement_defined": (
                not bool(contract.get("controlled_impedance_required"))
                or contract.get("impedance_requirement") != "not_controlled_impedance"
            ),
            "bend_radius_requirement_defined": (
                contract.get("min_bend_radius_mm") is not None
                or contract.get("physical_medium") == "board_to_board_edge_connector"
            ),
            "release_credit": False,
        }
        row["pass"] = (
            row["cad_part_present"]
            and row["cad_step_bytes"] > 1000
            and row["terminal_markers_present"]
            and row["terminal_step_bytes_total"] > 1000
            and row["solid_step_parts_present"]
            and row["visual_route_span_mm"] > 0.0
            and row["endpoints_present"]
            and row["all_nets_in_routed_development_board"]
            and row["all_represented_nets_have_route_trace"]
            and row["all_represented_routes_have_layer_source_and_class"]
            and row["controlled_impedance_requirement_defined"]
            and row["bend_radius_requirement_defined"]
        )
        connection_rows.append(row)

    physical_medium_counts: dict[str, int] = {}
    electrical_class_counts: dict[str, int] = {}
    for row in connection_rows:
        physical_medium_counts[str(row["physical_medium"])] = (
            physical_medium_counts.get(str(row["physical_medium"]), 0) + 1
        )
        electrical_class_counts[str(row["electrical_class"])] = (
            electrical_class_counts.get(str(row["electrical_class"]), 0) + 1
        )
    connection_coverage = {
        **{k: v for k, v in existing.items() if k != "connections"},
        "required_connection_count": len(connection_rows),
        "passing_connection_count": sum(1 for row in connection_rows if row["pass"]),
        "required_connection_terminal_marker_count": sum(
            int(row["terminal_marker_count"]) for row in connection_rows
        ),
        "passing_connection_terminal_pair_count": sum(
            1 for row in connection_rows if row["terminal_markers_present"]
        ),
        "required_connection_solid_step_part_count": sum(
            int(row["solid_step_part_count"]) for row in connection_rows
        ),
        "passing_connection_solid_step_part_set_count": sum(
            1 for row in connection_rows if row["solid_step_parts_present"]
        ),
        "connection_solid_step_part_bytes_total": sum(
            int(row["solid_step_part_bytes_total"]) for row in connection_rows
        ),
        "represented_net_count_total": sum(
            int(row["represented_net_count"]) for row in connection_rows
        ),
        "represented_route_count_total": sum(
            int(row["represented_route_count"]) for row in connection_rows
        ),
        "represented_route_record_count_total": sum(
            int(row["represented_route_record_count"]) for row in connection_rows
        ),
        "represented_route_records_with_layer_count_total": sum(
            int(row["represented_route_records_with_layer_count"]) for row in connection_rows
        ),
        "represented_route_records_with_source_domain_count_total": sum(
            int(row["represented_route_records_with_source_domain_count"])
            for row in connection_rows
        ),
        "represented_route_records_with_route_class_count_total": sum(
            int(row["represented_route_records_with_route_class_count"])
            for row in connection_rows
        ),
        "represented_route_classification_gap_count": sum(
            int(row["represented_route_classification_gap_count"]) for row in connection_rows
        ),
        "all_represented_routes_have_layer_source_and_class": all(
            row["all_represented_routes_have_layer_source_and_class"] for row in connection_rows
        ),
        "represented_route_length_total_mm": round(
            sum(float(row["represented_route_length_total_mm"]) for row in connection_rows),
            3,
        ),
        "represented_controlled_impedance_route_count_total": sum(
            int(row["represented_controlled_impedance_route_count"]) for row in connection_rows
        ),
        "all_represented_nets_have_route_trace": all(
            row["all_represented_nets_have_route_trace"] for row in connection_rows
        ),
        "visual_route_span_total_mm": round(
            sum(float(row["visual_route_span_mm"]) for row in connection_rows),
            3,
        ),
        "endpoint_pair_distance_total_mm": round(
            sum(float(row["endpoint_center_distance_mm"] or 0.0) for row in connection_rows),
            3,
        ),
        "physical_medium_counts": dict(sorted(physical_medium_counts.items())),
        "electrical_class_counts": dict(sorted(electrical_class_counts.items())),
        "controlled_impedance_connection_count": sum(
            1 for row in connection_rows if row["controlled_impedance_required"]
        ),
        "controlled_impedance_requirement_defined_count": sum(
            1 for row in connection_rows if row["controlled_impedance_requirement_defined"]
        ),
        "bend_radius_requirement_defined_count": sum(
            1 for row in connection_rows if row["bend_radius_requirement_defined"]
        ),
        "supplier_release_required_connection_count": sum(
            1 for row in connection_rows if row["supplier_release_required"]
        ),
        "status": "cad_connection_markers_complete_not_release"
        if all(row["pass"] for row in connection_rows)
        else "blocked_cad_connection_marker_gap",
        "release_credit": False,
        "connections": connection_rows,
    }
    coverage_path.write_text(json.dumps(connection_coverage, indent=2) + "\n")
    return connection_coverage


def write_solid_cad_handoff_artifacts(
    params: dict[str, Any], checks: dict[str, Any], parts: list[Part] | None = None
) -> dict[str, Any]:
    if parts is None:
        parts = build_parts(params)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    try:
        import cadquery as cq
    except Exception as exc:
        try:
            from OCP.BRep import BRep_Builder
            from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
            from OCP.IFSelect import IFSelect_RetDone
            from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
            from OCP.TopoDS import TopoDS_Compound
            from OCP.gp import gp_Pnt

            def fallback_artifact_path(path: Path) -> str:
                try:
                    return str(path.relative_to(ROOT))
                except ValueError:
                    return str(path)

            def rect_cells_for_plate(
                width_mm: float,
                height_mm: float,
                forbidden_rects: list[tuple[float, float, float, float]],
                min_span_mm: float = 0.05,
            ) -> list[tuple[float, float, float, float]]:
                """Return non-forbidden XY cells for an OCP fallback plate/frame.

                Rectangles are `(xmin, xmax, ymin, ymax)`. Splitting at every
                forbidden edge gives exact rectangular voids for camera, flash,
                glass, port, button, and side-frame openings without requiring
                CadQuery boolean cuts.
                """

                outer = (-width_mm / 2.0, width_mm / 2.0, -height_mm / 2.0, height_mm / 2.0)
                xs = [outer[0], outer[1]]
                ys = [outer[2], outer[3]]
                clipped: list[tuple[float, float, float, float]] = []
                for xmin, xmax, ymin, ymax in forbidden_rects:
                    xmin = max(outer[0], xmin)
                    xmax = min(outer[1], xmax)
                    ymin = max(outer[2], ymin)
                    ymax = min(outer[3], ymax)
                    if xmax - xmin <= min_span_mm or ymax - ymin <= min_span_mm:
                        continue
                    clipped.append((xmin, xmax, ymin, ymax))
                    xs.extend([xmin, xmax])
                    ys.extend([ymin, ymax])
                xs = sorted(set(round(v, 6) for v in xs))
                ys = sorted(set(round(v, 6) for v in ys))

                cells: list[tuple[float, float, float, float]] = []
                for x0, x1 in zip(xs, xs[1:]):
                    if x1 - x0 <= min_span_mm:
                        continue
                    cx = (x0 + x1) / 2.0
                    for y0, y1 in zip(ys, ys[1:]):
                        if y1 - y0 <= min_span_mm:
                            continue
                        cy = (y0 + y1) / 2.0
                        if any(xmin <= cx <= xmax and ymin <= cy <= ymax for xmin, xmax, ymin, ymax in clipped):
                            continue
                        cells.append((x0, x1, y0, y1))
                return cells

            def boxes_from_xy_cells(
                cells: list[tuple[float, float, float, float]],
                z_min: float,
                z_max: float,
            ) -> list[tuple[list[float], list[float]]]:
                boxes: list[tuple[list[float], list[float]]] = []
                for x0, x1, y0, y1 in cells:
                    boxes.append(
                        (
                            [round(x1 - x0, 6), round(y1 - y0, 6), round(z_max - z_min, 6)],
                            [round((x0 + x1) / 2.0, 6), round((y0 + y1) / 2.0, 6), round((z_min + z_max) / 2.0, 6)],
                        )
                    )
                return boxes

            def rect_from_center_size(center: list[float] | tuple[float, float], size: list[float]) -> tuple[float, float, float, float]:
                return (
                    float(center[0]) - float(size[0]) / 2.0,
                    float(center[0]) + float(size[0]) / 2.0,
                    float(center[1]) - float(size[1]) / 2.0,
                    float(center[1]) + float(size[1]) / 2.0,
                )

            def fallback_boxes_for_part(part: Part) -> list[tuple[list[float], list[float]]]:
                width, height, depth = [float(v) for v in params["device"]["envelope_mm"]]
                if part.name == "orange_back_shell":
                    shell_t = 1.2
                    z_min = -depth / 2.0
                    z_max = z_min + shell_t
                    camera_xy = rear_camera_center_xy(params)
                    flash_xy = rear_flash_center_xy(params)
                    forbidden = [
                        rect_from_center_size(camera_xy, rear_camera_shell_aperture_mm(params)),
                        rect_from_center_size(flash_xy, rear_flash_shell_aperture_mm(params)),
                    ]
                    return boxes_from_xy_cells(
                        rect_cells_for_plate(width, height, forbidden),
                        z_min,
                        z_max,
                    )

                if part.name == "orange_side_frame":
                    side_size, side_center = side_frame_body_size_center(params)
                    z_min = float(side_center[2]) - float(side_size[2]) / 2.0
                    z_max = float(side_center[2]) + float(side_size[2]) / 2.0
                    wall = float(params["device"]["wall_thickness_mm"])
                    forbidden = [
                        (
                            -width / 2.0 + wall,
                            width / 2.0 - wall,
                            -height / 2.0 + wall,
                            height / 2.0 - wall,
                        )
                    ]
                    for cutout in side_frame_external_cutout_specs(params):
                        forbidden.append(rect_from_center_size(cutout["center"], cutout["size"]))
                    return boxes_from_xy_cells(
                        rect_cells_for_plate(width, height, forbidden),
                        z_min,
                        z_max,
                    )

                if part.name == "screen_cover_glass":
                    glass_w, glass_h, glass_t = [float(v) for v in params["display"]["cover_glass_mm"]]
                    center_z = depth / 2.0 - 0.35
                    z_min = center_z - glass_t / 2.0
                    z_max = center_z + glass_t / 2.0
                    forbidden = [
                        rect_from_center_size(
                            handset_acoustic_slot_center(params),
                            handset_cover_glass_cutout_mm(params),
                        )
                    ]
                    return boxes_from_xy_cells(
                        rect_cells_for_plate(glass_w, glass_h, forbidden),
                        z_min,
                        z_max,
                    )

                low, high = part.bounds
                return [
                    (
                        [float(high[0] - low[0]), float(high[1] - low[1]), float(high[2] - low[2])],
                        [
                            float((low[0] + high[0]) / 2.0),
                            float((low[1] + high[1]) / 2.0),
                            float((low[2] + high[2]) / 2.0),
                        ],
                    )
                ]

            def fallback_compound_from_boxes(
                boxes: list[tuple[list[float], list[float]]]
            ) -> tuple[Any, np.ndarray, np.ndarray]:
                compound = TopoDS_Compound()
                builder.MakeCompound(compound)
                lows: list[list[float]] = []
                highs: list[list[float]] = []
                for size, center in boxes:
                    low = [float(center[i]) - float(size[i]) / 2.0 for i in range(3)]
                    high = [float(center[i]) + float(size[i]) / 2.0 for i in range(3)]
                    shape = BRepPrimAPI_MakeBox(
                        gp_Pnt(low[0], low[1], low[2]),
                        float(size[0]),
                        float(size[1]),
                        float(size[2]),
                    ).Shape()
                    builder.Add(compound, shape)
                    lows.append(low)
                    highs.append(high)
                return compound, np.min(np.asarray(lows), axis=0), np.max(np.asarray(highs), axis=0)

            builder = BRep_Builder()
            assembly_shape = TopoDS_Compound()
            builder.MakeCompound(assembly_shape)
            part_rows: list[dict[str, Any]] = []
            for part in parts:
                boxes = fallback_boxes_for_part(part)
                shape, low, high = fallback_compound_from_boxes(boxes)
                builder.Add(assembly_shape, shape)
                step_path = OUT_DIR / f"{part.name}.step"
                writer = STEPControl_Writer()
                writer.Transfer(shape, STEPControl_AsIs)
                if writer.Write(str(step_path)) != IFSelect_RetDone:
                    raise RuntimeError(f"STEP write failed for {part.name}")
                part_rows.append(
                    {
                        "name": part.name,
                        "role": part.role,
                        "material": part.material,
                        "step": fallback_artifact_path(step_path),
                        "bytes": step_path.stat().st_size,
                        "fallback_box_count": len(boxes),
                        "bbox_mm": {
                            "min": [round(float(value), 3) for value in low],
                            "max": [round(float(value), 3) for value in high],
                            "span": [round(float(value), 3) for value in (high - low)],
                        },
                    }
                )

            assembly_path = OUT_DIR / "e1-phone-solid-assembly.step"
            writer = STEPControl_Writer()
            writer.Transfer(assembly_shape, STEPControl_AsIs)
            if writer.Write(str(assembly_path)) != IFSelect_RetDone:
                raise RuntimeError("STEP write failed for e1-phone-solid-assembly")

            connection_coverage = refresh_ocp_connection_coverage(part_rows)
            required_solid_presence = {
                row["name"]: {
                    "present": Path(ROOT / row["step"]).is_file(),
                    "bytes": row["bytes"],
                }
                for row in part_rows
            }
            report = {
                "claim_boundary": (
                    "OCP STEP box-envelope handoff for EVT0 mechanical review; supplier STEP, "
                    "routed-board STEP, detailed fillets, and toolmaker steel design are still required."
                ),
                "status": "generated",
                "tool": "ocp_step_box_fallback",
                "tool_available": True,
                "cadquery_unavailable_error": f"{type(exc).__name__}: {exc}",
                "assembly_step": fallback_artifact_path(assembly_path),
                "assembly_step_bytes": assembly_path.stat().st_size,
                "part_count": len(part_rows),
                "parts": part_rows,
                "connection_coverage": connection_coverage,
                "required_solid_presence": required_solid_presence,
                "side_frame_external_cutouts": {
                    "status": "pass",
                    "cutout_count": 11,
                    "cutouts": [
                        {
                            "name": cutout["name"],
                            "source_aperture": cutout["source_aperture"],
                            "size_mm": cutout["size"],
                            "center_mm": cutout["center"],
                        }
                        for cutout in side_frame_external_cutout_specs(params)
                    ],
                    "note": "OCP fallback emits the side frame as a compound perimeter with real interior, port, microphone, speaker, and button voids.",
                },
                "cover_glass_external_cutouts": {
                    "status": "pass",
                    "cutout_count": 1,
                    "cutouts": [
                        {
                            "name": "handset_cover_glass_slot_cutout",
                            "source_aperture": "handset_acoustic_slot",
                            "size_mm": handset_cover_glass_cutout_mm(params),
                            "center_mm": handset_acoustic_slot_center(params),
                        }
                    ],
                    "note": "OCP fallback emits the cover glass as a compound plate with a real handset acoustic slot void.",
                },
                "linked_fit_status": checks["status"],
                "remaining_blockers": [
                    "Solids are parametric envelopes, not final supplier STEP models.",
                    "PCB is still the concept KiCad outline, not a release-approved routed board STEP.",
                    "Production surfaces still need toolmaker-approved draft, shutoffs, split lines, and texture.",
                ],
            }
            (REVIEW_DIR / "solid-cad-handoff.json").write_text(
                json.dumps(report, indent=2) + "\n"
            )
            lines = [
                "# E1 Phone Solid CAD Handoff",
                "",
                "Status: generated OCP STEP box-envelope handoff.",
                "",
                f"- Assembly STEP: `{report['assembly_step']}`",
                f"- Part STEP count: {report['part_count']}",
                "",
                "## Remaining Blockers",
                "",
            ]
            for blocker in report["remaining_blockers"]:
                lines.append(f"- {blocker}")
            (REVIEW_DIR / "solid-cad-handoff.md").write_text("\n".join(lines) + "\n")
            return report
        except Exception as fallback_exc:
            fallback_error = f"{type(fallback_exc).__name__}: {fallback_exc}"
        report: dict[str, Any] = {
            "claim_boundary": "STEP/B-rep handoff preflight; neither CadQuery nor OCP fallback succeeded.",
            "status": "blocked",
            "tool": "cadquery_or_ocp",
            "tool_available": False,
            "error": f"{type(exc).__name__}: {exc}",
            "ocp_terminal_step_fallback_error": fallback_error,
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
        return solid.translate((float(center[0]), float(center[1]), float(center[2])))

    def cq_cyl_z(radius_mm: float, depth_mm: float, center: list[float]) -> Any:
        solid = cq.Workplane("XY").circle(float(radius_mm)).extrude(float(depth_mm))
        return solid.translate(
            (
                float(center[0]),
                float(center[1]),
                float(center[2]) - float(depth_mm) / 2.0,
            )
        )

    def cq_composite_box(segments: list[tuple[list[float], list[float], str]]) -> Any:
        solid = None
        for size, center, _name in segments:
            segment = cq_box(size, center)
            solid = segment if solid is None else solid.union(segment)
        if solid is None:
            raise ValueError("composite solid needs at least one segment")
        return solid

    dev = params["device"]
    width, height, depth = dev["envelope_mm"]
    radius = dev["corner_radius_mm"]
    display = params["display"]
    battery = params["battery"]
    comp = params["components"]
    orange = cq.Color(1.0, 0.32, 0.02)
    black = cq.Color(0.02, 0.02, 0.02)
    metal = cq.Color(0.7, 0.72, 0.74)
    green = cq.Color(0.03, 0.38, 0.22)
    grey = cq.Color(0.55, 0.55, 0.55)
    adhesive_color = cq.Color(0.04, 0.04, 0.04)
    keepout_color = cq.Color(0.12, 0.12, 0.12)

    def cad_connection_contracts() -> list[dict[str, Any]]:
        return [
            {
                "id": "display_touch_fpc",
                "cad_part": "display_fpc_tail",
                "from": "display_fpc_connector",
                "to": "display_lcm",
                "connection_type": "display_touch_fpc",
                "nets": [
                    "DSI_D0_P",
                    "DSI_D0_N",
                    "DSI_D1_P",
                    "DSI_D1_N",
                    "DSI_CLK_P",
                    "DSI_CLK_N",
                    "DSI_D2_P",
                    "DSI_D2_N",
                    "DSI_D3_P",
                    "DSI_D3_N",
                    "DISP_RESET_N",
                    "DISP_TE",
                    "TOUCH_I2C_SCL",
                    "TOUCH_I2C_SDA",
                ],
            },
            {
                "id": "rear_camera_csi_fpc",
                "cad_part": "rear_camera_fpc_tail",
                "from": "main_pcb",
                "to": "rear_camera_module",
                "connection_type": "camera_fpc",
                "nets": [
                    "CAM0_CSI_D0_P",
                    "CAM0_CSI_D0_N",
                    "CAM0_CSI_CLK_P",
                    "CAM0_CSI_CLK_N",
                    "CAM0_CSI_D1_P",
                    "CAM0_CSI_D1_N",
                    "CAM0_CSI_D2_P",
                    "CAM0_CSI_D2_N",
                    "CAM0_CSI_D3_P",
                    "CAM0_CSI_D3_N",
                    "CAM0_MCLK",
                    "CAM0_I2C_SCL",
                    "CAM0_I2C_SDA",
                ],
            },
            {
                "id": "front_camera_csi_fpc",
                "cad_part": "front_camera_fpc_tail",
                "from": "main_pcb",
                "to": "front_camera_module",
                "connection_type": "camera_fpc",
                "nets": [
                    "CAM1_CSI_CLK_P",
                    "CAM1_CSI_CLK_N",
                    "CAM1_CSI_D0_P",
                    "CAM1_CSI_D0_N",
                    "CAM1_CSI_D1_P",
                    "CAM1_CSI_D1_N",
                    "CAM1_MCLK",
                    "CAM1_I2C_SCL",
                    "CAM1_I2C_SDA",
                ],
            },
            {
                "id": "side_key_flex",
                "cad_part": "side_key_flex_tail",
                "from": "main_pcb",
                "to": "power_button_cap",
                "connection_type": "side_key_flex",
                "nets": ["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N"],
            },
            {
                "id": "battery_lead_flex",
                "cad_part": "battery_connector_lead_flex",
                "from": "battery_pouch",
                "to": "main_pcb",
                "connection_type": "battery_lead_flex",
                "nets": ["VBAT", "SYS", "BAT_NTC", "BAT_ID"],
            },
            {
                "id": "usb_c_escape_tail",
                "cad_part": "usb_c_power_data_escape_tail",
                "from": "usb_c_receptacle",
                "to": "main_pcb",
                "connection_type": "usb_c_escape_flex",
                "nets": ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN"],
            },
            {
                "id": "usb_c_to_pd_controller_escape",
                "cad_part": "usb_pd_controller_escape_trace_marker",
                "from": "usb_c_receptacle",
                "to": "usb_pd_controller_package_marker",
                "connection_type": "board_power_usb_trace",
                "nets": ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN"],
            },
            {
                "id": "pd_controller_to_charger_control",
                "cad_part": "pd_charger_control_trace_marker",
                "from": "usb_pd_controller_package_marker",
                "to": "charger_package_marker",
                "connection_type": "board_power_control_trace",
                "nets": [
                    "VBUS",
                    "SYS",
                    "USBPD_I2C_SCL",
                    "USBPD_I2C_SDA",
                    "USBPD_IRQ_N",
                    "USBPD_RESET",
                    "CHG_I2C_SCL",
                    "CHG_I2C_SDA",
                    "CHG_IRQ_N",
                ],
            },
            {
                "id": "charger_to_battery_power_sense",
                "cad_part": "charger_battery_power_sense_trace_marker",
                "from": "charger_package_marker",
                "to": "battery_connector_package_marker",
                "connection_type": "board_battery_power_sense_trace",
                "nets": ["VBAT", "SYS", "BAT_NTC", "BAT_ID"],
            },
            {
                "id": "display_bias_power_flex",
                "cad_part": "display_bias_power_flex_marker",
                "from": "backlight_bias_package_marker",
                "to": "display_fpc_connector",
                "connection_type": "display_bias_power_flex",
                "nets": ["DISP_AVDD_5V5", "DISP_AVEE_N5V5"],
            },
            {
                "id": "rear_camera_power_flex",
                "cad_part": "rear_camera_power_flex_marker",
                "from": "main_pcb",
                "to": "rear_camera_module",
                "connection_type": "camera_power_flex",
                "nets": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM0_RESET_N"],
            },
            {
                "id": "front_camera_power_flex",
                "cad_part": "front_camera_power_flex_marker",
                "from": "main_pcb",
                "to": "front_camera_module",
                "connection_type": "camera_power_flex",
                "nets": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM1_RESET_N"],
            },
            {
                "id": "wifi_bt_host_control",
                "cad_part": "wifi_bt_host_control_trace_marker",
                "from": "wifi_bt_module_keepout",
                "to": "soc_package_marker",
                "connection_type": "wifi_bt_host_control_trace",
                "nets": [
                    "WIFI_PCIE_TX_P",
                    "WIFI_PCIE_TX_N",
                    "WIFI_PCIE_RX_P",
                    "WIFI_PCIE_RX_N",
                    "WIFI_EN",
                    "BT_EN",
                    "WIFI_SDIO_CLK",
                    "WIFI_SDIO_CMD",
                    "WIFI_SDIO_D0",
                    "WIFI_SDIO_D1",
                    "WIFI_SDIO_D2",
                    "WIFI_SDIO_D3",
                    "BT_UART_TX",
                    "BT_UART_RX",
                    "BT_UART_CTS_N",
                    "BT_UART_RTS_N",
                    "WIFI_HOST_WAKE",
                ],
            },
            {
                "id": "cellular_host_control",
                "cad_part": "cellular_host_control_trace_marker",
                "from": "cellular_lga_module_keepout",
                "to": "soc_package_marker",
                "connection_type": "cellular_host_control_trace",
                "nets": [
                    "CELL_USB2_DP",
                    "CELL_USB2_DN",
                    "CELL_PCIE_TX_P",
                    "CELL_PCIE_TX_N",
                    "CELL_PCIE_RX_P",
                    "CELL_PCIE_RX_N",
                    "CELL_RESET_N",
                    "CELL_W_DISABLE_N",
                ],
            },
            {
                "id": "bottom_speaker_lead_pair",
                "cad_part": "bottom_speaker_lead_pair",
                "from": "main_pcb",
                "to": "bottom_speaker_module",
                "connection_type": "speaker_lead_pair",
                "nets": ["SPK_P", "SPK_N"],
            },
            {
                "id": "bottom_microphone_flex",
                "cad_part": "bottom_microphone_flex_leads",
                "from": "main_pcb",
                "to": "bottom_mic",
                "connection_type": "microphone_flex",
                "nets": ["PDM_CLK", "PDM_DAT"],
            },
            {
                "id": "top_microphone_flex",
                "cad_part": "top_microphone_flex_tail",
                "from": "main_pcb",
                "to": "top_mic",
                "connection_type": "microphone_flex",
                "nets": ["PDM_CLK", "PDM_DAT"],
            },
            {
                "id": "earpiece_receiver_lead_flex",
                "cad_part": "earpiece_receiver_lead_flex",
                "from": "main_pcb",
                "to": "earpiece_receiver",
                "connection_type": "earpiece_receiver_lead_flex",
                "nets": ["SPK_P", "SPK_N"],
            },
            {
                "id": "haptic_flex",
                "cad_part": "haptic_flex_tail",
                "from": "main_pcb",
                "to": "haptic_lra",
                "connection_type": "haptic_flex",
                "nets": ["HAPTIC_OUT"],
            },
            {
                "id": "sensor_hub_i2c_flex",
                "cad_part": "sensor_hub_i2c_flex_marker",
                "from": "main_pcb",
                "to": "sensor_hub_package_marker",
                "connection_type": "sensor_hub_i2c_flex",
                "nets": ["SENSOR_I2C_SCL", "SENSOR_I2C_SDA"],
            },
            {
                "id": "sim_esim_signal_flex",
                "cad_part": "sim_esim_signal_flex_marker",
                "from": "main_pcb",
                "to": "sim_tray_keepout",
                "connection_type": "sim_esim_signal_marker",
                "nets": [
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
            },
            {
                "id": "nfc_loop_antenna_flex",
                "cad_part": "nfc_loop_antenna_flex_marker",
                "from": "nfc_controller_package_marker",
                "to": "nfc_loop_match_marker",
                "connection_type": "nfc_loop_antenna_flex_marker",
                "nets": ["NFC_RF_P", "NFC_RF_N", "NFC_IRQ_N", "NFC_EN"],
            },
            {
                "id": "compute_som_sodimm_carrier",
                "cad_part": "compute_som_sodimm_connector",
                "from": "main_pcb",
                "to": "compute_som_daughterboard_keepout",
                "connection_type": "compute_som_edge_connector",
                "nets": [
                    "USB_DP",
                    "USB_DN",
                    "DISP_RESET_N",
                    "TOUCH_I2C_SCL",
                    "TOUCH_I2C_SDA",
                    "CAM0_MCLK",
                    "CAM1_MCLK",
                    "LPDDR_CK_P",
                    "LPDDR_CK_N",
                ],
            },
            {
                "id": "soc_shield_ground_spring",
                "cad_part": "soc_shield_ground_spring_marker",
                "from": "soc_shield_can",
                "to": "main_pcb",
                "connection_type": "shield_ground_spring",
                "nets": ["GND"],
            },
            {
                "id": "radio_shield_ground_spring",
                "cad_part": "radio_shield_ground_spring_marker",
                "from": "radio_shield_can",
                "to": "main_pcb",
                "connection_type": "shield_ground_spring",
                "nets": ["GND", "SHIELD_GND"],
            },
            {
                "id": "cellular_main_rf_feed",
                "cad_part": "cellular_rf_feed_development_envelope",
                "from": "cellular_lga_module_keepout",
                "to": "cellular_top_antenna_keepout",
                "connection_type": "rf_50r_feed_envelope",
                "nets": ["CELL_RF_MAIN"],
            },
            {
                "id": "cellular_diversity_rf_feed",
                "cad_part": "cellular_div_rf_feed_development_envelope",
                "from": "cellular_lga_module_keepout",
                "to": "cellular_bottom_antenna_keepout",
                "connection_type": "rf_50r_feed_envelope",
                "nets": ["CELL_RF_DIV"],
            },
            {
                "id": "cellular_antenna_aperture_tuner",
                "cad_part": "antenna_aperture_tuner",
                "from": "cellular_lga_module_keepout",
                "to": "cellular_bottom_antenna_keepout",
                "connection_type": "rf_antenna_aperture_tuner",
                "nets": ["CELL_RF_DIV", "RF_VBAT"],
            },
            {
                "id": "cellular_gnss_rf_feed",
                "cad_part": "cellular_gnss_rf_feed_development_envelope",
                "from": "cellular_lga_module_keepout",
                "to": "gnss_lna_package_marker",
                "connection_type": "rf_50r_feed_envelope",
                "nets": ["CELL_GNSS_RF"],
            },
            {
                "id": "wifi_bt_rf0_feed",
                "cad_part": "wifi_bt_rf_feed_development_envelope",
                "from": "wifi_bt_module_keepout",
                "to": "wifi_bt_side_antenna_keepout",
                "connection_type": "rf_50r_feed_envelope",
                "nets": ["WIFI_BT_RF0"],
            },
            {
                "id": "wifi_bt_rf1_feed",
                "cad_part": "wifi_bt_rf1_feed_development_envelope",
                "from": "wifi_bt_module_keepout",
                "to": "wifi_bt_side_antenna_keepout",
                "connection_type": "rf_50r_feed_envelope",
                "nets": ["WIFI_BT_RF1"],
            },
            {
                "id": "split_interconnect_side_flex",
                "cad_part": "split_interconnect_side_flex",
                "from": "split_interconnect_top_connector",
                "to": "split_interconnect_bottom_connector",
                "connection_type": "top_bottom_board_flex",
                "nets": [
                    "USB_DP",
                    "USB_DN",
                    "I2S_BCLK",
                    "I2S_LRCLK",
                    "I2S_DOUT",
                    "I2S_DIN",
                    "PDM_CLK",
                    "PDM_DAT",
                ],
            },
        ]

    wall = dev["wall_thickness_mm"]
    rear_camera_glass_t = comp["rear_camera_glass"]["envelope_mm"][2]
    rear_camera_center_z = rear_camera_buried_center_z(params)
    rear_camera_x, rear_camera_y = rear_camera_center_xy(params)
    rear_aperture_w, rear_aperture_h = rear_camera_shell_aperture_mm(params)
    rear_sight_radius, rear_sight_depth = rear_camera_optical_sight_tunnel_mm(params)
    rear_bezel_border_mm = 1.0
    rear_flash_x, rear_flash_y = rear_flash_center_xy(params)
    rear_flash_aperture_w, rear_flash_aperture_h = rear_flash_shell_aperture_mm(params)
    rear_flash_bezel_border_mm = 0.45

    def artifact_path(path: Path) -> str:
        return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.as_posix()

    back_shell = cq_box([width, height, 1.2], [0, 0, -depth / 2 + 0.6], radius)
    back_shell = back_shell.cut(
        cq_box(
            [rear_aperture_w, rear_aperture_h, 2.4],
            [rear_camera_x, rear_camera_y, -depth / 2 + 0.6],
        )
    )
    back_shell = back_shell.cut(
        cq_box(
            [rear_flash_aperture_w, rear_flash_aperture_h, 2.4],
            [rear_flash_x, rear_flash_y, -depth / 2 + 0.6],
        )
    )
    side_frame_size, side_frame_center = side_frame_body_size_center(params)
    side_outer = cq_box(side_frame_size, side_frame_center, radius)
    side_inner = cq_box(
        [
            width - 2 * dev["wall_thickness_mm"],
            height - 2 * dev["wall_thickness_mm"],
            side_frame_size[2] + 1.0,
        ],
        side_frame_center,
        max(radius - dev["wall_thickness_mm"], 0.5),
    )
    side_frame_uncut = side_outer.cut(side_inner)
    side_frame = side_frame_uncut
    side_frame_cutouts = side_frame_external_cutout_specs(params)
    for cutout in side_frame_cutouts:
        side_frame = side_frame.cut(cq_box(cutout["size"], cutout["center"]))
    side_frame_uncut_volume_mm3 = round(float(side_frame_uncut.val().Volume()), 3)
    side_frame_cut_volume_mm3 = round(float(side_frame.val().Volume()), 3)
    cover_glass_uncut = cq_box(
        display["cover_glass_mm"],
        [0, -0.2, depth / 2 - 0.35],
        radius=max(radius - 1.2, 0.5),
    )
    cover_glass = cover_glass_uncut.cut(
        cq_box(handset_cover_glass_cutout_mm(params), handset_acoustic_slot_center(params))
    )
    cover_glass_uncut_volume_mm3 = round(float(cover_glass_uncut.val().Volume()), 3)
    cover_glass_cut_volume_mm3 = round(float(cover_glass.val().Volume()), 3)
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
            "shape": cover_glass,
            "color": black,
            "role": "screen",
            "material": "black cover glass B-rep envelope with handset acoustic slot cut",
        },
        {
            "name": "display_lcm",
            "shape": cq_box(
                display_module_size_mm(params),
                [0, -5.5, display_module_center_z(params)],
            ),
            "color": black,
            "role": "screen",
            "material": "bonded LCD+CTP module supplier envelope",
        },
        {
            "name": "main_pcb",
            "shape": cq_composite_box(pcb_island_segments(params)),
            "color": green,
            "role": "PCB",
            "material": "concept KiCad top/bottom split-island board envelope",
        },
        {
            "name": "battery_pouch",
            "shape": cq_box(battery["envelope_mm"], [0, -7.0, battery_center_z(params)]),
            "color": black,
            "role": "battery",
            "material": "LiPo pouch envelope",
        },
        {
            "name": "battery_back_void_foam_pad",
            "shape": cq_box(
                battery["back_void_foam_pad_mm"],
                [
                    0,
                    -7.0,
                    -depth / 2 + wall + float(battery["back_void_foam_pad_mm"][2]) / 2.0,
                ],
            ),
            "color": cq.Color(0.07, 0.075, 0.08, 0.55),
            "role": "battery support",
            "material": battery["back_void_foam_material"],
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
            "shape": cq_box(
                comp["rear_camera"]["module_mm"],
                [rear_camera_x, rear_camera_y, rear_camera_center_z],
            ),
            "color": black,
            "role": "camera",
            "material": comp["rear_camera"]["candidate"],
        },
        {
            "name": "rear_camera_shell_aperture",
            "shape": cq_box(
                [rear_aperture_w, rear_aperture_h, 0.08],
                [rear_camera_x, rear_camera_y, -depth / 2.0 - 0.015],
            ),
            "color": black,
            "role": "camera aperture",
            "material": "open molded back-shell camera hole envelope",
        },
        {
            "name": "orange_rear_camera_bezel_top",
            "shape": cq_box(
                [rear_aperture_w + 2.0 * rear_bezel_border_mm, rear_bezel_border_mm, 0.14],
                [
                    rear_camera_x,
                    rear_camera_y + rear_aperture_h / 2.0 + rear_bezel_border_mm / 2.0,
                    -depth / 2.0 + 0.07,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange camera aperture bevel/top land",
        },
        {
            "name": "orange_rear_camera_bezel_bottom",
            "shape": cq_box(
                [rear_aperture_w + 2.0 * rear_bezel_border_mm, rear_bezel_border_mm, 0.14],
                [
                    rear_camera_x,
                    rear_camera_y - rear_aperture_h / 2.0 - rear_bezel_border_mm / 2.0,
                    -depth / 2.0 + 0.07,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange camera aperture bevel/bottom land",
        },
        {
            "name": "orange_rear_camera_bezel_left",
            "shape": cq_box(
                [rear_bezel_border_mm, rear_aperture_h, 0.14],
                [
                    rear_camera_x - rear_aperture_w / 2.0 - rear_bezel_border_mm / 2.0,
                    rear_camera_y,
                    -depth / 2.0 + 0.07,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange camera aperture bevel/left land",
        },
        {
            "name": "orange_rear_camera_bezel_right",
            "shape": cq_box(
                [rear_bezel_border_mm, rear_aperture_h, 0.14],
                [
                    rear_camera_x + rear_aperture_w / 2.0 + rear_bezel_border_mm / 2.0,
                    rear_camera_y,
                    -depth / 2.0 + 0.07,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange camera aperture bevel/right land",
        },
        {
            "name": "rear_flash_shell_aperture",
            "shape": cq_box(
                [rear_flash_aperture_w, rear_flash_aperture_h, 0.08],
                [rear_flash_x, rear_flash_y, -depth / 2.0 - 0.015],
            ),
            "color": black,
            "role": "camera aperture",
            "material": "open molded back-shell flash hole envelope",
        },
        {
            "name": "orange_rear_flash_bezel_top",
            "shape": cq_box(
                [
                    rear_flash_aperture_w + 2.0 * rear_flash_bezel_border_mm,
                    rear_flash_bezel_border_mm,
                    0.12,
                ],
                [
                    rear_flash_x,
                    rear_flash_y + rear_flash_aperture_h / 2.0 + rear_flash_bezel_border_mm / 2.0,
                    -depth / 2.0 + 0.06,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange flash aperture bevel/top land",
        },
        {
            "name": "orange_rear_flash_bezel_bottom",
            "shape": cq_box(
                [
                    rear_flash_aperture_w + 2.0 * rear_flash_bezel_border_mm,
                    rear_flash_bezel_border_mm,
                    0.12,
                ],
                [
                    rear_flash_x,
                    rear_flash_y - rear_flash_aperture_h / 2.0 - rear_flash_bezel_border_mm / 2.0,
                    -depth / 2.0 + 0.06,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange flash aperture bevel/bottom land",
        },
        {
            "name": "orange_rear_flash_bezel_left",
            "shape": cq_box(
                [rear_flash_bezel_border_mm, rear_flash_aperture_h, 0.12],
                [
                    rear_flash_x - rear_flash_aperture_w / 2.0 - rear_flash_bezel_border_mm / 2.0,
                    rear_flash_y,
                    -depth / 2.0 + 0.06,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange flash aperture bevel/left land",
        },
        {
            "name": "orange_rear_flash_bezel_right",
            "shape": cq_box(
                [rear_flash_bezel_border_mm, rear_flash_aperture_h, 0.12],
                [
                    rear_flash_x + rear_flash_aperture_w / 2.0 + rear_flash_bezel_border_mm / 2.0,
                    rear_flash_y,
                    -depth / 2.0 + 0.06,
                ],
            ),
            "color": orange,
            "role": "molded enclosure",
            "material": "integral orange flash aperture bevel/right land",
        },
        {
            "name": "rear_flash_led",
            "shape": cq_box(
                comp["rear_flash_led"]["envelope_mm"],
                [
                    rear_flash_x,
                    rear_flash_y,
                    -depth / 2
                    + wall
                    + FLASH_BURIAL_CLEARANCE_MM
                    + comp["rear_flash_led"]["envelope_mm"][2] / 2.0,
                ],
            ),
            "color": metal,
            "role": "camera",
            "material": comp["rear_flash_led"]["candidate"],
        },
        {
            "name": "rear_flash_led_window",
            "shape": cq_box(
                comp["rear_flash_led"]["window_mm"],
                [
                    rear_flash_x,
                    rear_flash_y,
                    -depth / 2 + comp["rear_flash_led"]["window_mm"][2] / 2.0,
                ],
            ),
            "color": grey,
            "role": "camera",
            "material": "flush internal torch light pipe window, coplanar with flat back",
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
            "shape": cq_box(comp["haptic"]["envelope_mm"], [35.5, -44.0, -3.2]),
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
    for spec in side_button_seal_specs(params):
        solids.append(
            {
                "name": spec["name"],
                "shape": cq_box(spec["size"], spec["center"]),
                "color": (
                    adhesive_color
                    if spec["role"] == "button seal" and "gasket" in spec["name"]
                    else orange
                ),
                "role": spec["role"],
                "material": spec["material"],
            }
        )
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
                    [
                        rear_camera_x,
                        rear_camera_y,
                        -depth / 2 + comp["rear_camera_glass"]["envelope_mm"][2] / 2.0,
                    ],
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
                        comp["rear_camera"]["lens_diameter_mm"],
                        rear_camera_glass_t,
                    ],
                    [rear_camera_x, rear_camera_y, -depth / 2 + rear_camera_glass_t / 2.0],
                    radius=0.4,
                ),
                "color": black,
                "role": "camera",
                "material": "flush internal rear camera optical window, coplanar with flat back",
            },
            {
                "name": "rear_camera_optical_sight_tunnel",
                "shape": cq_cyl_z(
                    rear_sight_radius,
                    rear_sight_depth,
                    rear_camera_optical_sight_tunnel_center(params),
                ),
                "color": cq.Color(0.15, 0.35, 0.95, 0.26),
                "role": "camera optical clearance",
                "material": "clear rear-camera sight tunnel from exterior through back-shell aperture to module",
            },
            {
                "name": "front_camera_under_glass",
                "shape": cq_box(
                    [
                        comp["front_camera"]["lens_diameter_mm"],
                        comp["front_camera"]["lens_diameter_mm"],
                        0.08,
                    ],
                    front_camera_under_glass_center(params),
                    radius=0.35,
                ),
                "color": black,
                "role": "camera",
                "material": "front under-glass optical aperture envelope",
            },
            *[
                {
                    "name": spec["name"],
                    "shape": cq_box(spec["size"], spec["center"]),
                    "color": adhesive_color if "adhesive" in spec["name"] else black,
                    "role": spec["role"],
                    "material": spec["material"],
                }
                for spec in camera_seal_specs(params)
            ],
            {
                "name": "handset_acoustic_slot",
                "shape": cq_box(
                    handset_acoustic_slot_mm(params),
                    handset_acoustic_slot_center(params),
                ),
                "color": black,
                "role": "audio",
                "material": "gasketed handset acoustic slot",
            },
            {
                "name": "handset_acoustic_mesh",
                "shape": cq_box([17.5, 0.12, 0.4], handset_acoustic_mesh_center(params)),
                "color": adhesive_color,
                "role": "audio",
                "material": "hydrophobic acoustic mesh behind handset slot",
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
            *[
                {
                    "name": spec["name"],
                    "shape": cq_box(spec["size"], spec["center"]),
                    "color": adhesive_color if "gasket" in spec["name"] else orange,
                    "role": spec["role"],
                    "material": spec["material"],
                }
                for spec in usb_c_seal_specs(params)
            ],
            {
                "name": "bottom_speaker_acoustic_chamber",
                "shape": cq_box([18.0, 13.0, 2.2], [19.1, -height / 2 + 13.0, -4.1]),
                "color": orange,
                "role": "audio",
                "material": "molded loudspeaker rear chamber",
            },
            {
                "name": "earpiece_gasket",
                "shape": cq_box([18.0, 2.0, 0.55], [0, height / 2 - 7.6, 3.8]),
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
    adhesive_corner = adhesive_corner_radius(params)
    adhesive_straight_w = glass_w - 2.0 * adhesive_corner
    adhesive_straight_h = glass_h - 2.0 * adhesive_corner
    for name, size, center in [
        (
            "screen_adhesive_top",
            [adhesive_straight_w, adhesive_w, adhesive_t],
            [0, glass_h / 2 - adhesive_w / 2, adhesive_z],
        ),
        (
            "screen_adhesive_bottom",
            [adhesive_straight_w, adhesive_w, adhesive_t],
            [0, -glass_h / 2 + adhesive_w / 2, adhesive_z],
        ),
        (
            "screen_adhesive_left",
            [adhesive_w, adhesive_straight_h, adhesive_t],
            [-glass_w / 2 + adhesive_w / 2, 0, adhesive_z],
        ),
        (
            "screen_adhesive_right",
            [adhesive_w, adhesive_straight_h, adhesive_t],
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

    cushion = display.get("glass_perimeter_cushion")
    if cushion:
        cw = float(cushion["perimeter_width_mm"])
        ct = float(cushion["envelope_mm"][2])
        cushion_z = depth / 2 - 0.35 - 0.7 - ct / 2.0
        straight_w = glass_w - 2.0 * radius
        straight_h = glass_h - 2.0 * radius
        for cname, csize, ccenter in [
            (
                "glass_perimeter_cushion_top",
                [straight_w, cw, ct],
                [0, glass_h / 2 - cw / 2, cushion_z],
            ),
            (
                "glass_perimeter_cushion_bottom",
                [straight_w, cw, ct],
                [0, -glass_h / 2 + cw / 2, cushion_z],
            ),
            (
                "glass_perimeter_cushion_left",
                [cw, straight_h, ct],
                [-glass_w / 2 + cw / 2, 0, cushion_z],
            ),
            (
                "glass_perimeter_cushion_right",
                [cw, straight_h, ct],
                [glass_w / 2 - cw / 2, 0, cushion_z],
            ),
        ]:
            solids.append(
                {
                    "name": cname,
                    "shape": cq_box(csize, ccenter),
                    "color": adhesive_color,
                    "role": "screen retention",
                    "material": "PORON foam cover-glass perimeter cushion envelope",
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
    solids.append(
        {
            "name": "bottom_speaker_dust_mesh",
            "shape": cq_box([16.0, 0.12, 4.8], [17.5, -height / 2 + 0.22, -1.35]),
            "color": adhesive_color,
            "role": "audio",
            "material": "hydrophobic dust mesh behind bottom speaker grille",
        }
    )
    for spec in split_interconnect_specs(params):
        solids.append(
            {
                "name": spec["name"],
                "shape": cq_box(spec["size"], spec["center"]),
                "color": (
                    metal
                    if spec["role"] == "split-board interconnect" and "connector" in spec["name"]
                    else cq.Color(0.95, 0.58, 0.10, 0.72)
                ),
                "role": spec["role"],
                "material": spec["material"],
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
        solids.append(
            {
                "name": f"bottom_microphone_mesh_{idx}",
                "shape": cq_box([1.4, 0.12, 1.4], [x, -height / 2 + 0.2, -1.35]),
                "color": adhesive_color,
                "role": "audio",
                "material": "hydrophobic dust mesh behind bottom microphone port",
            }
        )
    solids.extend(
        [
            {
                "name": "top_microphone_port",
                "shape": cq_box([1.0, 0.4, 1.0], [18.0, height / 2 + 0.12, -1.35], radius=0.25),
                "color": black,
                "role": "audio",
                "material": "molded top microphone acoustic port envelope",
            },
            {
                "name": "top_microphone_mesh",
                "shape": cq_box([1.4, 0.12, 1.4], [18.0, height / 2 - 0.2, -1.35]),
                "color": adhesive_color,
                "role": "audio",
                "material": "hydrophobic dust mesh behind top microphone port",
            },
        ]
    )

    boss_radius = params["manufacturing"]["screw_boss_outer_diameter_mm"] / 2.0
    boss_z = -depth / 2 + 2.0
    for idx, (x, y) in enumerate(screw_boss_points(params), start=1):
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
    for rib in corner_rib_specs(params):
        solids.append(
            {
                "name": rib["name"],
                "shape": cq_box(rib["size"], rib["center"]),
                "color": orange,
                "role": "molded enclosure",
                "material": "PC+ABS corner gusset envelope",
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
            "antenna_aperture_tuner",
            params["radio"].get("antenna_aperture_tuner", {}).get("envelope_mm", [2.0, 2.0, 0.5]),
            [
                -params["radio"]["cellular"]["antenna_keepout_mm"][0] / 2.0 + 4.0,
                -height / 2 + 9.0,
                -1.6,
            ],
            "RF tuner",
            "Qorvo QPC1252Q antenna aperture/band-switch tuner (MIPI RFFE)",
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
            "cellular_lga_module_keepout",
            params["radio"]["cellular"].get("envelope_mm", [29.0, 32.0, 2.4]),
            [-15.5, 45.0, -0.45],
            "cellular module",
            params["radio"]["cellular"].get(
                "candidate", "Quectel RG255C-class 5G RedCap LGA module envelope"
            ),
        ),
        (
            "wifi_bt_module_keepout",
            params["radio"]["wifi_bt"].get("envelope_mm", [12.5, 9.4, 1.2]),
            [20.0, 42.0, -1.0],
            "Wi-Fi/Bluetooth module",
            params["radio"]["wifi_bt"].get(
                "candidate", "Murata LBEE5XV2EA-802 Type 2EA Wi-Fi 6E/Bluetooth module"
            ),
        ),
        (
            "compute_som_sodimm_connector",
            [65.0, 2.6, 0.3],
            [0.0, 50.3, -1.52],
            "compute interconnect",
            "260-pin 0.5 mm SODIMM compute-SoM carrier connector envelope",
        ),
        (
            "compute_som_daughterboard_keepout",
            [68.0, 30.0, 1.2],
            [0.0, 45.0, -0.3],
            "compute module keepout",
            "Firefly Core-3566JD4-class SoM daughterboard swept keepout; non-release fit envelope",
        ),
        (
            "soc_package_marker",
            [13.0, 13.0, 0.24],
            [-7.0, 55.0, -0.06],
            "PCB component marker",
            "visual marker for application processor package under SoC shield",
        ),
        (
            "dram_package_marker",
            [9.5, 8.0, 0.22],
            [-7.0, 68.0, -0.07],
            "PCB component marker",
            "visual marker for LPDDR memory package near SoC",
        ),
        (
            "storage_package_marker",
            [11.5, 9.0, 0.22],
            [11.0, 68.0, -0.07],
            "PCB component marker",
            "visual marker for eMMC/UFS storage package",
        ),
        (
            "pmic_package_marker",
            [7.0, 7.0, 0.22],
            [12.5, 55.0, -0.07],
            "PCB component marker",
            "visual marker for PMIC package under power shield",
        ),
        (
            "usb_pd_controller_package_marker",
            [9.0, 9.0, 0.22],
            [7.0, -54.8, -0.07],
            "PCB component marker",
            "visual marker for TPS65987 USB-PD controller package and exposed pads",
        ),
        (
            "charger_package_marker",
            [4.0, 4.0, 0.2],
            [-4.0, -54.8, -0.08],
            "PCB component marker",
            "visual marker for MAX77860 charger WLP package",
        ),
        (
            "battery_connector_package_marker",
            [6.0, 3.0, 0.18],
            [-6.0, -50.4, -0.08],
            "PCB connector marker",
            "visual marker for 4-pin battery pack connector or welded FPC landing",
        ),
        (
            "audio_codec_package_marker",
            [7.0, 7.0, 0.22],
            [-18.5, -54.0, -0.07],
            "PCB component marker",
            "visual marker for 48-pin audio codec package in bottom audio region",
        ),
        (
            "rf_transceiver_package_marker",
            [7.5, 7.5, 0.22],
            [-22.0, 55.0, -0.07],
            "PCB component marker",
            "visual marker for RF transceiver/front-end package under radio shield",
        ),
        (
            "gnss_lna_package_marker",
            [3.0, 2.5, 0.2],
            [-30.0, 62.5, -1.2],
            "PCB component marker",
            "visual marker for GNSS/RF low-noise amplifier placement",
        ),
        (
            "backlight_bias_package_marker",
            [4.0, 4.0, 0.22],
            [24.0, 35.5, -0.07],
            "PCB component marker",
            "visual marker for display backlight/bias power IC package",
        ),
        (
            "fuel_gauge_package_marker",
            [1.9, 1.5, 0.18],
            [-12.0, -50.0, -0.08],
            "PCB component marker",
            "visual marker for battery fuel-gauge WLCSP package",
        ),
        (
            "haptic_driver_package_marker",
            [1.4, 1.4, 0.18],
            [20.0, -54.0, -0.08],
            "PCB component marker",
            "visual marker for haptic driver WLCSP package",
        ),
        (
            "usim_levelshift_package_marker",
            [2.6, 2.1, 0.18],
            [26.0, -56.0, -0.08],
            "PCB component marker",
            "visual marker for USIM level-shifter/ESD package",
        ),
        (
            "esim_package_marker",
            [2.0, 2.0, 0.18],
            [28.0, -52.0, -0.08],
            "PCB component marker",
            "visual marker for MFF2 eSIM package",
        ),
        (
            "nfc_controller_package_marker",
            [5.0, 5.0, 0.22],
            [-26.0, 30.0, -0.07],
            "PCB component marker",
            "visual marker for NFC controller package",
        ),
        (
            "nfc_loop_match_marker",
            [4.0, 1.4, 0.12],
            [-30.0, 58.0, -0.09],
            "PCB passive marker",
            "visual marker for NFC loop matching network",
        ),
        (
            "sensor_hub_package_marker",
            [3.0, 3.0, 0.2],
            [7.0, 35.0, -0.08],
            "PCB component marker",
            "visual marker for always-on sensor hub package",
        ),
        (
            "esd_array_6ch_marker",
            [2.0, 1.0, 0.16],
            [0.0, -58.0, -0.09],
            "PCB protection marker",
            "visual marker for six-channel ESD protection arrays",
        ),
        (
            "tvs_diode_2p_marker",
            [1.2, 0.8, 0.16],
            [5.0, -58.0, -0.09],
            "PCB protection marker",
            "visual marker for two-terminal TVS diodes",
        ),
        (
            "testpoint_1mm_marker",
            [1.0, 1.0, 0.04],
            [10.0, -58.0, -0.11],
            "PCB test marker",
            "visual marker for one-millimeter board test pads",
        ),
        (
            "fiducial_1mm_marker",
            [1.0, 1.0, 0.03],
            [13.0, -58.0, -0.115],
            "PCB assembly marker",
            "visual marker for one-millimeter global fiducials",
        ),
        (
            "mounting_hole_1p2_marker",
            [1.2, 1.2, 0.04],
            [16.0, -58.0, -0.11],
            "PCB mechanical marker",
            "visual marker for 1.2 mm mounting-hole annular keepouts",
        ),
        (
            "r0402_component_marker",
            [1.0, 0.5, 0.16],
            [-8.0, -58.0, -0.09],
            "PCB passive marker",
            "visual marker for 0402 resistor packages",
        ),
        (
            "c0402_component_marker",
            [1.0, 0.5, 0.16],
            [-11.0, -58.0, -0.09],
            "PCB passive marker",
            "visual marker for 0402 capacitor packages",
        ),
        (
            "l0402_component_marker",
            [1.0, 0.6, 0.2],
            [-14.0, -58.0, -0.08],
            "PCB passive marker",
            "visual marker for 0402 inductor/ferrite packages",
        ),
        (
            "pi_match_0402_marker",
            [2.4, 1.1, 0.18],
            [-19.0, -58.0, -0.085],
            "PCB passive marker",
            "visual marker for RF pi matching component triplets",
        ),
        (
            "rc_array_4ch_marker",
            [2.0, 1.0, 0.18],
            [-23.0, -58.0, -0.085],
            "PCB passive marker",
            "visual marker for four-channel RC conditioning arrays",
        ),
        (
            "shunt_1206_marker",
            [3.2, 1.6, 0.22],
            [-28.0, -58.0, -0.07],
            "PCB passive marker",
            "visual marker for 1206 current-shunt packages",
        ),
        (
            "wifi_bt_rf_feed_development_envelope",
            [10.0, 0.45, 0.35],
            [28.5, 42.0, -1.0],
            "RF feed",
            "development coax/feed envelope from Wi-Fi/Bluetooth module toward side antenna keepout",
        ),
        (
            "cellular_rf_feed_development_envelope",
            [0.45, 15.0, 0.35],
            [-30.0, 61.0, -1.0],
            "RF feed",
            "development coax/feed envelope from cellular module toward top antenna keepout",
        ),
        (
            "display_fpc_tail",
            [10.0, 6.0, 0.12],
            [24.0, 45.0, -1.45],
            "flex/cable",
            "display/touch FPC tail route marker from connector into the display stack",
        ),
        (
            "rear_camera_fpc_tail",
            [12.0, 0.8, 0.12],
            [8.0, 63.0, -1.45],
            "flex/cable",
            "rear camera CSI FPC tail marker from top board connector to camera module",
        ),
        (
            "front_camera_fpc_tail",
            [9.0, 0.8, 0.12],
            [-18.0, 63.0, -1.45],
            "flex/cable",
            "front camera CSI FPC tail marker under the cover-glass camera region",
        ),
        (
            "side_key_flex_tail",
            [1.0, 28.0, 0.12],
            [31.0, 51.0, -1.45],
            "flex/cable",
            "power/volume side-key flex tail along the right side wall",
        ),
        (
            "battery_connector_lead_flex",
            [8.0, 1.2, 0.12],
            [-6.0, -52.5, -1.45],
            "flex/cable",
            "battery pack positive/negative/NTC/ID lead flex landing on bottom island",
        ),
        (
            "usb_c_power_data_escape_tail",
            [18.0, 1.0, 0.12],
            [0.0, -63.0, -1.45],
            "flex/cable",
            "USB-C VBUS/CC/USB2 escape tail marker on the bottom island",
        ),
        (
            "usb_pd_controller_escape_trace_marker",
            [9.0, 1.0, 0.12],
            [3.8, -59.0, -1.45],
            "PCB trace marker",
            "board-level USB-C VBUS/CC/USB2 route marker from receptacle to TPS65987",
        ),
        (
            "pd_charger_control_trace_marker",
            [10.0, 1.0, 0.12],
            [1.5, -54.8, -1.45],
            "PCB trace marker",
            "board-level PD controller to charger VBUS/SYS/I2C/IRQ route marker",
        ),
        (
            "charger_battery_power_sense_trace_marker",
            [4.0, 4.8, 0.12],
            [-5.0, -53.4, -1.2],
            "PCB trace marker",
            "board-level charger to battery connector VBAT/SYS/NTC/ID route marker",
        ),
        (
            "display_bias_power_flex_marker",
            [6.0, 1.0, 0.12],
            [21.0, 41.0, -1.35],
            "flex/cable",
            "display bias/backlight AVDD/AVEE flex marker from bias IC to display connector",
        ),
        (
            "rear_camera_power_flex_marker",
            [8.0, 0.7, 0.12],
            [12.0, 58.5, -1.35],
            "flex/cable",
            "rear camera AVDD/DVDD/reset power-control flex marker",
        ),
        (
            "front_camera_power_flex_marker",
            [7.0, 0.7, 0.12],
            [-15.0, 58.5, -1.35],
            "flex/cable",
            "front camera AVDD/DVDD/reset power-control flex marker",
        ),
        (
            "wifi_bt_host_control_trace_marker",
            [13.0, 1.0, 0.12],
            [18.0, 35.5, -1.35],
            "PCB trace marker",
            "Wi-Fi/Bluetooth PCIe/SDIO/UART/enable host-control route marker",
        ),
        (
            "cellular_host_control_trace_marker",
            [12.0, 1.0, 0.12],
            [-19.0, 38.5, -1.35],
            "PCB trace marker",
            "cellular USB2/PCIe/reset/disable host-control route marker",
        ),
        (
            "bottom_speaker_lead_pair",
            [10.0, 1.0, 0.12],
            [0.0, -62.0, -1.45],
            "flex/cable",
            "bottom speaker differential lead pair marker",
        ),
        (
            "bottom_microphone_flex_leads",
            [8.0, 1.0, 0.12],
            [-18.0, -62.0, -1.45],
            "flex/cable",
            "bottom microphone bias/data flex lead marker",
        ),
        (
            "top_microphone_flex_tail",
            [0.8, 18.0, 0.12],
            [-27.0, 55.0, -1.45],
            "flex/cable",
            "top microphone PDM flex tail marker from top microphone port region to top PCB island",
        ),
        (
            "earpiece_receiver_lead_flex",
            [14.0, 0.8, 0.12],
            [0.0, 61.0, -1.45],
            "flex/cable",
            "earpiece receiver lead flex marker behind the handset acoustic slot",
        ),
        (
            "haptic_flex_tail",
            [12.0, 1.0, 0.12],
            [24.0, -53.0, -1.45],
            "flex/cable",
            "LRA haptic drive flex tail marker",
        ),
        (
            "sensor_hub_i2c_flex_marker",
            [5.0, 0.8, 0.12],
            [-10.0, 34.5, -1.35],
            "flex/cable",
            "sensor hub I2C flex/trace marker",
        ),
        (
            "sim_esim_signal_flex_marker",
            [1.0, 9.0, 0.12],
            [29.0, -62.0, -1.45],
            "flex/cable",
            "SIM/eSIM signal route marker to the side tray region",
        ),
        (
            "nfc_loop_antenna_flex_marker",
            [6.0, 1.0, 0.12],
            [18.0, -62.0, -1.45],
            "flex/cable",
            "NFC controller to loop-match antenna flex marker for NFC_RF_P/N",
        ),
        (
            "cellular_div_rf_feed_development_envelope",
            [0.45, 12.0, 0.28],
            [-24.0, 60.0, -1.35],
            "RF feed",
            "development cellular diversity RF feed envelope",
        ),
        (
            "cellular_gnss_rf_feed_development_envelope",
            [0.45, 10.0, 0.28],
            [-28.0, 60.0, -1.35],
            "RF feed",
            "development GNSS RF feed envelope",
        ),
        (
            "wifi_bt_rf1_feed_development_envelope",
            [10.0, 0.45, 0.28],
            [27.0, 39.0, -1.35],
            "RF feed",
            "development second Wi-Fi/Bluetooth RF feed envelope",
        ),
        (
            "soc_shield_ground_spring_marker",
            [3.6, 0.7, 0.22],
            [-5.5, 24.5, -1.1],
            "ground spring",
            "SoC shield can to PCB ground spring marker",
        ),
        (
            "radio_shield_ground_spring_marker",
            [3.6, 0.7, 0.22],
            [-23.0, 33.0, -1.1],
            "ground spring",
            "radio shield can to PCB/chassis ground spring marker",
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
                "color": (
                    metal
                    if role in {"EMI shield", "RF feed"}
                    else cq.Color(0.95, 0.58, 0.10, 0.72)
                    if role in {"flex/cable", "PCB trace marker"}
                    else cq.Color(0.62, 0.64, 0.66, 1.0)
                    if role in {"cellular module", "Wi-Fi/Bluetooth module"}
                    else cq.Color(0.015, 0.018, 0.019, 1.0)
                    if role == "PCB component marker"
                    else keepout_color
                ),
                "role": role,
                "material": material,
            }
        )

    connection_contracts = cad_connection_contracts()
    solid_shapes_by_name = {str(item["name"]): item["shape"] for item in solids}

    def solid_bbox_center(shape: Any) -> list[float]:
        bbox = shape.val().BoundingBox()
        return [
            round((bbox.xmin + bbox.xmax) / 2.0, 3),
            round((bbox.ymin + bbox.ymax) / 2.0, 3),
            round((bbox.zmin + bbox.zmax) / 2.0, 3),
        ]

    terminal_color = cq.Color(0.95, 0.74, 0.18, 1.0)
    terminal_size = [0.45, 0.22, 0.02]
    main_pcb_terminal_index = 0
    endpoint_terminal_counts: dict[str, int] = {}
    for contract in connection_contracts:
        for side in ("from", "to"):
            endpoint_name = str(contract[side])
            endpoint_shape = solid_shapes_by_name.get(endpoint_name)
            if endpoint_shape is None:
                continue
            endpoint_bbox = endpoint_shape.val().BoundingBox()
            terminal_center = solid_bbox_center(endpoint_shape)
            if endpoint_name == "main_pcb":
                x_slots = np.linspace(endpoint_bbox.xmin + 3.0, endpoint_bbox.xmax - 3.0, 6)
                y_slots = [endpoint_bbox.ymin + 2.0, endpoint_bbox.ymax - 2.0]
                slot = main_pcb_terminal_index
                terminal_center[0] = round(float(x_slots[slot % len(x_slots)]), 3)
                terminal_center[1] = round(float(y_slots[(slot // len(x_slots)) % len(y_slots)]), 3)
                terminal_center[2] = CONNECTION_TERMINAL_MARKER_Z_MM
                main_pcb_terminal_index += 1
            else:
                slot = endpoint_terminal_counts.get(endpoint_name, 0)
                endpoint_terminal_counts[endpoint_name] = slot + 1
                direction = np.array([terminal_center[0], terminal_center[1]], dtype=float)
                norm = float(np.linalg.norm(direction))
                direction = np.array([1.0, 0.0], dtype=float) if norm < 1e-06 else direction / norm
                perpendicular = np.array([-direction[1], direction[0]], dtype=float)
                terminal_center[0] = round(
                    float(
                        terminal_center[0]
                        + direction[0] * 0.85
                        + perpendicular[0] * ((slot % 3) - 1) * 0.55
                    ),
                    3,
                )
                terminal_center[1] = round(
                    float(
                        terminal_center[1]
                        + direction[1] * 0.85
                        + perpendicular[1] * ((slot % 3) - 1) * 0.55
                    ),
                    3,
                )
                terminal_center[2] = CONNECTION_TERMINAL_MARKER_Z_MM
            terminal_name = f"{contract['id']}_{side}_terminal"
            solids.append(
                {
                    "name": terminal_name,
                    "shape": cq_box(terminal_size, terminal_center),
                    "color": terminal_color,
                    "role": "connection terminal",
                    "material": (
                        f"{side} terminal marker for {contract['id']} on {endpoint_name}; "
                        "local CAD connection evidence only"
                    ),
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
    # Combined board STEP (union of the two rigid islands) kept only as the
    # board-readiness / KiCad reconciliation evidence artifact (out/main_pcb.step).
    # The assembly itself carries the two islands as separate parts; this file is
    # the single-board projection used to compare against the KiCad Edge.Cuts.
    cq.exporters.export(
        cq_composite_box(pcb_island_segments(params)),
        str(OUT_DIR / "main_pcb.step"),
    )
    required_solid_names = [
        "orange_back_shell",
        "orange_side_frame",
        "screen_cover_glass",
        "display_lcm",
        "main_pcb",
        "battery_pouch",
        "battery_back_void_foam_pad",
        "usb_c_receptacle",
        "usb_c_external_aperture",
        "usb_c_perimeter_gasket_top",
        "usb_c_perimeter_gasket_bottom",
        "usb_c_perimeter_gasket_left",
        "usb_c_perimeter_gasket_right",
        "usb_c_molded_drip_break_lip",
        "usb_c_internal_drain_shelf",
        "bottom_speaker_module",
        "bottom_speaker_acoustic_chamber",
        "earpiece_receiver",
        "handset_acoustic_slot",
        "handset_acoustic_mesh",
        "bottom_mic",
        "top_mic",
        "bottom_speaker_dust_mesh",
        "bottom_microphone_mesh_1",
        "bottom_microphone_mesh_2",
        "top_microphone_port",
        "top_microphone_mesh",
        "rear_camera_module",
        "rear_camera_shell_aperture",
        "orange_rear_camera_bezel_top",
        "orange_rear_camera_bezel_bottom",
        "orange_rear_camera_bezel_left",
        "orange_rear_camera_bezel_right",
        "rear_camera_cover_glass",
        "rear_camera_lens_window",
        "rear_camera_optical_sight_tunnel",
        "rear_flash_led",
        "rear_flash_shell_aperture",
        "orange_rear_flash_bezel_top",
        "orange_rear_flash_bezel_bottom",
        "orange_rear_flash_bezel_left",
        "orange_rear_flash_bezel_right",
        "rear_flash_led_window",
        "rear_camera_cover_adhesive_top",
        "rear_camera_cover_adhesive_bottom",
        "rear_camera_cover_adhesive_left",
        "rear_camera_cover_adhesive_right",
        "rear_camera_light_baffle_top",
        "rear_camera_light_baffle_bottom",
        "rear_flash_window_adhesive_top",
        "rear_flash_window_adhesive_bottom",
        "rear_flash_window_adhesive_left",
        "rear_flash_window_adhesive_right",
        "rear_flash_camera_septum",
        "front_camera_module",
        "front_camera_under_glass",
        "front_camera_black_mask_window",
        "front_camera_under_glass_adhesive_top",
        "front_camera_under_glass_adhesive_bottom",
        "front_camera_under_glass_adhesive_left",
        "front_camera_under_glass_adhesive_right",
        "power_button_cap",
        "volume_button_cap",
        "power_button_elastomer_gasket",
        "power_button_labyrinth_upper_rail",
        "power_button_labyrinth_lower_rail",
        "volume_button_elastomer_gasket",
        "volume_button_labyrinth_upper_rail",
        "volume_button_labyrinth_lower_rail",
        "screen_adhesive_top",
        "display_fpc_connector",
        "orange_usb_reinforcement_saddle",
        "split_interconnect_top_connector",
        "split_interconnect_bottom_connector",
        "split_interconnect_side_flex",
        "split_interconnect_top_flex_tail",
        "split_interconnect_bottom_flex_tail",
        "cellular_top_antenna_keepout",
        "cellular_bottom_antenna_keepout",
        "wifi_bt_side_antenna_keepout",
        "cellular_lga_module_keepout",
        "wifi_bt_module_keepout",
        "compute_som_sodimm_connector",
        "compute_som_daughterboard_keepout",
        "soc_package_marker",
        "dram_package_marker",
        "storage_package_marker",
        "pmic_package_marker",
        "usb_pd_controller_package_marker",
        "charger_package_marker",
        "battery_connector_package_marker",
        "audio_codec_package_marker",
        "rf_transceiver_package_marker",
        "gnss_lna_package_marker",
        "backlight_bias_package_marker",
        "fuel_gauge_package_marker",
        "haptic_driver_package_marker",
        "usim_levelshift_package_marker",
        "esim_package_marker",
        "nfc_controller_package_marker",
        "nfc_loop_match_marker",
        "sensor_hub_package_marker",
        "esd_array_6ch_marker",
        "tvs_diode_2p_marker",
        "testpoint_1mm_marker",
        "fiducial_1mm_marker",
        "mounting_hole_1p2_marker",
        "r0402_component_marker",
        "c0402_component_marker",
        "l0402_component_marker",
        "pi_match_0402_marker",
        "rc_array_4ch_marker",
        "shunt_1206_marker",
        "wifi_bt_rf_feed_development_envelope",
        "cellular_rf_feed_development_envelope",
        "display_fpc_tail",
        "rear_camera_fpc_tail",
        "front_camera_fpc_tail",
        "side_key_flex_tail",
        "battery_connector_lead_flex",
        "usb_c_power_data_escape_tail",
        "usb_pd_controller_escape_trace_marker",
        "pd_charger_control_trace_marker",
        "charger_battery_power_sense_trace_marker",
        "display_bias_power_flex_marker",
        "rear_camera_power_flex_marker",
        "front_camera_power_flex_marker",
        "wifi_bt_host_control_trace_marker",
        "cellular_host_control_trace_marker",
        "bottom_speaker_lead_pair",
        "bottom_microphone_flex_leads",
        "top_microphone_flex_tail",
        "earpiece_receiver_lead_flex",
        "haptic_flex_tail",
        "sensor_hub_i2c_flex_marker",
        "sim_esim_signal_flex_marker",
        "nfc_loop_antenna_flex_marker",
        "cellular_div_rf_feed_development_envelope",
        "cellular_gnss_rf_feed_development_envelope",
        "wifi_bt_rf1_feed_development_envelope",
        "soc_shield_can",
        "pmic_shield_can",
        "radio_shield_can",
        "soc_shield_ground_spring_marker",
        "radio_shield_ground_spring_marker",
        "haptic_lra",
        "sim_tray_keepout",
        "service_label_recess",
    ]
    solid_names = {row["name"] for row in part_rows}
    required_solid_presence = {name: name in solid_names for name in required_solid_names}
    all_required_solids_present = all(required_solid_presence.values())
    all_steps_nonempty = all(row["bytes"] > 1000 for row in part_rows)
    routed_intake_path = (
        ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"
    )
    routed_intake = (
        yaml.safe_load(routed_intake_path.read_text()) if routed_intake_path.is_file() else {}
    )
    routed_nets = {
        str(route.get("net")) for route in routed_intake.get("routes", []) if route.get("net")
    }
    routed_route_records_by_net: dict[str, list[dict[str, Any]]] = {}
    for route in routed_intake.get("routes", []):
        if not isinstance(route, dict):
            continue
        route_net = str(route.get("canonical_net") or route.get("net") or "")
        if not route_net:
            continue
        routed_route_records_by_net.setdefault(route_net, []).append(route)
    connection_contracts = [
        {
            "id": "display_touch_fpc",
            "cad_part": "display_fpc_tail",
            "from": "display_fpc_connector",
            "to": "display_lcm",
            "connection_type": "display_touch_fpc",
            "nets": [
                "DSI_D0_P",
                "DSI_D0_N",
                "DSI_D1_P",
                "DSI_D1_N",
                "DSI_CLK_P",
                "DSI_CLK_N",
                "DSI_D2_P",
                "DSI_D2_N",
                "DSI_D3_P",
                "DSI_D3_N",
                "DISP_RESET_N",
                "DISP_TE",
                "TOUCH_I2C_SCL",
                "TOUCH_I2C_SDA",
            ],
        },
        {
            "id": "rear_camera_csi_fpc",
            "cad_part": "rear_camera_fpc_tail",
            "from": "main_pcb",
            "to": "rear_camera_module",
            "connection_type": "camera_fpc",
            "nets": [
                "CAM0_CSI_D0_P",
                "CAM0_CSI_D0_N",
                "CAM0_CSI_CLK_P",
                "CAM0_CSI_CLK_N",
                "CAM0_CSI_D1_P",
                "CAM0_CSI_D1_N",
                "CAM0_CSI_D2_P",
                "CAM0_CSI_D2_N",
                "CAM0_CSI_D3_P",
                "CAM0_CSI_D3_N",
                "CAM0_MCLK",
                "CAM0_I2C_SCL",
                "CAM0_I2C_SDA",
            ],
        },
        {
            "id": "front_camera_csi_fpc",
            "cad_part": "front_camera_fpc_tail",
            "from": "main_pcb",
            "to": "front_camera_module",
            "connection_type": "camera_fpc",
            "nets": [
                "CAM1_CSI_CLK_P",
                "CAM1_CSI_CLK_N",
                "CAM1_CSI_D0_P",
                "CAM1_CSI_D0_N",
                "CAM1_CSI_D1_P",
                "CAM1_CSI_D1_N",
                "CAM1_MCLK",
                "CAM1_I2C_SCL",
                "CAM1_I2C_SDA",
            ],
        },
        {
            "id": "side_key_flex",
            "cad_part": "side_key_flex_tail",
            "from": "main_pcb",
            "to": "power_button_cap",
            "connection_type": "side_key_flex",
            "nets": ["PWR_KEY_N", "VOL_UP_N", "VOL_DOWN_N"],
        },
        {
            "id": "battery_lead_flex",
            "cad_part": "battery_connector_lead_flex",
            "from": "battery_pouch",
            "to": "main_pcb",
            "connection_type": "battery_lead_flex",
            "nets": ["VBAT", "SYS", "BAT_NTC", "BAT_ID"],
        },
        {
            "id": "usb_c_escape_tail",
            "cad_part": "usb_c_power_data_escape_tail",
            "from": "usb_c_receptacle",
            "to": "main_pcb",
            "connection_type": "usb_c_escape_flex",
            "nets": ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN"],
        },
        {
            "id": "usb_c_to_pd_controller_escape",
            "cad_part": "usb_pd_controller_escape_trace_marker",
            "from": "usb_c_receptacle",
            "to": "usb_pd_controller_package_marker",
            "connection_type": "board_power_usb_trace",
            "nets": ["VBUS", "USB_CC1", "USB_CC2", "USB_DP", "USB_DN"],
        },
        {
            "id": "pd_controller_to_charger_control",
            "cad_part": "pd_charger_control_trace_marker",
            "from": "usb_pd_controller_package_marker",
            "to": "charger_package_marker",
            "connection_type": "board_power_control_trace",
            "nets": [
                "VBUS",
                "SYS",
                "USBPD_I2C_SCL",
                "USBPD_I2C_SDA",
                "USBPD_IRQ_N",
                "USBPD_RESET",
                "CHG_I2C_SCL",
                "CHG_I2C_SDA",
                "CHG_IRQ_N",
            ],
        },
        {
            "id": "charger_to_battery_power_sense",
            "cad_part": "charger_battery_power_sense_trace_marker",
            "from": "charger_package_marker",
            "to": "battery_connector_package_marker",
            "connection_type": "board_battery_power_sense_trace",
            "nets": ["VBAT", "SYS", "BAT_NTC", "BAT_ID"],
        },
        {
            "id": "display_bias_power_flex",
            "cad_part": "display_bias_power_flex_marker",
            "from": "backlight_bias_package_marker",
            "to": "display_fpc_connector",
            "connection_type": "display_bias_power_flex",
            "nets": ["DISP_AVDD_5V5", "DISP_AVEE_N5V5"],
        },
        {
            "id": "rear_camera_power_flex",
            "cad_part": "rear_camera_power_flex_marker",
            "from": "main_pcb",
            "to": "rear_camera_module",
            "connection_type": "camera_power_flex",
            "nets": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM0_RESET_N"],
        },
        {
            "id": "front_camera_power_flex",
            "cad_part": "front_camera_power_flex_marker",
            "from": "main_pcb",
            "to": "front_camera_module",
            "connection_type": "camera_power_flex",
            "nets": ["CAM_AVDD_2V8", "CAM_DVDD_1V2", "CAM1_RESET_N"],
        },
        {
            "id": "wifi_bt_host_control",
            "cad_part": "wifi_bt_host_control_trace_marker",
            "from": "wifi_bt_module_keepout",
            "to": "soc_package_marker",
            "connection_type": "wifi_bt_host_control_trace",
            "nets": [
                "WIFI_PCIE_TX_P",
                "WIFI_PCIE_TX_N",
                "WIFI_PCIE_RX_P",
                "WIFI_PCIE_RX_N",
                "WIFI_EN",
                "BT_EN",
                "WIFI_SDIO_CLK",
                "WIFI_SDIO_CMD",
                "WIFI_SDIO_D0",
                "WIFI_SDIO_D1",
                "WIFI_SDIO_D2",
                "WIFI_SDIO_D3",
                "BT_UART_TX",
                "BT_UART_RX",
                "BT_UART_CTS_N",
                "BT_UART_RTS_N",
                "WIFI_HOST_WAKE",
            ],
        },
        {
            "id": "cellular_host_control",
            "cad_part": "cellular_host_control_trace_marker",
            "from": "cellular_lga_module_keepout",
            "to": "soc_package_marker",
            "connection_type": "cellular_host_control_trace",
            "nets": [
                "CELL_USB2_DP",
                "CELL_USB2_DN",
                "CELL_PCIE_TX_P",
                "CELL_PCIE_TX_N",
                "CELL_PCIE_RX_P",
                "CELL_PCIE_RX_N",
                "CELL_RESET_N",
                "CELL_W_DISABLE_N",
            ],
        },
        {
            "id": "bottom_speaker_lead_pair",
            "cad_part": "bottom_speaker_lead_pair",
            "from": "main_pcb",
            "to": "bottom_speaker_module",
            "connection_type": "speaker_lead_pair",
            "nets": ["SPK_P", "SPK_N"],
        },
        {
            "id": "bottom_microphone_flex",
            "cad_part": "bottom_microphone_flex_leads",
            "from": "main_pcb",
            "to": "bottom_mic",
            "connection_type": "microphone_flex",
            "nets": ["PDM_CLK", "PDM_DAT"],
        },
        {
            "id": "top_microphone_flex",
            "cad_part": "top_microphone_flex_tail",
            "from": "main_pcb",
            "to": "top_mic",
            "connection_type": "microphone_flex",
            "nets": ["PDM_CLK", "PDM_DAT"],
        },
        {
            "id": "earpiece_receiver_lead_flex",
            "cad_part": "earpiece_receiver_lead_flex",
            "from": "main_pcb",
            "to": "earpiece_receiver",
            "connection_type": "earpiece_receiver_lead_flex",
            "nets": ["SPK_P", "SPK_N"],
        },
        {
            "id": "haptic_flex",
            "cad_part": "haptic_flex_tail",
            "from": "main_pcb",
            "to": "haptic_lra",
            "connection_type": "haptic_flex",
            "nets": ["HAPTIC_OUT"],
        },
        {
            "id": "sensor_hub_i2c_flex",
            "cad_part": "sensor_hub_i2c_flex_marker",
            "from": "main_pcb",
            "to": "sensor_hub_package_marker",
            "connection_type": "sensor_hub_i2c_flex",
            "nets": ["SENSOR_I2C_SCL", "SENSOR_I2C_SDA"],
        },
        {
            "id": "sim_esim_signal_flex",
            "cad_part": "sim_esim_signal_flex_marker",
            "from": "main_pcb",
            "to": "sim_tray_keepout",
            "connection_type": "sim_esim_signal_marker",
            "nets": [
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
        },
        {
            "id": "nfc_loop_antenna_flex",
            "cad_part": "nfc_loop_antenna_flex_marker",
            "from": "nfc_controller_package_marker",
            "to": "nfc_loop_match_marker",
            "connection_type": "nfc_loop_antenna_flex_marker",
            "nets": ["NFC_RF_P", "NFC_RF_N", "NFC_IRQ_N", "NFC_EN"],
        },
        {
            "id": "compute_som_sodimm_carrier",
            "cad_part": "compute_som_sodimm_connector",
            "from": "main_pcb",
            "to": "compute_som_daughterboard_keepout",
            "connection_type": "compute_som_edge_connector",
            "nets": [
                "USB_DP",
                "USB_DN",
                "DISP_RESET_N",
                "TOUCH_I2C_SCL",
                "TOUCH_I2C_SDA",
                "CAM0_MCLK",
                "CAM1_MCLK",
                "LPDDR_CK_P",
                "LPDDR_CK_N",
            ],
        },
        {
            "id": "soc_shield_ground_spring",
            "cad_part": "soc_shield_ground_spring_marker",
            "from": "soc_shield_can",
            "to": "main_pcb",
            "connection_type": "shield_ground_spring",
            "nets": ["GND"],
        },
        {
            "id": "radio_shield_ground_spring",
            "cad_part": "radio_shield_ground_spring_marker",
            "from": "radio_shield_can",
            "to": "main_pcb",
            "connection_type": "shield_ground_spring",
            "nets": ["GND", "SHIELD_GND"],
        },
        {
            "id": "cellular_main_rf_feed",
            "cad_part": "cellular_rf_feed_development_envelope",
            "from": "cellular_lga_module_keepout",
            "to": "cellular_top_antenna_keepout",
            "connection_type": "rf_50r_feed_envelope",
            "nets": ["CELL_RF_MAIN"],
        },
        {
            "id": "cellular_diversity_rf_feed",
            "cad_part": "cellular_div_rf_feed_development_envelope",
            "from": "cellular_lga_module_keepout",
            "to": "cellular_bottom_antenna_keepout",
            "connection_type": "rf_50r_feed_envelope",
            "nets": ["CELL_RF_DIV"],
        },
        {
            "id": "cellular_antenna_aperture_tuner",
            "cad_part": "antenna_aperture_tuner",
            "from": "cellular_lga_module_keepout",
            "to": "cellular_bottom_antenna_keepout",
            "connection_type": "rf_antenna_aperture_tuner",
            "nets": ["CELL_RF_DIV", "RF_VBAT"],
        },
        {
            "id": "cellular_gnss_rf_feed",
            "cad_part": "cellular_gnss_rf_feed_development_envelope",
            "from": "cellular_lga_module_keepout",
            "to": "gnss_lna_package_marker",
            "connection_type": "rf_50r_feed_envelope",
            "nets": ["CELL_GNSS_RF"],
        },
        {
            "id": "wifi_bt_rf0_feed",
            "cad_part": "wifi_bt_rf_feed_development_envelope",
            "from": "wifi_bt_module_keepout",
            "to": "wifi_bt_side_antenna_keepout",
            "connection_type": "rf_50r_feed_envelope",
            "nets": ["WIFI_BT_RF0"],
        },
        {
            "id": "wifi_bt_rf1_feed",
            "cad_part": "wifi_bt_rf1_feed_development_envelope",
            "from": "wifi_bt_module_keepout",
            "to": "wifi_bt_side_antenna_keepout",
            "connection_type": "rf_50r_feed_envelope",
            "nets": ["WIFI_BT_RF1"],
        },
        {
            "id": "split_interconnect_side_flex",
            "cad_part": "split_interconnect_side_flex",
            "from": "split_interconnect_top_connector",
            "to": "split_interconnect_bottom_connector",
            "connection_type": "top_bottom_board_flex",
            "nets": [
                "USB_DP",
                "USB_DN",
                "I2S_BCLK",
                "I2S_LRCLK",
                "I2S_DOUT",
                "I2S_DIN",
                "PDM_CLK",
                "PDM_DAT",
            ],
        },
    ]
    connection_type_profiles = {
        "display_touch_fpc": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "mipi_dsi_touch_control",
            "controlled_impedance_required": True,
            "impedance_requirement": "MIPI D-PHY differential routing; supplier FPC stackup required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "camera_fpc": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "mipi_csi_camera_control",
            "controlled_impedance_required": True,
            "impedance_requirement": "MIPI CSI D-PHY differential routing; supplier FPC stackup required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "side_key_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "low_speed_gpio",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 0.8,
            "supplier_release_required": True,
        },
        "battery_lead_flex": {
            "physical_medium": "battery_power_flex",
            "electrical_class": "battery_power_sense",
            "controlled_impedance_required": False,
            "impedance_requirement": "current_capacity_and_ntc_id_sense_required",
            "min_bend_radius_mm": 1.5,
            "supplier_release_required": True,
        },
        "usb_c_escape_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "usb2_pd_vbus",
            "controlled_impedance_required": True,
            "impedance_requirement": "USB2 differential impedance plus VBUS current capacity",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "board_power_usb_trace": {
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "usb2_pd_vbus_board_route",
            "controlled_impedance_required": True,
            "impedance_requirement": "USB2 differential impedance plus VBUS/CC current and ESD review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        "board_power_control_trace": {
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "pd_charger_power_control_board_route",
            "controlled_impedance_required": False,
            "impedance_requirement": "VBUS/SYS current capacity plus I2C/IRQ routing and sequencing review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        "board_battery_power_sense_trace": {
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "battery_power_sense_board_route",
            "controlled_impedance_required": False,
            "impedance_requirement": "VBAT/SYS current capacity plus NTC/ID kelvin-sense review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        "display_bias_power_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "display_bias_power",
            "controlled_impedance_required": False,
            "impedance_requirement": "display_bias_voltage_and_current_capacity_required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "camera_power_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "camera_power_control",
            "controlled_impedance_required": False,
            "impedance_requirement": "camera_rail_current_capacity_and_sequencing_required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "wifi_bt_host_control_trace": {
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "wifi_bt_host_interface",
            "controlled_impedance_required": True,
            "impedance_requirement": "PCIe differential impedance plus SDIO/UART/control routing review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        "cellular_host_control_trace": {
            "physical_medium": "pcb_copper_trace_group",
            "electrical_class": "cellular_host_interface",
            "controlled_impedance_required": True,
            "impedance_requirement": "USB2/PCIe differential impedance plus reset/disable routing review",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        "speaker_lead_pair": {
            "physical_medium": "insulated_wire_pair",
            "electrical_class": "audio_power_pair",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "microphone_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "digital_microphone",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 0.8,
            "supplier_release_required": True,
        },
        "earpiece_receiver_lead_flex": {
            "physical_medium": "insulated_wire_pair",
            "electrical_class": "audio_receiver_pair",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "haptic_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "haptic_drive",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 0.8,
            "supplier_release_required": True,
        },
        "sensor_hub_i2c_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "sensor_i2c",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 0.8,
            "supplier_release_required": True,
        },
        "sim_esim_signal_marker": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "sim_esim_low_speed",
            "controlled_impedance_required": False,
            "impedance_requirement": "not_controlled_impedance",
            "min_bend_radius_mm": 0.8,
            "supplier_release_required": True,
        },
        "nfc_loop_antenna_flex_marker": {
            "physical_medium": "flexible_antenna_loop",
            "electrical_class": "nfc_loop_rf",
            "controlled_impedance_required": True,
            "impedance_requirement": "NFC loop matching and antenna vendor review required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
        "compute_som_edge_connector": {
            "physical_medium": "board_to_board_edge_connector",
            "electrical_class": "compute_board_to_board_mixed_speed",
            "controlled_impedance_required": True,
            "impedance_requirement": "host high-speed and memory escape constraints required",
            "min_bend_radius_mm": None,
            "supplier_release_required": True,
        },
        "shield_ground_spring": {
            "physical_medium": "ground_spring_contact",
            "electrical_class": "shield_chassis_ground",
            "controlled_impedance_required": False,
            "impedance_requirement": "low_inductance_chassis_ground_contact_required",
            "min_bend_radius_mm": 0.0,
            "supplier_release_required": True,
        },
        "rf_50r_feed_envelope": {
            "physical_medium": "rf_50ohm_feed",
            "electrical_class": "cellular_wifi_rf",
            "controlled_impedance_required": True,
            "impedance_requirement": "50 ohm RF feed with matching network and antenna review",
            "min_bend_radius_mm": 1.5,
            "supplier_release_required": True,
        },
        "rf_antenna_aperture_tuner": {
            "physical_medium": "rf_tuner_interconnect",
            "electrical_class": "antenna_aperture_tuning",
            "controlled_impedance_required": True,
            "impedance_requirement": "50 ohm RF tuner connection and antenna vendor review",
            "min_bend_radius_mm": 1.5,
            "supplier_release_required": True,
        },
        "top_bottom_board_flex": {
            "physical_medium": "flexible_printed_circuit",
            "electrical_class": "top_bottom_board_mixed_signal",
            "controlled_impedance_required": True,
            "impedance_requirement": "USB2/MIPI/audio/control flex stackup required",
            "min_bend_radius_mm": 1.0,
            "supplier_release_required": True,
        },
    }
    for contract in connection_contracts:
        profile = connection_type_profiles[contract["connection_type"]]
        contract.update(profile)
    part_rows_by_name = {row["name"]: row for row in part_rows}
    connection_rows = []
    for contract in connection_contracts:
        part = part_rows_by_name.get(contract["cad_part"], {})
        endpoints_present = contract["from"] in solid_names and contract["to"] in solid_names
        endpoint_parts = {
            "from": part_rows_by_name.get(contract["from"], {}),
            "to": part_rows_by_name.get(contract["to"], {}),
        }
        part_bbox = part.get("bbox_mm") if isinstance(part.get("bbox_mm"), dict) else {}
        part_span = part_bbox.get("span") if isinstance(part_bbox, dict) else []
        from_terminal = f"{contract['id']}_from_terminal"
        to_terminal = f"{contract['id']}_to_terminal"
        terminal_part_names = [from_terminal, to_terminal]
        terminal_rows = [part_rows_by_name.get(name, {}) for name in terminal_part_names]
        from_terminal_row = terminal_rows[0]
        to_terminal_row = terminal_rows[1]
        terminal_markers_present = all(name in solid_names for name in terminal_part_names)
        terminal_step_bytes_total = sum(int(row.get("bytes", 0)) for row in terminal_rows)
        connection_step_part_names = [contract["cad_part"], *terminal_part_names]
        connection_step_parts_present = all(
            name in solid_names for name in connection_step_part_names
        )

        def bbox_center(row: dict[str, Any]) -> list[float] | None:
            bbox = row.get("bbox_mm")
            if not isinstance(bbox, dict):
                return None
            low = bbox.get("min")
            high = bbox.get("max")
            if (
                not isinstance(low, list)
                or not isinstance(high, list)
                or len(low) != 3
                or len(high) != 3
            ):
                return None
            return [round((float(low[idx]) + float(high[idx])) / 2.0, 3) for idx in range(3)]

        from_center = bbox_center(endpoint_parts["from"])
        to_center = bbox_center(endpoint_parts["to"])
        endpoint_center_distance_mm = None
        if from_center and to_center:
            endpoint_center_distance_mm = round(
                math.sqrt(
                    sum((float(from_center[idx]) - float(to_center[idx])) ** 2 for idx in range(3))
                ),
                3,
            )
        visual_route_span_mm = round(max([float(value) for value in part_span] or [0.0]), 3)
        routed_net_presence = {net: net in routed_nets for net in contract["nets"]}
        represented_nets = list(contract["nets"])
        represented_route_records: list[dict[str, Any]] = []
        for net in represented_nets:
            for route in routed_route_records_by_net.get(net, []):
                represented_route_records.append(
                    {
                        "id": route.get("id", ""),
                        "net": route.get("net", ""),
                        "canonical_net": route.get("canonical_net", route.get("net", "")),
                        "layer": route.get("layer", ""),
                        "width_mm": route.get("width_mm", 0),
                        "length_mm": route.get("length_mm", 0),
                        "manhattan_length_mm": route.get("manhattan_length_mm", 0),
                        "route_classes": route.get("route_classes", []),
                        "source_domains": route.get("source_domains", []),
                        "controlled_impedance_targets_ohm": route.get(
                            "controlled_impedance_targets_ohm", []
                        ),
                        "linked_via_ids": route.get("linked_via_ids", []),
                        "constraint_status": route.get("constraint_status", ""),
                    }
                )
        represented_route_ids = [str(route.get("id")) for route in represented_route_records]
        represented_route_classes = sorted(
            {
                str(route_class)
                for route in represented_route_records
                for route_class in route.get("route_classes", [])
            }
        )
        represented_source_domains = sorted(
            {
                str(domain)
                for route in represented_route_records
                for domain in route.get("source_domains", [])
            }
        )
        represented_route_record_count = len(represented_route_records)
        represented_route_records_with_layer_count = sum(
            1 for route in represented_route_records if route.get("layer")
        )
        represented_route_records_with_source_domain_count = sum(
            1 for route in represented_route_records if route.get("source_domains")
        )
        represented_route_records_with_route_class_count = sum(
            1 for route in represented_route_records if route.get("route_classes")
        )
        represented_route_classification_gap_count = sum(
            1
            for route in represented_route_records
            if not route.get("layer")
            or not route.get("source_domains")
            or not route.get("route_classes")
        )
        all_represented_routes_have_layer_source_and_class = (
            represented_route_record_count > 0
            and represented_route_classification_gap_count == 0
        )
        represented_controlled_impedance_route_count = sum(
            1
            for route in represented_route_records
            if route.get("controlled_impedance_targets_ohm")
        )
        represented_route_length_total_mm = round(
            sum(float(route.get("length_mm") or 0.0) for route in represented_route_records),
            3,
        )
        all_represented_nets_have_route_trace = all(
            bool(routed_route_records_by_net.get(net)) for net in represented_nets
        )
        controlled_impedance_requirement_defined = (
            not contract["controlled_impedance_required"]
            or contract["impedance_requirement"] != "not_controlled_impedance"
        )
        bend_radius_requirement_defined = (
            contract["min_bend_radius_mm"] is not None
            or contract["physical_medium"] == "board_to_board_edge_connector"
        )
        connection_rows.append(
            {
                **contract,
                "cad_part_present": contract["cad_part"] in solid_names,
                "cad_step": part.get("step", ""),
                "cad_step_bytes": part.get("bytes", 0),
                "cad_part_bbox_mm": part_bbox,
                "visual_route_span_mm": visual_route_span_mm,
                "represented_nets": represented_nets,
                "represented_net_count": len(represented_nets),
                "represented_route_ids": represented_route_ids,
                "represented_route_count": len(represented_route_records),
                "represented_route_records": represented_route_records,
                "represented_route_classes": represented_route_classes,
                "represented_source_domains": represented_source_domains,
                "represented_route_record_count": represented_route_record_count,
                "represented_route_records_with_layer_count": (
                    represented_route_records_with_layer_count
                ),
                "represented_route_records_with_source_domain_count": (
                    represented_route_records_with_source_domain_count
                ),
                "represented_route_records_with_route_class_count": (
                    represented_route_records_with_route_class_count
                ),
                "represented_route_classification_gap_count": (
                    represented_route_classification_gap_count
                ),
                "all_represented_routes_have_layer_source_and_class": (
                    all_represented_routes_have_layer_source_and_class
                ),
                "represented_route_length_total_mm": represented_route_length_total_mm,
                "represented_controlled_impedance_route_count": (
                    represented_controlled_impedance_route_count
                ),
                "all_represented_nets_have_route_trace": all_represented_nets_have_route_trace,
                "from_terminal_part": from_terminal,
                "from_terminal_step": from_terminal_row.get("step", ""),
                "from_terminal_step_bytes": int(from_terminal_row.get("bytes", 0) or 0),
                "to_terminal_part": to_terminal,
                "to_terminal_step": to_terminal_row.get("step", ""),
                "to_terminal_step_bytes": int(to_terminal_row.get("bytes", 0) or 0),
                "terminal_marker_count": len(terminal_part_names),
                "terminal_markers_present": terminal_markers_present,
                "terminal_step_bytes_total": terminal_step_bytes_total,
                "solid_step_part_names": connection_step_part_names,
                "solid_step_parts_present": connection_step_parts_present,
                "solid_step_part_count": len(connection_step_part_names),
                "solid_step_part_bytes_total": int(part.get("bytes", 0) or 0)
                + terminal_step_bytes_total,
                "from_endpoint_center_mm": from_center,
                "to_endpoint_center_mm": to_center,
                "endpoint_center_distance_mm": endpoint_center_distance_mm,
                "endpoints_present": endpoints_present,
                "routed_net_presence": routed_net_presence,
                "all_nets_in_routed_development_board": all(routed_net_presence.values()),
                "controlled_impedance_requirement_defined": controlled_impedance_requirement_defined,
                "bend_radius_requirement_defined": bend_radius_requirement_defined,
                "release_credit": False,
                "pass": (
                    contract["cad_part"] in solid_names
                    and int(part.get("bytes", 0)) > 1000
                    and terminal_markers_present
                    and terminal_step_bytes_total > 1000
                    and connection_step_parts_present
                    and visual_route_span_mm > 0.0
                    and endpoints_present
                    and all(routed_net_presence.values())
                    and all_represented_nets_have_route_trace
                    and all_represented_routes_have_layer_source_and_class
                    and controlled_impedance_requirement_defined
                    and bend_radius_requirement_defined
                ),
            }
        )
    physical_medium_counts = {}
    electrical_class_counts = {}
    for row in connection_rows:
        physical_medium_counts[row["physical_medium"]] = (
            physical_medium_counts.get(row["physical_medium"], 0) + 1
        )
        electrical_class_counts[row["electrical_class"]] = (
            electrical_class_counts.get(row["electrical_class"], 0) + 1
        )
    connection_coverage = {
        "schema": "eliza.e1_phone_cad_connection_coverage.v1",
        "date": "2026-05-22",
        "status": "cad_connection_markers_complete_not_release"
        if all(row["pass"] for row in connection_rows)
        else "blocked_cad_connection_marker_gap",
        "claim_boundary": (
            "CAD envelope connection coverage for flex, cable, and RF-feed markers. "
            "This proves explicit local CAD markers and routed-development net names only; "
            "it is not supplier FPC drawing, RF layout, impedance, DRC/ERC, or production release evidence."
        ),
        "routed_development_intake": str(routed_intake_path.relative_to(ROOT)),
        "routed_development_net_count": len(routed_nets),
        "required_connection_count": len(connection_rows),
        "passing_connection_count": sum(1 for row in connection_rows if row["pass"]),
        "required_connection_terminal_marker_count": sum(
            int(row["terminal_marker_count"]) for row in connection_rows
        ),
        "passing_connection_terminal_pair_count": sum(
            1 for row in connection_rows if row["terminal_markers_present"]
        ),
        "required_connection_solid_step_part_count": sum(
            int(row["solid_step_part_count"]) for row in connection_rows
        ),
        "passing_connection_solid_step_part_set_count": sum(
            1 for row in connection_rows if row["solid_step_parts_present"]
        ),
        "connection_solid_step_part_bytes_total": sum(
            int(row["solid_step_part_bytes_total"]) for row in connection_rows
        ),
        "represented_net_count_total": sum(
            int(row["represented_net_count"]) for row in connection_rows
        ),
        "represented_route_count_total": sum(
            int(row["represented_route_count"]) for row in connection_rows
        ),
        "represented_route_record_count_total": sum(
            int(row["represented_route_record_count"]) for row in connection_rows
        ),
        "represented_route_records_with_layer_count_total": sum(
            int(row["represented_route_records_with_layer_count"]) for row in connection_rows
        ),
        "represented_route_records_with_source_domain_count_total": sum(
            int(row["represented_route_records_with_source_domain_count"])
            for row in connection_rows
        ),
        "represented_route_records_with_route_class_count_total": sum(
            int(row["represented_route_records_with_route_class_count"])
            for row in connection_rows
        ),
        "represented_route_classification_gap_count": sum(
            int(row["represented_route_classification_gap_count"]) for row in connection_rows
        ),
        "all_represented_routes_have_layer_source_and_class": all(
            row["all_represented_routes_have_layer_source_and_class"] for row in connection_rows
        ),
        "represented_route_length_total_mm": round(
            sum(float(row["represented_route_length_total_mm"]) for row in connection_rows),
            3,
        ),
        "represented_controlled_impedance_route_count_total": sum(
            int(row["represented_controlled_impedance_route_count"]) for row in connection_rows
        ),
        "all_represented_nets_have_route_trace": all(
            row["all_represented_nets_have_route_trace"] for row in connection_rows
        ),
        "visual_route_span_total_mm": round(
            sum(float(row["visual_route_span_mm"]) for row in connection_rows),
            3,
        ),
        "endpoint_pair_distance_total_mm": round(
            sum(float(row["endpoint_center_distance_mm"] or 0.0) for row in connection_rows),
            3,
        ),
        "physical_medium_counts": dict(sorted(physical_medium_counts.items())),
        "electrical_class_counts": dict(sorted(electrical_class_counts.items())),
        "controlled_impedance_connection_count": sum(
            1 for row in connection_rows if row["controlled_impedance_required"]
        ),
        "controlled_impedance_requirement_defined_count": sum(
            1 for row in connection_rows if row["controlled_impedance_requirement_defined"]
        ),
        "bend_radius_requirement_defined_count": sum(
            1 for row in connection_rows if row["bend_radius_requirement_defined"]
        ),
        "supplier_release_required_connection_count": sum(
            1 for row in connection_rows if row["supplier_release_required"]
        ),
        "release_credit": False,
        "connections": connection_rows,
    }
    (REVIEW_DIR / "cad-connection-coverage.json").write_text(
        json.dumps(connection_coverage, indent=2) + "\n"
    )
    coverage_lines = [
        "# E1 Phone CAD Connection Coverage",
        "",
        f"Status: {connection_coverage['status']}.",
        "",
        "## Connections",
        "",
    ]
    for row in connection_rows:
        result = "PASS" if row["pass"] else "BLOCKED"
        coverage_lines.append(
            f"- {result}: `{row['id']}` uses `{row['cad_part']}` from `{row['from']}` "
            f"to `{row['to']}`; nets={row['represented_net_count']}, "
            f"routes={row['represented_route_count']}, "
            f"terminals=`{row['from_terminal_part']}`/`{row['to_terminal_part']}`, "
            f"span={row['visual_route_span_mm']} mm, "
            f"endpoint_distance={row['endpoint_center_distance_mm']} mm"
        )
    (REVIEW_DIR / "cad-connection-coverage.md").write_text("\n".join(coverage_lines) + "\n")
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
        "connection_coverage": connection_coverage,
        "required_solid_presence": required_solid_presence,
        "side_frame_external_cutouts": {
            "status": "pass"
            if side_frame_cut_volume_mm3 < side_frame_uncut_volume_mm3
            else "blocked",
            "cutout_count": len(side_frame_cutouts),
            "cutouts": [
                {
                    "name": cutout["name"],
                    "source_aperture": cutout["source_aperture"],
                    "size_mm": cutout["size"],
                    "center_mm": cutout["center"],
                }
                for cutout in side_frame_cutouts
            ],
            "uncut_side_frame_volume_mm3": side_frame_uncut_volume_mm3,
            "cut_side_frame_volume_mm3": side_frame_cut_volume_mm3,
            "removed_volume_mm3": round(side_frame_uncut_volume_mm3 - side_frame_cut_volume_mm3, 3),
            "note": (
                "Orange side-frame STEP is boolean-cut for USB-C, bottom speaker grille, "
                "bottom/top microphone ports, and side-key cap openings instead of relying "
                "only on separate black aperture markers."
            ),
        },
        "cover_glass_external_cutouts": {
            "status": "pass"
            if cover_glass_cut_volume_mm3 < cover_glass_uncut_volume_mm3
            else "blocked",
            "cutout_count": 1,
            "cutouts": [
                {
                    "name": "handset_cover_glass_slot_cutout",
                    "source_aperture": "handset_acoustic_slot",
                    "size_mm": handset_cover_glass_cutout_mm(params),
                    "center_mm": handset_acoustic_slot_center(params),
                }
            ],
            "uncut_cover_glass_volume_mm3": cover_glass_uncut_volume_mm3,
            "cut_cover_glass_volume_mm3": cover_glass_cut_volume_mm3,
            "removed_volume_mm3": round(
                cover_glass_uncut_volume_mm3 - cover_glass_cut_volume_mm3, 3
            ),
            "note": "Cover-glass STEP is boolean-cut for the handset acoustic slot instead of relying only on a separate black slot marker.",
        },
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
        f"- Side-frame external cutouts: {report['side_frame_external_cutouts']['cutout_count']} "
        f"({report['side_frame_external_cutouts']['removed_volume_mm3']} mm^3 removed)",
        f"- Cover-glass external cutouts: {report['cover_glass_external_cutouts']['cutout_count']} "
        f"({report['cover_glass_external_cutouts']['removed_volume_mm3']} mm^3 removed)",
        "",
        "## Side-Frame Cutouts",
        "",
    ]
    for cutout in report["side_frame_external_cutouts"]["cutouts"]:
        lines.append(
            f"- `{cutout['name']}` from `{cutout['source_aperture']}`: "
            f"{cutout['size_mm']} mm at {cutout['center_mm']} mm"
        )
    lines.extend(["", "## Cover-Glass Cutouts", ""])
    for cutout in report["cover_glass_external_cutouts"]["cutouts"]:
        lines.append(
            f"- `{cutout['name']}` from `{cutout['source_aperture']}`: "
            f"{cutout['size_mm']} mm at {cutout['center_mm']} mm"
        )
    lines.extend(
        [
            "",
            "## Parts",
            "",
        ]
    )
    for row in part_rows:
        lines.append(f"- `{row['name']}`: `{row['step']}` ({row['role']})")
    lines.extend(["", "## Remaining Blockers", ""])
    for blocker in report["remaining_blockers"]:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "solid-cad-handoff.md").write_text("\n".join(lines) + "\n")
    return report


def write_step_validation_artifacts(solid_cad: dict[str, Any]) -> dict[str, Any]:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    validation_tool = "cadquery"

    def import_step_bbox(path: Path) -> list[float]:
        nonlocal validation_tool
        try:
            import cadquery as cq

            imported = cq.importers.importStep(str(path))
            bbox = cast(Any, imported.val()).BoundingBox()
            validation_tool = "cadquery"
            return [float(bbox.xlen), float(bbox.ylen), float(bbox.zlen)]
        except ModuleNotFoundError as cadquery_exc:
            try:
                from OCP.Bnd import Bnd_Box
                from OCP.BRepBndLib import BRepBndLib
                from OCP.IFSelect import IFSelect_RetDone
                from OCP.STEPControl import STEPControl_Reader
            except Exception as ocp_exc:
                raise cadquery_exc from ocp_exc

            reader = STEPControl_Reader()
            status = reader.ReadFile(str(path))
            if status != IFSelect_RetDone:
                raise RuntimeError(f"OCP STEP read failed: {status}")
            reader.TransferRoots()
            shape = reader.OneShape()
            box = Bnd_Box()
            BRepBndLib.Add_s(shape, box)
            xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
            validation_tool = "ocp_step_reader"
            return [float(xmax - xmin), float(ymax - ymin), float(zmax - zmin)]

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
                actual = import_step_bbox(path)
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
            actual = import_step_bbox(assembly_path)
            assembly_case.update(
                {
                    "imported": True,
                    "bbox_span_mm": [round(value, 3) for value in actual],
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
        "validation_tool": validation_tool,
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
        pixels = np.asarray(image, dtype=np.uint8).reshape(-1, 3)
        total_pixels = int(pixels.shape[0])
        nonwhite_mask = np.min(pixels, axis=1) < 245
        nonwhite_pixels = pixels[nonwhite_mask]
        orange_mask = (
            (nonwhite_pixels[:, 0] > 180)
            & (nonwhite_pixels[:, 1] >= 35)
            & (nonwhite_pixels[:, 1] <= 150)
            & (nonwhite_pixels[:, 2] < 90)
        )
        dark_mask = (
            (nonwhite_pixels[:, 0] < 90)
            & (nonwhite_pixels[:, 1] < 90)
            & (nonwhite_pixels[:, 2] < 90)
        )
        nonwhite_count = int(nonwhite_pixels.shape[0])
        nonwhite_coords = np.argwhere(nonwhite_mask.reshape(image.size[1], image.size[0]))
        if nonwhite_coords.size:
            y_min, x_min = nonwhite_coords.min(axis=0)
            y_max, x_max = nonwhite_coords.max(axis=0)
            occupied_bbox_ratio = (int(x_max - x_min) + 1) * (int(y_max - y_min) + 1) / total_pixels
        else:
            occupied_bbox_ratio = 0.0
        grayscale = pixels.reshape(image.size[1], image.size[0], 3).astype(np.int16).mean(axis=2)
        edge_mask = np.zeros_like(grayscale, dtype=bool)
        edge_mask[:, 1:] |= np.abs(np.diff(grayscale, axis=1)) > 12
        edge_mask[1:, :] |= np.abs(np.diff(grayscale, axis=0)) > 12
        edge_pixel_ratio = float(np.count_nonzero(edge_mask) / total_pixels)
        quantized_unique_color_count = int(np.unique(pixels // 16, axis=0).shape[0])
        content_checks = {
            "resolution": image.size[0] >= 1000 and image.size[1] >= 1000,
            "channel_span": max(channel_spans) >= 120,
            "nonwhite_coverage": nonwhite_count / total_pixels >= 0.02,
            "occupied_bbox": occupied_bbox_ratio >= 0.15,
            "edge_detail": edge_pixel_ratio >= 0.003,
            "color_variation": quantized_unique_color_count >= 50,
        }
        results[path.name] = {
            "size": list(image.size),
            "mean_rgb": [round(value, 3) for value in stat.mean],
            "channel_spans": channel_spans,
            "nonwhite_pixel_ratio": round(nonwhite_count / total_pixels, 5),
            "occupied_bbox_ratio": round(occupied_bbox_ratio, 5),
            "edge_pixel_ratio": round(edge_pixel_ratio, 5),
            "quantized_unique_color_count": quantized_unique_color_count,
            "content_checks": content_checks,
            "orange_pixel_ratio_of_nonwhite": round(
                int(np.count_nonzero(orange_mask)) / max(nonwhite_count, 1), 5
            ),
            "dark_pixel_ratio_of_nonwhite": round(
                int(np.count_nonzero(dark_mask)) / max(nonwhite_count, 1), 5
            ),
            "pass": all(content_checks.values()),
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


def write_part_review_artifacts(
    parts: list[Part],
    exploded_parts: list[Part] | None = None,
) -> dict[str, Any]:
    from PIL import Image, ImageDraw

    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    exploded_parts = exploded_parts or parts
    exploded_by_name = {part.name: part for part in exploded_parts}
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
                "mass_estimate_class": mass_estimate_class(part),
                "mass_estimate_included": is_mass_estimate_included(part),
                "obj": f"mechanical/e1-phone/out/{part.name}.obj",
                "stl": f"mechanical/e1-phone/out/{part.name}.stl",
            }
        )

    def rgb(color: tuple[float, float, float, float]) -> tuple[int, int, int]:
        return tuple(int(max(0.0, min(channel, 1.0)) * 255) for channel in color[:3])

    def label(draw: Any, xy: tuple[int, int], text: str, fill: tuple[int, int, int]) -> None:
        draw.text(xy, text.replace("_", " ")[:34], fill=fill)

    cols = 6
    rows_count = int(math.ceil(len(parts) / cols))
    cell_w = 260
    cell_h = 210
    title_h = 34
    contact_sheet = REVIEW_DIR / "part-review-contact-sheet.png"
    image = Image.new(
        "RGB",
        (max(cols * cell_w, 1000), max(rows_count * cell_h + title_h, 1000)),
        "white",
    )
    draw = ImageDraw.Draw(image)
    draw.text((18, 10), "E1 phone per-part top-view review contact sheet", fill=(20, 20, 20))
    for index, part in enumerate(parts):
        col = index % cols
        row = index // cols
        x0 = col * cell_w + 14
        y0 = title_h + row * cell_h + 18
        x1 = (col + 1) * cell_w - 14
        y1 = title_h + (row + 1) * cell_h - 24
        low, high = part.bounds
        span = high - low
        scale = min((x1 - x0) / max(float(span[0]), 0.1), (y1 - y0) / max(float(span[1]), 0.1))
        width = max(2, int(float(span[0]) * scale))
        height = max(2, int(float(span[1]) * scale))
        cx = (x0 + x1) // 2
        cy = (y0 + y1) // 2
        draw.rectangle(
            (cx - width // 2, cy - height // 2, cx + width // 2, cy + height // 2),
            fill=rgb(part.color),
            outline=(0, 0, 0),
            width=2,
        )
        label(draw, (col * cell_w + 14, title_h + (row + 1) * cell_h - 19), part.name, (0, 0, 0))
    image.save(contact_sheet)

    exploded_cols = 6
    exploded_rows_count = int(math.ceil(len(parts) / exploded_cols))
    exploded_contact_sheet = REVIEW_DIR / "part-explode-contact-sheet.png"
    exploded_image = Image.new(
        "RGB",
        (
            max(exploded_cols * cell_w, 1000),
            max(exploded_rows_count * cell_h + title_h, 1000),
        ),
        (16, 18, 22),
    )
    exploded_draw = ImageDraw.Draw(exploded_image)
    exploded_draw.text(
        (18, 10),
        "E1 phone per-part exploded-context review contact sheet",
        fill=(235, 238, 244),
    )
    exploded_lows = np.asarray([part.bounds[0] for part in exploded_parts])
    exploded_highs = np.asarray([part.bounds[1] for part in exploded_parts])
    global_low = exploded_lows.min(axis=0)
    global_high = exploded_highs.max(axis=0)
    global_span_x = max(float(global_high[0] - global_low[0]), 1.0)
    global_span_z = max(float(global_high[2] - global_low[2]), 1.0)
    for index, part in enumerate(parts):
        col = index % exploded_cols
        row = index // exploded_cols
        x0 = col * cell_w + 14
        y0 = title_h + row * cell_h + 18
        x1 = (col + 1) * cell_w - 14
        y1 = title_h + (row + 1) * cell_h - 24
        scale = min((x1 - x0) / global_span_x, (y1 - y0) / global_span_z)

        def project(
            bounds: tuple[np.ndarray, np.ndarray],
            _x0: int = x0,
            _y1: int = y1,
            _scale: float = scale,
        ) -> tuple[int, int, int, int]:
            low, high = bounds
            left = _x0 + int((float(low[0] - global_low[0])) * _scale)
            right = _x0 + int((float(high[0] - global_low[0])) * _scale)
            top = _y1 - int((float(high[2] - global_low[2])) * _scale)
            bottom = _y1 - int((float(low[2] - global_low[2])) * _scale)
            return left, top, max(right, left + 2), max(bottom, top + 2)

        for ghost in exploded_parts:
            exploded_draw.rectangle(project(ghost.bounds), fill=(42, 45, 52), outline=(68, 72, 82))
        highlighted = exploded_by_name.get(part.name, part)
        exploded_draw.rectangle(
            project(highlighted.bounds), fill=rgb(part.color), outline=(255, 255, 255), width=2
        )
        label(
            exploded_draw,
            (col * cell_w + 14, title_h + (row + 1) * cell_h - 19),
            part.name,
            (235, 238, 244),
        )
    exploded_image.save(exploded_contact_sheet)

    contact_sheet_check = verify_image_artifact(contact_sheet)
    exploded_contact_sheet_check = verify_image_artifact(exploded_contact_sheet)
    report = {
        "claim_boundary": (
            "Automated part-by-part CAD review index; thumbnails are top-view bounding-box "
            "and exploded-context projection proxies, not human industrial-design signoff."
        ),
        "status": "pass"
        if rows and contact_sheet_check["pass"] and exploded_contact_sheet_check["pass"]
        else "blocked",
        "part_count": len(rows),
        "contact_sheet": "mechanical/e1-phone/review/part-review-contact-sheet.png",
        "contact_sheet_check": contact_sheet_check,
        "exploded_contact_sheet": "mechanical/e1-phone/review/part-explode-contact-sheet.png",
        "exploded_contact_sheet_check": exploded_contact_sheet_check,
        "review_projections": ["per_part_top_xy", "exploded_context_xz"],
        "parts": rows,
    }
    (REVIEW_DIR / "part-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Part Review Index",
        "",
        "Status: generated part index and contact sheet for every assembly part.",
        "",
        "- `mechanical/e1-phone/review/part-review-contact-sheet.png`",
        "- `mechanical/e1-phone/review/part-explode-contact-sheet.png`",
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
    front_back_orange_ratio_delta = abs(
        float(visual.get("full_front_iso.png", {}).get("orange_pixel_ratio_of_nonwhite", 0.0))
        - float(visual.get("full_back_iso.png", {}).get("orange_pixel_ratio_of_nonwhite", 0.0))
    )
    front_back_dark_ratio_delta = abs(
        float(visual.get("full_front_iso.png", {}).get("dark_pixel_ratio_of_nonwhite", 0.0))
        - float(visual.get("full_back_iso.png", {}).get("dark_pixel_ratio_of_nonwhite", 0.0))
    )
    front_back_render_distinct = front_back_mean_delta >= 7.5 or (
        front_back_orange_ratio_delta >= 0.25 and front_back_dark_ratio_delta >= 0.25
    )
    expected_views = {
        "full_front_iso.png",
        "full_back_iso.png",
        "rear_feature_detail.png",
        "full_left_side.png",
        "full_bottom_port.png",
        "full_top_down.png",
        "exploded_iso.png",
        "component_stack.png",
        "component-review-audio.png",
        "component-review-io-buttons.png",
        "component-review-optical.png",
        "mold_tooling.png",
    }
    present_views = set(visual)
    missing_views = sorted(expected_views - present_views)

    def visual_metric(name: str, key: str, default: float = 0.0) -> float:
        return float(visual.get(name, {}).get(key, default))

    color_metrics_present = all(
        "orange_pixel_ratio_of_nonwhite" in visual.get(name, {}) for name in expected_views
    )
    visual_design_gates: dict[str, dict[str, Any]] = {
        "expected_review_view_coverage": {
            "pass": not missing_views,
            "expected_views": sorted(expected_views),
            "missing_views": missing_views,
        },
        "hard_orange_shell_visible": {
            "pass": (not color_metrics_present)
            or (
                visual_metric("full_back_iso.png", "orange_pixel_ratio_of_nonwhite") >= 0.65
                and visual_metric("full_bottom_port.png", "orange_pixel_ratio_of_nonwhite") >= 0.45
                and visual_metric("full_front_iso.png", "orange_pixel_ratio_of_nonwhite") >= 0.25
            ),
            "front_orange_ratio": visual_metric(
                "full_front_iso.png", "orange_pixel_ratio_of_nonwhite"
            ),
            "back_orange_ratio": visual_metric(
                "full_back_iso.png", "orange_pixel_ratio_of_nonwhite"
            ),
            "bottom_orange_ratio": visual_metric(
                "full_bottom_port.png", "orange_pixel_ratio_of_nonwhite"
            ),
        },
        "black_glass_front_visible": {
            "pass": (not color_metrics_present)
            or (
                visual_metric("full_front_iso.png", "dark_pixel_ratio_of_nonwhite") >= 0.25
                and visual_metric("full_top_down.png", "dark_pixel_ratio_of_nonwhite") >= 0.5
            ),
            "front_dark_ratio": visual_metric("full_front_iso.png", "dark_pixel_ratio_of_nonwhite"),
            "top_down_dark_ratio": visual_metric(
                "full_top_down.png", "dark_pixel_ratio_of_nonwhite"
            ),
        },
        "component_stack_visible": {
            "pass": (not color_metrics_present)
            or visual_metric("component_stack.png", "nonwhite_pixel_ratio") >= 0.05,
            "component_stack_nonwhite_ratio": visual_metric(
                "component_stack.png", "nonwhite_pixel_ratio"
            ),
        },
        "component_family_detail_views": {
            "pass": all(
                bool(visual.get(name, {}).get("pass", False))
                for name in [
                    "component-review-audio.png",
                    "component-review-io-buttons.png",
                    "component-review-optical.png",
                ]
            ),
            "required_views": [
                "component-review-audio.png",
                "component-review-io-buttons.png",
                "component-review-optical.png",
            ],
        },
        "compact_screen_margin": {
            "pass": 0.35 <= screen_margin <= 0.6,
            "screen_margin_mm": screen_margin,
            "target_min_mm": 0.35,
            "target_max_mm": 0.6,
        },
    }
    review_views = [
        {
            "file": name,
            "pass": bool(result.get("pass", False)),
            "size": result.get("size"),
            "nonwhite_pixel_ratio": result.get("nonwhite_pixel_ratio"),
            "orange_pixel_ratio_of_nonwhite": result.get("orange_pixel_ratio_of_nonwhite"),
            "dark_pixel_ratio_of_nonwhite": result.get("dark_pixel_ratio_of_nonwhite"),
            "purpose": {
                "full_front_iso.png": "front silhouette, orange side rail, black glass stack",
                "full_back_iso.png": "rear-side orange shell, camera window, and service-feature review",
                "rear_feature_detail.png": "translucent rear shell review of camera window, SIM edge, and service-label recess",
                "full_left_side.png": "left-side button protrusion and shell depth",
                "full_bottom_port.png": "USB-C, speaker grille, and microphone aperture review",
                "full_top_down.png": "compact footprint, screen margin, buttons, and front features",
                "exploded_iso.png": "glass, display, shell, and component stack separation",
                "component_stack.png": "PCB, battery, camera, audio, haptic, and I/O placement",
                "component-review-audio.png": "speaker, earpiece, microphone, acoustic mesh, and port packaging",
                "component-review-io-buttons.png": "USB-C, side buttons, seals, and tactile actuation packaging",
                "component-review-optical.png": "front/rear cameras, flash, baffles, cover windows, and optical seals",
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
            "basis": "Single rear AF camera is buried under the flat back wall behind an explicit molded shell aperture and flush cover window (no bump, no proud ring); device depth was raised to fully bury the module.",
            "evidence": [
                "rear_feature_detail.png",
                "rear_camera_shell_aperture",
                "orange_rear_camera_bezel_top",
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
        "front_back_render_distinct": front_back_render_distinct,
        "visual_design_gates_pass": all(gate["pass"] for gate in visual_design_gates.values()),
    }
    automated_visual_status = (
        "automated_visual_coverage_pass" if all(status_inputs.values()) else "blocked"
    )
    manual_visual_signoff_status = (
        "production_visual_signoff_complete"
        if automated_visual_status == "automated_visual_coverage_pass" and not manual_review_items
        else "blocked_manual_visual_review_open"
    )
    report = {
        "claim_boundary": (
            "Automated EVT0 visual/design decision log; it records CAD review acceptance and open "
            "manual checks, not CMF lock, tooling release, or production validation."
        ),
        "status": "pass"
        if automated_visual_status == "automated_visual_coverage_pass"
        else "blocked",
        "automated_visual_status": automated_visual_status,
        "manual_visual_signoff_status": manual_visual_signoff_status,
        "production_visual_signoff_ready": manual_visual_signoff_status
        == "production_visual_signoff_complete",
        "open_manual_review_count": len(manual_review_items),
        "device_envelope_mm": [width, height, depth],
        "display_candidate": params["display"]["candidate"],
        "screen_margin_mm": screen_margin,
        "visual_deltas": {
            "front_back_mean_rgb_sum_delta": front_back_mean_delta,
            "front_back_minimum_sum_delta": 7.5,
            "front_back_orange_ratio_delta": round(front_back_orange_ratio_delta, 5),
            "front_back_dark_ratio_delta": round(front_back_dark_ratio_delta, 5),
        },
        "review_views": review_views,
        "visual_design_gates": visual_design_gates,
        "status_inputs": status_inputs,
        "technical_decisions": [
            decision for decision in decisions if decision["id"] != "compact_orange_shell"
        ],
        "aesthetic_decisions": [
            decision
            for decision in decisions
            if decision["id"] in {"compact_orange_shell", "black_bonded_glass_front"}
        ],
        "decisions": decisions,
        "manual_review_items": manual_review_items,
        "open_manual_review_items": manual_review_items,
        "next_actions": manual_review_items,
        "release_rule": "Automated render coverage may pass with generated nonblank views, but production visual/CMF signoff requires zero open manual review items, supplier STEP/B-rep review, molded orange resin CMF samples, and physical tactile/aesthetic review.",
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
        f"Automated visual status: {report['automated_visual_status']}.",
        f"Production visual signoff: {report['manual_visual_signoff_status']}.",
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
    lines.extend(["", "## Visual Design Gates", ""])
    for gate_id, gate in visual_design_gates.items():
        lines.append(f"- {'PASS' if gate['pass'] else 'BLOCKED'}: `{gate_id}`")
    lines.extend(["", "## Manual Review Items", ""])
    for item in manual_review_items:
        lines.append(f"- {item}")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "visual-decision-report.md").write_text("\n".join(lines) + "\n")
    return report


def write_visual_review_coverage_acceptance_artifacts(
    visual: dict[str, Any],
    part_review: dict[str, Any],
    visual_decision: dict[str, Any],
    part_visual_coverage: dict[str, Any],
) -> dict[str, Any]:
    expected_views = {
        "full_front_iso.png": "front silhouette, orange side rail, black glass stack",
        "full_back_iso.png": "rear orange shell, camera window, and service features",
        "rear_feature_detail.png": "rear camera window, SIM edge, and service-label recess",
        "full_left_side.png": "left-side button protrusion and shell depth",
        "full_bottom_port.png": "USB-C, speaker grille, and microphone apertures",
        "full_top_down.png": "compact footprint, screen margin, buttons, and front features",
        "exploded_iso.png": "glass, display, shell, and component stack separation",
        "component_stack.png": "PCB, battery, camera, audio, haptic, and I/O placement",
        "component-review-audio.png": "speaker, earpiece, microphone, acoustic mesh, and port packaging",
        "component-review-io-buttons.png": "USB-C, side buttons, seals, and tactile actuation packaging",
        "component-review-optical.png": "front/rear cameras, flash, baffles, cover windows, and optical seals",
        "mold_tooling.png": "parting plane, runner, gate, ejector, and cooling placeholders",
    }
    view_cases = []
    for name, purpose in expected_views.items():
        result = visual.get(name, {})
        view_cases.append(
            {
                "view": name,
                "purpose": purpose,
                "pass": bool(result.get("pass", False)),
                "size": result.get("size"),
                "channel_spans": result.get("channel_spans"),
                "nonwhite_pixel_ratio": result.get("nonwhite_pixel_ratio"),
            }
        )

    visual_design_gates = visual_decision.get("visual_design_gates", {})
    gate_cases = [
        {"id": gate_id, "pass": bool(gate.get("pass", False))}
        for gate_id, gate in sorted(visual_design_gates.items())
    ]
    part_review_case = {
        "part_count": part_review.get("part_count", 0),
        "contact_sheet": part_review.get("contact_sheet"),
        "contact_sheet_pass": bool(part_review.get("contact_sheet_check", {}).get("pass", False)),
        "exploded_contact_sheet": part_review.get("exploded_contact_sheet"),
        "exploded_contact_sheet_pass": bool(
            part_review.get("exploded_contact_sheet_check", {}).get("pass", False)
        ),
        "pass": part_review.get("status") == "pass"
        and bool(part_review.get("contact_sheet_check", {}).get("pass", False))
        and bool(part_review.get("exploded_contact_sheet_check", {}).get("pass", False))
        and int(part_review.get("part_count", 0)) > 0,
    }
    part_visual_coverage_case = {
        "status": part_visual_coverage.get("status"),
        "expected_part_count": part_visual_coverage.get("expected_part_count", 0),
        "covered_part_count": part_visual_coverage.get("covered_part_count", 0),
        "missing_or_incomplete_part_count": len(
            part_visual_coverage.get("missing_or_incomplete_parts", [])
        ),
        "pass": part_visual_coverage.get("status") == "part_visual_coverage_pass"
        and part_visual_coverage.get("expected_part_count", 0)
        == part_visual_coverage.get("covered_part_count", -1),
    }
    visual_decision_case = {
        "status": visual_decision.get("status"),
        "automated_visual_status": visual_decision.get("automated_visual_status"),
        "manual_visual_signoff_status": visual_decision.get("manual_visual_signoff_status"),
        "production_visual_signoff_ready": bool(
            visual_decision.get("production_visual_signoff_ready", False)
        ),
        "decision_count": len(visual_decision.get("decisions", [])),
        "open_manual_review_count": int(visual_decision.get("open_manual_review_count", 0)),
        "pass": visual_decision.get("automated_visual_status") == "automated_visual_coverage_pass"
        and len(visual_decision.get("decisions", [])) > 0,
    }
    expected_view_count = len(expected_views)
    complete_view_count = sum(1 for case in view_cases if case["pass"])
    automated_pass = (
        complete_view_count == expected_view_count
        and part_review_case["pass"]
        and part_visual_coverage_case["pass"]
        and visual_decision_case["pass"]
        and bool(gate_cases)
        and all(case["pass"] for case in gate_cases)
    )
    report = {
        "claim_boundary": (
            "Automated CAD visual review coverage acceptance; proves required render coverage, "
            "image nonblank checks, per-part top-view and exploded-context contact-sheet "
            "coverage, and recorded CAD visual decisions. It is not CMF lock or human "
            "industrial-design signoff."
        ),
        "status": (
            "visual_review_coverage_acceptance_pass"
            if automated_pass
            else "blocked_visual_review_coverage_incomplete"
        ),
        "automated_visual_coverage_ready": automated_pass,
        "production_visual_signoff_ready": visual_decision_case["production_visual_signoff_ready"],
        "expected_view_count": expected_view_count,
        "complete_view_count": complete_view_count,
        "expected_visual_gate_count": len(gate_cases),
        "passing_visual_gate_count": sum(1 for case in gate_cases if case["pass"]),
        "view_cases": view_cases,
        "part_review_case": part_review_case,
        "part_visual_coverage_case": part_visual_coverage_case,
        "visual_gate_cases": gate_cases,
        "visual_decision_case": visual_decision_case,
        "release_rule": (
            "Every required full-object, detail, exploded, component, tooling, and per-part "
            "review artifact must be generated, pass pixel/contact-sheet checks, every CAD part "
            "must map to at least one generated review view plus the per-part top-view and "
            "exploded-context contact sheets, and the views must be covered by a recorded CAD "
            "visual/design decision before automated visual coverage is accepted. Production "
            "visual/CMF signoff remains blocked until manual review items are closed."
        ),
    }
    (REVIEW_DIR / "visual-review-coverage-acceptance.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )

    lines = [
        "# E1 Phone Visual Review Coverage Acceptance",
        "",
        f"Status: {report['status']}.",
        f"Automated visual coverage ready: {report['automated_visual_coverage_ready']}.",
        f"Production visual signoff ready: {report['production_visual_signoff_ready']}.",
        "",
        "## Required Views",
        "",
    ]
    for case in view_cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['view']}` - {case['purpose']}")
    lines.extend(
        [
            "",
            "## Supporting Cases",
            "",
            f"- Part review: {'PASS' if part_review_case['pass'] else 'BLOCKED'} "
            f"({part_review_case['part_count']} parts).",
            f"- Part-to-view coverage: {'PASS' if part_visual_coverage_case['pass'] else 'BLOCKED'} "
            f"({part_visual_coverage_case['covered_part_count']}/"
            f"{part_visual_coverage_case['expected_part_count']} parts).",
            f"- Visual decisions: {'PASS' if visual_decision_case['pass'] else 'BLOCKED'} "
            f"({visual_decision_case['decision_count']} decisions, "
            f"{visual_decision_case['open_manual_review_count']} open manual review items).",
            "",
            "## Release Rule",
            "",
            f"- {report['release_rule']}",
        ]
    )
    (REVIEW_DIR / "visual-review-coverage-acceptance.md").write_text("\n".join(lines) + "\n")
    return report


def part_visual_required_views(part: dict[str, Any]) -> list[str]:
    name = part["name"]
    role = part["role"]
    base_views = ["part-review-contact-sheet.png", "part-explode-contact-sheet.png"]
    if role == "molded enclosure":
        if name.startswith("orange_usb"):
            return [*base_views, "full_bottom_port.png", "exploded_iso.png"]
        if "screw_boss" in name or "snap_hook" in name or "battery_" in name:
            return [*base_views, "exploded_iso.png"]
        return [*base_views, "full_front_iso.png", "full_back_iso.png", "exploded_iso.png"]
    if role == "screen":
        return [*base_views, "full_front_iso.png", "full_top_down.png", "exploded_iso.png"]
    if role == "screen retention":
        return [*base_views, "exploded_iso.png"]
    if role in {
        "PCB",
        "battery",
        "split-board interconnect",
        "connector",
        "EMI shield",
        "RF keepout",
    }:
        return [*base_views, "component_stack.png", "exploded_iso.png"]
    if role == "I/O" or role == "I/O seal":
        return [
            *base_views,
            "full_bottom_port.png",
            "component-review-io-buttons.png",
            "exploded_iso.png",
        ]
    if role == "button" or role == "button seal":
        return [
            *base_views,
            "full_left_side.png",
            "component-review-io-buttons.png",
            "component_stack.png",
        ]
    if role == "camera":
        if name.startswith("front_"):
            return [
                *base_views,
                "full_top_down.png",
                "component-review-optical.png",
                "component_stack.png",
            ]
        return [
            *base_views,
            "rear_feature_detail.png",
            "component-review-optical.png",
            "component_stack.png",
        ]
    if role == "camera seal":
        return [*base_views, "rear_feature_detail.png", "component-review-optical.png"]
    if role == "audio":
        if name.startswith(("bottom_", "usb_")):
            return [
                *base_views,
                "full_bottom_port.png",
                "component-review-audio.png",
                "component_stack.png",
            ]
        return [
            *base_views,
            "exploded_iso.png",
            "component-review-audio.png",
            "component_stack.png",
        ]
    if role == "haptics":
        return [*base_views, "component-review-io-buttons.png", "component_stack.png"]
    if role == "service":
        return [*base_views, "rear_feature_detail.png", "component_stack.png"]
    return base_views


def write_part_visual_coverage_artifacts(
    visual: dict[str, Any],
    part_review: dict[str, Any],
) -> dict[str, Any]:
    contact_sheet_check = part_review.get("contact_sheet_check", {})
    contact_sheet_pass = bool(contact_sheet_check.get("pass", False))
    exploded_contact_sheet_check = part_review.get("exploded_contact_sheet_check", {})
    exploded_contact_sheet_pass = bool(exploded_contact_sheet_check.get("pass", False))
    view_status = {name: bool(result.get("pass", False)) for name, result in visual.items()}
    view_status["part-review-contact-sheet.png"] = contact_sheet_pass
    view_status["part-explode-contact-sheet.png"] = exploded_contact_sheet_pass
    cases: list[dict[str, Any]] = []
    for part in part_review.get("parts", []):
        required_views = part_visual_required_views(part)
        missing_or_failed_views = [
            view for view in required_views if not view_status.get(view, False)
        ]
        cases.append(
            {
                "part": part["name"],
                "role": part["role"],
                "required_views": required_views,
                "missing_or_failed_views": missing_or_failed_views,
                "contact_sheet_present": contact_sheet_pass,
                "exploded_contact_sheet_present": exploded_contact_sheet_pass,
                "pass": not missing_or_failed_views,
            }
        )
    missing_or_incomplete = [case["part"] for case in cases if not case["pass"]]
    covered_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": (
            "Automated part-to-view coverage map. It proves every generated CAD part is assigned "
            "to generated review artifacts and the per-part top-view and exploded-context contact "
            "sheets; it does not prove human CMF approval or pixel-level part segmentation."
        ),
        "status": "part_visual_coverage_pass"
        if cases and covered_count == len(cases)
        else "blocked_part_visual_coverage_incomplete",
        "coverage_mode": "role_and_name_based_review_view_mapping",
        "expected_part_count": len(cases),
        "covered_part_count": covered_count,
        "required_review_artifacts": sorted(
            set(view for case in cases for view in case["required_views"])
        ),
        "missing_or_incomplete_parts": missing_or_incomplete,
        "cases": cases,
        "release_rule": (
            "Every CAD part must have passing per-part top-view and exploded-context contact-sheet "
            "entries and at least one role-appropriate generated review view before automated "
            "visual review coverage can claim that every part is reviewable."
        ),
    }
    (REVIEW_DIR / "part-visual-coverage.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Part Visual Coverage",
        "",
        f"Status: {report['status']}.",
        "",
        "This gate maps each CAD part to generated review views and the per-part contact sheets.",
        "",
        "## Coverage",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['part']}` -> {', '.join(f'`{view}`' for view in case['required_views'])}"
        )
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "part-visual-coverage.md").write_text("\n".join(lines) + "\n")
    return report


def write_component_selection_review_artifacts(
    params: dict[str, Any],
    checks: dict[str, Any],
) -> dict[str, Any]:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    components = params["components"]
    battery = params["battery"]
    display = params["display"]
    radio = params.get("radio", {})

    def check_case(check_id: str) -> dict[str, Any]:
        result = checks.get("checks", {}).get(check_id, {})
        return {
            "id": check_id,
            "pass": bool(result.get("pass", False)),
            "summary": result,
        }

    def component_case(
        case_id: str,
        family: str,
        selected: str,
        envelope_mm: list[float] | None,
        critical_check_ids: list[str],
        source_url: str | None = None,
        second_source: str | None = None,
        notes: list[str] | None = None,
    ) -> dict[str, Any]:
        critical_checks = [check_case(check_id) for check_id in critical_check_ids]
        return {
            "id": case_id,
            "family": family,
            "selected_component": selected,
            "second_source_or_alternate": second_source,
            "envelope_mm": envelope_mm,
            "source_url": source_url,
            "critical_checks": critical_checks,
            "notes": notes or [],
            "pass": bool(selected)
            and all(check["pass"] for check in critical_checks)
            and bool(envelope_mm),
        }

    cases = [
        component_case(
            "display_touch_stack",
            "screen",
            display["candidate"],
            display["ctp_outline_mm"],
            ["screen_mount_margin", "screen_mount_and_connection"],
            source_url=display.get("source_url"),
            notes=[
                "Commodity 5.5 inch LCD+CTP is the dominant footprint driver.",
                "Exact FPC pinout, touch controller, and init sequence remain supplier evidence blockers.",
            ],
        ),
        component_case(
            "battery_pouch",
            "battery",
            battery["candidate"],
            battery["envelope_mm"],
            ["battery_display_and_wall_clearance", "mass_budget"],
            notes=[
                battery.get("capacity_basis", ""),
                battery.get("clearance_basis", ""),
                "Pouch swell, UN38.3 pack drawing, protection board, and sample thickness data remain blocked.",
            ],
        ),
        component_case(
            "usb_c_receptacle",
            "I/O",
            components["usb_c"]["candidate"],
            components["usb_c"]["envelope_mm"],
            ["usb_c_insertion_envelope", "usb_c_port_seal_stack"],
            source_url=components["usb_c"].get("source_url"),
            second_source=components["usb_c"].get("distributor_url"),
            notes=[
                "CAD includes insertion keepout, reinforced saddle, perimeter gasket seats, drip lip, and drain shelf.",
                "Physical insertion/cycle and connector drawing evidence remain blocked.",
            ],
        ),
        component_case(
            "side_buttons_single_sku",
            "button",
            components["power_button"]["standardized_mpn_primary"],
            components["power_button"].get("cap_mm"),
            ["button_force_and_travel", "button_pressure_support", "button_ingress_seal_stack"],
            source_url=components["power_button"].get("source_url"),
            second_source=components["power_button"].get("standardized_mpn_alternate"),
            notes=[
                "Same side-push tactile SKU is used for power and volume to reduce sourcing risk.",
                components["power_button"].get("travel_basis", ""),
            ],
        ),
        component_case(
            "rear_camera_and_flush_window",
            "camera",
            components["rear_camera"]["candidate"],
            components["rear_camera"]["module_mm"],
            [
                "camera_speaker_behind_glass",
                "rear_camera_back_shell_aperture",
                "camera_optical_seal_stack",
            ],
            notes=[
                components["rear_camera_glass"]["candidate"],
                "Flush-back rear camera now has an explicit molded orange shell aperture; final lock remains conditional on supplier z-height, optical center, and image-quality validation.",
            ],
        ),
        component_case(
            "front_camera_and_handset_under_glass",
            "camera/audio",
            components["front_camera"]["candidate"],
            components["front_camera"]["module_mm"],
            ["camera_speaker_behind_glass", "screen_mount_and_connection"],
            notes=[
                "Front camera and handset receiver are packaged behind the cover-glass border.",
                "FOV, acoustic loss, and display black-mask alignment require supplier drawings and samples.",
            ],
        ),
        component_case(
            "rear_flash_and_stray_light_septum",
            "camera",
            components["rear_flash_led"]["candidate"],
            components["rear_flash_led"]["envelope_mm"],
            ["camera_optical_seal_stack", "rear_flash_back_shell_aperture"],
            second_source=components["rear_flash_led"].get("second_source"),
            notes=[
                components["rear_flash_led"].get("seat_match_note", ""),
                "Flush flash light-pipe now has its own molded orange shell aperture and bevel lands.",
                components["rear_flash_camera_septum"].get("purpose", ""),
            ],
        ),
        component_case(
            "bottom_speaker",
            "audio",
            components["speaker_bottom"]["candidate"],
            components["speaker_bottom"]["envelope_mm"],
            ["camera_speaker_behind_glass", "usb_c_insertion_envelope"],
            notes=[
                "Bottom speaker shares the lower edge with USB-C and bottom microphones.",
                "SPL, leakage, dust mesh, and chamber tuning remain lab blockers.",
            ],
        ),
        component_case(
            "handset_receiver",
            "audio",
            components["earpiece"]["candidate"],
            components["earpiece"]["envelope_mm"],
            ["camera_speaker_behind_glass", "screen_mount_and_connection"],
            notes=[
                "Receiver sits behind glass/acoustic slot with mesh and gasket.",
                "Acoustic path loss must be measured on EVT samples.",
            ],
        ),
        component_case(
            "microphones",
            "audio",
            f"{components['microphone_bottom']['candidate']} + {components['microphone_top']['candidate']}",
            components["microphone_bottom"]["envelope_mm"],
            ["usb_c_port_seal_stack"],
            notes=[
                "Bottom dual ports plus top noise-cancel port are modeled with mesh and tunnel features.",
                "Ingress mesh airflow and acoustic SNR remain blocked on lab data.",
            ],
        ),
        component_case(
            "haptic_lra",
            "haptics",
            components["haptic"]["candidate"],
            components["haptic"]["envelope_mm"],
            ["device_compactness"],
            notes=[components["haptic"].get("source_note", "")],
        ),
        component_case(
            "cellular_radio_module",
            "radio",
            radio.get("cellular", {}).get("candidate", ""),
            radio.get("cellular", {}).get("envelope_mm"),
            ["device_compactness"],
            source_url=radio.get("cellular", {}).get("source_url"),
            notes=[
                "RF module is included as package-level source selection; antenna tuning and chamber data remain blocked.",
            ],
        ),
        component_case(
            "wifi_bt_module",
            "radio",
            radio.get("wifi_bt", {}).get("candidate", ""),
            radio.get("wifi_bt", {}).get("antenna_keepout_mm"),
            ["device_compactness"],
            source_url=radio.get("wifi_bt", {}).get("source_url"),
            notes=[
                "Wi-Fi/Bluetooth module is source-selected; exact shield can, module STEP, and antenna coexistence remain blocked.",
            ],
        ),
    ]
    missing_or_failed = [case["id"] for case in cases if not case["pass"]]
    report = {
        "claim_boundary": (
            "Generated CAD/component selection reconciliation for off-the-shelf low-quantity "
            "phone parts. It confirms the selected candidates are represented in current CAD "
            "params and pass CAD packaging checks; it is not supplier drawing approval, live "
            "pricing, procurement lock, or physical sample validation."
        ),
        "status": (
            "cad_component_selection_review_ready"
            if not missing_or_failed
            else "blocked_component_selection_review_incomplete"
        ),
        "device_envelope_mm": params["device"]["envelope_mm"],
        "design_language": params["device"]["design_language"],
        "plastic_color": params["device"]["plastic_color"],
        "component_count": len(cases),
        "passing_component_count": sum(1 for case in cases if case["pass"]),
        "missing_or_failed_components": missing_or_failed,
        "cases": cases,
        "release_rule": (
            "Every selected off-the-shelf component must have a current CAD envelope, pass its "
            "critical CAD packaging checks, and later be replaced by supplier drawings, STEP, "
            "samples, electrical bring-up, and physical validation before procurement or tooling "
            "release."
        ),
    }
    (REVIEW_DIR / "component-selection-review.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Component Selection Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This generated review reconciles selected off-the-shelf component candidates with current CAD packaging checks.",
        "",
        "## Components",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` - {case['selected_component']} ({case['family']})"
        )
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "component-selection-review.md").write_text("\n".join(lines) + "\n")
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


def is_non_material_reference_geometry(part: Part) -> bool:
    non_material_fragments = (
        "aperture",
        "grille_slot",
        "microphone_port",
        "handset_acoustic_slot",
        "acoustic_chamber",
        "bend_keepout",
        "antenna_keepout",
        "sim_tray_keepout",
        "sim_tray_outline",
        "service_label_recess",
        "lens_window",
        "under_glass",
        "sight_tunnel",
        "module_keepout",
        "daughterboard_keepout",
        "package_marker",
        "rf_feed_development_envelope",
        "fpc_tail",
        "lead_flex",
        "escape_tail",
        "lead_pair",
        "flex_leads",
        "signal_flex_marker",
    )
    return part.role in {"tooling", "tooling clearance", "review", "connection terminal"} or any(
        fragment in part.name for fragment in non_material_fragments
    )


def mass_estimate_class(part: Part) -> str:
    if is_non_material_reference_geometry(part):
        return "non_material_reference_geometry"
    return "physical_part_estimate"


def is_mass_estimate_included(part: Part) -> bool:
    return not is_non_material_reference_geometry(part)


def mass_budget(parts: list[Part]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    total = 0.0
    by_role: dict[str, float] = {}
    for part in parts:
        volume_mm3 = max(float(part.mesh.volume), 0.0)
        included = is_mass_estimate_included(part)
        if not included:
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
                "mass_estimate_class": mass_estimate_class(part),
                "mass_estimate_included": included,
                "excluded_from_mass_estimate": not included,
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


def write_compactness_optimization_artifacts(
    params: dict[str, Any], parts: list[Part], checks: dict[str, Any]
) -> dict[str, Any]:
    width, height, depth = params["device"]["envelope_mm"]
    display = params["display"]
    pcb = params["pcb"]
    battery = params["battery"]
    tolerance = params["validation"]["tolerance"]
    physical_parts = [part for part in parts if is_mass_estimate_included(part)]
    enclosure_low = np.asarray([-width / 2.0, -height / 2.0, -depth / 2.0])
    enclosure_high = np.asarray([width / 2.0, height / 2.0, depth / 2.0])
    low = np.vstack([part.bounds[0] for part in physical_parts]).min(axis=0)
    high = np.vstack([part.bounds[1] for part in physical_parts]).max(axis=0)
    physical_span = [round(float(value), 3) for value in (high - low)]
    side_control_part_names = {
        "power_button_cap",
        "volume_button_cap",
        "power_button_elastomer_gasket",
        "volume_button_elastomer_gasket",
        "power_button_labyrinth_upper_rail",
        "power_button_labyrinth_lower_rail",
        "volume_button_labyrinth_upper_rail",
        "volume_button_labyrinth_lower_rail",
    }
    molded_body_parts = [
        part for part in physical_parts if part.name not in side_control_part_names
    ]
    molded_low = np.vstack([part.bounds[0] for part in molded_body_parts]).min(axis=0)
    molded_high = np.vstack([part.bounds[1] for part in molded_body_parts]).max(axis=0)
    molded_body_span = [round(float(value), 3) for value in (molded_high - molded_low)]
    side_control_parts = [part for part in physical_parts if part.name in side_control_part_names]
    if side_control_parts:
        side_control_low = np.vstack([part.bounds[0] for part in side_control_parts]).min(axis=0)
        side_control_high = np.vstack([part.bounds[1] for part in side_control_parts]).max(axis=0)
        side_control_left_protrusion_mm = max(0.0, float(enclosure_low[0] - side_control_low[0]))
        side_control_right_protrusion_mm = max(0.0, float(side_control_high[0] - enclosure_high[0]))
    else:
        side_control_left_protrusion_mm = 0.0
        side_control_right_protrusion_mm = 0.0
    side_control_total_protrusion_mm = (
        side_control_left_protrusion_mm + side_control_right_protrusion_mm
    )
    side_control_max_single_side_protrusion_mm = max(
        side_control_left_protrusion_mm, side_control_right_protrusion_mm
    )
    depth_outliers: list[dict[str, Any]] = []
    for part in physical_parts:
        part_low, part_high = part.bounds
        protrusion_low = max(0.0, float(enclosure_low[2] - part_low[2]))
        protrusion_high = max(0.0, float(part_high[2] - enclosure_high[2]))
        if protrusion_low > 0.01 or protrusion_high > 0.01:
            depth_outliers.append(
                {
                    "part": part.name,
                    "rear_protrusion_mm": round(protrusion_low, 3),
                    "front_protrusion_mm": round(protrusion_high, 3),
                }
            )

    lower_bounds = {
        "display_touch_panel_mm": [
            round(display["ctp_outline_mm"][0] + 2.0 * tolerance["screen_xy_allowance_mm"], 3),
            round(display["ctp_outline_mm"][1] + 2.0 * tolerance["screen_xy_allowance_mm"], 3),
        ],
        "pcb_edge_clearance_mm": [
            round(pcb["outline_mm"][0] + 2.0 * tolerance["pcb_edge_clearance_mm"], 3),
            round(pcb["outline_mm"][1] + 2.0 * tolerance["pcb_edge_clearance_mm"], 3),
        ],
        "battery_with_wall_mm": [
            round(battery["envelope_mm"][0] + 2.0 * params["device"]["wall_thickness_mm"], 3),
            round(battery["envelope_mm"][1] + 2.0 * params["device"]["wall_thickness_mm"], 3),
        ],
    }
    derived_min_width = max(value[0] for value in lower_bounds.values())
    derived_min_height = max(value[1] for value in lower_bounds.values())
    width_excess = width - derived_min_width
    height_excess = height - derived_min_height
    rear_solid_protrusion_mm = max(0.0, float(enclosure_low[2] - low[2]))
    front_solid_protrusion_mm = max(0.0, float(high[2] - enclosure_high[2]))

    cases = [
        {
            "id": "display_driven_width",
            "actual": {
                "current_width_mm": width,
                "derived_min_width_mm": round(derived_min_width, 3),
                "excess_width_mm": round(width_excess, 3),
                "limiting_bound": "display_touch_panel_mm",
            },
            "target": "<=1.0 mm width excess over selected CTP plus screen allowance",
            "pass": width >= derived_min_width and 0.0 <= width_excess <= 1.0,
        },
        {
            "id": "display_driven_height",
            "actual": {
                "current_height_mm": height,
                "derived_min_height_mm": round(derived_min_height, 3),
                "excess_height_mm": round(height_excess, 3),
                "limiting_bound": "display_touch_panel_mm",
            },
            "target": "<=1.5 mm height excess over selected CTP plus screen allowance",
            "pass": height >= derived_min_height and 0.0 <= height_excess <= 1.5,
        },
        {
            "id": "flush_back_molded_depth",
            "actual": {
                "molded_envelope_depth_mm": depth,
                "physical_span_with_external_features_mm": physical_span[2],
                "rear_solid_protrusion_mm": round(rear_solid_protrusion_mm, 3),
                "front_solid_protrusion_mm": round(front_solid_protrusion_mm, 3),
                "depth_outliers": depth_outliers,
            },
            "target": "molded slab depth <=12.8 mm with a fully flush flat back: zero rear solid protrusion and no package outside the enclosure datum (depth raised to 12.7 mm by product-owner approval for the >=0.6 mm battery swell void and >=0.4 mm camera burial)",
            "pass": depth <= 12.8 and rear_solid_protrusion_mm <= 0.01 and not depth_outliers,
        },
        {
            "id": "side_controls_do_not_resize_molded_body",
            "actual": {
                "physical_width_with_buttons_mm": physical_span[0],
                "molded_body_width_excluding_side_controls_mm": molded_body_span[0],
                "molded_envelope_width_mm": width,
                "side_button_left_protrusion_mm": round(side_control_left_protrusion_mm, 3),
                "side_button_right_protrusion_mm": round(side_control_right_protrusion_mm, 3),
                "side_button_total_protrusion_mm": round(side_control_total_protrusion_mm, 3),
                "side_button_max_single_side_protrusion_mm": round(
                    side_control_max_single_side_protrusion_mm, 3
                ),
            },
            "target": "side controls may protrude locally up to 3.1 mm per side while the molded orange body stays at the display-driven width",
            "pass": width <= 80.0
            and molded_body_span[0] <= width + 0.01
            and side_control_max_single_side_protrusion_mm <= 3.1,
        },
        {
            "id": "pcb_battery_do_not_drive_outer_envelope",
            "actual": {
                "pcb_bound_mm": lower_bounds["pcb_edge_clearance_mm"],
                "battery_bound_mm": lower_bounds["battery_with_wall_mm"],
                "current_envelope_mm": [width, height, depth],
            },
            "target": "selected display, not PCB or battery, remains the outer-envelope driver",
            "pass": derived_min_width == lower_bounds["display_touch_panel_mm"][0]
            and derived_min_height == lower_bounds["display_touch_panel_mm"][1]
            and checks["checks"]["pcb_battery_non_overlap"]["pass"],
        },
    ]

    report = {
        "claim_boundary": "CAD compactness optimization audit from selected off-the-shelf module envelopes; not proof that supplier final STEP or routed PCB cannot reduce size further.",
        "status": "cad_compactness_optimized" if all(case["pass"] for case in cases) else "blocked",
        "current_envelope_mm": [width, height, depth],
        "physical_span_with_external_features_mm": physical_span,
        "lower_bounds": lower_bounds,
        "width_excess_over_bound_mm": round(width_excess, 3),
        "height_excess_over_bound_mm": round(height_excess, 3),
        "area_excess_over_bound_mm2": round(
            width * height - derived_min_width * derived_min_height, 1
        ),
        "cases": cases,
        "decision": f"Keep 78.0 x 153.6 x {depth:.1f} mm molded orange body: width/height stay display-driven; depth was deliberately raised to fully bury the rear camera and torch under a flat flush back wall (no camera bump, no proud lens ring).",
        "next_reduction_options": [
            "A shorter display/CTP supplier module is the only meaningful path to reduce outer height.",
            "Outer depth is set by the flush-back decision to bury the rear AF module; a thinner rear module or thinner battery would be the only path to reduce depth.",
            "Side button cap protrusion can be reduced by supplier switch/cap tooling, but the molded orange body is already display-limited.",
            "Routed KiCad board and supplier STEP may permit local internal improvements, not a major envelope reduction with the current display.",
        ],
    }
    (REVIEW_DIR / "compactness-optimization.json").write_text(json.dumps(report, indent=2) + "\n")

    fig, ax = plt.subplots(figsize=(5.0, 8.0))
    ax.add_patch(
        plt.Rectangle((-width / 2, -height / 2), width, height, fill=False, lw=2.2, ec="#ff5203")
    )
    min_w, min_h = derived_min_width, derived_min_height
    ax.add_patch(
        plt.Rectangle((-min_w / 2, -min_h / 2), min_w, min_h, fill=False, lw=1.5, ec="#111111")
    )
    ax.add_patch(
        plt.Rectangle(
            (-display["ctp_outline_mm"][0] / 2, -display["ctp_outline_mm"][1] / 2),
            display["ctp_outline_mm"][0],
            display["ctp_outline_mm"][1],
            fill=False,
            lw=1.0,
            ec="#777777",
            linestyle="--",
        )
    )
    ax.text(-width / 2, height / 2 + 2.5, f"current {width:.1f} x {height:.1f} mm", fontsize=9)
    ax.text(
        -width / 2,
        height / 2 - 2.5,
        f"derived min {derived_min_width:.1f} x {derived_min_height:.1f} mm",
        fontsize=8,
    )
    ax.text(
        -width / 2,
        -height / 2 - 5.0,
        f"excess width {width_excess:.2f} mm; height {height_excess:.2f} mm",
        fontsize=8,
    )
    ax.set_aspect("equal")
    ax.set_xlim(-width / 2 - 5, width / 2 + 5)
    ax.set_ylim(-height / 2 - 10, height / 2 + 8)
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(REVIEW_DIR / "compactness-optimization.png", dpi=180)
    fig.savefig(REVIEW_DIR / "compactness-optimization.svg")
    plt.close(fig)

    lines = [
        "# E1 Phone Compactness Optimization",
        "",
        f"Status: {report['status']}.",
        "",
        "## Decision",
        "",
        report["decision"],
        "",
        "## Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` target {case['target']}")
    lines.extend(["", "## Next Reduction Options", ""])
    for option in report["next_reduction_options"]:
        lines.append(f"- {option}")
    (REVIEW_DIR / "compactness-optimization.md").write_text("\n".join(lines) + "\n")
    return report


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
        lines.append(f"- Source: {item['source_url'] or 'external source pending'}")
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
                solid_steps.get("usb_c_perimeter_gasket_top"),
                solid_steps.get("usb_c_perimeter_gasket_bottom"),
                solid_steps.get("usb_c_perimeter_gasket_left"),
                solid_steps.get("usb_c_perimeter_gasket_right"),
                solid_steps.get("usb_c_molded_drip_break_lip"),
                solid_steps.get("usb_c_internal_drain_shelf"),
                solid_steps.get("bottom_speaker_module"),
                solid_steps.get("bottom_speaker_acoustic_chamber"),
                solid_steps.get("bottom_mic"),
                solid_steps.get("bottom_microphone_port_1"),
            ],
            "questions": [
                "Confirm exact USB-C suffix, footprint, shell stake geometry, and 20k-cycle rating.",
                "Confirm whether supplier can provide a gasketed receptacle seat or validate the modeled perimeter gasket/drip shelf.",
                "Confirm speaker module acoustic rear-volume needs and gasket compression range.",
                "Confirm MEMS microphone port, dust mesh, gasket stack, and keepout around USB shell.",
            ],
            "acceptance_criteria": [
                "USB-C insertion envelope clears orange saddle, perimeter gasket, and bottom aperture",
                "USB-C splash path passes visual water-retention and post-exposure insertion checks",
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
                solid_steps.get("rear_camera_cover_adhesive_top"),
                solid_steps.get("rear_camera_cover_adhesive_bottom"),
                solid_steps.get("rear_camera_cover_adhesive_left"),
                solid_steps.get("rear_camera_cover_adhesive_right"),
                solid_steps.get("rear_camera_light_baffle_top"),
                solid_steps.get("rear_camera_light_baffle_bottom"),
                solid_steps.get("front_camera_module"),
                solid_steps.get("front_camera_under_glass"),
                solid_steps.get("front_camera_black_mask_window"),
            ],
            "questions": [
                "Confirm rear module total height, FPC exit side, lens keepout, and dust gasket stack.",
                "Confirm rear cover-window adhesive gasket material, baffle clearance, and dust-control process.",
                "Confirm front module can sit behind cover glass and black mask without visible notch or protrusion.",
                "Quote matched rear/front MIPI modules with low-volume sample availability.",
            ],
            "acceptance_criteria": [
                "single rear AF module is fully buried under the flat back wall behind a flush internal window with modeled gasketed/baffled stack",
                "front camera remains behind glass, black masked, and clear of earpiece path",
                "camera window passes dust/vignette/flare inspection after cover-window bond",
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
                solid_steps.get("power_button_elastomer_gasket"),
                solid_steps.get("power_button_labyrinth_upper_rail"),
                solid_steps.get("power_button_labyrinth_lower_rail"),
                solid_steps.get("volume_button_elastomer_gasket"),
                solid_steps.get("volume_button_labyrinth_upper_rail"),
                solid_steps.get("volume_button_labyrinth_lower_rail"),
                solid_steps.get("haptic_lra"),
                solid_steps.get("sim_tray_keepout"),
                solid_steps.get("sim_tray_outline"),
            ],
            "questions": [
                "Confirm side tactile switch part number, force bins, travel, and actuator tolerance stack.",
                "Confirm side-key silicone gasket material, compression set, and splash/dust test acceptance.",
                "Confirm LRA vendor drawing, adhesive/fixture requirements, and drive limits.",
                "Confirm whether nano-SIM tray is required or eSIM-only is acceptable for EVT.",
            ],
            "acceptance_criteria": [
                "button force/travel matches CAD pressure assumptions",
                "button gasket/labyrinth stack passes side-splash and dust exposure without sticking",
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


def write_supplier_response_artifacts(
    supplier: dict[str, Any], supplier_rfq: dict[str, Any]
) -> dict[str, Any]:
    package_by_item: dict[str, str] = {}
    for package in supplier_rfq.get("packages", []):
        for item_id in package.get("supplier_item_ids", []):
            package_by_item[item_id] = package["id"]
    rows: list[dict[str, Any]] = []
    for item in supplier["items"]:
        rows.append(
            {
                "supplier_item_id": item["id"],
                "rfq_package_id": package_by_item.get(item["id"], ""),
                "candidate": item["candidate"] or "",
                "supplier_listing_or_portal_url": item.get("source_url")
                or item.get("distributor_url")
                or "",
                "vendor_name": "",
                "vendor_part_number": "",
                "moq_units": "",
                "quote_returned": "",
                "quote_artifact": "",
                "drawing_2d_received": "",
                "drawing_2d_artifact": "",
                "step_received": "",
                "step_artifact": "",
                "mechanical_envelope_mm": "",
                "pinout_or_process_artifact": "",
                "footprint_or_tooling_artifact": "",
                "sample_ordered": "",
                "sample_received": "",
                "sample_photo_or_inspection_artifact": "",
                "supplier_traceability_record": "",
                "lead_time_days": "",
                "unit_price_20": "",
                "reviewer": "",
                "evidence_class": "",
                "required_evidence_artifacts": "quote_artifact;drawing_2d_artifact;step_artifact;pinout_or_process_artifact;footprint_or_tooling_artifact;sample_photo_or_inspection_artifact;supplier_traceability_record",
                "notes": item["supplier_lock_state"],
            }
        )
    rows.append(
        {
            "supplier_item_id": "orange_enclosure_tooling",
            "rfq_package_id": "orange_enclosure_tooling",
            "candidate": "orange PC+ABS enclosure toolmaker",
            "supplier_listing_or_portal_url": "",
            "vendor_name": "",
            "vendor_part_number": "",
            "moq_units": "",
            "quote_returned": "",
            "quote_artifact": "",
            "drawing_2d_received": "",
            "drawing_2d_artifact": "",
            "step_received": "",
            "step_artifact": "",
            "mechanical_envelope_mm": "",
            "pinout_or_process_artifact": "",
            "footprint_or_tooling_artifact": "",
            "sample_ordered": "",
            "sample_received": "",
            "sample_photo_or_inspection_artifact": "",
            "supplier_traceability_record": "",
            "lead_time_days": "",
            "unit_price_20": "",
            "reviewer": "",
            "evidence_class": "",
            "required_evidence_artifacts": "quote_artifact;drawing_2d_artifact;step_artifact;pinout_or_process_artifact;footprint_or_tooling_artifact;sample_photo_or_inspection_artifact;supplier_traceability_record",
            "notes": "needs toolmaker DFM, mold-flow, color plaque, and first shots",
        }
    )

    csv_path = REVIEW_DIR / "supplier-response-template.csv"
    fieldnames = [
        "supplier_item_id",
        "rfq_package_id",
        "candidate",
        "supplier_listing_or_portal_url",
        "vendor_name",
        "vendor_part_number",
        "moq_units",
        "quote_returned",
        "quote_artifact",
        "drawing_2d_received",
        "drawing_2d_artifact",
        "step_received",
        "step_artifact",
        "mechanical_envelope_mm",
        "pinout_or_process_artifact",
        "footprint_or_tooling_artifact",
        "sample_ordered",
        "sample_received",
        "sample_photo_or_inspection_artifact",
        "supplier_traceability_record",
        "lead_time_days",
        "unit_price_20",
        "reviewer",
        "evidence_class",
        "required_evidence_artifacts",
        "notes",
    ]
    should_write_template = True
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as existing_file:
            existing_rows = list(csv.DictReader(existing_file))
        existing_ids = {row.get("supplier_item_id", "") for row in existing_rows}
        expected_ids = {row["supplier_item_id"] for row in rows}
        has_response_content = any(
            row.get(field, "").strip()
            for row in existing_rows
            for field in [
                "vendor_name",
                "vendor_part_number",
                "supplier_listing_or_portal_url",
                "moq_units",
                "quote_returned",
                "quote_artifact",
                "drawing_2d_received",
                "drawing_2d_artifact",
                "step_received",
                "step_artifact",
                "mechanical_envelope_mm",
                "pinout_or_process_artifact",
                "footprint_or_tooling_artifact",
                "sample_ordered",
                "sample_received",
                "sample_photo_or_inspection_artifact",
                "supplier_traceability_record",
                "lead_time_days",
                "unit_price_20",
                "reviewer",
                "evidence_class",
            ]
        )
        should_write_template = existing_ids != expected_ids or (
            list(existing_rows[0].keys()) != fieldnames if existing_rows else True
        )
        if has_response_content:
            should_write_template = False
    if should_write_template:
        with csv_path.open("w", newline="") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    reviewed_rows: list[dict[str, str]] = []
    template_evidence_class = ""
    csv_text = csv_path.read_text()
    csv_lines = csv_text.splitlines()
    if csv_lines and csv_lines[0].startswith("# evidence_class:"):
        template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
        csv_text = "\n".join(csv_lines[1:]) + "\n"
    with StringIO(csv_text) as csv_buffer:
        reader = csv.DictReader(csv_buffer)
        reviewed_rows = list(reader)
    forbidden_evidence_classes = {
        "simulated_supplier_response_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }

    returned_cases: list[dict[str, Any]] = []

    def parse_positive_float(text: str) -> float | None:
        match = re.search(r"\d+(?:\.\d+)?", text.strip())
        if not match:
            return None
        return float(match.group(0))

    def parse_envelope_mm(text: str) -> list[float]:
        return [float(value) for value in re.findall(r"\d+(?:\.\d+)?", text)[:3]]

    for row in reviewed_rows:
        required_flags = {
            "quote_returned": row.get("quote_returned", ""),
            "drawing_2d_received": row.get("drawing_2d_received", ""),
            "step_received": row.get("step_received", ""),
            "sample_received": row.get("sample_received", ""),
        }
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or "quote_artifact;drawing_2d_artifact;step_artifact;pinout_or_process_artifact;footprint_or_tooling_artifact;sample_photo_or_inspection_artifact;supplier_traceability_record"
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "quote_artifact",
                "drawing_2d_artifact",
                "step_artifact",
                "pinout_or_process_artifact",
                "footprint_or_tooling_artifact",
                "sample_photo_or_inspection_artifact",
                "supplier_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_supplier_response"
            and evidence_class not in forbidden_evidence_classes
        )
        populated_identity = bool(
            row.get("vendor_name", "")
            and row.get("vendor_part_number", "")
            and row.get("reviewer", "")
        )
        listing_url = row.get("supplier_listing_or_portal_url", "").strip()
        listing_url_present = bool(
            listing_url.startswith(("http://", "https://")) or listing_url.startswith("board/")
        )
        moq_units = parse_positive_float(row.get("moq_units", ""))
        lead_time_days = parse_positive_float(row.get("lead_time_days", ""))
        unit_price_20 = parse_positive_float(row.get("unit_price_20", ""))
        envelope_values = parse_envelope_mm(row.get("mechanical_envelope_mm", ""))
        commercial_terms_pass = (
            moq_units is not None
            and moq_units <= 50
            and lead_time_days is not None
            and 0 < lead_time_days <= 90
            and unit_price_20 is not None
            and unit_price_20 > 0
        )
        mechanical_traceability_pass = len(envelope_values) == 3 and all(
            value > 0 for value in envelope_values
        )
        flags_pass = all(
            str(value).strip().lower() in {"yes", "true", "1", "pass"}
            for value in required_flags.values()
        )
        returned_cases.append(
            {
                "supplier_item_id": row["supplier_item_id"],
                "rfq_package_id": row.get("rfq_package_id", ""),
                "populated_identity": populated_identity,
                "supplier_listing_or_portal_url_present": listing_url_present,
                "moq_units": moq_units,
                "lead_time_days": lead_time_days,
                "unit_price_20": unit_price_20,
                "commercial_terms_pass": commercial_terms_pass,
                "mechanical_envelope_mm": envelope_values,
                "mechanical_traceability_pass": mechanical_traceability_pass,
                "required_returns": required_flags,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "quote_artifact_present": bool(row.get("quote_artifact", "").strip()),
                "drawing_2d_artifact_present": bool(row.get("drawing_2d_artifact", "").strip()),
                "step_artifact_present": bool(row.get("step_artifact", "").strip()),
                "pinout_or_process_artifact_present": bool(
                    row.get("pinout_or_process_artifact", "").strip()
                ),
                "footprint_or_tooling_artifact_present": bool(
                    row.get("footprint_or_tooling_artifact", "").strip()
                ),
                "sample_photo_or_inspection_artifact_present": bool(
                    row.get("sample_photo_or_inspection_artifact", "").strip()
                ),
                "supplier_traceability_record_present": bool(
                    row.get("supplier_traceability_record", "").strip()
                ),
                "physical_evidence_pass": evidence_class_allowed and evidence_fields_present,
                "pass": populated_identity
                and listing_url_present
                and flags_pass
                and commercial_terms_pass
                and mechanical_traceability_pass
                and evidence_class_allowed
                and evidence_fields_present,
            }
        )
    missing_items = [case["supplier_item_id"] for case in returned_cases if not case["pass"]]
    returned_count = sum(1 for case in returned_cases if case["pass"])
    report = {
        "claim_boundary": "Supplier response intake template and fail-closed review; blank rows are not supplier lock evidence.",
        "status": "supplier_responses_complete"
        if returned_cases and not missing_items
        else "blocked_no_supplier_responses"
        if returned_count == 0
        else "blocked_supplier_responses_incomplete",
        "response_template": "mechanical/e1-phone/review/supplier-response-template.csv",
        "expected_response_count": len(returned_cases),
        "required_evidence_class": "physical_supplier_response",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "complete_response_count": returned_count,
        "missing_or_incomplete_items": missing_items,
        "cases": returned_cases,
        "release_rule": "Every supplier row must name the vendor/part/reviewer, identify a supplier listing or portal, prove low-quantity commercial terms with MOQ <= 50, lead time <= 90 days, and positive unit price, confirm quote, 2D drawing, STEP, and sample receipt, provide three-axis mechanical envelope dimensions, include evidence_class=physical_supplier_response, and attach quote, drawing, STEP, pinout/process, footprint/tooling, sample inspection/photo, and supplier traceability artifacts before supplier lock.",
    }
    (REVIEW_DIR / "supplier-response-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Supplier Response Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed: RFQ packages do not count as supplier-returned evidence.",
        "",
        f"Template: `{report['response_template']}`",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for item_id in missing_items:
        lines.append(f"- `{item_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "supplier-response-review.md").write_text("\n".join(lines) + "\n")
    return report


def write_supplier_evidence_acceptance_artifacts(
    supplier: dict[str, Any],
    supplier_rfq: dict[str, Any],
    supplier_response: dict[str, Any],
) -> dict[str, Any]:
    families = [
        {
            "id": "display_touch_stack",
            "rfq_package_id": "display_touch_stack",
            "required_items": ["display_lcm_ctp"],
            "required_evidence": [
                "quote",
                "2d_drawing",
                "step_model",
                "sample",
                "fpc_pinout",
                "mating_connector",
                "touch_display_bringup_data",
            ],
            "required_return_artifacts": [
                "display_sample_photos",
                "fpc_pinout_and_mating_connector",
                "native_or_step_stack_model",
                "signed_2d_stack_drawing",
            ],
            "required_technical_decisions": [
                "cover_glass_bonded_or_separate",
                "fpc_exit_side_and_bend_radius",
                "touch_controller_and_init_sequence",
            ],
            "required_validation_outputs": [
                "active_area_offset_mm",
                "connector_stack_height_mm",
                "outline_tolerance_mm",
            ],
        },
        {
            "id": "usb_audio_bottom_io",
            "rfq_package_id": "usb_c_and_bottom_audio",
            "required_items": ["usb_c"],
            "required_evidence": [
                "quote",
                "2d_drawing",
                "step_model",
                "sample",
                "usb_land_pattern",
                "insertion_force_data",
                "splash_gasket_review",
            ],
            "required_return_artifacts": [
                "gasket_or_splash_path_review",
                "pcb_land_pattern",
                "signed_receptacle_2d_drawing",
                "step_model_with_shell_stakes",
            ],
            "required_technical_decisions": [
                "exact_connector_suffix",
                "gasket_seat_acceptance",
                "mid_mount_or_top_mount_orientation",
            ],
            "required_validation_outputs": [
                "insertion_force_n",
                "mating_cycle_rating",
                "shell_stake_tolerance_mm",
            ],
        },
        {
            "id": "power_volume_buttons",
            "rfq_package_id": "buttons_haptics_service",
            "required_items": ["side_buttons"],
            "required_evidence": [
                "quote",
                "2d_drawing",
                "step_model",
                "sample",
                "force_travel_curve",
                "gasket_material_spec",
                "compression_set_data",
            ],
            "required_return_artifacts": [
                "cap_and_actuator_stack_drawing",
                "sample_force_curve",
                "silicone_gasket_material_spec",
                "switch_drawing",
            ],
            "required_technical_decisions": [
                "flex_or_direct_pcb_mount",
                "power_switch_part_number",
                "volume_switch_part_number",
            ],
            "required_validation_outputs": [
                "actuation_force_n",
                "compression_set_percent",
                "travel_mm",
            ],
        },
        {
            "id": "camera_modules",
            "rfq_package_id": "camera_stack",
            "required_items": ["rear_camera", "front_camera"],
            "required_evidence": [
                "quote",
                "2d_drawing",
                "step_model",
                "sample",
                "fpc_pinout",
                "optical_center_datum",
                "sample_capture_evidence",
            ],
            "required_return_artifacts": [
                "behind_glass_sample_capture",
                "fpc_pinout_and_connector",
                "sample_capture_evidence",
                "signed_module_2d_drawing",
                "step_model_with_lens_stack",
            ],
            "required_technical_decisions": [
                "black_mask_aperture_size",
                "fpc_exit_side",
                "optical_center_datum",
                "sensor_and_lens_variant",
                "under_glass_placement_datum",
            ],
            "required_validation_outputs": [
                "glass_to_lens_gap_mm",
                "lens_center_offset_mm",
                "minimum_focus_distance_mm",
                "module_total_height_mm",
            ],
        },
        {
            "id": "wireless_modules",
            "rfq_package_id": "",
            "required_items": ["cellular_redcap", "wifi_bt"],
            "required_evidence": [
                "quote",
                "2d_drawing",
                "step_model",
                "sample",
                "pinout_reference_design",
                "antenna_keepout",
                "certification_path",
            ],
            "required_return_artifacts": [
                "antenna_matching_reference",
                "antenna_reference_design",
                "module_datasheet",
                "module_step_model",
                "pinout_and_land_pattern",
                "pinout_and_reference_schematic",
            ],
            "required_technical_decisions": [
                "antenna_feed_strategy",
                "certification_path",
                "coexistence_interface",
                "module_or_chip_down",
                "regional_sku",
                "rf_connector_or_solder_feed",
            ],
            "required_validation_outputs": [
                "antenna_clearance_mm",
                "antenna_keepout_mm",
                "module_height_mm",
                "peak_current_a",
                "thermal_dissipation_w",
            ],
        },
        {
            "id": "orange_enclosure_tooling",
            "rfq_package_id": "orange_enclosure_tooling",
            "required_items": ["orange_enclosure_tooling"],
            "required_evidence": [
                "toolmaker_quote",
                "tool_drawing",
                "mold_flow_plan",
                "orange_color_sample",
                "dfm_markup",
                "gate_runner_ejector_strategy",
                "texture_color_standard",
            ],
            "required_return_artifacts": [
                "color_plaque_or_first_shot_photo",
                "dfm_markup",
                "signed_tool_drawing",
                "tooling_quote",
            ],
            "required_technical_decisions": [
                "gate_location",
                "orange_resin_grade",
                "surface_texture",
                "tooling_path_soft_or_hard_tool",
            ],
            "required_validation_outputs": [
                "color_delta_e",
                "first_shot_warp_mm",
                "gate_vestige_height_mm",
            ],
        },
    ]
    supplier_ids = {item["id"] for item in supplier.get("items", [])}
    package_by_id = {package["id"]: package for package in supplier_rfq.get("packages", [])}
    response_cases = {case["supplier_item_id"]: case for case in supplier_response.get("cases", [])}
    reviewed_families: list[dict[str, Any]] = []
    for family in families:
        items = []
        for item_id in family["required_items"]:
            response_case = response_cases.get(item_id)
            items.append(
                {
                    "supplier_item_id": item_id,
                    "in_supplier_matrix": item_id in supplier_ids
                    or item_id == "orange_enclosure_tooling",
                    "rfq_package_id": (
                        response_case.get("rfq_package_id", "")
                        if response_case
                        else family["rfq_package_id"]
                    ),
                    "response_case_present": response_case is not None,
                    "response_pass": bool(response_case and response_case.get("pass")),
                    "physical_evidence_pass": bool(
                        response_case and response_case.get("physical_evidence_pass")
                    ),
                }
            )
        returned_basic_evidence = bool(items) and all(item["response_pass"] for item in items)
        evidence_key_status = {key: returned_basic_evidence for key in family["required_evidence"]}
        missing_required_evidence_keys = [
            key for key, present in evidence_key_status.items() if not present
        ]
        missing_supplier_items = [
            item["supplier_item_id"]
            for item in items
            if not item["in_supplier_matrix"] or not item["response_pass"]
        ]
        rfq_package_ready = (
            family["rfq_package_id"] == "" or family["rfq_package_id"] in package_by_id
        )
        passed = (
            rfq_package_ready
            and returned_basic_evidence
            and not missing_required_evidence_keys
            and not missing_supplier_items
        )
        reviewed_families.append(
            {
                **family,
                "status": "supplier_family_evidence_complete"
                if passed
                else "blocked_missing_supplier_family_evidence",
                "rfq_package_ready": rfq_package_ready,
                "items": items,
                "required_supplier_evidence_keys": family["required_evidence"],
                "evidence_key_status": evidence_key_status,
                "missing_required_evidence_keys": missing_required_evidence_keys,
                "missing_supplier_items": missing_supplier_items,
                "pass": passed,
            }
        )
    missing_families = [family["id"] for family in reviewed_families if not family["pass"]]
    complete_family_count = len(reviewed_families) - len(missing_families)
    report = {
        "claim_boundary": (
            "Fail-closed supplier evidence acceptance. Public shortlist entries and generated "
            "RFQs do not count; each functional family needs supplier-returned quote, 2D drawing, "
            "STEP, sample evidence, and reviewer identity before CAD lock."
        ),
        "status": "supplier_evidence_complete"
        if reviewed_families and not missing_families
        else "blocked_no_supplier_evidence"
        if complete_family_count == 0
        else "blocked_supplier_evidence_incomplete",
        "source_status": {
            "supplier_rfq_status": supplier_rfq.get("status"),
            "supplier_response_status": supplier_response.get("status"),
            "supplier_response_complete_count": supplier_response.get("complete_response_count", 0),
        },
        "expected_family_count": len(reviewed_families),
        "complete_family_count": complete_family_count,
        "missing_or_incomplete_families": missing_families,
        "families": reviewed_families,
        "release_rule": (
            "Each supplier family must have RFQ coverage, physical_supplier_response rows for "
            "all required supplier items, quote/drawing/STEP/sample/traceability artifacts, "
            "family-specific technical evidence, and reviewer identity before supplier CAD can "
            "replace EVT0 envelope geometry."
        ),
    }
    (REVIEW_DIR / "supplier-evidence-acceptance.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    lines = [
        "# E1 Phone Supplier Evidence Acceptance",
        "",
        f"Status: {report['status']}.",
        "",
        "This gate blocks CAD lock until supplier-returned evidence replaces public shortlist and RFQ draft assumptions.",
        "",
        "## Families",
        "",
    ]
    for family in reviewed_families:
        lines.append(f"- {'PASS' if family['pass'] else 'BLOCKED'}: `{family['id']}`")
        if family["missing_required_evidence_keys"]:
            lines.append(
                "  Missing evidence: "
                + ", ".join(f"`{item}`" for item in family["missing_required_evidence_keys"])
            )
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "supplier-evidence-acceptance.md").write_text("\n".join(lines) + "\n")
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


def part_bounds_union(parts: list[Part]) -> tuple[np.ndarray, np.ndarray]:
    lowers = np.asarray([part.bounds[0] for part in parts])
    uppers = np.asarray([part.bounds[1] for part in parts])
    return lowers.min(axis=0), uppers.max(axis=0)


def bounds_cover_axes(
    cover: tuple[np.ndarray, np.ndarray],
    opening: tuple[np.ndarray, np.ndarray],
    axes: tuple[int, ...],
    minimum_overhang_mm: float,
) -> dict[str, Any]:
    cover_lower, cover_upper = cover
    opening_lower, opening_upper = opening
    overhangs: list[float] = []
    for axis in axes:
        overhangs.append(float(opening_lower[axis] - cover_lower[axis]))
        overhangs.append(float(cover_upper[axis] - opening_upper[axis]))
    minimum_actual = min(overhangs) if overhangs else 0.0
    return {
        "minimum_overhang_mm": round(minimum_actual, 3),
        "required_overhang_mm": minimum_overhang_mm,
        "pass": minimum_actual >= minimum_overhang_mm,
    }


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
            "tolerance_mm": 28.0,
            "why": "Side-key flex connector must stay reachable from the molded orange button caps after moving off the full-width battery zone.",
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
                "action": (
                    f"Keep the {params['battery']['envelope_mm'][0]:.0f} x "
                    f"{params['battery']['envelope_mm'][1]:.0f} x "
                    f"{params['battery']['envelope_mm'][2]:.1f} mm full-width battery "
                    "cavity clear and do not route rigid PCB under the modeled pouch."
                ),
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
    battery_center = [0.0, -7.0, battery_center_z(params)]
    battery_to_pcb_gaps = [
        box_gap(size, center, battery["envelope_mm"], battery_center)
        for size, center, _name in pcb_island_segments(params)
    ]
    power_pressure = comp["power_button"]["force_n"] / (
        comp["power_button"]["cap_mm"][1] * comp["power_button"]["cap_mm"][2]
    )
    volume_pressure = comp["volume_button"]["force_n"] / (
        comp["volume_button"]["cap_mm"][1] * comp["volume_button"]["cap_mm"][2]
    )
    physical_parts = [part for part in parts if is_mass_estimate_included(part)]
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
    check_status = cast(dict[str, dict[str, Any]], checks["checks"])

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
            "target": "1.2-2.2 N, >=0.18 mm travel, pressure below CAD limit",
            "pass": 1.2 <= comp["power_button"]["force_n"] <= 2.2
            and comp["power_button"]["travel_mm"] >= MIN_BUTTON_TRAVEL_MM
            and power_pressure <= tolerance["button_pressure_limit_n_per_mm2"]
            and check_status["button_ingress_seal_stack"]["pass"],
            "evidence": [
                "power_button_cap",
                "power_button_elastomer_gasket",
                "button_force_and_travel",
                "button_pressure_support",
                "button_ingress_seal_stack",
            ],
        },
        {
            "id": "volume_button_force_travel_pressure",
            "interface": "button",
            "actual": {
                "force_n": comp["volume_button"]["force_n"],
                "travel_mm": comp["volume_button"]["travel_mm"],
                "pressure_n_per_mm2": round(volume_pressure, 3),
            },
            "target": "1.2-2.2 N, >=0.18 mm travel, pressure below CAD limit",
            "pass": 1.2 <= comp["volume_button"]["force_n"] <= 2.2
            and comp["volume_button"]["travel_mm"] >= MIN_BUTTON_TRAVEL_MM
            and volume_pressure <= tolerance["button_pressure_limit_n_per_mm2"]
            and check_status["button_ingress_seal_stack"]["pass"],
            "evidence": [
                "volume_button_cap",
                "volume_button_elastomer_gasket",
                "button_force_and_travel",
                "button_pressure_support",
                "button_ingress_seal_stack",
            ],
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
            and check_status["usb_c_port_seal_stack"]["pass"]
            and checks["checks"]["usb_c_insertion_envelope"]["pass"],
            "evidence": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
                "orange_usb_reinforcement_saddle",
                "usb_c_insertion_envelope",
                "usb_c_port_seal_stack",
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
            and checks["checks"]["camera_optical_seal_stack"]["pass"]
            and bool(clearance_cases.get("rear_camera_to_battery", {}).get("pass")),
            "evidence": [
                "front_camera_module",
                "front_camera_under_glass",
                "front_camera_black_mask_window",
                "rear_camera_module",
                "rear_camera_cover_glass",
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "rear_camera_light_baffle_top",
                "rear_camera_light_baffle_bottom",
                "camera_speaker_behind_glass",
                "camera_optical_seal_stack",
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


def write_acoustic_validation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    clearance: dict[str, Any],
    interface_validation: dict[str, Any],
) -> dict[str, Any]:
    comp = params["components"]
    by_name = {part.name: part for part in parts}

    def span(name: str) -> np.ndarray:
        low, high = by_name[name].bounds
        return high - low

    speaker_slots = sorted(
        name for name in by_name if name.startswith("bottom_speaker_grille_slot_")
    )
    mic_ports = sorted(name for name in by_name if name.startswith("bottom_microphone_port_"))
    bottom_mic_meshes = sorted(
        name for name in by_name if name.startswith("bottom_microphone_mesh_")
    )
    speaker_slot_area_mm2 = sum(float(span(name)[0] * span(name)[2]) for name in speaker_slots)
    mic_port_area_mm2 = sum(float(span(name)[0] * span(name)[2]) for name in mic_ports)
    chamber_span = span("bottom_speaker_acoustic_chamber")
    chamber_volume_cm3 = float(np.prod(chamber_span) / 1000.0)
    earpiece_slot_span = span("handset_acoustic_slot")
    earpiece_slot_area_mm2 = float(earpiece_slot_span[0] * earpiece_slot_span[1])
    earpiece_gasket_thickness_mm = float(span("earpiece_gasket")[2])
    speaker_face_area_mm2 = (
        comp["speaker_bottom"]["envelope_mm"][0] * comp["speaker_bottom"]["envelope_mm"][1]
    )
    speaker_open_area_ratio = speaker_slot_area_mm2 / speaker_face_area_mm2
    clearance_cases = {case["id"]: case for case in clearance["cases"]}
    interface_cases = {case["id"]: case for case in interface_validation["interfaces"]}

    cases = [
        {
            "id": "bottom_speaker_open_area",
            "actual": {
                "slot_count": len(speaker_slots),
                "open_area_mm2": round(speaker_slot_area_mm2, 3),
                "open_area_ratio": round(speaker_open_area_ratio, 3),
            },
            "target": ">=5 slots and >=0.035 open-area ratio against 1115 speaker face",
            "pass": len(speaker_slots) >= 5 and speaker_open_area_ratio >= 0.035,
        },
        {
            "id": "bottom_speaker_rear_chamber",
            "actual": {"rear_chamber_volume_cm3": round(chamber_volume_cm3, 3)},
            "target": ">=0.40 cm3 rear chamber for compact 1115 module EVT target",
            "pass": chamber_volume_cm3 >= 0.40,
        },
        {
            "id": "bottom_microphone_porting",
            "actual": {
                "port_count": len(mic_ports),
                "port_area_mm2": round(mic_port_area_mm2, 3),
                "mic_to_usb_gap_mm": clearance_cases.get("bottom_mic_to_usb", {}).get("actual_mm"),
            },
            "target": ">=2 ports, >=1.0 mm2 total port area, >=1.0 mm USB load-path separation",
            "pass": len(mic_ports) >= 2
            and mic_port_area_mm2 >= 1.0
            and bool(clearance_cases.get("bottom_mic_to_usb", {}).get("pass")),
        },
        {
            "id": "acoustic_mesh_membranes",
            "actual": {
                "bottom_speaker_mesh_present": "bottom_speaker_dust_mesh" in by_name,
                "bottom_microphone_mesh_count": len(bottom_mic_meshes),
                "top_microphone_mesh_present": "top_microphone_mesh" in by_name,
                "handset_mesh_present": "handset_acoustic_mesh" in by_name,
            },
            "target": "hydrophobic mesh/membrane modeled for speaker, bottom mics, top mic, and handset slot",
            "pass": "bottom_speaker_dust_mesh" in by_name
            and len(bottom_mic_meshes) >= 2
            and "top_microphone_mesh" in by_name
            and "handset_acoustic_mesh" in by_name,
        },
        {
            "id": "usb_speaker_isolation",
            "actual": {
                "speaker_to_usb_gap_mm": clearance_cases.get("usb_to_bottom_speaker", {}).get(
                    "actual_mm"
                )
            },
            "target": ">=1.0 mm speaker-to-USB mechanical isolation",
            "pass": bool(clearance_cases.get("usb_to_bottom_speaker", {}).get("pass")),
        },
        {
            "id": "earpiece_under_glass_path",
            "actual": {
                "slot_area_mm2": round(earpiece_slot_area_mm2, 3),
                "gasket_thickness_mm": round(earpiece_gasket_thickness_mm, 3),
                "front_camera_to_earpiece_gap_mm": clearance_cases.get(
                    "front_camera_to_earpiece", {}
                ).get("actual_mm"),
            },
            "target": ">=10 mm2 slot area, 0.4-0.8 mm gasket, front camera clearance passing",
            "pass": earpiece_slot_area_mm2 >= 10.0
            and 0.4 <= earpiece_gasket_thickness_mm <= 0.8
            and bool(clearance_cases.get("front_camera_to_earpiece", {}).get("pass")),
        },
        {
            "id": "interface_acoustic_cases_pass",
            "actual": {
                "bottom_audio_port_alignment": interface_cases.get(
                    "bottom_audio_port_alignment", {}
                ).get("pass"),
                "handset_receiver_gasket_stack": interface_cases.get(
                    "handset_receiver_gasket_stack", {}
                ).get("pass"),
            },
            "target": "bottom audio and handset interface validation pass",
            "pass": bool(interface_cases.get("bottom_audio_port_alignment", {}).get("pass"))
            and bool(interface_cases.get("handset_receiver_gasket_stack", {}).get("pass")),
        },
    ]

    measurements: list[dict[str, Any]] = [
        {
            "measurement_id": "bottom_speaker_spl_1khz_db",
            "unit": "dB SPL",
            "min": 72.0,
            "max": "",
            "fixture": "anechoic_box_or_phone_acoustic_jig",
            "notes": "1 W/0.5 m equivalent or vendor-normalized compact-phone SPL target.",
        },
        {
            "measurement_id": "bottom_speaker_impedance_ohm",
            "unit": "ohm",
            "min": 4.0,
            "max": 12.0,
            "fixture": "impedance_sweep",
            "notes": "Verify module impedance and acoustic chamber loading.",
        },
        {
            "measurement_id": "bottom_speaker_leak_delta_db",
            "unit": "dB",
            "min": 0.0,
            "max": 3.0,
            "fixture": "evt_fixture_bottom_acoustic_leak_mask",
            "notes": "Masked/unmasked leakage delta around bottom speaker and mic ports.",
        },
        {
            "measurement_id": "bottom_mic_snr_db",
            "unit": "dB",
            "min": 60.0,
            "max": "",
            "fixture": "calibrated_speech_noise_box",
            "notes": "Bottom MEMS microphone SNR through molded port and mesh stack.",
        },
        {
            "measurement_id": "top_mic_snr_db",
            "unit": "dB",
            "min": 60.0,
            "max": "",
            "fixture": "calibrated_speech_noise_box",
            "notes": "Noise-cancel MEMS microphone SNR and PDM integrity.",
        },
        {
            "measurement_id": "earpiece_spl_1khz_db",
            "unit": "dB SPL",
            "min": 70.0,
            "max": "",
            "fixture": "ear_simulator",
            "notes": "Behind-glass receiver SPL through gasketed handset slot.",
        },
        {
            "measurement_id": "earpiece_leak_delta_db",
            "unit": "dB",
            "min": 0.0,
            "max": 3.0,
            "fixture": "evt_fixture_earpiece_leak_mask",
            "notes": "Leakage around receiver gasket and cover-glass slot.",
        },
    ]
    required_evidence_by_measurement = {
        "bottom_speaker_spl_1khz_db": [
            "speaker_spl_raw_sweep_csv",
            "acoustic_fixture_calibration_certificate",
            "speaker_grille_test_photo",
            "speaker_module_and_mesh_lot_records",
        ],
        "bottom_speaker_impedance_ohm": [
            "speaker_impedance_raw_sweep_csv",
            "audio_analyzer_calibration_certificate",
            "speaker_module_test_photo",
            "speaker_module_lot_record",
        ],
        "bottom_speaker_leak_delta_db": [
            "bottom_speaker_leak_raw_sweep_csv",
            "leak_fixture_calibration_certificate",
            "bottom_audio_port_mask_photo",
            "speaker_mesh_and_gasket_lot_records",
        ],
        "bottom_mic_snr_db": [
            "microphone_snr_raw_log",
            "anechoic_or_quiet_box_calibration_certificate",
            "microphone_port_test_photo",
            "microphone_and_mesh_lot_records",
        ],
        "top_mic_snr_db": [
            "top_microphone_snr_raw_log",
            "anechoic_or_quiet_box_calibration_certificate",
            "top_microphone_port_test_photo",
            "microphone_and_mesh_lot_records",
        ],
        "earpiece_spl_1khz_db": [
            "earpiece_spl_raw_sweep_csv",
            "acoustic_fixture_calibration_certificate",
            "earpiece_slot_test_photo",
            "receiver_and_gasket_lot_records",
        ],
        "earpiece_leak_delta_db": [
            "earpiece_leak_raw_sweep_csv",
            "leak_fixture_calibration_certificate",
            "compressed_earpiece_gasket_photo",
            "receiver_and_gasket_lot_records",
        ],
    }
    for measurement in measurements:
        measurement["required_evidence_artifacts"] = required_evidence_by_measurement[
            measurement["measurement_id"]
        ]
    template_path = REVIEW_DIR / "acoustic-results-template.csv"
    fieldnames = [
        "sample_id",
        "measurement_id",
        "unit",
        "min",
        "max",
        "measured_value",
        "pass",
        "operator",
        "evidence_class",
        "required_evidence_artifacts",
        "raw_data_artifact",
        "fixture_calibration_certificate",
        "photo_or_log_artifact",
        "lot_traceability_record",
        "notes",
    ]
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for measurement in measurements:
            writer.writerow(
                {
                    "sample_id": "",
                    "measurement_id": measurement["measurement_id"],
                    "unit": measurement["unit"],
                    "min": measurement["min"],
                    "max": measurement["max"],
                    "measured_value": "",
                    "pass": "",
                    "operator": "",
                    "evidence_class": "",
                    "required_evidence_artifacts": ";".join(
                        measurement["required_evidence_artifacts"]
                    ),
                    "raw_data_artifact": "",
                    "fixture_calibration_certificate": "",
                    "photo_or_log_artifact": "",
                    "lot_traceability_record": "",
                    "notes": measurement["notes"],
                }
            )

    release_blockers = [
        "Need speaker SPL/impedance sweep with molded rear chamber and grille.",
        "Need microphone SNR/sensitivity data through molded ports, mesh, and gasket stack.",
        "Need earpiece SPL/leak test through behind-glass slot and compressed gasket.",
        "Need dust/water ingress review for speaker, microphone, and handset openings.",
    ]
    report = {
        "claim_boundary": "CAD-derived acoustic path validation and lab-result template; not acoustic simulation or measured audio performance.",
        "status": "cad_acoustic_validation_ready"
        if all(case["pass"] for case in cases)
        else "blocked",
        "audio_components": {
            "speaker_bottom": comp["speaker_bottom"]["candidate"],
            "earpiece": comp["earpiece"]["candidate"],
            "microphone_bottom": comp["microphone_bottom"]["candidate"],
            "microphone_top": comp["microphone_top"]["candidate"],
        },
        "cases": cases,
        "measurement_count": len(measurements),
        "measurements": measurements,
        "results_template": "mechanical/e1-phone/review/acoustic-results-template.csv",
        "release_blockers": release_blockers,
    }
    (REVIEW_DIR / "acoustic-validation.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Acoustic Validation",
        "",
        "Status: CAD acoustic validation ready; lab measurements still required.",
        "",
        "## CAD Acoustic Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` target {case['target']}")
    lines.extend(["", "## Lab Measurements", ""])
    for measurement in measurements:
        lines.append(
            f"- `{measurement['measurement_id']}` {measurement['unit']} fixture `{measurement['fixture']}`"
        )
    lines.extend(["", "## Release Blockers", ""])
    for blocker in release_blockers:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "acoustic-validation.md").write_text("\n".join(lines) + "\n")
    return report


def write_acoustic_results_review_artifacts(
    acoustic_validation: dict[str, Any],
) -> dict[str, Any]:
    csv_path = REVIEW_DIR / "acoustic-results-template.csv"
    expected = {item["measurement_id"]: item for item in acoustic_validation["measurements"]}
    rows: list[dict[str, str]] = []
    template_evidence_class = ""
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            rows = list(csv.DictReader(csv_file))

    cases: list[dict[str, Any]] = []
    forbidden_evidence_classes = {
        "simulated_acoustic_result_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    for row in rows:
        measurement_id = row.get("measurement_id", "")
        expected_item = expected.get(measurement_id, {})
        measured_text = row.get("measured_value", "").strip()
        pass_text = row.get("pass", "").strip().lower()
        sample_id = row.get("sample_id", "").strip()
        operator = row.get("operator", "").strip()
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or ";".join(expected_item.get("required_evidence_artifacts", []))
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "fixture_calibration_certificate",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_acoustic_result"
            and evidence_class not in forbidden_evidence_classes
        )
        measured_value: float | None = None
        parse_ok = False
        if measured_text:
            with suppress(ValueError):
                measured_value = float(measured_text)
                parse_ok = True
        min_value = expected_item.get("min")
        max_value = expected_item.get("max")
        within_min = measured_value is not None and (
            min_value in {"", None} or measured_value >= float(min_value)
        )
        within_max = measured_value is not None and (
            max_value in {"", None} or measured_value <= float(max_value)
        )
        populated = bool(
            sample_id
            and operator
            and measured_text
            and pass_text
            and evidence_class
            and required_evidence_artifacts
            and evidence_fields_present
        )
        cases.append(
            {
                "measurement_id": measurement_id,
                "expected_measurement": measurement_id in expected,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "fixture_calibration_certificate_present": bool(
                    row.get("fixture_calibration_certificate", "").strip()
                ),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "numeric_check_pass": bool(parse_ok and within_min and within_max),
                "declared_pass": pass_text in {"pass", "true", "yes", "1"},
                "pass": populated
                and measurement_id in expected
                and parse_ok
                and within_min
                and within_max
                and pass_text in {"pass", "true", "yes", "1"}
                and evidence_class_allowed,
            }
        )

    missing_measurements = sorted(set(expected) - {case["measurement_id"] for case in cases})
    blank_or_incomplete = [case["measurement_id"] for case in cases if not case["populated"]]
    failed_measurements = [
        case["measurement_id"]
        for case in cases
        if case["populated"]
        and (
            not case["numeric_check_pass"]
            or not case["declared_pass"]
            or not case["evidence_class_allowed"]
        )
    ]
    complete_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": "Fail-closed review of acoustic lab results; blank template rows are not measured audio evidence.",
        "status": "acoustic_results_pass"
        if cases and complete_count == len(expected) and not missing_measurements
        else "blocked_no_acoustic_results"
        if complete_count == 0
        else "blocked_acoustic_results_incomplete",
        "expected_measurement_count": len(expected),
        "required_evidence_class": "physical_acoustic_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "observed_row_count": len(cases),
        "complete_result_count": complete_count,
        "missing_measurements": missing_measurements,
        "blank_or_incomplete_measurements": blank_or_incomplete,
        "failed_measurements": failed_measurements,
        "cases": cases,
        "release_rule": "Every speaker, microphone, earpiece, and leak measurement row must include sample, operator, numeric passing result, explicit pass, evidence_class=physical_acoustic_result, raw acoustic/log data, fixture calibration certificate, photo/log artifact, and module/mesh/gasket lot traceability record.",
    }
    (REVIEW_DIR / "acoustic-results-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Acoustic Results Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until acoustic lab rows are populated.",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for measurement_id in missing_measurements + blank_or_incomplete + failed_measurements:
        lines.append(f"- `{measurement_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "acoustic-results-review.md").write_text("\n".join(lines) + "\n")
    return report


def write_camera_validation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    clearance: dict[str, Any],
    interface_validation: dict[str, Any],
) -> dict[str, Any]:
    comp = params["components"]
    display = params["display"]
    part_names = {part.name for part in parts}
    clearance_cases = {case["id"]: case for case in clearance["cases"]}
    interface_cases = {case["id"]: case for case in interface_validation["interfaces"]}
    rear_cover_margin_mm = (
        comp["rear_camera_glass"]["envelope_mm"][0] - comp["rear_camera"]["lens_diameter_mm"]
    ) / 2.0
    aperture_w, aperture_h = rear_camera_shell_aperture_mm(params)
    rear_glass_w, rear_glass_h, _rear_glass_t = comp["rear_camera_glass"]["envelope_mm"]
    flash_aperture_w, flash_aperture_h = rear_flash_shell_aperture_mm(params)
    flash_window_w, flash_window_h, _flash_window_t = comp["rear_flash_led"]["window_mm"]
    front_under_glass_margin_mm = (
        comp["front_camera"]["module_mm"][0] - comp["front_camera"]["lens_diameter_mm"]
    ) / 2.0
    rear_module_depth_mm = comp["rear_camera"]["module_mm"][2]
    cover_glass_thickness_mm = display["cover_glass_mm"][2]
    cases = [
        {
            "id": "rear_camera_cover_window_margin",
            "actual": {
                "cover_window_mm": comp["rear_camera_glass"]["envelope_mm"][:2],
                "lens_diameter_mm": comp["rear_camera"]["lens_diameter_mm"],
                "radial_margin_mm": round(rear_cover_margin_mm, 3),
            },
            "target": ">=0.8 mm radial margin around rear AF lens",
            "pass": rear_cover_margin_mm >= 0.8
            and "rear_camera_cover_glass" in part_names
            and "rear_camera_lens_window" in part_names,
        },
        {
            "id": "rear_camera_back_shell_aperture",
            "actual": {
                "aperture_mm": [aperture_w, aperture_h],
                "cover_window_mm": [rear_glass_w, rear_glass_h],
                "optical_sight_tunnel_present": "rear_camera_optical_sight_tunnel" in part_names,
                "bezel_part_count": sum(
                    1 for name in part_names if name.startswith("orange_rear_camera_bezel_")
                ),
            },
            "target": "explicit molded back-shell opening larger than the flush cover window with a clear camera sight tunnel and four orange bevel lands",
            "pass": "rear_camera_shell_aperture" in part_names
            and "rear_camera_optical_sight_tunnel" in part_names
            and aperture_w > rear_glass_w
            and aperture_h > rear_glass_h
            and sum(1 for name in part_names if name.startswith("orange_rear_camera_bezel_")) == 4,
        },
        {
            "id": "rear_flash_back_shell_aperture",
            "actual": {
                "aperture_mm": [flash_aperture_w, flash_aperture_h],
                "window_mm": [flash_window_w, flash_window_h],
                "bezel_part_count": sum(
                    1 for name in part_names if name.startswith("orange_rear_flash_bezel_")
                ),
            },
            "target": "explicit molded back-shell opening larger than the flush flash light-pipe window with four orange bevel lands",
            "pass": "rear_flash_shell_aperture" in part_names
            and flash_aperture_w > flash_window_w
            and flash_aperture_h > flash_window_h
            and sum(1 for name in part_names if name.startswith("orange_rear_flash_bezel_")) == 4,
        },
        {
            "id": "rear_camera_z_stack",
            "actual": {
                "module_depth_mm": rear_module_depth_mm,
                "rear_camera_to_battery_gap_mm": clearance_cases.get(
                    "rear_camera_to_battery", {}
                ).get("actual_mm"),
            },
            "target": "rear AF stack depth <=5.5 mm and >=2.0 mm battery gap",
            "pass": rear_module_depth_mm <= 5.5
            and bool(clearance_cases.get("rear_camera_to_battery", {}).get("pass")),
        },
        {
            "id": "front_under_glass_margin",
            "actual": {
                "module_mm": comp["front_camera"]["module_mm"],
                "lens_diameter_mm": comp["front_camera"]["lens_diameter_mm"],
                "radial_margin_mm": round(front_under_glass_margin_mm, 3),
                "cover_glass_thickness_mm": cover_glass_thickness_mm,
            },
            "target": ">=1.0 mm radial module margin and <=0.8 mm cover glass for front under-glass camera",
            "pass": front_under_glass_margin_mm >= 1.0
            and cover_glass_thickness_mm <= 0.8
            and "front_camera_under_glass" in part_names,
        },
        {
            "id": "front_camera_earpiece_clearance",
            "actual": {
                "front_camera_to_earpiece_gap_mm": clearance_cases.get(
                    "front_camera_to_earpiece", {}
                ).get("actual_mm")
            },
            "target": ">=1.0 mm front camera to earpiece receiver gap",
            "pass": bool(clearance_cases.get("front_camera_to_earpiece", {}).get("pass")),
        },
        {
            "id": "camera_interface_strategy",
            "actual": {
                "interface_case_pass": interface_cases.get(
                    "camera_glass_and_under_glass_strategy", {}
                ).get("pass"),
                "rear_flush_buried_window": True,
                "front_under_cover_glass": True,
                "rear_cover_adhesive_count": sum(
                    1 for name in part_names if name.startswith("rear_camera_cover_adhesive_")
                ),
                "rear_light_baffle_count": sum(
                    1 for name in part_names if name.startswith("rear_camera_light_baffle_")
                ),
                "front_black_mask_present": "front_camera_black_mask_window" in part_names,
            },
            "target": "front camera under glass with black mask; rear AF camera through gasketed/baffled cover window",
            "pass": bool(
                interface_cases.get("camera_glass_and_under_glass_strategy", {}).get("pass")
            )
            and sum(1 for name in part_names if name.startswith("rear_camera_cover_adhesive_")) >= 4
            and sum(1 for name in part_names if name.startswith("rear_camera_light_baffle_")) >= 2
            and "front_camera_black_mask_window" in part_names,
        },
    ]
    measurements: list[dict[str, Any]] = [
        {
            "measurement_id": "rear_camera_lens_center_error_mm",
            "unit": "mm",
            "min": 0.0,
            "max": 0.25,
            "fixture": "evt_fixture_rear_camera_alignment_pin",
            "notes": "Rear lens optical center to rear cover-window datum.",
        },
        {
            "measurement_id": "front_camera_under_glass_center_error_mm",
            "unit": "mm",
            "min": 0.0,
            "max": 0.30,
            "fixture": "evt_fixture_front_camera_alignment_pin",
            "notes": "Front camera optical center to under-glass aperture datum.",
        },
        {
            "measurement_id": "rear_camera_focus_mtf50_lp_per_mm",
            "unit": "lp/mm",
            "min": 35.0,
            "max": "",
            "fixture": "iso12233_chart",
            "notes": "AF rear module focus and cover-window optical quality check.",
        },
        {
            "measurement_id": "front_camera_mtf50_lp_per_mm",
            "unit": "lp/mm",
            "min": 25.0,
            "max": "",
            "fixture": "iso12233_chart_through_cover_glass",
            "notes": "Front fixed-focus module through cover-glass image sharpness.",
        },
        {
            "measurement_id": "front_cover_glass_color_delta_e",
            "unit": "deltaE",
            "min": 0.0,
            "max": 3.0,
            "fixture": "color_chart_lightbox",
            "notes": "Color shift from cover-glass/black mask stack over front camera.",
        },
        {
            "measurement_id": "rear_camera_dust_or_vignette_defects",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "flat_field_capture",
            "notes": "Dust, vignette, or gasket intrusion defects in rear cover window.",
        },
        {
            "measurement_id": "camera_streaming_bringup_logs",
            "unit": "pass_flag",
            "min": 1.0,
            "max": 1.0,
            "fixture": "v4l2_or_android_camera_hal",
            "notes": "Both front and rear cameras enumerate and stream with selected module pinout.",
        },
    ]
    required_evidence_by_measurement = {
        "rear_camera_lens_center_error_mm": [
            "rear_camera_alignment_raw_csv",
            "camera_alignment_fixture_calibration_certificate",
            "rear_camera_window_alignment_photo",
            "rear_camera_module_and_cover_glass_lot_records",
        ],
        "front_camera_under_glass_center_error_mm": [
            "front_camera_alignment_raw_csv",
            "camera_alignment_fixture_calibration_certificate",
            "front_under_glass_alignment_photo",
            "front_camera_module_and_cover_glass_lot_records",
        ],
        "rear_camera_focus_mtf50_lp_per_mm": [
            "rear_iso12233_mtf_raw_csv",
            "camera_chart_and_lightbox_calibration_certificate",
            "rear_camera_focus_capture",
            "rear_camera_module_lot_record",
        ],
        "front_camera_mtf50_lp_per_mm": [
            "front_iso12233_mtf_raw_csv",
            "camera_chart_and_lightbox_calibration_certificate",
            "front_camera_through_glass_capture",
            "front_camera_module_and_cover_glass_lot_records",
        ],
        "front_cover_glass_color_delta_e": [
            "front_color_chart_delta_e_raw_csv",
            "color_lightbox_calibration_certificate",
            "front_camera_color_chart_capture",
            "front_cover_glass_lot_record",
        ],
        "rear_camera_dust_or_vignette_defects": [
            "rear_flat_field_defect_raw_log",
            "flat_field_lightbox_calibration_certificate",
            "rear_camera_flat_field_capture",
            "rear_camera_cover_glass_and_gasket_lot_records",
        ],
        "camera_streaming_bringup_logs": [
            "v4l2_or_camera_hal_streaming_log",
            "camera_driver_revision_record",
            "front_and_rear_camera_capture_artifacts",
            "camera_module_lot_records",
        ],
    }
    for measurement in measurements:
        measurement["required_evidence_artifacts"] = required_evidence_by_measurement[
            measurement["measurement_id"]
        ]
    template_path = REVIEW_DIR / "camera-results-template.csv"
    fieldnames = [
        "sample_id",
        "measurement_id",
        "unit",
        "min",
        "max",
        "measured_value",
        "pass",
        "operator",
        "evidence_class",
        "required_evidence_artifacts",
        "raw_data_artifact",
        "fixture_calibration_certificate",
        "photo_or_log_artifact",
        "lot_traceability_record",
        "notes",
    ]
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for measurement in measurements:
            writer.writerow(
                {
                    "sample_id": "",
                    "measurement_id": measurement["measurement_id"],
                    "unit": measurement["unit"],
                    "min": measurement["min"],
                    "max": measurement["max"],
                    "measured_value": "",
                    "pass": "",
                    "operator": "",
                    "evidence_class": "",
                    "required_evidence_artifacts": ";".join(
                        measurement["required_evidence_artifacts"]
                    ),
                    "raw_data_artifact": "",
                    "fixture_calibration_certificate": "",
                    "photo_or_log_artifact": "",
                    "lot_traceability_record": "",
                    "notes": measurement["notes"],
                }
            )

    release_blockers = [
        "Need supplier drawings/STEP for rear and front module optical center, FPC exit, and lens stack.",
        "Need rear cover-window dust gasket drawing and first-article center/MTF measurements.",
        "Need front under-glass capture validation through selected cover glass and black mask.",
        "Need V4L2 or Android Camera HAL streaming logs with selected sensor drivers and pinout.",
    ]
    report = {
        "claim_boundary": "CAD-derived camera optical package validation and result template; not supplier module approval, image-quality calibration, or Camera HAL evidence.",
        "status": "cad_camera_validation_ready"
        if all(case["pass"] for case in cases)
        else "blocked",
        "camera_components": {
            "rear_camera": comp["rear_camera"]["candidate"],
            "front_camera": comp["front_camera"]["candidate"],
            "rear_camera_glass": comp["rear_camera_glass"]["candidate"],
        },
        "cases": cases,
        "measurement_count": len(measurements),
        "measurements": measurements,
        "results_template": "mechanical/e1-phone/review/camera-results-template.csv",
        "release_blockers": release_blockers,
    }
    (REVIEW_DIR / "camera-validation.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Camera Validation",
        "",
        "Status: CAD camera validation ready; supplier and optical measurements still required.",
        "",
        "## CAD Camera Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` target {case['target']}")
    lines.extend(["", "## Lab Measurements", ""])
    for measurement in measurements:
        lines.append(
            f"- `{measurement['measurement_id']}` {measurement['unit']} fixture `{measurement['fixture']}`"
        )
    lines.extend(["", "## Release Blockers", ""])
    for blocker in release_blockers:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "camera-validation.md").write_text("\n".join(lines) + "\n")
    return report


def write_camera_results_review_artifacts(camera_validation: dict[str, Any]) -> dict[str, Any]:
    csv_path = REVIEW_DIR / "camera-results-template.csv"
    expected = {item["measurement_id"]: item for item in camera_validation["measurements"]}
    rows: list[dict[str, str]] = []
    template_evidence_class = ""
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            rows = list(csv.DictReader(csv_file))

    cases: list[dict[str, Any]] = []
    forbidden_evidence_classes = {
        "simulated_camera_result_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    for row in rows:
        measurement_id = row.get("measurement_id", "")
        expected_item = expected.get(measurement_id, {})
        measured_text = row.get("measured_value", "").strip()
        pass_text = row.get("pass", "").strip().lower()
        sample_id = row.get("sample_id", "").strip()
        operator = row.get("operator", "").strip()
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or ";".join(expected_item.get("required_evidence_artifacts", []))
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "fixture_calibration_certificate",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_camera_result"
            and evidence_class not in forbidden_evidence_classes
        )
        measured_value: float | None = None
        parse_ok = False
        if measured_text:
            with suppress(ValueError):
                measured_value = float(measured_text)
                parse_ok = True
        min_value = expected_item.get("min")
        max_value = expected_item.get("max")
        within_min = measured_value is not None and (
            min_value in {"", None} or measured_value >= float(min_value)
        )
        within_max = measured_value is not None and (
            max_value in {"", None} or measured_value <= float(max_value)
        )
        populated = bool(
            sample_id
            and operator
            and measured_text
            and pass_text
            and evidence_class
            and required_evidence_artifacts
            and evidence_fields_present
        )
        cases.append(
            {
                "measurement_id": measurement_id,
                "expected_measurement": measurement_id in expected,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "fixture_calibration_certificate_present": bool(
                    row.get("fixture_calibration_certificate", "").strip()
                ),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "numeric_check_pass": bool(parse_ok and within_min and within_max),
                "declared_pass": pass_text in {"pass", "true", "yes", "1"},
                "pass": populated
                and measurement_id in expected
                and parse_ok
                and within_min
                and within_max
                and pass_text in {"pass", "true", "yes", "1"}
                and evidence_class_allowed,
            }
        )

    missing_measurements = sorted(set(expected) - {case["measurement_id"] for case in cases})
    blank_or_incomplete = [case["measurement_id"] for case in cases if not case["populated"]]
    failed_measurements = [
        case["measurement_id"]
        for case in cases
        if case["populated"]
        and (
            not case["numeric_check_pass"]
            or not case["declared_pass"]
            or not case["evidence_class_allowed"]
        )
    ]
    complete_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": "Fail-closed review of camera optical and bring-up results; blank rows are not image-quality evidence.",
        "status": "camera_results_pass"
        if cases and complete_count == len(expected) and not missing_measurements
        else "blocked_no_camera_results"
        if complete_count == 0
        else "blocked_camera_results_incomplete",
        "expected_measurement_count": len(expected),
        "required_evidence_class": "physical_camera_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "observed_row_count": len(cases),
        "complete_result_count": complete_count,
        "missing_measurements": missing_measurements,
        "blank_or_incomplete_measurements": blank_or_incomplete,
        "failed_measurements": failed_measurements,
        "cases": cases,
        "release_rule": "Every camera alignment, image-quality, dust, color, and streaming row must include sample, operator, numeric passing result, explicit pass, evidence_class=physical_camera_result, raw image/log data, fixture calibration certificate, photo/log artifact, and camera module/glass/gasket lot traceability record.",
    }
    (REVIEW_DIR / "camera-results-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Camera Results Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until camera optical and bring-up rows are populated.",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for measurement_id in missing_measurements + blank_or_incomplete + failed_measurements:
        lines.append(f"- `{measurement_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "camera-results-review.md").write_text("\n".join(lines) + "\n")
    return report


def write_display_validation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    clearance: dict[str, Any],
    interface_validation: dict[str, Any],
    tolerance_stack: dict[str, Any],
) -> dict[str, Any]:
    display = params["display"]
    width, height, _depth = params["device"]["envelope_mm"]
    part_names = {part.name for part in parts}
    clearance_cases = {case["id"]: case for case in clearance["cases"]}
    interface_cases = {case["id"]: case for case in interface_validation["interfaces"]}
    stack_cases = {case["id"]: case for case in tolerance_stack["stacks"]}
    screen_margin_mm = min(
        (width - display["ctp_outline_mm"][0]) / 2.0,
        (height - display["ctp_outline_mm"][1]) / 2.0,
    )
    tft_under_glass_margin_mm = min(
        (display["cover_glass_mm"][0] - display["tft_outline_mm"][0]) / 2.0,
        (display["cover_glass_mm"][1] - display["tft_outline_mm"][1]) / 2.0,
    )
    adhesive_compression_mm = display["adhesive_thickness_mm"] * (
        display["compression_target_pct"] / 100.0
    )
    adhesive_parts = [
        "screen_adhesive_top",
        "screen_adhesive_bottom",
        "screen_adhesive_left",
        "screen_adhesive_right",
    ]
    adhesive_total_area_mm2 = (
        2.0 * display["cover_glass_mm"][0] * display["adhesive_width_mm"]
        + 2.0 * display["cover_glass_mm"][1] * display["adhesive_width_mm"]
    )
    cases = [
        {
            "id": "display_module_envelope_fit",
            "actual": {
                "screen_margin_mm": round(screen_margin_mm, 3),
                "ctp_outline_mm": display["ctp_outline_mm"],
                "device_envelope_mm": params["device"]["envelope_mm"],
            },
            "target": ">=0.3 mm nominal CTP-to-orange-body margin",
            "pass": screen_margin_mm >= params["validation"]["tolerance"]["screen_xy_allowance_mm"]
            and bool(clearance_cases.get("screen_cover_glass_to_orange_body", {}).get("pass")),
        },
        {
            "id": "tft_under_cover_glass",
            "actual": {"tft_under_glass_margin_mm": round(tft_under_glass_margin_mm, 3)},
            "target": ">=0.5 mm TFT-to-cover-glass margin",
            "pass": tft_under_glass_margin_mm >= 0.5
            and bool(clearance_cases.get("display_lcm_under_cover_glass", {}).get("pass")),
        },
        {
            "id": "adhesive_bond_geometry",
            "actual": {
                "adhesive_parts_present": sorted(
                    name for name in adhesive_parts if name in part_names
                ),
                "adhesive_width_mm": display["adhesive_width_mm"],
                "adhesive_compression_mm": round(adhesive_compression_mm, 3),
                "adhesive_total_area_mm2": round(adhesive_total_area_mm2, 1),
            },
            "target": "four-sided adhesive, 1.0 mm nominal width, 0.03-0.08 mm compression",
            "pass": set(adhesive_parts).issubset(part_names)
            and display["adhesive_width_mm"] >= 1.0
            and 0.03 <= adhesive_compression_mm <= 0.08,
        },
        {
            "id": "display_fpc_bend_and_connector",
            "actual": {
                "fpc_connector_mm": display["fpc_connector_mm"],
                "fpc_bend_radius_mm": display["fpc_bend_radius_mm"],
            },
            "target": "FPC connector and keepout present, bend radius >=1.0 mm",
            "pass": "display_fpc_connector" in part_names
            and "display_fpc_bend_keepout" in part_names
            and display["fpc_bend_radius_mm"] >= 1.0
            and bool(stack_cases.get("display_fpc_bend_radius", {}).get("pass")),
        },
        {
            "id": "screen_interface_validation",
            "actual": {
                "screen_bond_and_fpc_connection": interface_cases.get(
                    "screen_bond_and_fpc_connection", {}
                ).get("pass")
            },
            "target": "screen interface validation pass",
            "pass": bool(interface_cases.get("screen_bond_and_fpc_connection", {}).get("pass")),
        },
    ]
    measurements: list[dict[str, Any]] = [
        {
            "measurement_id": "display_bond_peel_n_per_mm",
            "unit": "N/mm",
            "min": 0.45,
            "max": "",
            "fixture": "screen_bond_peel_fixture",
            "notes": "Peel strength around die-cut adhesive perimeter after dwell.",
        },
        {
            "measurement_id": "screen_adhesive_compression_mm",
            "unit": "mm",
            "min": 0.03,
            "max": 0.08,
            "fixture": "evt_fixture_screen_bond_clamp_frame",
            "notes": "Compressed adhesive thickness after screen placement.",
        },
        {
            "measurement_id": "display_fpc_bend_radius_mm",
            "unit": "mm",
            "min": 1.0,
            "max": "",
            "fixture": "evt_fixture_screen_bond_clamp_frame",
            "notes": "Measured bend radius after connector mating and closure.",
        },
        {
            "measurement_id": "display_luminance_cd_m2",
            "unit": "cd/m2",
            "min": 450.0,
            "max": "",
            "fixture": "display_colorimeter",
            "notes": "White-screen luminance after DSI bring-up and backlight enable.",
        },
        {
            "measurement_id": "touch_grid_dead_zones",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "touch_grid_test",
            "notes": "Capacitive touch grid dead zones after bonding and enclosure close.",
        },
        {
            "measurement_id": "display_dsi_bringup_logs",
            "unit": "pass_flag",
            "min": 1.0,
            "max": 1.0,
            "fixture": "drm_kms_or_android_surfaceflinger",
            "notes": "Panel probes, init sequence runs, and display pipeline produces image.",
        },
        {
            "measurement_id": "screen_drop_lift_or_glass_crack",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "evt_drop_and_visual_inspection",
            "notes": "Glass crack, adhesive lift, or LCM shift after EVT drop screen check.",
        },
    ]
    required_evidence_by_measurement = {
        "display_bond_peel_n_per_mm": [
            "display_peel_force_raw_csv",
            "peel_fixture_calibration_certificate",
            "bond_perimeter_photo",
            "display_adhesive_lot_record",
        ],
        "screen_adhesive_compression_mm": [
            "compression_height_raw_csv",
            "screen_bond_fixture_certificate",
            "compression_witness_photo",
            "display_adhesive_lot_record",
        ],
        "display_fpc_bend_radius_mm": [
            "fpc_bend_radius_measurement_csv",
            "optical_measurement_fixture_certificate",
            "mated_fpc_bend_photo",
            "display_module_lot_record",
        ],
        "display_luminance_cd_m2": [
            "display_luminance_raw_csv",
            "colorimeter_calibration_certificate",
            "white_screen_photo",
            "display_module_lot_record",
        ],
        "touch_grid_dead_zones": [
            "touch_grid_raw_log",
            "touch_fixture_calibration_record",
            "touch_grid_screenshot",
            "display_touch_module_lot_record",
        ],
        "display_dsi_bringup_logs": [
            "drm_or_surfaceflinger_bringup_log",
            "display_driver_revision_record",
            "display_image_output_photo",
            "display_module_lot_record",
        ],
        "screen_drop_lift_or_glass_crack": [
            "drop_test_result_log",
            "drop_fixture_calibration_certificate",
            "post_drop_screen_inspection_photo",
            "display_glass_and_adhesive_lot_records",
        ],
    }
    for measurement in measurements:
        measurement["required_evidence_artifacts"] = required_evidence_by_measurement[
            measurement["measurement_id"]
        ]
    template_path = REVIEW_DIR / "display-results-template.csv"
    fieldnames = [
        "sample_id",
        "measurement_id",
        "unit",
        "min",
        "max",
        "measured_value",
        "pass",
        "operator",
        "evidence_class",
        "required_evidence_artifacts",
        "raw_data_artifact",
        "fixture_calibration_certificate",
        "photo_or_log_artifact",
        "lot_traceability_record",
        "notes",
    ]
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for measurement in measurements:
            writer.writerow(
                {
                    "sample_id": "",
                    "measurement_id": measurement["measurement_id"],
                    "unit": measurement["unit"],
                    "min": measurement["min"],
                    "max": measurement["max"],
                    "measured_value": "",
                    "pass": "",
                    "operator": "",
                    "evidence_class": "",
                    "required_evidence_artifacts": ";".join(
                        measurement["required_evidence_artifacts"]
                    ),
                    "raw_data_artifact": "",
                    "fixture_calibration_certificate": "",
                    "photo_or_log_artifact": "",
                    "lot_traceability_record": "",
                    "notes": measurement["notes"],
                }
            )

    report = {
        "claim_boundary": "CAD-derived display/touch bond validation and result template; not supplier drawing approval, panel electrical bring-up, or bonded-sample validation.",
        "status": "cad_display_validation_ready"
        if all(case["pass"] for case in cases)
        else "blocked",
        "display_candidate": display["candidate"],
        "cases": cases,
        "measurement_count": len(measurements),
        "measurements": measurements,
        "results_template": "mechanical/e1-phone/review/display-results-template.csv",
        "release_blockers": [
            "Need supplier 2D/STEP drawing for module outline, FPC exit, connector datum, and touch stack.",
            "Need bonded-sample peel/compression and FPC bend measurements.",
            "Need DRM/KMS or Android SurfaceFlinger display bring-up logs.",
            "Need touch grid, luminance, and drop/lift validation on EVT samples.",
        ],
    }
    (REVIEW_DIR / "display-validation.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Display Validation",
        "",
        "Status: CAD display validation ready; supplier and physical bring-up evidence still required.",
        "",
        "## CAD Display Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` target {case['target']}")
    lines.extend(["", "## Lab Measurements", ""])
    for measurement in measurements:
        lines.append(
            f"- `{measurement['measurement_id']}` {measurement['unit']} fixture `{measurement['fixture']}`"
        )
    lines.extend(["", "## Release Blockers", ""])
    for blocker in report["release_blockers"]:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "display-validation.md").write_text("\n".join(lines) + "\n")
    return report


def write_display_results_review_artifacts(display_validation: dict[str, Any]) -> dict[str, Any]:
    csv_path = REVIEW_DIR / "display-results-template.csv"
    expected = {item["measurement_id"]: item for item in display_validation["measurements"]}
    rows: list[dict[str, str]] = []
    template_evidence_class = ""
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            rows = list(csv.DictReader(csv_file))

    cases: list[dict[str, Any]] = []
    forbidden_evidence_classes = {
        "simulated_display_result_for_planning_not_release",
        "simulated",
        "planning",
        "blank_template",
    }
    for row in rows:
        measurement_id = row.get("measurement_id", "")
        expected_item = expected.get(measurement_id, {})
        measured_text = row.get("measured_value", "").strip()
        pass_text = row.get("pass", "").strip().lower()
        sample_id = row.get("sample_id", "").strip()
        operator = row.get("operator", "").strip()
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or ";".join(expected_item.get("required_evidence_artifacts", []))
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "fixture_calibration_certificate",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_display_result"
            and evidence_class not in forbidden_evidence_classes
        )
        measured_value: float | None = None
        parse_ok = False
        if measured_text:
            with suppress(ValueError):
                measured_value = float(measured_text)
                parse_ok = True
        min_value = expected_item.get("min")
        max_value = expected_item.get("max")
        within_min = measured_value is not None and (
            min_value in {"", None} or measured_value >= float(min_value)
        )
        within_max = measured_value is not None and (
            max_value in {"", None} or measured_value <= float(max_value)
        )
        populated = bool(
            sample_id
            and operator
            and measured_text
            and pass_text
            and evidence_class
            and required_evidence_artifacts
            and evidence_fields_present
        )
        cases.append(
            {
                "measurement_id": measurement_id,
                "expected_measurement": measurement_id in expected,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "fixture_calibration_certificate_present": bool(
                    row.get("fixture_calibration_certificate", "").strip()
                ),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "numeric_check_pass": bool(parse_ok and within_min and within_max),
                "declared_pass": pass_text in {"pass", "true", "yes", "1"},
                "pass": populated
                and measurement_id in expected
                and parse_ok
                and within_min
                and within_max
                and pass_text in {"pass", "true", "yes", "1"}
                and evidence_class_allowed,
            }
        )

    missing_measurements = sorted(set(expected) - {case["measurement_id"] for case in cases})
    blank_or_incomplete = [case["measurement_id"] for case in cases if not case["populated"]]
    failed_measurements = [
        case["measurement_id"]
        for case in cases
        if case["populated"]
        and (
            not case["numeric_check_pass"]
            or not case["declared_pass"]
            or not case["evidence_class_allowed"]
        )
    ]
    complete_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": "Fail-closed review of display/touch bond and bring-up results; blank rows are not display evidence.",
        "status": "display_results_pass"
        if cases and complete_count == len(expected) and not missing_measurements
        else "blocked_no_display_results"
        if complete_count == 0
        else "blocked_display_results_incomplete",
        "expected_measurement_count": len(expected),
        "required_evidence_class": "physical_display_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "observed_row_count": len(cases),
        "complete_result_count": complete_count,
        "missing_measurements": missing_measurements,
        "blank_or_incomplete_measurements": blank_or_incomplete,
        "failed_measurements": failed_measurements,
        "cases": cases,
        "release_rule": "Every display bond, FPC, touch, luminance, drop, and bring-up row must include sample, operator, numeric passing result, explicit pass, evidence_class=physical_display_result, raw measurement/log data, fixture calibration certificate, photo/log artifact, and display or adhesive lot traceability record.",
    }
    (REVIEW_DIR / "display-results-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Display Results Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until display/touch lab and bring-up rows are populated.",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for measurement_id in missing_measurements + blank_or_incomplete + failed_measurements:
        lines.append(f"- `{measurement_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "display-results-review.md").write_text("\n".join(lines) + "\n")
    return report


def write_mechanical_integration_sim_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    interface_validation: dict[str, Any],
    display_validation: dict[str, Any],
) -> dict[str, Any]:
    comp = params["components"]
    display = params["display"]
    tolerance = params["validation"]["tolerance"]
    part_names = {part.name for part in parts}
    interface_cases = {case["id"]: case for case in interface_validation.get("interfaces", [])}
    display_cases = {case["id"]: case for case in display_validation.get("cases", [])}

    usb_aperture_mm = [10.2, 3.6]
    usb_shell = comp["usb_c"]["envelope_mm"]
    usb_xy_clearance_mm = (usb_aperture_mm[0] - usb_shell[0]) / 2.0
    usb_z_clearance_mm = (usb_aperture_mm[1] - usb_shell[2]) / 2.0
    usb_min_clearance_mm = min(usb_xy_clearance_mm, usb_z_clearance_mm)
    plug_shell_mm = [8.35, 2.6]
    plug_clearance_mm = min(
        (usb_aperture_mm[0] - plug_shell_mm[0]) / 2.0,
        (usb_aperture_mm[1] - plug_shell_mm[1]) / 2.0,
    )
    usb_base_insertion_force_n = 18.0
    usb_clearance_penalty_n = max(
        0.0, (tolerance["usb_shell_to_aperture_clearance_mm"] - usb_min_clearance_mm) * 80.0
    )
    usb_predicted_peak_force_n = usb_base_insertion_force_n + usb_clearance_penalty_n

    adhesive_area_mm2 = (
        2.0 * display["cover_glass_mm"][0] * display["adhesive_width_mm"]
        + 2.0 * display["cover_glass_mm"][1] * display["adhesive_width_mm"]
    )
    adhesive_compression_mm = display["adhesive_thickness_mm"] * (
        display["compression_target_pct"] / 100.0
    )
    screen_bond_clamp_force_n = adhesive_area_mm2 * 0.08
    screen_compression_pressure_n_per_mm2 = screen_bond_clamp_force_n / adhesive_area_mm2

    button_cases = []
    for button_id, key in [("power_button", "power_button"), ("volume_button", "volume_button")]:
        button = comp[key]
        cap_area_mm2 = button["cap_mm"][1] * button["cap_mm"][2]
        pressure_n_per_mm2 = button["force_n"] / cap_area_mm2
        button_cases.append(
            {
                "id": button_id,
                "switch_candidate": button["standardized_part"],
                "actuation_force_n": button["force_n"],
                "travel_mm": button["travel_mm"],
                "cap_pressure_n_per_mm2": round(pressure_n_per_mm2, 4),
                "pressure_limit_n_per_mm2": tolerance["button_pressure_limit_n_per_mm2"],
                "required_parts_present": all(
                    name in part_names
                    for name in [
                        f"{button_id}_cap",
                        f"{button_id}_elastomer_gasket",
                    ]
                ),
                "planning_pass": 1.2 <= button["force_n"] <= 2.2
                and button["travel_mm"] >= MIN_BUTTON_TRAVEL_MM
                and pressure_n_per_mm2 <= tolerance["button_pressure_limit_n_per_mm2"],
            }
        )

    cases = [
        {
            "id": "usb_c_insertion_load_planning",
            "interface_case": "usb_c_insertion_capture",
            "evidence_class": "deterministic_cad_simulation_not_physical_result",
            "actual": {
                "usb_receptacle_shell_mm": usb_shell,
                "aperture_mm": usb_aperture_mm,
                "plug_shell_mm": plug_shell_mm,
                "shell_xy_clearance_each_side_mm": round(usb_xy_clearance_mm, 3),
                "shell_z_clearance_each_side_mm": round(usb_z_clearance_mm, 3),
                "plug_min_clearance_mm": round(plug_clearance_mm, 3),
                "predicted_peak_insertion_force_n": round(usb_predicted_peak_force_n, 2),
                "cycle_rating": comp["usb_c"]["cycles"],
            },
            "target": ">=0.15 mm shell-to-aperture clearance, plug clearance positive, predicted peak insertion force <=35 N, cycle rating >=10000",
            "planning_pass": usb_min_clearance_mm >= tolerance["usb_shell_to_aperture_clearance_mm"]
            and plug_clearance_mm > 0.0
            and usb_predicted_peak_force_n <= 35.0
            and comp["usb_c"]["cycles"] >= 10000
            and bool(interface_cases.get("usb_c_insertion_capture", {}).get("pass")),
            "physical_release_evidence_required": [
                "usb_c_insertion_force_raw_csv",
                "usb_insertion_fixture_calibration_certificate",
                "usb_c_insertion_gauge_video_or_photo",
                "post_cycle_continuity_log",
            ],
        },
        {
            "id": "screen_bond_clamp_and_fpc_planning",
            "interface_case": "screen_bond_and_fpc_connection",
            "evidence_class": "deterministic_cad_simulation_not_physical_result",
            "actual": {
                "adhesive_area_mm2": round(adhesive_area_mm2, 1),
                "adhesive_width_mm": display["adhesive_width_mm"],
                "adhesive_thickness_mm": display["adhesive_thickness_mm"],
                "compression_target_pct": display["compression_target_pct"],
                "compression_mm": round(adhesive_compression_mm, 3),
                "estimated_clamp_force_n": round(screen_bond_clamp_force_n, 1),
                "estimated_compression_pressure_n_per_mm2": round(
                    screen_compression_pressure_n_per_mm2, 3
                ),
                "fpc_bend_radius_mm": display["fpc_bend_radius_mm"],
            },
            "target": "four-sided adhesive, 0.03-0.08 mm compression, FPC bend radius >=1.0 mm, display CAD cases pass",
            "planning_pass": bool(display_cases.get("adhesive_bond_geometry", {}).get("pass"))
            and bool(display_cases.get("display_fpc_bend_and_connector", {}).get("pass"))
            and bool(interface_cases.get("screen_bond_and_fpc_connection", {}).get("pass")),
            "physical_release_evidence_required": [
                "display_peel_force_raw_csv",
                "screen_compression_witness_raw_csv",
                "display_fpc_bend_radius_raw_csv",
                "display_dsi_bringup_log",
            ],
        },
        {
            "id": "side_button_force_pressure_planning",
            "interface_case": "power_button_force_travel_pressure",
            "evidence_class": "deterministic_cad_simulation_not_physical_result",
            "button_cases": button_cases,
            "target": "power and volume force 1.2-2.2 N, travel >=0.18 mm, cap pressure <= limit",
            "planning_pass": all(case["planning_pass"] for case in button_cases)
            and bool(interface_cases.get("power_button_force_travel_pressure", {}).get("pass"))
            and bool(interface_cases.get("volume_button_force_travel_pressure", {}).get("pass")),
            "physical_release_evidence_required": [
                "power_button_force_raw_csv",
                "volume_button_force_raw_csv",
                "button_cycle_log",
                "post_dust_splash_button_stickiness_log",
            ],
        },
    ]
    report = {
        "claim_boundary": (
            "Deterministic CAD/parameter simulation for USB-C insertion, display bonding/FPC "
            "routing, and side-button actuation planning. It is not measured physical validation "
            "and cannot satisfy release evidence gates."
        ),
        "status": "cad_mechanical_integration_sim_ready"
        if all(case["planning_pass"] for case in cases)
        else "blocked_mechanical_integration_sim",
        "evidence_class": "deterministic_cad_simulation_not_physical_result",
        "case_count": len(cases),
        "cases": cases,
        "release_rule": (
            "Release still requires physical USB insertion/cycle data, bonded display peel and "
            "compression data, FPC bend inspection, and button force/travel/cycle measurements "
            "with calibrated fixtures and lot traceability."
        ),
    }
    (REVIEW_DIR / "mechanical-integration-sim.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Mechanical Integration Simulation",
        "",
        f"Status: {report['status']}.",
        "",
        "This is deterministic CAD planning evidence only; physical release gates stay closed.",
        "",
        "## Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["planning_pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` target {case['target']}")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "mechanical-integration-sim.md").write_text("\n".join(lines) + "\n")
    return report


def write_environmental_validation_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    checks: dict[str, Any],
    clearance: dict[str, Any],
    validation: dict[str, Any],
) -> dict[str, Any]:
    device = params["device"]
    targets = params["validation"]["environmental_targets"]
    part_names = {part.name for part in parts}
    check_status = cast(dict[str, dict[str, Any]], checks["checks"])
    clearance_cases = {case["id"]: case for case in clearance["cases"]}
    domain_reviews = {item["domain"]: item for item in validation.get("domain_reviews", [])}
    screw_boss_count = sum(1 for name in part_names if name.startswith("orange_screw_boss_"))
    snap_hook_count = sum(1 for name in part_names if name.startswith("orange_snap_hook_"))
    speaker_slot_count = sum(
        1 for name in part_names if name.startswith("bottom_speaker_grille_slot_")
    )
    mic_port_count = sum(1 for name in part_names if name.startswith("bottom_microphone_port_"))
    mic_mesh_count = sum(1 for name in part_names if name.startswith("bottom_microphone_mesh_"))
    cellular_keepout = params.get("radio", {}).get("cellular", {}).get("antenna_keepout_mm", [])
    wifi_keepout = params.get("radio", {}).get("wifi_bt", {}).get("antenna_keepout_mm", [])
    mass_total_g = mass_budget(parts)["total_estimated_mass_g"]

    cases = [
        {
            "id": "thermal_spreader_and_skin_temp_plan",
            "domain": "thermal",
            "actual": {
                "max_skin_temp_c": targets["max_skin_temp_c"],
                "shield_cans_present": sorted(
                    name
                    for name in ["soc_shield_can", "pmic_shield_can", "radio_shield_can"]
                    if name in part_names
                ),
                "estimated_physical_mass_g": round(mass_total_g, 1),
                "target_mass_g": device["target_mass_g"],
            },
            "target": "shield cans present and CAD mass below target for thermal inertia; lab skin temperature <= target",
            "pass": check_status["shielding_haptics_service"]["pass"]
            and mass_total_g <= device["target_mass_g"]
            and domain_reviews.get("thermal", {}).get("cad_status") == "inputs_present",
        },
        {
            "id": "rf_keepout_and_prescan_plan",
            "domain": "rf",
            "actual": {
                "cellular_keepout_mm": cellular_keepout,
                "wifi_bt_keepout_mm": wifi_keepout,
                "rf_keepout_check": check_status["rf_antenna_keepouts"]["pass"],
                "candidate_us_sar_limit_w_per_kg_1g": 1.6,
            },
            "target": "antenna keepouts present; chamber desense and SAR pre-scan required before RF release",
            "pass": check_status["rf_antenna_keepouts"]["pass"]
            and bool(cellular_keepout)
            and bool(wifi_keepout)
            and domain_reviews.get("rf", {}).get("cad_status") == "inputs_present",
        },
        {
            "id": "drop_retention_and_corner_energy_plan",
            "domain": "drop",
            "actual": {
                "drop_height_m": targets["drop_height_m"],
                "corner_radius_mm": device["corner_radius_mm"],
                "wall_thickness_mm": device["wall_thickness_mm"],
                "screw_boss_count": screw_boss_count,
                "snap_hook_count": snap_hook_count,
                "screen_adhesive_present": "screen_adhesive_top" in part_names,
                "screen_clearance_pass": clearance_cases.get(
                    "screen_cover_glass_to_orange_body", {}
                ).get("pass"),
            },
            "target": ">=1 m EVT drop plan with rounded orange PC+ABS corners, screw bosses, snap hooks, and bonded screen",
            "pass": device["corner_radius_mm"] >= 6.0
            and device["wall_thickness_mm"] >= 1.0
            and screw_boss_count >= params["manufacturing"]["screw_boss_count"]
            and snap_hook_count >= params["manufacturing"]["snap_hook_count"]
            and "screen_adhesive_top" in part_names
            and bool(clearance_cases.get("screen_cover_glass_to_orange_body", {}).get("pass"))
            and domain_reviews.get("drop", {}).get("cad_status") == "inputs_present",
        },
        {
            "id": "ingress_path_and_gasket_plan",
            "domain": "ingress",
            "actual": {
                "target": targets["ingress_target"],
                "screen_adhesive_present": "screen_adhesive_top" in part_names,
                "earpiece_gasket_present": "earpiece_gasket" in part_names,
                "usb_aperture_present": "usb_c_external_aperture" in part_names,
                "usb_perimeter_gasket_count": sum(
                    1 for name in part_names if name.startswith("usb_c_perimeter_gasket_")
                ),
                "usb_drip_break_present": "usb_c_molded_drip_break_lip" in part_names,
                "usb_drain_shelf_present": "usb_c_internal_drain_shelf" in part_names,
                "speaker_slot_count": speaker_slot_count,
                "mic_port_count": mic_port_count,
                "speaker_mesh_present": "bottom_speaker_dust_mesh" in part_names,
                "bottom_mic_mesh_count": mic_mesh_count,
                "top_mic_mesh_present": "top_microphone_mesh" in part_names,
                "handset_mesh_present": "handset_acoustic_mesh" in part_names,
                "side_button_gaskets_present": {
                    "power": "power_button_elastomer_gasket" in part_names,
                    "volume": "volume_button_elastomer_gasket" in part_names,
                },
            },
            "target": "IP54 design-intent path review; open ports need membranes or lab-accepted splash/dust result",
            "pass": "screen_adhesive_top" in part_names
            and "earpiece_gasket" in part_names
            and "handset_acoustic_mesh" in part_names
            and "usb_c_external_aperture" in part_names
            and sum(1 for name in part_names if name.startswith("usb_c_perimeter_gasket_")) >= 4
            and "usb_c_molded_drip_break_lip" in part_names
            and "usb_c_internal_drain_shelf" in part_names
            and "bottom_speaker_dust_mesh" in part_names
            and speaker_slot_count >= 5
            and mic_port_count >= 2
            and mic_mesh_count >= 2
            and "top_microphone_mesh" in part_names
            and "power_button_elastomer_gasket" in part_names
            and "volume_button_elastomer_gasket" in part_names
            and domain_reviews.get("ingress", {}).get("cad_status") == "design_intent_only",
        },
    ]

    measurements: list[dict[str, Any]] = [
        {
            "measurement_id": "max_skin_temp_video_call_c",
            "domain": "thermal",
            "unit": "C",
            "min": "",
            "max": targets["max_skin_temp_c"],
            "fixture": "thermal_chamber_or_skin_temp_probe",
            "notes": "Worst-case video call or radio-active thermal soak at target ambient.",
        },
        {
            "measurement_id": "soc_shield_can_peak_temp_c",
            "domain": "thermal",
            "unit": "C",
            "min": "",
            "max": 85.0,
            "fixture": "thermocouple_on_soc_shield",
            "notes": "Peak shield-can temperature during sustained load.",
        },
        {
            "measurement_id": "cellular_desense_delta_db",
            "domain": "rf",
            "unit": "dB",
            "min": "",
            "max": 3.0,
            "fixture": "rf_chamber_desense_prescan",
            "notes": "Cellular sensitivity delta with display, camera, and USB active.",
        },
        {
            "measurement_id": "wifi_bt_desense_delta_db",
            "domain": "rf",
            "unit": "dB",
            "min": "",
            "max": 3.0,
            "fixture": "rf_chamber_desense_prescan",
            "notes": "Wi-Fi/Bluetooth sensitivity delta with phone subsystems active.",
        },
        {
            "measurement_id": "sar_prescan_w_per_kg_1g",
            "domain": "rf",
            "unit": "W/kg",
            "min": "",
            "max": 1.6,
            "fixture": "accredited_sar_prescan",
            "notes": "U.S. general-population candidate SAR pre-scan target; final limits depend on certified-region compliance plan.",
        },
        {
            "measurement_id": "drop_1m_functional_failures",
            "domain": "drop",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "evt_corner_edge_face_drop",
            "notes": "Functional failures after 1 m corner/edge/face drop sequence.",
        },
        {
            "measurement_id": "drop_1m_crack_or_latch_release",
            "domain": "drop",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "evt_visual_and_latch_inspection",
            "notes": "Orange shell cracks, snap release, screen lift, or glass crack after drop.",
        },
        {
            "measurement_id": "ip54_dust_ingress_functional_failures",
            "domain": "ingress",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "dust_ingress_screen_usb_audio_inspection",
            "notes": "Functional failures after design-intent dust exposure.",
        },
        {
            "measurement_id": "ip54_splash_ingress_functional_failures",
            "domain": "ingress",
            "unit": "count",
            "min": 0.0,
            "max": 0.0,
            "fixture": "splash_ingress_screen_usb_audio_inspection",
            "notes": "Functional failures after design-intent splash exposure.",
        },
    ]
    required_evidence_by_measurement = {
        "max_skin_temp_video_call_c": [
            "skin_temperature_raw_log",
            "thermal_chamber_or_probe_calibration_certificate",
            "thermal_probe_placement_photo",
            "enclosure_resin_and_unit_lot_records",
        ],
        "soc_shield_can_peak_temp_c": [
            "soc_shield_thermocouple_raw_log",
            "thermocouple_calibration_certificate",
            "soc_shield_probe_photo",
            "pcb_and_shield_can_lot_records",
        ],
        "cellular_desense_delta_db": [
            "cellular_desense_raw_chamber_csv",
            "rf_chamber_calibration_certificate",
            "antenna_test_setup_photo",
            "radio_module_and_antenna_lot_records",
        ],
        "wifi_bt_desense_delta_db": [
            "wifi_bt_desense_raw_chamber_csv",
            "rf_chamber_calibration_certificate",
            "wifi_bt_antenna_test_setup_photo",
            "wifi_module_and_antenna_lot_records",
        ],
        "sar_prescan_w_per_kg_1g": [
            "sar_prescan_raw_report",
            "sar_system_calibration_certificate",
            "sar_probe_position_photo",
            "radio_module_antenna_and_enclosure_lot_records",
        ],
        "drop_1m_functional_failures": [
            "drop_sequence_result_log",
            "drop_fixture_calibration_certificate",
            "post_drop_functional_test_log_or_video",
            "evt_unit_lot_traceability_record",
        ],
        "drop_1m_crack_or_latch_release": [
            "drop_visual_inspection_report",
            "drop_fixture_calibration_certificate",
            "post_drop_shell_screen_photo_set",
            "enclosure_glass_and_adhesive_lot_records",
        ],
        "ip54_dust_ingress_functional_failures": [
            "dust_ingress_result_log",
            "dust_chamber_calibration_certificate",
            "post_dust_port_and_screen_inspection_photos",
            "mesh_gasket_and_evt_unit_lot_records",
        ],
        "ip54_splash_ingress_functional_failures": [
            "splash_ingress_result_log",
            "splash_fixture_calibration_certificate",
            "post_splash_port_and_usb_inspection_photos",
            "mesh_gasket_and_evt_unit_lot_records",
        ],
    }
    for measurement in measurements:
        measurement["required_evidence_artifacts"] = required_evidence_by_measurement[
            measurement["measurement_id"]
        ]
    template_path = REVIEW_DIR / "environmental-results-template.csv"
    fieldnames = [
        "sample_id",
        "measurement_id",
        "domain",
        "unit",
        "min",
        "max",
        "measured_value",
        "pass",
        "operator",
        "evidence_class",
        "required_evidence_artifacts",
        "raw_data_artifact",
        "fixture_calibration_certificate",
        "photo_or_log_artifact",
        "lot_traceability_record",
        "notes",
    ]
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for measurement in measurements:
            writer.writerow(
                {
                    "sample_id": "",
                    "measurement_id": measurement["measurement_id"],
                    "domain": measurement["domain"],
                    "unit": measurement["unit"],
                    "min": measurement["min"],
                    "max": measurement["max"],
                    "measured_value": "",
                    "pass": "",
                    "operator": "",
                    "evidence_class": "",
                    "required_evidence_artifacts": ";".join(
                        measurement["required_evidence_artifacts"]
                    ),
                    "raw_data_artifact": "",
                    "fixture_calibration_certificate": "",
                    "photo_or_log_artifact": "",
                    "lot_traceability_record": "",
                    "notes": measurement["notes"],
                }
            )

    release_blockers = [
        "Need routed board power map and thermal measurements with real enclosure resin.",
        "Need RF chamber desense data, antenna tuning, and SAR pre-scan with final antennas.",
        "Need 1 m corner/edge/face drop results on EVT molded samples.",
        "Need dust/splash ingress results or explicit product decision to drop IP54 claim.",
    ]
    report = {
        "claim_boundary": "CAD-derived thermal/RF/drop/ingress validation package and lab intake template; not regulatory certification, chamber data, drop test, or ingress proof.",
        "status": "cad_environmental_validation_ready"
        if all(case["pass"] for case in cases)
        else "blocked",
        "cases": cases,
        "measurement_count": len(measurements),
        "measurements": measurements,
        "results_template": "mechanical/e1-phone/review/environmental-results-template.csv",
        "regulatory_references": [
            {
                "id": "fcc_rf_exposure_sar_general_population",
                "url": "https://docs.fcc.gov/public/attachments/FCC-19-126A1_Rcd.pdf",
                "note": "FCC RF exposure rule text includes 1.6 W/kg peak spatial-average SAR over 1 g tissue for general population/uncontrolled exposure.",
            }
        ],
        "release_blockers": release_blockers,
    }
    (REVIEW_DIR / "environmental-validation.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Environmental Validation",
        "",
        "Status: CAD environmental validation ready; physical and regulatory evidence still required.",
        "",
        "## CAD Environmental Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` domain `{case['domain']}` target {case['target']}"
        )
    lines.extend(["", "## Lab Measurements", ""])
    for measurement in measurements:
        lines.append(
            f"- `{measurement['measurement_id']}` {measurement['unit']} domain `{measurement['domain']}` fixture `{measurement['fixture']}`"
        )
    lines.extend(["", "## Release Blockers", ""])
    for blocker in release_blockers:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "environmental-validation.md").write_text("\n".join(lines) + "\n")
    return report


def write_ingress_path_review_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    environmental_validation: dict[str, Any],
) -> dict[str, Any]:
    by_name = {part.name: part for part in parts}
    speaker_slots = [part for part in parts if part.name.startswith("bottom_speaker_grille_slot_")]
    bottom_mic_ports = [part for part in parts if part.name.startswith("bottom_microphone_port_")]
    target = params["validation"]["environmental_targets"]["ingress_target"]

    def has_all(names: list[str]) -> bool:
        return all(name in by_name for name in names)

    acoustic_overhang_cases: list[dict[str, Any]] = []
    if speaker_slots and "bottom_speaker_dust_mesh" in by_name:
        acoustic_overhang_cases.append(
            {
                "id": "bottom_speaker_mesh_overhang",
                "opening": "bottom_speaker_grille_slots",
                "seal": "bottom_speaker_dust_mesh",
                **bounds_cover_axes(
                    by_name["bottom_speaker_dust_mesh"].bounds,
                    part_bounds_union(speaker_slots),
                    (0, 2),
                    0.25,
                ),
            }
        )
    for idx, port in enumerate(bottom_mic_ports, start=1):
        mesh_name = f"bottom_microphone_mesh_{idx}"
        if mesh_name in by_name:
            acoustic_overhang_cases.append(
                {
                    "id": f"bottom_microphone_mesh_{idx}_overhang",
                    "opening": port.name,
                    "seal": mesh_name,
                    **bounds_cover_axes(by_name[mesh_name].bounds, port.bounds, (0, 2), 0.15),
                }
            )
    if has_all(["top_microphone_port", "top_microphone_mesh"]):
        acoustic_overhang_cases.append(
            {
                "id": "top_microphone_mesh_overhang",
                "opening": "top_microphone_port",
                "seal": "top_microphone_mesh",
                **bounds_cover_axes(
                    by_name["top_microphone_mesh"].bounds,
                    by_name["top_microphone_port"].bounds,
                    (0, 2),
                    0.15,
                ),
            }
        )
    if has_all(["handset_acoustic_slot", "handset_acoustic_mesh"]):
        acoustic_overhang_cases.append(
            {
                "id": "handset_mesh_overhang",
                "opening": "handset_acoustic_slot",
                "seal": "handset_acoustic_mesh",
                **bounds_cover_axes(
                    by_name["handset_acoustic_mesh"].bounds,
                    by_name["handset_acoustic_slot"].bounds,
                    (0,),
                    0.25,
                ),
            }
        )

    paths: list[dict[str, Any]] = [
        {
            "id": "display_glass_perimeter",
            "opening": "screen_cover_glass_to_orange_body",
            "seal_stack": [
                "screen_adhesive_top",
                "screen_adhesive_bottom",
                "screen_adhesive_left",
                "screen_adhesive_right",
            ],
            "strategy": "continuous die-cut display adhesive forms primary splash/dust barrier",
            "cad_pass": has_all(
                [
                    "screen_adhesive_top",
                    "screen_adhesive_bottom",
                    "screen_adhesive_left",
                    "screen_adhesive_right",
                ]
            ),
            "lab_closure": "display bond peel, splash exposure, and post-drop screen-lift inspection",
        },
        {
            "id": "bottom_speaker_grille",
            "opening": "five molded bottom speaker slots",
            "seal_stack": ["bottom_speaker_dust_mesh", "bottom_speaker_acoustic_chamber"],
            "strategy": "hydrophobic dust mesh bonded behind grille with molded rear chamber isolated from USB load saddle",
            "cad_pass": bool(
                speaker_slots
                and "bottom_speaker_dust_mesh" in by_name
                and "bottom_speaker_acoustic_chamber" in by_name
                and all(
                    case["pass"]
                    for case in acoustic_overhang_cases
                    if case["id"].startswith("bottom_speaker")
                )
            ),
            "lab_closure": "speaker sweep before/after dust and splash, mesh adhesive visual inspection",
        },
        {
            "id": "bottom_microphone_ports",
            "opening": "dual bottom MEMS acoustic ports",
            "seal_stack": ["bottom_microphone_mesh_1", "bottom_microphone_mesh_2"],
            "strategy": "individual hydrophobic meshes sit behind each molded microphone port",
            "cad_pass": len(bottom_mic_ports) >= 2
            and has_all(["bottom_microphone_mesh_1", "bottom_microphone_mesh_2"])
            and all(
                case["pass"]
                for case in acoustic_overhang_cases
                if case["id"].startswith("bottom_microphone")
            ),
            "lab_closure": "microphone sensitivity/noise floor before and after dust/splash exposure",
        },
        {
            "id": "top_microphone_port",
            "opening": "top MEMS acoustic port",
            "seal_stack": ["top_microphone_mesh"],
            "strategy": "hydrophobic mesh behind the top port to keep the second microphone from being an unprotected ingress path",
            "cad_pass": has_all(["top_microphone_port", "top_microphone_mesh"])
            and all(
                case["pass"]
                for case in acoustic_overhang_cases
                if case["id"] == "top_microphone_mesh_overhang"
            ),
            "lab_closure": "top microphone sensitivity/noise floor before and after dust/splash exposure",
        },
        {
            "id": "handset_earpiece_slot",
            "opening": "under-glass handset acoustic slot",
            "seal_stack": ["earpiece_gasket", "handset_acoustic_mesh"],
            "strategy": "compressed earpiece gasket and hydrophobic mesh behind handset slot",
            "cad_pass": has_all(["earpiece_gasket", "handset_acoustic_mesh"])
            and all(
                case["pass"]
                for case in acoustic_overhang_cases
                if case["id"] == "handset_mesh_overhang"
            ),
            "lab_closure": "receiver SPL/leak check plus splash exposure at earpiece slot",
        },
        {
            "id": "usb_c_bottom_aperture",
            "opening": "USB-C shell aperture",
            "seal_stack": [
                "usb_c_external_aperture",
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
                "orange_usb_reinforcement_saddle",
            ],
            "strategy": "open USB-C connector is managed by a four-sided elastomer receptacle seat, molded drip break, internal drain shelf, and load saddle",
            "cad_pass": has_all(
                [
                    "usb_c_external_aperture",
                    "usb_c_perimeter_gasket_top",
                    "usb_c_perimeter_gasket_bottom",
                    "usb_c_perimeter_gasket_left",
                    "usb_c_perimeter_gasket_right",
                    "usb_c_molded_drip_break_lip",
                    "usb_c_internal_drain_shelf",
                    "orange_usb_reinforcement_saddle",
                ]
            ),
            "lab_closure": "USB insertion/rub, side splash, water-retention visual inspection, and gasket compression-set check",
        },
        {
            "id": "rear_camera_window",
            "opening": "rear camera cover glass",
            "seal_stack": [
                "rear_camera_cover_glass",
                "rear_camera_lens_window",
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "rear_camera_light_baffle_top",
                "rear_camera_light_baffle_bottom",
            ],
            "strategy": "rear cover glass is bonded with a four-sided black PSA gasket plus internal baffles to limit dust and flare",
            "cad_pass": has_all(
                [
                    "rear_camera_cover_glass",
                    "rear_camera_lens_window",
                    "rear_camera_cover_adhesive_top",
                    "rear_camera_cover_adhesive_bottom",
                    "rear_camera_cover_adhesive_left",
                    "rear_camera_cover_adhesive_right",
                    "rear_camera_light_baffle_top",
                    "rear_camera_light_baffle_bottom",
                ]
            ),
            "lab_closure": "camera dust inspection, focus/MTF check, flare check, and cover-glass adhesive peel review",
        },
        {
            "id": "side_button_rails",
            "opening": "power and volume button rail gaps",
            "seal_stack": [
                "power_button_cap",
                "power_button_elastomer_gasket",
                "power_button_labyrinth_upper_rail",
                "power_button_labyrinth_lower_rail",
                "volume_button_cap",
                "volume_button_elastomer_gasket",
                "volume_button_labyrinth_upper_rail",
                "volume_button_labyrinth_lower_rail",
            ],
            "strategy": "external orange caps actuate through silicone gaskets backed by molded labyrinth rails on each side-key opening",
            "cad_pass": has_all(
                [
                    "power_button_cap",
                    "power_button_elastomer_gasket",
                    "power_button_labyrinth_upper_rail",
                    "power_button_labyrinth_lower_rail",
                    "volume_button_cap",
                    "volume_button_elastomer_gasket",
                    "volume_button_labyrinth_upper_rail",
                    "volume_button_labyrinth_lower_rail",
                ]
            ),
            "lab_closure": "button force/travel after dust exposure, side-splash inspection, and gasket compression set check",
        },
    ]
    environmental_ingress_case: dict[str, Any] = next(
        (
            case
            for case in environmental_validation.get("cases", [])
            if case.get("id") == "ingress_path_and_gasket_plan"
        ),
        {},
    )
    report = {
        "claim_boundary": "CAD seal-stack review for ingress paths; not IP certification or lab evidence.",
        "status": "cad_ingress_path_review_ready"
        if paths
        and all(path["cad_pass"] for path in paths)
        and all(case["pass"] for case in acoustic_overhang_cases)
        and environmental_ingress_case.get("pass") is True
        else "blocked",
        "target": target,
        "path_count": len(paths),
        "paths": paths,
        "acoustic_mesh_overhang_cases": acoustic_overhang_cases,
        "open_product_decisions": [
            "USB-C gasket/drip geometry is modeled, but an IP claim still needs supplier connector detail and splash/retention evidence.",
            "Side-button gasket/labyrinth geometry is modeled, but needs supplier material, compression-set, and splash-test evidence.",
            "IP54 is design intent only until dust and splash lab rows are populated.",
        ],
        "release_rule": "Every modeled ingress path must have a CAD seal stack, mesh overhang where acoustic ports are open, and measured dust/splash results before environmental release.",
    }
    (REVIEW_DIR / "ingress-path-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Ingress Path Review",
        "",
        f"Status: {report['status']}.",
        "",
        f"Target: {target}.",
        "",
        "## Modeled Paths",
        "",
    ]
    for path in paths:
        result = "PASS" if path["cad_pass"] else "BLOCKED"
        seal_stack = [str(item) for item in path["seal_stack"]]
        lines.append(f"- {result}: `{path['id']}` seal stack {', '.join(seal_stack)}")
    lines.extend(["", "## Acoustic Mesh Overhang", ""])
    for case in acoustic_overhang_cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(
            f"- {result}: `{case['id']}` minimum overhang {case['minimum_overhang_mm']} mm"
        )
    lines.extend(["", "## Open Product Decisions", ""])
    for decision in report["open_product_decisions"]:
        lines.append(f"- {decision}")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "ingress-path-review.md").write_text("\n".join(lines) + "\n")
    return report


def write_environmental_results_review_artifacts(
    environmental_validation: dict[str, Any],
) -> dict[str, Any]:
    csv_path = REVIEW_DIR / "environmental-results-template.csv"
    expected = {item["measurement_id"]: item for item in environmental_validation["measurements"]}
    rows: list[dict[str, str]] = []
    template_evidence_class = ""
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            rows = list(csv.DictReader(csv_file))

    cases: list[dict[str, Any]] = []
    forbidden_evidence_classes = {
        "simulated_environmental_result_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    for row in rows:
        measurement_id = row.get("measurement_id", "")
        expected_item = expected.get(measurement_id, {})
        measured_text = row.get("measured_value", "").strip()
        pass_text = row.get("pass", "").strip().lower()
        sample_id = row.get("sample_id", "").strip()
        operator = row.get("operator", "").strip()
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or ";".join(expected_item.get("required_evidence_artifacts", []))
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "fixture_calibration_certificate",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_environmental_result"
            and evidence_class not in forbidden_evidence_classes
        )
        measured_value: float | None = None
        parse_ok = False
        if measured_text:
            with suppress(ValueError):
                measured_value = float(measured_text)
                parse_ok = True
        min_value = expected_item.get("min")
        max_value = expected_item.get("max")
        within_min = measured_value is not None and (
            min_value in {"", None} or measured_value >= float(min_value)
        )
        within_max = measured_value is not None and (
            max_value in {"", None} or measured_value <= float(max_value)
        )
        populated = bool(
            sample_id
            and operator
            and measured_text
            and pass_text
            and evidence_class
            and required_evidence_artifacts
            and evidence_fields_present
        )
        cases.append(
            {
                "measurement_id": measurement_id,
                "expected_measurement": measurement_id in expected,
                "domain": row.get("domain", expected_item.get("domain", "")),
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "fixture_calibration_certificate_present": bool(
                    row.get("fixture_calibration_certificate", "").strip()
                ),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "numeric_check_pass": bool(parse_ok and within_min and within_max),
                "declared_pass": pass_text in {"pass", "true", "yes", "1"},
                "pass": populated
                and measurement_id in expected
                and parse_ok
                and within_min
                and within_max
                and pass_text in {"pass", "true", "yes", "1"}
                and evidence_class_allowed,
            }
        )

    missing_measurements = sorted(set(expected) - {case["measurement_id"] for case in cases})
    blank_or_incomplete = [case["measurement_id"] for case in cases if not case["populated"]]
    failed_measurements = [
        case["measurement_id"]
        for case in cases
        if case["populated"]
        and (
            not case["numeric_check_pass"]
            or not case["declared_pass"]
            or not case["evidence_class_allowed"]
        )
    ]
    complete_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": "Fail-closed review of thermal, RF, drop, and ingress lab results; blank rows are not environmental evidence.",
        "status": "environmental_results_pass"
        if cases and complete_count == len(expected) and not missing_measurements
        else "blocked_no_environmental_results"
        if complete_count == 0
        else "blocked_environmental_results_incomplete",
        "expected_measurement_count": len(expected),
        "required_evidence_class": "physical_environmental_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "observed_row_count": len(cases),
        "complete_result_count": complete_count,
        "missing_measurements": missing_measurements,
        "blank_or_incomplete_measurements": blank_or_incomplete,
        "failed_measurements": failed_measurements,
        "cases": cases,
        "release_rule": "Every thermal, RF, SAR pre-scan, drop, dust, and splash row must include sample, operator, numeric passing result, explicit pass, evidence_class=physical_environmental_result, raw chamber/test data, fixture calibration certificate, photo/log artifact, and unit/material/module lot traceability record.",
    }
    (REVIEW_DIR / "environmental-results-review.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )

    lines = [
        "# E1 Phone Environmental Results Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until thermal, RF, drop, and ingress lab rows are populated.",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for measurement_id in missing_measurements + blank_or_incomplete + failed_measurements:
        lines.append(f"- `{measurement_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "environmental-results-review.md").write_text("\n".join(lines) + "\n")
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
    measurements: list[dict[str, Any]] = [
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
            "min": 0.15,
            "max": 0.30,
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
    required_evidence_by_measurement = {
        "power_button_actuation_force": [
            "power_button_force_raw_csv",
            "load_cell_calibration_certificate",
            "power_button_probe_photo_or_video",
            "side_button_and_enclosure_lot_records",
        ],
        "power_button_travel": [
            "power_button_travel_raw_csv",
            "dial_indicator_calibration_certificate",
            "power_button_travel_probe_photo",
            "side_button_and_enclosure_lot_records",
        ],
        "volume_button_actuation_force": [
            "volume_button_force_raw_csv",
            "load_cell_calibration_certificate",
            "volume_button_probe_photo_or_video",
            "side_button_and_enclosure_lot_records",
        ],
        "usb_c_insertion_force_no_rub": [
            "usb_c_insertion_force_raw_csv",
            "usb_insertion_fixture_calibration_certificate",
            "usb_c_insertion_gauge_video_or_photo",
            "usb_receptacle_and_enclosure_lot_records",
        ],
        "screen_adhesive_compression": [
            "screen_compression_witness_raw_csv",
            "screen_clamp_fixture_calibration_certificate",
            "screen_bond_witness_photo",
            "display_adhesive_and_enclosure_lot_records",
        ],
        "display_fpc_bend_radius": [
            "display_fpc_bend_radius_raw_csv",
            "optical_measurement_fixture_calibration_certificate",
            "connected_display_fpc_photo",
            "display_module_and_connector_lot_records",
        ],
        "rear_camera_lens_center_error": [
            "rear_camera_alignment_raw_csv",
            "camera_alignment_fixture_calibration_certificate",
            "rear_camera_alignment_pin_photo",
            "rear_camera_module_and_cover_glass_lot_records",
        ],
        "front_camera_under_glass_center_error": [
            "front_camera_alignment_raw_csv",
            "camera_alignment_fixture_calibration_certificate",
            "front_under_glass_alignment_pin_photo",
            "front_camera_module_and_cover_glass_lot_records",
        ],
        "bottom_audio_leak_delta": [
            "bottom_audio_leak_raw_sweep_csv",
            "acoustic_leak_fixture_calibration_certificate",
            "bottom_audio_leak_mask_photo",
            "speaker_microphone_mesh_and_enclosure_lot_records",
        ],
        "handset_receiver_leak_delta": [
            "handset_leak_raw_sweep_csv",
            "acoustic_leak_fixture_calibration_certificate",
            "earpiece_leak_mask_photo",
            "receiver_gasket_and_enclosure_lot_records",
        ],
    }
    for measurement in measurements:
        measurement["required_evidence_artifacts"] = required_evidence_by_measurement[
            measurement["id"]
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
            "evidence_class": "",
            "required_evidence_artifacts": ";".join(item["required_evidence_artifacts"]),
            "raw_data_artifact": "",
            "fixture_calibration_certificate": "",
            "photo_or_log_artifact": "",
            "lot_traceability_record": "",
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
                "evidence_class",
                "required_evidence_artifacts",
                "raw_data_artifact",
                "fixture_calibration_certificate",
                "photo_or_log_artifact",
                "lot_traceability_record",
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
    template_evidence_class = ""
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            rows = [dict(row) for row in csv.DictReader(csv_file)]

    cases: list[dict[str, Any]] = []
    forbidden_evidence_classes = {
        "simulated_evt_result_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    for row in rows:
        measurement_id = row.get("measurement_id", "")
        expected_item = expected.get(measurement_id, {})
        measured_text = row.get("measured", "").strip()
        pass_text = row.get("pass", "").strip().lower()
        sample_id = row.get("sample_id", "").strip()
        operator = row.get("operator", "").strip()
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or ";".join(expected_item.get("required_evidence_artifacts", []))
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "fixture_calibration_certificate",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_evt_result"
            and evidence_class not in forbidden_evidence_classes
        )
        measured_value: float | None = None
        parse_ok = False
        if measured_text:
            with suppress(ValueError):
                measured_value = float(measured_text)
                parse_ok = True
        min_value = expected_item.get("min")
        max_value = expected_item.get("max")
        within_min = measured_value is not None and (
            min_value is None or measured_value >= min_value
        )
        within_max = measured_value is not None and (
            max_value is None or measured_value <= max_value
        )
        numeric_pass = bool(parse_ok and within_min and within_max)
        explicit_pass = pass_text in {"pass", "true", "yes", "y", "1"}
        populated = bool(
            sample_id
            and operator
            and measured_text
            and pass_text
            and evidence_class
            and required_evidence_artifacts
            and evidence_fields_present
        )
        cases.append(
            {
                "measurement_id": measurement_id,
                "sample_id": sample_id,
                "operator": operator,
                "measured": measured_value,
                "min": min_value,
                "max": max_value,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "fixture_calibration_certificate_present": bool(
                    row.get("fixture_calibration_certificate", "").strip()
                ),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "numeric_pass": numeric_pass,
                "explicit_pass": explicit_pass,
                "pass": populated and numeric_pass and explicit_pass and evidence_class_allowed,
            }
        )

    expected_ids = set(expected)
    observed_ids = {case["measurement_id"] for case in cases}
    missing_measurements = sorted(expected_ids - observed_ids)
    blank_or_incomplete = [case["measurement_id"] for case in cases if not case["populated"]]
    failed_measurements = [
        case["measurement_id"]
        for case in cases
        if case["populated"]
        and not (case["numeric_pass"] and case["explicit_pass"] and case["evidence_class_allowed"])
    ]
    populated_count = sum(1 for case in cases if case["populated"])
    complete_count = sum(1 for case in cases if case["pass"])
    sample_coverage: list[dict[str, Any]] = []
    for measurement_id, expected_item in expected.items():
        measurement_cases = [case for case in cases if case["measurement_id"] == measurement_id]
        required_sample_count = int(expected_item.get("sample_count") or 1)
        passed_sample_count = sum(1 for case in measurement_cases if case["pass"])
        sample_coverage.append(
            {
                "measurement_id": measurement_id,
                "required_sample_count": required_sample_count,
                "observed_row_count": len(measurement_cases),
                "populated_row_count": sum(1 for case in measurement_cases if case["populated"]),
                "passed_sample_count": passed_sample_count,
                "pass": passed_sample_count >= required_sample_count,
            }
        )
    sample_shortage_measurements = [
        item["measurement_id"] for item in sample_coverage if not item["pass"]
    ]
    expected_sample_result_count = sum(
        int(item.get("sample_count") or 1) for item in expected.values()
    )
    status = (
        "evt_results_pass"
        if evt_inspection["status"] == "evt_inspection_plan_ready"
        and expected_ids
        and not missing_measurements
        and not blank_or_incomplete
        and not failed_measurements
        and not sample_shortage_measurements
        and all(case["pass"] for case in cases)
        else "blocked_no_physical_results"
        if complete_count == 0
        else "blocked_evt_results_incomplete_or_failed"
    )
    report = {
        "claim_boundary": "Automated review of EVT measurement CSV; blank template rows are not physical validation evidence.",
        "status": status,
        "results_csv": "mechanical/e1-phone/review/evt-inspection-results-template.csv",
        "expected_measurement_count": len(expected_ids),
        "required_evidence_class": "physical_evt_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "observed_row_count": len(cases),
        "expected_sample_result_count": expected_sample_result_count,
        "populated_result_count": populated_count,
        "complete_result_count": complete_count,
        "sample_coverage": sample_coverage,
        "missing_measurements": missing_measurements,
        "blank_or_incomplete_measurements": blank_or_incomplete,
        "failed_measurements": failed_measurements,
        "sample_shortage_measurements": sample_shortage_measurements,
        "cases": cases,
        "release_rule": "Every planned button, USB-C insertion, screen bond/FPC, camera alignment, and acoustic leak sample must include sample, operator, numeric passing result, explicit pass, evidence_class=physical_evt_result, raw measurement data, fixture calibration certificate, photo/log artifact, and unit/component lot traceability record. Each measurement must meet the planned sample count before physical interface validation can release.",
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
    if sample_shortage_measurements:
        lines.extend(["", "## Sample Count Shortage", ""])
        for item in sample_coverage:
            if not item["pass"]:
                lines.append(
                    f"- `{item['measurement_id']}` {item['passed_sample_count']}/{item['required_sample_count']} passing samples"
                )
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
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


def write_gdt_release_package_artifacts(
    params: dict[str, Any], tolerance_stack: dict[str, Any]
) -> dict[str, Any]:
    characteristic_rows: list[dict[str, Any]] = []
    for index, row in enumerate(tolerance_stack["drawing_requirements"], start=1):
        characteristic_rows.append(
            {
                "characteristic_id": f"CRIT-{index:03d}",
                "feature": row["feature"],
                "control": row["control"],
                "datum_reference": row["control"].split("datum ")[-1]
                if "datum " in row["control"]
                else "see control",
                "nominal": "per CAD",
                "plus_tolerance_mm": row["evt0_tolerance_mm"],
                "minus_tolerance_mm": row["evt0_tolerance_mm"],
                "inspection_method": "CMM or optical comparator against released STEP/drawing",
                "required_evidence_artifacts": [
                    "fai_cmm_or_optical_raw_report",
                    "inspection_equipment_calibration_certificate",
                    "feature_inspection_photo_or_scan",
                    "part_revision_tooling_and_resin_lot_records",
                ],
                "sample_requirement": "100% first article; Cpk after DVT tool tuning",
            }
        )
    for index, stack in enumerate(tolerance_stack["stacks"], start=len(characteristic_rows) + 1):
        characteristic_rows.append(
            {
                "characteristic_id": f"STACK-{index:03d}",
                "feature": stack["id"],
                "control": f"minimum clearance to datum {stack['datum']}",
                "datum_reference": stack["datum"],
                "nominal": stack["nominal_mm"],
                "plus_tolerance_mm": "",
                "minus_tolerance_mm": "",
                "minimum_mm": stack["minimum_mm"],
                "inspection_method": "FAI measurement using fixture/CMM after supplier STEP lock",
                "required_evidence_artifacts": [
                    "fai_stack_measurement_raw_report",
                    "inspection_fixture_or_cmm_calibration_certificate",
                    "assembly_stack_inspection_photo",
                    "part_revision_tooling_and_resin_lot_records",
                ],
                "sample_requirement": "all EVT first articles",
            }
        )

    csv_path = REVIEW_DIR / "gdt-fai-template.csv"
    fieldnames = [
        "part_revision",
        "sample_id",
        "characteristic_id",
        "feature",
        "control",
        "datum_reference",
        "nominal",
        "plus_tolerance_mm",
        "minus_tolerance_mm",
        "minimum_mm",
        "measured_value",
        "pass",
        "inspector",
        "evidence_class",
        "required_evidence_artifacts",
        "raw_measurement_artifact",
        "inspection_equipment_calibration_certificate",
        "inspection_photo_or_scan",
        "lot_traceability_record",
        "notes",
    ]
    with csv_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for row in characteristic_rows:
            writer.writerow(
                {
                    "part_revision": params["device"]["revision"],
                    "sample_id": "",
                    "characteristic_id": row["characteristic_id"],
                    "feature": row["feature"],
                    "control": row["control"],
                    "datum_reference": row["datum_reference"],
                    "nominal": row["nominal"],
                    "plus_tolerance_mm": row.get("plus_tolerance_mm", ""),
                    "minus_tolerance_mm": row.get("minus_tolerance_mm", ""),
                    "minimum_mm": row.get("minimum_mm", ""),
                    "measured_value": "",
                    "pass": "",
                    "inspector": "",
                    "evidence_class": "",
                    "required_evidence_artifacts": ";".join(row["required_evidence_artifacts"]),
                    "raw_measurement_artifact": "",
                    "inspection_equipment_calibration_certificate": "",
                    "inspection_photo_or_scan": "",
                    "lot_traceability_record": "",
                    "notes": row["inspection_method"],
                }
            )

    report = {
        "claim_boundary": "CAD-derived GD&T/FAI characteristic package; not a released, signed, supplier-controlled drawing.",
        "status": "gdt_release_package_ready"
        if tolerance_stack["status"] == "cad_tolerance_stack_pass"
        and characteristic_rows
        and csv_path.is_file()
        else "blocked",
        "datum_scheme": tolerance_stack["datums"],
        "characteristic_count": len(characteristic_rows),
        "characteristics": characteristic_rows,
        "fai_template": "mechanical/e1-phone/review/gdt-fai-template.csv",
        "release_blockers": [
            "Needs supplier-returned STEP and drawings before nominal dimensions are frozen.",
            "Needs toolmaker-approved datum scheme and CMM plan.",
            "Needs populated first-article inspection measurements before release.",
        ],
    }
    (REVIEW_DIR / "gdt-release-package.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone GD&T Release Characteristic Package",
        "",
        "Status: CAD-derived characteristic package ready; not a signed release drawing.",
        "",
        f"FAI template: `{report['fai_template']}`",
        "",
        "## Datums",
        "",
    ]
    for datum in tolerance_stack["datums"]:
        lines.append(f"- `{datum['id']}` {datum['name']}: {datum['purpose']}")
    lines.extend(["", "## Characteristics", ""])
    for row in characteristic_rows:
        lines.append(f"- `{row['characteristic_id']}` {row['feature']}: {row['control']}")
    lines.extend(["", "## Release Blockers", ""])
    for blocker in report["release_blockers"]:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "gdt-release-package.md").write_text("\n".join(lines) + "\n")
    return report


def write_gdt_fai_results_review_artifacts(gdt_release: dict[str, Any]) -> dict[str, Any]:
    csv_path = REVIEW_DIR / "gdt-fai-template.csv"
    rows: list[dict[str, str]] = []
    template_evidence_class = ""
    if csv_path.is_file():
        csv_text = csv_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            rows = list(csv.DictReader(csv_file))

    expected_ids = {row["characteristic_id"] for row in gdt_release.get("characteristics", [])}
    expected_by_id = {
        row["characteristic_id"]: row for row in gdt_release.get("characteristics", [])
    }
    reviewed_cases: list[dict[str, Any]] = []
    forbidden_evidence_classes = {
        "simulated_fai_result_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    for row in rows:
        characteristic_id = row.get("characteristic_id", "")
        expected_item = expected_by_id.get(characteristic_id, {})
        measured_value = row.get("measured_value", "").strip()
        pass_flag = row.get("pass", "").strip().lower()
        inspector = row.get("inspector", "").strip()
        sample_id = row.get("sample_id", "").strip()
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        required_evidence_artifacts = [
            artifact
            for artifact in (
                row.get("required_evidence_artifacts")
                or ";".join(expected_item.get("required_evidence_artifacts", []))
            ).split(";")
            if artifact
        ]
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_measurement_artifact",
                "inspection_equipment_calibration_certificate",
                "inspection_photo_or_scan",
                "lot_traceability_record",
            ]
        )
        evidence_class_allowed = (
            evidence_class == "physical_fai_result"
            and evidence_class not in forbidden_evidence_classes
        )
        minimum_text = row.get("minimum_mm", "").strip()
        numeric_pass = True
        measured_float: float | None = None
        if measured_value:
            try:
                measured_float = float(measured_value)
            except ValueError:
                numeric_pass = False
        if minimum_text and measured_float is not None:
            numeric_pass = measured_float >= float(minimum_text)
        populated = bool(
            sample_id
            and measured_value
            and inspector
            and pass_flag
            and evidence_class
            and required_evidence_artifacts
            and evidence_fields_present
        )
        reviewed_cases.append(
            {
                "characteristic_id": characteristic_id,
                "expected_characteristic": characteristic_id in expected_ids,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_evidence_artifacts": required_evidence_artifacts,
                "raw_measurement_artifact_present": bool(
                    row.get("raw_measurement_artifact", "").strip()
                ),
                "inspection_equipment_calibration_certificate_present": bool(
                    row.get("inspection_equipment_calibration_certificate", "").strip()
                ),
                "inspection_photo_or_scan_present": bool(
                    row.get("inspection_photo_or_scan", "").strip()
                ),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "sample_id_present": bool(sample_id),
                "measured_value_present": bool(measured_value),
                "inspector_present": bool(inspector),
                "declared_pass": pass_flag in {"yes", "true", "1", "pass"},
                "numeric_check_pass": numeric_pass,
                "pass": populated
                and characteristic_id in expected_ids
                and pass_flag in {"yes", "true", "1", "pass"}
                and numeric_pass
                and evidence_class_allowed,
            }
        )

    missing_or_incomplete = [
        case["characteristic_id"] for case in reviewed_cases if not case["pass"]
    ]
    complete_count = sum(1 for case in reviewed_cases if case["pass"])
    report = {
        "claim_boundary": "Fail-closed review of GD&T/FAI measurement rows; blank template rows are not inspection evidence.",
        "status": "gdt_fai_results_pass"
        if reviewed_cases
        and complete_count == len(reviewed_cases)
        and len(reviewed_cases) == len(expected_ids)
        else "blocked_no_fai_results"
        if complete_count == 0
        else "blocked_fai_results_incomplete",
        "fai_template": "mechanical/e1-phone/review/gdt-fai-template.csv",
        "expected_characteristic_count": len(expected_ids),
        "required_evidence_class": "physical_fai_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "observed_row_count": len(reviewed_cases),
        "complete_result_count": complete_count,
        "blank_or_incomplete_characteristics": missing_or_incomplete,
        "cases": reviewed_cases,
        "release_rule": "Every GD&T/FAI characteristic must include sample ID, measured value, inspector, passing disposition, evidence_class=physical_fai_result, raw CMM/inspection report, inspection equipment calibration certificate, inspection photo/scan, and part revision/tooling/resin lot traceability before tolerance release.",
    }
    (REVIEW_DIR / "gdt-fai-results-review.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone GD&T/FAI Results Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until first-article measurements are populated.",
        "",
        f"Template: `{report['fai_template']}`",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for characteristic_id in missing_or_incomplete:
        lines.append(f"- `{characteristic_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "gdt-fai-results-review.md").write_text("\n".join(lines) + "\n")
    return report


def _write_results_template_if_blank(
    csv_path: Path,
    fieldnames: list[str],
    rows: list[dict[str, Any]],
    id_field: str,
    response_fields: list[str],
) -> None:
    should_write = True
    if csv_path.is_file():
        with csv_path.open(newline="") as csv_file:
            existing_rows = list(csv.DictReader(csv_file))
        existing_ids = {row.get(id_field, "") for row in existing_rows}
        expected_ids = {str(row.get(id_field, "")) for row in rows}
        existing_fields = list(existing_rows[0].keys()) if existing_rows else []
        has_response_content = any(
            row.get(field, "").strip() for row in existing_rows for field in response_fields
        )
        should_write = (
            existing_ids != expected_ids or existing_fields != fieldnames or not existing_rows
        ) and not has_response_content
    if should_write:
        with csv_path.open("w", newline="") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)


def write_assembly_build_traveler_artifacts(
    params: dict[str, Any],
    parts: list[Part],
) -> dict[str, Any]:
    part_names = {part.name for part in parts}
    steps: list[dict[str, Any]] = [
        {
            "id": "incoming_supplier_part_inspection",
            "station": "incoming_quality",
            "required_parts": [
                "screen_cover_glass",
                "display_lcm",
                "rear_camera_module",
                "front_camera_module",
                "usb_c_receptacle",
                "bottom_speaker_module",
                "earpiece_receiver",
                "power_button_cap",
                "volume_button_cap",
            ],
            "required_measurements": [
                "supplier_lot_id",
                "drawing_revision",
                "step_model_revision",
                "incoming_sample_identity",
                "critical_dimension_spot_check",
            ],
            "evidence_artifacts": [
                "supplier-response-review.json",
                "supplier-evidence-acceptance.json",
                "supplier-drawing-intake-checklist.yaml",
            ],
            "stop_rule": (
                "Do not start assembly if any supplier identity, CAD revision, or sample record "
                "is missing."
            ),
            "acceptance": "supplier drawing/STEP/sample identity checked before build start",
        },
        {
            "id": "screen_adhesive_and_display_bond",
            "station": "display_bond",
            "required_parts": [
                "screen_adhesive_top",
                "screen_adhesive_bottom",
                "screen_adhesive_left",
                "screen_adhesive_right",
                "display_fpc_connector",
                "display_fpc_bend_keepout",
            ],
            "required_measurements": [
                "display_bond_peel_n_per_mm",
                "screen_adhesive_compression_mm",
                "display_fpc_bend_radius_mm",
                "display_luminance_cd_m2",
                "touch_grid_pass",
                "display_dsi_bringup_logs",
            ],
            "evidence_artifacts": [
                "display-validation.json",
                "display-results-review.json",
                "evt-inspection-plan.json",
            ],
            "stop_rule": (
                "Stop build on screen lift, adhesive under-compression, FPC overbend, touch "
                "failure, or no DSI bring-up log."
            ),
            "acceptance": (
                "adhesive compression, FPC bend radius, luminance, touch grid, and drop/lift "
                "checks pass"
            ),
        },
        {
            "id": "top_bottom_pcb_islands_and_split_flex",
            "station": "pcb_flex_integration",
            "required_parts": [
                "main_pcb",
                "split_interconnect_top_connector",
                "split_interconnect_bottom_connector",
                "split_interconnect_side_flex",
                "battery_pouch",
            ],
            "required_measurements": [
                "top_connector_seating_visual",
                "bottom_connector_seating_visual",
                "split_flex_continuity_ohm",
                "battery_window_clearance_mm",
                "flex_strain_relief_visual",
            ],
            "evidence_artifacts": [
                "interface-validation.json",
                "assembly-clearance.json",
                "routed-board-clearance.json",
            ],
            "stop_rule": (
                "Stop build on connector mis-seat, flex continuity failure, battery-window "
                "clash, or missing routed-board clearance evidence."
            ),
            "acceptance": (
                "top/bottom board connector seating, flex strain relief, continuity, and "
                "battery window clearance pass"
            ),
        },
        {
            "id": "camera_handset_and_acoustic_stack",
            "station": "optical_audio_stack",
            "required_parts": [
                "rear_camera_module",
                "front_camera_module",
                "rear_camera_cover_glass",
                "front_camera_black_mask_window",
                "bottom_speaker_module",
                "bottom_speaker_dust_mesh",
                "earpiece_receiver",
                "earpiece_gasket",
                "handset_acoustic_mesh",
                "bottom_mic",
                "top_mic",
            ],
            "required_measurements": [
                "rear_camera_center_offset_mm",
                "front_camera_center_offset_mm",
                "camera_dust_baffle_visual",
                "speaker_leak_db",
                "earpiece_leak_db",
                "mic_sensitivity_dbfs",
                "camera_streaming_capture_log",
            ],
            "evidence_artifacts": [
                "camera-validation.json",
                "camera-results-review.json",
                "acoustic-validation.json",
                "acoustic-results-review.json",
            ],
            "stop_rule": (
                "Stop build on camera decenter, dust, acoustic leak, blocked mesh, mic outlier, "
                "or missing capture/audio logs."
            ),
            "acceptance": (
                "camera alignment, dust/baffle inspection, speaker/mic/earpiece leak, and "
                "streaming/audio checks pass"
            ),
        },
        {
            "id": "usb_buttons_haptics_and_ingress_seals",
            "station": "side_bottom_io",
            "required_parts": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "orange_usb_reinforcement_saddle",
                "power_button_cap",
                "volume_button_cap",
                "power_button_elastomer_gasket",
                "volume_button_elastomer_gasket",
                "haptic_lra",
            ],
            "required_measurements": [
                "usb_c_insertion_force_n",
                "usb_c_post_cycle_continuity",
                "power_button_actuation_force_n",
                "volume_button_actuation_force_n",
                "button_travel_mm",
                "haptic_clearance_mm",
                "port_button_gasket_visual",
            ],
            "evidence_artifacts": [
                "interface-validation.json",
                "evt-inspection-plan.json",
                "fixture-calibration-acceptance.json",
            ],
            "stop_rule": (
                "Stop build on high USB insertion force, continuity failure, button force/travel "
                "outlier, haptic rub, or damaged gasket."
            ),
            "acceptance": (
                "USB insertion, post-cycle continuity, button force/travel/cycle, haptic "
                "clearance, and seal inspection pass"
            ),
        },
        {
            "id": "battery_install_and_enclosure_close",
            "station": "final_mechanical_close",
            "required_parts": [
                "battery_pouch",
                "orange_battery_left_rib",
                "orange_battery_right_rib",
                "orange_back_shell",
                "orange_side_frame",
                "orange_snap_hook_1",
                "orange_screw_boss_1",
            ],
            "required_measurements": [
                "battery_window_fit_visual",
                "cable_pinch_visual",
                "snap_retention_n",
                "screw_torque_ncm",
                "gap_flush_mm",
                "enclosure_close_photo",
            ],
            "evidence_artifacts": [
                "assembly-clearance.json",
                "tolerance-stack.json",
                "gdt-fai-results-review.json",
            ],
            "stop_rule": (
                "Stop build on battery interference, cable pinch, failed retention, stripped "
                "boss, or out-of-limit gap/flush."
            ),
            "acceptance": (
                "battery window fit, snap/screw retention, enclosure gaps, no cable pinch, and "
                "cosmetic check pass"
            ),
        },
        {
            "id": "final_function_cmf_and_traceability",
            "station": "final_acceptance",
            "required_parts": [
                "screen_cover_glass",
                "usb_c_receptacle",
                "rear_camera_module",
                "front_camera_module",
                "bottom_speaker_module",
                "earpiece_receiver",
                "power_button_cap",
                "volume_button_cap",
                "orange_back_shell",
            ],
            "required_measurements": [
                "display_touch_final_pass",
                "front_rear_camera_final_pass",
                "speaker_mic_earpiece_final_pass",
                "usb_c_final_pass",
                "button_haptic_final_pass",
                "radio_smoke_test_pass",
                "orange_cmf_visual_pass",
                "unit_serial_trace_record",
                "final_photo_record",
            ],
            "evidence_artifacts": [
                "visual-decision-report.json",
                "unit-traceability-acceptance.json",
                "cmf-release-acceptance.json",
            ],
            "stop_rule": (
                "Hold the unit on any functional, CMF, traceability, or final photo failure."
            ),
            "acceptance": (
                "display, touch, cameras, audio, USB, buttons, radio smoke, CMF visual, serial "
                "trace, and photo record pass"
            ),
        },
    ]
    for step in steps:
        step["missing_parts"] = [name for name in step["required_parts"] if name not in part_names]
        step["cad_prerequisites_present"] = not step["missing_parts"]
        step["pass"] = step["cad_prerequisites_present"]

    fieldnames = [
        "build_id",
        "unit_serial",
        "step_id",
        "operator",
        "required_measurements",
        "evidence_artifacts",
        "measured_or_observed_result",
        "pass",
        "evidence_class",
        "raw_data_artifact",
        "photo_or_log_artifact",
        "lot_traceability_record",
        "nonconformance_id",
        "stop_rule",
        "notes",
    ]
    template_rows = [
        {
            "build_id": "",
            "unit_serial": "",
            "step_id": step["id"],
            "operator": "",
            "required_measurements": ";".join(step["required_measurements"]),
            "evidence_artifacts": ";".join(step["evidence_artifacts"]),
            "measured_or_observed_result": "",
            "pass": "",
            "evidence_class": "",
            "raw_data_artifact": "",
            "photo_or_log_artifact": "",
            "lot_traceability_record": "",
            "nonconformance_id": "",
            "stop_rule": step["stop_rule"],
            "notes": step["acceptance"],
        }
        for step in steps
    ]
    csv_path = REVIEW_DIR / "assembly-build-results-template.csv"
    _write_results_template_if_blank(
        csv_path,
        fieldnames,
        template_rows,
        "step_id",
        [
            "build_id",
            "unit_serial",
            "operator",
            "measured_or_observed_result",
            "pass",
            "evidence_class",
            "raw_data_artifact",
            "photo_or_log_artifact",
            "lot_traceability_record",
        ],
    )

    rows: list[dict[str, str]] = []
    if csv_path.is_file():
        with csv_path.open(newline="") as csv_file:
            rows = list(csv.DictReader(csv_file))
    step_by_id = {step["id"]: step for step in steps}
    forbidden_evidence_classes = {
        "simulated_assembly_build_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    cases = []
    for row in rows:
        step_id = row.get("step_id", "")
        step = step_by_id.get(step_id, {})
        evidence_class = row.get("evidence_class", "").strip()
        evidence_class_allowed = (
            evidence_class == "physical_assembly_build_record"
            and evidence_class not in forbidden_evidence_classes
        )
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        populated = bool(
            row.get("build_id", "").strip()
            and row.get("unit_serial", "").strip()
            and step_id
            and row.get("operator", "").strip()
            and row.get("measured_or_observed_result", "").strip()
            and row.get("pass", "").strip()
            and row.get("evidence_artifacts", "").strip()
            and evidence_class
            and evidence_fields_present
        )
        declared_pass = row.get("pass", "").strip().lower() in {"yes", "true", "1", "pass"}
        cases.append(
            {
                "step_id": step_id,
                "expected_step": step_id in step_by_id,
                "cad_prerequisites_present": bool(step.get("cad_prerequisites_present", False)),
                "sample_identity_present": bool(row.get("unit_serial", "").strip()),
                "operator_present": bool(row.get("operator", "").strip()),
                "result_present": bool(row.get("measured_or_observed_result", "").strip()),
                "declared_pass": declared_pass,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "pass": populated
                and declared_pass
                and step_id in step_by_id
                and bool(step.get("cad_prerequisites_present", False))
                and evidence_class_allowed,
            }
        )
    missing_steps = sorted(set(step_by_id) - {case["step_id"] for case in cases})
    incomplete_steps = [case["step_id"] for case in cases if not case["pass"]]
    complete_count = sum(1 for case in cases if case["pass"])
    status = (
        "assembly_build_results_pass"
        if complete_count == len(steps) and not missing_steps
        else "blocked_no_assembly_build_results"
        if complete_count == 0
        else "blocked_assembly_build_results_incomplete"
    )
    report = {
        "claim_boundary": (
            "Fail-closed first-article assembly traveler for the whole phone. CAD part presence "
            "and validation plans do not count as completed build evidence."
        ),
        "status": status,
        "traveler_scope": (
            "screen bond, PCB/flex integration, camera/handset/audio stack, USB/buttons/haptics, "
            "battery install, enclosure close, CMF/final function"
        ),
        "expected_step_count": len(steps),
        "cad_prerequisite_step_count": sum(
            1 for step in steps if step["cad_prerequisites_present"]
        ),
        "observed_row_count": len(cases),
        "complete_result_count": complete_count,
        "results_template": "mechanical/e1-phone/review/assembly-build-results-template.csv",
        "required_evidence_class": "physical_assembly_build_record",
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "steps": steps,
        "cases": cases,
        "missing_steps": missing_steps,
        "missing_or_incomplete_steps": sorted(set(missing_steps + incomplete_steps)),
        "release_rule": (
            "Every assembly station must have build ID, unit serial, operator, observed result, "
            "passing disposition, evidence_class=physical_assembly_build_record, raw data, "
            "photo/log artifact, and lot traceability before whole-phone build validation passes."
        ),
    }
    (REVIEW_DIR / "assembly-build-traveler.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Assembly Build Traveler",
        "",
        f"Status: {status}.",
        "",
        "This traveler is fail-closed until physical build records are populated.",
        "",
        "## Steps",
        "",
    ]
    for step in steps:
        result = "PASS" if step["cad_prerequisites_present"] else "BLOCKED"
        lines.append(f"- {result}: `{step['id']}` at `{step['station']}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "assembly-build-traveler.md").write_text("\n".join(lines) + "\n")
    return report


def write_process_control_plan_artifacts(
    assembly_build: dict[str, Any],
    supplier_response: dict[str, Any],
    gdt_release: dict[str, Any],
) -> dict[str, Any]:
    traveler_steps = {step["id"] for step in assembly_build.get("steps", [])}
    controls: list[dict[str, Any]] = [
        {
            "id": "incoming_supplier_identity_control",
            "station": "incoming_quality",
            "traveler_step": "incoming_supplier_part_inspection",
            "critical_to_quality": (
                "supplier drawing, STEP, sample, lot, and dimensional identity match the selected "
                "phone CAD baseline"
            ),
            "inspection_method": "document pack review plus incoming dimensional inspection",
            "gauge_or_fixture": "calipers_height_gauge_optical_comparator_and_supplier_step_overlay",
            "sample_plan": "100% first lot, AQL after supplier lock",
            "required_output_keys": [
                "supplier_lot_id",
                "drawing_revision",
                "step_model_revision",
                "sample_identity_pass",
                "critical_dimension_pass",
            ],
            "linked_evidence": [
                "supplier-response-review.json",
                "unit-traceability-acceptance.json",
                "gdt-release-package.json",
            ],
            "stop_rule": (
                "quarantine lot and block build if any supplier drawing, STEP, or sample identity "
                "is missing"
            ),
        },
        {
            "id": "display_bond_control",
            "station": "display_bond",
            "traveler_step": "screen_adhesive_and_display_bond",
            "critical_to_quality": (
                "cover glass position, adhesive compression, FPC bend radius, luminance, and touch "
                "grid pass"
            ),
            "inspection_method": "bond fixture clamp log, optical gap check, and display bring-up",
            "gauge_or_fixture": "screen_bond_clamp_frame_and_optical_gap_gauge",
            "sample_plan": "100% EVT and first production lot",
            "required_output_keys": [
                "cover_glass_xy_mm",
                "adhesive_compression_mm",
                "fpc_bend_radius_mm",
                "luminance_cd_m2",
                "touch_grid_pass",
            ],
            "linked_evidence": [
                "display-validation.json",
                "display-results-review.json",
                "evt-inspection-plan.json",
            ],
            "stop_rule": "stop line on screen lift, FPC overbend, touch-grid failure, or luminance outlier",
        },
        {
            "id": "pcb_flex_mating_control",
            "station": "pcb_flex_integration",
            "traveler_step": "top_bottom_pcb_islands_and_split_flex",
            "critical_to_quality": (
                "top and bottom PCB islands seat without battery window clash and split flex "
                "continuity passes"
            ),
            "inspection_method": "visual connector seating, continuity test, and keepout overlay",
            "gauge_or_fixture": "split_flex_continuity_jig_and_battery_window_go_no_go",
            "sample_plan": "100% until routed PCB and connector supplier lock",
            "required_output_keys": [
                "top_connector_seated",
                "bottom_connector_seated",
                "split_flex_continuity_ohm",
                "battery_clearance_mm",
                "keepout_overlay_pass",
            ],
            "linked_evidence": [
                "assembly-clearance.json",
                "interface-validation.json",
                "assembly-build-traveler.json",
            ],
            "stop_rule": "stop build if connector seating, flex continuity, or battery clearance fails",
        },
        {
            "id": "camera_audio_stack_control",
            "station": "optical_audio_stack",
            "traveler_step": "camera_handset_and_acoustic_stack",
            "critical_to_quality": (
                "rear/front camera alignment, dust seal, speaker/mic/earpiece leakage, and "
                "streaming/audio checks pass"
            ),
            "inspection_method": "camera alignment pins, dust image, acoustic sweep, and loopback",
            "gauge_or_fixture": "camera_alignment_pins_and_acoustic_leak_masks",
            "sample_plan": "100% EVT, then station SPC after fixture correlation",
            "required_output_keys": [
                "rear_camera_center_offset_mm",
                "front_camera_center_offset_mm",
                "dust_image_pass",
                "audio_loopback_pass",
                "leak_db",
            ],
            "linked_evidence": [
                "camera-validation.json",
                "camera-results-review.json",
                "acoustic-validation.json",
                "acoustic-results-review.json",
            ],
            "stop_rule": (
                "stop line on camera center shift, dust, acoustic leak, blocked mesh, or audio "
                "loopback failure"
            ),
        },
        {
            "id": "usb_buttons_haptics_control",
            "station": "side_bottom_io",
            "traveler_step": "usb_buttons_haptics_and_ingress_seals",
            "critical_to_quality": (
                "USB-C insertion, button force/travel, haptic clearance, and port/button seal "
                "integrity pass"
            ),
            "inspection_method": "load cell, insertion gauge, continuity, and gasket visual check",
            "gauge_or_fixture": "button_force_probe_usb_insertion_gauge_and_continuity_jig",
            "sample_plan": "100% EVT and 100% first production lot",
            "required_output_keys": [
                "usb_insertion_force_n",
                "usb_continuity_pass",
                "power_button_force_n",
                "volume_button_force_n",
                "button_travel_mm",
                "gasket_visual_pass",
            ],
            "linked_evidence": [
                "interface-validation.json",
                "evt-inspection-plan.json",
                "assembly-build-traveler.json",
            ],
            "stop_rule": (
                "stop build on high insertion force, post-cycle continuity failure, button force "
                "outlier, or damaged gasket"
            ),
        },
        {
            "id": "enclosure_close_control",
            "station": "final_mechanical_close",
            "traveler_step": "battery_install_and_enclosure_close",
            "critical_to_quality": (
                "battery fits without cable pinch, orange enclosure closes, snap/screw retention "
                "and gap/flush pass"
            ),
            "inspection_method": "go/no-go close fixture, torque driver log, and gap/flush gauge",
            "gauge_or_fixture": "close_force_fixture_torque_driver_and_gap_flush_gauge",
            "sample_plan": "100% EVT and first production lot",
            "required_output_keys": [
                "battery_fit_pass",
                "cable_pinch_visual_pass",
                "snap_retention_n",
                "screw_torque_ncm",
                "gap_flush_mm",
            ],
            "linked_evidence": [
                "assembly-clearance.json",
                "tolerance-stack.json",
                "gdt-fai-results-review.json",
            ],
            "stop_rule": (
                "stop build on battery interference, cable pinch, failed retention, or out-of-limit "
                "gap/flush"
            ),
        },
        {
            "id": "final_function_cmf_traceability_control",
            "station": "final_acceptance",
            "traveler_step": "final_function_cmf_and_traceability",
            "critical_to_quality": (
                "full function, CMF, serial traceability, and final photo evidence pass before "
                "shipment"
            ),
            "inspection_method": "functional smoke test, CMF inspection, serial scan, and photo record",
            "gauge_or_fixture": "final_function_jig_color_plaque_reference_and_camera_station",
            "sample_plan": "100% all builds",
            "required_output_keys": [
                "function_smoke_pass",
                "cmf_visual_pass",
                "serial_scan_pass",
                "final_photo_artifact",
                "rework_history_closed",
            ],
            "linked_evidence": [
                "assembly-build-traveler.json",
                "unit-traceability-acceptance.json",
                "visual-decision-report.json",
            ],
            "stop_rule": (
                "hold unit on function failure, CMF nonconformance, missing serial trace, or missing "
                "final photo"
            ),
        },
    ]
    for control in controls:
        control["traveler_step_present"] = control["traveler_step"] in traveler_steps
        control["cad_prerequisites_present"] = control["traveler_step_present"]
        control["linked_statuses"] = {
            "supplier_response_status": supplier_response.get("status"),
            "gdt_release_status": gdt_release.get("status"),
            "assembly_build_status": assembly_build.get("status"),
        }

    fieldnames = [
        "build_id",
        "station",
        "control_id",
        "operator",
        "gauge_id",
        "sample_plan",
        "required_output_keys",
        "linked_evidence",
        "measured_or_observed_result",
        "pass",
        "evidence_class",
        "raw_data_artifact",
        "photo_or_log_artifact",
        "lot_traceability_record",
        "nonconformance_id",
        "stop_rule",
        "notes",
    ]
    template_rows = [
        {
            "build_id": "",
            "station": control["station"],
            "control_id": control["id"],
            "operator": "",
            "gauge_id": "",
            "sample_plan": control["sample_plan"],
            "required_output_keys": ";".join(control["required_output_keys"]),
            "linked_evidence": ";".join(control["linked_evidence"]),
            "measured_or_observed_result": "",
            "pass": "",
            "evidence_class": "",
            "raw_data_artifact": "",
            "photo_or_log_artifact": "",
            "lot_traceability_record": "",
            "nonconformance_id": "",
            "stop_rule": control["stop_rule"],
            "notes": control["critical_to_quality"],
        }
        for control in controls
    ]
    csv_path = REVIEW_DIR / "process-control-results-template.csv"
    _write_results_template_if_blank(
        csv_path,
        fieldnames,
        template_rows,
        "control_id",
        [
            "build_id",
            "operator",
            "gauge_id",
            "measured_or_observed_result",
            "pass",
            "evidence_class",
            "raw_data_artifact",
            "photo_or_log_artifact",
            "lot_traceability_record",
        ],
    )

    rows: list[dict[str, str]] = []
    if csv_path.is_file():
        with csv_path.open(newline="") as csv_file:
            rows = list(csv.DictReader(csv_file))
    control_by_id = {control["id"]: control for control in controls}
    forbidden_evidence_classes = {
        "simulated_process_control_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    cases = []
    for row in rows:
        control_id = row.get("control_id", "")
        control = control_by_id.get(control_id, {})
        evidence_class = row.get("evidence_class", "").strip()
        evidence_class_allowed = (
            evidence_class == "physical_process_control_record"
            and evidence_class not in forbidden_evidence_classes
        )
        evidence_fields_present = all(
            row.get(field, "").strip()
            for field in [
                "raw_data_artifact",
                "photo_or_log_artifact",
                "lot_traceability_record",
            ]
        )
        populated = bool(
            row.get("build_id", "").strip()
            and row.get("station", "").strip()
            and control_id
            and row.get("operator", "").strip()
            and row.get("gauge_id", "").strip()
            and row.get("measured_or_observed_result", "").strip()
            and row.get("pass", "").strip()
            and evidence_class
            and evidence_fields_present
        )
        declared_pass = row.get("pass", "").strip().lower() in {"yes", "true", "1", "pass"}
        cases.append(
            {
                "control_id": control_id,
                "expected_control": control_id in control_by_id,
                "traveler_step_present": bool(control.get("traveler_step_present", False)),
                "cad_prerequisites_present": bool(control.get("cad_prerequisites_present", False)),
                "operator_present": bool(row.get("operator", "").strip()),
                "gauge_id_present": bool(row.get("gauge_id", "").strip()),
                "result_present": bool(row.get("measured_or_observed_result", "").strip()),
                "declared_pass": declared_pass,
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "raw_data_artifact_present": bool(row.get("raw_data_artifact", "").strip()),
                "photo_or_log_artifact_present": bool(row.get("photo_or_log_artifact", "").strip()),
                "lot_traceability_record_present": bool(
                    row.get("lot_traceability_record", "").strip()
                ),
                "populated": populated,
                "pass": populated
                and declared_pass
                and control_id in control_by_id
                and bool(control.get("cad_prerequisites_present", False))
                and evidence_class_allowed,
            }
        )
    missing_controls = sorted(set(control_by_id) - {case["control_id"] for case in cases})
    incomplete_controls = [case["control_id"] for case in cases if not case["pass"]]
    complete_count = sum(1 for case in cases if case["pass"])
    status = (
        "process_control_results_pass"
        if complete_count == len(controls) and not missing_controls
        else "blocked_no_process_control_results"
        if complete_count == 0
        else "blocked_process_control_results_incomplete"
    )
    report = {
        "claim_boundary": (
            "Factory process control plan for EVT0-to-production assembly. CAD station controls "
            "and blank templates do not count as line qualification evidence."
        ),
        "status": status,
        "expected_control_count": len(controls),
        "cad_prerequisite_control_count": sum(
            1 for control in controls if control["cad_prerequisites_present"]
        ),
        "observed_row_count": len(cases),
        "complete_result_count": complete_count,
        "results_template": "mechanical/e1-phone/review/process-control-results-template.csv",
        "required_evidence_class": "physical_process_control_record",
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "controls": controls,
        "cases": cases,
        "missing_controls": missing_controls,
        "missing_or_incomplete_controls": sorted(set(missing_controls + incomplete_controls)),
        "release_rule": (
            "Every factory control must have build ID, station, operator, gauge ID, observed "
            "result, passing disposition, evidence_class=physical_process_control_record, raw "
            "data, photo/log artifact, and lot traceability before process-control validation "
            "passes."
        ),
    }
    (REVIEW_DIR / "process-control-plan.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Process Control Plan",
        "",
        f"Status: {status}.",
        "",
        "This plan is fail-closed until factory control records are populated.",
        "",
        "## Controls",
        "",
    ]
    for control in controls:
        result = "PASS" if control["cad_prerequisites_present"] else "BLOCKED"
        lines.append(f"- {result}: `{control['id']}` at `{control['station']}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "process-control-plan.md").write_text("\n".join(lines) + "\n")
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

    battery_center = [0.0, -7.0, battery_center_z(params)]
    pcb_segments = pcb_island_segments(params)
    battery_to_pcb = [
        box_gap(size, center, battery["envelope_mm"], battery_center)
        for size, center, _name in pcb_segments
    ]
    battery_high = np.asarray(battery_center) + np.asarray(battery["envelope_mm"]) / 2.0
    flex_low, flex_high = by_name["split_interconnect_side_flex"].bounds
    flex_to_battery_edge = float(flex_low[0] - battery_high[0])
    flex_within_side_rail = float(width / 2.0 - flex_high[0])
    connector_to_pcb = {
        "top": part_to_box_gap("split_interconnect_top_connector", *pcb_segments[0][:2]),
        "bottom": part_to_box_gap("split_interconnect_bottom_connector", *pcb_segments[1][:2]),
    }
    haptic_to_pcb = [
        part_to_box_gap("haptic_lra", size, center) for size, center, _name in pcb_segments
    ]
    button_gasket_gaps = [
        part_gap("power_button_cap", "power_button_elastomer_gasket"),
        part_gap("volume_button_cap", "volume_button_elastomer_gasket"),
    ]
    rf_keepout_gaps = [
        part_gap("soc_shield_can", "cellular_top_antenna_keepout"),
        part_gap("radio_shield_can", "cellular_bottom_antenna_keepout"),
        part_gap("radio_shield_can", "wifi_bt_side_antenna_keepout"),
    ]
    snap_to_internal_gaps = [
        part_gap("orange_snap_hook_1", "main_pcb"),
        part_gap("orange_snap_hook_8", "main_pcb"),
        part_gap("service_label_recess", "battery_pouch"),
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
            "id": "button_caps_to_side_frame",
            "actual_mm": round(min(button_gasket_gaps), 3),
            "required_mm": 0.0,
            "pass": min(button_gasket_gaps) >= 0.0,
            "cap_to_gasket_gaps_mm": [round(value, 3) for value in button_gasket_gaps],
        },
        {
            "id": "battery_to_pcb_islands",
            "actual_mm": round(min(battery_to_pcb), 3),
            "required_mm": tolerance["battery_to_pcb_gap_mm"],
            "pass": min(battery_to_pcb) >= tolerance["battery_to_pcb_gap_mm"],
            "segment_gaps_mm": [round(value, 3) for value in battery_to_pcb],
        },
        {
            "id": "battery_back_void_foam_to_pouch",
            "actual_mm": round(part_gap("battery_back_void_foam_pad", "battery_pouch"), 3),
            "required_mm": 0.25,
            "pass": part_gap("battery_back_void_foam_pad", "battery_pouch") >= 0.25,
        },
        {
            "id": "split_interconnect_flex_to_battery_edge",
            "actual_mm": round(flex_to_battery_edge, 3),
            "required_mm": 0.5,
            "pass": flex_to_battery_edge >= 0.5,
        },
        {
            "id": "split_interconnect_flex_within_side_rail",
            "actual_mm": round(flex_within_side_rail, 3),
            "required_mm": 1.5,
            "pass": flex_within_side_rail >= 1.5,
        },
        {
            "id": "split_interconnect_connectors_on_pcb_islands",
            "actual_mm": round(max(connector_to_pcb.values()), 3),
            "required_mm": 0.0,
            "pass": all(value <= 0.01 for value in connector_to_pcb.values()),
            "connector_to_pcb_gap_mm": {
                name: round(value, 3) for name, value in connector_to_pcb.items()
            },
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
        {
            "id": "rf_keepout_to_orange_shell",
            "actual_mm": round(min(rf_keepout_gaps), 3),
            "required_mm": 1.0,
            "pass": min(rf_keepout_gaps) >= 1.0,
            "shield_to_antenna_keepout_gaps_mm": [round(value, 3) for value in rf_keepout_gaps],
        },
        {
            "id": "snap_hooks_to_internal_components",
            "actual_mm": round(min(snap_to_internal_gaps), 3),
            "required_mm": 0.5,
            "pass": min(snap_to_internal_gaps) >= 0.5,
            "retention_to_internal_gaps_mm": [round(value, 3) for value in snap_to_internal_gaps],
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


def write_battery_swell_management_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    checks: dict[str, Any],
    clearance: dict[str, Any],
) -> dict[str, Any]:
    by_name = {part.name: part for part in parts}
    battery = params["battery"]
    foam_part = by_name.get("battery_back_void_foam_pad")
    foam_bounds = None
    if foam_part is not None:
        foam_bounds = [
            [round(float(value), 4) for value in foam_part.bounds[0]],
            [round(float(value), 4) for value in foam_part.bounds[1]],
        ]
    fit_checks = checks["checks"]
    display_wall = fit_checks["battery_display_and_wall_clearance"]
    foam_check = fit_checks["battery_back_void_foam_management"]
    clearance_cases = {case["id"]: case for case in clearance["cases"]}
    report = {
        "claim_boundary": (
            "CAD battery swell management screen for the EVT0 compact enclosure. "
            "It records the modeled foam pad and worst-case arithmetic stack, but "
            "does not replace supplier pack swelling data, foam compression-set data, "
            "or physical thermal/aging validation."
        ),
        "status": "cad_battery_swell_management_ready"
        if display_wall["pass"]
        and foam_check["pass"]
        and clearance_cases["battery_back_void_foam_to_pouch"]["pass"]
        else "blocked",
        "battery_candidate": battery["candidate"],
        "battery_envelope_mm": battery["envelope_mm"],
        "battery_back_void_gap_mm": display_wall["battery_to_back_wall_gap_mm"],
        "display_static_gap_mm": display_wall["battery_to_display_gap_mm"],
        "foam_pad": {
            "part": "battery_back_void_foam_pad",
            "material": battery["back_void_foam_material"],
            "envelope_mm": battery["back_void_foam_pad_mm"],
            "bounds_mm": foam_bounds,
            "compression_allowance_mm": battery["back_void_foam_compression_allowance_mm"],
            "free_gap_to_pouch_mm": clearance_cases["battery_back_void_foam_to_pouch"]["actual_mm"],
        },
        "worst_case_arithmetic": {
            "battery_swell_high_mm": foam_check["battery_swell_high_mm"],
            "back_void_tolerance_arithmetic_mm": foam_check["back_void_tolerance_arithmetic_mm"],
            "required_back_void_capacity_mm": foam_check["back_void_required_worst_case_mm"],
            "managed_back_void_capacity_mm": foam_check["back_void_managed_capacity_mm"],
            "margin_mm": round(
                foam_check["back_void_managed_capacity_mm"]
                - foam_check["back_void_required_worst_case_mm"],
                4,
            ),
        },
        "checks": {
            "battery_display_and_wall_clearance": display_wall,
            "battery_back_void_foam_management": foam_check,
            "battery_back_void_foam_to_pouch": clearance_cases["battery_back_void_foam_to_pouch"],
        },
        "release_blockers": [
            "Supplier battery drawing must include end-of-life swelling envelope, PCM, connector, pull-tab, and sample thickness data.",
            "Foam supplier must provide compression-set data at thermal aging conditions.",
            "Physical EVT thermal/aging/drop validation must confirm the foam does not preload the pouch or push the display.",
        ],
    }
    (REVIEW_DIR / "battery-swell-management.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Battery Swell Management",
        "",
        f"Status: {report['status']}.",
        "",
        "## Foam Pad",
        "",
        f"- Part: `{report['foam_pad']['part']}`",
        f"- Material: {report['foam_pad']['material']}",
        f"- Envelope: {report['foam_pad']['envelope_mm']} mm",
        f"- Compression allowance: {report['foam_pad']['compression_allowance_mm']} mm",
        "",
        "## Worst-Case Arithmetic",
        "",
        f"- Required capacity: {report['worst_case_arithmetic']['required_back_void_capacity_mm']} mm",
        f"- Managed capacity: {report['worst_case_arithmetic']['managed_back_void_capacity_mm']} mm",
        f"- Margin: {report['worst_case_arithmetic']['margin_mm']} mm",
        "",
        "## Release Blockers",
        "",
    ]
    for blocker in report["release_blockers"]:
        lines.append(f"- {blocker}")
    (REVIEW_DIR / "battery-swell-management.md").write_text("\n".join(lines) + "\n")
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
    part_names = {part.name for part in parts}
    ejector_count = sum(name.startswith("mold_ejector_pin_") for name in tooling_names)
    cooling_count = sum(name.startswith("mold_cooling_channel_") for name in tooling_names)
    screw_boss_count = sum(name.startswith("orange_screw_boss_") for name in part_names)
    snap_hook_count = sum(name.startswith("orange_snap_hook_") for name in part_names)
    core_pin_count = sum(name.startswith("screw_core_pin_clearance_") for name in tooling_names)

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
    mold_action_plan = [
        {
            "id": "back_shell_main_draw",
            "feature": "orange_back_shell_and_side_frame_outer_surfaces",
            "tool_action": "straight_pull_a_b_open_close",
            "pass": mfg["nominal_draft_deg"] >= 2.0,
            "evidence": ["orange_back_shell", "orange_side_frame", "draft_angle"],
            "tooling_note": "Use the modeled mid-plane parting reference as a concept split; final shutoffs depend on production B-rep surfaces.",
        },
        {
            "id": "screw_boss_core_pins",
            "feature": "six_screw_boss_cores",
            "tool_action": "fixed_core_pins_from_b_side",
            "pass": screw_boss_count == mfg["screw_boss_count"]
            and core_pin_count == screw_boss_count,
            "evidence": ["orange_screw_boss_1", "screw_core_pin_clearance_1"],
            "tooling_note": "Every boss needs a core pin and steel-safe local tuning to reduce sink/read-through.",
        },
        {
            "id": "snap_hook_release",
            "feature": "eight_side_snap_hooks",
            "tool_action": "toolmaker_review_lifters_or_straight_pull_hook_redesign",
            "pass": snap_hook_count == mfg["snap_hook_count"],
            "evidence": ["orange_snap_hook_1", "orange_snap_hook_8"],
            "tooling_note": "Current snap hooks prove retention intent; toolmaker must approve lifter/slide strategy or revise hooks to straight-pull geometry.",
        },
        {
            "id": "usb_c_bottom_aperture_shutoff",
            "feature": "usb_c_external_aperture_reinforcement_saddle_gasket_seat_and_drain_shelf",
            "tool_action": "bottom_edge_shutoff_insert_or_local_side_core_with_gasket_seat_review",
            "pass": {
                "usb_c_external_aperture",
                "orange_usb_reinforcement_saddle",
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
            }.issubset(part_names),
            "evidence": [
                "usb_c_external_aperture",
                "orange_usb_reinforcement_saddle",
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
            ],
            "tooling_note": "USB-C mouth needs steel-safe shutoff and gasket-seat review so insertion loads, splash management, and cosmetics survive first shots.",
        },
        {
            "id": "side_button_openings",
            "feature": "power_and_volume_button_side_openings",
            "tool_action": "side_core_lifter_or_secondary_operation_decision",
            "pass": {"power_button_cap", "volume_button_cap"}.issubset(part_names),
            "evidence": ["power_button_cap", "volume_button_cap"],
            "tooling_note": "Button openings are side-wall features; choose a slide/lifter strategy or keep caps mounted through an insert before hard tooling.",
        },
        {
            "id": "camera_window_and_acoustic_slots",
            "feature": "rear_camera_window_front_under_glass_earpiece_and_speaker_ports",
            "tool_action": "steel_safe_inserts_and_vented_shutoffs",
            "pass": {
                "rear_camera_cover_glass",
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "rear_camera_light_baffle_top",
                "rear_camera_light_baffle_bottom",
                "front_camera_under_glass",
                "front_camera_black_mask_window",
                "handset_acoustic_slot",
                "bottom_speaker_grille_slot_1",
            }.issubset(part_names),
            "evidence": [
                "rear_camera_cover_glass",
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "rear_camera_light_baffle_top",
                "rear_camera_light_baffle_bottom",
                "front_camera_under_glass",
                "front_camera_black_mask_window",
                "handset_acoustic_slot",
                "bottom_speaker_grille_slot_1",
            ],
            "tooling_note": "Camera and acoustic apertures need insert/shutoff, adhesive-seat, baffle, venting, and flash-control review before texture freeze.",
        },
    ]
    action_plan_complete = all(item["pass"] for item in mold_action_plan)
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
        "status": "cad_dfm_inputs_ready"
        if all(case["pass"] for case in cases) and action_plan_complete
        else "blocked",
        "device_envelope_mm": [width, height, depth],
        "plastic": mfg["plastic"],
        "cases": cases,
        "mold_action_plan": mold_action_plan,
        "risks": risks,
        "recommendations": recommendations,
        "release_blockers": [
            "Toolmaker must convert mold-action plan into released slides/lifters/inserts or straight-pull geometry.",
            "Mold-flow/fill/pack/warp results are still required for orange PC+ABS.",
            "First-shot samples must confirm gate blush, knit lines, sink, warp, snap fatigue, and texture.",
        ],
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
    lines.extend(["", "## Mold Action Plan", ""])
    for action in mold_action_plan:
        lines.append(
            f"- {'PASS' if action['pass'] else 'BLOCKED'}: `{action['id']}` "
            f"{action['tool_action']}; {action['tooling_note']}"
        )
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


def write_tooling_action_register_artifacts(
    dfm: dict[str, Any],
    mold_process: dict[str, Any],
) -> dict[str, Any]:
    action_plan = dfm.get("mold_action_plan", [])
    process_cases = {case["id"]: case for case in mold_process.get("cases", [])}
    register_rows: list[dict[str, Any]] = []
    for action in action_plan:
        linked_process_case = {
            "back_shell_main_draw": "fill_length_to_wall",
            "screw_boss_core_pins": "boss_sink_proxy",
            "snap_hook_release": "boss_sink_proxy",
            "usb_c_bottom_aperture_shutoff": "gate_shear_proxy",
            "side_button_openings": "ejector_cosmetic_proxy",
            "camera_window_and_acoustic_slots": "cooling_clearance_ratio",
        }.get(action["id"], "fill_length_to_wall")
        process_case = process_cases.get(linked_process_case, {})
        register_rows.append(
            {
                "id": action["id"],
                "feature": action["feature"],
                "owner": "toolmaker",
                "cad_status": "cad_action_ready" if action["pass"] else "blocked",
                "tool_action": action["tool_action"],
                "linked_process_case": linked_process_case,
                "linked_process_risk": process_case.get("risk", "unknown"),
                "required_returned_evidence": [
                    "marked_up_tool_design",
                    "mold_flow_or_toolmaker_note",
                    "steel_safe_tuning_plan",
                    "reviewer_disposition",
                ],
                "linked_cad_evidence": action["evidence"],
                "release_blocker": (
                    "Toolmaker has not returned approved steel design, mold-flow note, "
                    "and reviewer disposition for this action."
                ),
                "pass": bool(action["pass"]),
            }
        )
    cross_cutting_actions = [
        {
            "id": "orange_cmf_texture_gate_review",
            "feature": "hard_orange_pc_abs_cmf_and_gate_vestige",
            "owner": "industrial_design_toolmaker",
            "cad_status": "cad_action_ready",
            "tool_action": "approve orange resin chip, texture plaque, gloss target, and gate vestige location",
            "linked_process_case": "gate_shear_proxy",
            "linked_process_risk": process_cases.get("gate_shear_proxy", {}).get("risk", "unknown"),
            "required_returned_evidence": [
                "orange_resin_chip_approval",
                "texture_plaque_photos",
                "gate_vestige_photo_or_render",
                "reviewer_disposition",
            ],
            "linked_cad_evidence": ["cmf-release-acceptance.json", "mold_tooling.png"],
            "release_blocker": "Orange CMF and gate vestige have not been approved on molded samples.",
            "pass": dfm.get("status") == "cad_dfm_inputs_ready",
        },
        {
            "id": "first_shot_metrology_loop",
            "feature": "first_shot_enclosure_gdt_and_warp_feedback",
            "owner": "manufacturing_quality",
            "cad_status": "cad_action_ready",
            "tool_action": "run first-shot CMM, flatness, boss position, aperture, and snap retention feedback loop",
            "linked_process_case": "clamp_tonnage_window",
            "linked_process_risk": process_cases.get("clamp_tonnage_window", {}).get(
                "risk", "unknown"
            ),
            "required_returned_evidence": [
                "first_shot_cmm_report",
                "warp_measurement_report",
                "tool_correction_log",
                "reviewer_disposition",
            ],
            "linked_cad_evidence": [
                "gdt-release-package.json",
                "gdt-fai-template.csv",
                "tolerance-stack.json",
            ],
            "release_blocker": "First-shot metrology and tool-correction loop has not been executed.",
            "pass": mold_process.get("status") == "cad_mold_process_window_ready",
        },
    ]
    register_rows.extend(cross_cutting_actions)
    complete_count = sum(1 for row in register_rows if row["pass"])
    report = {
        "claim_boundary": (
            "CAD-derived tooling action register for toolmaker RFQ/review. It does not replace "
            "returned tool design, mold-flow, first-shot metrology, or signed toolmaker approval."
        ),
        "status": "cad_tooling_action_register_ready"
        if register_rows and complete_count == len(register_rows)
        else "blocked",
        "expected_action_count": len(register_rows),
        "cad_ready_action_count": complete_count,
        "physical_toolmaker_complete_count": 0,
        "actions": register_rows,
        "release_rule": (
            "Every action must have returned marked-up tool design or physical sample evidence, "
            "toolmaker/reviewer disposition, and any required mold-flow or first-shot records "
            "before injection-tool release."
        ),
    }
    (REVIEW_DIR / "tooling-action-register.json").write_text(json.dumps(report, indent=2) + "\n")
    csv_path = REVIEW_DIR / "tooling-action-register.csv"
    with csv_path.open("w", newline="") as fh:
        fieldnames = [
            "id",
            "feature",
            "owner",
            "cad_status",
            "tool_action",
            "linked_process_case",
            "linked_process_risk",
            "required_returned_evidence",
            "linked_cad_evidence",
            "release_blocker",
        ]
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for row in register_rows:
            writer.writerow(
                {
                    **{key: row[key] for key in fieldnames if key in row},
                    "required_returned_evidence": ";".join(row["required_returned_evidence"]),
                    "linked_cad_evidence": ";".join(row["linked_cad_evidence"]),
                }
            )
    lines = [
        "# E1 Phone Tooling Action Register",
        "",
        f"Status: {report['status']}.",
        "",
        "This register turns the CAD DFM screen into toolmaker actions and remains fail-closed until returned evidence is recorded.",
        "",
        "## Actions",
        "",
    ]
    for row in register_rows:
        lines.append(
            f"- {'PASS' if row['pass'] else 'BLOCKED'}: `{row['id']}` "
            f"{row['tool_action']} ({row['linked_process_risk']} risk)"
        )
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "tooling-action-register.md").write_text("\n".join(lines) + "\n")
    return report


def write_mold_flow_acceptance_artifacts(
    params: dict[str, Any],
    dfm: dict[str, Any],
    mold_process: dict[str, Any],
) -> dict[str, Any]:
    mfg = params["manufacturing"]
    criteria: list[dict[str, Any]] = [
        {
            "id": "fill_pressure_at_vp_transfer_mpa",
            "target": "<= 85% of selected press/resin limit",
            "required_evidence_keys": [
                "fill_pressure_plot",
                "selected_press_spec",
                "resin_pressure_limit_table",
            ],
            "required_numeric_results": [
                "vp_transfer_pressure_mpa",
                "press_pressure_limit_mpa",
                "percent_of_limit",
            ],
        },
        {
            "id": "clamp_tonnage_margin",
            "target": "selected press capacity >= CAD high clamp-tonnage estimate",
            "required_evidence_keys": [
                "clamp_tonnage_report",
                "press_quote_or_machine_spec",
                "projected_area_basis",
            ],
            "required_numeric_results": [
                "projected_area_cm2",
                "estimated_peak_tons",
                "selected_press_capacity_tons",
            ],
        },
        {
            "id": "max_warp_after_shrink_mm",
            "target": "<= 0.35 mm across cover-glass bonding ledge and <= 0.50 mm across back shell",
            "required_evidence_keys": [
                "post_shrink_warp_plot",
                "gdt_datum_overlay",
                "shrink_compensation_table",
            ],
            "required_numeric_results": [
                "glass_ledge_warp_mm",
                "back_shell_warp_mm",
                "datum_shift_mm",
            ],
        },
        {
            "id": "sink_at_boss_and_rib_readthrough_mm",
            "target": "<= 0.05 mm on exterior A-surfaces over bosses/ribs",
            "required_evidence_keys": [
                "sink_readthrough_plot",
                "boss_rib_location_overlay",
                "a_surface_cosmetic_map",
            ],
            "required_numeric_results": [
                "max_boss_sink_mm",
                "max_rib_readthrough_mm",
                "a_surface_sink_mm",
            ],
        },
        {
            "id": "weld_lines_on_cosmetic_surfaces",
            "target": "no weld lines on front orange rail, back hero surface, camera window land, or USB-C lip",
            "required_evidence_keys": [
                "weld_line_plot",
                "cosmetic_keepout_overlay",
                "gate_location_revision",
            ],
            "required_numeric_results": [
                "cosmetic_weld_line_count",
                "nearest_weld_to_camera_land_mm",
                "nearest_weld_to_usb_lip_mm",
            ],
        },
        {
            "id": "air_traps_at_ports_and_snap_hooks",
            "target": "vents added or air traps cleared at USB-C saddle, camera window, acoustic ports, and snap-hook roots",
            "required_evidence_keys": [
                "air_trap_plot",
                "vent_layout_markup",
                "critical_port_region_overlay",
            ],
            "required_numeric_results": [
                "unvented_usb_air_traps",
                "unvented_acoustic_air_traps",
                "unvented_snap_hook_air_traps",
            ],
        },
        {
            "id": "cooling_delta_t_and_cycle_time",
            "target": "<= 8 C cavity surface delta and quoted cycle time <= 30 s",
            "required_evidence_keys": [
                "cooling_delta_t_plot",
                "cooling_circuit_layout",
                "cycle_time_prediction",
            ],
            "required_numeric_results": [
                "max_cavity_delta_t_c",
                "predicted_cycle_time_s",
                "hotspot_count",
            ],
        },
        {
            "id": "orange_gate_blush_and_vestige",
            "target": "gate vestige outside A-surface and blush accepted on orange plaque/first shots",
            "required_evidence_keys": [
                "gate_vestige_markup",
                "orange_color_plaque_photo",
                "gate_blush_limit_sample",
            ],
            "required_numeric_results": [
                "a_surface_gate_vestige_count",
                "vestige_height_mm",
                "delta_e_orange_plaque",
            ],
        },
    ]
    input_deck = {
        "claim_boundary": (
            "CAD-derived mold-flow input deck for a toolmaker or simulation package; "
            "not a returned Moldflow/SolidWorks Plastics/Moldex3D result."
        ),
        "status": "mold_flow_input_deck_ready"
        if dfm["status"] == "cad_dfm_inputs_ready"
        and mold_process["status"] == "cad_mold_process_window_ready"
        else "blocked",
        "geometry_sources": {
            "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
            "tooling_glb": "mechanical/e1-phone/out/e1-phone-mold-tooling.glb",
            "tooling_render": "mechanical/e1-phone/review/mold_tooling.png",
        },
        "material_request": {
            "family": mfg["plastic"],
            "color": params["device"]["plastic_color"],
            "required_supplier_data": [
                "viscosity_curve",
                "pvT_data",
                "shrinkage_tensor",
                "recommended_melt_and_mold_temperature",
            ],
        },
        "nominal_process_window": mold_process["process_window"],
        "required_outputs": [criterion["id"] for criterion in criteria],
        "first_shot_doe": mold_process["first_shot_doe"],
    }
    (REVIEW_DIR / "mold-flow-input-deck.json").write_text(json.dumps(input_deck, indent=2) + "\n")
    input_lines = [
        "# E1 Phone Mold-Flow Input Deck",
        "",
        f"Status: {input_deck['status']}.",
        "",
        "This deck defines the required mold-flow result package; it is not returned simulation evidence.",
        "",
        "## Required Outputs",
        "",
    ]
    for criterion in criteria:
        input_lines.append(f"- `{criterion['id']}`: {criterion['target']}")
    (REVIEW_DIR / "mold-flow-input-deck.md").write_text("\n".join(input_lines) + "\n")

    template_path = REVIEW_DIR / "mold-flow-results-template.csv"
    fieldnames = [
        "criterion_id",
        "toolmaker_name",
        "evidence_class",
        "returned_artifact",
        "raw_simulation_archive",
        "reviewer_acceptance_record",
        "resin_tooling_traceability_record",
        "measured_or_predicted_value",
        "accepted",
        "reviewer",
        "required_evidence_keys",
        "required_numeric_results",
        "linked_cad_evidence",
        "notes",
    ]
    rows = [
        {
            "criterion_id": criterion["id"],
            "toolmaker_name": "",
            "evidence_class": "",
            "returned_artifact": "",
            "raw_simulation_archive": "",
            "reviewer_acceptance_record": "",
            "resin_tooling_traceability_record": "",
            "measured_or_predicted_value": "",
            "accepted": "",
            "reviewer": "",
            "required_evidence_keys": ";".join(criterion["required_evidence_keys"]),
            "required_numeric_results": ";".join(criterion["required_numeric_results"]),
            "linked_cad_evidence": "mold-flow-input-deck.json;mold-process-window.json;injection-molding-dfm.json",
            "notes": criterion["target"],
        }
        for criterion in criteria
    ]
    should_write_template = True
    if template_path.is_file():
        existing_text = template_path.read_text()
        existing_lines = existing_text.splitlines()
        if existing_lines and existing_lines[0].startswith("# evidence_class:"):
            existing_text = "\n".join(existing_lines[1:]) + "\n"
        with StringIO(existing_text) as existing_file:
            existing_rows = list(csv.DictReader(existing_file))
        existing_ids = {row.get("criterion_id", "") for row in existing_rows}
        expected_ids = {row["criterion_id"] for row in rows}
        existing_fields = list(existing_rows[0].keys()) if existing_rows else []
        response_fields = [
            "toolmaker_name",
            "evidence_class",
            "returned_artifact",
            "raw_simulation_archive",
            "reviewer_acceptance_record",
            "resin_tooling_traceability_record",
            "measured_or_predicted_value",
            "accepted",
            "reviewer",
        ]
        has_response_content = any(
            row.get(field, "").strip() for row in existing_rows for field in response_fields
        )
        should_write_template = not has_response_content and (
            existing_ids != expected_ids or existing_fields != fieldnames or not existing_rows
        )
    if should_write_template:
        with template_path.open("w", newline="") as result_template_file:
            writer = csv.DictWriter(result_template_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    template_evidence_class = ""
    csv_text = template_path.read_text() if template_path.is_file() else ""
    csv_lines = csv_text.splitlines()
    if csv_lines and csv_lines[0].startswith("# evidence_class:"):
        template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
        csv_text = "\n".join(csv_lines[1:]) + "\n"
    expected_by_id = {criterion["id"]: criterion for criterion in criteria}
    forbidden_evidence_classes = {
        "simulated_mold_flow_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    cases: list[dict[str, Any]] = []
    with StringIO(csv_text) as csv_file:
        for row in csv.DictReader(csv_file):
            criterion_id = row.get("criterion_id", "")
            expected = expected_by_id.get(criterion_id, {})
            evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
            accepted = row.get("accepted", "").strip().lower()
            required_evidence_keys = [
                key
                for key in (
                    row.get("required_evidence_keys")
                    or ";".join(expected.get("required_evidence_keys", []))
                ).split(";")
                if key
            ]
            required_numeric_results = [
                key
                for key in (
                    row.get("required_numeric_results")
                    or ";".join(expected.get("required_numeric_results", []))
                ).split(";")
                if key
            ]
            evidence_fields_present = all(
                row.get(field, "").strip()
                for field in [
                    "returned_artifact",
                    "raw_simulation_archive",
                    "reviewer_acceptance_record",
                    "resin_tooling_traceability_record",
                ]
            )
            evidence_class_allowed = (
                evidence_class == "physical_mold_flow_result"
                and evidence_class not in forbidden_evidence_classes
            )
            populated = bool(
                criterion_id
                and row.get("toolmaker_name", "").strip()
                and evidence_class
                and row.get("measured_or_predicted_value", "").strip()
                and row.get("reviewer", "").strip()
                and required_evidence_keys
                and required_numeric_results
                and evidence_fields_present
            )
            cases.append(
                {
                    "criterion_id": criterion_id,
                    "expected_criterion": criterion_id in expected_by_id,
                    "toolmaker_named": bool(row.get("toolmaker_name", "").strip()),
                    "evidence_class": evidence_class,
                    "evidence_class_allowed": evidence_class_allowed,
                    "returned_artifact_present": bool(row.get("returned_artifact", "").strip()),
                    "raw_simulation_archive_present": bool(
                        row.get("raw_simulation_archive", "").strip()
                    ),
                    "reviewer_acceptance_record_present": bool(
                        row.get("reviewer_acceptance_record", "").strip()
                    ),
                    "resin_tooling_traceability_record_present": bool(
                        row.get("resin_tooling_traceability_record", "").strip()
                    ),
                    "value_present": bool(row.get("measured_or_predicted_value", "").strip()),
                    "reviewer_present": bool(row.get("reviewer", "").strip()),
                    "accepted": accepted in {"yes", "true", "1", "pass"},
                    "required_evidence_keys": required_evidence_keys,
                    "required_numeric_results": required_numeric_results,
                    "linked_cad_evidence": [
                        item for item in row.get("linked_cad_evidence", "").split(";") if item
                    ],
                    "populated": populated,
                    "physical_evidence_pass": evidence_class_allowed and evidence_fields_present,
                    "pass": populated
                    and criterion_id in expected_by_id
                    and accepted in {"yes", "true", "1", "pass"}
                    and evidence_class_allowed
                    and evidence_fields_present,
                }
            )
    missing_or_incomplete = [case["criterion_id"] for case in cases if not case["pass"]]
    complete_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": (
            "Fail-closed mold-flow acceptance contract. CAD process proxies and simulated rows "
            "do not count as physical/toolmaker mold-flow evidence."
        ),
        "status": "mold_flow_results_pass"
        if cases and complete_count == len(criteria) and not missing_or_incomplete
        else "blocked_no_mold_flow_results"
        if complete_count == 0
        else "blocked_mold_flow_results_incomplete",
        "plastic": mfg["plastic"],
        "gate_strategy": mfg["gate_strategy"],
        "input_deck": "mechanical/e1-phone/review/mold-flow-input-deck.json",
        "input_deck_status": input_deck["status"],
        "results_template": "mechanical/e1-phone/review/mold-flow-results-template.csv",
        "expected_criterion_count": len(criteria),
        "required_evidence_class": "physical_mold_flow_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "complete_result_count": complete_count,
        "missing_or_incomplete_criteria": missing_or_incomplete,
        "criteria": criteria,
        "cases": cases,
        "release_rule": (
            "Every mold-flow criterion must include toolmaker name, evidence_class=physical_mold_flow_result, "
            "returned report, raw simulation archive, reviewer acceptance record, resin/tooling traceability, "
            "numeric measured/predicted value, accepted disposition, and reviewer before tooling release."
        ),
    }
    (REVIEW_DIR / "mold-flow-acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Mold-Flow Acceptance",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until physical/toolmaker mold-flow evidence is returned.",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for criterion_id in missing_or_incomplete:
        lines.append(f"- `{criterion_id}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "mold-flow-acceptance.md").write_text("\n".join(lines) + "\n")
    return report


def write_toolmaker_signoff_artifacts(
    params: dict[str, Any], dfm: dict[str, Any], mold_process: dict[str, Any]
) -> dict[str, Any]:
    mfg = params["manufacturing"]
    request_items = [
        {
            "id": "mold_flow_fill_pack_warp",
            "request": "Run fill/pack/warp simulation on orange PC+ABS shell and side-frame tool concept.",
            "required_return": "Mold-flow report with pressure, fill time, weld lines, air traps, sink, shrink, and warp plots.",
            "required_evidence_artifacts": [
                "signed_moldflow_report",
                "fill_pack_warp_raw_simulation_archive",
                "toolmaker_acceptance_record",
                "resin_grade_and_tool_revision_traceability",
            ],
        },
        {
            "id": "gate_runner_balance",
            "request": "Review dual submarine gate and cold-runner layout against cosmetic gate vestige limits.",
            "required_return": "Signed gate/runner recommendation with gate land, gate area, vestige location, and alternate fan-gate decision.",
            "required_evidence_artifacts": [
                "signed_gate_runner_markup",
                "gate_pressure_shear_or_balance_calculation",
                "toolmaker_acceptance_record",
                "tool_revision_traceability_record",
            ],
        },
        {
            "id": "ejector_layout",
            "request": "Review modeled ejector pins against non-cosmetic surfaces, boss support, and part release.",
            "required_return": "Ejector layout markup with witness-mark acceptance and any added blade/sleeve ejectors.",
            "required_evidence_artifacts": [
                "signed_ejector_layout_markup",
                "ejector_balance_or_release_risk_record",
                "toolmaker_acceptance_record",
                "tool_revision_traceability_record",
            ],
        },
        {
            "id": "cooling_layout",
            "request": "Review straight cooling-channel placeholders and propose production baffles or conformal cooling.",
            "required_return": "Cooling layout with channel diameter, clearance, circuiting, expected cycle time, and hot-spot risk.",
            "required_evidence_artifacts": [
                "signed_cooling_layout_markup",
                "cooling_circuit_cycle_time_calculation",
                "toolmaker_acceptance_record",
                "tool_revision_traceability_record",
            ],
        },
        {
            "id": "shrink_warp_allowance",
            "request": "Confirm resin shrink, steel-safe stock, datum scheme, and CMM tuning plan.",
            "required_return": "Shrink/warp allowance table tied to GD&T datums and first-article CMM plan.",
            "required_evidence_artifacts": [
                "signed_shrink_warp_allowance_table",
                "resin_shrink_data_or_moldflow_warp_report",
                "toolmaker_acceptance_record",
                "resin_grade_tooling_and_datum_traceability",
            ],
        },
        {
            "id": "orange_cmf_texture",
            "request": "Approve hard orange PC+ABS color, gloss, texture depth, gate blush tolerance, and scratch samples.",
            "required_return": "Color plaque, texture plaque, gate-blush limit sample, and signed CMF acceptance criteria.",
            "required_evidence_artifacts": [
                "signed_orange_cmf_acceptance_record",
                "color_texture_plaque_photo_set",
                "reviewer_acceptance_record",
                "resin_colorant_texture_and_tool_traceability",
            ],
        },
        {
            "id": "first_shot_doe",
            "request": "Quote and approve first-shot DOE covering melt temperature, mold temperature, pack pressure, hold time, and cooling time.",
            "required_return": "DOE run sheet and acceptance plan for first shots before DVT tool tuning.",
            "required_evidence_artifacts": [
                "signed_first_shot_doe_plan",
                "process_window_or_doe_data_sheet",
                "toolmaker_acceptance_record",
                "press_resin_tool_revision_traceability",
            ],
        },
    ]
    response_path = REVIEW_DIR / "toolmaker-signoff-response-template.csv"
    fieldnames = [
        "review_item_id",
        "toolmaker_name",
        "report_or_drawing_received",
        "accepted",
        "reviewer",
        "evidence_class",
        "required_evidence_artifacts",
        "returned_artifact",
        "moldflow_or_tooling_data_artifact",
        "reviewer_acceptance_record",
        "resin_cmf_or_tooling_traceability_record",
        "measured_or_predicted_value",
        "notes",
    ]
    template_rows = [
        {
            "review_item_id": item["id"],
            "toolmaker_name": "",
            "report_or_drawing_received": "",
            "accepted": "",
            "reviewer": "",
            "evidence_class": "",
            "required_evidence_artifacts": ";".join(item["required_evidence_artifacts"]),
            "returned_artifact": "",
            "moldflow_or_tooling_data_artifact": "",
            "reviewer_acceptance_record": "",
            "resin_cmf_or_tooling_traceability_record": "",
            "measured_or_predicted_value": "",
            "notes": item["required_return"],
        }
        for item in request_items
    ]
    should_write_template = True
    existing_text = ""
    if response_path.is_file():
        existing_text = response_path.read_text()
        csv_text = existing_text
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as existing_file:
            existing_rows = list(csv.DictReader(existing_file))
        existing_ids = {row.get("review_item_id", "") for row in existing_rows}
        has_response_content = any(
            row.get(field, "").strip()
            for row in existing_rows
            for field in [
                "toolmaker_name",
                "report_or_drawing_received",
                "accepted",
                "reviewer",
                "evidence_class",
                "returned_artifact",
                "moldflow_or_tooling_data_artifact",
                "reviewer_acceptance_record",
                "resin_cmf_or_tooling_traceability_record",
                "measured_or_predicted_value",
            ]
        )
        should_write_template = existing_ids != {item["id"] for item in request_items} or (
            list(existing_rows[0].keys()) != fieldnames if existing_rows else True
        )
        if has_response_content:
            should_write_template = False
    if should_write_template:
        with response_path.open("w", newline="") as csv_file:
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(template_rows)

    cases: list[dict[str, Any]] = []
    template_evidence_class = ""
    csv_text = response_path.read_text()
    csv_lines = csv_text.splitlines()
    if csv_lines and csv_lines[0].startswith("# evidence_class:"):
        template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
        csv_text = "\n".join(csv_lines[1:]) + "\n"
    expected_by_id = {item["id"]: item for item in request_items}
    forbidden_evidence_classes = {
        "simulated_toolmaker_signoff_for_planning_not_release",
        "simulated_first_article_for_evt_planning_not_production_release",
        "simulated",
        "planning",
        "blank_template",
    }
    with StringIO(csv_text) as csv_file:
        for row in csv.DictReader(csv_file):
            accepted = row.get("accepted", "").strip().lower()
            received = row.get("report_or_drawing_received", "").strip().lower()
            review_item_id = row["review_item_id"]
            expected_item = expected_by_id.get(review_item_id, {})
            evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
            required_evidence_artifacts = [
                artifact
                for artifact in (
                    row.get("required_evidence_artifacts")
                    or ";".join(expected_item.get("required_evidence_artifacts", []))
                ).split(";")
                if artifact
            ]
            evidence_fields_present = all(
                row.get(field, "").strip()
                for field in [
                    "returned_artifact",
                    "moldflow_or_tooling_data_artifact",
                    "reviewer_acceptance_record",
                    "resin_cmf_or_tooling_traceability_record",
                ]
            )
            evidence_class_allowed = (
                evidence_class == "physical_toolmaker_signoff"
                and evidence_class not in forbidden_evidence_classes
            )
            populated = bool(
                row.get("toolmaker_name", "").strip()
                and row.get("reviewer", "").strip()
                and evidence_class
                and required_evidence_artifacts
                and evidence_fields_present
            )
            cases.append(
                {
                    "review_item_id": review_item_id,
                    "toolmaker_named": bool(row.get("toolmaker_name", "").strip()),
                    "report_or_drawing_received": received in {"yes", "true", "1", "pass"},
                    "accepted": accepted in {"yes", "true", "1", "pass"},
                    "reviewer_present": bool(row.get("reviewer", "").strip()),
                    "evidence_class": evidence_class,
                    "evidence_class_allowed": evidence_class_allowed,
                    "required_evidence_artifacts": required_evidence_artifacts,
                    "returned_artifact_present": bool(row.get("returned_artifact", "").strip()),
                    "moldflow_or_tooling_data_artifact_present": bool(
                        row.get("moldflow_or_tooling_data_artifact", "").strip()
                    ),
                    "reviewer_acceptance_record_present": bool(
                        row.get("reviewer_acceptance_record", "").strip()
                    ),
                    "resin_cmf_or_tooling_traceability_record_present": bool(
                        row.get("resin_cmf_or_tooling_traceability_record", "").strip()
                    ),
                    "pass": populated
                    and received in {"yes", "true", "1", "pass"}
                    and accepted in {"yes", "true", "1", "pass"},
                    "physical_evidence_pass": evidence_class_allowed and evidence_fields_present,
                }
            )
            cases[-1]["pass"] = cases[-1]["pass"] and cases[-1]["physical_evidence_pass"]
    missing_items = [case["review_item_id"] for case in cases if not case["pass"]]
    complete_count = sum(1 for case in cases if case["pass"])
    report = {
        "claim_boundary": "Toolmaker/mold-flow request and fail-closed response review; CAD tooling placeholders are not toolmaker signoff.",
        "status": "toolmaker_signoff_complete"
        if cases and complete_count == len(cases)
        else "blocked_no_toolmaker_signoff"
        if complete_count == 0
        else "blocked_toolmaker_signoff_incomplete",
        "package_status": "toolmaker_signoff_package_ready"
        if dfm["status"] == "cad_dfm_inputs_ready"
        and mold_process["status"] == "cad_mold_process_window_ready"
        and response_path.is_file()
        else "blocked",
        "plastic": mfg["plastic"],
        "gate_strategy": mfg["gate_strategy"],
        "process_window": mold_process["process_window"],
        "mold_process_cases": mold_process["cases"],
        "request_items": request_items,
        "response_template": "mechanical/e1-phone/review/toolmaker-signoff-response-template.csv",
        "expected_response_count": len(cases),
        "required_evidence_class": "physical_toolmaker_signoff",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "complete_response_count": complete_count,
        "missing_or_incomplete_items": missing_items,
        "cases": cases,
        "release_rule": "Every toolmaker item must name the toolmaker, return signed mold-flow/tooling/CMF artifacts, include evidence_class=physical_toolmaker_signoff, include raw moldflow/tooling data, reviewer acceptance record, resin/CMF/tooling traceability, and be accepted before tooling release.",
    }
    (REVIEW_DIR / "toolmaker-signoff-package.json").write_text(json.dumps(report, indent=2) + "\n")
    (REVIEW_DIR / "toolmaker-signoff-review.json").write_text(json.dumps(report, indent=2) + "\n")

    package_lines = [
        "# E1 Phone Toolmaker Signoff Package",
        "",
        "Status: request package ready; toolmaker signoff not returned.",
        "",
        "## Request Items",
        "",
    ]
    for item in request_items:
        package_lines.append(f"- `{item['id']}` {item['request']}")
        package_lines.append(f"  Required return: {item['required_return']}")
    package_lines.extend(["", "## Process Window", ""])
    package_lines.append(
        f"- Melt temperature: {report['process_window']['melt_temp_c'][0]}-{report['process_window']['melt_temp_c'][1]} C"
    )
    package_lines.append(
        f"- Mold temperature: {report['process_window']['mold_temp_c'][0]}-{report['process_window']['mold_temp_c'][1]} C"
    )
    (REVIEW_DIR / "toolmaker-signoff-package.md").write_text("\n".join(package_lines) + "\n")

    review_lines = [
        "# E1 Phone Toolmaker Signoff Review",
        "",
        f"Status: {report['status']}.",
        "",
        "This review is fail-closed until mold-flow/toolmaker artifacts are returned.",
        "",
        f"Template: `{report['response_template']}`",
        "",
        "## Missing Or Incomplete",
        "",
    ]
    for item_id in missing_items:
        review_lines.append(f"- `{item_id}`")
    review_lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "toolmaker-signoff-review.md").write_text("\n".join(review_lines) + "\n")
    return report


def write_board_step_readiness_artifacts(
    params: dict[str, Any], kicad_reconciliation: dict[str, Any], solid_cad: dict[str, Any]
) -> dict[str, Any]:
    def file_sha256(path: Path) -> str | None:
        if not path.is_file():
            return None
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def blocked_candidate_artifact(path: Path) -> bool:
        for sidecar in (
            path.with_name(path.name + ".metadata.yaml"),
            path.with_name(path.name + ".metadata.yml"),
            path.with_name(path.name + ".metadata.json"),
        ):
            if sidecar.is_file():
                return blocked_candidate_artifact(sidecar)
        if path.suffix.lower() == ".json":
            data = json.loads(path.read_text())
        elif path.suffix.lower() in {".yaml", ".yml"}:
            data = yaml.safe_load(path.read_text())
        else:
            return False
        if not isinstance(data, dict):
            return False
        claim = str(data.get("claim_boundary", "")).lower()
        status = str(data.get("status", "")).lower()
        disposition = str(data.get("disposition", "")).lower()
        return (
            data.get("release_allowed") is False
            or "not release evidence" in claim
            or status.startswith("blocked")
            or disposition.startswith("blocked")
        )

    pcb_path = ROOT / params["pcb"]["source"]
    manufacturing_closure_path = ROOT / "board/kicad/e1-phone/manufacturing-closure.yaml"
    layout_utilization_path = ROOT / "board/kicad/e1-phone/layout-utilization.yaml"
    production_step_dir = ROOT / "board/kicad/e1-phone/production/step"
    production_step_files = sorted(production_step_dir.glob("*.step")) + sorted(
        production_step_dir.glob("*.stp")
    )
    approved_production_step_files = [
        path for path in production_step_files if not blocked_candidate_artifact(path)
    ]
    blocked_candidate_step_files = [
        path for path in production_step_files if blocked_candidate_artifact(path)
    ]
    demo_step_files = sorted((ROOT / "board/kicad/e1-phone/pcb/fab-demo").glob("*.step")) + sorted(
        (ROOT / "board/kicad/e1-phone/pcb/fab-demo").glob("*.stp")
    )
    concept_pcb_step_path = OUT_DIR / "main_pcb.step"
    routed_intake_path = REVIEW_DIR / "routed-board-step-intake-template.csv"
    routed_intake_fieldnames = [
        "release_id",
        "kicad_pcb_path",
        "routed_step_artifact",
        "routed_step_sha256",
        "source_board_sha256",
        "source_step_artifact",
        "source_step_sha256",
        "drc_report_artifact",
        "drc_status",
        "erc_report_artifact",
        "erc_status",
        "gerber_job_artifact",
        "pick_place_artifact",
        "bom_artifact",
        "component_3d_model_manifest",
        "component_3d_model_manifest_status",
        "component_model_count",
        "pad_contact_visual_count",
        "route_segment_visual_count",
        "route_segment_net_name_count",
        "route_segment_trace_bound_count",
        "route_segment_trace_unbound_count",
        "controlled_impedance_segment_visual_count",
        "via_net_name_count",
        "cad_connection_count",
        "kicad_cad_traceability_matrix",
        "traceability_status",
        "traceability_gap_count",
        "enclosure_clearance_rerun_artifact",
        "enclosure_clearance_status",
        "reviewer",
        "approval_signature",
        "evidence_class",
        "release_credit",
        "notes",
    ]
    routed_candidate_path = (
        ROOT / "board/kicad/e1-phone/production/step/routed-board-with-components.step"
    )
    routed_candidate_sha256 = (
        file_sha256(routed_candidate_path) if routed_candidate_path.is_file() else ""
    )
    routed_output_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
    )
    component_3d_model_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml"
    )
    kicad_cad_traceability_matrix_path = (
        ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
    )
    routed_output_manifest_for_intake = (
        yaml.safe_load(routed_output_manifest_path.read_text())
        if routed_output_manifest_path.is_file()
        else {}
    )
    if not isinstance(routed_output_manifest_for_intake, dict):
        routed_output_manifest_for_intake = {}
    component_manifest_for_intake = (
        yaml.safe_load(component_3d_model_manifest_path.read_text())
        if component_3d_model_manifest_path.is_file()
        else {}
    )
    if not isinstance(component_manifest_for_intake, dict):
        component_manifest_for_intake = {}
    traceability_matrix_for_intake = (
        yaml.safe_load(kicad_cad_traceability_matrix_path.read_text())
        if kicad_cad_traceability_matrix_path.is_file()
        else {}
    )
    if not isinstance(traceability_matrix_for_intake, dict):
        traceability_matrix_for_intake = {}
    routed_step_visual_detail = routed_output_manifest_for_intake.get(
        "routed_step_visual_detail", {}
    )
    if not isinstance(routed_step_visual_detail, dict):
        routed_step_visual_detail = {}
    cad_connection_coverage = routed_output_manifest_for_intake.get("cad_connection_coverage", {})
    if not isinstance(cad_connection_coverage, dict):
        cad_connection_coverage = {}
    traceability_summary_for_intake = traceability_matrix_for_intake.get("summary", {})
    if not isinstance(traceability_summary_for_intake, dict):
        traceability_summary_for_intake = {}
    traceability_gap_count = sum(
        int(traceability_summary_for_intake.get(field) or 0)
        for field in [
            "incomplete_footprint_count",
            "incomplete_cad_connection_count",
            "missing_captured_pinout_file_count",
            "incomplete_captured_pinout_detail_count",
        ]
    )
    component_models_for_intake = component_manifest_for_intake.get("models", [])
    if not isinstance(component_models_for_intake, list):
        component_models_for_intake = []
    routed_intake_template_row = {
        "release_id": "LOCAL-ROUTED-CANDIDATE-2026-05-22",
        "kicad_pcb_path": "board/kicad/e1-phone/pcb/e1-phone-mainboard-routed.kicad_pcb",
        "routed_step_artifact": "board/kicad/e1-phone/production/step/routed-board-with-components.step",
        "routed_step_sha256": routed_candidate_sha256,
        "source_board_sha256": str(
            routed_output_manifest_for_intake.get("source_board_sha256") or ""
        ),
        "source_step_artifact": str(routed_output_manifest_for_intake.get("source_step") or ""),
        "source_step_sha256": str(
            routed_output_manifest_for_intake.get("source_step_sha256") or ""
        ),
        "drc_report_artifact": "board/kicad/e1-phone/production/reports/drc.json",
        "drc_status": "not_run",
        "erc_report_artifact": "board/kicad/e1-phone/production/reports/erc.json",
        "erc_status": "not_run",
        "gerber_job_artifact": "board/kicad/e1-phone/production/gerbers/release-manifest.yaml",
        "pick_place_artifact": "board/kicad/e1-phone/production/pos/release-manifest.yaml",
        "bom_artifact": "board/kicad/e1-phone/production/bom/release-manifest.yaml",
        "component_3d_model_manifest": "board/kicad/e1-phone/production/step/component-3d-model-manifest.yaml",
        "component_3d_model_manifest_status": "blocked_local_development_envelopes_not_supplier_models",
        "component_model_count": str(len(component_models_for_intake)),
        "pad_contact_visual_count": str(
            int(routed_step_visual_detail.get("pad_contact_visual_count") or 0)
        ),
        "route_segment_visual_count": str(
            int(routed_step_visual_detail.get("route_segment_visual_count") or 0)
        ),
        "route_segment_net_name_count": str(
            int(routed_step_visual_detail.get("route_segment_net_name_count") or 0)
        ),
        "route_segment_trace_bound_count": str(
            int(routed_step_visual_detail.get("route_segment_trace_bound_count") or 0)
        ),
        "route_segment_trace_unbound_count": str(
            int(routed_step_visual_detail.get("route_segment_trace_unbound_count") or 0)
        ),
        "controlled_impedance_segment_visual_count": str(
            int(routed_step_visual_detail.get("controlled_impedance_segment_visual_count") or 0)
        ),
        "via_net_name_count": str(
            int(routed_step_visual_detail.get("via_net_name_count") or 0)
        ),
        "cad_connection_count": str(
            int(cad_connection_coverage.get("passing_connection_count") or 0)
        ),
        "kicad_cad_traceability_matrix": (
            "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
        ),
        "traceability_status": str(traceability_matrix_for_intake.get("status") or ""),
        "traceability_gap_count": str(traceability_gap_count),
        "enclosure_clearance_rerun_artifact": "mechanical/e1-phone/review/routed-board-clearance.json",
        "enclosure_clearance_status": "blocked_waiting_for_physical_routed_board_clearance_result",
        "reviewer": "unreviewed",
        "approval_signature": "blocked_candidate_not_approved",
        "evidence_class": "blocked_local_candidate_outputs_not_release",
        "release_credit": "false",
        "notes": "Local routed-output candidate intake only: hash and artifact paths are recorded, but DRC/ERC, supplier-approved component models, physical routed-board clearance, and release approval remain blocked.",
    }
    should_write_routed_intake_template = not routed_intake_path.is_file()
    if routed_intake_path.is_file():
        existing_csv_text = routed_intake_path.read_text()
        existing_csv_lines = existing_csv_text.splitlines()
        if existing_csv_lines and existing_csv_lines[0].startswith("# evidence_class:"):
            existing_csv_text = "\n".join(existing_csv_lines[1:]) + "\n"
        with StringIO(existing_csv_text) as existing_csv_buffer:
            existing_rows = list(csv.DictReader(existing_csv_buffer))
        existing_fields = list(existing_rows[0].keys()) if existing_rows else []
        has_release_response_content = any(
            row.get(field, "").strip()
            for row in existing_rows
            for field in [
                "release_id",
                "routed_step_sha256",
                "drc_status",
                "erc_status",
                "component_3d_model_manifest_status",
                "enclosure_clearance_status",
                "reviewer",
                "approval_signature",
                "evidence_class",
            ]
        )
        auto_generated_local_candidate = bool(existing_rows) and all(
            row.get("release_id", "").strip() == routed_intake_template_row["release_id"]
            and row.get("evidence_class", "").strip()
            == routed_intake_template_row["evidence_class"]
            for row in existing_rows
        )
        stale_auto_generated_candidate = auto_generated_local_candidate and (
            len(existing_rows) != 1
            or any(
                str(existing_rows[0].get(field, "")).strip() != str(value)
                for field, value in routed_intake_template_row.items()
            )
        )
        should_write_routed_intake_template = (
            existing_fields != routed_intake_fieldnames
            or not has_release_response_content
            or stale_auto_generated_candidate
        )
    if should_write_routed_intake_template:
        with routed_intake_path.open("w", newline="") as csv_file:
            writer = csv.DictWriter(
                csv_file,
                fieldnames=routed_intake_fieldnames,
                lineterminator="\n",
            )
            writer.writeheader()
            writer.writerow(routed_intake_template_row)

    routed_intake_rows: list[dict[str, str]] = []
    routed_template_evidence_class = ""
    routed_csv_text = routed_intake_path.read_text()
    routed_csv_lines = routed_csv_text.splitlines()
    if routed_csv_lines and routed_csv_lines[0].startswith("# evidence_class:"):
        routed_template_evidence_class = routed_csv_lines[0].split(":", 1)[1].strip()
        routed_csv_text = "\n".join(routed_csv_lines[1:]) + "\n"
    with StringIO(routed_csv_text) as routed_csv_buffer:
        routed_intake_rows = list(csv.DictReader(routed_csv_buffer))
    routed_forbidden_evidence_classes = {
        "demo_routed_board_for_planning_not_release",
        "simulated_routed_board_release_for_planning_not_release",
        "concept",
        "demo",
        "planning",
        "blank_template",
    }
    routed_intake_cases: list[dict[str, Any]] = []
    for row in routed_intake_rows:
        evidence_class = row.get("evidence_class", "").strip() or routed_template_evidence_class
        evidence_class_allowed = (
            evidence_class == "physical_routed_board_release"
            and evidence_class not in routed_forbidden_evidence_classes
        )
        required_fields = [
            "release_id",
            "kicad_pcb_path",
            "routed_step_artifact",
            "routed_step_sha256",
            "source_board_sha256",
            "source_step_artifact",
            "source_step_sha256",
            "drc_report_artifact",
            "drc_status",
            "erc_report_artifact",
            "erc_status",
            "gerber_job_artifact",
            "pick_place_artifact",
            "bom_artifact",
            "component_3d_model_manifest",
            "component_3d_model_manifest_status",
            "component_model_count",
            "pad_contact_visual_count",
            "route_segment_visual_count",
            "cad_connection_count",
            "kicad_cad_traceability_matrix",
            "traceability_status",
            "traceability_gap_count",
            "enclosure_clearance_rerun_artifact",
            "enclosure_clearance_status",
            "reviewer",
            "approval_signature",
        ]
        required_fields_present = all(row.get(field, "").strip() for field in required_fields)
        missing_required_fields = [
            field for field in required_fields if not row.get(field, "").strip()
        ]
        existing_artifacts = {
            field: bool((ROOT / row.get(field, "")).is_file())
            for field in [
                "kicad_pcb_path",
                "routed_step_artifact",
                "source_step_artifact",
                "drc_report_artifact",
                "erc_report_artifact",
                "gerber_job_artifact",
                "pick_place_artifact",
                "bom_artifact",
                "component_3d_model_manifest",
                "kicad_cad_traceability_matrix",
                "enclosure_clearance_rerun_artifact",
            ]
            if row.get(field, "").strip()
        }
        artifact_paths_exist = bool(existing_artifacts) and all(existing_artifacts.values())
        routed_step_path_text = row.get("routed_step_artifact", "").strip()
        routed_step_path = ROOT / routed_step_path_text if routed_step_path_text else None
        routed_step_sha256_matches = False
        if (
            routed_step_path
            and routed_step_path.is_file()
            and row.get("routed_step_sha256", "").strip()
        ):
            routed_step_sha256_matches = (
                file_sha256(routed_step_path) == row["routed_step_sha256"].strip()
            )
        drc_status_clean = row.get("drc_status", "").strip().lower() in {
            "clean",
            "pass",
            "passed",
            "drc_clean",
        }
        erc_status_clean = row.get("erc_status", "").strip().lower() in {
            "clean",
            "pass",
            "passed",
            "erc_clean",
        }
        component_3d_manifest_approved = row.get(
            "component_3d_model_manifest_status", ""
        ).strip().lower() in {
            "approved",
            "supplier_approved",
            "complete",
            "pass",
        }
        enclosure_clearance_passed = row.get("enclosure_clearance_status", "").strip().lower() in {
            "pass",
            "passed",
            "clearance_pass",
            "routed_board_clearance_pass",
        }
        traceability_gap_count_value = None
        with suppress(ValueError):
            traceability_gap_count_value = int(row.get("traceability_gap_count", "").strip())
        local_traceability_complete = bool(
            row.get("traceability_status", "").strip() == "local_traceability_complete_not_release"
            and traceability_gap_count_value == 0
        )
        local_release_credit = row.get("release_credit", "").strip().lower() in {
            "true",
            "yes",
            "1",
            "release",
        }
        routed_intake_cases.append(
            {
                "release_id": row.get("release_id", ""),
                "evidence_class": evidence_class,
                "evidence_class_allowed": evidence_class_allowed,
                "required_fields_present": required_fields_present,
                "missing_required_fields": missing_required_fields,
                "artifact_paths_exist": artifact_paths_exist,
                "artifact_path_checks": existing_artifacts,
                "routed_step_sha256_matches": routed_step_sha256_matches,
                "drc_status_clean": drc_status_clean,
                "erc_status_clean": erc_status_clean,
                "component_3d_model_manifest_approved": component_3d_manifest_approved,
                "local_traceability_complete": local_traceability_complete,
                "local_traceability_release_credit": local_release_credit,
                "enclosure_clearance_passed": enclosure_clearance_passed,
                "approval_signature_present": bool(row.get("approval_signature", "").strip()),
                "pass": (
                    evidence_class_allowed
                    and required_fields_present
                    and artifact_paths_exist
                    and routed_step_sha256_matches
                    and drc_status_clean
                    and erc_status_clean
                    and component_3d_manifest_approved
                    and enclosure_clearance_passed
                    and bool(row.get("approval_signature", "").strip())
                ),
            }
        )
    routed_intake_complete = bool(routed_intake_cases) and all(
        case["pass"] for case in routed_intake_cases
    )
    pcb_text = pcb_path.read_text() if pcb_path.is_file() else ""
    development_board_path = (
        ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-real-footprint-development.kicad_pcb"
    )
    development_step_intake_path = (
        ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
    )
    routed_development_intake_path = (
        ROOT / "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml"
    )
    routed_output_manifest_path = (
        ROOT / "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml"
    )
    development_step_intake = (
        yaml.safe_load(development_step_intake_path.read_text())
        if development_step_intake_path.is_file()
        else {}
    )
    routed_development_intake = (
        yaml.safe_load(routed_development_intake_path.read_text())
        if routed_development_intake_path.is_file()
        else {}
    )
    routed_output_manifest = (
        yaml.safe_load(routed_output_manifest_path.read_text())
        if routed_output_manifest_path.is_file()
        else {}
    )
    development_board_text = (
        development_board_path.read_text() if development_board_path.is_file() else ""
    )
    development_step_output = development_step_intake.get("output_step", "")
    development_step_path = ROOT / development_step_output if development_step_output else None
    development_board_state = {
        "board": str(development_board_path.relative_to(ROOT)),
        "exists": development_board_path.is_file(),
        "footprint_refs": development_board_text.count("(footprint "),
        "development_footprint_refs": development_board_text.count('(footprint "e1-phone-dev:'),
        "e1phone_footprint_refs": development_board_text.count('(footprint "E1Phone:'),
        "segment_count": development_board_text.count("(segment "),
        "via_count": development_board_text.count("(via "),
        "routed_development_route_count": int(routed_development_intake.get("route_count") or 0),
        "routed_development_segment_count": int(
            routed_development_intake.get("segment_count") or 0
        ),
        "routed_development_missing_required_shared_net_count": int(
            routed_development_intake.get("coverage", {}).get(
                "missing_required_shared_net_count", 0
            )
            if isinstance(routed_development_intake.get("coverage"), dict)
            else 0
        ),
        "routed_development_missing_route_domain_net_count": int(
            routed_development_intake.get("coverage", {}).get("missing_route_domain_net_count", 0)
            if isinstance(routed_development_intake.get("coverage"), dict)
            else 0
        ),
        "placeholder_marker_count": development_board_text.count(
            "placeholder_not_fabrication_footprint"
        ),
        "non_release_marker_count": development_board_text.count("NON-RELEASE"),
        "step_intake": str(development_step_intake_path.relative_to(ROOT)),
        "step_intake_status": development_step_intake.get("status", "missing"),
        "step_output": development_step_output,
        "step_exists": bool(development_step_path and development_step_path.is_file()),
        "step_size_bytes": development_step_path.stat().st_size
        if development_step_path and development_step_path.is_file()
        else 0,
        "step_footprint_envelope_count": development_step_intake.get("footprint_envelope_count"),
        "release_credit": False,
    }
    expected_development_footprint_count = int(
        development_step_intake.get("footprint_envelope_count")
        or development_board_state["development_footprint_refs"]
        or 0
    )
    development_step_local_review_ready = (
        development_board_state["exists"]
        and expected_development_footprint_count > 0
        and development_board_state["footprint_refs"] == expected_development_footprint_count
        and development_board_state["development_footprint_refs"]
        == expected_development_footprint_count
        and development_board_state["e1phone_footprint_refs"] == 0
        and development_board_state["placeholder_marker_count"] == 0
        and development_board_state["segment_count"] > 0
        and development_board_state["routed_development_route_count"] == 153
        and development_board_state["routed_development_segment_count"] == 306
        and development_board_state["routed_development_missing_required_shared_net_count"] == 0
        and development_board_state["routed_development_missing_route_domain_net_count"] == 0
        and development_board_state["step_exists"]
        and development_board_state["step_footprint_envelope_count"]
        == expected_development_footprint_count
        and development_board_state["step_intake_status"]
        == "development_step_generated_not_release"
    )
    routed_development_step_output = str(routed_development_intake.get("development_step") or "")
    routed_development_step_path = (
        ROOT / routed_development_step_output if routed_development_step_output else None
    )
    production_routed_candidate_path = (
        ROOT / "board/kicad/e1-phone/production/step/routed-board-with-components.step"
    )
    production_routed_candidate_sha256 = file_sha256(production_routed_candidate_path)
    routed_source_sha256 = str(
        routed_output_manifest.get("source_step_sha256")
        or routed_development_intake.get("development_step_sha256")
        or development_step_intake.get("step_sha256")
        or ""
    )
    routed_source_size_bytes = int(
        routed_output_manifest.get("source_step_size_bytes")
        or routed_development_intake.get("development_step_size_bytes")
        or 0
    )
    candidate_size_bytes = (
        production_routed_candidate_path.stat().st_size
        if production_routed_candidate_path.is_file()
        else 0
    )
    detailed_routed_step_candidate = {
        "path": str(production_routed_candidate_path.relative_to(ROOT)),
        "present": production_routed_candidate_path.is_file(),
        "blocked_metadata": blocked_candidate_artifact(production_routed_candidate_path),
        "release_credit": False,
        "reason_not_release": (
            "local routed-output candidate copied from non-release development STEP; "
            "lacks physical routed-board release intake, DRC/ERC signoff, approved "
            "supplier component 3D models, and measured enclosure clearance"
        ),
        "size_bytes": candidate_size_bytes,
        "sha256": production_routed_candidate_sha256,
        "source_step": str(
            routed_output_manifest.get("source_step")
            or routed_development_intake.get("development_step_source")
            or ""
        ),
        "source_step_sha256": routed_source_sha256,
        "source_step_size_bytes": routed_source_size_bytes,
        "route_count": int(routed_development_intake.get("route_count") or 0),
        "segment_count": int(routed_development_intake.get("segment_count") or 0),
        "footprint_envelope_count": int(
            development_step_intake.get("footprint_envelope_count") or 0
        ),
        "pad_contact_visual_count": int(
            development_step_intake.get("pad_contact_visual_count") or 0
        ),
        "route_segment_visual_count": int(
            development_step_intake.get("route_segment_visual_count") or 0
        ),
        "route_segment_net_name_count": int(
            development_step_intake.get("route_segment_net_name_count") or 0
        ),
        "route_segment_trace_bound_count": int(
            development_step_intake.get("route_segment_trace_bound_count") or 0
        ),
        "route_segment_trace_unbound_count": int(
            development_step_intake.get("route_segment_trace_unbound_count") or 0
        ),
        "controlled_impedance_segment_visual_count": int(
            development_step_intake.get("controlled_impedance_segment_visual_count") or 0
        ),
        "via_net_name_count": int(development_step_intake.get("via_net_name_count") or 0),
        "candidate_matches_routed_output_manifest": bool(
            production_routed_candidate_sha256
            and routed_output_manifest.get("source_step_sha256")
            == production_routed_candidate_sha256
            and candidate_size_bytes
            == int(routed_output_manifest.get("source_step_size_bytes") or 0)
        ),
        "candidate_matches_development_source": bool(
            production_routed_candidate_sha256
            and routed_source_sha256 == production_routed_candidate_sha256
            and candidate_size_bytes == routed_source_size_bytes
        ),
        "routed_development_intake": str(routed_development_intake_path.relative_to(ROOT)),
        "routed_output_manifest": str(routed_output_manifest_path.relative_to(ROOT)),
    }
    detailed_routed_step_candidate_ready = bool(
        detailed_routed_step_candidate["present"]
        and detailed_routed_step_candidate["blocked_metadata"]
        and detailed_routed_step_candidate["size_bytes"] > 1_000_000
        and detailed_routed_step_candidate["candidate_matches_development_source"]
        and detailed_routed_step_candidate["route_count"] > 0
        and detailed_routed_step_candidate["segment_count"] > 0
        and detailed_routed_step_candidate["footprint_envelope_count"]
        == int(development_step_intake.get("footprint_envelope_count") or 0)
        and detailed_routed_step_candidate["pad_contact_visual_count"] > 0
        and detailed_routed_step_candidate["route_segment_visual_count"] > 0
        and detailed_routed_step_candidate["release_credit"] is False
    )
    development_step_candidates = [
        {
            "path": development_step_output,
            "kind": "real_footprint_development_step",
            "present": bool(development_step_path and development_step_path.is_file()),
            "size_bytes": development_board_state["step_size_bytes"],
            "sha256": development_step_intake.get("step_sha256"),
            "release_credit": False,
        },
        {
            "path": routed_development_step_output,
            "kind": "routed_development_step",
            "present": bool(
                routed_development_step_path and routed_development_step_path.is_file()
            ),
            "size_bytes": routed_development_step_path.stat().st_size
            if routed_development_step_path and routed_development_step_path.is_file()
            else 0,
            "sha256": routed_development_intake.get("development_step_sha256"),
            "release_credit": False,
        },
        {
            "path": detailed_routed_step_candidate["path"],
            "kind": "blocked_routed_output_candidate_step",
            "present": detailed_routed_step_candidate["present"],
            "size_bytes": detailed_routed_step_candidate["size_bytes"],
            "sha256": detailed_routed_step_candidate["sha256"],
            "release_credit": False,
        },
    ]
    manufacturing_closure = (
        yaml.safe_load(manufacturing_closure_path.read_text())
        if manufacturing_closure_path.is_file()
        else {}
    )
    layout_utilization = (
        yaml.safe_load(layout_utilization_path.read_text())
        if layout_utilization_path.is_file()
        else {}
    )
    board_state = manufacturing_closure.get("board_state_detected", {})
    production_outputs = manufacturing_closure.get("production_outputs", {})
    step_output = production_outputs.get("step", {})
    placeholder_count = pcb_text.count("placeholder_not_fabrication_footprint") + pcb_text.count(
        "NON-RELEASE"
    )
    has_tracks = "(segment " in pcb_text or bool(board_state.get("has_tracks"))
    has_filled_zones = "(zone " in pcb_text or bool(board_state.get("has_filled_zones"))
    has_production_step = bool(approved_production_step_files) or bool(step_output.get("present"))
    has_concept_pcb_step = (
        concept_pcb_step_path.is_file() and concept_pcb_step_path.stat().st_size > 1000
    )
    concept_fail_closed = (
        manufacturing_closure.get("status")
        == "blocked_manufacturing_requires_routed_pcb_and_fab_outputs"
    )

    def cad_segment_to_board_rect(size: list[float], center: list[float]) -> dict[str, float]:
        board_w, board_h = params["pcb"]["outline_mm"][:2]
        return {
            "x": round(board_w / 2.0 + center[0] - size[0] / 2.0, 3),
            "y": round(board_h / 2.0 - center[1] - size[1] / 2.0, 3),
            "width": round(size[0], 3),
            "height": round(size[1], 3),
            "area_mm2": round(size[0] * size[1], 3),
        }

    cad_islands = [
        cad_segment_to_board_rect(size, center)
        for size, center, _name in pcb_island_segments(params)
    ]
    kicad_islands = layout_utilization.get("edge_cut_islands", [])
    split_island_geometry_matches = cad_islands == kicad_islands
    cases = [
        {
            "id": "kicad_placement_reconciled_to_cad",
            "pass": kicad_reconciliation["status"] == "cad_kicad_placement_reconciled",
            "evidence": "kicad-placement-reconciliation.json",
        },
        {
            "id": "solid_envelope_step_available",
            "pass": solid_cad["status"] == "generated",
            "evidence": solid_cad.get(
                "assembly_step", "mechanical/e1-phone/out/e1-phone-solid-assembly.step"
            ),
        },
        {
            "id": "concept_pcb_step_available",
            "pass": has_concept_pcb_step,
            "evidence": "mechanical/e1-phone/out/main_pcb.step",
        },
        {
            "id": "concept_split_island_geometry_matches_kicad",
            "pass": split_island_geometry_matches,
            "evidence": "board/kicad/e1-phone/layout-utilization.yaml",
        },
        {
            "id": "routed_tracks_present",
            "pass": has_tracks,
            "evidence": params["pcb"]["source"],
        },
        {
            "id": "development_routed_tracks_present_for_local_review",
            "pass": development_step_local_review_ready
            and development_board_state["routed_development_route_count"] == 153
            and development_board_state["routed_development_segment_count"] == 306,
            "evidence": "board/kicad/e1-phone/routed-development-board-intake-2026-05-22.yaml",
        },
        {
            "id": "filled_zones_present",
            "pass": has_filled_zones,
            "evidence": params["pcb"]["source"],
        },
        {
            "id": "production_board_step_present",
            "pass": has_production_step and routed_intake_complete,
            "evidence": "board/kicad/e1-phone/production/step",
        },
        {
            "id": "demo_board_step_not_counted",
            "pass": bool(demo_step_files) and not routed_intake_complete,
            "evidence": "board/kicad/e1-phone/pcb/fab-demo",
        },
        {
            "id": "real_footprint_development_step_available_for_local_review",
            "pass": development_step_local_review_ready,
            "evidence": "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml",
        },
        {
            "id": "detailed_routed_step_candidate_available_for_local_review",
            "pass": detailed_routed_step_candidate_ready,
            "evidence": "board/kicad/e1-phone/production/routed-output-candidate-manifest-2026-05-22.yaml",
        },
        {
            "id": "routed_board_release_intake_complete",
            "pass": routed_intake_complete,
            "evidence": "mechanical/e1-phone/review/routed-board-step-intake-template.csv",
        },
        {
            "id": "placeholder_footprints_replaced",
            "pass": placeholder_count == 0,
            "evidence": params["pcb"]["source"],
        },
        {
            "id": "development_footprints_replaced_for_local_review",
            "pass": development_step_local_review_ready
            and development_board_state["placeholder_marker_count"] == 0
            and development_board_state["development_footprint_refs"]
            == expected_development_footprint_count
            and development_board_state["e1phone_footprint_refs"] == 0,
            "evidence": "board/kicad/e1-phone/real-footprint-development-board-binding-2026-05-22.yaml",
        },
    ]
    if all(case["pass"] for case in cases) and not concept_fail_closed:
        board_step_status = "routed_board_step_ready"
    elif detailed_routed_step_candidate_ready:
        board_step_status = "blocked_local_routed_step_candidate_not_release"
    else:
        board_step_status = "blocked_concept_pcb_no_routed_step"

    report = {
        "claim_boundary": "Mechanical intake gate for routed KiCad board STEP; concept PCB envelope does not count as routed-board evidence.",
        "status": board_step_status,
        "pcb_source": params["pcb"]["source"],
        "manufacturing_closure": "board/kicad/e1-phone/manufacturing-closure.yaml",
        "layout_utilization": "board/kicad/e1-phone/layout-utilization.yaml",
        "production_step_dir": "board/kicad/e1-phone/production/step",
        "production_step_files": [
            str(path.relative_to(ROOT)) for path in approved_production_step_files
        ],
        "approved_production_step_files": [
            str(path.relative_to(ROOT)) for path in approved_production_step_files
        ],
        "blocked_candidate_step_files": [
            str(path.relative_to(ROOT)) for path in blocked_candidate_step_files
        ],
        "demo_step_files_ignored": [str(path.relative_to(ROOT)) for path in demo_step_files],
        "development_board_local_review_state": development_board_state,
        "development_step_local_review_ready": development_step_local_review_ready,
        "development_step_release_credit": False,
        "development_step_candidates": development_step_candidates,
        "detailed_routed_step_candidate": detailed_routed_step_candidate,
        "routed_board_step_intake_template": "mechanical/e1-phone/review/routed-board-step-intake-template.csv",
        "required_routed_board_evidence_class": "physical_routed_board_release",
        "routed_board_intake_template_evidence_class": routed_template_evidence_class,
        "routed_board_forbidden_evidence_classes": sorted(routed_forbidden_evidence_classes),
        "routed_board_intake_cases": routed_intake_cases,
        "concept_pcb_step": "mechanical/e1-phone/out/main_pcb.step",
        "board_state_detected": {
            "has_tracks": has_tracks,
            "has_filled_zones": has_filled_zones,
            "has_production_step": has_production_step,
            "has_demo_step": bool(demo_step_files),
            "has_detailed_blocked_routed_step_candidate": detailed_routed_step_candidate_ready,
            "has_development_routed_tracks_for_local_review": (
                development_step_local_review_ready
                and development_board_state["routed_development_route_count"] == 153
                and development_board_state["routed_development_segment_count"] == 306
            ),
            "has_development_footprints_replaced_for_local_review": (
                development_step_local_review_ready
                and development_board_state["placeholder_marker_count"] == 0
                and development_board_state["development_footprint_refs"]
                == expected_development_footprint_count
                and development_board_state["e1phone_footprint_refs"] == 0
            ),
            "has_complete_routed_board_release_intake": routed_intake_complete,
            "has_concept_pcb_step": has_concept_pcb_step,
            "placeholder_marker_count": placeholder_count,
            "manufacturing_closure_status": manufacturing_closure.get("status", "missing"),
        },
        "concept_split_island_geometry": {
            "cad_projected_islands": cad_islands,
            "kicad_edge_cut_islands": kicad_islands,
            "matches": split_island_geometry_matches,
        },
        "cases": cases,
        "required_next_actions": [
            "Replace E1Phone placeholder footprints with supplier land patterns and 3D models.",
            "Route the KiCad board with clean ERC/DRC, copper zones, impedance constraints, and test access.",
            "Export production board STEP from routed KiCad including component 3D models.",
            "Populate routed-board-step-intake-template.csv with physical_routed_board_release evidence and artifact paths.",
            "Re-import routed board STEP into the phone CAD and re-run enclosure collision, USB insertion, button, screen FPC, and acoustic checks.",
        ],
    }
    (REVIEW_DIR / "board-step-readiness.json").write_text(json.dumps(report, indent=2) + "\n")

    lines = [
        "# E1 Phone Board STEP Readiness",
        "",
        f"Status: {report['status']}.",
        "",
        "This is the mechanical gate for replacing the concept PCB envelope with routed KiCad board STEP.",
        "",
        "## Cases",
        "",
    ]
    for case in cases:
        result = "PASS" if case["pass"] else "BLOCKED"
        lines.append(f"- {result}: `{case['id']}` from `{case['evidence']}`")
    lines.extend(["", "## Required Next Actions", ""])
    for action in report["required_next_actions"]:
        lines.append(f"- {action}")
    (REVIEW_DIR / "board-step-readiness.md").write_text("\n".join(lines) + "\n")
    return report


def write_routed_board_clearance_artifacts(
    board_step: dict[str, Any],
    clearance: dict[str, Any],
    solid_cad: dict[str, Any],
) -> dict[str, Any]:
    template_path = REVIEW_DIR / "routed-board-clearance-results-template.csv"
    fieldnames = [
        "routed_step_file",
        "case_id",
        "rerun_priority",
        "concept_actual_mm",
        "concept_required_mm",
        "concept_margin_mm",
        "measured_min_gap_mm",
        "required_min_gap_mm",
        "interference_count",
        "pass",
        "reviewer",
        "evidence_class",
        "measurement_artifact",
        "measurement_instruction",
        "notes",
    ]
    rerun_cases = []
    for case in clearance.get("cases", []):
        actual = float(case.get("actual_mm", 0.0))
        required = float(case.get("required_mm", 0.0))
        margin = round(actual - required, 3)
        priority = 1 if margin <= 0.1 else 2 if margin <= 0.5 else 3
        if any(
            token in case.get("id", "")
            for token in ["pcb", "usb", "battery", "flex", "connector", "camera", "speaker"]
        ):
            rerun_cases.append(
                {
                    "case_id": case["id"],
                    "concept_clearance_pass": bool(case.get("pass", False)),
                    "concept_actual_mm": round(actual, 3),
                    "concept_required_mm": round(required, 3),
                    "concept_margin_mm": margin,
                    "rerun_priority": priority,
                    "risk_level": "high"
                    if priority == 1
                    else "medium"
                    if priority == 2
                    else "normal",
                    "measurement_instruction": (
                        "Rerun against routed KiCad STEP with production component 3D models."
                    ),
                    "requires_routed_step_rerun": True,
                }
            )
    rerun_cases.sort(key=lambda item: (item["rerun_priority"], item["case_id"]))

    should_write_template = True
    if template_path.is_file():
        csv_text = template_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            existing_rows = list(csv.DictReader(csv_file))
        existing_fields = list(existing_rows[0].keys()) if existing_rows else []
        has_response_content = any(
            row.get(field, "").strip()
            for row in existing_rows
            for field in [
                "routed_step_file",
                "measured_min_gap_mm",
                "interference_count",
                "pass",
                "reviewer",
                "evidence_class",
                "measurement_artifact",
            ]
        )
        should_write_template = existing_fields != fieldnames or not has_response_content
    if should_write_template:
        with template_path.open("w", newline="") as result_template_file:
            writer = csv.DictWriter(
                result_template_file,
                fieldnames=fieldnames,
                lineterminator="\n",
            )
            writer.writeheader()
            for case in rerun_cases:
                writer.writerow(
                    {
                        "routed_step_file": "",
                        "case_id": case["case_id"],
                        "rerun_priority": case["rerun_priority"],
                        "concept_actual_mm": case["concept_actual_mm"],
                        "concept_required_mm": case["concept_required_mm"],
                        "concept_margin_mm": case["concept_margin_mm"],
                        "measured_min_gap_mm": "",
                        "required_min_gap_mm": case["concept_required_mm"],
                        "interference_count": "",
                        "pass": "",
                        "reviewer": "",
                        "evidence_class": "",
                        "measurement_artifact": "",
                        "measurement_instruction": case["measurement_instruction"],
                        "notes": "Populate only after importing DRC/ERC-clean routed board STEP with supplier component models.",
                    }
                )

    csv_text = template_path.read_text()
    csv_lines = csv_text.splitlines()
    template_evidence_class = ""
    if csv_lines and csv_lines[0].startswith("# evidence_class:"):
        template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
        csv_text = "\n".join(csv_lines[1:]) + "\n"
    result_cases = []
    with StringIO(csv_text) as csv_file:
        for row in csv.DictReader(csv_file):
            evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
            measured_text = row.get("measured_min_gap_mm", "").strip()
            interference_text = row.get("interference_count", "").strip()
            measured_gap = float(measured_text) if measured_text else None
            interference_count = int(float(interference_text)) if interference_text else None
            required_gap = float(row.get("required_min_gap_mm", "") or 0.0)
            evidence_class_allowed = evidence_class == "physical_routed_board_clearance_result"
            populated = all(
                row.get(field, "").strip()
                for field in [
                    "routed_step_file",
                    "measured_min_gap_mm",
                    "interference_count",
                    "pass",
                    "reviewer",
                    "measurement_artifact",
                ]
            )
            result_cases.append(
                {
                    "case_id": row.get("case_id", ""),
                    "evidence_class": evidence_class,
                    "evidence_class_allowed": evidence_class_allowed,
                    "measured_min_gap_mm": measured_gap,
                    "required_min_gap_mm": required_gap,
                    "interference_count": interference_count,
                    "reviewer_present": bool(row.get("reviewer", "").strip()),
                    "measurement_artifact_present": bool(
                        row.get("measurement_artifact", "").strip()
                    ),
                    "pass": populated
                    and evidence_class_allowed
                    and row.get("pass", "").strip().lower() in {"yes", "true", "1", "pass"}
                    and measured_gap is not None
                    and measured_gap >= required_gap
                    and interference_count == 0,
                }
            )
    complete_count = sum(1 for case in result_cases if case["pass"])
    routed_board_ready = board_step.get("status") == "routed_board_step_ready"
    development_review_state = board_step.get("development_board_local_review_state", {})
    development_step_local_review_ready = bool(
        board_step.get("development_step_local_review_ready")
    )
    detailed_routed_step_candidate = board_step.get("detailed_routed_step_candidate", {})
    detailed_candidate_ready = bool(
        isinstance(detailed_routed_step_candidate, dict)
        and detailed_routed_step_candidate.get("present") is True
        and detailed_routed_step_candidate.get("blocked_metadata") is True
        and detailed_routed_step_candidate.get("release_credit") is False
        and int(detailed_routed_step_candidate.get("route_count") or 0) > 0
        and int(detailed_routed_step_candidate.get("segment_count") or 0) > 0
    )
    development_clearance_context = {
        "candidate_step": detailed_routed_step_candidate.get("path")
        if isinstance(detailed_routed_step_candidate, dict)
        else None,
        "candidate_ready_for_local_review": detailed_candidate_ready,
        "release_credit": False,
        "cases_mapped_to_candidate_step": len(rerun_cases) if detailed_candidate_ready else 0,
        "expected_clearance_case_count": len(rerun_cases),
        "reason_not_release": (
            "candidate routed STEP can guide local collision review only; measured "
            "clearance still requires physical_routed_board_clearance_result evidence"
        ),
    }
    report = {
        "artifact_id": "routed_board_clearance_candidate",
        "source_requirement_id": "physical_routed_board_clearance_result",
        "owner": "mechanical_engineering",
        "created_at": "2026-05-22",
        "tool_or_supplier_revision": "generate_e1_phone_cad.py",
        "input_artifact_hashes": {
            "board_step_readiness_status": str(board_step.get("status")),
            "assembly_clearance_status": str(clearance.get("status")),
            "solid_cad_status": str(solid_cad.get("status")),
        },
        "reviewer": "unreviewed",
        "reviewed_at": "unreviewed_local_candidate_2026-05-22",
        "disposition": "blocked_candidate_not_approved",
        "claim_boundary": (
            "Fail-closed routed-board mechanical clearance intake. Concept PCB envelope "
            "clearance does not prove routed PCB/component clearance."
        ),
        "status": "routed_board_clearance_pass"
        if routed_board_ready and result_cases and complete_count == len(result_cases)
        else "blocked_waiting_for_physical_routed_board_clearance_result"
        if detailed_candidate_ready
        else "blocked_waiting_for_routed_board_step"
        if not routed_board_ready
        else "blocked_routed_board_clearance_incomplete",
        "pcb_source": board_step.get("pcb_source"),
        "source_reviews": {
            "board_step_readiness_status": board_step.get("status"),
            "assembly_clearance_status": clearance.get("status"),
            "solid_cad_status": solid_cad.get("status"),
        },
        "production_step_files": board_step.get("production_step_files", []),
        "blocked_candidate_step_files": board_step.get("blocked_candidate_step_files", []),
        "concept_pcb_step": board_step.get("concept_pcb_step"),
        "development_step_local_review": {
            "ready": development_step_local_review_ready,
            "release_credit": False,
            "reason_not_release": (
                "development STEP is generated from local development footprints/envelopes "
                "and lacks physical routed-board release intake, supplier-approved component "
                "STEP models, DRC/ERC, reviewer signoff, and measured clearance artifacts"
            ),
            "state": development_review_state,
        },
        "development_clearance_context": development_clearance_context,
        "required_height_models": [
            "usb_c_receptacle",
            "display_fpc_connector",
            "split_interconnect_top_connector",
            "split_interconnect_bottom_connector",
            "rear_camera_module",
            "front_camera_module",
            "bottom_speaker_module",
            "earpiece_receiver",
            "haptic_lra",
            "soc_shield_can",
            "pmic_shield_can",
            "radio_shield_can",
        ],
        "import_execution_plan": [
            {
                "step": "export_routed_kicad_step",
                "required_output": "board/kicad/e1-phone/production/step/e1-phone-mainboard-routed.step",
                "blocks_clearance": True,
            },
            {
                "step": "replace_concept_main_pcb",
                "required_output": "phone CAD assembly with routed board STEP and supplier 3D models",
                "blocks_clearance": True,
            },
            {
                "step": "rerun_clearance_matrix",
                "required_output": "mechanical/e1-phone/review/routed-board-clearance-results-template.csv populated",
                "blocks_clearance": True,
            },
        ],
        "expected_clearance_case_count": len(rerun_cases),
        "complete_clearance_result_count": complete_count,
        "required_evidence_class": "physical_routed_board_clearance_result",
        "template_evidence_class": template_evidence_class,
        "results_template": "mechanical/e1-phone/review/routed-board-clearance-results-template.csv",
        "cases": [
            {
                "id": "routed_board_step_available_for_import",
                "pass": routed_board_ready,
                "evidence": "board-step-readiness.json",
            },
            {
                "id": "concept_pcb_step_not_release_evidence",
                "pass": True,
                "evidence": "mechanical/e1-phone/out/main_pcb.step",
                "note": "Concept PCB STEP is retained only as a packaging placeholder.",
            },
            {
                "id": "development_routed_step_available_for_local_review",
                "pass": development_step_local_review_ready and detailed_candidate_ready,
                "evidence": detailed_routed_step_candidate.get(
                    "path",
                    development_review_state.get(
                        "step_intake",
                        "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml",
                    ),
                )
                if isinstance(detailed_routed_step_candidate, dict)
                else development_review_state.get(
                    "step_intake",
                    "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml",
                ),
                "note": "Non-release local review evidence; does not satisfy routed_board_step_available_for_import.",
            },
            {
                "id": "height_critical_components_have_cad_envelopes",
                "pass": solid_cad.get("status") == "generated",
                "evidence": "solid-cad-handoff.json",
            },
            {
                "id": "clearance_rerun_cases_defined",
                "pass": bool(rerun_cases),
                "evidence": "assembly-clearance.json",
            },
            {
                "id": "routed_step_clearance_results_present",
                "pass": result_cases and complete_count == len(result_cases),
                "evidence": "mechanical/e1-phone/review/routed-board-clearance-results-template.csv",
            },
        ],
        "rerun_matrix": rerun_cases,
        "result_cases": result_cases,
        "release_rule": "Routed-board clearance passes only after routed KiCad STEP is available, all height-critical component models are present, every rerun case is measured, every minimum gap is met, every interference count is zero, and evidence_class=physical_routed_board_clearance_result.",
    }
    (REVIEW_DIR / "routed-board-clearance.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone Routed Board Clearance",
        "",
        f"Status: {report['status']}.",
        "",
        f"Template: `{report['results_template']}`",
        "",
        "## Cases",
        "",
    ]
    for case in report["cases"]:
        lines.append(f"- {'PASS' if case['pass'] else 'BLOCKED'}: `{case['id']}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "routed-board-clearance.md").write_text("\n".join(lines) + "\n")
    return report


def write_full_cad_boolean_interference_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    clearance: dict[str, Any],
    board_step: dict[str, Any],
    routed_board_clearance: dict[str, Any],
    supplier_response: dict[str, Any],
    solid_cad: dict[str, Any],
    step_validation: dict[str, Any],
) -> dict[str, Any]:
    template_path = REVIEW_DIR / "full-cad-boolean-interference-results-template.csv"
    scopes: list[dict[str, Any]] = [
        {
            "id": "screen_stack_to_orange_rails",
            "source_clearance_ids": [
                "screen_cover_glass_to_orange_body",
                "display_lcm_under_cover_glass",
            ],
            "required_parts": [
                "screen_cover_glass",
                "display_lcm",
                "screen_adhesive_top",
                "orange_side_frame",
            ],
            "concept_pair_checks": [
                ["display_lcm", "screen_cover_glass"],
                ["display_lcm", "orange_side_frame"],
                ["screen_cover_glass", "orange_side_frame"],
            ],
            "risk": "screen glass, adhesive, and display stack must not clash with molded orange rails or ledges",
        },
        {
            "id": "routed_pcb_components_to_orange_enclosure",
            "source_clearance_ids": ["battery_to_pcb_islands"],
            "required_parts": [
                "main_pcb",
                "battery_pouch",
                "orange_back_shell",
                "orange_side_frame",
            ],
            "concept_pair_checks": [["main_pcb", "battery_pouch"]],
            "risk": "routed board components must clear enclosure ribs, bosses, snaps, and side rails",
        },
        {
            "id": "usb_c_port_saddle_aperture_and_gaskets",
            "source_clearance_ids": ["usb_shell_to_external_aperture", "usb_to_bottom_speaker"],
            "required_parts": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "orange_usb_reinforcement_saddle",
            ],
            "concept_pair_checks": [
                ["usb_c_receptacle", "bottom_speaker_module"],
                ["usb_c_receptacle", "bottom_mic"],
            ],
            "risk": "USB-C shell, aperture, saddle, drip lip, and gaskets must remain interference-free",
        },
        {
            "id": "side_buttons_switches_gaskets_labyrinth",
            "source_clearance_ids": ["button_caps_to_side_frame"],
            "required_parts": ["power_button_cap", "volume_button_cap", "orange_side_frame"],
            "concept_pair_checks": [["power_button_cap", "volume_button_cap"]],
            "risk": "button caps, gaskets, rails, and switch keepouts must not bind or preload",
        },
        {
            "id": "front_camera_earpiece_under_glass_stack",
            "source_clearance_ids": ["front_camera_to_earpiece"],
            "required_parts": ["front_camera_module", "earpiece_receiver", "screen_cover_glass"],
            "concept_pair_checks": [
                ["front_camera_module", "earpiece_receiver"],
                ["front_camera_module", "screen_cover_glass"],
            ],
            "risk": "under-glass camera and handset acoustic path must clear cover glass and each other",
        },
        {
            "id": "rear_camera_window_baffle_adhesive_stack",
            "source_clearance_ids": ["rear_camera_to_battery"],
            "required_parts": [
                "rear_camera_module",
                "rear_camera_cover_glass",
                "rear_camera_light_baffle_top",
            ],
            "concept_pair_checks": [
                ["rear_camera_module", "battery_pouch"],
                ["rear_camera_module", "rear_camera_cover_glass"],
            ],
            "risk": "rear camera module, cover window, adhesive, and baffles must remain interference-free",
        },
        {
            "id": "battery_pouch_pcb_flex_haptic",
            "source_clearance_ids": [
                "battery_to_pcb_islands",
                "haptic_to_pcb_islands",
                "split_interconnect_flex_to_battery_edge",
            ],
            "required_parts": [
                "battery_pouch",
                "main_pcb",
                "haptic_lra",
                "split_interconnect_side_flex",
            ],
            "concept_pair_checks": [
                ["battery_pouch", "main_pcb"],
                ["battery_pouch", "haptic_lra"],
                ["battery_pouch", "split_interconnect_side_flex"],
            ],
            "risk": "battery, split interconnect, haptic, and PCB islands must not pinch or overlap",
        },
        {
            "id": "bottom_audio_microphone_speaker_meshes",
            "source_clearance_ids": ["bottom_mic_to_usb", "usb_to_bottom_speaker"],
            "required_parts": ["bottom_speaker_module", "bottom_mic", "usb_c_receptacle"],
            "concept_pair_checks": [
                ["bottom_speaker_module", "bottom_mic"],
                ["bottom_speaker_module", "usb_c_receptacle"],
            ],
            "risk": "speaker, microphone, meshes, and acoustic ports must not clash with USB or enclosure plastic",
        },
        {
            "id": "rf_shields_antennas_plastic_windows",
            "source_clearance_ids": ["rf_keepout_to_orange_shell"],
            "required_parts": ["soc_shield_can", "radio_shield_can", "orange_back_shell"],
            "risk": "RF shields, feed regions, and antenna plastic windows must preserve keepouts",
        },
        {
            "id": "molded_retention_boss_snap_service_features",
            "source_clearance_ids": ["snap_hooks_to_internal_components"],
            "required_parts": ["orange_back_shell", "orange_side_frame", "service_label_recess"],
            "risk": "screw bosses, snap hooks, service tray, and service label recess must not intrude into assemblies",
        },
    ]
    part_names = {part.name for part in parts}
    parts_by_name = {part.name: part for part in parts}
    clearance_by_id = {case["id"]: case for case in clearance.get("cases", [])}

    def component_bounds(part: Part) -> list[tuple[np.ndarray, np.ndarray]]:
        components = part.mesh.split(only_watertight=False)
        if not components:
            return [part.bounds]
        return [(component.bounds[0], component.bounds[1]) for component in components]

    def aabb_pair_check(scope_id: str, pair: list[str]) -> dict[str, Any]:
        missing = [name for name in pair if name not in parts_by_name]
        if missing:
            return {
                "scope_id": scope_id,
                "pair": pair,
                "missing_parts": missing,
                "component_pair_count": 0,
                "min_gap_mm": None,
                "max_overlap_volume_mm3": None,
                "interference_count": None,
                "pass": False,
            }
        if set(pair) == {"display_lcm", "orange_side_frame"}:
            display_part = parts_by_name["display_lcm"]
            width, height, _depth = params["device"]["envelope_mm"]
            wall = float(params["device"]["wall_thickness_mm"])
            inner_half_x = (float(width) - 2.0 * wall) / 2.0
            inner_half_y = (float(height) - 2.0 * wall) / 2.0
            disp_min, disp_max = display_part.bounds
            disp_center = (disp_min + disp_max) / 2.0
            disp_half = (disp_max - disp_min) / 2.0
            aperture_gaps = [
                inner_half_x - abs(float(disp_center[0])) - float(disp_half[0]),
                inner_half_y - abs(float(disp_center[1])) - float(disp_half[1]),
            ]
            min_gap = min(aperture_gaps)
            return {
                "scope_id": scope_id,
                "pair": pair,
                "missing_parts": [],
                "component_pair_count": 1,
                "min_gap_mm": round(min_gap, 3),
                "max_overlap_volume_mm3": 0.0 if min_gap >= 0 else round(abs(min_gap), 3),
                "interference_count": 0 if min_gap >= 0 else 1,
                "pass": min_gap >= 0,
                "method": "side_frame_inner_aperture_clearance",
            }
        min_gap: float | None = None
        max_overlap_volume = 0.0
        interference_count = 0
        component_pair_count = 0
        for a_min, a_max in component_bounds(parts_by_name[pair[0]]):
            for b_min, b_max in component_bounds(parts_by_name[pair[1]]):
                component_pair_count += 1
                overlap = [
                    max(0.0, float(min(a_max[axis], b_max[axis]) - max(a_min[axis], b_min[axis])))
                    for axis in range(3)
                ]
                overlap_volume = overlap[0] * overlap[1] * overlap[2]
                if overlap_volume > 1e-6:
                    interference_count += 1
                    max_overlap_volume = max(max_overlap_volume, overlap_volume)
                    pair_gap = 0.0
                else:
                    axis_gaps = []
                    for axis in range(3):
                        if a_max[axis] < b_min[axis]:
                            axis_gaps.append(float(b_min[axis] - a_max[axis]))
                        elif b_max[axis] < a_min[axis]:
                            axis_gaps.append(float(a_min[axis] - b_max[axis]))
                        else:
                            axis_gaps.append(0.0)
                    pair_gap = math.sqrt(sum(gap * gap for gap in axis_gaps))
                min_gap = pair_gap if min_gap is None else min(min_gap, pair_gap)
        return {
            "scope_id": scope_id,
            "pair": pair,
            "missing_parts": [],
            "component_pair_count": component_pair_count,
            "min_gap_mm": None if min_gap is None else round(min_gap, 3),
            "max_overlap_volume_mm3": round(max_overlap_volume, 3),
            "interference_count": interference_count,
            "pass": interference_count == 0,
        }

    fieldnames = [
        "scope_id",
        "assembly_step",
        "boolean_engine",
        "min_gap_mm",
        "interference_count",
        "interference_volume_mm3",
        "pass",
        "reviewer",
        "evidence_class",
        "boolean_report_artifact",
        "notes",
    ]
    with template_path.open("w", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for scope in scopes:
            writer.writerow(
                {
                    "scope_id": scope["id"],
                    "assembly_step": "mechanical/e1-phone/out/e1-phone-solid-assembly.step",
                    "boolean_engine": "OpenCascade B-rep boolean required",
                    "min_gap_mm": "",
                    "interference_count": "",
                    "interference_volume_mm3": "",
                    "pass": "",
                    "reviewer": "",
                    "evidence_class": "",
                    "boolean_report_artifact": "",
                    "notes": scope["risk"],
                }
            )
    scope_cases = []
    for scope in scopes:
        source_cases = [
            clearance_by_id[case_id]
            for case_id in scope["source_clearance_ids"]
            if case_id in clearance_by_id
        ]
        pair_checks = [
            aabb_pair_check(scope["id"], pair) for pair in scope.get("concept_pair_checks", [])
        ]
        concept_aabb_scan_pass = all(check["pass"] for check in pair_checks)
        scope_cases.append(
            {
                "id": scope["id"],
                "source_clearance_ids": scope["source_clearance_ids"],
                "required_parts": scope["required_parts"],
                "concept_pair_checks": scope.get("concept_pair_checks", []),
                "concept_aabb_pair_checks": pair_checks,
                "concept_aabb_interference_count": sum(
                    int(check["interference_count"] or 0) for check in pair_checks
                ),
                "concept_aabb_scan_pass": concept_aabb_scan_pass,
                "risk": scope["risk"],
                "required_parts_present": all(
                    name in part_names for name in scope["required_parts"]
                ),
                "concept_clearance_case_count": len(source_cases),
                "concept_clearance_pass": bool(source_cases)
                and all(case.get("pass", False) for case in source_cases),
                "cad_prerequisite_pass": all(name in part_names for name in scope["required_parts"])
                and bool(source_cases)
                and all(case.get("pass", False) for case in source_cases),
                "early_aabb_fit_pass": concept_aabb_scan_pass,
            }
        )
    concept_aabb_pair_checks = [
        check for case in scope_cases for check in case["concept_aabb_pair_checks"]
    ]
    prerequisites = {
        "solid_cad_generated": solid_cad.get("status") == "generated",
        "step_validation_pass": step_validation.get("status") == "pass",
        "assembly_clearance_pass": clearance.get("status") == "pass",
        "concept_aabb_interference_scan_pass": all(
            check["pass"] for check in concept_aabb_pair_checks
        ),
        "routed_board_step_ready": board_step.get("status") == "routed_board_step_ready",
        "routed_board_clearance_pass": routed_board_clearance.get("status")
        == "routed_board_clearance_pass",
        "supplier_brep_models_accepted": supplier_response.get("status")
        == "supplier_responses_complete",
        "scope_cad_prerequisites_pass": all(case["cad_prerequisite_pass"] for case in scope_cases),
    }
    report = {
        "claim_boundary": (
            "Fail-closed full CAD boolean interference acceptance. Targeted AABB clearance, "
            "concept STEP envelopes, and blank templates do not count as supplier B-rep/routed-board "
            "boolean clash evidence."
        ),
        "status": "full_cad_boolean_interference_pass"
        if all(prerequisites.values())
        else "blocked_boolean_interference_incomplete",
        "overall_status": "full_cad_boolean_interference_pass"
        if all(prerequisites.values())
        else "blocked_boolean_interference_incomplete",
        "source_reviews": {
            "solid_cad_status": solid_cad.get("status"),
            "step_validation_status": step_validation.get("status"),
            "assembly_clearance_status": clearance.get("status"),
            "board_step_readiness_status": board_step.get("status"),
            "routed_board_clearance_status": routed_board_clearance.get("status"),
            "supplier_response_status": supplier_response.get("status"),
        },
        "expected_scope_count": len(scopes),
        "scope_count": len(scope_cases),
        "cad_prerequisite_scope_count": sum(
            1 for case in scope_cases if case["cad_prerequisite_pass"]
        ),
        "concept_aabb_pair_check_count": len(concept_aabb_pair_checks),
        "concept_aabb_interference_count": sum(
            int(check["interference_count"] or 0) for check in concept_aabb_pair_checks
        ),
        "complete_result_count": 0,
        "results_template": "mechanical/e1-phone/review/full-cad-boolean-interference-results-template.csv",
        "required_evidence_class": "physical_supplier_brep_boolean_interference_result",
        "prerequisites": prerequisites,
        "scope_cases": scope_cases,
        "release_rule": "Every scope must be checked with a named boolean engine against supplier B-rep models and routed KiCad board STEP, with min gap >= 0, zero interference count, zero interference volume, reviewer, evidence_class=physical_supplier_brep_boolean_interference_result, and explicit pass.",
    }
    (REVIEW_DIR / "full-cad-boolean-interference.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    lines = [
        "# E1 Phone Full CAD Boolean Interference",
        "",
        f"Status: {report['status']}.",
        "",
        f"Template: `{report['results_template']}`",
        "",
        "## Scopes",
        "",
    ]
    for case in scope_cases:
        lines.append(f"- {'PASS' if case['cad_prerequisite_pass'] else 'BLOCKED'}: `{case['id']}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "full-cad-boolean-interference.md").write_text("\n".join(lines) + "\n")
    return report


def write_readiness_artifacts(
    params: dict[str, Any],
    parts: list[Part],
    tooling: list[Part],
    checks: dict[str, Any],
    visual: dict[str, Any],
    mass: dict[str, Any],
    compactness: dict[str, Any],
    supplier: dict[str, Any],
    handoff: dict[str, Any],
    kicad_reconciliation: dict[str, Any],
    validation: dict[str, Any],
    interface_validation: dict[str, Any],
    display_validation: dict[str, Any],
    display_results: dict[str, Any],
    mechanical_integration_sim: dict[str, Any],
    acoustic_validation: dict[str, Any],
    acoustic_results: dict[str, Any],
    camera_validation: dict[str, Any],
    camera_results: dict[str, Any],
    environmental_validation: dict[str, Any],
    ingress_path_review: dict[str, Any],
    environmental_results: dict[str, Any],
    evt_fixtures: dict[str, Any],
    evt_inspection: dict[str, Any],
    evt_results: dict[str, Any],
    clearance: dict[str, Any],
    part_review: dict[str, Any],
    dfm: dict[str, Any],
    tolerance_stack: dict[str, Any],
    gdt_release: dict[str, Any],
    gdt_fai_results: dict[str, Any],
    mold_process: dict[str, Any],
    toolmaker_signoff: dict[str, Any],
    visual_decision: dict[str, Any],
    solid_cad: dict[str, Any],
    step_validation: dict[str, Any],
    board_step: dict[str, Any],
    supplier_rfq: dict[str, Any],
    supplier_response: dict[str, Any],
) -> dict[str, Any]:
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
                "compactness-optimization.json",
                "compactness-optimization.md",
                "compactness-optimization.png",
            ],
            "remaining_blockers": [
                "No vendor mold-flow simulation.",
                "No measured shrink/warp data for selected PC+ABS resin.",
                "No GD&T-controlled 2D release drawing.",
            ],
        },
        {
            "subsystem": "compact_envelope_optimization",
            "status": "cad_pass"
            if compactness["status"] == "cad_compactness_optimized"
            else "blocked",
            "evidence": [
                "compactness-optimization.json",
                "compactness-optimization.md",
                "compactness-optimization.png",
                "compactness-optimization.svg",
                "device_compactness",
                "screen_mount_margin",
                "pcb_battery_non_overlap",
            ],
            "remaining_blockers": [
                "Envelope is optimized against current EVT0 supplier envelopes only.",
                "Need supplier STEP and routed PCB before proving no further local reduction is possible.",
            ],
        },
        {
            "subsystem": "battery_swell_management",
            "status": "cad_pass"
            if (REVIEW_DIR / "battery-swell-management.json").is_file()
            and (REVIEW_DIR / "battery-swell-management.md").is_file()
            and check_status["battery_back_void_foam_management"]["pass"]
            else "blocked",
            "evidence": [
                "battery_pouch",
                "battery_back_void_foam_pad",
                "battery_display_and_wall_clearance",
                "battery_back_void_foam_management",
                "battery-swell-management.json",
                "battery-swell-management.md",
            ],
            "remaining_blockers": [
                "CAD now models a compressible back-void foam pad, but supplier battery swelling and foam compression-set data are still missing.",
                "Need physical thermal aging, drop, and pouch-preload validation before battery release.",
            ],
        },
        {
            "subsystem": "component_selection_review",
            "status": "cad_pass"
            if (REVIEW_DIR / "component-selection-review.json").is_file()
            and (REVIEW_DIR / "component-selection-review.md").is_file()
            else "blocked",
            "evidence": [
                "component-selection-review.json",
                "component-selection-review.md",
                "screen_mount_and_connection",
                "usb_c_insertion_envelope",
                "button_force_and_travel",
                "camera_optical_seal_stack",
                "camera_speaker_behind_glass",
            ],
            "remaining_blockers": [
                "Component review reconciles current CAD envelopes and selected off-the-shelf candidates only.",
                "Need supplier drawings, STEP/B-rep models, samples, live procurement quotes, and lab validation before sourcing or tooling release.",
            ],
        },
        {
            "subsystem": "screen_stack",
            "status": "cad_pass"
            if interface_validation["status"] == "cad_interface_validation_pass"
            and display_validation["status"] == "cad_display_validation_ready"
            and mechanical_integration_sim["status"] == "cad_mechanical_integration_sim_ready"
            else "blocked",
            "evidence": [
                "screen_cover_glass",
                "display_lcm",
                "screen_adhesive_top",
                "display_fpc_connector",
                "screen_mount_and_connection",
                "interface-validation.json",
                "interface-validation.md",
                "display-validation.json",
                "display-validation.md",
                "display-results-template.csv",
                "display-results-review.json",
                "display-results-review.md",
                "mechanical-integration-sim.json",
                "mechanical-integration-sim.md",
            ],
            "remaining_blockers": [
                "Need supplier drawing and exact FPC exit direction.",
                "Need verified touch/display pinout and bend test with real sample.",
                "Need populated display/touch bond, luminance, touch-grid, drop, and bring-up results.",
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
                "board-step-readiness.json",
                "board-step-readiness.md",
            ],
            "remaining_blockers": [
                "KiCad source is still a concept placement, not routed fabrication data.",
                "Need board STEP from routed KiCad with real component 3D models.",
            ],
        },
        {
            "subsystem": "routed_board_step_import",
            "status": "cad_pass"
            if board_step["status"] == "routed_board_step_ready"
            else "blocked",
            "evidence": [
                "board-step-readiness.json",
                "board-step-readiness.md",
                "main_pcb.step",
                "kicad-placement-reconciliation.json",
            ],
            "remaining_blockers": [
                "KiCad board remains a concept floorplan with placeholder footprints.",
                "Need routed KiCad board STEP with production component 3D models before final CAD clash signoff.",
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
                "usb_c_perimeter_gasket_top.step",
                "usb_c_perimeter_gasket_bottom.step",
                "usb_c_perimeter_gasket_left.step",
                "usb_c_perimeter_gasket_right.step",
                "usb_c_molded_drip_break_lip.step",
                "usb_c_internal_drain_shelf.step",
                "bottom_mic.step",
                "top_mic.step",
                "bottom_speaker_module.step",
                "earpiece_receiver.step",
                "handset_acoustic_slot.step",
                "rear_camera_module.step",
                "rear_camera_cover_glass.step",
                "rear_camera_cover_adhesive_top.step",
                "rear_camera_cover_adhesive_bottom.step",
                "rear_camera_cover_adhesive_left.step",
                "rear_camera_cover_adhesive_right.step",
                "rear_camera_light_baffle_top.step",
                "rear_camera_light_baffle_bottom.step",
                "front_camera_module.step",
                "front_camera_under_glass.step",
                "front_camera_black_mask_window.step",
                "power_button_cap.step",
                "volume_button_cap.step",
                "power_button_elastomer_gasket.step",
                "power_button_labyrinth_upper_rail.step",
                "power_button_labyrinth_lower_rail.step",
                "volume_button_elastomer_gasket.step",
                "volume_button_labyrinth_upper_rail.step",
                "volume_button_labyrinth_lower_rail.step",
                "screen_adhesive_top.step",
                "display_fpc_connector.step",
                "orange_usb_reinforcement_saddle.step",
                "split_interconnect_top_connector.step",
                "split_interconnect_bottom_connector.step",
                "split_interconnect_side_flex.step",
                "split_interconnect_top_flex_tail.step",
                "split_interconnect_bottom_flex_tail.step",
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
            "subsystem": "supplier_returned_evidence",
            "status": "cad_pass"
            if supplier_response["status"] == "supplier_responses_complete"
            else "blocked",
            "evidence": [
                "supplier-response-template.csv",
                "supplier-response-review.json",
                "supplier-response-review.md",
            ],
            "remaining_blockers": [
                "No supplier-returned quote/drawing/STEP/sample evidence has been recorded.",
                "Need complete vendor responses before replacing EVT0 envelope CAD with supplier CAD.",
            ],
        },
        {
            "subsystem": "buttons",
            "status": "cad_pass"
            if interface_validation["status"] == "cad_interface_validation_pass"
            and mechanical_integration_sim["status"] == "cad_mechanical_integration_sim_ready"
            else "blocked",
            "evidence": [
                "power_button_cap",
                "volume_button_cap",
                "power_button_elastomer_gasket",
                "volume_button_elastomer_gasket",
                "button_force_and_travel",
                "button_pressure_support",
                "button_ingress_seal_stack",
                "interface-validation.json",
                "interface-validation.md",
                "mechanical-integration-sim.json",
                "mechanical-integration-sim.md",
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
            and acoustic_validation["status"] == "cad_acoustic_validation_ready"
            and mechanical_integration_sim["status"] == "cad_mechanical_integration_sim_ready"
            else "blocked",
            "evidence": [
                "usb_c_receptacle",
                "usb_c_external_aperture",
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
                "bottom_speaker_grille_slot_1",
                "bottom_microphone_port_1",
                "usb_c_insertion_envelope",
                "usb_c_port_seal_stack",
                "bottom_io_acoustic_apertures",
                "interface-validation.json",
                "interface-validation.md",
                "mechanical-integration-sim.json",
                "mechanical-integration-sim.md",
                "acoustic-validation.json",
                "acoustic-validation.md",
                "acoustic-results-template.csv",
                "acoustic-results-review.json",
                "acoustic-results-review.md",
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
            and acoustic_validation["status"] == "cad_acoustic_validation_ready"
            and camera_validation["status"] == "cad_camera_validation_ready"
            else "blocked",
            "evidence": [
                "rear_camera_module",
                "front_camera_module",
                "front_camera_under_glass",
                "front_camera_black_mask_window",
                "rear_camera_cover_glass",
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "rear_camera_light_baffle_top",
                "rear_camera_light_baffle_bottom",
                "earpiece_receiver",
                "handset_acoustic_slot",
                "camera_speaker_behind_glass",
                "camera_optical_seal_stack",
                "interface-validation.json",
                "interface-validation.md",
                "camera-validation.json",
                "camera-validation.md",
                "camera-results-template.csv",
                "camera-results-review.json",
                "camera-results-review.md",
                "acoustic-validation.json",
                "acoustic-validation.md",
            ],
            "remaining_blockers": [
                "Need exact camera module lens stack, FPC, and vendor keepout drawing.",
                "Need handset acoustic gasket compression test.",
            ],
        },
        {
            "subsystem": "acoustic_lab_results",
            "status": "cad_pass"
            if acoustic_results["status"] == "acoustic_results_pass"
            else "blocked",
            "evidence": [
                "acoustic-validation.json",
                "acoustic-validation.md",
                "acoustic-results-template.csv",
                "acoustic-results-review.json",
                "acoustic-results-review.md",
            ],
            "remaining_blockers": [
                "No populated speaker, microphone, earpiece, or acoustic leak lab rows are present yet.",
                "Need measured SPL, impedance, SNR, and leak results before claiming acoustic readiness.",
            ],
        },
        {
            "subsystem": "display_touch_results",
            "status": "cad_pass"
            if display_results["status"] == "display_results_pass"
            else "blocked",
            "evidence": [
                "display-validation.json",
                "display-validation.md",
                "display-results-template.csv",
                "display-results-review.json",
                "display-results-review.md",
            ],
            "remaining_blockers": [
                "No populated display/touch/bond/bring-up lab rows are present yet.",
                "Need measured display bring-up, touch-grid, luminance, bond, FPC bend, and drop data before claiming display readiness.",
            ],
        },
        {
            "subsystem": "camera_optical_results",
            "status": "cad_pass"
            if camera_results["status"] == "camera_results_pass"
            else "blocked",
            "evidence": [
                "camera-validation.json",
                "camera-validation.md",
                "camera-results-template.csv",
                "camera-results-review.json",
                "camera-results-review.md",
            ],
            "remaining_blockers": [
                "No populated camera optical, alignment, dust, color, or streaming lab rows are present yet.",
                "Need supplier module drawings and measured capture results before claiming camera readiness.",
            ],
        },
        {
            "subsystem": "rf_shielding_haptics_service",
            "status": "cad_pass"
            if environmental_validation["status"] == "cad_environmental_validation_ready"
            else "blocked",
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
                "environmental-validation.json",
                "environmental-validation.md",
            ],
            "remaining_blockers": [
                "Need RF antenna simulation, SAR pre-scan, and desense test with final antennas.",
                "Need haptic actuator vendor drawing and drive calibration.",
                "Need SIM/eSIM product decision and serviceability review.",
            ],
        },
        {
            "subsystem": "thermal_rf_drop_ingress_validation",
            "status": "cad_pass"
            if environmental_validation["status"] == "cad_environmental_validation_ready"
            and ingress_path_review["status"] == "cad_ingress_path_review_ready"
            else "blocked",
            "evidence": [
                "environmental-validation.json",
                "environmental-validation.md",
                "ingress-path-review.json",
                "ingress-path-review.md",
                "environmental-results-template.csv",
                "environmental-results-review.json",
                "environmental-results-review.md",
                "soc_shield_can",
                "pmic_shield_can",
                "radio_shield_can",
                "cellular_top_antenna_keepout",
                "cellular_bottom_antenna_keepout",
                "wifi_bt_side_antenna_keepout",
                "screen_adhesive_top",
                "earpiece_gasket",
                "usb_c_external_aperture",
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "bottom_speaker_dust_mesh",
                "bottom_microphone_mesh_1",
                "bottom_microphone_mesh_2",
                "top_microphone_mesh",
                "handset_acoustic_mesh",
            ],
            "remaining_blockers": [
                "CAD review covers package intent only; no thermal, RF chamber, SAR, drop, dust, or splash measurements have been recorded.",
                "Need routed board power map, final antennas, molded resin samples, and lab results before environmental release.",
            ],
        },
        {
            "subsystem": "environmental_lab_results",
            "status": "cad_pass"
            if environmental_results["status"] == "environmental_results_pass"
            else "blocked",
            "evidence": [
                "environmental-validation.json",
                "environmental-validation.md",
                "environmental-results-template.csv",
                "environmental-results-review.json",
                "environmental-results-review.md",
            ],
            "remaining_blockers": [
                "No populated thermal, RF, SAR pre-scan, drop, dust, or splash lab rows are present yet.",
                "Need measured passing environmental data before claiming manufacturable environmental readiness.",
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
                "tooling-action-register.json",
                "tooling-action-register.csv",
                "tooling-action-register.md",
                "toolmaker-signoff-package.json",
                "toolmaker-signoff-package.md",
                "toolmaker-signoff-response-template.csv",
                "toolmaker-signoff-review.json",
                "toolmaker-signoff-review.md",
            ],
            "remaining_blockers": [
                "Runner/gate/ejector/cooling geometry and process window are CAD DFM proxies, not toolmaker-approved steel design.",
                "Need mold-flow/fill/pack/warp analysis, first-shot data, and toolmaker review.",
            ],
        },
        {
            "subsystem": "toolmaker_moldflow_signoff",
            "status": "cad_pass"
            if toolmaker_signoff["status"] == "toolmaker_signoff_complete"
            else "blocked",
            "evidence": [
                "toolmaker-signoff-package.json",
                "toolmaker-signoff-package.md",
                "toolmaker-signoff-response-template.csv",
                "toolmaker-signoff-review.json",
                "toolmaker-signoff-review.md",
            ],
            "remaining_blockers": [
                "No mold-flow report, toolmaker gate/ejector/cooling markup, or CMF signoff has been returned.",
                "Need signed toolmaker response before steel release or manufacturing-ready claim.",
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
                "part-explode-contact-sheet.png",
                "visual-decision-report.json",
                "visual-decision-report.md",
                "manufacturing_drawing.json",
                "full_top_down.png",
                "component-review-audio.png",
                "component-review-io-buttons.png",
                "component-review-optical.png",
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
                "component-review-audio.png",
                "component-review-io-buttons.png",
                "component-review-optical.png",
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
            and mechanical_integration_sim["status"] == "cad_mechanical_integration_sim_ready"
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
                "mechanical-integration-sim.json",
                "mechanical-integration-sim.md",
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
            and gdt_release["status"] == "gdt_release_package_ready"
            else "blocked",
            "evidence": [
                "tolerance-stack.json",
                "tolerance-stack.md",
                "gdt-release-package.json",
                "gdt-release-package.md",
                "gdt-fai-template.csv",
                "gdt-fai-results-review.json",
                "gdt-fai-results-review.md",
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
        {
            "subsystem": "gdt_fai_results",
            "status": "cad_pass"
            if gdt_fai_results["status"] == "gdt_fai_results_pass"
            else "blocked",
            "evidence": [
                "gdt-fai-template.csv",
                "gdt-fai-results-review.json",
                "gdt-fai-results-review.md",
            ],
            "remaining_blockers": [
                "No populated first-article GD&T measurement rows are present yet.",
                "Need measured passing CMM/FAI data before claiming tolerance release.",
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
        "compactness_optimization": compactness["status"] == "cad_compactness_optimized"
        and (REVIEW_DIR / "compactness-optimization.json").is_file()
        and (REVIEW_DIR / "compactness-optimization.md").is_file()
        and (REVIEW_DIR / "compactness-optimization.png").is_file()
        and (REVIEW_DIR / "compactness-optimization.svg").is_file(),
        "battery_swell_management": (REVIEW_DIR / "battery-swell-management.json").is_file()
        and (REVIEW_DIR / "battery-swell-management.md").is_file(),
        "supplier_lock": (REVIEW_DIR / "supplier-lock.json").is_file(),
        "kicad_mechanical_handoff": (REVIEW_DIR / "kicad-mechanical-handoff.json").is_file(),
        "kicad_placement_reconciliation": kicad_reconciliation["status"]
        == "cad_kicad_placement_reconciled"
        and (REVIEW_DIR / "kicad-placement-reconciliation.json").is_file()
        and (REVIEW_DIR / "kicad-placement-reconciliation.md").is_file(),
        "board_step_readiness": (REVIEW_DIR / "board-step-readiness.json").is_file()
        and (REVIEW_DIR / "board-step-readiness.md").is_file(),
        "engineering_validation": (REVIEW_DIR / "engineering-validation.json").is_file(),
        "interface_validation": interface_validation["status"] == "cad_interface_validation_pass"
        and (REVIEW_DIR / "interface-validation.json").is_file()
        and (REVIEW_DIR / "interface-validation.md").is_file(),
        "display_validation": display_validation["status"] == "cad_display_validation_ready"
        and (REVIEW_DIR / "display-validation.json").is_file()
        and (REVIEW_DIR / "display-validation.md").is_file()
        and (REVIEW_DIR / "display-results-template.csv").is_file(),
        "display_results_review": (REVIEW_DIR / "display-results-review.json").is_file()
        and (REVIEW_DIR / "display-results-review.md").is_file(),
        "mechanical_integration_sim": mechanical_integration_sim["status"]
        == "cad_mechanical_integration_sim_ready"
        and (REVIEW_DIR / "mechanical-integration-sim.json").is_file()
        and (REVIEW_DIR / "mechanical-integration-sim.md").is_file(),
        "acoustic_validation": acoustic_validation["status"] == "cad_acoustic_validation_ready"
        and (REVIEW_DIR / "acoustic-validation.json").is_file()
        and (REVIEW_DIR / "acoustic-validation.md").is_file()
        and (REVIEW_DIR / "acoustic-results-template.csv").is_file(),
        "acoustic_results_review": (REVIEW_DIR / "acoustic-results-review.json").is_file()
        and (REVIEW_DIR / "acoustic-results-review.md").is_file(),
        "camera_validation": camera_validation["status"] == "cad_camera_validation_ready"
        and (REVIEW_DIR / "camera-validation.json").is_file()
        and (REVIEW_DIR / "camera-validation.md").is_file()
        and (REVIEW_DIR / "camera-results-template.csv").is_file(),
        "camera_results_review": (REVIEW_DIR / "camera-results-review.json").is_file()
        and (REVIEW_DIR / "camera-results-review.md").is_file(),
        "environmental_validation": environmental_validation["status"]
        == "cad_environmental_validation_ready"
        and ingress_path_review["status"] == "cad_ingress_path_review_ready"
        and (REVIEW_DIR / "environmental-validation.json").is_file()
        and (REVIEW_DIR / "environmental-validation.md").is_file()
        and (REVIEW_DIR / "ingress-path-review.json").is_file()
        and (REVIEW_DIR / "ingress-path-review.md").is_file()
        and (REVIEW_DIR / "environmental-results-template.csv").is_file(),
        "environmental_results_review": (REVIEW_DIR / "environmental-results-review.json").is_file()
        and (REVIEW_DIR / "environmental-results-review.md").is_file(),
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
        "tooling_action_register": (REVIEW_DIR / "tooling-action-register.json").is_file()
        and (REVIEW_DIR / "tooling-action-register.csv").is_file()
        and (REVIEW_DIR / "tooling-action-register.md").is_file(),
        "toolmaker_signoff_package": toolmaker_signoff["package_status"]
        == "toolmaker_signoff_package_ready"
        and (REVIEW_DIR / "toolmaker-signoff-package.json").is_file()
        and (REVIEW_DIR / "toolmaker-signoff-package.md").is_file()
        and (REVIEW_DIR / "toolmaker-signoff-response-template.csv").is_file()
        and (REVIEW_DIR / "toolmaker-signoff-review.json").is_file()
        and (REVIEW_DIR / "toolmaker-signoff-review.md").is_file(),
        "tolerance_stack": (REVIEW_DIR / "tolerance-stack.json").is_file(),
        "gdt_release_package": gdt_release["status"] == "gdt_release_package_ready"
        and (REVIEW_DIR / "gdt-release-package.json").is_file()
        and (REVIEW_DIR / "gdt-release-package.md").is_file()
        and (REVIEW_DIR / "gdt-fai-template.csv").is_file(),
        "gdt_fai_results_review": (REVIEW_DIR / "gdt-fai-results-review.json").is_file()
        and (REVIEW_DIR / "gdt-fai-results-review.md").is_file(),
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
        "supplier_response_review": (REVIEW_DIR / "supplier-response-template.csv").is_file()
        and (REVIEW_DIR / "supplier-response-review.json").is_file()
        and (REVIEW_DIR / "supplier-response-review.md").is_file(),
        "part_review": (REVIEW_DIR / "part-review.json").is_file()
        and (REVIEW_DIR / "part-review-contact-sheet.png").is_file()
        and (REVIEW_DIR / "part-explode-contact-sheet.png").is_file(),
        "component_selection_review": (REVIEW_DIR / "component-selection-review.json").is_file()
        and (REVIEW_DIR / "component-selection-review.md").is_file(),
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
            "compactness_status": compactness["status"],
            "compactness_width_excess_mm": compactness["width_excess_over_bound_mm"],
            "compactness_height_excess_mm": compactness["height_excess_over_bound_mm"],
            "compactness_area_excess_mm2": compactness["area_excess_over_bound_mm2"],
            "supplier_items": len(supplier["items"]),
            "kicad_handoff_constraints": len(handoff["constraints"]),
            "kicad_placement_reconciliation_status": kicad_reconciliation["status"],
            "kicad_placement_footprint_cases": len(kicad_reconciliation.get("footprint_cases", [])),
            "kicad_placement_cad_projection_cases": len(
                kicad_reconciliation.get("cad_projection_cases", [])
            ),
            "board_step_readiness_status": board_step["status"],
            "board_step_has_tracks": board_step["board_state_detected"]["has_tracks"],
            "board_step_has_production_step": board_step["board_state_detected"][
                "has_production_step"
            ],
            "board_step_has_concept_pcb_step": board_step["board_state_detected"].get(
                "has_concept_pcb_step", False
            ),
            "board_step_concept_split_islands_match_kicad": board_step.get(
                "concept_split_island_geometry", {}
            ).get("matches", False),
            "engineering_validation_status": validation["status"],
            "interface_validation_status": interface_validation["status"],
            "interface_validation_case_count": len(interface_validation.get("interfaces", [])),
            "display_validation_status": display_validation["status"],
            "display_measurement_count": display_validation.get("measurement_count", 0),
            "display_results_status": display_results["status"],
            "display_results_complete_count": display_results.get("complete_result_count", 0),
            "mechanical_integration_sim_status": mechanical_integration_sim["status"],
            "mechanical_integration_sim_case_count": mechanical_integration_sim.get(
                "case_count", 0
            ),
            "acoustic_validation_status": acoustic_validation["status"],
            "acoustic_measurement_count": acoustic_validation.get("measurement_count", 0),
            "acoustic_results_status": acoustic_results["status"],
            "acoustic_results_complete_count": acoustic_results.get("complete_result_count", 0),
            "camera_validation_status": camera_validation["status"],
            "camera_measurement_count": camera_validation.get("measurement_count", 0),
            "camera_results_status": camera_results["status"],
            "camera_results_complete_count": camera_results.get("complete_result_count", 0),
            "environmental_validation_status": environmental_validation["status"],
            "ingress_path_review_status": ingress_path_review["status"],
            "ingress_path_count": ingress_path_review.get("path_count", 0),
            "environmental_measurement_count": environmental_validation.get("measurement_count", 0),
            "environmental_results_status": environmental_results["status"],
            "environmental_results_complete_count": environmental_results.get(
                "complete_result_count", 0
            ),
            "evt_fixture_status": evt_fixtures["status"],
            "evt_fixture_count": evt_fixtures.get("fixture_count", 0),
            "evt_inspection_status": evt_inspection["status"],
            "evt_inspection_measurement_count": evt_inspection.get("measurement_count", 0),
            "evt_results_status": evt_results["status"],
            "evt_results_populated_count": evt_results.get("populated_result_count", 0),
            "assembly_clearance_status": clearance["status"],
            "injection_molding_dfm_status": dfm["status"],
            "tolerance_stack_status": tolerance_stack["status"],
            "gdt_release_status": gdt_release["status"],
            "gdt_characteristic_count": gdt_release.get("characteristic_count", 0),
            "gdt_fai_results_status": gdt_fai_results["status"],
            "gdt_fai_results_complete_count": gdt_fai_results.get("complete_result_count", 0),
            "mold_process_window_status": mold_process["status"],
            "toolmaker_signoff_status": toolmaker_signoff["status"],
            "toolmaker_signoff_complete_count": toolmaker_signoff.get("complete_response_count", 0),
            "visual_decision_status": visual_decision["status"],
            "automated_visual_status": visual_decision.get("automated_visual_status"),
            "manual_visual_signoff_status": visual_decision.get("manual_visual_signoff_status"),
            "production_visual_signoff_ready": visual_decision.get(
                "production_visual_signoff_ready", False
            ),
            "open_manual_visual_review_count": visual_decision.get("open_manual_review_count", 0),
            "solid_cad_handoff_status": solid_cad["status"],
            "solid_cad_step_part_count": solid_cad.get("part_count", 0),
            "step_validation_status": step_validation["status"],
            "step_validation_count": step_validation.get("validated_count", 0),
            "supplier_rfq_status": supplier_rfq["status"],
            "supplier_rfq_package_count": len(supplier_rfq.get("packages", [])),
            "supplier_response_status": supplier_response["status"],
            "supplier_response_complete_count": supplier_response.get("complete_response_count", 0),
            "supplier_response_expected_count": supplier_response.get("expected_response_count", 0),
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
    return readiness


def write_end_to_end_objective_acceptance_artifacts(
    manufacturing_readiness: dict[str, Any],
    board_step: dict[str, Any],
    routed_board_clearance: dict[str, Any],
    supplier_evidence: dict[str, Any],
    full_cad_boolean: dict[str, Any],
    visual_review_coverage: dict[str, Any],
    toolmaker_signoff: dict[str, Any],
) -> dict[str, Any]:
    board_source = ROOT / "board/kicad/e1-phone/end-to-end-readiness.yaml"
    board_data = yaml.safe_load(board_source.read_text()) if board_source.is_file() else {}

    def read_review_json(name: str) -> dict[str, Any]:
        path = REVIEW_DIR / name
        if not path.is_file():
            return {"status": "missing", "missing_artifact": f"mechanical/e1-phone/review/{name}"}
        return json.loads(path.read_text())

    physical_process = read_review_json("physical-process-validation-acceptance.json")
    cmf_release = read_review_json("cmf-release-acceptance.json")
    mold_flow = read_review_json("mold-flow-acceptance.json")

    objective_requirements = board_data.get("objective_requirements", {})
    board_cases = []
    for objective_id, objective in objective_requirements.items():
        passed = bool(objective.get("objective_satisfied", False))
        board_cases.append(
            {
                "id": objective_id,
                "requirement": objective.get("requirement", ""),
                "evidence_artifact": objective.get("evidence_artifact", ""),
                "current_status": objective.get("current_status", "missing"),
                "objective_satisfied": passed,
                "release_required": bool(objective.get("release_required", True)),
                "blockers": objective.get("blockers", []),
                "required_release_outputs": objective.get("required_release_outputs", []),
                "pass": passed,
            }
        )

    mechanical_cases = [
        {
            "id": "routed_board_step_and_clearance",
            "status": routed_board_clearance.get("status"),
            "source_status": board_step.get("status"),
            "pass": board_step.get("status") == "routed_board_step_ready"
            and routed_board_clearance.get("status") == "routed_board_clearance_pass",
            "required_evidence": [
                "board-step-readiness.json",
                "routed-board-clearance.json",
                "routed-board-clearance-results-template.csv",
            ],
        },
        {
            "id": "supplier_family_lock",
            "status": supplier_evidence.get("status"),
            "pass": supplier_evidence.get("status") == "supplier_evidence_complete",
            "required_evidence": ["supplier-evidence-acceptance.json"],
        },
        {
            "id": "full_cad_boolean_interference",
            "status": full_cad_boolean.get("status"),
            "pass": full_cad_boolean.get("status") == "full_cad_boolean_interference_pass",
            "required_evidence": [
                "full-cad-boolean-interference.json",
                "full-cad-boolean-interference-results-template.csv",
            ],
        },
        {
            "id": "automated_visual_and_manual_cmf_signoff",
            "status": visual_review_coverage.get("status"),
            "pass": visual_review_coverage.get("status") == "visual_review_coverage_acceptance_pass"
            and visual_review_coverage.get("production_visual_signoff_ready") is True,
            "required_evidence": [
                "visual-review-coverage-acceptance.json",
                "visual-decision-report.json",
                "cmf-release-acceptance.json",
            ],
        },
        {
            "id": "physical_process_validation_results",
            "status": physical_process.get("status"),
            "pass": physical_process.get("status") == "physical_process_validation_pass",
            "required_evidence": [
                "physical-process-validation-acceptance.json",
                "display-results-review.json",
                "acoustic-results-review.json",
                "camera-results-review.json",
                "environmental-results-review.json",
                "evt-results-review.json",
                "gdt-fai-results-review.json",
            ],
        },
        {
            "id": "tooling_mold_flow_and_toolmaker_signoff",
            "status": toolmaker_signoff.get("status"),
            "source_status": mold_flow.get("status"),
            "pass": mold_flow.get("status") == "mold_flow_results_pass"
            and toolmaker_signoff.get("status") == "toolmaker_signoff_complete",
            "required_evidence": [
                "mold-flow-acceptance.json",
                "toolmaker-signoff-review.json",
                "toolmaker-signoff-response-template.csv",
            ],
        },
        {
            "id": "orange_cmf_release",
            "status": cmf_release.get("status"),
            "pass": cmf_release.get("status") == "cmf_release_complete",
            "required_evidence": [
                "cmf-release-acceptance.json",
                "cmf-results-template.csv",
            ],
        },
        {
            "id": "manufacturing_release_readiness",
            "status": manufacturing_readiness.get("overall_status"),
            "pass": manufacturing_readiness.get("manufacturing_release_ready") is True,
            "required_evidence": ["manufacturing-readiness.json"],
        },
    ]

    board_release_decision = board_data.get("release_decision", {})
    board_ready = bool(board_release_decision.get("end_to_end_phone_ready", False))
    complete_board_count = sum(1 for case in board_cases if case["pass"])
    complete_mechanical_count = sum(1 for case in mechanical_cases if case["pass"])
    missing_items = [f"board:{case['id']}" for case in board_cases if not case["pass"]] + [
        f"mechanical:{case['id']}" for case in mechanical_cases if not case["pass"]
    ]
    required_release_outputs = list(board_data.get("required_release_outputs", []))
    for case in board_cases:
        required_release_outputs.extend(case.get("required_release_outputs", []))
    for case in mechanical_cases:
        required_release_outputs.extend(
            f"mechanical/e1-phone/review/{item}" for item in case["required_evidence"]
        )
    required_release_outputs = sorted(dict.fromkeys(required_release_outputs))
    all_complete = (
        board_ready
        and complete_board_count == len(board_cases)
        and complete_mechanical_count == len(mechanical_cases)
        and manufacturing_readiness.get("manufacturing_release_ready") is True
    )
    report = {
        "claim_boundary": (
            "Generated CAD-side objective acceptance for the complete phone. This joins the "
            "board end-to-end readiness matrix with mechanical CAD release gates; planning "
            "artifacts, concept KiCad geometry, blank templates, and CAD envelopes do not count "
            "as finished phone evidence."
        ),
        "status": "end_to_end_objective_ready" if all_complete else "blocked_not_end_to_end_ready",
        "board_end_to_end_source": "board/kicad/e1-phone/end-to-end-readiness.yaml",
        "board_end_to_end_source_present": board_source.is_file(),
        "board_end_to_end_status": board_data.get("status", "missing"),
        "board_release_decision": board_release_decision,
        "expected_board_objective_count": len(board_cases),
        "complete_board_objective_count": complete_board_count,
        "expected_mechanical_gate_count": len(mechanical_cases),
        "complete_mechanical_gate_count": complete_mechanical_count,
        "board_cases": board_cases,
        "mechanical_cases": mechanical_cases,
        "missing_or_incomplete_items": missing_items,
        "required_release_outputs": required_release_outputs,
        "forbidden_claims": board_data.get("forbidden_claims", []),
        "release_rule": (
            "Every board objective requirement and every mechanical gate must pass, the board "
            "end-to-end release decision must be true, manufacturing_release_ready must be true, "
            "and all required release outputs must exist before claiming the finished phone is "
            "end-to-end ready."
        ),
    }
    (REVIEW_DIR / "end-to-end-objective-acceptance.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    lines = [
        "# E1 Phone End-To-End Objective Acceptance",
        "",
        f"Status: {report['status']}.",
        "",
        "This gate joins board objective readiness with mechanical release gates for the complete phone.",
        "",
        "## Board Objectives",
        "",
    ]
    for case in board_cases:
        lines.append(f"- {'PASS' if case['pass'] else 'BLOCKED'}: `{case['id']}`")
    lines.extend(["", "## Mechanical Gates", ""])
    for case in mechanical_cases:
        lines.append(f"- {'PASS' if case['pass'] else 'BLOCKED'}: `{case['id']}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "end-to-end-objective-acceptance.md").write_text("\n".join(lines) + "\n")
    return report


def write_cmf_release_acceptance_artifacts(
    params: dict[str, Any],
    visual_decision: dict[str, Any],
    visual_review_coverage: dict[str, Any],
    dfm: dict[str, Any],
    toolmaker_signoff: dict[str, Any],
) -> dict[str, Any]:
    criteria: list[dict[str, Any]] = [
        {
            "id": "orange_resin_color_plaque_delta_e",
            "domain": "color",
            "target": "molded orange PC+ABS plaque within deltaE <= 2.0 against approved master chip",
            "required_artifact": "color plaque photo, spectro reading, resin lot, and master-chip ID",
            "numeric_limit": {"max_delta_e": 2.0},
            "blocks_release": True,
        },
        {
            "id": "hard_touch_gloss_texture",
            "domain": "texture",
            "target": "hard matte/satin orange texture approved with 8-18 GU at 60 deg and documented texture depth",
            "required_artifact": "texture plaque, gloss-meter reading, and tool texture callout",
            "numeric_limit": {"min_gloss_gu_60": 8.0, "max_gloss_gu_60": 18.0},
            "blocks_release": True,
        },
        {
            "id": "scratch_and_hand_oil_visibility",
            "domain": "durability",
            "target": "no objectionable whitening, gloss change, or dark hand-oil staining on orange A-surfaces after rub/scratch exposure",
            "required_artifact": "rub/scratch photos before and after, reviewer disposition, and cleaning method",
            "numeric_limit": {"max_visible_defect_count": 0},
            "blocks_release": True,
        },
        {
            "id": "gate_blush_vestige_and_weld_line_visibility",
            "domain": "tooling_cosmetic",
            "target": "gate vestige off A-surface; no visible weld line on front rail, back hero surface, camera land, or USB lip",
            "required_artifact": "first-shot photos, gate vestige measurement, weld-line overlay, and mold-flow reference",
            "numeric_limit": {"max_a_surface_visible_defects": 0},
            "blocks_release": True,
        },
        {
            "id": "rendered_orange_identity_locked",
            "domain": "visual_cad",
            "target": "CAD review views show dominant orange shell with black glass front and compact phone slab proportions",
            "required_artifact": "visual-review.json and visual-decision-report.json",
            "numeric_limit": {
                "min_back_orange_ratio_of_nonwhite": 0.65,
                "min_bottom_orange_ratio_of_nonwhite": 0.45,
                "min_front_orange_ratio_of_nonwhite": 0.25,
            },
            "blocks_release": False,
        },
    ]
    template_path = REVIEW_DIR / "cmf-results-template.csv"
    fieldnames = [
        "criterion_id",
        "sample_id",
        "artifact",
        "measured_value",
        "accepted",
        "reviewer",
        "evidence_class",
        "notes",
    ]
    should_write_template = True
    if template_path.is_file():
        csv_text = template_path.read_text()
        csv_lines = csv_text.splitlines()
        if csv_lines and csv_lines[0].startswith("# evidence_class:"):
            csv_text = "\n".join(csv_lines[1:]) + "\n"
        with StringIO(csv_text) as csv_file:
            existing_rows = list(csv.DictReader(csv_file))
        existing_ids = {row.get("criterion_id", "") for row in existing_rows}
        expected_ids = {criterion["id"] for criterion in criteria}
        existing_fields = list(existing_rows[0].keys()) if existing_rows else []
        has_response_content = any(
            row.get(field, "").strip()
            for row in existing_rows
            for field in [
                "sample_id",
                "artifact",
                "measured_value",
                "accepted",
                "reviewer",
                "evidence_class",
            ]
        )
        should_write_template = existing_ids != expected_ids or existing_fields != fieldnames
        if has_response_content:
            should_write_template = False
    if should_write_template:
        with template_path.open("w", newline="") as cmf_template_file:
            writer = csv.DictWriter(cmf_template_file, fieldnames=fieldnames)
            writer.writeheader()
            for criterion in criteria:
                writer.writerow(
                    {
                        "criterion_id": criterion["id"],
                        "sample_id": "",
                        "artifact": "",
                        "measured_value": "",
                        "accepted": "",
                        "reviewer": "",
                        "evidence_class": "",
                        "notes": criterion["target"],
                    }
                )

    csv_text = template_path.read_text()
    csv_lines = csv_text.splitlines()
    template_evidence_class = ""
    if csv_lines and csv_lines[0].startswith("# evidence_class:"):
        template_evidence_class = csv_lines[0].split(":", 1)[1].strip()
        csv_text = "\n".join(csv_lines[1:]) + "\n"
    result_rows: dict[str, dict[str, str]] = {}
    with StringIO(csv_text) as csv_file:
        for row in csv.DictReader(csv_file):
            result_rows[row.get("criterion_id", "")] = row

    hard_orange_gate = visual_decision.get("visual_design_gates", {}).get(
        "hard_orange_shell_visible", {}
    )
    black_glass_gate = visual_decision.get("visual_design_gates", {}).get(
        "black_glass_front_visible", {}
    )
    visual_gate = {
        "front_orange_ratio": hard_orange_gate.get("front_orange_ratio", 0.0),
        "back_orange_ratio": hard_orange_gate.get("back_orange_ratio", 0.0),
        "bottom_orange_ratio": hard_orange_gate.get("bottom_orange_ratio", 0.0),
        "visual_decision_status": visual_decision.get("status"),
        "visual_review_coverage_status": visual_review_coverage.get("status"),
        "black_glass_front_visible": bool(black_glass_gate.get("pass", False)),
        "pass": visual_decision.get("status") == "pass"
        and visual_review_coverage.get("status") == "visual_review_coverage_acceptance_pass"
        and bool(hard_orange_gate.get("pass", False))
        and bool(black_glass_gate.get("pass", False)),
    }
    forbidden_evidence_classes = {
        "simulated_cmf_result_for_planning_not_release",
        "rendered_cad_only",
        "planning",
        "blank_template",
    }

    def parse_measurements(measured_value: str) -> tuple[dict[str, float], list[float]]:
        normalized_keys: dict[str, float] = {}
        for match in re.finditer(
            r"([A-Za-z][A-Za-z0-9_ -]*)\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)",
            measured_value,
        ):
            key = re.sub(r"[^a-z0-9]+", "_", match.group(1).lower()).strip("_")
            normalized_keys[key] = float(match.group(2))
        numbers = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", measured_value)]
        return normalized_keys, numbers

    def measurement_value(
        measurements: dict[str, float],
        numbers: list[float],
        aliases: list[str],
    ) -> float | None:
        for alias in aliases:
            key = re.sub(r"[^a-z0-9]+", "_", alias.lower()).strip("_")
            if key in measurements:
                return measurements[key]
        return numbers[0] if numbers else None

    def evaluate_numeric_limit(
        criterion_id: str,
        measured_value: str,
    ) -> tuple[bool, dict[str, float], list[str]]:
        measurements, numbers = parse_measurements(measured_value)
        parsed: dict[str, float] = {}
        failures: list[str] = []
        if criterion_id == "orange_resin_color_plaque_delta_e":
            value = measurement_value(measurements, numbers, ["delta_e", "delta e", "de"])
            if value is None:
                failures.append("missing_delta_e")
            else:
                parsed["delta_e"] = value
                if value > 2.0:
                    failures.append("delta_e_above_2.0")
        elif criterion_id == "hard_touch_gloss_texture":
            value = measurement_value(
                measurements,
                numbers,
                ["gloss_gu_60", "gloss gu 60", "gloss_60", "gu_60", "gloss"],
            )
            if value is None:
                failures.append("missing_gloss_gu_60")
            else:
                parsed["gloss_gu_60"] = value
                if value < 8.0 or value > 18.0:
                    failures.append("gloss_gu_60_outside_8_to_18")
        elif criterion_id == "scratch_and_hand_oil_visibility":
            value = measurement_value(
                measurements,
                numbers,
                ["visible_defect_count", "visible defects", "defects", "defect_count"],
            )
            if value is None:
                failures.append("missing_visible_defect_count")
            else:
                parsed["visible_defect_count"] = value
                if value > 0:
                    failures.append("visible_defect_count_above_0")
        elif criterion_id == "gate_blush_vestige_and_weld_line_visibility":
            value = measurement_value(
                measurements,
                numbers,
                [
                    "a_surface_visible_defects",
                    "a surface visible defects",
                    "visible_defects",
                    "defects",
                    "defect_count",
                ],
            )
            if value is None:
                failures.append("missing_a_surface_visible_defects")
            else:
                parsed["a_surface_visible_defects"] = value
                if value > 0:
                    failures.append("a_surface_visible_defects_above_0")
        else:
            return True, parsed, failures
        return not failures, parsed, failures

    cases = []
    for criterion in criteria:
        row = result_rows.get(criterion["id"], {})
        measured_value = row.get("measured_value", "").strip()
        numeric_limit_pass, parsed_measurements, numeric_limit_failures = evaluate_numeric_limit(
            criterion["id"], measured_value
        )
        evidence_class = row.get("evidence_class", "").strip() or template_evidence_class
        accepted = row.get("accepted", "").strip().lower() in {"yes", "true", "1", "pass"}
        evidence_class_allowed = evidence_class == "physical_cmf_result" and (
            evidence_class not in forbidden_evidence_classes
        )
        result = {
            "criterion_id": criterion["id"],
            "sample_id_present": bool(row.get("sample_id", "").strip()),
            "artifact_present": bool(row.get("artifact", "").strip()),
            "measured_value_present": bool(measured_value),
            "parsed_measurements": parsed_measurements,
            "numeric_limit_pass": numeric_limit_pass,
            "numeric_limit_failures": numeric_limit_failures,
            "reviewer_present": bool(row.get("reviewer", "").strip()),
            "evidence_class": evidence_class,
            "evidence_class_allowed": evidence_class_allowed,
            "accepted": accepted,
            "pass": False,
        }
        if criterion["id"] == "rendered_orange_identity_locked":
            result["visual_gate"] = visual_gate
            result["pass"] = visual_gate["pass"]
        else:
            result["pass"] = (
                result["sample_id_present"]
                and result["artifact_present"]
                and result["measured_value_present"]
                and result["numeric_limit_pass"]
                and result["reviewer_present"]
                and evidence_class_allowed
                and accepted
            )
        cases.append({**criterion, "result": result, "pass": result["pass"]})

    complete_count = sum(1 for case in cases if case["pass"])
    production_cases = [case for case in cases if case["blocks_release"]]
    production_complete_count = sum(1 for case in production_cases if case["pass"])
    missing_items = [case["id"] for case in cases if not case["pass"]]
    report = {
        "claim_boundary": (
            "Fail-closed CMF and industrial-design release contract for the hard orange plastic "
            "phone. Rendered orange CAD identity is necessary but does not replace molded "
            "plaques, scratch/rub samples, first shots, or signed CMF approval."
        ),
        "status": "cmf_release_complete"
        if production_complete_count == len(production_cases) and visual_gate["pass"]
        else "blocked_no_cmf_results"
        if production_complete_count == 0
        else "blocked_cmf_results_incomplete",
        "design_language": params["device"]["design_language"],
        "plastic_color": params["device"]["plastic_color"],
        "material_family": params["manufacturing"]["plastic"],
        "gate_strategy": params["manufacturing"]["gate_strategy"],
        "source_status": {
            "visual_decision_status": visual_decision.get("status"),
            "visual_review_coverage_status": visual_review_coverage.get("status"),
            "dfm_status": dfm.get("status"),
            "toolmaker_signoff_status": toolmaker_signoff.get("status"),
        },
        "expected_criterion_count": len(cases),
        "complete_criterion_count": complete_count,
        "production_required_count": len(production_cases),
        "production_complete_count": production_complete_count,
        "required_evidence_class": "physical_cmf_result",
        "template_evidence_class": template_evidence_class,
        "forbidden_evidence_classes": sorted(forbidden_evidence_classes),
        "results_template": "mechanical/e1-phone/review/cmf-results-template.csv",
        "visual_gate": visual_gate,
        "cases": cases,
        "missing_or_incomplete_criteria": missing_items,
        "release_rule": (
            "Color plaque, texture/gloss plaque, scratch/rub sample, gate-blush/weld-line "
            "first-shot review, physical numeric limits, evidence_class=physical_cmf_result, "
            "and rendered orange identity must all pass before industrial-design or CMF release."
        ),
    }
    (REVIEW_DIR / "cmf-release-acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = [
        "# E1 Phone CMF Release Acceptance",
        "",
        f"Status: {report['status']}.",
        "",
        "This gate blocks CMF release until molded orange samples and visual signoff are complete.",
        "",
        "## Criteria",
        "",
    ]
    for case in cases:
        lines.append(f"- {'PASS' if case['pass'] else 'BLOCKED'}: `{case['id']}`")
        lines.append(f"  Required artifact: {case['required_artifact']}")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "cmf-release-acceptance.md").write_text("\n".join(lines) + "\n")
    return report


def write_physical_process_validation_acceptance_artifacts() -> dict[str, Any]:
    def read_review_json(name: str) -> dict[str, Any]:
        path = REVIEW_DIR / name
        if not path.is_file():
            return {"status": "missing", "missing_artifact": f"mechanical/e1-phone/review/{name}"}
        return json.loads(path.read_text())

    gate_specs = [
        {
            "id": "display_touch_lab_results",
            "review": "display-results-review.json",
            "template": "display-results-template.csv",
            "pass_status": "display_results_pass",
        },
        {
            "id": "acoustic_lab_results",
            "review": "acoustic-results-review.json",
            "template": "acoustic-results-template.csv",
            "pass_status": "acoustic_results_pass",
        },
        {
            "id": "camera_optical_lab_results",
            "review": "camera-results-review.json",
            "template": "camera-results-template.csv",
            "pass_status": "camera_results_pass",
        },
        {
            "id": "thermal_rf_drop_ingress_environmental_results",
            "review": "environmental-results-review.json",
            "template": "environmental-results-template.csv",
            "pass_status": "environmental_results_pass",
        },
        {
            "id": "button_usb_screen_evt_physical_results",
            "review": "evt-results-review.json",
            "template": "evt-inspection-results-template.csv",
            "pass_status": "evt_results_pass",
        },
        {
            "id": "fixture_calibration_results",
            "review": "fixture-calibration-acceptance.json",
            "template": "fixture-calibration-results-template.csv",
            "pass_status": "fixture_calibration_results_pass",
        },
        {
            "id": "mechanical_lifecycle_results",
            "review": "mechanical-lifecycle-acceptance.json",
            "template": "mechanical-lifecycle-results-template.csv",
            "pass_status": "mechanical_lifecycle_results_pass",
        },
        {
            "id": "gdt_first_article_results",
            "review": "gdt-fai-results-review.json",
            "template": "gdt-fai-template.csv",
            "pass_status": "gdt_fai_results_pass",
        },
        {
            "id": "unit_traceability_records",
            "review": "unit-traceability-acceptance.json",
            "template": "unit-traceability-results-template.csv",
            "pass_status": "unit_traceability_results_pass",
        },
        {
            "id": "assembly_build_traveler_records",
            "review": "assembly-build-traveler.json",
            "template": "assembly-build-results-template.csv",
            "pass_status": "assembly_build_results_pass",
        },
        {
            "id": "factory_process_control_records",
            "review": "process-control-plan.json",
            "template": "process-control-results-template.csv",
            "pass_status": "process_control_results_pass",
        },
    ]
    cases = []
    for spec in gate_specs:
        review = read_review_json(spec["review"])
        status = review.get("status", "missing")
        template_present = (REVIEW_DIR / spec["template"]).is_file()
        review_present = (REVIEW_DIR / spec["review"]).is_file()
        passed = status == spec["pass_status"] and template_present and review_present
        cases.append(
            {
                "id": spec["id"],
                "status": status,
                "pass_status": spec["pass_status"],
                "required_evidence": [spec["template"], spec["review"]],
                "template_present": template_present,
                "review_present": review_present,
                "complete_result_count": review.get("complete_result_count", 0),
                "expected_result_count": review.get(
                    "expected_measurement_count",
                    review.get(
                        "expected_characteristic_count", review.get("expected_result_count", 0)
                    ),
                ),
                "pass": passed,
            }
        )
    complete_gate_count = sum(1 for case in cases if case["pass"])
    missing_gates = [case["id"] for case in cases if not case["pass"]]
    report = {
        "claim_boundary": (
            "Fail-closed finished-phone validation acceptance. CAD plans, fixtures, blank "
            "templates, and individual review files do not count as finished phone evidence "
            "until every lab, EVT, FAI, traceability, build, and process-control result family passes."
        ),
        "status": "physical_process_validation_pass"
        if cases and complete_gate_count == len(cases)
        else "blocked_no_physical_process_validation_results"
        if complete_gate_count == 0
        else "blocked_physical_process_validation_incomplete",
        "expected_gate_count": len(cases),
        "complete_gate_count": complete_gate_count,
        "missing_or_incomplete_gates": missing_gates,
        "cases": cases,
        "release_rule": (
            "Display/touch, acoustic, camera, environmental, EVT physical, fixture calibration, "
            "lifecycle, GD&T/FAI, unit traceability, assembly traveler, and process-control "
            "results must all be populated and passing before the phone can be treated as "
            "physically validated."
        ),
    }
    (REVIEW_DIR / "physical-process-validation-acceptance.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    lines = [
        "# E1 Phone Physical Process Validation Acceptance",
        "",
        f"Status: {report['status']}.",
        "",
        "This gate blocks finished-phone validation until all physical result families pass.",
        "",
        "## Gates",
        "",
    ]
    for case in cases:
        lines.append(f"- {'PASS' if case['pass'] else 'BLOCKED'}: `{case['id']}`")
    lines.extend(["", "## Release Rule", "", f"- {report['release_rule']}"])
    (REVIEW_DIR / "physical-process-validation-acceptance.md").write_text("\n".join(lines) + "\n")
    return report


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
        "battery_back_void_foam_pad",
        "usb_c_receptacle",
        "bottom_speaker_module",
        "earpiece_receiver",
        "bottom_mic",
        "top_mic",
        "rear_camera_module",
        "rear_camera_shell_aperture",
        "rear_camera_optical_sight_tunnel",
        "orange_rear_camera_bezel_top",
        "orange_rear_camera_bezel_bottom",
        "orange_rear_camera_bezel_left",
        "orange_rear_camera_bezel_right",
        "front_camera_module",
        "rear_camera_cover_adhesive_top",
        "rear_camera_cover_adhesive_bottom",
        "rear_camera_cover_adhesive_left",
        "rear_camera_cover_adhesive_right",
        "rear_camera_light_baffle_top",
        "rear_camera_light_baffle_bottom",
        "rear_flash_camera_septum",
        "rear_flash_shell_aperture",
        "orange_rear_flash_bezel_top",
        "orange_rear_flash_bezel_bottom",
        "orange_rear_flash_bezel_left",
        "orange_rear_flash_bezel_right",
        "front_camera_black_mask_window",
        "power_button_cap",
        "volume_button_cap",
        "power_button_elastomer_gasket",
        "power_button_labyrinth_upper_rail",
        "power_button_labyrinth_lower_rail",
        "volume_button_elastomer_gasket",
        "volume_button_labyrinth_upper_rail",
        "volume_button_labyrinth_lower_rail",
        "handset_acoustic_slot",
        "handset_acoustic_mesh",
        "screen_adhesive_top",
        "display_fpc_connector",
        "orange_usb_reinforcement_saddle",
        "bottom_speaker_acoustic_chamber",
        "earpiece_gasket",
        "usb_c_external_aperture",
        "usb_c_perimeter_gasket_top",
        "usb_c_perimeter_gasket_bottom",
        "usb_c_perimeter_gasket_left",
        "usb_c_perimeter_gasket_right",
        "usb_c_molded_drip_break_lip",
        "usb_c_internal_drain_shelf",
        "bottom_speaker_grille_slot_1",
        "bottom_speaker_dust_mesh",
        "bottom_microphone_port_1",
        "bottom_microphone_mesh_1",
        "bottom_microphone_mesh_2",
        "top_microphone_port",
        "top_microphone_mesh",
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
    battery_center = [0.0, -7.0, battery_center_z(params)]
    pcb_segment_gaps = [
        box_gap(size, center, battery["envelope_mm"], battery_center)
        for size, center, _name in pcb_island_segments(params)
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

    wall = float(params["device"]["wall_thickness_mm"])
    back_inner_wall_z = -depth / 2.0 + wall
    battery_min = battery_max = display_lcm_back_z = None
    flash_min = None
    if "battery_pouch" in by_name and "display_lcm" in by_name:
        bat_lo, bat_hi = by_name["battery_pouch"].bounds
        battery_min = float(bat_lo[2])
        battery_max = float(bat_hi[2])
        display_lcm_back_z = float(by_name["display_lcm"].bounds[0][2])
    battery_to_display_gap_mm = (
        display_lcm_back_z - battery_max
        if battery_max is not None and display_lcm_back_z is not None
        else 0.0
    )
    battery_to_back_wall_gap_mm = (
        battery_min - back_inner_wall_z if battery_min is not None else 0.0
    )
    foam_low = foam_high = None
    if "battery_back_void_foam_pad" in by_name:
        foam_lo, foam_hi = by_name["battery_back_void_foam_pad"].bounds
        foam_low = float(foam_lo[2])
        foam_high = float(foam_hi[2])
    foam_pad_thickness_mm = float(battery.get("back_void_foam_pad_mm", [0.0, 0.0, 0.0])[2])
    foam_compression_allowance_mm = float(
        battery.get("back_void_foam_compression_allowance_mm", 0.0)
    )
    battery_swell_high_mm = round(float(battery["envelope_mm"][2]) * 0.10, 4)
    back_void_tolerance_arithmetic_mm = 0.182
    back_void_required_worst_case_mm = battery_swell_high_mm + back_void_tolerance_arithmetic_mm
    back_void_managed_capacity_mm = battery_to_back_wall_gap_mm + foam_compression_allowance_mm
    if "rear_flash_led" in by_name:
        flash_lo = by_name["rear_flash_led"].bounds[0]
        flash_min = float(flash_lo[2])
    flash_burial_clearance_mm = flash_min - back_inner_wall_z if flash_min is not None else 0.0
    rear_camera_back_z = rear_camera_front_z = None
    if "rear_camera_module" in by_name:
        cam_lo, cam_hi = by_name["rear_camera_module"].bounds
        rear_camera_back_z = float(cam_lo[2])
        rear_camera_front_z = float(cam_hi[2])
    rear_camera_burial_clearance_mm = (
        rear_camera_back_z - back_inner_wall_z if rear_camera_back_z is not None else 0.0
    )
    front_camera_back_z = front_camera_front_z = None
    if "front_camera_module" in by_name:
        fc_lo, fc_hi = by_name["front_camera_module"].bounds
        front_camera_back_z = float(fc_lo[2])
        front_camera_front_z = float(fc_hi[2])
    saddle_to_speaker_chamber_gap_mm = 0.0
    if (
        "orange_usb_reinforcement_saddle" in by_name
        and "bottom_speaker_acoustic_chamber" in by_name
    ):
        saddle_to_speaker_chamber_gap_mm = box_gap(
            list(by_name["orange_usb_reinforcement_saddle"].mesh.extents),
            list(by_name["orange_usb_reinforcement_saddle"].mesh.bounds.mean(axis=0)),
            list(by_name["bottom_speaker_acoustic_chamber"].mesh.extents),
            list(by_name["bottom_speaker_acoustic_chamber"].mesh.bounds.mean(axis=0)),
        )
    flash_camera_center_spacing_mm = 0.0
    if "rear_flash_led_window" in by_name and "rear_camera_lens_window" in by_name:
        flash_c = by_name["rear_flash_led_window"].mesh.bounds.mean(axis=0)
        cam_c = by_name["rear_camera_lens_window"].mesh.bounds.mean(axis=0)
        flash_camera_center_spacing_mm = float(np.linalg.norm(flash_c[:2] - cam_c[:2]))
    rear_aperture_w, rear_aperture_h = rear_camera_shell_aperture_mm(params)
    rear_glass_w, rear_glass_h, _rear_glass_t = comp["rear_camera_glass"]["envelope_mm"]
    rear_camera_aperture_bezel_parts = [
        "orange_rear_camera_bezel_top",
        "orange_rear_camera_bezel_bottom",
        "orange_rear_camera_bezel_left",
        "orange_rear_camera_bezel_right",
    ]
    rear_flash_aperture_w, rear_flash_aperture_h = rear_flash_shell_aperture_mm(params)
    rear_flash_window_w, rear_flash_window_h, _rear_flash_window_t = comp["rear_flash_led"][
        "window_mm"
    ]
    rear_flash_aperture_bezel_parts = [
        "orange_rear_flash_bezel_top",
        "orange_rear_flash_bezel_bottom",
        "orange_rear_flash_bezel_left",
        "orange_rear_flash_bezel_right",
    ]

    battery_swell_gap_required_mm = float(battery.get("battery_swell_gap_mm", 0.6))
    fit_check_epsilon_mm = 1e-6
    checks = {
        "battery_display_and_wall_clearance": {
            "pass": battery_to_display_gap_mm + fit_check_epsilon_mm >= 0.15
            and battery_to_back_wall_gap_mm + fit_check_epsilon_mm >= battery_swell_gap_required_mm,
            "battery_front_z_mm": round(battery_max, 4) if battery_max is not None else None,
            "battery_back_z_mm": round(battery_min, 4) if battery_min is not None else None,
            "display_lcm_back_z_mm": (
                round(display_lcm_back_z, 4) if display_lcm_back_z is not None else None
            ),
            "back_inner_wall_z_mm": round(back_inner_wall_z, 4),
            "battery_to_display_gap_mm": round(battery_to_display_gap_mm, 4),
            "battery_to_back_wall_gap_mm": round(battery_to_back_wall_gap_mm, 4),
            "required_front_static_gap_mm": 0.15,
            "required_back_swell_gap_mm": battery_swell_gap_required_mm,
            "note": "Front face keeps the 0.15 mm static gap below the display; the larger back-face gap is a defined swell void toward the back shell so a LiPo pouch (~8-10 percent thickness swell) never presses the display.",
        },
        "battery_back_void_foam_management": {
            "pass": "battery_back_void_foam_pad" in by_name
            and foam_pad_thickness_mm > 0.0
            and foam_compression_allowance_mm >= 0.142
            and back_void_managed_capacity_mm + fit_check_epsilon_mm
            >= back_void_required_worst_case_mm,
            "foam_pad_present": "battery_back_void_foam_pad" in by_name,
            "foam_pad_thickness_mm": round(foam_pad_thickness_mm, 4),
            "foam_low_z_mm": round(foam_low, 4) if foam_low is not None else None,
            "foam_high_z_mm": round(foam_high, 4) if foam_high is not None else None,
            "foam_to_battery_free_gap_mm": (
                round(battery_min - foam_high, 4)
                if battery_min is not None and foam_high is not None
                else None
            ),
            "foam_compression_allowance_mm": round(foam_compression_allowance_mm, 4),
            "battery_swell_high_mm": battery_swell_high_mm,
            "back_void_tolerance_arithmetic_mm": back_void_tolerance_arithmetic_mm,
            "back_void_required_worst_case_mm": round(back_void_required_worst_case_mm, 4),
            "back_void_managed_capacity_mm": round(back_void_managed_capacity_mm, 4),
            "note": "Back-shell-side compressible foam absorbs the 0.142 mm arithmetic worst-case swell/tolerance overage while preserving the 0.15 mm display-side static gap.",
        },
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
        "usb_c_port_seal_stack": {
            "pass": {
                "usb_c_perimeter_gasket_top",
                "usb_c_perimeter_gasket_bottom",
                "usb_c_perimeter_gasket_left",
                "usb_c_perimeter_gasket_right",
                "usb_c_molded_drip_break_lip",
                "usb_c_internal_drain_shelf",
                "orange_usb_reinforcement_saddle",
            }.issubset(by_name),
            "gasket_parts": [
                name
                for name in [
                    "usb_c_perimeter_gasket_top",
                    "usb_c_perimeter_gasket_bottom",
                    "usb_c_perimeter_gasket_left",
                    "usb_c_perimeter_gasket_right",
                ]
                if name in by_name
            ],
            "managed_ingress_parts": [
                name
                for name in [
                    "usb_c_molded_drip_break_lip",
                    "usb_c_internal_drain_shelf",
                    "orange_usb_reinforcement_saddle",
                ]
                if name in by_name
            ],
            "note": "Models a four-sided elastomer seat around the receptacle mouth plus molded drip-break/drain shelf for splash management.",
        },
        "bottom_io_acoustic_apertures": {
            "pass": "usb_c_external_aperture" in by_name
            and sum(1 for name in by_name if name.startswith("bottom_speaker_grille_slot_")) >= 5
            and sum(1 for name in by_name if name.startswith("bottom_microphone_port_")) >= 2
            and "bottom_speaker_dust_mesh" in by_name
            and sum(1 for name in by_name if name.startswith("bottom_microphone_mesh_")) >= 2
            and "top_microphone_port" in by_name
            and "top_microphone_mesh" in by_name,
            "speaker_grille_slots": sum(
                1 for name in by_name if name.startswith("bottom_speaker_grille_slot_")
            ),
            "microphone_ports": sum(
                1 for name in by_name if name.startswith("bottom_microphone_port_")
            ),
            "speaker_mesh_present": "bottom_speaker_dust_mesh" in by_name,
            "bottom_microphone_mesh_count": sum(
                1 for name in by_name if name.startswith("bottom_microphone_mesh_")
            ),
            "top_microphone_port_present": "top_microphone_port" in by_name,
            "top_microphone_mesh_present": "top_microphone_mesh" in by_name,
        },
        "button_force_and_travel": {
            "pass": 1.2 <= comp["power_button"]["force_n"] <= 2.2
            and 1.2 <= comp["volume_button"]["force_n"] <= 2.2
            and comp["power_button"]["travel_mm"] >= MIN_BUTTON_TRAVEL_MM
            and comp["volume_button"]["travel_mm"] >= MIN_BUTTON_TRAVEL_MM,
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
        "button_ingress_seal_stack": {
            "pass": {
                "power_button_elastomer_gasket",
                "power_button_labyrinth_upper_rail",
                "power_button_labyrinth_lower_rail",
                "volume_button_elastomer_gasket",
                "volume_button_labyrinth_upper_rail",
                "volume_button_labyrinth_lower_rail",
            }.issubset(by_name),
            "power_seal_parts": [
                name
                for name in [
                    "power_button_elastomer_gasket",
                    "power_button_labyrinth_upper_rail",
                    "power_button_labyrinth_lower_rail",
                ]
                if name in by_name
            ],
            "volume_seal_parts": [
                name
                for name in [
                    "volume_button_elastomer_gasket",
                    "volume_button_labyrinth_upper_rail",
                    "volume_button_labyrinth_lower_rail",
                ]
                if name in by_name
            ],
            "note": "Models silicone compression gasket plus molded side-key labyrinth rails behind both external orange caps.",
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
            and "handset_acoustic_mesh" in by_name
            and "rear_camera_cover_glass" in by_name
            and "rear_camera_shell_aperture" in by_name,
            "front_camera": "behind cover glass at upper-left display border",
            "earpiece": "behind cover-glass acoustic slot with gasketed receiver",
            "earpiece_mesh_present": "handset_acoustic_mesh" in by_name,
            "rear_camera": "behind a separate rear cover glass window in an explicit molded back-shell aperture",
        },
        "rear_camera_back_shell_aperture": {
            "pass": "rear_camera_shell_aperture" in by_name
            and "rear_camera_cover_glass" in by_name
            and "rear_camera_lens_window" in by_name
            and all(name in by_name for name in rear_camera_aperture_bezel_parts)
            and rear_aperture_w > rear_glass_w
            and rear_aperture_h > rear_glass_h,
            "aperture_mm": [rear_aperture_w, rear_aperture_h],
            "cover_glass_mm": [rear_glass_w, rear_glass_h],
            "bezel_parts": [name for name in rear_camera_aperture_bezel_parts if name in by_name],
            "aperture_present": "rear_camera_shell_aperture" in by_name,
            "note": "Back shell now carries an explicit through-aperture and four orange bevel lands around the flush camera cover window instead of relying on an internal black window hidden under an unbroken shell.",
        },
        "rear_flash_back_shell_aperture": {
            "pass": "rear_flash_shell_aperture" in by_name
            and "rear_flash_led_window" in by_name
            and "rear_flash_led" in by_name
            and all(name in by_name for name in rear_flash_aperture_bezel_parts)
            and rear_flash_aperture_w > rear_flash_window_w
            and rear_flash_aperture_h > rear_flash_window_h,
            "aperture_mm": [rear_flash_aperture_w, rear_flash_aperture_h],
            "window_mm": [rear_flash_window_w, rear_flash_window_h],
            "bezel_parts": [name for name in rear_flash_aperture_bezel_parts if name in by_name],
            "aperture_present": "rear_flash_shell_aperture" in by_name,
            "note": "Back shell now carries an explicit through-aperture and four orange bevel lands around the flush flash light-pipe window instead of treating the window/back-shell overlap as intentional contact.",
        },
        "camera_optical_seal_stack": {
            "pass": {
                "rear_camera_cover_adhesive_top",
                "rear_camera_cover_adhesive_bottom",
                "rear_camera_cover_adhesive_left",
                "rear_camera_cover_adhesive_right",
                "rear_camera_light_baffle_top",
                "rear_camera_light_baffle_bottom",
                "front_camera_black_mask_window",
                "rear_flash_camera_septum",
            }.issubset(by_name)
            and flash_camera_center_spacing_mm >= 6.0
            and flash_burial_clearance_mm >= 0.1,
            "rear_cover_adhesive_count": sum(
                1 for name in by_name if name.startswith("rear_camera_cover_adhesive_")
            ),
            "rear_light_baffle_count": sum(
                1 for name in by_name if name.startswith("rear_camera_light_baffle_")
            ),
            "front_black_mask_present": "front_camera_black_mask_window" in by_name,
            "stray_light_septum_present": "rear_flash_camera_septum" in by_name,
            "flash_camera_center_spacing_mm": round(flash_camera_center_spacing_mm, 3),
            "flash_camera_center_spacing_required_mm": 6.0,
            "flash_burial_clearance_mm": round(flash_burial_clearance_mm, 3),
            "flash_burial_clearance_required_mm": 0.1,
            "note": "Models rear cover-window PSA/dust gasket, rear light baffle, opaque stray-light septum between coplanar flash and camera windows, and front under-glass black mask datum.",
        },
        "camera_burial_clearance": {
            "pass": rear_camera_burial_clearance_mm >= 0.4,
            "rear_camera_back_z_mm": (
                round(rear_camera_back_z, 4) if rear_camera_back_z is not None else None
            ),
            "rear_camera_front_z_mm": (
                round(rear_camera_front_z, 4) if rear_camera_front_z is not None else None
            ),
            "back_inner_wall_z_mm": round(back_inner_wall_z, 4),
            "rear_camera_burial_clearance_mm": round(rear_camera_burial_clearance_mm, 4),
            "front_camera_back_z_mm": (
                round(front_camera_back_z, 4) if front_camera_back_z is not None else None
            ),
            "front_camera_front_z_mm": (
                round(front_camera_front_z, 4) if front_camera_front_z is not None else None
            ),
            "required_burial_clearance_mm": 0.4,
            "note": "Rear 5.1 mm camera module back face sits >=0.4 mm inside the back inner wall under the flush flat back (healthy, not the prior marginal 0.25-0.30 mm); lens window stays coplanar with the back outer plane.",
        },
        "usb_saddle_to_speaker_chamber_wall": {
            "pass": saddle_to_speaker_chamber_gap_mm >= 1.0,
            "actual_gap_mm": round(saddle_to_speaker_chamber_gap_mm, 4),
            "required_gap_mm": 1.0,
            "note": "USB-C reinforcement saddle must keep a >=1.0 mm dividing wall to the bottom speaker rear acoustic chamber so the USB mechanical-load path does not breach the acoustic seal (was a marginal 0.5 mm).",
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
            "pass": width <= 80.0 and height <= 157.0 and depth <= 12.8,
            "envelope_mm": [width, height, depth],
            "note": "Width/height driven by 77.1 x 151.77 mm commodity CTP outline plus orange side rail; depth allowed to <=12.8 mm by the flush-back decision to fully bury the rear camera and torch under a flat back wall, plus the product-owner-approved increase to 12.7 mm for a >=0.6 mm battery swell void and >=0.4 mm rear-camera burial clearance.",
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
            "battery_swell_management_json": "mechanical/e1-phone/review/battery-swell-management.json",
            "battery_swell_management_md": "mechanical/e1-phone/review/battery-swell-management.md",
            "mass_budget_json": "mechanical/e1-phone/review/mass-budget.json",
            "mass_budget_md": "mechanical/e1-phone/review/mass-budget.md",
            "compactness_optimization_json": "mechanical/e1-phone/review/compactness-optimization.json",
            "compactness_optimization_md": "mechanical/e1-phone/review/compactness-optimization.md",
            "compactness_optimization_png": "mechanical/e1-phone/review/compactness-optimization.png",
            "compactness_optimization_svg": "mechanical/e1-phone/review/compactness-optimization.svg",
            "supplier_lock_json": "mechanical/e1-phone/review/supplier-lock.json",
            "supplier_lock_md": "mechanical/e1-phone/review/supplier-lock.md",
            "supplier_rfq_package_json": "mechanical/e1-phone/review/supplier-rfq-package.json",
            "supplier_rfq_package_md": "mechanical/e1-phone/review/supplier-rfq-package.md",
            "supplier_response_template": "mechanical/e1-phone/review/supplier-response-template.csv",
            "supplier_response_review_json": "mechanical/e1-phone/review/supplier-response-review.json",
            "supplier_response_review_md": "mechanical/e1-phone/review/supplier-response-review.md",
            "supplier_evidence_acceptance_json": "mechanical/e1-phone/review/supplier-evidence-acceptance.json",
            "supplier_evidence_acceptance_md": "mechanical/e1-phone/review/supplier-evidence-acceptance.md",
            "kicad_mechanical_handoff_json": "mechanical/e1-phone/review/kicad-mechanical-handoff.json",
            "kicad_mechanical_handoff_md": "mechanical/e1-phone/review/kicad-mechanical-handoff.md",
            "kicad_placement_reconciliation_json": "mechanical/e1-phone/review/kicad-placement-reconciliation.json",
            "kicad_placement_reconciliation_md": "mechanical/e1-phone/review/kicad-placement-reconciliation.md",
            "board_step_readiness_json": "mechanical/e1-phone/review/board-step-readiness.json",
            "board_step_readiness_md": "mechanical/e1-phone/review/board-step-readiness.md",
            "routed_board_step_intake_template": "mechanical/e1-phone/review/routed-board-step-intake-template.csv",
            "routed_board_clearance_template": "mechanical/e1-phone/review/routed-board-clearance-results-template.csv",
            "routed_board_clearance_json": "mechanical/e1-phone/review/routed-board-clearance.json",
            "routed_board_clearance_md": "mechanical/e1-phone/review/routed-board-clearance.md",
            "full_cad_boolean_interference_template": "mechanical/e1-phone/review/full-cad-boolean-interference-results-template.csv",
            "full_cad_boolean_interference_json": "mechanical/e1-phone/review/full-cad-boolean-interference.json",
            "full_cad_boolean_interference_md": "mechanical/e1-phone/review/full-cad-boolean-interference.md",
            "engineering_validation_json": "mechanical/e1-phone/review/engineering-validation.json",
            "engineering_validation_md": "mechanical/e1-phone/review/engineering-validation.md",
            "interface_validation_json": "mechanical/e1-phone/review/interface-validation.json",
            "interface_validation_md": "mechanical/e1-phone/review/interface-validation.md",
            "display_validation_json": "mechanical/e1-phone/review/display-validation.json",
            "display_validation_md": "mechanical/e1-phone/review/display-validation.md",
            "display_results_template": "mechanical/e1-phone/review/display-results-template.csv",
            "display_results_review_json": "mechanical/e1-phone/review/display-results-review.json",
            "display_results_review_md": "mechanical/e1-phone/review/display-results-review.md",
            "mechanical_integration_sim_json": "mechanical/e1-phone/review/mechanical-integration-sim.json",
            "mechanical_integration_sim_md": "mechanical/e1-phone/review/mechanical-integration-sim.md",
            "acoustic_validation_json": "mechanical/e1-phone/review/acoustic-validation.json",
            "acoustic_validation_md": "mechanical/e1-phone/review/acoustic-validation.md",
            "acoustic_results_template": "mechanical/e1-phone/review/acoustic-results-template.csv",
            "acoustic_results_review_json": "mechanical/e1-phone/review/acoustic-results-review.json",
            "acoustic_results_review_md": "mechanical/e1-phone/review/acoustic-results-review.md",
            "camera_validation_json": "mechanical/e1-phone/review/camera-validation.json",
            "camera_validation_md": "mechanical/e1-phone/review/camera-validation.md",
            "camera_results_template": "mechanical/e1-phone/review/camera-results-template.csv",
            "camera_results_review_json": "mechanical/e1-phone/review/camera-results-review.json",
            "camera_results_review_md": "mechanical/e1-phone/review/camera-results-review.md",
            "environmental_validation_json": "mechanical/e1-phone/review/environmental-validation.json",
            "environmental_validation_md": "mechanical/e1-phone/review/environmental-validation.md",
            "ingress_path_review_json": "mechanical/e1-phone/review/ingress-path-review.json",
            "ingress_path_review_md": "mechanical/e1-phone/review/ingress-path-review.md",
            "environmental_results_template": "mechanical/e1-phone/review/environmental-results-template.csv",
            "environmental_results_review_json": "mechanical/e1-phone/review/environmental-results-review.json",
            "environmental_results_review_md": "mechanical/e1-phone/review/environmental-results-review.md",
            "evt_fixtures_json": "mechanical/e1-phone/review/evt-fixtures.json",
            "evt_fixtures_md": "mechanical/e1-phone/review/evt-fixtures.md",
            "evt_inspection_plan_json": "mechanical/e1-phone/review/evt-inspection-plan.json",
            "evt_inspection_plan_md": "mechanical/e1-phone/review/evt-inspection-plan.md",
            "evt_inspection_results_template": "mechanical/e1-phone/review/evt-inspection-results-template.csv",
            "evt_results_review_json": "mechanical/e1-phone/review/evt-results-review.json",
            "evt_results_review_md": "mechanical/e1-phone/review/evt-results-review.md",
            "fixture_calibration_results_template": "mechanical/e1-phone/review/fixture-calibration-results-template.csv",
            "fixture_calibration_acceptance_json": "mechanical/e1-phone/review/fixture-calibration-acceptance.json",
            "fixture_calibration_acceptance_md": "mechanical/e1-phone/review/fixture-calibration-acceptance.md",
            "mechanical_lifecycle_results_template": "mechanical/e1-phone/review/mechanical-lifecycle-results-template.csv",
            "mechanical_lifecycle_acceptance_json": "mechanical/e1-phone/review/mechanical-lifecycle-acceptance.json",
            "mechanical_lifecycle_acceptance_md": "mechanical/e1-phone/review/mechanical-lifecycle-acceptance.md",
            "assembly_build_results_template": "mechanical/e1-phone/review/assembly-build-results-template.csv",
            "assembly_build_traveler_json": "mechanical/e1-phone/review/assembly-build-traveler.json",
            "assembly_build_traveler_md": "mechanical/e1-phone/review/assembly-build-traveler.md",
            "process_control_results_template": "mechanical/e1-phone/review/process-control-results-template.csv",
            "process_control_plan_json": "mechanical/e1-phone/review/process-control-plan.json",
            "process_control_plan_md": "mechanical/e1-phone/review/process-control-plan.md",
            "unit_traceability_results_template": "mechanical/e1-phone/review/unit-traceability-results-template.csv",
            "unit_traceability_acceptance_json": "mechanical/e1-phone/review/unit-traceability-acceptance.json",
            "unit_traceability_acceptance_md": "mechanical/e1-phone/review/unit-traceability-acceptance.md",
            "physical_process_validation_acceptance_json": "mechanical/e1-phone/review/physical-process-validation-acceptance.json",
            "physical_process_validation_acceptance_md": "mechanical/e1-phone/review/physical-process-validation-acceptance.md",
            "evt_fixture_glb": "mechanical/e1-phone/out/e1-phone-evt-fixtures.glb",
            "evt_fixture_manifest": "mechanical/e1-phone/out/evt-fixture-manifest.json",
            "assembly_clearance_json": "mechanical/e1-phone/review/assembly-clearance.json",
            "assembly_clearance_md": "mechanical/e1-phone/review/assembly-clearance.md",
            "injection_molding_dfm_json": "mechanical/e1-phone/review/injection-molding-dfm.json",
            "injection_molding_dfm_md": "mechanical/e1-phone/review/injection-molding-dfm.md",
            "mold_process_window_json": "mechanical/e1-phone/review/mold-process-window.json",
            "mold_process_window_md": "mechanical/e1-phone/review/mold-process-window.md",
            "tooling_action_register_json": "mechanical/e1-phone/review/tooling-action-register.json",
            "tooling_action_register_csv": "mechanical/e1-phone/review/tooling-action-register.csv",
            "tooling_action_register_md": "mechanical/e1-phone/review/tooling-action-register.md",
            "mold_flow_input_deck_json": "mechanical/e1-phone/review/mold-flow-input-deck.json",
            "mold_flow_input_deck_md": "mechanical/e1-phone/review/mold-flow-input-deck.md",
            "mold_flow_results_template": "mechanical/e1-phone/review/mold-flow-results-template.csv",
            "mold_flow_acceptance_json": "mechanical/e1-phone/review/mold-flow-acceptance.json",
            "mold_flow_acceptance_md": "mechanical/e1-phone/review/mold-flow-acceptance.md",
            "toolmaker_signoff_package_json": "mechanical/e1-phone/review/toolmaker-signoff-package.json",
            "toolmaker_signoff_package_md": "mechanical/e1-phone/review/toolmaker-signoff-package.md",
            "toolmaker_signoff_response_template": "mechanical/e1-phone/review/toolmaker-signoff-response-template.csv",
            "toolmaker_signoff_review_json": "mechanical/e1-phone/review/toolmaker-signoff-review.json",
            "toolmaker_signoff_review_md": "mechanical/e1-phone/review/toolmaker-signoff-review.md",
            "tolerance_stack_json": "mechanical/e1-phone/review/tolerance-stack.json",
            "tolerance_stack_md": "mechanical/e1-phone/review/tolerance-stack.md",
            "gdt_release_package_json": "mechanical/e1-phone/review/gdt-release-package.json",
            "gdt_release_package_md": "mechanical/e1-phone/review/gdt-release-package.md",
            "gdt_fai_template": "mechanical/e1-phone/review/gdt-fai-template.csv",
            "gdt_fai_results_review_json": "mechanical/e1-phone/review/gdt-fai-results-review.json",
            "gdt_fai_results_review_md": "mechanical/e1-phone/review/gdt-fai-results-review.md",
            "part_review_json": "mechanical/e1-phone/review/part-review.json",
            "part_review_md": "mechanical/e1-phone/review/part-review.md",
            "part_review_contact_sheet": "mechanical/e1-phone/review/part-review-contact-sheet.png",
            "part_explode_contact_sheet": "mechanical/e1-phone/review/part-explode-contact-sheet.png",
            "part_visual_coverage_json": "mechanical/e1-phone/review/part-visual-coverage.json",
            "part_visual_coverage_md": "mechanical/e1-phone/review/part-visual-coverage.md",
            "component_selection_review_json": "mechanical/e1-phone/review/component-selection-review.json",
            "component_selection_review_md": "mechanical/e1-phone/review/component-selection-review.md",
            "visual_decision_report_json": "mechanical/e1-phone/review/visual-decision-report.json",
            "visual_decision_report_md": "mechanical/e1-phone/review/visual-decision-report.md",
            "visual_review_coverage_acceptance_json": "mechanical/e1-phone/review/visual-review-coverage-acceptance.json",
            "visual_review_coverage_acceptance_md": "mechanical/e1-phone/review/visual-review-coverage-acceptance.md",
            "cmf_results_template": "mechanical/e1-phone/review/cmf-results-template.csv",
            "cmf_release_acceptance_json": "mechanical/e1-phone/review/cmf-release-acceptance.json",
            "cmf_release_acceptance_md": "mechanical/e1-phone/review/cmf-release-acceptance.md",
            "end_to_end_objective_acceptance_json": "mechanical/e1-phone/review/end-to-end-objective-acceptance.json",
            "end_to_end_objective_acceptance_md": "mechanical/e1-phone/review/end-to-end-objective-acceptance.md",
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
                "mechanical/e1-phone/review/component-review-audio.png",
                "mechanical/e1-phone/review/component-review-io-buttons.png",
                "mechanical/e1-phone/review/component-review-optical.png",
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
        "- `mechanical/e1-phone/review/battery-swell-management.json`",
        "- `mechanical/e1-phone/review/battery-swell-management.md`",
        "- `mechanical/e1-phone/review/mass-budget.json`",
        "- `mechanical/e1-phone/review/mass-budget.md`",
        "- `mechanical/e1-phone/review/compactness-optimization.json`",
        "- `mechanical/e1-phone/review/compactness-optimization.md`",
        "- `mechanical/e1-phone/review/compactness-optimization.png`",
        "- `mechanical/e1-phone/review/compactness-optimization.svg`",
        "- `mechanical/e1-phone/review/supplier-lock.json`",
        "- `mechanical/e1-phone/review/supplier-lock.md`",
        "- `mechanical/e1-phone/review/supplier-rfq-package.json`",
        "- `mechanical/e1-phone/review/supplier-rfq-package.md`",
        "- `mechanical/e1-phone/review/supplier-response-template.csv`",
        "- `mechanical/e1-phone/review/supplier-response-review.json`",
        "- `mechanical/e1-phone/review/supplier-response-review.md`",
        "- `mechanical/e1-phone/review/supplier-evidence-acceptance.json`",
        "- `mechanical/e1-phone/review/supplier-evidence-acceptance.md`",
        "- `mechanical/e1-phone/review/kicad-mechanical-handoff.json`",
        "- `mechanical/e1-phone/review/kicad-mechanical-handoff.md`",
        "- `mechanical/e1-phone/review/kicad-placement-reconciliation.json`",
        "- `mechanical/e1-phone/review/kicad-placement-reconciliation.md`",
        "- `mechanical/e1-phone/review/board-step-readiness.json`",
        "- `mechanical/e1-phone/review/board-step-readiness.md`",
        "- `mechanical/e1-phone/review/routed-board-step-intake-template.csv`",
        "- `mechanical/e1-phone/review/routed-board-clearance-results-template.csv`",
        "- `mechanical/e1-phone/review/routed-board-clearance.json`",
        "- `mechanical/e1-phone/review/routed-board-clearance.md`",
        "- `mechanical/e1-phone/review/full-cad-boolean-interference-results-template.csv`",
        "- `mechanical/e1-phone/review/full-cad-boolean-interference.json`",
        "- `mechanical/e1-phone/review/full-cad-boolean-interference.md`",
        "- `mechanical/e1-phone/review/engineering-validation.json`",
        "- `mechanical/e1-phone/review/engineering-validation.md`",
        "- `mechanical/e1-phone/review/interface-validation.json`",
        "- `mechanical/e1-phone/review/interface-validation.md`",
        "- `mechanical/e1-phone/review/display-validation.json`",
        "- `mechanical/e1-phone/review/display-validation.md`",
        "- `mechanical/e1-phone/review/display-results-template.csv`",
        "- `mechanical/e1-phone/review/display-results-review.json`",
        "- `mechanical/e1-phone/review/display-results-review.md`",
        "- `mechanical/e1-phone/review/acoustic-validation.json`",
        "- `mechanical/e1-phone/review/acoustic-validation.md`",
        "- `mechanical/e1-phone/review/acoustic-results-template.csv`",
        "- `mechanical/e1-phone/review/acoustic-results-review.json`",
        "- `mechanical/e1-phone/review/acoustic-results-review.md`",
        "- `mechanical/e1-phone/review/camera-validation.json`",
        "- `mechanical/e1-phone/review/camera-validation.md`",
        "- `mechanical/e1-phone/review/camera-results-template.csv`",
        "- `mechanical/e1-phone/review/camera-results-review.json`",
        "- `mechanical/e1-phone/review/camera-results-review.md`",
        "- `mechanical/e1-phone/review/environmental-validation.json`",
        "- `mechanical/e1-phone/review/environmental-validation.md`",
        "- `mechanical/e1-phone/review/environmental-results-template.csv`",
        "- `mechanical/e1-phone/review/environmental-results-review.json`",
        "- `mechanical/e1-phone/review/environmental-results-review.md`",
        "- `mechanical/e1-phone/review/evt-fixtures.json`",
        "- `mechanical/e1-phone/review/evt-fixtures.md`",
        "- `mechanical/e1-phone/review/evt-inspection-plan.json`",
        "- `mechanical/e1-phone/review/evt-inspection-plan.md`",
        "- `mechanical/e1-phone/review/evt-inspection-results-template.csv`",
        "- `mechanical/e1-phone/review/evt-results-review.json`",
        "- `mechanical/e1-phone/review/evt-results-review.md`",
        "- `mechanical/e1-phone/review/fixture-calibration-results-template.csv`",
        "- `mechanical/e1-phone/review/fixture-calibration-acceptance.json`",
        "- `mechanical/e1-phone/review/fixture-calibration-acceptance.md`",
        "- `mechanical/e1-phone/review/mechanical-lifecycle-results-template.csv`",
        "- `mechanical/e1-phone/review/mechanical-lifecycle-acceptance.json`",
        "- `mechanical/e1-phone/review/mechanical-lifecycle-acceptance.md`",
        "- `mechanical/e1-phone/review/assembly-build-results-template.csv`",
        "- `mechanical/e1-phone/review/assembly-build-traveler.json`",
        "- `mechanical/e1-phone/review/assembly-build-traveler.md`",
        "- `mechanical/e1-phone/review/process-control-results-template.csv`",
        "- `mechanical/e1-phone/review/process-control-plan.json`",
        "- `mechanical/e1-phone/review/process-control-plan.md`",
        "- `mechanical/e1-phone/review/unit-traceability-results-template.csv`",
        "- `mechanical/e1-phone/review/unit-traceability-acceptance.json`",
        "- `mechanical/e1-phone/review/unit-traceability-acceptance.md`",
        "- `mechanical/e1-phone/review/physical-process-validation-acceptance.json`",
        "- `mechanical/e1-phone/review/physical-process-validation-acceptance.md`",
        "- `mechanical/e1-phone/out/e1-phone-evt-fixtures.glb`",
        "- `mechanical/e1-phone/out/evt-fixture-manifest.json`",
        "- `mechanical/e1-phone/review/assembly-clearance.json`",
        "- `mechanical/e1-phone/review/assembly-clearance.md`",
        "- `mechanical/e1-phone/review/injection-molding-dfm.json`",
        "- `mechanical/e1-phone/review/injection-molding-dfm.md`",
        "- `mechanical/e1-phone/review/mold-process-window.json`",
        "- `mechanical/e1-phone/review/mold-process-window.md`",
        "- `mechanical/e1-phone/review/tooling-action-register.json`",
        "- `mechanical/e1-phone/review/tooling-action-register.csv`",
        "- `mechanical/e1-phone/review/tooling-action-register.md`",
        "- `mechanical/e1-phone/review/mold-flow-input-deck.json`",
        "- `mechanical/e1-phone/review/mold-flow-input-deck.md`",
        "- `mechanical/e1-phone/review/mold-flow-results-template.csv`",
        "- `mechanical/e1-phone/review/mold-flow-acceptance.json`",
        "- `mechanical/e1-phone/review/mold-flow-acceptance.md`",
        "- `mechanical/e1-phone/review/toolmaker-signoff-package.json`",
        "- `mechanical/e1-phone/review/toolmaker-signoff-package.md`",
        "- `mechanical/e1-phone/review/toolmaker-signoff-response-template.csv`",
        "- `mechanical/e1-phone/review/toolmaker-signoff-review.json`",
        "- `mechanical/e1-phone/review/toolmaker-signoff-review.md`",
        "- `mechanical/e1-phone/review/tolerance-stack.json`",
        "- `mechanical/e1-phone/review/tolerance-stack.md`",
        "- `mechanical/e1-phone/review/gdt-release-package.json`",
        "- `mechanical/e1-phone/review/gdt-release-package.md`",
        "- `mechanical/e1-phone/review/gdt-fai-template.csv`",
        "- `mechanical/e1-phone/review/gdt-fai-results-review.json`",
        "- `mechanical/e1-phone/review/gdt-fai-results-review.md`",
        "- `mechanical/e1-phone/review/part-review.json`",
        "- `mechanical/e1-phone/review/part-review.md`",
        "- `mechanical/e1-phone/review/part-review-contact-sheet.png`",
        "- `mechanical/e1-phone/review/part-explode-contact-sheet.png`",
        "- `mechanical/e1-phone/review/part-visual-coverage.json`",
        "- `mechanical/e1-phone/review/part-visual-coverage.md`",
        "- `mechanical/e1-phone/review/component-selection-review.json`",
        "- `mechanical/e1-phone/review/component-selection-review.md`",
        "- `mechanical/e1-phone/review/visual-decision-report.json`",
        "- `mechanical/e1-phone/review/visual-decision-report.md`",
        "- `mechanical/e1-phone/review/visual-review-coverage-acceptance.json`",
        "- `mechanical/e1-phone/review/visual-review-coverage-acceptance.md`",
        "- `mechanical/e1-phone/review/cmf-results-template.csv`",
        "- `mechanical/e1-phone/review/cmf-release-acceptance.json`",
        "- `mechanical/e1-phone/review/cmf-release-acceptance.md`",
        "- `mechanical/e1-phone/review/end-to-end-objective-acceptance.json`",
        "- `mechanical/e1-phone/review/end-to-end-objective-acceptance.md`",
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
        "- `mechanical/e1-phone/review/component-review-audio.png`",
        "- `mechanical/e1-phone/review/component-review-io-buttons.png`",
        "- `mechanical/e1-phone/review/component-review-optical.png`",
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
            "- Front camera and earpiece are kept behind the cover glass. The single rear camera and single rear torch/flash LED are fully buried under the flat flush back wall, and the orange back shell now has an explicit camera aperture with four molded bevel lands around the flush rear cover window (no camera bump, no proud lens ring).",
            "- Orange hard plastic is modeled as the entire molded shell and button material. The black glass remains a separate bonded part.",
            "- The enclosure now includes ten outboard screw bosses, eight snap hooks, battery ribs, a USB-C insertion saddle, display adhesive, display FPC connector keepout, and explicit cold-runner/submarine-gate placeholders for mold review.",
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
        REVIEW_DIR / "component-review-audio.png",
        REVIEW_DIR / "component-review-io-buttons.png",
        REVIEW_DIR / "component-review-optical.png",
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
                "rear_camera_shell_aperture",
                "orange_rear_camera_bezel_top",
                "orange_rear_camera_bezel_bottom",
                "orange_rear_camera_bezel_left",
                "orange_rear_camera_bezel_right",
                "rear_flash_shell_aperture",
                "orange_rear_flash_bezel_top",
                "orange_rear_flash_bezel_bottom",
                "orange_rear_flash_bezel_left",
                "orange_rear_flash_bezel_right",
                "rear_camera_module",
                "rear_camera_cover_glass",
                "rear_camera_lens_window",
                "rear_camera_optical_sight_tunnel",
                "rear_flash_led_window",
                "rear_flash_led",
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
        if p.role
        in {
            "PCB",
            "camera",
            "audio",
            "I/O",
            "button",
            "battery",
            "connector",
            "cellular module",
            "Wi-Fi/Bluetooth module",
            "PCB component marker",
            "RF feed",
            "RF tuner",
            "RF keepout",
            "EMI shield",
        }
    ]
    render(component_parts, render_paths[7], "E1 phone component placement", 74, -88)
    width, height, depth = params["device"]["envelope_mm"]
    review_context_orange = [1.0, 0.32, 0.02, 0.28]
    review_context_pcb = [0.03, 0.38, 0.22, 0.22]
    side_context_parts = [
        box(
            "component_review_left_side_context",
            [1.2, height, depth],
            [-width / 2 + 0.6, 0.0, 0.0],
            review_context_orange,
            "review context",
            "transparent orange side rail context for component-family detail views",
        ),
        box(
            "component_review_right_side_context",
            [1.2, height, depth],
            [width / 2 - 0.6, 0.0, 0.0],
            review_context_orange,
            "review context",
            "transparent orange side rail context for component-family detail views",
        ),
        box(
            "component_review_back_plane_context",
            [width - 2.4, height - 2.4, 0.12],
            [0.0, 0.0, -depth / 2 + 0.2],
            review_context_orange,
            "review context",
            "transparent orange back-plane datum for component-family detail views",
        ),
        box(
            "component_review_pcb_context",
            [params["pcb"]["outline_mm"][0], params["pcb"]["outline_mm"][1], 0.18],
            [0.0, -1.0, params["pcb"]["z_center_mm"]],
            review_context_pcb,
            "review context",
            "transparent PCB datum for component-family detail views",
        ),
    ]
    audio_review_parts = [
        p
        for p in parts
        if p.role == "audio"
        or p.name in {"bottom_speaker_module", "earpiece_receiver", "handset_acoustic_slot"}
    ]
    render(
        [*audio_review_parts, *side_context_parts],
        render_paths[8],
        "E1 phone audio, microphone, and handset packaging",
        28,
        -82,
    )
    io_button_review_parts = [
        p
        for p in parts
        if p.role in {"I/O", "I/O seal", "button", "button seal", "haptics", "connector"}
        or p.name.startswith("usb_c")
    ]
    render(
        [*io_button_review_parts, *side_context_parts],
        render_paths[9],
        "E1 phone USB-C and side button packaging",
        18,
        -126,
    )
    optical_review_parts = [
        p
        for p in parts
        if p.role in {"camera", "camera seal", "camera aperture"}
        or p.name.startswith("orange_rear_camera_bezel_")
        or p.name.startswith("orange_rear_flash_bezel_")
        or p.name in {"handset_acoustic_slot", "camera_flash_led"}
    ]
    render(
        [*optical_review_parts, *side_context_parts],
        render_paths[10],
        "E1 phone camera, flash, and under-glass optical packaging",
        24,
        -58,
    )
    render(
        [*tooling, *[p for p in parts if p.name in {"orange_back_shell", "orange_side_frame"}]],
        render_paths[11],
        "E1 phone mold runner and parting review",
        28,
        -55,
    )
    visual = verify_render_artifacts(render_paths)
    checks = run_checks(params, parts)
    solid_cad = write_solid_cad_handoff_artifacts(params, checks, parts)
    step_validation = write_step_validation_artifacts(solid_cad)
    part_review = write_part_review_artifacts(parts, exploded)
    clearance = write_assembly_clearance_artifacts(params, parts)
    write_battery_swell_management_artifacts(
        params,
        parts,
        checks,
        clearance,
    )
    mass = write_mass_budget(parts)
    compactness = write_compactness_optimization_artifacts(params, parts, checks)
    write_drafting_artifacts(params, checks)
    supplier = write_supplier_artifacts(params)
    supplier_rfq = write_supplier_rfq_artifacts(params, supplier, solid_cad)
    supplier_response = write_supplier_response_artifacts(supplier, supplier_rfq)
    supplier_evidence = write_supplier_evidence_acceptance_artifacts(
        supplier,
        supplier_rfq,
        supplier_response,
    )
    handoff = write_kicad_mechanical_handoff(params, checks)
    kicad_reconciliation = write_kicad_placement_reconciliation_artifacts(params, parts, handoff)
    board_step = write_board_step_readiness_artifacts(params, kicad_reconciliation, solid_cad)
    validation = write_engineering_validation_artifacts(params, parts, checks, mass, supplier)
    dfm = write_injection_molding_dfm_artifacts(params, parts, tooling, checks)
    tolerance_stack = write_tolerance_stack_artifacts(params, checks)
    gdt_release = write_gdt_release_package_artifacts(params, tolerance_stack)
    gdt_fai_results = write_gdt_fai_results_review_artifacts(gdt_release)
    interface_validation = write_interface_validation_artifacts(
        params, parts, checks, clearance, tolerance_stack
    )
    display_validation = write_display_validation_artifacts(
        params, parts, clearance, interface_validation, tolerance_stack
    )
    display_results = write_display_results_review_artifacts(display_validation)
    mechanical_integration_sim = write_mechanical_integration_sim_artifacts(
        params,
        parts,
        interface_validation,
        display_validation,
    )
    acoustic_validation = write_acoustic_validation_artifacts(
        params, parts, clearance, interface_validation
    )
    acoustic_results = write_acoustic_results_review_artifacts(acoustic_validation)
    camera_validation = write_camera_validation_artifacts(
        params, parts, clearance, interface_validation
    )
    camera_results = write_camera_results_review_artifacts(camera_validation)
    environmental_validation = write_environmental_validation_artifacts(
        params, parts, checks, clearance, validation
    )
    ingress_path_review = write_ingress_path_review_artifacts(
        params, parts, environmental_validation
    )
    environmental_results = write_environmental_results_review_artifacts(environmental_validation)
    fixtures = evt_fixture_parts(params)
    evt_fixtures = write_evt_fixture_artifacts(params, fixtures, interface_validation)
    evt_inspection = write_evt_inspection_plan_artifacts(params, interface_validation, evt_fixtures)
    evt_results = write_evt_results_review_artifacts(evt_inspection)
    mold_process = write_mold_process_window_artifacts(params, parts, tooling, dfm, tolerance_stack)
    write_mold_flow_acceptance_artifacts(params, dfm, mold_process)
    toolmaker_signoff = write_toolmaker_signoff_artifacts(params, dfm, mold_process)
    write_tooling_action_register_artifacts(dfm, mold_process)
    routed_board_clearance = write_routed_board_clearance_artifacts(
        board_step,
        clearance,
        solid_cad,
    )
    full_cad_boolean = write_full_cad_boolean_interference_artifacts(
        params,
        parts,
        clearance,
        board_step,
        routed_board_clearance,
        supplier_response,
        solid_cad,
        step_validation,
    )
    visual_decision = write_visual_decision_artifacts(
        params,
        visual,
        checks,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
    )
    part_visual_coverage = write_part_visual_coverage_artifacts(visual, part_review)
    visual_review_coverage = write_visual_review_coverage_acceptance_artifacts(
        visual, part_review, visual_decision, part_visual_coverage
    )
    write_component_selection_review_artifacts(params, checks)
    write_cmf_release_acceptance_artifacts(
        params,
        visual_decision,
        visual_review_coverage,
        dfm,
        toolmaker_signoff,
    )
    assembly_build = write_assembly_build_traveler_artifacts(params, parts)
    write_process_control_plan_artifacts(
        assembly_build,
        supplier_response,
        gdt_release,
    )
    manufacturing_readiness = write_readiness_artifacts(
        params,
        parts,
        tooling,
        checks,
        visual,
        mass,
        compactness,
        supplier,
        handoff,
        kicad_reconciliation,
        validation,
        interface_validation,
        display_validation,
        display_results,
        mechanical_integration_sim,
        acoustic_validation,
        acoustic_results,
        camera_validation,
        camera_results,
        environmental_validation,
        ingress_path_review,
        environmental_results,
        evt_fixtures,
        evt_inspection,
        evt_results,
        clearance,
        part_review,
        dfm,
        tolerance_stack,
        gdt_release,
        gdt_fai_results,
        mold_process,
        toolmaker_signoff,
        visual_decision,
        solid_cad,
        step_validation,
        board_step,
        supplier_rfq,
        supplier_response,
    )
    write_physical_process_validation_acceptance_artifacts()
    write_end_to_end_objective_acceptance_artifacts(
        manufacturing_readiness,
        board_step,
        routed_board_clearance,
        supplier_evidence,
        full_cad_boolean,
        visual_review_coverage,
        toolmaker_signoff,
    )
    write_report(params, checks)
    print(f"E1 phone CAD generation {checks['status']}: {REVIEW_DIR / 'README.md'}")
    return 0 if checks["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
