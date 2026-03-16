"""
List contacts action for Signal plugin.
"""

from typing import Optional

from elizaos_plugin_signal.types import (
    get_signal_contact_display_name,
    SIGNAL_SERVICE_NAME,
)


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
    """Handle the list contacts action."""
    signal_service = runtime.get_service(SIGNAL_SERVICE_NAME)

    if not signal_service or not signal_service.is_service_connected():
        if callback:
            await callback({"text": "Signal service is not available.", "source": "signal"})
        return {"success": False, "error": "Signal service not available"}

    contacts = await signal_service.get_contacts()

    # Filter out blocked contacts and sort by name
    active_contacts = sorted(
        [c for c in contacts if not c.blocked],
        key=lambda c: get_signal_contact_display_name(c).lower(),
    )

    # Format contact list
    contact_list = [
        f"• {get_signal_contact_display_name(c)} ({c.number})"
        for c in active_contacts
    ]

    response_text = f"Found {len(active_contacts)} contacts:\n\n" + "\n".join(contact_list)

    if callback:
        await callback({
            "text": response_text,
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "contact_count": len(active_contacts),
            "contacts": [
                {
                    "number": c.number,
                    "name": get_signal_contact_display_name(c),
                    "uuid": c.uuid,
                }
                for c in active_contacts
            ],
        },
    }


list_contacts_action = {
    "name": "SIGNAL_LIST_CONTACTS",
    "similes": [
        "LIST_SIGNAL_CONTACTS",
        "SHOW_CONTACTS",
        "GET_CONTACTS",
        "SIGNAL_CONTACTS",
    ],
    "description": "List Signal contacts",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {
                "name": "{{user1}}",
                "content": {"text": "Show me my Signal contacts"},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll list your Signal contacts.",
                    "actions": ["SIGNAL_LIST_CONTACTS"],
                },
            },
        ]
    ],
}
