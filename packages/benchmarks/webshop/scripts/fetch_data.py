#!/usr/bin/env python3
"""
Fetch the Princeton-NLP WebShop datasets used by the benchmark.

The upstream ``setup.sh`` lists three Google Drive file IDs:

  items_shuffle_1000   1EgHdxQ_YxqIQlvvq5iKlCrkEKR6-j0Ib   ~6 MB    (1k products)
  items_ins_v2_1000    1IduG0xl544V_A_jv3tHXC0kyFi7PnyBu   ~2 MB    (1k product attrs)
  items_shuffle        1A2whVgOO0euk5O13n2iYDM0bQRkkRduB   ~1.6 GB  (~1.18M products)
  items_ins_v2         1s2j6NgHljiZzQNL3veZaAiyW_qDEgBNi   ~600 MB  (~1.18M attrs)
  items_human_ins      14Kb5SPBk_jfdLZ_CDBNitW98QLDlKR5O   ~5 MB    (12,087 human instructions)

We expose the same five files through three named profiles:

  --profile small    -> items_shuffle_1000 + items_ins_v2_1000 + items_human_ins
                       (default; matches upstream ``setup.sh -d small``)
  --profile full     -> items_shuffle + items_ins_v2 + items_human_ins
                       (the full 1.18M-product catalog used in the published
                       benchmark; gigabytes of download).
  --profile goals    -> items_human_ins only (smallest; lets you inspect the
                       12,087 instruction list without product catalog).

Files are saved into ``packages/benchmarks/webshop/data/`` and skipped if a
matching file already exists with non-zero size.

Java/Lucene/pyserini are *not* fetched here; the WebShop search engine is
optional (we degrade to BM25 in-process when pyserini is unavailable).
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

# Maps logical file name -> (Google Drive file id, expected output basename)
GDRIVE_FILES: dict[str, tuple[str, str]] = {
    "items_shuffle_1000": (
        "1EgHdxQ_YxqIQlvvq5iKlCrkEKR6-j0Ib",
        "items_shuffle_1000.json",
    ),
    "items_ins_v2_1000": (
        "1IduG0xl544V_A_jv3tHXC0kyFi7PnyBu",
        "items_ins_v2_1000.json",
    ),
    "items_shuffle": (
        "1A2whVgOO0euk5O13n2iYDM0bQRkkRduB",
        "items_shuffle.json",
    ),
    "items_ins_v2": (
        "1s2j6NgHljiZzQNL3veZaAiyW_qDEgBNi",
        "items_ins_v2.json",
    ),
    "items_human_ins": (
        "14Kb5SPBk_jfdLZ_CDBNitW98QLDlKR5O",
        "items_human_ins.json",
    ),
}

PROFILES: dict[str, tuple[str, ...]] = {
    "small": ("items_shuffle_1000", "items_ins_v2_1000", "items_human_ins"),
    "full": ("items_shuffle", "items_ins_v2", "items_human_ins"),
    "goals": ("items_human_ins",),
}

REPO_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _download_via_gdown(file_id: str, dest: Path) -> None:
    try:
        import gdown  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SystemExit(
            "gdown is required to fetch WebShop datasets. "
            "Install it with: pip install gdown"
        ) from exc

    url = f"https://drive.google.com/uc?id={file_id}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    gdown.download(url, str(tmp), quiet=False)
    tmp.replace(dest)


def fetch_profile(profile: str, *, data_dir: Path, force: bool = False) -> list[Path]:
    if profile not in PROFILES:
        raise SystemExit(
            f"Unknown profile {profile!r}; expected one of {sorted(PROFILES)}"
        )
    fetched: list[Path] = []
    for logical_name in PROFILES[profile]:
        file_id, basename = GDRIVE_FILES[logical_name]
        dest = data_dir / basename
        if dest.exists() and dest.stat().st_size > 0 and not force:
            print(f"[fetch_data] {basename}: already present "
                  f"({dest.stat().st_size:,} bytes), skipping")
            fetched.append(dest)
            continue
        print(f"[fetch_data] Downloading {logical_name} -> {dest}")
        _download_via_gdown(file_id, dest)
        fetched.append(dest)
    return fetched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--profile",
        choices=sorted(PROFILES),
        default="small",
        help="Data profile (default: small).",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=REPO_DATA_DIR,
        help=f"Output directory (default: {REPO_DATA_DIR}).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download even if the target file already exists.",
    )
    parser.add_argument(
        "--also-link-into-upstream",
        action="store_true",
        help=(
            "Symlink (or copy) the fetched files into "
            "``upstream/data/`` so that upstream code that uses "
            "``DEFAULT_FILE_PATH`` resolves correctly."
        ),
    )
    args = parser.parse_args(argv)

    fetched = fetch_profile(args.profile, data_dir=args.data_dir, force=args.force)

    if args.also_link_into_upstream:
        upstream_data = Path(__file__).resolve().parent.parent / "upstream" / "data"
        upstream_data.mkdir(parents=True, exist_ok=True)
        for src in fetched:
            dst = upstream_data / src.name
            if dst.exists():
                dst.unlink()
            try:
                os.symlink(src, dst)
            except (OSError, NotImplementedError):
                # Windows without symlink permissions: fall back to copy.
                shutil.copy2(src, dst)
            print(f"[fetch_data] Linked {dst} -> {src}")

    print(f"[fetch_data] Done. {len(fetched)} file(s) in {args.data_dir}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
