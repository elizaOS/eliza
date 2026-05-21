from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from eliza_robot.asimov_1.constants import (
    ASIMOV1_ACTOR_OBSERVATION_DIM,
    ASIMOV1_FULL_ACTION_DIM,
    ASIMOV1_LEG_ACTION_DIM,
)
from eliza_robot.sim.mujoco.asimov_mjx_training import (
    _train_from_job_impl,
    make_asimov_text_conditioned_mjx_env,
)
from eliza_robot.sim.mujoco.asimov_training import asimov_full_training_job_spec


def test_asimov_mjx_env_reset_step_contract() -> None:
    jax = pytest.importorskip("jax")
    jp = pytest.importorskip("jax.numpy")
    pytest.importorskip("mujoco")
    pytest.importorskip("mujoco_playground")

    env = make_asimov_text_conditioned_mjx_env(
        active_tasks=("stand_up", "walk_forward"),
        pca_dim=8,
        episode_length=2,
        domain_randomization={},
    )

    assert env.proprio_dim == ASIMOV1_ACTOR_OBSERVATION_DIM
    assert env.text_dim == 8
    assert env.observation_size == ASIMOV1_ACTOR_OBSERVATION_DIM + 8
    assert env.action_size == ASIMOV1_LEG_ACTION_DIM
    assert env.mj_model.nu == ASIMOV1_FULL_ACTION_DIM
    assert env.n_substeps == 4

    state = env.reset(jax.random.PRNGKey(0))
    assert tuple(state.obs.shape) == (env.observation_size,)
    assert bool(jp.all(jp.isfinite(state.obs)))
    assert tuple(state.info["motor_targets"].shape) == (ASIMOV1_FULL_ACTION_DIM,)

    action = jp.linspace(-0.25, 0.25, env.action_size)
    state = env.step(state, action)
    assert tuple(state.obs.shape) == (env.observation_size,)
    assert bool(jp.all(jp.isfinite(state.obs)))
    assert bool(jp.isfinite(state.reward))
    assert tuple(state.info["motor_targets"].shape) == (ASIMOV1_FULL_ACTION_DIM,)

    state = env.step(state, action)
    assert bool(state.done), "episode_length=2 should mark the second step done"


def test_asimov_train_from_job_impl_writes_brax_artifact_contract(tmp_path: Path) -> None:
    job = asimov_full_training_job_spec(
        curriculum_version=42,
        output_dir=str(tmp_path),
        total_steps=8,
        num_envs=2,
        num_evals=1,
        seed=11,
        pca_dim=6,
        domain_rand=False,
    )
    job["ppo"].update(
        {
            "unroll_length": 2,
            "num_minibatches": 1,
            "num_updates_per_batch": 1,
            "batch_size": 2,
        }
    )
    (tmp_path / "training_job.json").write_text(json.dumps(job), encoding="utf-8")

    class FakeEnv:
        observation_size = ASIMOV1_ACTOR_OBSERVATION_DIM + 6
        proprio_dim = ASIMOV1_ACTOR_OBSERVATION_DIM
        text_dim = 6
        action_size = ASIMOV1_LEG_ACTION_DIM
        active_tasks = ("stand_up", "walk_forward")
        _config = SimpleNamespace(episode_length=3)

    captured: dict[str, object] = {}

    def fake_env_factory(**kwargs):
        captured["env_kwargs"] = kwargs
        return FakeEnv()

    def fake_networks(**kwargs):
        captured["network_kwargs"] = kwargs
        return {"network": kwargs}

    def fake_ppo_train(**kwargs):
        captured["ppo_kwargs"] = kwargs
        kwargs["network_factory"](99, 12, lambda obs, _params=None: obs)
        kwargs["progress_fn"](4, {"eval/episode_reward": 1.5})
        return object(), {"weights": [1.0, 2.0]}, {}

    def fake_save(path: str, params) -> None:
        Path(path).write_bytes(json.dumps(params).encode("utf-8"))

    result = _train_from_job_impl(
        tmp_path,
        ppo_train_fn=fake_ppo_train,
        save_params_fn=fake_save,
        tree_map_fn=lambda _fn, tree: tree,
        make_networks_fn=fake_networks,
        wrap_env_fn=lambda env, **_kwargs: env,
        env_factory=fake_env_factory,
    )

    assert result["ok"] is True
    assert (tmp_path / "policy_brax.pkl").is_file()
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    metrics = json.loads((tmp_path / "metrics.json").read_text(encoding="utf-8"))
    config = json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))

    assert manifest["regime"] == "brax_ppo"
    assert manifest["profile_id"] == "asimov-1"
    assert manifest["obs_dim"] == ASIMOV1_ACTOR_OBSERVATION_DIM + 6
    assert manifest["proprio_dim"] == ASIMOV1_ACTOR_OBSERVATION_DIM
    assert manifest["text_dim"] == 6
    assert manifest["action_dim"] == ASIMOV1_LEG_ACTION_DIM
    assert manifest["output_dim"] == ASIMOV1_FULL_ACTION_DIM
    assert manifest["ckpt"] == "policy_brax.pkl"
    assert metrics == [{"steps": 4, "reward": 1.5, "elapsed_s": metrics[0]["elapsed_s"]}]
    assert config["active_tasks"] == ["stand_up", "walk_forward"]

    assert captured["env_kwargs"] == {
        "active_tasks": tuple(job["active_tasks"]),
        "pca_dim": 6,
        "episode_length": 500,
        "domain_randomization": {},
    }
    ppo_kwargs = captured["ppo_kwargs"]
    assert ppo_kwargs["num_timesteps"] == 8
    assert ppo_kwargs["num_envs"] == 2
    assert ppo_kwargs["episode_length"] == 3
    assert ppo_kwargs["seed"] == 11
    network_kwargs = captured["network_kwargs"]
    assert network_kwargs["observation_size"] == 99
    assert network_kwargs["action_size"] == 12
    assert tuple(network_kwargs["policy_hidden_layer_sizes"]) == (512, 256, 128)
