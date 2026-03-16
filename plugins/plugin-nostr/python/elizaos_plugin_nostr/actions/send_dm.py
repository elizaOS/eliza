"""
Send DM action for Nostr plugin.
"""

import json
import logging
import re

from ..types import (
    NOSTR_SERVICE_NAME,
    NostrDmSendOptions,
    is_valid_pubkey,
    normalize_pubkey,
    split_message_for_nostr,
)

logger = logging.getLogger(__name__)

SEND_DM_TEMPLATE = """# Task: Extract Nostr DM parameters
Based on the conversation, determine what message to send and to whom.

Recent conversation:
{recent_messages}

Extract the following:
- text: The message content to send
- toPubkey: The target pubkey (npub or hex format, or "current" for the current conversation)

Respond with a JSON object:
```json
{{
  "text": "message content here",
  "toPubkey": "npub1... or hex pubkey or current"
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
    """Handle the send DM action."""
    nostr_service = runtime.get_service(NOSTR_SERVICE_NAME)

    if not nostr_service or not nostr_service.is_connected():
        if callback:
            await callback({"text": "Nostr service is not available.", "source": "nostr"})
        return {"success": False, "error": "Nostr service not available"}

    # Build prompt
    recent_messages = state.get("recentMessages", "") if state else ""
    prompt = SEND_DM_TEMPLATE.format(recent_messages=recent_messages)

    # Extract parameters using LLM
    dm_info = None
    for _ in range(3):
        response = await runtime.use_model("TEXT_SMALL", {"prompt": prompt})

        try:
            json_match = re.search(r"\{[^{}]*\}", response, re.DOTALL)
            if json_match:
                parsed = json.loads(json_match.group())
                if parsed.get("text"):
                    dm_info = {
                        "text": str(parsed["text"]),
                        "to_pubkey": str(parsed.get("toPubkey", "current")),
                    }
                    break
        except (json.JSONDecodeError, ValueError):
            continue

    if not dm_info or not dm_info.get("text"):
        if callback:
            await callback({
                "text": "I couldn't understand what message you want me to send.",
                "source": "nostr",
            })
        return {"success": False, "error": "Could not extract message parameters"}

    # Determine target pubkey
    target_pubkey = None
    if dm_info["to_pubkey"] and dm_info["to_pubkey"] != "current":
        if is_valid_pubkey(dm_info["to_pubkey"]):
            try:
                target_pubkey = normalize_pubkey(dm_info["to_pubkey"])
            except Exception:
                pass

    # Get pubkey from state if available
    if not target_pubkey:
        state_data = state.get("data", {}) if state else {}
        target_pubkey = state_data.get("senderPubkey")

    if not target_pubkey:
        if callback:
            await callback({
                "text": "I couldn't determine who to send the message to.",
                "source": "nostr",
            })
        return {"success": False, "error": "Could not determine target pubkey"}

    # Split message if too long
    chunks = split_message_for_nostr(dm_info["text"])

    # Send message(s)
    last_result = None
    for chunk in chunks:
        opts = NostrDmSendOptions(to_pubkey=target_pubkey, text=chunk)
        result = await nostr_service.send_dm(opts)

        if not result.success:
            if callback:
                await callback({
                    "text": f"Failed to send message: {result.error}",
                    "source": "nostr",
                })
            return {"success": False, "error": result.error}

        last_result = {"event_id": result.event_id, "relays": result.relays}

    if callback:
        await callback({
            "text": "Message sent successfully.",
            "source": message.content.get("source"),
        })

    return {
        "success": True,
        "data": {
            "to_pubkey": target_pubkey,
            "event_id": last_result.get("event_id") if last_result else None,
            "relays": last_result.get("relays") if last_result else [],
            "chunks_count": len(chunks),
        },
    }


send_dm_action = {
    "name": "NOSTR_SEND_DM",
    "similes": [
        "SEND_NOSTR_DM",
        "NOSTR_MESSAGE",
        "NOSTR_TEXT",
        "DM_NOSTR",
    ],
    "description": "Send an encrypted direct message via Nostr (NIP-04)",
    "validate": validate,
    "handler": handler,
    "examples": [
        [
            {"name": "{{user1}}", "content": {"text": "Send them a message saying 'Hello!'"}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": "I'll send that DM via Nostr.",
                    "actions": ["NOSTR_SEND_DM"],
                },
            },
        ],
    ],
}
