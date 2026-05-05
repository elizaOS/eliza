#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)
DEFAULT_RELEASE_ROOT = Path(__file__).resolve().parents[4] / "releases" / "scam-defense-managed"


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object at {path}")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_symlink(path: Path, target: Path) -> None:
    if path.exists() or path.is_symlink():
        path.unlink()
    path.symlink_to(target)


def release_id_for(label: str) -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in label).strip("-")
    return f"{slug}-{timestamp}"


def current_manifest_path(release_root: Path) -> Path:
    return release_root / "current.json"


def previous_manifest_path(release_root: Path) -> Path:
    return release_root / "previous.json"


def load_optional_manifest(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return load_json(path)


def validate_release_dir(release_dir: Path) -> dict[str, Any]:
    manifest_path = release_dir / "release_manifest.json"
    if not manifest_path.exists():
        raise ValueError(f"Release manifest not found: {manifest_path}")
    manifest = load_json(manifest_path)

    dataset_repo = manifest.get("dataset_repo")
    if not isinstance(dataset_repo, str) or not Path(dataset_repo).exists():
        raise ValueError(f"Dataset repo missing for release: {dataset_repo}")

    models = manifest.get("models")
    if not isinstance(models, list) or not models:
        raise ValueError("Release manifest must include at least one model.")
    for model in models:
        if not isinstance(model, dict):
            raise ValueError("Release manifest model entry is invalid.")
        repo_dir = model.get("repo_dir")
        if not isinstance(repo_dir, str) or not Path(repo_dir).exists():
            raise ValueError(f"Model repo missing for release: {repo_dir}")

    return manifest


def promote_release(
    *,
    release_dir: Path,
    release_root: Path,
    label: str,
) -> dict[str, Any]:
    release_dir = release_dir.resolve()
    source_manifest = validate_release_dir(release_dir)

    previous_current = load_optional_manifest(current_manifest_path(release_root))
    release_id = release_id_for(label)
    record_dir = release_root / "releases" / release_id
    record_dir.mkdir(parents=True, exist_ok=False)

    record = {
        "release_id": release_id,
        "label": label,
        "promoted_at": datetime.now(timezone.utc).isoformat(),
        "source_release_dir": str(release_dir),
        "source_release_manifest": str((release_dir / "release_manifest.json").resolve()),
        "dataset_repo": str(source_manifest["dataset_repo"]),
        "model_count": len(source_manifest["models"]),
        "recommended_models": source_manifest.get("recommended_models", {}),
        "previous_release_id": previous_current.get("release_id") if previous_current else None,
    }
    write_json(record_dir / "manifest.json", record)
    write_symlink(record_dir / "bundle", release_dir)

    if previous_current is not None:
        write_json(previous_manifest_path(release_root), previous_current)
        previous_target = release_root / "releases" / str(previous_current["release_id"])
        if previous_target.exists():
            write_symlink(release_root / "previous", previous_target)

    write_json(current_manifest_path(release_root), record)
    write_symlink(release_root / "current", record_dir)
    LOGGER.info("Promoted scam-defense release %s from %s", release_id, release_dir)
    return record


def rollback_release(
    *,
    release_root: Path,
    target_release_id: str | None,
) -> dict[str, Any]:
    current_manifest = load_optional_manifest(current_manifest_path(release_root))
    if current_manifest is None:
        raise ValueError("No current release manifest found.")

    if target_release_id:
        target_path = release_root / "releases" / target_release_id / "manifest.json"
    else:
        target_path = previous_manifest_path(release_root)
    if not target_path.exists():
        raise ValueError("Rollback target manifest not found.")

    target_manifest = load_json(target_path)
    target_dir = release_root / "releases" / str(target_manifest["release_id"])
    if not target_dir.exists():
        raise ValueError(f"Rollback target directory missing: {target_dir}")

    write_json(previous_manifest_path(release_root), current_manifest)
    write_json(current_manifest_path(release_root), target_manifest)
    write_symlink(release_root / "current", target_dir)
    write_symlink(
        release_root / "previous",
        release_root / "releases" / str(current_manifest["release_id"]),
    )

    event = {
        "rolled_back_at": datetime.now(timezone.utc).isoformat(),
        "from_release_id": current_manifest["release_id"],
        "to_release_id": target_manifest["release_id"],
    }
    rollback_log = release_root / "rollback_events.jsonl"
    with rollback_log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")
    LOGGER.info(
        "Rolled back scam-defense release from %s to %s",
        current_manifest["release_id"],
        target_manifest["release_id"],
    )
    return event


def status_release(release_root: Path) -> dict[str, Any]:
    return {
        "current": load_optional_manifest(current_manifest_path(release_root)),
        "previous": load_optional_manifest(previous_manifest_path(release_root)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Promote and rollback scam-defense release bundles."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    promote = subparsers.add_parser("promote")
    promote.add_argument("--release-dir", required=True)
    promote.add_argument("--release-root", default=str(DEFAULT_RELEASE_ROOT))
    promote.add_argument("--label", default="scam-defense")

    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("--release-root", default=str(DEFAULT_RELEASE_ROOT))
    rollback.add_argument("--target-release-id", default="")

    status = subparsers.add_parser("status")
    status.add_argument("--release-root", default=str(DEFAULT_RELEASE_ROOT))

    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    release_root = Path(args.release_root).resolve()
    release_root.mkdir(parents=True, exist_ok=True)

    try:
        if args.command == "promote":
            payload = promote_release(
                release_dir=Path(args.release_dir).resolve(),
                release_root=release_root,
                label=args.label,
            )
        elif args.command == "rollback":
            payload = rollback_release(
                release_root=release_root,
                target_release_id=args.target_release_id or None,
            )
        else:
            payload = status_release(release_root)

        print(json.dumps(payload, indent=2))
        return 0
    except Exception:
        LOGGER.exception("Scam-defense release management failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
