import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import ActionResult
from elizaos_browser.utils.errors import (
    ActionError,
    SessionError,
    handle_browser_error,
)
from elizaos_browser.utils.url import parse_click_target

logger = logging.getLogger(__name__)


CLICK_ACTION = {
    "name": "BROWSER_CLICK",
    "similes": ["CLICK_ELEMENT", "TAP", "PRESS_BUTTON"],
    "description": "Click on an element on the webpage",
    "examples": [
        {"user": "Click on the search button", "agent": "I've clicked on the search button."}
    ],
}


async def browser_click(
    service: BrowserService,
    message: str,
    callback: Any | None = None,
) -> ActionResult:
    session = await service.get_or_create_session()
    if not session:
        error = SessionError("No active browser session")
        handle_browser_error(error, callback, "click on element")
        return ActionResult(
            success=False,
            error="no_session",
            data={"actionName": "BROWSER_CLICK"},
        )

    description = parse_click_target(message)

    result = await service.get_client().click(session.id, description)
    if not result.success:
        raise ActionError("click", description, RuntimeError(result.error or "Click failed"))

    response_text = f'I\'ve successfully clicked on "{description}"'
    if callback:
        callback({"text": response_text, "actions": ["BROWSER_CLICK"]})

    return ActionResult(
        success=True,
        data={
            "actionName": "BROWSER_CLICK",
            "element": description,
            "sessionId": session.id,
        },
    )
