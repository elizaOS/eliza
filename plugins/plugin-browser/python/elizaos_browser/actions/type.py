"""
Browser Type Action

Type text into an input field on the webpage.
"""

import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import ActionResult
from elizaos_browser.utils.errors import (
    ActionError,
    BrowserError,
    SessionError,
    handle_browser_error,
)
from elizaos_browser.utils.url import parse_type_action

logger = logging.getLogger(__name__)


TYPE_ACTION = {
    "name": "BROWSER_TYPE",
    "similes": ["TYPE_TEXT", "INPUT", "ENTER_TEXT"],
    "description": "Type text into an input field on the webpage",
    "examples": [
        {
            "user": 'Type "hello world" in the search box',
            "agent": 'I\'ve typed "hello world" in the search box.',
        }
    ],
}


async def browser_type(
    service: BrowserService,
    message: str,
    callback: Any | None = None,
) -> ActionResult:
    """
    Type text into an input field on the webpage.

    Args:
        service: Browser service instance
        message: Message with text and field
        callback: Optional callback for responses

    Returns:
        ActionResult with type details
    """
    try:
        session = await service.get_or_create_session()
        if not session:
            error = SessionError("No active browser session")
            handle_browser_error(error, callback, "type text")
            return ActionResult(
                success=False,
                error="no_session",
                data={"actionName": "BROWSER_TYPE"},
            )

        text_to_type, field = parse_type_action(message)

        if not text_to_type:
            raise ActionError("type", field, Exception("No text specified to type"))

        result = await service.get_client().type_text(session.id, text_to_type, field)
        if not result.success:
            raise ActionError("type", field, Exception(result.error or "Type failed"))

        response_text = f'I\'ve typed "{text_to_type}" in the {field}'
        if callback:
            callback({"text": response_text, "actions": ["BROWSER_TYPE"]})

        return ActionResult(
            success=True,
            data={
                "actionName": "BROWSER_TYPE",
                "textTyped": text_to_type,
                "field": field,
                "sessionId": session.id,
            },
        )

    except BrowserError as e:
        logger.error(f"Error in BROWSER_TYPE action: {e}")
        handle_browser_error(e, callback)
        return ActionResult(
            success=False,
            error=str(e),
            data={"actionName": "BROWSER_TYPE"},
        )

    except Exception as e:
        logger.error(f"Error in BROWSER_TYPE action: {e}")
        browser_error: BrowserError = ActionError("type", "input field", e)
        handle_browser_error(browser_error, callback)
        return ActionResult(
            success=False,
            error=str(e),
            data={"actionName": "BROWSER_TYPE"},
        )
