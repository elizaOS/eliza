"""
Emoji list action for Slack.
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
    """Handle the emoji list action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    emoji = await slack_service.get_emoji_list()
    emoji_names = sorted(emoji.keys())
    
    if not emoji_names:
        if callback:
            await callback({
                "text": "There are no custom emoji in this workspace.",
                "source": "slack",
            })
        return {
            "success": True,
            "data": {
                "emoji_count": 0,
                "emoji": {},
            },
        }
    
    # Limit display count
    display_count = min(len(emoji_names), 100)
    display_emoji = emoji_names[:display_count]
    
    # Detect aliases
    aliases = []
    custom = []
    for name in display_emoji:
        value = emoji[name]
        if value.startswith("alias:"):
            aliases.append(name)
        else:
            custom.append(name)
    
    emoji_display = " ".join(f":{name}:" for name in custom)
    alias_display = ""
    if aliases:
        alias_display = f"\n\nAliases: " + " ".join(f":{name}:" for name in aliases)
    
    truncation_note = ""
    if len(emoji_names) > display_count:
        truncation_note = f"\n\n(Showing {display_count} of {len(emoji_names)} total custom emoji)"
    
    if callback:
        await callback({
            "text": f"Custom emoji in this workspace ({len(emoji_names)} total):\n\n{emoji_display}{alias_display}{truncation_note}",
            "source": "slack",
        })
    
    return {
        "success": True,
        "data": {
            "emoji_count": len(emoji_names),
            "emoji": {name: emoji[name] for name in display_emoji},
        },
    }


emoji_list = {
    "name": "SLACK_EMOJI_LIST",
    "similes": ["LIST_SLACK_EMOJI", "SHOW_EMOJI", "GET_CUSTOM_EMOJI"],
    "description": "List custom emoji available in the Slack workspace",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Show me the custom emoji in this workspace"}},
            {"name": "{{agent}}", "content": {"text": "I'll list the custom emoji.", "actions": ["SLACK_EMOJI_LIST"]}},
        ],
    ],
}
