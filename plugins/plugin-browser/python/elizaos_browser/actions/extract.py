import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import ActionResult
from elizaos_browser.utils.errors import (
    ActionError,
    SessionError,
    handle_browser_error,
)
from elizaos_browser.utils.url import parse_extract_instruction

logger = logging.getLogger(__name__)


EXTRACT_ACTION = {
    "name": "BROWSER_EXTRACT",
    "similes": ["EXTRACT_DATA", "GET_TEXT", "SCRAPE"],
    "description": "Extract data from the webpage",
    "examples": [
        {
            "user": "Extract the main heading from the page",
            "agent": 'I extracted the main heading: "Welcome to Our Website"',
        }
    ],
}


async def browser_extract(
    service: BrowserService,
    message: str,
    callback: Any | None = None,
) -> ActionResult:
    session = await service.get_or_create_session()
    if not session:
        error = SessionError("No active browser session")
        handle_browser_error(error, callback, "extract data")
        return ActionResult(
            success=False,
            error="no_session",
            data={"actionName": "BROWSER_EXTRACT"},
        )

    instruction = parse_extract_instruction(message)

    result = await service.get_client().extract(session.id, instruction)
    if not result.success:
        raise ActionError("extract", "page", RuntimeError(result.error or "Extraction failed"))

    extracted_data = result.data or {}
    found_text = extracted_data.get("data", "No data found")
    found = extracted_data.get("found", False)

    if found:
        response_text = f'I found the {instruction}: "{found_text}"'
    else:
        response_text = f"I couldn't find the requested {instruction} on the page."

    if callback:
        callback({"text": response_text, "actions": ["BROWSER_EXTRACT"]})

    return ActionResult(
        success=True,
        data={
            "actionName": "BROWSER_EXTRACT",
            "instruction": instruction,
            "found": found,
            "data": found_text,
            "sessionId": session.id,
        },
    )
