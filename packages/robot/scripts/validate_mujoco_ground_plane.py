#!/usr/bin/env python3
"""Audit MuJoCo robot geometry against the declared ground plane.

The training environment already reports collision-geometry floor clearance in
rollout info. This script is intentionally stricter for human review: it checks
both physics-enabled geoms and visual/passive robot geoms, highlights foot/toe
geometries, can step zero actions to catch settling penetration, and can render
reset screenshots for the audit report.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    TextConditionedProfileEnv,
)

SUPPORTED_PROFILES = (
    "hiwonder-ainex",
    "asimov-1",
    "unitree-g1",
    "unitree-h1",
    "unitree-r1",
)


def _geom_name(model: Any, geom_id: int) -> str:
    import mujoco

    return (
        mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, geom_id)
        or f"geom_{geom_id}"
    )


def _body_name(model: Any, body_id: int) -> str:
    import mujoco

    return (
        mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id)
        or f"body_{body_id}"
    )


def _geom_type_name(model: Any, geom_id: int) -> str:
    import mujoco

    geom_type = int(model.geom_type[geom_id])
    names = {
        int(mujoco.mjtGeom.mjGEOM_PLANE): "plane",
        int(mujoco.mjtGeom.mjGEOM_HFIELD): "hfield",
        int(mujoco.mjtGeom.mjGEOM_SPHERE): "sphere",
        int(mujoco.mjtGeom.mjGEOM_CAPSULE): "capsule",
        int(mujoco.mjtGeom.mjGEOM_ELLIPSOID): "ellipsoid",
        int(mujoco.mjtGeom.mjGEOM_CYLINDER): "cylinder",
        int(mujoco.mjtGeom.mjGEOM_BOX): "box",
        int(mujoco.mjtGeom.mjGEOM_MESH): "mesh",
    }
    return names.get(geom_type, str(geom_type))


def _is_world_or_target_body(model: Any, geom_id: int) -> bool:
    body_id = int(model.geom_bodyid[geom_id])
    return _body_name(model, body_id) in {"world", "target_ball"}


def _all_robot_geom_ids(env: TextConditionedProfileEnv) -> list[int]:
    model = env._model  # noqa: SLF001
    assert model is not None
    floor_ids = set(int(idx) for idx in env._floor_geom_ids)  # noqa: SLF001
    geom_ids: list[int] = []
    for geom_id in range(int(model.ngeom)):
        if geom_id in floor_ids:
            continue
        if _is_world_or_target_body(model, geom_id):
            continue
        geom_ids.append(geom_id)
    return geom_ids


def _geom_record(
    env: TextConditionedProfileEnv,
    geom_id: int,
    *,
    floor_z: float,
) -> dict[str, Any]:
    model = env._model  # noqa: SLF001
    assert model is not None
    body_id = int(model.geom_bodyid[geom_id])
    contype = int(model.geom_contype[geom_id])
    conaffinity = int(model.geom_conaffinity[geom_id])
    clearance = float(env._geom_aabb_min_z_m(geom_id) - floor_z)  # noqa: SLF001
    return {
        "geom_id": int(geom_id),
        "geom_name": _geom_name(model, geom_id),
        "body_name": _body_name(model, body_id),
        "geom_type": _geom_type_name(model, geom_id),
        "contype": contype,
        "conaffinity": conaffinity,
        "category": "visual_or_passive" if contype == 0 and conaffinity == 0 else "collision",
        "min_z_m": float(clearance + floor_z),
        "clearance_m": clearance,
    }


def _clearance_summary(
    env: TextConditionedProfileEnv,
    geom_ids: list[int],
    *,
    floor_z: float,
    tolerance_m: float,
) -> dict[str, Any]:
    records = [
        _geom_record(env, geom_id, floor_z=floor_z)
        for geom_id in geom_ids
    ]
    records.sort(key=lambda row: float(row["clearance_m"]))
    below = [row for row in records if float(row["clearance_m"]) < -tolerance_m]
    penetrating = [row for row in records if float(row["clearance_m"]) < 0.0]
    worst = records[0] if records else None
    return {
        "geom_count": len(records),
        "min_clearance_m": float(worst["clearance_m"]) if worst else 0.0,
        "worst_geom": worst,
        "below_tolerance_count": len(below),
        "below_tolerance_geoms": below[:20],
        "penetrating_count": len(penetrating),
        "penetrating_geoms": penetrating[:20],
        "lowest_geoms": records[:20],
    }


def _foot_or_toe_geom_ids(env: TextConditionedProfileEnv) -> list[int]:
    model = env._model  # noqa: SLF001
    assert model is not None
    explicit = set(
        int(geom_id)
        for side in ("left", "right")
        for geom_id in env._foot_geom_ids[side]  # noqa: SLF001
    )
    named: set[int] = set()
    for geom_id in _all_robot_geom_ids(env):
        name = _geom_name(model, geom_id).lower()
        body = _body_name(model, int(model.geom_bodyid[geom_id])).lower()
        if any(token in name or token in body for token in ("foot", "toe", "ank")):
            named.add(geom_id)
    return sorted(explicit | named)


def _sample_environment(
    *,
    profile_id: str,
    task_id: str,
    seed: int,
    settle_steps: int,
    tolerance_m: float,
    screenshot_dir: Path | None,
    width: int,
    height: int,
) -> dict[str, Any]:
    env = TextConditionedProfileEnv(
        profile_id,
        ProfileEnvConfig(
            include_tasks=(task_id,),
            exclude_tasks=(),
            episode_steps=max(1, settle_steps + 1),
            pca_dim=32,
            domain_rand=False,
        ),
    )
    _, reset_info = env.reset(seed=seed)
    samples: list[dict[str, Any]] = []
    screenshot_path: Path | None = None
    if screenshot_dir is not None:
        screenshot_path = _render_screenshot(
            env,
            screenshot_dir=screenshot_dir,
            profile_id=profile_id,
            task_id=task_id,
            step=0,
            width=width,
            height=height,
        )
    samples.append(
        _audit_current_state(
            env,
            task_id=task_id,
            phase="reset",
            step=0,
            tolerance_m=tolerance_m,
        )
    )
    for step in range(1, settle_steps + 1):
        _, _, terminated, truncated, info = env.step(
            np.zeros(env.action_space.shape, dtype=np.float32)
        )
        sample = _audit_current_state(
            env,
            task_id=task_id,
            phase="zero_action_settle",
            step=step,
            tolerance_m=tolerance_m,
        )
        sample["terminated"] = bool(terminated)
        sample["truncated"] = bool(truncated)
        sample["done_reason"] = info.get("done_reason")
        samples.append(sample)
        if terminated or truncated:
            break
    return {
        "profile_id": profile_id,
        "task_id": task_id,
        "seed": seed,
        "settle_steps_requested": settle_steps,
        "reset_info": reset_info,
        "screenshot": str(screenshot_path) if screenshot_path else None,
        "samples": samples,
        "worst": _worst_across_samples(samples),
    }


def _audit_current_state(
    env: TextConditionedProfileEnv,
    *,
    task_id: str,
    phase: str,
    step: int,
    tolerance_m: float,
) -> dict[str, Any]:
    floor_z = float(env._floor_height_m())  # noqa: SLF001
    collision_ids = env._robot_geom_ids_for_floor_check()  # noqa: SLF001
    all_ids = _all_robot_geom_ids(env)
    foot_ids = _foot_or_toe_geom_ids(env)
    collision_set = set(int(geom_id) for geom_id in collision_ids)
    collision_foot_ids = [geom_id for geom_id in foot_ids if geom_id in collision_set]
    collision = _clearance_summary(
        env,
        collision_ids,
        floor_z=floor_z,
        tolerance_m=tolerance_m,
    )
    all_robot = _clearance_summary(
        env,
        all_ids,
        floor_z=floor_z,
        tolerance_m=tolerance_m,
    )
    foot_or_toe = _clearance_summary(
        env,
        foot_ids,
        floor_z=floor_z,
        tolerance_m=tolerance_m,
    )
    collision_foot_or_toe = _clearance_summary(
        env,
        collision_foot_ids,
        floor_z=floor_z,
        tolerance_m=tolerance_m,
    )
    return {
        "task_id": task_id,
        "phase": phase,
        "step": int(step),
        "floor_z_m": floor_z,
        "tolerance_m": tolerance_m,
        "physics_pass": collision["below_tolerance_count"] == 0
        and collision_foot_or_toe["below_tolerance_count"] == 0,
        "strict_model_pass": all_robot["below_tolerance_count"] == 0,
        "collision_geoms": collision,
        "all_robot_geoms": all_robot,
        "foot_or_toe_geoms": foot_or_toe,
        "collision_foot_or_toe_geoms": collision_foot_or_toe,
    }


def _worst_across_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    def worst_sample(key: str) -> dict[str, Any] | None:
        finite = [
            sample
            for sample in samples
            if math.isfinite(float(sample[key]["min_clearance_m"]))
        ]
        if not finite:
            return None
        return min(finite, key=lambda sample: float(sample[key]["min_clearance_m"]))

    collision = worst_sample("collision_geoms")
    all_robot = worst_sample("all_robot_geoms")
    foot = worst_sample("foot_or_toe_geoms")
    return {
        "physics_pass": all(
            sample["physics_pass"]
            for sample in samples
        ),
        "strict_model_pass": all(
            sample["strict_model_pass"]
            for sample in samples
        ),
        "min_collision_clearance_m": (
            float(collision["collision_geoms"]["min_clearance_m"])
            if collision
            else 0.0
        ),
        "min_all_robot_clearance_m": (
            float(all_robot["all_robot_geoms"]["min_clearance_m"])
            if all_robot
            else 0.0
        ),
        "min_foot_or_toe_clearance_m": (
            float(foot["foot_or_toe_geoms"]["min_clearance_m"])
            if foot
            else 0.0
        ),
        "worst_collision_sample": _sample_pointer(collision, "collision_geoms"),
        "worst_all_robot_sample": _sample_pointer(all_robot, "all_robot_geoms"),
        "worst_foot_or_toe_sample": _sample_pointer(foot, "foot_or_toe_geoms"),
    }


def _sample_pointer(sample: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
    if sample is None:
        return None
    worst = sample[key]["worst_geom"]
    return {
        "task_id": sample["task_id"],
        "phase": sample["phase"],
        "step": sample["step"],
        "worst_geom": worst,
    }


def _render_screenshot(
    env: TextConditionedProfileEnv,
    *,
    screenshot_dir: Path,
    profile_id: str,
    task_id: str,
    step: int,
    width: int,
    height: int,
) -> Path | None:
    try:
        import imageio.v2 as imageio
        import mujoco
    except ImportError:
        return None

    screenshot_dir.mkdir(parents=True, exist_ok=True)
    path = screenshot_dir / f"{profile_id}_{task_id}_step{step:03d}.jpg"
    renderer = mujoco.Renderer(env._model, width=width, height=height)  # noqa: SLF001
    try:
        renderer.update_scene(env._data)  # noqa: SLF001
        imageio.imwrite(path, renderer.render())
    finally:
        renderer.close()
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profiles", nargs="+", default=list(SUPPORTED_PROFILES))
    parser.add_argument(
        "--tasks",
        nargs="+",
        default=["stand_up", "walk_forward", "walk_backward", "sidestep_left", "sidestep_right", "turn_left", "turn_right"],
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--settle-steps", type=int, default=10)
    parser.add_argument("--tolerance-m", type=float, default=0.005)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--screenshot-dir", type=Path, default=None)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    args = parser.parse_args(argv)

    results: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for profile_id in args.profiles:
        for task_id in args.tasks:
            try:
                results.append(
                    _sample_environment(
                        profile_id=profile_id,
                        task_id=task_id,
                        seed=args.seed,
                        settle_steps=max(0, args.settle_steps),
                        tolerance_m=args.tolerance_m,
                        screenshot_dir=args.screenshot_dir,
                        width=args.width,
                        height=args.height,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(
                    {
                        "profile_id": profile_id,
                        "task_id": task_id,
                        "error": str(exc),
                    }
                )
    physics_failures = [
        result for result in results if not result["worst"]["physics_pass"]
    ]
    strict_failures = [
        result for result in results if not result["worst"]["strict_model_pass"]
    ]
    report = {
        "schema": "mujoco-ground-plane-audit-v1",
        "profiles": args.profiles,
        "tasks": args.tasks,
        "seed": args.seed,
        "settle_steps": args.settle_steps,
        "tolerance_m": args.tolerance_m,
        "summary": {
            "sample_count": len(results),
            "error_count": len(errors),
            "physics_pass": not physics_failures and not errors,
            "strict_model_pass": not strict_failures and not errors,
            "physics_failure_count": len(physics_failures),
            "strict_model_failure_count": len(strict_failures),
        },
        "physics_failures": [
            {
                "profile_id": result["profile_id"],
                "task_id": result["task_id"],
                "worst": result["worst"],
                "screenshot": result["screenshot"],
            }
            for result in physics_failures
        ],
        "strict_model_failures": [
            {
                "profile_id": result["profile_id"],
                "task_id": result["task_id"],
                "worst": result["worst"],
                "screenshot": result["screenshot"],
            }
            for result in strict_failures
        ],
        "errors": errors,
        "results": results,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    return 0 if report["summary"]["physics_pass"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
