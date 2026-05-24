#!/usr/bin/env python3
"""Refresh reproducible AOSP build provenance inside the staged Eliza APK."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

import check_android_system_apk_payload as payload_gate


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
DEFAULT_APK = payload_gate.DEFAULT_APK
PROVENANCE_ENTRY = payload_gate.PROVENANCE_ENTRY
RUNTIME_PROVENANCE_ENTRY = payload_gate.RUNTIME_PROVENANCE_ENTRY


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return path.as_posix()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fp:
        for chunk in iter(lambda: fp.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_git_revision() -> str | None:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=WORKSPACE.parent,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def read_zip_json(apk: Path, entry: str) -> dict[str, Any] | None:
    try:
        with zipfile.ZipFile(apk) as zf:
            value = json.loads(zf.read(entry).decode("utf-8"))
    except (KeyError, json.JSONDecodeError, UnicodeDecodeError, zipfile.BadZipFile):
        return None
    return value if isinstance(value, dict) else None


def copy_without_provenance(source: Path, target: Path) -> None:
    with zipfile.ZipFile(source, "r") as src, zipfile.ZipFile(
        target, "w", compression=zipfile.ZIP_DEFLATED
    ) as dst:
        seen: set[str] = set()
        for info in src.infolist():
            if info.filename == PROVENANCE_ENTRY or info.filename in seen:
                continue
            seen.add(info.filename)
            dst.writestr(info, src.read(info.filename))


def provenance_payload(apk_without_provenance: Path, apk_name: str) -> dict[str, Any]:
    runtime_provenance = read_zip_json(apk_without_provenance, RUNTIME_PROVENANCE_ENTRY)
    runtime_bytes = b""
    if runtime_provenance is not None:
        with zipfile.ZipFile(apk_without_provenance) as zf:
            runtime_bytes = zf.read(RUNTIME_PROVENANCE_ENTRY)
    return {
        "schema": payload_gate.AOSP_PROVENANCE_SCHEMA,
        "claim_boundary": payload_gate.AOSP_PROVENANCE_CLAIM_BOUNDARY,
        "repo_root": ".",
        "repo_root_provenance": "relative_to_git_checkout",
        "git_revision": current_git_revision(),
        "apk_name": apk_name,
        "apk_sha256_before_provenance": sha256_file(apk_without_provenance),
        "runtime_provenance_entry": RUNTIME_PROVENANCE_ENTRY,
        "runtime_provenance_sha256": (
            hashlib.sha256(runtime_bytes).hexdigest() if runtime_bytes else None
        ),
        "runtime_provenance": runtime_provenance,
        "android_system_variant": "Eliza",
        "android_package": "ai.elizaos.app",
    }


def refresh_apk(apk: Path) -> dict[str, Any]:
    if not apk.is_file():
        raise FileNotFoundError(rel(apk))
    with tempfile.TemporaryDirectory(prefix="eliza-apk-provenance-") as tmp_text:
        tmp = Path(tmp_text)
        without_provenance = tmp / "without-provenance.apk"
        refreshed = tmp / "refreshed.apk"
        copy_without_provenance(apk, without_provenance)
        copy_without_provenance(without_provenance, refreshed)
        provenance = provenance_payload(without_provenance, apk.name)
        with zipfile.ZipFile(refreshed, "a", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                PROVENANCE_ENTRY,
                json.dumps(provenance, indent=2, sort_keys=True).encode("utf-8") + b"\n",
            )
        apk.write_bytes(refreshed.read_bytes())
    return provenance


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", type=Path, default=DEFAULT_APK)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    provenance = refresh_apk(args.apk.resolve())
    print(
        "refreshed AOSP APK provenance: "
        f"apk={rel(args.apk.resolve())} "
        f"apk_name={provenance['apk_name']} "
        f"repo_root={provenance['repo_root']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
