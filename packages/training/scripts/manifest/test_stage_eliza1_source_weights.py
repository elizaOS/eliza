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
    stale_source = "unsloth/Qwen3.5-" + "1" + ".7B-GGUF"
    assert stale_source not in report["sources"]


def test_4b_tier_records_text_and_vision_sources_with_dflash_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "4b"))

    assert [f["kind"] for f in report["files"]] == ["text", "vision"]
    assert "unsloth/Qwen3.5-4B-GGUF" in report["sources"]
    assert any("No upstream DFlash drafter" in b for b in report["blockers"])
    assert all("final Eliza-1" not in f["destination"] for f in report["files"])


def test_stage_sources_rejects_removed_large_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    try:
        stage.stage_sources(_args(tmp_path, "27b"))
    except KeyError:
        return
    raise AssertionError("27b source staging should not be part of the active release line")
