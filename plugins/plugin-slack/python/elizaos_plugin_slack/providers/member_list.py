"""
Member list provider for Slack.
"""

from typing import Any, Dict

from ..types import SLACK_SERVICE_NAME, get_slack_user_display_name


async def get_member_list(runtime: Any, message: Any, state: Any) -> Dict[str, Any]:
    """Get the member list for the current Slack channel."""
    # If message source is not slack, return empty
    if message.content.get("source") != "slack":
        return {"data": {}, "values": {}, "text": ""}
    
    room = state.data.get("room") if state and state.data else None
    if not room:
        room = await runtime.get_room(message.room_id)
    
    if not room or not room.channel_id:
        return {"data": {}, "values": {}, "text": ""}
    
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    if not slack_service or not slack_service.client:
        return {"data": {}, "values": {}, "text": ""}
    
    channel_id = room.channel_id
    
    # Get channel members
    result = await slack_service.client.conversations_members(
        channel=channel_id,
        limit=100,
    )
    
    member_ids = result.get("members", [])
    
    if not member_ids:
        return {
            "data": {"channel_id": channel_id, "member_count": 0, "members": []},
            "values": {"member_count": 0},
            "text": "No members found in this channel.",
        }
    
    # Get user info for each member (limited to first 20 for performance)
    member_limit = 20
    limited_member_ids = member_ids[:member_limit]
    members = []
    
    for member_id in limited_member_ids:
        user = await slack_service.get_user(member_id)
        if user:
            members.append({
                "id": user.id,
                "name": user.name,
                "display_name": get_slack_user_display_name(user),
                "is_bot": user.is_bot,
                "is_admin": user.is_admin or user.is_owner,
            })
    
    # Get channel info for name
    channel = await slack_service.get_channel(channel_id)
    channel_name = channel.name if channel else channel_id
    
    # Format member list
    bot_user_id = slack_service.get_bot_user_id()
    member_descriptions = []
    for m in members:
        tags = []
        if m["id"] == bot_user_id:
            tags.append("this bot")
        if m["is_bot"] and m["id"] != bot_user_id:
            tags.append("bot")
        if m["is_admin"]:
            tags.append("admin")
        tag_str = f" ({', '.join(tags)})" if tags else ""
        member_descriptions.append(f"- {m['display_name']} (@{m['name']}){tag_str}")
    
    truncation_note = ""
    if len(member_ids) > member_limit:
        truncation_note = f"\n\n(Showing {member_limit} of {len(member_ids)} total members)"
    
    response_text = f"Members in #{channel_name}:\n" + "\n".join(member_descriptions) + truncation_note
    
    return {
        "data": {
            "channel_id": channel_id,
            "channel_name": channel_name,
            "member_count": len(member_ids),
            "members": members,
            "has_more_members": len(member_ids) > member_limit,
        },
        "values": {
            "channel_id": channel_id,
            "channel_name": channel_name,
            "member_count": len(member_ids),
        },
        "text": response_text,
    }


member_list_provider = {
    "name": "slackMemberList",
    "description": "Provides information about members in the current Slack channel",
    "get": get_member_list,
}
