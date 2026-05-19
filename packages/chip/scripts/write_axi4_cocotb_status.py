#!/usr/bin/env python3
"""AXI4 cocotb status writer.

Parses the cocotb JUnit XML produced by every AXI4-domain ``make
cocotb-axi4*`` target and writes a status JSON snapshot under
``docs/evidence/memory/axi4_cocotb_status.json``.

Tracked harnesses:

* ``e1_axi4_tb`` / ``test_axi4_burst`` — burst, ID ordering, strobes,
  exclusive monitor, decode error.
* ``e1_axi4_irq_w1c_tb`` / ``test_irq_w1c`` — write-1-to-clear IRQ
  status MMR.
* ``e1_axi4_multimaster_tb`` / ``test_multi_master_fairness`` —
  8-master round-robin / QoS-biased arbitration.
* ``e1_dram_ctrl_tb`` / ``test_dfi_traffic`` — DFI 5.0 north command
  shaper observability through the e1_dram_ctrl wrapper.

This file is NOT one of the four BLOCKED evidence artifacts — those
remain blocked until the real DRAM PHY measurement + STREAM/lmbench
runs land.  This is the proof that the in-repo behavioural
verification of the AXI4 fabric is green; downstream gates can fail
fast if it ever regresses.

Schema: ``eliza.memory.axi4_cocotb_status.v1``.
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "build/reports/cocotb"
OUT_JSON = ROOT / "docs/evidence/memory/axi4_cocotb_status.json"

HARNESSES: list[dict[str, object]] = [
    {
        "toplevel": "e1_axi4_tb",
        "module": "test_axi4_burst",
        "required_tests": [
            "incr_burst_length_sweep",
            "decode_error_returns_decerr",
            "write_strobe_partial_beat_preserves_unwritten_bytes",
            "id_ordering_per_axid",
            "exclusive_read_then_write_returns_exokay_or_okay",
        ],
    },
    {
        "toplevel": "e1_axi4_irq_w1c_tb",
        "module": "test_irq_w1c",
        "required_tests": [
            "decode_err_irq_w1c_clears_status",
            "excl_fail_irq_w1c_clears_status",
            "w1c_clears_only_masked_bits",
        ],
    },
    {
        "toplevel": "e1_axi4_multimaster_tb",
        "module": "test_multi_master_fairness",
        "required_tests": [
            "equal_qos_round_robin_no_starvation",
            "qos_weighted_high_master_wins_no_starvation",
        ],
    },
    {
        "toplevel": "e1_dram_ctrl_tb",
        "module": "test_dfi_traffic",
        "required_tests": [
            "dfi_init_brings_cke_high",
            "dfi_write_emits_activate_then_write_col",
            "dfi_read_emits_activate_then_read_col",
            "dfi_refresh_fires_within_window",
        ],
    },
]


def parse_harness(toplevel: str, module: str) -> dict[str, object]:
    xml_path = REPORT_DIR / f"{toplevel}_{module}.raw.xml"
    if not xml_path.is_file():
        return {
            "status": "missing",
            "result_xml": str(xml_path.relative_to(ROOT)),
            "results": {},
            "pass_count": 0,
            "fail_count": 0,
        }

    tree = ET.parse(xml_path)
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
    return {
        "status": "present",
        "result_xml": str(xml_path.relative_to(ROOT)),
        "results": results,
        "pass_count": pass_count,
        "fail_count": fail_count,
    }


def main() -> int:
    overall_pass = 0
    overall_fail = 0
    harness_records: list[dict[str, object]] = []
    missing_required: list[str] = []
    any_missing_xml = False

    for harness in HARNESSES:
        top = str(harness["toplevel"])
        mod = str(harness["module"])
        required = list(harness["required_tests"])  # type: ignore[arg-type]
        parsed = parse_harness(top, mod)
        if parsed["status"] == "missing":
            any_missing_xml = True
        missing = [t for t in required if t not in parsed["results"]]  # type: ignore[operator]
        missing_required.extend(f"{top}::{t}" for t in missing)
        overall_pass += int(parsed["pass_count"])  # type: ignore[arg-type]
        overall_fail += int(parsed["fail_count"])  # type: ignore[arg-type]
        harness_records.append(
            {
                "toplevel": top,
                "module": mod,
                "required_tests": required,
                **parsed,
                "missing_required_tests": missing,
            }
        )

    if any_missing_xml:
        print(
            "axi4 cocotb status: at least one result XML is missing;"
            " run `make memory-axi4-check` first."
        )
        return 1

    if missing_required:
        print(
            "axi4 cocotb status: required tests missing from result XML:"
            f" {missing_required}"
        )
        return 1

    all_passed = overall_fail == 0
    snapshot = {
        "schema": "eliza.memory.axi4_cocotb_status.v1",
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "simulator": "verilator",
        "harnesses": harness_records,
        "summary": {
            "pass_count": overall_pass,
            "fail_count": overall_fail,
            "all_passed": all_passed,
        },
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"axi4 cocotb status written: {OUT_JSON.relative_to(ROOT)}")
    print(f"  pass={overall_pass} fail={overall_fail} all_passed={all_passed}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
