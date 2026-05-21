"""Interactive MuJoCo viewer for the text-conditioned policy.

Open a `mujoco.viewer.launch_passive` window on the requested robot
profile, accept free-form text commands from stdin (or a websocket), and
let the trained policy drive the joints in real time. Optionally record
mp4 / gif of each command for evidence.

Run (interactive)::
    uv run python scripts/interactive_viewer.py --profile unitree-g1
    # then type commands at the prompt:
    >> walk forward
    >> turn left
    >> stand up

Run (scripted)::
    uv run python scripts/interactive_viewer.py --profile unitree-g1 \\
        --commands "walk forward" "turn left" --record evidence/agent_videos/

The text command is embedded via the same sentence-transformer + PCA
encoder used at training time, then fed into the profile env's task
slot for `max-steps` ticks. When a trained SB3 policy is found at
`checkpoints/text_conditioned_<profile>_smoke/policy.zip` it is loaded;
otherwise a zero-action fallback runs (useful for verifying the viewer +
ego-camera wiring before training has converged).
"""

from __future__ import annotations

import argparse
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

os.environ.setdefault("JAX_PLATFORMS", "cpu")

from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import list_profiles, load_profile  # noqa: E402
from eliza_robot.rl.text_conditioned.encoder import build_task_embeddings  # noqa: E402
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)


def _resolve_task_id(text: str, task_ids: list[str]) -> str | None:
    """Match free-form text against the curriculum tasks. Cheap substring
    match first, then token overlap; returns None if nothing matches."""
    low = text.lower().strip()
    if not low:
        return None
    # Exact id / underscored variant
    direct = low.replace(" ", "_")
    if direct in task_ids:
        return direct
    # Substring: 'walk forward' -> 'walk_forward'
    for tid in task_ids:
        if all(tok in low for tok in tid.split("_")):
            return tid
    return None


def _load_sb3_policy(profile_id: str):
    """Return a callable `policy(obs)->action` or None if no checkpoint."""
    ckpt_path = PKG_ROOT / "checkpoints" / f"text_conditioned_{profile_id}_smoke" / "policy.zip"
    if not ckpt_path.is_file():
        return None
    try:
        from stable_baselines3 import PPO
    except ImportError:
        return None
    model = PPO.load(str(ckpt_path), device="cpu")
    print(f"[viewer] loaded SB3 policy from {ckpt_path}", file=sys.stderr)

    def _act(obs: np.ndarray) -> np.ndarray:
        action, _ = model.predict(obs, deterministic=True)
        return np.asarray(action, dtype=np.float32).reshape(-1)

    return _act


def _start_recorder(out_dir: Path, profile_id: str, label: str, *, width: int, height: int):
    try:
        import imageio.v2 as imageio
    except ImportError:
        return None, None
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_label = label.replace(" ", "_").replace("/", "_")[:48]
    path = out_dir / f"{profile_id}_{safe_label}.mp4"
    writer = imageio.get_writer(
        path,
        fps=30,
        codec="libx264",
        quality=8,
        macro_block_size=None,
    )
    print(f"[viewer] recording {path}", file=sys.stderr)
    return writer, path


def run(
    profile_id: str,
    *,
    commands: list[str] | None,
    record_dir: Path | None,
    max_steps_per_cmd: int,
    headless: bool,
    width: int,
    height: int,
    record_camera: str | None = None,
) -> int:
    import mujoco

    profile = load_profile(profile_id)
    curriculum = load_curriculum()
    pca_dim = 32
    embeddings = build_task_embeddings(curriculum=curriculum, pca_dim=pca_dim)

    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=tuple(t.id for t in curriculum.tasks),
            exclude_tasks=(),
            episode_steps=max_steps_per_cmd,
            pca_dim=pca_dim,
        ),
        curriculum=curriculum,
        embeddings=embeddings,
    )
    env.reset(seed=0)
    env._ensure_model()  # noqa: SLF001 — viewer needs the model handle
    model, data = env._model, env._data  # noqa: SLF001
    # Offscreen recorder needs ground plane + lights; if the profile ships
    # a scene_xml use it for visualization while training runs on bare MJCF.
    render_model = model
    render_data = data
    if profile.assets.scene_xml is not None and profile.assets.scene_xml.is_file():
        render_model = mujoco.MjModel.from_xml_path(str(profile.assets.scene_xml))
        render_data = mujoco.MjData(render_model)

    policy = _load_sb3_policy(profile_id)
    if policy is None:
        print(
            f"[viewer] no SB3 policy at checkpoints/text_conditioned_{profile_id}_smoke/; "
            "using zero-action fallback",
            file=sys.stderr,
        )

    task_ids = list(env.task_ids)
    cmd_queue: queue.Queue[str] = queue.Queue()
    if commands:
        for c in commands:
            cmd_queue.put(c)
    else:
        def _reader():
            print("[viewer] type a command (or 'quit'):", file=sys.stderr)
            for line in sys.stdin:
                line = line.strip()
                if line.lower() in {"quit", "exit", ":q"}:
                    cmd_queue.put("__QUIT__")
                    return
                if line:
                    cmd_queue.put(line)
        threading.Thread(target=_reader, daemon=True).start()

    viewer = None if headless else mujoco.viewer.launch_passive(render_model, render_data)
    renderer = (
        mujoco.Renderer(render_model, height=height, width=width)
        if record_dir
        else None
    )

    def _tick(label: str, writer) -> int:
        # Run max_steps_per_cmd steps with the resolved task active.
        obs = env._build_obs()  # noqa: SLF001
        last = time.time()
        for _ in range(max_steps_per_cmd):
            if policy is not None:
                action = policy(obs)
            else:
                action = np.zeros(env.action_space.shape, dtype=np.float32)
            obs, _, term, trunc, _ = env.step(action)
            # Sync qpos/qvel from the training MJCF into the scene MJCF so the
            # renderer shows the live policy state on top of the ground plane.
            if render_data is not data and render_model.nq == model.nq:
                render_data.qpos[:] = data.qpos
                render_data.qvel[:] = data.qvel
                mujoco.mj_forward(render_model, render_data)
            if writer is not None and renderer is not None:
                if record_camera and any(
                    c.name == record_camera for c in profile.sensors.cameras
                ):
                    renderer.update_scene(render_data, camera=record_camera)
                else:
                    renderer.update_scene(render_data)
                writer.append_data(renderer.render())
            if viewer is not None:
                viewer.sync()
            now = time.time()
            dt = 0.02 - (now - last)
            if dt > 0:
                time.sleep(dt)
            last = time.time()
            if term or trunc:
                return 1
        return 0

    try:
        while True:
            try:
                text = cmd_queue.get(timeout=0.05)
            except queue.Empty:
                if viewer is not None:
                    viewer.sync()
                if commands:
                    break
                continue
            if text == "__QUIT__":
                break
            task_id = _resolve_task_id(text, task_ids)
            if task_id is None:
                print(f"[viewer] no curriculum task matches {text!r}", file=sys.stderr)
                continue
            env._current_task = next(t for t in env.active_tasks if t.id == task_id)  # noqa: SLF001
            env._current_embed = embeddings[task_id].reduced_embed.astype(np.float32)  # noqa: SLF001
            env._step_count = 0  # noqa: SLF001
            writer, path = (None, None)
            if record_dir is not None:
                writer, path = _start_recorder(
                    record_dir, profile_id, text, width=width, height=height
                )
            print(f"[viewer] executing task={task_id} ({text!r})", file=sys.stderr)
            _tick(text, writer)
            if writer is not None:
                writer.close()
                print(f"[viewer] saved {path}", file=sys.stderr)
    finally:
        if viewer is not None:
            viewer.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=list_profiles(), required=True)
    parser.add_argument(
        "--commands",
        nargs="*",
        default=None,
        help="Run a fixed list of commands then exit (non-interactive).",
    )
    parser.add_argument(
        "--record",
        type=Path,
        default=None,
        help="Directory to write mp4 recordings into (one per command).",
    )
    parser.add_argument("--max-steps-per-cmd", type=int, default=300)
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Skip mujoco.viewer (useful in CI / when only recording mp4).",
    )
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument(
        "--record-camera",
        default=None,
        help="Render from this named camera (e.g. 'head_cam' for ego-pose).",
    )
    args = parser.parse_args(argv)
    return run(
        args.profile,
        commands=args.commands,
        record_dir=args.record,
        max_steps_per_cmd=args.max_steps_per_cmd,
        headless=args.headless,
        width=args.width,
        height=args.height,
        record_camera=args.record_camera,
    )


if __name__ == "__main__":
    raise SystemExit(main())
