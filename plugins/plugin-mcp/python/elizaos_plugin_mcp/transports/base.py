"""Base transport interface for MCP connections."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from types import TracebackType


class Transport(ABC):
    """Abstract base class for MCP transports."""

    @abstractmethod
    async def connect(self) -> None:
        """Establish the connection to the MCP server.

        Raises:
            McpError: If connection fails.
        """
        pass

    @abstractmethod
    async def send(self, message: dict[str, Any]) -> None:
        """Send a JSON-RPC message to the server.

        Args:
            message: The JSON-RPC message to send.

        Raises:
            McpError: If sending fails.
        """
        pass

    @abstractmethod
    async def receive(self) -> dict[str, Any]:
        """Receive a JSON-RPC message from the server.

        Returns:
            The received JSON-RPC message.

        Raises:
            McpError: If receiving fails.
        """
        pass

    @abstractmethod
    async def close(self) -> None:
        """Close the connection to the MCP server."""
        pass

    async def __aenter__(self) -> Transport:
        """Async context manager entry."""
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Async context manager exit."""
        await self.close()
