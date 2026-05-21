#!/usr/bin/env python3
"""Tests for the canonical timing-path normalizer (eliza.pd_timing_path.v1).

Run: python3 scripts/test_timing_paths.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import normalize_timing_paths as ntp  # noqa: E402

# A minimal but real-shaped OpenSTA report_checks block (one setup, one hold).
SAMPLE = """
report_checks -path_delay max (Setup)

Startpoint: DBG_ADDR[1] (input port clocked by CLK_IN)
Endpoint: DBG_RDATA[0] (output port clocked by CLK_IN)
Path Group: CLK_IN
Path Type: max

Fanout         Cap        Slew       Delay        Time   Description
---------------------------------------------------------------------------------------------
                                  0.000000    0.000000   clock CLK_IN (rise edge)
                                  4.000000    4.000000 v input external delay
     2    0.006014    0.015817    0.009794    4.009794 v DBG_ADDR[1] (in)
     3    0.013330    0.082911    0.121469    4.131263 v input2/X (sky130_fd_sc_hd__buf_1)
     1    0.005588    0.339657    0.380477    4.512119 ^ _26_/Y (sky130_fd_sc_hd__nor4b_1)
                                              5.193251   data arrival time

                                 20.000000   20.000000   clock CLK_IN (rise edge)
                                             15.750001   data required time
---------------------------------------------------------------------------------------------
                                             15.750001   data required time
                                             -5.193251   data arrival time
---------------------------------------------------------------------------------------------
                                             10.556749   slack (MET)


Startpoint: u_ff/CLK (rising edge-triggered flip-flop clocked by CLK_IN)
Endpoint: u_ff2/D (rising edge-triggered flip-flop clocked by CLK_IN)
Path Group: CLK_IN
Path Type: min

Fanout         Cap        Slew       Delay        Time   Description
---------------------------------------------------------------------------------------------
     1    0.001000    0.010000    0.050000    0.050000 ^ u_ff/Q (sky130_fd_sc_hd__dfxtp_1)
                                              0.050000   data arrival time
                                              0.020000   data required time
---------------------------------------------------------------------------------------------
                                             -0.030000   slack (VIOLATED)
"""


def test_parses_two_paths() -> None:
    paths, warnings = ntp.parse_report(SAMPLE)
    assert warnings == [], f"unexpected warnings: {warnings}"
    assert len(paths) == 2, f"expected 2 paths, got {len(paths)}"


def test_setup_path_fields() -> None:
    paths, _ = ntp.parse_report(SAMPLE)
    setup = paths[0]
    assert setup.startpoint == "DBG_ADDR[1] (input port clocked by CLK_IN)"
    assert setup.endpoint == "DBG_RDATA[0] (output port clocked by CLK_IN)"
    assert setup.path_type == "max"
    assert setup.path_group == "CLK_IN"
    assert setup.met is True
    assert abs(setup.slack - 10.556749) < 1e-6
    assert abs((setup.arrival or 0) - 5.193251) < 1e-6
    assert abs((setup.required or 0) - 15.750001) < 1e-6
    # Two cell stages; clock-edge rows and the (in) port marker are excluded.
    assert len(setup.stages) == 2
    assert setup.stages[0].cell == "sky130_fd_sc_hd__buf_1"
    assert setup.stages[-1].cell == "sky130_fd_sc_hd__nor4b_1"
    assert setup.stages[-1].edge == "rise"
    assert setup.stages[0].edge == "fall"


def test_hold_path_violated() -> None:
    paths, _ = ntp.parse_report(SAMPLE)
    hold = paths[1]
    assert hold.path_type == "min"
    assert hold.met is False
    assert abs(hold.slack - (-0.030000)) < 1e-6


def test_no_synthesized_values_on_malformed_block() -> None:
    # A block with no slack line must be dropped with a warning, never
    # assigned a fabricated slack.
    bad = (
        "Startpoint: a (in)\nEndpoint: b (out)\nPath Group: g\nPath Type: max\n"
        "no slack line here\n"
    )
    paths, warnings = ntp.parse_report(bad)
    assert paths == []
    assert warnings and "slack" in warnings[0]


def test_missing_path_type_dropped() -> None:
    bad = "Startpoint: a (in)\nEndpoint: b (out)\n   1.0 slack (MET)\n"
    paths, warnings = ntp.parse_report(bad)
    assert paths == []
    assert any("Path Type" in w for w in warnings)


def test_to_dict_schema() -> None:
    paths, warnings = ntp.parse_report(SAMPLE)
    payload = ntp.to_dict(
        paths,
        source_tool="opensta",
        source_report="sample.rpt",
        scenario="func__tt__rc_nom",
        warnings=warnings,
    )
    assert payload["schema"] == "eliza.pd_timing_path.v1"
    assert payload["path_count"] == 2
    assert payload["scenario"] == "func__tt__rc_nom"
    assert payload["paths"][0]["stages"][0]["pin"] == "input2/X"


def test_parses_real_report_if_available() -> None:
    candidates = list((ROOT / "pd" / "openlane" / "runs").glob("**/*.rpt"))
    real = [c for c in candidates if "Startpoint" in c.read_text(errors="ignore")]
    if not real:
        print("  (skip) no real report_checks output present")
        return
    payload = ntp.normalize_file(real[0], source_tool="opensta")
    assert payload["schema"] == "eliza.pd_timing_path.v1"
    assert payload["path_count"] > 0, f"no paths parsed from {real[0]}"
    assert payload["parse_warnings"] == [], f"warnings on real report: {payload['parse_warnings']}"
    for p in payload["paths"]:
        assert p["startpoint"] and p["endpoint"]
        assert p["path_type"] in ("min", "max")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS: {test.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL: {test.__name__}: {exc}", file=sys.stderr)
    if failures:
        print(f"\n{failures}/{len(tests)} tests failed", file=sys.stderr)
        return 1
    print(f"\nAll {len(tests)} timing-path tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
