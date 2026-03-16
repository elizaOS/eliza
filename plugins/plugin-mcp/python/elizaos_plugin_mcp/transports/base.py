"""Base transport interface for MCP connections."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from types import TracebackType


class Transport(ABC):
    @abstractmethod
    async def connect(self) -> None:
        pass

    @abstractmethod
    async def send(self, message: dict[str, Any]) -> None:
        pass

    @abstractmethod
    async def receive(self) -> dict[str, Any]:
        pass

    @abstractmethod
    async def close(self) -> None:
        pass

    async def __aenter__(self) -> Transport:
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()
