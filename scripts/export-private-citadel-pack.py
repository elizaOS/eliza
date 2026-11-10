#!/usr/bin/env python3
"""Write an owner-only archive outside the public site tree."""

import os
import pathlib
import sys
import tarfile

SKIP_NAMES = {".env", ".env.local", ".env.production", ".env.development"}
SKIP_SUFFIXES = {".pem", ".key"}


def rejected(path):
    name = path.name
    if name in SKIP_NAMES or name.startswith(".env"):
        return True
    if path.suffix.lower() in SKIP_SUFFIXES:
        return True
    lowered = name.lower()
    if "private_key" in lowered or lowered.endswith(".p12"):
        return True
    return False


def export_pack(source, destination):
    source = pathlib.Path(source).resolve()
    destination = pathlib.Path(destination).resolve()
    if "website" in destination.parts or "site-build" in destination.parts:
        raise SystemExit("refusing to write inside the public site")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz") as archive:
        for path in sorted(source.rglob("*")):
            if not path.is_file() or rejected(path):
                continue
            data = path.read_bytes()
            if b"BEGIN PRIVATE KEY" in data or b"BEGIN RSA PRIVATE KEY" in data:
                continue
            archive.add(path, arcname=str(path.relative_to(source.parent)))
    os.chmod(destination, 0o600)
    return destination


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: export-private-citadel-pack.py SOURCE DESTINATION")
    print(export_pack(sys.argv[1], sys.argv[2]))
