from __future__ import annotations

import json

import numpy as np

from eliza_robot.rl.alberta.classic_control_benchmark import (
    ClassicControlBenchmarkConfig,
    SharedClassicControlEnv,
    run_benchmark,
)


def test_shared_classic_control_env_pads_observations_and_maps_actions():
    env = SharedClassicControlEnv(["CartPole-v1", "Acrobot-v1"], seed=123)
    try:
        assert env.observation_space.shape == (8,)
        assert env.action_space.n == 3

        env.set_task(0)
        obs, _ = env.reset(seed=1)
        assert obs.shape == (8,)
        assert obs[6] == 1.0
        assert obs[7] == 0.0
        next_obs, _reward, _terminated, _truncated, _info = env.step(2)
        assert next_obs.shape == (8,)

        env.set_task(1)
        obs, _ = env.reset(seed=2)
        assert obs.shape == (8,)
        assert obs[6] == 0.0
        assert obs[7] == 1.0
    finally:
        env.close()


def test_classic_control_benchmark_writes_forgetting_artifacts(tmp_path):
    out_dir = tmp_path / "classic"
    bundle = run_benchmark(
        ClassicControlBenchmarkConfig(
            steps_first_task=8,
            steps_second_task=8,
            eval_episodes=1,
            seeds=1,
            learners=("alberta",),
        ),
        out_dir,
    )

    assert bundle["tasks"] == ["CartPole-v1", "Acrobot-v1"]
    assert "alberta" in bundle["aggregate"]
    assert np.asarray(bundle["results"][0]["matrix"]).shape == (2, 2)
    assert "cartpole_retention_delta" in bundle["results"][0]["summary"]

    json_path = out_dir / "classic_control_forgetting.json"
    md_path = out_dir / "classic_control_forgetting.md"
    assert json_path.is_file()
    assert md_path.is_file()
    assert json.loads(json_path.read_text())["config"]["first_task"] == "CartPole-v1"
