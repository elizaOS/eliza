"""CPU-only invariants for the Gemma EOT LoRA helper scripts."""

from __future__ import annotations

import pytest

from scripts.voice.eot.prep_eot_corpus import apply_gemma_user_template
from scripts.voice.eot.train_eot_lora import (
    TIER_REGISTRY,
    eot_loss_weights,
    resolve_tier,
)


def test_eot_lora_tiers_are_active_gemma_bases() -> None:
    assert set(TIER_REGISTRY) == {"2b", "4b"}
    assert all(spec.base_id.startswith("google/gemma-4-") for spec in TIER_REGISTRY.values())
    assert "0_8b" not in TIER_REGISTRY
    with pytest.raises(SystemExit, match="unknown tier"):
        resolve_tier("0_8b")


def test_gemma_user_template_leaves_end_token_as_training_target() -> None:
    text = apply_gemma_user_template("hello there")
    assert text == "<start_of_turn>user\nhello there\n"
    assert "<end_of_turn>" not in text
    assert "<|im_" not in text


def test_eot_loss_weights_target_gemma_end_of_turn_token() -> None:
    assert eot_loss_weights(label=1, eot_token_id=42, vocab_size=100) == {
        "target_token": 42.0,
        "weight": 1.0,
        "mode": "positive",
    }
    assert eot_loss_weights(label=0, eot_token_id=42, vocab_size=100) == {
        "target_token": -1.0,
        "weight": pytest.approx(1.0 / 99),
        "mode": "negative",
    }
