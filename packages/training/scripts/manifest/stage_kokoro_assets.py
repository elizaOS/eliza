#!/usr/bin/env python3
"""Stage Kokoro ONNX assets into existing Eliza-1 bundles.

This is intentionally separate from the OmniVoice/ASR/VAD staging helper:
small Eliza-1 tiers can add Kokoro to already-built raw/base bundles without
re-running text quantization or DFlash staging. The script downloads the
canonical Kokoro ONNX export and bundled voice packs, adds them to
``files.voice`` in ``eliza-1.manifest.json``, writes provenance evidence, and
regenerates ``checksums/SHA256SUMS``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Iterable, Sequence

try:  # pragma: no cover - import availability is environment-dependent
    from huggingface_hub import HfApi, hf_hub_download
except ModuleNotFoundError:  # pragma: no cover - env-only path
    HfApi = None  # type: ignore[assignment]
    hf_hub_download = None  # type: ignore[assignment]

try:
    from .eliza1_manifest import validate_manifest
except ImportError:  # pragma: no cover - direct script execution path
    from eliza1_manifest import validate_manifest

KOKORO_REPO: Final[str] = "onnx-community/Kokoro-82M-v1.0-ONNX"
DEFAULT_BUNDLES_ROOT: Final[Path] = Path.home() / ".eliza" / "local-inference" / "models"
KOKORO_RELEASE_ROOT: Final[str] = "tts/kokoro"
KOKORO_MODEL_REMOTE: Final[str] = "onnx/model_q4.onnx"
KOKORO_TOKENIZER_REMOTE: Final[str] = "tokenizer.json"
KOKORO_MODEL_BUNDLE_PATH: Final[str] = f"{KOKORO_RELEASE_ROOT}/model_q4.onnx"
KOKORO_TOKENIZER_BUNDLE_PATH: Final[str] = f"{KOKORO_RELEASE_ROOT}/tokenizer.json"
DEFAULT_VOICES: Final[tuple[str, ...]] = (
    "af_bella",
    "af_sarah",
    "af_nicole",
    "af_sky",
    "am_michael",
    "am_adam",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
)
KOKORO_LICENSE_TEXT: Final[str] = (
    "Kokoro-82M ONNX assets staged from onnx-community/Kokoro-82M-v1.0-ONNX.\n"
    "Declared upstream license: Apache-2.0.\n"
)


@dataclass(frozen=True)
class StagedKokoroFile:
    role: str
    repo: str
    revision: str | None
    remote_path: str
    bundle_path: str
    size_bytes: int | None
    sha256: str | None
    dry_run: bool


def _require_hf() -> tuple[Any, Any]:
    global HfApi, hf_hub_download
    if HfApi is None or hf_hub_download is None:
        try:
            from huggingface_hub import HfApi as ImportedHfApi
            from huggingface_hub import hf_hub_download as ImportedDownload
        except ModuleNotFoundError as exc:  # pragma: no cover - env-only path
            raise SystemExit(
                "huggingface_hub is required for Kokoro staging; install the "
                "training environment first"
            ) from exc
        HfApi = ImportedHfApi
        hf_hub_download = ImportedDownload
    return HfApi, hf_hub_download


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _copy_or_link(source: Path, destination: Path, *, link_mode: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() or destination.is_symlink():
        destination.unlink()
    if link_mode == "hardlink":
        try:
            os.link(source, destination)
            return
        except OSError:
            pass
    shutil.copy2(source, destination)


def _bundle_dir_for_tier(root: Path, tier: str) -> Path:
    return root / f"eliza-1-{tier}.bundle"


def _safe_bundle_path(bundle_dir: Path, rel: str) -> Path:
    if not rel or Path(rel).is_absolute():
        raise ValueError(f"invalid bundle-relative path: {rel!r}")
    root = bundle_dir.resolve()
    target = (root / rel).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"bundle path escapes root: {rel!r}")
    return target


def _manifest_path(bundle_dir: Path) -> Path:
    return bundle_dir / "eliza-1.manifest.json"


def _load_manifest(bundle_dir: Path) -> dict[str, Any]:
    path = _manifest_path(bundle_dir)
    if not path.is_file():
        raise FileNotFoundError(f"missing manifest: {path}")
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} did not contain a JSON object")
    return data


def _write_manifest(bundle_dir: Path, manifest: dict[str, Any]) -> None:
    errors = validate_manifest(manifest, require_publish_ready=False)
    if errors:
        raise ValueError("manifest validation failed after Kokoro staging: " + "; ".join(errors))
    _manifest_path(bundle_dir).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def _voice_remote_paths(voices: Sequence[str]) -> list[tuple[str, str, str]]:
    out = [
        ("kokoro-onnx", KOKORO_MODEL_REMOTE, KOKORO_MODEL_BUNDLE_PATH),
        ("kokoro-tokenizer", KOKORO_TOKENIZER_REMOTE, KOKORO_TOKENIZER_BUNDLE_PATH),
    ]
    for voice in voices:
        out.append(
            (
                "kokoro-voice",
                f"voices/{voice}.bin",
                f"{KOKORO_RELEASE_ROOT}/voices/{voice}.bin",
            )
        )
    return out


def _repo_revision(repo_id: str, *, dry_run: bool) -> str | None:
    if dry_run:
        return None
    HfApiImpl, _ = _require_hf()
    info = HfApiImpl().model_info(repo_id)
    return str(getattr(info, "sha", "") or "")


def _stage_one(
    *,
    bundle_dir: Path,
    repo_id: str,
    revision: str | None,
    role: str,
    remote_path: str,
    bundle_path: str,
    link_mode: str,
    dry_run: bool,
) -> StagedKokoroFile:
    if dry_run:
        return StagedKokoroFile(
            role=role,
            repo=repo_id,
            revision=revision,
            remote_path=remote_path,
            bundle_path=bundle_path,
            size_bytes=None,
            sha256=None,
            dry_run=True,
        )

    _, download = _require_hf()
    cached = Path(
        download(
            repo_id=repo_id,
            filename=remote_path,
            revision=revision,
            repo_type="model",
        )
    )
    destination = _safe_bundle_path(bundle_dir, bundle_path)
    _copy_or_link(cached, destination, link_mode=link_mode)
    return StagedKokoroFile(
        role=role,
        repo=repo_id,
        revision=revision,
        remote_path=remote_path,
        bundle_path=bundle_path,
        size_bytes=destination.stat().st_size,
        sha256=_sha256_file(destination),
        dry_run=False,
    )


def _merge_manifest_voice_entries(
    bundle_dir: Path,
    manifest: dict[str, Any],
    staged: Sequence[StagedKokoroFile],
    *,
    repo_id: str,
    revision: str | None,
) -> None:
    files = manifest.setdefault("files", {})
    if not isinstance(files, dict):
        raise ValueError("manifest.files must be an object")
    voice = files.setdefault("voice", [])
    if not isinstance(voice, list):
        raise ValueError("manifest.files.voice must be a list")
    keep = [
        entry
        for entry in voice
        if not (
            isinstance(entry, dict)
            and isinstance(entry.get("path"), str)
            and entry["path"].startswith(f"{KOKORO_RELEASE_ROOT}/")
        )
    ]
    for item in staged:
        if item.dry_run:
            continue
        target = _safe_bundle_path(bundle_dir, item.bundle_path)
        keep.append({"path": item.bundle_path, "sha256": _sha256_file(target)})
    files["voice"] = keep

    lineage = manifest.setdefault("lineage", {})
    if isinstance(lineage, dict):
        voice_lineage = lineage.setdefault("voice", {"base": "", "license": "apache-2.0"})
        if isinstance(voice_lineage, dict):
            marker = f"{repo_id}@{revision or 'main'}"
            base = str(voice_lineage.get("base") or "")
            if marker not in base:
                voice_lineage["base"] = f"{base}; {marker}" if base else marker
            voice_lineage.setdefault("license", "apache-2.0")


def _merge_lineage_json(bundle_dir: Path, *, repo_id: str, revision: str | None) -> None:
    lineage_path = bundle_dir / "lineage.json"
    data: dict[str, Any] = {}
    if lineage_path.is_file():
        data = json.loads(lineage_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    data["kokoro"] = {
        "base": f"{repo_id}@{revision or 'main'}",
        "license": "apache-2.0",
        "bundleRoot": KOKORO_RELEASE_ROOT,
    }
    lineage_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_license(bundle_dir: Path) -> None:
    target = bundle_dir / "licenses" / "LICENSE.kokoro"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(KOKORO_LICENSE_TEXT, encoding="utf-8")


def regenerate_checksums(bundle_dir: Path) -> Path:
    sums = bundle_dir / "checksums" / "SHA256SUMS"
    sums.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(bundle_dir).as_posix()
        if rel == "checksums/SHA256SUMS":
            continue
        lines.append(f"{_sha256_file(path)}  {rel}")
    sums.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return sums


def stage_kokoro_bundle(
    bundle_dir: Path,
    *,
    repo_id: str = KOKORO_REPO,
    voices: Sequence[str] = DEFAULT_VOICES,
    link_mode: str = "copy",
    dry_run: bool = False,
) -> dict[str, Any]:
    bundle_dir = bundle_dir.resolve()
    if not bundle_dir.is_dir():
        raise FileNotFoundError(f"missing bundle directory: {bundle_dir}")
    if not dry_run:
        _load_manifest(bundle_dir)
    revision = _repo_revision(repo_id, dry_run=dry_run)
    staged = [
        _stage_one(
            bundle_dir=bundle_dir,
            repo_id=repo_id,
            revision=revision,
            role=role,
            remote_path=remote,
            bundle_path=rel,
            link_mode=link_mode,
            dry_run=dry_run,
        )
        for role, remote, rel in _voice_remote_paths(voices)
    ]
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bundleDir": str(bundle_dir),
        "repo": repo_id,
        "revision": revision,
        "voices": list(voices),
        "files": [asdict(item) for item in staged],
        "dryRun": dry_run,
    }
    if dry_run:
        return report

    manifest = _load_manifest(bundle_dir)
    _merge_manifest_voice_entries(
        bundle_dir,
        manifest,
        staged,
        repo_id=repo_id,
        revision=revision,
    )
    _write_manifest(bundle_dir, manifest)
    _merge_lineage_json(bundle_dir, repo_id=repo_id, revision=revision)
    _write_license(bundle_dir)
    checksum_path = regenerate_checksums(bundle_dir)
    report["checksumManifest"] = checksum_path.relative_to(bundle_dir).as_posix()
    evidence = bundle_dir / "evidence" / "kokoro-assets.json"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    regenerate_checksums(bundle_dir)
    return report


def _parse_voices(values: Iterable[str] | None) -> tuple[str, ...]:
    if not values:
        return DEFAULT_VOICES
    out: list[str] = []
    for value in values:
        for part in value.split(","):
            voice = part.strip()
            if voice:
                out.append(voice)
    return tuple(dict.fromkeys(out))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bundles-root", type=Path, default=DEFAULT_BUNDLES_ROOT)
    ap.add_argument("--bundle-dir", type=Path, action="append", dest="bundle_dirs")
    ap.add_argument("--tier", action="append", dest="tiers")
    ap.add_argument("--repo-id", default=KOKORO_REPO)
    ap.add_argument("--voice", action="append", dest="voices")
    ap.add_argument("--link-mode", choices=("copy", "hardlink"), default="copy")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", type=Path)
    args = ap.parse_args(argv)

    bundle_dirs = list(args.bundle_dirs or [])
    bundle_dirs.extend(_bundle_dir_for_tier(args.bundles_root, tier) for tier in (args.tiers or []))
    if not bundle_dirs:
        ap.error("provide at least one --tier or --bundle-dir")

    voices = _parse_voices(args.voices)
    reports = [
        stage_kokoro_bundle(
            bundle_dir,
            repo_id=args.repo_id,
            voices=voices,
            link_mode=args.link_mode,
            dry_run=args.dry_run,
        )
        for bundle_dir in bundle_dirs
    ]
    out = {"reports": reports}
    print(json.dumps(out, indent=2, sort_keys=True))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
