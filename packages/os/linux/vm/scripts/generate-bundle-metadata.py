#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


VM_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARTIFACTS = {
    "qemu": {
        "path": "disk-base.qcow2",
        "format": "qcow2",
        "architecture": "x86_64",
        "boot_mode": "bios",
    },
    "utm": {
        "path": "output/usbeliza.utm.zip",
        "format": "utm",
        "architecture": "x86_64",
        "boot_mode": "bios",
    },
    "virtualbox": {
        "path": "output/usbeliza-virtualbox.ova",
        "format": "ova",
        "architecture": "x86_64",
        "boot_mode": "bios",
    },
}


def iso_timestamp() -> str:
    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if source_date_epoch:
        return datetime.fromtimestamp(int(source_date_epoch), timezone.utc).isoformat().replace("+00:00", "Z")
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def git_revision() -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=VM_ROOT,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_record(name: str, spec: dict[str, str], base_dir: Path) -> dict[str, object]:
    path = (base_dir / spec["path"]).resolve()
    exists = path.is_file()
    record: dict[str, object] = {
        "name": name,
        "path": spec["path"],
        "format": spec["format"],
        "architecture": spec["architecture"],
        "boot_mode": spec["boot_mode"],
        "exists": exists,
        "size_bytes": path.stat().st_size if exists else None,
        "sha256": sha256_file(path) if exists else None,
    }
    return record


def build_manifest(args: argparse.Namespace) -> dict[str, object]:
    artifacts = [
        artifact_record(name, spec, VM_ROOT)
        for name, spec in DEFAULT_ARTIFACTS.items()
        if name in args.targets
    ]
    missing = [artifact["name"] for artifact in artifacts if not artifact["exists"]]
    if args.require_images and missing:
        joined = ", ".join(missing)
        raise SystemExit(f"error: required VM image artifacts are missing: {joined}")

    return {
        "schema_version": 1,
        "bundle_id": args.bundle_id,
        "version": args.version,
        "generated_at": iso_timestamp(),
        "source": {
            "repository_path": str(VM_ROOT),
            "git_revision": git_revision(),
        },
        "host": {
            "system": platform.system(),
            "machine": platform.machine(),
        },
        "artifacts": artifacts,
        "hardware_requirements": {
            "qemu": {
                "requires": ["x86_64 CPU", "QEMU"],
                "recommended": ["KVM on Linux or HVF on Intel macOS"],
                "notes": "The scripted harness in scripts/boot.sh requires Linux KVM. Metadata generation does not.",
            },
            "utm": {
                "requires": ["macOS", "UTM"],
                "recommended": ["Intel Mac for x86_64 virtualization"],
                "notes": "Apple Silicon can emulate this x86_64 image, but that is slower and not the CI path.",
            },
            "virtualbox": {
                "requires": ["VirtualBox", "x86_64 host CPU with VT-x or AMD-V"],
                "recommended": ["Intel/AMD Linux, Windows, or macOS host"],
                "notes": "This x86_64 appliance is not a native Apple Silicon VirtualBox target.",
            },
        },
        "quickstarts": {
            "qemu": "quickstarts/qemu.md",
            "utm": "quickstarts/utm.md",
            "virtualbox": "quickstarts/virtualbox.md",
        },
    }


def build_package_metadata(manifest: dict[str, object]) -> dict[str, object]:
    docs = ["README.md", "quickstarts/qemu.md", "quickstarts/utm.md", "quickstarts/virtualbox.md"]
    present_docs = [path for path in docs if (VM_ROOT / path).is_file()]
    return {
        "schema_version": 1,
        "bundle_id": manifest["bundle_id"],
        "version": manifest["version"],
        "generated_at": manifest["generated_at"],
        "manifest": "manifest.json",
        "metadata_files": ["manifest.json", "package-metadata.json", *present_docs],
        "image_files": [
            artifact["path"]
            for artifact in manifest["artifacts"]
            if artifact["exists"]
        ],
        "missing_image_files": [
            artifact["path"]
            for artifact in manifest["artifacts"]
            if not artifact["exists"]
        ],
        "can_generate_without_images": True,
    }


def write_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate usbeliza VM bundle metadata.")
    parser.add_argument("--output-dir", default="output/bundle-metadata", help="Directory for manifest.json and package-metadata.json.")
    parser.add_argument("--bundle-id", default="usbeliza-vm", help="Stable bundle identifier.")
    parser.add_argument("--version", default="dev", help="Bundle version label.")
    parser.add_argument(
        "--target",
        action="append",
        choices=sorted(DEFAULT_ARTIFACTS),
        dest="targets",
        help="Target to include. May be repeated. Defaults to all targets.",
    )
    parser.add_argument("--require-images", action="store_true", help="Fail if selected VM image artifacts are absent.")
    args = parser.parse_args(argv)
    args.targets = args.targets or sorted(DEFAULT_ARTIFACTS)
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    output_dir = (VM_ROOT / args.output_dir).resolve()
    manifest = build_manifest(args)
    package_metadata = build_package_metadata(manifest)
    write_json(output_dir / "manifest.json", manifest)
    write_json(output_dir / "package-metadata.json", package_metadata)
    print(f"wrote {output_dir / 'manifest.json'}")
    print(f"wrote {output_dir / 'package-metadata.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
