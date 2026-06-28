"""Tests for staging non-text Eliza-1 bundle assets."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import stage_eliza1_bundle_assets as stage  # noqa: E402
from scripts.manifest.eliza1_manifest import ELIZA_1_TIERS  # noqa: E402


class FakeHfApi:
    def model_info(self, repo: str) -> SimpleNamespace:
        return SimpleNamespace(sha=f"sha-{repo}")

    def list_repo_files(self, repo_id: str, repo_type: str) -> list[str]:
        assert repo_type == "model"
        if repo_id == "ggml-org/Qwen3-ASR-0.6B-GGUF":
            return [
                "Qwen3-ASR-0.6B-Q8_0.gguf",
                "Qwen3-ASR-0.6B-bf16.gguf",
                "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
            ]
        if repo_id == "ggml-org/Qwen3-ASR-1.7B-GGUF":
            return [
                "Qwen3-ASR-1.7B-Q8_0.gguf",
                "Qwen3-ASR-1.7B-bf16.gguf",
                "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
            ]
        if repo_id == stage.ELIZA_1_HF_REPO:
            return ["voice/vad/silero-vad-v5.gguf"]
        return []


def test_retired_qwen_and_turn_detector_maps_match_active_tiers() -> None:
    active = set(ELIZA_1_TIERS)
    assert set(stage.RETIRED_QWEN_ASR_REPO_BY_TIER) == active
    assert set(stage.TURN_DETECTOR_LIVEKIT_REVISION_BY_TIER) == active
    assert "0_8b" not in stage.RETIRED_QWEN_ASR_REPO_BY_TIER
    assert "0_8b" not in stage.TURN_DETECTOR_LIVEKIT_REVISION_BY_TIER
    assert stage.TURN_DETECTOR_LIVEKIT_REVISION_BY_TIER["2b"] == "v1.2.2-en"
    for tier in active - {"2b"}:
        assert stage.TURN_DETECTOR_LIVEKIT_REVISION_BY_TIER[tier] == "v0.4.1-intl"


def _args(tmp_path: Path, tier: str) -> argparse.Namespace:
    return argparse.Namespace(
        tier=tier,
        bundle_dir=tmp_path / tier,
        dry_run=True,
        link_mode="copy",
        asr_repo=None,
        asr_file=None,
        asr_mmproj_file=None,
        allow_retired_qwen_asr=False,
        asr_requantize=None,
        llama_quantize_bin=None,
        include_vad_onnx_fallback=False,
        skip_wakeword=False,
        # Voice Wave 2: turn detector defaults — skip during dry runs because
        # the staging step calls copy_hf_file for the LiveKit/Turnsense ONNX
        # which is independent of the asr_repo / VOICE_REPO test scaffolding.
        # Dedicated turn-detector tests live in
        # `test_stage_turn_detector.py`.
        skip_turn_detector=True,
        turn_license="livekit",
        upload_repo=None,
        upload_prefix="",
        public=False,
    )


def _legacy_qwen_args(tmp_path: Path, tier: str) -> argparse.Namespace:
    args = _args(tmp_path, tier)
    args.allow_retired_qwen_asr = True
    return args


def test_stage_dry_run_requires_explicit_gemma_asr_source_by_default(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    with pytest.raises(SystemExit, match="Gemma ASR artifacts are not configured"):
        stage.stage_assets(_args(tmp_path, "4b"))


def test_legacy_stage_dry_run_uses_qwen_asr_only_with_opt_in(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_legacy_qwen_args(tmp_path, "4b"))

    staged = {
        (f["repo"], f["remotePath"], Path(f["path"]).as_posix())
        for f in report["files"]
        if "repo" in f
    }
    assert (
        "ggml-org/Qwen3-ASR-0.6B-GGUF",
        "Qwen3-ASR-0.6B-Q8_0.gguf",
        (tmp_path / "4b" / "asr" / "eliza-1-asr.gguf").as_posix(),
    ) in staged
    assert (
        "ggml-org/Qwen3-ASR-0.6B-GGUF",
        "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
        (tmp_path / "4b" / "asr" / "eliza-1-asr-mmproj.gguf").as_posix(),
    ) in staged
    assert (
        stage.VAD_NATIVE_REPO,
        "voice/vad/silero-vad-v5.gguf",
        (tmp_path / "4b" / "vad" / "silero-vad-v5.gguf").as_posix(),
    ) in staged
    assert report["asrMmprojRemotePath"] == "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"
    assert report["asrRequantize"] is None
    assert report["vad"] == {
        "nativeRepo": stage.VAD_NATIVE_REPO,
        "nativeRemotePath": "voice/vad/silero-vad-v5.gguf",
        "nativeBundlePath": "vad/silero-vad-v5.gguf",
        "format": "gguf",
        "onnxFallbackIncluded": False,
        "onnxFallbackRepo": None,
        "onnxFallbackBundlePath": None,
    }
    # Optional wake-word graphs are staged by default (dry-run records the
    # planned downloads).
    ww = {
        Path(f["path"]).as_posix(): f.get("url")
        for f in report["files"]
        if "url" in f
    }
    for rel in (
        "wake/melspectrogram.onnx",
        "wake/embedding_model.onnx",
        "wake/hey-eliza.onnx",
    ):
        dst = (tmp_path / "4b" / rel).as_posix()
        assert dst in ww
        assert ww[dst].startswith(stage.WAKEWORD_RELEASE)


def test_stage_dry_run_records_explicit_asr_q4_requantize_plan(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    args = _legacy_qwen_args(tmp_path, "2b")
    args.asr_requantize = "Q4_K_M"
    report = stage.stage_assets(args)

    req = report["asrRequantize"]
    assert req["kind"] == "gguf-requantize"
    assert req["quant"] == "Q4_K_M"
    assert req["allowRequantize"] is True
    assert req["sourceRepo"] == "ggml-org/Qwen3-ASR-0.6B-GGUF"
    assert req["sourceRemotePath"] == "Qwen3-ASR-0.6B-Q8_0.gguf"
    assert req["path"] == (tmp_path / "2b" / "asr" / "eliza-1-asr.gguf").as_posix()


def test_stage_asr_requantize_can_be_disabled(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    args = _legacy_qwen_args(tmp_path, "2b")
    args.asr_requantize = "none"
    report = stage.stage_assets(args)

    assert report["asrRequantize"] is None


def test_real_stage_requantizes_asr_when_quantizer_is_supplied(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_copy_hf_file(**kwargs):
        destination = kwargs["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"q8-source")
        return {
            "repo": kwargs["repo_id"],
            "revision": kwargs["revision"],
            "remotePath": kwargs["remote_path"],
            "path": str(destination),
            "sizeBytes": destination.stat().st_size,
            "sha256": "0" * 64,
        }

    def fake_download_url_file(**kwargs):
        destination = kwargs["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"onnx-payload")
        return {
            "url": kwargs["url"],
            "path": str(destination),
            "sizeBytes": destination.stat().st_size,
            "sha256": "0" * 64,
        }

    def fake_requantize_gguf_file(**kwargs):
        destination = kwargs["destination"]
        destination.write_bytes(b"q4-asr")
        calls.append(kwargs)
        return {
            "path": str(destination),
            "sourcePath": str(kwargs["source"]),
            "quant": kwargs["quant"],
            "allowRequantize": kwargs["allow_requantize"],
            "kind": "gguf-requantize",
            "sizeBytes": destination.stat().st_size,
            "sha256": stage.sha256_file(destination),
        }

    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    monkeypatch.setattr(stage, "copy_hf_file", fake_copy_hf_file)
    monkeypatch.setattr(stage, "download_url_file", fake_download_url_file)
    monkeypatch.setattr(stage, "requantize_gguf_file", fake_requantize_gguf_file)
    monkeypatch.setattr(stage, "validate_manifest", lambda *args, **kwargs: ())

    args = _legacy_qwen_args(tmp_path, "2b")
    args.dry_run = False
    args.llama_quantize_bin = tmp_path / "llama-quantize"
    args.asr_requantize = "Q4_K_M"
    bundle = tmp_path / "2b"
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "eliza-1.manifest.json").write_text(
        json.dumps({"id": "eliza-1-2b", "tier": "2b", "files": {}}) + "\n",
        encoding="utf-8",
    )
    (bundle / "evidence" / "release.json").write_text(
        json.dumps({"schemaVersion": 1, "tier": "2b", "weights": []}) + "\n",
        encoding="utf-8",
    )

    report = stage.stage_assets(args)

    assert calls
    assert calls[0]["quant"] == "Q4_K_M"
    assert calls[0]["allow_requantize"] is True
    assert not (bundle / "asr" / "eliza-1-asr.source.gguf").exists()
    assert (bundle / "asr" / "eliza-1-asr.gguf").read_bytes() == b"q4-asr"
    assert report["asrRequantize"]["sha256"] == stage.sha256_file(
        bundle / "asr" / "eliza-1-asr.gguf"
    )


def test_skip_wakeword_omits_wake_graphs(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    args = _legacy_qwen_args(tmp_path, "4b")
    args.skip_wakeword = True
    report = stage.stage_assets(args)
    assert not any("url" in f for f in report["files"])


def test_stage_dry_run_can_include_legacy_onnx_vad_fallback(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    args = _legacy_qwen_args(tmp_path, "4b")
    args.include_vad_onnx_fallback = True
    report = stage.stage_assets(args)
    staged = {
        (f["repo"], f["remotePath"], Path(f["path"]).as_posix())
        for f in report["files"]
        if "repo" in f
    }
    assert (
        "onnx-community/silero-vad",
        "onnx/model_int8.onnx",
        (tmp_path / "4b" / "vad" / "silero-vad-int8.onnx").as_posix(),
    ) in staged
    assert report["vad"]["onnxFallbackIncluded"] is True
    assert report["vad"]["onnxFallbackRepo"] == "onnx-community/silero-vad"


def test_legacy_stage_dry_run_accepts_active_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_legacy_qwen_args(tmp_path, "2b"))

    assert report["tier"] == "2b"
    assert report["asrRepo"] == "ggml-org/Qwen3-ASR-0.6B-GGUF"


def test_non_dry_run_writes_asr_vad_and_wakeword_license_notes(
    tmp_path: Path,
) -> None:
    stage.write_license_notes(tmp_path, dry_run=False)
    assert (tmp_path / "licenses" / "LICENSE.asr").is_file()
    assert (tmp_path / "licenses" / "LICENSE.vad").is_file()
    assert (tmp_path / "licenses" / "LICENSE.wakeword").is_file()
    assert "Qwen3-ASR assets are retired" in (
        tmp_path / "licenses" / "LICENSE.asr"
    ).read_text()
    vad = (tmp_path / "licenses" / "LICENSE.vad").read_text()
    assert "GGUF" in vad
    assert "vad/silero-vad-v5.gguf" in vad
    ww = (tmp_path / "licenses" / "LICENSE.wakeword").read_text()
    assert "openWakeWord" in ww
    assert "Apache-2.0" in ww


def test_voice_preset_payload_is_deterministic_in_dry_run(tmp_path: Path) -> None:
    a = stage.write_voice_preset(tmp_path / "a.bin", dry_run=True)
    b = stage.write_voice_preset(tmp_path / "b.bin", dry_run=True)
    assert a["sha256"] == b["sha256"]
    assert a["phraseSeedCount"] == 0
    assert not (tmp_path / "a.bin").exists()


def test_real_stage_writes_evidence_report_without_downloading(
    tmp_path: Path,
    monkeypatch,
) -> None:
    copied: list[tuple[str, Path]] = []

    def fake_copy_hf_file(**kwargs):
        destination = kwargs["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"payload")
        copied.append((kwargs["remote_path"], destination))
        return {
            "repo": kwargs["repo_id"],
            "revision": kwargs["revision"],
            "remotePath": kwargs["remote_path"],
            "path": str(destination),
            "sizeBytes": 7,
            "sha256": "0" * 64,
        }

    def fake_download_url_file(**kwargs):
        destination = kwargs["destination"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"onnx-payload")
        return {
            "url": kwargs["url"],
            "path": str(destination),
            "sizeBytes": 12,
            "sha256": "0" * 64,
        }

    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    monkeypatch.setattr(stage, "copy_hf_file", fake_copy_hf_file)
    monkeypatch.setattr(stage, "download_url_file", fake_download_url_file)
    monkeypatch.setattr(stage, "validate_manifest", lambda *args, **kwargs: ())
    args = _legacy_qwen_args(tmp_path, "2b")
    args.dry_run = False
    args.asr_requantize = "none"
    bundle = tmp_path / "2b"
    (bundle / "evidence").mkdir(parents=True)
    (bundle / "eliza-1.manifest.json").write_text(
        json.dumps(
            {
                    "id": "eliza-1-2b",
                    "tier": "2b",
                "files": {
                    "voice": [],
                    "asr": [],
                    "vad": [],
                    "wakeword": [],
                    "cache": [],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    (bundle / "evidence" / "release.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                    "tier": "2b",
                "repoId": "old/repo",
                "weights": [],
                "hf": {"repoId": "old/repo"},
            }
        )
        + "\n",
        encoding="utf-8",
    )

    report = stage.stage_assets(args)

    assert report["dryRun"] is False
    assert copied
    assert (tmp_path / "2b" / "wake" / "hey-eliza.onnx").is_file()
    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    voice_paths = {entry["path"] for entry in manifest["files"]["voice"]}
    assert "tts/omnivoice-base-Q4_K_M.gguf" in voice_paths
    assert "tts/omnivoice-tokenizer-Q4_K_M.gguf" in voice_paths
    assert manifest["files"]["cache"][0]["path"] == "cache/voice-preset-default.bin"
    release = json.loads((bundle / "evidence" / "release.json").read_text())
    assert release["repoId"] == stage.ELIZA_1_HF_REPO
    assert "tts/omnivoice-base-Q4_K_M.gguf" in release["weights"]
    assert stage.VOICE_REPO in report["sources"]
    assert (bundle / "checksums" / "SHA256SUMS").is_file()
    assert report["manifestUpdate"]["updatedPaths"]
    assert report["releaseEvidenceUpdate"]["weights"]
    assert report["checksumManifest"]["entryCount"] > 0
    evidence = json.loads(
        (tmp_path / "2b" / "evidence" / "bundle-assets.json").read_text()
    )
    assert evidence["asrRepo"] == "ggml-org/Qwen3-ASR-0.6B-GGUF"
