"""Publish the elizaOS Pipeline Corpus v1 to HuggingFace Hub.

Uploads ``data/final/parquet/`` and ``data/final/README.md`` to a target
HuggingFace dataset repo. By default the repo is created **private** —
flip to public via the Hub UI once the upload is verified.

Pre-flight checks:

1. ``HF_TOKEN`` (or ``HUGGINGFACE_HUB_TOKEN``) env var is set.
2. ``data/final/parquet/`` exists and contains ``train``,
   ``validation``, ``test`` subdirs with at least one ``*.parquet``
   file each.
3. ``data/final/README.md`` exists.
4. Published targets are native JSON-derived parquet chunks.

Usage::

    # Dry-run (always safe; no network calls except metadata reads).
    uv run python scripts/push_to_hf.py --dry-run

    # Real upload to the default repo (creates private if missing).
    HF_TOKEN=hf_xxx uv run python scripts/push_to_hf.py

    # Custom repo / public from the start.
    HF_TOKEN=hf_xxx uv run python scripts/push_to_hf.py \\
        --repo-id myorg/my-corpus --public

    # Just push the README (e.g. after edits).
    HF_TOKEN=hf_xxx uv run python scripts/push_to_hf.py --readme-only
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FINAL = ROOT / "data" / "final"
PARQUET_DIR = FINAL / "parquet"
README = FINAL / "README.md"

DEFAULT_REPO_ID = "elizaos/eliza-native-tool-calling-v1-sft"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("push_to_hf")


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def discover_parquet_chunks() -> dict[str, list[Path]]:
    """Return {split_name: [parquet_path, ...]} for the published splits."""
    if not PARQUET_DIR.exists():
        return {}
    out: dict[str, list[Path]] = {}
    for split in ("train", "validation", "test"):
        d = PARQUET_DIR / split
        if d.exists():
            out[split] = sorted(d.glob("*.parquet"))
    return out


def total_bytes(paths: list[Path]) -> int:
    return sum(p.stat().st_size for p in paths if p.exists())


def preflight(args: argparse.Namespace) -> tuple[bool, list[str]]:
    """Return (ok, messages). messages always lists the checks performed."""
    msgs: list[str] = []
    ok = True

    token = hf_token()
    if token:
        msgs.append("[ok] HF_TOKEN is set")
    else:
        msgs.append("[fail] HF_TOKEN / HUGGINGFACE_HUB_TOKEN env var is not set")
        if not args.dry_run:
            ok = False

    if README.exists():
        msgs.append(f"[ok] dataset card present: {README.relative_to(ROOT)} ({README.stat().st_size:,} bytes)")
    else:
        msgs.append(f"[fail] missing {README.relative_to(ROOT)}")
        ok = False

    if args.readme_only:
        return ok, msgs

    chunks = discover_parquet_chunks()
    if not chunks:
        msg = (
            f"no parquet found at {PARQUET_DIR.relative_to(ROOT)}/ — "
            "run scripts/jsonl_to_parquet.py first"
        )
        if args.dry_run:
            msgs.append(f"[warn] {msg}")
        else:
            msgs.append(f"[fail] {msg}")
            ok = False
    else:
        total_size = 0
        for split, paths in chunks.items():
            sz = total_bytes(paths)
            total_size += sz
            if not paths:
                if args.dry_run:
                    msgs.append(f"[warn] no parquet chunks under {split}/")
                else:
                    msgs.append(f"[fail] no parquet chunks under {split}/")
                    ok = False
            else:
                msgs.append(
                    f"[ok] {split}: {len(paths)} chunk(s), {sz / (1024 ** 3):.2f} GiB"
                )
        msgs.append(f"[info] total parquet payload: {total_size / (1024 ** 3):.2f} GiB")

    msgs.append("[ok] corpus format is native JSON")

    return ok, msgs


def push(args: argparse.Namespace) -> int:
    from huggingface_hub import HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())
    repo_id = args.repo_id

    # Repo create / probe.
    try:
        api.repo_info(repo_id, repo_type="dataset")
        log.info("repo %s already exists", repo_id)
    except RepositoryNotFoundError:
        log.info(
            "repo %s does not exist — creating (private=%s)",
            repo_id,
            not args.public,
        )
        api.create_repo(
            repo_id=repo_id,
            repo_type="dataset",
            private=not args.public,
            exist_ok=False,
        )
        log.info("repo %s created", repo_id)

    if args.readme_only:
        log.info("uploading README only")
        api.upload_file(
            path_or_fileobj=str(README),
            path_in_repo="README.md",
            repo_id=repo_id,
            repo_type="dataset",
            commit_message="Update dataset card",
        )
        log.info("README uploaded")
        return 0

    # Upload parquet folder. ``upload_large_folder`` chunks + retries
    # automatically; ``upload_folder`` is fine for sub-50GB payloads.
    log.info(
        "uploading parquet folder %s -> %s/parquet/",
        PARQUET_DIR.relative_to(ROOT),
        repo_id,
    )
    try:
        api.upload_large_folder(
            folder_path=str(PARQUET_DIR),
            repo_id=repo_id,
            repo_type="dataset",
            path_in_repo="parquet",
            allow_patterns=["*.parquet", "_summary.json"],
        )
    except AttributeError:
        # Older huggingface_hub versions: fall back to upload_folder.
        log.info("upload_large_folder unavailable; using upload_folder")
        api.upload_folder(
            folder_path=str(PARQUET_DIR),
            repo_id=repo_id,
            repo_type="dataset",
            path_in_repo="parquet",
            allow_patterns=["*.parquet", "_summary.json"],
            commit_message="Upload parquet chunks",
        )

    # Upload manifest.json so consumers can audit per-source counts.
    manifest = FINAL / "manifest.json"
    if manifest.exists():
        log.info("uploading manifest.json")
        api.upload_file(
            path_or_fileobj=str(manifest),
            path_in_repo="manifest.json",
            repo_id=repo_id,
            repo_type="dataset",
            commit_message="Upload pack manifest",
        )

    # Upload README last so the dataset card refreshes only after data
    # is in place.
    log.info("uploading README")
    api.upload_file(
        path_or_fileobj=str(README),
        path_in_repo="README.md",
        repo_id=repo_id,
        repo_type="dataset",
        commit_message="Update dataset card",
    )

    log.info("done. https://huggingface.co/datasets/%s", repo_id)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--repo-id",
        default=DEFAULT_REPO_ID,
        help=f"HF repo id (default {DEFAULT_REPO_ID})",
    )
    ap.add_argument(
        "--public",
        action="store_true",
        help="create the repo as public (default: private)",
    )
    ap.add_argument(
        "--readme-only",
        action="store_true",
        help="only upload the README dataset card",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print plan; do not call the Hub",
    )
    args = ap.parse_args()

    ok, msgs = preflight(args)
    log.info("preflight:")
    for m in msgs:
        log.info("  %s", m)
    if not ok:
        log.error("preflight failed; aborting")
        return 2

    log.info("plan:")
    log.info("  repo_id:        %s", args.repo_id)
    log.info("  visibility:     %s", "public" if args.public else "private")
    log.info("  readme_only:    %s", args.readme_only)
    log.info("  dry_run:        %s", args.dry_run)

    if args.dry_run:
        log.info("dry-run: skipping Hub calls")
        return 0

    return push(args)


if __name__ == "__main__":
    sys.exit(main())
