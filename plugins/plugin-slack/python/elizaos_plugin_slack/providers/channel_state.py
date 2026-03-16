"""
Channel state provider for Slack.
"""

from typing import Any, Dict, Optional

from ..types import SLACK_SERVICE_NAME, get_slack_channel_type


async def get_channel_state(runtime: Any, message: Any, state: Any) -> Dict[str, Any]:
    """Get the current Slack channel state."""
    room = state.data.get("room") if state and state.data else None
    if not room:
        room = await runtime.get_room(message.room_id)
    
    if not room:
        return {"data": {}, "values": {}, "text": ""}
    
    # If message source is not slack, return empty
    if message.content.get("source") != "slack":
        return {"data": {}, "values": {}, "text": ""}
    
    agent_name = state.agent_name if state else "The agent"
    sender_name = state.sender_name if state else "someone"
    
    response_text = ""
    channel_type = ""
    workspace_name = ""
    channel_name = ""
    channel_id = room.channel_id or ""
    thread_ts = room.metadata.get("thread_ts") if room.metadata else None
    
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    if not slack_service or not slack_service.client:
        return {
            "data": {"room": room, "channel_type": "unknown", "channel_id": channel_id},
            "values": {"channel_type": "unknown", "channel_id": channel_id},
            "text": "",
        }
    
    # Get channel info
    channel = await slack_service.get_channel(channel_id) if channel_id else None
    
    if channel:
        channel_name = channel.name
        slack_channel_type = get_slack_channel_type(channel)
        
        if slack_channel_type == "im":
            channel_type = "DM"
            response_text = f"{agent_name} is currently in a direct message conversation with {sender_name} on Slack. {agent_name} should engage in conversation, responding to messages that are addressed to them."
        elif slack_channel_type == "mpim":
            channel_type = "GROUP_DM"
            response_text = f"{agent_name} is currently in a group direct message on Slack. {agent_name} should be aware that multiple people can see this conversation."
        else:
            channel_type = "PRIVATE_CHANNEL" if slack_channel_type == "group" else "PUBLIC_CHANNEL"
            
            if thread_ts:
                response_text = f"{agent_name} is currently in a thread within the channel #{channel_name} on Slack."
                response_text += f"\n{agent_name} should keep responses focused on the thread topic and be mindful of thread etiquette."
            else:
                response_text = f"{agent_name} is currently having a conversation in the Slack channel #{channel_name}."
                response_text += f"\n{agent_name} is in a channel with other users and should only participate when directly addressed or when the conversation is relevant to them."
            
            if channel.topic and channel.topic.value:
                response_text += f"\nChannel topic: {channel.topic.value}"
            if channel.purpose and channel.purpose.value:
                response_text += f"\nChannel purpose: {channel.purpose.value}"
    else:
        channel_type = "unknown"
        response_text = f"{agent_name} is in a Slack conversation but couldn't retrieve channel details."
    
    # Add workspace context if available
    team_id = slack_service.get_team_id()
    if team_id and room.world_id:
        world = await runtime.get_world(room.world_id)
        if world:
            workspace_name = world.name
            response_text += f"\nWorkspace: {workspace_name}"
    
    # Add thread context if applicable
    if thread_ts:
        response_text += f"\nThis is a threaded conversation (thread timestamp: {thread_ts})."
    
    return {
        "data": {
            "room": room,
            "channel_type": channel_type,
            "workspace_name": workspace_name,
            "channel_name": channel_name,
            "channel_id": channel_id,
            "thread_ts": thread_ts,
            "is_thread": bool(thread_ts),
            "topic": channel.topic.value if channel and channel.topic else None,
            "purpose": channel.purpose.value if channel and channel.purpose else None,
            "is_private": channel.is_private if channel else None,
            "num_members": channel.num_members if channel else None,
        },
        "values": {
            "channel_type": channel_type,
            "workspace_name": workspace_name,
            "channel_name": channel_name,
            "channel_id": channel_id,
            "is_thread": bool(thread_ts),
        },
        "text": response_text,
    }


channel_state_provider = {
    "name": "slackChannelState",
    "description": "Provides information about the current Slack channel context",
    "get": get_channel_state,
}
