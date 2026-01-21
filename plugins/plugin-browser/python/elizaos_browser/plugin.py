import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

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

if TYPE_CHECKING:
    from elizaos.types.components import Action, Provider

logger = logging.getLogger(__name__)


def _create_browser_action(
    name: str,
    description: str,
    similes: list[str],
    handler_fn: Callable[..., Any],
    service_getter: Callable[[], BrowserService | None],
) -> "Action":
    """Create an Action object for a browser action."""
    from elizaos.types.components import Action, ActionResult

    async def validate(runtime: Any, memory: Any, state: Any = None) -> bool:
        # Browser actions are always valid if service exists
        return service_getter() is not None

    async def handler(
        runtime: Any,
        memory: Any,
        state: Any = None,
        options: Any = None,
        callback: Any = None,
        memories: Any = None,
    ) -> ActionResult | None:
        service = service_getter()
        if not service:
            return ActionResult(success=False, error="Browser service not initialized")

        # Extract text from memory content
        message = ""
        if hasattr(memory, "content"):
            content = memory.content
            if hasattr(content, "text"):
                message = content.text or ""
            elif isinstance(content, dict):
                message = content.get("text", "")
            elif isinstance(content, str):
                message = content

        result = await handler_fn(service, message, callback)

        # Convert to standard ActionResult
        return ActionResult(
            success=getattr(result, "success", True),
            error=getattr(result, "error", None),
            data=getattr(result, "data", {}),
        )

    return Action(
        name=name,
        description=description,
        similes=similes,
        validate=validate,
        handler=handler,
    )


def _create_browser_provider(
    name: str,
    description: str,
    provider_fn: Callable[..., Any],
    service_getter: Callable[[], BrowserService | None],
) -> "Provider":
    """Create a Provider object for a browser provider."""
    from elizaos.types.components import Provider, ProviderResult

    async def get(runtime: Any, memory: Any, state: Any) -> ProviderResult:
        service = service_getter()
        if not service:
            return ProviderResult(text="Browser service not initialized")

        result = await provider_fn(service)
        return ProviderResult(text=str(result))

    return Provider(
        name=name,
        description=description,
        get=get,
    )


@dataclass
class BrowserPlugin:
    name: str = "plugin-browser"
    description: str = "Browser automation plugin"
    config: BrowserConfig = field(default_factory=BrowserConfig)
    service: BrowserService | None = None
    actions: list[Any] = field(default_factory=list)
    providers: list[Any] = field(default_factory=list)
    _action_handlers: dict[str, Callable[..., Any]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Store raw handlers for direct access
        self._action_handlers = {
            "BROWSER_NAVIGATE": browser_navigate,
            "BROWSER_CLICK": browser_click,
            "BROWSER_TYPE": browser_type,
            "BROWSER_SELECT": browser_select,
            "BROWSER_EXTRACT": browser_extract,
            "BROWSER_SCREENSHOT": browser_screenshot,
        }

        # Create proper Action objects
        self.actions = [
            _create_browser_action(
                "BROWSER_NAVIGATE",
                "Navigate the browser to a specified URL",
                ["GO_TO_URL", "OPEN_WEBSITE", "VISIT_PAGE", "NAVIGATE_TO"],
                browser_navigate,
                lambda: self.service,
            ),
            _create_browser_action(
                "BROWSER_CLICK",
                "Click on an element in the browser",
                ["CLICK_ELEMENT", "PRESS_BUTTON", "TAP"],
                browser_click,
                lambda: self.service,
            ),
            _create_browser_action(
                "BROWSER_TYPE",
                "Type text into an input field",
                ["ENTER_TEXT", "FILL_FIELD", "INPUT_TEXT"],
                browser_type,
                lambda: self.service,
            ),
            _create_browser_action(
                "BROWSER_SELECT",
                "Select an option from a dropdown",
                ["CHOOSE_OPTION", "SELECT_DROPDOWN"],
                browser_select,
                lambda: self.service,
            ),
            _create_browser_action(
                "BROWSER_EXTRACT",
                "Extract content from the current page",
                ["GET_PAGE_CONTENT", "READ_PAGE", "SCRAPE"],
                browser_extract,
                lambda: self.service,
            ),
            _create_browser_action(
                "BROWSER_SCREENSHOT",
                "Take a screenshot of the current page",
                ["CAPTURE_SCREEN", "SNAPSHOT"],
                browser_screenshot,
                lambda: self.service,
            ),
        ]

        # Create proper Provider objects
        self.providers = [
            _create_browser_provider(
                "BROWSER_STATE",
                "Get current browser state",
                get_browser_state,
                lambda: self.service,
            ),
        ]

    async def init(self) -> None:
        logger.info("Initializing browser automation plugin")

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

        self.service = BrowserService(self.config)
        await self.service.start()

        logger.info("Browser plugin initialized successfully")

    async def stop(self) -> None:
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
        """Execute an action directly by name (for direct usage)."""
        if action_name not in self._action_handlers:
            raise ValueError(f"Unknown action: {action_name}")

        if not self.service:
            raise RuntimeError("Browser service not initialized")

        return await self._action_handlers[action_name](self.service, message, callback)

    async def get_provider(self, provider_name: str) -> Any:
        """Get provider data directly by name (for direct usage)."""
        if provider_name == "BROWSER_STATE":
            if not self.service:
                raise RuntimeError("Browser service not initialized")
            return await get_browser_state(self.service)

        raise ValueError(f"Unknown provider: {provider_name}")


def create_browser_plugin(config: BrowserConfig | None = None) -> BrowserPlugin:
    return BrowserPlugin(config=config or BrowserConfig())
