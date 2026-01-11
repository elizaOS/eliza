"""Roblox service implementation for elizaOS."""

import logging
from datetime import datetime
from typing import Any
from uuid import UUID

from elizaos_plugin_roblox.client import RobloxClient
from elizaos_plugin_roblox.config import RobloxConfig
from elizaos_plugin_roblox.types import MessageSender, MessagingServiceMessage

logger = logging.getLogger(__name__)


class RobloxService:
    """Roblox service for elizaOS agents."""

    def __init__(
        self,
        config: RobloxConfig,
        agent_id: UUID,
        agent_name: str,
    ) -> None:
        """Initialize the service.

        Args:
            config: Roblox configuration.
            agent_id: Agent UUID.
            agent_name: Agent name.
        """
        self.config = config
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.client = RobloxClient(config)
        self._is_running = False

    async def start(self) -> None:
        """Start the service."""
        if self._is_running:
            logger.warning("Roblox service already running")
            return

        self._is_running = True
        logger.info(
            f"Roblox service started for agent {self.agent_id} "
            f"(universe: {self.config.universe_id})"
        )

    async def stop(self) -> None:
        """Stop the service."""
        if not self._is_running:
            logger.debug("Roblox service not running")
            return

        self._is_running = False
        await self.client.close()
        logger.info(f"Roblox service stopped for agent {self.agent_id}")

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._is_running

    async def send_message(
        self,
        content: str,
        target_player_ids: list[int] | None = None,
    ) -> None:
        """Send a message to the game.

        Args:
            content: Message content.
            target_player_ids: Optional list of target player IDs.
        """
        message = MessagingServiceMessage(
            topic=self.config.messaging_topic,
            data={
                "type": "agent_message",
                "content": content,
                "targetPlayerIds": target_player_ids,
                "timestamp": int(datetime.now().timestamp() * 1000),
            },
            sender=MessageSender(
                agent_id=self.agent_id,
                agent_name=self.agent_name,
            ),
        )

        await self.client.send_agent_message(message)

    async def execute_action(
        self,
        action_name: str,
        parameters: dict[str, Any],
        target_player_ids: list[int] | None = None,
    ) -> None:
        """Execute an action in the game.

        Args:
            action_name: Name of the action.
            parameters: Action parameters.
            target_player_ids: Optional list of target player IDs.
        """
        message = MessagingServiceMessage(
            topic=self.config.messaging_topic,
            data={
                "type": "agent_action",
                "action": action_name,
                "parameters": parameters,
                "targetPlayerIds": target_player_ids,
                "timestamp": int(datetime.now().timestamp() * 1000),
            },
            sender=MessageSender(
                agent_id=self.agent_id,
                agent_name=self.agent_name,
            ),
        )

        await self.client.send_agent_message(message)

    async def __aenter__(self) -> "RobloxService":
        """Async context manager entry."""
        await self.start()
        return self

    async def __aexit__(self, *args: object) -> None:
        """Async context manager exit."""
        await self.stop()


