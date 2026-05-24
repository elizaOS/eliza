#!/usr/bin/env python3
"""Validate that a multiarch ISO carries the graphical kiosk payload."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "evidence/multiarch_boot_matrix.json"
DEFAULT_ARCH = "riscv64"
SQUASHFS = "live/filesystem.squashfs"

REQUIRED_SQUASHFS_PATHS = {
    "cage": "squashfs-root/usr/bin/cage",
    "epiphany_browser": "squashfs-root/usr/bin/epiphany-browser",
    "grim": "squashfs-root/usr/bin/grim",
    "xorg": "squashfs-root/usr/bin/Xorg",
    "seatd_service": "squashfs-root/usr/lib/systemd/system/seatd.service",
    "kiosk_service": "squashfs-root/etc/systemd/system/elizaos-kiosk.service",
    "kiosk_enabled": "squashfs-root/etc/systemd/system/graphical.target.wants/elizaos-kiosk.service",
    "seatd_enabled": "squashfs-root/etc/systemd/system/multi-user.target.wants/seatd.service",
    "virtio_gpu_modules": "squashfs-root/etc/modules-load.d/elizaos-virtio-gpu.conf",
    "start_cage": "squashfs-root/usr/local/lib/elizaos/start-cage",
    "start_kiosk": "squashfs-root/usr/local/lib/elizaos/start-kiosk",
}

ARCH_RUNTIME_SQUASHFS_PATHS = {
    "arm64": {
        "bun": "squashfs-root/opt/elizaos/bin/bun",
        "node": "squashfs-root/usr/bin/node",
        "agent_bundle": "squashfs-root/opt/elizaos/app/agent-bundle.js",
    },
    "riscv64": {
        "node": "squashfs-root/usr/bin/node",
        "agent_bundle": "squashfs-root/opt/elizaos/app/agent-bundle.js",
    },
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def default_out_for_arch(arch: str) -> Path:
    return ROOT / f"evidence/{arch}_gui_kiosk_iso_check.json"


def latest_out_iso(arch: str) -> Path | None:
    out_dir = ROOT / "out"
    if not out_dir.is_dir():
        return None
    candidates = sorted(
        out_dir.glob(f"elizaos-linux-{arch}-*.iso"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def default_iso_from_matrix(arch: str) -> Path:
    matrix = json.loads(MATRIX.read_text(encoding="utf-8"))
    for row in matrix.get("architectures", []):
        if isinstance(row, dict) and row.get("arch") == arch:
            iso = row.get("iso")
            if isinstance(iso, str) and iso:
                return ROOT / iso
    fallback = latest_out_iso(arch)
    if fallback is not None:
        return fallback
    article = "an" if arch[0].lower() in {"a"} else "a"
    raise ValueError(
        f"multiarch boot matrix does not record {article} {arch} ISO and no "
        f"elizaos-linux-{arch}-*.iso exists under out/"
    )


def squashfs_listing(iso: Path) -> list[str]:
    if shutil.which("bsdtar") is None:
        raise RuntimeError("bsdtar is required to extract live/filesystem.squashfs")
    if shutil.which("unsquashfs") is None:
        raise RuntimeError("unsquashfs is required to inspect live/filesystem.squashfs")
    with tempfile.TemporaryDirectory(prefix="elizaos-gui-iso-") as tmp:
        squashfs = Path(tmp) / "filesystem.squashfs"
        with squashfs.open("wb") as handle:
            extract = subprocess.run(
                ["bsdtar", "-xOf", str(iso), SQUASHFS],
                stdout=handle,
                stderr=subprocess.PIPE,
                text=False,
                check=False,
            )
        if extract.returncode != 0:
            stderr = extract.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"failed to extract {SQUASHFS}: {stderr.strip()}")
        listing = subprocess.run(
            ["unsquashfs", "-ll", str(squashfs)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if listing.returncode != 0:
            raise RuntimeError(f"unsquashfs listing failed: {listing.stderr.strip()}")
        return listing.stdout.splitlines()


def path_present(listing: list[str], squashfs_path: str) -> bool:
    suffix = " " + squashfs_path
    link_prefix = squashfs_path + " -> "
    for line in listing:
        if line.endswith(suffix) or f" {link_prefix}" in line:
            return True
    return False


def required_paths_for_arch(arch: str) -> dict[str, str]:
    return {**REQUIRED_SQUASHFS_PATHS, **ARCH_RUNTIME_SQUASHFS_PATHS.get(arch, {})}


def build_report(iso: Path, arch: str) -> dict[str, Any]:
    listing = squashfs_listing(iso)
    required_paths = required_paths_for_arch(arch)
    checks = {
        name: {"path": path, "present": path_present(listing, path)}
        for name, path in required_paths.items()
    }
    missing = [name for name, item in checks.items() if not item["present"]]
    return {
        "schema": "eliza.os.linux.gui_kiosk_iso_check.v1",
        "status": "pass" if not missing else "fail",
        "arch": arch,
        "claim_boundary": (
            "static ISO squashfs payload check for graphical kiosk dependencies; "
            "not a pixel-rendered GUI runtime screenshot or physical display claim"
        ),
        "iso": {
            "path": rel(iso),
            "sha256": sha256_file(iso),
            "bytes": iso.stat().st_size,
        },
        "squashfs": SQUASHFS,
        "checks": checks,
        "missing": missing,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arch", choices=("arm64", "riscv64"), default=DEFAULT_ARCH)
    parser.add_argument("--iso", type=Path, default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)

    out_arg = args.out if args.out is not None else default_out_for_arch(args.arch)
    try:
        iso = args.iso if args.iso is not None else default_iso_from_matrix(args.arch)
    except ValueError as exc:
        out = out_arg if out_arg.is_absolute() else ROOT / out_arg
        out.parent.mkdir(parents=True, exist_ok=True)
        report = {
            "schema": "eliza.os.linux.gui_kiosk_iso_check.v1",
            "status": "blocked",
            "arch": args.arch,
            "claim_boundary": (
                "static ISO squashfs payload check for graphical kiosk dependencies; "
                "not a pixel-rendered GUI runtime screenshot or physical display claim"
            ),
            "blockers": [str(exc)],
            "checks": {},
            "missing": list(required_paths_for_arch(args.arch)),
        }
        out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"STATUS: BLOCKED {args.arch}.gui_kiosk_iso - {exc}; report={rel(out)}")
        return 2
    if not iso.is_absolute():
        iso = (ROOT / iso).resolve()
    if not iso.is_file():
        out = out_arg if out_arg.is_absolute() else ROOT / out_arg
        out.parent.mkdir(parents=True, exist_ok=True)
        report = {
            "schema": "eliza.os.linux.gui_kiosk_iso_check.v1",
            "status": "blocked",
            "arch": args.arch,
            "claim_boundary": (
                "static ISO squashfs payload check for graphical kiosk dependencies; "
                "not a pixel-rendered GUI runtime screenshot or physical display claim"
            ),
            "iso": {"path": rel(iso), "exists": False},
            "blockers": [f"missing ISO: {rel(iso)}"],
            "checks": {},
            "missing": list(required_paths_for_arch(args.arch)),
        }
        out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(
            f"STATUS: BLOCKED {args.arch}.gui_kiosk_iso - missing ISO: {rel(iso)}; "
            f"report={rel(out)}"
        )
        return 2

    try:
        report = build_report(iso, args.arch)
    except RuntimeError as exc:
        print(f"STATUS: BLOCKED {args.arch}.gui_kiosk_iso - {exc}")
        return 2

    out = out_arg if out_arg.is_absolute() else ROOT / out_arg
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if report["status"] == "pass":
        print(f"STATUS: PASS {args.arch}.gui_kiosk_iso report={rel(out)}")
        return 0
    print(f"STATUS: FAIL {args.arch}.gui_kiosk_iso report={rel(out)}")
    for name in report["missing"]:
        print(f"  - {name}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
