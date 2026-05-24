"""Tests for online reward models."""

from __future__ import annotations

import chex
import jax.numpy as jnp

from alberta_framework.core.reward_model import RLSRewardModel, RLSRewardModelConfig


def test_rls_reward_model_config_roundtrip() -> None:
    """Config serialization should preserve all fields."""
    config = RLSRewardModelConfig(
        feature_dim=4,
        forgetting=0.99,
        ridge=3.0,
        error_decay=0.9,
    )

    restored = RLSRewardModelConfig.from_config(config.to_config())

    assert restored == config


def test_rls_reward_model_learns_linear_reward() -> None:
    """RLS should quickly fit a deterministic linear reward surface."""
    model = RLSRewardModel(
        RLSRewardModelConfig(feature_dim=3, forgetting=1.0, ridge=0.1)
    )
    state = model.init()
    true_weights = jnp.array([0.25, -0.5, 0.75], dtype=jnp.float32)
    features = jnp.array(
        [
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [1.0, 0.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 2.0, -1.0],
        ],
        dtype=jnp.float32,
    )

    for _ in range(16):
        for feature in features:
            reward = jnp.dot(true_weights, feature)
            state = model.update(state, feature, reward).state

    predictions = jnp.array([model.predict(state, feature) for feature in features])
    targets = features @ true_weights

    chex.assert_trees_all_close(predictions, targets, atol=2e-3, rtol=2e-3)
    chex.assert_tree_all_finite(state.covariance)
    assert int(state.step_count) == 80


def test_rls_reward_model_rejects_invalid_config() -> None:
    """Invalid numerical settings should fail early."""
    for config in (
        RLSRewardModelConfig(feature_dim=0),
        RLSRewardModelConfig(feature_dim=1, forgetting=0.0),
        RLSRewardModelConfig(feature_dim=1, ridge=0.0),
        RLSRewardModelConfig(feature_dim=1, error_decay=1.0),
    ):
        try:
            RLSRewardModel(config)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {config}")
