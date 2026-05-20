#!/usr/bin/env python3
"""Generate non-release KiCad schematic skeletons for the E1 phone board.

The generated sheets intentionally remain documentation-grade: they carry the
block netlist into KiCad review artifacts without pretending to be finished
symbols, footprints, ERC, or fabrication evidence.
"""

from __future__ import annotations

import json
import textwrap
import uuid
from pathlib import Path
from typing import Any, TypedDict

import yaml

ROOT = Path(__file__).resolve().parents[1]
PHONE_DIR = ROOT / "board/kicad/e1-phone"
SCHEMATIC_DIR = PHONE_DIR / "schematic"
NETLIST = PHONE_DIR / "block-netlist.yaml"
PROJECT = PHONE_DIR / "e1-phone.kicad_pro"
ROOT_SCH = SCHEMATIC_DIR / "e1-phone.kicad_sch"


class SheetConfig(TypedDict):
    title: str
    blocks: list[str]


SHEETS: dict[str, SheetConfig] = {
    "power_usb": {
        "title": "Power, Battery, Charger, USB-C",
        "blocks": ["J_USB_C", "U_USB_PD", "U_CHARGER", "J_BATTERY", "U_PMIC"],
    },
    "compute": {
        "title": "E1 SoC, Memory, Storage",
        "blocks": ["U_SOC"],
    },
    "display_camera": {
        "title": "Display, Touch, Cameras",
        "blocks": ["J_DISPLAY_TOUCH", "J_CAM0", "J_CAM1"],
    },
    "radios": {
        "title": "Cellular, Wi-Fi, Bluetooth, GNSS RF",
        "blocks": ["U_CELL", "U_WIFI_BT"],
    },
    "audio_buttons": {
        "title": "Audio, Haptics, Power and Volume Buttons",
        "blocks": ["SW_SIDE_KEYS", "U_AUDIO_HAPTIC"],
    },
    "split_interconnect": {
        "title": "Top/Bottom Split-Board Interconnect",
        "blocks": ["J_TOP_BOTTOM_FLEX_TOP", "J_TOP_BOTTOM_FLEX_BOTTOM"],
    },
}


def stable_uuid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"eliza:e1-phone:{name}"))


def load_netlist() -> dict[str, Any]:
    with NETLIST.open() as handle:
        return yaml.safe_load(handle)


def wrap_kicad_text(text: str, width: int = 92) -> list[str]:
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append("")
            continue
        lines.extend(textwrap.wrap(stripped, width=width) or [""])
    return lines


def text_item(text: str, x: float, y: float, size: float = 1.5) -> str:
    safe = text.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'  (text "{safe}" (at {x:.2f} {y:.2f} 0)\n'
        f"    (effects (font (size {size:.2f} {size:.2f})) (justify left bottom))\n"
        f"  )"
    )


def make_sheet(path: Path, title: str, blocks: list[dict[str, Any]]) -> str:
    items = [
        '(kicad_sch (version 20230121) (generator "eliza-phone-netlist-scaffold")',
        f'  (uuid "{stable_uuid(path.stem)}")',
        '  (paper "A3")',
        "  (title_block",
        f'    (title "E1 Phone - {title}")',
        '    (date "2026-05-20")',
        '    (rev "concept-netlist-r0")',
        '    (company "Eliza phone board planning")',
        '    (comment 1 "Evidence class: non_release_schematic_scaffold")',
        '    (comment 2 "Source: board/kicad/e1-phone/block-netlist.yaml")',
        '    (comment 3 "Replace with real symbols, footprints, ERC and reviewed supplier pinouts before fabrication")',
        "  )",
    ]
    y = 20.0
    items.append(
        text_item(
            "NON-RELEASE SCHEMATIC SKELETON: logical nets only, no ERC/fabrication claim.",
            20,
            y,
            1.8,
        )
    )
    y += 10.0
    for block in blocks:
        items.append(
            text_item(f"{block['id']} - {block['kind']} - {block['package_binding']}", 20, y, 1.55)
        )
        y += 7.0
        for group, nets in block["nets"].items():
            joined = ", ".join(str(net) for net in nets)
            for line in wrap_kicad_text(f"{group}: {joined}", width=100):
                items.append(text_item(line, 26, y, 1.15))
                y += 5.0
        y += 4.0
    items.append(")")
    return "\n".join(items) + "\n"


def make_root(netlist: dict[str, Any]) -> str:
    items = [
        '(kicad_sch (version 20230121) (generator "eliza-phone-netlist-scaffold")',
        f'  (uuid "{stable_uuid("root")}")',
        '  (paper "A3")',
        "  (title_block",
        '    (title "E1 Phone Mainboard - schematic scaffold")',
        '    (date "2026-05-20")',
        '    (rev "concept-netlist-r0")',
        '    (company "Eliza phone board planning")',
        '    (comment 1 "Evidence class: non_release_schematic_scaffold")',
        '    (comment 2 "Display anchor: 5.5 inch 1080x1920 MIPI, board 64 x 132 mm")',
        '    (comment 3 "Source: block-netlist.yaml and routing-constraints.yaml")',
        "  )",
    ]
    y = 20.0
    items.append(
        text_item(
            "Root schematic scaffold. This is not ERC-clean design data or a production schematic.",
            20,
            y,
            1.8,
        )
    )
    y += 10.0
    items.append(text_item("Generated sheets:", 20, y, 1.5))
    y += 8.0
    for sheet_name, config in SHEETS.items():
        items.append(
            text_item(f"schematic/{sheet_name}.kicad_sch - {config['title']}", 26, y, 1.25)
        )
        y += 6.0
    y += 4.0
    domains = ", ".join(domain["name"] for domain in netlist["voltage_domains"])
    for line in wrap_kicad_text(f"Voltage domains: {domains}", width=100):
        items.append(text_item(line, 20, y, 1.2))
        y += 5.0
    required = netlist["required_shared_nets"]
    for group, nets in required.items():
        for line in wrap_kicad_text(f"Required shared {group} nets: {', '.join(nets)}", width=100):
            items.append(text_item(line, 20, y, 1.2))
            y += 5.0
    items.append(
        text_item(
            "Release blocker: replace text scaffolds with reviewed symbols, exact supplier pinouts, footprints, ERC, and net classes.",
            20,
            y + 5.0,
            1.25,
        )
    )
    items.append(")")
    return "\n".join(items) + "\n"


def make_project() -> str:
    project = {
        "board": {
            "design_settings": {
                "defaults": {
                    "board_outline_line_width": 0.1,
                    "copper_line_width": 0.1,
                    "silk_line_width": 0.12,
                    "silk_text_size_h": 1.0,
                    "silk_text_size_v": 1.0,
                }
            }
        },
        "boards": [["pcb/e1-phone-mainboard-concept.kicad_pcb"]],
        "cvpcb": {"equivalence_files": []},
        "erc": {"erc_exclusions": []},
        "libraries": {"pinned_footprint_libs": [], "pinned_symbol_libs": []},
        "meta": {"filename": "e1-phone.kicad_pro", "version": 1},
        "net_settings": {
            "classes": [
                {
                    "bus_width": 12.0,
                    "clearance": 0.1,
                    "diff_pair_gap": 0.12,
                    "diff_pair_via_gap": 0.18,
                    "diff_pair_width": 0.1,
                    "line_style": 0,
                    "microvia_diameter": 0.2,
                    "microvia_drill": 0.075,
                    "name": "Default",
                    "pcb_color": "rgba(0, 0, 0, 0.000)",
                    "schematic_color": "rgba(0, 0, 0, 0.000)",
                    "track_width": 0.1,
                    "via_diameter": 0.4,
                    "via_drill": 0.2,
                    "wire_width": 6.0,
                }
            ],
            "meta": {"version": 3},
        },
        "pcbnew": {"last_paths": {}, "page_layout_descr_file": ""},
        "schematic": {
            "drawing": {
                "default_bus_thickness": 12.0,
                "default_junction_size": 40.0,
                "default_line_thickness": 6.0,
            },
            "legacy_lib_dir": "",
            "legacy_lib_list": [],
            "meta": {"version": 1},
            "net_format_name": "",
            "page_layout_descr_file": "",
            "plot_directory": "production/pdf",
        },
        "sheets": [["00000000-0000-0000-0000-000000000000", ""]],
        "text_variables": {
            "claim_boundary": "non_release_phone_schematic_scaffold",
            "display_anchor": "5.5in_1080x1920_MIPI",
            "board_bbox_mm": "64x132",
        },
    }
    return json.dumps(project, indent=2, sort_keys=True) + "\n"


def main() -> int:
    netlist = load_netlist()
    blocks_by_id = {block["id"]: block for block in netlist["blocks"]}
    SCHEMATIC_DIR.mkdir(parents=True, exist_ok=True)
    ROOT_SCH.write_text(make_root(netlist))
    for sheet_name, config in SHEETS.items():
        blocks = [blocks_by_id[block_id] for block_id in config["blocks"]]
        (SCHEMATIC_DIR / f"{sheet_name}.kicad_sch").write_text(
            make_sheet(SCHEMATIC_DIR / f"{sheet_name}.kicad_sch", config["title"], blocks)
        )
    PROJECT.write_text(make_project())
    print(f"generated {ROOT_SCH}")
    print(f"generated {PROJECT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
