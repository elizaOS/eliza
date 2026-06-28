"""Production-facing Step 3 Horde helper tests."""

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.core.horde import run_horde_learning_loop
from alberta_framework.steps import (
    Step3HordeConfig,
    build_step2_to_step3_arrays,
    make_step3_horde,
    run_step3_smoke,
)


def test_step2_to_step3_arrays_shift_augmented_observations() -> None:
    raw = jnp.arange(12, dtype=jnp.float32).reshape(3, 4)
    constructed = jnp.asarray(
        [
            [0.0, 1.0],
            [2.0, 3.0],
            [4.0, 5.0],
        ],
        dtype=jnp.float32,
    )
    cumulants = jnp.asarray(
        [
            [1.0, 0.0],
            [0.5, 0.25],
            [0.0, 1.0],
        ],
        dtype=jnp.float32,
    )

    arrays = build_step2_to_step3_arrays(raw, constructed, cumulants)

    chex.assert_shape(arrays.observations, (3, 6))
    chex.assert_shape(arrays.cumulants, (3, 2))
    chex.assert_shape(arrays.next_observations, (3, 6))
    chex.assert_trees_all_close(
        arrays.observations[0],
        jnp.concatenate([raw[0], constructed[0]]),
    )
    chex.assert_trees_all_close(arrays.next_observations[0], arrays.observations[1])
    chex.assert_trees_all_close(arrays.next_observations[-1], arrays.observations[-1])
    assert arrays.feature_dim == 6
    assert arrays.n_demons == 2
    assert arrays.to_dict()["observations_shape"] == [3, 6]


def test_step3_horde_runs_on_handoff_arrays() -> None:
    raw = jnp.asarray(
        [
            [0.0, 1.0, 0.5],
            [0.2, 0.9, 0.4],
            [0.4, 0.7, 0.3],
            [0.6, 0.5, 0.2],
        ],
        dtype=jnp.float32,
    )
    constructed = jnp.stack([raw[:, 0] * raw[:, 1], raw[:, 1] * raw[:, 2]], axis=1)
    cumulants = jnp.stack([constructed[:, 0], raw[:, 0] + constructed[:, 1]], axis=1)
    arrays = build_step2_to_step3_arrays(raw, constructed, cumulants)

    config = Step3HordeConfig(
        gammas=(0.0, 0.5),
        lamdas=(0.0, 0.2),
        hidden_sizes=(),
        step_size=0.05,
    )
    horde = make_step3_horde(config)
    state = horde.init(arrays.feature_dim, jr.key(0))
    result = run_horde_learning_loop(
        horde,
        state,
        arrays.observations,
        arrays.cumulants,
        arrays.next_observations,
    )

    chex.assert_shape(result.per_demon_metrics, (4, 2, 3))
    chex.assert_shape(result.td_errors, (4, 2))
    chex.assert_tree_all_finite(result.per_demon_metrics)
    chex.assert_tree_all_finite(result.td_errors)
    assert horde.horde_spec.demons[1].gamma == 0.5
    assert horde.horde_spec.demons[1].lamda == 0.2
    assert horde.to_config()["type"] == "HordeLearner"


def test_step3_smoke_is_finite_and_serializable() -> None:
    config = Step3HordeConfig(
        gammas=(0.0, 0.9),
        lamdas=(0.0, 0.8),
        hidden_sizes=(),
        normalizer="ema",
    )
    result = run_step3_smoke(config, steps=16, final_window=4, seed=1)
    payload = result.to_dict()

    assert result.finite
    assert result.final_window_mse >= 0.0
    assert result.per_demon_metrics_shape == (16, 2, 3)
    assert result.td_errors_shape == (16, 2)
    assert payload["config"] == config.to_dict()
    handoff = payload["handoff"]
    horde_config = payload["horde_config"]
    assert isinstance(handoff, dict)
    assert isinstance(horde_config, dict)
    assert handoff["n_demons"] == 2
    assert horde_config["type"] == "HordeLearner"


def test_step3_config_validation() -> None:
    with pytest.raises(ValueError, match="same length"):
        make_step3_horde(Step3HordeConfig(gammas=(0.0, 0.9), lamdas=(0.0,)))

    raw = jnp.zeros((2, 3), dtype=jnp.float32)
    constructed = jnp.zeros((3, 1), dtype=jnp.float32)
    cumulants = jnp.zeros((2, 1), dtype=jnp.float32)
    with pytest.raises(ValueError, match="same number of rows"):
        build_step2_to_step3_arrays(raw, constructed, cumulants)

    with pytest.raises(ValueError, match="at least one demon"):
        build_step2_to_step3_arrays(
            raw,
            jnp.zeros((2, 0), dtype=jnp.float32),
            jnp.zeros((2, 0), dtype=jnp.float32),
        )

    with pytest.raises(ValueError, match="final_window"):
        run_step3_smoke(steps=4, final_window=8)
