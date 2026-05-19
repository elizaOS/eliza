"""Unit tests for the BPU behavioural model.

Treated as a pytest module; ``pytest benchmarks/cpu/branch/`` exercises it.
The assertions check that the model's MPKI is in the expected range for each
synthetic generator, so a regression in the python model's training rules is
caught at lint/test time.
"""

from __future__ import annotations

from benchmarks.cpu.branch.bpu_model import BPUSimulator
from benchmarks.cpu.branch.traces import (
    SYNTHETIC_GENERATORS,
    synthetic_alternating,
    synthetic_always_taken_loop,
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
