"""
Publish profile action for Nostr plugin.
"""

import json
import logging
import re

from ..types import NOSTR_SERVICE_NAME, NostrProfile

logger = logging.getLogger(__name__)

PUBLISH_PROFILE_TEMPLATE = """# Task: Extract Nostr profile data
Based on the conversation, determine what profile information to update.

Recent conversation:
{recent_messages}

Extract any of the following profile fields that should be updated:
- name: Display name
- about: Bio/description
- picture: Profile picture URL
- banner: Banner image URL
- nip05: Nostr verification (user@domain.com)
- lud16: Lightning address (user@domain.com)
- website: Website URL

Respond with a JSON object containing only the fields to update:
```json
{{
  "name": "optional name",
  "about": "optional bio"
}}
```"""


async def validate(runtime, message, state: dict | None = None) -> bool:
    """Validate that this action can be executed."""
    return message.content.get("source") == "nostr"


async def handler(
    runtime,
    message,
    state: dict | None = None,
    options: dict | None = None,
    callback=None,
):
    """Handle the publish profile action."""
    nostr_service = runtime.get_service(NOSTR_SERVICE_NAME)

    if not nostr_service or not nostr_service.is_connected():
        if callback:
            await callback({"text": "Nostr service is not available.", "source": "nostr"})
        return {"success": False, "error": "Nostr service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = PUBLISH_PROFILE_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    profile_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                profile_info = NostrProfile(
                    name=parsed.get("name"),
                    display_name=parsed.get("displayName"),
                    about=parsed.get("about"),
                    picture=parsed.get("picture"),
                    banner=parsed.get("banner"),
                    nip05=parsed.get("nip05"),
                    lud16=parsed.get("lud16"),
                    website=parsed.get("website"),
                )
                break
        except (json.JSONDecodeError, ValueError):
            continue

    if not profile_info:
        if callback:
            await callback({
                "text": "I couldn't understand the profile information.",
                "source": "nostr",
            })
        return {"success": False, "error": "Could not extract profile parameters"}

    # Publish profile
    result = await nostr_service.publish_profile(profile_info)

    if not result.success:
        if callback:
            await callback({
                "text": f"Failed to publish profile: {result.error}",
                "source": "nostr",
            })
        return {"success": False, "error": result.error}

    if callback:
        await callback({
            "text": "Profile published successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "event_id": result.event_id,
            "relays": result.relays,
        },
    }


publish_profile_action = {
    "name": "NOSTR_PUBLISH_PROFILE",
    "similes": [
        "UPDATE_NOSTR_PROFILE",
        "SET_NOSTR_PROFILE",
        "NOSTR_PROFILE",
    ],
    "description": "Publish or update the bot's Nostr profile (kind:0 metadata)",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Update your profile name to 'Bot Assistant'"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll update my Nostr profile.",
                    "actions": ["NOSTR_PUBLISH_PROFILE"],
                },
            },
        ],
    ],
}
