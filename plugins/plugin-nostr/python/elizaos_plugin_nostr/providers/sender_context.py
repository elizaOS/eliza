"""
Sender context provider for Nostr plugin.
"""


from ..types import (
    NOSTR_SERVICE_NAME,
    NostrCryptoError,
    get_pubkey_display_name,
    pubkey_to_npub,
)


async def get_sender_context(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the Nostr sender context."""
    if message.content.get("source") != "nostr":
        return {"data": {}, "values": {}, "text": ""}

    nostr_service = runtime.get_service(NOSTR_SERVICE_NAME)

    if not nostr_service or not nostr_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"

    # Get sender pubkey from state
    state_data = state.get("data", {}) if state else {}
    sender_pubkey = state_data.get("senderPubkey")

    if not sender_pubkey:
        return {"data": {"connected": True}, "values": {"connected": True}, "text": ""}

    sender_npub = ""
    try:
        sender_npub = pubkey_to_npub(sender_pubkey)
    except NostrCryptoError:
        pass

    display_name = get_pubkey_display_name(sender_pubkey)

    response_text = (
        f"{agent_name} is talking to {display_name} on Nostr. "
        f"Their pubkey is {sender_npub or sender_pubkey}. "
        f"This is an encrypted direct message conversation using NIP-04."
    )

    return {
        "data": {
            "sender_pubkey": sender_pubkey,
            "sender_npub": sender_npub,
            "display_name": display_name,
            "is_encrypted": True,
        },
        "values": {
            "sender_pubkey": sender_pubkey,
            "sender_npub": sender_npub,
            "display_name": display_name,
        },
        "text": response_text,
    }


sender_context_provider = {
    "name": "nostrSenderContext",
    "description": "Provides information about the Nostr user in the current conversation",
    "get": get_sender_context,
}
