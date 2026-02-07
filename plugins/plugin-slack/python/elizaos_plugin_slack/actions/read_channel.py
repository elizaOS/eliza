"""
Read channel action for Slack.
"""

from typing import Any, Dict, Optional
from datetime import datetime

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
    """Handle the read channel action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    channel_ref = options.get("channel_ref", "current") if options else "current"
    limit = min(options.get("limit", 10), 100) if options else 10
    before = options.get("before") if options else None
    after = options.get("after") if options else None
    
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
    
    # Resolve channel reference
    if channel_ref and channel_ref != "current":
        channels = await slack_service.list_channels()
        for ch in channels:
            ch_name = ch.name.lower() if ch.name else ""
            search = channel_ref.lower().lstrip("#")
            if ch_name == search or ch.id == channel_ref:
                target_channel_id = ch.id
                break
    
    messages = await slack_service.read_history(
        target_channel_id,
        limit=limit,
        before=before,
        after=after,
    )
    
    # Format messages for display
    formatted = []
    for msg in messages:
        ts_float = float(msg.ts)
        timestamp = datetime.fromtimestamp(ts_float).isoformat()
        user = msg.user or "unknown"
        text = msg.text or "[no text]"
        formatted.append(f"[{timestamp}] {user}: {text}")
    
    channel_info = await slack_service.get_channel(target_channel_id)
    channel_name = channel_info.name if channel_info else target_channel_id
    
    if callback:
        await callback({
            "text": f"Last {len(messages)} messages from #{channel_name}:\n\n" + "\n".join(formatted),
            "source": "slack",
        })
    
    return {
        "success": True,
        "data": {
            "channel_id": target_channel_id,
            "channel_name": channel_name,
            "message_count": len(messages),
            "messages": [{"ts": m.ts, "user": m.user, "text": m.text} for m in messages],
        },
    }


read_channel = {
    "name": "SLACK_READ_CHANNEL",
    "similes": ["READ_SLACK_MESSAGES", "GET_CHANNEL_HISTORY", "SLACK_HISTORY"],
    "description": "Read message history from a Slack channel",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Show me the last 5 messages in this channel"}},
            {"name": "{{agent}}", "content": {"text": "I'll fetch the recent messages.", "actions": ["SLACK_READ_CHANNEL"]}},
        ],
    ],
}
