"""Backend contract for ROSBridge-compatible websocket operations."""

from __future__ import annotations

from abc import ABC, abstractmethod

from eliza_robot.bridge.types import JsonDict


class RosbridgeBackend(ABC):
    """Abstract ROSBridge operation surface for target runtimes."""

    @property
    @abstractmethod
    def backend_name(self) -> str:
        """Return backend identifier."""

    @abstractmethod
    async def connect(self) -> None:
        """Initialize resources."""

    @abstractmethod
    async def shutdown(self) -> None:
        """Release resources."""

    @abstractmethod
    async def publish(self, topic: str, message: JsonDict) -> None:
        """Handle a ROSBridge publish operation."""

    @abstractmethod
    async def call_service(self, service: str, args: JsonDict) -> JsonDict:
        """Handle a ROSBridge call_service operation and return values."""

    @abstractmethod
    async def snapshot_topics(self) -> dict[str, JsonDict]:
        """Return latest topic messages keyed by topic name."""

    @abstractmethod
    def capabilities(self) -> JsonDict:
        """Return backend capabilities."""
