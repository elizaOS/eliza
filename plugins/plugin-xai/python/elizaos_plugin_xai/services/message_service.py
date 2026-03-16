"""Message service for X (Twitter) interactions."""

import logging
from abc import ABC, abstractmethod
from typing import Protocol

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime interface."""

    agent_id: str


class IMessageService(ABC):
    """Interface for message service operations."""

    @abstractmethod
    async def send_message(self, recipient_id: str, text: str) -> dict[str, object]:
        """Send a direct message.

        Args:
            recipient_id: The recipient's user ID
            text: The message text

        Returns:
            The sent message data
        """
        ...

    @abstractmethod
    async def get_messages(self, conversation_id: str | None = None) -> list[dict[str, object]]:
        """Get messages from conversations.

        Args:
            conversation_id: Optional specific conversation to retrieve

        Returns:
            List of message data
        """
        ...


class MessageService(IMessageService):
    """Message service implementation for X direct messages."""

    def __init__(self, runtime: RuntimeProtocol) -> None:
        """Initialize the message service.

        Args:
            runtime: The agent runtime
        """
        self._runtime = runtime
        self._is_running = False

    async def start(self) -> None:
        """Start the message service."""
        self._is_running = True
        logger.info("MessageService started")

    async def stop(self) -> None:
        """Stop the message service."""
        self._is_running = False
        logger.info("MessageService stopped")

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._is_running

    async def send_message(self, recipient_id: str, text: str) -> dict[str, object]:
        """Send a direct message.

        Args:
            recipient_id: The recipient's user ID
            text: The message text

        Returns:
            The sent message data
        """
        # Placeholder - actual implementation would use X API client
        logger.info(f"Sending message to {recipient_id}: {text[:50]}...")
        return {
            "id": "placeholder",
            "recipient_id": recipient_id,
            "text": text,
            "sent": True,
        }

    async def get_messages(self, conversation_id: str | None = None) -> list[dict[str, object]]:
        """Get messages from conversations.

        Args:
            conversation_id: Optional specific conversation to retrieve

        Returns:
            List of message data
        """
        # Placeholder - actual implementation would use X API client
        logger.info(f"Getting messages for conversation: {conversation_id}")
        return []
