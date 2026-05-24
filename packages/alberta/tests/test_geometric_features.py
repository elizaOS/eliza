"""Tests for the Step 2 budgeted geometric feature learner."""

from __future__ import annotations

import jax.numpy as jnp
import jax.random as jr
import numpy as np

from alberta_framework.core.geometric_features import (
    BudgetedGeometricFeatureLearner,
    run_geometric_feature_arrays,
)


def test_feature_shape_and_no_nans() -> None:
    learner = BudgetedGeometricFeatureLearner(n_centers=3, n_tasks=2)
    state = learner.init(feature_dim=4, key=jr.key(0))
    obs = jnp.asarray([0.5, -1.0, 0.25, 2.0], dtype=jnp.float32)

    feats = learner.features(state, obs)
    pred = learner.predict(state, obs)

    assert feats.shape == (10,)
    assert pred.shape == (2,)
    assert bool(jnp.all(jnp.isfinite(feats)))
    assert bool(jnp.all(jnp.isfinite(pred)))


def test_center_insertion_and_replacement() -> None:
    learner = BudgetedGeometricFeatureLearner(
        n_centers=2,
        n_tasks=1,
        residual_threshold=0.0,
        novelty_threshold=0.1,
        min_center_age=0,
        imprint_scale=0.0,
    )
    state = learner.init(feature_dim=2, key=jr.key(0))

    samples = [
        jnp.asarray([0.0, 0.0], dtype=jnp.float32),
        jnp.asarray([4.0, 0.0], dtype=jnp.float32),
        jnp.asarray([0.0, 4.0], dtype=jnp.float32),
    ]
    target = jnp.asarray([1.0], dtype=jnp.float32)
    slots: list[int] = []
    for obs in samples:
        result = learner.update(state, obs, target)
        state = result.state
        slots.append(int(result.inserted_slot))

    assert slots[0] == 0
    assert slots[1] == 1
    assert slots[2] in {0, 1}
    assert int(jnp.sum(state.active)) == 2
    assert bool(jnp.any(jnp.all(jnp.isclose(state.centers, samples[2]), axis=1)))


def test_deterministic_init_update() -> None:
    learner = BudgetedGeometricFeatureLearner(
        n_centers=4,
        n_tasks=2,
        residual_threshold=0.0,
        novelty_threshold=0.0,
    )
    obs = jnp.asarray([0.25, -0.5, 1.0], dtype=jnp.float32)
    target = jnp.asarray([1.0, -0.5], dtype=jnp.float32)
    state_a = learner.init(feature_dim=3, key=jr.key(7))
    state_b = learner.init(feature_dim=3, key=jr.key(7))

    result_a = learner.update(state_a, obs, target)
    result_b = learner.update(state_b, obs, target)

    np.testing.assert_allclose(result_a.metrics, result_b.metrics)
    np.testing.assert_allclose(result_a.state.centers, result_b.state.centers)
    np.testing.assert_allclose(
        result_a.state.output_weights, result_b.state.output_weights
    )


def test_config_roundtrip() -> None:
    learner = BudgetedGeometricFeatureLearner(
        n_centers=5,
        n_tasks=3,
        step_size_output=0.02,
        novelty_threshold=1.25,
        residual_threshold=0.5,
        use_obgd=False,
    )
    restored = BudgetedGeometricFeatureLearner.from_config(learner.to_config())
    assert restored.to_config() == learner.to_config()


def test_scan_run_remains_finite_with_nan_targets() -> None:
    learner = BudgetedGeometricFeatureLearner(n_centers=6, n_tasks=2)
    state = learner.init(feature_dim=3, key=jr.key(0))
    observations = jnp.asarray(
        [
            [0.0, 0.0, 1.0],
            [1.0, -1.0, 0.5],
            [2.0, 0.5, -1.0],
            [-1.0, 1.5, 0.25],
        ],
        dtype=jnp.float32,
    )
    targets = jnp.asarray(
        [[0.0, jnp.nan], [1.0, -1.0], [0.5, jnp.nan], [-0.25, 0.75]],
        dtype=jnp.float32,
    )

    result = run_geometric_feature_arrays(learner, state, observations, targets)

    assert result.metrics.shape == (4, 7)
    assert bool(jnp.all(jnp.isfinite(result.metrics)))
    assert bool(jnp.all(jnp.isfinite(result.state.output_weights)))
