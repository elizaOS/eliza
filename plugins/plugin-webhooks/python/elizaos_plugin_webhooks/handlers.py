"""
Route handlers for webhook endpoints.

Three endpoints:
  POST /hooks/wake   – Enqueue system event + optional immediate heartbeat
  POST /hooks/agent  – Run isolated agent turn + optional delivery
  POST /hooks/:name  – Mapped webhook (resolves via hooks.mappings config)

Handlers are framework-agnostic: they accept a protocol-typed *runtime*
object and return structured results that callers adapt to their HTTP
framework (FastAPI, Flask, etc.).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable

from .auth import validate_token
from .error import AuthenticationError, NotFoundError, ValidationError
from .mappings import apply_mapping, find_mapping
from .types import AppliedMapping, HookMapping, HookMatch, HooksConfig

logger = logging.getLogger("elizaos.plugin.webhooks")


# ---------------------------------------------------------------------------
# Runtime protocol – thin abstraction of the elizaOS agent runtime
# ---------------------------------------------------------------------------


@runtime_checkable
class AgentRuntime(Protocol):
    """Minimal runtime interface consumed by webhook handlers."""

    agent_id: str

    async def emit_event(self, event: str, data: dict[str, Any]) -> None: ...
    async def get_rooms(self, agent_id: str) -> list[dict[str, Any]]: ...
    async def get_room(self, room_id: str) -> Optional[dict[str, Any]]: ...
    async def create_room(self, room: dict[str, Any]) -> None: ...
    async def add_participant(self, agent_id: str, room_id: str) -> None: ...
    async def send_message_to_target(
        self, target: dict[str, Any], content: dict[str, Any]
    ) -> None: ...
    async def handle_message(
        self, memory: dict[str, Any], callback: Any
    ) -> None: ...

    def get_character_settings(self) -> dict[str, Any]: ...


# ---------------------------------------------------------------------------
# GMAIL preset (matches TS implementation)
# ---------------------------------------------------------------------------

GMAIL_PRESET_MAPPING = HookMapping(
    match=HookMatch(path="gmail"),
    action="agent",
    name="Gmail",
    session_key="hook:gmail:{{messages[0].id}}",
    message_template=(
        "New email from {{messages[0].from}}\n"
        "Subject: {{messages[0].subject}}\n"
        "{{messages[0].snippet}}\n"
        "{{messages[0].body}}"
    ),
    wake_mode="now",
    deliver=True,
    channel="last",
)


# ---------------------------------------------------------------------------
# Config resolution
# ---------------------------------------------------------------------------


def resolve_hooks_config(runtime: AgentRuntime) -> Optional[HooksConfig]:
    """Resolve hooks configuration from character settings.

    Returns ``None`` if hooks are disabled or the token is empty.
    """
    settings = runtime.get_character_settings()
    hooks: dict[str, Any] = settings.get("hooks", {})

    if hooks.get("enabled") is False:
        return None

    token = hooks.get("token", "")
    if not isinstance(token, str) or not token.strip():
        return None
    token = token.strip()

    raw_mappings = hooks.get("mappings", [])
    mappings: list[HookMapping] = []
    if isinstance(raw_mappings, list):
        for m in raw_mappings:
            if isinstance(m, dict):
                mappings.append(HookMapping.from_dict(m))

    presets: list[str] = []
    raw_presets = hooks.get("presets", [])
    if isinstance(raw_presets, list):
        presets = [p for p in raw_presets if isinstance(p, str)]

    # Apply presets
    if "gmail" in presets:
        has_gmail = any(
            m.match and m.match.path == "gmail" for m in mappings
        )
        if not has_gmail:
            mappings.append(GMAIL_PRESET_MAPPING)

    return HooksConfig(token=token, mappings=mappings, presets=presets)


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------


@dataclass
class HandlerResponse:
    """Structured response returned by every handler."""

    status_code: int = 200
    body: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Event helpers
# ---------------------------------------------------------------------------


async def _emit_heartbeat_wake(
    runtime: AgentRuntime,
    text: Optional[str] = None,
    source: str = "webhook",
) -> None:
    await runtime.emit_event(
        "HEARTBEAT_WAKE",
        {"runtime": runtime, "text": text, "source": source},
    )


async def _emit_heartbeat_system_event(
    runtime: AgentRuntime,
    text: str,
    source: str = "webhook",
) -> None:
    await runtime.emit_event(
        "HEARTBEAT_SYSTEM_EVENT",
        {"runtime": runtime, "text": text, "source": source},
    )


# ---------------------------------------------------------------------------
# Delivery
# ---------------------------------------------------------------------------


async def _deliver_to_channel(
    runtime: AgentRuntime,
    content: dict[str, Any],
    channel: str,
    to: Optional[str] = None,
) -> None:
    """Deliver *content* to a channel, resolving ``"last"`` by scanning rooms."""
    source: Optional[str] = None
    channel_id: Optional[str] = None

    if channel != "last":
        source = channel
        channel_id = to
    else:
        internal_sources = {"cron", "webhook", "heartbeat", "internal"}
        try:
            rooms = await runtime.get_rooms(runtime.agent_id)
        except Exception:
            rooms = []

        for room in rooms:
            room_source = room.get("source")
            if room_source and room_source not in internal_sources:
                source = room_source
                channel_id = to or room.get("channelId")
                break

        if source is None:
            logger.warning(
                '[Webhooks] No delivery target resolved for channel "last"'
            )
            return

    await runtime.send_message_to_target(
        {"source": source, "channelId": channel_id},
        content,
    )
    suffix = f":{channel_id}" if channel_id else ""
    logger.info(f"[Webhooks] Delivered to {source}{suffix}")


# ---------------------------------------------------------------------------
# Isolated agent turn
# ---------------------------------------------------------------------------


async def _run_isolated_agent_turn(
    runtime: AgentRuntime,
    *,
    message: str,
    name: str,
    session_key: str,
    model: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
) -> str:
    """Run an isolated agent turn in a dedicated room."""
    # Deterministic room ID from agent_id + session_key
    room_id = str(
        uuid.uuid5(uuid.NAMESPACE_DNS, f"{runtime.agent_id}-{session_key}")
    )

    existing = await runtime.get_room(room_id)
    if not existing:
        await runtime.create_room(
            {
                "id": room_id,
                "name": f"Hook: {name}",
                "source": "webhook",
                "type": "GROUP",
                "channelId": session_key,
            }
        )
        await runtime.add_participant(runtime.agent_id, room_id)

    message_id = str(uuid.uuid4())
    memory = {
        "id": message_id,
        "entityId": runtime.agent_id,
        "roomId": room_id,
        "agentId": runtime.agent_id,
        "content": {"text": f"[{name}] {message}"},
        "createdAt": int(time.time() * 1000),
    }

    response_text_parts: list[str] = []

    async def callback(response: dict[str, Any]) -> list[Any]:
        text = response.get("text")
        if text:
            response_text_parts.append(text)
        return []

    timeout_ms = (timeout_seconds or 300) * 1.0

    try:
        await asyncio.wait_for(
            runtime.handle_message(memory, callback),
            timeout=timeout_ms,
        )
    except asyncio.TimeoutError:
        raise TimeoutError("Agent turn timeout")

    return "".join(response_text_parts)


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------


async def handle_wake(
    runtime: AgentRuntime,
    *,
    headers: Optional[dict[str, Any]] = None,
    body: Optional[dict[str, Any]] = None,
) -> HandlerResponse:
    """POST /hooks/wake – enqueue system event + optional immediate heartbeat."""
    config = resolve_hooks_config(runtime)
    if config is None:
        return HandlerResponse(404, {"error": "Hooks not enabled"})

    if not validate_token(config.token, headers=headers):
        return HandlerResponse(401, {"error": "Unauthorized"})

    body = body or {}
    text = body.get("text", "")
    if isinstance(text, str):
        text = text.strip()
    if not text:
        return HandlerResponse(400, {"error": "Missing required field: text"})

    mode = "next-heartbeat" if body.get("mode") == "next-heartbeat" else "now"

    await _emit_heartbeat_system_event(runtime, text, "hook:wake")

    if mode == "now":
        await _emit_heartbeat_wake(runtime, source="hook:wake")

    logger.info(
        f'[Webhooks] /hooks/wake: "{text[:80]}" (mode: {mode})'
    )
    return HandlerResponse(200, {"ok": True})


async def handle_agent(
    runtime: AgentRuntime,
    *,
    headers: Optional[dict[str, Any]] = None,
    body: Optional[dict[str, Any]] = None,
) -> HandlerResponse:
    """POST /hooks/agent – run isolated agent turn + optional delivery."""
    config = resolve_hooks_config(runtime)
    if config is None:
        return HandlerResponse(404, {"error": "Hooks not enabled"})

    if not validate_token(config.token, headers=headers):
        return HandlerResponse(401, {"error": "Unauthorized"})

    body = body or {}
    message = body.get("message", "")
    if isinstance(message, str):
        message = message.strip()
    if not message:
        return HandlerResponse(
            400, {"error": "Missing required field: message"}
        )

    name = body.get("name", "Webhook")
    if not isinstance(name, str):
        name = "Webhook"

    session_key = body.get("sessionKey")
    if not isinstance(session_key, str):
        session_key = f"hook:{uuid.uuid4()}"

    wake_mode = (
        "next-heartbeat"
        if body.get("wakeMode") == "next-heartbeat"
        else "now"
    )
    deliver = body.get("deliver") is not False
    channel = body.get("channel", "last")
    if not isinstance(channel, str):
        channel = "last"
    to = body.get("to") if isinstance(body.get("to"), str) else None
    model = body.get("model") if isinstance(body.get("model"), str) else None
    timeout_seconds = (
        body.get("timeoutSeconds")
        if isinstance(body.get("timeoutSeconds"), (int, float))
        else None
    )

    logger.info(
        f'[Webhooks] /hooks/agent: "{message[:80]}" (session: {session_key})'
    )

    # Fire-and-forget async task
    async def run_async() -> None:
        response_text = await _run_isolated_agent_turn(
            runtime,
            message=message,
            name=name,
            session_key=session_key,
            model=model,
            timeout_seconds=int(timeout_seconds) if timeout_seconds else None,
        )

        trimmed = response_text.strip()
        if deliver and trimmed and trimmed != "HEARTBEAT_OK":
            try:
                await _deliver_to_channel(
                    runtime, {"text": response_text}, channel, to
                )
            except Exception as exc:
                logger.warning(
                    f"[Webhooks] Delivery failed for hook agent: {exc}"
                )

        if trimmed and trimmed != "HEARTBEAT_OK":
            summary = (
                f"{response_text[:200]}…"
                if len(response_text) > 200
                else response_text
            )
            await _emit_heartbeat_system_event(
                runtime,
                f'[Hook "{name}" completed] {summary}',
                f"hook:{name}",
            )

        if wake_mode == "now":
            await _emit_heartbeat_wake(runtime, source=f"hook:{name}")

    asyncio.ensure_future(run_async())

    return HandlerResponse(202, {"ok": True, "sessionKey": session_key})


async def handle_mapped(
    runtime: AgentRuntime,
    *,
    headers: Optional[dict[str, Any]] = None,
    body: Optional[dict[str, Any]] = None,
    hook_name: str = "",
) -> HandlerResponse:
    """POST /hooks/:name – mapped webhook via hooks.mappings config."""
    config = resolve_hooks_config(runtime)
    if config is None:
        return HandlerResponse(404, {"error": "Hooks not enabled"})

    if not validate_token(config.token, headers=headers):
        return HandlerResponse(401, {"error": "Unauthorized"})

    if not hook_name:
        return HandlerResponse(400, {"error": "Missing hook name"})

    body = body or {}

    mapping = find_mapping(config.mappings, hook_name, body)
    if mapping is None:
        return HandlerResponse(
            404, {"error": f"No mapping found for hook: {hook_name}"}
        )

    resolved = apply_mapping(mapping, hook_name, body)

    logger.info(
        f"[Webhooks] /hooks/{hook_name}: action={resolved.action}"
    )

    if resolved.action == "wake":
        await _emit_heartbeat_system_event(
            runtime, resolved.text or "", f"hook:{hook_name}"
        )
        if resolved.wake_mode == "now":
            await _emit_heartbeat_wake(runtime, source=f"hook:{hook_name}")
        return HandlerResponse(200, {"ok": True})

    # action == "agent"
    async def run_async() -> None:
        response_text = await _run_isolated_agent_turn(
            runtime,
            message=resolved.message or "",
            name=resolved.name or hook_name,
            session_key=resolved.session_key
            or f"hook:{hook_name}:{int(time.time() * 1000)}",
            model=resolved.model,
            timeout_seconds=resolved.timeout_seconds,
        )

        trimmed = response_text.strip()
        if resolved.deliver and trimmed and trimmed != "HEARTBEAT_OK":
            try:
                await _deliver_to_channel(
                    runtime,
                    {"text": response_text},
                    resolved.channel or "last",
                    resolved.to,
                )
            except Exception as exc:
                logger.warning(
                    f'[Webhooks] Delivery failed for mapped hook "{hook_name}": {exc}'
                )

        if trimmed and trimmed != "HEARTBEAT_OK":
            summary = (
                f"{response_text[:200]}…"
                if len(response_text) > 200
                else response_text
            )
            await _emit_heartbeat_system_event(
                runtime,
                f'[Hook "{resolved.name or hook_name}" completed] {summary}',
                f"hook:{hook_name}",
            )

        if resolved.wake_mode == "now":
            await _emit_heartbeat_wake(
                runtime, source=f"hook:{hook_name}"
            )

    asyncio.ensure_future(run_async())

    return HandlerResponse(202, {"ok": True})
