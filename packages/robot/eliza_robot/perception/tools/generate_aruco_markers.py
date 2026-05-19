"""Generate printable ArUco markers for external-camera-assisted localization.

Creates:
- individual 2-inch marker PNGs at 300 DPI
- a printable HTML contact sheet laid out on US Letter paper
- a JSON manifest with dictionary, IDs, and print metadata

Usage:
    python3 -m perception.tools.generate_aruco_markers
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


DEFAULT_DICTIONARY = "DICT_6X6_250"
DEFAULT_MARKER_IDS = (0, 1, 2, 3, 4, 5, 6, 7, 8)
DEFAULT_MARKER_SIZE_IN = 2.0
DEFAULT_DPI = 300
LETTER_WIDTH_IN = 8.5
LETTER_HEIGHT_IN = 11.0

# Default purpose labels for each marker ID
DEFAULT_MARKER_LABELS: dict[int, str] = {
    0: "Robot Body",
    1: "Robot Head",
    2: "Ground Origin (0,0)",
    3: "Ground +X (1,0)",
    4: "Ground +X+Y (1,1)",
    5: "Ground +Y (0,1)",
    6: "Object: Red Ball",
    7: "Object: Blue Cube",
    8: "Object: Green Cylinder",
}


def _parse_marker_ids(raw: str) -> tuple[int, ...]:
    marker_ids: list[int] = []
    for chunk in raw.split(","):
        trimmed = chunk.strip()
        if trimmed == "":
            continue
        marker_ids.append(int(trimmed))
    if not marker_ids:
        raise ValueError("At least one marker id is required")
    return tuple(marker_ids)


def _get_dictionary(name: str) -> cv2.aruco.Dictionary:
    dictionary_id = getattr(cv2.aruco, name, None)
    if dictionary_id is None:
        raise ValueError(f"Unknown ArUco dictionary: {name}")
    return cv2.aruco.getPredefinedDictionary(dictionary_id)


def _build_contact_sheet_html(
    marker_ids: tuple[int, ...],
    output_dir: Path,
    dictionary_name: str,
    marker_size_in: float,
    dpi: int,
    labels: dict[int, str] | None = None,
) -> str:
    cols = 3
    rows = int(np.ceil(len(marker_ids) / cols))
    if rows <= 0:
        rows = 1
    page_margin_in = 0.4
    cell_gap_in = 0.2
    caption_height_in = 0.28
    usable_width_in = LETTER_WIDTH_IN - (page_margin_in * 2)
    usable_height_in = LETTER_HEIGHT_IN - (page_margin_in * 2)
    cell_width_in = min(
        marker_size_in + cell_gap_in,
        usable_width_in / cols,
    )
    cell_height_in = min(
        marker_size_in + caption_height_in + cell_gap_in,
        usable_height_in / rows,
    )

    marker_blocks: list[str] = []
    for marker_id in marker_ids:
        marker_name = f"aruco_{marker_id:02d}.png"
        label = (labels or {}).get(marker_id, "")
        caption = f"ID {marker_id}" + (f" &mdash; {label}" if label else "")
        marker_blocks.append(
            f"""
      <div class="marker-cell">
        <img src="{marker_name}" alt="ArUco marker {marker_id}" />
        <div class="caption">{caption}</div>
      </div>""".rstrip()
        )

    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Printable ArUco Markers</title>
    <style>
      @page {{
        size: letter portrait;
        margin: {page_margin_in}in;
      }}
      body {{
        font-family: Arial, sans-serif;
        margin: 0;
      }}
      h1 {{
        font-size: 16pt;
        margin: 0 0 0.15in 0;
      }}
      p {{
        margin: 0 0 0.08in 0;
        font-size: 10pt;
      }}
      .grid {{
        display: grid;
        grid-template-columns: repeat({cols}, {cell_width_in:.3f}in);
        grid-auto-rows: {cell_height_in:.3f}in;
        column-gap: {cell_gap_in}in;
        row-gap: {cell_gap_in}in;
      }}
      .marker-cell {{
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
      }}
      .marker-cell img {{
        width: {marker_size_in:.3f}in;
        height: {marker_size_in:.3f}in;
        image-rendering: pixelated;
        border: 0.02in solid #000;
        box-sizing: border-box;
      }}
      .caption {{
        margin-top: 0.06in;
        font-size: 9pt;
      }}
      .notes {{
        margin-bottom: 0.2in;
      }}
    </style>
  </head>
  <body>
    <h1>Printable ArUco Markers</h1>
    <div class="notes">
      <p>Dictionary: {dictionary_name}</p>
      <p>Marker size: {marker_size_in:.2f} in square at {dpi} DPI</p>
      <p>Print at 100% scale. Do not fit to page.</p>
      <p>Output directory: {output_dir}</p>
    </div>
    <div class="grid">
      {"".join(marker_blocks)}
    </div>
  </body>
</html>
"""


def generate_markers(
    output_dir: Path,
    dictionary_name: str,
    marker_ids: tuple[int, ...],
    marker_size_in: float,
    dpi: int,
    labels: dict[int, str] | None = None,
) -> None:
    dictionary = _get_dictionary(dictionary_name)
    output_dir.mkdir(parents=True, exist_ok=True)
    marker_size_px = int(round(marker_size_in * dpi))
    if marker_size_px <= 0:
        raise ValueError("Marker size in pixels must be positive")

    labels = labels or DEFAULT_MARKER_LABELS

    manifest = {
        "dictionary": dictionary_name,
        "marker_ids": list(marker_ids),
        "marker_size_in": marker_size_in,
        "dpi": dpi,
        "marker_size_px": marker_size_px,
        "assignments": {
            str(mid): labels.get(mid, f"marker_{mid}")
            for mid in marker_ids
        },
        "artifacts": [],
    }

    for marker_id in marker_ids:
        marker = np.zeros((marker_size_px, marker_size_px), dtype=np.uint8)
        cv2.aruco.generateImageMarker(dictionary, marker_id, marker_size_px, marker, 1)
        marker_path = output_dir / f"aruco_{marker_id:02d}.png"
        if not cv2.imwrite(str(marker_path), marker):
            raise RuntimeError(f"Failed to write marker image: {marker_path}")
        manifest["artifacts"].append(
            {
                "id": marker_id,
                "label": labels.get(marker_id, ""),
                "png": marker_path.name,
            }
        )

    html = _build_contact_sheet_html(
        marker_ids=marker_ids,
        output_dir=output_dir,
        dictionary_name=dictionary_name,
        marker_size_in=marker_size_in,
        dpi=dpi,
        labels=labels,
    )
    (output_dir / "aruco_print_sheet.html").write_text(html, encoding="utf-8")
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate printable ArUco markers")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("printables/aruco"),
        help="Directory to write generated markers into",
    )
    parser.add_argument(
        "--dictionary",
        type=str,
        default=DEFAULT_DICTIONARY,
        help="OpenCV ArUco dictionary constant name",
    )
    parser.add_argument(
        "--ids",
        type=str,
        default=",".join(str(marker_id) for marker_id in DEFAULT_MARKER_IDS),
        help="Comma-separated marker IDs",
    )
    parser.add_argument(
        "--size-in",
        type=float,
        default=DEFAULT_MARKER_SIZE_IN,
        help='Printed square marker size in inches (default: 2.0)',
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=DEFAULT_DPI,
        help="Raster resolution for generated marker PNGs",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    generate_markers(
        output_dir=args.output_dir,
        dictionary_name=args.dictionary,
        marker_ids=_parse_marker_ids(args.ids),
        marker_size_in=args.size_in,
        dpi=args.dpi,
    )
    print(f"Generated printable ArUco markers in {args.output_dir}")


if __name__ == "__main__":
    main()
