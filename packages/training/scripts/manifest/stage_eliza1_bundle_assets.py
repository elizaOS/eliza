#!/usr/bin/env python3
"""Stage real voice / ASR / VAD assets into an Eliza-1 bundle directory.

This is the bridge between the manifest-first runtime bundle layout and
the current upstream asset locations on Hugging Face. It intentionally does
not fabricate text or DFlash weights; it stages the non-text assets that are
already externally available and writes evidence/provenance sidecars so the
publish orchestrator can hash and validate the final bundle.

Default sources:
  - TTS: Serveurperso/OmniVoice-GGUF, Apache-2.0 GGUF artifacts.
  - ASR: ggml-org/Qwen3-ASR-0.6B-GGUF / Qwen3-ASR-1.7B-GGUF, GGUF artifacts.
  - VAD: ggml-org/whisper-vad, native GGML Silero VAD v5.1.2 model.
    The legacy onnx-community/silero-vad int8 ONNX model can be staged as
    an explicit fallback with --include-vad-onnx-fallback.
  - Wake word (optional): github.com/dscripka/openWakeWord release ONNX
    graphs (melspectrogram + embedding feature models, "hey jarvis" head
    staged as the Eliza-1 default `wake/hey-eliza.onnx`). Skip with
    `--skip-wakeword`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Mapping, Sequence

try:  # pragma: no cover - import availability is environment-dependent
    from huggingface_hub import HfApi, hf_hub_download
except ModuleNotFoundError:  # pragma: no cover - env-only path
    HfApi = None  # type: ignore[assignment]
    hf_hub_download = None  # type: ignore[assignment]

try:
    from .eliza1_manifest import (
        ELIZA_1_HF_REPO,
        VOICE_QUANT_BY_TIER,
        VOICE_QUANT_LADDER_BY_TIER,
        validate_manifest,
    )
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import (
        ELIZA_1_HF_REPO,
        VOICE_QUANT_BY_TIER,
        VOICE_QUANT_LADDER_BY_TIER,
        validate_manifest,
    )

VOICE_REPO: Final[str] = "Serveurperso/OmniVoice-GGUF"
VAD_NATIVE_REPO: Final[str] = "ggml-org/whisper-vad"
VAD_ONNX_REPO: Final[str] = "onnx-community/silero-vad"
ASR_REPO_BY_TIER: Final[dict[str, str]] = {
    "0_8b": "ggml-org/Qwen3-ASR-0.6B-GGUF",
    "2b": "ggml-org/Qwen3-ASR-0.6B-GGUF",
    "4b": "ggml-org/Qwen3-ASR-0.6B-GGUF",
    "9b": "ggml-org/Qwen3-ASR-1.7B-GGUF",
    "27b": "ggml-org/Qwen3-ASR-1.7B-GGUF",
    "27b-256k": "ggml-org/Qwen3-ASR-1.7B-GGUF",
    "27b-1m": "ggml-org/Qwen3-ASR-1.7B-GGUF",
}

# Voice Wave 2 (2026-05-14): semantic end-of-turn detector — `livekit/turn-detector`
# is the default ship target; `latishab/turnsense` is the Apache-2.0 fallback
# routed via `--turn-license=apache`. Per-tier revision matches the runtime
# resolver in `plugins/plugin-local-inference/src/services/voice/eot-classifier.ts`
# (`turnDetectorRevisionForTier`): EN-only SmolLM2 distill on `0_8b` / `2b`,
# multilingual pruned Qwen2.5 elsewhere.
TURN_DETECTOR_LIVEKIT_REPO: Final[str] = "livekit/turn-detector"
TURN_DETECTOR_LIVEKIT_REVISION_BY_TIER: Final[dict[str, str]] = {
    "0_8b": "v1.2.2-en",
    "2b": "v1.2.2-en",
    "4b": "v0.4.1-intl",
    "9b": "v0.4.1-intl",
    "27b": "v0.4.1-intl",
    "27b-256k": "v0.4.1-intl",
    "27b-1m": "v0.4.1-intl",
}
TURN_DETECTOR_TURNSENSE_REPO: Final[str] = "latishab/turnsense"
TURN_DETECTOR_LIVEKIT_ONNX_REMOTE: Final[str] = "onnx/model_q8.onnx"
TURN_DETECTOR_LIVEKIT_ONNX_BUNDLE: Final[str] = "turn/model_q8.onnx"
TURN_DETECTOR_TURNSENSE_ONNX_REMOTE: Final[str] = "model_quantized.onnx"
TURN_DETECTOR_TURNSENSE_ONNX_BUNDLE: Final[str] = "turn/model_q8.onnx"
TURN_DETECTOR_TOKENIZER_REMOTE: Final[str] = "tokenizer.json"
TURN_DETECTOR_TOKENIZER_BUNDLE: Final[str] = "turn/tokenizer.json"
TURN_DETECTOR_LANGUAGES_REMOTE: Final[str] = "languages.json"
TURN_DETECTOR_LANGUAGES_BUNDLE: Final[str] = "turn/languages.json"
TURN_LICENSE_CHOICES: Final[tuple[str, ...]] = ("livekit", "apache")
GGUF_QUANT_PREFERENCE: Final[tuple[str, ...]] = (
    "Q4_K_M",
    "Q4_K_S",
    "Q5_K_M",
    "Q8_0",
)

VAD_NATIVE_FILES: Final[tuple[tuple[str, str], ...]] = (
    ("ggml-silero-v5.1.2.bin", "vad/silero-vad-v5.1.2.ggml.bin"),
)
VAD_ONNX_FALLBACK_FILES: Final[tuple[tuple[str, str], ...]] = (
    ("onnx/model_int8.onnx", "vad/silero-vad-int8.onnx"),
)

# openWakeWord ships its model-agnostic front-end graphs (melspectrogram +
# embedding model) as GitHub release assets — they ship verbatim per bundle
# and are not retrained. The wake-word head is the wake-phrase-specific
# part; it is trained by
# `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py` and
# either staged from a local trained-head path (via --wakeword-head-path)
# or, when no path is supplied, falls back to the upstream "hey jarvis"
# placeholder — which the runtime flags as a placeholder via
# `OPENWAKEWORD_PLACEHOLDER_HEADS` in voice/wake-word.ts. The 2026-05-14
# training run (FA=10%/TA=90% on a 20+20 synthetic held-out) produces the
# first real "hey eliza" head; the public registry will publish it once a
# proper noise-corpus eval lands.
WAKEWORD_RELEASE: Final[str] = (
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
)
WAKEWORD_FRONT_END_FILES: Final[tuple[tuple[str, str], ...]] = (
    ("melspectrogram.onnx", "wake/melspectrogram.onnx"),
    ("embedding_model.onnx", "wake/embedding_model.onnx"),
)
# Placeholder source used when the operator does not pass
# --wakeword-head-path; matches the historical behavior + the
# `hey_jarvis` placeholder flag in voice/wake-word.ts.
WAKEWORD_HEAD_PLACEHOLDER_REMOTE: Final[str] = "hey_jarvis_v0.1.onnx"
WAKEWORD_HEAD_DESTINATION: Final[str] = "wake/hey-eliza.onnx"
WAKEWORD_MIN_BYTES: Final[int] = 100_000

VOICE_PRESET_MAGIC: Final[int] = 0x315A4C45  # 'ELZ1'
VOICE_PRESET_VERSION: Final[int] = 1
VOICE_PRESET_HEADER_BYTES: Final[int] = 24
HF_RETRY_ATTEMPTS: Final[int] = 4
HF_RETRY_BASE_DELAY_SEC: Final[float] = 2.0


def require_hf_hub(*, require_download: bool = False) -> tuple[Any, Any]:
    global HfApi, hf_hub_download
    if HfApi is None or (require_download and hf_hub_download is None):
        try:
            from huggingface_hub import HfApi as ImportedHfApi
            from huggingface_hub import hf_hub_download as imported_hf_hub_download
        except ModuleNotFoundError as exc:  # pragma: no cover - env-only path
            raise SystemExit(
                "huggingface_hub is required for non-dry-run asset staging; "
                "install the training deps or run inside the training environment"
            ) from exc
        HfApi = ImportedHfApi
        hf_hub_download = imported_hf_hub_download
    if HfApi is None or (require_download and hf_hub_download is None):
        raise SystemExit(
            "huggingface_hub is required for non-dry-run asset staging; "
            "install the training deps or run inside the training environment"
        )
    return HfApi, hf_hub_download


def retry_hf(callable_, *args: Any, **kwargs: Any) -> Any:
    last_error: Exception | None = None
    for attempt in range(HF_RETRY_ATTEMPTS):
        try:
            return callable_(*args, **kwargs)
        except Exception as exc:  # pragma: no cover - network-only path
            last_error = exc
            if attempt == HF_RETRY_ATTEMPTS - 1:
                break
            time.sleep(HF_RETRY_BASE_DELAY_SEC * (attempt + 1))
    assert last_error is not None
    raise last_error


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def bundle_relpath(bundle_dir: Path, path: Path) -> str:
    root = bundle_dir.resolve()
    target = path.resolve()
    try:
        return target.relative_to(root).as_posix()
    except ValueError as exc:
        raise ValueError(f"staged path escapes bundle root: {path}") from exc


def _all_checksum_inputs(bundle_dir: Path) -> list[Path]:
    out: list[Path] = []
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(bundle_dir)
        if rel.as_posix() == "checksums/SHA256SUMS":
            continue
        if any(part.startswith(".") for part in rel.parts):
            continue
        out.append(path)
    return out


def regenerate_checksums(bundle_dir: Path, *, dry_run: bool) -> dict[str, Any] | None:
    if dry_run:
        return None
    checksum_path = bundle_dir / "checksums" / "SHA256SUMS"
    checksum_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        f"{sha256_file(path)}  {path.relative_to(bundle_dir).as_posix()}"
        for path in _all_checksum_inputs(bundle_dir)
    ]
    checksum_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {
        "path": str(checksum_path),
        "entryCount": len(lines),
        "sha256": sha256_file(checksum_path),
    }


def _slot_for_bundle_path(rel: str) -> str | None:
    if rel.startswith("tts/"):
        return "voice"
    if rel.startswith("asr/"):
        return "asr"
    if rel.startswith("vad/"):
        return "vad"
    if rel.startswith("wake/"):
        return "wakeword"
    if rel.startswith("turn/"):
        # Voice Wave 2: only the ONNX gates the manifest `files.turn` slot;
        # tokenizer.json + languages.json are co-located on disk but are
        # tokenizer/threshold sidecars, not a manifest-file entry.
        if rel.endswith(".onnx"):
            return "turn"
        return None
    if rel == "cache/voice-preset-default.bin":
        return "cache"
    return None


def merge_manifest_asset_entries(
    bundle_dir: Path,
    staged_files: Sequence[Mapping[str, Any]],
    *,
    voice_preset: Mapping[str, Any],
    dry_run: bool,
) -> dict[str, Any] | None:
    """Merge newly staged non-text assets into an existing bundle manifest."""

    manifest_path = bundle_dir / "eliza-1.manifest.json"
    if dry_run or not manifest_path.is_file():
        return None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"{manifest_path} did not contain a JSON object")

    files = manifest.setdefault("files", {})
    if not isinstance(files, dict):
        raise ValueError("manifest.files must be an object")

    by_slot: dict[str, dict[str, dict[str, Any]]] = {}
    for item in staged_files:
        path_value = item.get("path")
        if not isinstance(path_value, str):
            continue
        destination = Path(path_value)
        if not destination.is_file():
            continue
        rel = bundle_relpath(bundle_dir, destination)
        slot = _slot_for_bundle_path(rel)
        if slot is None:
            continue
        by_slot.setdefault(slot, {})[rel] = {
            "path": rel,
            "sha256": sha256_file(destination),
        }

    preset_path = voice_preset.get("path")
    if isinstance(preset_path, str) and (bundle_dir / "cache").is_dir():
        destination = Path(preset_path)
        if destination.is_file():
            rel = bundle_relpath(bundle_dir, destination)
            by_slot.setdefault("cache", {})[rel] = {
                "path": rel,
                "sha256": sha256_file(destination),
            }

    changed_paths: list[str] = []
    for slot, replacements in sorted(by_slot.items()):
        existing = files.setdefault(slot, [])
        if not isinstance(existing, list):
            raise ValueError(f"manifest.files.{slot} must be a list")
        merged: list[Any] = []
        seen: set[str] = set()
        for entry in existing:
            if isinstance(entry, dict) and isinstance(entry.get("path"), str):
                rel = entry["path"]
                if rel in replacements:
                    merged.append(replacements[rel])
                    seen.add(rel)
                    changed_paths.append(rel)
                else:
                    merged.append(entry)
            else:
                merged.append(entry)
        for rel, entry in sorted(replacements.items()):
            if rel not in seen:
                merged.append(entry)
                changed_paths.append(rel)
        files[slot] = merged

    errors = validate_manifest(manifest, require_publish_ready=False)
    if errors:
        raise ValueError(
            "manifest validation failed after asset staging: " + "; ".join(errors)
        )
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {
        "path": str(manifest_path),
        "updatedPaths": sorted(set(changed_paths)),
    }


def merge_release_evidence_assets(
    bundle_dir: Path,
    staged_files: Sequence[Mapping[str, Any]],
    *,
    dry_run: bool,
) -> dict[str, Any] | None:
    evidence_path = bundle_dir / "evidence" / "release.json"
    if dry_run or not evidence_path.is_file():
        return None
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    if not isinstance(evidence, dict):
        raise ValueError(f"{evidence_path} did not contain a JSON object")

    evidence["repoId"] = ELIZA_1_HF_REPO
    evidence["checksumManifest"] = "checksums/SHA256SUMS"
    hf = evidence.setdefault("hf", {})
    if isinstance(hf, dict):
        hf["repoId"] = ELIZA_1_HF_REPO
        hf.setdefault("pathPrefix", f"bundles/{evidence.get('tier', '')}")

    shipped: set[str] = set()
    for subdir in ("text", "tts", "asr", "vad", "vision", "dflash", "turn"):
        root = bundle_dir / subdir
        if root.is_dir():
            shipped.update(
                p.relative_to(bundle_dir).as_posix()
                for p in root.rglob("*")
                if p.is_file()
            )
    for item in staged_files:
        path_value = item.get("path")
        if isinstance(path_value, str):
            path = Path(path_value)
            if path.is_file():
                rel = bundle_relpath(bundle_dir, path)
                if rel.split("/", 1)[0] in {"tts", "asr", "vad", "turn"}:
                    shipped.add(rel)

    evidence["weights"] = sorted(shipped)
    evidence_path.write_text(
        json.dumps(evidence, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {"path": str(evidence_path), "weights": evidence["weights"]}


def copy_hf_file(
    *,
    repo_id: str,
    revision: str | None,
    remote_path: str,
    destination: Path,
    link_mode: str,
    dry_run: bool,
) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if dry_run:
        return {
            "repo": repo_id,
            "revision": revision,
            "remotePath": remote_path,
            "path": str(destination),
            "dryRun": True,
        }

    cached = Path(
        retry_hf(
            require_hf_hub(require_download=True)[1],
            repo_id=repo_id,
            filename=remote_path,
            revision=revision,
            repo_type="model",
        )
    )
    if link_mode == "hardlink":
        try:
            if destination.exists() or destination.is_symlink():
                if destination.samefile(cached):
                    pass
                else:
                    destination.unlink()
                    os.link(cached, destination)
            else:
                os.link(cached, destination)
        except OSError:
            shutil.copy2(cached, destination)
    else:
        shutil.copy2(cached, destination)
    return {
        "repo": repo_id,
        "revision": revision,
        "remotePath": remote_path,
        "path": str(destination),
        "linkMode": link_mode,
        "sizeBytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
    }


def download_url_file(
    *,
    url: str,
    destination: Path,
    min_bytes: int,
    dry_run: bool,
) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if dry_run:
        return {"url": url, "path": str(destination), "dryRun": True}
    tmp = destination.with_suffix(destination.suffix + ".part")

    def _fetch() -> None:
        with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310
            tmp.write_bytes(resp.read())

    retry_hf(_fetch)
    size = tmp.stat().st_size
    if size < min_bytes:
        tmp.unlink(missing_ok=True)
        raise ValueError(f"downloaded {url} is only {size} bytes (< {min_bytes})")
    tmp.replace(destination)
    return {
        "url": url,
        "path": str(destination),
        "sizeBytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
    }


def choose_gguf_file(
    api: Any,
    *,
    repo_id: str,
    requested: str | None = None,
) -> str:
    files = [
        f
        for f in retry_hf(api.list_repo_files, repo_id, repo_type="model")
        if f.endswith(".gguf")
    ]
    files = [f for f in files if "mmproj" not in f.lower()]
    if requested:
        if requested not in files:
            raise ValueError(f"requested GGUF {requested!r} not found in {repo_id}")
        return requested
    for quant in GGUF_QUANT_PREFERENCE:
        matches = sorted(f for f in files if quant.lower() in f.lower())
        if matches:
            return matches[0]
    if not files:
        raise ValueError(f"no GGUF files found in {repo_id}")
    return sorted(files)[0]


def choose_mmproj_file(
    api: Any,
    *,
    repo_id: str,
    requested: str | None = None,
) -> str:
    files = [
        f
        for f in retry_hf(api.list_repo_files, repo_id, repo_type="model")
        if f.endswith(".gguf") and "mmproj" in f.lower()
    ]
    if requested:
        if requested not in files:
            raise ValueError(
                f"requested ASR mmproj {requested!r} not found in {repo_id}"
            )
        return requested
    for quant in GGUF_QUANT_PREFERENCE:
        matches = sorted(f for f in files if quant.lower() in f.lower())
        if matches:
            return matches[0]
    if not files:
        raise ValueError(f"no ASR mmproj GGUF files found in {repo_id}")
    return sorted(files)[0]


def stage_turn_detector(
    *,
    tier: str,
    license: str,
    bundle_dir: Path,
    link_mode: str,
    dry_run: bool,
) -> dict[str, Any]:
    """Stage the semantic end-of-turn detector ONNX into ``bundle_dir/turn/``.

    Mirrors :func:`stage_kokoro_assets.stage_kokoro_assets` shape — pulls the
    matching upstream artifact, materializes ``turn/model_q8.onnx`` +
    ``turn/tokenizer.json`` (+ optional ``languages.json`` for the multilingual
    variant), and returns a structured report the publish orchestrator can
    fold into manifest/lineage/release-evidence.

    ``license="livekit"`` ships ``livekit/turn-detector`` at the tier-matched
    revision (``v1.2.2-en`` for 0_8b/2b, ``v0.4.1-intl`` elsewhere).
    ``license="apache"`` ships the Apache-2.0 ``latishab/turnsense`` fallback
    (English-only binary classifier; same bundle path so the runtime resolver
    is license-agnostic).
    """
    if license not in TURN_LICENSE_CHOICES:
        raise ValueError(
            f"--turn-license must be one of {TURN_LICENSE_CHOICES}, got {license!r}"
        )
    files: list[dict[str, Any]] = []
    if license == "livekit":
        revision = TURN_DETECTOR_LIVEKIT_REVISION_BY_TIER[tier]
        repo = TURN_DETECTOR_LIVEKIT_REPO
        files.append(
            copy_hf_file(
                repo_id=repo,
                revision=revision,
                remote_path=TURN_DETECTOR_LIVEKIT_ONNX_REMOTE,
                destination=bundle_dir / TURN_DETECTOR_LIVEKIT_ONNX_BUNDLE,
                link_mode=link_mode,
                dry_run=dry_run,
            )
        )
        files.append(
            copy_hf_file(
                repo_id=repo,
                revision=revision,
                remote_path=TURN_DETECTOR_TOKENIZER_REMOTE,
                destination=bundle_dir / TURN_DETECTOR_TOKENIZER_BUNDLE,
                link_mode=link_mode,
                dry_run=dry_run,
            )
        )
        # languages.json is mandatory on the multilingual variant and
        # advisory on the EN-only one; the upstream always ships it.
        files.append(
            copy_hf_file(
                repo_id=repo,
                revision=revision,
                remote_path=TURN_DETECTOR_LANGUAGES_REMOTE,
                destination=bundle_dir / TURN_DETECTOR_LANGUAGES_BUNDLE,
                link_mode=link_mode,
                dry_run=dry_run,
            )
        )
        license_id = (
            "livekit-model-license; see "
            "https://huggingface.co/livekit/turn-detector/blob/main/LICENSE"
        )
    else:
        revision = None
        repo = TURN_DETECTOR_TURNSENSE_REPO
        files.append(
            copy_hf_file(
                repo_id=repo,
                revision=revision,
                remote_path=TURN_DETECTOR_TURNSENSE_ONNX_REMOTE,
                destination=bundle_dir / TURN_DETECTOR_TURNSENSE_ONNX_BUNDLE,
                link_mode=link_mode,
                dry_run=dry_run,
            )
        )
        files.append(
            copy_hf_file(
                repo_id=repo,
                revision=revision,
                remote_path=TURN_DETECTOR_TOKENIZER_REMOTE,
                destination=bundle_dir / TURN_DETECTOR_TOKENIZER_BUNDLE,
                link_mode=link_mode,
                dry_run=dry_run,
            )
        )
        license_id = "apache-2.0"
    return {
        "license": license,
        "licenseId": license_id,
        "repo": repo,
        "revision": revision,
        "files": files,
    }


def write_voice_preset(path: Path, *, dry_run: bool) -> dict[str, Any]:
    """Write a deterministic neutral v1 voice preset cache.

    The real release should replace this with a speaker embedding derived
    from the approved Eliza voice sample plus phrase-cache PCM seeds. This
    neutral cache is still a valid fail-closed runtime artifact: it exercises
    the parser and cache path without inventing audio.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    embedding = [0.0] * 256
    emb = struct.pack("<" + "f" * len(embedding), *embedding)
    phrases = struct.pack("<I", 0)
    emb_off = VOICE_PRESET_HEADER_BYTES
    phr_off = emb_off + len(emb)
    header = struct.pack(
        "<IIIIII",
        VOICE_PRESET_MAGIC,
        VOICE_PRESET_VERSION,
        emb_off,
        len(emb),
        phr_off,
        len(phrases),
    )
    payload = header + emb + phrases
    if not dry_run:
        path.write_bytes(payload)
    return {
        "path": str(path),
        "sizeBytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "embeddingFloats": len(embedding),
        "phraseSeedCount": 0,
        "dryRun": dry_run,
    }


def merge_lineage(
    bundle_dir: Path,
    revisions: dict[str, str],
    *,
    asr_repo: str,
    turn_detector: dict[str, Any] | None = None,
    dry_run: bool,
) -> None:
    path = bundle_dir / "lineage.json"
    data: dict[str, Any] = {}
    if path.is_file():
        data = json.loads(path.read_text())
    data.update(
        {
            "voice": {
                "base": f"{VOICE_REPO}@{revisions[VOICE_REPO]}",
                "license": "apache-2.0",
            },
            "asr": {
                "base": f"{asr_repo}@{revisions[asr_repo]}",
                "license": "apache-2.0; review upstream model card before release",
            },
            "vad": {
                "base": f"{VAD_NATIVE_REPO}@{revisions[VAD_NATIVE_REPO]}",
                "license": "mit",
                "format": "ggml",
                "artifact": "vad/silero-vad-v5.1.2.ggml.bin",
                "onnxFallback": (
                    f"{VAD_ONNX_REPO}@{revisions[VAD_ONNX_REPO]}"
                    if VAD_ONNX_REPO in revisions
                    else None
                ),
            },
            "wakeword": {
                "base": f"{WAKEWORD_RELEASE}",
                "license": (
                    "openWakeWord code + feature models: Apache-2.0; "
                    "pre-trained wake-phrase heads: CC-BY-NC-SA-4.0 "
                    "(acceptable for Eliza-1's non-commercial release; "
                    "retrain the head for any commercial pivot)"
                ),
            },
        }
    )
    if turn_detector is not None:
        repo = turn_detector["repo"]
        revision = turn_detector.get("revision")
        data["turn"] = {
            "base": f"{repo}@{revision}" if revision else repo,
            "license": turn_detector["licenseId"],
            "artifact": TURN_DETECTOR_LIVEKIT_ONNX_BUNDLE,
        }
    if not dry_run:
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def write_license_notes(
    bundle_dir: Path,
    *,
    turn_license: str | None = None,
    dry_run: bool,
) -> None:
    licenses = {
        "LICENSE.voice": (
            "OmniVoice GGUF assets staged from Serveurperso/OmniVoice-GGUF.\n"
            "Declared upstream license: Apache-2.0.\n"
        ),
        "LICENSE.asr": (
            "ASR GGUF assets staged from ggml-org/Qwen3-ASR-0.6B-GGUF "
            "or ggml-org/Qwen3-ASR-1.7B-GGUF.\n"
            "Review upstream Apache-2.0 license and model card before release.\n"
        ),
        "LICENSE.vad": (
            "VAD assets staged from ggml-org/whisper-vad as native GGML "
            "Silero VAD v5.1.2 at vad/silero-vad-v5.1.2.ggml.bin.\n"
            "Optional legacy ONNX fallback may be staged from "
            "onnx-community/silero-vad at vad/silero-vad-int8.onnx.\n"
            "Declared upstream license: MIT.\n"
        ),
        "LICENSE.wakeword": (
            "Wake-word assets staged from "
            "https://github.com/dscripka/openWakeWord (v0.5.1 release).\n"
            "openWakeWord code and the shared feature models "
            "(melspectrogram, embedding): Apache-2.0.\n"
            "Pre-trained wake-phrase heads: CC-BY-NC-SA-4.0 "
            "(GTSinger/RAVDESS/Expresso-style training corpora — acceptable "
            "for the non-commercial Eliza-1 release; retrain the head on a "
            "commercially-licensed corpus for any commercial pivot).\n"
        ),
    }
    if turn_license == "livekit":
        licenses["LICENSE.turn"] = (
            "Turn-detector ONNX staged from livekit/turn-detector (HF revision "
            "v1.2.2-en for 0_8b/2b tiers, v0.4.1-intl elsewhere).\n"
            "Declared upstream license: LiveKit Model License "
            "(https://huggingface.co/livekit/turn-detector/blob/main/LICENSE).\n"
            "Use --turn-license=apache to ship latishab/turnsense (Apache-2.0).\n"
        )
    elif turn_license == "apache":
        licenses["LICENSE.turn"] = (
            "Turn-detector ONNX staged from latishab/turnsense.\n"
            "Declared upstream license: Apache-2.0.\n"
            "English-only binary classifier head over SmolLM2-135M; lower "
            "accuracy on backchannels than the LiveKit detectors but free of "
            "the LiveKit Model License redistribution restrictions.\n"
        )
    if dry_run:
        return
    license_dir = bundle_dir / "licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    for name, text in licenses.items():
        target = license_dir / name
        if not target.exists():
            target.write_text(text)


def resolve_revisions(api: Any, repos: tuple[str, ...]) -> dict[str, str]:
    out: dict[str, str] = {}
    for repo in repos:
        info = retry_hf(api.model_info, repo)
        out[repo] = str(info.sha)
    return out


def stage_assets(args: argparse.Namespace) -> dict[str, Any]:
    tier = args.tier
    quant = VOICE_QUANT_BY_TIER[tier]
    bundle_dir = args.bundle_dir.resolve()
    asr_repo = args.asr_repo or ASR_REPO_BY_TIER[tier]
    HfApi, _ = require_hf_hub()
    api = HfApi()
    revision_repos = [VOICE_REPO, asr_repo, VAD_NATIVE_REPO]
    if args.include_vad_onnx_fallback:
        revision_repos.append(VAD_ONNX_REPO)
    revisions = resolve_revisions(api, tuple(revision_repos))
    asr_remote_path = choose_gguf_file(api, repo_id=asr_repo, requested=args.asr_file)
    asr_mmproj_remote_path = choose_mmproj_file(
        api,
        repo_id=asr_repo,
        requested=args.asr_mmproj_file,
    )

    staged: list[dict[str, Any]] = []
    # Default: stage the runtime's preferred quant (VOICE_QUANT_BY_TIER).
    # Opt-in: --include-voice-ladder stages the full K-quant ladder
    # (VOICE_QUANT_LADDER_BY_TIER) so a downloader can pick a smaller level
    # at install time based on the host's RAM/SoC class. The ladder is the
    # publishable subset of omnivoice.cpp's full Q2_K..Q8_0 support; see
    # packages/shared/src/local-inference/catalog.ts:voiceQuantLadderForTier
    # and docs/inference/voice-quant-matrix.md.
    voice_quants: tuple[str, ...]
    if getattr(args, "include_voice_ladder", False):
        ladder = VOICE_QUANT_LADDER_BY_TIER.get(tier, ())
        voice_quants = tuple(ladder) if ladder else ()
    else:
        voice_quants = (quant,)
    voice_pairs: tuple[tuple[str, str], ...] = tuple(
        pair
        for q in voice_quants
        for pair in (
            (f"omnivoice-base-{q}.gguf", f"tts/omnivoice-base-{q}.gguf"),
            (f"omnivoice-tokenizer-{q}.gguf", f"tts/omnivoice-tokenizer-{q}.gguf"),
        )
    )
    for remote, rel in voice_pairs:
        staged.append(
            copy_hf_file(
                repo_id=VOICE_REPO,
                revision=revisions[VOICE_REPO],
                remote_path=remote,
                destination=bundle_dir / rel,
                link_mode=args.link_mode,
                dry_run=args.dry_run,
            )
        )
    staged.append(
        copy_hf_file(
            repo_id=asr_repo,
            revision=revisions[asr_repo],
            remote_path=asr_remote_path,
            destination=bundle_dir / "asr" / "eliza-1-asr.gguf",
            link_mode=args.link_mode,
            dry_run=args.dry_run,
        )
    )
    staged.append(
        copy_hf_file(
            repo_id=asr_repo,
            revision=revisions[asr_repo],
            remote_path=asr_mmproj_remote_path,
            destination=bundle_dir / "asr" / "eliza-1-asr-mmproj.gguf",
            link_mode=args.link_mode,
            dry_run=args.dry_run,
        )
    )
    for remote, rel in VAD_NATIVE_FILES:
        staged.append(
            copy_hf_file(
                repo_id=VAD_NATIVE_REPO,
                revision=revisions[VAD_NATIVE_REPO],
                remote_path=remote,
                destination=bundle_dir / rel,
                link_mode=args.link_mode,
                dry_run=args.dry_run,
            )
        )
    if args.include_vad_onnx_fallback:
        for remote, rel in VAD_ONNX_FALLBACK_FILES:
            staged.append(
                copy_hf_file(
                    repo_id=VAD_ONNX_REPO,
                    revision=revisions[VAD_ONNX_REPO],
                    remote_path=remote,
                    destination=bundle_dir / rel,
                    link_mode=args.link_mode,
                    dry_run=args.dry_run,
                )
            )
    if not args.skip_wakeword:
        for remote, rel in WAKEWORD_FRONT_END_FILES:
            staged.append(
                download_url_file(
                    url=f"{WAKEWORD_RELEASE}/{remote}",
                    destination=bundle_dir / rel,
                    min_bytes=WAKEWORD_MIN_BYTES,
                    dry_run=args.dry_run,
                )
            )
        head_dest = bundle_dir / WAKEWORD_HEAD_DESTINATION
        head_src = getattr(args, "wakeword_head_path", None)
        if head_src:
            head_src_path = Path(head_src)
            if not head_src_path.is_file():
                raise SystemExit(
                    f"--wakeword-head-path {head_src!r} does not exist; "
                    "train one via packages/training/scripts/wakeword/"
                    "train_eliza1_wakeword_head.py first"
                )
            if head_src_path.stat().st_size < WAKEWORD_MIN_BYTES:
                raise SystemExit(
                    f"--wakeword-head-path {head_src!r} is only "
                    f"{head_src_path.stat().st_size} bytes (< {WAKEWORD_MIN_BYTES}); "
                    "looks truncated or wrong file"
                )
            if not args.dry_run:
                head_dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(head_src_path, head_dest)
            staged.append(
                {
                    "source": str(head_src_path),
                    "path": str(head_dest),
                    "sizeBytes": (
                        head_dest.stat().st_size
                        if head_dest.is_file()
                        else head_src_path.stat().st_size
                    ),
                    "sha256": (
                        sha256_file(head_dest)
                        if head_dest.is_file()
                        else sha256_file(head_src_path)
                    ),
                    "wakePhrase": "hey eliza",
                    "trainedHead": True,
                }
            )
        else:
            # Fall back to the openWakeWord placeholder; the runtime keeps
            # this listed in OPENWAKEWORD_PLACEHOLDER_HEADS so the engine
            # warns on activation.
            staged.append(
                download_url_file(
                    url=f"{WAKEWORD_RELEASE}/{WAKEWORD_HEAD_PLACEHOLDER_REMOTE}",
                    destination=head_dest,
                    min_bytes=WAKEWORD_MIN_BYTES,
                    dry_run=args.dry_run,
                )
            )
    # Voice Wave 2 (2026-05-14): semantic turn detector staging. Per-tier
    # revision routing matches the runtime resolver in
    # plugins/plugin-local-inference/src/services/voice/eot-classifier.ts
    # (`turnDetectorRevisionForTier`). Apache-2.0 fallback via
    # `--turn-license=apache` ships `latishab/turnsense` at the same on-disk
    # path so downstream resolution stays license-agnostic.
    turn_detector_report: dict[str, Any] | None = None
    if not args.skip_turn_detector:
        turn_detector_report = stage_turn_detector(
            tier=tier,
            license=args.turn_license,
            bundle_dir=bundle_dir,
            link_mode=args.link_mode,
            dry_run=args.dry_run,
        )
        staged.extend(turn_detector_report["files"])

    preset = write_voice_preset(
        bundle_dir / "cache" / "voice-preset-default.bin",
        dry_run=args.dry_run,
    )
    merge_lineage(
        bundle_dir,
        revisions,
        asr_repo=asr_repo,
        turn_detector=turn_detector_report,
        dry_run=args.dry_run,
    )
    write_license_notes(
        bundle_dir,
        turn_license=None if args.skip_turn_detector else args.turn_license,
        dry_run=args.dry_run,
    )
    manifest_update = merge_manifest_asset_entries(
        bundle_dir,
        staged,
        voice_preset=preset,
        dry_run=args.dry_run,
    )
    release_evidence_update = merge_release_evidence_assets(
        bundle_dir,
        staged,
        dry_run=args.dry_run,
    )
    checksum_manifest = regenerate_checksums(bundle_dir, dry_run=args.dry_run)

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tier": tier,
        "bundleDir": str(bundle_dir),
        "voiceQuant": quant,
        "asrRepo": asr_repo,
        "asrRemotePath": asr_remote_path,
        "asrMmprojRemotePath": asr_mmproj_remote_path,
        "turnDetector": (
            None
            if turn_detector_report is None
            else {
                "license": turn_detector_report["license"],
                "licenseId": turn_detector_report["licenseId"],
                "repo": turn_detector_report["repo"],
                "revision": turn_detector_report["revision"],
                "bundlePath": (
                    TURN_DETECTOR_LIVEKIT_ONNX_BUNDLE
                    if turn_detector_report["license"] == "livekit"
                    else TURN_DETECTOR_TURNSENSE_ONNX_BUNDLE
                ),
            }
        ),
        "vad": {
            "nativeRepo": VAD_NATIVE_REPO,
            "nativeRemotePath": VAD_NATIVE_FILES[0][0],
            "nativeBundlePath": VAD_NATIVE_FILES[0][1],
            "format": "ggml",
            "onnxFallbackIncluded": bool(args.include_vad_onnx_fallback),
            "onnxFallbackRepo": (
                VAD_ONNX_REPO if args.include_vad_onnx_fallback else None
            ),
            "onnxFallbackBundlePath": (
                VAD_ONNX_FALLBACK_FILES[0][1]
                if args.include_vad_onnx_fallback
                else None
            ),
        },
        "sources": {
            repo: {"revision": rev}
            for repo, rev in revisions.items()
        },
        "files": staged,
        "voicePreset": preset,
        "manifestUpdate": manifest_update,
        "releaseEvidenceUpdate": release_evidence_update,
        "checksumManifest": checksum_manifest,
        "dryRun": args.dry_run,
    }
    if not args.dry_run:
        evidence = bundle_dir / "evidence" / "bundle-assets.json"
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def upload_assets(args: argparse.Namespace) -> None:
    if not args.upload_repo or args.dry_run:
        return
    HfApi, _ = require_hf_hub()
    api = HfApi()
    api.create_repo(
        repo_id=args.upload_repo,
        repo_type="model",
        private=not args.public,
        exist_ok=True,
    )
    api.upload_folder(
        repo_id=args.upload_repo,
        repo_type="model",
        folder_path=str(args.bundle_dir.resolve()),
        path_in_repo=args.upload_prefix.strip("/"),
        commit_message=f"Stage Eliza-1 {args.tier} voice/ASR/VAD/wake assets",
        allow_patterns=[
            "tts/**",
            "asr/**",
            "vad/**",
            "wake/**",
            "turn/**",
            "cache/voice-preset-default.bin",
            "evidence/bundle-assets.json",
            "lineage.json",
            "licenses/LICENSE.voice",
            "licenses/LICENSE.asr",
            "licenses/LICENSE.vad",
            "licenses/LICENSE.wakeword",
            "licenses/LICENSE.turn",
        ],
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=tuple(VOICE_QUANT_BY_TIER))
    ap.add_argument("--bundle-dir", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--link-mode",
        choices=("copy", "hardlink"),
        default="copy",
        help=(
            "How to materialize Hub cache files in the bundle. `hardlink` "
            "deduplicates repeated tier assets on the same filesystem and "
            "falls back to copy if linking is unavailable."
        ),
    )
    ap.add_argument(
        "--asr-repo",
        default=None,
        help="Override ASR GGUF model repo. Defaults by tier.",
    )
    ap.add_argument(
        "--asr-file",
        default=None,
        help=(
            "Exact ASR GGUF file path inside --asr-repo. Defaults to a "
            "preferred quant."
        ),
    )
    ap.add_argument(
        "--asr-mmproj-file",
        default=None,
        help="Exact ASR mmproj GGUF file path inside --asr-repo.",
    )
    ap.add_argument(
        "--skip-wakeword",
        action="store_true",
        help=(
            "Skip staging the optional openWakeWord graphs. Wake word is "
            "opt-in (hide-not-disable); a bundle without it still has a "
            "working voice pipeline (push-to-talk / VAD-gated)."
        ),
    )
    ap.add_argument(
        "--wakeword-head-path",
        default=None,
        help=(
            "Path to a locally-trained wake-word head ONNX (output of "
            "packages/training/scripts/wakeword/train_eliza1_wakeword_head.py). "
            "When supplied, this head is staged as wake/hey-eliza.onnx in "
            "every bundle instead of the upstream `hey_jarvis` placeholder. "
            "Omitting the flag preserves the legacy placeholder behavior "
            "(runtime warns via OPENWAKEWORD_PLACEHOLDER_HEADS)."
        ),
    )
    ap.add_argument(
        "--skip-turn-detector",
        action="store_true",
        help=(
            "Skip staging the semantic end-of-turn detector. Without it the "
            "runtime falls back to HeuristicEotClassifier (deterministic "
            "punctuation/conjunction baseline)."
        ),
    )
    ap.add_argument(
        "--turn-license",
        choices=TURN_LICENSE_CHOICES,
        default="livekit",
        help=(
            "Which turn-detector to bundle. `livekit` (default) ships "
            "livekit/turn-detector at the tier-matched revision (LiveKit "
            "Model License). `apache` ships latishab/turnsense (Apache-2.0, "
            "English-only binary classifier)."
        ),
    )
    ap.add_argument(
        "--include-vad-onnx-fallback",
        action="store_true",
        help=(
            "Also stage the legacy Silero ONNX fallback at "
            "vad/silero-vad-int8.onnx. Native GGML VAD is always staged."
        ),
    )
    ap.add_argument(
        "--include-voice-ladder",
        action="store_true",
        help=(
            "Stage every OmniVoice K-quant level declared in "
            "VOICE_QUANT_LADDER_BY_TIER (Q3_K_M, Q4_K_M, Q5_K_M, Q6_K, Q8_0 "
            "for 9b+ tiers; nothing for Kokoro-only tiers) under "
            "tts/omnivoice-base-<level>.gguf and tts/omnivoice-tokenizer-"
            "<level>.gguf. Without this flag only the runtime's preferred "
            "quant (VOICE_QUANT_BY_TIER) is staged. The downloader picks "
            "the appropriate level at install time based on host RAM/SoC "
            "class; AGENTS.md §3 forbids silent fallback so the ladder must "
            "be a published-as-shipped subset, not a runtime guess."
        ),
    )
    ap.add_argument(
        "--upload-repo",
        default=None,
        help="Optional HF repo id to upload the staged asset subset to.",
    )
    ap.add_argument(
        "--upload-prefix",
        default="",
        help="Optional path prefix inside --upload-repo.",
    )
    ap.add_argument("--public", action="store_true")
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    report = stage_assets(args)
    upload_assets(args)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
