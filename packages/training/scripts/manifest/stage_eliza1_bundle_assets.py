#!/usr/bin/env python3
"""Stage real voice / ASR / VAD assets into an Eliza-1 bundle directory.

This is the bridge between the manifest-first runtime bundle layout and
the current upstream asset locations on Hugging Face. It intentionally does
not fabricate text or DFlash weights; it stages the non-text assets that are
already externally available and writes evidence/provenance sidecars so the
publish orchestrator can hash and validate the final bundle.

Default sources:
  - TTS: Serveurperso/OmniVoice-GGUF, Apache-2.0 GGUF artifacts.
  - ASR: ggml-org/Qwen3-ASR-*-GGUF, GGUF artifacts.
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
from typing import Any, Final

try:  # pragma: no cover - import availability is environment-dependent
    from huggingface_hub import HfApi, hf_hub_download
except ModuleNotFoundError:  # pragma: no cover - env-only path
    HfApi = None  # type: ignore[assignment]
    hf_hub_download = None  # type: ignore[assignment]

try:
    from .eliza1_manifest import VOICE_QUANT_BY_TIER
except ImportError:  # pragma: no cover - script execution path
    from eliza1_manifest import VOICE_QUANT_BY_TIER

VOICE_REPO: Final[str] = "Serveurperso/OmniVoice-GGUF"
VAD_NATIVE_REPO: Final[str] = "ggml-org/whisper-vad"
VAD_ONNX_REPO: Final[str] = "onnx-community/silero-vad"
ASR_REPO_BY_TIER: Final[dict[str, str]] = {
    "0_8b": "ggml-org/Qwen3-ASR-0.8B-GGUF",
    "2b": "ggml-org/Qwen3-ASR-0.8B-GGUF",
    "4b": "ggml-org/Qwen3-ASR-0.8B-GGUF",
    "9b": "ggml-org/Qwen3-ASR-0.8B-GGUF",
    "27b": "ggml-org/Qwen3-ASR-2B-GGUF",
    "27b-256k": "ggml-org/Qwen3-ASR-2B-GGUF",
    "27b-1m": "ggml-org/Qwen3-ASR-2B-GGUF",
}
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

# openWakeWord ships its ONNX graphs as GitHub release assets, not on the
# Hub. The melspectrogram + embedding front-ends are model-agnostic; the
# wake-word head is the wake phrase. We stage the upstream "hey jarvis"
# head as the Eliza-1 default ("hey-eliza.onnx") — replace it with a head
# trained on the approved wake phrase before a real release.
WAKEWORD_RELEASE: Final[str] = (
    "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
)
WAKEWORD_FILES: Final[tuple[tuple[str, str], ...]] = (
    ("melspectrogram.onnx", "wake/melspectrogram.onnx"),
    ("embedding_model.onnx", "wake/embedding_model.onnx"),
    ("hey_jarvis_v0.1.onnx", "wake/hey-eliza.onnx"),
)
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
    if not dry_run:
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def write_license_notes(bundle_dir: Path, *, dry_run: bool) -> None:
    licenses = {
        "LICENSE.voice": (
            "OmniVoice GGUF assets staged from Serveurperso/OmniVoice-GGUF.\n"
            "Declared upstream license: Apache-2.0.\n"
        ),
        "LICENSE.asr": (
            "ASR GGUF assets staged from ggml-org/Qwen3-ASR-*-GGUF.\n"
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
        for remote, rel in WAKEWORD_FILES:
            staged.append(
                download_url_file(
                    url=f"{WAKEWORD_RELEASE}/{remote}",
                    destination=bundle_dir / rel,
                    min_bytes=WAKEWORD_MIN_BYTES,
                    dry_run=args.dry_run,
                )
            )

    preset = write_voice_preset(
        bundle_dir / "cache" / "voice-preset-default.bin",
        dry_run=args.dry_run,
    )
    merge_lineage(bundle_dir, revisions, asr_repo=asr_repo, dry_run=args.dry_run)
    write_license_notes(bundle_dir, dry_run=args.dry_run)

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tier": tier,
        "bundleDir": str(bundle_dir),
        "voiceQuant": quant,
        "asrRepo": asr_repo,
        "asrRemotePath": asr_remote_path,
        "asrMmprojRemotePath": asr_mmproj_remote_path,
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
            "cache/voice-preset-default.bin",
            "evidence/bundle-assets.json",
            "lineage.json",
            "licenses/LICENSE.voice",
            "licenses/LICENSE.asr",
            "licenses/LICENSE.vad",
            "licenses/LICENSE.wakeword",
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
        "--include-vad-onnx-fallback",
        action="store_true",
        help=(
            "Also stage the legacy Silero ONNX fallback at "
            "vad/silero-vad-int8.onnx. Native GGML VAD is always staged."
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
