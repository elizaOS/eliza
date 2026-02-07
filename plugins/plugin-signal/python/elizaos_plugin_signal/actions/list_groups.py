"""
List groups action for Signal plugin.
"""

from typing import Optional

from elizaos_plugin_signal.types import SIGNAL_SERVICE_NAME


async def validate(runtime, message, state: Optional[dict] = None) -> bool:
    """Validate if this action can be executed."""
    return message.content.get("source") == "signal"


async def handler(
    runtime,
    message,
    state: Optional[dict] = None,
    options: Optional[dict] = None,
    callback=None,
):
    """Handle the list groups action."""
    signal_service = runtime.get_service(SIGNAL_SERVICE_NAME)

    if not signal_service or not signal_service.is_service_connected():
        if callback:
            await callback({"text": "Signal service is not available.", "source": "signal"})
        return {"success": False, "error": "Signal service not available"}

    groups = await signal_service.get_groups()

    # Filter to groups the bot is a member of and sort by name
    active_groups = sorted(
        [g for g in groups if g.is_member and not g.is_blocked],
        key=lambda g: g.name.lower(),
    )

    # Format group list
    group_list = []
    for g in active_groups:
        member_count = len(g.members)
        description = ""
        if g.description:
            truncated = g.description[:50]
            if len(g.description) > 50:
                truncated += "..."
            description = f" - {truncated}"
        group_list.append(f"• {g.name} ({member_count} members){description}")

    response_text = f"Found {len(active_groups)} groups:\n\n" + "\n".join(group_list)

    if callback:
        await callback({
            "text": response_text,
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "group_count": len(active_groups),
            "groups": [
                {
                    "id": g.id,
                    "name": g.name,
                    "description": g.description,
                    "member_count": len(g.members),
                }
                for g in active_groups
            ],
        },
    }


list_groups_action = {
    "name": "SIGNAL_LIST_GROUPS",
    "similes": [
        "LIST_SIGNAL_GROUPS",
        "SHOW_GROUPS",
        "GET_GROUPS",
        "SIGNAL_GROUPS",
    ],
    "description": "List Signal groups",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Show me my Signal groups"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll list your Signal groups.",
                    "actions": ["SIGNAL_LIST_GROUPS"],
                },
            },
        ]
    ],
}
