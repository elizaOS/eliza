"""Streaming integrity checks for model and release artifacts."""

import hashlib
from pathlib import Path


def sha256_file(path: Path, chunk: int = 1024 * 1024) -> str:
    if chunk <= 0:
        raise ValueError("hash chunk size must be positive")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()
