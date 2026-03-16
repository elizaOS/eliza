import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService
from elizaos_browser.types import ActionResult
from elizaos_browser.utils.errors import (
    NoUrlFoundError,
    SecurityError,
    handle_browser_error,
)
from elizaos_browser.utils.retry import DEFAULT_RETRY_CONFIGS, retry_with_backoff
from elizaos_browser.utils.security import default_url_validator, validate_secure_action
from elizaos_browser.utils.url import extract_url

logger = logging.getLogger(__name__)


NAVIGATE_ACTION = {
    "name": "BROWSER_NAVIGATE",
    "similes": ["GO_TO_URL", "OPEN_WEBSITE", "VISIT_PAGE", "NAVIGATE_TO"],
    "description": "Navigate the browser to a specified URL",
    "examples": [{"user": "Go to google.com", "agent": "I've navigated to https://google.com."}],
}


async def browser_navigate(
    service: BrowserService,
    message: str,
    callback: Any | None = None,
) -> ActionResult:
    logger.info("Handling BROWSER_NAVIGATE action")

    url = extract_url(message)
    if not url:
        error = NoUrlFoundError()
        handle_browser_error(error, callback, "navigate to a page")
        return ActionResult(
            success=False,
            error="no_url_found",
            data={"actionName": "BROWSER_NAVIGATE"},
        )

    try:
        validate_secure_action(url, default_url_validator)
    except SecurityError as e:
        handle_browser_error(e, callback)
        return ActionResult(
            success=False,
            error="security_error",
            data={"actionName": "BROWSER_NAVIGATE", "url": url},
        )

    session = await service.get_current_session()
    if not session:
        session = await service.get_or_create_session()

    target_url: str = url
    result = await retry_with_backoff(
        lambda: service.get_client().navigate(session.id, target_url),
        DEFAULT_RETRY_CONFIGS["navigation"],
        f"navigate to {target_url}",
    )

    response_text = f'I\'ve navigated to {url}. The page title is: "{result.title}"'
    if callback:
        callback({"text": response_text, "actions": ["BROWSER_NAVIGATE"]})

    return ActionResult(
        success=True,
        data={
            "actionName": "BROWSER_NAVIGATE",
            "url": result.url,
            "title": result.title,
            "sessionId": session.id,
        },
    )
