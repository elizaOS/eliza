"""
Browser Screenshot Action

Take a screenshot of the current page.
"""

import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import ActionResult, ScreenshotResult
from elizaos_browser.utils.errors import (
    BrowserError,
    ActionError,
    SessionError,
    handle_browser_error,
)

logger = logging.getLogger(__name__)


SCREENSHOT_ACTION = {
    "name": "BROWSER_SCREENSHOT",
    "similes": ["TAKE_SCREENSHOT", "CAPTURE_PAGE", "SCREENSHOT"],
    "description": "Take a screenshot of the current page",
    "examples": [
        {"user": "Take a screenshot of the page", "agent": "I've taken a screenshot of the page."}
    ],
}


async def browser_screenshot(
    service: BrowserService,
    message: str,
    callback: Any | None = None,
) -> ActionResult:
    """
    Take a screenshot of the current page.

    Args:
        service: Browser service instance
        message: Message requesting screenshot
        callback: Optional callback for responses

    Returns:
        ActionResult with screenshot details
    """
    try:
        session = await service.get_or_create_session()
        if not session:
            error = SessionError("No active browser session")
            handle_browser_error(error, callback, "take screenshot")
            return ActionResult(
                success=False,
                error="no_session",
                data={"actionName": "BROWSER_SCREENSHOT"},
            )

        result = await service.get_client().screenshot(session.id)
        if not result.success:
            raise ActionError("screenshot", "page", Exception(result.error or "Screenshot failed"))

        screenshot_data = result.data or {}
        url = screenshot_data.get("url", "unknown")
        title = screenshot_data.get("title", "Untitled")

        response_text = f'I\'ve taken a screenshot of the page "{title}" at {url}'
        if callback:
            callback({
                "text": response_text,
                "actions": ["BROWSER_SCREENSHOT"],
                "data": {
                    "screenshot": screenshot_data.get("screenshot"),
                    "mimeType": screenshot_data.get("mimeType", "image/png"),
                    "url": url,
                    "title": title,
                },
            })

        return ActionResult(
            success=True,
            data={
                "actionName": "BROWSER_SCREENSHOT",
                "url": url,
                "title": title,
                "sessionId": session.id,
                "screenshot": screenshot_data.get("screenshot"),
            },
        )

    except BrowserError as e:
        logger.error(f"Error in BROWSER_SCREENSHOT action: {e}")
        handle_browser_error(e, callback)
        return ActionResult(
            success=False,
            error=str(e),
            data={"actionName": "BROWSER_SCREENSHOT"},
        )

    except Exception as e:
        logger.error(f"Error in BROWSER_SCREENSHOT action: {e}")
        error = ActionError("screenshot", "page", e)
        handle_browser_error(error, callback)
        return ActionResult(
            success=False,
            error=str(e),
            data={"actionName": "BROWSER_SCREENSHOT"},
        )


