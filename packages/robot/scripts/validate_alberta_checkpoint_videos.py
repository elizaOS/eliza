#!/usr/bin/env python3
"""Validate checkpoint-bound local Alberta video evidence."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.record_agent_videos import expected_telemetry_names, expected_video_names  # noqa: E402

DEFAULT_PROFILES = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1", "unitree-r1")
DEFAULT_COMMANDS = ("stand up", "walk forward")


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _checkpoint_for_profile(package_root: Path, profile: str) -> Path:
    return (package_root / "evidence" / "alberta_all_profiles" / profile / "alberta").resolve()


def _expected_policy_source(package_root: Path, profile: str) -> str:
    rel = _checkpoint_for_profile(package_root, profile).relative_to(package_root)
    return f"checkpoint:{rel.as_posix()}"


def _checkpoint_manifest_ok(checkpoint: Path, profile: str) -> bool:
    manifest = _load_json(checkpoint / "manifest.json")
    return (
        checkpoint.is_dir()
        and (checkpoint / "alberta_policy.npz").is_file()
        and manifest.get("regime") == "alberta_streaming"
        and manifest.get("profile_id") == profile
    )


def _telemetry_sources_ok(telemetry: dict[str, Any], expected_source: str) -> bool:
    if telemetry.get("policy_source") != expected_source:
        return False
    commands = telemetry.get("commands")
    if isinstance(commands, list):
        return all(
            isinstance(command, dict) and command.get("policy_source") == expected_source
            for command in commands
        )
    return True


def _telemetry_rollout_ok(telemetry: dict[str, Any]) -> bool:
    rollout_ok = telemetry.get("rollout_ok")
    if isinstance(rollout_ok, bool):
        return rollout_ok
    commands = telemetry.get("commands")
    if isinstance(commands, list) and commands:
        return all(
            isinstance(command, dict) and command.get("rollout_ok") is True
            for command in commands
        )
    return False


def _finite_number(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, int | float) and math.isfinite(float(value))


def _stats_present(stats: Any) -> bool:
    if not isinstance(stats, dict):
        return False
    return all(_finite_number(stats.get(key)) for key in ("min", "max", "final", "mean"))


def _single_rollout_signal_ok(telemetry: dict[str, Any], *, min_steps_executed: int) -> bool:
    checks = telemetry.get("checks") if isinstance(telemetry.get("checks"), dict) else {}
    return bool(
        isinstance(telemetry.get("steps_executed"), int)
        and int(telemetry["steps_executed"]) >= min_steps_executed
        and _stats_present(telemetry.get("reward"))
        and _stats_present(telemetry.get("torso_z"))
        and _stats_present(telemetry.get("upright_proj"))
        and checks.get("no_termination") is True
        and checks.get("torso_above_fall_threshold") is True
        and checks.get("upright_positive") is True
    )


def _telemetry_task_signal_ok(telemetry: dict[str, Any], *, min_steps_executed: int) -> bool:
    commands = telemetry.get("commands")
    if isinstance(commands, list):
        return bool(commands) and all(
            isinstance(command, dict)
            and _single_rollout_signal_ok(command, min_steps_executed=min_steps_executed)
            for command in commands
        )
    return _single_rollout_signal_ok(telemetry, min_steps_executed=min_steps_executed)


def validate_alberta_checkpoint_videos(
    *,
    package_root: Path,
    evidence_dir: Path,
    review_path: Path,
    profiles: tuple[str, ...] = DEFAULT_PROFILES,
    commands: tuple[str, ...] = DEFAULT_COMMANDS,
    min_video_bytes: int = 1024,
    min_steps_executed: int = 1,
) -> dict[str, Any]:
    package_root = package_root.resolve()
    evidence_dir = evidence_dir.resolve()
    review_path = review_path.resolve()
    manifest_path = evidence_dir / "manifest.json"
    manifest = _load_json(manifest_path)
    review = _load_json(review_path)
    entries = manifest.get("profiles") if isinstance(manifest.get("profiles"), list) else []
    entries_by_profile = {
        entry["profile"]: entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("profile"), str)
    }

    profile_reports: list[dict[str, Any]] = []
    all_video_reports: list[dict[str, Any]] = []
    for profile in profiles:
        checkpoint = _checkpoint_for_profile(package_root, profile)
        expected_checkpoint = str(checkpoint)
        expected_source = _expected_policy_source(package_root, profile)
        entry = entries_by_profile.get(profile, {})
        expected_videos = expected_video_names(
            profile,
            list(commands),
            record_combined=True,
        )
        expected_telemetry = expected_telemetry_names(
            profile,
            list(commands),
            record_combined=True,
        )
        profile_dir = evidence_dir / profile
        video_reports = []
        for video_name, telemetry_name in zip(expected_videos, expected_telemetry, strict=True):
            video_path = profile_dir / video_name
            telemetry_path = profile_dir / telemetry_name
            telemetry = _load_json(telemetry_path)
            video_report = {
                "video": str(video_path),
                "telemetry": str(telemetry_path),
                "video_present": video_path.is_file(),
                "telemetry_present": telemetry_path.is_file(),
                "video_bytes": video_path.stat().st_size if video_path.is_file() else 0,
                "telemetry_policy_source": telemetry.get("policy_source"),
                "expected_policy_source": expected_source,
                "policy_source_ok": _telemetry_sources_ok(telemetry, expected_source),
                "rollout_ok": _telemetry_rollout_ok(telemetry),
                "task_signal_ok": _telemetry_task_signal_ok(
                    telemetry,
                    min_steps_executed=min_steps_executed,
                ),
            }
            video_report["ok"] = bool(
                video_report["video_present"]
                and video_report["telemetry_present"]
                and int(video_report["video_bytes"]) >= int(min_video_bytes)
                and video_report["policy_source_ok"]
                and video_report["rollout_ok"]
                and video_report["task_signal_ok"]
            )
            video_reports.append(video_report)
            all_video_reports.append({"profile": profile, **video_report})
        manifest_checkpoint = entry.get("policy_checkpoint")
        profile_checks = {
            "manifest_entry": bool(entry),
            "manifest_entry_ok": entry.get("ok") is True,
            "manifest_checkpoint": manifest_checkpoint == expected_checkpoint,
            "checkpoint_manifest": _checkpoint_manifest_ok(checkpoint, profile),
            "expected_videos": all(video.get("ok") is True for video in video_reports),
        }
        profile_reports.append(
            {
                "profile": profile,
                "checkpoint": expected_checkpoint,
                "expected_policy_source": expected_source,
                "checks": profile_checks,
                "ok": all(profile_checks.values()),
                "videos": video_reports,
            }
        )

    expected_video_count = len(profiles) * (len(commands) + 1)
    review_checks = {
        "present": review_path.is_file(),
        "ok": review.get("ok") is True,
        "video_count": review.get("video_count") == expected_video_count,
        "profiles": sorted(review.get("profiles") or []) == sorted(profiles),
        "actions": sorted(review.get("actions") or []) == ["combined_actions"]
        + sorted(command.replace(" ", "_") for command in commands),
        "telemetry_present": (review.get("telemetry") or {}).get("present_count") == expected_video_count,
        "telemetry_ok": (review.get("telemetry") or {}).get("ok_count") == expected_video_count,
        "telemetry_failed": (review.get("telemetry") or {}).get("failed_count") == 0,
        "all_videos_reviewed_good": review.get("all_videos_reviewed_good") is True,
    }
    checks = {
        "manifest": manifest_path.is_file(),
        "manifest_ok": manifest.get("ok") is True,
        "profiles": all(profile.get("ok") is True for profile in profile_reports),
        "review": all(review_checks.values()),
        "videos": all(video.get("ok") is True for video in all_video_reports),
    }
    return {
        "schema": "robot-alberta-checkpoint-video-validation-v1",
        "ok": all(checks.values()),
        "package_root": str(package_root),
        "evidence_dir": str(evidence_dir),
        "manifest": str(manifest_path),
        "review": str(review_path),
        "profiles": list(profiles),
        "commands": list(commands),
        "expected_video_count": expected_video_count,
        "min_steps_executed": min_steps_executed,
        "checks": checks,
        "review_checks": review_checks,
        "profile_reports": profile_reports,
        "video_reports": all_video_reports,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-root", type=Path, default=ROOT)
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        default=ROOT / "evidence" / "alberta_checkpoint_videos",
    )
    parser.add_argument(
        "--review",
        type=Path,
        default=ROOT / "evidence" / "alberta_checkpoint_video_review" / "video_review.json",
    )
    parser.add_argument("--profiles", nargs="+", default=list(DEFAULT_PROFILES))
    parser.add_argument("--commands", nargs="+", default=list(DEFAULT_COMMANDS))
    parser.add_argument("--min-video-bytes", type=int, default=1024)
    parser.add_argument("--min-steps-executed", type=int, default=1)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    report = validate_alberta_checkpoint_videos(
        package_root=args.package_root,
        evidence_dir=args.evidence_dir,
        review_path=args.review,
        profiles=tuple(args.profiles),
        commands=tuple(args.commands),
        min_video_bytes=args.min_video_bytes,
        min_steps_executed=args.min_steps_executed,
    )
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
