#!/usr/bin/env python3
"""Unit tests for Chipyard Verilator preflight blockers."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_chipyard_verilator_preflight as preflight  # noqa: E402


def test_disk_space_blocker_requires_configured_headroom() -> None:
    blocker = preflight.disk_space_blocker(19 * 1024**3, min_free_gib=20)
    if blocker is None:
        raise AssertionError("expected low-disk blocker")
    if "19.00 GiB free" not in blocker or "20 GiB required" not in blocker:
        raise AssertionError(blocker)

    if preflight.disk_space_blocker(20 * 1024**3, min_free_gib=20) is not None:
        raise AssertionError("threshold free space should pass")


def main() -> int:
    tests = (test_disk_space_blocker_requires_configured_headroom,)
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
