"""X (Twitter) main service orchestration."""

import logging
from typing import Protocol

logger = logging.getLogger(__name__)


class RuntimeProtocol(Protocol):
    """Protocol for agent runtime interface."""

    agent_id: str

    def get_setting(self, key: str) -> str | None:
        """Get a runtime setting."""
        ...


class XService:
    """X Client Instance - orchestrates all X (formerly Twitter) functionality.

    Components:
    - client: base operations (auth, timeline caching)
    - post: autonomous posting
    - interaction: mentions and replies
    - timeline: actions (likes, reposts, replies)
    - discovery: content discovery and engagement
    """

    service_type = "x"
    capability_description = "Send and receive posts on X (formerly Twitter)"

    def __init__(self) -> None:
        """Initialize the X service."""
        self._runtime: RuntimeProtocol | None = None
        self._is_running = False
        self._post_enabled = False
        self._replies_enabled = False
        self._actions_enabled = False
        self._discovery_enabled = False

    @classmethod
    async def start(cls, runtime: RuntimeProtocol) -> "XService":
        """Start the X service.

        Args:
            runtime: The agent runtime

        Returns:
            The started service instance
        """
        service = cls()
        service._runtime = runtime

        # Check feature flags
        service._post_enabled = runtime.get_setting("X_ENABLE_POST") == "true"
        service._replies_enabled = runtime.get_setting("X_ENABLE_REPLIES") != "false"
        service._actions_enabled = runtime.get_setting("X_ENABLE_ACTIONS") == "true"
        service._discovery_enabled = runtime.get_setting("X_ENABLE_DISCOVERY") == "true" or (
            service._actions_enabled and runtime.get_setting("X_ENABLE_DISCOVERY") != "false"
        )

        if service._post_enabled:
            logger.info("X posting ENABLED")
        if service._replies_enabled:
            logger.info("X replies ENABLED")
        if service._actions_enabled:
            logger.info("X timeline actions ENABLED")
        if service._discovery_enabled:
            logger.info("X discovery ENABLED")

        service._is_running = True
        logger.info("X configuration validated")
        return service

    async def stop(self) -> None:
        """Stop the X service."""
        self._is_running = False
        logger.info("X service stopped")

    @property
    def is_running(self) -> bool:
        """Check if the service is running."""
        return self._is_running

    @property
    def post_enabled(self) -> bool:
        """Check if posting is enabled."""
        return self._post_enabled

    @property
    def replies_enabled(self) -> bool:
        """Check if replies are enabled."""
        return self._replies_enabled

    @property
    def actions_enabled(self) -> bool:
        """Check if timeline actions are enabled."""
        return self._actions_enabled

    @property
    def discovery_enabled(self) -> bool:
        """Check if discovery is enabled."""
        return self._discovery_enabled
