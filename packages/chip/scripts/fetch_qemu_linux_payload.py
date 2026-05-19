#!/usr/bin/env python3
"""Fetch a real riscv64 QEMU Linux payload from Debian netboot artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE_URL = (
    "https://snapshot.debian.org/archive/debian/20260517T000000Z/dists/trixie/main/"
    "installer-riscv64/current/images"
)
DEFAULT_SNAPSHOT_TIMESTAMP = "20260517T000000Z"
DEFAULT_INSTALLER_PACKAGE_VERSION = "20250803+deb13u5"
PAYLOADS = {
    "linux": "netboot/debian-installer/riscv64/linux",
    "initrd.gz": "netboot/debian-installer/riscv64/initrd.gz",
}


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".tmp")
    tmp.unlink(missing_ok=True)
    destination.unlink(missing_ok=True)
    command = [
        "curl",
        "--fail",
        "--location",
        "--retry",
        "3",
        "--connect-timeout",
        "15",
        "--max-time",
        "900",
        "--output",
        str(tmp),
        url,
    ]
    try:
        subprocess.run(command, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        with urllib.request.urlopen(url, timeout=900) as response:
            tmp.write_bytes(response.read())
    if not tmp.is_file():
        raise FileNotFoundError(f"download completed without writing {tmp}")
    tmp.replace(destination)


def fetch_verified(url: str, destination: Path, expected_hash: str, *, force: bool) -> str:
    if force or not destination.is_file():
        if force:
            destination.unlink(missing_ok=True)
            destination.with_suffix(destination.suffix + ".tmp").unlink(missing_ok=True)
        print(f"fetch {url}", flush=True)
        fetch(url, destination)
    actual_hash = sha256_path(destination)
    if actual_hash == expected_hash:
        return actual_hash

    destination.unlink(missing_ok=True)
    destination.with_suffix(destination.suffix + ".tmp").unlink(missing_ok=True)
    print(
        f"warning: sha256 mismatch for {destination.relative_to(ROOT)}; retrying clean download",
        file=sys.stderr,
        flush=True,
    )
    fetch(url, destination)
    actual_hash = sha256_path(destination)
    if actual_hash != expected_hash:
        destination.unlink(missing_ok=True)
        destination.with_suffix(destination.suffix + ".tmp").unlink(missing_ok=True)
        raise ValueError(
            f"sha256 mismatch for {destination}: expected {expected_hash}, got {actual_hash}"
        )
    return actual_hash


def parse_sha256s(text: str) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) != 2:
            continue
        digest, rel = parts
        hashes[rel.removeprefix("./")] = digest
    return hashes


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument(
        "--output-dir",
        default="build/qemu/linux_payload/debian-installer-riscv64-20260517T000000Z",
        help="Directory for downloaded linux/initrd.gz artifacts.",
    )
    parser.add_argument("--force", action="store_true", help="Download even when files exist.")
    args = parser.parse_args(argv)

    base_url = args.base_url.rstrip("/")
    out_dir = ROOT / args.output_dir
    sha_url = f"{base_url}/SHA256SUMS"
    sha_file = out_dir / "SHA256SUMS"
    print(f"fetch {sha_url}", flush=True)
    fetch(sha_url, sha_file)
    expected = parse_sha256s(sha_file.read_text(encoding="utf-8", errors="ignore"))

    manifest: dict[str, object] = {
        "schema": "eliza.qemu_linux_payload.v1",
        "claim_boundary": "qemu_virt_debian_netboot_payload_only",
        "created_utc": utc_now(),
        "base_url": base_url,
        "snapshot_timestamp": DEFAULT_SNAPSHOT_TIMESTAMP
        if DEFAULT_SNAPSHOT_TIMESTAMP in base_url
        else "",
        "debian_installer_package_version": DEFAULT_INSTALLER_PACKAGE_VERSION,
        "sha256s_url": sha_url,
        "payloads": {},
    }
    payloads: dict[str, object] = {}
    for name, rel_url in PAYLOADS.items():
        expected_hash = expected.get(rel_url)
        if not expected_hash:
            print(f"error: SHA256SUMS lacks {rel_url}", file=sys.stderr)
            return 1
        destination = out_dir / name
        url = f"{base_url}/{rel_url}"
        try:
            actual_hash = fetch_verified(url, destination, expected_hash, force=args.force)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        payloads[name] = {
            "path": str(destination.relative_to(ROOT)),
            "url": url,
            "sha256": actual_hash,
            "bytes": destination.stat().st_size,
        }
        print(f"verified {destination.relative_to(ROOT)} sha256={actual_hash}", flush=True)

    manifest["payloads"] = payloads
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"wrote {manifest_path.relative_to(ROOT)}", flush=True)
    print("next: scripts/run_qemu.sh --check-os", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
