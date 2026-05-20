#!/usr/bin/env python3
"""Generate display/enclosure fit evidence for the E1 phone concept."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DISPLAY = ROOT / "package/display/v0-dsi-720x1280.yaml"
METRICS = ROOT / "docs/board/e1-phone-mainboard-metrics.yaml"
ENCLOSURE = ROOT / "docs/board/e1-phone-enclosure-interface.yaml"
OUT = ROOT / "board/kicad/e1-phone/display-fit.yaml"


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False):
        return super().increase_indent(flow=flow, indentless=False)


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        return yaml.safe_load(handle)


def round2(value: float) -> float:
    return round(value + 0.0, 2)


def candidate_outline(candidate: dict[str, Any]) -> tuple[str, dict[str, float] | None]:
    for key in ("module_outline_mm", "touch_lens_outline_mm", "tft_outline_mm", "outline_mm"):
        outline = candidate.get(key)
        if isinstance(outline, dict) and "width" in outline and "height" in outline:
            return key, outline
    return "missing_outline", None


def clearance(envelope: dict[str, float], outline: dict[str, float]) -> dict[str, float]:
    return {
        "width_clearance_mm": round2(envelope["width"] - outline["width"]),
        "height_clearance_mm": round2(envelope["height"] - outline["height"]),
    }


def main() -> int:
    display = load_yaml(DISPLAY)
    metrics = load_yaml(METRICS)
    enclosure = load_yaml(ENCLOSURE)

    envelope = metrics["industrial_design_assumptions"]["device_envelope_mm"]
    board = metrics["mainboard_outline_concept"]["bounding_box_mm"]
    primary = display["panel_candidates"][0]
    primary_outline_kind, primary_outline = candidate_outline(primary)
    if primary_outline is None:
        raise SystemExit("primary display candidate has no usable mechanical outline")

    required_side_margin = 0.3
    required_top_bottom_margin = 0.9
    minimum_envelope = {
        "width": round2(primary_outline["width"] + 2 * required_side_margin),
        "height": round2(primary_outline["height"] + 2 * required_top_bottom_margin),
    }
    primary_clearance = clearance(envelope, primary_outline)

    candidates = []
    for candidate in display["panel_candidates"]:
        kind, outline = candidate_outline(candidate)
        if outline is None:
            candidates.append(
                {
                    "vendor": candidate.get("vendor"),
                    "part": candidate.get("part"),
                    "status": "missing_mechanical_outline",
                }
            )
            continue
        candidate_clearance = clearance(envelope, outline)
        candidates.append(
            {
                "vendor": candidate.get("vendor"),
                "part": candidate.get("part"),
                "outline_source": kind,
                "outline_mm": {
                    "width": round2(outline["width"]),
                    "height": round2(outline["height"]),
                    **({"thickness": outline["thickness"]} if "thickness" in outline else {}),
                },
                "clearance_in_current_envelope_mm": candidate_clearance,
                "fits_current_envelope": (
                    candidate_clearance["width_clearance_mm"] >= 0
                    and candidate_clearance["height_clearance_mm"] >= 0
                ),
                "board_width_margin_behind_outline_mm": round2(outline["width"] - board["width"]),
            }
        )

    fits_primary = (
        primary_clearance["width_clearance_mm"] >= 0
        and primary_clearance["height_clearance_mm"] >= 0
    )
    report = {
        "schema": "eliza.e1_phone_display_fit.v1",
        "status": "mechanical_fit_baseline_not_step_not_fabrication_ready",
        "source_files": [
            "package/display/v0-dsi-720x1280.yaml",
            "docs/board/e1-phone-mainboard-metrics.yaml",
            "docs/board/e1-phone-enclosure-interface.yaml",
        ],
        "claim_boundary": (
            "Checks 2D display/module/envelope fit only. This is not a STEP model, "
            "tolerance stack, FPC bend validation, camera stack validation, or "
            "enclosure release."
        ),
        "selected_primary_display": {
            "vendor": primary.get("vendor"),
            "part": primary.get("part"),
            "outline_source": primary_outline_kind,
            "outline_mm": {
                "width": round2(primary_outline["width"]),
                "height": round2(primary_outline["height"]),
                **(
                    {"thickness": primary_outline["thickness"]}
                    if "thickness" in primary_outline
                    else {}
                ),
            },
            "active_area_mm": primary.get("active_area_mm"),
        },
        "current_device_envelope_mm": envelope,
        "minimum_envelope_for_primary_with_margin_mm": {
            "width": minimum_envelope["width"],
            "height": minimum_envelope["height"],
            "side_margin_each_mm": required_side_margin,
            "top_bottom_margin_each_mm": required_top_bottom_margin,
        },
        "primary_clearance_in_current_envelope_mm": primary_clearance,
        "primary_fits_current_envelope": fits_primary,
        "board_fit_behind_primary_display": {
            "board_width_mm": board["width"],
            "board_height_mm": board["height"],
            "width_margin_from_display_outline_mm": round2(
                primary_outline["width"] - board["width"]
            ),
            "height_margin_from_display_outline_mm": round2(
                primary_outline["height"] - board["height"]
            ),
            "interpretation": (
                "The rigid board remains narrower than the selected display assembly; "
                "the earlier 72 x 148 mm device envelope was the inconsistent item."
            ),
        },
        "candidate_fit_summary": candidates,
        "recommended_device_envelope_mm": {
            "width": max(envelope["width"], minimum_envelope["width"]),
            "height": max(envelope["height"], minimum_envelope["height"]),
            "max_thickness": envelope["max_thickness"],
            "basis": "primary 5.5 inch Chenghao-class CTP module plus compact CAD rail margin",
        },
        "required_next_evidence": [
            "supplier 2D drawing with display FPC exit and connector datum",
            "cover-lens/touch-stack decision if using CTP module wider than 72 mm",
            "STEP assembly for display, board, battery, camera, USB-C, side buttons, and midframe",
            "FPC bend-radius and adhesive/tolerance stack review",
            "camera bump and top speaker clearance against the selected display module",
        ],
    }

    enclosure_envelope = enclosure["coordinate_system"]["device_envelope"]
    if (
        enclosure_envelope["width"] != envelope["width"]
        or enclosure_envelope["height"] != envelope["height"]
    ):
        report["enclosure_metrics_mismatch"] = {
            "metrics_device_envelope_mm": envelope,
            "enclosure_device_envelope_mm": enclosure_envelope,
        }

    OUT.write_text(yaml.dump(report, Dumper=IndentedSafeDumper, sort_keys=False))
    print(f"generated {OUT}")
    print(
        "primary display clearance="
        f"{primary_clearance['width_clearance_mm']}mm x {primary_clearance['height_clearance_mm']}mm"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
