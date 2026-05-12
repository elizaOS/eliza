"""Download every source dataset listed in `datasets.yaml`.

Strategy:
  * `huggingface_hub.snapshot_download` per repo into `data/raw/<slug>/`.
  * Skip on success marker (`data/raw/<slug>/.done`); re-running is cheap.
  * Disk-budget guard: aborts before starting a dataset if free space drops
    below `--min-free-gb` (default 30). Override with --force.
  * Optional --priority core to skip "extra" datasets, keeps disk usage down.
  * Concurrency is bounded — HF rate-limits are not generous.

Usage:
    uv run python scripts/download_datasets.py
    uv run python scripts/download_datasets.py --priority core
    uv run python scripts/download_datasets.py --only scambench,hermes-fc-v1
    uv run python scripts/download_datasets.py --skip hermes-3
    uv run python scripts/download_datasets.py --min-free-gb 60
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml
from huggingface_hub import snapshot_download
from huggingface_hub.utils import HfHubHTTPError

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
REGISTRY = ROOT / "datasets.yaml"
DOWNLOAD_MANIFEST = RAW_DIR / "download_manifest.json"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.local_path_source import LocalPathSource  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("download")


def free_gb(path: Path) -> float:
    return shutil.disk_usage(path).free / (1024**3)


def dataset_dir(slug: str) -> Path:
    return RAW_DIR / slug


def is_done(slug: str) -> bool:
    return (dataset_dir(slug) / ".done").exists()


def mark_done(slug: str, repo_id: str) -> None:
    d = dataset_dir(slug)
    d.mkdir(parents=True, exist_ok=True)
    (d / ".done").write_text(f"{repo_id}\n{time.time()}\n", encoding="utf-8")


def dir_size_gb(path: Path) -> float:
    if not path.exists():
        return 0.0
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total / (1024**3)


def stage_local(entry: dict) -> tuple[str, str, float]:
    """Stage a local-source dataset under data/raw/<slug>/ as a mirrored
    tree of file-level symlinks.

    `local_path` resolves relative to the training/ root. We replicate the
    directory structure under the source and symlink leaf files so
    normalize.py's `rglob("*.jsonl")` finds them — `rglob` does not
    descend into directory symlinks, so we recreate dirs ourselves.
    """
    slug = entry["slug"]
    source = (ROOT / entry["local_path"]).resolve()
    if not source.exists():
        return (slug, f"FAILED: local_path {source} does not exist", 0.0)

    target = dataset_dir(slug)
    target.mkdir(parents=True, exist_ok=True)
    # Walk source recursively, mirror dirs, symlink files (idempotent).
    for root, dirs, files in os.walk(source, followlinks=True):
        rel = Path(root).relative_to(source)
        out_dir = target / rel
        out_dir.mkdir(parents=True, exist_ok=True)
        for fname in files:
            src = Path(root) / fname
            dst = out_dir / fname
            if dst.is_symlink() or dst.exists():
                dst.unlink()
            dst.symlink_to(src.resolve())
    mark_done(slug, entry.get("repo_id") or f"local:{entry['local_path']}")
    return (slug, "ok", dir_size_gb(source))


def stage_local_path_source(entry: dict) -> tuple[str, str, float]:
    """Stage a `source: { type: local_path, root, glob }` entry.

    Used by the nightly trajectory-export bridge: globs files out of
    ``~/.eliza/training/datasets/<date>/*.jsonl`` (resolved through
    env-var expansion) and symlinks them under ``data/raw/<slug>/``.
    A missing root or empty glob match is NOT a failure — we mark the
    entry "done" with zero size so the normalize step skips it cleanly.
    """
    slug = entry["slug"]
    parsed = LocalPathSource.from_entry(entry)
    if parsed is None:
        return (slug, "FAILED: expected source.type=local_path", 0.0)
    files = parsed.resolve_files()
    target = dataset_dir(slug)
    target.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    for src in files:
        # Flatten into target/<parent_dir>__<filename> so multiple dated
        # subdirectories (e.g. 2026-05-11/, 2026-05-12/) coexist without
        # collisions when the glob includes a wildcard segment.
        rel_parent = src.parent.name
        dst = target / f"{rel_parent}__{src.name}"
        if dst.is_symlink() or dst.exists():
            dst.unlink()
        dst.symlink_to(src.resolve())
        try:
            total_bytes += src.stat().st_size
        except OSError:
            pass
    mark_done(slug, f"local_path:{parsed.root}/{parsed.glob}")
    return (slug, "ok", total_bytes / (1024**3))


def download_one(entry: dict, *, retries: int = 3) -> tuple[str, str, float]:
    if isinstance(entry.get("source"), dict) and entry["source"].get("type") == "local_path":
        return stage_local_path_source(entry)
    if entry.get("local_path"):
        return stage_local(entry)
    slug = entry["slug"]
    repo_id = entry["repo_id"]
    target = dataset_dir(slug)
    target.mkdir(parents=True, exist_ok=True)

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            snapshot_download(
                repo_id=repo_id,
                repo_type="dataset",
                local_dir=str(target),
                # Skip optional large extras when not needed; we still get
                # README.md and dataset_infos.json for traceability.
                allow_patterns=[
                    "*.json",
                    "*.jsonl",
                    "*.parquet",
                    "*.csv",
                    "*.tsv",
                    "*.md",
                    "*.txt",
                    "*.yaml",
                    "*.yml",
                ],
                etag_timeout=60,
                max_workers=4,
            )
            mark_done(slug, repo_id)
            return (slug, "ok", dir_size_gb(target))
        except HfHubHTTPError as e:
            last_err = e
            wait = min(60, 5 * attempt)
            log.warning(
                "download %s attempt %d failed (%s); retrying in %ds",
                slug, attempt, e, wait,
            )
            time.sleep(wait)
        except Exception as e:  # noqa: BLE001 — surface every failure
            last_err = e
            log.warning("download %s attempt %d failed (%s)", slug, attempt, e)
            time.sleep(5)

    return (slug, f"FAILED: {last_err}", dir_size_gb(target))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--registry", type=Path, default=REGISTRY)
    ap.add_argument("--priority", choices=["core", "extra", "all"], default="all",
                    help="filter by priority (core only by default? — no, default all)")
    ap.add_argument("--only", type=str, default="",
                    help="comma-separated slugs to download")
    ap.add_argument("--skip", type=str, default="",
                    help="comma-separated slugs to skip")
    ap.add_argument("--min-free-gb", type=float, default=30.0)
    ap.add_argument("--max-workers", type=int, default=2)
    ap.add_argument("--sample-per-source", type=int, default=0,
                    help="Accepted for pipeline-flag parity. Downloads are "
                         "file-level (snapshot_download), so this is a no-op "
                         "here — per-source record sampling happens in "
                         "normalize.py / pack_dataset.py.")
    ap.add_argument("--force", action="store_true",
                    help="ignore the disk-budget guard")
    ap.add_argument("--rebuild", action="store_true",
                    help="ignore .done markers and re-download")
    args = ap.parse_args()

    if args.sample_per_source:
        log.info("--sample-per-source=%d is a no-op at download time; "
                 "per-source record limits apply in normalize/pack",
                 args.sample_per_source)

    RAW_DIR.mkdir(parents=True, exist_ok=True)

    with args.registry.open() as f:
        registry = yaml.safe_load(f)

    entries: list[dict] = registry.get("datasets") or []
    only = {s.strip() for s in args.only.split(",") if s.strip()}
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}

    selected: list[dict] = []
    for e in entries:
        if args.priority != "all" and e.get("priority", "core") != args.priority:
            continue
        if only and e["slug"] not in only:
            continue
        if e["slug"] in skip:
            continue
        if not args.rebuild and is_done(e["slug"]):
            log.info("skip %s (already done)", e["slug"])
            continue
        selected.append(e)

    if not selected:
        log.info("nothing to download")
        return 0

    def _is_local(e: dict) -> bool:
        if e.get("local_path"):
            return True
        source = e.get("source")
        return isinstance(source, dict) and source.get("type") == "local_path"

    needs_network = [e for e in selected if not _is_local(e)]
    est_total_gb = sum(float(e.get("est_size_gb", 1.0)) for e in needs_network)
    free = free_gb(RAW_DIR)
    log.info(
        "queued %d datasets (%d local, %d remote), est total %.1f GB, free %.1f GB (min %.1f GB)",
        len(selected), len(selected) - len(needs_network), len(needs_network),
        est_total_gb, free, args.min_free_gb,
    )
    if needs_network and not args.force and free - est_total_gb < args.min_free_gb:
        log.error(
            "would drop below --min-free-gb=%.1f after downloading. "
            "Re-run with --priority core, --only=..., or --force.",
            args.min_free_gb,
        )
        return 2

    fails: list[tuple[str, str]] = []
    results: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=args.max_workers) as ex:
        fut2slug = {ex.submit(download_one, e): e["slug"] for e in selected}
        for fut in as_completed(fut2slug):
            slug = fut2slug[fut]
            try:
                slug, status, size = fut.result()
            except Exception as e:  # noqa: BLE001
                log.exception("worker for %s crashed", slug)
                fails.append((slug, repr(e)))
                results.append({"slug": slug, "status": "FAILED", "error": repr(e), "size_gb": 0.0})
                continue
            if status == "ok":
                log.info("done %-35s %6.2f GB", slug, size)
                results.append({"slug": slug, "status": "ok", "size_gb": round(size, 4)})
            else:
                log.error("FAIL %-35s %s", slug, status)
                fails.append((slug, status))
                results.append({"slug": slug, "status": "FAILED", "error": status, "size_gb": round(size, 4)})
            if needs_network and free_gb(RAW_DIR) < args.min_free_gb and not args.force:
                log.error(
                    "free space dropped below %.1f GB; aborting remaining downloads",
                    args.min_free_gb,
                )
                # cancel pending futures
                for f, s in fut2slug.items():
                    if not f.done():
                        f.cancel()
                break

    DOWNLOAD_MANIFEST.write_text(
        json.dumps(
            {
                "selected": [e["slug"] for e in selected],
                "results": results,
                "failed": [{"slug": slug, "error": msg} for slug, msg in fails],
                "raw_dir": str(RAW_DIR),
                "free_gb_after": round(free_gb(RAW_DIR), 2),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    log.info("download manifest at %s", DOWNLOAD_MANIFEST)

    if fails:
        log.error("%d datasets failed:", len(fails))
        for slug, msg in fails:
            log.error("  %s — %s", slug, msg)
        return 1

    log.info("all done. raw data in %s", RAW_DIR)
    return 0


if __name__ == "__main__":
    sys.exit(main())
