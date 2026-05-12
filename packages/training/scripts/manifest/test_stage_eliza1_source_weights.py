"""Tests for Eliza-1 upstream source-weight acquisition metadata."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from types import SimpleNamespace

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import stage_eliza1_source_weights as stage  # noqa: E402


class FakeHfApi:
    def model_info(self, repo: str) -> SimpleNamespace:
        return SimpleNamespace(sha=f"sha-{repo}")


def _args(tmp_path: Path, tier: str) -> argparse.Namespace:
    return argparse.Namespace(
        tier=tier,
        bundle_dir=tmp_path / f"eliza-1-{tier}.bundle",
        dry_run=True,
        link_mode="hardlink",
    )


def test_lite_tiers_are_source_only_and_keep_dflash_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "0_8b"))

    kinds = [f["kind"] for f in report["files"]]
    assert "text" in kinds
    assert "dflash" not in kinds
    assert "unsloth/Qwen3.5-0.8B-GGUF" in report["sources"]
    assert any("No upstream DFlash drafter" in b for b in report["blockers"])


def test_mobile_tier_uses_qwen35_2b_source(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "2b"))

    assert "unsloth/Qwen3.5-2B-GGUF" in report["sources"]
    assert "unsloth/Qwen3.5-1.7B-GGUF" not in report["sources"]


def test_pro_tier_records_text_dflash_and_vision_sources(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "27b"))

    assert [f["kind"] for f in report["files"]] == ["text", "dflash", "vision"]
    assert "batiai/Qwen3.6-27B-GGUF" in report["sources"]
    assert "spiritbuun/Qwen3.6-27B-DFlash-GGUF" in report["sources"]
    assert all("final Eliza-1" not in f["destination"] for f in report["files"])


def test_one_million_context_tier_reuses_27b_sources(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "27b-1m"))

    assert [f["kind"] for f in report["files"]] == ["text", "dflash", "vision"]
    assert "batiai/Qwen3.6-27B-GGUF" in report["sources"]
    assert "spiritbuun/Qwen3.6-27B-DFlash-GGUF" in report["sources"]
    assert any("final 1m" in note for f in report["files"] for note in f["notes"])
