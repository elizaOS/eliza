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
        upload_repo=None,
        upload_prefix="",
        public=False,
    )


def test_stage_dry_run_uses_qwen_asr_gguf_and_vad_sidecar(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_args(tmp_path, "9b"))

    staged = {
        (f["repo"], f["remotePath"], Path(f["path"]).as_posix())
        for f in report["files"]
    }
    assert (
        "ggml-org/Qwen3-ASR-0.6B-GGUF",
        "Qwen3-ASR-0.6B-Q8_0.gguf",
        (tmp_path / "9b" / "asr" / "eliza-1-asr.gguf").as_posix(),
    ) in staged
    assert (
        "ggml-org/Qwen3-ASR-0.6B-GGUF",
        "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
        (tmp_path / "9b" / "asr" / "eliza-1-asr-mmproj.gguf").as_posix(),
    ) in staged
    assert (
        "onnx-community/silero-vad",
        "onnx/model_int8.onnx",
        (tmp_path / "9b" / "vad" / "silero-vad-int8.onnx").as_posix(),
    ) in staged
    assert report["asrMmprojRemotePath"] == "mmproj-Qwen3-ASR-0.6B-Q8_0.gguf"


def test_stage_dry_run_uses_larger_asr_for_pro_tier(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    report = stage.stage_assets(_args(tmp_path, "27b"))
    assert report["asrRepo"] == "ggml-org/Qwen3-ASR-1.7B-GGUF"
    assert report["asrRemotePath"] == "Qwen3-ASR-1.7B-Q8_0.gguf"


def test_non_dry_run_writes_asr_and_vad_license_notes(tmp_path: Path) -> None:
    stage.write_license_notes(tmp_path, dry_run=False)
    assert (tmp_path / "licenses" / "LICENSE.asr").is_file()
    assert (tmp_path / "licenses" / "LICENSE.vad").is_file()
    assert "Qwen3-ASR" in (tmp_path / "licenses" / "LICENSE.asr").read_text()


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

    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    monkeypatch.setattr(stage, "copy_hf_file", fake_copy_hf_file)
    args = _args(tmp_path, "0_6b")
    args.dry_run = False

    report = stage.stage_assets(args)

    assert report["dryRun"] is False
    assert copied
    evidence = json.loads(
        (tmp_path / "0_6b" / "evidence" / "bundle-assets.json").read_text()
    )
    assert evidence["asrRepo"] == "ggml-org/Qwen3-ASR-0.6B-GGUF"
