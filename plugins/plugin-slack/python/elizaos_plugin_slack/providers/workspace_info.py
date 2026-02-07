"""
Workspace info provider for Slack.
"""

from typing import Any, Dict

from ..types import SLACK_SERVICE_NAME


async def get_workspace_info(runtime: Any, message: Any, state: Any) -> Dict[str, Any]:
    """Get Slack workspace information."""
    # If message source is not slack, return empty
    if message.content.get("source") != "slack":
        return {"data": {}, "values": {}, "text": ""}
    
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    if not slack_service or not slack_service.client:
        return {"data": {}, "values": {}, "text": ""}
    
    team_id = slack_service.get_team_id()
    bot_user_id = slack_service.get_bot_user_id()
    is_connected = slack_service.is_service_connected()
    
    workspace_name = ""
    domain = ""
    
    # Get workspace info from world if available
    room = state.data.get("room") if state and state.data else None
    if not room:
        room = await runtime.get_room(message.room_id)
    
    if room and room.world_id:
        world = await runtime.get_world(room.world_id)
        if world:
            workspace_name = world.name
            domain = world.metadata.get("domain", "") if world.metadata else ""
    
    # Get channel statistics
    channels = await slack_service.list_channels(types="public_channel,private_channel")
    public_channels = [ch for ch in channels if not ch.is_private and not ch.is_archived]
    private_channels = [ch for ch in channels if ch.is_private and not ch.is_archived]
    member_channels = [ch for ch in channels if ch.is_member and not ch.is_archived]
    
    # Get allowed channels
    allowed_channel_ids = slack_service.get_allowed_channel_ids()
    has_channel_restrictions = len(allowed_channel_ids) > 0
    
    agent_name = state.agent_name if state else "The agent"
    
    response_text = f"{agent_name} is connected to the Slack workspace"
    if workspace_name:
        response_text += f' "{workspace_name}"'
    if domain:
        response_text += f" ({domain}.slack.com)"
    response_text += "."
    
    response_text += "\n\nWorkspace statistics:"
    response_text += f"\n- Public channels: {len(public_channels)}"
    response_text += f"\n- Private channels: {len(private_channels)}"
    response_text += f"\n- Channels the bot is a member of: {len(member_channels)}"
    
    if has_channel_restrictions:
        response_text += f"\n\nNote: The bot is restricted to {len(allowed_channel_ids)} specific channel(s)."
    
    return {
        "data": {
            "team_id": team_id,
            "bot_user_id": bot_user_id,
            "workspace_name": workspace_name,
            "domain": domain,
            "is_connected": is_connected,
            "public_channel_count": len(public_channels),
            "private_channel_count": len(private_channels),
            "member_channel_count": len(member_channels),
            "has_channel_restrictions": has_channel_restrictions,
            "allowed_channel_ids": allowed_channel_ids,
        },
        "values": {
            "team_id": team_id or "",
            "bot_user_id": bot_user_id or "",
            "workspace_name": workspace_name,
            "domain": domain,
            "is_connected": is_connected,
            "public_channel_count": len(public_channels),
            "private_channel_count": len(private_channels),
            "member_channel_count": len(member_channels),
        },
        "text": response_text,
    }


workspace_info_provider = {
    "name": "slackWorkspaceInfo",
    "description": "Provides information about the Slack workspace",
    "get": get_workspace_info,
}
