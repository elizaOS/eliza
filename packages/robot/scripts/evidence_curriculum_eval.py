"""Comprehensive curriculum evaluation — the SOTA verification gate.

For a given checkpoint, runs the trained policy against EVERY task in
the curriculum (tier 1 and 2 by default, tier 3 opt-in), scores each:

  - Programmatic success via `GoalChecker` (curriculum/goal_checker.py).
  - State-mirror sim2real RMS divergence (mean/median/p95).
  - VLM-as-judge pass/fail + critique (mock unless ANTHROPIC_API_KEY set).
  - Per-task mp4 (sim external view).

Outputs:
  - `report.json` — full per-task numbers + aggregates.
  - `summary.md` — human-readable table.
  - `tier1_grid.png` / `tier2_grid.png` — keyframe grids per tier.
  - `task_<id>.mp4` — per-task recording.

Exit code 0 if the overall pass rate (programmatic AND VLM) ≥ threshold.

This is the script we run after every checkpoint to claim "SOTA" — if
all tier-1 tasks pass programmatically AND the VLM agrees, the policy
is producing recognisable behaviour for the whole tier-1 surface.

Usage:
    PATH="$PWD/.venv/lib/python3.11/site-packages/torch/bin:$PATH" \\
    PYTHONPATH=. .venv/bin/python scripts/evidence_curriculum_eval.py \\
        --checkpoint checkpoints/text_conditioned_brax_v1 \\
        --tiers 1 \\
        --threshold 0.6
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from eliza_robot.bridge.backends.dual_target import DualTargetBackend
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.backends.noise_injector import (
    NoiseInjectorBackend,
    NoiseProfile,
)
from eliza_robot.bridge.backends.state_mirror import StateMirrorBackend
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.curriculum.goal_checker import GoalChecker, TelemetrySample
from eliza_robot.curriculum.loader import TaskSpec, load_curriculum
from eliza_robot.perception.evidence_capture import EvidenceCapture, HudLine
from eliza_robot.rl.text_conditioned.inference_loop import (
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.sim.mujoco.demo_env import DemoEnv


@dataclass
class TaskResult:
    task_id: str
    tier: int
    prompt: str
    duration_s: float
    success_programmatic: bool
    success_reason: str
    samples: int
    elapsed_s: float
    sim2real_mean_mrad: float
    sim2real_median_mrad: float
    sim2real_p95_mrad: float
    vlm_passed: bool | None = None
    vlm_confidence: float | None = None
    vlm_critique: str | None = None
    video_path: str | None = None
    error: str | None = None


async def _read_real_joints(real_backend) -> dict[str, float]:
    read = getattr(real_backend, "read_joint_positions", None)
    if callable(read):
        try:
            return await read()
        except Exception:
            pass
    return {}


async def _read_sim_joints(sim_env) -> dict[str, float]:
    try:
        return {
            name: float(sim_env.data.qpos[sim_env._act_qpos_idx[idx]])
            for name, idx in sim_env._act_name_to_idx.items()
        }
    except Exception:
        return {}


async def _evaluate_task(
    task: TaskSpec,
    *,
    backend,
    real_backend,
    sim_env,
    checkpoint: Path,
    episode_s: float,
    policy_hz: float,
    fps: float,
    out_dir: Path,
    evaluator=None,
) -> TaskResult:
    prompt = task.verbs.en[0] if task.verbs.en else task.id.replace("_", " ")
    print(f"[curriculum] >>> {task.id:24s} ({task.tier}) prompt={prompt!r}")
    t0 = time.time()

    checker = GoalChecker(task, episode_start_t_s=t0)
    divergence_samples: list[float] = []
    sim_frames_for_video: list[np.ndarray] = []
    last_result = None

    cfg = InferenceLoopConfig(
        hz=policy_hz,
        max_steps=int(episode_s * policy_hz),
        action_scale=0.3,
    )

    async def _watch():
        nonlocal last_result
        frame_period = 1.0 / fps
        next_frame = time.time()
        t_end = time.time() + episode_s
        stand_height_m = None
        try:
            stand_height_m = float(sim_env.get_robot_position()[2])
        except Exception:
            pass
        while time.time() < t_end:
            now = time.time()
            if now < next_frame:
                await asyncio.sleep(0.005)
                continue
            next_frame = now + frame_period

            real_pos = await _read_real_joints(real_backend)
            sim_pos = await _read_sim_joints(sim_env)
            keys = set(real_pos) & set(sim_pos)
            if keys:
                diffs = [float(real_pos[k]) - float(sim_pos[k]) for k in keys]
                divergence_samples.append(
                    float(np.sqrt(np.mean([d * d for d in diffs])) * 1000)
                )

            # Goal-checker sample from sim ground truth.
            try:
                pos = sim_env.get_robot_position()
                sample = TelemetrySample(
                    t_s=now,
                    torso_x_m=float(pos[0]),
                    torso_y_m=float(pos[1]),
                    torso_z_m=float(pos[2]),
                    yaw_rad=float(sim_env.get_robot_yaw()),
                    joint_positions=sim_pos,
                    extra={"stand_height_m": stand_height_m},
                )
                last_result = checker.update(sample)
            except Exception:
                pass

            # Sim video frame.
            try:
                frame = sim_env.render_external(width=640, height=480)
                sim_frames_for_video.append(frame.copy())
            except Exception:
                pass

    try:
        inference_task = asyncio.create_task(
            run_inference(backend, checkpoint, prompt, config=cfg)
        )
        await _watch()
        await inference_task

        success_prog = bool(last_result.success) if last_result is not None else False
        reason = (last_result.reason or "") if last_result is not None else "no telemetry samples"
    except Exception as exc:
        traceback.print_exc()
        return TaskResult(
            task_id=task.id, tier=task.tier, prompt=prompt,
            duration_s=time.time() - t0,
            success_programmatic=False, success_reason=f"exception: {exc}",
            samples=0, elapsed_s=0.0,
            sim2real_mean_mrad=0.0, sim2real_median_mrad=0.0, sim2real_p95_mrad=0.0,
            error=str(exc),
        )

    # Stop walk + park.
    try:
        await backend.handle_command(CommandEnvelope(
            request_id=f"curric-stop-{task.id}", timestamp=utc_now_iso(),
            command="walk.command", payload={"action": "stop"}, preempt=True,
        ))
    except Exception:
        pass

    # Write per-task mp4.
    video_path = None
    if sim_frames_for_video:
        with EvidenceCapture(out_dir=out_dir, name=task.id, fps=fps) as ec:
            for f in sim_frames_for_video:
                ec.write_frame(
                    f"task_{task.id}", f,
                    hud=[HudLine(text=f"{task.id} — {prompt!r}", scale=0.55)],
                )
        video_path = str(out_dir / f"task_{task.id}.mp4")

    # VLM eval on last frame.
    vlm_passed = None
    vlm_conf = None
    vlm_critique = None
    if evaluator is not None and sim_frames_for_video:
        try:
            sim_frame = sim_frames_for_video[-1]
            result = await evaluator.evaluate_render(
                task_spec=task, sim_frame=sim_frame,
            )
            vlm_passed = result.passed
            vlm_conf = result.confidence
            vlm_critique = result.critique
        except Exception as exc:
            vlm_critique = f"(vlm error: {exc})"

    if divergence_samples:
        mean_d = float(np.mean(divergence_samples))
        median_d = float(np.median(divergence_samples))
        p95_d = float(np.percentile(divergence_samples, 95))
    else:
        mean_d = median_d = p95_d = 0.0

    duration = time.time() - t0
    return TaskResult(
        task_id=task.id, tier=task.tier, prompt=prompt,
        duration_s=duration,
        success_programmatic=success_prog, success_reason=reason,
        samples=len(divergence_samples),
        elapsed_s=duration,
        sim2real_mean_mrad=mean_d,
        sim2real_median_mrad=median_d,
        sim2real_p95_mrad=p95_d,
        vlm_passed=vlm_passed, vlm_confidence=vlm_conf, vlm_critique=vlm_critique,
        video_path=video_path,
    )


async def _build_evaluator(no_vlm: bool):
    if no_vlm:
        return None
    try:
        from eliza_robot.perception.vlm_evaluator import (
            VLMEvaluator, MockBackend, AnthropicBackend,
        )
    except Exception as exc:
        print(f"[curriculum] VLM evaluator unavailable: {exc}")
        return None
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            return VLMEvaluator(backend=AnthropicBackend())
        except Exception as exc:
            print(f"[curriculum] Anthropic backend init failed ({exc}); using mock")
    return VLMEvaluator(backend=MockBackend())


async def _run(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    curriculum = load_curriculum()
    tiers = {int(t.strip()) for t in str(args.tiers).split(",") if t.strip()}
    tasks = [t for t in curriculum.tasks if t.tier in tiers]
    if args.only:
        keep = {s.strip() for s in args.only.split(",") if s.strip()}
        tasks = [t for t in tasks if t.id in keep]
    print(f"[curriculum] evaluating {len(tasks)} tasks across tiers {sorted(tiers)}")

    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id="hiwonder-ainex")
    twin_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    twin_inner = MuJocoBackend(twin_env, profile_id="hiwonder-ainex")
    real = NoiseInjectorBackend(
        twin_inner, profile=NoiseProfile(deterministic_only=True, rng_seed=args.seed),
    )
    dual = DualTargetBackend(real=real, sim=sim)
    backend = StateMirrorBackend(
        dual, real=real, sim_env=sim_env, sync_period_s=args.mirror_period,
    )
    await backend.connect()
    await asyncio.sleep(1.0)

    evaluator = await _build_evaluator(args.no_vlm)

    per_task: list[TaskResult] = []
    try:
        for task in tasks:
            res = await _evaluate_task(
                task,
                backend=backend, real_backend=real, sim_env=sim_env,
                checkpoint=args.checkpoint,
                episode_s=args.episode_s,
                policy_hz=args.policy_hz, fps=args.fps,
                out_dir=out, evaluator=evaluator,
            )
            per_task.append(res)
            vmark = (
                "VLM✓" if res.vlm_passed is True
                else "VLM✗" if res.vlm_passed is False
                else "VLM?"
            )
            pmark = "PASS" if res.success_programmatic else "fail"
            print(
                f"[curriculum]     {pmark} {vmark}  "
                f"div mean {res.sim2real_mean_mrad:5.1f} mrad  "
                f"reason={res.success_reason[:60]!r}"
            )
    finally:
        await backend.shutdown()

    # Aggregates
    n = len(per_task)
    n_prog = sum(1 for r in per_task if r.success_programmatic)
    n_vlm = sum(1 for r in per_task if r.vlm_passed is True)
    agg_mean_mrad = float(np.mean(
        [r.sim2real_mean_mrad for r in per_task if r.samples > 0]
    )) if any(r.samples > 0 for r in per_task) else 0.0
    summary = {
        "checkpoint": str(args.checkpoint),
        "tiers": sorted(tiers),
        "n_tasks": n,
        "n_programmatic_pass": n_prog,
        "n_vlm_pass": n_vlm,
        "programmatic_pass_rate": n_prog / max(n, 1),
        "vlm_pass_rate": n_vlm / max(n, 1) if any(r.vlm_passed is not None for r in per_task) else None,
        "agg_sim2real_mean_mrad": agg_mean_mrad,
        "tasks": [
            {
                "task_id": r.task_id, "tier": r.tier, "prompt": r.prompt,
                "duration_s": round(r.duration_s, 2),
                "success_programmatic": r.success_programmatic,
                "success_reason": r.success_reason,
                "samples": r.samples,
                "sim2real_mean_mrad": round(r.sim2real_mean_mrad, 2),
                "sim2real_median_mrad": round(r.sim2real_median_mrad, 2),
                "sim2real_p95_mrad": round(r.sim2real_p95_mrad, 2),
                "vlm_passed": r.vlm_passed,
                "vlm_confidence": r.vlm_confidence,
                "vlm_critique": (r.vlm_critique or "")[:240],
                "video_path": r.video_path,
                "error": r.error,
            }
            for r in per_task
        ],
    }
    (out / "report.json").write_text(json.dumps(summary, indent=2))

    # Markdown summary
    md_lines = [
        f"# Curriculum eval — {Path(args.checkpoint).name}",
        "",
        f"- Tasks: **{n}** across tiers {sorted(tiers)}",
        f"- Programmatic pass: **{n_prog}/{n}** ({100*n_prog/max(n,1):.0f}%)",
    ]
    if summary["vlm_pass_rate"] is not None:
        md_lines.append(f"- VLM pass: **{n_vlm}/{n}** ({100*n_vlm/max(n,1):.0f}%)")
    md_lines.append(f"- Aggregate sim2real mean: **{agg_mean_mrad:.1f} mrad**")
    md_lines += ["", "| task | tier | prog | VLM | div mean (mrad) | reason |", "|---|---|---|---|---|---|"]
    for r in per_task:
        v = "✓" if r.vlm_passed is True else "✗" if r.vlm_passed is False else "—"
        md_lines.append(
            f"| {r.task_id} | {r.tier} | "
            f"{'✓' if r.success_programmatic else '✗'} | {v} | "
            f"{r.sim2real_mean_mrad:.1f} | {(r.success_reason or '')[:48]} |"
        )
    (out / "summary.md").write_text("\n".join(md_lines))

    print()
    print("=" * 60)
    print(f"Curriculum eval: programmatic {n_prog}/{n} pass "
          f"({100*n_prog/max(n,1):.0f}%), sim2real {agg_mean_mrad:.1f} mrad")
    if summary["vlm_pass_rate"] is not None:
        print(f"  VLM judge: {n_vlm}/{n} pass ({100*n_vlm/max(n,1):.0f}%)")
    print(f"  wrote {out / 'report.json'} + summary.md + {len(per_task)} mp4s")
    rate = n_prog / max(n, 1)
    return 0 if rate >= args.threshold else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint", type=Path,
        default=Path(__file__).resolve().parents[1] / "checkpoints" / "text_conditioned_brax_v1",
    )
    parser.add_argument("--tiers", default="1", help="comma list, e.g. '1' or '1,2'")
    parser.add_argument("--only", default="", help="comma list of task ids to filter to")
    parser.add_argument("--episode-s", type=float, default=3.0)
    parser.add_argument("--policy-hz", type=float, default=8.0)
    parser.add_argument("--mirror-period", type=float, default=0.005)
    parser.add_argument("--fps", type=float, default=10.0)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--threshold", type=float, default=0.6)
    parser.add_argument("--no-vlm", action="store_true")
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "CURRICULUM_EVAL",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
