"""
Chat context provider for the LINE plugin.
"""


from ..types import LINE_SERVICE_NAME


async def get_chat_context(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the current LINE chat context."""
    if message.content.get("source") != "line":
        return {"data": {}, "values": {}, "text": ""}

    line_service = runtime.get_service(LINE_SERVICE_NAME)

    if not line_service or not line_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"
    state_data = state.get("data", {}) if state else {}

    user_id = state_data.get("userId")
    group_id = state_data.get("groupId")
    room_id = state_data.get("roomId")

    chat_type = "user"
    chat_id = user_id or ""

    if group_id:
        chat_type = "group"
        chat_id = group_id
    elif room_id:
        chat_type = "room"
        chat_id = room_id

    # Get additional info based on chat type
    chat_name = ""
    member_count = None

    if chat_type == "group" and group_id:
        group_info = await line_service.get_group_info(group_id)
        if group_info:
            chat_name = group_info.group_name or ""
            member_count = group_info.member_count

    response_text = f"{agent_name} is chatting on LINE "

    if chat_type == "user":
        response_text += "in a direct message conversation."
    elif chat_type == "group":
        response_text += f'in group "{chat_name or chat_id}".'
        if member_count:
            response_text += f" The group has {member_count} members."
    elif chat_type == "room":
        response_text += "in a multi-person chat room."

    response_text += (
        " LINE supports text messages, images, locations, rich cards (flex messages), and quick replies."
    )

    return {
        "data": {
            "chat_type": chat_type,
            "chat_id": chat_id,
            "user_id": user_id,
            "group_id": group_id,
            "room_id": room_id,
            "chat_name": chat_name,
            "member_count": member_count,
            "connected": True,
        },
        "values": {
            "chat_type": chat_type,
            "chat_id": chat_id,
            "chat_name": chat_name,
        },
        "text": response_text,
    }


chat_context_provider = {
    "name": "lineChatContext",
    "description": "Provides information about the current LINE chat context",
    "get": get_chat_context,
}
