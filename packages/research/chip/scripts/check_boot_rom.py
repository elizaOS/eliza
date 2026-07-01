#!/usr/bin/env python3
"""Top-level entrypoint for the boot ROM artifact/release-evidence check."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "fw/boot-rom/check_boot_rom.py"


def main() -> int:
    try:
        runpy.run_path(str(CHECKER), run_name="__main__")
    except SystemExit as exc:
        return int(exc.code or 0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
