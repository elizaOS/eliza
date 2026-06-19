"""Import-path helper for the legacy ``benchmarks.mmau`` shim."""

from __future__ import annotations

import sys
from pathlib import Path


def ensure_mmau_audio_path() -> None:
    package_root = Path(__file__).resolve().parents[1] / "mmau-audio"
    if package_root.is_dir():
        path = str(package_root)
        if path not in sys.path:
            sys.path.insert(0, path)

