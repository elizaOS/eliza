from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")


def _run_mjx_contract_child(code: str) -> None:
    env = dict(os.environ)
    env.setdefault("JAX_PLATFORMS", "cpu")
    env.setdefault("JAX_PLATFORM_NAME", "cpu")
    env.setdefault("CUDA_VISIBLE_DEVICES", "")
    root = Path(__file__).resolve().parents[4]
    robot_pkg = str(root / "packages" / "robot")
    env["PYTHONPATH"] = (
        robot_pkg
        if not env.get("PYTHONPATH")
        else f"{robot_pkg}{os.pathsep}{env['PYTHONPATH']}"
    )
    proc = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        cwd=root,
        env=env,
        text=True,
        capture_output=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_asimov_mjx_env_reset_step_contract() -> None:
    _run_mjx_contract_child(
        """
        import os
        os.environ.setdefault("JAX_PLATFORMS", "cpu")
        os.environ.setdefault("JAX_PLATFORM_NAME", "cpu")
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
        import pytest
        jax = pytest.importorskip("jax")
        jp = pytest.importorskip("jax.numpy")
        pytest.importorskip("mujoco")
        pytest.importorskip("mujoco_playground")
        from eliza_robot.asimov_1.constants import (
            ASIMOV1_ACTOR_OBSERVATION_DIM,
            ASIMOV1_FULL_ACTION_DIM,
            ASIMOV1_LEG_ACTION_DIM,
            ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM,
        )
        from eliza_robot.sim.mujoco.asimov_mjx_training import make_asimov_text_conditioned_mjx_env

        env = make_asimov_text_conditioned_mjx_env(
            active_tasks=("stand_up", "walk_forward"),
            pca_dim=8,
            episode_length=2,
            domain_randomization={},
        )

        assert env.proprio_dim == ASIMOV1_ACTOR_OBSERVATION_DIM
        assert env.text_dim == 8
        assert env.actor_observation_size == ASIMOV1_ACTOR_OBSERVATION_DIM + 8
        assert env.privileged_observation_size == (
            ASIMOV1_ACTOR_OBSERVATION_DIM + 8 + ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM
        )
        assert env.observation_size == {
            "state": env.actor_observation_size,
            "privileged_state": env.privileged_observation_size,
        }
        assert env.action_size == ASIMOV1_LEG_ACTION_DIM
        assert env.mj_model.nu == ASIMOV1_FULL_ACTION_DIM
        assert env.n_substeps == 4
        assert env.observation_delay_steps == (1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2)

        state = env.reset(jax.random.PRNGKey(0))
        assert tuple(state.obs["state"].shape) == (env.actor_observation_size,)
        assert tuple(state.obs["privileged_state"].shape) == (env.privileged_observation_size,)
        assert bool(jp.all(jp.isfinite(state.obs["state"])))
        assert bool(jp.all(jp.isfinite(state.obs["privileged_state"])))
        assert tuple(state.info["motor_targets"].shape) == (ASIMOV1_FULL_ACTION_DIM,)
        assert tuple(state.info["qpos_history"].shape) == (3, ASIMOV1_LEG_ACTION_DIM)
        assert tuple(state.info["qvel_history"].shape) == (3, ASIMOV1_LEG_ACTION_DIM)

        action = jp.linspace(-0.25, 0.25, env.action_size)
        state = env.step(state, action)
        assert tuple(state.obs["state"].shape) == (env.actor_observation_size,)
        assert tuple(state.obs["privileged_state"].shape) == (env.privileged_observation_size,)
        assert bool(jp.all(jp.isfinite(state.obs["state"])))
        assert bool(jp.all(jp.isfinite(state.obs["privileged_state"])))
        assert bool(jp.isfinite(state.reward))
        assert tuple(state.info["motor_targets"].shape) == (ASIMOV1_FULL_ACTION_DIM,)

        state = env.step(state, action)
        assert bool(state.done), "episode_length=2 should mark the second step done"
        os._exit(0)
        """
    )


def test_asimov_mjx_observation_uses_grouped_delayed_joint_state() -> None:
    _run_mjx_contract_child(
        """
        import os
        os.environ.setdefault("JAX_PLATFORMS", "cpu")
        os.environ.setdefault("JAX_PLATFORM_NAME", "cpu")
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
        import pytest
        jax = pytest.importorskip("jax")
        jp = pytest.importorskip("jax.numpy")
        pytest.importorskip("mujoco")
        pytest.importorskip("mujoco_playground")
        from eliza_robot.asimov_1.constants import ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS
        from eliza_robot.sim.mujoco.asimov_mjx_training import make_asimov_text_conditioned_mjx_env

        env = make_asimov_text_conditioned_mjx_env(
            active_tasks=("stand_up",),
            pca_dim=4,
            episode_length=2,
            domain_randomization={},
        )
        state = env.reset(jax.random.PRNGKey(1))
        qpos_history = jp.arange(36, dtype=jp.float32).reshape(3, 12)
        qvel_history = qpos_history + 100.0
        info = dict(state.info)
        info["qpos_history"] = qpos_history
        info["qvel_history"] = qvel_history

        proprio = env._get_proprio(state.data, info)
        qpos_slice = proprio[9:21]
        qvel_slice = proprio[21:33]

        expected_qpos = []
        expected_qvel = []
        for group, indices in ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS.items():
            delay = 1 if group == "left_leg" else 2
            for idx in indices:
                expected_qpos.append(float(qpos_history[delay, idx]))
                expected_qvel.append(float(qvel_history[delay, idx]))

        assert tuple(qpos_slice.tolist()) == tuple(expected_qpos)
        assert tuple(qvel_slice.tolist()) == tuple(expected_qvel)
        os._exit(0)
        """
    )


def test_asimov_train_from_job_impl_writes_brax_artifact_contract() -> None:
    _run_mjx_contract_child(
        """
        import json
        import os
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace

        from eliza_robot.asimov_1.constants import (
            ASIMOV1_ACTOR_OBSERVATION_DIM,
            ASIMOV1_FULL_ACTION_DIM,
            ASIMOV1_GENERATED_MANIFEST,
            ASIMOV1_GENERATED_MJCF,
            ASIMOV1_LEG_ACTION_DIM,
            ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM,
        )
        from eliza_robot.asimov_1.cad import sha256_file
        from eliza_robot.sim.mujoco.asimov_mjx_training import _train_from_job_impl
        from eliza_robot.sim.mujoco.asimov_training import asimov_full_training_job_spec

        with tempfile.TemporaryDirectory(prefix="asimov-mjx-train-test-") as tmp:
            tmp_path = Path(tmp)
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
                actor_observation_size = ASIMOV1_ACTOR_OBSERVATION_DIM + 6
                privileged_observation_size = (
                    ASIMOV1_ACTOR_OBSERVATION_DIM
                    + 6
                    + ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM
                )
                proprio_dim = ASIMOV1_ACTOR_OBSERVATION_DIM
                text_dim = 6
                action_size = ASIMOV1_LEG_ACTION_DIM
                active_tasks = ("stand_up", "walk_forward")
                _config = SimpleNamespace(episode_length=3)

            captured = {}

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
            assert manifest["mjcf_xml"] == str(ASIMOV1_GENERATED_MJCF)
            assert manifest["mjcf_xml_sha256"] == sha256_file(ASIMOV1_GENERATED_MJCF)
            assert manifest["asset_manifest"] == str(ASIMOV1_GENERATED_MANIFEST)
            assert manifest["asset_manifest_sha256"] == sha256_file(
                ASIMOV1_GENERATED_MANIFEST
            )
            assert manifest["obs_dim"] == ASIMOV1_ACTOR_OBSERVATION_DIM + 6
            assert manifest["proprio_dim"] == ASIMOV1_ACTOR_OBSERVATION_DIM
            assert manifest["text_dim"] == 6
            assert manifest["critic_obs_dim"] == (
                ASIMOV1_ACTOR_OBSERVATION_DIM + 6 + ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM
            )
            assert manifest["policy_obs_key"] == "state"
            assert manifest["value_obs_key"] == "privileged_state"
            assert manifest["action_dim"] == ASIMOV1_LEG_ACTION_DIM
            assert manifest["output_dim"] == ASIMOV1_FULL_ACTION_DIM
            assert manifest["observation_delay_steps"] == {"left_leg": 1, "right_leg": 2}
            assert manifest["ckpt"] == "policy_brax.pkl"
            assert metrics == [{"steps": 4, "reward": 1.5, "elapsed_s": metrics[0]["elapsed_s"]}]
            assert config["active_tasks"] == ["stand_up", "walk_forward"]
            assert config["mjcf_xml"] == str(ASIMOV1_GENERATED_MJCF)
            assert config["mjcf_xml_sha256"] == sha256_file(ASIMOV1_GENERATED_MJCF)
            assert config["asset_manifest"] == str(ASIMOV1_GENERATED_MANIFEST)
            assert config["asset_manifest_sha256"] == sha256_file(ASIMOV1_GENERATED_MANIFEST)
            assert config["observation_delay_steps"] == {"left_leg": 1, "right_leg": 2}

            assert captured["env_kwargs"] == {
                "active_tasks": tuple(job["active_tasks"]),
                "pca_dim": 6,
                "episode_length": 500,
                "domain_randomization": {},
                "observation_delay_steps": {"left_leg": 1, "right_leg": 2},
            }
            ppo_kwargs = captured["ppo_kwargs"]
            assert ppo_kwargs["num_timesteps"] == 8
            assert ppo_kwargs["num_envs"] == 2
            assert ppo_kwargs["episode_length"] == 3
            assert ppo_kwargs["seed"] == 11
            network_kwargs = captured["network_kwargs"]
            assert network_kwargs["observation_size"] == 99
            assert network_kwargs["action_size"] == 12
            assert network_kwargs["policy_obs_key"] == "state"
            assert network_kwargs["value_obs_key"] == "privileged_state"
            assert tuple(network_kwargs["policy_hidden_layer_sizes"]) == (512, 256, 128)
        os._exit(0)
        """
    )
