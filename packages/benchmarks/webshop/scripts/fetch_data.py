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

Java/Lucene/pyserini are *not* fetched here. Full publishable runs require the
checksum-bound Lucene index built by ``scripts/build_search_index.py``;
small/sample diagnostics use the in-process BM25 backend.
"""

from __future__ import annotations

import argparse
import hashlib
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

# Google Drive is the upstream distribution channel. This immutable mirror is
# used only when Drive refuses an otherwise-public large-file download; hashes
# prove that either source produced the same benchmark bytes.
HF_MIRROR_REPOSITORY = "YWZBrandon/webshop-data"
HF_MIRROR_REVISION = "ce990fff5aee388db2706f07820c578ab68e0453"
EXPECTED_FILES: dict[str, tuple[int, str]] = {
    "items_shuffle_1000": (
        4_467_013,
        "30a4765c3a327af72d9a9a95a6b2486d516f0fa1d3ecd83681901ce82a21b269",
    ),
    "items_ins_v2_1000": (
        147_099,
        "f88a36314a397b53b3d9c3fa5878e5f7b26d35019a51ec83fbedeca61a948f6f",
    ),
    "items_shuffle": (
        5_479_720_229,
        "2ef591d65df3af89e972ab72468eb82cbf124d876552d9f3678667edd620a6c8",
    ),
    "items_ins_v2": (
        186_295_270,
        "1d36af476bdb8f82a5da62bd8acdabe54cd8de2fa84010d37da5c4890feb447e",
    ),
    "items_human_ins": (
        5_137_548,
        "cf78667548a71786e1d9049c24b802e48e1084ad4bb021cae56ce1f6d96954a3",
    ),
}

REPO_DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class PrimarySourceUnavailable(RuntimeError):
    """Signals that the upstream Google Drive transport could not serve a file."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_file(logical_name: str, path: Path) -> None:
    expected_size, expected_sha256 = EXPECTED_FILES[logical_name]
    actual_size = path.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(
            f"{path.name} size mismatch: expected {expected_size}, got {actual_size}"
        )
    actual_sha256 = _sha256(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"{path.name} checksum mismatch: expected {expected_sha256}, got {actual_sha256}"
        )


def _download_via_gdown(file_id: str, dest: Path) -> None:
    try:
        import gdown  # type: ignore[import-not-found]
    except ImportError as exc:
        raise PrimarySourceUnavailable(
            "gdown is unavailable for the upstream Google Drive transport"
        ) from exc

    url = f"https://drive.google.com/uc?id={file_id}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.unlink(missing_ok=True)
    try:
        downloaded = gdown.download(url, str(tmp), quiet=False)
    except Exception as exc:
        # error-policy:J2 context-adding rethrow — the caller owns the explicit
        # checksum-pinned mirror policy and must distinguish source transport
        # failure from an invalid downloaded artifact.
        tmp.unlink(missing_ok=True)
        raise PrimarySourceUnavailable(
            f"Google Drive could not serve {dest.name}"
        ) from exc
    if not downloaded or not tmp.is_file():
        raise PrimarySourceUnavailable(f"Google Drive did not produce {dest.name}")


def _download_via_huggingface(logical_name: str, dest: Path) -> None:
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as exc:
        raise RuntimeError(
            "huggingface_hub is required when the upstream Google Drive transport is unavailable"
        ) from exc

    _file_id, basename = GDRIVE_FILES[logical_name]
    # hf_hub_download returns the snapshot path, which is a relative symlink
    # into the hub cache's blobs/ dir. os.link would clone the symlink itself
    # and leave a dangling ``../../blobs/<sha>`` link under data/, so resolve
    # to the real blob before hard-linking.
    downloaded = Path(
        hf_hub_download(
            repo_id=HF_MIRROR_REPOSITORY,
            repo_type="dataset",
            filename=basename,
            revision=HF_MIRROR_REVISION,
        )
    ).resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.unlink(missing_ok=True)
    try:
        os.link(downloaded, tmp)
    except OSError:
        shutil.copy2(downloaded, tmp)


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
            _verify_file(logical_name, dest)
            print(f"[fetch_data] {basename}: already present "
                  f"({dest.stat().st_size:,} bytes), skipping")
            fetched.append(dest)
            continue
        print(f"[fetch_data] Downloading {logical_name} -> {dest}")
        try:
            _download_via_gdown(file_id, dest)
        except PrimarySourceUnavailable as exc:
            # error-policy:J4 explicit source degrade — both transports are
            # public distribution paths for checksum-identical immutable data.
            print(
                f"[fetch_data] {exc}; using pinned Hugging Face mirror "
                f"{HF_MIRROR_REPOSITORY}@{HF_MIRROR_REVISION}"
            )
            _download_via_huggingface(logical_name, dest)
        tmp = dest.with_suffix(dest.suffix + ".part")
        _verify_file(logical_name, tmp)
        tmp.replace(dest)
        fetched.append(dest)
    return fetched


def download_profile(profile: str, dest: Path, force: bool = False) -> list[Path]:
    return fetch_profile(profile, data_dir=dest, force=force)


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
