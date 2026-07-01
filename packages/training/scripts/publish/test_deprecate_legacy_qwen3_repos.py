"""Tests for the legacy Eliza-1 repo deprecation helper."""

from __future__ import annotations

import sys
from pathlib import Path


_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.publish import deprecate_legacy_qwen3_repos as P  # noqa: E402


def test_build_updates_targets_only_retired_pre_gemma_tiers() -> None:
    updates = P.build_updates()
    repo_ids = {update.repo_id for update in updates}

    assert "elizaos/eliza-1-0_6b" in repo_ids
    assert "elizaos/eliza-1-0_8b" in repo_ids
    assert "elizaos/eliza-1-1_7b" in repo_ids
    assert "elizaos/eliza-1-4b" not in repo_ids
    assert "elizaos/eliza-1-4b-optimized" not in repo_ids
    assert len(updates) == 14


def test_zero_8b_card_uses_legacy_source_and_active_gemma_replacements() -> None:
    update = next(update for update in P.build_updates() if update.repo_id == "elizaos/eliza-1-0_8b")

    assert "Qwen/Qwen3.5-0.8B-Base" in update.body
    assert "`bundles/0_8b/`" not in update.body
    assert "`bundles/2b/`" in update.body
    assert "google/gemma-4-E2B" in update.body
    assert "google/gemma-4-E4B" in update.body


def test_dry_run_prints_active_plan_without_hf_token(monkeypatch, capsys) -> None:
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)

    assert P.main([]) == 0
    out = capsys.readouterr().out
    assert "legacy pre-Gemma deprecation plan (14 repos)" in out
    assert "https://huggingface.co/elizaos/eliza-1-0_8b" in out
    assert "https://huggingface.co/elizaos/eliza-1-4b" not in out
