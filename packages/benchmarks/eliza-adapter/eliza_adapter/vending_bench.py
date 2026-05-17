"""Vending-Bench LLM provider backed by the eliza TS benchmark server.

Implements the duck-typed ``LLMProvider`` protocol expected by
``elizaos_vending_bench.agent.VendingAgent``: a single ``generate``
coroutine returning ``(response_text, tokens_used)``. Each call is
forwarded to the eliza TS bridge via ``ElizaClient.send_message`` so
no Python ``AgentRuntime`` is needed.

Long-prompt failure mode + fix
==============================

The bridge's ``messageService.handleMessage`` accumulates conversation
history across turns through the runtime's RECENT_MESSAGES provider.
Vending-Bench is a 30-day simulation with one turn per day, and the
agent injects the full daily business state in every prompt — so
without bounding the bridge-side history, the prompt fed to the
underlying LLM grows unboundedly and eventually trips a timeout (the
client sees "Remote end closed connection" when the server-side socket
gets recycled).

The agent.py prompts already self-contain the daily state, so we
reset the bridge session before every ``generate`` call. This keeps
the bridge-side conversation history bounded to one turn at a time
without losing simulation context, since that context already lives
inside the prompt we're sending.
"""

from __future__ import annotations

import logging
import json
import re
import uuid
from typing import Optional

from eliza_adapter.client import ElizaClient

logger = logging.getLogger(__name__)


_VENDING_ACTIONS = {
    "VIEW_BUSINESS_STATE",
    "VIEW_STATE",
    "VIEW_SUPPLIERS",
    "SET_PRICE",
    "PLACE_ORDER",
    "RESTOCK_SLOT",
    "COLLECT_CASH",
    "UPDATE_NOTES",
    "CHECK_DELIVERIES",
    "ADVANCE_DAY",
}


def _extract_json_candidate(text: str) -> str:
    stripped = (text or "").strip()
    if "```json" in stripped:
        return stripped.split("```json", 1)[1].split("```", 1)[0].strip()
    if "```" in stripped:
        return stripped.split("```", 1)[1].split("```", 1)[0].strip()
    tool_match = re.search(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", stripped, re.DOTALL)
    if tool_match:
        return tool_match.group(1).strip()
    return stripped


def _normalize_vending_payload(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    data = {str(k).strip(): v for k, v in payload.items()}
    arguments = data.get("arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            arguments = None
    if isinstance(arguments, dict):
        data.update({str(k).strip(): v for k, v in arguments.items()})

    raw_action = (
        data.get("action")
        or data.get("name")
        or data.get("command")
        or data.get("tool_name")
    )
    if not isinstance(raw_action, str):
        return None
    normalized = raw_action.strip().upper()
    if normalized == "VIEW_STATE":
        normalized = "VIEW_BUSINESS_STATE"
    if normalized not in _VENDING_ACTIONS:
        return None

    out = {
        str(k).strip(): v
        for k, v in data.items()
        if str(k).strip() not in {"action", "name", "command", "tool_name", "arguments"}
    }
    out["action"] = normalized
    return json.dumps(out)


def _looks_like_vending_json(text: str) -> bool:
    try:
        parsed = json.loads(_extract_json_candidate(text))
    except Exception:
        return False
    return _normalize_vending_payload(parsed) is not None


def _response_to_vending_json(text: str, params: dict, user_prompt: str) -> str:
    stripped = (text or "").strip()
    try:
        normalized = _normalize_vending_payload(json.loads(_extract_json_candidate(stripped)))
        if normalized is not None:
            return normalized
    except Exception:
        pass

    action_params = params.get("BENCHMARK_ACTION")
    normalized = _normalize_vending_payload(action_params)
    if normalized is not None:
        return normalized
    action_params_many = params.get("BENCHMARK_ACTIONS")
    if isinstance(action_params_many, list):
        for item in action_params_many:
            normalized = _normalize_vending_payload(item)
            if normalized is not None:
                return normalized

    return stripped


class ElizaVendingProvider:
    """LLMProvider implementation that routes through the eliza TS bridge.

    Drop-in replacement for ``OpenAIProvider`` / ``AnthropicProvider`` etc.
    when running with ``--provider eliza``. The bridge owns the underlying
    model selection through the runtime config, so no per-call model
    parameter is needed here.
    """

    def __init__(
        self,
        client: Optional[ElizaClient] = None,
        model: str = "eliza-ts-bridge",
    ) -> None:
        self._client = client or ElizaClient()
        self.model = model
        self._initialized = False
        self._run_id: str = f"vending-{uuid.uuid4().hex[:12]}"
        self._turn_counter: int = 0

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        self._client.wait_until_ready(timeout=120)
        self._initialized = True

    async def generate(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.0,
    ) -> tuple[str, int]:
        await self._ensure_initialized()

        # Reset the bridge session each turn so the underlying runtime's
        # RECENT_MESSAGES provider does not accumulate across turns. The
        # agent prompt is already self-contained.
        self._turn_counter += 1
        try:
            self._client.reset(
                task_id=f"{self._run_id}:turn-{self._turn_counter}",
                benchmark="vending-bench",
            )
        except Exception as exc:
            logger.debug("Eliza per-turn reset failed (continuing): %s", exc)

        prompt = f"{system_prompt}\n\n{user_prompt}" if system_prompt else user_prompt

        try:
            response = self._client.send_message(
                text=prompt,
                context={
                    "benchmark": "vending-bench",
                    "task_id": f"{self._run_id}:turn-{self._turn_counter}",
                    "system_prompt": system_prompt,
                    "temperature": temperature,
                    "run_id": self._run_id,
                    "turn": self._turn_counter,
                },
            )
        except Exception as exc:
            logger.error("[eliza-vending] send_message failed: %s", exc)
            raise

        return (_response_to_vending_json(response.text or "", response.params, user_prompt), 0)

    async def reset(self, run_id: str) -> None:
        """Reset the bridge session at the start of a new simulation run."""
        self._run_id = run_id or f"vending-{uuid.uuid4().hex[:12]}"
        self._turn_counter = 0
        try:
            self._client.reset(task_id=self._run_id, benchmark="vending-bench")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)
