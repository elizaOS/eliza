"""
List spaces action for Google Chat plugin.
"""


from ..types import (
    GOOGLE_CHAT_SERVICE_NAME,
    get_space_display_name,
    is_direct_message,
)


async def validate(runtime, message, state: dict | None = None) -> bool:
    """Validate that this action can be executed."""
    return message.content.get("source") == "google-chat"


async def handler(
    runtime,
    message,
    state: dict | None = None,
    options: dict | None = None,
    callback=None,
):
    """Handle the list spaces action."""
    gchat_service = runtime.get_service(GOOGLE_CHAT_SERVICE_NAME)

    if not gchat_service or not gchat_service.is_connected():
        if callback:
            await callback({"text": "Google Chat service is not available.", "source": "google-chat"})
        return {"success": False, "error": "Google Chat service not available"}

    spaces = await gchat_service.get_spaces()

    if not spaces:
        if callback:
            await callback({
                "text": "I'm not currently in any Google Chat spaces.",
                "source": message.content.get("source"),
            })
        return {"success": True, "data": {"space_count": 0, "spaces": []}}

    # Format space list
    space_lines = []
    for space in spaces:
        name = get_space_display_name(space)
        space_type = "DM" if is_direct_message(space) else (space.type or "SPACE")
        threaded = " (threaded)" if space.threaded else ""
        space_lines.append(f"• {name} [{space_type}]{threaded}")

    response_text = f"Currently in {len(spaces)} space(s):\n\n" + "\n".join(space_lines)

    if callback:
        await callback({
            "text": response_text,
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "space_count": len(spaces),
            "spaces": [
                {
                    "name": s.name,
                    "display_name": s.display_name,
                    "type": s.type,
                    "threaded": s.threaded,
                }
                for s in spaces
            ],
        },
    }


list_spaces_action = {
    "name": "GOOGLE_CHAT_LIST_SPACES",
    "similes": [
        "LIST_GOOGLE_CHAT_SPACES",
        "GCHAT_SPACES",
        "SHOW_GOOGLE_CHAT_SPACES",
    ],
    "description": "List all Google Chat spaces the bot is a member of",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "What Google Chat spaces are you in?"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "Let me check my Google Chat spaces.",
                    "actions": ["GOOGLE_CHAT_LIST_SPACES"],
                },
            },
        ],
    ],
}
