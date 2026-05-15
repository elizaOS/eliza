"""Tests for Eliza-1 upstream source-weight acquisition metadata."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

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

def test_stage_sources_accepts_large_active_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "27b"))

    assert "unsloth/Qwen3.6-27B-GGUF" in report["sources"]

@pytest.mark.parametrize("tier", ["27b", "27b-256k", "27b-1m"])
def test_27b_class_tiers_use_qwen36_source(
    tmp_path: Path,
    monkeypatch,
    tier: str,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, tier))

    assert "unsloth/Qwen3.6-27B-GGUF" in report["sources"]
    assert all("Qwen3.5-27B" not in f["repo"] for f in report["files"])

def test_every_active_tier_has_vision_source() -> None:
    """Every Qwen3.5 release tier must source its own mmproj-F16.gguf.

    The 27b / 27b-256k / 27b-1m text-context variants all reuse the
    `unsloth/Qwen3.6-27B-GGUF` projector by design (the projector arch is
    shared across the 27B family). The 0_8b/2b/4b/9b tiers each have a
    distinct upstream mmproj source. The 0_8b tier ships Q4_K_M; every
    other tier ships Q8_0.
    """
    for tier in ("0_8b", "2b", "4b", "9b", "27b", "27b-256k", "27b-1m"):
        assert stage.VISION_SOURCES[tier] is not None, tier
        artifact = stage.VISION_SOURCES[tier]
        assert artifact.kind == "vision"
        assert artifact.filename == "mmproj-F16.gguf"
        if tier.startswith("27b"):
            assert artifact.repo == "unsloth/Qwen3.6-27B-GGUF"
        assert tier in stage.MMPROJ_QUANT_BY_TIER
        assert tier in stage.MMPROJ_QUANT_TENSOR_OVERRIDES
        assert stage.MMPROJ_QUANT_BY_TIER["0_8b"] == "Q4_K_M"
        if tier != "0_8b":
            assert stage.MMPROJ_QUANT_BY_TIER[tier] == "Q8_0"

def test_large_projector_tiers_carry_ffn_down_override() -> None:
    """9B/27B-family projectors must keep `v.blk.*.ffn_down.weight` at F16.

    Their hidden_dim (4304) is not divisible by 32, which is the row
    alignment Q8_0 requires; without the override `llama-quantize` bails
    with "Unsupported tensor size encountered" mid-stream. The 0_8b/2b/4b
    mid+small projectors do not need that override.
    """
    for tier in ("9b", "27b", "27b-256k", "27b-1m"):
        overrides = stage.MMPROJ_QUANT_TENSOR_OVERRIDES[tier]
        assert "v\\.blk\\.[0-9]+\\.ffn_down\\.weight" in overrides
        assert "v\\.patch_embd\\.weight" in overrides
    for tier in ("0_8b", "2b", "4b"):
        overrides = stage.MMPROJ_QUANT_TENSOR_OVERRIDES[tier]
        assert "v\\.patch_embd\\.weight" in overrides
        assert "v\\.blk\\.[0-9]+\\.ffn_down\\.weight" not in overrides

def test_quantize_mmproj_invokes_binary_with_overrides(
    tmp_path: Path, monkeypatch
) -> None:
    """`quantize_mmproj` must pass each tensor override to the binary."""
    calls: list[list[str]] = []

    class FakeCompleted:
        returncode = 0
        stderr = ""

    source = tmp_path / "mmproj-F16.gguf"
    source.write_bytes(b"GGUF" + b"\x00" * 32)
    target = tmp_path / "vision" / "mmproj-9b.gguf"
    binary = tmp_path / "fake-llama-quantize"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o755)

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"GGUF" + b"\x00" * 16)
        return FakeCompleted()

    monkeypatch.setattr(stage.subprocess, "run", fake_run)

    result = stage.quantize_mmproj(
        source_f16=source,
        target_quantized=target,
        quant="Q8_0",
        tensor_overrides={
            "v\\.patch_embd\\.weight": "f16",
            "v\\.blk\\.[0-9]+\\.ffn_down\\.weight": "f16",
        },
        quantizer_bin=binary,
    )

    assert calls and calls[0][0] == str(binary)
    flat = " ".join(calls[0])
    assert "--tensor-type v\\.patch_embd\\.weight=f16" in flat
    assert "--tensor-type v\\.blk\\.[0-9]+\\.ffn_down\\.weight=f16" in flat
    assert flat.endswith("Q8_0")
    assert result["quant"] == "Q8_0"
    assert result["outputPath"].endswith("mmproj-9b.gguf")

def test_quantize_mmproj_raises_when_binary_missing(tmp_path: Path) -> None:
    source = tmp_path / "mmproj-F16.gguf"
    source.write_bytes(b"GGUF\x00")
    target = tmp_path / "mmproj-out.gguf"
    binary = tmp_path / "does-not-exist"
    try:
        stage.quantize_mmproj(
            source_f16=source,
            target_quantized=target,
            quant="Q8_0",
            tensor_overrides={},
            quantizer_bin=binary,
        )
    except SystemExit as exc:
        assert "llama-quantize binary not found" in str(exc)
    else:  # pragma: no cover - protective
        raise AssertionError("expected SystemExit")


def test_source_staging_accepts_27b_1m_extension_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "27b-1m"))

    assert "unsloth/Qwen3.6-27B-GGUF" in report["sources"]
    assert any(f["destination"].endswith("qwen3.6-27b-1m-q8_0.gguf") for f in report["files"])
    assert "27b-1m" in stage.SOURCE_WEIGHT_TIERS
