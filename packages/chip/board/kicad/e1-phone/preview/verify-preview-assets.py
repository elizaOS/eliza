#!/usr/bin/env python3
from html.parser import HTMLParser
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
HTML_FILES = [
    ROOT / "e1-phone-mainboard-floorplan.html",
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


class PreviewHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.has_html = False
        self.has_body = False
        self.image_sources: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "html":
            self.has_html = True
        if tag == "body":
            self.has_body = True
        if tag == "img":
            attrs_by_name = {name: value for name, value in attrs}
            src = attrs_by_name.get("src")
            if src:
                self.image_sources.append(src)


def nonwhite_percent(path: Path) -> float:
    image = Image.open(path).convert("RGB")
    width, height = image.size
    nonwhite = sum(
        1 for red, green, blue in image.getdata() if not (red > 245 and green > 245 and blue > 245)
    )
    return nonwhite * 100.0 / (width * height)


for svg in SVG_FILES:
    ET.parse(svg)
    text = svg.read_text(errors="ignore")
    for stale in ["45 x 72", "45x72", "45 x72", "45x 72"]:
        if stale in text:
            raise SystemExit(f"stale small-battery label in preview: {svg}")
    print(f"xml ok: {svg}")

for html in HTML_FILES:
    parser = PreviewHTMLParser()
    parser.feed(html.read_text())
    if not parser.has_html or not parser.has_body:
        raise SystemExit(f"invalid html preview shell: {html}")
    for source in parser.image_sources:
        target = (html.parent / source).resolve()
        if not target.is_file():
            raise SystemExit(f"html preview references missing image: {html} -> {source}")
    if not parser.image_sources:
        raise SystemExit(f"html preview has no image source: {html}")
    print(f"html ok: {html}")

for png, min_pct in PNG_FILES:
    pct = nonwhite_percent(png)
    print(f"png ok: {png} nonwhite={pct:.2f}%")
    if pct < min_pct:
        raise SystemExit(f"broken or blank render: {png}")

pcb_text = KICAD_PCB.read_text()
if pcb_text.count("(") != pcb_text.count(")"):
    raise SystemExit(f"unbalanced KiCad PCB syntax: {KICAD_PCB}")
edge_rects = pcb_text.count('(layer "Edge.Cuts")')
if edge_rects < 2:
    raise SystemExit(
        f"split-island KiCad concept must expose two Edge.Cuts rectangles: {KICAD_PCB}"
    )
if "BATTERY CAVITY 64x87mm" not in pcb_text:
    raise SystemExit(f"missing full-width battery-cavity label in {KICAD_PCB}")
if "BATTERY WINDOW 45x72mm" in pcb_text:
    raise SystemExit(f"stale 45x72 battery label in {KICAD_PCB}")
for required in ["(kicad_pcb", "(layers", "Edge.Cuts", "F.Fab", "USB-C"]:
    if required not in pcb_text:
        raise SystemExit(f"missing {required} in {KICAD_PCB}")
print(f"kicad pcb concept ok: {KICAD_PCB}")
