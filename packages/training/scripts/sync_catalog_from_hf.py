"""Walk elizaos/eliza-1-* repos and emit a catalog diff for local inference.

The local-inference catalog (`packages/app-core/src/services/local-inference/catalog.ts`)
is the source of truth for which models the phone offers and where it
downloads them from. This script:

  1. Lists every Eliza-1 repo under the elizaos HF org.
  2. For each repo, reads `manifest.json` and the GGUF metadata (via the
     `huggingface_hub` repo_info API; `lfs.sha256` and `size` come for
     free with `files_metadata=True`).
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
          "id": "eliza-1-mobile-1_7b",
          "hfRepo": "elizaos/eliza-1-mobile-1_7b",
          "ggufFile": "text/eliza-1-mobile-1_7b-q4_k_m.gguf",
          "sha256": "<64-hex>",
          "sizeBytes": 0,
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
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("sync_catalog_from_hf")


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

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "hfRepo": self.hf_repo,
            "ggufFile": self.gguf_file,
            "sha256": self.sha256,
            "sizeBytes": self.size_bytes,
            "manifest": self.manifest,
        }


def _read_remote_manifest(api, repo_id: str) -> dict[str, Any] | None:
    """Fetch manifest.json from a model repo, or None if missing/unparseable."""
    from huggingface_hub import hf_hub_download
    from huggingface_hub.errors import EntryNotFoundError

    try:
        path = hf_hub_download(
            repo_id=repo_id,
            filename="manifest.json",
            repo_type="model",
            token=hf_token(),
        )
    except EntryNotFoundError:
        log.warning("repo %s has no manifest.json; skipping", repo_id)
        return None
    except Exception as exc:
        log.warning("failed to fetch manifest.json from %s: %s", repo_id, exc)
        return None
    try:
        return json.loads(Path(path).read_text())
    except json.JSONDecodeError as exc:
        log.warning("manifest.json from %s is not valid JSON: %s", repo_id, exc)
        return None


def _gguf_sibling(api, repo_id: str) -> tuple[str, str, int] | None:
    """Return (gguf_file, sha256, size_bytes) for the single GGUF in repo_id.

    Returns None if no GGUF is present (placeholder repo) or the LFS
    metadata is missing.
    """
    info = api.repo_info(repo_id, repo_type="model", files_metadata=True)
    siblings = getattr(info, "siblings", None) or []
    ggufs = [s for s in siblings if s.rfilename.endswith(".gguf")]
    if not ggufs:
        return None
    if len(ggufs) > 1:
        log.warning(
            "repo %s has multiple GGUFs (%s); using the first",
            repo_id,
            [s.rfilename for s in ggufs],
        )
    sibling = ggufs[0]
    lfs = getattr(sibling, "lfs", None)
    sha = None
    if lfs:
        sha = getattr(lfs, "sha256", None) or (
            lfs.get("sha256") if isinstance(lfs, dict) else None
        )
    size = getattr(sibling, "size", None)
    if size is None and lfs:
        size = lfs.get("size") if isinstance(lfs, dict) else getattr(lfs, "size", None)
    if not sha or size is None:
        log.warning(
            "repo %s GGUF %s has no LFS sha/size; skipping",
            repo_id,
            sibling.rfilename,
        )
        return None
    return (sibling.rfilename, sha, int(size))


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
        if filter_prefix and not repo_name.startswith(filter_prefix):
            continue
        if filter_suffix and not repo_id.endswith(f"-{filter_suffix}"):
            continue
        log.info("inspecting %s", repo_id)
        manifest = _read_remote_manifest(api, repo_id)
        if manifest is None:
            continue
        gguf_info = _gguf_sibling(api, repo_id)
        if gguf_info is None:
            log.info(
                "repo %s has no published GGUF yet (placeholder); skipping",
                repo_id,
            )
            continue
        gguf_file, sha, size = gguf_info
        # Catalog id == bare repo name (after the org/), e.g.
        # `elizaos/eliza-1-mobile-1_7b` -> `eliza-1-mobile-1_7b`.
        catalog_id = repo_name
        entries.append(CatalogEntry(
            id=catalog_id,
            hf_repo=repo_id,
            gguf_file=gguf_file,
            sha256=sha,
            size_bytes=size,
            manifest=manifest,
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
