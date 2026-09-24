#!/usr/bin/env python3
"""Builds the official full-catalog WebShop Lucene retrieval index.

The converter streams the checksum-pinned product array, reproduces the text
projection used by Princeton's ``convert_product_file_format.py``, and writes a
Pyserini index plus a provenance manifest. The temporary index is promoted only
after its document count is verified, so interrupted builds are never runnable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

from elizaos_webshop.dataset import (
    EXPECTED_FULL_CATALOG_ENTRIES,
    EXPECTED_FULL_PRODUCTS,
    REPO_DATA_DIR,
    UPSTREAM_FILE_MANIFEST,
    _iter_catalog_products,
    resolve_paths,
    verify_upstream_data,
)

DEFAULT_INDEX_DIR = REPO_DATA_DIR / "search-indexes" / "full"
DEFAULT_MANIFEST_PATH = REPO_DATA_DIR / "search-indexes" / "full.manifest.json"
BATCH_SIZE = 2_048
EXPECTED_EMPTY_PROJECTIONS = 60
EXPECTED_INDEXED_DOCUMENTS = EXPECTED_FULL_PRODUCTS - EXPECTED_EMPTY_PROJECTIONS


def _document_from_product(product: dict[str, Any]) -> dict[str, str] | None:
    asin = product.get("asin")
    if not isinstance(asin, str):
        raise ValueError("WebShop product catalog entry has no ASIN")
    if not asin or asin == "nan" or len(asin) > 10:
        return None

    title = product.get("name")
    description = product.get("full_description")
    bullet_points = product.get("small_description")
    if not isinstance(title, str) or not isinstance(description, str):
        raise ValueError(f"WebShop product {asin} has invalid title or description")
    if isinstance(bullet_points, list):
        if not bullet_points or not isinstance(bullet_points[0], str):
            raise ValueError(f"WebShop product {asin} has no primary bullet point")
        primary_bullet = bullet_points[0]
    elif isinstance(bullet_points, str):
        primary_bullet = bullet_points
    else:
        raise ValueError(f"WebShop product {asin} has invalid bullet points")

    raw_options = product.get("customization_options")
    # The source catalog uses both null and an empty string for products with
    # no options; upstream load_products treats every falsy representation as
    # absent before it calls .items().
    if not raw_options:
        raw_options = {}
    if not isinstance(raw_options, dict):
        raise ValueError(f"WebShop product {asin} has invalid customization options")
    option_texts: list[str] = []
    for option_name, option_contents in raw_options.items():
        if option_contents is None:
            continue
        if not isinstance(option_name, str) or not isinstance(option_contents, list):
            raise ValueError(f"WebShop product {asin} has malformed customization options")
        option_values: list[str] = []
        for option in option_contents:
            if not isinstance(option, dict) or not isinstance(option.get("value"), str):
                raise ValueError(f"WebShop product {asin} has a malformed option value")
            option_values.append(
                option["value"].strip().replace("/", " | ").lower()
            )
        option_texts.append(f"{option_name.lower()}: {', '.join(option_values)}")

    contents = " ".join(
        (title, description, primary_bullet, ", and ".join(option_texts))
    ).lower()
    return {"id": asin, "contents": contents}


def _anserini_metadata() -> tuple[str, str]:
    import pyserini

    jars = sorted((Path(pyserini.__file__).parent / "resources" / "jars").glob(
        "anserini-*-fatjar.jar"
    ))
    if len(jars) != 1:
        raise RuntimeError(f"Expected one bundled Anserini jar, found {len(jars)}")
    jar = jars[0]
    jar_version = jar.name.removeprefix("anserini-").removesuffix("-fatjar.jar")
    digest = hashlib.sha256()
    with jar.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return jar_version, digest.hexdigest()


def build_index(index_dir: Path, manifest_path: Path) -> dict[str, Any]:
    if index_dir.exists() or manifest_path.exists():
        raise FileExistsError(
            f"Refusing to overwrite existing WebShop search artifacts: "
            f"{index_dir} or {manifest_path}"
        )

    paths = resolve_paths(data_dir=REPO_DATA_DIR, profile="full")
    if paths is None:
        raise FileNotFoundError(
            "WebShop full data is missing; run scripts/fetch_data.py --profile full first"
        )
    source_provenance = verify_upstream_data(paths)

    from pyserini.index.lucene import LuceneIndexer, LuceneIndexReader

    index_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary_index = Path(
        tempfile.mkdtemp(prefix=".webshop-index-", dir=index_dir.parent)
    )
    indexer: LuceneIndexer | None = None
    raw_entries = 0
    submitted_document_count = 0
    empty_projection_count = 0
    document_count = 0
    seen: set[str] = set()
    batch: list[dict[str, str]] = []
    try:
        indexer = LuceneIndexer(
            args=[
                "-index",
                str(temporary_index),
                "-storePositions",
                "-storeDocvectors",
                "-storeRaw",
            ],
            threads=max(1, min(8, os.cpu_count() or 1)),
        )
        for product in _iter_catalog_products(paths.items):
            raw_entries += 1
            document = _document_from_product(product)
            if document is None or document["id"] in seen:
                continue
            seen.add(document["id"])
            submitted_document_count += 1
            # Anserini's SimpleIndexer omits empty analyzed documents. Skipping
            # them explicitly makes that official behavior measurable and
            # prevents a submitted-count metric from masquerading as index size.
            if not document["contents"].strip():
                empty_projection_count += 1
                continue
            batch.append(document)
            if len(batch) >= BATCH_SIZE:
                indexer.add_batch_dict(batch)
                document_count += len(batch)
                batch.clear()
        if batch:
            indexer.add_batch_dict(batch)
            document_count += len(batch)
            batch.clear()
        indexer.close()
        indexer = None

        if raw_entries != EXPECTED_FULL_CATALOG_ENTRIES:
            raise ValueError(
                f"Expected {EXPECTED_FULL_CATALOG_ENTRIES} raw products, found {raw_entries}"
            )
        if submitted_document_count != EXPECTED_FULL_PRODUCTS:
            raise ValueError(
                "Expected "
                f"{EXPECTED_FULL_PRODUCTS} submitted products, found "
                f"{submitted_document_count}"
            )
        if empty_projection_count != EXPECTED_EMPTY_PROJECTIONS:
            raise ValueError(
                f"Expected {EXPECTED_EMPTY_PROJECTIONS} empty projections, found "
                f"{empty_projection_count}"
            )
        if document_count != EXPECTED_INDEXED_DOCUMENTS:
            raise ValueError(
                f"Expected {EXPECTED_INDEXED_DOCUMENTS} searchable products, found "
                f"{document_count}"
            )
        stats = LuceneIndexReader(str(temporary_index)).stats()
        if int(stats.get("documents", -1)) != EXPECTED_INDEXED_DOCUMENTS:
            raise ValueError(
                "Lucene index document count mismatch: expected "
                f"{EXPECTED_INDEXED_DOCUMENTS}, found {stats.get('documents')}"
            )

        anserini_version, anserini_sha256 = _anserini_metadata()
        java_version = subprocess.run(
            ["java", "-version"],
            check=True,
            capture_output=True,
            text=True,
        ).stderr.splitlines()[0]
        manifest: dict[str, Any] = {
            "schema_version": 1,
            "search_backend": "pyserini-lucene",
            "document_projection": "webshop-title-description-primary-bullet-options-v1",
            "raw_catalog_entries": raw_entries,
            "submitted_document_count": submitted_document_count,
            "empty_projection_count": empty_projection_count,
            "document_count": document_count,
            "source_file_size": paths.items.stat().st_size,
            "source_sha256": UPSTREAM_FILE_MANIFEST[paths.items.name][1],
            "pyserini_version": version("pyserini"),
            "anserini_version": anserini_version,
            "anserini_jar_sha256": anserini_sha256,
            "java_version": java_version,
            "index_options": ["storePositions", "storeDocvectors", "storeRaw"],
            "source_provenance": source_provenance,
        }
        manifest_part = manifest_path.with_suffix(manifest_path.suffix + ".part")
        manifest_part.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_index, index_dir)
        os.replace(manifest_part, manifest_path)
        return manifest
    finally:
        if indexer is not None:
            indexer.close()
        if temporary_index.exists():
            shutil.rmtree(temporary_index)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index-dir", type=Path, default=DEFAULT_INDEX_DIR)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    args = parser.parse_args()
    manifest = build_index(args.index_dir.resolve(), args.manifest.resolve())
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
