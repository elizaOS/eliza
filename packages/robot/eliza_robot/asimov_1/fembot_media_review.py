"""Validation wrapper for fembot screenshot and joint-motion media."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageStat

from eliza_robot.asimov_1.parametric_inventory import ASIMOV_FEMININE_CAD_ROOT, ASIMOV_PARAM_PROOFS

FEMBOT_MEDIA_REVIEW_SCHEMA = "asimov-fembot-media-review-v1"
DEFAULT_FEMBOT_MEDIA_ROOT = ASIMOV_FEMININE_CAD_ROOT / "output" / "media" / "fembot"
DEFAULT_FEMBOT_MEDIA_PROOF = ASIMOV_PARAM_PROOFS / "fembot-media-review.json"


def _image_report(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"path": str(path), "exists": False, "nonblank": False}
    image = Image.open(path).convert("RGB")
    stddev = [round(float(value), 3) for value in ImageStat.Stat(image).stddev]
    return {
        "path": str(path),
        "exists": True,
        "bytes": path.stat().st_size,
        "width": image.width,
        "height": image.height,
        "stddev_rgb": stddev,
        "nonblank": max(stddev) >= 1.0,
    }


def _video_report(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "exists": path.is_file(),
        "bytes": path.stat().st_size if path.is_file() else 0,
        "nonzero": path.is_file() and path.stat().st_size > 0,
    }


def build_fembot_media_review_proof(
    *,
    media_root: Path = DEFAULT_FEMBOT_MEDIA_ROOT,
    proof_path: Path = DEFAULT_FEMBOT_MEDIA_PROOF,
) -> dict[str, Any]:
    """Return gateable evidence for screenshots and simultaneous joint video."""
    screenshot_names = [
        "fembot_front.png",
        "fembot_rear.png",
        "fembot_left.png",
        "fembot_right.png",
        "fembot_three_quarter.png",
        "fembot_upper_three_quarter.png",
    ]
    screenshots = [_image_report(media_root / name) for name in screenshot_names]
    video = _video_report(media_root / "fembot_all_joints_simultaneous_constraints.mp4")
    existing_proof: dict[str, Any] = {}
    if proof_path.is_file():
        existing_proof = json.loads(proof_path.read_text(encoding="utf-8"))

    joint_motion = existing_proof.get("joint_motion") if isinstance(existing_proof, dict) else {}
    if not isinstance(joint_motion, dict):
        joint_motion = {}
    source = existing_proof.get("source") if isinstance(existing_proof, dict) else {}
    if not isinstance(source, dict):
        source = {}
    source_fitted_part_media = (
        existing_proof.get("source_fitted_part_media")
        if isinstance(existing_proof, dict)
        else []
    )
    if not isinstance(source_fitted_part_media, list):
        source_fitted_part_media = []
    source_fitted_part_images = [
        _image_report(Path(str(item.get("path"))))
        | {
            "link": item.get("link"),
            "shape_family": item.get("shape_family"),
            "generated_step_path": item.get("generated_step_path"),
            "surface_symmetric_hausdorff_m": item.get("surface_symmetric_hausdorff_m"),
        }
        for item in source_fitted_part_media
        if isinstance(item, dict) and item.get("path")
    ]
    source_fitted_assembly_media = (
        existing_proof.get("source_fitted_assembly_media")
        if isinstance(existing_proof, dict)
        else []
    )
    if not isinstance(source_fitted_assembly_media, list):
        source_fitted_assembly_media = []
    source_fitted_assembly_images = [
        _image_report(Path(str(item.get("path"))))
        | {
            "name": item.get("name"),
        }
        for item in source_fitted_assembly_media
        if isinstance(item, dict) and item.get("path")
    ]
    source_fitted_visual_mjcf = (
        existing_proof.get("source_fitted_visual_mjcf")
        if isinstance(existing_proof, dict)
        else {}
    )
    if not isinstance(source_fitted_visual_mjcf, dict):
        source_fitted_visual_mjcf = {}

    missing_screenshots = [item["path"] for item in screenshots if not item["exists"]]
    blank_screenshots = [item["path"] for item in screenshots if item["exists"] and not item["nonblank"]]
    missing_source_fitted_part_images = [
        item["path"] for item in source_fitted_part_images if not item["exists"]
    ]
    blank_source_fitted_part_images = [
        item["path"]
        for item in source_fitted_part_images
        if item["exists"] and not item["nonblank"]
    ]
    missing_source_fitted_assembly_images = [
        item["path"] for item in source_fitted_assembly_images if not item["exists"]
    ]
    blank_source_fitted_assembly_images = [
        item["path"]
        for item in source_fitted_assembly_images
        if item["exists"] and not item["nonblank"]
    ]
    frame_count = (existing_proof.get("video") or {}).get("frame_count") if isinstance(existing_proof, dict) else None
    joint_count = joint_motion.get("joint_count")
    source_fitted_visual_replacements = int(
        source_fitted_visual_mjcf.get("visual_replacements") or 0
    )
    source_fitted_visual_failures = int(
        source_fitted_visual_mjcf.get("replacement_failures") or 0
    )
    ok = bool(
        not missing_screenshots
        and not blank_screenshots
        and video["nonzero"]
        and isinstance(frame_count, int)
        and frame_count > 0
        and isinstance(joint_count, int)
        and joint_count > 0
        and not missing_source_fitted_part_images
        and not blank_source_fitted_part_images
        and source_fitted_visual_replacements == 28
        and source_fitted_visual_failures == 0
        and len(source_fitted_assembly_images) >= 3
        and not missing_source_fitted_assembly_images
        and not blank_source_fitted_assembly_images
    )
    return {
        "schema": FEMBOT_MEDIA_REVIEW_SCHEMA,
        "ok": ok,
        "accepted": False,
        "source": {
            "media_root": str(media_root),
            "proof_path": str(proof_path),
            "mjcf": source.get("mjcf"),
        },
        "summary": {
            "screenshot_count": len(screenshots),
            "missing_screenshots": missing_screenshots,
            "blank_screenshots": blank_screenshots,
            "video_exists": video["exists"],
            "video_bytes": video["bytes"],
            "video_frame_count": frame_count,
            "joint_count": joint_count,
            "source_fitted_part_screenshot_count": len(source_fitted_part_images),
            "source_fitted_part_links": sorted(
                str(item.get("link"))
                for item in source_fitted_part_images
                if item.get("link")
            ),
            "missing_source_fitted_part_screenshots": missing_source_fitted_part_images,
            "blank_source_fitted_part_screenshots": blank_source_fitted_part_images,
            "source_fitted_visual_mjcf_replacements": source_fitted_visual_replacements,
            "source_fitted_visual_mjcf_replacement_failures": source_fitted_visual_failures,
            "source_fitted_assembly_screenshot_count": len(source_fitted_assembly_images),
            "source_fitted_assembly_screenshot_names": sorted(
                str(item.get("name"))
                for item in source_fitted_assembly_images
                if item.get("name")
            ),
            "missing_source_fitted_assembly_screenshots": (
                missing_source_fitted_assembly_images
            ),
            "blank_source_fitted_assembly_screenshots": (
                blank_source_fitted_assembly_images
            ),
            "accepted": False,
            "acceptance_blocker": (
                "screenshots and constrained all-joint video exist, but production "
                "acceptance still requires manual visual review and hardware calibration"
            ),
        },
        "screenshots": screenshots,
        "source_fitted_part_screenshots": source_fitted_part_images,
        "source_fitted_assembly_screenshots": source_fitted_assembly_images,
        "source_fitted_visual_mjcf": source_fitted_visual_mjcf,
        "video": video,
        "joint_motion": joint_motion,
    }


def dump_fembot_media_review_proof_json(report: dict[str, Any]) -> str:
    return json.dumps(report, indent=2, sort_keys=True) + "\n"


def write_fembot_media_review_proof(
    report: dict[str, Any],
    output: Path = DEFAULT_FEMBOT_MEDIA_PROOF,
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(dump_fembot_media_review_proof_json(report), encoding="utf-8")
    return output
