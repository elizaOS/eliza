"""Tests for the Step 9 guarded-dreaming facade."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.steps.step6 import Step6DifferentialSARSAConfig
from alberta_framework.steps.step9 import (
    Step9DreamingConfig,
    Step9DreamingState,
    init_step9_state,
    make_step9_components,
    run_step9_scan,
    run_step9_smoke,
    step9_update,
)

# ---------------------------------------------------------------------------
# Config tests
# ---------------------------------------------------------------------------


def test_step9_config_roundtrip() -> None:
    cfg = Step9DreamingConfig(
        control=Step6DifferentialSARSAConfig(n_actions=3),
        observation_dim=3,
        n_actions=3,
        model_hidden_sizes=(32,),
        model_step_size=0.05,
        model_sparsity=0.0,
        planning_budget=2,
        behavior_model_step_size=0.02,
        dream_rollout_horizon=3,
        dream_candidate_count=4,
        dream_surprise_weight=0.5,
        dream_utility_weight=1.5,
        buffer_capacity=16,
    )
    assert Step9DreamingConfig.from_dict(cfg.to_dict()) == cfg


def test_step9_config_n_actions_mismatch_raises() -> None:
    with pytest.raises(ValueError, match="n_actions"):
        Step9DreamingConfig(
            control=Step6DifferentialSARSAConfig(n_actions=2),
            n_actions=3,
        )


def test_step9_config_negative_planning_budget_raises() -> None:
    with pytest.raises(ValueError, match="planning_budget"):
        Step9DreamingConfig(planning_budget=-1)


def test_step9_config_negative_warmup_raises() -> None:
    with pytest.raises(ValueError, match="warmup"):
        Step9DreamingConfig(dreaming_warmup_steps=-1)


def test_step9_config_negative_max_error_raises() -> None:
    with pytest.raises(ValueError, match="max_model_error"):
        Step9DreamingConfig(dreaming_max_model_error=-0.1)


def test_step9_config_zero_buffer_capacity_raises() -> None:
    with pytest.raises(ValueError, match="buffer_capacity"):
        Step9DreamingConfig(buffer_capacity=0)


def test_step9_config_negative_behavior_step_size_raises() -> None:
    with pytest.raises(ValueError, match="behavior_model_step_size"):
        Step9DreamingConfig(behavior_model_step_size=-0.1)


def test_step9_config_zero_dream_rollout_horizon_raises() -> None:
    with pytest.raises(ValueError, match="dream_rollout_horizon"):
        Step9DreamingConfig(dream_rollout_horizon=0)


def test_step9_config_zero_dream_candidate_count_raises() -> None:
    with pytest.raises(ValueError, match="dream_candidate_count"):
        Step9DreamingConfig(dream_candidate_count=0)


# ---------------------------------------------------------------------------
# Factory and init tests
# ---------------------------------------------------------------------------


def test_step9_make_components_returns_correct_types() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
    )
    agent, model, buffer = make_step9_components(cfg)
    assert model.config.observation_dim == 2
    assert model.config.n_actions == 2
    assert buffer.capacity == cfg.buffer_capacity


def test_step9_init_state_fields() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
    )
    agent, model, buffer = make_step9_components(cfg)
    initial_obs = jnp.array([0.5, -0.5], dtype=jnp.float32)
    state = init_step9_state(agent, model, buffer, key=jr.key(0), initial_observation=initial_obs)
    assert isinstance(state, Step9DreamingState)
    assert int(state.step_count) == 0
    assert int(state.world_model_state.step_count) == 0
    assert int(state.behavior_model_state.step_count) == 0
    assert int(state.buffer_state.size) >= 1


# ---------------------------------------------------------------------------
# Single-step update tests
# ---------------------------------------------------------------------------


def test_step9_single_update_increments_counters() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=2,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent, model, buffer,
        key=jr.key(1),
        initial_observation=jnp.zeros(2),
    )
    result = step9_update(
        cfg, agent, model, buffer,
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([0.1, 0.2], dtype=jnp.float32),
    )
    assert int(result.state.step_count) == 1
    assert int(result.state.world_model_state.step_count) == 1
    assert int(result.state.behavior_model_state.step_count) == 1
    chex.assert_shape(result.dream_td_errors, (2,))
    chex.assert_shape(result.dream_accepted, (2,))


def test_step9_dreams_rejected_before_warmup() -> None:
    """With warmup=100 and only 1 step, no dreams should be accepted."""
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=4,
        dreaming_warmup_steps=100,
        dreaming_max_model_error=1e30,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent, model, buffer,
        key=jr.key(2),
        initial_observation=jnp.zeros(2),
    )
    result = step9_update(
        cfg, agent, model, buffer,
        state,
        jnp.array(0.0, dtype=jnp.float32),
        jnp.zeros(2, dtype=jnp.float32),
    )
    assert not bool(jnp.any(result.dream_accepted)), "Dreams should be rejected before warmup"


def test_step9_dreams_accepted_with_zero_warmup_and_high_error_threshold() -> None:
    """With warmup=0 and a very high error threshold, dreams should be accepted."""
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=2,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent, model, buffer,
        key=jr.key(3),
        initial_observation=jnp.zeros(2),
    )
    result = step9_update(
        cfg, agent, model, buffer,
        state,
        jnp.array(0.5, dtype=jnp.float32),
        jnp.array([0.3, -0.3], dtype=jnp.float32),
    )
    assert bool(jnp.any(result.dream_accepted)), "At least one dream should be accepted"


def test_step9_dreams_rejected_when_error_too_high() -> None:
    """With a very strict error threshold, dreams should be rejected."""
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=3,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=0.0,  # impossible threshold
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent, model, buffer,
        key=jr.key(4),
        initial_observation=jnp.zeros(2),
    )
    # run a few updates so model_error_ema becomes nonzero
    obs = jnp.array([1.0, 2.0], dtype=jnp.float32)
    result = step9_update(cfg, agent, model, buffer, state,
                          jnp.array(1.0), obs)
    assert not bool(jnp.any(result.dream_accepted)), (
        "Dreams should be rejected when error exceeds threshold"
    )


def test_step9_multi_step_behavior_model_dreaming_path() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=2,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
        behavior_model_step_size=0.1,
        dream_rollout_horizon=3,
        dream_candidate_count=3,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent,
        model,
        buffer,
        key=jr.key(41),
        initial_observation=jnp.zeros(2),
    )
    result = step9_update(
        cfg,
        agent,
        model,
        buffer,
        state,
        jnp.array(0.25, dtype=jnp.float32),
        jnp.array([0.2, -0.1], dtype=jnp.float32),
    )
    chex.assert_shape(result.dream_td_errors, (2,))
    chex.assert_shape(result.dream_accepted, (2,))
    chex.assert_tree_all_finite(result.dream_td_errors)
    assert int(result.state.behavior_model_state.step_count) == 1
    assert bool(jnp.any(result.dream_accepted))


def test_step9_prioritized_candidate_selection_path() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=1,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
        dream_candidate_count=5,
        dream_surprise_weight=2.0,
        dream_utility_weight=0.5,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent,
        model,
        buffer,
        key=jr.key(42),
        initial_observation=jnp.array([0.1, -0.1], dtype=jnp.float32),
    )
    result = step9_update(
        cfg,
        agent,
        model,
        buffer,
        state,
        jnp.array(0.5, dtype=jnp.float32),
        jnp.array([0.3, 0.4], dtype=jnp.float32),
    )
    chex.assert_shape(result.dream_td_errors, (1,))
    chex.assert_shape(result.dream_accepted, (1,))
    chex.assert_tree_all_finite(result.dream_td_errors)
    chex.assert_tree_all_finite(result.real_control_result.td_error)
    chex.assert_tree_all_finite(result.real_model_result.prediction_error)
    assert bool(result.dream_accepted[0])


# ---------------------------------------------------------------------------
# Zero planning budget
# ---------------------------------------------------------------------------


def test_step9_zero_planning_budget() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=0,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent, model, buffer,
        key=jr.key(5),
        initial_observation=jnp.zeros(2),
    )
    result = step9_update(
        cfg, agent, model, buffer,
        state,
        jnp.array(0.0, dtype=jnp.float32),
        jnp.zeros(2, dtype=jnp.float32),
    )
    chex.assert_shape(result.dream_td_errors, (0,))
    chex.assert_shape(result.dream_accepted, (0,))
    assert int(result.state.step_count) == 1


# ---------------------------------------------------------------------------
# Scan tests
# ---------------------------------------------------------------------------


def test_step9_scan_shapes() -> None:
    steps = 8
    cfg = Step9DreamingConfig(
        observation_dim=3,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=2,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
    )
    agent, model, buffer = make_step9_components(cfg)
    observations = jr.normal(jr.key(6), (steps + 1, 3), dtype=jnp.float32)
    rewards = jnp.tanh(observations[1:, 0])
    state = init_step9_state(agent, model, buffer, key=jr.key(7),
                              initial_observation=observations[0])
    result = run_step9_scan(cfg, agent, model, buffer, state, rewards, observations[1:])
    chex.assert_shape(result.real_td_errors, (steps,))
    chex.assert_shape(result.average_rewards, (steps,))
    chex.assert_shape(result.actions, (steps,))
    chex.assert_shape(result.model_prediction_errors, (steps,))
    chex.assert_shape(result.dream_td_errors, (steps, 2))
    chex.assert_shape(result.dream_accepted, (steps, 2))
    chex.assert_tree_all_finite(result.real_td_errors)
    chex.assert_tree_all_finite(result.average_rewards)
    chex.assert_tree_all_finite(result.model_prediction_errors)


def test_step9_scan_actions_in_range() -> None:
    steps = 16
    cfg = Step9DreamingConfig(
        observation_dim=4,
        n_actions=3,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=1,
        control=Step6DifferentialSARSAConfig(n_actions=3),
    )
    agent, model, buffer = make_step9_components(cfg)
    observations = jr.normal(jr.key(8), (steps + 1, 4))
    rewards = jnp.tanh(observations[1:, 0])
    state = init_step9_state(agent, model, buffer, key=jr.key(9),
                              initial_observation=observations[0])
    result = run_step9_scan(cfg, agent, model, buffer, state, rewards, observations[1:])
    assert bool(jnp.all(result.actions >= 0))
    assert bool(jnp.all(result.actions < 3))


# ---------------------------------------------------------------------------
# Smoke tests
# ---------------------------------------------------------------------------


def test_step9_smoke_defaults() -> None:
    result = run_step9_smoke(steps=16, seed=0)
    assert result.finite
    assert result.steps == 16
    assert result.real_td_errors_shape == (16,)
    assert result.dream_td_errors_shape == (16, 1)


def test_step9_smoke_config_roundtrip() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=3,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        control=Step6DifferentialSARSAConfig(n_actions=2),
        planning_budget=3,
        dreaming_warmup_steps=4,
        dreaming_max_model_error=1e30,
    )
    result = run_step9_smoke(cfg, steps=8, seed=42)
    assert result.finite
    assert result.dream_td_errors_shape == (8, 3)


def test_step9_smoke_zero_steps_raises() -> None:
    with pytest.raises(ValueError, match="steps must be positive"):
        run_step9_smoke(steps=0)


def test_step9_smoke_linear_model() -> None:
    """Linear (hidden_sizes=()) world model should work identically."""
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=2,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
    )
    result = run_step9_smoke(cfg, steps=8, seed=1)
    assert result.finite


def test_step9_smoke_larger_config() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=6,
        n_actions=4,
        model_hidden_sizes=(32, 32),
        model_step_size=0.01,
        model_sparsity=0.5,
        planning_budget=2,
        buffer_capacity=32,
        dreaming_warmup_steps=2,
        dreaming_max_model_error=1e30,
        control=Step6DifferentialSARSAConfig(
            n_actions=4,
            q_step_size=0.03,
            average_reward_step_size=0.005,
        ),
    )
    result = run_step9_smoke(cfg, steps=16, seed=99)
    assert result.finite


# ---------------------------------------------------------------------------
# Buffer interaction tests
# ---------------------------------------------------------------------------


def test_step9_buffer_grows_after_updates() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=0,
        buffer_capacity=8,
    )
    agent, model, buffer = make_step9_components(cfg)
    state = init_step9_state(
        agent, model, buffer,
        key=jr.key(10),
        initial_observation=jnp.zeros(2),
    )
    initial_size = int(state.buffer_state.size)
    for i in range(4):
        result = step9_update(
            cfg, agent, model, buffer, state,
            jnp.array(float(i)),
            jr.normal(jr.key(i + 100), (2,)),
        )
        state = result.state
    assert int(state.buffer_state.size) > initial_size


# ---------------------------------------------------------------------------
# State finitenesss across many steps
# ---------------------------------------------------------------------------


def test_step9_state_stays_finite_over_many_steps() -> None:
    cfg = Step9DreamingConfig(
        observation_dim=2,
        n_actions=2,
        model_hidden_sizes=(),
        model_sparsity=0.0,
        planning_budget=2,
        dreaming_warmup_steps=0,
        dreaming_max_model_error=1e30,
    )
    result = run_step9_smoke(cfg, steps=128, seed=7)
    assert result.finite
