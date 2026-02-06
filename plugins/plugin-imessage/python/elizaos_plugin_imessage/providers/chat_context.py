"""
Chat context provider for the iMessage plugin.
"""


from ..types import IMESSAGE_SERVICE_NAME


async def get_chat_context(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the current iMessage chat context."""
    if message.content.get("source") != "imessage":
        return {"data": {}, "values": {}, "text": ""}

    imessage_service = runtime.get_service(IMESSAGE_SERVICE_NAME)

    if not imessage_service or not imessage_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"
    state_data = state.get("data", {}) if state else {}

    handle = state_data.get("handle")
    chat_id = state_data.get("chatId")
    chat_type = state_data.get("chatType", "direct")
    display_name = state_data.get("displayName")

    if chat_type == "group":
        chat_description = f'group chat "{display_name}"' if display_name else "a group chat"
    else:
        chat_description = f"direct message with {handle}" if handle else "a direct message"

    response_text = (
        f"{agent_name} is chatting via iMessage in {chat_description}. "
        "iMessage supports text messages and attachments."
    )

    return {
        "data": {
            "handle": handle,
            "chat_id": chat_id,
            "chat_type": chat_type,
            "display_name": display_name,
            "connected": True,
            "platform": "imessage",
        },
        "values": {
            "handle": handle,
            "chat_id": chat_id,
            "chat_type": chat_type,
            "display_name": display_name,
        },
        "text": response_text,
    }


chat_context_provider = {
    "name": "imessageChatContext",
    "description": "Provides information about the current iMessage chat context",
    "get": get_chat_context,
}
