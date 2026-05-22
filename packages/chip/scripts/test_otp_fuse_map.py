#!/usr/bin/env python3
"""Positive and negative vectors for the OTP fuse-map checker."""

from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

CHECK_PATH = ROOT / "scripts/check_otp_fuse_map.py"
_spec = importlib.util.spec_from_file_location("check_otp_fuse_map", CHECK_PATH)
if _spec is None or _spec.loader is None:
    raise SystemExit(f"unable to import {CHECK_PATH}")
check_otp = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = check_otp
_spec.loader.exec_module(check_otp)

from chip_utils import load_json_object  # noqa: E402


def _fuse_map() -> dict:
    return load_json_object(check_otp.DEFAULT_FUSE_MAP)


def test_default_fuse_map_valid() -> None:
    errors = check_otp.validate(_fuse_map())
    if errors:
        raise AssertionError(errors)
    print("PASS default OTP fuse map valid")


def test_overlapping_partitions_rejected() -> None:
    fuse_map = copy.deepcopy(_fuse_map())
    fuse_map["partitions"][1]["offset"] = 0  # collide with creator_root_key
    errors = check_otp.validate(fuse_map)
    if not any("overlaps" in error for error in errors):
        raise AssertionError(f"expected overlap rejection, got {errors}")
    print("PASS overlapping OTP partitions rejected")


def test_secret_readable_in_production_rejected() -> None:
    fuse_map = copy.deepcopy(_fuse_map())
    fuse_map["partitions"][0]["readableInProduction"] = True
    errors = check_otp.validate(fuse_map)
    if not any("readable in production" in error for error in errors):
        raise AssertionError(f"expected secret-readability rejection, got {errors}")
    print("PASS secret partition readable-in-production rejected")


def test_missing_rollback_index_rejected() -> None:
    fuse_map = copy.deepcopy(_fuse_map())
    fuse_map["partitions"] = [p for p in fuse_map["partitions"] if p["id"] != "rollback_index"]
    errors = check_otp.validate(fuse_map)
    if not any("rollback_index" in error for error in errors):
        raise AssertionError(f"expected rollback_index rejection, got {errors}")
    print("PASS missing rollback_index rejected")


def main() -> int:
    test_default_fuse_map_valid()
    test_overlapping_partitions_rejected()
    test_secret_readable_in_production_rejected()
    test_missing_rollback_index_rejected()
    print("PASS: OTP fuse-map checker tests")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
