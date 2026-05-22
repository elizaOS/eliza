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
    BranchEvent,
)
from benchmarks.cpu.branch.traces import (
    SYNTHETIC_GENERATORS,
    synthetic_alias_thrash,
    synthetic_alternating,
    synthetic_always_taken_loop,
    synthetic_dual_branch_fetch_block,
    synthetic_btb_confidence_churn,
    synthetic_control_indirect_pair,
    synthetic_gpu_occupancy_phase,
    synthetic_gpu_nested_reconvergence,
    synthetic_loop_known_count,
    synthetic_phase_change_server,
    synthetic_recursive_call_return,
    synthetic_return_mismatch_exceptions,
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


def test_phase_change_server_exercises_direction_and_target_relearning():
    sim, branches = _run(synthetic_phase_change_server)
    counters = sim.stats()
    assert counters["cond"] > 0
    assert counters["ind"] > 0
    assert counters["misp"] > 0
    assert sim.mpki(branches * 5) < 300.0


def test_gpu_occupancy_phase_mixes_conditionals_and_indirects():
    events = list(synthetic_gpu_occupancy_phase())
    kinds = {ev.kind for ev in events}
    assert BR_COND in kinds
    assert BR_IND in kinds
    assert len({ev.target for ev in events if ev.kind == BR_IND}) >= 8
    sim = BPUSimulator()
    sim.feed(events)
    assert sim.stats()["ind"] > 0


def test_gpu_nested_reconvergence_has_nested_phase_shape():
    events = list(synthetic_gpu_nested_reconvergence())
    pcs = {ev.pc for ev in events}
    assert len(pcs) == 5
    assert {ev.taken for ev in events} == {False, True}
    assert all(ev.kind == BR_COND for ev in events)

    outer_pc = 0x800C_0000
    inner_pcs = {0x800C_0040, 0x800C_0080}
    outer_outcomes = [ev.taken for ev in events if ev.pc == outer_pc]
    assert {False, True}.issubset(set(outer_outcomes))
    assert inner_pcs.issubset(pcs)


def test_control_indirect_pair_carries_target_context_in_conditionals():
    events = list(synthetic_control_indirect_pair())
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    assert len(ind_events) * 2 == len(cond_events)
    assert len({ev.pc for ev in ind_events}) == 1
    assert len({ev.target for ev in ind_events}) == 8
    assert {ev.taken for ev in cond_events} == {False, True}

    sim = BPUSimulator()
    sim.feed(events)
    assert sim.stats()["ind"] == len(ind_events)


def test_btb_confidence_churn_exceeds_uftb_capacity_and_flips_targets():
    events = list(synthetic_btb_confidence_churn())
    pcs = {ev.pc for ev in events}
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len(pcs) > DEFAULT_GEOMETRY["UFTB_ENTRIES"]
    assert len({ev.pc for ev in ind_events}) >= 128
    assert len({ev.target for ev in ind_events}) > len({ev.pc for ev in ind_events})
    assert {ev.taken for ev in events if ev.kind == BR_COND} == {False, True}


def test_alias_thrash_collides_low_index_bits():
    events = list(synthetic_alias_thrash())
    pcs = {ev.pc for ev in events}
    assert len(pcs) >= 16
    assert len({pc & 0xFFFF for pc in pcs}) == 1
    assert {ev.taken for ev in events} == {False, True}


def test_return_mismatch_exceptions_stress_ras_without_exploding():
    sim, branches = _run(synthetic_return_mismatch_exceptions)
    counters = sim.stats()
    assert counters["call"] > 0
    assert counters["ret"] > 0
    assert counters["ret_misp"] > 0
    assert sim.mpki(branches * 5) < 150.0


def test_python_default_geometry_tracks_rtl_package():
    """The MPKI sweep must evaluate the production RTL geometry by default."""
    pkg_values = _parse_rtl_geometry((ROOT / "rtl/cpu/bpu/bpu_pkg.sv").read_text(encoding="utf-8"))
    shared = {
        "BIM_ENTRIES",
        "BIM_CTR_W",
        "FETCH_BLOCK_BYTES",
        "FTB_ENTRIES",
        "FTB_TARGET_CONF_W",
        "FTB_WAYS",
        "ITTAGE_ENTRIES",
        "ITTAGE_HIST_LEN",
        "ITTAGE_TABLES",
        "ITTAGE_TAG_W",
        "ITTAGE_USEFUL_RESET_PERIOD",
        "ITTAGE_USEFUL_W",
        "ITTAGE_REPLACE_WEAK_CTR",
        "ITTAGE_REPLACE_MIN_PROVIDER",
        "ITTAGE_TARGET_HISTORY_BITS",
        "ITTAGE_TARGET_HISTORY_SHIFT",
        "ITTAGE_TARGET_HISTORY_TOKEN_BITS",
        "LOOP_CTR_W",
        "LOOP_ENTRIES",
        "LOOP_CONF_W",
        "RAS_ARCH_ENTRIES",
        "RAS_SPEC_ENTRIES",
        "SC_CTR_W",
        "SC_ENTRIES_TABLE",
        "SC_HIST_LEN",
        "SC_LOCAL_HISTORY_BITS",
        "SC_LOCAL_HISTORY_ENTRIES",
        "SC_TABLES",
        "SC_THRESH_INIT",
        "TAGE_CTR_W",
        "TAGE_ENTRIES_TABLE",
        "TAGE_HIST_LEN",
        "TAGE_TABLES",
        "TAGE_TAG_W",
        "TAGE_USE_ALT_ON_NA",
        "TAGE_USEFUL_RESET_PERIOD",
        "TAGE_USEFUL_W",
        "UFTB_ENTRIES",
        "UFTB_STEER_CONF_MIN",
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
    """The SC override path must remain executable. Use a deliberately lower
    threshold than the production baseline so this tiny microtrace exercises
    the corrector without constraining the tuned threshold."""
    geo = dict(DEFAULT_GEOMETRY)
    geo["SC_THRESH_INIT"] = 6
    geo["SC_LOCAL_HISTORY_BITS"] = 0
    sim = BPUSimulator(geometry=geo)
    sim.feed(list(synthetic_loop_known_count()))
    counters = sim.stats()
    assert counters.get("sc_override", 0) > 0, "SC never fired — corrector inactive"


def test_loop_predictor_drops_confidence_on_trip_count_overrun():
    """A variable-trip loop must not keep predicting an old exit forever."""
    sim = BPUSimulator()
    pc = 0x8000_2000
    target = pc - 0x40

    for _ in range(8):
        for _ in range(3):
            sim.loop.update(pc, target, True)
        sim.loop.update(pc, target, False)

    entry = sim.loop.storage[pc & 0xFFFF]
    assert entry["iter_max"] == 3
    assert entry["conf"] == 7

    for _ in range(4):
        sim.loop.update(pc, target, True)

    assert entry["conf"] == 0


def test_loop_predictor_ignores_forward_branches():
    """Only backward branches are loops; forward conditionals must not train."""
    sim = BPUSimulator()
    pc = 0x8000_2000
    target = pc + 0x20

    for _ in range(16):
        sim.loop.update(pc, target, True)

    assert (pc & 0xFFFF) not in sim.loop.storage


def test_ftb_target_confidence_tracks_stable_targets():
    sim = BPUSimulator()
    pc = 0x9000_2000
    target = 0x9000_5000
    other = 0x9000_6000

    sim.ftb.update(pc, target, BR_IND)
    assert sim.ftb.lookup(pc)["target_conf"] == 0
    sim.ftb.update(pc, target, BR_IND)
    assert sim.ftb.lookup(pc)["target_conf"] == 1
    sim.ftb.update(pc, other, BR_IND)
    assert sim.ftb.lookup(pc)["target_conf"] == 0


def test_weak_ittage_yields_to_stable_ftb_target():
    sim = BPUSimulator()
    pc = 0x9000_3000
    stable = 0x9000_7000
    stale = 0x9000_8000

    sim.ftb.update(pc, stable, BR_IND)
    sim.ftb.update(pc, stable, BR_IND)
    sim.ftb.update(pc, stable, BR_IND)
    sim.ittage.storage[0][0] = {
        "tag": sim.ittage._index_tag(0, pc, 0)[1],
        "target": stale,
        "ctr": 1 << (sim.geometry["ITTAGE_CTR_W"] - 1),
    }

    pred_taken, pred_target = sim._predict(BranchEvent(pc=pc, target=stable, taken=True, kind=BR_IND))

    assert pred_taken
    assert pred_target == stable


def test_ittage_replaces_weak_stale_target():
    sim = BPUSimulator()
    pc = 0x9000_4000
    stale = 0x9000_8000
    target = 0x9000_9000
    table = sim.geometry["ITTAGE_REPLACE_MIN_PROVIDER"] - 1
    idx, tag = sim.ittage._index_tag(table, pc, 0)
    sim.ittage.storage[table][idx] = {
        "tag": tag,
        "target": stale,
        "ctr": sim.geometry["ITTAGE_REPLACE_WEAK_CTR"],
        "useful": 0,
    }

    sim.ittage.update(pc, 0, target, provider=table + 1, misp=True)

    entry = sim.ittage.storage[table][idx]
    assert entry["target"] == target
    assert entry["ctr"] == 1 << (sim.geometry["ITTAGE_CTR_W"] - 1)
    assert entry["useful"] == 0


def test_ittage_keeps_low_provider_stale_target_until_aged():
    sim = BPUSimulator()
    pc = 0x9000_5000
    stale = 0x9000_8000
    target = 0x9000_9000
    idx, tag = sim.ittage._index_tag(0, pc, 0)
    sim.ittage.storage[0][idx] = {
        "tag": tag,
        "target": stale,
        "ctr": sim.geometry["ITTAGE_REPLACE_WEAK_CTR"],
        "useful": 1,
    }

    sim.ittage.update(pc, 0, target, provider=1, misp=True)

    entry = sim.ittage.storage[0][idx]
    assert entry["target"] == stale
    assert entry["ctr"] == sim.geometry["ITTAGE_REPLACE_WEAK_CTR"] - 1
    assert entry["useful"] == 0


def test_ittage_skips_useful_victim_and_replaces_aged_victim():
    geo = dict(DEFAULT_GEOMETRY)
    geo["ITTAGE_USEFUL_RESET_PERIOD"] = 2
    sim = BPUSimulator(geometry=geo)
    pc = 0x9000_5100
    old_target = 0x9000_8000
    new_target = 0x9000_9000

    idx, tag = sim.ittage._index_tag(0, pc, 0)
    sim.ittage.storage[0][idx] = {
        "tag": tag ^ 0x1,
        "target": old_target,
        "ctr": 4,
        "useful": 1,
    }
    sim.ittage.update(pc, 0, new_target, provider=0, misp=True)
    assert sim.ittage.storage[0][idx]["target"] == old_target
    idx1, _tag1 = sim.ittage._index_tag(1, pc, 0)
    assert sim.ittage.storage[1][idx1]["target"] == new_target

    sim.ittage.update(pc, 0, new_target, provider=0, misp=False)
    assert sim.ittage.storage[0][idx]["useful"] == 0
    for table in range(1, geo["ITTAGE_TABLES"]):
        idx_t, tag_t = sim.ittage._index_tag(table, pc, 0)
        sim.ittage.storage[table][idx_t] = {
            "tag": tag_t ^ 0x1,
            "target": old_target,
            "ctr": 4,
            "useful": 1,
        }
    sim.ittage.update(pc, 0, new_target, provider=0, misp=True)
    assert sim.ittage.storage[0][idx]["target"] == new_target


def test_fetch_block_one_slot_exposes_second_branch_redirect_gap():
    """One predicted conditional per fetch block misses a later taken branch."""
    geo = dict(DEFAULT_GEOMETRY)
    geo["FETCH_BLOCK_BRANCH_SLOTS"] = 1
    sim = BPUSimulator(geometry=geo)
    sim.feed(list(synthetic_dual_branch_fetch_block()))
    counters = sim.stats()
    assert counters.get("fetch_slot_blocked", 0) > 0
    assert counters.get("fetch_slot_misp", 0) > 0


def test_fetch_block_dual_slot_removes_second_branch_slot_misses():
    """Dual-branch fetch-block prediction is the bounded RTL-facing proposal."""
    geo = dict(DEFAULT_GEOMETRY)
    geo["FETCH_BLOCK_BRANCH_SLOTS"] = 2
    sim = BPUSimulator(geometry=geo)
    sim.feed(list(synthetic_dual_branch_fetch_block()))
    counters = sim.stats()
    assert counters.get("fetch_slot_blocked", 0) == 0
    assert counters.get("fetch_slot_misp", 0) == 0


def test_tage_use_alt_on_weak_provider():
    """USE_ALT_ON_NA should trust alternate direction for a weak provider."""
    pc = 0x8000_8800
    hist = 0x5A

    geo = dict(DEFAULT_GEOMETRY)
    geo["TAGE_USE_ALT_ON_NA"] = 1
    sim = BPUSimulator(geometry=geo)
    weak_provider = sim.tage.tables[1]
    strong_alt = sim.tage.tables[0]

    idx, tag = strong_alt._index_tag(pc, hist)
    strong_alt.storage[idx] = {"tag": tag, "ctr": 0, "useful": 1}
    idx, tag = weak_provider._index_tag(pc, hist)
    weak_provider.storage[idx] = {"tag": tag, "ctr": 1 << (geo["TAGE_CTR_W"] - 1), "useful": 0}

    taken, provider, low_conf = sim.tage.predict(pc, hist)
    assert provider == 2
    assert low_conf
    assert not taken


def test_sc_adaptive_threshold_runs():
    """The optional adaptive-threshold lever must run and stay bounded."""
    geo = dict(BPUSimulator().geometry)
    geo["SC_ADAPTIVE"] = True
    sim = BPUSimulator(geometry=geo)
    sim.feed(list(synthetic_loop_known_count()))
    assert sim.sc.threshold >= 4  # never drops below the floor


def test_sc_local_history_updates_when_enabled():
    geo = dict(DEFAULT_GEOMETRY)
    geo["SC_LOCAL_HISTORY_BITS"] = 4
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_1234
    for taken in (True, False, True):
        sim.sc.update(pc, 0, taken, tage_lowconf=True)
    idx = (pc >> 1) % geo["SC_LOCAL_HISTORY_ENTRIES"]
    assert sim.sc.local_history[idx] == 0b101


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
