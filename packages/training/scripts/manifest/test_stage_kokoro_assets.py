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
from scripts.manifest.eliza1_manifest import REQUIRED_KERNELS_BY_TIER  # noqa: E402


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_bundle(root: Path) -> Path:
    bundle = root / "eliza-1-2b.bundle"
    files = {
        "text/eliza-1-2b-128k.gguf": b"text",
        "tts/omnivoice-base-Q4_K_M.gguf": b"omni",
        "mtp/drafter-2b.gguf": b"draft",
        "vision/mmproj-2b.gguf": b"vision",
        "cache/voice-preset-default.bin": b"cache",
    }
    for rel, payload in files.items():
        p = bundle / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(payload)
    manifest = {
        "$schema": "https://elizaos.ai/schemas/eliza-1.manifest.v1.json",
        "id": "eliza-1-2b",
        "tier": "2b",
        "version": "1.0.0",
        "publishedAt": "2026-05-12T00:00:00Z",
        "lineage": {
            "text": {"base": "google/gemma-4-E2B", "license": "apache-2.0"},
            "voice": {"base": "Serveurperso/OmniVoice-GGUF", "license": "apache-2.0"},
            "drafter": {"base": "google/gemma-4-E2B", "license": "apache-2.0"},
            "vision": {
                "base": "unsloth/gemma-4-E2B-GGUF/mmproj-F16.gguf",
                "license": "apache-2.0",
            },
        },
        "files": {
            "text": [
                {
                    "path": "text/eliza-1-2b-128k.gguf",
                    "sha256": _sha(files["text/eliza-1-2b-128k.gguf"]),
                    "ctx": 131072,
                }
            ],
            "voice": [
                {
                    "path": "tts/omnivoice-base-Q4_K_M.gguf",
                    "sha256": _sha(files["tts/omnivoice-base-Q4_K_M.gguf"]),
                }
            ],
            "asr": [],
            "vision": [
                {
                    "path": "vision/mmproj-2b.gguf",
                    "sha256": _sha(files["vision/mmproj-2b.gguf"]),
                }
            ],
            "mtp": [
                {
                    "path": "mtp/drafter-2b.gguf",
                    "sha256": _sha(files["mtp/drafter-2b.gguf"]),
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
            "required": list(REQUIRED_KERNELS_BY_TIER["2b"]),
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
    assert report["tier"] == "2b"
    assert "tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf" in paths
    assert "tts/kokoro/tokenizer.json" in paths
    assert "tts/kokoro/voices/af_bella.bin" in paths
    remotes = {f["remote_path"] for f in report["files"]}
    assert "bundles/2b/tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf" in remotes
    assert "bundles/2b/tts/kokoro/tokenizer.json" in remotes
    assert "bundles/2b/tts/kokoro/voices/af_bella.bin" in remotes
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
    assert "tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf" in voice_paths
    assert "tts/kokoro/tokenizer.json" in voice_paths
    assert "tts/kokoro/voices/af_bella.bin" in voice_paths
    assert "elizaos/eliza-1" in manifest["lineage"]["voice"]["base"]
    assert (bundle / "licenses" / "LICENSE.kokoro").is_file()
    assert (bundle / "evidence" / "kokoro-assets.json").is_file()
    assert report["checksumManifest"] == "checksums/SHA256SUMS"
    sums = (bundle / "checksums" / "SHA256SUMS").read_text()
    assert "tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf" in sums
    assert "evidence/kokoro-assets.json" in sums


def test_voice_remote_template_overrides_default_path(tmp_path: Path) -> None:
    """Per-voice HF repos ship the embedding at a different remote path.

    The default template uses the tiered `elizaos/eliza-1` bundle layout.
    Per-voice staging releases can still ship `voice.bin` at the release-dir
    root — the template lets the caller override the remote path while the
    bundle path remains canonical.
    """
    bundle = _write_bundle(tmp_path)
    report = stage.stage_kokoro_bundle(
        bundle,
        voices=("af_same",),
        dry_run=True,
        voice_remote_template="voice.bin",
        include_base_assets=False,
    )
    remotes = {f["remote_path"] for f in report["files"]}
    # No base-asset remotes when include_base_assets=False.
    assert "bundles/2b/tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf" not in remotes
    assert "tokenizer.json" not in remotes
    # The voice itself was looked up at the overridden remote path.
    assert "voice.bin" in remotes
    # Bundle path stays at the canonical kokoro layout regardless of remote.
    paths = {f["bundle_path"] for f in report["files"]}
    assert "tts/kokoro/voices/af_same.bin" in paths


def test_voice_remote_template_placeholder_per_voice(tmp_path: Path) -> None:
    """Templates with `{voice}` interpolate the voice name in the remote path."""
    bundle = _write_bundle(tmp_path)
    report = stage.stage_kokoro_bundle(
        bundle,
        voices=("af_same", "af_bella"),
        dry_run=True,
        voice_remote_template="custom/{voice}-pack.bin",
    )
    remotes = {f["remote_path"] for f in report["files"] if f["role"] == "kokoro-voice"}
    assert remotes == {"custom/af_same-pack.bin", "custom/af_bella-pack.bin"}


def test_kokoro_only_prunes_omnivoice_payloads_from_small_bundle(
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

    report = stage.stage_kokoro_bundle(
        bundle,
        voices=("af_bella",),
        dry_run=False,
        kokoro_only=True,
    )

    manifest = json.loads((bundle / "eliza-1.manifest.json").read_text())
    voice_paths = {entry["path"] for entry in manifest["files"]["voice"]}
    assert voice_paths == {
        "tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf",
        "tts/kokoro/tokenizer.json",
        "tts/kokoro/voices/af_bella.bin",
    }
    assert not (bundle / "tts" / "omnivoice-base-Q4_K_M.gguf").exists()
    assert report["removed"] == ["tts/omnivoice-base-Q4_K_M.gguf"]
    assert manifest["lineage"]["voice"]["base"].startswith(
        "elizaos/eliza-1@"
    )
    sums = (bundle / "checksums" / "SHA256SUMS").read_text()
    assert "tts/omnivoice-base-Q4_K_M.gguf" not in sums
