"""Backend interface for the websocket bridge."""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np

from eliza_robot.bridge.protocol import CommandEnvelope, EventEnvelope, ResponseEnvelope
from eliza_robot.bridge.types import JsonDict


class BridgeBackend(ABC):
    """Abstract backend contract used by websocket server."""

    @property
    @abstractmethod
    def backend_name(self) -> str:
        """Return backend identifier used in responses/events."""

    @abstractmethod
    async def connect(self) -> None:
        """Initialize backend resources."""

    @abstractmethod
    async def shutdown(self) -> None:
        """Release backend resources."""

    @abstractmethod
    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        """Execute one command envelope."""

    @abstractmethod
    async def poll_events(self) -> list[EventEnvelope]:
        """Return any pending events that should be pushed to clients."""

    @abstractmethod
    def capabilities(self) -> JsonDict:
        """Return backend capabilities in JSON-serializable form."""

    def snapshot_camera(self, _camera: str = "head") -> np.ndarray | None:
        """Return the current camera frame as (H, W, 3) uint8 RGB, or None
        when the backend does not expose camera frames yet.

        The server-level `camera.snapshot` handler encodes the frame as PNG
        and ships it as base64. Subclasses (mujoco, mock, ros_real) override
        this to return real pixels.
        """
        return None

