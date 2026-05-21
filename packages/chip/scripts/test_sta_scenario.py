#!/usr/bin/env python3
"""Tests for the MMMC scenario DB and the signoff handoff seam.

Run: python3 scripts/test_sta_scenario.py
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_signoff_handoff as bsh  # noqa: E402
import check_signoff_handoff as csh  # noqa: E402
import sta_scenario_db as sdb  # noqa: E402

OPEN_NODES = ["sky130", "gf180", "ihp-sg13g2", "asap7"]
BLOCKED_NODES = ["tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"]


def test_open_nodes_build_scenarios() -> None:
    for node in OPEN_NODES:
        sset = sdb.build_scenario_set(node)
        assert not sset.blocked, f"{node} should not be blocked"
        # 3 PVT x 3 RC x 1 mode = 9 for the open/predictive manifests.
        assert len(sset.scenarios) == 9, f"{node}: expected 9 scenarios, got {len(sset.scenarios)}"
        names = {s.name for s in sset.scenarios}
        assert len(names) == 9, f"{node}: scenario names must be unique"
        for s in sset.scenarios:
            assert s.delay_corner.liberty, f"{node}: delay corner must reference Liberty"
            assert s.ocv.kind in ("ocv", "lvf")


def test_blocked_nodes_are_empty_not_fabricated() -> None:
    for node in BLOCKED_NODES:
        sset = sdb.build_scenario_set(node)
        assert sset.blocked, f"{node} must be blocked"
        assert sset.scenarios == [], f"{node} must have an empty scenario set"
        assert sset.blocked_reason, f"{node} must name the blocking reason"


def test_unknown_node_rejected() -> None:
    try:
        sdb.build_scenario_set("not-a-node")
    except ValueError:
        return
    raise AssertionError("unknown node must raise ValueError")


def test_serialize_roundtrip() -> None:
    sset = sdb.build_scenario_set("sky130")
    payload = sdb.scenario_set_to_dict(sset)
    assert payload["schema"] == sdb.SCHEMA
    rebuilt = sdb.dict_to_scenarios(payload)
    assert len(rebuilt) == len(sset.scenarios)
    assert rebuilt[0].delay_corner.liberty == sset.scenarios[0].delay_corner.liberty


def test_dict_to_scenarios_rejects_blocked() -> None:
    payload = sdb.scenario_set_to_dict(sdb.build_scenario_set("tsmc-n2p"))
    try:
        sdb.dict_to_scenarios(payload)
    except ValueError:
        return
    raise AssertionError("dict_to_scenarios must reject a blocked DB")


def test_handoff_blocked_node_emits_empty() -> None:
    with tempfile.TemporaryDirectory() as td:
        sdb_path = Path(td) / "scen.json"
        sdb_path.write_text(
            json.dumps(sdb.scenario_set_to_dict(sdb.build_scenario_set("tsmc-n2p")))
        )
        bundle = bsh.build_handoff(
            node_id="tsmc-n2p",
            netlist=Path("/dev/null"),
            sdc=Path("/dev/null"),
            spefs=[],
            scenario_db=sdb_path,
        )
        assert bundle["blocked"] is True
        assert bundle["design"] == {}
        assert bundle["liberty_refs"] == []


def test_handoff_open_node_validates_and_detects_tamper() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        netlist = d / "e1.nl.v"
        netlist.write_text("module e1_chip_top(input CLK_IN); endmodule\n")
        sdc = d / "e1.sdc"
        sdc.write_text("create_clock -name clk -period 100 [get_ports CLK_IN]\n")
        spef = d / "e1.max.spef"
        spef.write_text('*SPEF "IEEE 1481-1998"\n')
        sdb_path = d / "scen.json"
        sdb_path.write_text(
            json.dumps(sdb.scenario_set_to_dict(sdb.build_scenario_set("sky130")))
        )
        bundle = bsh.build_handoff(
            node_id="sky130",
            netlist=netlist,
            sdc=sdc,
            spefs=[spef],
            scenario_db=sdb_path,
        )
        assert bundle["blocked"] is False
        assert bundle["liberty_refs"], "open bundle must list Liberty refs"
        assert bundle["design"]["netlist"]["sha256"] == hashlib.sha256(
            netlist.read_bytes()
        ).hexdigest()

        bundle_path = d / "handoff.json"
        bundle_path.write_text(json.dumps(bundle))
        loaded = csh._load_bundle(bundle_path)
        blocked, errors = csh.validate_bundle(loaded)
        assert not blocked and not errors, f"clean bundle must validate: {errors}"

        netlist.write_text("module e1_chip_top(input CLK_IN); wire x; endmodule\n")
        blocked, errors = csh.validate_bundle(loaded)
        assert errors and any("sha256 mismatch" in e for e in errors)


def test_import_back_provenance_and_redaction() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        bundle = {
            "schema": csh.HANDOFF_SCHEMA,
            "node_id": "sky130",
            "blocked": False,
            "design": {"top": "e1_chip_top"},
        }
        good = d / "vendor.json"
        good.write_text(
            json.dumps(
                {
                    "design": "e1_chip_top",
                    "paths": [
                        {
                            "startpoint": "u_ff/Q",
                            "endpoint": "dout[0]",
                            "path_type": "max",
                            "slack": 0.42,
                            "stages": [
                                {
                                    "pin": "u_ff/Q",
                                    "cell": "vendorlib__dff_x4",
                                    "edge": "rise",
                                    "delay": 0.1,
                                    "time": 0.1,
                                }
                            ],
                        },
                        {"startpoint": "bad", "path_type": "max"},
                    ],
                }
            )
        )
        result = csh.import_back(bundle, good, "primetime")
        assert result["schema"] == "eliza.pd_timing_path.v1"
        assert result["provenance_verified"] is True
        assert result["path_count"] == 1, "malformed record must be dropped, not faked"
        assert result["parse_warnings"], "dropped record must produce a warning"
        assert result["paths"][0]["stages"][0]["cell_class"] == "vendorlib"
        assert "cell" not in result["paths"][0]["stages"][0], "vendor cell name must be stripped"

        notop = d / "notop.json"
        notop.write_text(
            json.dumps({"paths": [{"startpoint": "a", "endpoint": "b", "path_type": "max", "slack": 1.0}]})
        )
        try:
            csh.import_back(bundle, notop, "tempus")
        except ValueError:
            pass
        else:
            raise AssertionError("import without top reference must fail provenance")


def test_import_back_rejects_blocked_bundle() -> None:
    with tempfile.TemporaryDirectory() as td:
        rpt = Path(td) / "v.json"
        rpt.write_text("{}")
        try:
            csh.import_back({"blocked": True, "node_id": "tsmc-n2p"}, rpt, "primetime")
        except ValueError:
            return
    raise AssertionError("import against blocked bundle must fail")


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
    print(f"\nAll {len(tests)} scenario/handoff tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
