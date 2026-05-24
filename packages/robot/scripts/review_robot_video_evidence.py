"""Review recorded robot video evidence.

The readiness gate checks that MP4 files exist. This script goes one level
deeper: it samples frames from every video, rejects blank/static clips, and
writes contact sheets so a reviewer can inspect what the robot actually did.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]


def _safe_stem(path: Path) -> str:
    return path.with_suffix("").name.replace("/", "_")


def _infer_action(profile: str, path: Path) -> str:
    stem = path.with_suffix("").name
    prefix = f"{profile}_"
    if stem.startswith(prefix):
        return stem[len(prefix) :]
    return stem


def _review_verdict(
    *,
    checks: dict[str, bool],
    action: str,
    stats: dict[str, Any],
) -> dict[str, Any]:
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        return {
            "verdict": "needs-work",
            "review_notes": (
                "Frame review failed checks: "
                + ", ".join(failed)
                + f". visual_progress={stats['visual_progress']:.6g}"
            ),
            "failed_checks": failed,
        }
    action_label = action.replace("_", " ")
    if action == "combined_actions":
        notes = (
            "Sampled frames show a nonblank robot sequence across the combined "
            "action script with measurable frame-to-frame or centroid progress."
        )
    else:
        notes = (
            f"Sampled frames show nonblank robot motion for `{action_label}` with "
            "measurable frame-to-frame or centroid progress."
        )
    return {
        "verdict": "good",
        "review_notes": notes,
        "failed_checks": [],
    }


def _load_manual_annotations(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    items = raw.get("videos") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return {}
    annotations: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("video"), str):
            continue
        annotations[item["video"]] = item
    return annotations


def _load_telemetry(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


def _telemetry_ok(telemetry: dict[str, Any] | None) -> bool | None:
    if telemetry is None:
        return None
    rollout_ok = telemetry.get("rollout_ok")
    if isinstance(rollout_ok, bool):
        return rollout_ok
    commands = telemetry.get("commands")
    if isinstance(commands, list):
        command_results = [
            command.get("rollout_ok")
            for command in commands
            if isinstance(command, dict) and isinstance(command.get("rollout_ok"), bool)
        ]
        if command_results:
            return all(command_results)
    return None


def _telemetry_summary(telemetry: dict[str, Any] | None) -> dict[str, Any]:
    if telemetry is None:
        return {"present": False, "ok": None}
    ok = _telemetry_ok(telemetry)
    summary: dict[str, Any] = {
        "present": True,
        "ok": ok,
        "steps_executed": telemetry.get("steps_executed"),
        "steps_requested": telemetry.get("steps_requested"),
        "terminated": telemetry.get("terminated"),
        "truncated": telemetry.get("truncated"),
        "first_done_step": telemetry.get("first_done_step"),
        "fall_threshold": telemetry.get("fall_threshold"),
    }
    for key in ("torso_z", "upright_proj", "reward"):
        if isinstance(telemetry.get(key), dict):
            summary[key] = telemetry[key]
    if isinstance(telemetry.get("commands"), list):
        commands = [cmd for cmd in telemetry["commands"] if isinstance(cmd, dict)]
        summary["command_count"] = len(commands)
        summary["failed_commands"] = [
            {
                "label": command.get("label"),
                "task_id": command.get("task_id"),
                "steps_executed": command.get("steps_executed"),
                "terminated": command.get("terminated"),
                "first_done_step": command.get("first_done_step"),
                "torso_z": command.get("torso_z"),
                "upright_proj": command.get("upright_proj"),
            }
            for command in commands
            if command.get("rollout_ok") is False
        ]
    return summary


def _sample_frames(path: Path, samples: int) -> tuple[list[np.ndarray], dict[str, Any]]:
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        return [], {"open": False, "frame_count": 0, "fps": 0.0}
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    indices = (
        np.linspace(0, max(frame_count - 1, 0), num=max(samples, 1), dtype=int)
        if frame_count > 0
        else np.array([], dtype=int)
    )
    frames: list[np.ndarray] = []
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()
        if ok and frame is not None:
            frames.append(frame)
    cap.release()
    return frames, {
        "open": True,
        "frame_count": frame_count,
        "fps": fps,
        "width": width,
        "height": height,
        "sampled_frames": len(frames),
    }


def _frame_stats(frames: list[np.ndarray]) -> dict[str, Any]:
    if not frames:
        return {
            "nonblank_ratio": 0.0,
            "mean_luma": 0.0,
            "mean_frame_delta": 0.0,
            "foreground_centroid_path": 0.0,
            "mean_foreground_mask_delta": 0.0,
            "visual_progress": 0.0,
        }
    lumas = []
    nonblank = []
    deltas = []
    centroid_path = 0.0
    mask_deltas = []
    previous_gray: np.ndarray | None = None
    previous_mask: np.ndarray | None = None
    previous_centroid: tuple[float, float] | None = None
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mask = gray > 8
        lumas.append(float(gray.mean()))
        nonblank.append(float(np.mean(mask)))
        if previous_gray is not None:
            deltas.append(float(np.mean(np.abs(gray.astype(np.float32) - previous_gray.astype(np.float32)))))
        if previous_mask is not None:
            mask_deltas.append(float(np.mean(mask != previous_mask)))
        ys, xs = np.nonzero(mask)
        if len(xs) > 0 and gray.shape[1] > 0 and gray.shape[0] > 0:
            centroid = (float(xs.mean() / gray.shape[1]), float(ys.mean() / gray.shape[0]))
            if previous_centroid is not None:
                dx = centroid[0] - previous_centroid[0]
                dy = centroid[1] - previous_centroid[1]
                centroid_path += float((dx * dx + dy * dy) ** 0.5)
            previous_centroid = centroid
        previous_gray = gray
        previous_mask = mask
    mean_mask_delta = float(np.mean(mask_deltas)) if mask_deltas else 0.0
    mean_frame_delta = float(np.mean(deltas)) if deltas else 0.0
    normalized_frame_delta = mean_frame_delta / 255.0
    return {
        "nonblank_ratio": float(np.mean(nonblank)),
        "mean_luma": float(np.mean(lumas)),
        "mean_frame_delta": mean_frame_delta,
        "normalized_frame_delta": normalized_frame_delta,
        "foreground_centroid_path": centroid_path,
        "mean_foreground_mask_delta": mean_mask_delta,
        "visual_progress": max(centroid_path, mean_mask_delta, normalized_frame_delta),
    }


def _write_contact_sheet(frames: list[np.ndarray], out_path: Path) -> bool:
    if not frames:
        return False
    thumb_w = 240
    thumbs = []
    for frame in frames:
        h, w = frame.shape[:2]
        if w <= 0 or h <= 0:
            continue
        thumb_h = max(1, int(h * (thumb_w / w)))
        thumbs.append(cv2.resize(frame, (thumb_w, thumb_h), interpolation=cv2.INTER_AREA))
    if not thumbs:
        return False
    max_h = max(t.shape[0] for t in thumbs)
    padded = []
    for thumb in thumbs:
        if thumb.shape[0] < max_h:
            pad = np.zeros((max_h - thumb.shape[0], thumb.shape[1], 3), dtype=thumb.dtype)
            thumb = np.vstack([thumb, pad])
        padded.append(thumb)
    sheet = np.hstack(padded)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    return bool(cv2.imwrite(str(out_path), sheet))


def review_videos(
    evidence_dir: Path,
    *,
    out_dir: Path,
    samples: int,
    min_frames: int,
    min_nonblank_ratio: float,
    min_mean_frame_delta: float,
    min_visual_progress: float = 0.0,
    require_telemetry: bool = False,
) -> dict[str, Any]:
    evidence_dir = evidence_dir.resolve()
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    videos = sorted(evidence_dir.glob("*/*.mp4"))
    reviews = []
    annotations = _load_manual_annotations(out_dir / "manual_frame_review.json")
    for video in videos:
        frames, meta = _sample_frames(video, samples)
        stats = _frame_stats(frames)
        telemetry = _load_telemetry(video.with_suffix(".telemetry.json"))
        telemetry_summary = _telemetry_summary(telemetry)
        telemetry_ok = _telemetry_ok(telemetry)
        contact_sheet = out_dir / f"{video.parent.name}_{_safe_stem(video)}_contact.jpg"
        contact_written = _write_contact_sheet(frames, contact_sheet)
        checks = {
            "open": bool(meta.get("open")),
            "frame_count": int(meta.get("frame_count", 0)) >= min_frames,
            "sampled_frames": len(frames) >= min(samples, max(int(meta.get("frame_count", 0)), 1)),
            "nonblank": stats["nonblank_ratio"] >= min_nonblank_ratio,
            "motion_or_camera_change": stats["mean_frame_delta"] >= min_mean_frame_delta,
            "action_progress": stats["visual_progress"] >= min_visual_progress,
            "contact_sheet": contact_written,
        }
        if require_telemetry:
            checks["telemetry_present"] = telemetry is not None
        if telemetry_ok is False:
            checks["telemetry_rollout_ok"] = False
        elif telemetry_ok is True:
            checks["telemetry_rollout_ok"] = True
        video_ok = all(checks.values())
        inferred_action = _infer_action(video.parent.name, video)
        rel_video = str(video.relative_to(evidence_dir))
        verdict = _review_verdict(
            checks=checks,
            action=inferred_action,
            stats=stats,
        )
        annotation = annotations.get(rel_video)
        manual_frame_review = None
        if annotation:
            manual_verdict = str(annotation.get("verdict") or verdict["verdict"])
            manual_notes = str(annotation.get("review_notes") or verdict["review_notes"])
            verdict = {
                "verdict": manual_verdict,
                "review_notes": manual_notes,
                "failed_checks": annotation.get("failed_checks")
                if isinstance(annotation.get("failed_checks"), list)
                else verdict["failed_checks"],
            }
            manual_frame_review = {
                "reviewer": annotation.get("reviewer", "codex"),
                "reviewed_contact_sheet": annotation.get("reviewed_contact_sheet", True),
            }
            video_ok = video_ok and manual_verdict == "good"
        reviews.append(
            {
                "profile": video.parent.name,
                "action": inferred_action,
                "video": rel_video,
                "bytes": video.stat().st_size,
                "contact_sheet": str(contact_sheet),
                "checks": checks,
                "telemetry": telemetry_summary,
                **meta,
                **stats,
                "ok": video_ok,
                "manual_frame_review": manual_frame_review,
                **verdict,
            }
        )
    ok = bool(reviews) and all(review.get("ok") is True for review in reviews)
    report = {
        "ok": ok,
        "evidence_dir": str(evidence_dir),
        "out_dir": str(out_dir),
        "thresholds": {
            "samples": samples,
            "min_frames": min_frames,
            "min_nonblank_ratio": min_nonblank_ratio,
            "min_mean_frame_delta": min_mean_frame_delta,
            "min_visual_progress": min_visual_progress,
            "require_telemetry": require_telemetry,
        },
        "manual_annotations": {
            "path": str(out_dir / "manual_frame_review.json"),
            "loaded": bool(annotations),
            "count": len(annotations),
        },
        "video_count": len(videos),
        "videos": reviews,
    }
    numeric_fields = (
        "visual_progress",
        "mean_frame_delta",
        "normalized_frame_delta",
        "foreground_centroid_path",
        "mean_foreground_mask_delta",
        "nonblank_ratio",
    )
    for field in numeric_fields:
        values = [
            float(review[field])
            for review in reviews
            if isinstance(review.get(field), int | float)
        ]
        report[f"min_{field}"] = min(values) if values else None
        report[f"mean_{field}"] = float(np.mean(values)) if values else None
    report["profiles"] = sorted({review["profile"] for review in reviews})
    report["actions"] = sorted({review["action"] for review in reviews})
    report["all_videos_reviewed_good"] = bool(reviews) and all(
        review.get("verdict") == "good" for review in reviews
    )
    report["telemetry"] = {
        "required": require_telemetry,
        "present_count": sum(
            1 for review in reviews if review.get("telemetry", {}).get("present") is True
        ),
        "ok_count": sum(
            1 for review in reviews if review.get("telemetry", {}).get("ok") is True
        ),
        "failed_count": sum(
            1 for review in reviews if review.get("telemetry", {}).get("ok") is False
        ),
    }
    report["profile_action_matrix"] = {
        profile: sorted(
            review["action"] for review in reviews if review["profile"] == profile
        )
        for profile in report["profiles"]
    }
    (out_dir / "video_review.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence-dir", type=Path, default=PKG_ROOT / "evidence" / "agent_videos")
    parser.add_argument("--out-dir", type=Path, default=PKG_ROOT / "evidence" / "video_review")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--min-frames", type=int, default=5)
    parser.add_argument("--min-nonblank-ratio", type=float, default=0.05)
    parser.add_argument("--min-mean-frame-delta", type=float, default=0.01)
    parser.add_argument("--min-visual-progress", type=float, default=0.0)
    parser.add_argument(
        "--require-telemetry",
        action="store_true",
        help="Require a .telemetry.json sidecar for every reviewed video.",
    )
    args = parser.parse_args(argv)
    report = review_videos(
        args.evidence_dir,
        out_dir=args.out_dir,
        samples=args.samples,
        min_frames=args.min_frames,
        min_nonblank_ratio=args.min_nonblank_ratio,
        min_mean_frame_delta=args.min_mean_frame_delta,
        min_visual_progress=args.min_visual_progress,
        require_telemetry=args.require_telemetry,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
