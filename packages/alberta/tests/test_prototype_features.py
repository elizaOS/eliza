"""Tests for causal prototype feature construction."""

import chex
import jax.numpy as jnp

from alberta_framework.core.prototype_features import PrototypeFeatureConstructor


def test_init_shapes_and_empty_features():
    constructor = PrototypeFeatureConstructor(n_classes=3)
    state = constructor.init(feature_dim=4)

    chex.assert_shape(state.prototypes, (3, 4))
    chex.assert_shape(state.counts, (3,))
    assert int(state.step_count) == 0

    features = constructor.features(state, jnp.ones(4))
    chex.assert_shape(features, (3,))
    chex.assert_trees_all_close(features, jnp.ones(3) / 3.0)


def test_simplex_update_changes_only_observed_class():
    constructor = PrototypeFeatureConstructor(n_classes=3, alpha=1.0)
    state = constructor.init(feature_dim=4)
    observation = jnp.array([1.0, 2.0, 0.0, 0.0], dtype=jnp.float32)
    target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

    updated = constructor.update(state, observation, target)

    assert float(updated.counts[1]) == 1.0
    assert float(jnp.sum(updated.counts)) == 1.0
    chex.assert_trees_all_close(
        updated.prototypes[1],
        observation / jnp.linalg.norm(observation),
    )
    chex.assert_trees_all_close(updated.prototypes[0], jnp.zeros(4))
    chex.assert_trees_all_close(updated.prototypes[2], jnp.zeros(4))


def test_non_simplex_target_skips_prototype_update():
    constructor = PrototypeFeatureConstructor(n_classes=3)
    state = constructor.init(feature_dim=2)
    target = jnp.array([0.5, 0.5, 0.5], dtype=jnp.float32)

    updated = constructor.update(state, jnp.ones(2), target)

    chex.assert_trees_all_close(updated.prototypes, state.prototypes)
    chex.assert_trees_all_close(updated.counts, state.counts)
    assert int(updated.step_count) == 1


def test_features_prefer_matching_seen_prototype():
    constructor = PrototypeFeatureConstructor(n_classes=2, alpha=1.0, temperature=0.05)
    state = constructor.init(feature_dim=2)
    state = constructor.update(
        state,
        jnp.array([1.0, 0.0], dtype=jnp.float32),
        jnp.array([1.0, 0.0], dtype=jnp.float32),
    )
    state = constructor.update(
        state,
        jnp.array([0.0, 1.0], dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
    )

    features = constructor.features(state, jnp.array([1.0, 0.0], dtype=jnp.float32))

    assert float(features[0]) > 0.99
    assert float(features[1]) < 0.01


def test_augment_appends_prototype_features():
    constructor = PrototypeFeatureConstructor(n_classes=2)
    state = constructor.init(feature_dim=3)

    augmented = constructor.augment(state, jnp.ones(3))

    chex.assert_shape(augmented, (5,))
