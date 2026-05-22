"""Unit tests for the BPU behavioural model.

Treated as a pytest module; ``pytest benchmarks/cpu/branch/`` exercises it.
The assertions check that the model's MPKI is in the expected range for each
synthetic generator, so a regression in the python model's training rules is
caught at lint/test time.
"""

from __future__ import annotations

import re
from pathlib import Path

from benchmarks.cpu.branch.bpu_model import (
    BR_CALL,
    BR_COND,
    BR_IND,
    BR_RET,
    DEFAULT_GEOMETRY,
    BPUSimulator,
)
from benchmarks.cpu.branch.traces import (
    SYNTHETIC_GENERATORS,
    synthetic_alternating,
    synthetic_always_taken_loop,
    synthetic_loop_known_count,
    synthetic_recursive_call_return,
)
from scripts.check_branch_prediction import parse_int_literal, parse_package

ROOT = Path(__file__).resolve().parents[3]


def _parse_rtl_geometry(text: str) -> dict[str, int | list[int]]:
    values = parse_package(text)
    scalar_re = re.compile(
        r"localparam\s+int\s+unsigned\s+(?P<name>[A-Z_][A-Z0-9_]*)\s*=\s*(?P<value>[^;]+);"
    )
    for match in scalar_re.finditer(text):
        name = match.group("name")
        try:
            values[name] = parse_int_literal(match.group("value").strip())
        except (ValueError, KeyError):
            continue
    return values


def _run(generator) -> tuple[BPUSimulator, int]:
    events = list(generator())
    sim = BPUSimulator()
    sim.feed(events)
    return sim, len(events)


def test_always_taken_loop_mpki_below_one():
    sim, branches = _run(synthetic_always_taken_loop)
    # 5 instructions/branch estimate, so dynamic instruction count == 5*branches.
    assert sim.mpki(branches * 5) < 1.0


def test_alternating_pattern_trains_under_two_mpki():
    sim, branches = _run(synthetic_alternating)
    assert sim.mpki(branches * 5) < 2.0


def test_recursive_call_return_is_finite():
    sim, branches = _run(synthetic_recursive_call_return)
    counters = sim.stats()
    assert counters["call"] > 0
    assert counters["ret"] > 0
    # Returns should eventually find the RAS top after the first pair trains.
    assert sim.mpki(branches * 5) < 100.0


def test_all_named_generators_emit_events():
    for name, factory in SYNTHETIC_GENERATORS.items():
        events = list(factory())
        assert events, f"generator {name} produced no events"


def test_python_default_geometry_tracks_rtl_package():
    """The MPKI sweep must evaluate the production RTL geometry by default."""
    pkg_values = _parse_rtl_geometry((ROOT / "rtl/cpu/bpu/bpu_pkg.sv").read_text(encoding="utf-8"))
    shared = {
        "BIM_ENTRIES",
        "BIM_CTR_W",
        "FETCH_BLOCK_BYTES",
        "FTB_ENTRIES",
        "FTB_WAYS",
        "ITTAGE_ENTRIES",
        "ITTAGE_HIST_LEN",
        "ITTAGE_TABLES",
        "ITTAGE_TAG_W",
        "LOOP_CTR_W",
        "LOOP_ENTRIES",
        "LOOP_CONF_W",
        "RAS_ARCH_ENTRIES",
        "RAS_SPEC_ENTRIES",
        "SC_CTR_W",
        "SC_ENTRIES_TABLE",
        "SC_HIST_LEN",
        "SC_TABLES",
        "SC_THRESH_INIT",
        "TAGE_CTR_W",
        "TAGE_ENTRIES_TABLE",
        "TAGE_HIST_LEN",
        "TAGE_TABLES",
        "TAGE_TAG_W",
        "TAGE_USEFUL_RESET_PERIOD",
        "TAGE_USEFUL_W",
        "UFTB_ENTRIES",
        "UFTB_WAYS",
    }
    aliases = {"TAGE_USEFUL_RESET_PERIOD": "TAGE_UBIT_RESET_PERIOD"}
    for rtl_name in shared:
        model_name = aliases.get(rtl_name, rtl_name)
        assert model_name in DEFAULT_GEOMETRY, f"model missing {model_name}"
        expected = pkg_values[rtl_name]
        actual = DEFAULT_GEOMETRY[model_name]
        if isinstance(actual, tuple):
            actual = list(actual)
        assert actual == expected, f"{model_name} drifted from bpu_pkg.sv"


def test_statistical_corrector_is_active():
    """The SC must override low-confidence TAGE on a loop workload (it is the
    'SC' in TAGE-SC-L; the model previously omitted it)."""
    sim, _ = _run(synthetic_loop_known_count)
    counters = sim.stats()
    assert counters.get("sc_override", 0) > 0, "SC never fired — corrector inactive"


def test_sc_adaptive_threshold_runs():
    """The optional adaptive-threshold lever must run and stay bounded."""
    geo = dict(BPUSimulator().geometry)
    geo["SC_ADAPTIVE"] = True
    sim = BPUSimulator(geometry=geo)
    sim.feed(list(synthetic_loop_known_count()))
    assert sim.sc.threshold >= 4  # never drops below the floor


def test_execlog_decoder_reconstructs_branch_classes():
    """The QEMU execlog decoder must classify RV64 control transfers and use
    the next executed PC as ground-truth direction/target."""
    import tempfile
    from pathlib import Path

    from benchmarks.cpu.branch.workload_trace import decode_execlog

    # cond not-taken (fall-through), cond taken, call, ret, indirect jump.
    lines = [
        '0, 0x1000, 0x463, "beqz a0,8 # 0x1008"',  # not taken -> next 0x1004
        '0, 0x1004, 0x13, "addi x0,x0,0"',
        '0, 0x1006, 0x463, "bne a0,a1,6 # 0x100c"',  # taken -> next 0x100c
        '0, 0x100c, 0xef, "jal ra,16 # 0x101c"',  # call -> next 0x101c
        '0, 0x101c, 0x13, "addi x0,x0,0"',
        '0, 0x101e, 0x8082, "ret"',  # ret -> next 0x1010
        '0, 0x1010, 0x8782, "jr a5"',  # indirect -> next 0x2000
        '0, 0x2000, 0x13, "addi x0,x0,0"',
    ]
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "t.execlog.txt"
        p.write_text("\n".join(lines) + "\n")
        branches, stats = decode_execlog(p)
    kinds = [b.kind for b in branches]
    assert kinds == [BR_COND, BR_COND, BR_CALL, BR_RET, BR_IND]
    assert branches[0].taken is False  # beqz fell through
    assert branches[1].taken is True  # bne taken
    assert branches[2].kind == BR_CALL and branches[2].call_return_pc == 0x1010
    assert stats.instruction_count == len(lines)
