"""Tests for latent predictive world models and dream selection."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.behavior_model import BehaviorModel, BehaviorModelConfig
from alberta_framework.core.dreaming import (
    BehaviorModelDreamPolicy,
    DreamSelectionConfig,
    score_dream_candidates,
)
from alberta_framework.core.latent_world_model import (
    LatentWorldModel,
    LatentWorldModelConfig,
    run_latent_world_model_learning_loop,
)


def test_latent_world_model_update_and_prediction_shapes() -> None:
    config = LatentWorldModelConfig(
        observation_dim=3,
        n_actions=2,
        latent_dim=5,
        hidden_sizes=(),
        step_size=0.05,
        sparsity=0.0,
        gamma=0.95,
        observation_scale=(1.0, 2.0, 3.0),
    )
    model = LatentWorldModel(config)
    state = model.init(jr.key(0))

    result = model.update(
        state,
        jnp.array([0.2, -0.1, 0.3], dtype=jnp.float32),
        jnp.array(1, dtype=jnp.int32),
        jnp.array(0.5, dtype=jnp.float32),
        jnp.array(0.95, dtype=jnp.float32),
        jnp.array([0.3, 0.0, 0.2], dtype=jnp.float32),
    )

    assert int(result.state.step_count) == 1
    chex.assert_shape(result.prediction.latent, (5,))
    chex.assert_shape(result.prediction.next_latent, (5,))
    chex.assert_shape(result.prediction.raw_predictions, (7,))
    chex.assert_shape(result.targets, (7,))
    chex.assert_tree_all_finite(result.surprise)
    chex.assert_tree_all_finite(result.latent_std_mean)


def test_latent_world_model_scan_loop_and_config_roundtrip() -> None:
    config = LatentWorldModelConfig(
        observation_dim=2,
        n_actions=2,
        latent_dim=4,
        hidden_sizes=(8,),
        include_action_interactions=True,
        surprise_decay=0.9,
    )
    model = LatentWorldModel(config)
    restored = LatentWorldModel.from_config(model.to_config())
    assert restored.config == config

    state = restored.init(jr.key(3))
    observations = jnp.array(
        [[0.0, 0.0], [0.1, 0.0], [0.1, 0.2]],
        dtype=jnp.float32,
    )
    next_observations = jnp.array(
        [[0.1, 0.0], [0.1, 0.2], [0.2, 0.2]],
        dtype=jnp.float32,
    )
    result = run_latent_world_model_learning_loop(
        restored,
        state,
        observations,
        jnp.array([0, 1, 0], dtype=jnp.int32),
        jnp.array([1.0, 0.5, 0.25], dtype=jnp.float32),
        next_observations,
        jnp.array([0.99, 0.99, 0.0], dtype=jnp.float32),
    )

    assert int(result.state.step_count) == 3
    chex.assert_shape(result.latent_predictions, (3, 4))
    chex.assert_shape(result.next_latent_predictions, (3, 4))
    chex.assert_shape(result.reward_predictions, (3,))
    chex.assert_shape(result.surprises, (3,))
    chex.assert_shape(result.per_head_metrics, (3, 6, 3))
    chex.assert_tree_all_finite(result.prediction_errors)


def test_score_dream_candidates_selects_surprising_useful_valid_items() -> None:
    result = score_dream_candidates(
        surprises=jnp.array([0.1, 0.9, 0.7, 0.3], dtype=jnp.float32),
        utilities=jnp.array([1.0, -1.0, 0.5, 0.4], dtype=jnp.float32),
        confidences=jnp.array([1.0, 1.0, 0.2, 1.0], dtype=jnp.float32),
        model_errors=jnp.array([0.0, 0.0, 0.0, 2.0], dtype=jnp.float32),
        config=DreamSelectionConfig(
            max_items=2,
            surprise_weight=1.0,
            utility_weight=2.0,
            min_surprise=0.2,
            min_utility=0.0,
            min_confidence=0.5,
            max_model_error=1.0,
        ),
    )

    chex.assert_shape(result.selected_indices, (2,))
    assert bool(result.accepted[0]) is False
    assert bool(result.accepted[1]) is False
    assert bool(result.accepted[2]) is False
    assert bool(result.accepted[3]) is False
    assert not bool(jnp.any(result.selected_mask))

    permissive = score_dream_candidates(
        surprises=jnp.array([0.1, 0.9, 0.7, 0.3], dtype=jnp.float32),
        utilities=jnp.array([1.0, -1.0, 0.5, 0.4], dtype=jnp.float32),
        config=DreamSelectionConfig(max_items=2, min_utility=0.0),
    )
    assert set(map(int, permissive.selected_indices.tolist())) == {0, 2}
    assert int(jnp.sum(permissive.selected_mask)) == 2


def test_behavior_model_dream_policy_samples_from_learned_agent_model() -> None:
    model = BehaviorModel(BehaviorModelConfig(n_actions=2, step_size=0.1))
    state = model.init(feature_dim=3, key=jr.key(9))
    state = state.replace(  # type: ignore[attr-defined]
        weights=jnp.array(
            [[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
            dtype=jnp.float32,
        )
    )
    policy = BehaviorModelDreamPolicy(model)
    sample = policy.sample_action(
        state,
        jnp.array([2.0, 0.0, 0.0], dtype=jnp.float32),
        jr.key(10),
    )

    assert int(sample.action) in {0, 1}
    chex.assert_tree_all_finite(sample.action_probability)
    chex.assert_tree_all_finite(sample.log_probability)
