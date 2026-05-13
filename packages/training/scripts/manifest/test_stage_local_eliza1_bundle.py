"""Tests for completing a local Eliza-1 bundle with stand-in assets."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import stage_local_eliza1_bundle as stage  # noqa: E402


def _write(path: Path, payload: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(payload, bytes):
        path.write_bytes(payload)
    else:
        path.write_text(payload)
    return path


def _base_bundle(tmp_path: Path) -> Path:
    bundle = tmp_path / "eliza-1-2b.bundle"
    _write(bundle / "tts" / "omnivoice-base-Q4_K_M.gguf", b"voice")
    _write(bundle / "tts" / "omnivoice-tokenizer-Q4_K_M.gguf", b"voice-tokenizer")
    _write(bundle / "asr" / "eliza-1-asr.gguf", b"asr")
    _write(bundle / "vad" / "silero-vad-v5.1.2.ggml.bin", b"vad")
    _write(bundle / "cache" / "voice-preset-default.bin", b"cache")
    _write(bundle / "licenses" / "LICENSE.voice", "voice license\n")
    _write(bundle / "licenses" / "LICENSE.asr", "asr license\n")
    _write(bundle / "licenses" / "LICENSE.vad", "vad license\n")
    _write(
        bundle / "lineage.json",
        json.dumps(
            {
                "voice": {"base": "voice-source", "license": "apache-2.0"},
                "asr": {"base": "asr-source", "license": "apache-2.0"},
                "vad": {"base": "vad-source", "license": "mit"},
            }
        ),
    )
    return bundle


def test_stage_local_bundle_writes_non_publishable_layout(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "_repo_root", lambda: tmp_path)
    bundle = _base_bundle(tmp_path)
    text_source = _write(tmp_path / "sources" / "text.gguf", b"text")
    drafter_source = _write(tmp_path / "sources" / "drafter.gguf", b"drafter")
    smoke = _write(
        tmp_path / "smoke.json",
        json.dumps(
            {
                "result": "partial-pass",
                "host": {"platform": "darwin", "arch": "arm64"},
                "tts": {
                    "ok": True,
                    "audioSeconds": 1.0,
                    "synthesizeMs": 1500,
                },
                "asr": {"ok": False, "code": "kernel-missing"},
            }
        ),
    )

    report = stage.stage_local_bundle(
        argparse.Namespace(
            tier="2b",
            bundle_dir=bundle,
            text_source=text_source,
            drafter_source=drafter_source,
            context="32k",
            all_contexts=False,
            version="0.0.0-local.test",
            generated_at="2026-05-11T12:00:00Z",
            local_smoke_report=smoke,
            force=False,
        )
    )

    assert report["publishEligible"] is False
    assert report["manifestValidation"]["localNonPublishableOk"] is True
    assert report["manifestValidation"]["publishReadyOk"] is False
    assert report["checksumValidation"]["ok"] is True
    assert (bundle / "text" / "eliza-1-2b-32k.gguf").is_file()
    assert (bundle / "dflash" / "drafter-2b.gguf").is_file()
    assert (bundle / "dflash" / "target-meta.json").is_file()
    assert (bundle / "vision").is_dir()
    assert (bundle / "evals" / "aggregate.json").is_file()
    assert (bundle / "evals" / "text-eval.json").is_file()
    assert (bundle / "evals" / "voice-rtf.json").is_file()
    assert (bundle / "evals" / "e2e-loop.json").is_file()
    assert (bundle / "checksums" / "SHA256SUMS").is_file()
    assert (bundle / "quantization" / "turboquant.json").is_file()
    assert (bundle / "quantization" / "fused_turboquant.json").is_file()
    assert (bundle / "quantization" / "qjl_config.json").is_file()
    assert (bundle / "quantization" / "polarquant_config.json").is_file()
    assert (bundle / "licenses" / "LICENSE.text").is_file()
    assert (bundle / "licenses" / "LICENSE.dflash").is_file()
    assert (bundle / "licenses" / "LICENSE.eliza-1").is_file()
    aggregate = json.loads((bundle / "evals" / "aggregate.json").read_text())
    assert "vad_boundary_ms" in aggregate["results"]
    assert "vad_endpoint_ms" in aggregate["results"]
    assert "vad_false_barge_in_rate" in aggregate["results"]

    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    assert manifest["defaultEligible"] is False
    assert manifest["files"]["vision"] == []
    assert manifest["files"]["vad"][0]["path"] == "vad/silero-vad-v5.1.2.ggml.bin"
    assert manifest["evals"]["vadLatencyMs"]["boundaryMs"] == 0.0
    assert manifest["evals"]["vadLatencyMs"]["endpointMs"] == 0.0
    assert manifest["evals"]["vadLatencyMs"]["falseBargeInRate"] == 1.0
    # RAM budget is calibrated from the 2026-05-11 e2e voice-loop bench:
    # the fused llama-server holds every voice region resident, so 2b's
    # server peak RSS must clear the calibrated budget with headroom
    # and the previous 4500 MB figure (which `thirty_turn_ok` failed on) is
    # no longer in effect.
    assert manifest["ramBudgetMb"] == {"min": 4000, "recommended": 5500}
    assert stage.validate_manifest(manifest, require_publish_ready=False) == ()
    publish_errors = stage.validate_manifest(manifest)
    assert any("textEval" in err for err in publish_errors)
    assert any("metal" in err for err in publish_errors)

    release = json.loads((bundle / "evidence" / "release.json").read_text())
    assert release["releaseState"] == "local-standin"
    assert release["publishEligible"] is False
    assert release["final"]["weights"] is False
    assert "quantization/turboquant.json" in release["quantizationSidecars"]
    assert any("stand-in" in reason for reason in release["publishBlockingReasons"])
    assert stage.validate_checksum_manifest(bundle) == ()
    assert Path(report["repoEvidence"]).is_file()
