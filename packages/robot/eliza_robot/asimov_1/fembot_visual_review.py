"""Visual and mathematical review scaffold for ASIMOV fembot."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eliza_robot.asimov_1.fembot_generated_cad import build_fembot_generated_cad_envelope_proof
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS

VISUAL_REVIEW_SCHEMA = "asimov-fembot-visual-review-proof-v1"
DEFAULT_VISUAL_REVIEW_ROOT = ASIMOV_FEMININE_CAD_ROOT / "output" / "visual-review"


def _safe_filename(value: str) -> str:
    return "".join(char.lower() if char.isalnum() else "_" for char in value).strip("_")


def _bbox_union(records: list[dict[str, Any]]) -> tuple[list[float], list[float]]:
    mins = [[float(value) for value in record["reloaded_bbox_min_m"]] for record in records]
    maxs = [[float(value) for value in record["reloaded_bbox_max_m"]] for record in records]
    return (
        [min(values[index] for values in mins) for index in range(3)],
        [max(values[index] for values in maxs) for index in range(3)],
    )


def _extent(minimum: list[float], maximum: list[float]) -> list[float]:
    return [maximum[index] - minimum[index] for index in range(3)]


def _project(record: dict[str, Any], *, axes: tuple[int, int], scale: float, origin: tuple[float, float]) -> str:
    bbox_min = [float(value) for value in record["reloaded_bbox_min_m"]]
    bbox_max = [float(value) for value in record["reloaded_bbox_max_m"]]
    x0 = origin[0] + bbox_min[axes[0]] * scale
    y0 = origin[1] - bbox_max[axes[1]] * scale
    width = max((bbox_max[axes[0]] - bbox_min[axes[0]]) * scale, 1.0)
    height = max((bbox_max[axes[1]] - bbox_min[axes[1]]) * scale, 1.0)
    fill = "#95b8ff" if record.get("surface_intent") == "smooth" else "#c8c8c8"
    return (
        f'<rect x="{x0:.3f}" y="{y0:.3f}" width="{width:.3f}" height="{height:.3f}" '
        f'fill="{fill}" fill-opacity="0.55" stroke="#1f2937" stroke-width="1">'
        f"<title>{record['link']}</title></rect>"
    )


def _write_svg_view(
    *,
    path: Path,
    title: str,
    records: list[dict[str, Any]],
    axes: tuple[int, int],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    scale = 520.0
    origin = (300.0, 420.0)
    rects = "\n".join(_project(record, axes=axes, scale=scale, origin=origin) for record in records)
    labels = (
        '<text x="24" y="34" font-size="18" font-family="monospace" fill="#111827">'
        f"{title}</text>"
    )
    path.write_text(
        "\n".join(
            [
                '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">',
                '<rect width="640" height="480" fill="#f8fafc"/>',
                labels,
                rects,
                "</svg>",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _write_three_quarter_svg(path: Path, title: str, records: list[dict[str, Any]]) -> None:
    pseudo_records = []
    for record in records:
        bbox_min = [float(value) for value in record["reloaded_bbox_min_m"]]
        bbox_max = [float(value) for value in record["reloaded_bbox_max_m"]]
        pseudo_min = [bbox_min[0] + bbox_min[1] * 0.45, bbox_min[2], 0.0]
        pseudo_max = [bbox_max[0] + bbox_max[1] * 0.45, bbox_max[2], 0.0]
        pseudo_records.append({**record, "reloaded_bbox_min_m": pseudo_min, "reloaded_bbox_max_m": pseudo_max})
    _write_svg_view(path=path, title=title, records=pseudo_records, axes=(0, 1))


def _group_review_record(
    *,
    group: dict[str, Any],
    generated_by_link: dict[str, dict[str, Any]],
    output_root: Path,
) -> dict[str, Any]:
    group_name = str(group["group"])
    links = [str(link).upper() for link in group.get("links", [])]
    records = [generated_by_link[link] for link in links if link in generated_by_link]
    minimum, maximum = _bbox_union(records)
    extent = _extent(minimum, maximum)
    root = output_root / _safe_filename(group_name)
    render_paths = {
        "front": str(root / "front.svg"),
        "side": str(root / "side.svg"),
        "three_quarter": str(root / "three_quarter.svg"),
    }
    _write_svg_view(path=Path(render_paths["front"]), title=f"{group_name} front x/z", records=records, axes=(0, 2))
    _write_svg_view(path=Path(render_paths["side"]), title=f"{group_name} side y/z", records=records, axes=(1, 2))
    _write_three_quarter_svg(Path(render_paths["three_quarter"]), f"{group_name} three-quarter", records)
    front_envelope = {"width_m": extent[0], "height_m": extent[2]}
    side_envelope = {"depth_m": extent[1], "height_m": extent[2]}
    slenderness_ratio = extent[2] / max(extent[0], extent[1], 1.0e-9)
    return {
        "group": group_name,
        "links": links,
        "render_paths": render_paths,
        "front_envelope_m": front_envelope,
        "side_envelope_m": side_envelope,
        "three_quarter_review": {
            "status": "generated_reference_svg",
            "review_required": True,
            "notes": "schematic bbox view exists; manual visual review still required before acceptance",
        },
        "bbox_min_m": minimum,
        "bbox_max_m": maximum,
        "bbox_extent_m": extent,
        "slenderness_ratio_height_over_max_width_depth": slenderness_ratio,
        "accepted": False,
    }


def build_fembot_visual_review_proof(
    body_groups: list[dict[str, Any]],
    *,
    generated_cad_report: dict[str, Any] | None = None,
    output_root: Path = DEFAULT_VISUAL_REVIEW_ROOT,
) -> dict[str, Any]:
    generated = generated_cad_report or build_fembot_generated_cad_envelope_proof(body_groups)
    generated_by_link = {record["link"]: record for record in generated.get("link_steps", [])}
    group_records = [
        _group_review_record(group=group, generated_by_link=generated_by_link, output_root=output_root)
        for group in body_groups
    ]
    render_paths = [
        path
        for group in group_records
        for path in group["render_paths"].values()
    ]
    missing_render_paths = [path for path in render_paths if not Path(path).is_file()]
    return {
        "schema": VISUAL_REVIEW_SCHEMA,
        "ok": bool(generated.get("ok") and not missing_render_paths and len(group_records) == 5),
        "accepted": False,
        "source": {
            "generated_cad_schema": generated.get("schema"),
            "output_root": str(output_root),
        },
        "summary": {
            "body_groups": len(group_records),
            "render_paths": len(render_paths),
            "missing_render_paths": missing_render_paths,
            "front_envelope_max_width_m": max(
                (float(group["front_envelope_m"]["width_m"]) for group in group_records),
                default=None,
            ),
            "side_envelope_max_depth_m": max(
                (float(group["side_envelope_m"]["depth_m"]) for group in group_records),
                default=None,
            ),
            "minimum_slenderness_ratio": min(
                (
                    float(group["slenderness_ratio_height_over_max_width_depth"])
                    for group in group_records
                ),
                default=None,
            ),
            "accepted": False,
            "acceptance_blocker": (
                "schematic generated-CAD review renders and numeric envelopes exist, "
                "but manual visual review and final rendered CAD views are still required"
            ),
        },
        "body_groups": group_records,
    }


def dump_fembot_visual_review_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_visual_review_proof(
    report: dict[str, Any],
    output: Path = ASIMOV_PARAM_PROOFS / "fembot-visual-review.json",
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_visual_review_proof_json(report), encoding="utf-8")
    return output
