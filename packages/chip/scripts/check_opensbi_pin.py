#!/usr/bin/env python3
"""Fail-closed check that the OpenSBI external pin manifest is consistent."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "external" / "opensbi" / "pin-manifest.json"
CHECKOUT = ROOT / "external" / "opensbi" / "opensbi"


def main() -> int:
    if not MANIFEST.is_file():
        print(f"FAIL opensbi pin manifest missing: {MANIFEST.relative_to(ROOT)}")
        return 1

    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL opensbi pin manifest invalid JSON: {exc}")
        return 1

    if manifest.get("license") != "BSD-2-Clause-Patent":
        print("FAIL opensbi license must be BSD-2-Clause-Patent")
        return 1
    if manifest.get("ip_name") != "opensbi":
        print("FAIL opensbi ip_name must be opensbi")
        return 1

    tag = manifest.get("upstream_tag_pinned", "")
    if not tag.startswith("v1.") or tag in ("v1.0", "v1.1", "v1.2", "v1.3", "v1.4"):
        print(
            f"FAIL opensbi upstream_tag_pinned must be v1.5 or newer "
            f"(MPxy + RPMI support required), got {tag}"
        )
        return 1

    if not CHECKOUT.is_dir():
        print(
            "STATUS: BLOCKED power.opensbi_pin - external/opensbi/opensbi absent; "
            "run scripts/bootstrap_opensbi.sh first"
        )
        return 0

    for relpath in manifest.get("minimum_required_files", []):
        if not (ROOT / relpath).is_file():
            print(f"STATUS: BLOCKED power.opensbi_pin - missing required file {relpath}")
            return 0

    try:
        head = subprocess.check_output(
            ["git", "-C", str(CHECKOUT), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.PIPE,
        ).strip()
    except subprocess.CalledProcessError as exc:
        print(f"STATUS: BLOCKED power.opensbi_pin - rev-parse failed: {exc.stderr.strip()}")
        return 0

    pin = manifest.get("upstream_commit_pinned", "")
    if pin.startswith("BLOCKED"):
        print(f"STATUS: BLOCKED power.opensbi_pin - pin is sentinel: {pin}")
        return 0
    if head != pin:
        print(f"STATUS: FAIL power.opensbi_pin - HEAD={head} does not match pin={pin}")
        return 1

    print(f"STATUS: PASS power.opensbi_pin - HEAD={head[:7]} matches manifest pin")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
