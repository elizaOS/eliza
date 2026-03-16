"""
List pins action for Slack.
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
    """Handle the list pins action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    channel_ref = options.get("channel_ref", "current") if options else "current"
    
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
    
    pins = await slack_service.list_pins(target_channel_id)
    channel_info = await slack_service.get_channel(target_channel_id)
    channel_name = channel_info.name if channel_info else target_channel_id
    
    if not pins:
        if callback:
            await callback({
                "text": f"There are no pinned messages in #{channel_name}.",
                "source": "slack",
            })
        return {
            "success": True,
            "data": {
                "channel_id": target_channel_id,
                "pin_count": 0,
                "pins": [],
            },
        }
    
    # Format pinned messages
    formatted = []
    for i, pin in enumerate(pins, 1):
        ts_float = float(pin.ts)
        timestamp = datetime.fromtimestamp(ts_float).isoformat()
        user = pin.user or "unknown"
        text = (pin.text[:100] if pin.text else "[no text]")
        truncated = "..." if pin.text and len(pin.text) > 100 else ""
        formatted.append(f"{i}. [{timestamp}] {user}: {text}{truncated}")
    
    if callback:
        await callback({
            "text": f"Pinned messages in #{channel_name} ({len(pins)}):\n\n" + "\n\n".join(formatted),
            "source": "slack",
        })
    
    return {
        "success": True,
        "data": {
            "channel_id": target_channel_id,
            "channel_name": channel_name,
            "pin_count": len(pins),
            "pins": [{"ts": p.ts, "user": p.user, "text": p.text} for p in pins],
        },
    }


list_pins = {
    "name": "SLACK_LIST_PINS",
    "similes": ["LIST_SLACK_PINS", "SHOW_PINS", "GET_PINNED_MESSAGES"],
    "description": "List pinned messages in a Slack channel",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Show me the pinned messages in this channel"}},
            {"name": "{{agent}}", "content": {"text": "I'll list the pinned messages.", "actions": ["SLACK_LIST_PINS"]}},
        ],
    ],
}
