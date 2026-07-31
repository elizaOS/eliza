#!/usr/bin/env python3
"""Rewrites a validated .skill ZIP with stable ordering and metadata."""

import os
import sys
import tempfile
import zipfile
from pathlib import Path


def normalize_archive(archive_path: Path) -> None:
    """Make identical packaged contents produce byte-identical ZIP archives."""
    with zipfile.ZipFile(archive_path, "r") as source:
        entries = source.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("skill archive contains duplicate paths")
        contents = {entry.filename: source.read(entry) for entry in entries}

    descriptor, temporary_name = tempfile.mkstemp(
        dir=archive_path.parent,
        prefix=f".{archive_path.name}.",
        suffix=".tmp",
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
        ) as target:
            for name in sorted(names):
                entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                target.writestr(
                    entry,
                    contents[name],
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )
        os.replace(temporary_path, archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: normalize-skill-archive.py <archive.skill>")
    archive_path = Path(sys.argv[1]).resolve()
    if not archive_path.is_file():
        raise FileNotFoundError(f"skill archive does not exist: {archive_path}")
    normalize_archive(archive_path)


if __name__ == "__main__":
    main()
