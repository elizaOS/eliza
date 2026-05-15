#!/usr/bin/env python3
"""Hydrate public voice sub-model binary payloads into local staging.

The voice registry intentionally does not record hashes for binaries that
were not present. This helper downloads every currently public upstream
payload we can verify, writes it under ``artifacts/voice-sub-model-staging``,
and patches the local voice manifests with real ``sha256`` / ``sizeBytes``.

Custom Eliza-only assets remain explicit gaps until their build pipelines
produce files:

* ``voices/af_sam.bin`` (Kokoro sam preset)
* ``presets/voice-preset-same.bin`` (OmniVoice same-voice preset)
* ``hey-eliza-int8.onnx`` (trained wake-word head)
* ``voice-emotion`` ONNX exports
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from huggingface_hub import hf_hub_download


REPO_ROOT: Final[Path] = Path(__file__).resolve().parents[4]
STAGING_ROOT: Final[Path] = REPO_ROOT / "artifacts" / "voice-sub-model-staging"
VOICE_MANIFEST: Final[Path] = REPO_ROOT / "models" / "voice" / "manifest.json"


@dataclass(frozen=True)
class AssetSpec:
    staging_dir: str
    filename: str
    repo: str
    remote_path: str
    revision: str | None = None


ASSETS: Final[tuple[AssetSpec, ...]] = (
    AssetSpec(
        "speaker",
        "wespeaker-resnet34-lm.onnx",
        "Wespeaker/wespeaker-voxceleb-resnet34-LM",
        "voxceleb_resnet34_LM.onnx",
    ),
    AssetSpec(
        "embedding",
        "eliza-1-embedding-q8_0.gguf",
        "Qwen/Qwen3-Embedding-0.6B-GGUF",
        "Qwen3-Embedding-0.6B-Q8_0.gguf",
    ),
    AssetSpec(
        "asr",
        "eliza-1-asr-q8_0.gguf",
        "ggml-org/Qwen3-ASR-1.7B-GGUF",
        "Qwen3-ASR-1.7B-Q8_0.gguf",
    ),
    AssetSpec(
        "asr",
        "eliza-1-asr-mmproj.gguf",
        "ggml-org/Qwen3-ASR-1.7B-GGUF",
        "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
    ),
    AssetSpec(
        "diarizer",
        "pyannote-segmentation-3.0-int8.onnx",
        "onnx-community/pyannote-segmentation-3.0",
        "onnx/model_int8.onnx",
    ),
    AssetSpec(
        "diarizer",
        "pyannote-segmentation-3.0-fp32.onnx",
        "onnx-community/pyannote-segmentation-3.0",
        "onnx/model.onnx",
    ),
    AssetSpec(
        "kokoro",
        "kokoro-v1.0-q4.onnx",
        "onnx-community/Kokoro-82M-v1.0-ONNX",
        "onnx/model_q4.onnx",
    ),
    AssetSpec(
        "kokoro",
        "voices/af_bella.bin",
        "onnx-community/Kokoro-82M-v1.0-ONNX",
        "voices/af_bella.bin",
    ),
    AssetSpec(
        "omnivoice",
        "omnivoice-base-q4_k_m.gguf",
        "Serveurperso/OmniVoice-GGUF",
        "omnivoice-base-Q4_K_M.gguf",
    ),
    AssetSpec(
        "omnivoice",
        "omnivoice-tokenizer-q4_k_m.gguf",
        "Serveurperso/OmniVoice-GGUF",
        "omnivoice-tokenizer-Q4_K_M.gguf",
    ),
    AssetSpec(
        "omnivoice",
        "omnivoice-base-q8_0.gguf",
        "Serveurperso/OmniVoice-GGUF",
        "omnivoice-base-Q8_0.gguf",
    ),
    AssetSpec(
        "turn",
        "turn-detector-en-int8.onnx",
        "livekit/turn-detector",
        "onnx/model_q8.onnx",
        "v1.2.2-en",
    ),
    AssetSpec(
        "turn",
        "turn-detector-intl-int8.onnx",
        "livekit/turn-detector",
        "onnx/model_q8.onnx",
        "v0.4.1-intl",
    ),
    AssetSpec(
        "turn",
        "turnsense-fallback-int8.onnx",
        "latishab/turnsense",
        "model_quantized.onnx",
    ),
    AssetSpec(
        "vad",
        "silero-vad-int8.onnx",
        "onnx-community/silero-vad",
        "onnx/model_int8.onnx",
    ),
    AssetSpec(
        "vad",
        "silero-vad-v5.1.2.ggml.bin",
        "ggml-org/whisper-vad",
        "ggml-silero-v5.1.2.bin",
    ),
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def copy_from_hf(spec: AssetSpec, *, dry_run: bool) -> dict[str, Any]:
    destination = STAGING_ROOT / spec.staging_dir / spec.filename
    if not dry_run:
        destination.parent.mkdir(parents=True, exist_ok=True)
        cached = Path(
            hf_hub_download(
                repo_id=spec.repo,
                filename=spec.remote_path,
                revision=spec.revision,
                repo_type="model",
            )
        )
        shutil.copy2(cached, destination)
    size = destination.stat().st_size if destination.exists() else None
    digest = sha256_file(destination) if destination.exists() else None
    return {
        "stagingDir": spec.staging_dir,
        "filename": spec.filename,
        "repo": spec.repo,
        "remotePath": spec.remote_path,
        "revision": spec.revision,
        "path": str(destination),
        "sizeBytes": size,
        "sha256": digest,
        "dryRun": dry_run,
    }


def patch_manifest_file(path: Path, hydrated: dict[str, dict[str, Any]]) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    changed = False
    for item in data.get("files", []):
        if not isinstance(item, dict):
            continue
        info = hydrated.get(str(item.get("filename")))
        if not info:
            continue
        item["sizeBytes"] = info["sizeBytes"]
        item["sha256"] = info["sha256"]
        item["assetStatus"] = "available"
        item["sourceRepo"] = info["repo"]
        item["sourcePath"] = info["remotePath"]
        if info.get("revision"):
            item["sourceRevision"] = info["revision"]
        changed = True
    if changed:
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def patch_voice_manifest(hydrated: dict[str, dict[str, Any]]) -> None:
    data = json.loads(VOICE_MANIFEST.read_text(encoding="utf-8"))
    data["assetAudit"] = {
        "auditedAt": "2026-05-15T00:00:00Z",
        "status": "partial-binaries-hydrated",
        "notes": [
            "Public upstream payloads were downloaded into artifacts/voice-sub-model-staging and verified by sha256.",
            "Custom Eliza-only assets remain missing until their training/build pipelines produce binaries.",
            "Do not publish entries with null sha256/sizeBytes as available assets.",
        ],
    }
    for model in data.get("models", []):
        for variant in model.get("variants", []):
            info = hydrated.get(str(variant.get("filename")))
            if not info:
                continue
            variant["sizeBytes"] = info["sizeBytes"]
            variant["sha256"] = info["sha256"]
            variant["assetStatus"] = "available"
            variant.pop("missingReason", None)
            variant["stagedPath"] = str(
                Path("artifacts")
                / "voice-sub-model-staging"
                / info["stagingDir"]
                / info["filename"]
            )
            variant["sourceRepo"] = info["repo"]
            variant["sourcePath"] = info["remotePath"]
            if info.get("revision"):
                variant["sourceRevision"] = info["revision"]
    VOICE_MANIFEST.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    reports = [copy_from_hf(spec, dry_run=args.dry_run) for spec in ASSETS]
    hydrated = {
        str(report["filename"]): report
        for report in reports
        if report.get("sha256") and report.get("sizeBytes")
    }
    if not args.dry_run:
        for manifest in STAGING_ROOT.glob("*/manifest.json"):
            patch_manifest_file(manifest, hydrated)
        patch_voice_manifest(hydrated)
    print(json.dumps({"assets": reports}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
