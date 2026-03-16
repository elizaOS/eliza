"""MS Teams Bot Framework client implementation."""

import logging
import re
import time
import uuid
from collections.abc import Callable

import httpx

from elizaos_plugin_msteams.config import MSTeamsConfig, MSTeamsCredentials
from elizaos_plugin_msteams.types import (
    MSTeamsConversationReference,
    MSTeamsMention,
    MSTeamsSendOptions,
    MSTeamsSendResult,
)

logger = logging.getLogger(__name__)

# Maximum message length for MS Teams
MAX_MESSAGE_LENGTH = 4000

# MS Teams media size limit (100MB)
MAX_MEDIA_BYTES = 100 * 1024 * 1024

# Bot Framework OAuth token endpoint
TOKEN_ENDPOINT = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"


class MSTeamsClient:
    """MS Teams Bot Framework client."""

    def __init__(self, config: MSTeamsConfig) -> None:
        """Initialize the client with configuration."""
        self.config = config
        self.credentials = MSTeamsCredentials.from_config(config)
        self._http_client = httpx.AsyncClient()
        self._conversation_refs: dict[str, MSTeamsConversationReference] = {}
        self._cached_token: str | None = None
        self._token_expires_at: float = 0

    async def close(self) -> None:
        """Close the HTTP client."""
        await self._http_client.aclose()

    def store_conversation_reference(self, conv_ref: MSTeamsConversationReference) -> None:
        """Store a conversation reference for proactive messaging."""
        conv_id = conv_ref.conversation.id
        self._conversation_refs[conv_id] = conv_ref

    def get_conversation_reference(
        self, conversation_id: str
    ) -> MSTeamsConversationReference | None:
        """Get a stored conversation reference."""
        return self._conversation_refs.get(conversation_id)

    async def _get_access_token(self) -> str:
        """Get an access token for the Bot Framework."""
        # Check cache
        if self._cached_token and time.time() < self._token_expires_at:
            return self._cached_token

        # Fetch new token
        data = {
            "grant_type": "client_credentials",
            "client_id": self.credentials.app_id,
            "client_secret": self.credentials.app_password,
            "scope": "https://api.botframework.com/.default",
        }

        response = await self._http_client.post(TOKEN_ENDPOINT, data=data)
        response.raise_for_status()

        token_data = response.json()
        self._cached_token = token_data["access_token"]
        # Cache with 5 minute buffer
        expires_in = token_data.get("expires_in", 3600)
        self._token_expires_at = time.time() + expires_in - 300

        return self._cached_token

    async def send_proactive_message(
        self,
        conversation_id: str,
        text: str,
        options: MSTeamsSendOptions | None = None,
    ) -> MSTeamsSendResult:
        """Send a proactive message to a conversation."""
        conv_ref = self._conversation_refs.get(conversation_id)
        if not conv_ref:
            raise ValueError(f"No conversation reference found for {conversation_id}")

        if not conv_ref.service_url:
            raise ValueError("Missing service URL in conversation reference")

        token = await self._get_access_token()

        url = f"{conv_ref.service_url.rstrip('/')}/v3/conversations/{conversation_id}/activities"

        activity: dict = {
            "type": "message",
            "text": text,
        }

        if options:
            if options.reply_to_id:
                activity["replyToId"] = options.reply_to_id

            if options.adaptive_card:
                activity["attachments"] = [
                    {
                        "contentType": "application/vnd.microsoft.card.adaptive",
                        "content": options.adaptive_card,
                    }
                ]

            if options.mentions:
                activity["entities"] = [
                    {
                        "type": "mention",
                        "mentioned": {
                            "id": m.mentioned.id,
                            "name": m.mentioned.name,
                        },
                        "text": m.text,
                    }
                    for m in options.mentions
                ]

        response = await self._http_client.post(
            url,
            json=activity,
            headers={"Authorization": f"Bearer {token}"},
        )
        response.raise_for_status()

        result = response.json()
        return MSTeamsSendResult(
            message_id=result.get("id", ""),
            conversation_id=conversation_id,
            activity_id=result.get("id"),
        )

    async def send_adaptive_card(
        self,
        conversation_id: str,
        card: dict,
        fallback_text: str | None = None,
    ) -> MSTeamsSendResult:
        """Send an Adaptive Card to a conversation."""
        options = MSTeamsSendOptions(adaptive_card=card)
        return await self.send_proactive_message(
            conversation_id, fallback_text or "", options
        )

    async def send_poll(
        self,
        conversation_id: str,
        question: str,
        options: list[str],
        max_selections: int = 1,
    ) -> tuple[MSTeamsSendResult, str]:
        """Send a poll as an Adaptive Card."""
        poll_id = str(uuid.uuid4())
        capped_max = min(max(1, max_selections), len(options))

        choices = [{"title": opt, "value": str(i)} for i, opt in enumerate(options)]

        hint = (
            f"Select up to {capped_max} options."
            if capped_max > 1
            else "Select one option."
        )

        card = {
            "type": "AdaptiveCard",
            "version": "1.5",
            "body": [
                {
                    "type": "TextBlock",
                    "text": question,
                    "wrap": True,
                    "weight": "Bolder",
                    "size": "Medium",
                },
                {
                    "type": "Input.ChoiceSet",
                    "id": "choices",
                    "isMultiSelect": capped_max > 1,
                    "style": "expanded",
                    "choices": choices,
                },
                {
                    "type": "TextBlock",
                    "text": hint,
                    "wrap": True,
                    "isSubtle": True,
                    "spacing": "Small",
                },
            ],
            "actions": [
                {
                    "type": "Action.Submit",
                    "title": "Vote",
                    "data": {"pollId": poll_id, "action": "vote"},
                }
            ],
        }

        fallback_lines = [f"Poll: {question}"] + [
            f"{i + 1}. {opt}" for i, opt in enumerate(options)
        ]

        result = await self.send_adaptive_card(
            conversation_id, card, "\n".join(fallback_lines)
        )
        return result, poll_id

    async def reply_to_message(
        self,
        conversation_id: str,
        reply_to_id: str,
        text: str,
    ) -> MSTeamsSendResult:
        """Reply to a message in a conversation."""
        options = MSTeamsSendOptions(reply_to_id=reply_to_id)
        return await self.send_proactive_message(conversation_id, text, options)

    @staticmethod
    def split_message(text: str) -> list[str]:
        """Split a long message into chunks."""
        if len(text) <= MAX_MESSAGE_LENGTH:
            return [text]

        parts: list[str] = []
        current = ""

        for line in text.split("\n"):
            line_with_newline = line if not current else f"\n{line}"

            if len(current) + len(line_with_newline) > MAX_MESSAGE_LENGTH:
                if current:
                    parts.append(current)
                    current = ""

                if len(line) > MAX_MESSAGE_LENGTH:
                    # Split by words
                    words = line.split()
                    for word in words:
                        word_with_space = word if not current else f" {word}"
                        if len(current) + len(word_with_space) > MAX_MESSAGE_LENGTH:
                            if current:
                                parts.append(current)
                                current = ""
                            if len(word) > MAX_MESSAGE_LENGTH:
                                # Split by characters
                                for i in range(0, len(word), MAX_MESSAGE_LENGTH):
                                    parts.append(word[i : i + MAX_MESSAGE_LENGTH])
                            else:
                                current = word
                        else:
                            current += word_with_space
                else:
                    current = line
            else:
                current += line_with_newline

        if current:
            parts.append(current)

        return parts

    @staticmethod
    def strip_mention_tags(text: str) -> str:
        """Strip mention tags from message text."""
        # Teams wraps mentions in <at>...</at> tags
        return re.sub(r"<at[^>]*>.*?</at>", "", text, flags=re.IGNORECASE).strip()
