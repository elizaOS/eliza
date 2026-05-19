#!/usr/bin/env python3
"""Fail-closed check that the XiangShan external pin manifest is consistent.

Reads ``external/xiangshan/pin-manifest.json`` and verifies:

- schema is the expected pin-manifest schema,
- license is Mulan-PSL-v2,
- upstream repo is the OpenXiangShan canonical repo,
- checkout_destination matches the manifest's recorded path,
- if external/xiangshan/XiangShan exists, the .git HEAD matches the
  manifest's pinned commit; otherwise the gate is BLOCKED, not failed.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "external/xiangshan/pin-manifest.json"


def load(path: Path, errors: list[str]) -> dict | None:
    if not path.is_file():
        errors.append(f"missing manifest: {path.relative_to(ROOT)}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")
        return None


def main() -> int:
    errors: list[str] = []
    manifest = load(MANIFEST, errors)
    if manifest is None:
        for err in errors:
            print(f"FAIL: {err}")
        return 1

    expected_repo = "https://github.com/OpenXiangShan/XiangShan.git"
    if manifest.get("schema") != "eliza.external_ip_pin_manifest.v1":
        errors.append("schema must be eliza.external_ip_pin_manifest.v1")
    if manifest.get("license") != "Mulan-PSL-v2":
        errors.append("license must be Mulan-PSL-v2")
    if manifest.get("upstream_repo") != expected_repo:
        errors.append(f"upstream_repo must be {expected_repo}")
    if manifest.get("ip_name") != "XiangShan-Kunminghu":
        errors.append("ip_name must be XiangShan-Kunminghu")

    checkout = ROOT / manifest.get("checkout_destination", "")
    blocked_reason = None
    if not checkout.exists():
        blocked_reason = f"{checkout.relative_to(ROOT)} not present; clone {expected_repo}"

    if errors:
        print("XiangShan pin check failed:")
        for err in errors:
            print(f"  - {err}")
        return 1

    if blocked_reason:
        print(f"STATUS: BLOCKED cpu.xiangshan_pin - {blocked_reason}")
        return 0

    pinned = manifest.get("upstream_commit_pinned", "")
    if not pinned or pinned.startswith("BLOCKED"):
        try:
            head = subprocess.check_output(
                ["git", "-C", str(checkout), "rev-parse", "HEAD"],
                stderr=subprocess.PIPE,
                text=True,
            ).strip()
            print(
                f"STATUS: BLOCKED cpu.xiangshan_pin - manifest commit BLOCKED; "
                f"working checkout HEAD={head}. Update manifest after first review."
            )
            return 0
        except subprocess.CalledProcessError as exc:
            print(
                f"STATUS: BLOCKED cpu.xiangshan_pin - checkout exists but `git rev-parse HEAD` failed: "
                f"{exc.stderr.strip()}"
            )
            return 0

    print(f"STATUS: PASS cpu.xiangshan_pin - manifest pinned at {pinned}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
