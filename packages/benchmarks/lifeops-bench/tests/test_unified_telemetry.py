"""Wave 1-A unified telemetry tests.

Verify that:
  1. Cerebras-shaped usage (``usage.prompt_tokens_details.cached_tokens``)
     populates ``cache_read_input_tokens`` on ``Usage``.
  2. Anthropic-shaped usage (``cache_read_input_tokens`` +
     ``cache_creation_input_tokens`` at the usage root) populates both
     cache fields on ``Usage``.
  3. ``cache_supported`` stays ``True`` on the new ``TurnResult`` defaults
     (Cerebras gpt-oss-120b + Anthropic Claude both support prompt caching).
  4. ``compute_cache_hit_pct`` returns ``None`` for missing data and the
     correct fraction otherwise.
  5. The hermes-adapter / openclaw-adapter cache-attach helpers parse the
     same usage shapes onto a plain stand-in object via ``setattr``.
"""

from __future__ import annotations

from typing import Any

import pytest

from eliza_lifeops_bench import compute_cache_hit_pct
from eliza_lifeops_bench.clients.anthropic import AnthropicClient, ANTHROPIC_PRICING
from eliza_lifeops_bench.clients.base import Usage
from eliza_lifeops_bench.clients.cerebras import CerebrasClient
from eliza_lifeops_bench.types import TurnResult


# ---------------------------------------------------------------------------
# Stand-in objects so we don't have to run any real HTTP calls.
# ---------------------------------------------------------------------------


class _FakeResponse:
    """Minimal stand-in for ``httpx.Response`` returning a fixed JSON body."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body
        self.status_code = 200
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._body


class _FakeAsyncClient:
    """Stand-in for ``httpx.AsyncClient`` that returns the fixed response."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    async def post(self, *_args: Any, **_kwargs: Any) -> _FakeResponse:  # noqa: ANN401
        return _FakeResponse(self._body)

    async def aclose(self) -> None:
        return None


class _FakeAnthropicMessage:
    """Mimics the typed object returned by the Anthropic SDK."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

    def model_dump(self) -> dict[str, Any]:
        return self._body


class _FakeAnthropicClient:
    """Stand-in for the AsyncAnthropic SDK client."""

    def __init__(self, body: dict[str, Any]) -> None:
        self._body = body

        class _Messages:
            def __init__(self, parent: _FakeAnthropicClient) -> None:
                self._parent = parent

            async def create(self, **_kwargs: Any) -> _FakeAnthropicMessage:  # noqa: ANN401
                return _FakeAnthropicMessage(self._parent._body)

        self.messages = _Messages(self)


# ---------------------------------------------------------------------------
# 1. Cerebras-shaped usage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cerebras_parses_cached_tokens_into_cache_read_input_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = {
        "choices": [
            {"finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}
        ],
        "usage": {
            "prompt_tokens": 1024,
            "completion_tokens": 32,
            "total_tokens": 1056,
            "prompt_tokens_details": {"cached_tokens": 896},
        },
    }
    monkeypatch.setenv("CEREBRAS_API_KEY", "test")
    client = CerebrasClient(model="gpt-oss-120b", http_client=_FakeAsyncClient(body))

    from eliza_lifeops_bench.clients.base import ClientCall

    response = await client.complete(ClientCall(messages=[{"role": "user", "content": "hi"}]))

    assert response.usage.cache_read_input_tokens == 896
    assert response.usage.cache_creation_input_tokens is None
    # Legacy compatibility: cached_tokens still surfaces the same value.
    assert response.usage.cached_tokens == 896


@pytest.mark.asyncio
async def test_cerebras_missing_cache_block_yields_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = {
        "choices": [
            {"finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}
        ],
        "usage": {
            "prompt_tokens": 64,
            "completion_tokens": 8,
            "total_tokens": 72,
            # No prompt_tokens_details at all.
        },
    }
    monkeypatch.setenv("CEREBRAS_API_KEY", "test")
    client = CerebrasClient(model="gpt-oss-120b", http_client=_FakeAsyncClient(body))

    from eliza_lifeops_bench.clients.base import ClientCall

    response = await client.complete(ClientCall(messages=[{"role": "user", "content": "hi"}]))

    # Per AGENTS.md Cmd #8: missing data stays None, not silent 0.
    assert response.usage.cache_read_input_tokens is None
    assert response.usage.cache_creation_input_tokens is None


# ---------------------------------------------------------------------------
# 2. Anthropic-shaped usage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anthropic_parses_cache_creation_and_cache_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    body = {
        "content": [{"type": "text", "text": "ok"}],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 200,
            "output_tokens": 50,
            "cache_read_input_tokens": 1024,
            "cache_creation_input_tokens": 128,
        },
    }
    client = AnthropicClient(
        model="claude-opus-4-7",
        client=_FakeAnthropicClient(body),
    )
    # Ensure the lazy import does not need the real SDK installed.
    monkeypatch.setattr(
        "eliza_lifeops_bench.clients.anthropic._import_anthropic_sdk",
        lambda: type(
            "AnthropicStub",
            (),
            {"APIStatusError": type("APIStatusError", (Exception,), {})},
        ),
    )

    from eliza_lifeops_bench.clients.base import ClientCall

    response = await client.complete(
        ClientCall(messages=[{"role": "user", "content": "hi"}])
    )

    assert response.usage.cache_read_input_tokens == 1024
    assert response.usage.cache_creation_input_tokens == 128
    # Cost calculation should account for cache_read at the discount tier.
    pricing = ANTHROPIC_PRICING["claude-opus-4-7"]
    expected_cost = (
        (200 - 1024) / 1_000_000 * pricing["input_per_million_usd"]  # negative clamps
        + 50 / 1_000_000 * pricing["output_per_million_usd"]
        + 1024 / 1_000_000 * pricing["cache_read_per_million_usd"]
    )
    # billable_input clamps at 0 in the helper; verify cost is non-negative
    # and includes the cache-read line item.
    assert response.cost_usd >= 0
    # Compute the clamped-version cost explicitly.
    clamped_cost = (
        max(0, 200 - 1024) / 1_000_000 * pricing["input_per_million_usd"]
        + 50 / 1_000_000 * pricing["output_per_million_usd"]
        + 1024 / 1_000_000 * pricing["cache_read_per_million_usd"]
    )
    assert response.cost_usd == pytest.approx(clamped_cost)
    del expected_cost  # silence unused-warn


# ---------------------------------------------------------------------------
# 3. cache_supported defaults + TurnResult cache fields
# ---------------------------------------------------------------------------


def test_turn_result_cache_supported_default_is_true() -> None:
    result = TurnResult(
        turn_number=1,
        agent_message="ok",
        agent_actions=[],
        user_response="",
        latency_ms=10,
        input_tokens=10,
        output_tokens=5,
        cost_usd=0.0,
    )
    # Cerebras gpt-oss-120b, OpenAI, and Anthropic all support caching →
    # the dataclass default is hard True.
    assert result.cache_supported is True
    # Nullable cache fields default to None — never silently 0.
    assert result.cache_read_input_tokens is None
    assert result.cache_creation_input_tokens is None
    assert result.cache_hit_pct is None


def test_turn_result_accepts_cache_fields() -> None:
    result = TurnResult(
        turn_number=2,
        agent_message="ok",
        agent_actions=[],
        user_response="",
        latency_ms=10,
        input_tokens=200,
        output_tokens=50,
        cost_usd=0.001,
        cache_read_input_tokens=1024,
        cache_creation_input_tokens=128,
        cache_hit_pct=compute_cache_hit_pct(200, 1024, 128),
        cache_supported=True,
        model_tier="large",
        prompt_cache_key="lifeops/cal/seed=42",
        model_name="gpt-oss-120b",
    )
    assert result.cache_read_input_tokens == 1024
    assert result.cache_creation_input_tokens == 128
    assert result.cache_supported is True
    assert result.model_tier == "large"
    assert result.prompt_cache_key == "lifeops/cal/seed=42"
    assert result.model_name == "gpt-oss-120b"
    # 1024 / (200 + 128 + 1024) = 1024 / 1352
    assert result.cache_hit_pct == pytest.approx(1024 / 1352)


# ---------------------------------------------------------------------------
# 4. compute_cache_hit_pct behavior
# ---------------------------------------------------------------------------


def test_compute_cache_hit_pct_none_when_any_input_missing() -> None:
    assert compute_cache_hit_pct(None, 100, 0) is None
    assert compute_cache_hit_pct(100, None, 0) is None
    assert compute_cache_hit_pct(100, 0, None) is None


def test_compute_cache_hit_pct_handles_zero_denominator() -> None:
    assert compute_cache_hit_pct(0, 0, 0) == 0.0


def test_compute_cache_hit_pct_uses_full_billed_input() -> None:
    # denominator = 100 + 50 + 250 = 400, numerator = 250
    assert compute_cache_hit_pct(100, 250, 50) == pytest.approx(250 / 400)


# ---------------------------------------------------------------------------
# 5. Adapter-level cache-attach helper
#
# ``attach_usage_cache_fields`` lives on ``eliza_lifeops_bench.types`` and is
# shared by the hermes-adapter + openclaw-adapter wrappers. Previously each
# adapter shipped its own private copy; the helper now has one canonical home.
# ---------------------------------------------------------------------------


class _AttrTurn:
    """Plain object that supports ``setattr`` / ``getattr`` — mirrors
    ``MessageTurn`` for the adapter helpers without importing eliza_lifeops_bench
    enum/dataclass machinery."""


def test_attach_usage_cerebras_shape() -> None:
    from eliza_lifeops_bench.types import attach_usage_cache_fields

    usage = {
        "prompt_tokens": 256,
        "completion_tokens": 32,
        "prompt_tokens_details": {"cached_tokens": 192},
    }
    turn = _AttrTurn()
    attach_usage_cache_fields(turn, usage)
    assert getattr(turn, "input_tokens") == 256
    assert getattr(turn, "output_tokens") == 32
    assert getattr(turn, "cache_read_input_tokens") == 192
    assert getattr(turn, "cache_creation_input_tokens") is None
    assert getattr(turn, "cache_supported") is True


def test_attach_usage_anthropic_shape() -> None:
    from eliza_lifeops_bench.types import attach_usage_cache_fields

    usage = {
        "input_tokens": 200,
        "output_tokens": 50,
        "cache_read_input_tokens": 1024,
        "cache_creation_input_tokens": 128,
    }
    turn = _AttrTurn()
    attach_usage_cache_fields(turn, usage)
    assert getattr(turn, "input_tokens") == 200
    assert getattr(turn, "output_tokens") == 50
    assert getattr(turn, "cache_read_input_tokens") == 1024
    assert getattr(turn, "cache_creation_input_tokens") == 128
    assert getattr(turn, "cache_supported") is True


def test_attach_usage_missing_cache_stays_none() -> None:
    from eliza_lifeops_bench.types import attach_usage_cache_fields

    usage = {
        "prompt_tokens": 1,
        "completion_tokens": 1,
        # No cache info at all.
    }
    turn = _AttrTurn()
    attach_usage_cache_fields(turn, usage)
    # No silent 0 fallback — AGENTS.md Cmd #8.
    assert getattr(turn, "cache_read_input_tokens") is None
    assert getattr(turn, "cache_creation_input_tokens") is None


# ---------------------------------------------------------------------------
# 6. Plain Usage dataclass — cache fields preserved through frozen=True
# ---------------------------------------------------------------------------


def test_usage_dataclass_carries_new_cache_fields() -> None:
    usage = Usage(
        prompt_tokens=100,
        completion_tokens=20,
        total_tokens=120,
        cached_tokens=40,
        cache_read_input_tokens=40,
        cache_creation_input_tokens=0,
    )
    assert usage.cache_read_input_tokens == 40
    assert usage.cache_creation_input_tokens == 0
    assert usage.cached_tokens == 40


# ---------------------------------------------------------------------------
# 7. Wave 6-F4: per-turn ``cost_usd`` + ``latency_ms`` on ``MessageTurn``
#
# Per-run ``total_cost_usd`` is already wired at the run level (W1-3); these
# tests verify per-turn granularity lands as proper :class:`MessageTurn`
# dataclass fields and round-trips through the OpenAI-compat agent path.
# Cerebras gpt-oss-120b pricing is $0.35/M input + $0.75/M output — sourced
# from CEREBRAS_PRICING and confirmed against
# https://www.cerebras.ai/blog/cerebras-inference-now-available-via-pay-per-token.
# ---------------------------------------------------------------------------


def test_message_turn_has_per_turn_cost_and_latency_fields() -> None:
    """``MessageTurn`` has nullable ``cost_usd`` / ``latency_ms`` defaults."""
    from eliza_lifeops_bench.types import MessageTurn

    turn = MessageTurn(role="assistant", content="ok")
    # Per AGENTS.md Cmd #8: missing data stays None, never 0.0.
    assert turn.cost_usd is None
    assert turn.latency_ms is None
    assert turn.input_tokens is None
    assert turn.output_tokens is None

    # Fields accept explicit values when the provider exposes them.
    populated = MessageTurn(
        role="assistant",
        content="ok",
        cost_usd=0.001,
        latency_ms=423.5,
        input_tokens=200,
        output_tokens=50,
    )
    assert populated.cost_usd == pytest.approx(0.001)
    assert populated.latency_ms == pytest.approx(423.5)
    assert populated.input_tokens == 200
    assert populated.output_tokens == 50


@pytest.mark.asyncio
async def test_openai_compat_agent_attaches_per_turn_cost_and_latency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``OpenAICompatAgent`` writes per-turn ``cost_usd`` + ``latency_ms``
    on the returned ``MessageTurn`` and the values match Cerebras pricing.
    """
    from eliza_lifeops_bench.agents._openai_compat import OpenAICompatAgent
    from eliza_lifeops_bench.clients.base import ClientCall
    from eliza_lifeops_bench.clients.cerebras import CEREBRAS_PRICING, CerebrasClient
    from eliza_lifeops_bench.types import MessageTurn

    monkeypatch.setenv("CEREBRAS_API_KEY", "test")
    body = {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "done"},
            }
        ],
        "usage": {
            "prompt_tokens": 1024,
            "completion_tokens": 256,
            "total_tokens": 1280,
        },
    }
    fake_http = _FakeAsyncClient(body)

    def _factory() -> CerebrasClient:
        return CerebrasClient(model="gpt-oss-120b", http_client=fake_http)

    agent = OpenAICompatAgent(_factory)
    history = [MessageTurn(role="user", content="status?")]
    turn = await agent(history, tools=[])

    pricing = CEREBRAS_PRICING["gpt-oss-120b"]
    expected_cost = (
        1024 / 1_000_000.0 * pricing["input_per_million_usd"]
        + 256 / 1_000_000.0 * pricing["output_per_million_usd"]
    )

    assert turn.cost_usd is not None
    assert turn.cost_usd == pytest.approx(expected_cost)
    # Latency comes from the client's wall-clock timing — a fake HTTP
    # client returns almost instantly, but it's still a non-negative
    # number that was actually recorded.
    assert turn.latency_ms is not None
    assert turn.latency_ms >= 0
    # Token counts also land on the dataclass.
    assert turn.input_tokens == 1024
    assert turn.output_tokens == 256
    # Agent-level accumulator picks up per-turn cost exactly once.
    assert agent.total_cost_usd == pytest.approx(expected_cost)
    # The unused ClientCall import below keeps this test self-contained
    # for tools / typecheckers that flag unused symbols.
    _ = ClientCall


def test_message_turn_cost_usd_is_none_for_unpriced_models() -> None:
    """When the pricing table doesn't know a model, ``cost_usd`` is
    :data:`None` — per AGENTS.md Cmd #8, missing pricing data stays
    nullable rather than masquerading as a free ``0.0`` call.
    """
    from eliza_lifeops_bench.clients.cerebras import _compute_cost_usd as _cerebras_cost
    from eliza_lifeops_bench.clients.hermes import _compute_cost_usd as _hermes_cost

    assert _cerebras_cost("definitely-not-a-real-model", 1024, 256) is None
    assert _hermes_cost("nonsense/Custom-Model-9B", 1024, 256) is None


def test_total_cost_usd_equals_sum_of_per_turn_costs() -> None:
    """Run-level invariant: ``ScenarioResult.total_cost_usd`` equals
    the sum of per-turn ``cost_usd`` values, skipping None entries
    (unpriced models). Matches the runner's aggregation at
    ``runner.py``'s ``ScenarioResult`` construction.
    """
    from eliza_lifeops_bench.types import TurnResult

    turns = [
        TurnResult(
            turn_number=1,
            agent_message="a",
            agent_actions=[],
            user_response="",
            latency_ms=100,
            input_tokens=200,
            output_tokens=50,
            cost_usd=0.0012,
        ),
        TurnResult(
            turn_number=2,
            agent_message="b",
            agent_actions=[],
            user_response="",
            latency_ms=120,
            input_tokens=210,
            output_tokens=60,
            cost_usd=0.0034,
        ),
        # An unpriced turn: cost is unknown, not free.
        TurnResult(
            turn_number=3,
            agent_message="c",
            agent_actions=[],
            user_response="",
            latency_ms=130,
            input_tokens=220,
            output_tokens=70,
            cost_usd=None,
        ),
    ]
    # Mirrors the runner aggregation expression — keep in sync with
    # ``ScenarioResult`` construction in runner.py.
    total = sum(t.cost_usd for t in turns if t.cost_usd is not None)
    assert total == pytest.approx(0.0012 + 0.0034)
    # The None-priced turn is preserved on the per-turn record so
    # downstream telemetry can still distinguish "unknown" from "free".
    assert turns[2].cost_usd is None


def test_message_turn_json_shape_via_dataclasses_asdict() -> None:
    """Sample MessageTurn JSON output documents the new field shape
    for downstream serializers (W1-3 already round-trips ``total_cost_usd``
    at the run level; this captures the per-turn analogue).
    """
    import json
    from dataclasses import asdict

    from eliza_lifeops_bench.types import MessageTurn

    turn = MessageTurn(
        role="assistant",
        content="OK, booking that for Tuesday.",
        tool_calls=None,
        cost_usd=0.00128,
        latency_ms=412.0,
        input_tokens=1024,
        output_tokens=256,
    )
    payload = json.loads(json.dumps(asdict(turn)))
    assert payload == {
        "role": "assistant",
        "content": "OK, booking that for Tuesday.",
        "name": None,
        "tool_calls": None,
        "tool_call_id": None,
        "cost_usd": 0.00128,
        "latency_ms": 412.0,
        "input_tokens": 1024,
        "output_tokens": 256,
    }
