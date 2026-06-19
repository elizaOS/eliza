#!/usr/bin/env python3
"""Generate concept layout utilization metrics from the KiCad PCB geometry."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PCB = ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"
OUT = ROOT / "board/kicad/e1-phone/layout-utilization.yaml"

RECT_RE = re.compile(
    r"\(gr_rect\s+\(start\s+([-0-9.]+)\s+([-0-9.]+)\)\s+"
    r'\(end\s+([-0-9.]+)\s+([-0-9.]+)\).*?\(layer\s+"([^"]+)"\)',
    re.DOTALL,
)


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


@dataclass(frozen=True)
class Rect:
    layer: str
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return abs(self.x1 - self.x0)

    @property
    def height(self) -> float:
        return abs(self.y1 - self.y0)

    @property
    def area(self) -> float:
        return self.width * self.height

    @property
    def center(self) -> tuple[float, float]:
        return ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)


def round2(value: float) -> float:
    return round(value + 0.0, 2)


def overlap_area(a: Rect, b: Rect) -> float:
    ax0, ax1 = sorted((a.x0, a.x1))
    ay0, ay1 = sorted((a.y0, a.y1))
    bx0, bx1 = sorted((b.x0, b.x1))
    by0, by1 = sorted((b.y0, b.y1))
    width = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    height = max(0.0, min(ay1, by1) - max(ay0, by0))
    return width * height


def classify_fab_rect(rect: Rect) -> str:
    cx, cy = rect.center
    if cy < 34 and cx < 19:
        return "cellular_rf_module"
    if cy < 27 and cx < 35:
        return "soc_lpddr"
    if cy < 31 and cx < 46:
        return "pmic"
    if cy < 34:
        return "display_camera_ffc"
    if cy < 31:
        return "wifi_bt_or_midboard_module"
    if cx < 31 and cy < 31:
        return "side_keys_and_flex"
    if cy >= 123:
        return "usb_c_receptacle"
    if cy >= 117:
        return "bottom_audio_haptic_speaker"
    return "unclassified"


def parse_rects() -> list[Rect]:
    text = PCB.read_text()
    rects = []
    for match in RECT_RE.finditer(text):
        x0, y0, x1, y1, layer = match.groups()
        rects.append(Rect(layer=layer, x0=float(x0), y0=float(y0), x1=float(x1), y1=float(y1)))
    return rects


def main() -> int:
    rects = parse_rects()
    edge_rects = [rect for rect in rects if rect.layer == "Edge.Cuts"]
    if len(edge_rects) not in {1, 2}:
        raise SystemExit(
            f"expected one or two rectangular Edge.Cuts outlines, found {len(edge_rects)}"
        )
    min_x = min(min(rect.x0, rect.x1) for rect in edge_rects)
    min_y = min(min(rect.y0, rect.y1) for rect in edge_rects)
    max_x = max(max(rect.x0, rect.x1) for rect in edge_rects)
    max_y = max(max(rect.y0, rect.y1) for rect in edge_rects)
    board_bbox_area = (max_x - min_x) * (max_y - min_y)
    edge_area = sum(rect.area for rect in edge_rects)

    fab_rects = [rect for rect in rects if rect.layer == "F.Fab"]
    dwgs_rects = [rect for rect in rects if rect.layer == "Dwgs.User"]
    battery = max(dwgs_rects, key=lambda rect: rect.area)
    antenna_keepouts = [
        rect
        for rect in dwgs_rects
        if rect is not battery
        and not any(overlap_area(rect, fab) >= rect.area * 0.98 for fab in fab_rects)
    ]

    fab_by_class: dict[str, float] = {}
    for rect in fab_rects:
        kind = classify_fab_rect(rect)
        fab_by_class[kind] = fab_by_class.get(kind, 0.0) + rect.area

    board_area = board_bbox_area
    battery_area = battery.area
    antenna_area = sum(
        overlap_area(rect, island) for rect in antenna_keepouts for island in edge_rects
    )
    physical_pcb_area = edge_area
    placement_area = physical_pcb_area - antenna_area
    occupied_area = sum(fab_by_class.values())
    route_shield_test_reserve = placement_area - occupied_area
    reserve_pct = route_shield_test_reserve * 100.0 / placement_area
    if route_shield_test_reserve < 0:
        pressure_status = "blocked_concept_footprints_exceed_top_bottom_island_area"
        interpretation = (
            "Reserve is negative because the full-width 64 x 87 mm battery cavity "
            "leaves only top/bottom island area and the current F.Fab concept "
            "rectangles no longer fit. Real placement must move side-key/service "
            "functions to flex or reduce footprint area before routing."
        )
    elif reserve_pct > 50.0:
        pressure_status = "concept_floorplan_sparse_not_fabrication_evidence"
        interpretation = (
            "Reserve above target indicates the current PCB is still a floorplan. "
            "Real footprints, shields, test pads, via fields, RF clearances, and "
            "speaker/camera mechanical detail must consume this reserve before "
            "fabrication readiness can be claimed."
        )
    else:
        pressure_status = "concept_area_pressure_plausible_not_routed"
        interpretation = (
            "Concept area pressure is plausible, but this is still not routed-board "
            "evidence until supplier footprints, courtyards, DRC, and STEP exist."
        )

    report = {
        "schema": "eliza.e1_phone_layout_utilization.v1",
        "status": pressure_status,
        "source_pcb": "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb",
        "claim_boundary": (
            "Derived from gr_rect concept geometry only. This is not a routed-board "
            "component courtyard, DRC, DFM, SI, RF, or enclosure-readiness result."
        ),
        "board_bbox_mm": {
            "width": round2(max_x - min_x),
            "height": round2(max_y - min_y),
            "area_mm2": round2(board_area),
        },
        "edge_cut_islands": [
            {
                "x": round2(min(rect.x0, rect.x1)),
                "y": round2(min(rect.y0, rect.y1)),
                "width": round2(rect.width),
                "height": round2(rect.height),
                "area_mm2": round2(rect.area),
            }
            for rect in edge_rects
        ],
        "physical_pcb_area_from_edge_cuts_mm2": round2(edge_area),
        "battery_window_mm": {
            "x": round2(min(battery.x0, battery.x1)),
            "y": round2(min(battery.y0, battery.y1)),
            "width": round2(battery.width),
            "height": round2(battery.height),
            "area_mm2": round2(battery_area),
        },
        "antenna_keepout_area_mm2": round2(antenna_area),
        "physical_pcb_area_after_battery_window_mm2": round2(physical_pcb_area),
        "placement_area_after_battery_and_antenna_keepouts_mm2": round2(placement_area),
        "fab_region_area_by_class_mm2": {
            key: round2(value) for key, value in sorted(fab_by_class.items())
        },
        "fab_region_total_area_mm2": round2(occupied_area),
        "route_shield_test_reserve_area_mm2": round2(route_shield_test_reserve),
        "route_shield_test_reserve_pct_of_placement_area": round2(reserve_pct),
        "layout_pressure_assessment": {
            "target_reserve_pct_range_after_real_footprints": {"min": 35.0, "max": 50.0},
            "current_concept_reserve_pct": round2(reserve_pct),
            "interpretation": interpretation,
        },
        "required_next_evidence": [
            "replace F.Fab rectangles with supplier footprints and courtyards",
            "compute courtyard utilization from KiCad footprints",
            "replace split-island rectangular Edge.Cuts concept with routed rigid or rigid-flex board outline",
            "assign net classes and run DRC after routing",
            "prove antenna/rf keepouts against enclosure metal and display stack",
            "prove USB-C, side button, camera, speaker, and battery mechanical interfaces in STEP",
        ],
    }

    OUT.write_text(yaml.dump(report, Dumper=IndentedSafeDumper, sort_keys=False))
    print(f"generated {OUT}")
    print(f"placement reserve={reserve_pct:.2f}% source={PCB}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
