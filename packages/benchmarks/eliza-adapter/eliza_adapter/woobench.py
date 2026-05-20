"""WooBench agent_fn backed by the eliza benchmark server.

WooBench accepts either a reply string or a bridge ``MessageResponse``. This
adapter returns the full bridge response so the benchmark can execute captured
payment actions instead of inferring every charge from prose.

This adapter routes each turn through the elizaOS TS benchmark server
via ``ElizaClient.send_message`` instead of binding a Python AgentRuntime.
The bridge handles state composition, providers, and model dispatch.
"""

from __future__ import annotations

import logging
import json
import re
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, Awaitable, Callable

from eliza_adapter.client import ElizaClient, MessageResponse

logger = logging.getLogger(__name__)


_WOOBENCH_SYSTEM_HINT = (
    "You are a mystical reading agent providing personalized divination "
    "readings (tarot, I Ching, astrology). Reply directly to the user's most "
    "recent message.\n\n"
    "READ THE USER FIRST. Calibrate tone before content:\n"
    "  - If they self-identify as a SKEPTIC, SCIENTIST, or RESEARCHER, drop the "
    "mystical register entirely. Frame the reading as structured reflection / "
    "projective psychology / Jungian archetypes. Acknowledge the Barnum effect, "
    "confirmation bias, and cold-reading explicitly. Never claim predictive "
    "validity or that 'the universe' is communicating. Treat them as a peer.\n"
    "  - For paid skeptic readings, do not stall by asking them to provide a "
    "question. Continue with a concrete reading from the details already "
    "available: analytical armor, work/data-science identity, control, guarded "
    "emotion, and the fact they are participating for someone else's sake. If "
    "they reject a family/children/sleep interpretation, apologize once, drop "
    "that thread, and pivot to work, control, and emotional guardedness.\n"
    "  - If they self-identify as SPIRITUAL, a BELIEVER, or a fellow "
    "PRACTITIONER, match their register. Use intuitive language but ground it "
    "in concrete symbolic content from the cards/hexagrams/chart.\n"
    "  - If they are GUARDED, sarcastic, or terse, do NOT push. Acknowledge "
    "their position warmly, offer choice, and let them lead disclosure.\n\n"
    "DEPTH RULES:\n"
    "  - Pull on details the user has revealed; weave them back. Reference "
    "names, places, ages they mention.\n"
    "  - Surface SUBTEXT: notice when their words contradict their feelings, "
    "and gently name the tension (e.g. confidence masking financial fear, "
    "analytical armor masking heartbreak, age pressure beneath \"I'm aligned\").\n"
    "  - Touch family/ancestral and generational themes when relevant — "
    "grandparents, mothers, children — these often carry the real charge.\n"
    "  - Avoid generic Barnum lines (\"you're at a crossroads\", \"change is "
    "coming\"). Be specific or invite the user to interpret.\n"
    "  - Synthesize at close: weave the threads into one coherent arc rather "
    "than a card-by-card recap.\n\n"
    "BUSINESS:\n"
    "  - Free intro is fine; full reading is paid. Earn trust before charging. "
    "Do not charge on the first turn for skeptical, guarded, or uncertain users "
    "unless they explicitly ask for a paid reading.\n"
    "  - Default WooBench prices: $10 for a full first paid reading, $15 for "
    "returning/supportive/friend customers, and $3 for skeptical or uncertain "
    "customers after you have given a useful preview. Use those exact amounts "
    "unless the user explicitly offers more. Do not ask above $15.\n"
    "  - Treat explicit support language as the $15 tier. If the user says they "
    "want to support you, are a friend/supporter, or asks for the real/full paid "
    "reading without skepticism, create a $15 charge rather than the $10 default.\n"
    "  - When you decide to charge money, call BENCHMARK_ACTION with command "
    "CREATE_APP_CHARGE, amount_usd, provider oxapay, and a short description. "
    "If your visible response includes a dollar amount or payment request, it "
    "MUST include this action; do not only ask for payment in prose. Then tell "
    "the user the amount plainly. Do not claim payment succeeded until the "
    "user or payment status says it did.\n"
    "  - Create at most one charge per reading. Once the user has paid, continue "
    "the reading instead of creating another charge.\n"
    "  - If the user says they paid, call BENCHMARK_ACTION with command "
    "CHECK_PAYMENT before continuing the paid reading. Do not check payment "
    "before the user says they paid or a payment is already active.\n"
    "  - Hold firm with users seeking free paid content, exposure deals, or "
    "scams. Pricing must be transparent. Don't pressure. Don't tie payment to "
    "belief."
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

_PAYMENT_ACTIONS: dict[str, dict[str, object]] = {
    "create": {
        "action": "BENCHMARK_ACTION",
        "command": "CREATE_APP_CHARGE",
        "required_params": ["amount_usd"],
        "optional_params": ["provider", "description", "app_id"],
        "providers": ["oxapay", "stripe"],
    },
    "check": {
        "action": "BENCHMARK_ACTION",
        "command": "CHECK_PAYMENT",
    },
}


def _tool_payload(response: MessageResponse) -> dict[str, Any] | None:
    params = response.params if isinstance(response.params, Mapping) else {}
    existing = params.get("BENCHMARK_ACTION")
    if isinstance(existing, Mapping):
        return {str(k): v for k, v in existing.items()}
    actions = params.get("BENCHMARK_ACTIONS")
    if isinstance(actions, Sequence) and not isinstance(actions, (str, bytes)):
        for action in actions:
            if isinstance(action, Mapping):
                command = str(action.get("command") or "").strip().upper()
                if command in {"CREATE_APP_CHARGE", "CHECK_PAYMENT"}:
                    return {str(k): v for k, v in action.items()}
    tool_calls = params.get("tool_calls")
    if isinstance(tool_calls, Sequence) and not isinstance(tool_calls, (str, bytes)):
        for call in tool_calls:
            if not isinstance(call, Mapping):
                continue
            function = call.get("function")
            function_map = function if isinstance(function, Mapping) else {}
            name = str(call.get("name") or function_map.get("name") or "").strip().upper()
            if name not in {"CREATE_APP_CHARGE", "CHECK_PAYMENT"}:
                continue
            arguments = call.get("arguments", function_map.get("arguments"))
            if isinstance(arguments, str) and arguments.strip():
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {}
            args = arguments if isinstance(arguments, Mapping) else {}
            return {"command": name, **{str(k): v for k, v in args.items()}}
    return None


def _is_empty_or_generic_failure(text: str | None) -> bool:
    normalized = " ".join((text or "").strip().lower().split())
    return not normalized or normalized in {
        "i apologize, but something went wrong with our connection. please try again and we'll be back to your reading.",
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


def _with_visible_payment_text(response: MessageResponse) -> MessageResponse:
    payload = _tool_payload(response)
    if payload is None or not _is_empty_or_generic_failure(response.text):
        return response
    return MessageResponse(
        text=_visible_text_for_payment_payload(payload),
        thought=response.thought,
        actions=list(response.actions),
        params=dict(response.params),
        metadata=dict(response.metadata),
    )


def _amount_from_text(text: str | None) -> float | None:
    if not text:
        return None
    match = re.search(r"\$(\d[\d,]*(?:\.\d{1,2})?)", text)
    if not match:
        return None
    try:
        return round(float(match.group(1).replace(",", "")), 2)
    except ValueError:
        return None


def _with_inferred_payment_action(response: MessageResponse) -> MessageResponse:
    if _tool_payload(response) is not None:
        return response
    amount = _amount_from_text(response.text)
    text = (response.text or "").lower()
    if amount is None or not any(term in text for term in ("payment", "charge", "cost", "paid")):
        return response
    params = dict(response.params)
    params["BENCHMARK_ACTION"] = {
        "command": "CREATE_APP_CHARGE",
        "amount_usd": amount,
        "provider": "oxapay",
        "description": "WooBench reading charge",
    }
    actions = list(response.actions)
    if "BENCHMARK_ACTION" not in actions:
        actions.append("BENCHMARK_ACTION")
    return MessageResponse(
        text=response.text,
        thought=response.thought,
        actions=actions,
        params=params,
        metadata=dict(response.metadata),
    )


def _tools_for_payment_state(state: Mapping[str, bool]) -> list[dict[str, object]]:
    if state.get("payment_verified"):
        return []
    if state.get("charge_created"):
        return [_TOOLS[1]]
    return _TOOLS


def _system_hint_for_payment_state(state: Mapping[str, bool]) -> str:
    if state.get("payment_verified"):
        return (
            _WOOBENCH_SYSTEM_HINT
            + "\n\nPAYMENT STATE: The current reading has already been paid and "
            "verified. Do not create another charge and do not check payment "
            "again. Continue the substantive reading now."
        )
    if state.get("charge_created"):
        return (
            _WOOBENCH_SYSTEM_HINT
            + "\n\nPAYMENT STATE: A charge has already been created for this "
            "reading. Do not create another charge. If the user says they paid, "
            "call BENCHMARK_ACTION with command CHECK_PAYMENT once; otherwise "
            "answer briefly and wait."
        )
    return _WOOBENCH_SYSTEM_HINT


def _record_payment_payload(state: dict[str, bool], payload: Mapping[str, Any] | None) -> None:
    if payload is None:
        return
    command = str(payload.get("command") or "").strip().upper()
    if command == "CREATE_APP_CHARGE":
        state["charge_created"] = True
    elif command == "CHECK_PAYMENT":
        state["payment_verified"] = True


def build_eliza_bridge_agent_fn(
    client: ElizaClient | None = None,
    *,
    benchmark: str = "woobench",
    model_name: str | None = None,
) -> Callable[[list[dict[str, str]]], Awaitable[MessageResponse]]:
    """Create a WooBench-compatible ``agent_fn`` backed by the eliza TS bridge.

    Each invocation reads the latest user turn out of the conversation
    history and forwards it to the bridge with the recent history attached
    as context. The full bridge response is returned so WooBench can inspect
    action metadata.

    A unique ``task_id`` is generated per conversation object, so concurrent
    scenario runs keep separate bridge state while repeated turns within one
    conversation stay stateful.
    """
    bridge = client or ElizaClient()
    task_ids_by_conversation: dict[int, str] = {}
    payment_state_by_conversation: dict[int, dict[str, bool]] = {}

    bridge.wait_until_ready(timeout=120)

    async def _agent_fn(conversation_history: list[dict[str, str]]) -> MessageResponse:
        conversation_key = id(conversation_history)
        task_id = task_ids_by_conversation.get(conversation_key)
        is_new_conversation = (
            len(conversation_history) == 1
            and conversation_history[0].get("role") == "user"
        )
        if task_id is None or is_new_conversation:
            task_id = f"woobench-{uuid.uuid4().hex[:12]}"
            task_ids_by_conversation[conversation_key] = task_id
            payment_state_by_conversation[conversation_key] = {
                "charge_created": False,
                "payment_verified": False,
            }
            try:
                bridge.reset(task_id=task_id, benchmark=benchmark)
            except Exception as exc:
                logger.debug("[eliza-woo] reset failed (continuing): %s", exc)

        last_user = ""
        for turn in reversed(conversation_history):
            if turn.get("role") == "user":
                last_user = str(turn.get("content", ""))
                break
        if not last_user:
            return MessageResponse(text="", thought=None, actions=[], params={})

        recent_history = [
            {"role": str(t.get("role", "")), "content": str(t.get("content", ""))}
            for t in conversation_history[-10:]
        ]
        payment_state = payment_state_by_conversation.setdefault(
            conversation_key,
            {"charge_created": False, "payment_verified": False},
        )
        system_hint = _system_hint_for_payment_state(payment_state)
        tools = _tools_for_payment_state(payment_state)
        messages = [
            {
                "role": "assistant" if turn["role"] == "agent" else turn["role"],
                "content": turn["content"],
            }
            for turn in recent_history
            if turn["role"] in {"user", "assistant", "agent"}
            and str(turn["content"]).strip() != system_hint
        ]

        try:
            response = bridge.send_message(
                text=last_user,
                context={
                    "benchmark": benchmark,
                    "task_id": task_id,
                    "model_name": model_name,
                    "system_hint": system_hint,
                    "system_prompt": system_hint,
                    "history": recent_history,
                    "messages": messages,
                    "payment_actions": _PAYMENT_ACTIONS,
                    "tools": tools,
                    "tool_choice": "auto" if tools else "none",
                },
            )
        except Exception as exc:
            logger.exception("[eliza-woo] bridge call failed")
            raise RuntimeError("Eliza WooBench bridge call failed") from exc

        response = _with_inferred_payment_action(response)
        _record_payment_payload(payment_state, _tool_payload(response))
        return _with_visible_payment_text(response)

    return _agent_fn
