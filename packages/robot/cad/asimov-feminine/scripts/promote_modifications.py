"""Promote approved modified STL files from output/modified/ back to assets/profiles/asimov-1/meshes/.

Run with --dry-run first, then --apply after review.
"""
import argparse
import hashlib
import shutil
from pathlib import Path

WORKSPACE = Path(__file__).parent.parent
MODIFIED_DIR = WORKSPACE / "output/modified"
ASSET_DIR = WORKSPACE.parent.parent / "assets/profiles/asimov-1/meshes"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def promote(dry_run: bool = True):
    modified = list(MODIFIED_DIR.glob("*.STL"))
    if not modified:
        print("No modified STL files found in output/modified/")
        return

    print(f"{'DRY RUN — ' if dry_run else ''}Promoting {len(modified)} files\n")
    for src in sorted(modified):
        dst = ASSET_DIR / src.name
        src_hash = sha256(src)
        dst_hash = sha256(dst) if dst.exists() else "new"
        changed = src_hash != dst_hash
        action = "COPY" if changed else "SAME"
        print(f"  [{action}] {src.name}  {dst_hash} → {src_hash}")
        if changed and not dry_run:
            shutil.copy2(src, dst)

    if dry_run:
        print("\nRun with --apply to actually promote.")
    else:
        print("\nPromotion complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    promote(dry_run=not args.apply)
