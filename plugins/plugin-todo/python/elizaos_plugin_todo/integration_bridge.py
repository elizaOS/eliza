"""Integration bridge service for connecting with other plugins."""

import logging
from typing import Protocol

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime interface."""

    agent_id: str


class TodoIntegrationBridge:
    """Integration bridge service for connecting todo plugin with other plugins.

    This service enables enhanced functionality by bridging the todo plugin
    with other plugins in the system.
    """

    service_type = "TODO_INTEGRATION_BRIDGE"
    capability_description = "Bridges todo plugin with other plugins for enhanced functionality"

    def __init__(self) -> None:
        """Initialize the integration bridge."""
        self._runtime: RuntimeProtocol | None = None
        self._is_running = False

    @classmethod
    async def start(cls, runtime: RuntimeProtocol) -> "TodoIntegrationBridge":
        """Start the integration bridge service.

        Args:
            runtime: The agent runtime

        Returns:
            The started service instance
        """
        logger.info("Starting TodoIntegrationBridge...")
        service = cls()
        service._runtime = runtime
        await service._initialize()
        service._is_running = True
        logger.info("TodoIntegrationBridge started successfully")
        return service

    async def _initialize(self) -> None:
        """Initialize the service."""
        # Initialization complete
        pass

    async def stop(self) -> None:
        """Stop the integration bridge service."""
        self._is_running = False
        logger.info("TodoIntegrationBridge stopped")

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._is_running
