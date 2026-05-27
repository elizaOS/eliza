#!/usr/bin/env python3
"""Build an explorable silicon-layout viewer from OpenLane/OpenROAD DEF output."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "build" / "chip-visualizer"
VIEWER_HTML = ROOT / "docs" / "pd" / "chip-viewer" / "index.html"
KLAYOUT = ROOT / "external" / "deb-tools" / "klayout-0.30.8" / "usr" / "bin" / "klayout"
KLAYOUT_LIB = ROOT / "external" / "deb-tools" / "klayout-0.30.8" / "usr" / "lib" / "klayout"
KLAYOUT_DEPS = ROOT / "external" / "deb-tools" / "klayout-0.30.8" / "usr" / "lib" / "x86_64-linux-gnu"
GDS_RENDER_SCRIPT = ROOT / "scripts" / "render_gds_preview.py"
KLAYOUT_STREAM_OUT = ROOT / "external" / "openlane2" / "openlane" / "scripts" / "klayout" / "stream_out.py"
OPENLANE_PYTHON = ROOT / "external" / "openlane2" / ".venv" / "bin" / "python"
VOLARE_SKY130 = ROOT / "external" / "pdks" / "volare" / "sky130" / "versions"
SKY130_STD_VERSION = VOLARE_SKY130 / "0fe599b2afb6708d281543108caf8310912f54af" / "sky130A"
SKY130_SRAM_VERSION = VOLARE_SKY130 / "c6d73a35f524070e85faff4a6a9eef49553ebc2b" / "sky130A"
SKY130_LYP = (
    SKY130_STD_VERSION / "libs.tech" / "klayout" / "tech" / "sky130A.lyp"
)
SKY130_LYT = SKY130_STD_VERSION / "libs.tech" / "klayout" / "tech" / "sky130A.lyt"
SKY130_LYM = SKY130_STD_VERSION / "libs.tech" / "klayout" / "tech" / "sky130A.map"
STREAMOUT_LEFS = [
    SKY130_STD_VERSION / "libs.ref" / "sky130_fd_sc_hd" / "techlef" / "sky130_fd_sc_hd__nom.tlef",
    SKY130_STD_VERSION / "libs.ref" / "sky130_fd_sc_hd" / "lef" / "sky130_ef_sc_hd.lef",
    SKY130_STD_VERSION / "libs.ref" / "sky130_fd_sc_hd" / "lef" / "sky130_fd_sc_hd.lef",
    SKY130_SRAM_VERSION / "libs.ref" / "sky130_sram_macros" / "lef" / "sky130_sram_2kbyte_1rw1r_32x512_8.lef",
]
STREAMOUT_GDS_FILES = [
    SKY130_STD_VERSION / "libs.ref" / "sky130_fd_sc_hd" / "gds" / "sky130_fd_sc_hd.gds",
    SKY130_SRAM_VERSION / "libs.ref" / "sky130_sram_macros" / "gds" / "sky130_sram_2kbyte_1rw1r_32x512_8.gds",
]


LAYER_COLORS = {
    "li1": "#a3d977",
    "met1": "#f59f4a",
    "met2": "#e4564f",
    "met3": "#7a5cff",
    "met4": "#00a878",
    "met5": "#f1d65c",
    "met6": "#c56cf0",
    "via": "#f7f1d0",
    "via2": "#f7f1d0",
    "via3": "#f7f1d0",
    "via4": "#f7f1d0",
}

DEF_POINT = r"\(\s*(?P<{x}>-?\d+|\*)\s+(?P<{y}>-?\d+|\*)\s*\)"
ROUTE_SEGMENT_RE = re.compile(
    rf"(?:\+ ROUTED|NEW)\s+(?P<layer>\S+)(?:\s+(?P<width>\d+))?[^()]*"
    rf"{DEF_POINT.format(x='x1', y='y1')}(?:\s+{DEF_POINT.format(x='x2', y='y2')})?"
)
RECT_RE = re.compile(r"\bRECT\s+\(\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\)")


@dataclass(frozen=True)
class DefSource:
    path: Path
    role: str


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path)


def choose_def() -> DefSource:
    runs = ROOT / "pd" / "openlane" / "runs"
    patterns = [
        ("*/44-openroad-detailedrouting/e1_chip_top.def", "detailed_routing_full_soc"),
        ("*/46-openroad-detailedrouting/e1_chip_top.def", "detailed_routing_full_soc"),
        ("*/final/def/e1_chip_top.def", "final_full_soc"),
        ("*/38-openroad-globalrouting/e1_chip_top.def", "global_routing_full_soc"),
        ("*/final/def/*.def", "final_available_design"),
        ("*/44-openroad-detailedrouting/*.def", "detailed_routing_available_design"),
        ("*/46-openroad-detailedrouting/*.def", "detailed_routing_available_design"),
    ]
    for pattern, role in patterns:
        matches = list(runs.glob(pattern))
        if matches:
            return DefSource(max(matches, key=lambda path: path.stat().st_mtime), role)
    raise FileNotFoundError(f"no DEF files found under {runs}")


def split_sections(lines: list[str]) -> dict[str, tuple[int, int]]:
    sections: dict[str, tuple[int, int]] = {}
    active: tuple[str, int] | None = None
    for idx, line in enumerate(lines):
        stripped = line.strip()
        token = stripped.split(" ", 1)[0] if stripped else ""
        if token in {"COMPONENTS", "PINS", "SPECIALNETS", "NETS", "VIAS"}:
            active = (token, idx)
        elif stripped.startswith("END ") and active:
            name = stripped.split(" ", 1)[1]
            if name == active[0]:
                sections[name] = (active[1], idx)
                active = None
    return sections


def parse_header(lines: list[str]) -> dict[str, Any]:
    header: dict[str, Any] = {"design": None, "units_per_micron": 1, "diearea": [0, 0, 1, 1]}
    for line in lines[:200]:
        stripped = line.strip()
        if stripped.startswith("DESIGN "):
            header["design"] = stripped.split()[1]
        elif stripped.startswith("UNITS DISTANCE MICRONS "):
            header["units_per_micron"] = int(stripped.split()[3])
        elif stripped.startswith("DIEAREA "):
            nums = [int(value) for value in re.findall(r"-?\d+", stripped)]
            if len(nums) >= 4:
                header["diearea"] = nums[:4]
    return header


def parse_rows(lines: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("ROW "):
            continue
        parts = stripped.split()
        if len(parts) < 12:
            continue
        rows.append(
            {
                "name": parts[1],
                "site": parts[2],
                "x": int(parts[3]),
                "y": int(parts[4]),
                "orient": parts[5],
                "count": int(parts[7]),
                "step_x": int(parts[11]),
                "step_y": int(parts[12]) if len(parts) > 12 else 0,
            }
        )
    return rows


def row_height(rows: list[dict[str, Any]]) -> int:
    ys = sorted({row["y"] for row in rows})
    if len(ys) > 1:
        return max(1, min(b - a for a, b in zip(ys, ys[1:], strict=False) if b > a))
    return 2720


def estimate_cell_width(master: str, site_step: int) -> int:
    if "__decap_" in master or "__fill_" in master:
        match = re.search(r"_(\d+)$", master)
        return site_step * int(match.group(1)) if match else site_step
    if "__dfrtp" in master or "__dfxtp" in master:
        return site_step * 8
    if "__clkbuf_16" in master:
        return site_step * 12
    if "__clkbuf_4" in master:
        return site_step * 5
    if "__mux" in master:
        return site_step * 4
    if "__xor" in master or "__and4" in master or "__nor4" in master:
        return site_step * 3
    return site_step * 2


def classify_component(name: str, master: str) -> str:
    text = f"{name} {master}".lower()
    if "antenna" in text or "diode" in text:
        return "antenna"
    if "fill" in text:
        return "filler"
    if "decap" in text:
        return "decap"
    if "clk" in text:
        return "clock"
    if "df" in text:
        return "register"
    return "logic"


def parse_components(lines: list[str], section: tuple[int, int] | None, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if section is None:
        return []
    site_step = min((row["step_x"] for row in rows if row["step_x"] > 0), default=460)
    height = row_height(rows)
    components: list[dict[str, Any]] = []
    for line in lines[section[0] + 1 : section[1]]:
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        match = re.match(
            r"-\s+(\S+)\s+(\S+).*?\+\s+(?:PLACED|FIXED)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+(\S+)",
            stripped,
        )
        if not match:
            continue
        name, master, x, y, orient = match.groups()
        width = estimate_cell_width(master, site_step)
        components.append(
            {
                "name": name,
                "master": master,
                "x": int(x),
                "y": int(y),
                "w": width,
                "h": height,
                "orient": orient,
                "class": classify_component(name, master),
            }
        )
    return components


def parse_pins(lines: list[str], section: tuple[int, int] | None) -> list[dict[str, Any]]:
    if section is None:
        return []
    pins: list[dict[str, Any]] = []
    block: list[str] = []
    for line in lines[section[0] + 1 : section[1]]:
        stripped = line.strip()
        if stripped.startswith("- ") and block:
            pins.append(parse_pin_block(" ".join(block)))
            block = [stripped]
        else:
            block.append(stripped)
    if block:
        pins.append(parse_pin_block(" ".join(block)))
    return [pin for pin in pins if pin]


def parse_pin_block(block: str) -> dict[str, Any]:
    name_match = re.match(r"-\s+(\S+)", block)
    place_match = re.search(r"\+\s+(?:PLACED|FIXED)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+(\S+)", block)
    layer_match = re.search(r"\+\s+LAYER\s+(\S+)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)\s+\(\s*(-?\d+)\s+(-?\d+)\s*\)", block)
    if not name_match or not place_match:
        return {}
    pin: dict[str, Any] = {
        "name": name_match.group(1),
        "x": int(place_match.group(1)),
        "y": int(place_match.group(2)),
        "orient": place_match.group(3),
    }
    if layer_match:
        pin.update(
            {
                "layer": layer_match.group(1),
                "rect": [int(layer_match.group(i)) for i in range(2, 6)],
            }
        )
    return pin


def route_width(layer: str, special: bool) -> int:
    if special:
        return {"met1": 480, "met2": 480, "met3": 640, "met4": 800, "met5": 1600}.get(layer, 420)
    return {"li1": 170, "met1": 140, "met2": 140, "met3": 300, "met4": 300, "met5": 1600}.get(layer, 160)


def iter_net_blocks(lines: list[str], section: tuple[int, int] | None) -> list[str]:
    if section is None:
        return []
    blocks: list[str] = []
    block: list[str] = []
    for line in lines[section[0] + 1 : section[1]]:
        stripped = line.strip()
        if stripped.startswith("- ") and block:
            blocks.append(" ".join(block))
            block = [stripped]
        else:
            block.append(stripped)
    if block:
        blocks.append(" ".join(block))
    return blocks


def point_value(value: str, previous: int | None) -> int:
    if value == "*":
        if previous is None:
            raise ValueError("DEF route uses '*' before an absolute coordinate")
        return previous
    return int(value)


def parse_routes(lines: list[str], section: tuple[int, int] | None, special: bool) -> list[dict[str, Any]]:
    routes: list[dict[str, Any]] = []
    for block in iter_net_blocks(lines, section):
        name_match = re.match(r"-\s+(\S+)", block)
        net_name = name_match.group(1) if name_match else "unknown"
        previous: tuple[int, int] | None = None
        for match in ROUTE_SEGMENT_RE.finditer(block):
            layer = match.group("layer")
            x1 = point_value(match.group("x1"), previous[0] if previous else None)
            y1 = point_value(match.group("y1"), previous[1] if previous else None)
            x2 = point_value(match.group("x2"), x1) if match.group("x2") is not None else x1
            y2 = point_value(match.group("y2"), y1) if match.group("y2") is not None else y1
            previous = (x2, y2)
            width = int(match.group("width")) if match.group("width") else route_width(layer, special)
            if x1 == x2 and y1 == y2:
                width = max(width, 420)
            routes.append(
                {
                    "net": net_name,
                    "layer": layer,
                    "x1": x1,
                    "y1": y1,
                    "x2": x2,
                    "y2": y2,
                    "w": width,
                    "special": special,
                }
            )
        for rect in RECT_RE.finditer(block):
            # RECT coordinates are route-local; attach them to the current point when possible.
            if previous is None:
                continue
            x1, y1, x2, y2 = (int(rect.group(i)) for i in range(1, 5))
            routes.append(
                {
                    "net": net_name,
                    "layer": "rect",
                    "x1": previous[0] + x1,
                    "y1": previous[1] + y1,
                    "x2": previous[0] + x2,
                    "y2": previous[1] + y2,
                    "w": 1,
                    "special": special,
                }
            )
    return routes


def make_tiles(items: list[dict[str, Any]], diearea: list[int], tile_count: int = 32) -> list[dict[str, Any]]:
    x0, y0, x1, y1 = diearea
    width = max(1, x1 - x0)
    height = max(1, y1 - y0)
    buckets: dict[tuple[int, int], dict[str, Any]] = {}
    for item in items:
        cx = (item.get("x", item.get("x1", 0)) + item.get("x2", item.get("x", item.get("x1", 0)))) / 2
        cy = (item.get("y", item.get("y1", 0)) + item.get("y2", item.get("y", item.get("y1", 0)))) / 2
        tx = min(tile_count - 1, max(0, math.floor((cx - x0) / width * tile_count)))
        ty = min(tile_count - 1, max(0, math.floor((cy - y0) / height * tile_count)))
        bucket = buckets.setdefault((tx, ty), {"x": tx, "y": ty, "components": 0, "routes": 0})
        if "master" in item:
            bucket["components"] += 1
        else:
            bucket["routes"] += 1
    return list(buckets.values())


def collect_gds_near(def_path: Path) -> list[str]:
    run = next((parent for parent in def_path.parents if parent.name.startswith("RUN_")), None)
    if run is None:
        return []
    return [rel(path) for path in sorted(run.glob("**/*.gds"))]


def choose_gds(def_path: Path, explicit_gds: Path | None = None) -> Path | None:
    if explicit_gds is not None:
        return explicit_gds
    run = next((parent for parent in def_path.parents if parent.name.startswith("RUN_")), None)
    if run is None:
        return None
    design = def_path.stem
    matches = sorted(run.glob(f"**/{design}*.gds"), key=lambda path: (".klayout." not in path.name, path.stat().st_mtime))
    return matches[-1] if matches else None


def export_gds_from_def(def_path: Path, out_dir: Path, design_name: str) -> Path:
    missing = [path for path in [OPENLANE_PYTHON, KLAYOUT_STREAM_OUT, SKY130_LYP, SKY130_LYT, SKY130_LYM, *STREAMOUT_LEFS, *STREAMOUT_GDS_FILES] if not path.exists()]
    if missing:
        raise FileNotFoundError("missing streamout inputs: " + ", ".join(rel(path) for path in missing))

    export_dir = out_dir / "exported-gds"
    export_dir.mkdir(parents=True, exist_ok=True)
    output = export_dir / f"{design_name}.klayout.gds"
    command = [
        str(OPENLANE_PYTHON),
        str(KLAYOUT_STREAM_OUT),
        str(def_path),
        "--output",
        str(output),
        "--top",
        design_name,
        "--lyp",
        str(SKY130_LYP),
        "--lyt",
        str(SKY130_LYT),
        "--lym",
        str(SKY130_LYM),
    ]
    for lef in STREAMOUT_LEFS:
        command.extend(["--input-lef", str(lef)])
    for gds in STREAMOUT_GDS_FILES:
        command.extend(["--with-gds-file", str(gds)])
    subprocess.run(command, check=True, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return output


def make_tile_pyramid(image_path: Path, out_dir: Path, tile_size: int) -> dict[str, Any]:
    from PIL import Image

    tiles_dir = out_dir / "silicon-gds-tiles"
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    tiles_dir.mkdir(parents=True)

    source = Image.open(image_path).convert("RGB")
    base_width, base_height = source.size
    levels: list[dict[str, Any]] = []
    level = 0
    current = source
    while True:
        level_dir = tiles_dir / str(level)
        level_dir.mkdir()
        width, height = current.size
        cols = math.ceil(width / tile_size)
        rows = math.ceil(height / tile_size)
        for ty in range(rows):
            for tx in range(cols):
                x0 = tx * tile_size
                y0 = ty * tile_size
                tile = current.crop((x0, y0, min(width, x0 + tile_size), min(height, y0 + tile_size)))
                tile.save(level_dir / f"{tx}_{ty}.png")
        levels.append(
            {
                "level": level,
                "scale": width / base_width,
                "width": width,
                "height": height,
                "cols": cols,
                "rows": rows,
                "path": f"silicon-gds-tiles/{level}",
            }
        )
        if max(width, height) <= tile_size:
            break
        next_size = (max(1, math.ceil(width / 2)), max(1, math.ceil(height / 2)))
        current = current.resize(next_size, Image.Resampling.LANCZOS)
        level += 1

    return {"tile_size": tile_size, "width": base_width, "height": base_height, "levels": levels}


def make_silicon_image_metadata(
    def_path: Path,
    gds_path: Path | None,
    out_dir: Path,
    render_gds: bool,
    size: int,
    tile_gds: bool,
    tile_size: int,
) -> dict[str, Any]:
    if gds_path is None:
        return {
            "available": False,
            "reason": "no matching GDS was found next to the selected DEF; showing routed DEF geometry only",
        }

    metadata: dict[str, Any] = {
        "available": True,
        "gds": rel(gds_path),
        "image": None,
        "rendered": False,
        "bounds": None,
    }
    if not render_gds:
        metadata["reason"] = "GDS source found; pass --render-gds to render a silicon raster background"
        return metadata

    if not KLAYOUT.exists() or not SKY130_LYP.exists():
        metadata["reason"] = "KLayout or SKY130 layer properties are not installed locally"
        return metadata

    out_dir.mkdir(parents=True, exist_ok=True)
    image_path = out_dir / "silicon-gds.png"
    env = os.environ.copy()
    env.update(
        {
            "ELIZA_GDS_INPUT": str(gds_path),
            "ELIZA_GDS_OUTPUT": str(image_path),
            "ELIZA_GDS_LYP": str(SKY130_LYP),
            "ELIZA_GDS_WIDTH": str(size),
            "ELIZA_GDS_HEIGHT": str(size),
            "LD_LIBRARY_PATH": f"{KLAYOUT_LIB}:{KLAYOUT_DEPS}:{env.get('LD_LIBRARY_PATH', '')}",
        }
    )
    command = ["xvfb-run", "-a", str(KLAYOUT), "-zz", "-r", str(GDS_RENDER_SCRIPT)]
    try:
        subprocess.run(command, check=True, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        metadata["reason"] = f"GDS render failed: {exc}"
        return metadata

    metadata.update({"image": image_path.name, "rendered": True, "bounds": "diearea"})
    if tile_gds:
        try:
            metadata["tiles"] = make_tile_pyramid(image_path, out_dir, tile_size)
        except Exception as exc:  # pragma: no cover - exercised by integration render smoke.
            metadata["tile_reason"] = f"GDS tile pyramid failed: {exc}"
    return metadata


def build_payload(
    def_path: Path,
    role: str,
    gds_path: Path | None,
    out_dir: Path,
    render_gds: bool,
    gds_size: int,
    tile_gds: bool,
    tile_size: int,
) -> dict[str, Any]:
    lines = def_path.read_text(errors="replace").splitlines()
    sections = split_sections(lines)
    header = parse_header(lines)
    rows = parse_rows(lines)
    components = parse_components(lines, sections.get("COMPONENTS"), rows)
    pins = parse_pins(lines, sections.get("PINS"))
    routes = parse_routes(lines, sections.get("SPECIALNETS"), special=True)
    routes.extend(parse_routes(lines, sections.get("NETS"), special=False))
    layer_counts: dict[str, int] = {}
    for route in routes:
        layer_counts[route["layer"]] = layer_counts.get(route["layer"], 0) + 1
    class_counts: dict[str, int] = {}
    for component in components:
        class_counts[component["class"]] = class_counts.get(component["class"], 0) + 1
    return {
        "schema": "eliza.chip_visualizer.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "source": {"def": rel(def_path), "role": role, "nearby_gds": collect_gds_near(def_path)},
        "silicon_image": make_silicon_image_metadata(def_path, gds_path, out_dir, render_gds, gds_size, tile_gds, tile_size),
        "design": header["design"] or def_path.stem,
        "units_per_micron": header["units_per_micron"],
        "diearea": header["diearea"],
        "layers": [{"name": name, "color": LAYER_COLORS.get(name, "#d9d9d9")} for name in sorted(layer_counts)],
        "rows": rows,
        "components": components,
        "pins": pins,
        "routes": routes,
        "tiles": make_tiles([*components, *routes], header["diearea"]),
        "summary": {
            "component_count": len(components),
            "pin_count": len(pins),
            "route_segment_count": len(routes),
            "row_count": len(rows),
            "layer_counts": layer_counts,
            "component_class_counts": class_counts,
        },
    }


def write_viewer(out_dir: Path, payload: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "chip-layout.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    shutil.copyfile(VIEWER_HTML, out_dir / "index.html")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--def", dest="def_file", type=Path, help="DEF file to visualize")
    parser.add_argument("--gds", dest="gds_file", type=Path, help="matching GDS file to render as a silicon image")
    parser.add_argument("--export-gds", action="store_true", help="export a matching GDS from the selected DEF before rendering")
    parser.add_argument("--render-gds", action="store_true", help="render a GDS PNG background with KLayout")
    parser.add_argument("--gds-size", type=int, default=4096, help="GDS render width and height in pixels")
    parser.add_argument("--tile-gds", action="store_true", help="split the rendered GDS image into a zoomable tile pyramid")
    parser.add_argument("--tile-size", type=int, default=512, help="GDS tile width and height in pixels")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.def_file:
        source = DefSource(args.def_file, "explicit")
    else:
        source = choose_def()
    out_dir = args.out.resolve()
    def_path = source.path.resolve()
    lines = def_path.read_text(errors="replace").splitlines()
    design_name = parse_header(lines)["design"] or def_path.stem
    gds_path = choose_gds(def_path, args.gds_file.resolve() if args.gds_file else None)
    if args.export_gds:
        gds_path = export_gds_from_def(def_path, out_dir, design_name)
    payload = build_payload(
        def_path,
        source.role,
        gds_path,
        out_dir,
        args.render_gds,
        args.gds_size,
        args.tile_gds,
        args.tile_size,
    )
    write_viewer(out_dir, payload)
    print(f"wrote {args.out / 'index.html'}")
    print(f"source DEF: {payload['source']['def']}")
    if payload["silicon_image"].get("rendered"):
        print(f"source GDS: {payload['silicon_image']['gds']}")
        print(f"silicon image: {args.out / payload['silicon_image']['image']}")
        if payload["silicon_image"].get("tiles"):
            print(f"silicon tiles: {len(payload['silicon_image']['tiles']['levels'])} levels")
    elif payload["silicon_image"].get("gds"):
        print(f"source GDS: {payload['silicon_image']['gds']} (not rendered)")
    print(
        "features: "
        f"{payload['summary']['component_count']} instances, "
        f"{payload['summary']['route_segment_count']} route segments, "
        f"{len(payload['layers'])} layers"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
