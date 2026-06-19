"""Synthetic non-stationary experience streams for testing continual learning.

These streams generate non-stationary supervised learning problems where
the target function changes over time, testing the learner's ability to
track and adapt.

All streams use JAX-compatible pure functions that work with jax.lax.scan.
"""

from typing import Any

import chex
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int, PRNGKeyArray

from alberta_framework.core.types import TimeStep
from alberta_framework.streams.base import ScanStream


@chex.dataclass(frozen=True)
class RandomWalkState:
    """State for RandomWalkStream.

    Attributes:
        key: JAX random key for generating randomness
        true_weights: Current true target weights
    """

    key: PRNGKeyArray
    true_weights: Float[Array, " feature_dim"]


class RandomWalkStream:
    """Non-stationary stream where target weights drift via random walk.

    The true target function is linear: `y* = w_true @ x + noise`
    where w_true evolves via random walk at each time step.

    This tests the learner's ability to continuously track a moving target.

    Attributes:
        feature_dim: Dimension of observation vectors
        drift_rate: Standard deviation of weight drift per step
        noise_std: Standard deviation of observation noise
        feature_std: Standard deviation of features
    """

    def __init__(
        self,
        feature_dim: int,
        drift_rate: float = 0.001,
        noise_std: float = 0.1,
        feature_std: float = 1.0,
    ):
        """Initialize the random walk target stream.

        Args:
            feature_dim: Dimension of the feature/observation vectors
            drift_rate: Std dev of weight changes per step (controls non-stationarity)
            noise_std: Std dev of target noise
            feature_std: Std dev of feature values
        """
        self._feature_dim = feature_dim
        self._drift_rate = drift_rate
        self._noise_std = noise_std
        self._feature_std = feature_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    def init(self, key: Array) -> RandomWalkState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state with random weights
        """
        key, subkey = jr.split(key)
        weights = jr.normal(subkey, (self._feature_dim,), dtype=jnp.float32)
        return RandomWalkState(key=key, true_weights=weights)

    def step(self, state: RandomWalkState, idx: Array) -> tuple[TimeStep, RandomWalkState]:
        """Generate one time step.

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, k_drift, k_x, k_noise = jr.split(state.key, 4)

        # Drift weights
        drift = jr.normal(k_drift, state.true_weights.shape, dtype=jnp.float32)
        new_weights = state.true_weights + self._drift_rate * drift

        # Generate observation and target
        x = self._feature_std * jr.normal(k_x, (self._feature_dim,), dtype=jnp.float32)
        noise = self._noise_std * jr.normal(k_noise, (), dtype=jnp.float32)
        target = jnp.dot(new_weights, x) + noise

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = RandomWalkState(key=key, true_weights=new_weights)

        return timestep, new_state


@chex.dataclass(frozen=True)
class HiddenStateAR2State:
    """State for :class:`HiddenStateAR2Stream`."""

    key: PRNGKeyArray
    x_prev: Float[Array, " feature_dim"]
    x_prev2: Float[Array, " feature_dim"]


class HiddenStateAR2Stream:
    """Stationary AR(2) stream with partially observable hidden channels.

    The emitted observation contains the full AR state so downstream feature
    construction can decide what to mask. The target includes visible linear
    terms plus a hidden interaction, making the hidden channels behaviorally
    relevant for Step 3 feature-discovery probes.
    """

    def __init__(
        self,
        feature_dim: int,
        visible_dim: int = 2,
        phi1: float = 0.6,
        phi2: float = -0.2,
        innovation_std: float = 0.2,
        nonlinear_coeff: float = 0.5,
        target_noise_std: float = 0.01,
    ):
        """Initialize the AR(2) stream."""
        if visible_dim <= 0 or visible_dim >= feature_dim:
            raise ValueError("visible_dim must be in [1, feature_dim)")
        if feature_dim - visible_dim < 2:
            raise ValueError("hidden block must contain at least two channels")
        deterministic_copy = phi1 == 1.0 and phi2 == 0.0 and innovation_std == 0.0
        violates_stationarity = (
            phi1 + phi2 >= 1.0 or phi2 - phi1 >= 1.0 or abs(phi2) >= 1.0
        )
        if violates_stationarity and not deterministic_copy:
            raise ValueError("AR(2) coefficients violate the stationarity triangle")
        self._feature_dim = feature_dim
        self._visible_dim = visible_dim
        self._phi1 = phi1
        self._phi2 = phi2
        self._innovation_std = innovation_std
        self._nonlinear_coeff = nonlinear_coeff
        self._target_noise_std = target_noise_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    @property
    def visible_dim(self) -> int:
        """Return the number of visible channels."""
        return self._visible_dim

    def init(self, key: Array) -> HiddenStateAR2State:
        """Initialize AR state."""
        key, k1, k2 = jr.split(key, 3)
        x_prev = jr.normal(k1, (self._feature_dim,), dtype=jnp.float32)
        x_prev2 = jr.normal(k2, (self._feature_dim,), dtype=jnp.float32)
        return HiddenStateAR2State(key=key, x_prev=x_prev, x_prev2=x_prev2)

    def step(
        self,
        state: HiddenStateAR2State,
        idx: Array,
    ) -> tuple[TimeStep, HiddenStateAR2State]:
        """Generate one AR(2) sample."""
        del idx
        key, k_innov, k_noise = jr.split(state.key, 3)
        innovation = self._innovation_std * jr.normal(
            k_innov,
            (self._feature_dim,),
            dtype=jnp.float32,
        )
        x_t = self._phi1 * state.x_prev + self._phi2 * state.x_prev2 + innovation
        visible_term = jnp.sum(x_t[: self._visible_dim])
        h0 = x_t[self._visible_dim]
        h1 = x_t[self._visible_dim + 1]
        hidden_term = self._nonlinear_coeff * h0 * h1
        noise = self._target_noise_std * jr.normal(k_noise, (), dtype=jnp.float32)
        target = visible_term + hidden_term + noise
        timestep = TimeStep(observation=x_t, target=jnp.atleast_1d(target))
        new_state = HiddenStateAR2State(
            key=key,
            x_prev=x_t,
            x_prev2=state.x_prev,
        )
        return timestep, new_state


@chex.dataclass(frozen=True)
class AbruptChangeState:
    """State for AbruptChangeStream.

    Attributes:
        key: JAX random key for generating randomness
        true_weights: Current true target weights
        step_count: Number of steps taken
    """

    key: PRNGKeyArray
    true_weights: Float[Array, " feature_dim"]
    step_count: Int[Array, ""]


class AbruptChangeStream:
    """Non-stationary stream with sudden target weight changes.

    Target weights remain constant for a period, then abruptly change
    to new random values. Tests the learner's ability to detect and
    rapidly adapt to distribution shifts.

    Attributes:
        feature_dim: Dimension of observation vectors
        change_interval: Number of steps between weight changes
        noise_std: Standard deviation of observation noise
        feature_std: Standard deviation of features
    """

    def __init__(
        self,
        feature_dim: int,
        change_interval: int = 1000,
        noise_std: float = 0.1,
        feature_std: float = 1.0,
    ):
        """Initialize the abrupt change stream.

        Args:
            feature_dim: Dimension of feature vectors
            change_interval: Steps between abrupt weight changes
            noise_std: Std dev of target noise
            feature_std: Std dev of feature values
        """
        self._feature_dim = feature_dim
        self._change_interval = change_interval
        self._noise_std = noise_std
        self._feature_std = feature_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    def init(self, key: Array) -> AbruptChangeState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state
        """
        key, subkey = jr.split(key)
        weights = jr.normal(subkey, (self._feature_dim,), dtype=jnp.float32)
        return AbruptChangeState(
            key=key,
            true_weights=weights,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(self, state: AbruptChangeState, idx: Array) -> tuple[TimeStep, AbruptChangeState]:
        """Generate one time step.

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, key_weights, key_x, key_noise = jr.split(state.key, 4)

        # Determine if we should change weights
        should_change = state.step_count % self._change_interval == 0

        # Generate new weights (always generated but only used if should_change)
        new_random_weights = jr.normal(key_weights, (self._feature_dim,), dtype=jnp.float32)

        # Use jnp.where to conditionally update weights (JIT-compatible)
        new_weights = jnp.where(should_change, new_random_weights, state.true_weights)

        # Generate observation
        x = self._feature_std * jr.normal(key_x, (self._feature_dim,), dtype=jnp.float32)

        # Compute target
        noise = self._noise_std * jr.normal(key_noise, (), dtype=jnp.float32)
        target = jnp.dot(new_weights, x) + noise

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = AbruptChangeState(
            key=key,
            true_weights=new_weights,
            step_count=state.step_count + 1,
        )

        return timestep, new_state


@chex.dataclass(frozen=True)
class SuttonExperiment1State:
    """State for SuttonExperiment1Stream.

    Attributes:
        key: JAX random key for generating randomness
        signs: Signs (+1/-1) for the relevant inputs
        step_count: Number of steps taken
    """

    key: PRNGKeyArray
    signs: Float[Array, " num_relevant"]
    wt_irr: Float[Array, " num_irrelevant"]
    step_count: Int[Array, ""]


class SuttonExperiment1Stream:
    """Non-stationary stream replicating Experiment 1 from Sutton 1992.

    This stream implements the exact task from Sutton's IDBD paper:
    - 20 real-valued inputs drawn from N(0, 1)
    - Only first 5 inputs are relevant (weights are ±1)
    - Last 15 inputs are irrelevant (weights are 0)
    - Every change_interval steps, one of the 5 relevant signs is flipped

    Reference: Sutton, R.S. (1992). "Adapting Bias by Gradient Descent:
    An Incremental Version of Delta-Bar-Delta"

    Attributes:
        num_relevant: Number of relevant inputs (default 5)
        num_irrelevant: Number of irrelevant inputs (default 15)
        change_interval: Steps between sign changes (default 20)
    """

    def __init__(
        self,
        num_relevant: int = 5,
        num_irrelevant: int = 15,
        change_interval: int = 20,
        noise_std: float = 0.0,
        bias_drift_rate: float = 0.0,
    ):
        """Initialize the Sutton Experiment 1 stream.

        Args:
            num_relevant: Number of relevant inputs with ±1 weights
            num_irrelevant: Number of irrelevant inputs with 0 weights
            change_interval: Number of steps between sign flips
        """
        self._num_relevant = num_relevant
        self._num_irrelevant = num_irrelevant
        self._change_interval = change_interval
        self._noise_std = noise_std
        self._bias_drift_rate = bias_drift_rate

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._num_relevant + self._num_irrelevant

    def init(self, key: Array) -> SuttonExperiment1State:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state with all +1 signs
        """
        signs = jnp.ones(self._num_relevant, dtype=jnp.float32)
        return SuttonExperiment1State(
            key=key,
            signs=signs,
            wt_irr=jnp.zeros(self._num_irrelevant, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self, state: SuttonExperiment1State, idx: Array
    ) -> tuple[TimeStep, SuttonExperiment1State]:
        """Generate one time step.

        At each step:
        1. If at a change interval (and not step 0), flip one random sign
        2. Generate random inputs from N(0, 1)
        3. Compute target as sum of relevant inputs weighted by signs

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, key_x, key_which, key_irr, key_noise = jr.split(state.key, 5)

        # Determine if we should flip a sign (not at step 0)
        should_flip = (state.step_count > 0) & (state.step_count % self._change_interval == 0)

        # Select which sign to flip
        idx_to_flip = jr.randint(key_which, (), 0, self._num_relevant)

        # Create flip mask
        flip_mask = jnp.where(
            jnp.arange(self._num_relevant) == idx_to_flip,
            jnp.array(-1.0, dtype=jnp.float32),
            jnp.array(1.0, dtype=jnp.float32),
        )

        # Apply flip mask conditionally
        new_signs = jnp.where(should_flip, state.signs * flip_mask, state.signs)
        wt_irr = state.wt_irr + self._bias_drift_rate * jr.normal(
            key_irr,
            (self._num_irrelevant,),
            dtype=jnp.float32,
        )

        # Generate observation from N(0, 1)
        x = jr.normal(key_x, (self.feature_dim,), dtype=jnp.float32)

        # Compute target: sum of first num_relevant inputs weighted by signs
        target = jnp.dot(new_signs, x[: self._num_relevant])
        target = target + jnp.dot(wt_irr, x[self._num_relevant :])
        target = target + self._noise_std * jr.normal(key_noise, (), dtype=jnp.float32)

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = SuttonExperiment1State(
            key=key,
            signs=new_signs,
            wt_irr=wt_irr,
            step_count=state.step_count + 1,
        )

        return timestep, new_state


@chex.dataclass(frozen=True)
class CyclicState:
    """State for CyclicStream.

    Attributes:
        key: JAX random key for generating randomness
        configurations: Pre-generated weight configurations
        step_count: Number of steps taken
    """

    key: PRNGKeyArray
    configurations: Float[Array, "num_configs feature_dim"]
    step_count: Int[Array, ""]


class CyclicStream:
    """Non-stationary stream that cycles between known weight configurations.

    Weights cycle through a fixed set of configurations. Tests whether
    the learner can re-adapt quickly to previously seen targets.

    Attributes:
        feature_dim: Dimension of observation vectors
        cycle_length: Number of steps per configuration before switching
        num_configurations: Number of weight configurations to cycle through
        noise_std: Standard deviation of observation noise
        feature_std: Standard deviation of features
    """

    def __init__(
        self,
        feature_dim: int,
        cycle_length: int = 500,
        num_configurations: int = 4,
        noise_std: float = 0.1,
        feature_std: float = 1.0,
    ):
        """Initialize the cyclic target stream.

        Args:
            feature_dim: Dimension of feature vectors
            cycle_length: Steps spent in each configuration
            num_configurations: Number of configurations to cycle through
            noise_std: Std dev of target noise
            feature_std: Std dev of feature values
        """
        self._feature_dim = feature_dim
        self._cycle_length = cycle_length
        self._num_configurations = num_configurations
        self._noise_std = noise_std
        self._feature_std = feature_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    def init(self, key: Array) -> CyclicState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state with pre-generated configurations
        """
        key, key_configs = jr.split(key)
        configurations = jr.normal(
            key_configs,
            (self._num_configurations, self._feature_dim),
            dtype=jnp.float32,
        )
        return CyclicState(
            key=key,
            configurations=configurations,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(self, state: CyclicState, idx: Array) -> tuple[TimeStep, CyclicState]:
        """Generate one time step.

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, key_x, key_noise = jr.split(state.key, 3)

        # Get current configuration index
        config_idx = (state.step_count // self._cycle_length) % self._num_configurations
        true_weights = state.configurations[config_idx]

        # Generate observation
        x = self._feature_std * jr.normal(key_x, (self._feature_dim,), dtype=jnp.float32)

        # Compute target
        noise = self._noise_std * jr.normal(key_noise, (), dtype=jnp.float32)
        target = jnp.dot(true_weights, x) + noise

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = CyclicState(
            key=key,
            configurations=state.configurations,
            step_count=state.step_count + 1,
        )

        return timestep, new_state


@chex.dataclass(frozen=True)
class PeriodicChangeState:
    """State for PeriodicChangeStream.

    Attributes:
        key: JAX random key for generating randomness
        base_weights: Base target weights (center of oscillation)
        phases: Per-weight phase offsets
        step_count: Number of steps taken
    """

    key: PRNGKeyArray
    base_weights: Float[Array, " feature_dim"]
    phases: Float[Array, " feature_dim"]
    step_count: Int[Array, ""]


class PeriodicChangeStream:
    """Non-stationary stream where target weights oscillate sinusoidally.

    Target weights follow: w(t) = base + amplitude * sin(2π * t / period + phase)
    where each weight has a random phase offset for diversity.

    This tests the learner's ability to track predictable periodic changes,
    which is qualitatively different from random drift or abrupt changes.

    Attributes:
        feature_dim: Dimension of observation vectors
        period: Number of steps for one complete oscillation
        amplitude: Magnitude of weight oscillation
        noise_std: Standard deviation of observation noise
        feature_std: Standard deviation of features
    """

    def __init__(
        self,
        feature_dim: int,
        period: int = 1000,
        amplitude: float = 1.0,
        noise_std: float = 0.1,
        feature_std: float = 1.0,
    ):
        """Initialize the periodic change stream.

        Args:
            feature_dim: Dimension of feature vectors
            period: Steps for one complete oscillation cycle
            amplitude: Magnitude of weight oscillations around base
            noise_std: Std dev of target noise
            feature_std: Std dev of feature values
        """
        self._feature_dim = feature_dim
        self._period = period
        self._amplitude = amplitude
        self._noise_std = noise_std
        self._feature_std = feature_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    def init(self, key: Array) -> PeriodicChangeState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state with random base weights and phases
        """
        key, key_weights, key_phases = jr.split(key, 3)
        base_weights = jr.normal(key_weights, (self._feature_dim,), dtype=jnp.float32)
        # Random phases in [0, 2π) for each weight
        phases = jr.uniform(key_phases, (self._feature_dim,), minval=0.0, maxval=2.0 * jnp.pi)
        return PeriodicChangeState(
            key=key,
            base_weights=base_weights,
            phases=phases,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(self, state: PeriodicChangeState, idx: Array) -> tuple[TimeStep, PeriodicChangeState]:
        """Generate one time step.

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, key_x, key_noise = jr.split(state.key, 3)

        # Compute oscillating weights: w(t) = base + amplitude * sin(2π * t / period + phase)
        t = state.step_count.astype(jnp.float32)
        oscillation = self._amplitude * jnp.sin(2.0 * jnp.pi * t / self._period + state.phases)
        true_weights = state.base_weights + oscillation

        # Generate observation
        x = self._feature_std * jr.normal(key_x, (self._feature_dim,), dtype=jnp.float32)

        # Compute target
        noise = self._noise_std * jr.normal(key_noise, (), dtype=jnp.float32)
        target = jnp.dot(true_weights, x) + noise

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = PeriodicChangeState(
            key=key,
            base_weights=state.base_weights,
            phases=state.phases,
            step_count=state.step_count + 1,
        )

        return timestep, new_state


@chex.dataclass(frozen=True)
class ScaledStreamState:
    """State for ScaledStreamWrapper.

    Attributes:
        inner_state: State of the wrapped stream
    """

    inner_state: tuple[Any, ...]  # Generic state from wrapped stream


class ScaledStreamWrapper:
    """Wrapper that applies per-feature scaling to any stream's observations.

    This wrapper multiplies each feature of the observation by a corresponding
    scale factor. Useful for testing how learners handle features at different
    scales, which is important for understanding normalization benefits.

    Examples
    --------
    ```python
    stream = ScaledStreamWrapper(
        AbruptChangeStream(feature_dim=10, change_interval=1000),
        feature_scales=jnp.array([0.001, 0.01, 0.1, 1.0, 10.0,
                                  100.0, 1000.0, 0.001, 0.01, 0.1])
    )
    ```

    Attributes:
        inner_stream: The wrapped stream instance
        feature_scales: Per-feature scale factors (must match feature_dim)
    """

    def __init__(self, inner_stream: ScanStream[Any], feature_scales: Array):
        """Initialize the scaled stream wrapper.

        Args:
            inner_stream: Stream to wrap (must implement ScanStream protocol)
            feature_scales: Array of scale factors, one per feature. Must have
                shape (feature_dim,) matching the inner stream's feature_dim.

        Raises:
            ValueError: If feature_scales length doesn't match inner stream's feature_dim
        """
        self._inner_stream: ScanStream[Any] = inner_stream
        self._feature_scales = jnp.asarray(feature_scales, dtype=jnp.float32)

        if self._feature_scales.shape[0] != inner_stream.feature_dim:
            raise ValueError(
                f"feature_scales length ({self._feature_scales.shape[0]}) "
                f"must match inner stream's feature_dim ({inner_stream.feature_dim})"
            )

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return int(self._inner_stream.feature_dim)

    @property
    def inner_stream(self) -> ScanStream[Any]:
        """Return the wrapped stream."""
        return self._inner_stream

    @property
    def feature_scales(self) -> Array:
        """Return the per-feature scale factors."""
        return self._feature_scales

    def init(self, key: Array) -> ScaledStreamState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state wrapping the inner stream's state
        """
        inner_state = self._inner_stream.init(key)
        return ScaledStreamState(inner_state=inner_state)

    def step(self, state: ScaledStreamState, idx: Array) -> tuple[TimeStep, ScaledStreamState]:
        """Generate one time step with scaled observations.

        Args:
            state: Current stream state
            idx: Current step index

        Returns:
            Tuple of (timestep with scaled observation, new_state)
        """
        timestep, new_inner_state = self._inner_stream.step(state.inner_state, idx)

        # Scale the observation
        scaled_observation = timestep.observation * self._feature_scales

        scaled_timestep = TimeStep(
            observation=scaled_observation,
            target=timestep.target,
        )

        new_state = ScaledStreamState(inner_state=new_inner_state)
        return scaled_timestep, new_state


def make_scale_range(
    feature_dim: int,
    min_scale: float = 0.001,
    max_scale: float = 1000.0,
    log_spaced: bool = True,
) -> Array:
    """Create a per-feature scale array spanning a range.

    Utility function to generate scale factors for ScaledStreamWrapper.

    Args:
        feature_dim: Number of features
        min_scale: Minimum scale factor
        max_scale: Maximum scale factor
        log_spaced: If True, scales are logarithmically spaced (default).
            If False, scales are linearly spaced.

    Returns:
        Array of shape (feature_dim,) with scale factors

    Examples
    --------
    ```python
    scales = make_scale_range(10, min_scale=0.01, max_scale=100.0)
    stream = ScaledStreamWrapper(RandomWalkStream(10), scales)
    ```
    """
    if log_spaced:
        return jnp.logspace(
            jnp.log10(min_scale),
            jnp.log10(max_scale),
            feature_dim,
            dtype=jnp.float32,
        )
    else:
        return jnp.linspace(min_scale, max_scale, feature_dim, dtype=jnp.float32)


@chex.dataclass(frozen=True)
class DynamicScaleShiftState:
    """State for DynamicScaleShiftStream.

    Attributes:
        key: JAX random key for generating randomness
        true_weights: Current true target weights
        current_scales: Current per-feature scaling factors
        step_count: Number of steps taken
    """

    key: PRNGKeyArray
    true_weights: Float[Array, " feature_dim"]
    current_scales: Float[Array, " feature_dim"]
    step_count: Int[Array, ""]


class DynamicScaleShiftStream:
    """Non-stationary stream with abruptly changing feature scales.

    Both target weights AND feature scales change at specified intervals.
    This tests whether OnlineNormalizer can track scale shifts faster
    than Autostep's internal v_i adaptation.

    The target is computed from unscaled features to maintain consistent
    difficulty across scale changes (only the feature representation changes,
    not the underlying prediction task).

    Attributes:
        feature_dim: Dimension of observation vectors
        scale_change_interval: Steps between scale changes
        weight_change_interval: Steps between weight changes
        min_scale: Minimum scale factor
        max_scale: Maximum scale factor
        noise_std: Standard deviation of observation noise
    """

    def __init__(
        self,
        feature_dim: int,
        scale_change_interval: int = 2000,
        weight_change_interval: int = 1000,
        min_scale: float = 0.01,
        max_scale: float = 100.0,
        noise_std: float = 0.1,
    ):
        """Initialize the dynamic scale shift stream.

        Args:
            feature_dim: Dimension of feature vectors
            scale_change_interval: Steps between abrupt scale changes
            weight_change_interval: Steps between abrupt weight changes
            min_scale: Minimum scale factor (log-uniform sampling)
            max_scale: Maximum scale factor (log-uniform sampling)
            noise_std: Std dev of target noise
        """
        self._feature_dim = feature_dim
        self._scale_change_interval = scale_change_interval
        self._weight_change_interval = weight_change_interval
        self._min_scale = min_scale
        self._max_scale = max_scale
        self._noise_std = noise_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    def init(self, key: Array) -> DynamicScaleShiftState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state with random weights and scales
        """
        key, k_weights, k_scales = jr.split(key, 3)
        weights = jr.normal(k_weights, (self._feature_dim,), dtype=jnp.float32)
        # Initial scales: log-uniform between min and max
        log_scales = jr.uniform(
            k_scales,
            (self._feature_dim,),
            minval=jnp.log(self._min_scale),
            maxval=jnp.log(self._max_scale),
        )
        scales = jnp.exp(log_scales).astype(jnp.float32)
        return DynamicScaleShiftState(
            key=key,
            true_weights=weights,
            current_scales=scales,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self, state: DynamicScaleShiftState, idx: Array
    ) -> tuple[TimeStep, DynamicScaleShiftState]:
        """Generate one time step.

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, k_weights, k_scales, k_x, k_noise = jr.split(state.key, 5)

        # Check if scales should change
        should_change_scales = state.step_count % self._scale_change_interval == 0
        new_log_scales = jr.uniform(
            k_scales,
            (self._feature_dim,),
            minval=jnp.log(self._min_scale),
            maxval=jnp.log(self._max_scale),
        )
        new_random_scales = jnp.exp(new_log_scales).astype(jnp.float32)
        new_scales = jnp.where(should_change_scales, new_random_scales, state.current_scales)

        # Check if weights should change
        should_change_weights = state.step_count % self._weight_change_interval == 0
        new_random_weights = jr.normal(k_weights, (self._feature_dim,), dtype=jnp.float32)
        new_weights = jnp.where(should_change_weights, new_random_weights, state.true_weights)

        # Generate raw features (unscaled)
        raw_x = jr.normal(k_x, (self._feature_dim,), dtype=jnp.float32)

        # Apply scaling to observation
        x = raw_x * new_scales

        # Target from true weights using RAW features (for consistent difficulty)
        noise = self._noise_std * jr.normal(k_noise, (), dtype=jnp.float32)
        target = jnp.dot(new_weights, raw_x) + noise

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = DynamicScaleShiftState(
            key=key,
            true_weights=new_weights,
            current_scales=new_scales,
            step_count=state.step_count + 1,
        )
        return timestep, new_state


@chex.dataclass(frozen=True)
class ScaleDriftState:
    """State for ScaleDriftStream.

    Attributes:
        key: JAX random key for generating randomness
        true_weights: Current true target weights
        log_scales: Current log-scale factors (random walk on log-scale)
        step_count: Number of steps taken
    """

    key: PRNGKeyArray
    true_weights: Float[Array, " feature_dim"]
    log_scales: Float[Array, " feature_dim"]
    step_count: Int[Array, ""]


class ScaleDriftStream:
    """Non-stationary stream where feature scales drift via random walk.

    Both target weights and feature scales drift continuously. Weights drift
    in linear space while scales drift in log-space (bounded random walk).
    This tests continuous scale tracking where OnlineNormalizer's EMA
    may adapt differently than Autostep's v_i.

    The target is computed from unscaled features to maintain consistent
    difficulty across scale changes.

    Attributes:
        feature_dim: Dimension of observation vectors
        weight_drift_rate: Std dev of weight drift per step
        scale_drift_rate: Std dev of log-scale drift per step
        min_log_scale: Minimum log-scale (clips random walk)
        max_log_scale: Maximum log-scale (clips random walk)
        noise_std: Standard deviation of observation noise
    """

    def __init__(
        self,
        feature_dim: int,
        weight_drift_rate: float = 0.001,
        scale_drift_rate: float = 0.01,
        min_log_scale: float = -4.0,  # exp(-4) ~ 0.018
        max_log_scale: float = 4.0,  # exp(4) ~ 54.6
        noise_std: float = 0.1,
    ):
        """Initialize the scale drift stream.

        Args:
            feature_dim: Dimension of feature vectors
            weight_drift_rate: Std dev of weight drift per step
            scale_drift_rate: Std dev of log-scale drift per step
            min_log_scale: Minimum log-scale (clips drift)
            max_log_scale: Maximum log-scale (clips drift)
            noise_std: Std dev of target noise
        """
        self._feature_dim = feature_dim
        self._weight_drift_rate = weight_drift_rate
        self._scale_drift_rate = scale_drift_rate
        self._min_log_scale = min_log_scale
        self._max_log_scale = max_log_scale
        self._noise_std = noise_std

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        return self._feature_dim

    def init(self, key: Array) -> ScaleDriftState:
        """Initialize stream state.

        Args:
            key: JAX random key

        Returns:
            Initial stream state with random weights and unit scales
        """
        key, k_weights = jr.split(key)
        weights = jr.normal(k_weights, (self._feature_dim,), dtype=jnp.float32)
        # Initial log-scales at 0 (scale = 1)
        log_scales = jnp.zeros(self._feature_dim, dtype=jnp.float32)
        return ScaleDriftState(
            key=key,
            true_weights=weights,
            log_scales=log_scales,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(self, state: ScaleDriftState, idx: Array) -> tuple[TimeStep, ScaleDriftState]:
        """Generate one time step.

        Args:
            state: Current stream state
            idx: Current step index (unused)

        Returns:
            Tuple of (timestep, new_state)
        """
        del idx  # unused
        key, k_w_drift, k_s_drift, k_x, k_noise = jr.split(state.key, 5)

        # Drift target weights
        weight_drift = self._weight_drift_rate * jr.normal(
            k_w_drift, (self._feature_dim,), dtype=jnp.float32
        )
        new_weights = state.true_weights + weight_drift

        # Drift log-scales (bounded random walk)
        scale_drift = self._scale_drift_rate * jr.normal(
            k_s_drift, (self._feature_dim,), dtype=jnp.float32
        )
        new_log_scales = state.log_scales + scale_drift
        new_log_scales = jnp.clip(new_log_scales, self._min_log_scale, self._max_log_scale)

        # Generate raw features (unscaled)
        raw_x = jr.normal(k_x, (self._feature_dim,), dtype=jnp.float32)

        # Apply scaling to observation
        scales = jnp.exp(new_log_scales)
        x = raw_x * scales

        # Target from true weights using RAW features
        noise = self._noise_std * jr.normal(k_noise, (), dtype=jnp.float32)
        target = jnp.dot(new_weights, raw_x) + noise

        timestep = TimeStep(observation=x, target=jnp.atleast_1d(target))
        new_state = ScaleDriftState(
            key=key,
            true_weights=new_weights,
            log_scales=new_log_scales,
            step_count=state.step_count + 1,
        )
        return timestep, new_state


# Backward-compatible aliases
RandomWalkTarget = RandomWalkStream
AbruptChangeTarget = AbruptChangeStream
CyclicTarget = CyclicStream
PeriodicChangeTarget = PeriodicChangeStream
