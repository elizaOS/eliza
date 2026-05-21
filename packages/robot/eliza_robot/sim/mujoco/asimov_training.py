"""Training contract for ASIMOV-1 MuJoCo/MJX environments."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from eliza_robot.asimov_1.constants import (
    ASIMOV1_ACTOR_OBSERVATION_DIM,
    ASIMOV1_CONTROL_HZ,
    ASIMOV1_FIRMWARE_JOINT_ORDER,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_LEG_ACTION_DIM,
    ASIMOV1_PHYSICS_HZ,
)


@dataclass(frozen=True)
class AsimovTrainingContract:
    profile_id: str
    mjcf_xml: str
    control_hz: float
    physics_hz: float
    joint_order: tuple[str, ...]
    actor_observation_dim: int
    leg_action_dim: int
    actor_hidden_sizes: tuple[int, int, int]
    critic_hidden_sizes: tuple[int, int, int]
    actor_excludes: tuple[str, ...]
    privileged_critic_terms: tuple[str, ...]
    text_conditioned_tasks: tuple[str, ...]
    domain_randomization: dict[str, tuple[float, float]]


def default_asimov_training_contract() -> AsimovTrainingContract:
    return AsimovTrainingContract(
        profile_id="asimov-1",
        mjcf_xml=str(ASIMOV1_GENERATED_MJCF),
        control_hz=ASIMOV1_CONTROL_HZ,
        physics_hz=ASIMOV1_PHYSICS_HZ,
        joint_order=ASIMOV1_FIRMWARE_JOINT_ORDER,
        actor_observation_dim=ASIMOV1_ACTOR_OBSERVATION_DIM,
        leg_action_dim=ASIMOV1_LEG_ACTION_DIM,
        actor_hidden_sizes=(512, 256, 128),
        critic_hidden_sizes=(512, 256, 128),
        actor_excludes=("ground_truth_base_linear_velocity",),
        privileged_critic_terms=("ground_truth_base_linear_velocity", "toe_contact_state", "foot_contact_forces", "root_height"),
        text_conditioned_tasks=("stand_up", "walk_forward", "walk_backward", "sidestep_left", "sidestep_right", "turn_left", "turn_right"),
        domain_randomization={"encoder_zero_offset_rad": (-0.02, 0.02), "pd_gain_scale": (0.9, 1.1)},
    )


def asimov_text_conditioned_manifest_template(
    *,
    curriculum_version: int,
    pca_dim: int = 32,
    active_tasks: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    contract = default_asimov_training_contract()
    tasks = active_tasks or contract.text_conditioned_tasks
    return {
        "regime": "brax_ppo",
        "profile_id": "asimov-1",
        "curriculum_version": int(curriculum_version),
        "pca_dim": int(pca_dim),
        "active_tasks": list(tasks),
        "obs_dim": contract.actor_observation_dim + int(pca_dim),
        "proprio_dim": contract.actor_observation_dim,
        "text_dim": int(pca_dim),
        "action_dim": contract.leg_action_dim,
        "output_dim": len(contract.joint_order),
        "policy_hidden_layer_sizes": list(contract.actor_hidden_sizes),
        "value_hidden_layer_sizes": list(contract.critic_hidden_sizes),
        "normalize_observations": True,
        "ckpt": "policy_brax.pkl",
        "encoder_model": "sentence-transformers/all-MiniLM-L6-v2",
    }


def asimov_full_training_job_spec(
    *,
    curriculum_version: int,
    output_dir: str,
    total_steps: int = 150_000_000,
    num_envs: int = 8192,
    num_evals: int = 10,
    seed: int = 0,
    learning_rate: float = 3e-4,
    pca_dim: int = 32,
    domain_rand: bool = True,
) -> dict[str, Any]:
    contract = default_asimov_training_contract()
    manifest = asimov_text_conditioned_manifest_template(
        curriculum_version=curriculum_version,
        pca_dim=pca_dim,
        active_tasks=contract.text_conditioned_tasks,
    )
    manifest.update({"total_steps": int(total_steps), "seed": int(seed), "training_job": "asimov-1-text-conditioned-mjx-brax"})
    ppo = {
        "algorithm": "brax_ppo",
        "num_timesteps": int(total_steps),
        "num_envs": int(num_envs),
        "num_evals": int(num_evals),
        "learning_rate": float(learning_rate),
        "reward_scaling": 1.0,
        "normalize_observations": True,
        "action_repeat": 1,
        "unroll_length": 20,
        "num_minibatches": 32,
        "num_updates_per_batch": 4,
        "discounting": 0.97,
        "entropy_cost": 1e-2,
        "batch_size": 256,
        "max_grad_norm": 1.0,
        "policy_hidden_layer_sizes": list(contract.actor_hidden_sizes),
        "value_hidden_layer_sizes": list(contract.critic_hidden_sizes),
    }
    return {
        "job": "asimov-1-text-conditioned-mjx-brax",
        "profile_id": "asimov-1",
        "output_dir": output_dir,
        "mjcf_xml": contract.mjcf_xml,
        "control_hz": contract.control_hz,
        "physics_hz": contract.physics_hz,
        "actor_observation_layout": [
            {"name": "gyro", "dim": 3},
            {"name": "gravity", "dim": 3},
            {"name": "velocity_command", "dim": 3},
            {"name": "leg_joint_position", "dim": 12},
            {"name": "leg_joint_velocity", "dim": 12},
            {"name": "previous_leg_action", "dim": 12},
        ],
        "actor_observation_dim": 45,
        "leg_action_dim": 12,
        "output_dim": 25,
        "joint_order": list(contract.joint_order),
        "active_tasks": list(contract.text_conditioned_tasks),
        "ppo": ppo,
        "trainer_entrypoint": "eliza_robot.sim.mujoco.asimov_mjx_training:train_from_job",
        "runner": "scripts/run_asimov1_full_training.py",
        "domain_randomization": {k: [float(v[0]), float(v[1])] for k, v in contract.domain_randomization.items()} if domain_rand else {},
        "manifest_template": manifest,
        "expected_artifacts": ["policy_brax.pkl", "manifest.json", "metrics.json", "config.json"],
        "validation_commands": [
            f"python3 scripts/run_asimov1_full_training.py --job-dir {output_dir} --check-only",
            f"python3 scripts/verify_brax_text_policy.py --ckpt {output_dir} --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25",
            f"python3 scripts/validate_asimov1_production_checkpoint.py {output_dir} --min-steps {total_steps}",
            f"python3 scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt {output_dir} --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes 5 --max-steps 200",
            f"python3 scripts/sim_validation_gate.py --profile asimov-1 --checkpoint {output_dir}",
        ],
    }
