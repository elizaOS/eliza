# mypy: disable-error-code="call-arg"
"""Tests for reusable prototype basis blocks."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.prototype_basis import (
    PrototypeBasisBlock,
    PrototypeBasisConfig,
    PrototypeBasisState,
    run_prototype_basis_arrays,
)


def _select_center_slot_like_existing(
    block: PrototypeBasisBlock,
    state: PrototypeBasisState,
    observation: Array,
) -> tuple[Array, Array]:
    used = state.counts > 0.0
    has_used = jnp.any(used)
    has_empty = jnp.any(~used)
    distances = jnp.mean((state.centers - observation[None, :]) ** 2, axis=1)
    used_distances = jnp.where(used, distances, jnp.inf)
    nearest_slot = jnp.argmin(used_distances)
    nearest_distance = used_distances[nearest_slot]
    empty_slot = jnp.argmax((~used).astype(jnp.int32))
    min_count = jnp.min(state.counts)
    tied = state.counts <= (min_count + 1e-6)
    oldest = jnp.where(tied, state.last_update, jnp.array(2_147_483_647, dtype=jnp.int32))
    replacement_slot = jnp.argmin(oldest)
    novel = (~has_used) | (
        nearest_distance > jnp.asarray(block.config.novelty_threshold, dtype=jnp.float32)
    )
    slot = jnp.where(
        ~has_used,
        jnp.array(0, dtype=nearest_slot.dtype),
        jnp.where(
            novel & has_empty,
            empty_slot,
            jnp.where(novel, replacement_slot, nearest_slot),
        ),
    )
    return slot, novel


def test_prototype_basis_init_shapes() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(input_dim=3, output_dim=2, n_prototypes=5)
    )
    params, state = block.init(jr.key(0))

    chex.assert_shape(params.values, (5, 2))
    chex.assert_shape(params.bias, (2,))
    chex.assert_shape(state.centers, (5, 3))
    chex.assert_shape(state.bandwidths, (5,))
    chex.assert_tree_all_finite((params, state))


def test_empty_basis_predicts_zero() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(input_dim=2, output_dim=3, n_prototypes=4)
    )
    params, state = block.init()

    prediction = block.predict(params, state, jnp.ones(2, dtype=jnp.float32))
    chex.assert_trees_all_close(prediction, jnp.zeros(3, dtype=jnp.float32))


def test_repeated_update_reduces_error_after_center_exists() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(
            input_dim=2,
            output_dim=1,
            n_prototypes=4,
            step_size=0.1,
            novelty_threshold=0.5,
            bandwidth=0.2,
        )
    )
    params, state = block.init()
    observation = jnp.asarray([0.25, -0.5], dtype=jnp.float32)
    target = jnp.asarray([1.0], dtype=jnp.float32)
    initial_error = abs(float(target[0] - block.predict(params, state, observation)[0]))

    for _ in range(20):
        result = block.update(params, state, observation, target)
        params, state = result.params, result.state

    final_error = abs(float(target[0] - block.predict(params, state, observation)[0]))
    assert final_error < initial_error
    assert int(jnp.sum(state.counts > 0.0)) == 1


def test_adaptive_bandwidth_changes_on_matched_updates() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(
            input_dim=2,
            output_dim=1,
            n_prototypes=2,
            novelty_threshold=2.0,
            bandwidth=1.0,
            adaptive_bandwidth=True,
            bandwidth_update_rate=0.5,
        )
    )
    params, state = block.init()
    target = jnp.asarray([0.0], dtype=jnp.float32)
    state = block.update(
        params,
        state,
        jnp.asarray([0.0, 0.0], dtype=jnp.float32),
        target,
    ).state
    before = float(state.bandwidths[0])
    state = block.update(
        params,
        state,
        jnp.asarray([0.25, 0.0], dtype=jnp.float32),
        target,
    ).state
    after = float(state.bandwidths[0])
    assert after != before


def test_update_centers_with_slot_matches_separate_slot_and_update() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(
            input_dim=2,
            output_dim=1,
            n_prototypes=3,
            update_rate=0.5,
            novelty_threshold=0.05,
            bandwidth=0.25,
            adaptive_bandwidth=True,
            bandwidth_update_rate=0.5,
        )
    )
    _, state = block.init()
    observations = jnp.asarray(
        [
            [0.0, 0.0],
            [0.1, 0.0],
            [1.0, 1.0],
            [2.0, 2.0],
            [-1.0, -1.0],
        ],
        dtype=jnp.float32,
    )

    for observation in observations:
        expected_slot, expected_novel = _select_center_slot_like_existing(
            block,
            state,
            observation,
        )
        expected_state, expected_metrics = block.update_centers(state, observation)
        fused_state, fused_metrics, fused_slot, fused_novel = block.update_centers_with_slot(
            state,
            observation,
        )

        chex.assert_trees_all_close(fused_state, expected_state)
        chex.assert_trees_all_close(fused_metrics, expected_metrics)
        assert int(fused_slot) == int(expected_slot)
        assert bool(fused_novel) == bool(expected_novel)
        state = expected_state


def test_update_centers_with_slot_scan_matches_current_output() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(
            input_dim=3,
            output_dim=1,
            n_prototypes=4,
            update_rate=0.25,
            novelty_threshold=0.08,
            bandwidth=0.2,
            adaptive_bandwidth=True,
            bandwidth_update_rate=0.3,
        )
    )
    _, state = block.init()
    observations = jnp.asarray(
        [
            [0.0, 0.0, 0.0],
            [0.1, 0.0, 0.0],
            [0.4, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.15, 0.0, 0.05],
            [-1.0, -1.0, -1.0],
            [2.0, 2.0, 2.0],
        ],
        dtype=jnp.float32,
    )

    @jax.jit
    def run_separate(
        initial_state: PrototypeBasisState,
    ) -> tuple[PrototypeBasisState, tuple[Array, Array, Array]]:
        def step(
            carry: PrototypeBasisState,
            observation: Array,
        ) -> tuple[PrototypeBasisState, tuple[Array, Array, Array]]:
            slot, novel = _select_center_slot_like_existing(block, carry, observation)
            new_state, metrics = block.update_centers(carry, observation)
            return new_state, (metrics, slot, novel)

        return jax.lax.scan(step, initial_state, observations)

    @jax.jit
    def run_fused(
        initial_state: PrototypeBasisState,
    ) -> tuple[PrototypeBasisState, tuple[Array, Array, Array]]:
        def step(
            carry: PrototypeBasisState,
            observation: Array,
        ) -> tuple[PrototypeBasisState, tuple[Array, Array, Array]]:
            new_state, metrics, slot, novel = block.update_centers_with_slot(
                carry,
                observation,
            )
            return new_state, (metrics, slot, novel)

        return jax.lax.scan(step, initial_state, observations)

    expected_state, (expected_metrics, expected_slots, expected_novel) = run_separate(state)
    fused_state, (fused_metrics, fused_slots, fused_novel) = run_fused(state)

    chex.assert_trees_all_close(fused_state, expected_state)
    chex.assert_trees_all_close(fused_metrics, expected_metrics)
    chex.assert_trees_all_equal(fused_slots, expected_slots)
    chex.assert_trees_all_equal(fused_novel, expected_novel)


def test_run_prototype_basis_arrays_returns_scan_outputs() -> None:
    block = PrototypeBasisBlock(
        PrototypeBasisConfig(input_dim=2, output_dim=2, n_prototypes=3)
    )
    observations = jnp.asarray(
        [[0.0, 0.0], [1.0, 1.0], [0.1, 0.0]],
        dtype=jnp.float32,
    )
    targets = jnp.asarray(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]],
        dtype=jnp.float32,
    )

    result = run_prototype_basis_arrays(block, observations, targets, key=jr.key(1))

    chex.assert_shape(result.predictions, (3, 2))
    chex.assert_shape(result.activations, (3, 3))
    chex.assert_shape(result.metrics, (3, 6))
    assert int(result.state.step_count) == 3
    chex.assert_tree_all_finite(result)


def test_config_roundtrip() -> None:
    config = PrototypeBasisConfig(
        input_dim=5,
        output_dim=4,
        n_prototypes=7,
        adaptive_bandwidth=True,
    )
    block = PrototypeBasisBlock(config)
    assert PrototypeBasisConfig.from_config(config.to_config()) == config
    assert PrototypeBasisBlock.from_config(block.to_config()).config == config
