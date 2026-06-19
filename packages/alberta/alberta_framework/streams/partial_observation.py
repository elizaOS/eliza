"""Partial-observation stream wrapper for POMDP testbeds (Step 3 Phase D).

Wraps any ``ScanStream`` so that a configurable subset of observation
channels is masked at each step. Useful for testing whether agents can
recover the missing information from history (e.g. via
``HistoryFeatureExtractor`` in ``core/history_features.py``).

Three masking modes are supported:
    - ``MaskMode.FIXED``: same channels are masked every step.
    - ``MaskMode.RANDOM``: each step samples an i.i.d. random mask with
      Bernoulli probability ``mask_prob`` per channel.
    - ``MaskMode.PERIODIC``: the mask cycles through a hand-specified
      schedule of mask vectors with period ``len(schedule)``.

The wrapped TimeStep retains the SAME ``feature_dim`` -- masked positions
are replaced with a sentinel value (default 0.0). The ``target`` is
unchanged. This means the agent's job is unchanged dimensionally; it
just receives less information about the underlying state.
"""

from __future__ import annotations

import enum
from typing import TypeVar

import chex
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Bool, PRNGKeyArray

from alberta_framework.core.types import TimeStep
from alberta_framework.streams.base import ScanStream

InnerStateT = TypeVar("InnerStateT")


# =============================================================================
# Modes
# =============================================================================


class MaskMode(enum.Enum):
    """Channel-masking mode for ``PartialObservationWrapper``."""

    FIXED = "fixed"
    RANDOM = "random"
    PERIODIC = "periodic"


# =============================================================================
# State
# =============================================================================


@chex.dataclass(frozen=True)
class PartialObservationState[InnerStateT]:
    """State for the partial-observation wrapper.

    Attributes:
        inner_state: The wrapped stream's state.
        key: JAX random key used by ``MaskMode.RANDOM``.
        period_index: Step counter modulo schedule length for
            ``MaskMode.PERIODIC``.
    """

    inner_state: InnerStateT
    key: PRNGKeyArray
    period_index: Array


# =============================================================================
# Wrapper
# =============================================================================


class PartialObservationWrapper[InnerStateT]:
    """ScanStream wrapper that masks observation channels.

    Args:
        inner: The underlying ``ScanStream`` whose observations will be
            partially masked.
        mode: Masking mode (FIXED / RANDOM / PERIODIC).
        fixed_mask: Boolean mask of shape ``(feature_dim,)`` for FIXED.
            ``True`` means VISIBLE; ``False`` means HIDDEN.
        mask_prob: Per-channel KEEP probability for RANDOM. So
            ``mask_prob = 0.5`` keeps half the channels each step in
            expectation.
        schedule: Tuple of boolean masks of shape ``(feature_dim,)``;
            cycled each step under PERIODIC mode.
        sentinel: Value that replaces masked entries (default ``0.0``).

    Examples
    --------
    ```python
    inner = RandomWalkStream(feature_dim=10, drift_rate=0.0)
    fixed = jnp.array([True] * 5 + [False] * 5)  # hide last 5 channels
    wrapper = PartialObservationWrapper(
        inner, mode=MaskMode.FIXED, fixed_mask=fixed
    )
    state = wrapper.init(jr.key(0))
    timestep, state = wrapper.step(state, jnp.array(0))
    # timestep.observation has zeros in positions 5..9
    ```
    """

    def __init__(
        self,
        inner: ScanStream[InnerStateT],
        mode: MaskMode = MaskMode.FIXED,
        fixed_mask: Bool[Array, " feature_dim"] | None = None,
        mask_prob: float = 0.5,
        schedule: tuple[Bool[Array, " feature_dim"], ...] | None = None,
        sentinel: float = 0.0,
    ):
        self._inner = inner
        self._mode = mode
        self._mask_prob = mask_prob
        self._sentinel = sentinel

        feature_dim = inner.feature_dim

        if mode == MaskMode.FIXED:
            if fixed_mask is None:
                raise ValueError("MaskMode.FIXED requires fixed_mask.")
            mask = jnp.asarray(fixed_mask, dtype=jnp.bool_)
            if mask.shape != (feature_dim,):
                raise ValueError(
                    f"fixed_mask shape {mask.shape} != (feature_dim={feature_dim},)"
                )
            self._fixed_mask: Array | None = mask
        else:
            self._fixed_mask = None

        if mode == MaskMode.PERIODIC:
            if schedule is None or len(schedule) == 0:
                raise ValueError(
                    "MaskMode.PERIODIC requires a non-empty schedule."
                )
            sched = jnp.stack([jnp.asarray(m, dtype=jnp.bool_) for m in schedule], axis=0)
            if sched.shape[1] != feature_dim:
                raise ValueError(
                    f"schedule masks must each have shape (feature_dim={feature_dim},)"
                )
            self._schedule: Array | None = sched
        else:
            self._schedule = None

        if mode == MaskMode.RANDOM:
            if not (0.0 <= mask_prob <= 1.0):
                raise ValueError(f"mask_prob must lie in [0, 1]; got {mask_prob}")

    @property
    def feature_dim(self) -> int:
        """Same as the wrapped stream."""
        return self._inner.feature_dim

    @property
    def mode(self) -> MaskMode:
        """Masking mode."""
        return self._mode

    def init(self, key: Array) -> PartialObservationState[InnerStateT]:
        """Initialize wrapper state."""
        k_inner, k_mask = jr.split(key)
        inner_state = self._inner.init(k_inner)
        return PartialObservationState(  # type: ignore[call-arg]
            inner_state=inner_state,
            key=k_mask,
            period_index=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self,
        state: PartialObservationState[InnerStateT],
        idx: Array,
    ) -> tuple[TimeStep, PartialObservationState[InnerStateT]]:
        """Step the wrapped stream and apply the channel mask."""
        timestep, new_inner = self._inner.step(state.inner_state, idx)

        new_key = state.key
        new_period_index = state.period_index

        if self._mode == MaskMode.FIXED:
            assert self._fixed_mask is not None
            mask = self._fixed_mask
        elif self._mode == MaskMode.RANDOM:
            new_key, k_use = jr.split(state.key)
            mask = jr.uniform(k_use, (self._inner.feature_dim,)) < self._mask_prob
        else:  # PERIODIC
            assert self._schedule is not None
            mask = self._schedule[state.period_index % self._schedule.shape[0]]
            new_period_index = state.period_index + 1

        masked_obs = jnp.where(
            mask,
            timestep.observation,
            jnp.full_like(timestep.observation, self._sentinel),
        )

        new_timestep = TimeStep(  # type: ignore[call-arg]
            observation=masked_obs,
            target=timestep.target,
        )
        new_state: PartialObservationState[InnerStateT] = PartialObservationState(
            inner_state=new_inner,
            key=new_key,
            period_index=new_period_index,
        )
        return new_timestep, new_state
