"""Canonical MODEL_TIER registry for the LifeOpsBench Python harness.

Mirrors ``packages/benchmarks/lib/src/model-tiers.ts``. Keep the four tier
names (``small`` / ``mid`` / ``large`` / ``frontier``) and the override env
var names (``MODEL_NAME_OVERRIDE`` / ``MODEL_BASE_URL_OVERRIDE`` /
``MODEL_BUNDLE_OVERRIDE``) in lockstep with the TS module. Direct orchestrator
runs also export ``BENCHMARK_MODEL_NAME`` / ``MODEL_NAME`` / ``CEREBRAS_MODEL``;
those are accepted as lower-priority aliases so LifeOps rows use the same
requested model as the standard benchmark adapters.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal, Mapping, Optional

ModelTier = Literal["small", "mid", "large", "frontier"]
ModelTierProvider = Literal[
    "cerebras",
    "anthropic",
    "openai",
    "local-llama-cpp",
    "ollama",
]

_VALID_TIERS: frozenset[str] = frozenset({"small", "mid", "large", "frontier"})
_MODEL_NAME_ENV_PRIORITY: tuple[str, ...] = (
    "MODEL_NAME_OVERRIDE",
    "BENCHMARK_MODEL_NAME",
    "MODEL_NAME",
    "CEREBRAS_MODEL",
)


@dataclass(frozen=True)
class TierSpec:
    tier: ModelTier
    provider: ModelTierProvider
    model_name: str
    context_window: int
    base_url: Optional[str] = None
    bundle_path: Optional[str] = None
    notes: Optional[str] = None


DEFAULT_TIERS: dict[ModelTier, TierSpec] = {
    "small": TierSpec(
        tier="small",
        provider="local-llama-cpp",
        model_name="qwen3-0.8b-q8_0",
        bundle_path="~/.eliza/local-inference/models/eliza-1-0.8b.bundle",
        context_window=32_768,
        notes="Tier-A smoke lane; dflash fork or Ollama fallback",
    ),
    "mid": TierSpec(
        tier="mid",
        provider="local-llama-cpp",
        model_name="qwen3-2b-q4_k_m",
        bundle_path="~/.eliza/local-inference/models/eliza-1-2b.bundle",
        context_window=65_536,
        notes="Tier-B manual/scheduled",
    ),
    "large": TierSpec(
        tier="large",
        provider="cerebras",
        model_name="gpt-oss-120b",
        base_url="https://api.cerebras.ai/v1",
        context_window=131_072,
        notes="Default eval provider; prompt caching enabled",
    ),
    "frontier": TierSpec(
        tier="frontier",
        provider="anthropic",
        model_name="claude-opus-4-7",
        context_window=200_000,
        notes="Production runtime",
    ),
}


def is_model_tier(value: object) -> bool:
    return isinstance(value, str) and value in _VALID_TIERS


def resolve_tier(env: Optional[Mapping[str, str]] = None) -> TierSpec:
    """Resolve a :class:`TierSpec` from environment variables.

    Reads ``MODEL_TIER`` (defaults to ``large``) and applies the three
    single-field overrides if set. Returns a copy of the registry entry
    with override fields replaced.
    """
    env_map = env if env is not None else os.environ
    raw = (env_map.get("MODEL_TIER") or "").strip()
    tier_key: ModelTier = raw if is_model_tier(raw) else "large"  # type: ignore[assignment]

    base = DEFAULT_TIERS[tier_key]

    name_override = _first_env_value(env_map, _MODEL_NAME_ENV_PRIORITY)
    base_url_override = (env_map.get("MODEL_BASE_URL_OVERRIDE") or "").strip() or None
    bundle_override = (env_map.get("MODEL_BUNDLE_OVERRIDE") or "").strip() or None

    return TierSpec(
        tier=base.tier,
        provider=base.provider,
        model_name=name_override or base.model_name,
        base_url=base_url_override or base.base_url,
        bundle_path=bundle_override or base.bundle_path,
        context_window=base.context_window,
        notes=base.notes,
    )


def _first_env_value(env_map: Mapping[str, str], keys: tuple[str, ...]) -> Optional[str]:
    """Return the first non-empty environment value in priority order."""
    for key in keys:
        value = (env_map.get(key) or "").strip()
        if value:
            return value
    return None


__all__ = [
    "DEFAULT_TIERS",
    "ModelTier",
    "ModelTierProvider",
    "TierSpec",
    "is_model_tier",
    "resolve_tier",
]
