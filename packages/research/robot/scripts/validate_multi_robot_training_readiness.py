"""Validate multi-robot training readiness.

This is a fast, local gate for the unified robot training surface. It checks
that every requested robot profile loads into the same text-conditioned env,
that Alberta is importable as the default continual learner, and that recorded
video evidence contains both per-action and combined-action clips.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
from pathlib import Path
from typing import Any

os.environ["CUDA_VISIBLE_DEVICES"] = ""
os.environ["JAX_PLATFORM_NAME"] = "cpu"
os.environ["JAX_PLATFORMS"] = "cpu"

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

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
    "walk backward",
    "sidestep left",
    "sidestep right",
    "turn left",
    "turn right",
)
DEFAULT_ZERO_ACTION_SURVIVAL_STEPS = 2


def _safe_label(label: str) -> str:
    return label.replace(" ", "_").replace("/", "_")[:48]


def _expected_video_names(
    profile_id: str,
    commands: list[str],
    *,
    require_combined: bool,
) -> list[str]:
    names = [f"{profile_id}_{_safe_label(command)}.mp4" for command in commands]
    if require_combined:
        names.append(f"{profile_id}_combined_actions.mp4")
    return names


def _check_alberta() -> dict[str, Any]:
    stderr = io.StringIO()
    try:
        with contextlib.redirect_stderr(stderr):
            from eliza_robot.rl.alberta.agent import AlbertaContinualController
            from eliza_robot.rl.alberta.train_robot import train_robot
    except Exception as exc:  # noqa: BLE001 - readiness report must carry context.
        return {"ok": False, "error": repr(exc)}
    return {
        "ok": True,
        "controller": AlbertaContinualController.__name__,
        "trainer": train_robot.__name__,
        "import_stderr": stderr.getvalue().splitlines()[-3:],
    }


def _check_profile(profile_id: str, *, pca_dim: int) -> dict[str, Any]:
    try:
        import mujoco

        from eliza_robot.profiles.schema import load_profile
        from eliza_robot.rl.text_conditioned.profile_env import (
            ProfileEnvConfig,
            make_text_conditioned_env,
        )

        profile = load_profile(profile_id)
        env = make_text_conditioned_env(
            profile_id,
            config=ProfileEnvConfig(
                tier_subset=(1,),
                pca_dim=pca_dim,
                episode_steps=DEFAULT_ZERO_ACTION_SURVIVAL_STEPS + 1,
                domain_rand=False,
            ),
        )
        env.reset(seed=0)
        env._ensure_model()  # noqa: SLF001 - this is a validator.
        model = env._model  # noqa: SLF001
        reset_pose = env._root_pose_summary()  # noqa: SLF001
        reset_torso_z = reset_pose["z"]
        reset_upright_proj = reset_pose["upright_proj"]
        obs_dim = int(env.observation_space.shape[0])
        action_dim = int(env.action_space.shape[0])
        profile_dof = int(profile.kinematics.dof)
        leg_dof = sum(1 for joint in profile.kinematics.joints if joint.group == "LEG")
        model_nu = int(model.nu)
        actuator_ok = action_dim <= model_nu
        zero_action_survival_steps = 0
        zero_action_terminal_info: dict[str, Any] | None = None
        step_obs = None
        for _ in range(DEFAULT_ZERO_ACTION_SURVIVAL_STEPS):
            step_obs, _, terminated, truncated, info = env.step(
                env.action_space.low * 0.0
            )
            if terminated or truncated:
                zero_action_terminal_info = {
                    "terminated": bool(terminated),
                    "truncated": bool(truncated),
                    "info": info,
                }
                break
            zero_action_survival_steps += 1
        if step_obs is None:
            step_obs = env._build_obs()  # noqa: SLF001
        step_obs_dim = int(step_obs.shape[0])
        zero_action_survival_ok = (
            zero_action_survival_steps >= DEFAULT_ZERO_ACTION_SURVIVAL_STEPS
        )
        return {
            "ok": bool(
                profile_dof == len(profile.kinematics.joints)
                and action_dim == leg_dof
                and obs_dim == step_obs_dim
                and obs_dim > action_dim
                and actuator_ok
                and zero_action_survival_ok
            ),
            "name": profile.name,
            "profile_dof": profile_dof,
            "leg_action_dim": leg_dof,
            "env_action_dim": action_dim,
            "env_obs_dim": obs_dim,
            "step_obs_dim": step_obs_dim,
            "mjcf": str(env._mjcf_path),  # noqa: SLF001
            "mjcf_exists": env._mjcf_path.is_file(),  # noqa: SLF001
            "mujoco_nu": model_nu,
            "mujoco_version": getattr(mujoco, "__version__", "unknown"),
            "root_qpos_idx": env._root_qpos_idx,  # noqa: SLF001
            "root_qvel_idx": env._root_qvel_idx,  # noqa: SLF001
            "reset_torso_z": reset_torso_z,
            "reset_upright_proj": reset_upright_proj,
            "fall_z_threshold": env._fall_z_threshold,  # noqa: SLF001
            "zero_action_survival_steps": zero_action_survival_steps,
            "required_zero_action_survival_steps": DEFAULT_ZERO_ACTION_SURVIVAL_STEPS,
            "zero_action_survival_ok": zero_action_survival_ok,
            "zero_action_terminal_info": zero_action_terminal_info,
        }
    except Exception as exc:  # noqa: BLE001 - collect all blockers.
        return {"ok": False, "error": repr(exc)}


def _load_manifest(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"ok": False, "error": f"missing manifest: {path}"}
    try:
        raw = json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"invalid manifest JSON: {exc!r}"}
    if not isinstance(raw, dict):
        return {"ok": False, "error": "manifest root is not an object"}
    raw["__load_ok"] = True
    return raw


def _manifest_entry_exit_ok(entry: dict[str, Any]) -> bool:
    if not entry:
        return True
    if entry.get("manifest_source") == "existing_files" and entry.get("ok") is True:
        return True
    exit_code = entry.get("exit_code")
    if exit_code is None:
        return False
    try:
        return int(exit_code) == 0
    except (TypeError, ValueError):
        return False


def _check_video_evidence(
    evidence_dir: Path,
    *,
    profiles: list[str],
    commands: list[str],
    min_video_bytes: int,
    require_combined: bool,
) -> dict[str, Any]:
    manifest_path = evidence_dir / "manifest.json"
    manifest = _load_manifest(manifest_path)
    manifest_commands = (
        manifest.get("commands") if isinstance(manifest.get("commands"), list) else []
    )
    commands_match = [str(command) for command in manifest_commands] == list(commands)
    combined_recording_match = (
        True
        if not require_combined
        else manifest.get("record_combined") is True
    )
    profile_entries = {
        entry.get("profile"): entry
        for entry in manifest.get("profiles", [])
        if isinstance(entry, dict)
    }
    checked: list[dict[str, Any]] = []
    ok = bool(manifest.get("__load_ok")) and commands_match and combined_recording_match
    for profile_id in profiles:
        profile_dir = evidence_dir / profile_id
        entry = profile_entries.get(profile_id, {})
        expected = _expected_video_names(
            profile_id,
            commands,
            require_combined=require_combined,
        )
        files = []
        telemetry_files = []
        missing = []
        missing_telemetry = []
        too_small = []
        for name in expected:
            path = profile_dir / name
            if not path.is_file():
                missing.append(name)
                continue
            size = path.stat().st_size
            files.append({"name": name, "bytes": size})
            if size < min_video_bytes:
                too_small.append({"name": name, "bytes": size})
        expected_telemetry = [
            Path(name).with_suffix(".telemetry.json").name for name in expected
        ]
        for name in expected_telemetry:
            path = profile_dir / name
            if not path.is_file():
                missing_telemetry.append(name)
                continue
            telemetry_files.append({"name": name, "bytes": path.stat().st_size})
        # Post-training validation may re-record the trained target profile into
        # the same evidence directory, replacing the all-profile manifest while
        # leaving the actual per-profile videos intact. Keep the gate tied to
        # the durable video files so a later production recording cannot erase
        # valid multi-robot evidence for the other profiles.
        entry_exit_ok = _manifest_entry_exit_ok(entry)
        manifest_expects_telemetry = bool(entry.get("expected_telemetry"))
        telemetry_ok = not manifest_expects_telemetry or not missing_telemetry
        profile_ok = entry_exit_ok and not missing and not too_small and telemetry_ok
        if require_combined:
            profile_ok = profile_ok and (profile_dir / f"{profile_id}_combined_actions.mp4").is_file()
        checked.append(
            {
                "profile": profile_id,
                "ok": profile_ok,
                "manifest_entry": bool(entry),
                "exit_code": entry.get("exit_code"),
                "expected": expected,
                "expected_telemetry": expected_telemetry,
                "present": files,
                "telemetry_present": telemetry_files,
                "missing": missing,
                "missing_telemetry": missing_telemetry,
                "manifest_expects_telemetry": manifest_expects_telemetry,
                "too_small": too_small,
            }
        )
        ok = ok and profile_ok
    return {
        "ok": ok,
        "manifest": str(manifest_path),
        "manifest_ok_field": manifest.get("ok"),
        "manifest_commands": manifest_commands,
        "commands_match": commands_match,
        "manifest_record_combined": manifest.get("record_combined"),
        "combined_recording_match": combined_recording_match,
        "require_combined": require_combined,
        "min_video_bytes": min_video_bytes,
        "profiles": checked,
    }


def validate(
    *,
    profiles: list[str],
    commands: list[str],
    video_evidence: Path,
    pca_dim: int,
    min_video_bytes: int,
    require_combined_videos: bool,
) -> dict[str, Any]:
    profile_checks = {
        profile_id: _check_profile(profile_id, pca_dim=pca_dim)
        for profile_id in profiles
    }
    result = {
        "profiles": profile_checks,
        "alberta": _check_alberta(),
        "video_evidence": _check_video_evidence(
            video_evidence,
            profiles=profiles,
            commands=commands,
            min_video_bytes=min_video_bytes,
            require_combined=require_combined_videos,
        ),
    }
    result["ok"] = (
        all(check.get("ok") for check in profile_checks.values())
        and result["alberta"].get("ok")
        and result["video_evidence"].get("ok")
    )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profiles", nargs="+", default=list(DEFAULT_PROFILES))
    parser.add_argument("--commands", nargs="+", default=list(DEFAULT_COMMANDS))
    parser.add_argument(
        "--video-evidence",
        type=Path,
        default=PKG_ROOT / "evidence" / "multi_robot_smoke_videos",
    )
    parser.add_argument("--pca-dim", type=int, default=32)
    parser.add_argument("--min-video-bytes", type=int, default=1024)
    parser.add_argument(
        "--no-require-combined-videos",
        action="store_true",
        help="Allow legacy evidence that only has one video per action.",
    )
    args = parser.parse_args(argv)
    result = validate(
        profiles=list(args.profiles),
        commands=list(args.commands),
        video_evidence=args.video_evidence,
        pca_dim=args.pca_dim,
        min_video_bytes=args.min_video_bytes,
        require_combined_videos=not args.no_require_combined_videos,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
