import hashlib
import hmac
import secrets
import time
from typing import Any

import httpx

from elizaos_plugin_nextcloud_talk.error import ApiError, SignatureVerificationError
from elizaos_plugin_nextcloud_talk.types import (
    NextcloudTalkInboundMessage,
    NextcloudTalkSendResult,
    NextcloudTalkWebhookHeaders,
    NextcloudTalkWebhookPayload,
)


def verify_signature(signature: str, random: str, body: str, secret: str) -> bool:
    """
    Verify the HMAC-SHA256 signature of an incoming webhook request.
    Signature is calculated as: HMAC-SHA256(random + body, secret)
    """
    if not signature or not random or not secret:
        return False

    expected = hmac.new(
        secret.encode("utf-8"),
        (random + body).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(signature, expected)


def generate_signature(body: str, secret: str) -> tuple[str, str]:
    """Generate signature headers for an outbound request to Nextcloud Talk."""
    random = secrets.token_hex(32)
    signature = hmac.new(
        secret.encode("utf-8"),
        (random + body).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return random, signature


def extract_webhook_headers(headers: dict[str, str]) -> NextcloudTalkWebhookHeaders | None:
    """Extract webhook headers from an HTTP request."""
    signature = headers.get("x-nextcloud-talk-signature") or headers.get(
        "X-Nextcloud-Talk-Signature"
    )
    random = headers.get("x-nextcloud-talk-random") or headers.get("X-Nextcloud-Talk-Random")
    backend = headers.get("x-nextcloud-talk-backend") or headers.get("X-Nextcloud-Talk-Backend")

    if not signature or not random or not backend:
        return None

    return NextcloudTalkWebhookHeaders(signature=signature, random=random, backend=backend)


def parse_webhook_payload(payload: NextcloudTalkWebhookPayload) -> NextcloudTalkInboundMessage:
    """Parse the webhook payload into an inbound message."""
    return NextcloudTalkInboundMessage(
        message_id=payload.object.id,
        room_token=payload.target.id,
        room_name=payload.target.name,
        sender_id=payload.actor.id,
        sender_name=payload.actor.name,
        text=payload.object.content,
        media_type=payload.object.media_type,
        timestamp=int(time.time()),
        is_group_chat=False,  # Will be determined by service based on room info
    )


async def send_message(
    base_url: str,
    secret: str,
    room_token: str,
    message: str,
    reply_to: str | None = None,
) -> NextcloudTalkSendResult:
    """Send a message to a Nextcloud Talk room."""
    if not message.strip():
        raise ValueError("Message must be non-empty")

    body: dict[str, Any] = {"message": message.strip()}
    if reply_to:
        body["replyTo"] = reply_to

    import json

    body_str = json.dumps(body)
    random, signature = generate_signature(body_str, secret)

    url = f"{base_url}/ocs/v2.php/apps/spreed/api/v1/bot/{room_token}/message"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=body_str,
            headers={
                "Content-Type": "application/json",
                "OCS-APIRequest": "true",
                "X-Nextcloud-Talk-Bot-Random": random,
                "X-Nextcloud-Talk-Bot-Signature": signature,
            },
        )

    if not response.is_success:
        status = response.status_code
        error_body = response.text

        if status == 400:
            error_msg = f"Bad request: {error_body or 'invalid message format'}"
        elif status == 401:
            error_msg = "Authentication failed - check bot secret"
        elif status == 403:
            error_msg = "Forbidden - bot may not have permission in this room"
        elif status == 404:
            error_msg = f"Room not found (token={room_token})"
        else:
            error_msg = f"Send failed: {error_body}"

        raise ApiError(status, error_msg)

    message_id = "unknown"
    timestamp = None

    try:
        data = response.json()
        if data.get("ocs", {}).get("data", {}).get("id") is not None:
            message_id = str(data["ocs"]["data"]["id"])
        if isinstance(data.get("ocs", {}).get("data", {}).get("timestamp"), int):
            timestamp = data["ocs"]["data"]["timestamp"]
    except Exception:
        pass

    return NextcloudTalkSendResult(
        message_id=message_id,
        room_token=room_token,
        timestamp=timestamp,
    )


async def send_reaction(
    base_url: str,
    secret: str,
    room_token: str,
    message_id: str,
    reaction: str,
) -> None:
    """Send a reaction to a message in Nextcloud Talk."""
    import json

    body = json.dumps({"reaction": reaction})
    random, signature = generate_signature(body, secret)

    url = f"{base_url}/ocs/v2.php/apps/spreed/api/v1/bot/{room_token}/reaction/{message_id}"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=body,
            headers={
                "Content-Type": "application/json",
                "OCS-APIRequest": "true",
                "X-Nextcloud-Talk-Bot-Random": random,
                "X-Nextcloud-Talk-Bot-Signature": signature,
            },
        )

    if not response.is_success:
        raise ApiError(response.status_code, f"Reaction failed: {response.text}")
