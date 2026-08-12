"""Validate the fully composed verl GRPO config before run artifacts exist.

The launcher composes this file through the installed, Git-pinned verl Hydra
entry point. Validation checks the immutable source revision, the elizaOS
overrides, the custom reward import, and verl's own current config validator.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

EXPECTED_VERL_COMMIT = "668baad7455453eac8ab863f1b2d6fecaec746ed"


def _select(config: Mapping[str, Any], path: str) -> Any:
    value: Any = config
    for component in path.split("."):
        if not isinstance(value, Mapping) or component not in value:
            raise ValueError(f"composed verl config is missing {path}")
        value = value[component]
    return value


def validate_contract(
    config: Mapping[str, Any],
    *,
    dataset: Path,
    checkpoint: Path,
    reward_function: Path,
    rollouts: int,
    rollout_batch: int,
    epochs: int,
    kl_coef: float,
    gpus: int,
) -> None:
    """Check the values relied on by the pinned verl execution path."""

    expected = {
        "algorithm.adv_estimator": "grpo",
        "algorithm.use_kl_in_reward": False,
        "data.train_files": [str(dataset)],
        "data.val_files": [str(dataset)],
        "data.prompt_key": "prompt",
        "data.train_batch_size": rollout_batch,
        "actor_rollout_ref.model.path": str(checkpoint),
        "actor_rollout_ref.actor.use_kl_loss": True,
        "actor_rollout_ref.actor.kl_loss_coef": kl_coef,
        "actor_rollout_ref.rollout.name": "vllm",
        "actor_rollout_ref.rollout.n": rollouts,
        "critic.enable": False,
        "reward.reward_model.enable": False,
        "reward.custom_reward_function.path": str(reward_function),
        "reward.custom_reward_function.name": "compute_score",
        "trainer.total_epochs": epochs,
        "trainer.n_gpus_per_node": gpus,
        "trainer.nnodes": 1,
        "trainer.use_v1": True,
    }
    for path, expected_value in expected.items():
        actual = _select(config, path)
        if actual != expected_value:
            raise ValueError(
                f"composed verl config has {path}={actual!r}; expected {expected_value!r}"
            )

    for required_mapping in ("ray_kwargs", "transfer_queue", "global_profiler"):
        if not isinstance(_select(config, required_mapping), Mapping):
            raise ValueError(f"composed verl config has invalid {required_mapping}")


def validate_installed_revision() -> None:
    """Require the PEP 610 metadata emitted for the locked Git dependency."""

    distribution = importlib.metadata.distribution("verl")
    raw = distribution.read_text("direct_url.json")
    if raw is None:
        raise ValueError("installed verl has no direct_url.json Git provenance")
    direct_url = json.loads(raw)
    commit = _select(direct_url, "vcs_info.commit_id")
    if commit != EXPECTED_VERL_COMMIT:
        raise ValueError(
            f"installed verl commit is {commit!r}; expected {EXPECTED_VERL_COMMIT}"
        )


def _validate_prepared_dataset(path: Path) -> None:
    with path.open("r", encoding="utf-8") as handle:
        first_line = next((line for line in handle if line.strip()), None)
    if first_line is None:
        raise ValueError("prepared verl dataset is empty")
    row = json.loads(first_line)
    if not isinstance(row.get("prompt"), list):
        raise ValueError("prepared verl dataset has no message-list prompt")
    if not isinstance(row.get("data_source"), str):
        raise ValueError("prepared verl dataset has no data_source")
    reward_model = row.get("reward_model")
    if not isinstance(reward_model, dict) or "ground_truth" not in reward_model:
        raise ValueError("prepared verl dataset has no reward ground truth")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--prepared-dataset", type=Path, required=True)
    parser.add_argument("--configured-dataset", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--reward-function", type=Path, required=True)
    parser.add_argument("--rollouts", type=int, required=True)
    parser.add_argument("--rollout-batch", type=int, required=True)
    parser.add_argument("--epochs", type=int, required=True)
    parser.add_argument("--kl-coef", type=float, required=True)
    parser.add_argument("--gpus", type=int, required=True)
    args = parser.parse_args()

    from omegaconf import OmegaConf

    config = OmegaConf.load(args.config)
    OmegaConf.resolve(config)
    plain = OmegaConf.to_container(config, resolve=True)
    if not isinstance(plain, Mapping):
        raise ValueError("composed verl config must be a mapping")

    validate_installed_revision()
    validate_contract(
        plain,
        dataset=args.configured_dataset,
        checkpoint=args.checkpoint,
        reward_function=args.reward_function,
        rollouts=args.rollouts,
        rollout_batch=args.rollout_batch,
        epochs=args.epochs,
        kl_coef=args.kl_coef,
        gpus=args.gpus,
    )
    _validate_prepared_dataset(args.prepared_dataset)

    from verl.trainer.ppo.reward import get_custom_reward_fn
    from verl.trainer.ppo.utils import need_critic, need_reference_policy
    from verl.utils.config import validate_config

    validate_config(
        config=config,
        use_reference_policy=need_reference_policy(config),
        use_critic=need_critic(config),
    )
    if get_custom_reward_fn(config) is None:
        raise ValueError("verl did not load the configured custom reward function")

    print("validated composed config against the pinned verl runtime")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
