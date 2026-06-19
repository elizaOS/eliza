# mypy: disable-error-code="call-arg,untyped-decorator,no-any-return"
"""Tests for fixed-budget Step 2 prototype memory."""

import chex
import jax
import jax.numpy as jnp

from alberta_framework.core.prototype_memory import (
    PrototypeMemoryConfig,
    PrototypeMemoryLearner,
    PrototypeMemoryState,
    run_prototype_memory_arrays,
)


def test_prototype_memory_init_shapes() -> None:
    """Initial state should match configured budget."""
    config = PrototypeMemoryConfig(feature_dim=4, n_classes=3, slots_per_class=5)
    learner = PrototypeMemoryLearner(config)
    state = learner.init()

    chex.assert_shape(state.means, (3, 5, 4))
    chex.assert_shape(state.counts, (3, 5))
    chex.assert_shape(state.last_update, (3, 5))
    assert int(state.step_count) == 0
    chex.assert_tree_all_finite(state)


def test_empty_memory_predicts_uniformly() -> None:
    """With no prototypes, softmax logits should be neutral."""
    learner = PrototypeMemoryLearner(
        PrototypeMemoryConfig(feature_dim=2, n_classes=4, slots_per_class=2)
    )
    state = learner.init()
    prediction = learner.predict(state, jnp.asarray([1.0, -1.0], dtype=jnp.float32))

    chex.assert_trees_all_close(prediction, jnp.full((4,), 0.25, dtype=jnp.float32))


def test_repeated_update_moves_prediction_to_target_class() -> None:
    """A repeated class example should become confidently classified."""
    learner = PrototypeMemoryLearner(
        PrototypeMemoryConfig(
            feature_dim=2,
            n_classes=3,
            slots_per_class=2,
            novelty_threshold=0.5,
            bandwidth=0.05,
        )
    )
    state = learner.init()
    observation = jnp.asarray([0.25, 0.75], dtype=jnp.float32)
    target = jnp.asarray([0.0, 1.0, 0.0], dtype=jnp.float32)

    for _ in range(3):
        result = learner.update(state, observation, target)
        state = result.state

    prediction = learner.predict(state, observation)
    assert int(jnp.argmax(prediction)) == 1
    assert float(prediction[1]) > 0.95
    assert int(jnp.sum(state.counts > 0.0)) == 1


def test_novelty_allocates_multiple_prototypes_per_class() -> None:
    """Far examples with the same class should occupy different slots."""
    learner = PrototypeMemoryLearner(
        PrototypeMemoryConfig(
            feature_dim=2,
            n_classes=2,
            slots_per_class=3,
            novelty_threshold=0.01,
        )
    )
    state = learner.init()
    target = jnp.asarray([1.0, 0.0], dtype=jnp.float32)
    for observation in (
        jnp.asarray([0.0, 0.0], dtype=jnp.float32),
        jnp.asarray([1.0, 1.0], dtype=jnp.float32),
    ):
        state = learner.update(state, observation, target).state

    assert int(jnp.sum(state.counts[0] > 0.0)) == 2


def test_invalid_target_advances_time_without_allocating() -> None:
    """Non-simplex targets should not corrupt memory slots."""
    learner = PrototypeMemoryLearner(
        PrototypeMemoryConfig(feature_dim=2, n_classes=2, slots_per_class=2)
    )
    state = learner.init()
    result = learner.update(
        state,
        jnp.asarray([0.0, 1.0], dtype=jnp.float32),
        jnp.asarray([0.5, 0.5], dtype=jnp.float32),
    )

    assert int(result.state.step_count) == 1
    assert int(jnp.sum(result.state.counts > 0.0)) == 0
    assert float(result.metrics[4]) == 0.0


def test_run_prototype_memory_arrays_is_scan_compatible() -> None:
    """Array runner should return fixed-width predictions and metrics."""
    learner = PrototypeMemoryLearner(
        PrototypeMemoryConfig(feature_dim=2, n_classes=2, slots_per_class=2)
    )
    observations = jnp.asarray(
        [[0.0, 0.0], [1.0, 1.0], [0.1, 0.0]],
        dtype=jnp.float32,
    )
    targets = jnp.asarray(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]],
        dtype=jnp.float32,
    )

    result = run_prototype_memory_arrays(learner, observations, targets)

    chex.assert_shape(result.predictions, (3, 2))
    chex.assert_shape(result.metrics, (3, 6))
    assert int(result.state.step_count) == 3
    chex.assert_tree_all_finite(result)


def test_update_can_be_wrapped_by_jit() -> None:
    """Single-step update should work inside an outer JIT."""
    learner = PrototypeMemoryLearner(
        PrototypeMemoryConfig(feature_dim=2, n_classes=2, slots_per_class=2)
    )
    state = learner.init()
    observation = jnp.asarray([1.0, 0.0], dtype=jnp.float32)
    target = jnp.asarray([0.0, 1.0], dtype=jnp.float32)

    @jax.jit
    def update_once(inner_state: PrototypeMemoryState) -> PrototypeMemoryState:
        return learner.update(inner_state, observation, target).state

    updated = update_once(state)
    assert int(updated.step_count) == 1


def test_config_roundtrip() -> None:
    """Config serialization should be reversible."""
    config = PrototypeMemoryConfig(
        feature_dim=7,
        n_classes=5,
        slots_per_class=4,
        update_rate=0.25,
        novelty_threshold=0.2,
        bandwidth=0.03,
    )
    learner = PrototypeMemoryLearner(config)

    assert PrototypeMemoryConfig.from_config(config.to_config()) == config
    assert PrototypeMemoryLearner.from_config(learner.to_config()).config == config
