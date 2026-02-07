"""
React to message action for Slack.
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
    """Handle the react to message action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    emoji = options.get("emoji") if options else None
    message_ts = options.get("message_ts") if options else None
    channel_id = options.get("channel_id") if options else None
    remove = options.get("remove", False) if options else False
    
    if not emoji or not message_ts:
        if callback:
            await callback({
                "text": "Please specify the emoji and message timestamp.",
                "source": "slack",
            })
        return {"success": False, "error": "Missing emoji or message_ts"}
    
    if not is_valid_message_ts(message_ts):
        if callback:
            await callback({
                "text": "Invalid message timestamp format.",
                "source": "slack",
            })
        return {"success": False, "error": "Invalid message timestamp"}
    
    # Get channel from room if not provided
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
    
    if remove:
        await slack_service.remove_reaction(channel_id, message_ts, emoji)
        action_word = "removed"
    else:
        await slack_service.send_reaction(channel_id, message_ts, emoji)
        action_word = "added"
    
    if callback:
        await callback({
            "text": f"Reaction :{emoji}: {action_word} successfully.",
            "source": "slack",
        })
    
    return {
        "success": True,
        "data": {
            "emoji": emoji,
            "message_ts": message_ts,
            "channel_id": channel_id,
            "action": action_word,
        },
    }


react_to_message = {
    "name": "SLACK_REACT_TO_MESSAGE",
    "similes": ["ADD_SLACK_REACTION", "REACT_SLACK", "SLACK_EMOJI"],
    "description": "Add or remove an emoji reaction to a Slack message",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "React to the last message with a thumbs up"}},
            {"name": "{{agent}}", "content": {"text": "I'll add a thumbs up reaction.", "actions": ["SLACK_REACT_TO_MESSAGE"]}},
        ],
    ],
}
