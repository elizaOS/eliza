#!/usr/bin/env python3
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image

ROOT = Path(__file__).resolve().parent
CHIP_ROOT = ROOT.parents[3]

SVG_FILES = [
    ROOT / "e1-phone-mainboard-floorplan.svg",
    ROOT / "e1-phone-mainboard-pcb-render.svg",
    ROOT / "e1-phone-enclosure-fit.svg",
    ROOT / "kicad-cli-mainboard.svg",
    ROOT / "schematic/e1-phone.svg",
]
PNG_FILES = [
    (ROOT / "e1-phone-mainboard-floorplan.png", 5.0),
    (ROOT / "e1-phone-mainboard-floorplan-direct.png", 5.0),
    (ROOT / "e1-phone-mainboard-pcb-render.png", 5.0),
    (ROOT / "e1-phone-enclosure-fit.png", 5.0),
    (ROOT / "kicad-cli-mainboard.png", 5.0),
    (ROOT / "floorplan-html-screenshot.png", 5.0),
    (ROOT / "schematic/e1-phone.png", 0.5),
]
KICAD_PCB = CHIP_ROOT / "board/kicad/e1-phone/pcb/e1-phone-mainboard-concept.kicad_pcb"


def nonwhite_percent(path: Path) -> float:
    image = Image.open(path).convert("RGB")
    width, height = image.size
    nonwhite = sum(
        1 for red, green, blue in image.getdata() if not (red > 245 and green > 245 and blue > 245)
    )
    return nonwhite * 100.0 / (width * height)


for svg in SVG_FILES:
    ET.parse(svg)
    print(f"xml ok: {svg}")

for png, min_pct in PNG_FILES:
    pct = nonwhite_percent(png)
    print(f"png ok: {png} nonwhite={pct:.2f}%")
    if pct < min_pct:
        raise SystemExit(f"broken or blank render: {png}")

pcb_text = KICAD_PCB.read_text()
if pcb_text.count("(") != pcb_text.count(")"):
    raise SystemExit(f"unbalanced KiCad PCB syntax: {KICAD_PCB}")
for required in ["(kicad_pcb", "(layers", "Edge.Cuts", "F.Fab", "USB-C"]:
    if required not in pcb_text:
        raise SystemExit(f"missing {required} in {KICAD_PCB}")
print(f"kicad pcb concept ok: {KICAD_PCB}")
