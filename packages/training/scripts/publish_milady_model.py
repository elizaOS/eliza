"""Publish a fused-kernel "milady-optimized" GGUF to the milady-ai org.

This is the wrapper around `huggingface_hub` that takes a directory
produced by W5-Pipeline (a fully-optimized GGUF + manifest.json + a
README.md) and ships it to `milady-ai/<base>-milady-optimized` (or the
sibling drafter repo). It is distinct from `push_model_to_hf.py`, which
publishes the *base* eliza-1 fine-tunes in stock GGUF / fp8 / polarquant
flavors under the `elizaos/*` org — those repos contain one optimization
at a time. The milady-ai repos contain the **fused** stack
(Q4_POLAR + QJL1_256 K + TBQ V + DFlash) in a single file.

Refuses to ship stock-format GGUFs: every file the script publishes must
declare both `Q4_POLAR` *and* `qjl1_256` in its GGUF tensor type table.
This is the safety rail that keeps an accidentally-mislabeled K-quant
out of the milady-ai org.

Idempotency: after a successful upload the script writes
`published.json` next to the GGUF with the canonical resolve URL,
sha256, and file size. Re-running with the same input is a no-op once
the remote LFS pointer matches the local sha — useful for the nightly
publish-models-nightly CI job, which can replay safely on retry.

Usage::

    # Dry-run — no HF_TOKEN required. Prints the manifest, validates the
    # GGUF metadata, refuses to continue if Q4_POLAR/QJL1_256 are missing.
    uv run python scripts/publish_milady_model.py \\
        --model-dir /path/to/qwen3.5-4b-milady-optimized \\
        --repo-id milady-ai/qwen3.5-4b-milady-optimized \\
        --dry-run

    # Real push.
    HF_TOKEN=hf_xxx uv run python scripts/publish_milady_model.py \\
        --model-dir /path/to/qwen3.5-4b-milady-optimized \\
        --repo-id milady-ai/qwen3.5-4b-milady-optimized
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("publish_milady_model")


# ---------------------------------------------------------------------------
# Required GGUF metadata markers. Both must appear somewhere in the GGUF
# tensor type / metadata header for the file to be considered "fused-kernel
# optimized" and pushable to milady-ai.
#
# We grep the binary header directly rather than parse with gguf-py because
# (a) gguf-py is not a hard dependency of this repo, and (b) the header
# names appear as length-prefixed UTF-8 strings — any GGUF that actually
# uses Q4_POLAR weights or QJL1_256 K-cache type names them in the type
# table, so a bytes-grep is a reliable existence check.
# ---------------------------------------------------------------------------

REQUIRED_GGUF_MARKERS: tuple[bytes, ...] = (b"q4_polar", b"qjl1_256")

# How many bytes of the GGUF header to scan. The tensor type table lives
# near the start of the file — 4 MB is generous and avoids loading a
# multi-GB file just to confirm the markers exist.
GGUF_HEADER_SCAN_BYTES = 4 * 1024 * 1024

# How many bytes of the suffix to scan. Some GGUF writers put the type
# names in a metadata block near the end; cover that too without reading
# the whole file. 1 MB is enough.
GGUF_TAIL_SCAN_BYTES = 1 * 1024 * 1024


# ---------------------------------------------------------------------------
# Config + helpers
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class PublishConfig:
    model_dir: Path
    repo_id: str
    public: bool
    dry_run: bool
    skip_marker_check: bool


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _find_gguf(model_dir: Path) -> Path:
    """Return the single GGUF inside the model dir.

    We deliberately reject directories with zero or multiple GGUFs:
    every milady-ai repo ships one target file. Drafter repos ship one
    drafter file. Multi-file bundles use separate repos.
    """
    candidates = sorted(model_dir.glob("*.gguf"))
    if not candidates:
        raise SystemExit(
            f"no *.gguf in {model_dir}; refusing to publish an empty repo. "
            "W5-Pipeline must produce the fused GGUF before this runs."
        )
    if len(candidates) > 1:
        names = [p.name for p in candidates]
        raise SystemExit(
            f"multiple GGUFs in {model_dir}: {names}. Each milady-ai repo "
            "ships exactly one target/drafter GGUF — split the bundles "
            "across separate repos."
        )
    gguf = candidates[0]
    if gguf.stat().st_size == 0:
        raise SystemExit(
            f"GGUF is zero bytes: {gguf}. Refusing to publish a placeholder. "
            "W5-Pipeline must finish the build before this runs."
        )
    return gguf


def _scan_for_markers(gguf_path: Path) -> set[bytes]:
    """Return the subset of REQUIRED_GGUF_MARKERS present in the file.

    Scans the leading 4 MB and the trailing 1 MB. If markers appear, the
    file declares those tensor types or carries them in the metadata
    block — that's all we need to confirm before pushing.
    """
    found: set[bytes] = set()
    size = gguf_path.stat().st_size
    with gguf_path.open("rb") as fh:
        head = fh.read(min(GGUF_HEADER_SCAN_BYTES, size))
        for marker in REQUIRED_GGUF_MARKERS:
            if marker in head.lower():
                found.add(marker)

        if size > GGUF_HEADER_SCAN_BYTES:
            tail_start = max(0, size - GGUF_TAIL_SCAN_BYTES)
            fh.seek(tail_start)
            tail = fh.read(size - tail_start)
            for marker in REQUIRED_GGUF_MARKERS:
                if marker in tail.lower():
                    found.add(marker)
    return found


def _validate_optimized_gguf(gguf_path: Path, skip: bool) -> None:
    if skip:
        log.warning(
            "--skip-marker-check active — uploading %s without verifying "
            "Q4_POLAR/QJL1_256 metadata. Use only for explicitly-tested "
            "stock-format placeholder repos.",
            gguf_path.name,
        )
        return
    found = _scan_for_markers(gguf_path)
    missing = [m.decode() for m in REQUIRED_GGUF_MARKERS if m not in found]
    if missing:
        raise SystemExit(
            f"refusing to publish {gguf_path.name}: GGUF header is missing "
            f"required milady-optimized markers {missing}. The milady-ai "
            "org is for fused-kernel GGUFs only — stock K-quants belong "
            "under elizaos/eliza-1-*-gguf-* instead. Pass "
            "--skip-marker-check only if you have manually verified the "
            "file via gguf-py."
        )
    log.info(
        "GGUF marker validation passed: %s",
        sorted(m.decode() for m in found),
    )


def _read_manifest(model_dir: Path) -> dict[str, Any]:
    path = model_dir / "manifest.json"
    if not path.exists():
        raise SystemExit(
            f"missing manifest.json in {model_dir}; required by every "
            "milady-ai repo. See HF_PUBLISHING.md → 'Drafter pairing manifest' "
            "for the schema."
        )
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest.json is not valid JSON: {exc}") from exc


def _read_readme(model_dir: Path) -> str:
    path = model_dir / "README.md"
    if not path.exists():
        raise SystemExit(
            f"missing README.md in {model_dir}; required by every "
            "milady-ai repo."
        )
    return path.read_text()


def _validate_manifest(manifest: dict[str, Any], gguf: Path, repo_id: str) -> None:
    """Light schema enforcement — surface obvious authoring mistakes early."""
    required_top = ("version", "kind", "modelId", "base", "gguf", "optimization")
    missing = [k for k in required_top if k not in manifest]
    if missing:
        raise SystemExit(
            f"manifest.json is missing required keys: {missing}. See "
            "HF_PUBLISHING.md → 'Drafter pairing manifest' for the schema."
        )
    if manifest["version"] != 1:
        raise SystemExit(
            f"manifest.json version={manifest['version']!r}; only version=1 "
            "is supported by this script."
        )
    if manifest["kind"] not in ("milady-optimized", "milady-drafter"):
        raise SystemExit(
            "manifest.json kind must be 'milady-optimized' or 'milady-drafter'; "
            f"got {manifest['kind']!r}."
        )
    declared = manifest["gguf"].get("file")
    if declared and declared != gguf.name:
        raise SystemExit(
            f"manifest.json gguf.file={declared!r} but on-disk file is "
            f"{gguf.name!r}. Either rename the file or fix the manifest."
        )
    # If the manifest carries a sha256 from a prior build, refuse to push
    # if it disagrees with the on-disk file — that means the GGUF was
    # rebuilt without re-running publish_milady_model.py.
    declared_sha = manifest["gguf"].get("sha256")
    if declared_sha and declared_sha != _sha256_file(gguf):
        raise SystemExit(
            "manifest.json gguf.sha256 does not match on-disk GGUF sha256. "
            "Re-derive the manifest from the actual file before publishing."
        )


# ---------------------------------------------------------------------------
# Idempotency: published.json sidecar
# ---------------------------------------------------------------------------


def _write_published_sidecar(
    model_dir: Path,
    *,
    repo_id: str,
    gguf_name: str,
    sha256: str,
    size_bytes: int,
) -> Path:
    """Drop a `published.json` next to the GGUF with the canonical pointer."""
    sidecar = model_dir / "published.json"
    payload = {
        "version": 1,
        "repoId": repo_id,
        "ggufFile": gguf_name,
        "sha256": sha256,
        "sizeBytes": size_bytes,
        "resolveUrl": f"https://huggingface.co/{repo_id}/resolve/main/{gguf_name}",
    }
    sidecar.write_text(json.dumps(payload, indent=2) + "\n")
    return sidecar


def _remote_sha256(api, repo_id: str, gguf_name: str) -> str | None:
    try:
        info = api.repo_info(repo_id, repo_type="model", files_metadata=True)
    except Exception:
        return None
    for sib in getattr(info, "siblings", []) or []:
        if sib.rfilename != gguf_name:
            continue
        lfs = getattr(sib, "lfs", None)
        if not lfs:
            return None
        return getattr(lfs, "sha256", None) or (
            lfs.get("sha256") if isinstance(lfs, dict) else None
        )
    return None


# ---------------------------------------------------------------------------
# Publish
# ---------------------------------------------------------------------------


def publish(config: PublishConfig) -> int:
    if not config.model_dir.is_dir():
        raise SystemExit(f"model dir does not exist: {config.model_dir}")

    if not config.repo_id.startswith("milady-ai/"):
        raise SystemExit(
            f"--repo-id must be under milady-ai/ org; got {config.repo_id!r}. "
            "Use scripts/push_model_to_hf.py for elizaos/* fine-tunes."
        )

    gguf = _find_gguf(config.model_dir)
    _validate_optimized_gguf(gguf, skip=config.skip_marker_check)
    manifest = _read_manifest(config.model_dir)
    _validate_manifest(manifest, gguf, config.repo_id)
    readme = _read_readme(config.model_dir)

    local_sha = _sha256_file(gguf)
    size = gguf.stat().st_size

    log.info("model_dir=%s", config.model_dir)
    log.info("repo_id=%s", config.repo_id)
    log.info("gguf=%s (%.2f MB)", gguf.name, size / 1e6)
    log.info("sha256=%s", local_sha)
    log.info("manifest.kind=%s manifest.modelId=%s",
             manifest.get("kind"), manifest.get("modelId"))

    if config.dry_run:
        log.info("dry-run: would upload %s + manifest.json + README.md", gguf.name)
        log.info("manifest preview:\n%s", json.dumps(manifest, indent=2))
        return 0

    if not hf_token():
        raise SystemExit(
            "HF_TOKEN (or HUGGINGFACE_HUB_TOKEN) env var not set; refusing "
            "to push. Use --dry-run for offline validation."
        )

    from huggingface_hub import CommitOperationAdd, HfApi
    from huggingface_hub.errors import RepositoryNotFoundError

    api = HfApi(token=hf_token())

    try:
        api.repo_info(config.repo_id, repo_type="model")
        log.info("repo %s already exists", config.repo_id)
    except RepositoryNotFoundError:
        log.info("repo %s does not exist — creating (private=%s)",
                 config.repo_id, not config.public)
        api.create_repo(
            repo_id=config.repo_id,
            repo_type="model",
            private=not config.public,
            exist_ok=False,
        )

    remote_sha = _remote_sha256(api, config.repo_id, gguf.name)
    if remote_sha == local_sha:
        log.info(
            "GGUF sha matches remote LFS pointer; refreshing manifest + README only"
        )
        operations: list[CommitOperationAdd] = [
            CommitOperationAdd(
                path_in_repo="README.md",
                path_or_fileobj=readme.encode("utf-8"),
            ),
            CommitOperationAdd(
                path_in_repo="manifest.json",
                path_or_fileobj=json.dumps(manifest, indent=2).encode("utf-8"),
            ),
        ]
    else:
        log.info("uploading GGUF + manifest.json + README.md")
        operations = [
            CommitOperationAdd(
                path_in_repo="README.md",
                path_or_fileobj=readme.encode("utf-8"),
            ),
            CommitOperationAdd(
                path_in_repo="manifest.json",
                path_or_fileobj=json.dumps(manifest, indent=2).encode("utf-8"),
            ),
            CommitOperationAdd(
                path_in_repo=gguf.name,
                path_or_fileobj=str(gguf),
            ),
        ]

    api.create_commit(
        repo_id=config.repo_id,
        repo_type="model",
        operations=operations,
        commit_message=f"milady-ai: publish {manifest.get('modelId', gguf.name)}",
    )

    sidecar = _write_published_sidecar(
        config.model_dir,
        repo_id=config.repo_id,
        gguf_name=gguf.name,
        sha256=local_sha,
        size_bytes=size,
    )
    log.info("wrote %s", sidecar)
    log.info("done. https://huggingface.co/%s", config.repo_id)
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--model-dir", type=Path, required=True,
                    help="Directory containing the optimized GGUF + manifest.json + README.md.")
    ap.add_argument("--repo-id", required=True,
                    help="Destination HF repo, e.g. milady-ai/qwen3.5-4b-milady-optimized.")
    ap.add_argument("--public", action="store_true", default=True,
                    help="Create the repo as public (default).")
    ap.add_argument("--no-public", dest="public", action="store_false",
                    help="Create the repo as private (staging).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Validate inputs and print the plan; no network calls.")
    ap.add_argument(
        "--skip-marker-check", action="store_true",
        help="Skip the Q4_POLAR/QJL1_256 GGUF marker scan. Use only when "
             "you have independently verified the file is fused-kernel "
             "optimized. Logs a warning regardless.",
    )
    args = ap.parse_args(argv)

    config = PublishConfig(
        model_dir=args.model_dir,
        repo_id=args.repo_id,
        public=args.public,
        dry_run=args.dry_run,
        skip_marker_check=args.skip_marker_check,
    )
    return publish(config)


if __name__ == "__main__":
    sys.exit(main())
