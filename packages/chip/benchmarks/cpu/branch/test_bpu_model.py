"""Unit tests for the BPU behavioural model.

Treated as a pytest module; ``pytest benchmarks/cpu/branch/`` exercises it.
The assertions check that the model's MPKI is in the expected range for each
synthetic generator, so a regression in the python model's training rules is
caught at lint/test time.
"""

from __future__ import annotations

from benchmarks.cpu.branch.bpu_model import (
    BR_CALL,
    BR_COND,
    BR_IND,
    BR_RET,
    BPUSimulator,
)
from benchmarks.cpu.branch.traces import (
    SYNTHETIC_GENERATORS,
    synthetic_alternating,
    synthetic_always_taken_loop,
    synthetic_loop_known_count,
    synthetic_recursive_call_return,
)


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
