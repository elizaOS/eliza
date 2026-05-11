#!/usr/bin/env python3
"""Stage real voice / ASR / VAD assets into an Eliza-1 bundle directory.

This is the bridge between the manifest-first runtime bundle layout and
the current upstream asset locations on Hugging Face. It intentionally does
not fabricate text or DFlash weights; it stages the non-text assets that are
already externally available and writes evidence/provenance sidecars so the
publish orchestrator can hash and validate the final bundle.

Default sources:
  - TTS: Serveurperso/OmniVoice-GGUF, Apache-2.0 GGUF artifacts.
  - ASR: onnx-community/whisper-tiny.en, int8 ONNX encoder/decoder.
  - VAD: onnx-community/silero-vad, int8 ONNX model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final

from huggingface_hub import HfApi, hf_hub_download

TIER_VOICE_QUANT: Final[dict[str, str]] = {
    "0_6b": "Q4_K_M",
    "1_7b": "Q4_K_M",
    "9b": "Q8_0",
    "27b": "Q8_0",
    "27b-256k": "Q8_0",
}

VOICE_REPO: Final[str] = "Serveurperso/OmniVoice-GGUF"
ASR_REPO: Final[str] = "onnx-community/whisper-tiny.en"
VAD_REPO: Final[str] = "onnx-community/silero-vad"

ASR_FILES: Final[tuple[tuple[str, str], ...]] = (
    ("onnx/encoder_model_int8.onnx", "asr/whisper-tiny-en-encoder-int8.onnx"),
    (
        "onnx/decoder_model_merged_int8.onnx",
        "asr/whisper-tiny-en-decoder-merged-int8.onnx",
    ),
    ("tokenizer.json", "asr/whisper-tiny-en-tokenizer.json"),
    ("preprocessor_config.json", "asr/whisper-tiny-en-preprocessor_config.json"),
    ("config.json", "asr/whisper-tiny-en-config.json"),
    ("generation_config.json", "asr/whisper-tiny-en-generation_config.json"),
)

VAD_FILES: Final[tuple[tuple[str, str], ...]] = (
    ("onnx/model_int8.onnx", "vad/silero-vad-int8.onnx"),
)

VOICE_PRESET_MAGIC: Final[int] = 0x315A4C45  # 'ELZ1'
VOICE_PRESET_VERSION: Final[int] = 1
VOICE_PRESET_HEADER_BYTES: Final[int] = 24


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def copy_hf_file(
    *,
    repo_id: str,
    revision: str | None,
    remote_path: str,
    destination: Path,
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
        hf_hub_download(
            repo_id=repo_id,
            filename=remote_path,
            revision=revision,
            repo_type="model",
        )
    )
    shutil.copy2(cached, destination)
    return {
        "repo": repo_id,
        "revision": revision,
        "remotePath": remote_path,
        "path": str(destination),
        "sizeBytes": destination.stat().st_size,
        "sha256": sha256_file(destination),
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


def merge_lineage(bundle_dir: Path, revisions: dict[str, str], *, dry_run: bool) -> None:
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
                "base": f"{ASR_REPO}@{revisions[ASR_REPO]}",
                "license": "openai/whisper license; see upstream model card",
            },
            "vad": {
                "base": f"{VAD_REPO}@{revisions[VAD_REPO]}",
                "license": "mit",
            },
        }
    )
    if not dry_run:
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def write_license_notes(bundle_dir: Path, *, dry_run: bool) -> None:
    licenses = {
        "LICENSE.voice": (
            "OmniVoice GGUF assets staged from Serveurperso/OmniVoice-GGUF.\n"
            "Declared upstream license: Apache-2.0.\n"
        ),
        "LICENSE.asr": (
            "ASR assets staged from onnx-community/whisper-tiny.en.\n"
            "Review upstream OpenAI Whisper license/model card before release.\n"
        ),
        "LICENSE.vad": (
            "VAD assets staged from onnx-community/silero-vad.\n"
            "Declared upstream license: MIT.\n"
        ),
    }
    if dry_run:
        return
    license_dir = bundle_dir / "licenses"
    license_dir.mkdir(parents=True, exist_ok=True)
    for name, text in licenses.items():
        target = license_dir / name
        if not target.exists():
            target.write_text(text)


def resolve_revisions(api: HfApi, repos: tuple[str, ...]) -> dict[str, str]:
    out: dict[str, str] = {}
    for repo in repos:
        info = api.model_info(repo)
        out[repo] = str(info.sha)
    return out


def stage_assets(args: argparse.Namespace) -> dict[str, Any]:
    tier = args.tier
    quant = TIER_VOICE_QUANT[tier]
    bundle_dir = args.bundle_dir.resolve()
    api = HfApi()
    revisions = resolve_revisions(api, (VOICE_REPO, ASR_REPO, VAD_REPO))

    staged: list[dict[str, Any]] = []
    voice_pairs = (
        (f"omnivoice-base-{quant}.gguf", f"tts/omnivoice-base-{quant}.gguf"),
        (
            f"omnivoice-tokenizer-{quant}.gguf",
            f"tts/omnivoice-tokenizer-{quant}.gguf",
        ),
    )
    for remote, rel in voice_pairs:
        staged.append(
            copy_hf_file(
                repo_id=VOICE_REPO,
                revision=revisions[VOICE_REPO],
                remote_path=remote,
                destination=bundle_dir / rel,
                dry_run=args.dry_run,
            )
        )
    for remote, rel in ASR_FILES:
        staged.append(
            copy_hf_file(
                repo_id=ASR_REPO,
                revision=revisions[ASR_REPO],
                remote_path=remote,
                destination=bundle_dir / rel,
                dry_run=args.dry_run,
            )
        )
    for remote, rel in VAD_FILES:
        staged.append(
            copy_hf_file(
                repo_id=VAD_REPO,
                revision=revisions[VAD_REPO],
                remote_path=remote,
                destination=bundle_dir / rel,
                dry_run=args.dry_run,
            )
        )

    preset = write_voice_preset(
        bundle_dir / "cache" / "voice-preset-default.bin",
        dry_run=args.dry_run,
    )
    merge_lineage(bundle_dir, revisions, dry_run=args.dry_run)
    write_license_notes(bundle_dir, dry_run=args.dry_run)

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tier": tier,
        "bundleDir": str(bundle_dir),
        "voiceQuant": quant,
        "sources": {
            repo: {"revision": rev}
            for repo, rev in revisions.items()
        },
        "files": staged,
        "voicePreset": preset,
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
        commit_message=f"Stage Eliza-1 {args.tier} voice/ASR/VAD assets",
        allow_patterns=[
            "tts/**",
            "asr/**",
            "vad/**",
            "cache/voice-preset-default.bin",
            "evidence/bundle-assets.json",
            "lineage.json",
            "licenses/LICENSE.voice",
            "licenses/LICENSE.asr",
            "licenses/LICENSE.vad",
        ],
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tier", required=True, choices=tuple(TIER_VOICE_QUANT))
    ap.add_argument("--bundle-dir", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true")
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
