"""Tests for assembling a real-weights Eliza-1 bundle (offline path)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

import pytest

from scripts.manifest import stage_real_eliza1_bundle as stage  # noqa: E402


def _write(path: Path, payload: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(payload, bytes):
        path.write_bytes(payload)
    else:
        path.write_text(payload)
    return path


def _seed_assets(bundle: Path) -> None:
    """Pre-place the voice/ASR/VAD assets + lineage/licenses/cache so the
    --skip-assets path has a valid starting point (no HF network)."""
    _write(bundle / "tts" / "omnivoice-base-Q4_K_M.gguf", b"omnivoice-base")
    _write(bundle / "tts" / "omnivoice-tokenizer-Q4_K_M.gguf", b"omnivoice-tok")
    _write(bundle / "asr" / "eliza-1-asr.gguf", b"asr")
    _write(bundle / "asr" / "eliza-1-asr-mmproj.gguf", b"asr-mmproj")
    _write(bundle / "vad" / "silero-vad-v5.1.2.ggml.bin", b"vad")
    _write(bundle / "cache" / "voice-preset-default.bin", b"cache")
    _write(bundle / "licenses" / "LICENSE.voice", "voice license\n")
    _write(bundle / "licenses" / "LICENSE.asr", "asr license\n")
    _write(bundle / "licenses" / "LICENSE.vad", "vad license\n")
    _write(
        bundle / "lineage.json",
        json.dumps({
            "voice": {"base": "voice-source@rev", "license": "apache-2.0"},
            "asr": {"base": "asr-source@rev", "license": "apache-2.0"},
            "vad": {"base": "vad-source@rev", "license": "mit"},
            # The asset stager always writes this; the real bundle stager
            # must drop it because there are no wakeword files in the bundle.
            "wakeword": {"base": "wakeword-source", "license": "apache-2.0"},
        }),
    )


def _seed_recipes(root: Path) -> Path:
    """Minimal recipe-sidecar outputs with the §3 kernel_manifest fragments."""
    from scripts.quantization._kernel_manifest import kernel_manifest_fragment

    for sub, fname, method in (
        ("turbo", "turboquant.json", "turboquant"),
        ("fused", "fused_turboquant.json", "fused-turboquant"),
        ("qjl", "qjl_config.json", "qjl"),
        ("polar", "polarquant_config.json", "polarquant"),
    ):
        _write(
            root / sub / fname,
            json.dumps({"method": method, "kernel_manifest": kernel_manifest_fragment(method)}),
        )
    return root


def test_stage_real_bundle_offline_layout(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(stage, "_repo_root", lambda: tmp_path)
    bundle = tmp_path / "eliza-1-0_6b.bundle"
    bundle.mkdir(parents=True)
    _seed_assets(bundle)
    recipes = _seed_recipes(tmp_path / "recipes")
    text_gguf = _write(tmp_path / "src" / "text.gguf", b"text-weights")
    drafter_gguf = _write(tmp_path / "src" / "drafter.gguf", b"drafter-weights")

    args = argparse.Namespace(
        tier="0_6b", bundle_dir=bundle, text_gguf=text_gguf, drafter_gguf=drafter_gguf,
        recipes_dir=recipes, vision_gguf=None,
        text_lineage_repo="Qwen/Qwen3-0.6B", text_lineage_rev="deadbeef",
        text_lineage_note="substitute base", text_substituted=True, drafter_stamp_only=True,
        skip_assets=True, skip_wakeword=True, link_mode="copy",
        version="1.0.0-staged.1", generated_at="2026-05-11T00:00:00Z", force=False,
    )
    report = stage.stage_real_bundle(args)

    assert report["publishEligible"] is False
    assert report["checksumValidation"]["ok"] is True
    # The bundle records real weights but is not publish-ready yet.
    assert report["manifestValidation"]["localNonPublishableOk"] is True
    assert report["manifestValidation"]["publishReadyOk"] is False

    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    assert manifest["id"] == "eliza-1-0_6b"
    assert manifest["defaultEligible"] is False
    assert manifest["lineage"]["text"]["base"] == "Qwen/Qwen3-0.6B@deadbeef"
    # 0_6b ships no separate embedding artifact (text backbone IS the embedding).
    assert "embedding" not in manifest["lineage"]
    assert manifest["files"]["text"][0]["ctx"] == 32768
    assert manifest["files"]["vad"][0]["path"] == "vad/silero-vad-v5.1.2.ggml.bin"
    assert manifest["evals"]["vadLatencyMs"]["boundaryMs"] == 0.0
    assert manifest["evals"]["vadLatencyMs"]["endpointMs"] == 0.0
    assert manifest["evals"]["vadLatencyMs"]["falseBargeInRate"] == 1.0

    release = json.loads((bundle / "evidence" / "release.json").read_text())
    assert release["releaseState"] == "weights-staged"
    assert release["final"]["weights"] is True
    assert release["final"]["evals"] is False

    target_meta = json.loads((bundle / "dflash" / "target-meta.json").read_text())
    assert target_meta["status"] == "weights-staged"
    assert target_meta["targetText"]["finalElizaWeights"] is True
    # Stamp-only stand-in drafter has no recorded target sha here.
    assert target_meta["drafter"]["matchesTargetCheckpoint"] is False

    # wakeword lineage entry must have been dropped (no wakeword files staged).
    lineage = json.loads((bundle / "lineage.json").read_text())
    assert "wakeword" not in lineage

    # Quantization recipe sidecars copied verbatim.
    for fname in ("turboquant.json", "fused_turboquant.json", "qjl_config.json", "polarquant_config.json"):
        side = json.loads((bundle / "quantization" / fname).read_text())
        assert set(side["kernel_manifest"]) == {
            "kernel_target", "block_layout_version", "codebook_hash", "per_block_tolerance"
        }


def test_stage_real_bundle_embedding_tier_keeps_embedding_lineage(tmp_path: Path, monkeypatch) -> None:
    """Non-0_6b tiers ship a separate embedding artifact; if present, its
    lineage entry must survive (the bundle stager places it before lineage)."""
    monkeypatch.setattr(stage, "_repo_root", lambda: tmp_path)
    bundle = tmp_path / "eliza-1-1_7b.bundle"
    bundle.mkdir(parents=True)
    _seed_assets(bundle)
    _write(bundle / "embedding" / "eliza-1-embedding.gguf", b"embedding-weights")
    recipes = _seed_recipes(tmp_path / "recipes")
    text_gguf = _write(tmp_path / "src" / "text.gguf", b"text-weights")
    drafter_gguf = _write(tmp_path / "src" / "drafter.gguf", b"drafter-weights")
    args = argparse.Namespace(
        tier="1_7b", bundle_dir=bundle, text_gguf=text_gguf, drafter_gguf=drafter_gguf,
        recipes_dir=recipes, vision_gguf=None,
        text_lineage_repo="Qwen/Qwen3-1.7B", text_lineage_rev="cafebabe",
        text_lineage_note="substitute base", text_substituted=True, drafter_stamp_only=True,
        skip_assets=True, skip_wakeword=True, link_mode="copy",
        version="1.0.0-staged.1", generated_at="2026-05-11T00:00:00Z", force=False,
    )
    report = stage.stage_real_bundle(args)
    assert report["checksumValidation"]["ok"] is True
    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    assert manifest["lineage"]["embedding"]["base"] == "Qwen/Qwen3-Embedding-0.6B"
    assert manifest["files"]["embedding"][0]["path"] == "embedding/eliza-1-embedding.gguf"
    # Two context variants for 1_7b.
    ctxs = sorted(f["ctx"] for f in manifest["files"]["text"])
    assert ctxs == [32768, 65536]
