import logging
from typing import Any

from elizaos_browser.services.browser_service import BrowserService

logger = logging.getLogger(__name__)


BROWSER_STATE_PROVIDER = {
    "name": "BROWSER_STATE",
    "description": "Provides current browser state information",
}


async def get_browser_state(service: BrowserService) -> dict[str, Any]:
    session = await service.get_current_session()

    if not session:
        return {
            "text": "No active browser session",
            "values": {"hasSession": False},
            "data": {},
        }

    client = service.get_client()
    state = await client.get_state(session.id)

    return {
        "text": f'Current browser page: "{state.get("title", "")}" at {state.get("url", "")}',
        "values": {
            "hasSession": True,
            "url": state.get("url", ""),
            "title": state.get("title", ""),
        },
        "data": {
            "sessionId": session.id,
            "createdAt": session.created_at.isoformat(),
        },
    }
