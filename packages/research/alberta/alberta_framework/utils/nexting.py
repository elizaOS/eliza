"""Multi-timescale nexting evaluation harness for GVF Horde predictions.

Implements the "nexting" evaluation protocol of Modayil, White, Sutton (2014),
"Multi-timescale nexting in a reinforcement learning robot": predict each
cumulant channel at multiple discount factors gamma, and compare each
prediction at time t against the empirical forward-view return computed
from the actual trajectory.

The empirical forward-view return for cumulant c with discount gamma is::

    G_t = sum_{k=0..} gamma^k * c_{t+k+1}

For finite trajectories this is computed by reverse-cumulative-sum::

    G_T = c_T
    G_t = c_{t+1} + gamma * G_{t+1}     for t < T

This module provides:
- ``forward_view_returns`` : compute G_t for a cumulant series at a fixed gamma
- ``multi_horizon_returns`` : compute G_t at several gammas in one pass
- ``per_horizon_rmse`` : aggregate per-step prediction-vs-return errors

These are the gold-standard targets that any temporal GVF prediction
algorithm should track. The harness is JAX-compatible so it can be used
inside scan loops or compared against scan-collected predictions.

References:
    Modayil, J., White, A., & Sutton, R.S. (2014).
    Multi-timescale nexting in a reinforcement learning robot.
    Adaptive Behavior 22(2), pp. 146-160.
"""

from __future__ import annotations

import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


def forward_view_returns(
    cumulants: Float[Array, " T"],
    gamma: float | Float[Array, ""],
    terminal_value: float = 0.0,
) -> Float[Array, " T"]:
    """Compute the forward-view return G_t for each step of a cumulant series.

    Uses the recursion ``G_t = c_{t+1} + gamma * G_{t+1}`` with terminal
    condition ``G_T = terminal_value`` (default 0). Implemented via
    ``jax.lax.scan`` over reversed indices for JIT efficiency.

    Args:
        cumulants: 1-D series of cumulants with length ``T`` -- the
            cumulant emitted at step ``t+1`` of a trajectory.
        gamma: Constant discount factor (or 0-D array).
        terminal_value: Value at the post-terminal step (default 0.0).

    Returns:
        Array of shape ``(T,)`` where index ``t`` is the forward-view
        return ``G_t = c_{t+1} + gamma * c_{t+2} + gamma^2 * c_{t+3} + ...``.
    """
    gamma_s = jnp.asarray(gamma, dtype=cumulants.dtype)
    init = jnp.asarray(terminal_value, dtype=cumulants.dtype)

    def step(carry: Array, c: Array) -> tuple[Array, Array]:
        new_carry = c + gamma_s * carry
        return new_carry, new_carry

    _, returns_reversed = jax.lax.scan(step, init, cumulants[::-1])
    return returns_reversed[::-1]


def multi_horizon_returns(
    cumulants: Float[Array, " T"],
    gammas: Float[Array, " H"],
    terminal_value: float = 0.0,
) -> Float[Array, "T H"]:
    """Compute forward-view returns for one cumulant at several discount factors.

    Equivalent to running ``forward_view_returns`` once per gamma but
    batched via ``jax.vmap``.

    Args:
        cumulants: 1-D series of cumulants, length ``T``.
        gammas: 1-D array of discount factors, length ``H``.
        terminal_value: Post-terminal G value (default 0.0).

    Returns:
        Array of shape ``(T, H)`` -- ``[t, h]`` is the forward-view return
        from step ``t`` at horizon ``gammas[h]``.
    """

    def per_gamma(g: Array) -> Array:
        return forward_view_returns(cumulants, g, terminal_value=terminal_value)

    return jax.vmap(per_gamma, out_axes=1)(gammas)


def multi_channel_horizon_returns(
    cumulants: Float[Array, "T C"],
    gammas: Float[Array, " H"],
    terminal_value: float = 0.0,
) -> Float[Array, "T C H"]:
    """Compute forward-view returns for ``C`` cumulant channels at ``H`` horizons.

    Args:
        cumulants: 2-D array of cumulants, shape ``(T, C)``.
        gammas: 1-D discount factors, shape ``(H,)``.
        terminal_value: Post-terminal G value (default 0.0).

    Returns:
        Array of shape ``(T, C, H)`` of forward-view returns.
    """
    # Vmap over channels: for each channel apply multi_horizon_returns
    def per_channel(c_series: Array) -> Array:
        return multi_horizon_returns(c_series, gammas, terminal_value=terminal_value)

    return jax.vmap(per_channel, in_axes=1, out_axes=1)(cumulants)


def per_horizon_rmse(
    predictions: Float[Array, "T H"],
    forward_returns: Float[Array, "T H"],
    burn_in: int = 0,
) -> Float[Array, " H"]:
    """Per-horizon root-mean-squared error of predictions vs forward-view returns.

    Args:
        predictions: Predictions over time at each horizon, shape ``(T, H)``.
        forward_returns: Ground-truth forward-view returns, shape ``(T, H)``.
        burn_in: Number of initial steps to skip (helps when the learner
            has not yet warmed up). Defaults to 0.

    Returns:
        Array of shape ``(H,)`` with RMSE per horizon.
    """
    if burn_in:
        predictions = predictions[burn_in:]
        forward_returns = forward_returns[burn_in:]
    sq_err = (predictions - forward_returns) ** 2
    return jnp.sqrt(jnp.mean(sq_err, axis=0))


def per_horizon_running_rmse(
    predictions: Float[Array, "T H"],
    forward_returns: Float[Array, "T H"],
    window_size: int = 100,
) -> Float[Array, "T H"]:
    """Per-horizon running RMSE over a sliding window.

    Useful for plotting how prediction accuracy evolves through a non-
    stationary stream (e.g. through Pavlovian phase transitions).

    Args:
        predictions: Shape ``(T, H)``.
        forward_returns: Shape ``(T, H)``.
        window_size: Length of the trailing average window.

    Returns:
        Array of shape ``(T, H)``. The first ``window_size - 1`` rows are
        equal to ``running_rmse[window_size - 1]``.
    """
    sq_err = (predictions - forward_returns) ** 2  # (T, H)
    cumsum = jnp.cumsum(jnp.concatenate([jnp.zeros((1, sq_err.shape[1])), sq_err]), axis=0)
    window = cumsum[window_size:] - cumsum[:-window_size]
    running = jnp.sqrt(window / window_size)
    pad = jnp.broadcast_to(running[0], (window_size - 1, sq_err.shape[1]))
    return jnp.concatenate([pad, running], axis=0)
