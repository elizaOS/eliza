"""WooBench agent_fn backed by hermes-agent."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any

from hermes_adapter.client import HermesClient, MessageResponse

logger = logging.getLogger(__name__)


_WOOBENCH_SYSTEM_HINT = (
    "You are a mystical reading agent providing personalized divination readings. "
    "Calibrate tone to the user: for skeptics, scientists, and researchers, frame "
    "the reading as structured reflection and projective psychology, not literal "
    "prediction. For spiritual users, match their register while grounding claims "
    "in concrete symbolic content. Free intro is fine; full readings are paid. "
    "Default prices are $10 for a first paid reading, $15 for returning/supportive "
    "customers, and $3 for skeptical or uncertain users after a useful preview. "
    "When charging, call CREATE_APP_CHARGE with amount_usd, provider, and "
    "description. If the user says they paid, call CHECK_PAYMENT before continuing."
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
    return {
        "text": response.text,
        "thought": response.thought,
        "actions": actions,
        "params": params,
    }


def build_hermes_woobench_agent_fn(
    client: HermesClient | None = None,
    *,
    model_name: str | None = None,
) -> Callable[[list[dict[str, str]]], Awaitable[dict[str, Any]]]:
    bridge = client or HermesClient(model=model_name or "gpt-oss-120b")
    bridge.wait_until_ready(timeout=60)
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
        try:
            response = bridge.send_message(
                last_user,
                context={
                    "benchmark": "woobench",
                    "task_id": task_id,
                    "system_hint": _WOOBENCH_SYSTEM_HINT,
                    "system_prompt": _WOOBENCH_SYSTEM_HINT,
                    "history": recent_history,
                    "messages": messages,
                    "tools": _TOOLS,
                    "tool_choice": "auto",
                    "model_name": model_name,
                },
            )
        except Exception as exc:
            logger.exception("[hermes-woo] send_message failed")
            raise RuntimeError("Hermes WooBench send_message failed") from exc
        return _turn_from_response(response)

    return _agent_fn


__all__ = ["build_hermes_woobench_agent_fn"]
