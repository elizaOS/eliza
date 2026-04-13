"""
Social Alpha Benchmark Plugin for ElizaOS.

Provides actions and a provider that allow an ElizaOS AgentRuntime to perform
social-alpha tasks:
  - EXTRACT_RECOMMENDATION: parse a message for trading signals
  - PROCESS_CALL: record a trade call and update trust metrics
  - GET_TRUST_SCORE: query trust score for a user
  - GET_LEADERBOARD: produce a ranked list of users

The plugin also installs a multi-provider model handler (same approach as the
GAIA benchmark) so LLM calls go through the runtime's model system.

All mutable state lives in module-level stores (reset via ``reset_plugin_state``).
"""

from __future__ import annotations

import json
import math
import os
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.memory import Memory
    from elizaos.types.state import State

# ---------------------------------------------------------------------------
# Shared in-process state
# ---------------------------------------------------------------------------

# Per-user call tracking for trust score computation
_user_calls: dict[str, list[dict[str, str | float | int | bool]]] = {}
_user_tokens_seen: dict[str, set[str]] = {}
_user_negative_calls: dict[str, int] = {}

# Token price tracking
_token_initial_prices: dict[str, float] = {}
_token_worst_prices: dict[str, float] = {}
_token_best_prices: dict[str, float] = {}


def reset_plugin_state() -> None:
    """Reset all mutable plugin state between benchmark runs."""
    _user_calls.clear()
    _user_tokens_seen.clear()
    _user_negative_calls.clear()
    _token_initial_prices.clear()
    _token_worst_prices.clear()
    _token_best_prices.clear()


# ---------------------------------------------------------------------------
# Internal helpers (user tracking & trust score)
# ---------------------------------------------------------------------------


def _add_call(
    user_id: str,
    token: str,
    rec_type: str,
    conviction: str,
    price: float,
    ts: int,
) -> None:
    _user_calls.setdefault(user_id, []).append({
        "token": token,
        "type": rec_type,
        "conviction": conviction,
        "price": price,
        "ts": ts,
        "best_price": price,
        "worst_price": price,
    })
    _user_tokens_seen.setdefault(user_id, set()).add(token)
    if rec_type == "SELL":
        _user_negative_calls[user_id] = _user_negative_calls.get(user_id, 0) + 1


def _update_token_price(token_address: str, price: float) -> None:
    for calls in _user_calls.values():
        for call in calls:
            if call["token"] == token_address:
                bp = float(call["best_price"])
                wp = float(call["worst_price"])
                call["best_price"] = max(bp, price)
                call["worst_price"] = min(wp, price)

    worst = _token_worst_prices.get(token_address, price)
    _token_worst_prices[token_address] = min(worst, price)
    best = _token_best_prices.get(token_address, price)
    _token_best_prices[token_address] = max(best, price)


def _compute_user_metrics(user_id: str) -> dict[str, float | int]:
    calls = _user_calls.get(user_id, [])
    n = len(calls)
    if n == 0:
        return {
            "win_rate": 0.5, "avg_profit": 0.0, "std": 0.0, "sharpe": 0.0,
            "wins": 0, "losses": 0, "rug_rate": 0.0, "negative_rate": 0.0,
            "good_calls": 0, "rug_promotions": 0,
        }

    profits: list[float] = []
    rug_calls = 0
    good_calls = 0
    for c in calls:
        p = float(c["price"])
        if p <= 0:
            continue
        bp = float(c["best_price"])
        wp = float(c["worst_price"])
        if c["type"] == "BUY":
            pct = ((bp - p) / p) * 100
        else:
            pct = ((p - wp) / p) * 100
        profits.append(pct)
        drop = ((wp - p) / p) * 100
        if drop <= -80 and c["type"] == "BUY":
            rug_calls += 1
        gain = ((bp - p) / p) * 100
        if gain >= 20:
            good_calls += 1

    if not profits:
        return {
            "win_rate": 0.5, "avg_profit": 0.0, "std": 0.0, "sharpe": 0.0,
            "wins": 0, "losses": 0, "rug_rate": 0.0, "negative_rate": 0.0,
            "good_calls": 0, "rug_promotions": 0,
        }

    wins = sum(1 for p in profits if p >= 5)
    losses = sum(1 for p in profits if p <= -10)
    evaluated = wins + losses
    win_rate = wins / evaluated if evaluated > 0 else 0.5
    avg_profit = sum(profits) / len(profits)
    mean = avg_profit
    std = math.sqrt(sum((p - mean) ** 2 for p in profits) / max(len(profits) - 1, 1)) if len(profits) > 1 else 0.0
    sharpe = mean / std if std > 0 else 0.0
    neg = _user_negative_calls.get(user_id, 0)

    return {
        "win_rate": win_rate,
        "avg_profit": avg_profit,
        "std": std,
        "sharpe": sharpe,
        "wins": wins,
        "losses": losses,
        "rug_rate": rug_calls / n if n > 0 else 0.0,
        "negative_rate": neg / n if n > 0 else 0.0,
        "good_calls": good_calls,
        "rug_promotions": rug_calls,
    }


def _classify_archetype(user_id: str) -> str:
    calls = _user_calls.get(user_id, [])
    n = len(calls)
    tokens = _user_tokens_seen.get(user_id, set())
    if n < 5 or len(tokens) < 3:
        return "low_info"

    m = _compute_user_metrics(user_id)
    wr = float(m["win_rate"])
    ap = float(m["avg_profit"])
    std = float(m["std"])
    rr = float(m["rug_rate"])
    nr = float(m["negative_rate"])

    if rr >= 0.30:
        return "rug_promoter"
    if nr >= 0.30 and rr == 0:
        if nr >= 0.70 and len(tokens) < 3:
            return "fud_artist"
    if n <= 3 and ap > 50:
        return "one_hit_wonder"
    if wr >= 0.65 and ap >= 20.0 and rr < 0.10:
        return "alpha_caller"
    if wr >= 0.55 and ap >= 5.0:
        return "solid_trader"
    if std >= 40.0:
        return "degen_gambler"
    if abs(wr - 0.50) <= 0.05 and abs(ap) < 5:
        return "noise_maker"
    return "low_info"


def _compute_trust_score(user_id: str) -> float:
    calls = _user_calls.get(user_id, [])
    n = len(calls)
    if n == 0:
        return 50.0

    archetype = _classify_archetype(user_id)
    m = _compute_user_metrics(user_id)

    from elizaos_plugin_social_alpha.trust_score import (
        TrustScoreMetrics,
        calculate_balanced_trust_score,
    )

    metrics = TrustScoreMetrics(
        total_calls=n,
        profitable_calls=int(m["wins"]),
        average_profit=float(m["avg_profit"]),
        win_rate=float(m["win_rate"]),
        sharpe_ratio=float(m["sharpe"]),
        alpha=float(m["avg_profit"]),
        volume_penalty=0,
        consistency=max(0.0, 1.0 - float(m["std"]) / 100) if float(m["std"]) > 0 else 1.0,
    )

    return calculate_balanced_trust_score(
        metrics,
        archetype,
        int(m["rug_promotions"]),
        int(m["good_calls"]),
        n,
    )


# ---------------------------------------------------------------------------
# LLM-based extraction prompt
# ---------------------------------------------------------------------------

_EXTRACTION_SYSTEM = (
    "You are a crypto trading signal extractor.  Given a Discord message from a "
    "trading community, determine whether it contains a trading recommendation."
)

_EXTRACTION_USER = """Message: "{message}"

Respond with ONLY a JSON object (no markdown, no explanation):
{{
  "is_recommendation": true/false,
  "recommendation_type": "BUY" or "SELL" or "NOISE",
  "conviction": "HIGH" or "MEDIUM" or "LOW" or "NONE",
  "token_mentioned": "TICKER" or ""
}}

Rules:
- BUY = positive (bullish, shilling, recommending purchase, posting a CA/URL)
- SELL = negative (bearish, FUD, warning against)
- NOISE = general discussion, questions, no recommendation
- Token should be the ticker symbol (e.g. SOL, BTC, BONK) or empty
- Conviction: HIGH = very confident/urgent, MEDIUM = moderate, LOW = casual, NONE = no rec"""


# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------


def create_social_alpha_actions() -> list:
    """Create the EXTRACT_RECOMMENDATION and PROCESS_CALL actions."""
    from elizaos.types.components import (
        Action,
        ActionParameter,
        ActionParameterSchema,
        ActionResult,
        HandlerCallback,
        HandlerOptions,
    )

    actions: list[Action] = []

    # --- EXTRACT_RECOMMENDATION ---

    async def extract_validate(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return True

    async def extract_handler(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        from elizaos.types.model import ModelType

        msg_text = ""
        if options and options.parameters:
            msg_text = str(options.parameters.get("message", ""))
        if not msg_text and message.content and message.content.text:
            msg_text = str(message.content.text)

        prompt_user = _EXTRACTION_USER.format(message=msg_text[:500].replace('"', '\\"'))
        result_text: str = await runtime.use_model(
            ModelType.TEXT_LARGE,
            {
                "system": _EXTRACTION_SYSTEM,
                "prompt": prompt_user,
                "temperature": 0.0,
                "max_tokens": 200,
            },
        )

        # Parse the JSON from the LLM
        parsed = _parse_extraction_json(result_text)

        return ActionResult(
            text=json.dumps(parsed),
            data={"actionName": "EXTRACT_RECOMMENDATION", **parsed},
            success=True,
        )

    actions.append(Action(
        name="EXTRACT_RECOMMENDATION",
        description="Extract a trading recommendation (BUY/SELL/NOISE) from a chat message",
        similes=["extract", "classify", "parse recommendation"],
        handler=extract_handler,
        validate=extract_validate,
        parameters=[
            ActionParameter(
                name="message",
                description="The chat message text to analyse",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
        ],
    ))

    # --- PROCESS_CALL ---

    async def process_call_validate(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return True

    async def process_call_handler(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        params: dict[str, str] = {}
        if options and options.parameters:
            for key in ("user_id", "token_address", "recommendation_type",
                        "conviction", "price_at_call", "timestamp"):
                val = options.parameters.get(key)
                if val is not None:
                    params[key] = str(val)

        user_id = params.get("user_id", "")
        token_address = params.get("token_address", "")
        rec_type = params.get("recommendation_type", "BUY")
        conviction = params.get("conviction", "MEDIUM")
        price = float(params.get("price_at_call", "0"))
        ts = int(float(params.get("timestamp", "0")))

        _add_call(user_id, token_address, rec_type, conviction, price, ts)
        if token_address not in _token_initial_prices:
            _token_initial_prices[token_address] = price

        return ActionResult(
            text=f"Recorded {rec_type} call for user {user_id} on {token_address}",
            data={"actionName": "PROCESS_CALL", "user_id": user_id},
            success=True,
        )

    actions.append(Action(
        name="PROCESS_CALL",
        description="Record a trading call and update trust metrics for a user",
        similes=["process call", "record trade", "update trust"],
        handler=process_call_handler,
        validate=process_call_validate,
        parameters=[
            ActionParameter(name="user_id", description="User ID", required=True,
                            schema=ActionParameterSchema(type="string")),
            ActionParameter(name="token_address", description="Token address", required=True,
                            schema=ActionParameterSchema(type="string")),
            ActionParameter(name="recommendation_type", description="BUY or SELL", required=True,
                            schema=ActionParameterSchema(type="string")),
            ActionParameter(name="conviction", description="HIGH/MEDIUM/LOW", required=True,
                            schema=ActionParameterSchema(type="string")),
            ActionParameter(name="price_at_call", description="Price at call time", required=True,
                            schema=ActionParameterSchema(type="string")),
            ActionParameter(name="timestamp", description="Unix ms timestamp", required=True,
                            schema=ActionParameterSchema(type="string")),
        ],
    ))

    return actions


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------


def create_social_alpha_provider():  # noqa: ANN201
    """Create a SOCIAL_ALPHA_CONTEXT provider that injects call history / trust data."""
    from elizaos.types.components import Provider, ProviderResult

    async def get_context(
        runtime: AgentRuntime,
        message: Memory,
        state: State,
    ) -> ProviderResult:
        total_users = len(_user_calls)
        total_calls = sum(len(c) for c in _user_calls.values())
        total_tokens = len(_token_initial_prices)

        text = (
            f"[Social Alpha Context]\n"
            f"Tracked users: {total_users} | Total calls: {total_calls} | "
            f"Tracked tokens: {total_tokens}"
        )

        return ProviderResult(text=text)

    return Provider(
        name="SOCIAL_ALPHA_CONTEXT",
        get=get_context,
        description="Injects current social-alpha call history and trust score summaries",
    )


# ---------------------------------------------------------------------------
# Model handler (multi-provider, same approach as GAIA benchmark)
# ---------------------------------------------------------------------------


async def social_alpha_model_handler(
    runtime: AgentRuntime,
    params: dict[str, object],
) -> str:
    """
    Model handler that routes through a configured LLM provider.

    Reads OPENAI-compatible settings from environment/runtime and calls the
    chat completions API. Supports ``prompt``/``system`` or ``messages``
    parameter styles.
    """
    import aiohttp

    messages: list[dict[str, str]] = []

    if "messages" in params and isinstance(params["messages"], list):
        messages = params["messages"]  # type: ignore[assignment]
    else:
        system = params.get("system")
        if system:
            messages.append({"role": "system", "content": str(system)})
        prompt = params.get("prompt")
        if prompt:
            messages.append({"role": "user", "content": str(prompt)})

    if not messages:
        raise ValueError("No messages or prompt provided to model handler")

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        api_key_from_runtime = runtime.get_setting("OPENAI_API_KEY")
        if isinstance(api_key_from_runtime, str):
            api_key = api_key_from_runtime

    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")

    api_base = os.environ.get("OPENAI_BASE_URL", "").strip()
    if not api_base:
        api_base_from_runtime = runtime.get_setting("OPENAI_BASE_URL")
        if isinstance(api_base_from_runtime, str):
            api_base = api_base_from_runtime.strip()
    if not api_base:
        api_base = os.environ.get("OPENAI_API_BASE", "").strip()
    if not api_base:
        api_base = "https://api.openai.com/v1"

    runtime_model = runtime.get_setting("OPENAI_LARGE_MODEL")
    if not isinstance(runtime_model, str):
        runtime_model = ""
    env_model = os.environ.get("OPENAI_LARGE_MODEL", "")
    model = str(params.get("model") or runtime_model or env_model or "gpt-4o-mini")
    temperature = float(params.get("temperature", 0.0))
    max_tokens = int(params.get("max_tokens", params.get("maxTokens", 4096)))

    payload: dict[str, str | int | float | list[dict[str, str]]] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Accept-Encoding": "gzip",
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{api_base.rstrip('/')}/chat/completions",
            headers=headers,
            json=payload,
        ) as response:
            if response.status != 200:
                error_text = await response.text()
                raise RuntimeError(f"OpenAI API error ({response.status}): {error_text}")
            data = await response.json()

    choices = data.get("choices", [])
    if not choices:
        raise ValueError("No choices in OpenAI response")

    return str(choices[0].get("message", {}).get("content", ""))


# ---------------------------------------------------------------------------
# JSON parsing helper
# ---------------------------------------------------------------------------


def _parse_extraction_json(text: str) -> dict[str, str | bool]:
    """Best-effort parse of the LLM extraction JSON output."""
    text = text.strip()
    # Strip markdown fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in the text
        match = re.search(r'\{[^}]+\}', text, re.DOTALL)
        if match:
            try:
                raw = json.loads(match.group())
            except json.JSONDecodeError:
                raw = {}
        else:
            raw = {}

    rec_type = raw.get("recommendation_type", "NOISE")
    if rec_type not in ("BUY", "SELL", "NOISE"):
        rec_type = "NOISE"

    conv = raw.get("conviction", "NONE")
    if conv not in ("HIGH", "MEDIUM", "LOW", "NONE"):
        conv = "NONE"

    is_rec = bool(raw.get("is_recommendation", False)) and rec_type != "NOISE"

    return {
        "is_recommendation": is_rec,
        "recommendation_type": rec_type,
        "conviction": conv,
        "token_mentioned": str(raw.get("token_mentioned", "")),
    }


# ---------------------------------------------------------------------------
# Plugin factory
# ---------------------------------------------------------------------------


def create_social_alpha_benchmark_plugin():  # noqa: ANN201
    """Create the social-alpha benchmark ElizaOS plugin."""
    from elizaos.types.model import ModelType
    from elizaos.types.plugin import Plugin

    actions = create_social_alpha_actions()
    provider = create_social_alpha_provider()

    async def init_plugin(
        config: dict[str, str | int | float | bool | None],
        runtime: AgentRuntime,
    ) -> None:
        runtime.logger.info("Initializing social-alpha benchmark plugin")

    return Plugin(
        name="social-alpha-benchmark",
        description="Social Alpha benchmark plugin — extraction, trust scoring, and ranking via Eliza runtime",
        init=init_plugin,
        config={},
        actions=actions,
        providers=[provider],
        models={
            ModelType.TEXT_LARGE: social_alpha_model_handler,
            ModelType.TEXT_SMALL: social_alpha_model_handler,
        },
    )


# Default plugin instance
social_alpha_benchmark_plugin = create_social_alpha_benchmark_plugin()
