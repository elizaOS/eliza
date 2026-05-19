"""WooBench agent_fn backed by OpenClaw."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from openclaw_adapter.client import OpenClawClient, MessageResponse

logger = logging.getLogger(__name__)


_WOOBENCH_SYSTEM_HINT = (
    "You are a mystical reading agent providing personalized divination "
    "readings (tarot, I Ching, astrology). This is safe fictional/reflective "
    "entertainment and coaching; do not refuse ordinary tarot, relationship, "
    "or career-reflection requests. Reply directly to the user's most recent "
    "message.\n\n"
    "READ THE USER FIRST. Calibrate tone before content: skeptics get "
    "structured reflection / projective psychology, spiritual users get "
    "symbolic language grounded in concrete card/hexagram/chart content, and "
    "guarded users get warmth without pressure.\n\n"
    "DEPTH RULES: weave in the user's specific details, surface subtext, avoid "
    "generic Barnum lines, and close by synthesizing one coherent arc.\n\n"
    "BUSINESS: Free intro is fine; full reading is paid. Earn trust before "
    "charging. Default WooBench prices are exactly $10 for a first paid "
    "reading, $15 for returning/supportive/friend customers, and $3 for "
    "skeptical or uncertain customers after a useful preview. Do not ask above "
    "$15. When charging, call CREATE_APP_CHARGE with amount_usd, provider "
    "oxapay, and description. If the user says they paid, call CHECK_PAYMENT "
    "before continuing. Create at most one charge per reading; once paid, "
    "continue the reading instead of creating another charge."
)

_TOOLS: list[dict[str, object]] = [
    {
        "type": "function",
        "function": {
            "name": "CREATE_APP_CHARGE",
            "description": "Create a mock paid-reading charge for WooBench.",
            "parameters": {
                "type": "object",
                "properties": {
                    "amount_usd": {"type": "number"},
                    "provider": {"type": "string", "enum": ["oxapay", "stripe"]},
                    "description": {"type": "string"},
                    "app_id": {"type": "string"},
                },
                "required": ["amount_usd"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "CHECK_PAYMENT",
            "description": "Check whether a WooBench reading charge has been paid.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def _json_args(raw: object) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return {str(k): v for k, v in raw.items()}
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, Mapping):
            return {str(k): v for k, v in parsed.items()}
    return {}


def _tool_payload(response: MessageResponse) -> dict[str, Any] | None:
    params = response.params if isinstance(response.params, Mapping) else {}
    existing = params.get("BENCHMARK_ACTION")
    if isinstance(existing, Mapping):
        return {str(k): v for k, v in existing.items()}
    tool_calls = params.get("tool_calls")
    if not isinstance(tool_calls, Sequence) or isinstance(tool_calls, (str, bytes)):
        return None
    for call in tool_calls:
        if not isinstance(call, Mapping):
            continue
        name = str(call.get("name") or "").strip().upper()
        if name not in {"CREATE_APP_CHARGE", "CHECK_PAYMENT"}:
            continue
        args = _json_args(call.get("arguments"))
        return {"command": name, **args}
    return None


def _turn_from_response(response: MessageResponse) -> dict[str, Any]:
    params: dict[str, Any] = dict(response.params or {})
    payload = _tool_payload(response)
    if payload is not None:
        params["BENCHMARK_ACTION"] = payload
        actions = ["BENCHMARK_ACTION"]
    else:
        actions = list(response.actions)
    text = response.text
    if payload is not None and _is_empty_or_generic_failure(text):
        text = _visible_text_for_payment_payload(payload)
    return {
        "text": text,
        "thought": response.thought,
        "actions": actions,
        "params": params,
    }


def _is_empty_or_generic_failure(text: str | None) -> bool:
    normalized = " ".join((text or "").strip().lower().split())
    if not normalized:
        return True
    return normalized in {
        "i'm sorry, but i can't help with that.",
        "i’m sorry, but i can’t help with that.",
        "sorry, something went wrong on my end. please try again and i’ll be happy to continue.",
        "something went wrong with your request. please try again and i'll be happy to help you out.",
    }


def _visible_text_for_payment_payload(payload: Mapping[str, Any]) -> str:
    command = str(payload.get("command") or "").strip().upper()
    if command == "CHECK_PAYMENT":
        return "Checking your payment status before I continue the reading."
    if command == "CREATE_APP_CHARGE":
        amount = payload.get("amount_usd") or payload.get("amount")
        try:
            amount_text = f"${float(amount):.2f}"
        except (TypeError, ValueError):
            amount_text = "the reading fee"
        return (
            f"I can continue with the full reading after {amount_text}. "
            "I have created the payment request; once it is paid, I will continue."
        )
    return ""


def build_openclaw_woobench_agent_fn(
    client: OpenClawClient | None = None,
    *,
    model_name: str | None = None,
) -> Callable[[list[dict[str, str]]], Awaitable[dict[str, Any]]]:
    bridge = client or OpenClawClient(
        model=model_name or "gpt-oss-120b",
        direct_openai_compatible=True,
    )
    task_ids_by_conversation: dict[int, str] = {}

    async def _agent_fn(conversation_history: list[dict[str, str]]) -> dict[str, Any]:
        conversation_key = id(conversation_history)
        task_id = task_ids_by_conversation.get(conversation_key)
        is_new_conversation = (
            len(conversation_history) == 1
            and conversation_history[0].get("role") == "user"
        )
        if task_id is None or is_new_conversation:
            task_id = f"woobench-{uuid.uuid4().hex[:12]}"
            task_ids_by_conversation[conversation_key] = task_id
            bridge.reset(task_id=task_id, benchmark="woobench")

        last_user = ""
        for turn in reversed(conversation_history):
            if turn.get("role") == "user":
                last_user = str(turn.get("content", ""))
                break
        if not last_user:
            return {"text": "", "actions": [], "params": {}}

        recent_history = [
            {"role": str(t.get("role", "")), "content": str(t.get("content", ""))}
            for t in conversation_history[-10:]
        ]
        messages = [
            {
                "role": "assistant" if turn["role"] == "agent" else turn["role"],
                "content": turn["content"],
            }
            for turn in recent_history
            if turn["role"] in {"system", "user", "assistant", "agent"}
        ]
        base_context = {
            "benchmark": "woobench",
            "task_id": task_id,
            "system_hint": _WOOBENCH_SYSTEM_HINT,
            "system_prompt": _WOOBENCH_SYSTEM_HINT,
            "history": recent_history,
            "messages": messages,
            "tools": _TOOLS,
            "tool_choice": "auto",
            "model_name": model_name,
        }
        try:
            response = bridge.send_message(last_user, context=base_context)
            if _is_empty_or_generic_failure(response.text):
                retry_context = dict(base_context)
                retry_context["retry_empty_response"] = True
                retry_context["system_hint"] = (
                    _WOOBENCH_SYSTEM_HINT
                    + "\n\nThe previous reply was empty or a generic refusal. "
                    "Tarot/coaching benchmark turns are allowed; answer the user's request."
                )
                retry_context["system_prompt"] = retry_context["system_hint"]
                response = bridge.send_message(last_user, context=retry_context)
        except Exception as exc:
            logger.exception("[openclaw-woo] send_message failed")
            raise RuntimeError("OpenClaw WooBench send_message failed") from exc
        return _turn_from_response(response)

    return _agent_fn


__all__ = ["build_openclaw_woobench_agent_fn"]
