# mypy: disable-error-code="call-arg,untyped-decorator"
"""Tests for the single UPGD plus prototype-memory Step 2 learner."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.upgd_memory import (
    UPGDMemoryConfig,
    UPGDMemoryLearner,
    UPGDMemoryState,
    run_upgd_memory_arrays,
)


def test_upgd_memory_init_predict_shapes() -> None:
    """Initial hybrid state should expose fixed prediction/metric shapes."""
    config = UPGDMemoryConfig(feature_dim=4, n_heads=3, hidden_sizes=(8,))
    learner = UPGDMemoryLearner(config)
    state = learner.init(jr.key(0))

    prediction = learner.predict(state, jnp.zeros(config.feature_dim))

    chex.assert_shape(prediction, (3,))
    chex.assert_tree_all_finite(prediction)
    chex.assert_tree_all_finite(state.memory_state)
    assert int(state.step_count) == 0
    assert learner.to_config()["type"] == "UPGDMemoryLearner"
    assert UPGDMemoryLearner.from_config(learner.to_config()).config == config


def test_upgd_memory_passes_head_plasticity_to_upgd() -> None:
    """Hybrid config should expose UPGD output-head plasticity controls."""
    config = UPGDMemoryConfig(
        feature_dim=4,
        n_heads=3,
        hidden_sizes=(8,),
        upgd_head_step_size_multiplier=2.0,
        upgd_head_bias_step_size_multiplier=3.0,
        upgd_head_loss_pressure_gate_ratio=1.2,
        upgd_head_loss_pressure_multiplier=1.5,
        upgd_head_loss_pressure_warmup_steps=7,
        upgd_head_repetition_multiplier=2.5,
        upgd_head_repetition_decay=0.8,
        upgd_head_repetition_delta_threshold=0.02,
        upgd_head_repetition_pressure_threshold=0.3,
        upgd_head_repetition_warmup_steps=5,
        target_trace_blend_scale=0.25,
        target_trace_pressure_threshold=0.4,
    )
    learner = UPGDMemoryLearner(config)
    upgd_config = learner.upgd.to_config()

    assert upgd_config["head_step_size_multiplier"] == 2.0
    assert upgd_config["head_bias_step_size_multiplier"] == 3.0
    assert upgd_config["head_loss_pressure_gate_ratio"] == 1.2
    assert upgd_config["head_loss_pressure_multiplier"] == 1.5
    assert upgd_config["head_loss_pressure_warmup_steps"] == 7
    assert upgd_config["head_repetition_multiplier"] == 2.5
    assert upgd_config["head_repetition_decay"] == 0.8
    assert upgd_config["head_repetition_delta_threshold"] == 0.02
    assert upgd_config["head_repetition_pressure_threshold"] == 0.3
    assert upgd_config["head_repetition_warmup_steps"] == 5
    assert UPGDMemoryConfig.from_config(config.to_config()) == config


def test_upgd_memory_target_trace_prior_is_causal() -> None:
    """Repeated targets should optionally bias prequential update predictions."""
    config = UPGDMemoryConfig(
        feature_dim=2,
        n_heads=2,
        hidden_sizes=(4,),
        target_trace_blend_scale=0.5,
        target_trace_pressure_threshold=0.0,
    )
    learner = UPGDMemoryLearner(config)
    state = learner.init(jr.key(10))
    target = jnp.asarray([0.0, 1.0], dtype=jnp.float32)
    observation = jnp.asarray([1.0, 0.0], dtype=jnp.float32)

    state = learner.update(state, observation, target).state
    state = learner.update(state, observation, target).state
    traced_prediction = learner.update(state, observation, target).predictions

    no_trace = UPGDMemoryLearner(
        UPGDMemoryConfig(
            feature_dim=2,
            n_heads=2,
            hidden_sizes=(4,),
            target_trace_blend_scale=0.0,
        )
    )
    no_trace_state = no_trace.init(jr.key(10))
    no_trace_state = no_trace.update(no_trace_state, observation, target).state
    no_trace_state = no_trace.update(no_trace_state, observation, target).state
    baseline_prediction = no_trace.update(
        no_trace_state,
        observation,
        target,
    ).predictions

    assert traced_prediction[1] > baseline_prediction[1]
    assert traced_prediction[1] > learner.predict(state, observation)[1]


def test_upgd_memory_updates_both_components() -> None:
    """One-hot targets should train UPGD and allocate memory slots."""
    config = UPGDMemoryConfig(
        feature_dim=2,
        n_heads=2,
        hidden_sizes=(4,),
        slots_per_class=2,
        memory_logit_step_size=0.1,
        target_trace_blend_scale=0.0,
    )
    learner = UPGDMemoryLearner(config)
    state = learner.init(jr.key(1))
    target = jnp.asarray([1.0, 0.0], dtype=jnp.float32)

    result = learner.update(state, jnp.asarray([1.0, -1.0], dtype=jnp.float32), target)

    chex.assert_shape(result.predictions, (2,))
    chex.assert_shape(result.metrics, (10,))
    assert int(result.state.step_count) == 1
    assert int(result.state.upgd_state.step_count) == 1
    assert int(result.state.memory_state.step_count) == 1
    assert int(jnp.sum(result.state.memory_state.counts > 0.0)) == 1
    assert float(result.metrics[0]) >= 0.0
    assert float(result.metrics[3]) == 0.0
    chex.assert_tree_all_finite(result.metrics)


def test_upgd_memory_scan_runner_is_jit_compatible() -> None:
    """Array runner should work under an outer JIT scan."""
    config = UPGDMemoryConfig(feature_dim=2, n_heads=2, hidden_sizes=(4,))
    learner = UPGDMemoryLearner(config)
    state = learner.init(jr.key(2))
    observations = jnp.asarray(
        [[1.0, 0.0], [0.9, 0.1], [-1.0, 0.0], [-0.9, 0.1]],
        dtype=jnp.float32,
    )
    targets = jnp.asarray(
        [[1.0, 0.0], [1.0, 0.0], [0.0, 1.0], [0.0, 1.0]],
        dtype=jnp.float32,
    )

    @jax.jit
    def run(initial_state: UPGDMemoryState):
        return run_upgd_memory_arrays(learner, initial_state, observations, targets)

    result = run(state)

    chex.assert_shape(result.predictions, (4, 2))
    chex.assert_shape(result.metrics, (4, 10))
    assert int(result.state.step_count) == 4
    assert int(jnp.sum(result.state.memory_state.counts > 0.0)) == 2
    chex.assert_tree_all_finite(result.metrics)


def test_upgd_memory_novelty_threshold_adapts() -> None:
    """Runtime novelty threshold should move from the initial value."""
    config = UPGDMemoryConfig(
        feature_dim=2,
        n_heads=2,
        hidden_sizes=(4,),
        slots_per_class=4,
        novelty_adaptation_rate=0.2,
        target_allocation_rate=0.0,
    )
    learner = UPGDMemoryLearner(config)
    state = learner.init(jr.key(3))
    target = jnp.asarray([1.0, 0.0], dtype=jnp.float32)

    for value in (0.0, 1.0, 2.0):
        state = learner.update(
            state,
            jnp.asarray([value, value], dtype=jnp.float32),
            target,
        ).state

    assert float(jnp.exp(state.novelty_log_threshold)) > config.initial_novelty_threshold
