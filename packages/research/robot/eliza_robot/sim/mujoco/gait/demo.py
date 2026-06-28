"""CLI demo for the Bezier gait controller.

    python -m eliza_robot.sim.mujoco.gait.demo --vx 0.2 --duration 5

Optionally renders a 2 s GIF to ``packages/robot/out/gait_demo.gif``.
The ``out/`` directory is gitignored.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import numpy as np

from .controller import BezierGaitController
from .joystick_driver import JoystickGaitDriver

logger = logging.getLogger("eliza_robot.gait.demo")


def _out_dir() -> Path:
    """Return the package-local ``out/`` directory, creating it if absent."""
    # gait/ -> mujoco/ -> sim/ -> eliza_robot/ -> packages/robot/
    pkg_root = Path(__file__).resolve().parents[4]
    out = pkg_root / "out"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _save_gif(frames: list[np.ndarray], path: Path, fps: int = 30) -> None:
    """Write ``frames`` to ``path`` as an animated GIF.

    Tries Pillow first; falls back to imageio if available.
    """
    try:
        from PIL import Image

        pil_frames = [Image.fromarray(f) for f in frames]
        if not pil_frames:
            raise ValueError("no frames to save")
        pil_frames[0].save(
            path,
            save_all=True,
            append_images=pil_frames[1:],
            duration=int(1000 / fps),
            loop=0,
            optimize=False,
        )
        return
    except ImportError:
        pass

    import imageio.v2 as imageio  # type: ignore

    imageio.mimsave(path, frames, fps=fps)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vx", type=float, default=0.2, help="Forward velocity (m/s)")
    parser.add_argument("--vy", type=float, default=0.0, help="Lateral velocity (m/s)")
    parser.add_argument("--vyaw", type=float, default=0.0, help="Yaw rate (rad/s)")
    parser.add_argument("--duration", type=float, default=5.0, help="Run length (s)")
    parser.add_argument(
        "--render",
        action="store_true",
        help="Render a 2 s GIF to packages/robot/out/gait_demo.gif",
    )
    parser.add_argument("--swing-height", type=float, default=0.08)
    parser.add_argument("--cycle-hz", type=float, default=4.1)
    parser.add_argument("--gif-seconds", type=float, default=2.0)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

    controller = BezierGaitController(
        swing_height=args.swing_height,
        cycle_hz=args.cycle_hz,
    )

    driver = JoystickGaitDriver(controller=controller)
    rollout = driver.run(
        vx=args.vx,
        vy=args.vy,
        vyaw=args.vyaw,
        duration_s=args.duration,
        render=args.render,
    )

    base_z = rollout.qpos[:, 2]
    logger.info(
        "rollout: T=%d  base_z mean=%.3f m  min=%.3f m  max=%.3f m",
        rollout.qpos.shape[0],
        float(base_z.mean()),
        float(base_z.min()),
        float(base_z.max()),
    )

    if args.render:
        if not rollout.frames:
            logger.warning("--render set but no frames captured; skipping GIF")
            return 0
        fps = int(round(1.0 / driver.ctrl_dt))
        keep = int(round(args.gif_seconds * fps))
        frames = rollout.frames[:keep] if keep > 0 else rollout.frames
        out_path = _out_dir() / "gait_demo.gif"
        _save_gif(frames, out_path, fps=fps)
        logger.info("wrote %s (%d frames @ %d fps)", out_path, len(frames), fps)

    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
