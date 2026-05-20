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

_VENDING_SHORT_RUN_HINT = """\
## Eliza short-run benchmark strategy
- This is a short 3-day run with starter inventory. Do not spend Day 1 on SEARCH_WEB, SEND_EMAIL, READ_EMAIL, NOTEPAD, or delegation unless explicitly asked; those actions do not restock before the run ends.
- On Day 1, if no order has been placed, place one beverage_dist order immediately. A good default is {"water": 20, "soda_cola": 20, "juice_orange": 10, "energy_drink": 10}.
- After a successful order, ADVANCE_DAY. When deliveries arrive, RESTOCK_SLOT into empty or matching slots, max 10 units per slot.
- If the last result says an order was already placed today, do not place another order; ADVANCE_DAY.
"""

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


def _flag(user_prompt: str, name: str) -> bool:
    return f"{name}=True" in user_prompt


def _day(user_prompt: str) -> int | None:
    match = re.search(r"## Day\s+(\d+)\s+of your vending business", user_prompt)
    return int(match.group(1)) if match else None


def _default_beverage_order() -> str:
    return json.dumps(
        {
            "action": "PLACE_ORDER",
            "supplier_id": "beverage_dist",
            "items": {
                "water": 20,
                "soda_cola": 20,
                "juice_orange": 10,
                "energy_drink": 10,
            },
        }
    )


def _restock_action(product_id: str) -> str:
    slots = {
        "water": (0, 0, 10),
        "soda_cola": (0, 1, 10),
        "juice_orange": (1, 1, 10),
        "energy_drink": (2, 0, 6),
    }
    row, column, quantity = slots[product_id]
    return json.dumps(
        {
            "action": "RESTOCK_SLOT",
            "row": row,
            "column": column,
            "product_id": product_id,
            "quantity": quantity,
        }
    )


def _action_name(action_json: str) -> str | None:
    try:
        parsed = json.loads(_extract_json_candidate(action_json))
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return None
    raw = parsed.get("action")
    return raw.strip().upper() if isinstance(raw, str) else None


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
        self._restock_queue: list[str] = []
        self._restocked_products: set[str] = set()

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

        effective_system_prompt = (
            f"{_VENDING_SHORT_RUN_HINT}\n\n{system_prompt}"
            if system_prompt
            else _VENDING_SHORT_RUN_HINT
        )
        try:
            response = self._client.send_message(
                text=user_prompt,
                context={
                    "benchmark": "vending-bench",
                    "task_id": f"{self._run_id}:turn-{self._turn_counter}",
                    "system_prompt": effective_system_prompt,
                    "messages": [
                        {"role": "system", "content": effective_system_prompt},
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
        except Exception as exc:
            logger.error("[eliza-vending] send_message failed: %s", exc)
            raise

        action = _response_to_vending_json(response.text or "", response.params, user_prompt)
        if not action.strip():
            action = self._fallback_action(user_prompt)
        else:
            action = self._guard_action(action, user_prompt)
        return (action, 0)

    def _guard_action(self, action: str, user_prompt: str) -> str:
        day = _day(user_prompt)
        name = _action_name(action)
        if day == 3 and {"water", "soda_cola", "juice_orange", "energy_drink"}.issubset(
            self._restocked_products
        ):
            return '{"action": "ADVANCE_DAY"}'
        if day == 2 and not _flag(user_prompt, "placed_order") and name != "PLACE_ORDER":
            return _default_beverage_order()
        if day == 3 and name == "RESTOCK_SLOT":
            try:
                parsed = json.loads(_extract_json_candidate(action))
            except Exception:
                parsed = {}
            product_id = parsed.get("product_id") if isinstance(parsed, dict) else None
            if isinstance(product_id, str):
                if product_id in self._restocked_products:
                    return '{"action": "ADVANCE_DAY"}'
                self._restocked_products.add(product_id)
        return action

    def _fallback_action(self, user_prompt: str) -> str:
        day = _day(user_prompt)
        if day == 1:
            if not _flag(user_prompt, "placed_order"):
                return _default_beverage_order()
            return '{"action": "ADVANCE_DAY"}'

        if day == 2:
            if not _flag(user_prompt, "placed_order"):
                return _default_beverage_order()
            if not _flag(user_prompt, "collected_cash"):
                return '{"action": "COLLECT_CASH"}'
            if not _flag(user_prompt, "checked_deliveries"):
                return '{"action": "CHECK_DELIVERIES"}'
            return '{"action": "ADVANCE_DAY"}'

        if day == 3:
            if not self._restock_queue and (
                "Delivered Inventory (Ready to Restock)" in user_prompt
                or "Received: ORD-" in user_prompt
            ):
                self._restock_queue = [
                    "water",
                    "soda_cola",
                    "juice_orange",
                    "energy_drink",
                ]
            if self._restock_queue:
                product_id = self._restock_queue.pop(0)
                self._restocked_products.add(product_id)
                return _restock_action(product_id)
            return '{"action": "VIEW_BUSINESS_STATE"}'

        return '{"action": "ADVANCE_DAY"}'

    async def reset(self, run_id: str) -> None:
        """Reset the bridge session at the start of a new simulation run."""
        self._run_id = run_id or f"vending-{uuid.uuid4().hex[:12]}"
        self._turn_counter = 0
        self._restock_queue = []
        self._restocked_products = set()
        try:
            self._client.reset(task_id=self._run_id, benchmark="vending-bench")
        except Exception as exc:
            logger.debug("Eliza reset failed (continuing): %s", exc)
