"""
List channels action for Slack.
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
    """Handle the list channels action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    channels = await slack_service.list_channels(
        types="public_channel,private_channel",
        limit=100,
    )
    
    # Filter and sort
    sorted_channels = sorted(
        [ch for ch in channels if not ch.is_archived],
        key=lambda ch: ch.name,
    )
    
    # Format channel list
    channel_list = []
    for ch in sorted_channels:
        member_count = f" ({ch.num_members} members)" if ch.num_members is not None else ""
        private = " 🔒" if ch.is_private else ""
        topic = ""
        if ch.topic and ch.topic.value:
            topic_text = ch.topic.value[:50] + ("..." if len(ch.topic.value) > 50 else "")
            topic = f" - {topic_text}"
        channel_list.append(f"• #{ch.name}{private}{member_count}{topic}")
    
    if callback:
        await callback({
            "text": f"Found {len(sorted_channels)} channels:\n\n" + "\n".join(channel_list),
            "source": "slack",
        })
    
    return {
        "success": True,
        "data": {
            "channel_count": len(sorted_channels),
            "channels": [
                {
                    "id": ch.id,
                    "name": ch.name,
                    "is_private": ch.is_private,
                    "num_members": ch.num_members,
                    "topic": ch.topic.value if ch.topic else None,
                    "purpose": ch.purpose.value if ch.purpose else None,
                }
                for ch in sorted_channels
            ],
        },
    }


list_channels = {
    "name": "SLACK_LIST_CHANNELS",
    "similes": ["LIST_SLACK_CHANNELS", "SHOW_CHANNELS", "GET_CHANNELS"],
    "description": "List available Slack channels in the workspace",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Show me all the channels in this workspace"}},
            {"name": "{{agent}}", "content": {"text": "I'll list all available channels.", "actions": ["SLACK_LIST_CHANNELS"]}},
        ],
    ],
}
