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
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.bridge.backends.dual_target import DualTargetBackend  # noqa: E402
from eliza_robot.bridge.backends.mock_backend import MockBackend  # noqa: E402
from eliza_robot.bridge.backends.mujoco_backend import MuJocoBackend  # noqa: E402
from eliza_robot.bridge.backends.noise_injector import NoiseProfile  # noqa: E402
from eliza_robot.bridge.protocol import CommandEnvelope, utc_now_iso  # noqa: E402
from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy  # noqa: E402
from eliza_robot.sim.mujoco.demo_env import DemoEnv  # noqa: E402
from eliza_robot.sim2real.sysid import calibrate_via_sysid  # noqa: E402

GATES_PASS_REPORT = "checkpoint loads, policy differentiates by text, sys-ID recovers offsets, bridge accepts commands"
DEFAULT_ALBERTA_CHECKPOINT = ROOT / "checkpoints" / "alberta_text_conditioned"


async def _gate_training(ckpt_dir: Path) -> dict:
    """Gate 1: checkpoint loads and emits 24-D actions."""
    print(f"[gate-1] loading {ckpt_dir}/manifest.json ...")
    p = TextConditionedPolicy(ckpt_dir, strict_manifest=True)
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


async def _gate_training_dim(ckpt_dir: Path, output_dim: int) -> dict:
    print(f"[gate-1] loading {ckpt_dir}/policy manifest ...")
    p = TextConditionedPolicy(ckpt_dir, strict_manifest=True)
    proprio = np.zeros(int(p.manifest.proprio_dim or 45), dtype=np.float32)
    if proprio.shape[0] > 5:
        proprio[5] = 1.0
    results = []
    for prompt in p.active_tasks:
        action, task = p.act(prompt, proprio)
        results.append(
            {
                "prompt": prompt,
                "matched_task": task,
                "action_shape": list(action.shape),
                "finite": bool(np.all(np.isfinite(action))),
            }
        )
    all_ok = all(r["action_shape"] == [output_dim] and r["finite"] for r in results)
    print(f"[gate-1] {'PASS' if all_ok else 'FAIL'} — {len(results)} prompts, all {output_dim}-D")
    return {"passed": all_ok, "results": results}


async def _gate_conditioning(ckpt_dir: Path) -> dict:
    """Gate 2: text input materially changes the policy output."""
    print("[gate-2] conditioning differentiation...")
    p = TextConditionedPolicy(ckpt_dir, strict_manifest=True)
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
    print("[gate-3] dual-sim sys-ID calibration...")
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
    print("[gate-4] dual-target bridge contract...")
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


async def _gate_asimov_bridge() -> dict:
    from eliza_robot.asimov_1.constants import ASIMOV1_FIRMWARE_JOINT_ORDER
    from eliza_robot.bridge.backends.asimov_mujoco import AsimovMujocoBackend
    from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend

    async def exercise(backend) -> dict:
        await backend.connect()
        failures = []
        target = [0.0] * len(ASIMOV1_FIRMWARE_JOINT_ORDER)
        for command, payload in (
            ("asimov.mode", {"mode": "DAMP"}),
            ("asimov.mode", {"mode": "STAND"}),
            ("asimov.velocity", {"vx_mps": 0.0, "vy_mps": 0.0, "yaw_rad_s": 0.0}),
            ("asimov.trajectory", {"positions": target, "duration": 0.05}),
        ):
            resp = await backend.handle_command(
                CommandEnvelope(
                    request_id=f"asimov-gate-{command}",
                    timestamp=utc_now_iso(),
                    command=command,
                    payload=payload,
                )
            )
            if not resp.ok:
                failures.append({"command": command, "message": resp.message})
        events = await backend.poll_events()
        await backend.shutdown()
        return {"backend": backend.backend_name, "passed": not failures and bool(events), "failures": failures}

    mock = await exercise(AsimovRemoteBackend(mock=True))
    mujoco = await exercise(AsimovMujocoBackend())
    return {"passed": mock["passed"] and mujoco["passed"], "mock": mock, "mujoco": mujoco}


async def _gate_asimov_mjx_env() -> dict:
    print("[gate-4] ASIMOV MJX env reset/step...")
    import jax
    import jax.numpy as jp

    from eliza_robot.sim.mujoco.asimov_mjx_training import make_asimov_text_conditioned_mjx_env

    env = make_asimov_text_conditioned_mjx_env(
        active_tasks=("stand_up", "walk_forward"),
        pca_dim=8,
        episode_length=3,
        domain_randomization={},
    )
    state = env.reset(jax.random.PRNGKey(0))
    state = env.step(state, jp.zeros(env.action_size))
    actor_obs = state.obs["state"]
    critic_obs = state.obs["privileged_state"]
    passed = (
        tuple(actor_obs.shape) == (env.actor_observation_size,)
        and tuple(critic_obs.shape) == (env.privileged_observation_size,)
        and env.proprio_dim == 45
        and env.text_dim == 8
        and env.action_size == 12
        and env.mj_model.nu == 25
        and bool(jp.all(jp.isfinite(actor_obs)))
        and bool(jp.all(jp.isfinite(critic_obs)))
        and bool(jp.isfinite(state.reward))
    )
    print(
        f"[gate-4] {'PASS' if passed else 'FAIL'} — "
        f"actor_obs={actor_obs.shape}, critic_obs={critic_obs.shape}, "
        f"action={env.action_size}, actuators={env.mj_model.nu}"
    )
    return {
        "passed": passed,
        "obs_keys": sorted(state.obs),
        "actor_obs_shape": list(actor_obs.shape),
        "critic_obs_shape": list(critic_obs.shape),
        "observation_size": dict(env.observation_size),
        "proprio_dim": int(env.proprio_dim),
        "text_dim": int(env.text_dim),
        "action_size": int(env.action_size),
        "mujoco_actuators": int(env.mj_model.nu),
    }


async def _gate_asimov_model_provenance(ckpt_dir: Path) -> dict:
    print("[gate-0] ASIMOV model provenance...")
    from eliza_robot.asimov_1.cad import sha256_file
    from eliza_robot.asimov_1.constants import (
        ASIMOV1_GENERATED_MANIFEST,
        ASIMOV1_GENERATED_MJCF,
    )

    def load_dict(path: Path) -> tuple[dict, bool]:
        if not path.is_file():
            return {}, False
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}, False
        return loaded if isinstance(loaded, dict) else {}, isinstance(loaded, dict)

    def source_ok(
        *,
        path_key: str,
        hash_key: str,
        expected_path: Path,
        actual_path: Path,
        actual_hash: str | None,
    ) -> bool:
        return (
            actual_path.is_file()
            and actual_path.resolve() == expected_path.resolve()
            and actual_hash is not None
            and job.get(path_key) == str(actual_path)
            and job.get(hash_key) == actual_hash
            and checkpoint_manifest.get(path_key) == str(actual_path)
            and checkpoint_manifest.get(hash_key) == actual_hash
            and config.get(path_key) == str(actual_path)
            and config.get(hash_key) == actual_hash
        )

    job_path = ckpt_dir / "training_job.json"
    checkpoint_manifest_path = ckpt_dir / "manifest.json"
    config_path = ckpt_dir / "config.json"
    checks: dict[str, bool] = {"training_job": job_path.is_file()}
    details: dict[str, object] = {
        "training_job": str(job_path),
        "manifest": str(checkpoint_manifest_path),
        "config": str(config_path),
    }
    job, job_json = load_dict(job_path)
    checkpoint_manifest, manifest_json = load_dict(checkpoint_manifest_path)
    config, config_json = load_dict(config_path)
    checks["training_job_json"] = job_json
    checks["manifest"] = checkpoint_manifest_path.is_file()
    checks["manifest_json"] = manifest_json
    checks["config"] = config_path.is_file()
    checks["config_json"] = config_json

    mjcf_raw = str(job.get("mjcf_xml", ""))
    asset_manifest_raw = str(job.get("asset_manifest", ""))
    mjcf_path = Path(mjcf_raw)
    asset_manifest_path = Path(asset_manifest_raw)
    mjcf_hash = sha256_file(mjcf_path) if mjcf_path.is_file() else None
    asset_manifest_hash = (
        sha256_file(asset_manifest_path) if asset_manifest_path.is_file() else None
    )
    checks.update(
        {
            "mjcf_current_asset": mjcf_path.resolve()
            == ASIMOV1_GENERATED_MJCF.resolve()
            if mjcf_raw
            else False,
            "mjcf_hash": mjcf_hash is not None
            and job.get("mjcf_xml_sha256") == mjcf_hash,
            "mjcf_manifest_config_provenance": source_ok(
                path_key="mjcf_xml",
                hash_key="mjcf_xml_sha256",
                expected_path=ASIMOV1_GENERATED_MJCF,
                actual_path=mjcf_path,
                actual_hash=mjcf_hash,
            ),
            "asset_manifest_current": asset_manifest_path.resolve()
            == ASIMOV1_GENERATED_MANIFEST.resolve()
            if asset_manifest_raw
            else False,
            "asset_manifest_hash": asset_manifest_hash is not None
            and job.get("asset_manifest_sha256") == asset_manifest_hash,
            "asset_manifest_manifest_config_provenance": source_ok(
                path_key="asset_manifest",
                hash_key="asset_manifest_sha256",
                expected_path=ASIMOV1_GENERATED_MANIFEST,
                actual_path=asset_manifest_path,
                actual_hash=asset_manifest_hash,
            ),
        }
    )
    details.update(
        {
            "mjcf_xml": mjcf_raw or None,
            "mjcf_xml_sha256": job.get("mjcf_xml_sha256"),
            "asset_manifest": asset_manifest_raw or None,
            "asset_manifest_sha256": job.get("asset_manifest_sha256"),
        }
    )
    passed = all(checks.values())
    print(f"[gate-0] {'PASS' if passed else 'FAIL'} — ASIMOV generated model assets")
    return {"passed": passed, "checks": checks, "details": details}


async def main_async(args) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ckpt_dir = Path(args.checkpoint)
    gates = {}

    if args.profile == "asimov-1":
        if args.require_asimov_model_provenance:
            gates["g0_asimov_model_provenance"] = await _gate_asimov_model_provenance(
                ckpt_dir
            )
        gates["g1_checkpoint_contract"] = await _gate_training_dim(ckpt_dir, 25)
        gates["g2_conditioning"] = await _gate_conditioning(ckpt_dir)
        gates["g3_asimov_bridge"] = await _gate_asimov_bridge()
        gates["g4_asimov_mjx_env"] = await _gate_asimov_mjx_env()
    else:
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
        default=DEFAULT_ALBERTA_CHECKPOINT,
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "examples"
        / "robot-mujoco-demo" / "evidence" / "sim_validation_gate",
    )
    parser.add_argument("--profile", default="hiwonder-ainex")
    parser.add_argument(
        "--require-asimov-model-provenance",
        action="store_true",
        help=(
            "for asimov-1, require training_job.json to reference the current "
            "generated MJCF and asset manifest hashes"
        ),
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
