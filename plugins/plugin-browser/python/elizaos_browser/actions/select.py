import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import ActionResult
from elizaos_browser.utils.errors import (
    ActionError,
    SessionError,
    handle_browser_error,
)
from elizaos_browser.utils.url import parse_select_action

logger = logging.getLogger(__name__)


SELECT_ACTION = {
    "name": "BROWSER_SELECT",
    "similes": ["SELECT_OPTION", "CHOOSE", "PICK"],
    "description": "Select an option from a dropdown on the webpage",
    "examples": [
        {
            "user": 'Select "United States" from the country dropdown',
            "agent": 'I\'ve selected "United States" from the country dropdown.',
        }
    ],
}


async def browser_select(
    service: BrowserService,
    message: str,
    callback: Any | None = None,
) -> ActionResult:
    session = await service.get_or_create_session()
    if not session:
        error = SessionError("No active browser session")
        handle_browser_error(error, callback, "select option")
        return ActionResult(
            success=False,
            error="no_session",
            data={"actionName": "BROWSER_SELECT"},
        )

    option, dropdown = parse_select_action(message)

    if not option:
        raise ActionError("select", dropdown, ValueError("No option specified to select"))

    result = await service.get_client().select(session.id, option, dropdown)
    if not result.success:
        raise ActionError("select", dropdown, RuntimeError(result.error or "Select failed"))

    response_text = f'I\'ve selected "{option}" from the {dropdown}'
    if callback:
        callback({"text": response_text, "actions": ["BROWSER_SELECT"]})

    return ActionResult(
        success=True,
        data={
            "actionName": "BROWSER_SELECT",
            "option": option,
            "dropdown": dropdown,
            "sessionId": session.id,
        },
    )
