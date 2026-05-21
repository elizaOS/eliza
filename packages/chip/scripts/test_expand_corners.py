#!/usr/bin/env python3
"""Tests for scripts/expand_corners.py."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CORNER_DIR = ROOT / "pd/corner-manifests"

spec = importlib.util.spec_from_file_location("expand_corners", ROOT / "scripts/expand_corners.py")
if spec is None or spec.loader is None:
    raise RuntimeError("could not import expand_corners.py")
expander = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expander)


def _manifest(stem: str) -> dict[str, Any]:
    data = yaml.safe_load((CORNER_DIR / f"{stem}.yaml").read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise AssertionError(f"{stem} must be a mapping")
    return data


def test_repo_corner_expansion_passes() -> None:
    if expander.main([]) != 0:
        raise AssertionError("repo corner manifests must all meet their declared minimum")


def test_advanced_product_meets_minimum() -> None:
    for stem in ("tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"):
        errors: list[str] = []
        result = expander.expand_manifest(CORNER_DIR / f"{stem}.yaml", errors)
        if result is None:
            raise AssertionError(f"{stem}: expansion returned None: {errors}")
        if errors:
            raise AssertionError(f"{stem}: unexpected errors: {errors}")
        if result["meets_minimum"] is not True:
            raise AssertionError(f"{stem}: must meet total_effective_corners_min")
        if result["effective_corners"] < result["total_effective_corners_min"]:
            raise AssertionError(f"{stem}: effective < minimum")


def test_blocked_axis_product_is_cartesian() -> None:
    manifest = _manifest("tsmc-n2p")
    required = manifest["required_after_unblock"]
    axes = required["pvt_axes"]
    expected = (
        len(axes["process"])
        * len(axes["voltage_v"])
        * len(axes["temperature_c"])
        * len(axes["aging"])
        * len(axes["rc"])
        * len(required["multi_vt_required"])
    )
    result = expander.expand_blocked(required)
    if result["effective_corners"] != expected:
        raise AssertionError(
            f"cross-product mismatch: got {result['effective_corners']} expected {expected}"
        )


def test_short_manifest_fails_closed() -> None:
    manifest = copy.deepcopy(_manifest("tsmc-n2p"))
    # Collapse every axis to a single value so the product drops below the minimum.
    required = manifest["required_after_unblock"]
    axes = required["pvt_axes"]
    for axis in ("process", "voltage_v", "temperature_c", "aging", "rc"):
        axes[axis] = [axes[axis][0]]
    required["multi_vt_required"] = [required["multi_vt_required"][0]]
    result = expander.expand_blocked(required)
    if result["effective_corners"] != 1:
        raise AssertionError("collapsed axes should yield exactly one corner")
    if result["effective_corners"] >= required["total_effective_corners_min"]:
        raise AssertionError("collapsed product must be below the declared minimum")


def test_open_manifest_realized_product() -> None:
    errors: list[str] = []
    result = expander.expand_manifest(CORNER_DIR / "asap7.yaml", errors)
    if result is None or errors:
        raise AssertionError(f"asap7 expansion failed: {errors}")
    # asap7: 3 pvt x 3 rc x 4 vt (SLVT, LVT, RVT, SRAM) = 36.
    if result["effective_corners"] != 36:
        raise AssertionError(f"asap7 realized corners must be 36, got {result['effective_corners']}")
    if result["meets_minimum"] is not None:
        raise AssertionError("open/predictive manifests declare no minimum")


def main() -> int:
    for test in (
        test_repo_corner_expansion_passes,
        test_advanced_product_meets_minimum,
        test_blocked_axis_product_is_cartesian,
        test_short_manifest_fails_closed,
        test_open_manifest_realized_product,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
