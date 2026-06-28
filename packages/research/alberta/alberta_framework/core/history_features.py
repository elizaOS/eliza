"""History-feature extractor for recurrent state construction (Step 3 Phase D).

Implements decaying-trace ("EMA") features over observation channels --
the simplest form of memory needed for partially observable settings.

Sutton, Bowling, & Pilarski (2022, p.8) Step 3: features in Step 3 must
include "not just nonlinear combinations, but also incorporation of older
signals and traces." A history-feature bank with multiple decay rates is
the simplest realization of this idea.

Mathematically, for each observation channel ``i`` and each decay rate
``beta_k`` in ``decay_rates``, the trace feature is::

    h_{i,k}(t) = beta_k * h_{i,k}(t-1) + (1 - beta_k) * obs_i(t)

This is an EMA with timescale ``1 / (1 - beta_k)``, giving an effective
memory horizon. With several decay rates we get a multi-timescale view
of the recent observation history -- the kind of representation that
lets a Horde demon condition predictions on what happened in the past.

Pairs cleanly with ``streams/partial_observation.py``: a POMDP wrapper
masks part of the observation, and the agent recovers the missing
information by conditioning on history features.

Reference: Sutton & Tanner 2004 (Temporal-Difference Networks);
the multi-timescale trace idea is also central to Modayil et al. 2014
nexting work.
"""

from __future__ import annotations

import functools
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float

# =============================================================================
# Types
# =============================================================================


@chex.dataclass(frozen=True)
class HistoryFeatureState:
    """State for the history-feature extractor.

    Attributes:
        traces: Per-decay-rate, per-channel trace values, shape
            ``(n_decay_rates, n_channels)``.
    """

    traces: Float[Array, "n_decays n_channels"]


# =============================================================================
# Extractor
# =============================================================================


class HistoryFeatureExtractor:
    """Decaying-trace history-feature extractor.

    Given an observation ``obs`` of shape ``(raw_dim,)``, produces an
    augmented observation of shape ``(out_dim,)``::

        out_dim = (raw_dim if include_raw else 0)
                  + len(channels) * len(decay_rates)

    Channels chosen for tracing are ``range(raw_dim)`` by default, or
    a custom subset if ``channels`` is given. ``include_raw`` controls
    whether the raw observation is concatenated to the front (default True
    -- this is the "augmented_observation" pattern used by Step 2's
    ``FixedBudgetInteractionLearner``).

    JIT-compiled. Pure functional, no mutation.

    Examples
    --------
    ```python
    extractor = HistoryFeatureExtractor(
        raw_dim=4,
        decay_rates=(0.5, 0.9, 0.99),
    )
    state = extractor.init()
    obs = jnp.array([1.0, 0.0, -0.3, 0.7])
    aug, state = extractor.step(state, obs)
    # aug has shape (4 + 4*3,) = (16,)
    ```

    Attributes:
        raw_dim: Dimension of the raw observation
        decay_rates: Tuple of EMA decay rates beta_k in [0, 1)
        channels: Indices of observation channels to track
        include_raw: Whether the raw observation is concatenated to the front
    """

    def __init__(
        self,
        raw_dim: int,
        decay_rates: tuple[float, ...] = (0.5, 0.9, 0.99),
        channels: tuple[int, ...] | None = None,
        include_raw: bool = True,
    ):
        """Initialize the history-feature extractor.

        Args:
            raw_dim: Dimension of the raw observation vector
            decay_rates: EMA decay rates ``beta_k`` in ``[0, 1)``. Each rate
                yields one trace feature per selected channel.
            channels: Indices of observation channels to track. ``None``
                means all channels (``range(raw_dim)``).
            include_raw: If True (default), the raw observation is
                concatenated to the front of the augmented observation.
        """
        if any((b < 0.0) or (b >= 1.0) for b in decay_rates):
            raise ValueError(
                f"decay_rates must lie in [0, 1); got {decay_rates}"
            )
        if channels is None:
            channels = tuple(range(raw_dim))
        if any(c < 0 or c >= raw_dim for c in channels):
            raise ValueError(
                f"channels {channels} contains an index outside [0, {raw_dim})"
            )

        self._raw_dim = raw_dim
        self._decay_rates = decay_rates
        self._channels = channels
        self._include_raw = include_raw

    @property
    def raw_dim(self) -> int:
        """Dimension of the raw observation."""
        return self._raw_dim

    @property
    def decay_rates(self) -> tuple[float, ...]:
        """Tuple of EMA decay rates."""
        return self._decay_rates

    @property
    def channels(self) -> tuple[int, ...]:
        """Tracked observation-channel indices."""
        return self._channels

    @property
    def include_raw(self) -> bool:
        """Whether the raw observation is included in the augmented output."""
        return self._include_raw

    def feature_dim(self) -> int:
        """Dimension of the augmented observation."""
        out = len(self._channels) * len(self._decay_rates)
        if self._include_raw:
            out += self._raw_dim
        return out

    def init(self) -> HistoryFeatureState:
        """Initialize traces to zero."""
        traces = jnp.zeros(
            (len(self._decay_rates), len(self._channels)), dtype=jnp.float32
        )
        return HistoryFeatureState(traces=traces)  # type: ignore[call-arg]

    @functools.partial(jax.jit, static_argnums=(0,))
    def step(
        self,
        state: HistoryFeatureState,
        observation: Float[Array, " raw_dim"],
    ) -> tuple[Float[Array, " out_dim"], HistoryFeatureState]:
        """Update traces and produce the augmented observation.

        Args:
            state: Current history-feature state
            observation: Raw observation, shape ``(raw_dim,)``

        Returns:
            Tuple ``(augmented, new_state)``:
            - ``augmented`` has shape ``(out_dim,)`` -- raw observation
              (if ``include_raw``) followed by the trace bank flattened
              channel-major within each decay rate
            - ``new_state`` carries the updated trace values
        """
        # Select tracked channels
        channel_indices = jnp.asarray(self._channels, dtype=jnp.int32)
        obs_tracked = observation[channel_indices]  # shape (n_channels,)

        # EMA decay per trace row
        decay = jnp.asarray(self._decay_rates, dtype=jnp.float32)[:, None]
        new_traces = decay * state.traces + (1.0 - decay) * obs_tracked[None, :]

        # Flatten and concatenate
        flat_traces = new_traces.reshape(-1)
        if self._include_raw:
            augmented = jnp.concatenate([observation, flat_traces])
        else:
            augmented = flat_traces

        return augmented, HistoryFeatureState(traces=new_traces)  # type: ignore[call-arg]

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict."""
        return {
            "type": "HistoryFeatureExtractor",
            "raw_dim": self._raw_dim,
            "decay_rates": list(self._decay_rates),
            "channels": list(self._channels),
            "include_raw": self._include_raw,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> HistoryFeatureExtractor:
        """Reconstruct from config dict."""
        config = dict(config)
        config.pop("type", None)
        return cls(
            raw_dim=int(config["raw_dim"]),
            decay_rates=tuple(config["decay_rates"]),
            channels=tuple(config["channels"]) if config["channels"] is not None else None,
            include_raw=bool(config["include_raw"]),
        )
