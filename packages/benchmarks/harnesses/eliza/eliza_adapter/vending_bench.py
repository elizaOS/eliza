"""Routes Vending-Bench decisions through the selected native agent runtime.

Every turn is isolated because the benchmark prompt carries its designed state
and memory tools; this prevents one runtime's implicit chat history from giving
it context that the other native runtimes do not receive.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Mapping
from typing import Optional

from eliza_adapter.client import ElizaClient

_VENDING_ACTIONS = {
    "ADVANCE_DAY",
    "CHECK_DELIVERIES",
    "COLLECT_CASH",
    "DELEGATE_EMAIL",
    "DELEGATE_RESEARCH",
    "NOTEPAD_READ",
    "NOTEPAD_WRITE",
    "PLACE_ORDER",
    "READ_EMAIL",
    "RESTOCK_SLOT",
    "SEARCH_WEB",
    "SEND_EMAIL",
    "SET_PRICE",
    "UPDATE_NOTES",
    "VIEW_BUSINESS_STATE",
    "VIEW_STATE",
    "VIEW_SUPPLIERS",
}

_VENDING_TOOL = {
    "type": "function",
    "function": {
        "name": "BENCHMARK_ACTION",
        "description": "Return exactly one Vending-Bench action for this turn.",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": sorted(_VENDING_ACTIONS - {"VIEW_STATE"})},
                "supplier_id": {"type": "string"},
                "items": {"type": "object", "additionalProperties": {"type": "integer"}},
                "row": {"type": "integer"},
                "column": {"type": "integer"},
                "product_id": {"type": "string"},
                "quantity": {"type": "integer"},
                "price": {"type": "number"},
                "query": {"type": "string"},
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
                "text": {"type": "string"},
                "task": {"type": "string"},
                "key": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["action"],
            "additionalProperties": False,
        },
    },
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
        except json.JSONDecodeError:  # error-policy:J3 invalid tool arguments stay invalid
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
        if str(k).strip()
        not in {
            "action",
            "name",
            "command",
            "tool_name",
            "arguments",
            "actionContext",
            "previousResults",
            "reasoning",
        }
    }
    out["action"] = normalized
    return json.dumps(out)


def _response_to_vending_json(text: str, params: dict) -> str:
    stripped = (text or "").strip()
    try:
        normalized = _normalize_vending_payload(json.loads(_extract_json_candidate(stripped)))
        if normalized is not None:
            return normalized
    except (json.JSONDecodeError, TypeError):  # error-policy:J3 try structured tool data next
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


def _tokens_used(params: Mapping[str, object]) -> int:
    usage = params.get("usage")
    if not isinstance(usage, Mapping):
        raise RuntimeError("Vending-Bench native response is missing token usage")
    for key in ("total_tokens", "totalTokens", "total"):
        total = usage.get(key)
        if isinstance(total, int) and not isinstance(total, bool) and total >= 0:
            return total
    prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
    completion = usage.get("completion_tokens", usage.get("output_tokens"))
    if (
        isinstance(prompt, int)
        and not isinstance(prompt, bool)
        and prompt >= 0
        and isinstance(completion, int)
        and not isinstance(completion, bool)
        and completion >= 0
    ):
        return prompt + completion
    raise RuntimeError("Vending-Bench native response has incomplete token usage")


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

        self._turn_counter += 1
        self._client.reset(
            task_id=f"{self._run_id}:turn-{self._turn_counter}",
            benchmark="vending-bench",
        )
        response = self._client.send_message(
            text=user_prompt,
            context={
                "benchmark": "vending-bench",
                "task_id": f"{self._run_id}:turn-{self._turn_counter}",
                "system_prompt": system_prompt,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "tools": [_VENDING_TOOL],
                "tool_choice": "required",
                "max_tokens": 512,
                "temperature": temperature,
                "run_id": self._run_id,
                "turn": self._turn_counter,
            },
        )

        action = _response_to_vending_json(response.text or "", response.params)
        return action, _tokens_used(response.params)

    async def reset(self, run_id: str) -> None:
        """Reset the bridge session at the start of a new simulation run."""
        self._run_id = run_id or f"vending-{uuid.uuid4().hex[:12]}"
        self._turn_counter = 0
        self._client.reset(task_id=self._run_id, benchmark="vending-bench")
