"""Request secret action.

Requests a missing secret from the user or administrator by using the LLM
to extract which secret is needed from the recent conversation context.

Ported from secrets/actions/request-secret.ts.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

from elizaos.types import Action, ActionResult, Content, ModelType

from ..types import SecretContext, SecretLevel

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

    from ..service import SecretsService

logger = logging.getLogger(__name__)

EXTRACT_REQUEST_TEMPLATE = """You are helping an AI agent request a missing secret.
Determine what secret the agent needs and why based on the recent conversation.

Common patterns:
- "I need an API key for OpenAI" -> key: OPENAI_API_KEY
- "Missing TWITTER_TOKEN" -> key: TWITTER_TOKEN
- "I cannot proceed without a Discord token" -> key: DISCORD_TOKEN

Recent Messages:
{recent_messages}

Output JSON with:
- key: The name of the secret needed (e.g. OPENAI_API_KEY)
- reason: Why it is needed (optional)

If no specific secret is requested, return null json."""


def _get_secrets_service(runtime: IAgentRuntime) -> SecretsService | None:
    for svc in (runtime.services or {}).values():
        if getattr(svc, "service_type", None) == "secrets":
            return svc  # type: ignore[return-value]
    return None


async def _validate(runtime: IAgentRuntime, message: Memory, _state: State | None = None) -> bool:
    text = (message.content.text if message.content else "") or ""
    text_lower = text.lower()
    has_keyword = any(kw in text_lower for kw in ("request", "secret"))
    if not has_keyword or not re.search(r"\b(?:request|secret)\b", text, re.IGNORECASE):
        return False
    return _get_secrets_service(runtime) is not None


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    logger.info("[RequestSecret] Processing secret request")

    current_state = state if state is not None else await runtime.compose_state(message)
    recent_messages = getattr(current_state, "recent_messages", "") or ""
    prompt = EXTRACT_REQUEST_TEMPLATE.format(recent_messages=recent_messages)

    try:
        result = await runtime.use_model(ModelType.OBJECT_SMALL, prompt=prompt)

        if not isinstance(result, dict) or not result.get("key"):
            logger.warning("[RequestSecret] Failed to extract secret key from context")
            return ActionResult(text="Could not determine which secret is needed.", success=False)

        key: str = result["key"]
        reason: str | None = result.get("reason")
        key = re.sub(r"[^A-Z0-9_]", "_", key.upper())

        # Check if it already exists
        secrets_svc = _get_secrets_service(runtime)
        if secrets_svc is not None:
            entity_id = message.entity_id if message.entity_id != runtime.agent_id else None
            context = SecretContext(
                level=SecretLevel.GLOBAL,
                agent_id=str(runtime.agent_id),
                user_id=str(entity_id) if entity_id else None,
            )
            exists = await secrets_svc.exists(key, context)
            if exists:
                text = f"The secret '{key}' is already available. You can use it now."
                if callback:
                    await callback(Content(text=text, actions=["REQUEST_SECRET"]))
                return ActionResult(text=text, success=True)

        reason_text = f" ({reason})" if reason else ""
        text = (
            f"I require the secret '{key}' to proceed{reason_text}. "
            f"Please provide it securely using 'set secret {key} <value>'."
        )

        if callback:
            await callback(
                Content(
                    text=text,
                    actions=["REQUEST_SECRET"],
                )
            )

        return ActionResult(text=text, success=True)
    except Exception as exc:
        logger.error("[RequestSecret] Error: %s", exc)
        return ActionResult(text="Failed to process secret request", success=False)


request_secret_action = Action(
    name="REQUEST_SECRET",
    similes=["ASK_FOR_SECRET", "REQUIRE_SECRET", "NEED_SECRET", "MISSING_SECRET"],
    description="Request a missing secret from the user or administrator",
    validate=_validate,
    handler=_handler,
    examples=[
        [
            {"name": "{{user1}}", "content": {"text": "I need an OpenAI key to continue."}},
            {
                "name": "{{agent}}",
                "content": {
                    "text": (
                        "I require the secret 'OPENAI_API_KEY' to proceed. "
                        "Please provide it securely using 'set secret OPENAI_API_KEY <value>'."
                    ),
                    "action": "REQUEST_SECRET",
                },
            },
        ],
        [
            {
                "name": "{{user1}}",
                "content": {"text": "I cannot access the database without a connection string."},
            },
            {
                "name": "{{agent}}",
                "content": {
                    "text": (
                        "I require the secret 'DATABASE_URL' to proceed (database access). "
                        "Please provide it securely using 'set secret DATABASE_URL <value>'."
                    ),
                    "action": "REQUEST_SECRET",
                },
            },
        ],
    ],
)
