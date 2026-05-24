from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy  # noqa: E402


def test_brax_policy_adapter_reconstructs_asymmetric_observation_network(
    monkeypatch,
    tmp_path: Path,
) -> None:
    from brax.io import model as brax_model
    from brax.training.agents.ppo import networks as ppo_networks

    manifest = {
        "regime": "brax_ppo",
        "profile_id": "asimov-1",
        "curriculum_version": 1,
        "pca_dim": 4,
        "active_tasks": ["stand_up"],
        "obs_dim": 49,
        "proprio_dim": 45,
        "text_dim": 4,
        "critic_obs_dim": 58,
        "policy_obs_key": "state",
        "value_obs_key": "privileged_state",
        "action_dim": 12,
        "output_dim": 25,
        "ckpt": "policy_brax.pkl",
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (tmp_path / "policy_brax.pkl").write_bytes(b"not-empty")

    captured: dict[str, object] = {}
    monkeypatch.setattr(brax_model, "load_params", lambda _path: ("normalizer", "policy", "value"))

    def fake_make_ppo_networks(**kwargs):
        captured["network_kwargs"] = kwargs
        return {"network": kwargs}

    def fake_make_inference_fn(_networks):
        def make_fn(_params, deterministic: bool):
            captured["deterministic"] = deterministic

            def inference(obs, _key):
                captured["obs_keys"] = sorted(obs)
                return obs["state"][:12] * 0.0 + 1.0, None

            return inference

        return make_fn

    monkeypatch.setattr(ppo_networks, "make_ppo_networks", fake_make_ppo_networks)
    monkeypatch.setattr(ppo_networks, "make_inference_fn", fake_make_inference_fn)

    policy = TextConditionedPolicy(tmp_path)
    action, task = policy.act("stand_up", np.zeros(45, dtype=np.float32))

    assert task == "stand_up"
    assert action.shape == (25,)
    assert np.allclose(action[:12], 1.0)
    assert np.allclose(action[12:], 0.0)
    network_kwargs = captured["network_kwargs"]
    assert network_kwargs["observation_size"] == {"state": 49, "privileged_state": 58}
    assert network_kwargs["policy_obs_key"] == "state"
    assert network_kwargs["value_obs_key"] == "privileged_state"
    assert captured["obs_keys"] == ["state"]
