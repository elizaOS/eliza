"""Resolver tests for the LifeOpsBench MODEL_TIER registry.

Mirrors ``packages/benchmarks/lib/src/__tests__/model-tiers.test.ts`` to
keep the TS and Python harnesses in lockstep on the env contract.
"""

from __future__ import annotations

import pytest

from eliza_lifeops_bench.model_tiers import (
    DEFAULT_TIERS,
    is_model_tier,
    resolve_tier,
)


def test_resolve_tier_defaults_to_large_when_unset() -> None:
    spec = resolve_tier({})
    assert spec.tier == "large"
    assert spec.provider == "cerebras"
    assert spec.model_name == "gpt-oss-120b"
    assert spec.base_url == "https://api.cerebras.ai/v1"


def test_resolve_tier_small() -> None:
    spec = resolve_tier({"MODEL_TIER": "small"})
    assert spec.tier == "small"
    assert spec.provider == "local-llama-cpp"
    assert spec.model_name == "qwen3-0.6b-q8_0"
    assert spec.bundle_path is not None
    assert "eliza-1-0.6b.bundle" in spec.bundle_path


def test_resolve_tier_mid() -> None:
    spec = resolve_tier({"MODEL_TIER": "mid"})
    assert spec.tier == "mid"
    assert spec.model_name == "qwen3-1.7b-q4_k_m"
    assert spec.context_window == 65_536


def test_resolve_tier_frontier() -> None:
    spec = resolve_tier({"MODEL_TIER": "frontier"})
    assert spec.provider == "anthropic"
    assert spec.model_name == "claude-opus-4-7"
    assert spec.context_window == 200_000


def test_unknown_tier_falls_back_to_large() -> None:
    spec = resolve_tier({"MODEL_TIER": "bogus"})
    assert spec.tier == "large"


def test_model_name_override() -> None:
    spec = resolve_tier(
        {"MODEL_TIER": "small", "MODEL_NAME_OVERRIDE": "qwen3-0.6b-q4_k_s"}
    )
    assert spec.model_name == "qwen3-0.6b-q4_k_s"


def test_model_base_url_override() -> None:
    spec = resolve_tier(
        {"MODEL_TIER": "large", "MODEL_BASE_URL_OVERRIDE": "http://localhost:9999/v1"}
    )
    assert spec.base_url == "http://localhost:9999/v1"


def test_model_bundle_override() -> None:
    spec = resolve_tier(
        {"MODEL_TIER": "mid", "MODEL_BUNDLE_OVERRIDE": "/custom/bundle.gguf"}
    )
    assert spec.bundle_path == "/custom/bundle.gguf"


def test_override_does_not_mutate_registry() -> None:
    resolve_tier({"MODEL_TIER": "small", "MODEL_NAME_OVERRIDE": "mutated"})
    assert DEFAULT_TIERS["small"].model_name == "qwen3-0.6b-q8_0"


@pytest.mark.parametrize("tier", ["small", "mid", "large", "frontier"])
def test_is_model_tier_accepts_canonical(tier: str) -> None:
    assert is_model_tier(tier) is True


@pytest.mark.parametrize("value", ["xl", "", None, 42])
def test_is_model_tier_rejects_unknown(value: object) -> None:
    assert is_model_tier(value) is False
