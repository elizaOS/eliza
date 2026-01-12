from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.types.components import ActionResult, HandlerCallback, HandlerOptions
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

import logging

from elizaos.types.components import Action, ActionExample
from elizaos.types.model import ModelType

from elizaos_plugin_xai.client import TwitterClient

logger: logging.Logger | None = None


def _get_logger() -> logging.Logger:
    global logger
    if logger is None:
        from elizaos.logger import create_logger

        logger = create_logger(__name__)
    return logger


@dataclass
class PostActionResult:
    success: bool
    text: str | None = None
    error: str | None = None
    post_id: str | None = None
    post_url: str | None = None


async def validate_post(
    runtime: IAgentRuntime,
    _message: Memory | None = None,
    _state: State | None = None,
) -> bool:
    try:
        service = runtime.get_service("x")
        return service is not None
    except Exception:
        return False


async def handle_post(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
    _options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    _responses: list[Memory] | None = None,
) -> ActionResult:
    log = _get_logger()
    log.info("Executing POST action")

    try:
        service = runtime.get_service("x")
        if not service:
            raise RuntimeError("X service not available")

        if not hasattr(service, "client") or not isinstance(service.client, TwitterClient):
            raise RuntimeError("X client not available or invalid")

        client: TwitterClient = service.client

        try:
            profile = await client.me()
        except Exception as e:
            raise RuntimeError(f"X client not initialized - {e}") from e

        text = ""
        if message.content:
            if isinstance(message.content, dict):
                text = message.content.get("text", "")
            elif hasattr(message.content, "text"):
                text = message.content.text or ""
            else:
                text = str(message.content)

        text = text.strip() if text else ""

        if not text:
            error_msg = "I need something to post! Please provide the text."
            if callback:
                await callback({"text": error_msg, "action": "POST"})
            return {"success": False, "error": "No text provided"}

        if len(text) > 280:
            sentences = re.findall(r"[^.!?]+[.!?]+", text) or [text]
            truncated = ""
            for sentence in sentences:
                if len(truncated + sentence) <= 280:
                    truncated += sentence
                else:
                    break
            text = truncated.strip() or f"{text[:277]}..."

        final_text = text
        if len(text) < 50 or "post" in text.lower():
            character = runtime.character
            topics = ", ".join(character.topics) if character.topics else "technology, AI"

            prompt = f"""You are {character.name}.
{character.bio or ""}

Generate a post based on: {text}

Style:
- Be specific, opinionated, authentic
- No generic content or platitudes
- Share insights, hot takes, unique perspectives
- Conversational and punchy
- Under 280 characters
- Skip hashtags unless essential

Topics: {topics}

Post:"""

            try:
                response = await runtime.use_model(
                    ModelType.TEXT_SMALL.value,
                    {
                        "prompt": prompt,
                        "maxTokens": 100,
                        "temperature": 0.9,
                    },
                )
                final_text = str(response).strip()
            except Exception as e:
                log.warning(f"Failed to generate post text: {e}, using original text")
                final_text = text

        result = await client.create_post(final_text)

        if result and result.id:
            post_id = result.id
            post_url = f"https://x.com/{profile.username}/status/{post_id}"

            log.info(f"Posted: {post_id}")

            from elizaos.types.memory import Content

            await runtime.create_memory(
                Memory(
                    entity_id=runtime.agent_id,
                    agent_id=runtime.agent_id,
                    room_id=message.room_id,
                    content=Content(
                        text=final_text,
                        url=post_url,
                        source="x",
                        action="POST",
                    ),
                ),
                "messages",
            )

            success_text = f'Posted: "{final_text}"\n\n{post_url}'
            if callback:
                await callback(
                    {
                        "text": success_text,
                        "metadata": {"postId": post_id, "postUrl": post_url},
                    }
                )

            return {
                "success": True,
                "text": f"Posted: {post_url}",
                "data": {"postId": post_id, "postUrl": post_url},
            }
        else:
            raise RuntimeError("Failed to post - no response data")

    except Exception as e:
        log.error(f"Error in POST action: {e}")
        error_msg = f"Failed to post: {e}"
        if callback:
            await callback({"text": error_msg, "action": "POST"})
        return {"success": False, "error": str(e)}


# Action definition
POST_ACTION: Action = {
    "name": "POST",
    "similes": ["POST_TO_X", "POST", "SEND_POST", "SHARE_ON_X"],
    "description": "Post content on X (formerly Twitter)",
    "validate": validate_post,
    "handler": handle_post,
    "examples": [
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Post about the weather today"},
            ),
            ActionExample(
                name="{{agent}}",
                content={"text": "I'll post about today's weather.", "action": "POST"},
            ),
        ],
        [
            ActionExample(
                name="{{user1}}",
                content={"text": "Post: The future of AI is collaborative intelligence"},
            ),
            ActionExample(
                name="{{agent}}",
                content={"text": "I'll post that for you.", "action": "POST"},
            ),
        ],
    ],
}
