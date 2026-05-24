"""Tests for the multi-timescale nexting evaluation harness."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import numpy as np

from alberta_framework.utils.nexting import (
    forward_view_returns,
    multi_channel_horizon_returns,
    multi_horizon_returns,
    per_horizon_rmse,
    per_horizon_running_rmse,
)


class TestForwardViewReturns:
    def test_gamma_zero_equals_next_cumulant(self) -> None:
        c = jnp.array([1.0, 2.0, 3.0, 4.0, 5.0])
        g = forward_view_returns(c, gamma=0.0)
        chex.assert_trees_all_close(g, c)

    def test_gamma_one_undiscounted(self) -> None:
        c = jnp.array([1.0, 2.0, 3.0, 4.0, 5.0])
        g = forward_view_returns(c, gamma=1.0)
        # Cumulative sum from the right
        expected = jnp.array([15.0, 14.0, 12.0, 9.0, 5.0])
        chex.assert_trees_all_close(g, expected)

    def test_gamma_half(self) -> None:
        c = jnp.array([1.0, 2.0, 4.0])
        # G_2 = 4
        # G_1 = 2 + 0.5 * 4 = 4
        # G_0 = 1 + 0.5 * 4 = 3
        expected = jnp.array([3.0, 4.0, 4.0])
        g = forward_view_returns(c, gamma=0.5)
        chex.assert_trees_all_close(g, expected, atol=1e-6)

    def test_terminal_value(self) -> None:
        c = jnp.array([0.0, 0.0, 1.0])
        # With terminal_value=10, gamma=1
        # G_2 = 1 + 1 * 10 = 11
        # G_1 = 0 + 1 * 11 = 11
        # G_0 = 0 + 1 * 11 = 11
        g = forward_view_returns(c, gamma=1.0, terminal_value=10.0)
        chex.assert_trees_all_close(g, jnp.array([11.0, 11.0, 11.0]))


class TestMultiHorizon:
    def test_shape(self) -> None:
        c = jnp.arange(10, dtype=jnp.float32)
        gammas = jnp.array([0.0, 0.5, 0.9, 0.99], dtype=jnp.float32)
        g = multi_horizon_returns(c, gammas)
        chex.assert_shape(g, (10, 4))

    def test_each_column_matches_single_call(self) -> None:
        c = jnp.array([1.0, -1.0, 0.5, 0.5, -0.5, 0.0])
        gammas = jnp.array([0.1, 0.5, 0.9])
        g_multi = multi_horizon_returns(c, gammas)

        for i, gv in enumerate([0.1, 0.5, 0.9]):
            g_single = forward_view_returns(c, gamma=gv)
            chex.assert_trees_all_close(g_multi[:, i], g_single, atol=1e-6)

    def test_zero_gamma_column(self) -> None:
        c = jnp.array([0.0, 1.0, 0.0, 2.0])
        gammas = jnp.array([0.0, 0.9])
        g = multi_horizon_returns(c, gammas)
        chex.assert_trees_all_close(g[:, 0], c)


class TestMultiChannel:
    def test_shape_and_values(self) -> None:
        cumulants = jnp.array(
            [
                [1.0, -1.0],
                [2.0, 0.0],
                [3.0, 1.0],
            ]
        )
        gammas = jnp.array([0.0, 0.5])
        g = multi_channel_horizon_returns(cumulants, gammas)
        chex.assert_shape(g, (3, 2, 2))  # (T, C, H)

        # Channel 0 at gamma=0
        chex.assert_trees_all_close(g[:, 0, 0], cumulants[:, 0])
        # Channel 1 at gamma=0
        chex.assert_trees_all_close(g[:, 1, 0], cumulants[:, 1])

    def test_cross_channel_independent(self) -> None:
        # Two channels with different cumulant patterns
        c1 = jnp.array([1.0, 0.0, 0.0])
        c2 = jnp.array([0.0, 0.0, 1.0])
        cumulants = jnp.stack([c1, c2], axis=1)
        gammas = jnp.array([0.9])
        g = multi_channel_horizon_returns(cumulants, gammas)

        # Channel 0: G_0 = 1 + 0.9*0 + 0.81*0 = 1; G_1 = 0; G_2 = 0
        chex.assert_trees_all_close(g[:, 0, 0], jnp.array([1.0, 0.0, 0.0]), atol=1e-6)
        # Channel 1: G_0 = 0 + 0.9*0 + 0.81*1 = 0.81; G_1 = 0.9; G_2 = 1
        chex.assert_trees_all_close(g[:, 1, 0], jnp.array([0.81, 0.9, 1.0]), atol=1e-6)


class TestRMSE:
    def test_zero_error_when_predictions_match(self) -> None:
        t, h = 50, 4
        truths = jnp.ones((t, h))
        rmse = per_horizon_rmse(truths, truths)
        chex.assert_trees_all_close(rmse, jnp.zeros(h), atol=1e-7)

    def test_constant_error(self) -> None:
        t, h = 100, 2
        preds = jnp.zeros((t, h))
        truths = jnp.ones((t, h)) * 3.0
        rmse = per_horizon_rmse(preds, truths)
        chex.assert_trees_all_close(rmse, jnp.array([3.0, 3.0]), atol=1e-7)

    def test_burn_in(self) -> None:
        # Errors only in the first 5 steps; with burn-in=5, RMSE should be 0.
        t, h = 20, 1
        preds = jnp.zeros((t, h))
        truths = jnp.zeros((t, h)).at[:5].set(10.0)
        rmse_no_burn = per_horizon_rmse(preds, truths, burn_in=0)
        rmse_burn = per_horizon_rmse(preds, truths, burn_in=5)
        assert float(rmse_no_burn[0]) > 0.0
        chex.assert_trees_all_close(rmse_burn, jnp.zeros(h), atol=1e-6)


class TestRunningRMSE:
    def test_shape(self) -> None:
        t, h = 50, 3
        preds = jnp.zeros((t, h))
        truths = jnp.ones((t, h))
        running = per_horizon_running_rmse(preds, truths, window_size=10)
        chex.assert_shape(running, (t, h))

    def test_constant_error(self) -> None:
        t, h = 30, 2
        preds = jnp.zeros((t, h))
        truths = jnp.ones((t, h)) * 2.0
        running = per_horizon_running_rmse(preds, truths, window_size=5)
        # All windows should contain the same constant error
        np.testing.assert_allclose(np.asarray(running), 2.0, atol=1e-6)

    def test_decay(self) -> None:
        # First half big errors, second half no errors. Running RMSE
        # should drop in the second half.
        t = 40
        h = 1
        preds = jnp.zeros((t, h))
        truths = jnp.zeros((t, h)).at[:20].set(5.0)
        running = per_horizon_running_rmse(preds, truths, window_size=5)
        # End of series: window contains only zero-error steps
        assert float(running[-1, 0]) < 0.01
        # Mid-series transition: some error
        assert float(running[19, 0]) > 0.5
