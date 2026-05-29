#!/usr/bin/env python3
from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAKEFILE = ROOT / "Makefile"
CHECKER = ROOT / "scripts/check_display_scanout.py"


def main() -> int:
    makefile = MAKEFILE.read_text(encoding="utf-8")
    checker = CHECKER.read_text(encoding="utf-8")
    errors: list[str] = []

    if ".PHONY: display-scanout-check" not in makefile:
        errors.append("Makefile missing .PHONY: display-scanout-check")
    if not re.search(
        r"(?m)^display-scanout-check:\n\t@\$\(PYTHON\) scripts/check_display_scanout\.py$",
        makefile,
    ):
        errors.append("display-scanout-check target must run scripts/check_display_scanout.py")

    for token in (
        '"phone_claim_allowed": False',
        '"release_claim_allowed": False',
        '"panel_bringup_claim_allowed": False',
        '"dsi_phy_claim_allowed": False',
        '"drm_kms_claim_allowed": False',
        "Does NOT",
        "cover the DSI analog PHY",
        "panel DCS init",
        "async pixel-clock CDC",
        "DRM/KMS/compositor",
    ):
        if token not in checker:
            errors.append(f"display scanout checker missing token: {token}")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS display scanout gate regression")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
