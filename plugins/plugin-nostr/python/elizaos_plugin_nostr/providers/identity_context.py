"""
Identity context provider for Nostr plugin.
"""


from ..types import NOSTR_SERVICE_NAME


async def get_identity_context(
    runtime,
    message,
    state: dict | None = None,
):
    """Get the bot's Nostr identity context."""
    if message.content.get("source") != "nostr":
        return {"data": {}, "values": {}, "text": ""}

    nostr_service = runtime.get_service(NOSTR_SERVICE_NAME)

    if not nostr_service or not nostr_service.is_connected():
        return {"data": {"connected": False}, "values": {"connected": False}, "text": ""}

    agent_name = state.get("agentName", "The agent") if state else "The agent"
    public_key = nostr_service.get_public_key()
    npub = nostr_service.get_npub()
    relays = nostr_service.get_relays()

    response_text = (
        f"{agent_name} is connected to Nostr with pubkey {npub}. "
        f"Connected to {len(relays)} relay(s): {', '.join(relays)}. "
        f"Nostr is a decentralized social protocol using cryptographic keys for identity."
    )

    return {
        "data": {
            "public_key": public_key,
            "npub": npub,
            "relays": relays,
            "relay_count": len(relays),
            "connected": True,
        },
        "values": {
            "public_key": public_key,
            "npub": npub,
            "relay_count": len(relays),
        },
        "text": response_text,
    }


identity_context_provider = {
    "name": "nostrIdentityContext",
    "description": "Provides information about the bot's Nostr identity",
    "get": get_identity_context,
}
