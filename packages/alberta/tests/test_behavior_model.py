"""Tests for the online behavior/action prediction model."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import chex
import jax
import jax.numpy as jnp

try:
    from alberta_framework.core.behavior_model import (
        BehaviorModel,
        BehaviorModelConfig,
        action_log_likelihoods,
        clipped_importance_ratios,
        epsilon_greedy_probabilities,
        floor_and_renormalize_probabilities,
        run_behavior_model_from_arrays,
        selected_action_probabilities,
    )
except ImportError:
    # Other in-flight Step 8/world-model lanes can temporarily break package
    # imports. Keep this focused behavior-model test runnable without touching
    # those files.
    module_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "alberta_framework"
        / "core"
        / "behavior_model.py"
    )
    spec = importlib.util.spec_from_file_location(
        "alberta_framework_behavior_model_under_test",
        module_path,
    )
    if spec is None or spec.loader is None:
        raise
    behavior_model_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(behavior_model_module)
    BehaviorModel = behavior_model_module.BehaviorModel
    BehaviorModelConfig = behavior_model_module.BehaviorModelConfig
    action_log_likelihoods = behavior_model_module.action_log_likelihoods
    clipped_importance_ratios = behavior_model_module.clipped_importance_ratios
    epsilon_greedy_probabilities = behavior_model_module.epsilon_greedy_probabilities
    floor_and_renormalize_probabilities = (
        behavior_model_module.floor_and_renormalize_probabilities
    )
    run_behavior_model_from_arrays = behavior_model_module.run_behavior_model_from_arrays
    selected_action_probabilities = behavior_model_module.selected_action_probabilities


def _assert_behavior_update_finite(result: Any) -> None:
    """Check numeric leaves while handling JAX typed PRNG keys explicitly."""
    chex.assert_tree_all_finite(
        (
            result.state.weights,
            result.state.bias,
            jax.random.key_data(result.state.rng_key),
            result.state.step_count,
            result.state.nll_ema,
            result.state.accuracy_ema,
            result.state.confidence_ema,
            result.logits,
            result.probabilities,
            result.action_probability,
            result.log_likelihood,
            result.loss,
            result.entropy,
            result.confidence,
            result.predicted_action,
            result.correct,
        )
    )


def test_init_predict_update_finite_and_shapes() -> None:
    model = BehaviorModel(BehaviorModelConfig(n_actions=3, step_size=0.1))
    state = model.init(feature_dim=4, key=jax.random.key(0))
    obs = jnp.array([1.0, -1.0, 0.5, 2.0], dtype=jnp.float32)

    logits = model.predict_logits(state, obs)
    probs = model.predict_probabilities(state, obs)
    result = model.update(state, obs, jnp.array(2, dtype=jnp.int32))

    chex.assert_shape(logits, (3,))
    chex.assert_shape(probs, (3,))
    chex.assert_shape(result.probabilities, (3,))
    chex.assert_shape(result.action_probability, ())
    _assert_behavior_update_finite(result)
    assert int(result.state.step_count) == 1
    assert float(result.loss) > 0.0


def test_probability_simplex_and_helper_invariants() -> None:
    model = BehaviorModel(BehaviorModelConfig(n_actions=4))
    state = model.init(feature_dim=2, key=jax.random.key(1))
    probs = model.predict_probabilities(
        state,
        jnp.array([10.0, -3.0], dtype=jnp.float32),
    )
    floored = floor_and_renormalize_probabilities(
        jnp.array([0.0, 0.2, 0.3, 0.5], dtype=jnp.float32),
        min_probability=0.01,
    )

    chex.assert_trees_all_close(jnp.sum(probs), 1.0, atol=1e-6)
    chex.assert_trees_all_close(jnp.sum(floored), 1.0, atol=1e-6)
    assert float(jnp.min(floored)) >= 0.01 - 1e-7

    selected = selected_action_probabilities(
        jnp.array([[0.2, 0.8], [0.9, 0.1]], dtype=jnp.float32),
        jnp.array([1, 0], dtype=jnp.int32),
    )
    logs = action_log_likelihoods(
        jnp.array([[0.2, 0.8], [0.9, 0.1]], dtype=jnp.float32),
        jnp.array([1, 0], dtype=jnp.int32),
    )
    chex.assert_trees_all_close(selected, jnp.array([0.8, 0.9], dtype=jnp.float32))
    chex.assert_trees_all_close(logs, jnp.log(selected))


def test_likelihood_improves_on_deterministic_policy_stream() -> None:
    model = BehaviorModel(
        BehaviorModelConfig(n_actions=2, step_size=0.2, diagnostic_decay=0.9)
    )
    state = model.init(feature_dim=2, key=jax.random.key(2))
    obs0 = jnp.array([1.0, 0.0], dtype=jnp.float32)
    obs1 = jnp.array([0.0, 1.0], dtype=jnp.float32)

    start_p0 = model.action_probability(state, obs0, jnp.array(0, dtype=jnp.int32))
    start_p1 = model.action_probability(state, obs1, jnp.array(1, dtype=jnp.int32))
    for _ in range(160):
        state = model.update(state, obs0, jnp.array(0, dtype=jnp.int32)).state
        state = model.update(state, obs1, jnp.array(1, dtype=jnp.int32)).state

    end_p0 = model.action_probability(state, obs0, jnp.array(0, dtype=jnp.int32))
    end_p1 = model.action_probability(state, obs1, jnp.array(1, dtype=jnp.int32))

    assert float(end_p0) > float(start_p0) + 0.35
    assert float(end_p1) > float(start_p1) + 0.35
    assert float(end_p0) > 0.85
    assert float(end_p1) > 0.85
    assert float(state.accuracy_ema) > 0.85


def test_scan_loop_and_jit_compatibility() -> None:
    model = BehaviorModel(BehaviorModelConfig(n_actions=3, step_size=0.05))
    state = model.init(feature_dim=3, key=jax.random.key(3))
    observations = jnp.eye(3, dtype=jnp.float32).repeat(4, axis=0)
    actions = jnp.array([0, 1, 2] * 4, dtype=jnp.int32)

    jitted_update = jax.jit(model.update)
    update_result = jitted_update(state, observations[0], actions[0])
    result = run_behavior_model_from_arrays(
        model,
        state,
        observations,
        actions,
    )

    _assert_behavior_update_finite(update_result)
    chex.assert_shape(result.probabilities, (12, 3))
    chex.assert_shape(result.action_probabilities, (12,))
    chex.assert_shape(result.log_likelihoods, (12,))
    chex.assert_shape(result.correct, (12,))
    assert int(result.state.step_count) == 12


def test_config_roundtrip_and_sampling() -> None:
    model = BehaviorModel(
        BehaviorModelConfig(
            n_actions=3,
            step_size=0.03,
            temperature=0.8,
            l2_penalty=0.01,
            max_gradient_norm=1.5,
            min_probability=1e-5,
            ratio_clip=3.0,
            diagnostic_decay=0.8,
        )
    )
    restored = BehaviorModel.from_config(model.to_config())
    assert restored.to_config() == model.to_config()

    state = restored.init(feature_dim=2, key=jax.random.key(4))
    sample = restored.sample_action(state, jnp.ones(2, dtype=jnp.float32))
    chex.assert_shape(sample.probabilities, (3,))
    chex.assert_trees_all_close(jnp.sum(sample.probabilities), 1.0, atol=1e-6)
    assert 0 <= int(sample.action) < 3


def test_importance_ratio_and_epsilon_greedy_helpers() -> None:
    target = jnp.array([[0.8, 0.2], [0.1, 0.9]], dtype=jnp.float32)
    behavior = jnp.array([[0.4, 0.6], [0.5, 0.5]], dtype=jnp.float32)
    actions = jnp.array([0, 1], dtype=jnp.int32)

    ratios = clipped_importance_ratios(
        target,
        behavior,
        actions,
        clip=1.5,
    )
    chex.assert_trees_all_close(ratios, jnp.array([1.5, 1.5], dtype=jnp.float32))

    q_values = jnp.array([1.0, 3.0, 3.0, 0.0], dtype=jnp.float32)
    probs = epsilon_greedy_probabilities(q_values, jnp.array(0.2, dtype=jnp.float32))
    expected = jnp.array([0.05, 0.45, 0.45, 0.05], dtype=jnp.float32)
    chex.assert_trees_all_close(probs, expected, atol=1e-6)

    model = BehaviorModel(BehaviorModelConfig(n_actions=2, ratio_clip=1.25))
    state = model.init(feature_dim=2, key=jax.random.key(5))
    ratio = model.importance_ratio(
        state,
        jnp.ones(2, dtype=jnp.float32),
        jnp.array(1, dtype=jnp.int32),
        jnp.array([0.1, 0.9], dtype=jnp.float32),
    )
    assert float(ratio) == 1.25
