"""
Get user info action for Slack.
"""

from typing import Any, Dict, Optional

from ..types import SLACK_SERVICE_NAME, is_valid_user_id, get_slack_user_display_name


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
    """Handle the get user info action."""
    slack_service = runtime.get_service(SLACK_SERVICE_NAME)
    
    if not slack_service or not slack_service.client:
        if callback:
            await callback({"text": "Slack service is not available.", "source": "slack"})
        return {"success": False, "error": "Slack service not available"}
    
    user_id = options.get("user_id") if options else None
    
    if not user_id:
        if callback:
            await callback({
                "text": "Please specify a user ID.",
                "source": "slack",
            })
        return {"success": False, "error": "Missing user_id"}
    
    if not is_valid_user_id(user_id):
        if callback:
            await callback({
                "text": "Invalid user ID format. Slack user IDs start with U.",
                "source": "slack",
            })
        return {"success": False, "error": "Invalid user ID format"}
    
    user = await slack_service.get_user(user_id)
    
    if not user:
        if callback:
            await callback({
                "text": f"Could not find user with ID {user_id}.",
                "source": "slack",
            })
        return {"success": False, "error": "User not found"}
    
    display_name = get_slack_user_display_name(user)
    
    roles = []
    if user.is_admin:
        roles.append("Admin")
    if user.is_owner:
        roles.append("Owner")
    if user.is_primary_owner:
        roles.append("Primary Owner")
    if user.is_bot:
        roles.append("Bot")
    if user.is_restricted:
        roles.append("Guest")
    
    details = [f"**Name:** {display_name}"]
    if user.profile.real_name and user.profile.real_name != display_name:
        details.append(f"**Real Name:** {user.profile.real_name}")
    details.append(f"**Username:** @{user.name}")
    if user.profile.title:
        details.append(f"**Title:** {user.profile.title}")
    if user.profile.email:
        details.append(f"**Email:** {user.profile.email}")
    if user.tz:
        details.append(f"**Timezone:** {user.tz_label or user.tz}")
    if user.profile.status_text:
        emoji = user.profile.status_emoji or ""
        details.append(f"**Status:** {emoji} {user.profile.status_text}")
    if roles:
        details.append(f"**Roles:** {', '.join(roles)}")
    
    if callback:
        await callback({
            "text": f"User information for {display_name}:\n\n" + "\n".join(details),
            "source": "slack",
        })
    
    return {
        "success": True,
        "data": {
            "user_id": user.id,
            "name": user.name,
            "display_name": display_name,
            "real_name": user.profile.real_name,
            "title": user.profile.title,
            "email": user.profile.email,
            "timezone": user.tz,
            "is_admin": user.is_admin,
            "is_owner": user.is_owner,
            "is_bot": user.is_bot,
            "status_text": user.profile.status_text,
            "status_emoji": user.profile.status_emoji,
            "avatar": user.profile.image_192 or user.profile.image_72,
        },
    }


get_user_info = {
    "name": "SLACK_GET_USER_INFO",
    "similes": ["GET_SLACK_USER", "USER_INFO", "SLACK_USER", "WHO_IS"],
    "description": "Get information about a Slack user",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Who is U0123456789?"}},
            {"name": "{{agent}}", "content": {"text": "Let me look up that user.", "actions": ["SLACK_GET_USER_INFO"]}},
        ],
    ],
}
