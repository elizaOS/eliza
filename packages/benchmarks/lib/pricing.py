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

from typing import Final, Mapping


# Per-million-token USD pricing keyed by ``model`` name as returned by the
# provider. Mirrors ``eliza_lifeops_bench.clients.cerebras.CEREBRAS_PRICING``.
CEREBRAS_PRICING: Final[Mapping[str, Mapping[str, float]]] = {
    "gpt-oss-120b": {"input_per_million_usd": 0.35, "output_per_million_usd": 0.75},
}


def compute_cost_usd(
    model: str | None,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    pricing: Mapping[str, Mapping[str, float]] = CEREBRAS_PRICING,
) -> float | None:
    """Return USD cost for a single completion, or :data:`None` when unpriced.

    Args:
        model: Model identifier returned by the provider.
        prompt_tokens: Input token count for the turn.
        completion_tokens: Output token count for the turn.
        pricing: Per-model pricing table (defaults to :data:`CEREBRAS_PRICING`).
    """
    if not model:
        return None
    row = pricing.get(model)
    if row is None:
        return None
    return (
        (prompt_tokens / 1_000_000.0) * row["input_per_million_usd"]
        + (completion_tokens / 1_000_000.0) * row["output_per_million_usd"]
    )


__all__ = ["CEREBRAS_PRICING", "compute_cost_usd"]
