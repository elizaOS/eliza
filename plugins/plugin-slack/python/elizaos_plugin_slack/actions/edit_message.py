"""
Edit message action for Slack.
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
    """Handle the edit message action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    message_ts = options.get("message_ts") if options else None
    new_text = options.get("new_text") if options else None
    channel_id = options.get("channel_id") if options else None
    
    if not message_ts or not new_text:
        if callback:
            await callback({
                "text": "Please specify the message timestamp and new text.",
                "source": "slack",
            })
        return {"success": False, "error": "Missing message_ts or new_text"}
    
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
    
    await slack_service.edit_message(channel_id, message_ts, new_text)
    
    if callback:
        await callback({"text": "Message edited successfully.", "source": "slack"})
    
    return {
        "success": True,
        "data": {
            "message_ts": message_ts,
            "channel_id": channel_id,
            "new_text": new_text,
        },
    }


edit_message = {
    "name": "SLACK_EDIT_MESSAGE",
    "similes": ["UPDATE_SLACK_MESSAGE", "MODIFY_MESSAGE", "CHANGE_MESSAGE"],
    "description": "Edit an existing Slack message",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Edit that message to say 'Meeting at 3pm' instead"}},
            {"name": "{{agent}}", "content": {"text": "I'll update that message.", "actions": ["SLACK_EDIT_MESSAGE"]}},
        ],
    ],
}
