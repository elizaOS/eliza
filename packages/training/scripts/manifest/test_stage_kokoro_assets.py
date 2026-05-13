"""Tests for staging Kokoro assets into existing Eliza-1 bundles."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

_TRAINING_ROOT = Path(__file__).resolve().parents[2]
if str(_TRAINING_ROOT) not in sys.path:
    sys.path.insert(0, str(_TRAINING_ROOT))

from scripts.manifest import stage_kokoro_assets as stage  # noqa: E402


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_bundle(root: Path) -> Path:
    bundle = root / "eliza-1-1_7b.bundle"
    files = {
        "text/eliza-1-1_7b-32k.gguf": b"text",
        "tts/omnivoice-base-Q4_K_M.gguf": b"omni",
        "dflash/drafter-1_7b.gguf": b"draft",
        "cache/voice-preset-default.bin": b"cache",
    }
    for rel, payload in files.items():
        p = bundle / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(payload)
    manifest = {
        "$schema": "https://elizaos.ai/schemas/eliza-1.manifest.v1.json",
        "id": "eliza-1-1_7b",
        "tier": "1_7b",
        "version": "1.0.0",
        "publishedAt": "2026-05-12T00:00:00Z",
        "lineage": {
            "text": {"base": "Qwen/Qwen3.5-1.7B", "license": "apache-2.0"},
            "voice": {"base": "Serveurperso/OmniVoice-GGUF", "license": "apache-2.0"},
            "drafter": {"base": "Qwen/Qwen3.5-1.7B", "license": "apache-2.0"},
        },
        "files": {
            "text": [
                {
                    "path": "text/eliza-1-1_7b-32k.gguf",
                    "sha256": _sha(files["text/eliza-1-1_7b-32k.gguf"]),
                    "ctx": 32768,
                }
            ],
            "voice": [
                {
                    "path": "tts/omnivoice-base-Q4_K_M.gguf",
                    "sha256": _sha(files["tts/omnivoice-base-Q4_K_M.gguf"]),
                }
            ],
            "asr": [],
            "vision": [],
            "dflash": [
                {
                    "path": "dflash/drafter-1_7b.gguf",
                    "sha256": _sha(files["dflash/drafter-1_7b.gguf"]),
                }
            ],
            "cache": [
                {
                    "path": "cache/voice-preset-default.bin",
                    "sha256": _sha(files["cache/voice-preset-default.bin"]),
                }
            ],
        },
        "kernels": {
            "required": ["turboquant_q4", "qjl", "polarquant", "dflash"],
            "optional": [],
            "verifiedBackends": {
                b: {"status": "skipped", "atCommit": "test", "report": "test"}
                for b in ("metal", "vulkan", "cuda", "rocm", "cpu")
            },
        },
        "evals": {
            "textEval": {"score": 0, "passed": False},
            "voiceRtf": {"rtf": 0, "passed": False},
            "e2eLoopOk": False,
            "thirtyTurnOk": False,
        },
        "ramBudgetMb": {"min": 1, "recommended": 2},
        "defaultEligible": False,
    }
    (bundle / "eliza-1.manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return bundle


class FakeHfApi:
    def model_info(self, repo: str) -> SimpleNamespace:
        return SimpleNamespace(sha=f"sha-{repo}")


def test_dry_run_plans_default_kokoro_files(tmp_path: Path) -> None:
    bundle = _write_bundle(tmp_path)

    report = stage.stage_kokoro_bundle(bundle, dry_run=True)

    paths = {f["bundle_path"] for f in report["files"]}
    assert "tts/kokoro/model_q4.onnx" in paths
    assert "tts/kokoro/tokenizer.json" in paths
    assert "tts/kokoro/voices/af_bella.bin" in paths
    assert not (bundle / "tts" / "kokoro").exists()


def test_stage_updates_manifest_evidence_license_and_checksums(
    tmp_path: Path,
    monkeypatch,
) -> None:
    bundle = _write_bundle(tmp_path)
    cache = tmp_path / "cache"

    def fake_download(**kwargs):
        remote = kwargs["filename"]
        p = cache / remote
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(f"payload:{remote}".encode())
        return str(p)

    monkeypatch.setattr(stage, "HfApi", FakeHfApi)
    monkeypatch.setattr(stage, "hf_hub_download", fake_download)

    report = stage.stage_kokoro_bundle(bundle, voices=("af_bella",), dry_run=False)

    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    voice_paths = {entry["path"] for entry in manifest["files"]["voice"]}
    assert "tts/omnivoice-base-Q4_K_M.gguf" in voice_paths
    assert "tts/kokoro/model_q4.onnx" in voice_paths
    assert "tts/kokoro/tokenizer.json" in voice_paths
    assert "tts/kokoro/voices/af_bella.bin" in voice_paths
    assert "onnx-community/Kokoro-82M-v1.0-ONNX" in manifest["lineage"]["voice"]["base"]
    assert (bundle / "licenses" / "LICENSE.kokoro").is_file()
    assert (bundle / "evidence" / "kokoro-assets.json").is_file()
    assert report["checksumManifest"] == "checksums/SHA256SUMS"
    sums = (bundle / "checksums" / "SHA256SUMS").read_text()
    assert "tts/kokoro/model_q4.onnx" in sums
    assert "evidence/kokoro-assets.json" in sums
