"""
Send message action for Slack.
"""

from typing import Any, Dict, Optional

from ..types import SLACK_SERVICE_NAME


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
    """Handle the send message action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    # Extract parameters from state or message
    text = options.get("text") if options else None
    channel_ref = options.get("channel_ref", "current") if options else "current"
    thread_ts = options.get("thread_ts") if options else None
    
    if not text:
        if callback:
            await callback({
                "text": "No message text provided.",
                "source": "slack",
            })
        return {"success": False, "error": "No message text"}
    
    # Get current room if using current channel
    room = state.data.get("room") if state and state.data else None
    if not room:
        room = await runtime.get_room(message.room_id)
    
    if not room or not room.channel_id:
        if callback:
            await callback({
                "text": "Could not determine the current channel.",
                "source": "slack",
            })
        return {"success": False, "error": "Could not determine channel"}
    
    target_channel_id = room.channel_id
    
    # Resolve channel reference if not "current"
    if channel_ref and channel_ref != "current":
        channels = await slack_service.list_channels()
        for ch in channels:
            ch_name = ch.name.lower() if ch.name else ""
            search = channel_ref.lower().lstrip("#")
            if ch_name == search or ch.id == channel_ref:
                target_channel_id = ch.id
                break
    
    result = await slack_service.send_message(
        target_channel_id,
        text,
        thread_ts=thread_ts,
    )
    
    if callback:
        await callback({"text": "Message sent successfully.", "source": "slack"})
    
    return {
        "success": True,
        "data": {
            "message_ts": result["ts"],
            "channel_id": target_channel_id,
        },
    }


send_message = {
    "name": "SLACK_SEND_MESSAGE",
    "similes": [
        "SEND_SLACK_MESSAGE",
        "POST_TO_SLACK",
        "MESSAGE_SLACK",
        "SLACK_POST",
    ],
    "description": "Send a message to a Slack channel or thread",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send a message to #general saying 'Hello everyone!'"}},
            {"name": "{{agent}}", "content": {"text": "I'll send that message to #general for you.", "actions": ["SLACK_SEND_MESSAGE"]}},
        ],
    ],
}
