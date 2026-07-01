#!/usr/bin/env python3
"""Generate a local Brax/MJX PPO contract artifact without claiming training.

The production Brax/MJX PPO baseline requires a GPU training host. This script
uses the real ASIMOV-1 MJX training writer with injected fake PPO/train
functions so CI can validate the checkpoint/manifest/config/metrics contract
that production training must satisfy.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_ACTOR_OBSERVATION_DIM,
    ASIMOV1_FULL_ACTION_DIM,
    ASIMOV1_LEG_ACTION_DIM,
    ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM,
)
from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.sim.mujoco.asimov_mjx_training import _train_from_job_impl  # noqa: E402
from eliza_robot.sim.mujoco.asimov_training import asimov_full_training_job_spec  # noqa: E402


class _ContractEnv:
    def __init__(self, *, pca_dim: int, active_tasks: tuple[str, ...], episode_length: int) -> None:
        self.observation_size = ASIMOV1_ACTOR_OBSERVATION_DIM + pca_dim
        self.actor_observation_size = ASIMOV1_ACTOR_OBSERVATION_DIM + pca_dim
        self.privileged_observation_size = (
            ASIMOV1_ACTOR_OBSERVATION_DIM + pca_dim + ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM
        )
        self.proprio_dim = ASIMOV1_ACTOR_OBSERVATION_DIM
        self.text_dim = pca_dim
        self.action_size = ASIMOV1_LEG_ACTION_DIM
        self.active_tasks = active_tasks
        self._config = SimpleNamespace(episode_length=episode_length)


def _fake_env_factory(**kwargs) -> _ContractEnv:
    return _ContractEnv(
        pca_dim=int(kwargs["pca_dim"]),
        active_tasks=tuple(kwargs["active_tasks"]),
        episode_length=int(kwargs["episode_length"]),
    )


def _fake_networks(**kwargs) -> dict[str, Any]:
    return {"network_factory_kwargs": kwargs}


def _fake_ppo_train(**kwargs):
    kwargs["network_factory"](
        kwargs["environment"].actor_observation_size,
        kwargs["environment"].action_size,
        lambda obs, _params=None: obs,
    )
    progress = kwargs.get("progress_fn")
    if callable(progress):
        progress(max(1, int(kwargs["num_timesteps"])), {"eval/episode_reward": 1.0})
    params = {
        "contract_only": True,
        "algorithm": "brax_ppo",
        "num_timesteps": int(kwargs["num_timesteps"]),
        "num_envs": int(kwargs["num_envs"]),
        "seed": int(kwargs["seed"]),
    }
    return object(), params, {}


def _fake_save(path: str, params) -> None:
    Path(path).write_bytes(json.dumps(params, sort_keys=True).encode("utf-8"))


def _validate_contract_artifact(out_dir: Path) -> dict[str, Any]:
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    metrics = json.loads((out_dir / "metrics.json").read_text(encoding="utf-8"))
    config = json.loads((out_dir / "config.json").read_text(encoding="utf-8"))
    checks = {
        "policy_artifact": (out_dir / "policy_brax.pkl").is_file()
        and (out_dir / "policy_brax.pkl").stat().st_size > 0,
        "manifest": (out_dir / "manifest.json").is_file(),
        "metrics": isinstance(metrics, list) and bool(metrics),
        "config": (out_dir / "config.json").is_file(),
        "regime": manifest.get("regime") == "brax_ppo",
        "profile_id": manifest.get("profile_id") == "asimov-1",
        "proprio_dim": manifest.get("proprio_dim") == ASIMOV1_ACTOR_OBSERVATION_DIM,
        "action_dim": manifest.get("action_dim") == ASIMOV1_LEG_ACTION_DIM,
        "output_dim": manifest.get("output_dim") == ASIMOV1_FULL_ACTION_DIM,
        "asymmetric_actor_critic": manifest.get("policy_obs_key") == "state"
        and manifest.get("value_obs_key") == "privileged_state",
        "config_tasks_match_manifest": config.get("active_tasks") == manifest.get("active_tasks"),
        "contract_not_production": True,
    }
    return {
        "schema": "robot-brax-mjx-contract-artifact-v1",
        "ok": all(checks.values()),
        "contract_only": True,
        "production_training": False,
        "out_dir": str(out_dir),
        "checks": checks,
        "manifest": manifest,
        "metrics": metrics,
        "config": config,
    }


def generate_contract_artifact(
    out_dir: Path,
    *,
    steps: int,
    num_envs: int,
    seed: int,
    pca_dim: int,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    curriculum = load_curriculum()
    job = asimov_full_training_job_spec(
        curriculum_version=curriculum.version,
        output_dir=str(out_dir),
        total_steps=steps,
        num_envs=num_envs,
        num_evals=1,
        seed=seed,
        pca_dim=pca_dim,
        domain_rand=False,
    )
    job["ppo"].update(
        {
            "unroll_length": 2,
            "num_minibatches": 1,
            "num_updates_per_batch": 1,
            "batch_size": max(1, num_envs),
        }
    )
    (out_dir / "training_job.json").write_text(json.dumps(job, indent=2) + "\n", encoding="utf-8")
    (out_dir / "manifest.template.json").write_text(
        json.dumps(job["manifest_template"], indent=2) + "\n",
        encoding="utf-8",
    )
    _train_from_job_impl(
        out_dir,
        ppo_train_fn=_fake_ppo_train,
        save_params_fn=_fake_save,
        tree_map_fn=lambda _fn, tree: tree,
        make_networks_fn=_fake_networks,
        wrap_env_fn=lambda env, **_kwargs: env,
        env_factory=_fake_env_factory,
    )
    report = _validate_contract_artifact(out_dir)
    (out_dir / "validation_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "evidence" / "brax_mjx_contract_artifact",
    )
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--num-envs", type=int, default=2)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--pca-dim", type=int, default=6)
    args = parser.parse_args(argv)
    report = generate_contract_artifact(
        args.out,
        steps=args.steps,
        num_envs=args.num_envs,
        seed=args.seed,
        pca_dim=args.pca_dim,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
