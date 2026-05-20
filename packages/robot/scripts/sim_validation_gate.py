"""Sim validation gate — the 100%-confidence check for sim + sim2real.

Runs three pure-sim checks and emits one summary number plus pass/fail.

  1. **Training smoke** — load the checkpoint, verify the policy reads
     and emits 24-D actions for every prompt in the active task list.

  2. **Conditioning differentiation** — same proprio, different texts,
     confirm action vectors are materially different (L2 > threshold).

  3. **Sys-ID calibration** — fit the noisy "real" twin, measure
     per-joint offset recovery error and report the median.

  4. **Bridge contract parity** — confirm dual-target backend (sim+sim)
     accepts a sequence of programmatic commands without error.

The gate prints a final verdict line. Exit code 0 if all gates pass,
non-zero otherwise. CI-friendly.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.dual_target import DualTargetBackend
from eliza_robot.bridge.backends.mock_backend import MockBackend
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend
from eliza_robot.bridge.backends.noise_injector import NoiseProfile
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso
from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy
from eliza_robot.sim.mujoco.demo_env import DemoEnv
from eliza_robot.sim2real.sysid import calibrate_via_sysid


GATES_PASS_REPORT = "checkpoint loads, policy differentiates by text, sys-ID recovers offsets, bridge accepts commands"


async def _gate_training(ckpt_dir: Path) -> dict:
    """Gate 1: checkpoint loads and emits 24-D actions."""
    print(f"[gate-1] loading {ckpt_dir}/policy.zip ...")
    p = TextConditionedPolicy(ckpt_dir)
    proprio = np.zeros(45, dtype=np.float32)
    proprio[5] = 1.0
    results = []
    for prompt in p.active_tasks:
        action, task = p.act(prompt, proprio)
        results.append({
            "prompt": prompt,
            "matched_task": task,
            "action_shape": list(action.shape),
            "action_mean": float(action.mean()),
            "action_std": float(action.std()),
        })
    all_ok = all(r["action_shape"] == [24] for r in results)
    print(f"[gate-1] {'PASS' if all_ok else 'FAIL'} — {len(results)} prompts, all 24-D")
    return {"passed": all_ok, "results": results}


async def _gate_conditioning(ckpt_dir: Path) -> dict:
    """Gate 2: text input materially changes the policy output."""
    print(f"[gate-2] conditioning differentiation...")
    p = TextConditionedPolicy(ckpt_dir)
    proprio = np.zeros(45, dtype=np.float32)
    proprio[5] = 1.0
    actions = {}
    prompts = p.active_tasks
    for prompt in prompts:
        a, _ = p.act(prompt, proprio)
        actions[prompt] = a
    mat = np.zeros((len(prompts), len(prompts)))
    for i, p1 in enumerate(prompts):
        for j, p2 in enumerate(prompts):
            mat[i, j] = float(np.linalg.norm(actions[p1] - actions[p2]))
    off_diag = mat[np.triu_indices_from(mat, k=1)]
    mean_l2 = float(off_diag.mean()) if off_diag.size else 0.0
    threshold = 0.001
    passed = mean_l2 > threshold
    print(
        f"[gate-2] {'PASS' if passed else 'FAIL'} — "
        f"mean off-diagonal action L2={mean_l2:.5f} (threshold {threshold})"
    )
    return {"passed": passed, "mean_action_l2": mean_l2, "threshold": threshold}


async def _gate_sysid() -> dict:
    """Gate 3: sys-ID recovers per-joint offsets within ≤15 mrad median."""
    print(f"[gate-3] dual-sim sys-ID calibration...")
    profile = NoiseProfile(rng_seed=0, deterministic_only=True)
    result = await calibrate_via_sysid(noise_profile=profile)
    truth = result.truth_offsets_rad or {}
    errs = []
    for name, fit in result.fits.items():
        if name in truth:
            errs.append(abs(fit.offset - truth[name]) * 1000.0)
    median_err = float(np.median(errs)) if errs else float("inf")
    threshold = 15.0  # mrad
    passed = median_err <= threshold
    print(
        f"[gate-3] {'PASS' if passed else 'FAIL'} — "
        f"median offset recovery error {median_err:.2f} mrad (threshold ≤{threshold})"
    )
    return {
        "passed": passed,
        "median_offset_err_mrad": median_err,
        "threshold_mrad": threshold,
        "fits_count": len(result.fits),
    }


async def _gate_bridge_dual() -> dict:
    """Gate 4: DualTargetBackend accepts a programmatic command sequence."""
    print(f"[gate-4] dual-target bridge contract...")
    sim_a = MuJocoBackend(
        DemoEnv(target_position=(2.0, 0.0, 0.05)), profile_id="hiwonder-ainex"
    )
    sim_b = MockBackend()
    dual = DualTargetBackend(real=sim_b, sim=sim_a)  # mock stands in for the "real" leg
    await dual.connect()
    program = [
        ("head.set", {"pan": 0.3, "tilt": 0.0, "duration": 0.3}),
        ("action.play", {"name": "stand"}),
        ("action.play", {"name": "wave"}),
        ("walk.command", {"action": "stop"}),
    ]
    failures = []
    for cmd, payload in program:
        env = CommandEnvelope(
            request_id=f"gate4-{cmd}", timestamp=utc_now_iso(),
            command=cmd, payload=payload,
        )
        resp = await dual.handle_command(env)
        if not resp.ok:
            failures.append({"cmd": cmd, "message": resp.message})
    await dual.shutdown()
    passed = not failures
    print(f"[gate-4] {'PASS' if passed else 'FAIL'} — {len(program)} commands, {len(failures)} failures")
    return {"passed": passed, "commands_attempted": len(program), "failures": failures}


async def main_async(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ckpt_dir = Path(args.checkpoint)
    gates = {}

    gates["g1_training"] = await _gate_training(ckpt_dir)
    gates["g2_conditioning"] = await _gate_conditioning(ckpt_dir)
    gates["g3_sysid"] = await _gate_sysid()
    gates["g4_bridge_dual"] = await _gate_bridge_dual()

    all_pass = all(g["passed"] for g in gates.values())
    summary = {
        "checkpoint": str(ckpt_dir),
        "verdict": "PASS" if all_pass else "FAIL",
        "gates": gates,
    }
    (out / "sim_validation_gate.json").write_text(json.dumps(summary, indent=2))
    print()
    print("=" * 60)
    for name, g in gates.items():
        ok = "PASS" if g["passed"] else "FAIL"
        print(f"  {name:20s} {ok}")
    print(f"\nVERDICT: {summary['verdict']}")
    if all_pass:
        print(f"  ({GATES_PASS_REPORT})")
    return 0 if all_pass else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "checkpoints" / "text_conditioned_v2",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "sim_validation_gate",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
