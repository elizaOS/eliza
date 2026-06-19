#!/usr/bin/env python3
"""Consolidate split Eliza-1 voice payload repos into ``elizaos/eliza-1``.

DEPRECATED (2026-05-15): the migration described below is complete. The
legacy ``elizaos/eliza-1-voice-*`` repos have been removed and every voice
asset now lives under ``elizaos/eliza-1`` at ``voice/<model-id>/...``. The
``LEGACY_REPOS`` map is retained as a historical record of the migration
source. This script will fail loudly if invoked because the source repos
no longer exist; do not run it on a fresh checkout.

This script is intentionally conservative:

* Read-only audit is the default.
* Publishing requires ``--publish`` and HF auth. The token may come from
  ``HF_TOKEN``/``HUGGINGFACE_HUB_TOKEN`` or the local huggingface_hub cache.
* Deleting legacy split repos requires ``--delete-split-repos`` and an exact
  ``--confirm-delete-split-repos`` guard after destination verification passes.

The unified layout is::

    elizaos/eliza-1/voice/<model-id>/<asset filename>

``models/voice/manifest.json`` remains the local audit source for sha256 and
sizeBytes. The script verifies source payloads before staging, publishing, or
deleting legacy repos; destination-only verification remains usable after the
legacy repos are removed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from huggingface_hub import HfApi, hf_hub_download, upload_folder


TARGET_REPO = "elizaos/eliza-1"
VOICE_PREFIX = "voice"
LEGACY_REPOS: dict[str, str] = {
    "asr": "elizaos/eliza-1-voice-asr",
    "turn-detector": "elizaos/eliza-1-voice-turn",
    "voice-emotion": "elizaos/eliza-1-voice-emotion",
    "speaker-encoder": "elizaos/eliza-1-voice-speaker",
    "diarizer": "elizaos/eliza-1-voice-diarizer",
    "vad": "elizaos/eliza-1-voice-vad",
    "wakeword": "elizaos/eliza-1-voice-wakeword",
    "kokoro": "elizaos/eliza-1-voice-kokoro",
    "omnivoice": "elizaos/eliza-1-voice-omnivoice",
    "embedding": "elizaos/eliza-1-voice-embedding",
}
GGUF_EXTENSIONS = (".gguf", ".ggml", ".ggml.bin", ".bin")


@dataclass(frozen=True)
class Asset:
    model_id: str
    source_repo: str
    source_revision: str
    source_path: str
    destination_path: str
    sha256: str
    size_bytes: int
    format: str


def token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{path} did not contain a JSON object")
    return data


def iter_assets(manifest: dict[str, Any]) -> Iterable[Asset]:
    for model in manifest.get("models", []):
        if not isinstance(model, dict):
            continue
        model_id = model.get("id")
        revision = model.get("hfRevision")
        if not isinstance(model_id, str) or not isinstance(revision, str):
            raise ValueError(f"voice manifest model is missing id/hfRevision: {model!r}")
        source_repo = LEGACY_REPOS.get(model_id)
        if source_repo is None:
            raise ValueError(f"no legacy repo mapping for voice model {model_id!r}")
        for variant in model.get("variants", []):
            if not isinstance(variant, dict):
                continue
            if variant.get("assetStatus") == "missing":
                continue
            filename = variant.get("filename")
            sha256 = variant.get("sha256")
            size_bytes = variant.get("sizeBytes")
            file_format = variant.get("format")
            if not (
                isinstance(filename, str)
                and isinstance(sha256, str)
                and isinstance(size_bytes, int)
                and isinstance(file_format, str)
            ):
                raise ValueError(f"{model_id}: malformed available variant {variant!r}")
            yield Asset(
                model_id=model_id,
                source_repo=source_repo,
                source_revision=revision,
                source_path=filename,
                destination_path=f"{VOICE_PREFIX}/{model_id}/{filename}",
                sha256=sha256,
                size_bytes=size_bytes,
                format=file_format,
            )


def hf_file_index(api: HfApi, repo: str, revision: str) -> dict[str, Any]:
    info = api.model_info(repo, revision=revision, files_metadata=True)
    return {s.rfilename: s for s in info.siblings}


def lfs_sha(sibling: Any) -> str | None:
    lfs = getattr(sibling, "lfs", None)
    if isinstance(lfs, dict):
        value = lfs.get("sha256")
        return value if isinstance(value, str) else None
    value = getattr(lfs, "sha256", None)
    return value if isinstance(value, str) else None


def verify_sources(api: HfApi, assets: list[Asset]) -> list[str]:
    errors: list[str] = []
    indexes: dict[tuple[str, str], dict[str, Any]] = {}
    for asset in assets:
        key = (asset.source_repo, asset.source_revision)
        if key not in indexes:
            indexes[key] = hf_file_index(api, asset.source_repo, asset.source_revision)
        sibling = indexes[key].get(asset.source_path)
        if sibling is None:
            errors.append(
                f"{asset.source_repo}@{asset.source_revision}: missing {asset.source_path}"
            )
            continue
        actual_size = getattr(sibling, "size", None)
        actual_sha = lfs_sha(sibling)
        if actual_size is not None and int(actual_size) != asset.size_bytes:
            errors.append(
                f"{asset.source_repo}/{asset.source_path}: size "
                f"manifest={asset.size_bytes} hf={actual_size}"
            )
        if actual_sha is not None and actual_sha != asset.sha256:
            errors.append(
                f"{asset.source_repo}/{asset.source_path}: sha "
                f"manifest={asset.sha256} hf={actual_sha}"
            )
    return errors


def verify_destination(api: HfApi, assets: list[Asset], revision: str = "main") -> list[str]:
    errors: list[str] = []
    index = hf_file_index(api, TARGET_REPO, revision)
    for asset in assets:
        sibling = index.get(asset.destination_path)
        if sibling is None:
            errors.append(f"{TARGET_REPO}@{revision}: missing {asset.destination_path}")
            continue
        actual_size = getattr(sibling, "size", None)
        actual_sha = lfs_sha(sibling)
        if actual_size is not None and int(actual_size) != asset.size_bytes:
            errors.append(
                f"{asset.destination_path}: size manifest={asset.size_bytes} hf={actual_size}"
            )
        if actual_sha is not None and actual_sha != asset.sha256:
            errors.append(
                f"{asset.destination_path}: sha manifest={asset.sha256} hf={actual_sha}"
            )
    return errors


def stage_assets(assets: list[Asset], stage_dir: Path, *, clean: bool) -> None:
    if clean and stage_dir.exists():
        shutil.rmtree(stage_dir)
    stage_dir.mkdir(parents=True, exist_ok=True)
    manifest_assets: list[dict[str, Any]] = []
    for asset in assets:
        local = hf_hub_download(
            repo_id=asset.source_repo,
            revision=asset.source_revision,
            filename=asset.source_path,
            repo_type="model",
        )
        dest = stage_dir / asset.destination_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(local, dest)
        manifest_assets.append(asset.__dict__)
    manifest_path = stage_dir / VOICE_PREFIX / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(
            {
                "repo": TARGET_REPO,
                "prefix": VOICE_PREFIX,
                "assets": manifest_assets,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def publish_stage(stage_dir: Path) -> None:
    upload_folder(
        repo_id=TARGET_REPO,
        repo_type="model",
        folder_path=str(stage_dir / VOICE_PREFIX),
        path_in_repo=VOICE_PREFIX,
        commit_message="Consolidate Eliza-1 voice payloads into unified repo",
        token=token(),
    )


def delete_legacy_repos(api: HfApi) -> None:
    for repo in sorted(set(LEGACY_REPOS.values())):
        api.delete_repo(repo_id=repo, repo_type="model", token=token())
        print(f"deleted {repo}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("models/voice/manifest.json"),
        help="local voice manifest with sha256/size audit data",
    )
    parser.add_argument(
        "--stage-dir",
        type=Path,
        default=Path("artifacts/hf-eliza1-voice-consolidation"),
    )
    parser.add_argument("--stage", action="store_true", help="download source assets")
    parser.add_argument("--clean-stage", action="store_true")
    parser.add_argument("--publish", action="store_true", help="upload staged voice/ dir")
    parser.add_argument("--verify-sources", action="store_true")
    parser.add_argument("--verify-destination", action="store_true")
    parser.add_argument("--require-gguf", action="store_true")
    parser.add_argument("--delete-split-repos", action="store_true")
    parser.add_argument("--confirm-delete-split-repos", action="store_true")
    args = parser.parse_args()

    manifest = load_manifest(args.manifest)
    assets = list(iter_assets(manifest))
    api = HfApi()

    non_gguf = [
        a
        for a in assets
        if a.format != "gguf" and not a.source_path.lower().endswith(GGUF_EXTENSIONS)
    ]
    if non_gguf:
        print("non-gguf assets still present:")
        for asset in non_gguf:
            print(f"  - {asset.model_id}: {asset.source_path} ({asset.format})")
        if args.require_gguf:
            print("--require-gguf set; refusing to publish/delete", file=sys.stderr)
            return 1

    explicit_action = any(
        (
            args.stage,
            args.publish,
            args.verify_sources,
            args.verify_destination,
            args.delete_split_repos,
            args.require_gguf,
        )
    )
    needs_source_verification = (
        args.verify_sources
        or args.stage
        or args.publish
        or args.delete_split_repos
        or not explicit_action
    )
    if needs_source_verification:
        source_errors = verify_sources(api, assets)
        if source_errors:
            print("source verification failed:", file=sys.stderr)
            for error in source_errors:
                print(f"  - {error}", file=sys.stderr)
            return 1
        print(f"source verification passed for {len(assets)} assets")

    if args.stage:
        stage_assets(assets, args.stage_dir, clean=args.clean_stage)
        print(f"staged unified voice payloads under {args.stage_dir / VOICE_PREFIX}")

    if args.publish:
        publish_stage(args.stage_dir)
        print(f"published staged voice payloads to {TARGET_REPO}/{VOICE_PREFIX}")

    destination_errors: list[str] = []
    if args.verify_destination or args.delete_split_repos:
        destination_errors = verify_destination(api, assets)
        if destination_errors:
            print("destination verification failed:", file=sys.stderr)
            for error in destination_errors:
                print(f"  - {error}", file=sys.stderr)
            return 1
        print(f"destination verification passed for {len(assets)} assets")

    if args.delete_split_repos:
        if not args.confirm_delete_split_repos:
            print(
                "--delete-split-repos requires --confirm-delete-split-repos",
                file=sys.stderr,
            )
            return 1
        delete_legacy_repos(api)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
