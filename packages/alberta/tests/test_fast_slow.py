# mypy: disable-error-code="call-arg"
"""Tests for the Step 2 fast/slow core scaffold."""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.fast_slow import (
    FastSlowConfig,
    FastSlowLearner,
    FastSlowParams,
    FastSlowState,
    run_fast_slow_arrays,
)


def test_fast_slow_init_shapes() -> None:
    """Initial state should match configured dimensions."""
    config = FastSlowConfig(input_dim=4, output_dim=3, hidden_dim=8)
    learner = FastSlowLearner(config)
    state = learner.init(jr.key(0))

    chex.assert_shape(state.params.encoder_kernel, (4, 8))
    chex.assert_shape(state.params.slow_kernel, (8, 3))
    chex.assert_shape(state.params.fast_kernel, (8, 3))
    chex.assert_shape(state.params.gate_kernel, (8, 3))
    chex.assert_tree_all_finite(state)


def test_fast_slow_update_reduces_repeated_error() -> None:
    """Repeated online updates on one sample should move prediction toward target."""
    config = FastSlowConfig(
        input_dim=3,
        output_dim=1,
        hidden_dim=16,
        encoder_step_size=0.0,
        slow_step_size=0.03,
        fast_step_size=0.08,
        gate_step_size=0.0,
        fast_decay=0.995,
    )
    learner = FastSlowLearner(config)
    state = learner.init(jr.key(1))
    observation = jnp.asarray([0.25, -0.5, 1.0], dtype=jnp.float32)
    target = jnp.asarray([1.0], dtype=jnp.float32)

    initial_error = jnp.abs(target - learner.predict(state, observation))[0]
    for _ in range(80):
        result = learner.update(state, observation, target)
        state = result.state
    final_error = jnp.abs(target - learner.predict(state, observation))[0]

    assert float(final_error) < float(initial_error)
    assert int(state.step_count) == 80


def test_fast_slow_gate_moves_toward_useful_fast_path() -> None:
    """When only the gate can learn, it should open toward a useful fast readout."""
    config = FastSlowConfig(
        input_dim=2,
        output_dim=1,
        hidden_dim=4,
        encoder_step_size=0.0,
        slow_step_size=0.0,
        fast_step_size=0.0,
        gate_step_size=0.5,
        fast_decay=1.0,
    )
    learner = FastSlowLearner(config)
    base_state = learner.init(jr.key(2))
    params = base_state.params
    state = FastSlowState(
        params=FastSlowParams(
            encoder_kernel=params.encoder_kernel,
            encoder_bias=params.encoder_bias,
            slow_kernel=params.slow_kernel,
            slow_bias=params.slow_bias,
            fast_kernel=jnp.ones_like(params.fast_kernel),
            fast_bias=jnp.asarray([0.0], dtype=jnp.float32),
            gate_kernel=params.gate_kernel,
            gate_bias=params.gate_bias,
        ),
        step_count=base_state.step_count,
    )
    observation = jnp.asarray([0.6, -0.3], dtype=jnp.float32)
    before = learner.predict_parts(state, observation).gate[0]
    fast_target = learner.predict_parts(state, observation).fast_prediction

    result = learner.update(state, observation, fast_target)
    after = learner.predict_parts(result.state, observation).gate[0]

    assert float(after) > float(before)


def test_run_fast_slow_arrays_returns_scan_metrics() -> None:
    """Array runner should use scan-compatible state and fixed-width metrics."""
    config = FastSlowConfig(input_dim=2, output_dim=1, hidden_dim=8)
    learner = FastSlowLearner(config)
    observations = jnp.asarray(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
        dtype=jnp.float32,
    )
    targets = jnp.asarray([[1.0], [-1.0], [0.5]], dtype=jnp.float32)

    result = run_fast_slow_arrays(
        learner,
        observations,
        targets,
        key=jr.key(3),
    )

    chex.assert_shape(result.metrics, (3, 6))
    assert int(result.state.step_count) == 3
    chex.assert_tree_all_finite(result)


def test_fast_slow_config_roundtrip() -> None:
    """Config serialization should be plain-data and reversible."""
    config = FastSlowConfig(
        input_dim=5,
        output_dim=2,
        hidden_dim=7,
        fast_decay=0.9,
        gate_l2=0.01,
    )
    restored = FastSlowConfig.from_config(config.to_config())

    assert restored == config
    learner = FastSlowLearner(restored)
    learner_config = FastSlowLearner.from_config(learner.to_config()).config
    assert learner_config == config
