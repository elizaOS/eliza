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
slot for `max-steps` ticks. `--policy-checkpoint` loads the same
framework-agnostic policy wrapper as the bridge (Alberta, PPO, Brax);
without it the viewer tries a matching Alberta checkpoint first, then the
historical SB3 smoke checkpoint, then zero actions for rendering/wiring checks.
"""

from __future__ import annotations

import argparse
import json
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

from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample  # noqa: E402
from eliza_robot.curriculum.loader import Curriculum, load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import list_profiles, load_profile  # noqa: E402
from eliza_robot.rl.text_conditioned.encoder import build_task_embeddings  # noqa: E402
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy  # noqa: E402
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)

DEFAULT_ALBERTA_CHECKPOINT = PKG_ROOT / "checkpoints" / "alberta_text_conditioned"


def _resolve_task_id(text: str, task_ids: list[str], curriculum: Curriculum) -> str | None:
    """Match free-form text against the curriculum tasks. Cheap substring
    match first, then token overlap; returns None if nothing matches."""
    found = curriculum.find_by_text(text)
    if found is not None and found.id in task_ids:
        return found.id
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


def _scripted_smoke_action(env, task_id: str, step_idx: int) -> np.ndarray:
    """Deterministic command-specific action used only for interactive smoke.

    This is not a learned policy. It exists so a clean local checkout can prove
    the text->task->joint-control path attempts nonzero behavior instead of
    silently producing zero-action evidence.
    """
    action = np.zeros(env.action_space.shape, dtype=np.float32)
    phase = step_idx * 0.35
    for idx, joint in enumerate(env._action_joints):  # noqa: SLF001
        name = joint.name.lower()
        side = -1.0 if name.startswith(("l_", "left_")) else 1.0
        if task_id == "stand_up":
            action[idx] = 0.0
        elif task_id == "sit_down":
            if "hip_pitch" in name:
                action[idx] = -0.8
            elif "knee" in name:
                action[idx] = 0.9
            elif "ank" in name and "pitch" in name:
                action[idx] = -0.6
        elif task_id in {"walk_forward", "walk_backward"}:
            direction = 1.0 if task_id == "walk_forward" else -1.0
            gait = np.sin(phase + (0.0 if side > 0 else np.pi))
            if "hip_pitch" in name:
                action[idx] = direction * 0.55 * gait
            elif "knee" in name:
                action[idx] = 0.35 * max(0.0, gait)
            elif "ank" in name and "pitch" in name:
                action[idx] = -direction * 0.25 * gait
        elif task_id in {"sidestep_left", "sidestep_right"}:
            direction = 1.0 if task_id == "sidestep_left" else -1.0
            gait = np.sin(phase + (0.0 if side > 0 else np.pi))
            if "hip_roll" in name:
                action[idx] = direction * 0.45 * gait
            elif "ank" in name and "roll" in name:
                action[idx] = -direction * 0.25 * gait
        elif task_id in {"turn_left", "turn_right", "turn_around"}:
            direction = 1.0 if task_id == "turn_left" else -1.0
            if task_id == "turn_around":
                direction = 1.0
            gait = np.sin(phase + (0.0 if side > 0 else np.pi))
            if "hip_yaw" in name:
                action[idx] = direction * 0.55 * side
            elif "hip_pitch" in name:
                action[idx] = 0.35 * gait
            elif "ank" in name and "roll" in name:
                action[idx] = -0.2 * direction * side
    return np.clip(action, -1.0, 1.0).astype(np.float32)


def _read_checkpoint_profile_id(checkpoint_dir: Path) -> str | None:
    manifest = checkpoint_dir / "manifest.json"
    if not manifest.is_file():
        return None
    try:
        import json

        raw = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    profile_id = raw.get("profile_id")
    return str(profile_id) if profile_id else None


def _candidate_default_policy_checkpoints(
    profile_id: str,
    *,
    root: Path = PKG_ROOT,
) -> list[Path]:
    profile_slug = profile_id.replace("-", "_")
    candidates: list[Path] = []
    env_checkpoint = os.environ.get("ROBOT_POLICY_CHECKPOINT")
    if env_checkpoint:
        candidates.append(Path(env_checkpoint))
    candidates.extend([
        root / "checkpoints" / f"{profile_slug}_alberta_full",
        root
        / "evidence"
        / "nebius_full_training"
        / "synced_run"
        / "checkpoints"
        / f"{profile_slug}_alberta_full",
        root / "checkpoints" / "alberta_text_conditioned",
    ])
    return candidates


def _resolve_default_policy_checkpoint(
    profile_id: str,
    *,
    root: Path = PKG_ROOT,
) -> Path | None:
    for checkpoint in _candidate_default_policy_checkpoints(profile_id, root=root):
        if _read_checkpoint_profile_id(checkpoint) == profile_id:
            return checkpoint
    return None


def _load_checkpoint_policy(profile_id: str, checkpoint_dir: Path):
    """Return a callable `policy(label, obs)->action` for any policy backend."""

    policy = TextConditionedPolicy(checkpoint_dir, strict_manifest=True)
    if policy.manifest.profile_id != profile_id:
        raise ValueError(
            "checkpoint profile mismatch: "
            f"manifest profile_id={policy.manifest.profile_id!r}, "
            f"viewer profile_id={profile_id!r}"
        )
    print(f"[viewer] loaded text-conditioned policy from {checkpoint_dir}", file=sys.stderr)

    def _act(label: str, obs: np.ndarray) -> np.ndarray:
        proprio_dim = int(
            policy.manifest.proprio_dim
            or policy.manifest.obs_dim - policy.manifest.pca_dim
        )
        action, _ = policy.act(
            label,
            obs[:proprio_dim],
            deterministic=True,
            output_dim=policy.manifest.action_dim,
        )
        return np.asarray(action, dtype=np.float32).reshape(-1)

    return _act


def _load_sb3_policy(profile_id: str):
    """Return a callable `policy(label, obs)->action` or None if no checkpoint."""
    ckpt_path = PKG_ROOT / "checkpoints" / f"text_conditioned_{profile_id}_smoke" / "policy.zip"
    if not ckpt_path.is_file():
        return None
    try:
        from stable_baselines3 import PPO
    except ImportError:
        return None
    model = PPO.load(str(ckpt_path), device="cpu")
    print(f"[viewer] loaded SB3 policy from {ckpt_path}", file=sys.stderr)

    def _act(_label: str, obs: np.ndarray) -> np.ndarray:
        action, _ = model.predict(obs, deterministic=True)
        return np.asarray(action, dtype=np.float32).reshape(-1)

    return _act


def _start_recorder(out_dir: Path, profile_id: str, label: str, *, width: int, height: int):
    try:
        import imageio.v2 as imageio
    except ImportError as exc:
        raise RuntimeError(
            "recording requires imageio[ffmpeg]; install the robot package dependencies"
        ) from exc
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


def _telemetry_path(video_path: Path) -> Path:
    return video_path.with_suffix(".telemetry.json")


def _finite_float(value) -> float | None:
    try:
        fval = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(fval):
        return None
    return fval


def _series_summary(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"min": None, "max": None, "final": None, "mean": None}
    return {
        "min": min(values),
        "max": max(values),
        "final": values[-1],
        "mean": float(np.mean(values)),
    }


def _write_telemetry(path: Path, telemetry: dict) -> None:
    path.write_text(json.dumps(telemetry, indent=2) + "\n", encoding="utf-8")
    print(f"[viewer] saved telemetry {path}", file=sys.stderr)


def _append_frame(
    *,
    renderer,
    render_data,
    writers: list,
    profile,
    record_camera: str | None,
) -> None:
    if not writers or renderer is None:
        return
    if record_camera and any(c.name == record_camera for c in profile.sensors.cameras):
        renderer.update_scene(render_data, camera=record_camera)
    else:
        renderer.update_scene(render_data)
    frame = renderer.render()
    for writer in writers:
        writer.append_data(frame)


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
    record_combined: bool = False,
    policy_checkpoint: Path | None = None,
    preserve_state_between_commands: bool = False,
    scripted_smoke: bool = False,
    allow_zero_action_fallback: bool = False,
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

    if scripted_smoke and policy_checkpoint is not None:
        raise ValueError("--scripted-smoke and --policy-checkpoint are mutually exclusive")
    if scripted_smoke:
        policy = None
        policy_source = "scripted_smoke"
    elif policy_checkpoint is not None:
        policy = _load_checkpoint_policy(profile_id, policy_checkpoint)
        policy_source = f"checkpoint:{policy_checkpoint}"
    else:
        default_checkpoint = _resolve_default_policy_checkpoint(profile_id)
        if default_checkpoint is not None:
            policy = _load_checkpoint_policy(profile_id, default_checkpoint)
            policy_source = f"checkpoint:{default_checkpoint}"
        else:
            policy = _load_sb3_policy(profile_id)
            policy_source = "sb3_smoke" if policy is not None else "zero_action"
    if policy is None and not scripted_smoke:
        if not allow_zero_action_fallback:
            raise FileNotFoundError(
                "no trained policy checkpoint found for "
                f"profile={profile_id!r}. Pass --policy-checkpoint, set "
                "ROBOT_POLICY_CHECKPOINT, use --scripted-smoke for wiring "
                "evidence, or pass --allow-zero-action-fallback explicitly."
            )
        print(
            "[viewer] no matching Alberta checkpoint or SB3 policy at "
            f"checkpoints/text_conditioned_{profile_id}_smoke/; "
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

    combined_writer, combined_path = (None, None)
    if record_dir is not None and record_combined and commands:
        combined_writer, combined_path = _start_recorder(
            record_dir,
            profile_id,
            "combined_actions",
            width=width,
            height=height,
        )

    def _activate_task(task_id: str) -> None:
        env._current_task = next(t for t in env.active_tasks if t.id == task_id)  # noqa: SLF001
        env._current_embed = embeddings[task_id].reduced_embed.astype(np.float32)  # noqa: SLF001
        env._step_count = 0  # noqa: SLF001

    def _reset_for_command(task_id: str, seed: int) -> None:
        original_tasks = env.active_tasks
        env.active_tasks = [next(t for t in original_tasks if t.id == task_id)]
        try:
            env.reset(seed=seed)
        finally:
            env.active_tasks = original_tasks
        _activate_task(task_id)
        if render_data is not data and render_model.nq == model.nq:
            render_data.qpos[:] = data.qpos
            render_data.qvel[:] = data.qvel
            mujoco.mj_forward(render_model, render_data)

    def _sample(t_s: float, info: dict) -> TelemetrySample:
        return TelemetrySample(
            t_s=t_s,
            torso_x_m=_finite_float(info.get("root_x")),
            torso_y_m=_finite_float(info.get("root_y")),
            torso_z_m=_finite_float(info.get("torso_z")),
            yaw_rad=_finite_float(info.get("root_yaw")),
            imu_roll_rad=float(info.get("imu_roll", 0.0) or 0.0),
            imu_pitch_rad=float(info.get("imu_pitch", 0.0) or 0.0),
            extra={"stand_height_m": info.get("stand_height_m")},
        )

    def _tick(label: str, task_id: str, writers: list) -> dict:
        # Run max_steps_per_cmd steps with the resolved task active.
        obs = env._build_obs()  # noqa: SLF001
        last = time.time()
        task = next(t for t in env.active_tasks if t.id == task_id)
        checker = GoalChecker(task, episode_start_t_s=0.0)
        torso_z: list[float] = []
        upright_proj: list[float] = []
        rewards: list[float] = []
        delta_x: list[float] = []
        delta_y: list[float] = []
        delta_yaw: list[float] = []
        action_norms: list[float] = []
        nonzero_action_steps = 0
        terminated = False
        truncated = False
        first_done_step: int | None = None
        done_reason: str | None = None
        final_result = checker.update(
            TelemetrySample(
                t_s=0.0,
                torso_x_m=getattr(env, "_episode_start_x", 0.0),
                torso_y_m=getattr(env, "_episode_start_y", 0.0),
                torso_z_m=getattr(env, "_episode_start_torso_z", 0.0),
                yaw_rad=getattr(env, "_episode_start_yaw", 0.0),
                extra={"stand_height_m": getattr(env, "_stand_height_m", None)},
            )
        )
        for step_idx in range(max_steps_per_cmd):
            if policy_source == "scripted_smoke":
                action = _scripted_smoke_action(env, task_id, step_idx)
            elif policy is not None:
                action = policy(label, obs)
            else:
                action = np.zeros(env.action_space.shape, dtype=np.float32)
            norm = float(np.linalg.norm(action))
            action_norms.append(norm)
            if norm > 1e-6:
                nonzero_action_steps += 1
            obs, reward, term, trunc, info = env.step(action)
            reward_value = _finite_float(reward)
            if reward_value is not None:
                rewards.append(reward_value)
            torso_value = _finite_float(info.get("torso_z"))
            if torso_value is not None:
                torso_z.append(torso_value)
            upright_value = _finite_float(info.get("upright_proj"))
            if upright_value is not None:
                upright_proj.append(upright_value)
            dx_value = _finite_float(info.get("delta_x"))
            if dx_value is not None:
                delta_x.append(dx_value)
            dy_value = _finite_float(info.get("delta_y"))
            if dy_value is not None:
                delta_y.append(dy_value)
            dyaw_value = _finite_float(info.get("delta_yaw"))
            if dyaw_value is not None:
                delta_yaw.append(dyaw_value)
            final_result = checker.update(_sample((step_idx + 1) * env.config.control_dt_s, info))
            # Sync qpos/qvel from the training MJCF into the scene MJCF so the
            # renderer shows the live policy state on top of the ground plane.
            if render_data is not data and render_model.nq == model.nq:
                render_data.qpos[:] = data.qpos
                render_data.qvel[:] = data.qvel
                mujoco.mj_forward(render_model, render_data)
            _append_frame(
                renderer=renderer,
                render_data=render_data,
                writers=writers,
                profile=profile,
                record_camera=record_camera,
            )
            if viewer is not None:
                viewer.sync()
            now = time.time()
            dt = 0.02 - (now - last)
            if dt > 0:
                time.sleep(dt)
            last = time.time()
            if term or trunc:
                terminated = bool(term)
                truncated = bool(trunc)
                first_done_step = step_idx + 1
                done_reason = "terminated" if term else "truncated"
                break
        fall_threshold = _finite_float(getattr(env, "_fall_z_threshold", None))
        min_torso = min(torso_z) if torso_z else None
        min_upright = min(upright_proj) if upright_proj else None
        no_fall = (
            not terminated
            and (fall_threshold is None or min_torso is None or min_torso >= fall_threshold)
        )
        upright_ok = min_upright is None or min_upright > 0.0
        policy_driven_attempt = (
            policy_source == "scripted_smoke"
            or policy_source == "sb3_smoke"
            or policy_source.startswith("checkpoint:")
        )
        attempted_action = bool(nonzero_action_steps > 0 or policy_driven_attempt)
        return {
            "profile": profile_id,
            "label": label,
            "task_id": task_id,
            "policy_source": policy_source,
            "steps_requested": max_steps_per_cmd,
            "steps_executed": len(rewards),
            "terminated": terminated,
            "truncated": truncated,
            "first_done_step": first_done_step,
            "done_reason": done_reason,
            "fall_threshold": fall_threshold,
            "torso_z": _series_summary(torso_z),
            "upright_proj": _series_summary(upright_proj),
            "reward": _series_summary(rewards),
            "delta_x_m": _series_summary(delta_x),
            "delta_y_m": _series_summary(delta_y),
            "delta_yaw_rad": _series_summary(delta_yaw),
            "action_norm": _series_summary(action_norms),
            "nonzero_action_steps": nonzero_action_steps,
            "attempted_action": attempted_action,
            "goal_success": bool(final_result.success),
            "goal_failed": bool(final_result.failed),
            "goal_reason": final_result.reason,
            "rollout_ok": bool(no_fall and upright_ok),
            "checks": {
                "no_termination": not terminated,
                "torso_above_fall_threshold": bool(no_fall),
                "upright_positive": bool(upright_ok),
                "attempted_action": attempted_action,
                "goal_success": bool(final_result.success),
            },
        }

    command_telemetry: list[dict] = []
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
            task_id = _resolve_task_id(text, task_ids, curriculum)
            if task_id is None:
                print(f"[viewer] no curriculum task matches {text!r}", file=sys.stderr)
                continue
            if preserve_state_between_commands:
                _activate_task(task_id)
            else:
                _reset_for_command(task_id, seed=len(command_telemetry))
            writer, path = (None, None)
            if record_dir is not None:
                writer, path = _start_recorder(
                    record_dir, profile_id, text, width=width, height=height
                )
            print(f"[viewer] executing task={task_id} ({text!r})", file=sys.stderr)
            writers = [w for w in (writer, combined_writer) if w is not None]
            telemetry = _tick(text, task_id, writers)
            command_telemetry.append(telemetry)
            if writer is not None:
                writer.close()
                print(f"[viewer] saved {path}", file=sys.stderr)
                _write_telemetry(_telemetry_path(path), telemetry)
    finally:
        if combined_writer is not None:
            combined_writer.close()
            print(f"[viewer] saved {combined_path}", file=sys.stderr)
            if combined_path is not None:
                combined = {
                    "profile": profile_id,
                    "label": "combined_actions",
                    "policy_source": policy_source,
                    "preserve_state_between_commands": preserve_state_between_commands,
                    "commands": command_telemetry,
                    "steps_requested": sum(
                        int(item.get("steps_requested", 0)) for item in command_telemetry
                    ),
                    "steps_executed": sum(
                        int(item.get("steps_executed", 0)) for item in command_telemetry
                    ),
                    "rollout_ok": bool(command_telemetry)
                    and all(item.get("rollout_ok") is True for item in command_telemetry),
                    "any_goal_success": any(
                        item.get("goal_success") is True for item in command_telemetry
                    ),
                }
                _write_telemetry(_telemetry_path(combined_path), combined)
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
    parser.add_argument(
        "--record-combined",
        action="store_true",
        help="Also record one mp4 containing all scripted commands in sequence.",
    )
    parser.add_argument(
        "--policy-checkpoint",
        type=Path,
        default=None,
        help="Checkpoint directory with manifest.json (Alberta, PPO, or Brax).",
    )
    parser.add_argument(
        "--preserve-state-between-commands",
        action="store_true",
        help=(
            "Run scripted commands as one continuous rollout. By default each "
            "command starts from a fresh reset so per-action videos are independent."
        ),
    )
    parser.add_argument(
        "--scripted-smoke",
        action="store_true",
        help=(
            "Use deterministic command-specific joint actions instead of a "
            "checkpoint. This proves interactive text-to-action wiring only; "
            "it is not trained-policy evidence."
        ),
    )
    parser.add_argument(
        "--allow-zero-action-fallback",
        action="store_true",
        help=(
            "Allow rendering with zero actions when no checkpoint exists. "
            "This is only for renderer/debug smoke, never trained-policy evidence."
        ),
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
        record_combined=args.record_combined,
        policy_checkpoint=args.policy_checkpoint,
        preserve_state_between_commands=args.preserve_state_between_commands,
        scripted_smoke=args.scripted_smoke,
        allow_zero_action_fallback=args.allow_zero_action_fallback,
    )


if __name__ == "__main__":
    raise SystemExit(main())
