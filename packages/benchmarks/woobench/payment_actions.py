"""WooBench payment action parsing and execution.

The benchmark accepts the same high-level shape the eliza benchmark bridge
returns for real actions: ``actions`` plus ``params``. For local runs those
actions execute against the payments mock provider instead of live Stripe,
OxaPay, or x402 settlement.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any, Mapping


CREATE_PAYMENT_COMMANDS = {
    "CREATE_APP_CHARGE",
    "CREATE_APP_CHARGE_REQUEST",
    "CREATE_CHARGE",
    "CREATE_PAYMENT_REQUEST",
    "REQUEST_PAYMENT",
    "CHARGE_USER",
    "PAYMENT_REQUEST",
}

CHECK_PAYMENT_COMMANDS = {
    "CHECK_APP_CHARGE",
    "CHECK_PAYMENT",
    "CHECK_PAYMENT_REQUEST",
    "VERIFY_PAYMENT",
    "PAYMENT_STATUS",
}


@dataclass
class AgentTurn:
    text: str
    actions: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class PaymentDemand:
    amount_usd: float
    action_name: str
    source: str
    provider: str = "oxapay"
    app_id: str = "woobench-mock-app"
    description: str = "WooBench reading charge"
    checkout_url: str | None = None


def normalize_agent_turn(raw: Any) -> AgentTurn:
    """Normalize string, mapping, or bridge MessageResponse into AgentTurn."""
    if isinstance(raw, str):
        return AgentTurn(text=raw)

    text = getattr(raw, "text", None)
    actions = getattr(raw, "actions", None)
    params = getattr(raw, "params", None)
    if text is not None or actions is not None or params is not None:
        return AgentTurn(
            text=str(text or ""),
            actions=[str(action) for action in actions] if isinstance(actions, list) else [],
            params=dict(params) if isinstance(params, Mapping) else {},
        )

    if isinstance(raw, Mapping):
        raw_actions = raw.get("actions")
        return AgentTurn(
            text=str(raw.get("text") or raw.get("message") or ""),
            actions=[str(action) for action in raw_actions] if isinstance(raw_actions, list) else [],
            params=dict(raw.get("params")) if isinstance(raw.get("params"), Mapping) else {},
        )

    return AgentTurn(text=str(raw or ""))


def detect_payment_demand(turn: AgentTurn) -> PaymentDemand | None:
    """Extract a payment request from structured action params or text."""
    action_payload = _payment_action_payload(turn)
    if action_payload is not None:
        amount = _read_money(action_payload, "amount_usd", "amountUsd", "amount", "price")
        if amount is None:
            amount = _amount_from_text(turn.text)
        if amount is None:
            amount = 1.0
        return PaymentDemand(
            amount_usd=amount,
            action_name=str(action_payload.get("command") or action_payload.get("action") or "REQUEST_PAYMENT"),
            source="action",
            provider=_read_string(action_payload, "provider", "payment_provider") or "oxapay",
            app_id=_read_string(action_payload, "app_id", "appId") or "woobench-mock-app",
            description=_read_string(action_payload, "description")
            or _description_from_text(turn.text)
            or "WooBench reading charge",
        )

    amount = _amount_from_text(turn.text)
    if amount is None:
        return None
    return PaymentDemand(
        amount_usd=amount,
        action_name="TEXT_PAYMENT_REQUEST",
        source="text",
        description=_description_from_text(turn.text) or "WooBench reading charge",
    )


def detect_payment_check(turn: AgentTurn) -> str | None:
    """Return the normalized check command when the agent asks to verify payment."""
    payloads = _benchmark_payloads(turn.params)
    payload = payloads[0] if payloads else {}
    for candidate in payloads:
        command = _normalized_command(candidate)
        if command in CHECK_PAYMENT_COMMANDS:
            return command
    for action in turn.actions:
        normalized = action.strip().upper()
        if normalized in CHECK_PAYMENT_COMMANDS or (
            normalized == "PAYMENT"
            and str(payload.get("op", "")).strip().lower() == "check"
        ):
            return normalized
    return None


def _payment_action_payload(turn: AgentTurn) -> dict[str, Any] | None:
    payloads = _benchmark_payloads(turn.params)
    payload = payloads[0] if payloads else {}
    for candidate in payloads:
        command = _normalized_command(candidate)
        if command in CREATE_PAYMENT_COMMANDS:
            return candidate

    for action in turn.actions:
        normalized = action.strip().upper()
        if normalized in CREATE_PAYMENT_COMMANDS:
            return {"command": normalized, **payload}
        if normalized == "PAYMENT" and str(payload.get("op", "")).strip().lower() == "request":
            return {"command": "REQUEST_PAYMENT", **payload}
    return None


def _benchmark_payload(params: Mapping[str, Any]) -> dict[str, Any]:
    payloads = _benchmark_payloads(params)
    return payloads[0] if payloads else dict(params)


def _benchmark_payloads(params: Mapping[str, Any]) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    nested_many = params.get("BENCHMARK_ACTIONS")
    if isinstance(nested_many, list):
        for item in nested_many:
            if isinstance(item, Mapping):
                payloads.append(dict(item))
    nested = params.get("BENCHMARK_ACTION")
    if isinstance(nested, Mapping):
        payloads.append(dict(nested))
    nested = params.get("PAYMENT")
    if isinstance(nested, Mapping):
        payloads.append(dict(nested))
    if not payloads:
        payloads.append(dict(params))
    return payloads


def _normalized_command(payload: Mapping[str, Any]) -> str:
    for key in ("command", "action", "name", "operation"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().upper()
    return ""


def _read_string(payload: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _read_money(payload: Mapping[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return round(float(value), 2)
        if isinstance(value, str) and value.strip():
            parsed = _parse_money(value)
            if parsed is not None:
                return parsed
    return None


def _amount_from_text(text: str) -> float | None:
    for pattern in (
        r"\$(\d+(?:\.\d{1,2})?)",
        r"(\d+(?:\.\d{1,2})?)\s*(?:USDC|usdc|dollars?)",
    ):
        match = re.search(pattern, text)
        if match:
            return _parse_money(match.group(1))
    return None


def _parse_money(value: str) -> float | None:
    cleaned = value.strip().replace("$", "")
    try:
        parsed = float(cleaned)
    except ValueError:
        return None
    if not parsed > 0:
        return None
    return round(parsed, 2)


def _description_from_text(text: str) -> str | None:
    stripped = " ".join(text.split())
    if not stripped:
        return None
    return stripped[:160]
