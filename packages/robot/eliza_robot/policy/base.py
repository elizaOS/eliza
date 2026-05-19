"""Base class + DTO for policy backends.

A `PolicyBackend` is a thin client wrapper that converts robot observation
dicts into action chunks. Concrete implementations live in
`eliza_robot.policy.<name>/` (e.g. `openpi/client.py`).

Action shape (`ActionChunk`) is deliberately backend-agnostic. Where a
backend produces additional details, it should pack them into `joints`,
`walk_command`, or `head_target` as appropriate so the bridge dispatcher
can route them without knowing which backend was used.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np


@dataclass(frozen=True)
class ActionChunk:
    """One inference output from a policy backend.

    Fields are optional so a backend can emit any combination of joint
    targets, locomotion command, or head pose. `confidence` and
    `latency_ms` are always set (defaulted) so consumers can log them.
    """

    joints: np.ndarray | None = None
    walk_command: dict[str, Any] | None = None
    head_target: dict[str, Any] | None = None
    confidence: float = 1.0
    latency_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dict (numpy arrays become lists)."""
        d = asdict(self)
        if self.joints is not None:
            d["joints"] = self.joints.tolist()
        return d


class PolicyBackend(ABC):
    """Abstract interface every policy backend implements.

    Lifecycle: `start(target_task)` -> repeated `step(observation)` ->
    `stop()`. `is_alive()` reports whether the backend is ready to take a
    `step`.
    """

    @abstractmethod
    def start(self, target_task: str) -> None:
        """Initialise the backend for a given task (language instruction)."""

    @abstractmethod
    def stop(self) -> None:
        """Release backend resources (sockets, processes, GPU memory)."""

    @abstractmethod
    def step(self, observation: dict[str, Any]) -> ActionChunk:
        """Run one inference step and return the resulting action chunk."""

    @abstractmethod
    def is_alive(self) -> bool:
        """Return True if the backend is connected and ready to `step`."""


__all__ = ["ActionChunk", "PolicyBackend"]
