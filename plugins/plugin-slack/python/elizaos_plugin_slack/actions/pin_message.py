"""
Pin message action for Slack.
"""

from typing import Any, Dict, Optional

from ..types import SLACK_SERVICE_NAME, is_valid_message_ts


async def validate(runtime: Any, message: Any, state: Optional[Any] = None) -> bool:
    """Validate if this action can be executed."""
    return message.content.get("source") == "slack"


async def handler(
    runtime: Any,
    message: Any,
    state: Optional[Any] = None,
    options: Optional[Dict] = None,
    callback: Optional[Any] = None,
) -> Optional[Dict[str, Any]]:
    """Handle the pin message action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    message_ts = options.get("message_ts") if options else None
    channel_id = options.get("channel_id") if options else None
    
    if not message_ts:
        if callback:
            await callback({
                "text": "Please specify the message timestamp.",
                "source": "slack",
            })
        return {"success": False, "error": "Missing message_ts"}
    
    if not is_valid_message_ts(message_ts):
        if callback:
            await callback({
                "text": "Invalid message timestamp format.",
                "source": "slack",
            })
        return {"success": False, "error": "Invalid message timestamp"}
    
    if not channel_id:
        room = state.data.get("room") if state and state.data else None
        if not room:
            room = await runtime.get_room(message.room_id)
        channel_id = room.channel_id if room else None
    
    if not channel_id:
        if callback:
            await callback({
                "text": "Could not determine the channel.",
                "source": "slack",
            })
        return {"success": False, "error": "Could not determine channel"}
    
    await slack_service.pin_message(channel_id, message_ts)
    
    if callback:
        await callback({"text": "Message pinned successfully.", "source": "slack"})
    
    return {
        "success": True,
        "data": {
            "message_ts": message_ts,
            "channel_id": channel_id,
        },
    }


pin_message = {
    "name": "SLACK_PIN_MESSAGE",
    "similes": ["PIN_SLACK_MESSAGE", "PIN_MESSAGE", "SLACK_PIN"],
    "description": "Pin a message in a Slack channel",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Pin that important announcement"}},
            {"name": "{{agent}}", "content": {"text": "I'll pin that message.", "actions": ["SLACK_PIN_MESSAGE"]}},
        ],
    ],
}
