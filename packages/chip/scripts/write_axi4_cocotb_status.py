#!/usr/bin/env python3
"""AXI4 cocotb status writer.

Parses the cocotb JUnit XML produced by ``make cocotb-axi4`` and writes a
status JSON snapshot under
``docs/evidence/memory/axi4_cocotb_status.json``.

This file is NOT one of the four BLOCKED evidence artifacts — those
remain blocked until the real DRAM PHY measurement + STREAM/lmbench
runs land.  This is the proof that the in-repo behavioural verification
of the AXI4 fabric is green; downstream gates can fail fast if it ever
regresses.

Schema: ``eliza.memory.axi4_cocotb_status.v1``.
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULT_XML = ROOT / "build/reports/cocotb/e1_axi4_tb_test_axi4_burst.raw.xml"
OUT_JSON = ROOT / "docs/evidence/memory/axi4_cocotb_status.json"

REQUIRED_TESTS = [
    "incr_burst_length_sweep",
    "decode_error_returns_decerr",
    "write_strobe_partial_beat_preserves_unwritten_bytes",
    "id_ordering_per_axid",
    "exclusive_read_then_write_returns_exokay_or_okay",
]


def main() -> int:
    if not RESULT_XML.is_file():
        print(f"axi4 cocotb status: result XML missing at {RESULT_XML}")
        return 1

    tree = ET.parse(RESULT_XML)
    root = tree.getroot()

    results: dict[str, dict[str, object]] = {}
    pass_count = 0
    fail_count = 0
    for tc in root.iter("testcase"):
        name = tc.attrib.get("name") or ""
        sim_time_ns = float(tc.attrib.get("sim_time_ns") or 0.0)
        wall_time_s = float(tc.attrib.get("time") or 0.0)
        failed = tc.find("failure") is not None
        results[name] = {
            "status": "fail" if failed else "pass",
            "sim_time_ns": sim_time_ns,
            "wall_time_s": wall_time_s,
        }
        if failed:
            fail_count += 1
        else:
            pass_count += 1

    missing = [t for t in REQUIRED_TESTS if t not in results]
    if missing:
        print(f"axi4 cocotb status: required tests missing in result XML: {missing}")
        return 1

    snapshot = {
        "schema": "eliza.memory.axi4_cocotb_status.v1",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "harness": {
            "simulator": "verilator",
            "toplevel": "e1_axi4_tb",
            "module": "test_axi4_burst",
            "result_xml": str(RESULT_XML.relative_to(ROOT)),
        },
        "summary": {
            "pass_count": pass_count,
            "fail_count": fail_count,
            "all_passed": fail_count == 0 and pass_count == len(REQUIRED_TESTS),
        },
        "results": results,
        "required_tests": REQUIRED_TESTS,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"axi4 cocotb status written: {OUT_JSON.relative_to(ROOT)}")
    print(f"  pass={pass_count} fail={fail_count} all_passed={snapshot['summary']['all_passed']}")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
