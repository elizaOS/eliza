"""Walk the elizaos/eliza-1 bundle repo and emit a catalog diff for local inference.

The local-inference catalog (`packages/app-core/src/services/local-inference/catalog.ts`)
is the source of truth for which models the phone offers and where it
downloads them from. This script:

  1. Lists the Eliza-1 bundle repo under the elizaos HF org.
  2. Reads each `bundles/<tier>/eliza-1.manifest.json` plus legacy
     per-tier `eliza-1-*` manifests when present.
     and the GGUF metadata (via the `huggingface_hub` repo_info API;
     `lfs.sha256` and `size` come for free with `files_metadata=True`).
  3. Emits a JSON diff describing which catalog entries should be
     created, updated, or left alone.

It deliberately does NOT edit `catalog.ts` — that is W5-Catalog's job,
and the diff format keeps the merger out of TypeScript ASTs. The diff
schema is intentionally tiny:

    {
      "version": 1,
      "generatedAt": "<UTC ISO>",
      "org": "elizaos",
      "entries": [
        {
          "id": "eliza-1-2b",
          "hfRepo": "elizaos/eliza-1",
          "hfPathPrefix": "bundles/2b",
          "ggufFile": "text/eliza-1-2b-q4_k_m.gguf",
          "sha256": "<64-hex>",
          "sizeBytes": 0,
          "bundleManifestFile": "eliza-1.manifest.json",
          "bundleManifestSha256": "<64-hex>",
          "manifest": { ... full manifest.json contents ... }
        },
        ...
      ]
    }

Usage::

    # No HF_TOKEN required for public repos.
    uv run python scripts/sync_catalog_from_hf.py \\
        --org elizaos \\
        --out reports/porting/2026-05-10/catalog-diff.json

    # Limit to a specific naming convention.
    uv run python scripts/sync_catalog_from_hf.py \\
        --org elizaos \\
        --filter-prefix eliza-1- \\
        --out diff.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("sync_catalog_from_hf")

MANIFEST_FILENAMES: tuple[str, ...] = ("eliza-1.manifest.json", "manifest.json")


def hf_token() -> str | None:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    hf_repo: str
    gguf_file: str
    sha256: str
    size_bytes: int
    manifest: dict[str, Any]
    hf_path_prefix: str | None = None
    bundle_manifest_file: str | None = None
    bundle_manifest_sha256: str | None = None
    bundle_size_bytes: int | None = None

    def to_json(self) -> dict[str, Any]:
        out = {
            "id": self.id,
            "hfRepo": self.hf_repo,
            "ggufFile": self.gguf_file,
            "sha256": self.sha256,
            "sizeBytes": self.size_bytes,
            "manifest": self.manifest,
        }
        if self.hf_path_prefix is not None:
            out["hfPathPrefix"] = self.hf_path_prefix
        if self.bundle_manifest_file is not None:
            out["bundleManifestFile"] = self.bundle_manifest_file
        if self.bundle_manifest_sha256 is not None:
            out["bundleManifestSha256"] = self.bundle_manifest_sha256
        if self.bundle_size_bytes is not None:
            out["bundleSizeBytes"] = self.bundle_size_bytes
        return out


def _sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def _read_remote_manifest(
    api,
    repo_id: str,
    filenames: tuple[str, ...] = MANIFEST_FILENAMES,
) -> tuple[str, dict[str, Any], str] | None:
    """Fetch an Eliza manifest from a model repo, or None if missing/unparseable."""
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import EntryNotFoundError

    missing: list[str] = []
    for filename in filenames:
        try:
            path = Path(
                hf_hub_download(
                    repo_id=repo_id,
                    filename=filename,
                    repo_type="model",
                    token=hf_token(),
                )
            )
        except EntryNotFoundError:
            missing.append(filename)
            continue
        except Exception as exc:
            log.warning("failed to fetch %s from %s: %s", filename, repo_id, exc)
            return None
        try:
            return filename, json.loads(path.read_text()), _sha256_file(path)
        except json.JSONDecodeError as exc:
            log.warning("%s from %s is not valid JSON: %s", filename, repo_id, exc)
            return None
    log.warning("repo %s has none of %s; skipping", repo_id, ", ".join(missing))
    return None


def _sibling_sha_size(sibling: Any) -> tuple[str | None, int | None]:
    lfs = getattr(sibling, "lfs", None)
    sha = None
    if lfs:
        sha = getattr(lfs, "sha256", None) or (
            lfs.get("sha256") if isinstance(lfs, dict) else None
        )
    size = getattr(sibling, "size", None)
    if size is None and lfs:
        size = lfs.get("size") if isinstance(lfs, dict) else getattr(lfs, "size", None)
    return sha, int(size) if size is not None else None


def _repo_file_index(api, repo_id: str) -> dict[str, tuple[str | None, int | None]]:
    info = api.repo_info(repo_id, repo_type="model", files_metadata=True)
    siblings = getattr(info, "siblings", None) or []
    return {
        s.rfilename: _sibling_sha_size(s)
        for s in siblings
        if getattr(s, "rfilename", None)
    }


def _gguf_sibling(
    file_index: Mapping[str, tuple[str | None, int | None]],
    repo_id: str,
) -> tuple[str, str, int] | None:
    """Return (gguf_file, sha256, size_bytes) for the single GGUF in repo_id.

    Returns None if no GGUF is present (placeholder repo) or the LFS
    metadata is missing.
    """
    ggufs = [name for name in file_index if name.endswith(".gguf")]
    if not ggufs:
        return None
    if len(ggufs) > 1:
        log.warning(
            "repo %s has multiple GGUFs (%s); using the first",
            repo_id,
            ggufs,
        )
    gguf_file = ggufs[0]
    sha, size = file_index[gguf_file]
    if not sha or size is None:
        log.warning(
            "repo %s GGUF %s has no LFS sha/size; skipping",
            repo_id,
            gguf_file,
        )
        return None
    return (gguf_file, sha, size)


def _primary_text_file_from_manifest(
    manifest: Mapping[str, Any],
    file_index: Mapping[str, tuple[str | None, int | None]],
    repo_id: str,
    path_prefix: str = "",
) -> tuple[str, str, int] | None:
    files = manifest.get("files")
    text_files = files.get("text") if isinstance(files, dict) else None
    if not isinstance(text_files, list):
        return None
    candidates = [
        entry
        for entry in text_files
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    ]
    candidates.sort(
        key=lambda entry: entry.get("ctx") if isinstance(entry.get("ctx"), int) else -1,
        reverse=True,
    )
    for entry in candidates:
        rel = entry["path"]
        remote_rel = f"{path_prefix}/{rel}" if path_prefix else rel
        sha = entry.get("sha256")
        lfs_sha, size = file_index.get(remote_rel, (None, None))
        if not isinstance(sha, str):
            sha = lfs_sha
        if sha and size is not None:
            return rel, sha, size
        log.warning("repo %s manifest text file %s has no sha/size metadata", repo_id, rel)
    return None


def _bundle_size_from_manifest(
    manifest: Mapping[str, Any],
    file_index: Mapping[str, tuple[str | None, int | None]],
    path_prefix: str = "",
) -> int | None:
    files = manifest.get("files")
    if not isinstance(files, dict):
        return None
    total = 0
    seen: set[str] = set()
    for entries in files.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                continue
            rel = entry["path"]
            if rel in seen:
                continue
            seen.add(rel)
            remote_rel = f"{path_prefix}/{rel}" if path_prefix else rel
            _, size = file_index.get(remote_rel, (None, None))
            if size is None:
                return None
            total += size
    return total if seen else None


def collect_entries(
    *,
    org: str,
    filter_prefix: str | None,
    filter_suffix: str | None,
) -> list[CatalogEntry]:
    from huggingface_hub import HfApi

    api = HfApi(token=hf_token())

    log.info("listing models under org=%s", org)
    repos = list(api.list_models(author=org))
    log.info("found %d repos", len(repos))

    entries: list[CatalogEntry] = []
    for repo in repos:
        repo_id = repo.id
        repo_name = repo_id.split("/", 1)[1] if "/" in repo_id else repo_id
        if repo_name == "eliza-1":
            log.info("inspecting single bundle repo %s", repo_id)
            file_index = _repo_file_index(api, repo_id)
            bundle_manifests = sorted(
                name
                for name in file_index
                if name.startswith("bundles/")
                and name.endswith("/eliza-1.manifest.json")
            )
            for manifest_path in bundle_manifests:
                path_prefix = manifest_path.rsplit("/", 1)[0]
                tier = path_prefix.split("/", 1)[1]
                manifest_result = _read_remote_manifest(
                    api, repo_id, (manifest_path,)
                )
                if manifest_result is None:
                    continue
                _, manifest, manifest_sha = manifest_result
                gguf_info = _primary_text_file_from_manifest(
                    manifest, file_index, repo_id, path_prefix
                )
                if gguf_info is None:
                    log.info(
                        "bundle %s/%s has no published text GGUF yet; skipping",
                        repo_id,
                        path_prefix,
                    )
                    continue
                gguf_file, sha, size = gguf_info
                entries.append(
                    CatalogEntry(
                        id=str(manifest.get("id") or f"eliza-1-{tier}"),
                        hf_repo=repo_id,
                        hf_path_prefix=path_prefix,
                        gguf_file=gguf_file,
                        sha256=sha,
                        size_bytes=size,
                        manifest=manifest,
                        bundle_manifest_file="eliza-1.manifest.json",
                        bundle_manifest_sha256=manifest_sha,
                        bundle_size_bytes=_bundle_size_from_manifest(
                            manifest, file_index, path_prefix
                        ),
                    )
                )
            continue
        if filter_prefix and not repo_name.startswith(filter_prefix):
            continue
        if filter_suffix and not repo_id.endswith(f"-{filter_suffix}"):
            continue
        log.info("inspecting %s", repo_id)
        manifest_result = _read_remote_manifest(api, repo_id)
        if manifest_result is None:
            continue
        manifest_filename, manifest, manifest_sha = manifest_result
        file_index = _repo_file_index(api, repo_id)
        gguf_info = _primary_text_file_from_manifest(manifest, file_index, repo_id)
        bundle_manifest_file = None
        bundle_manifest_sha = None
        bundle_size_bytes = None
        if gguf_info is not None and manifest_filename == "eliza-1.manifest.json":
            bundle_manifest_file = manifest_filename
            bundle_manifest_sha = manifest_sha
            bundle_size_bytes = _bundle_size_from_manifest(manifest, file_index)
        if gguf_info is None:
            gguf_info = _gguf_sibling(file_index, repo_id)
        if gguf_info is None:
            log.info(
                "repo %s has no published GGUF yet (placeholder); skipping",
                repo_id,
            )
            continue
        gguf_file, sha, size = gguf_info
        # Legacy catalog id == bare repo name (after the org/).
        catalog_id = repo_name
        entries.append(CatalogEntry(
            id=catalog_id,
            hf_repo=repo_id,
            gguf_file=gguf_file,
            sha256=sha,
            size_bytes=size,
            manifest=manifest,
            bundle_manifest_file=bundle_manifest_file,
            bundle_manifest_sha256=bundle_manifest_sha,
            bundle_size_bytes=bundle_size_bytes,
        ))
    return entries


def write_diff(entries: list[CatalogEntry], out_path: Path, *, org: str) -> None:
    payload = {
        "version": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "org": org,
        "entries": [e.to_json() for e in entries],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    log.info(
        "wrote %d catalog entries to %s (%.1f KB)",
        len(entries),
        out_path,
        out_path.stat().st_size / 1024,
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--org", default="elizaos",
                    help="HF org to scan (default: elizaos).")
    ap.add_argument(
        "--filter-prefix", default="eliza-1-",
        help="If set, include only repos whose bare name starts with this prefix "
             "(default: eliza-1-).",
    )
    ap.add_argument(
        "--filter-suffix", default=None,
        help="If set, include only repos whose name ends with -<suffix>. "
             "Useful for one-off legacy scans; leave unset for Eliza-1.",
    )
    ap.add_argument(
        "--out", type=Path, required=True,
        help="Output path for the diff JSON.",
    )
    args = ap.parse_args(argv)

    entries = collect_entries(
        org=args.org,
        filter_prefix=args.filter_prefix,
        filter_suffix=args.filter_suffix,
    )
    write_diff(entries, args.out, org=args.org)
    return 0


if __name__ == "__main__":
    sys.exit(main())
