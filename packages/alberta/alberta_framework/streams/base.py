"""Base protocol for experience streams.

Experience streams generate temporally-uniform experience for continual learning.
Every time step produces a new observation-target pair.

This module defines the ScanStream protocol for JAX scan-compatible streams.
All streams implement pure functions that can be JIT-compiled.
"""

from typing import Protocol, TypeVar

from jax import Array

from alberta_framework.core.types import TimeStep

# Type variable for stream state
StateT = TypeVar("StateT")


class ScanStream(Protocol[StateT]):
    """Protocol for JAX scan-compatible experience streams.

    Streams generate temporally-uniform experience for continual learning.
    Unlike iterator-based streams, ScanStream uses pure functions that
    can be compiled with JAX's JIT and used with jax.lax.scan.

    The stream should be non-stationary to test continual learning
    capabilities - the underlying target function changes over time.

    Type Parameters:
        StateT: The state type maintained by this stream

    Examples
    --------
    ```python
    stream = RandomWalkStream(feature_dim=10, drift_rate=0.001)
    key = jax.random.key(42)
    state = stream.init(key)
    timestep, new_state = stream.step(state, jnp.array(0))
    ```
    """

    @property
    def feature_dim(self) -> int:
        """Return the dimension of observation vectors."""
        ...

    def init(self, key: Array) -> StateT:
        """Initialize stream state.

        Args:
            key: JAX random key for initialization

        Returns:
            Initial stream state
        """
        ...

    def step(self, state: StateT, idx: Array) -> tuple[TimeStep, StateT]:
        """Generate one time step. Must be JIT-compatible.

        This is a pure function that takes the current state and step index,
        and returns a TimeStep along with the updated state. The step index
        can be used for time-dependent behavior but is often ignored.

        Args:
            state: Current stream state
            idx: Current step index (can be ignored for most streams)

        Returns:
            Tuple of (timestep, new_state)
        """
        ...
