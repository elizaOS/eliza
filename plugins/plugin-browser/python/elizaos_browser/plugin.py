"""
Browser Plugin for ElizaOS

Main plugin class for browser automation.
"""

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from elizaos_browser.actions import (
    browser_click,
    browser_extract,
    browser_navigate,
    browser_screenshot,
    browser_select,
    browser_type,
)
from elizaos_browser.providers import get_browser_state
from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import BrowserConfig

logger = logging.getLogger(__name__)


@dataclass
class BrowserPlugin:
    """Browser automation plugin for ElizaOS."""

    name: str = "plugin-browser"
    description: str = "Browser automation plugin for AI-powered web interactions"
    config: BrowserConfig = field(default_factory=BrowserConfig)
    service: BrowserService | None = None

    # Action handlers
    actions: dict[str, Callable[..., Any]] = field(default_factory=dict)
    providers: dict[str, Callable[..., Any]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Initialize actions and providers."""
        self.actions = {
            "BROWSER_NAVIGATE": self._wrap_action(browser_navigate),
            "BROWSER_CLICK": self._wrap_action(browser_click),
            "BROWSER_TYPE": self._wrap_action(browser_type),
            "BROWSER_SELECT": self._wrap_action(browser_select),
            "BROWSER_EXTRACT": self._wrap_action(browser_extract),
            "BROWSER_SCREENSHOT": self._wrap_action(browser_screenshot),
        }
        self.providers = {
            "BROWSER_STATE": self._wrap_provider(get_browser_state),
        }

    def _wrap_action(
        self,
        action: Callable[..., Any],
    ) -> Callable[..., Any]:
        """Wrap action to inject service."""

        async def wrapper(message: str, callback: Any | None = None) -> Any:
            if not self.service:
                raise RuntimeError("Browser service not initialized")
            return await action(self.service, message, callback)

        return wrapper

    def _wrap_provider(
        self,
        provider: Callable[..., Any],
    ) -> Callable[..., Any]:
        """Wrap provider to inject service."""

        async def wrapper() -> Any:
            if not self.service:
                raise RuntimeError("Browser service not initialized")
            return await provider(self.service)

        return wrapper

    async def init(self) -> None:
        """Initialize the plugin."""
        logger.info("Initializing browser automation plugin")

        # Load configuration from environment
        self.config = BrowserConfig(
            headless=os.getenv("BROWSER_HEADLESS", "true").lower() == "true",
            browserbase_api_key=os.getenv("BROWSERBASE_API_KEY"),
            browserbase_project_id=os.getenv("BROWSERBASE_PROJECT_ID"),
            openai_api_key=os.getenv("OPENAI_API_KEY"),
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
            ollama_base_url=os.getenv("OLLAMA_BASE_URL"),
            ollama_model=os.getenv("OLLAMA_MODEL"),
            capsolver_api_key=os.getenv("CAPSOLVER_API_KEY"),
            server_port=int(os.getenv("BROWSER_SERVER_PORT", "3456")),
        )

        # Create and start service
        self.service = BrowserService(self.config)
        await self.service.start()

        logger.info("Browser plugin initialized successfully")

    async def stop(self) -> None:
        """Stop the plugin."""
        logger.info("Stopping browser automation plugin")
        if self.service:
            await self.service.stop()
            self.service = None

    async def handle_action(
        self,
        action_name: str,
        message: str,
        callback: Any | None = None,
    ) -> Any:
        """Handle an action by name."""
        if action_name not in self.actions:
            raise ValueError(f"Unknown action: {action_name}")

        return await self.actions[action_name](message, callback)

    async def get_provider(self, provider_name: str) -> Any:
        """Get provider data by name."""
        if provider_name not in self.providers:
            raise ValueError(f"Unknown provider: {provider_name}")

        return await self.providers[provider_name]()


def create_browser_plugin(config: BrowserConfig | None = None) -> BrowserPlugin:
    """Create a browser plugin instance."""
    return BrowserPlugin(config=config or BrowserConfig())



