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


def test_active_tiers_have_source_weight_entries() -> None:
    active_tiers = set(stage.ELIZA_1_TIERS)
    assert set(stage.TEXT_SOURCES) == active_tiers
    assert set(stage.DRAFTER_SOURCES) == active_tiers
    assert set(stage.VISION_SOURCES) == active_tiers
    assert set(stage.MMPROJ_QUANT_BY_TIER) == active_tiers
    assert set(stage.MMPROJ_QUANT_TENSOR_OVERRIDES) == active_tiers

    for tier in stage.ELIZA_1_TIERS:
        assert tier in stage.TEXT_SOURCES
        assert tier in stage.DRAFTER_SOURCES
        assert tier in stage.VISION_SOURCES
        assert tier in stage.MMPROJ_QUANT_BY_TIER
        assert tier in stage.MMPROJ_QUANT_TENSOR_OVERRIDES


def test_mobile_tier_uses_gemma4_e2b_source(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "2b"))

    kinds = [f["kind"] for f in report["files"]]
    assert "text" in kinds
    assert "mtp" in kinds
    assert "unsloth/gemma-4-E2B-GGUF" in report["sources"]
    assert (
        "google/gemma-4-E2B-it-qat-q4_0-unquantized-assistant"
        in report["sources"]
    )


def test_2b_tier_records_mtp_conversion_blocker(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "2b"))

    assert stage.DRAFTER_SOURCES["2b"] is not None
    assert any("not a final GGUF" in b for b in report["blockers"])


def test_4b_tier_records_text_mtp_and_vision_sources(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "4b"))

    assert [f["kind"] for f in report["files"]] == ["text", "mtp", "vision"]
    assert "unsloth/gemma-4-E4B-GGUF" in report["sources"]
    assert (
        "google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant"
        in report["sources"]
    )
    assert any("not a final GGUF" in b for b in report["blockers"])
    assert all("final Eliza-1" not in f["destination"] for f in report["files"])


def test_stage_sources_accepts_large_active_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    report = stage.stage_sources(_args(tmp_path, "27b"))

    assert "unsloth/gemma-4-31B-GGUF" in report["sources"]
    assert (
        "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant"
        in report["sources"]
    )


def test_27b_class_tiers_use_gemma4_31b_source(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)

    for tier in ("27b", "27b-256k"):
        report = stage.stage_sources(_args(tmp_path, tier))

        assert "unsloth/gemma-4-31B-GGUF" in report["sources"]
        assert (
            "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant"
            in report["sources"]
        )
        # The 27b-family tiers must use the 31B Gemma 4 source, never a
        # smaller-tier base.
        assert all(
            not any(
                small in f["repo"]
                for small in ("gemma-4-E2B", "gemma-4-E4B", "gemma-4-12B")
            )
            for f in report["files"]
            if f["kind"] in {"text", "mtp", "vision"}
        )
        drafter_files = [f for f in report["files"] if f["kind"] == "mtp"]
        assert drafter_files == [
            {
                "kind": "mtp",
                "repo": "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant",
                "filename": "model.safetensors",
                "destination": "source/mtp/gemma4-31b-assistant.safetensors",
                "license": "gemma",
                "status": "source-safetensors",
                "notes": tuple(stage.DRAFTER_SOURCES[tier].notes),
                "revision": "sha-google/gemma-4-31B-it-qat-q4_0-unquantized-assistant",
                "path": str(
                    tmp_path
                    / f"eliza-1-{tier}.bundle"
                    / "source/mtp/gemma4-31b-assistant.safetensors"
                ),
                "dryRun": True,
            }
        ]
        assert any(
            "acceptance against the Eliza-1 text checkpoint" in b
            for b in report["blockers"]
        )


def test_known_mtp_sources_are_wired_without_faking_small_tiers() -> None:
    assert (
        stage.DRAFTER_SOURCES["2b"].repo
        == "google/gemma-4-E2B-it-qat-q4_0-unquantized-assistant"
    )
    assert stage.DRAFTER_SOURCES["2b"].filename == "model.safetensors"
    assert stage.DRAFTER_SOURCES["2b"].license == "gemma"

    assert (
        stage.DRAFTER_SOURCES["4b"].repo
        == "google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant"
    )
    assert stage.DRAFTER_SOURCES["4b"].filename == "model.safetensors"
    assert stage.DRAFTER_SOURCES["4b"].license == "gemma"

    assert (
        stage.DRAFTER_SOURCES["9b"].repo
        == "google/gemma-4-12B-it-qat-q4_0-unquantized-assistant"
    )
    assert stage.DRAFTER_SOURCES["9b"].filename == "model.safetensors"
    assert stage.DRAFTER_SOURCES["9b"].license == "gemma"

    for tier in ("27b", "27b-256k"):
        artifact = stage.DRAFTER_SOURCES[tier]
        assert artifact is not None
        assert artifact.repo == "google/gemma-4-31B-it-qat-q4_0-unquantized-assistant"
        assert artifact.filename == "model.safetensors"
        assert artifact.status == "source-safetensors"


def test_every_active_tier_has_vision_source() -> None:
    """Every active release tier must source its own mmproj-F16.gguf."""
    for tier in stage.ELIZA_1_TIERS:
        assert stage.VISION_SOURCES[tier] is not None, tier
        artifact = stage.VISION_SOURCES[tier]
        assert artifact.kind == "vision"
        assert artifact.filename == "mmproj-F16.gguf"
        if tier.startswith("27b"):
            assert artifact.repo == "unsloth/gemma-4-31B-GGUF"
        else:
            assert artifact.repo.startswith("unsloth/gemma-4-")
        assert tier in stage.MMPROJ_QUANT_BY_TIER
        assert tier in stage.MMPROJ_QUANT_TENSOR_OVERRIDES
        assert stage.MMPROJ_QUANT_BY_TIER[tier] == "Q8_0"


def test_large_projector_tiers_carry_ffn_down_override() -> None:
    """9B/27B-family projectors must keep `v.blk.*.ffn_down.weight` at F16.

    Their hidden_dim (4304) is not divisible by 32, which is the row
    alignment Q8_0 requires; without the override `llama-quantize` bails
    with "Unsupported tensor size encountered" mid-stream. The 2b/4b mid+small
    projectors do not need that override.
    """
    for tier in ("9b", "27b", "27b-256k"):
        overrides = stage.MMPROJ_QUANT_TENSOR_OVERRIDES[tier]
        assert "v\\.blk\\.[0-9]+\\.ffn_down\\.weight" in overrides
        assert "v\\.patch_embd\\.weight" in overrides
    for tier in ("2b", "4b"):
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
