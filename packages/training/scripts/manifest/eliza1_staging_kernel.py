"""Owns the profile-driven filesystem graph shared by Eliza-1 bundle stagers."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

CHECKSUM_PATH = Path("checksums/SHA256SUMS")


@dataclass(frozen=True, slots=True)
class StagingProfile:
    name: str
    release_dirs: tuple[str, ...]
    conditional_dirs: Mapping[str, frozenset[str]]


@dataclass(frozen=True, slots=True)
class StagedFile:
    role: str
    source: str
    destination: str
    sha256: str
    sizeBytes: int
    method: str
    provenance: str


def now_iso() -> str:
    return datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for block in iter(lambda: file_handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def json_write(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def text_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def link_or_copy(source: Path, destination: Path) -> str:
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        shutil.copy2(source, destination)
        return "copy"


def stage_file(
    *, role: str, source: Path, destination: Path, provenance: str, force: bool
) -> StagedFile:
    source = source.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_sha = sha256_file(source)
    if destination.exists():
        destination_sha = sha256_file(destination)
        if destination_sha == source_sha:
            method = "existing"
        elif force:
            destination.unlink()
            method = link_or_copy(source, destination)
        else:
            raise FileExistsError(
                f"{destination} already exists with sha256 {destination_sha}; "
                f"expected {source_sha}. Re-run with --force to replace it."
            )
    else:
        method = link_or_copy(source, destination)
    return StagedFile(
        role=role,
        source=str(source),
        destination=str(destination),
        sha256=source_sha,
        sizeBytes=destination.stat().st_size,
        method=method,
        provenance=provenance,
    )


def ensure_release_dirs(bundle_dir: Path, profile: StagingProfile, tier: str) -> None:
    for relative in profile.release_dirs:
        allowed_tiers = profile.conditional_dirs.get(relative)
        if allowed_tiers is not None and tier not in allowed_tiers:
            continue
        (bundle_dir / relative).mkdir(parents=True, exist_ok=True)


def all_checksum_inputs(bundle_dir: Path) -> list[Path]:
    return [
        path
        for path in sorted(bundle_dir.rglob("*"))
        if path.is_file()
        and path.relative_to(bundle_dir) != CHECKSUM_PATH
        and not any(part.startswith(".") for part in path.relative_to(bundle_dir).parts)
    ]


def write_checksum_manifest(bundle_dir: Path) -> Path:
    checksum_path = bundle_dir / CHECKSUM_PATH
    checksum_path.parent.mkdir(parents=True, exist_ok=True)
    checksum_path.write_text(
        "\n".join(
            f"{sha256_file(path)}  {path.relative_to(bundle_dir)}"
            for path in all_checksum_inputs(bundle_dir)
        )
        + "\n"
    )
    return checksum_path


def validate_checksum_manifest(bundle_dir: Path) -> tuple[str, ...]:
    checksum_path = bundle_dir / CHECKSUM_PATH
    if not checksum_path.is_file():
        return (f"missing {CHECKSUM_PATH}",)
    recorded: dict[str, str] = {}
    errors: list[str] = []
    for line_number, raw in enumerate(checksum_path.read_text().splitlines(), start=1):
        if not raw.strip():
            continue
        parts = raw.split(None, 1)
        if len(parts) != 2:
            errors.append(f"{CHECKSUM_PATH}:{line_number}: expected '<sha>  <path>'")
            continue
        recorded[parts[1].strip()] = parts[0]
    for path in all_checksum_inputs(bundle_dir):
        relative = str(path.relative_to(bundle_dir))
        if relative not in recorded:
            errors.append(f"{CHECKSUM_PATH}: missing {relative}")
        elif recorded[relative] != sha256_file(path):
            errors.append(f"{CHECKSUM_PATH}: checksum mismatch for {relative}")
    return tuple(errors)


def profile_graph(profile: StagingProfile, tier: str) -> tuple[str, ...]:
    """Return the deterministic directory graph used by drift tests and tooling."""
    return tuple(
        relative
        for relative in profile.release_dirs
        if profile.conditional_dirs.get(relative) is None
        or tier in profile.conditional_dirs[relative]
    )
