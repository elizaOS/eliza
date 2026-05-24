"""VLM-eval evidence script. Promotion target:
`scripts/evidence_vlm_evaluation_e2e.py`.

Pipeline: run the FINAL_E2E sim-only rollout (5 tier-1 prompts); at
end-of-episode capture sim render (+ real camera frame if available),
look up the `TaskSpec`, call `VLMEvaluator.evaluate_render(...)`,
persist sim/real PNGs, panel with critique overlay, eval JSON.
`report.json` aggregates `vlm_pass_rate`. Exit 0 if pass rate >=
`--threshold` (default 0.6), else 2.

Per AGENTS.md: library never catches; this script is the only place
that swallows per-prompt judge failures so one bad call cannot abort
the sweep.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import traceback
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

# Reach into the existing evidence harness instead of duplicating it.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from evidence_final_e2e import PROMPTS, _real_camera_frame, _slug  # type: ignore  # noqa: E402

from eliza_robot.bridge.backends.dual_target import DualTargetBackend  # noqa: E402
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend  # noqa: E402
from eliza_robot.bridge.backends.noise_injector import (  # noqa: E402
    NoiseInjectorBackend,
    NoiseProfile,
)
from eliza_robot.bridge.backends.state_mirror import StateMirrorBackend  # noqa: E402
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso  # noqa: E402
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.perception.vlm_evaluator import EvalResult, VLMEvaluator  # noqa: E402
from eliza_robot.rl.text_conditioned.inference_loop import (  # noqa: E402
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.sim.mujoco.demo_env import DemoEnv  # noqa: E402

PKG_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ALBERTA_CHECKPOINT = PKG_ROOT / "checkpoints" / "alberta_text_conditioned"
SUPPORTED_PROFILE_ID = "hiwonder-ainex"


def _load_checkpoint_manifest(checkpoint: Path) -> dict:
    manifest = checkpoint / "manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"missing checkpoint manifest: {manifest}")
    return json.loads(manifest.read_text(encoding="utf-8"))


def _validate_checkpoint_profile(checkpoint: Path) -> dict:
    manifest = _load_checkpoint_manifest(checkpoint)
    profile_id = manifest.get("profile_id")
    if not profile_id:
        raise ValueError(f"checkpoint manifest has no profile_id: {checkpoint}")
    if profile_id != SUPPORTED_PROFILE_ID:
        raise ValueError(
            "checkpoint profile mismatch: "
            f"checkpoint={profile_id!r} script_profile={SUPPORTED_PROFILE_ID!r}"
        )
    return manifest


def _wrap_text(text: str, width: int) -> list[str]:
    out: list[str] = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split(" "):
            candidate = (line + " " + word).strip()
            if len(candidate) <= width:
                line = candidate
            else:
                if line:
                    out.append(line)
                line = word
        if line:
            out.append(line)
    return out


def _resize_h(frame: np.ndarray, target_h: int) -> np.ndarray:
    bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    return cv2.resize(bgr, (int(bgr.shape[1] * target_h / bgr.shape[0]), target_h))


def _panel_with_critique(
    sim_frame: np.ndarray,
    real_frame: np.ndarray | None,
    result: EvalResult | None,
    *,
    error: str | None = None,
    target_h: int = 360,
) -> np.ndarray:
    """Compose sim (+ real) views with a critique strip below."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    sim_resized = _resize_h(sim_frame, target_h)
    if real_frame is not None:
        real_resized = _resize_h(real_frame, target_h)
        combined = np.concatenate([real_resized, sim_resized], axis=1)
        cv2.putText(combined, "REAL", (12, 26), font, 0.7, (255, 255, 255), 2)
        cv2.putText(combined, "SIM", (real_resized.shape[1] + 12, 26),
                    font, 0.7, (255, 255, 255), 2)
    else:
        combined = sim_resized
        cv2.putText(combined, "SIM", (12, 26), font, 0.7, (255, 255, 255), 2)

    w = combined.shape[1]
    if result is not None:
        verdict_color = (120, 240, 120) if result.passed else (120, 120, 240)
        verdict_text = (
            f"VLM verdict: {'PASS' if result.passed else 'FAIL'}  "
            f"conf={result.confidence:.2f}  model={result.model}"
        )
        suggestions = "; ".join(result.suggestions) if result.suggestions else "(none)"
        body = f"{result.critique}\n\nSuggestions: {suggestions}"
    elif error is not None:
        verdict_color = (120, 180, 240)
        verdict_text = "VLM verdict: ERROR"
        body = error
    else:
        verdict_color = (200, 200, 200)
        verdict_text = "VLM verdict: SKIPPED"
        body = ""

    lines = _wrap_text(body, width=max(40, w // 8))
    strip_h = 28 + 18 * max(1, len(lines)) + 12
    strip = np.full((strip_h, w, 3), 22, dtype=np.uint8)
    cv2.putText(
        strip, verdict_text, (12, 22), font, 0.6, verdict_color, 1,
    )
    for i, line in enumerate(lines):
        cv2.putText(strip, line, (12, 44 + 18 * i),
                    font, 0.45, (220, 220, 220), 1)
    return np.concatenate([combined, strip], axis=0)


async def _run(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = _validate_checkpoint_profile(Path(args.checkpoint))

    curriculum = load_curriculum()

    sim_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
    sim = MuJocoBackend(sim_env, profile_id=SUPPORTED_PROFILE_ID)

    if args.sim_only:
        twin_env = DemoEnv(target_position=(2.0, 0.0, 0.05))
        twin_inner = MuJocoBackend(twin_env, profile_id=SUPPORTED_PROFILE_ID)
        real = NoiseInjectorBackend(
            twin_inner,
            profile=NoiseProfile(deterministic_only=True, rng_seed=42),
        )
        print("[vlm-eval] SIM-ONLY mode: noisy MuJoCo twin standing in for real")
    else:
        from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
        real = AinexRemoteBackend(host=args.host, port=args.port)
        print(f"[vlm-eval] REAL ROBOT mode: ws://{args.host}:{args.port}")

    dual = DualTargetBackend(real=real, sim=sim)
    backend = StateMirrorBackend(
        dual, real=real, sim_env=sim_env, sync_period_s=args.mirror_period,
    )
    await backend.connect()
    await asyncio.sleep(2.0)

    import os
    if args.mock or not os.environ.get("ANTHROPIC_API_KEY"):
        from eliza_robot.perception.vlm_evaluator import MockBackend
        evaluator = VLMEvaluator(backend=MockBackend())
        print("[vlm-eval] using MockBackend (set ANTHROPIC_API_KEY for real grading)")
    else:
        evaluator = VLMEvaluator()
        print("[vlm-eval] using AnthropicBackend with claude-opus-4-7")
    per_prompt: list[dict] = []

    try:
        for prompt in PROMPTS:
            slug = _slug(prompt)
            print(f"[vlm-eval] >>> {prompt!r}")
            t0 = time.time()
            cfg = InferenceLoopConfig(
                hz=args.policy_hz,
                max_steps=int(args.episode_s * args.policy_hz),
                action_scale=0.3,
            )
            await run_inference(backend, args.checkpoint, prompt, config=cfg)

            sim_frame = sim_env.render_external(width=640, height=480)
            real_frame = await _real_camera_frame(real, f"vlm-{slug}")

            # Persist raw frames first — useful even if the judge errors.
            Image.fromarray(sim_frame).save(out / f"sim_{slug}.png")
            if real_frame is not None:
                Image.fromarray(real_frame).save(out / f"real_{slug}.png")

            task_spec = curriculum.find_by_text(prompt)
            if task_spec is None:
                print(f"[vlm-eval]   no task match for {prompt!r}; skipping judge")
                panel = _panel_with_critique(
                    sim_frame, real_frame, None,
                    error=f"no curriculum task matched prompt {prompt!r}",
                )
                cv2.imwrite(str(out / f"panel_{slug}.png"), panel)
                per_prompt.append({
                    "prompt": prompt, "task_id": None,
                    "vlm_passed": None, "vlm_confidence": None,
                    "error": "no_task_match",
                    "duration_s": round(time.time() - t0, 2),
                })
                continue

            result: EvalResult | None = None
            error: str | None = None
            try:
                result = await evaluator.evaluate_render(
                    task_spec, sim_frame, real_frame=real_frame,
                )
            except Exception as exc:
                # Script-level swallow per AGENTS.md: one bad judge call
                # must not abort the sweep. Log loudly, record, continue.
                error = f"{type(exc).__name__}: {exc}"
                traceback.print_exc()

            panel = _panel_with_critique(sim_frame, real_frame, result, error=error)
            cv2.imwrite(str(out / f"panel_{slug}.png"), panel)
            if result is not None:
                (out / f"eval_{slug}.json").write_text(
                    json.dumps(result.model_dump(), indent=2)
                )

            per_prompt.append({
                "prompt": prompt,
                "task_id": task_spec.id,
                "vlm_passed": result.passed if result else None,
                "vlm_confidence": result.confidence if result else None,
                "vlm_critique": result.critique if result else None,
                "vlm_suggestions": result.suggestions if result else None,
                "error": error,
                "duration_s": round(time.time() - t0, 2),
            })
            verdict_str = (
                "PASS" if (result and result.passed) else
                "FAIL" if result is not None else
                "ERROR"
            )
            conf_str = f"{result.confidence:.2f}" if result else "n/a"
            print(f"[vlm-eval]   {prompt}: VLM -> {verdict_str} (conf={conf_str})")
    finally:
        await backend.handle_command(CommandEnvelope(
            request_id="vlm-stop", timestamp=utc_now_iso(),
            command="walk.command", payload={"action": "stop"}, preempt=True,
        ))
        await backend.handle_command(CommandEnvelope(
            request_id="vlm-stand", timestamp=utc_now_iso(),
            command="action.play", payload={"name": "stand"},
        ))
        await backend.shutdown()

    judged = [p for p in per_prompt if p["vlm_passed"] is not None]
    pass_count = sum(1 for p in judged if p["vlm_passed"])
    vlm_pass_rate = (pass_count / len(judged)) if judged else 0.0

    error_count = sum(1 for p in per_prompt if p["error"])
    summary = {
        "checkpoint": str(args.checkpoint),
        "checkpoint_regime": manifest.get("regime"),
        "profile_id": SUPPORTED_PROFILE_ID,
        "n_prompts": len(per_prompt), "n_judged": len(judged),
        "pass_count": pass_count, "fail_count": len(judged) - pass_count,
        "error_count": error_count, "vlm_pass_rate": vlm_pass_rate,
        "threshold": args.threshold,
        "model": evaluator.backend.model_name, "per_prompt": per_prompt,
    }
    (out / "report.json").write_text(json.dumps(summary, indent=2))

    print()
    print("=" * 60)
    print(f"VLM eval: {pass_count}/{len(judged)} prompts judged PASS "
          f"({vlm_pass_rate:.0%}), threshold={args.threshold:.0%}")
    if error_count:
        print(f"  ({error_count} prompt(s) errored — see report.json)")
    return 0 if vlm_pass_rate >= args.threshold else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=DEFAULT_ALBERTA_CHECKPOINT,
    )
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--policy-hz", type=float, default=8.0)
    parser.add_argument("--episode-s", type=float, default=3.0)
    parser.add_argument("--mirror-period", type=float, default=0.05)
    parser.add_argument("--threshold", type=float, default=0.6,
                        help="fraction of prompts the VLM must pass for exit 0")
    parser.add_argument(
        "--mock", action="store_true",
        help="force MockBackend even when ANTHROPIC_API_KEY is set (cheap smoke)",
    )
    parser.add_argument(
        "--sim-only", action="store_true", default=True,
        help="use a noisy MuJoCo twin instead of the real robot (default ON)",
    )
    parser.add_argument(
        "--use-real", dest="sim_only", action="store_false",
        help="actually drive the physical AiNex (opt-in)",
    )
    parser.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[2] / "examples"
        / "robot-mujoco-demo" / "evidence" / "VLM_EVAL",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    sys.exit(main())
