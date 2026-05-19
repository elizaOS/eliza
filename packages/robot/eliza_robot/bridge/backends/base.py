"""Backend interface for the websocket bridge."""

from __future__ import annotations

from abc import ABC, abstractmethod

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

