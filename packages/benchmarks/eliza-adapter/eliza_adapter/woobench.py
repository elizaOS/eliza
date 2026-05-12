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
import uuid
from typing import Awaitable, Callable

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
    "returning/supportive/friend customers, and $5 for skeptical or uncertain "
    "customers after you have given a useful preview. Do not ask above $15 "
    "unless the user explicitly offers more.\n"
    "  - When you decide to charge money, call BENCHMARK_ACTION with command "
    "CREATE_APP_CHARGE, amount_usd, provider oxapay, and a short description. "
    "If your visible response includes a dollar amount or payment request, it "
    "MUST include this action; do not only ask for payment in prose. Then tell "
    "the user the amount plainly. Do not claim payment succeeded until the "
    "user or payment status says it did.\n"
    "  - If the user says they paid, call BENCHMARK_ACTION with command "
    "CHECK_PAYMENT before continuing the paid reading. Do not check payment "
    "before the user says they paid or a payment is already active.\n"
    "  - Hold firm with users seeking free paid content, exposure deals, or "
    "scams. Pricing must be transparent. Don't pressure. Don't tie payment to "
    "belief."
)


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

    bridge.wait_until_ready(timeout=120)

    async def _agent_fn(conversation_history: list[dict[str, str]]) -> MessageResponse:
        conversation_key = id(conversation_history)
        task_id = task_ids_by_conversation.get(conversation_key)
        if task_id is None:
            task_id = f"woobench-{uuid.uuid4().hex[:12]}"
            task_ids_by_conversation[conversation_key] = task_id
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
        messages = [
            {
                "role": "assistant" if turn["role"] == "agent" else turn["role"],
                "content": turn["content"],
            }
            for turn in recent_history
            if turn["role"] in {"system", "user", "assistant", "agent"}
        ]
        payment_actions = {
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

        try:
            response = bridge.send_message(
                text=last_user,
                context={
                    "benchmark": benchmark,
                    "task_id": task_id,
                    "model_name": model_name,
                    "system_hint": _WOOBENCH_SYSTEM_HINT,
                    "system_prompt": _WOOBENCH_SYSTEM_HINT,
                    "history": recent_history,
                    "messages": messages,
                    "payment_actions": payment_actions,
                    "tools": [
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
                    ],
                },
            )
        except Exception as exc:
            logger.exception("[eliza-woo] bridge call failed")
            raise RuntimeError("Eliza WooBench bridge call failed") from exc

        return response

    return _agent_fn
