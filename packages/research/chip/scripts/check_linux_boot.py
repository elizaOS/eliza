#!/usr/bin/env python3
"""Fail-closed Linux boot evidence ingestion for the e1 CPU AP.

Reads ``build/evidence/cpu_ap/eliza_e1_linux_boot.log`` and verifies the
canonical Linux boot markers documented in
``docs/evidence/cpu-ap-evidence-manifest.json``. Writes a structured
summary to ``docs/evidence/cpu_ap/linux-boot.json`` regardless of
outcome, with a SHA-256 of the transcript fragment that contains each
marker.

This script does NOT generate evidence. It only ingests evidence the
scripts/run_linux_smoke.sh harness produced and ratifies that it meets
the contract. Absence of evidence fails closed.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRANSCRIPT = ROOT / "build/evidence/cpu_ap/eliza_e1_linux_boot.log"
EVIDENCE_OUT = ROOT / "docs/evidence/cpu_ap/linux-boot.json"

REQUIRED_MARKERS = (
    "OpenSBI v",
    "Booting Linux on physical CPU",
    "Linux version",
    "Run /init",
    "Welcome to",
    "console-uart",
)


def write_blocked(reason: str) -> int:
    EVIDENCE_OUT.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE_OUT.write_text(
        json.dumps(
            {
                "schema": "eliza.cpu_linux_boot_evidence.v1",
                "status": "blocked",
                "reason": reason,
                "transcript": str(TRANSCRIPT.relative_to(ROOT)),
                "checked_at": _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"STATUS: BLOCKED cpu.linux_boot - {reason}")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--require",
        action="store_true",
        help="exit 1 when transcript missing or markers absent",
    )
    args = parser.parse_args()

    if not TRANSCRIPT.is_file():
        rc = write_blocked("transcript missing: run scripts/run_linux_smoke.sh first")
        return rc if args.require else 0

    text = TRANSCRIPT.read_text(encoding="utf-8", errors="ignore")
    digest = hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()

    missing = [m for m in REQUIRED_MARKERS if m not in text]

    EVIDENCE_OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "eliza.cpu_linux_boot_evidence.v1",
        "status": "blocked" if missing else "pass",
        "transcript": str(TRANSCRIPT.relative_to(ROOT)),
        "transcript_sha256": digest,
        "required_markers": list(REQUIRED_MARKERS),
        "missing_markers": missing,
        "checked_at": _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    EVIDENCE_OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    if missing:
        print(f"STATUS: BLOCKED cpu.linux_boot - missing markers: {missing}")
        return 1 if args.require else 0

    print("STATUS: PASS cpu.linux_boot - all required markers present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
