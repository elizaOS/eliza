#!/usr/bin/env python3
"""Assert that every kernel/Buildroot BSP evidence file expected by the
2026-05-17 BSP critical-gap audit is either checked in or explicitly
marked BLOCKED with a reason.

The audit (docs/android/bsp-critical-gap-audit-2026-05-17.md) lists machine
readable BLOCK gates that require evidence transcripts under
docs/evidence/linux/ and docs/evidence/buildroot/. Until external trees
produce them, this script accepts a marker file alongside the missing
evidence:

    docs/evidence/linux/<name>.BLOCKED
    docs/evidence/buildroot/<name>.BLOCKED

Each marker must be non-empty and start with `reason:` on the first line.

Exits 0 if every required path is either present as evidence or accompanied
by a valid BLOCKED marker. Exits 1 otherwise.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

REQUIRED_EVIDENCE: dict[str, list[str]] = {
    "linux": [
        "docs/evidence/linux/eliza_e1_kernel_build.log",
        "docs/evidence/linux/eliza_e1_dtb_check.log",
        "docs/evidence/linux/e1-mmio-smoke.log",
    ],
    "buildroot": [
        "docs/evidence/buildroot/eliza_e1_defconfig.log",
        "docs/evidence/buildroot/eliza_e1_image_manifest.txt",
        "docs/evidence/buildroot/e1-mmio-smoke.log",
    ],
}


def check_one(rel: str) -> tuple[str, str]:
    """Return (status, message) for one required evidence path."""
    evidence = REPO_ROOT / rel
    blocked = evidence.with_suffix(evidence.suffix + ".BLOCKED")

    if evidence.is_file() and evidence.stat().st_size > 0:
        return ("PASS", f"{rel}: evidence present ({evidence.stat().st_size} bytes)")

    if blocked.is_file():
        text = blocked.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            return ("FAIL", f"{rel}: BLOCKED marker is empty ({blocked.relative_to(REPO_ROOT)})")
        first = text.splitlines()[0].strip().lower()
        if not first.startswith("reason:"):
            return (
                "FAIL",
                f"{rel}: BLOCKED marker must start with 'reason:' "
                f"({blocked.relative_to(REPO_ROOT)})",
            )
        return ("BLOCKED", f"{rel}: BLOCKED ({text.splitlines()[0].strip()})")

    return (
        "FAIL",
        f"{rel}: missing evidence and no {blocked.relative_to(REPO_ROOT)} marker",
    )


def main(argv: list[str]) -> int:
    targets = argv[1:] or sorted(REQUIRED_EVIDENCE.keys())
    failures = 0
    for target in targets:
        if target not in REQUIRED_EVIDENCE:
            print(f"FAIL: unknown target '{target}'", file=sys.stderr)
            failures += 1
            continue
        print(f"== {target} ==")
        for rel in REQUIRED_EVIDENCE[target]:
            status, message = check_one(rel)
            print(f"  {status}: {message}")
            if status == "FAIL":
                failures += 1
    if failures:
        print(f"\ncheck_kernel_bsp: {failures} failure(s)", file=sys.stderr)
        return 1
    print("\ncheck_kernel_bsp: ok (all paths present or BLOCKED with reason)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
