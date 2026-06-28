"""Tests for action-conditioned environment prediction and dream guards."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.dreaming import (
    ActionConditionedDreamWorld,
    DreamBehaviorModelPrediction,
    DreamingConfig,
    DreamRolloutConfig,
    GuardedDreamer,
    RecentObservationBuffer,
    dream_rollout,
    imagined_rollout_to_gvf_items,
    init_dream_rollout_state,
)
from alberta_framework.core.world_model import (
    ActionConditionedWorldModel,
    ActionConditionedWorldModelConfig,
    run_action_conditioned_world_model_learning_loop,
)


def test_action_conditioned_world_model_update_and_prediction_shapes() -> None:
    config = ActionConditionedWorldModelConfig(
        observation_dim=2,
        n_actions=2,
        observation_scale=(1.0, 2.0),
        hidden_sizes=(),
        step_size=0.05,
        sparsity=0.0,
        gamma=0.95,
    )
    model = ActionConditionedWorldModel(config)
    state = model.init(jr.key(0))

    result = model.update(
        state,
        jnp.array([0.2, -0.1], dtype=jnp.float32),
        jnp.array(1, dtype=jnp.int32),
        jnp.array(0.5, dtype=jnp.float32),
        jnp.array(0.95, dtype=jnp.float32),
        jnp.array([0.3, 0.1], dtype=jnp.float32),
    )

    chex.assert_shape(result.prediction.next_observation, (2,))
    chex.assert_shape(result.prediction.raw_predictions, (4,))
    chex.assert_shape(result.targets, (4,))
    chex.assert_shape(result.per_head_metrics, (4, 3))
    assert int(result.state.step_count) == 1
    chex.assert_tree_all_finite(result.prediction.raw_predictions)
    chex.assert_tree_all_finite(result.prediction_error)


def test_action_conditioned_world_model_config_roundtrip() -> None:
    config = ActionConditionedWorldModelConfig(
        observation_dim=3,
        n_actions=4,
        observation_scale=(1.0, 2.0, 3.0),
        hidden_sizes=(8,),
        error_decay=0.9,
    )
    model = ActionConditionedWorldModel(config)
    restored = ActionConditionedWorldModel.from_config(model.to_config())

    assert restored.config == config
    features = restored.input_features(
        jnp.array([1.0, 2.0, 3.0], dtype=jnp.float32),
        jnp.array(2, dtype=jnp.int32),
    )
    chex.assert_shape(features, (7,))
    chex.assert_trees_all_close(features[-4:], jnp.array([0.0, 0.0, 1.0, 0.0]))


def test_action_conditioned_world_model_optional_interaction_features() -> None:
    config = ActionConditionedWorldModelConfig(
        observation_dim=2,
        n_actions=3,
        hidden_sizes=(),
        include_action_interactions=True,
    )
    model = ActionConditionedWorldModel(config)

    assert model.input_dim == 11
    features = model.input_features(
        jnp.array([2.0, -3.0], dtype=jnp.float32),
        jnp.array(1, dtype=jnp.int32),
    )

    chex.assert_shape(features, (11,))
    chex.assert_trees_all_close(features[:2], jnp.array([2.0, -3.0]))
    chex.assert_trees_all_close(features[2:5], jnp.array([0.0, 1.0, 0.0]))
    chex.assert_trees_all_close(
        features[5:],
        jnp.array([0.0, 2.0, 0.0, -0.0, -3.0, -0.0]),
    )


def test_action_conditioned_world_model_scan_loop_shapes() -> None:
    config = ActionConditionedWorldModelConfig(
        observation_dim=2,
        n_actions=2,
        hidden_sizes=(),
        step_size=0.05,
        sparsity=0.0,
    )
    model = ActionConditionedWorldModel(config)
    state = model.init(jr.key(8))
    observations = jnp.array(
        [[0.0, 0.0], [0.1, 0.0], [0.1, 0.2]],
        dtype=jnp.float32,
    )
    next_observations = jnp.array(
        [[0.1, 0.0], [0.1, 0.2], [0.2, 0.2]],
        dtype=jnp.float32,
    )
    result = run_action_conditioned_world_model_learning_loop(
        model,
        state,
        observations,
        jnp.array([0, 1, 0], dtype=jnp.int32),
        jnp.array([1.0, 0.5, 0.25], dtype=jnp.float32),
        next_observations,
        jnp.array([0.99, 0.99, 0.0], dtype=jnp.float32),
    )

    assert int(result.state.step_count) == 3
    chex.assert_shape(result.next_observation_predictions, (3, 2))
    chex.assert_shape(result.reward_predictions, (3,))
    chex.assert_shape(result.discount_predictions, (3,))
    chex.assert_shape(result.per_head_metrics, (3, 4, 3))
    chex.assert_tree_all_finite(result.prediction_errors)


def test_guarded_dreamer_rejects_warmup_and_accepts_after_real_updates() -> None:
    config = ActionConditionedWorldModelConfig(
        observation_dim=2,
        n_actions=2,
        hidden_sizes=(),
        step_size=0.05,
        sparsity=0.0,
        error_decay=0.0,
    )
    model = ActionConditionedWorldModel(config)
    model_state = model.init(jr.key(1))
    dreamer = GuardedDreamer(
        DreamingConfig(warmup_steps=1, max_model_error_ema=100.0, max_uncertainty=0.1)
    )
    obs = jnp.array([0.0, 0.0], dtype=jnp.float32)
    action = jnp.array(0, dtype=jnp.int32)

    cold = dreamer.propose(model, model_state, obs, action)
    assert int(cold.reject_code) == GuardedDreamer.REJECT_WARMUP
    assert not bool(cold.accepted)

    update = model.update(
        model_state,
        obs,
        action,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array(0.99, dtype=jnp.float32),
        jnp.array([0.1, 0.0], dtype=jnp.float32),
    )
    warm = dreamer.propose(
        model,
        update.state,
        obs,
        action,
        uncertainty=jnp.array(0.0, dtype=jnp.float32),
    )

    assert int(warm.reject_code) == GuardedDreamer.ACCEPT
    assert bool(warm.accepted)
    chex.assert_shape(warm.transition.next_observation, (2,))


def test_recent_observation_buffer_ring_and_sample() -> None:
    buffer = RecentObservationBuffer(capacity=2, observation_dim=3)
    state = buffer.init()
    state = buffer.add(state, jnp.array([1.0, 0.0, 0.0], dtype=jnp.float32))
    state = buffer.add(state, jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32))
    state = buffer.add(state, jnp.array([0.0, 0.0, 1.0], dtype=jnp.float32))

    assert int(state.size) == 2
    sample, idx = buffer.sample(state, jr.key(3))
    chex.assert_shape(sample, (3,))
    assert 0 <= int(idx) < 2


class _ConstantBehavior:
    def sample_action(
        self,
        state: object,
        observation: jnp.ndarray,
        key: jnp.ndarray,
    ) -> DreamBehaviorModelPrediction:
        del state, observation, key
        return DreamBehaviorModelPrediction(
            action=jnp.array(1, dtype=jnp.int32),
            action_probability=jnp.array(1.0, dtype=jnp.float32),
            log_probability=jnp.array(0.0, dtype=jnp.float32),
        )


def test_action_conditioned_dream_rollout_converts_to_gvf_items() -> None:
    config = ActionConditionedWorldModelConfig(
        observation_dim=2,
        n_actions=2,
        hidden_sizes=(),
        step_size=0.05,
        sparsity=0.0,
        error_decay=0.0,
    )
    model = ActionConditionedWorldModel(config)
    state = model.init(jr.key(4))
    obs = jnp.array([0.0, 0.0], dtype=jnp.float32)
    update = model.update(
        state,
        obs,
        jnp.array(1, dtype=jnp.int32),
        jnp.array(0.25, dtype=jnp.float32),
        jnp.array(0.99, dtype=jnp.float32),
        jnp.array([0.1, 0.0], dtype=jnp.float32),
    )

    rollout = dream_rollout(
        ActionConditionedDreamWorld(model),
        update.state,
        _ConstantBehavior(),
        None,
        init_dream_rollout_state(obs, jr.key(5)),
        DreamRolloutConfig(rollout_horizon=2, max_model_error=100.0),
    )
    gvf_item = imagined_rollout_to_gvf_items(rollout)

    chex.assert_shape(rollout.transitions.observation, (2, 2))
    chex.assert_shape(gvf_item.observations, (2, 2))
    chex.assert_shape(gvf_item.cumulants, (2, 1))
    chex.assert_shape(gvf_item.discounts, (2,))
