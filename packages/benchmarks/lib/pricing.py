"""Shared per-million-token pricing for benchmark adapters.

The hermes-adapter and openclaw-adapter lifeops_bench modules each used to
inline their own ``_CEREBRAS_PRICING`` table. This module is the single
source of truth so total_cost_usd numbers across harnesses do not silently
diverge.

Per AGENTS.md Cmd #8, :func:`compute_cost_usd` returns :data:`None` when a
model is unpriced rather than ``0.0`` — "unpriced" is distinct from "free"
and the orchestrator's cost aggregation skips :data:`None` entries.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final, Mapping


# Per-million-token USD pricing keyed by ``model`` name as returned by the
# provider. Mirrors ``eliza_lifeops_bench.clients.cerebras.CEREBRAS_PRICING``.
CEREBRAS_PRICING: Final[Mapping[str, Mapping[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


# Historical rate assumptions retained for reproducible projections. These are
# recorded benchmark inputs, not a claim about current provider list prices.
ANTHROPIC_PRICING: Final[Mapping[str, Mapping[str, float]]] = {
    "claude-opus-4-8": {"input_per_million_usd": 15.0, "output_per_million_usd": 75.0},
    "claude-opus-4-7": {"input_per_million_usd": 15.0, "output_per_million_usd": 75.0},
    "claude-opus-4-1-20250805": {
        "input_per_million_usd": 15.0,
        "output_per_million_usd": 75.0,
    },
    "claude-opus-4-1": {"input_per_million_usd": 15.0, "output_per_million_usd": 75.0},
}


# Union of all priced models, for cost reports that mix providers.
ALL_PRICING: Final[Mapping[str, Mapping[str, float]]] = {
    **CEREBRAS_PRICING,
    **ANTHROPIC_PRICING,
}


def compute_cost_usd(
    model: str | None,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    pricing: Mapping[str, Mapping[str, float]] = CEREBRAS_PRICING,
    cached_prompt_tokens: int = 0,
) -> float | None:
    """Return USD cost for a single completion, or :data:`None` when unpriced.

    Args:
        model: Model identifier returned by the provider.
        prompt_tokens: Input token count for the turn.
        completion_tokens: Output token count for the turn.
        pricing: Per-model pricing table (defaults to :data:`CEREBRAS_PRICING`).
    """
    for count in (prompt_tokens, completion_tokens, cached_prompt_tokens):
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("Token counts must be non-negative integers")
    if cached_prompt_tokens > prompt_tokens:
        raise ValueError("Cached tokens cannot exceed prompt tokens")
    if not model:
        return None
    # A provider prefix must not accidentally use another provider's rates.
    if "/" in model:
        provider, model = model.rsplit("/", 1)
        if pricing is CEREBRAS_PRICING and provider != "cerebras":
            return None
    row = pricing.get(model)
    if row is None:
        return None
    input_rate = row["input_per_million_usd"]
    output_rate = row["output_per_million_usd"]
    cached_rate = row.get("cached_input_per_million_usd", input_rate)
    if any(
        not math.isfinite(rate) or rate < 0
        for rate in (input_rate, output_rate, cached_rate)
    ):
        raise ValueError("Price rates must be finite and non-negative")
    return (
        (prompt_tokens - cached_prompt_tokens) * input_rate
        + cached_prompt_tokens * cached_rate
        + completion_tokens * output_rate
    ) / 1_000_000.0


def cost_from_usage(model: str | None, usage: object) -> float | None:
    """Read measured usage without converting missing counters into free calls."""
    if not isinstance(usage, dict):
        return None

    def counter(*names: str):
        return next(
            (usage[name] for name in names if usage.get(name) is not None), None
        )

    prompt = counter("prompt_tokens", "promptTokens", "input_tokens")
    completion = counter("completion_tokens", "completionTokens", "output_tokens")
    if prompt is None or completion is None:
        return None
    details = usage.get("prompt_tokens_details", {})
    cached = details.get("cached_tokens", 0) if isinstance(details, dict) else 0
    return compute_cost_usd(model, prompt, completion, cached_prompt_tokens=cached)


PRICING_REVISION = "benchmark-recorded-rates-v1"


@dataclass
class CostAccumulator:
    """Keep measured known spend without certifying incomplete totals."""

    known_cost_usd: float = 0.0
    unknown_calls: int = 0

    def add(self, cost: float | None) -> None:
        if cost is None:
            self.unknown_calls += 1
        elif not math.isfinite(cost) or cost < 0:
            raise ValueError("Cost must be finite and non-negative")
        else:
            self.known_cost_usd += cost

    @property
    def total(self) -> float | None:
        return None if self.unknown_calls else self.known_cost_usd

    def metadata(self) -> dict[str, object]:
        return {
            "known_cost_usd": self.known_cost_usd,
            "cost_complete": self.unknown_calls == 0,
            "unknown_cost_calls": self.unknown_calls,
            "pricing_revision": PRICING_REVISION,
        }


__all__ = [
    "CEREBRAS_PRICING",
    "ANTHROPIC_PRICING",
    "ALL_PRICING",
    "compute_cost_usd",
    "cost_from_usage",
    "CostAccumulator",
    "PRICING_REVISION",
]
