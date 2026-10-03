"""Install the complete pinned Hermes corpus without publishing partial downloads.

The archive is a licensed data artifact, never executable code. Existing
installations are reverified; incomplete or unrelated destinations are preserved.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path
from urllib.request import urlopen

BUNDLE = Path(__file__).with_name("corpus")
RECORD_NAME = "hermes-fc-v1.jsonl"


def _verify_record(path: Path, manifest: dict) -> None:
    digest = hashlib.sha256()
    size = count = 0
    with path.open("rb") as source:
        for line in source:
            digest.update(line)
            size += len(line)
            if size > manifest["recordBytes"]:
                raise ValueError("Corpus exceeds its declared complete size")
            record = json.loads(line)
            if not isinstance(record, dict):
                raise ValueError("Corpus contains a non-object record")
            count += 1
    if (size, count, digest.hexdigest()) != (
        manifest["recordBytes"],
        manifest["recordCount"],
        manifest["recordSha256"],
    ):
        raise ValueError("Corpus byte count, row count or SHA-256 does not match")


def _install(destination: Path, archive: Path | None, bundle: Path) -> dict:
    manifest_bytes = (bundle / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    destination = destination.absolute()
    record_path = destination / RECORD_NAME
    metadata = {
        name: (bundle / name).read_bytes()
        for name in ("LICENSE", "SOURCE-README.md", "manifest.json")
    }
    if destination.exists():
        _verify_record(record_path, manifest)
        for name, expected in metadata.items():
            if (destination / name).read_bytes() != expected:
                raise ValueError(
                    "Existing corpus metadata differs; use a fresh destination"
                )
        return {"status": "verified", "file": str(record_path), **manifest}
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation rejects concurrent installation without overwriting files.
    destination.mkdir(mode=0o700)
    compressed = destination / ".archive.partial"
    pending = destination / ".records.partial"
    source = (
        archive.open("rb") if archive else urlopen(manifest["archiveUrl"], timeout=60)
    )
    digest = hashlib.sha256()
    size = 0
    with source, compressed.open("xb") as output:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > manifest["archiveBytes"]:
                raise ValueError("Archive exceeds its declared complete size")
            digest.update(chunk)
            output.write(chunk)
    if (size, digest.hexdigest()) != (
        manifest["archiveBytes"],
        manifest["archiveSha256"],
    ):
        raise ValueError("Archive byte count or SHA-256 does not match")
    with gzip.open(compressed, "rb") as decoded, pending.open("xb") as output:
        size = 0
        while chunk := decoded.read(1024 * 1024):
            size += len(chunk)
            if size > manifest["recordBytes"]:
                raise ValueError("Decoded corpus exceeds its declared complete size")
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    _verify_record(pending, manifest)
    for name, value in metadata.items():
        with (destination / name).open("xb") as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
    # Publish only after data and attribution are complete. link refuses replacement.
    os.link(pending, record_path)
    pending.unlink()
    compressed.unlink()
    return {"status": "installed", "file": str(record_path), **manifest}


def install_corpus(destination: Path, archive: Path | None = None) -> dict:
    """Install only the corpus pinned by the benchmark's publication contract."""
    from benchmarks.publication_contracts import (
        ACTION_CALLING_DATASET_ROW_COUNT,
        ACTION_CALLING_DATASET_SHA256,
    )

    manifest = json.loads((BUNDLE / "manifest.json").read_text())
    if (manifest["recordCount"], manifest["recordSha256"]) != (
        ACTION_CALLING_DATASET_ROW_COUNT,
        ACTION_CALLING_DATASET_SHA256,
    ):
        raise ValueError("Installer and benchmark corpus contracts disagree")
    return _install(destination, archive, BUNDLE)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--destination",
        type=Path,
        required=True,
        help="Fresh corpus directory, or a complete installation to verify",
    )
    parser.add_argument(
        "--archive",
        type=Path,
        help="Offline copy of the exact pinned .jsonl.gz archive",
    )
    args = parser.parse_args()
    try:
        result = install_corpus(args.destination, args.archive)
    except (OSError, ValueError, EOFError, HTTPException) as error:
        # error-policy:J1 Report the failed attempt without accepting partial data.
        parser.exit(
            1,
            f"Corpus installation failed: {error}. Existing files were preserved; use a fresh destination for a failed attempt.\n",
        )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
