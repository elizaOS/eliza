# mypy: disable-error-code="call-arg,untyped-decorator"
"""Tests for causal temporal/context features."""

import chex
import jax
import jax.numpy as jnp

from alberta_framework.core.temporal_context import (
    TemporalContextConfig,
    TemporalContextFeaturizer,
    TemporalContextState,
    transform_temporal_context_arrays,
)


def test_temporal_context_shapes_and_roundtrip() -> None:
    config = TemporalContextConfig(input_dim=3, periods=(5.0, 10.0))
    featurizer = TemporalContextFeaturizer(config)
    state = featurizer.init()

    features = featurizer.features(state, jnp.ones(3))

    assert config.output_dim() == 13
    chex.assert_shape(features, (13,))
    chex.assert_tree_all_finite(features)
    assert TemporalContextConfig.from_config(config.to_config()) == config


def test_temporal_context_step_is_causal() -> None:
    config = TemporalContextConfig(input_dim=2, ema_decay=0.5, periods=())
    featurizer = TemporalContextFeaturizer(config)
    state = featurizer.init()
    observation = jnp.asarray([2.0, -2.0], dtype=jnp.float32)

    next_state, features = featurizer.step(state, observation)

    chex.assert_trees_all_close(features[:2], observation)
    chex.assert_trees_all_close(features[2:4], jnp.zeros(2))
    chex.assert_trees_all_close(features[4:6], observation)
    chex.assert_trees_all_close(next_state.observation_ema, observation * 0.5)
    assert int(next_state.step_count) == 1


def test_temporal_context_phase_products_expand_with_input() -> None:
    config = TemporalContextConfig(
        input_dim=2,
        include_phase_products=True,
        periods=(4.0,),
    )
    featurizer = TemporalContextFeaturizer(config)

    features = featurizer.features(featurizer.init(), jnp.asarray([3.0, -1.0]))

    assert config.output_dim() == 12
    chex.assert_shape(features, (12,))
    chex.assert_tree_all_finite(features)


def test_temporal_context_array_transform_is_jittable() -> None:
    config = TemporalContextConfig(input_dim=2, periods=(4.0,))
    featurizer = TemporalContextFeaturizer(config)
    observations = jnp.asarray([[1.0, 0.0], [0.0, 1.0]], dtype=jnp.float32)

    @jax.jit
    def run(initial_state: TemporalContextState):
        return transform_temporal_context_arrays(
            featurizer,
            observations,
            state=initial_state,
        )

    state, features = run(featurizer.init())

    chex.assert_shape(features, (2, config.output_dim()))
    assert int(state.step_count) == 2
    chex.assert_tree_all_finite(features)
