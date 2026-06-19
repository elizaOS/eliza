#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
)
from eliza_robot.bridge.backends.asimov_mujoco import AsimovMujocoBackend  # noqa: E402
from eliza_robot.bridge.backends.asimov_remote import AsimovRemoteBackend  # noqa: E402
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import load_profile  # noqa: E402
from eliza_robot.rl.alberta.agent import (  # noqa: E402
    AlbertaContinualController,
    AlbertaControllerConfig,
)
from eliza_robot.rl.alberta.features import FeatureConfig  # noqa: E402
from eliza_robot.rl.text_conditioned.inference_loop import (  # noqa: E402
    InferenceLoopConfig,
    run_inference,
)
from eliza_robot.rl.text_conditioned.profile_env import (  # noqa: E402
    ProfileEnvConfig,
    make_text_conditioned_env,
)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_validation_checkpoint(path: Path, seed: int = 0) -> None:
    """Write a tiny Alberta checkpoint for the ASIMOV policy-loop validator.

    This is intentionally untrained: the script validates bridge/inference
    wiring, shape contracts, and command dispatch. Production learning is
    covered by the Alberta trainer and benchmark jobs.
    """
    path.mkdir(parents=True, exist_ok=True)
    profile = load_profile("asimov-1")
    curriculum = load_curriculum()
    pca_dim = 32
    env = make_text_conditioned_env(
        "asimov-1",
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            pca_dim=pca_dim,
            episode_steps=4,
            domain_rand=False,
        ),
    )
    feature_cfg = FeatureConfig(
        mode="sparse_gated",
        embed_dim=pca_dim,
        n_prototypes=64,
        gate_hard=True,
        proprio_random_dim=32,
        seed=seed,
    )
    controller_cfg = AlbertaControllerConfig(
        obs_dim=int(env.observation_space.shape[0]),
        action_dim=int(env.action_space.shape[0]),
        gamma=0.5,
        actor_step_size=5e-3,
        critic_step_size=1e-2,
        log_sigma_init=-1.0,
        normalize=False,
        obgd_kappa=2.0,
        features=feature_cfg,
        seed=seed,
    )
    controller = AlbertaContinualController(controller_cfg)
    np.savez(path / "alberta_policy.npz", **controller.state_dict())
    manifest = {
        "regime": "alberta_streaming",
        "curriculum_version": curriculum.version,
        "pca_dim": pca_dim,
        "active_tasks": ["walk_forward"],
        "obs_dim": int(env.observation_space.shape[0]),
        "action_dim": int(env.action_space.shape[0]),
        "output_dim": len(profile.kinematics.joints),
        "profile_id": "asimov-1",
        "profile_version": profile.version,
        "proprio_dim": int(env.observation_space.shape[0]) - pca_dim,
        "text_dim": pca_dim,
        "ckpt": "alberta_policy.npz",
        "controller": {
            "gamma": controller_cfg.gamma,
            "actor_step_size": controller_cfg.actor_step_size,
            "critic_step_size": controller_cfg.critic_step_size,
            "actor_lamda": controller_cfg.actor_lamda,
            "critic_lamda": controller_cfg.critic_lamda,
            "log_sigma_init": controller_cfg.log_sigma_init,
            "log_sigma_min": controller_cfg.log_sigma_min,
            "log_sigma_max": controller_cfg.log_sigma_max,
            "action_low": controller_cfg.action_low,
            "action_high": controller_cfg.action_high,
            "obgd_kappa": controller_cfg.obgd_kappa,
            "normalize": controller_cfg.normalize,
            "normalizer_decay": controller_cfg.normalizer_decay,
            "decouple_global_bias": controller_cfg.decouple_global_bias,
            "features": {
                "mode": feature_cfg.mode,
                "embed_dim": feature_cfg.embed_dim,
                "n_prototypes": feature_cfg.n_prototypes,
                "gate_hard": feature_cfg.gate_hard,
                "gate_temperature": feature_cfg.gate_temperature,
                "proprio_random_dim": feature_cfg.proprio_random_dim,
                "random_dim": feature_cfg.random_dim,
                "scale": feature_cfg.scale,
                "seed": feature_cfg.seed,
            },
        },
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "history": [],
        "validation_checkpoint": True,
        "mjcf_xml": str(ASIMOV1_GENERATED_MJCF),
        "mjcf_xml_sha256": _sha256_file(ASIMOV1_GENERATED_MJCF),
        "asset_manifest": str(ASIMOV1_GENERATED_MANIFEST),
        "asset_manifest_sha256": _sha256_file(ASIMOV1_GENERATED_MANIFEST),
    }
    (path / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


async def _exercise(backend, ckpt: Path, max_steps: int) -> dict:
    await backend.connect()
    try:
        result = await run_inference(
            backend,
            ckpt,
            "walk_forward",
            config=InferenceLoopConfig(hz=50.0, max_steps=max_steps, profile_id="asimov-1"),
        )
        events = await backend.poll_events()
        return {
            "ok": result["steps_completed"] == max_steps,
            "backend": backend.backend_name,
            "result": result,
            "events": len(events),
        }
    finally:
        await backend.shutdown()


async def _run(ckpt: Path, max_steps: int) -> dict:
    return {
        "ok": True,
        "backends": {
            "mock": await _exercise(AsimovRemoteBackend(mock=True), ckpt, max_steps),
            "mujoco": await _exercise(AsimovMujocoBackend(), ckpt, max_steps),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--max-steps", type=int, default=2)
    args = parser.parse_args()
    if args.checkpoint is None:
        with tempfile.TemporaryDirectory(prefix="asimov-policy-loop-") as tmp:
            ckpt = Path(tmp)
            write_validation_checkpoint(ckpt)
            report = asyncio.run(_run(ckpt, args.max_steps))
    else:
        report = asyncio.run(_run(args.checkpoint, args.max_steps))
    report["ok"] = all(row["ok"] for row in report["backends"].values())
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
