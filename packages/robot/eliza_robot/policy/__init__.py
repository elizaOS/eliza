"""Policy backend abstraction + registry.

A *policy backend* takes a robot observation dict and returns an
`ActionChunk` describing what the robot should do next. Concrete backends
live in submodules (`eliza_robot.policy.openpi`, future RL/imitation
backends, etc.) and are constructed via `get_policy_backend(name, **kwargs)`.
"""

from eliza_robot.policy.base import ActionChunk, PolicyBackend
from eliza_robot.policy.dispatch import get_policy_backend

__all__ = [
    "ActionChunk",
    "PolicyBackend",
    "get_policy_backend",
]
