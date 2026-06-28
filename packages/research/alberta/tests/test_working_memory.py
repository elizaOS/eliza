# mypy: disable-error-code="call-arg,untyped-decorator"
"""Tests for lightweight working-memory predictive-state features."""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp

from alberta_framework.core.working_memory import (
    WorkingMemoryConfig,
    WorkingMemoryFeaturizer,
    WorkingMemoryState,
    transform_working_memory_arrays,
)


def test_working_memory_config_roundtrip_and_shapes() -> None:
    config = WorkingMemoryConfig(
        observation_dim=3,
        action_dim=2,
        reward_dim=1,
        observation_decay_rates=(0.5, 0.9),
        action_decay_rates=(0.25,),
        reward_decay_rates=(0.0, 0.8),
        include_innovations=True,
    )
    memory = WorkingMemoryFeaturizer(config)
    restored = WorkingMemoryFeaturizer.from_config(memory.to_config())
    state = restored.init()

    assert restored.config == config
    assert restored.feature_dim() == config.feature_dim()
    chex.assert_shape(state.observation_traces, (2, 3))
    chex.assert_shape(state.action_traces, (1, 2))
    chex.assert_shape(state.reward_traces, (2, 1))
    chex.assert_shape(state.last_gate, (3,))


def test_working_memory_trace_decay_and_feature_causality() -> None:
    config = WorkingMemoryConfig(
        observation_dim=1,
        action_dim=0,
        reward_dim=0,
        observation_decay_rates=(0.5,),
        include_current_observation=False,
        include_current_action=False,
        include_current_reward=False,
    )
    memory = WorkingMemoryFeaturizer(config)
    state = memory.init()

    state1, features1 = memory.step(
        state,
        jnp.asarray([2.0]),
        memory.zero_action(),
        memory.zero_reward(),
    )
    state2, features2 = memory.step(
        state1,
        jnp.asarray([0.0]),
        memory.zero_action(),
        memory.zero_reward(),
    )

    chex.assert_trees_all_close(features1, jnp.asarray([0.0]))
    chex.assert_trees_all_close(state1.observation_traces[0], jnp.asarray([1.0]))
    chex.assert_trees_all_close(features2, jnp.asarray([1.0]))
    chex.assert_trees_all_close(state2.observation_traces[0], jnp.asarray([0.5]))


def test_working_memory_reset_semantics() -> None:
    memory = WorkingMemoryFeaturizer(
        WorkingMemoryConfig(observation_dim=2, action_dim=1, reward_dim=1)
    )
    state, _ = memory.step(
        memory.init(),
        jnp.asarray([1.0, -1.0]),
        jnp.asarray([1.0]),
        jnp.asarray([0.5]),
    )
    reset = memory.reset()

    assert int(state.step_count) == 1
    assert int(reset.step_count) == 0
    chex.assert_trees_all_close(reset.observation_traces, jnp.zeros_like(reset.observation_traces))
    chex.assert_trees_all_close(reset.action_traces, jnp.zeros_like(reset.action_traces))
    chex.assert_trees_all_close(reset.reward_traces, jnp.zeros_like(reset.reward_traces))


def test_working_memory_action_and_reward_are_included() -> None:
    config = WorkingMemoryConfig(
        observation_dim=1,
        action_dim=3,
        reward_dim=1,
        observation_decay_rates=(),
        action_decay_rates=(0.0,),
        reward_decay_rates=(0.0,),
        include_current_observation=False,
        include_current_action=False,
        include_current_reward=False,
    )
    memory = WorkingMemoryFeaturizer(config)
    action = jnp.asarray([0.0, 1.0, 0.0])
    reward = jnp.asarray([2.5])

    state, features0 = memory.step(memory.init(), jnp.asarray([0.0]), action, reward)
    _, features1 = memory.step(state, jnp.asarray([0.0]), jnp.zeros(3), jnp.zeros(1))

    chex.assert_trees_all_close(features0, jnp.zeros(4))
    chex.assert_trees_all_close(features1, jnp.asarray([0.0, 1.0, 0.0, 2.5]))


def test_working_memory_gated_update_can_hold_traces() -> None:
    config = WorkingMemoryConfig(
        observation_dim=1,
        action_dim=0,
        reward_dim=0,
        observation_decay_rates=(0.0,),
        include_current_observation=False,
        include_current_action=False,
        include_current_reward=False,
    )
    memory = WorkingMemoryFeaturizer(config)
    state = memory.init()
    state1 = memory.update(state, jnp.asarray([1.0]), memory.zero_action(), memory.zero_reward())
    held = memory.update(
        state1,
        jnp.asarray([5.0]),
        memory.zero_action(),
        memory.zero_reward(),
        external_gate=0.0,
    )

    chex.assert_trees_all_close(held.observation_traces, state1.observation_traces)
    chex.assert_trees_all_close(held.last_gate, jnp.zeros(3))


def test_working_memory_scan_and_jit_compatibility() -> None:
    config = WorkingMemoryConfig(
        observation_dim=2,
        action_dim=2,
        reward_dim=1,
        observation_decay_rates=(0.5, 0.9),
        include_innovations=True,
    )
    memory = WorkingMemoryFeaturizer(config)
    observations = jnp.arange(20, dtype=jnp.float32).reshape(10, 2) / 10.0
    action_ids = jnp.arange(10) % 2
    actions = jax.nn.one_hot(action_ids, 2)
    rewards = jnp.linspace(-1.0, 1.0, 10).reshape(10, 1)

    @jax.jit
    def run(initial_state: WorkingMemoryState):
        return transform_working_memory_arrays(
            memory,
            observations,
            actions,
            rewards,
            state=initial_state,
        )

    final_state, features = run(memory.init())

    chex.assert_shape(features, (10, config.feature_dim()))
    chex.assert_tree_all_finite(features)
    chex.assert_tree_all_finite(final_state)
    assert int(final_state.step_count) == 10


def test_working_memory_diagnostics_are_finite() -> None:
    memory = WorkingMemoryFeaturizer(WorkingMemoryConfig(observation_dim=2, action_dim=1))
    state = memory.update(
        memory.init(),
        jnp.asarray([1.0, 2.0]),
        jnp.asarray([1.0]),
        jnp.asarray([0.5]),
    )
    diagnostics = memory.diagnostics(state)

    assert int(diagnostics.step_count) == 1
    assert float(diagnostics.trace_energy) > 0.0
    assert float(diagnostics.effective_dimension) > 0.0
    chex.assert_tree_all_finite(diagnostics)


def test_working_memory_delayed_action_positive_control() -> None:
    config = WorkingMemoryConfig(
        observation_dim=1,
        action_dim=2,
        reward_dim=0,
        observation_decay_rates=(),
        action_decay_rates=(0.0,),
        reward_decay_rates=(),
        include_current_observation=False,
        include_current_action=False,
        include_current_reward=False,
    )
    memory = WorkingMemoryFeaturizer(config)
    observations = jnp.zeros((8, 1), dtype=jnp.float32)
    action_ids = jnp.asarray([0, 1, 1, 0, 1, 0, 0, 1])
    actions = jax.nn.one_hot(action_ids, 2)
    rewards = jnp.zeros((8, 0), dtype=jnp.float32)
    _, features = transform_working_memory_arrays(memory, observations, actions, rewards)

    delayed_first_action = jnp.concatenate(
        [jnp.asarray([0.0]), actions[:-1, 0]],
        axis=0,
    )
    memory_prediction = features[:, 0]
    raw_prediction = jnp.zeros_like(delayed_first_action)
    memory_mse = jnp.mean((memory_prediction - delayed_first_action) ** 2)
    raw_mse = jnp.mean((raw_prediction - delayed_first_action) ** 2)

    chex.assert_trees_all_close(memory_mse, 0.0)
    assert float(memory_mse) < float(raw_mse)
