"""Tests for staging non-text Eliza-1 bundle assets."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import stage_eliza1_bundle_assets as stage  # noqa: E402


class FakeHfApi:
    def model_info(self, repo: str) -> SimpleNamespace:
        return SimpleNamespace(sha=f"sha-{repo}")

    def list_repo_files(self, repo_id: str, repo_type: str) -> list[str]:
        assert repo_type == "model"
        if repo_id == "ggml-org/Qwen3-ASR-0.8B-GGUF":
            return [
                "Qwen3-ASR-0.8B-Q8_0.gguf",
                "Qwen3-ASR-0.8B-bf16.gguf",
                "mmproj-Qwen3-ASR-0.8B-Q8_0.gguf",
            ]
        if repo_id == "ggml-org/Qwen3-ASR-2B-GGUF":
            return [
                "Qwen3-ASR-2B-Q8_0.gguf",
                "Qwen3-ASR-2B-bf16.gguf",
                "mmproj-Qwen3-ASR-2B-Q8_0.gguf",
            ]
        if repo_id == "ggml-org/whisper-vad":
            return ["ggml-silero-v5.1.2.bin"]
        return []


def _args(tmp_path: Path, tier: str) -> argparse.Namespace:
    return argparse.Namespace(
        tier=tier,
        bundle_dir=tmp_path / tier,
        dry_run=True,
        link_mode="copy",
        asr_repo=None,
        asr_file=None,
        asr_mmproj_file=None,
        include_vad_onnx_fallback=False,
        skip_wakeword=False,
        upload_repo=None,
        upload_prefix="",
        public=False,
    )


def test_stage_dry_run_uses_qwen_asr_gguf_and_native_vad(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_args(tmp_path, "9b"))

    staged = {
        (f["repo"], f["remotePath"], Path(f["path"]).as_posix())
        for f in report["files"]
        if "repo" in f
    }
    assert (
        "ggml-org/Qwen3-ASR-0.8B-GGUF",
        "Qwen3-ASR-0.8B-Q8_0.gguf",
        (tmp_path / "9b" / "asr" / "eliza-1-asr.gguf").as_posix(),
    ) in staged
    assert (
        "ggml-org/Qwen3-ASR-0.8B-GGUF",
        "mmproj-Qwen3-ASR-0.8B-Q8_0.gguf",
        (tmp_path / "9b" / "asr" / "eliza-1-asr-mmproj.gguf").as_posix(),
    ) in staged
    assert (
        "ggml-org/whisper-vad",
        "ggml-silero-v5.1.2.bin",
        (tmp_path / "9b" / "vad" / "silero-vad-v5.1.2.ggml.bin").as_posix(),
    ) in staged
    assert report["asrMmprojRemotePath"] == "mmproj-Qwen3-ASR-0.8B-Q8_0.gguf"
    assert report["vad"] == {
        "nativeRepo": "ggml-org/whisper-vad",
        "nativeRemotePath": "ggml-silero-v5.1.2.bin",
        "nativeBundlePath": "vad/silero-vad-v5.1.2.ggml.bin",
        "format": "ggml",
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
        dst = (tmp_path / "9b" / rel).as_posix()
        assert dst in ww
        assert ww[dst].startswith(stage.WAKEWORD_RELEASE)


def test_skip_wakeword_omits_wake_graphs(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    args = _args(tmp_path, "9b")
    args.skip_wakeword = True
    report = stage.stage_assets(args)
    assert not any("url" in f for f in report["files"])


def test_stage_dry_run_can_include_legacy_onnx_vad_fallback(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    args = _args(tmp_path, "9b")
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
        (tmp_path / "9b" / "vad" / "silero-vad-int8.onnx").as_posix(),
    ) in staged
    assert report["vad"]["onnxFallbackIncluded"] is True
    assert report["vad"]["onnxFallbackRepo"] == "onnx-community/silero-vad"


def test_stage_dry_run_uses_larger_asr_for_pro_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_args(tmp_path, "27b"))
    assert report["asrRepo"] == "ggml-org/Qwen3-ASR-2B-GGUF"
    assert report["asrRemotePath"] == "Qwen3-ASR-2B-Q8_0.gguf"


def test_stage_dry_run_uses_larger_asr_for_27b_1m_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_args(tmp_path, "27b-1m"))
    assert report["asrRepo"] == "ggml-org/Qwen3-ASR-2B-GGUF"
    assert report["asrRemotePath"] == "Qwen3-ASR-2B-Q8_0.gguf"


def test_non_dry_run_writes_asr_vad_and_wakeword_license_notes(
    tmp_path: Path,
) -> None:
    stage.write_license_notes(tmp_path, dry_run=False)
    assert (tmp_path / "licenses" / "LICENSE.asr").is_file()
    assert (tmp_path / "licenses" / "LICENSE.vad").is_file()
    assert (tmp_path / "licenses" / "LICENSE.wakeword").is_file()
    assert "Qwen3-ASR" in (tmp_path / "licenses" / "LICENSE.asr").read_text()
    vad = (tmp_path / "licenses" / "LICENSE.vad").read_text()
    assert "GGML" in vad
    assert "vad/silero-vad-v5.1.2.ggml.bin" in vad
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
    args = _args(tmp_path, "0_8b")
    args.dry_run = False

    report = stage.stage_assets(args)

    assert report["dryRun"] is False
    assert copied
    assert (tmp_path / "0_8b" / "wake" / "hey-eliza.onnx").is_file()
    evidence = json.loads(
        (tmp_path / "0_8b" / "evidence" / "bundle-assets.json").read_text()
    )
    assert evidence["asrRepo"] == "ggml-org/Qwen3-ASR-0.8B-GGUF"
