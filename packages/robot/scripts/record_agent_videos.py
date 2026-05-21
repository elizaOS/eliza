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

DEFAULT_PROFILES = ("hiwonder-ainex", "asimov-1", "unitree-g1", "unitree-h1")
DEFAULT_COMMANDS = (
    "stand up",
    "walk forward",
    "turn left",
    "turn right",
    "walk backward",
)


def _viewer_cmd(
    profile: str,
    commands: list[str],
    out_dir: Path,
    max_steps: int,
    width: int,
    height: int,
    record_camera: str | None,
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
    args = parser.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env.setdefault("JAX_PLATFORMS", "cpu")
    env.setdefault("MUJOCO_GL", "egl")

    manifest: dict = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "commands": list(args.commands),
        "profiles": [],
    }
    for profile in args.profiles:
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
            ),
            env=env,
            cwd=str(PKG_ROOT),
            capture_output=True,
            text=True,
        )
        videos = sorted(p.name for p in profile_dir.glob("*.mp4"))
        manifest["profiles"].append(
            {
                "profile": profile,
                "videos": videos,
                "stdout_tail": "\n".join(proc.stdout.splitlines()[-5:]),
                "stderr_tail": "\n".join(proc.stderr.splitlines()[-5:]),
                "exit_code": proc.returncode,
                "wall_clock_s": round(time.time() - t0, 2),
            }
        )
        print(
            f"[record-agent-videos] {profile}: "
            f"{len(videos)} mp4 in {profile_dir} "
            f"(rc={proc.returncode}, {time.time() - t0:.1f}s)",
            file=sys.stderr,
        )

    manifest_path = args.out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
