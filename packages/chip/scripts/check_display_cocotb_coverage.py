#!/usr/bin/env python3
"""Fail-closed checker for the directed standalone display cocotb artifact."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COVERAGE = ROOT / "build/reports/display_cocotb_coverage.json"
SCHEMA = "e1-chip.display_cocotb_coverage.v1"
CLAIM_BOUNDARY = "directed_display_cocotb_coverage_only_not_system_or_release_evidence"
REQUIRED_CONTRACTS = frozenset(
    {
        "disable_fetch_gate",
        "scan_position_reset",
        "xr24_scanout",
    }
)
REQUIRED_BOUNDARY_PHRASES = (
    "production framebuffer",
    "Linux display driver",
    "DRM/KMS",
    "HDMI/MIPI",
    "panel bring-up",
    "DSI PHY",
    "compositor",
    "display PHY",
)
FALSE_CLAIM_FLAGS = (
    "phone_claim_allowed",
    "release_claim_allowed",
    "production_framebuffer_claim_allowed",
    "linux_display_driver_claim_allowed",
    "drm_kms_claim_allowed",
    "panel_bringup_claim_allowed",
    "dsi_phy_claim_allowed",
    "display_phy_claim_allowed",
    "compositor_claim_allowed",
)


def load_coverage(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"FAIL: missing display cocotb coverage artifact: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"FAIL: invalid JSON in {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"FAIL: {path}: top-level JSON must be an object")
    return payload


def validate_coverage(payload: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if payload.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")
    if payload.get("claim_boundary") != CLAIM_BOUNDARY:
        errors.append(f"claim_boundary must be {CLAIM_BOUNDARY}")
    if payload.get("source") != "verify/cocotb/test_e1_display.py":
        errors.append("source must name verify/cocotb/test_e1_display.py")
    if payload.get("pixel_format") != "XR24 only":
        errors.append("pixel_format must remain XR24 only")

    contracts = payload.get("covered_contracts")
    if not isinstance(contracts, list) or not all(isinstance(item, str) for item in contracts):
        errors.append("covered_contracts must be a list of strings")
        covered = set()
    else:
        covered = set(contracts)
    missing = sorted(REQUIRED_CONTRACTS - covered)
    if missing:
        errors.append(f"missing required display contracts: {', '.join(missing)}")

    for flag in FALSE_CLAIM_FLAGS:
        if payload.get(flag) is not False:
            errors.append(f"{flag} must be exactly false")

    boundary = payload.get("boundary")
    if not isinstance(boundary, str):
        errors.append("boundary must be a string")
    else:
        for phrase in REQUIRED_BOUNDARY_PHRASES:
            if phrase not in boundary:
                errors.append(f"boundary must explicitly mention {phrase!r}")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--coverage",
        type=Path,
        default=DEFAULT_COVERAGE,
        help="Display cocotb coverage artifact to validate",
    )
    args = parser.parse_args(argv)

    payload = load_coverage(args.coverage)
    errors = validate_coverage(payload)
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print(f"PASS: display cocotb coverage: {args.coverage}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
