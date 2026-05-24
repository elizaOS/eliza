"""End-to-end agent → robot → video harness.

Drives each supported profile through the same set of free-form text
commands the Eliza chat agent would emit via the `AINEX_RUN_RL` action,
records an mp4 per (profile, command), and writes a manifest summarizing
the run. The output mirrors what `examples/robot-mujoco-demo/` would
produce in chat — but headless and reproducible for CI / evidence.

Run::
    uv run python scripts/record_agent_videos.py \\
        --out evidence/agent_videos --max-steps 200
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[1]

DEFAULT_PROFILES = (
    "hiwonder-ainex",
    "asimov-1",
    "unitree-g1",
    "unitree-h1",
    "unitree-r1",
)
DEFAULT_COMMANDS = (
    "stand up",
    "walk forward",
    "turn left",
    "turn right",
    "walk backward",
)


def _safe_label(label: str) -> str:
    return label.replace(" ", "_").replace("/", "_")[:48]


def expected_video_names(
    profile: str,
    commands: list[str],
    *,
    record_combined: bool,
) -> list[str]:
    names = [f"{profile}_{_safe_label(command)}.mp4" for command in commands]
    if record_combined:
        names.append(f"{profile}_combined_actions.mp4")
    return names


def expected_telemetry_names(
    profile: str,
    commands: list[str],
    *,
    record_combined: bool,
) -> list[str]:
    return [
        Path(name).with_suffix(".telemetry.json").name
        for name in expected_video_names(
            profile,
            commands,
            record_combined=record_combined,
        )
    ]


def _viewer_cmd(
    profile: str,
    commands: list[str],
    out_dir: Path,
    max_steps: int,
    width: int,
    height: int,
    record_camera: str | None,
    record_combined: bool,
    policy_checkpoint: Path | None = None,
    preserve_state_between_commands: bool = False,
) -> list[str]:
    args = [
        sys.executable,
        str(PKG_ROOT / "scripts" / "interactive_viewer.py"),
        "--profile",
        profile,
        "--commands",
        *commands,
        "--headless",
        "--max-steps-per-cmd",
        str(max_steps),
        "--record",
        str(out_dir),
        "--width",
        str(width),
        "--height",
        str(height),
    ]
    if record_camera:
        args += ["--record-camera", record_camera]
    if record_combined:
        args.append("--record-combined")
    if policy_checkpoint is not None:
        args += ["--policy-checkpoint", str(policy_checkpoint)]
    if preserve_state_between_commands:
        args.append("--preserve-state-between-commands")
    return args


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profiles",
        nargs="+",
        default=list(DEFAULT_PROFILES),
        choices=list(DEFAULT_PROFILES),
    )
    parser.add_argument("--commands", nargs="+", default=list(DEFAULT_COMMANDS))
    parser.add_argument(
        "--out",
        type=Path,
        default=PKG_ROOT / "evidence" / "agent_videos",
    )
    parser.add_argument("--max-steps", type=int, default=200)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument(
        "--record-camera",
        default=None,
        help="Optional named camera (e.g. head_cam) — ego-pose recording.",
    )
    parser.add_argument(
        "--policy-checkpoint",
        type=Path,
        default=None,
        help="Optional trained text-conditioned checkpoint to drive recordings.",
    )
    parser.add_argument(
        "--no-record-combined",
        action="store_true",
        help="Disable the default combined-actions mp4 per profile.",
    )
    parser.add_argument(
        "--preserve-state-between-commands",
        action="store_true",
        help=(
            "Run scripted commands as one continuous rollout. By default each "
            "command resets before recording so per-action clips are independent."
        ),
    )
    args = parser.parse_args(argv)
    record_combined = not args.no_record_combined

    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.setdefault("JAX_PLATFORMS", "cpu")
    env.setdefault("MUJOCO_GL", "egl")

    previous_manifest: dict = {}
    previous_manifest_path = args.out / "manifest.json"
    if previous_manifest_path.is_file():
        try:
            loaded = json.loads(previous_manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            loaded = {}
        previous_manifest = loaded if isinstance(loaded, dict) else {}
    previous_entries = {
        entry["profile"]: entry
        for entry in previous_manifest.get("profiles", [])
        if isinstance(entry, dict) and isinstance(entry.get("profile"), str)
    }

    manifest: dict = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "commands": list(args.commands),
        "record_combined": record_combined,
        "preserve_state_between_commands": args.preserve_state_between_commands,
        "policy_checkpoint": (
            str(args.policy_checkpoint.resolve())
            if args.policy_checkpoint is not None
            else None
        ),
        "profiles": [],
    }
    recorded_profiles: set[str] = set()
    ok = True
    for profile in args.profiles:
        recorded_profiles.add(profile)
        profile_dir = args.out / profile
        profile_dir.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        proc = subprocess.run(
            _viewer_cmd(
                profile,
                args.commands,
                profile_dir,
                args.max_steps,
                args.width,
                args.height,
                args.record_camera,
                record_combined,
                args.policy_checkpoint,
                args.preserve_state_between_commands,
            ),
            env=env,
            cwd=str(PKG_ROOT),
            capture_output=True,
            text=True,
        )
        videos = sorted(p.name for p in profile_dir.glob("*.mp4"))
        telemetry = sorted(p.name for p in profile_dir.glob("*.telemetry.json"))
        expected = expected_video_names(
            profile,
            list(args.commands),
            record_combined=record_combined,
        )
        expected_telemetry = expected_telemetry_names(
            profile,
            list(args.commands),
            record_combined=record_combined,
        )
        missing = [name for name in expected if not (profile_dir / name).is_file()]
        missing_telemetry = [
            name for name in expected_telemetry if not (profile_dir / name).is_file()
        ]
        combined_video = f"{profile}_combined_actions.mp4"
        profile_ok = proc.returncode == 0 and not missing and not missing_telemetry
        ok = ok and profile_ok
        manifest["profiles"].append(
            {
                "profile": profile,
                "videos": videos,
                "telemetry": telemetry,
                "expected_videos": expected,
                "expected_telemetry": expected_telemetry,
                "missing_videos": missing,
                "missing_telemetry": missing_telemetry,
                "combined_video": combined_video if record_combined else None,
                "combined_present": (
                    (profile_dir / combined_video).is_file()
                    if record_combined
                    else None
                ),
                "policy_checkpoint": manifest["policy_checkpoint"],
                "stdout_tail": "\n".join(proc.stdout.splitlines()[-5:]),
                "stderr_tail": "\n".join(proc.stderr.splitlines()[-5:]),
                "exit_code": proc.returncode,
                "ok": profile_ok,
                "wall_clock_s": round(time.time() - t0, 2),
            }
        )
        print(
            f"[record-agent-videos] {profile}: "
            f"{len(videos)} mp4 in {profile_dir} "
            f"(rc={proc.returncode}, {time.time() - t0:.1f}s)",
            file=sys.stderr,
        )

    for profile in DEFAULT_PROFILES:
        if profile in recorded_profiles:
            continue
        profile_dir = args.out / profile
        expected = expected_video_names(
            profile,
            list(args.commands),
            record_combined=record_combined,
        )
        if not all((profile_dir / name).is_file() for name in expected):
            continue
        videos = sorted(p.name for p in profile_dir.glob("*.mp4"))
        telemetry = sorted(p.name for p in profile_dir.glob("*.telemetry.json"))
        expected_telemetry = expected_telemetry_names(
            profile,
            list(args.commands),
            record_combined=record_combined,
        )
        missing_telemetry = [
            name for name in expected_telemetry if not (profile_dir / name).is_file()
        ]
        combined_video = f"{profile}_combined_actions.mp4"
        previous_entry = previous_entries.get(profile, {})
        preserved_checkpoint = (
            previous_entry.get("policy_checkpoint")
            if isinstance(previous_entry.get("policy_checkpoint"), str)
            else None
        )
        profile_ok = not missing_telemetry
        ok = ok and profile_ok
        manifest["profiles"].append(
            {
                "profile": profile,
                "videos": videos,
                "telemetry": telemetry,
                "expected_videos": expected,
                "expected_telemetry": expected_telemetry,
                "missing_videos": [],
                "missing_telemetry": missing_telemetry,
                "combined_video": combined_video if record_combined else None,
                "combined_present": (
                    (profile_dir / combined_video).is_file()
                    if record_combined
                    else None
                ),
                "policy_checkpoint": preserved_checkpoint,
                "stdout_tail": "",
                "stderr_tail": "",
                "exit_code": None,
                "ok": profile_ok,
                "wall_clock_s": 0.0,
                "manifest_source": "existing_files",
            }
        )

    manifest_path = args.out / "manifest.json"
    manifest["ok"] = ok
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
