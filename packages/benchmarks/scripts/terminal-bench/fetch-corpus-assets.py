"""Restore pinned large benchmark inputs without adding their bytes to Git history."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
from urllib.request import urlopen

SUITE = Path(__file__).resolve().parents[2] / "suites" / "terminal-bench"


def restore_assets(manifest_path: Path, tasks_dir: Path) -> int:
    """Download missing inputs atomically; reject corrupt existing or fetched bytes."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    restored = 0
    for asset in manifest["downloadable_assets"]:
        relative = PurePosixPath(asset["path"])
        if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative):
            raise ValueError(f"Unsafe corpus asset path: {relative}")
        target = tasks_dir / relative
        if not target.resolve().is_relative_to(tasks_dir.resolve()):
            raise ValueError(f"Corpus asset escapes tasks directory: {relative}")
        expected = (asset["bytes"], asset["sha256"])
        if target.exists():
            with target.open("rb") as source:
                digest = hashlib.sha256()
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
                actual = (target.stat().st_size, digest.hexdigest())
            if actual != expected:
                raise ValueError(f"Existing input is corrupt; move it aside and retry: {target}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        # Stage outside tasks/ so incomplete downloads never enter corpus hashing.
        with tempfile.TemporaryDirectory(prefix="terminal-assets-", dir=tasks_dir.parent) as staging:
            pending = Path(staging) / "asset"
            digest = hashlib.sha256()
            size = 0
            with urlopen(asset["url"], timeout=120) as response, pending.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
            if (size, digest.hexdigest()) != expected:
                raise ValueError(f"Downloaded input failed checksum verification: {relative}")
            os.replace(pending, target)
        restored += 1
        print(f"Restored {relative} ({size} bytes)")
    return restored


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=SUITE / "corpus-manifest.json")
    parser.add_argument("--tasks-dir", type=Path, default=SUITE / "tasks")
    args = parser.parse_args()
    restored = restore_assets(args.manifest, args.tasks_dir)
    print(f"Verified all downloadable inputs; restored {restored}.")


if __name__ == "__main__":
    main()
