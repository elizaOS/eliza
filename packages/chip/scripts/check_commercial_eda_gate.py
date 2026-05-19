#!/usr/bin/env python3
"""Fail-closed check for the commercial-EDA partnership gate.

Reads docs/evidence/pd/commercial-eda-gate.yaml and exits zero only when
the gate status flips to complete_local_evidence. Today this gate is
intentionally BLOCKED; the script exits with code 2 (distinct from a real
failure) so CI can distinguish "blocked-on-vendor" from "broken".
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / "docs" / "evidence" / "pd" / "commercial-eda-gate.yaml"


def main() -> int:
    if not GATE.is_file():
        print(f"FAIL: gate file missing: {GATE.relative_to(ROOT)}", file=sys.stderr)
        return 1
    payload = yaml.safe_load(GATE.read_text())
    if not isinstance(payload, dict):
        print(f"FAIL: gate file is not a mapping: {GATE.relative_to(ROOT)}", file=sys.stderr)
        return 1
    status = payload.get("status")
    if status == "complete_local_evidence":
        print("PASS: commercial-eda-gate unblocked")
        return 0
    print(
        f"BLOCK: commercial-eda-gate intentionally blocked "
        f"(status={status}); see {GATE.relative_to(ROOT)}"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
