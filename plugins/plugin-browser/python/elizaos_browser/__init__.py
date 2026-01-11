"""
Browser Automation Plugin for ElizaOS (Python)

Provides AI-powered browser automation capabilities including:
- Navigation (navigate, back, forward, refresh)
- Interactions (click, type, select)
- Data extraction
- Screenshots
- CAPTCHA solving
"""

from elizaos_browser.actions import (
    browser_click,
    browser_extract,
    browser_navigate,
    browser_screenshot,
    browser_select,
    browser_type,
)
from elizaos_browser.plugin import BrowserPlugin, create_browser_plugin
from elizaos_browser.providers import get_browser_state
from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.services.websocket_client import BrowserWebSocketClient
from elizaos_browser.types import (
    ActionResult,
    BrowserConfig,
    BrowserSession,
    CaptchaResult,
    CaptchaType,
    ExtractResult,
    NavigationResult,
    RetryConfig,
    ScreenshotResult,
    SecurityConfig,
)

__version__ = "1.0.0"

__all__ = [
    # Types
    "BrowserConfig",
    "BrowserSession",
    "NavigationResult",
    "ActionResult",
    "ExtractResult",
    "ScreenshotResult",
    "CaptchaResult",
    "CaptchaType",
    "SecurityConfig",
    "RetryConfig",
    # Services
    "BrowserService",
    "BrowserWebSocketClient",
    # Actions
    "browser_navigate",
    "browser_click",
    "browser_type",
    "browser_select",
    "browser_extract",
    "browser_screenshot",
    # Providers
    "get_browser_state",
    # Plugin
    "BrowserPlugin",
    "create_browser_plugin",
]



