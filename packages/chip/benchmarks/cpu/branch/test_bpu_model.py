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
    BR_DIRECT,
    BR_IND,
    BR_RET,
    DEFAULT_GEOMETRY,
    BPUSimulator,
    BranchEvent,
)
from benchmarks.cpu.branch.traces import (
    SYNTHETIC_GENERATORS,
    synthetic_alias_thrash,
    synthetic_allocator_gc_barrier,
    synthetic_alternating,
    synthetic_always_taken_loop,
    synthetic_android_runtime_inline_cache,
    synthetic_btb_confidence_churn,
    synthetic_command_buffer_validation,
    synthetic_control_indirect_pair,
    synthetic_dual_branch_fetch_block,
    synthetic_epoll_rpc_dispatch,
    synthetic_gpu_driver_submit_phases,
    synthetic_gpu_nested_reconvergence,
    synthetic_gpu_occupancy_phase,
    synthetic_gpu_wavefront_compaction,
    synthetic_hash_probe_inline_cache,
    synthetic_json_parser_state_machine,
    synthetic_l2_ftb_target_pressure,
    synthetic_loop_known_count,
    synthetic_phase_change_server,
    synthetic_recursive_call_return,
    synthetic_return_mismatch_exceptions,
    synthetic_signal_exception_unwind,
    synthetic_work_stealing_queues,
    synthetic_workload_class_phase_alias,
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


def test_return_prediction_falls_back_to_architectural_ras_top():
    sim = BPUSimulator()
    call = BranchEvent(
        pc=0x8000_1000,
        target=0x8000_2000,
        taken=True,
        kind=BR_CALL,
        call_return_pc=0x8000_1004,
    )
    sim.feed([call])
    assert sim.ras.arch[-1] == 0x8000_1004
    assert sim.ras.spec == []

    ret = BranchEvent(
        pc=0x8000_2000,
        target=0x8000_1004,
        taken=True,
        kind=BR_RET,
    )
    sim.ftb.update(ret.pc, ret.target, BR_RET)
    before = sim.stats().get("misp", 0)
    sim.feed([ret])
    assert sim.stats().get("ret_misp", 0) == 0
    assert sim.stats().get("misp", 0) == before


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


def test_command_buffer_validation_mixes_validation_and_indirects():
    events = list(synthetic_command_buffer_validation())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len(cond_events) > len(ind_events)
    assert len({ev.target for ev in ind_events}) >= 12
    assert {ev.taken for ev in cond_events} == {False, True}


def test_work_stealing_queues_has_phase_imbalanced_dispatch():
    events = list(synthetic_work_stealing_queues())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len({ev.pc for ev in cond_events}) >= 12
    assert len({ev.target for ev in ind_events}) >= 8
    assert {ev.taken for ev in cond_events} == {False, True}


def test_hash_probe_inline_cache_combines_probe_loop_and_pic_targets():
    events = list(synthetic_hash_probe_inline_cache())
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len({ev.pc for ev in ind_events}) == 1
    assert len({ev.target for ev in ind_events}) >= 5
    assert {ev.taken for ev in events if ev.kind == BR_COND} == {False, True}


def test_allocator_gc_barrier_has_rare_slow_indirects():
    events = list(synthetic_allocator_gc_barrier())
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    assert 0 < len(ind_events) < len(cond_events) // 8
    assert len({ev.target for ev in ind_events}) >= 4
    assert {ev.taken for ev in cond_events} == {False, True}


def test_l2_ftb_target_pressure_exceeds_l1_and_fits_l2_shape():
    events = list(synthetic_l2_ftb_target_pressure())
    pcs = {ev.pc for ev in events}
    assert len(pcs) == 6144
    assert len(pcs) > DEFAULT_GEOMETRY["FTB_ENTRIES"]
    assert len(pcs) < DEFAULT_GEOMETRY["L2_FTB_ENTRIES"]
    assert all(ev.kind == BR_COND and ev.taken for ev in events)

    same_event_geo = dict(DEFAULT_GEOMETRY)
    same_event_geo["L2_FTB_SAME_EVENT_LATE_REDIRECT"] = True
    same_event = BPUSimulator(geometry=same_event_geo)
    same_event.feed(events)
    no_l2_geo = dict(DEFAULT_GEOMETRY)
    no_l2_geo["L2_FTB_ENTRIES"] = 0
    no_l2 = BPUSimulator(geometry=no_l2_geo)
    no_l2.feed(events)

    assert same_event.stats()["misp"] < no_l2.stats()["misp"]
    assert same_event.stats()["l2_ftb_late_redirect"] > 0


def test_ftb_uses_set_way_replacement_like_rtl():
    ftb = BPUSimulator().ftb
    base = 0x8000_0000
    idx = ftb._index(base)
    pcs = []
    pc = base
    while len(pcs) < DEFAULT_GEOMETRY["FTB_WAYS"] + 1:
        if ftb._index(pc) == idx and pc not in pcs:
            pcs.append(pc)
        pc += DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]

    for i, pc in enumerate(pcs):
        ftb.update(pc, 0x9000_0000 + i * 4, BR_CALL)

    assert sum(len(bucket) for bucket in ftb.storage.values()) == DEFAULT_GEOMETRY["FTB_WAYS"]
    assert ftb.lookup(pcs[0]) is None
    assert ftb.lookup(pcs[-1]) is not None


def test_l2_ftb_same_event_timing_ablation_matches_no_l2_pressure():
    events = list(synthetic_l2_ftb_target_pressure())
    no_l2_geo = dict(DEFAULT_GEOMETRY)
    no_l2_geo["L2_FTB_ENTRIES"] = 0
    no_l2 = BPUSimulator(geometry=no_l2_geo)
    no_l2.feed(events)

    delayed_geo = dict(DEFAULT_GEOMETRY)
    delayed_geo["L2_FTB_SAME_EVENT_LATE_REDIRECT"] = False
    delayed = BPUSimulator(geometry=delayed_geo)
    delayed.feed(events)

    assert delayed.stats()["misp"] == no_l2.stats()["misp"]
    assert delayed.stats()["l2_ftb_deferred_by_timing_model"] > 0
    assert delayed.stats().get("l2_ftb_late_redirect", 0) == 0


def test_gpu_wavefront_compaction_has_phase_correlated_simt_shape():
    events = list(synthetic_gpu_wavefront_compaction())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len(ind_events) * 3 == len(cond_events)
    assert len({ev.pc for ev in cond_events}) == 3
    assert len({ev.pc for ev in ind_events}) == 1
    assert len({ev.target for ev in ind_events}) >= 8
    assert {ev.taken for ev in cond_events} == {False, True}


def test_epoll_rpc_dispatch_has_bursty_guards_and_method_targets():
    events = list(synthetic_epoll_rpc_dispatch())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len(cond_events) > len(ind_events) * 3
    assert len({ev.pc for ev in cond_events}) == 4
    assert len({ev.target for ev in ind_events}) >= 12
    assert 0 < len(ind_events) < len(events) // 3
    assert {ev.taken for ev in cond_events} == {False, True}


def test_json_parser_state_machine_tracks_depth_guards_and_states():
    events = list(synthetic_json_parser_state_machine())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len(cond_events) == len(ind_events) * 4
    assert len({ev.pc for ev in cond_events}) == 4
    assert len({ev.target for ev in ind_events}) >= 10
    assert any(ev.taken for ev in cond_events if ev.pc == 0x8024_00C0)
    assert {ev.taken for ev in cond_events} == {False, True}


def test_android_runtime_inline_cache_has_tiered_pic_shape():
    events = list(synthetic_android_runtime_inline_cache())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len(cond_events) == len(ind_events) * 4
    assert len({ev.pc for ev in cond_events}) == 4
    assert len({ev.pc for ev in ind_events}) == 1
    assert len({ev.target for ev in ind_events}) >= 20
    assert any(ev.target >= 0x8025_9000 for ev in ind_events)
    assert {ev.taken for ev in cond_events} == {False, True}


def test_signal_exception_unwind_stresses_non_lifo_returns():
    events = list(synthetic_signal_exception_unwind())
    call_events = [ev for ev in events if ev.kind == BR_CALL]
    ret_events = [ev for ev in events if ev.kind == BR_RET]
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    assert len(call_events) > 0
    assert len(ret_events) >= len(call_events)
    assert {ev.taken for ev in cond_events} == {False, True}
    assert any(ev.target >= 0x8027_0800 for ev in ret_events)

    sim = BPUSimulator()
    sim.feed(events)
    assert sim.stats()["ret_misp"] > 0


def test_gpu_driver_submit_phases_mix_guards_and_ioctl_targets():
    events = list(synthetic_gpu_driver_submit_phases())
    cond_events = [ev for ev in events if ev.kind == BR_COND]
    ind_events = [ev for ev in events if ev.kind == BR_IND]
    assert len({ev.pc for ev in cond_events}) == 4
    assert len({ev.target for ev in ind_events}) >= 12
    assert len(ind_events) < len(events) // 3
    assert {ev.taken for ev in cond_events} == {False, True}
    assert any(ev.workload_class == 1 for ev in ind_events)


def test_workload_class_phase_alias_exercises_same_pc_phase_contexts():
    events = list(synthetic_workload_class_phase_alias())
    by_class = {ev.workload_class for ev in events}
    hot_pcs = {ev.pc for ev in events if ev.kind in (BR_COND, BR_IND)}

    assert by_class == {0, 1}
    assert len(hot_pcs) == 2


def test_promoted_ittage_tag_path_mix_does_not_regress_key_diagnostics():
    """Promoted ITTAGE history mix must not regress prior blocker diagnostics."""
    prior_geo = dict(DEFAULT_GEOMETRY)
    prior_geo["ITTAGE_TAG_W"] = 9
    prior_geo["ITTAGE_TARGET_HISTORY_TOKEN_BITS"] = 7
    prior_geo["ITTAGE_PATH_HISTORY_BITS"] = 0
    prior_geo["ITTAGE_PATH_HISTORY_TOKEN_BITS"] = 6

    baseline_misp: int | float = 0
    prior_misp: int | float = 0
    for generator in (
        SYNTHETIC_GENERATORS["v8_indirect_dispatch"],
        synthetic_command_buffer_validation,
    ):
        events = list(generator())
        baseline = BPUSimulator()
        baseline.feed(events)
        prior = BPUSimulator(geometry=prior_geo)
        prior.feed(events)
        baseline_misp += baseline.stats()["misp"]
        prior_misp += prior.stats()["misp"]

    assert baseline_misp <= prior_misp


def test_python_default_geometry_tracks_rtl_package():
    """The MPKI sweep must evaluate the production RTL geometry by default."""
    pkg_values = _parse_rtl_geometry((ROOT / "rtl/cpu/bpu/bpu_pkg.sv").read_text(encoding="utf-8"))
    shared = {
        "BPU_ASID_W",
        "BPU_CONTEXT_HASH_W",
        "BPU_PRIV_W",
        "BPU_VMID_W",
        "BPU_WORKLOAD_CLASS_W",
        "BIM_ENTRIES",
        "BIM_CTR_W",
        "FETCH_BLOCK_BYTES",
        "FTB_ENTRIES",
        "FTB_TARGET_CONF_W",
        "FTB_WAYS",
        "H2P_ENABLE",
        "H2P_ENTRIES",
        "H2P_HIST_LEN",
        "H2P_LOWCONF_ONLY",
        "H2P_META_CTR_W",
        "H2P_META_ENABLE",
        "H2P_META_ENTRIES",
        "H2P_META_THRESHOLD",
        "H2P_PATH_HIST_LEN",
        "H2P_TARGET_HIST_LEN",
        "H2P_THRESHOLD",
        "H2P_WEIGHT_W",
        "ITTAGE_ENTRIES",
        "ITTAGE_HIST_LEN",
        "ITTAGE_TABLES",
        "ITTAGE_TAG_W",
        "ITTAGE_WAYS",
        "ITTAGE_USEFUL_RESET_PERIOD",
        "ITTAGE_USEFUL_W",
        "ITTAGE_REPLACE_WEAK_CTR",
        "ITTAGE_REPLACE_MIN_PROVIDER",
        "ITTAGE_TARGET_HISTORY_BITS",
        "ITTAGE_TARGET_HISTORY_SHIFT",
        "ITTAGE_TARGET_HISTORY_TOKEN_BITS",
        "LOCAL_DIR_ENABLE",
        "LOCAL_DIR_ENTRIES",
        "LOCAL_DIR_HIST_W",
        "LOCAL_DIR_META_CTR_W",
        "LOCAL_DIR_META_ENABLE",
        "LOCAL_DIR_META_ENTRIES",
        "LOCAL_DIR_META_THRESHOLD",
        "LOCAL_DIR_PHT_ENTRIES",
        "L2_FTB_ENTRIES",
        "L2_FTB_WAYS",
        "LOOP_CTR_W",
        "LOOP_ENTRIES",
        "LOOP_CONF_W",
        "LOOP_IMLI_ENABLE",
        "LOOP_IMLI_HIST_W",
        "LOOP_IMLI_TOKEN_W",
        "LOOP_PATH_SIG_W",
        "RAS_ARCH_ENTRIES",
        "RAS_SPEC_ENTRIES",
        "SC_CTR_W",
        "SC_BIAS_ENABLE",
        "SC_BIAS_CTR_W",
        "SC_BIAS_ENTRIES",
        "SC_ENTRIES_TABLE",
        "SC_HIST_LEN",
        "SC_LOCAL_HISTORY_BITS",
        "SC_LOCAL_HISTORY_ENTRIES",
        "SC_TABLES",
        "SC_THRESH_INIT",
        "TAGE_CTR_W",
        "TAGE_ALT_ON_NA_CTR_W",
        "TAGE_ALT_ON_NA_ENTRIES",
        "TAGE_ALT_ON_NA_THRESHOLD",
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


def test_local_dir_meta_index_matches_rtl_low_pc_bits():
    """RTL uses pc[2 +: LOCAL_DIR_META_IDX_W] for the chooser index."""
    sim = BPUSimulator()
    entries = sim.geometry["LOCAL_DIR_META_ENTRIES"]
    pc = 0x1234_5678
    assert sim.local_dir_meta._idx(pc) == ((pc >> 2) % entries)


def test_model_context_hash_matches_rtl_context_fields():
    """ASID/VMID/priv/secure/workload-class fields all perturb context PC."""
    sim = BPUSimulator()
    pc = 0x8000_4000
    default = BranchEvent(pc=pc, target=pc + 4, taken=False, kind=BR_COND)
    contextual = BranchEvent(
        pc=pc,
        target=pc + 4,
        taken=False,
        kind=BR_COND,
        asid=0x5A,
        vmid=0x6,
        priv=0x3,
        secure=1,
        workload_class=1,
    )
    assert sim._context_pc(default) == pc
    assert sim._context_pc(contextual) != pc


def test_sweep_window_modes_cover_middle_late_and_stratified_caps():
    """Capped optimisation runs should not be limited to trace prefixes."""
    from benchmarks.cpu.branch.sweep import _windowed_traces

    events = [
        BranchEvent(
            pc=0x8000_0000 + i * 4,
            target=0x8000_1000 + i * 4,
            taken=bool(i & 1),
            kind=BR_COND,
        )
        for i in range(90)
    ]

    windows = _windowed_traces("trace", events, 900, 10, 3.0, "windows")
    assert [w.name for w in windows] == ["trace@prefix", "trace@middle", "trace@late"]
    assert [w.events[0].pc for w in windows] == [
        events[0].pc,
        events[40].pc,
        events[80].pc,
    ]
    assert sum(w.weight for w in windows) == 3.0

    stratified = _windowed_traces("trace", events, 900, 12, 3.0, "stratified")
    assert [w.name for w in stratified] == ["trace@stratified"]
    pcs = [ev.pc for ev in stratified[0].events]
    assert events[0].pc in pcs
    assert events[43].pc in pcs
    assert events[86].pc in pcs


def test_statistical_corrector_is_active():
    """The SC override path must remain executable. Use a deliberately lower
    threshold than the production baseline so this tiny microtrace exercises
    the corrector without constraining the tuned threshold."""
    geo = dict(DEFAULT_GEOMETRY)
    geo["SC_THRESH_INIT"] = 6
    geo["SC_LOCAL_HISTORY_BITS"] = 0
    geo["H2P_ENABLE"] = False
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

    entry = sim.loop.storage[(pc & 0xFFFF, 0)]
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

    assert (pc & 0xFFFF, 0) not in sim.loop.storage


def test_loop_predictor_path_signature_separates_same_pc_contexts():
    sim = BPUSimulator()
    pc = 0x8000_2400
    target = pc - 0x40

    for _ in range(8):
        for _ in range(8):
            sim.loop.update(pc, target, True, path_sig=0x12)
        sim.loop.update(pc, target, False, path_sig=0x12)
        for _ in range(3):
            sim.loop.update(pc, target, True, path_sig=0xA5)
        sim.loop.update(pc, target, False, path_sig=0xA5)

    long_entry = sim.loop.storage[(pc & 0xFFFF, 0x12)]
    short_entry = sim.loop.storage[(pc & 0xFFFF, 0xA5)]
    assert long_entry["iter_max"] == 8
    assert short_entry["iter_max"] == 3
    assert long_entry["conf"] == 7
    assert short_entry["conf"] == 7


def test_loop_predictor_imli_signature_separates_repeating_trip_phases():
    geo = dict(DEFAULT_GEOMETRY)
    geo["LOOP_IMLI_ENABLE"] = True
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_2600
    target = pc - 0x40
    pattern = (3, 5, 7, 5)

    for _ in range(8):
        for trip in pattern:
            for _ in range(trip - 1):
                sim.loop.update(pc, target, True, path_sig=0)
            sim.loop.update(pc, target, False, path_sig=0)

    learned_bounds = {entry["iter_max"] for entry in sim.loop.storage.values()}
    assert {2, 4, 6}.issubset(learned_bounds)
    assert sim.loop.imli_hist != 0


def test_loop_predictor_imli_can_be_disabled_for_ablation():
    geo = dict(DEFAULT_GEOMETRY)
    geo["LOOP_IMLI_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_2600
    target = pc - 0x40
    for trip in (3, 5, 7):
        for _ in range(trip - 1):
            sim.loop.update(pc, target, True, path_sig=0)
        sim.loop.update(pc, target, False, path_sig=0)
    assert sim.loop.imli_hist == 0


def test_loop_predictor_single_early_exit_keeps_saturated_bound():
    sim = BPUSimulator()
    pc = 0x8000_2800
    target = pc - 0x40

    for _ in range(8):
        for _ in range(8):
            sim.loop.update(pc, target, True)
        sim.loop.update(pc, target, False)

    entry = sim.loop.storage[(pc & 0xFFFF, 0)]
    assert entry["iter_max"] == 8
    assert entry["conf"] == 7

    for _ in range(3):
        sim.loop.update(pc, target, True)
    sim.loop.update(pc, target, False)

    assert entry["iter_max"] == 8
    assert entry["conf"] == 6
    assert entry["early_exit_seen"] == 1

    for _ in range(8):
        sim.loop.update(pc, target, True)
    sim.loop.update(pc, target, False)

    assert entry["iter_max"] == 8
    assert entry["conf"] == 7
    assert entry["early_exit_seen"] == 0


def test_ftb_target_confidence_tracks_stable_targets():
    sim = BPUSimulator()
    pc = 0x9000_2000
    target = 0x9000_5000
    other = 0x9000_6000

    sim.ftb.update(pc, target, BR_IND)
    assert sim.ftb.lookup(pc)["target_conf"] == 1
    sim.ftb.update(pc, target, BR_IND)
    assert sim.ftb.lookup(pc)["target_conf"] == 2
    sim.ftb.update(pc, other, BR_IND)
    assert sim.ftb.lookup(pc)["target_conf"] == 1


def test_ftb_lookup_uses_first_fetch_block_slot():
    sim = BPUSimulator()
    first_pc = 0x9000_2000
    second_pc = first_pc + 8
    first_target = 0x9000_5000
    second_target = 0x9000_6000

    sim.ftb.update(second_pc, second_target, BR_IND)
    assert sim.ftb.lookup(second_pc)["target"] == second_target

    sim.ftb.update(first_pc, first_target, BR_COND)

    assert sim.ftb.lookup(second_pc)["target"] == first_target
    assert sim.ftb.lookup(second_pc)["kind"] == BR_COND
    assert sim.ftb.lookup(first_pc)["target"] == first_target


def test_weak_ittage_yields_to_stable_ftb_target():
    sim = BPUSimulator()
    pc = 0x9000_3000
    stable = 0x9000_7000
    stale = 0x9000_8000
    idx, tag = sim.ittage._index_tag(0, pc, 0)

    sim.ftb.update(pc, stable, BR_IND)
    sim.ftb.update(pc, stable, BR_IND)
    sim.ftb.update(pc, stable, BR_IND)
    sim.ittage.storage[0][idx] = [
        {
            "tag": tag,
            "target": stale,
            "ctr": 1 << (sim.geometry["ITTAGE_CTR_W"] - 1),
            "useful": 0,
        }
    ]

    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=stable, taken=True, kind=BR_IND)
    )

    assert pred_taken
    assert pred_target == stable
    stats = sim.stats()
    assert stats["ittage_hit"] == 1
    assert stats["ittage_weak_yield_to_ftb"] == 1
    assert stats.get("ittage_target_used", 0) == 0


def test_ittage_model_reports_hit_use_update_and_allocation_counters():
    sim = BPUSimulator()
    pc = 0x9000_3040
    target = 0x9000_7800
    hist = 0

    sim.ittage.update(pc, hist, target, provider=0, misp=True)
    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=target, taken=True, kind=BR_IND)
    )

    assert pred_taken
    assert pred_target == target
    stats = sim.stats()
    assert stats["ittage_updates"] == 1
    assert stats["ittage_allocations"] == 1
    assert stats["ittage_hit"] == 1
    assert stats["ittage_target_used"] == 1


def test_ittage_timing_model_can_defer_same_event_target_use():
    geo = dict(DEFAULT_GEOMETRY)
    geo["ITTAGE_SAME_EVENT_TARGET"] = False
    sim = BPUSimulator(geometry=geo)
    pc = 0x9000_3060
    target = 0x9000_7860
    sim.ittage.update(pc, 0, target, provider=0, misp=True)

    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=target, taken=True, kind=BR_IND)
    )

    assert not pred_taken
    assert pred_target == pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]
    stats = sim.stats()
    assert stats["ittage_hit"] == 1
    assert stats["ittage_deferred_by_timing_model"] == 1
    assert stats.get("ittage_target_used", 0) == 0


def test_ittage_model_reports_weak_target_replacement_counter():
    sim = BPUSimulator()
    pc = 0x9000_3080
    old_target = 0x9000_7900
    new_target = 0x9000_7A00
    hist = 0
    idx, tag = sim.ittage._index_tag(sim.geometry["ITTAGE_REPLACE_MIN_PROVIDER"] - 1, pc, hist)
    sim.ittage.storage[sim.geometry["ITTAGE_REPLACE_MIN_PROVIDER"] - 1][idx] = [
        {
            "tag": tag,
            "target": old_target,
            "ctr": sim.geometry["ITTAGE_REPLACE_WEAK_CTR"],
            "useful": 0,
        }
    ]

    sim.ittage.update(
        pc,
        hist,
        new_target,
        provider=sim.geometry["ITTAGE_REPLACE_MIN_PROVIDER"],
        misp=False,
    )

    stats = sim.stats()
    assert stats["ittage_updates"] == 1
    assert stats["ittage_weak_target_replacements"] == 1
    assert (
        sim.ittage.storage[sim.geometry["ITTAGE_REPLACE_MIN_PROVIDER"] - 1][idx][0]["target"]
        == new_target
    )


def test_l2_ftb_late_redirect_rescues_call_target_after_l1_miss():
    geo = dict(DEFAULT_GEOMETRY)
    geo["L2_FTB_SAME_EVENT_LATE_REDIRECT"] = True
    sim = BPUSimulator(geometry=geo)
    pc = 0x9000_3400
    target = 0x9000_A000
    sim.l2_ftb.update(pc, target, BR_CALL)

    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=target, taken=True, kind=BR_CALL)
    )

    assert pred_taken
    assert pred_target == target
    counters = sim.stats()
    assert counters["l2_ftb_hit"] == 1
    assert counters["l2_ftb_late_redirect"] == 1


def test_direct_branch_uses_target_array_without_direction_or_ittage_training():
    sim = BPUSimulator()
    pc = 0x9000_3200
    target = 0x9000_E000

    for _ in range(3):
        sim.feed([BranchEvent(pc=pc, target=target, taken=True, kind=BR_DIRECT)])

    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=target, taken=True, kind=BR_DIRECT)
    )

    assert pred_taken
    assert pred_target == target
    stats = sim.stats()
    assert stats["direct"] == 3
    assert stats.get("cond", 0) == 0
    assert stats.get("ind", 0) == 0
    assert stats.get("call", 0) == 0


def test_l2_ftb_can_be_disabled_for_ablation():
    geo = dict(DEFAULT_GEOMETRY)
    geo["L2_FTB_ENTRIES"] = 0
    sim = BPUSimulator(geometry=geo)
    pc = 0x9000_3500
    target = 0x9000_A800
    sim.l2_ftb.update(pc, target, BR_CALL)

    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=target, taken=True, kind=BR_CALL)
    )

    assert not pred_taken
    assert pred_target == pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]
    assert sim.stats().get("l2_ftb_hit", 0) == 0


def test_l2_ftb_conditional_patch_requires_strong_taken_bimodal():
    geo = dict(DEFAULT_GEOMETRY)
    geo["L2_FTB_SAME_EVENT_LATE_REDIRECT"] = True
    sim = BPUSimulator(geometry=geo)
    pc = 0x9000_3600
    target = 0x9000_B000
    event = BranchEvent(pc=pc, target=target, taken=True, kind=BR_COND)
    sim.l2_ftb.update(pc, target, BR_COND)

    pred_taken, pred_target = sim._predict(event)
    assert not pred_taken
    assert pred_target == pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]

    for _ in range(2):
        sim.l2_cond_bim.update(pc, True)

    pred_taken, pred_target = sim._predict(event)
    assert pred_taken
    assert pred_target == target
    assert sim.stats()["l2_ftb_late_redirect"] == 1


def test_workload_class_partitions_model_target_predictions():
    sim = BPUSimulator()
    pc = 0x9000_3A00
    general_target = 0x9000_C000
    gpu_target = 0x9000_D000

    for _ in range(3):
        sim.feed([BranchEvent(pc=pc, target=general_target, taken=True, kind=BR_CALL)])

    pred_taken, pred_target = sim._predict(
        BranchEvent(
            pc=pc,
            target=gpu_target,
            taken=True,
            kind=BR_CALL,
            workload_class=1,
        )
    )
    assert not pred_taken
    assert pred_target == pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]

    for _ in range(3):
        sim.feed(
            [
                BranchEvent(
                    pc=pc,
                    target=gpu_target,
                    taken=True,
                    kind=BR_CALL,
                    workload_class=1,
                )
            ]
        )

    pred_taken, pred_target = sim._predict(
        BranchEvent(pc=pc, target=general_target, taken=True, kind=BR_CALL)
    )
    assert pred_taken
    assert pred_target == general_target

    pred_taken, pred_target = sim._predict(
        BranchEvent(
            pc=pc,
            target=gpu_target,
            taken=True,
            kind=BR_CALL,
            workload_class=1,
        )
    )
    assert pred_taken
    assert pred_target == gpu_target


def test_ittage_replaces_weak_stale_target():
    sim = BPUSimulator()
    pc = 0x9000_4000
    stale = 0x9000_8000
    target = 0x9000_9000
    table = sim.geometry["ITTAGE_REPLACE_MIN_PROVIDER"] - 1
    idx, tag = sim.ittage._index_tag(table, pc, 0)
    sim.ittage.storage[table][idx] = [
        {
            "tag": tag,
            "target": stale,
            "ctr": sim.geometry["ITTAGE_REPLACE_WEAK_CTR"],
            "useful": 0,
        }
    ]

    sim.ittage.update(pc, 0, target, provider=table + 1, misp=True)

    entry = sim.ittage.storage[table][idx][0]
    assert entry["target"] == target
    assert entry["ctr"] == 1 << (sim.geometry["ITTAGE_CTR_W"] - 1)
    assert entry["useful"] == 0


def test_ittage_set_associative_entries_keep_colliding_targets():
    sim = BPUSimulator()
    table = sim.geometry["ITTAGE_TABLES"] - 1
    pc_a = 0x9000_3800
    idx, tag_a = sim.ittage._index_tag(table, pc_a, 0)
    pc_b = None
    tag_b = None
    for candidate in range(pc_a + 0x10000, pc_a + 0x100000, 4):
        cand_idx, cand_tag = sim.ittage._index_tag(table, candidate, 0)
        if cand_idx == idx and cand_tag != tag_a:
            pc_b = candidate
            tag_b = cand_tag
            break
    assert pc_b is not None
    assert tag_b is not None

    target_a = 0x9010_0000
    target_b = 0x9020_0000
    sim.ittage.update(pc_a, 0, target_a, provider=table, misp=True)
    sim.ittage.update(pc_b, 0, target_b, provider=table, misp=True)

    assert sim.ittage.predict(pc_a, 0) == (target_a, table + 1, 4)
    assert sim.ittage.predict(pc_b, 0) == (target_b, table + 1, 4)


def test_ittage_keeps_low_provider_stale_target_until_aged():
    sim = BPUSimulator()
    pc = 0x9000_5000
    stale = 0x9000_8000
    target = 0x9000_9000
    idx, tag = sim.ittage._index_tag(0, pc, 0)
    sim.ittage.storage[0][idx] = [
        {
            "tag": tag,
            "target": stale,
            "ctr": sim.geometry["ITTAGE_REPLACE_WEAK_CTR"],
            "useful": 1,
        }
    ]

    sim.ittage.update(pc, 0, target, provider=1, misp=True)

    entry = sim.ittage.storage[0][idx][0]
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
    sim.ittage.storage[0][idx] = [
        {
            "tag": tag ^ 0x1,
            "target": old_target,
            "ctr": 4,
            "useful": 1,
        }
    ]
    sim.ittage.storage[0][idx].append(
        {
            "tag": tag ^ 0x2,
            "target": old_target,
            "ctr": 4,
            "useful": 1,
        }
    )
    sim.ittage.update(pc, 0, new_target, provider=0, misp=True)
    assert all(entry["target"] == old_target for entry in sim.ittage.storage[0][idx])
    idx1, _tag1 = sim.ittage._index_tag(1, pc, 0)
    assert sim.ittage.storage[1][idx1][0]["target"] == new_target

    sim.ittage.update(pc, 0, new_target, provider=0, misp=False)
    assert sim.ittage.storage[0][idx][0]["useful"] == 0
    for table in range(1, geo["ITTAGE_TABLES"]):
        idx_t, tag_t = sim.ittage._index_tag(table, pc, 0)
        sim.ittage.storage[table][idx_t] = [
            {
                "tag": tag_t ^ 0x1,
                "target": old_target,
                "ctr": 4,
                "useful": 1,
            }
        ]
        sim.ittage.storage[table][idx_t].append(
            {
                "tag": tag_t ^ 0x2,
                "target": old_target,
                "ctr": 4,
                "useful": 1,
            }
        )
    sim.ittage.update(pc, 0, new_target, provider=0, misp=True)
    assert any(entry["target"] == new_target for entry in sim.ittage.storage[0][idx])


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


def test_tage_adaptive_use_alt_on_na_learns_alternate_confidence():
    """Adaptive use-alt-on-NA should start conservative, then trust alt."""
    pc = 0x8000_8900
    hist = 0xA5

    geo = dict(DEFAULT_GEOMETRY)
    geo["TAGE_ALT_ON_NA_ENTRIES"] = 16
    geo["TAGE_ALT_ON_NA_THRESHOLD"] = 1
    sim = BPUSimulator(geometry=geo)
    weak_provider = sim.tage.tables[1]
    strong_alt = sim.tage.tables[0]

    idx, tag = strong_alt._index_tag(pc, hist)
    strong_alt.storage[idx] = {"tag": tag, "ctr": 0, "useful": 1}
    idx, tag = weak_provider._index_tag(pc, hist)
    weak_provider.storage[idx] = {
        "tag": tag,
        "ctr": 1 << (geo["TAGE_CTR_W"] - 1),
        "useful": 0,
    }

    taken, provider, low_conf = sim.tage.predict(pc, hist)
    assert provider == 2
    assert low_conf
    assert taken

    sim.tage.update(pc, hist, hist, taken=False, provider=provider, misp=False)
    weak_provider.storage[idx]["ctr"] = 1 << (geo["TAGE_CTR_W"] - 1)

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
    sim.sc.update(pc, 0, False, tage_lowconf=False)
    assert sim.sc.local_history[idx] == 0b1010


def test_sc_bias_bank_trains_on_high_confidence_updates():
    geo = dict(DEFAULT_GEOMETRY)
    geo["SC_BIAS_ENABLE"] = True
    geo["SC_THRESH_INIT"] = 4
    geo["SC_LOCAL_HISTORY_BITS"] = 0
    geo["SC_TABLES"] = 1
    geo["SC_HIST_LEN"] = (0,)
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_5678

    for _ in range(8):
        sim.sc.update(pc, 0, True, tage_lowconf=False)

    idx = sim.sc._bias_idx(pc)
    assert sim.sc.bias[idx] > 0
    override, taken = sim.sc.predict(pc, 0, tage_lowconf=True)
    assert override
    assert taken


def test_sc_bias_bank_disabled_by_default_after_sweep():
    sim = BPUSimulator()
    pc = 0x8000_5678
    for _ in range(8):
        sim.sc.update(pc, 0, True, tage_lowconf=False)
    idx = sim.sc._bias_idx(pc)
    assert sim.sc.bias[idx] == 0


def test_local_direction_corrector_learns_short_alternation():
    geo = dict(DEFAULT_GEOMETRY)
    geo["LOCAL_DIR_ENABLE"] = True
    geo["LOCAL_DIR_META_ENABLE"] = False
    geo["H2P_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_1350

    for taken in (True, False, True):
        sim.local_dir.update(pc, taken)

    conf, taken = sim.local_dir.predict(pc)
    assert conf
    assert not taken


def test_local_direction_corrector_overrides_tage_when_saturated():
    event = BranchEvent(pc=0x8000_2460, target=0x9000_0000, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["LOCAL_DIR_ENABLE"] = True
    geo["LOCAL_DIR_META_ENABLE"] = False
    geo["H2P_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)
    idx = sim.local_dir._idx(event.pc)
    meta_idx = sim.local_dir_meta._idx(event.pc)
    sim.local_dir.history[idx] = 0
    sim.local_dir.pht[idx][0] = 0
    sim.local_dir_meta.ctrs[meta_idx] = sim.geometry["LOCAL_DIR_META_THRESHOLD"]

    taken, target = sim._predict(event)
    assert not taken
    assert target == event.pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]

    off_geo = dict(DEFAULT_GEOMETRY)
    off_geo["LOCAL_DIR_ENABLE"] = False
    off = BPUSimulator(geometry=off_geo)
    off.ftb.update(event.pc, event.target, event.kind)
    taken, target = off._predict(event)
    assert taken
    assert target == event.target


def test_local_direction_meta_chooser_suppresses_unearned_override():
    event = BranchEvent(pc=0x8000_2460, target=0x9000_0000, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["LOCAL_DIR_ENABLE"] = True
    geo["LOCAL_DIR_META_ENABLE"] = True
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)
    idx = sim.local_dir._idx(event.pc)
    sim.local_dir.history[idx] = 0
    sim.local_dir.pht[idx][0] = 0

    taken, target = sim._predict(event)
    assert taken
    assert target == event.target

    for _ in range(2):
        sim.local_dir_meta.update(event.pc, True, False, False)

    taken, target = sim._predict(event)
    assert not taken
    assert target == event.pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]


def test_h2p_corrector_can_override_base_direction_when_confident():
    event = BranchEvent(pc=0x8000_33C0, target=0x9000_2000, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 8
    geo["H2P_THRESHOLD"] = 2
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)

    for _ in range(4):
        sim.h2p.update(event.pc, 0, False)

    taken, target = sim._predict(event)
    assert not taken
    assert target == event.pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]
    assert sim.h2p.predict(event.pc, 0)[0]


def test_h2p_model_uses_rtl_bias_plus_feature_weights():
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 4
    geo["H2P_TARGET_HIST_LEN"] = 2
    geo["H2P_PATH_HIST_LEN"] = 2
    geo["H2P_THRESHOLD"] = 4
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_33C4

    sim.h2p.update(pc, 0b1010, True, target_hist=0b01, path_hist=0b10)
    weights = sim.h2p.weights[sim.h2p._idx(pc)]

    assert weights == [1, -1, 1, -1, 1, 1, -1, -1, 1]
    conf, taken, score = sim.h2p.predict(pc, 0b1010, target_hist=0b01, path_hist=0b10)
    assert conf
    assert taken
    assert score == 9
    opposite_conf, opposite_taken, opposite_score = sim.h2p.predict(
        pc,
        0b0101,
        target_hist=0b10,
        path_hist=0b01,
    )
    assert opposite_conf
    assert not opposite_taken
    assert opposite_score == -7


def test_h2p_meta_chooser_suppresses_unearned_override():
    event = BranchEvent(pc=0x8000_33D0, target=0x9000_2400, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 8
    geo["H2P_THRESHOLD"] = 2
    geo["H2P_META_ENABLE"] = True
    geo["H2P_META_ENTRIES"] = 16
    geo["LOCAL_DIR_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)

    for _ in range(4):
        sim.h2p.update(event.pc, 0, False)

    taken, target = sim._predict(event)
    assert taken
    assert target == event.target

    sim._step(event)
    assert sim.counters["h2p_meta_blocked"] == 1
    assert sim.h2p_meta.ctrs[sim.h2p_meta._idx(event.pc)] > 0


def test_h2p_lowconf_only_blocks_high_confidence_base_override():
    event = BranchEvent(pc=0x8000_33D8, target=0x9000_2600, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 8
    geo["H2P_THRESHOLD"] = 2
    geo["H2P_LOWCONF_ONLY"] = 1
    geo["LOCAL_DIR_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)

    for _ in range(4):
        sim.h2p.update(event.pc, 0, False)

    taken, target = sim._predict(event)
    assert taken
    assert target == event.target
    assert sim.counters["h2p_lowconf_blocked"] == 1
    assert not sim.tage.predict(event.pc, 0)[2]


def test_h2p_meta_chooser_allows_earned_override():
    event = BranchEvent(pc=0x8000_33E0, target=0x9000_2800, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 8
    geo["H2P_THRESHOLD"] = 2
    geo["H2P_META_ENABLE"] = True
    geo["H2P_META_ENTRIES"] = 16
    geo["LOCAL_DIR_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)

    for _ in range(4):
        sim.h2p.update(event.pc, 0, False)
    sim.h2p_meta.update(event.pc, base_taken=True, side_taken=False, actual=False)

    taken, target = sim._predict(event)
    assert not taken
    assert target == event.pc + DEFAULT_GEOMETRY["FETCH_BLOCK_BYTES"]


def test_h2p_priority_suppresses_local_dir_meta_training():
    event = BranchEvent(pc=0x8000_3440, target=0x9000_3000, taken=True, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 8
    geo["H2P_THRESHOLD"] = 2
    geo["LOCAL_DIR_ENABLE"] = True
    geo["LOCAL_DIR_META_ENABLE"] = True
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)

    idx = sim.local_dir._idx(event.pc)
    meta_idx = sim.local_dir_meta._idx(event.pc)
    sim.local_dir.history[idx] = 0
    sim.local_dir.pht[idx][0] = 0
    for _ in range(4):
        sim.h2p.update(event.pc, 0, False)

    before = sim.local_dir_meta.ctrs[meta_idx]
    sim._step(event)
    assert sim.local_dir_meta.ctrs[meta_idx] == before
    assert sim.counters["h2p_override"] == 1
    assert sim.counters["local_dir_override"] == 0


def test_slow_direction_timing_model_defers_sc_local_and_h2p_overrides():
    event = BranchEvent(pc=0x8000_3480, target=0x9000_3400, taken=False, kind=BR_COND)
    geo = dict(DEFAULT_GEOMETRY)
    geo["SC_SAME_EVENT_OVERRIDE"] = False
    geo["LOCAL_DIR_SAME_EVENT_OVERRIDE"] = False
    geo["H2P_SAME_EVENT_OVERRIDE"] = False
    geo["H2P_THRESHOLD"] = 2
    geo["LOCAL_DIR_META_ENABLE"] = False
    sim = BPUSimulator(geometry=geo)
    sim.ftb.update(event.pc, event.target, event.kind)
    sim.tage.tables[0].try_allocate(event.pc, 0, True)

    for _ in range(6):
        sim.sc.update(event.pc, 0, False, tage_lowconf=True)
        sim.h2p.update(event.pc, 0, False)
    idx = sim.local_dir._idx(event.pc)
    sim.local_dir.history[idx] = 0
    sim.local_dir.pht[idx][0] = 0

    pred_taken, pred_target = sim._predict(event)

    assert pred_taken
    assert pred_target == event.target
    stats = sim.stats()
    assert stats["sc_deferred_by_timing_model"] >= 1
    assert stats["local_dir_deferred_by_timing_model"] >= 1
    assert stats["h2p_deferred_by_timing_model"] >= 1
    assert stats.get("sc_override", 0) == 0
    assert stats.get("local_dir_override", 0) == 0
    assert stats.get("h2p_override", 0) == 0


def test_h2p_multi_perspective_target_history_can_split_same_pc():
    geo = dict(DEFAULT_GEOMETRY)
    geo["H2P_ENABLE"] = True
    geo["H2P_HIST_LEN"] = 0
    geo["H2P_TARGET_HIST_LEN"] = 4
    geo["H2P_PATH_HIST_LEN"] = 0
    geo["H2P_THRESHOLD"] = 3
    sim = BPUSimulator(geometry=geo)
    pc = 0x8000_35C0

    for _ in range(8):
        sim.h2p.update(pc, 0, False, target_hist=0b0011)
        sim.h2p.update(pc, 0, True, target_hist=0b1100)

    low_conf, low_taken, low_score = sim.h2p.predict(pc, 0, target_hist=0b0011)
    high_conf, high_taken, high_score = sim.h2p.predict(pc, 0, target_hist=0b1100)
    assert low_conf and high_conf
    assert not low_taken
    assert high_taken
    assert low_score < 0 < high_score


def test_h2p_corrector_enabled_by_default_after_sweep():
    sim = BPUSimulator()
    pc = 0x8000_33C0
    for _ in range(4):
        sim.h2p.update(pc, 0, False)

    conf, taken, score = sim.h2p.predict(pc, 0)
    assert conf
    assert not taken
    assert score < 0


def test_local_direction_corrector_enabled_with_meta_after_h2p_sweep():
    sim = BPUSimulator()
    pc = 0x8000_1350
    for taken in (True, False) * 8:
        sim.local_dir.update(pc, taken)
    conf, taken = sim.local_dir.predict(pc)
    assert conf
    assert taken
    assert sim.local_dir_meta.enable


def test_execlog_decoder_reconstructs_branch_classes():
    """The QEMU execlog decoder must classify RV64 control transfers and use
    the next executed PC as ground-truth direction/target."""
    import tempfile
    from pathlib import Path

    from benchmarks.cpu.branch.workload_trace import decode_execlog

    # cond not-taken, cond taken, direct jump, call, ret, indirect jump.
    lines = [
        '0, 0x1000, 0x463, "beqz a0,8 # 0x1008"',  # not taken -> next 0x1004
        '0, 0x1004, 0x13, "addi x0,x0,0"',
        '0, 0x1006, 0x463, "bne a0,a1,6 # 0x100c"',  # taken -> next 0x100c
        '0, 0x100c, 0x6f, "j 16 # 0x101c"',  # direct -> next 0x101c
        '0, 0x101c, 0x13, "addi x0,x0,0"',
        '0, 0x101e, 0xef, "jal ra,16 # 0x102e"',  # call -> next 0x102e
        '0, 0x102e, 0x13, "addi x0,x0,0"',
        '0, 0x1030, 0x8082, "ret"',  # ret -> next 0x1010
        '0, 0x1010, 0x8782, "jr a5"',  # indirect -> next 0x2000
        '0, 0x2000, 0x13, "addi x0,x0,0"',
    ]
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "t.execlog.txt"
        p.write_text("\n".join(lines) + "\n")
        branches, stats = decode_execlog(p)
    kinds = [b.kind for b in branches]
    assert kinds == [BR_COND, BR_COND, BR_DIRECT, BR_CALL, BR_RET, BR_IND]
    assert branches[0].taken is False  # beqz fell through
    assert branches[1].taken is True  # bne taken
    assert branches[2].kind == BR_DIRECT and branches[2].target == 0x101C
    assert branches[3].kind == BR_CALL and branches[3].call_return_pc == 0x1022
    assert stats.direct_jump == 1
    assert stats.cond == 2
    assert stats.instruction_count == len(lines)


def test_workload_trace_roundtrips_bpu_context_fields():
    import tempfile
    from pathlib import Path

    from benchmarks.cpu.branch.workload_trace import (
        WorkloadTraceStats,
        read_workload_trace,
        write_workload_trace,
    )

    branch = BranchEvent(
        pc=0x8000_0000,
        target=0x8000_1000,
        taken=True,
        kind=BR_COND,
        asid=0x12,
        vmid=0x3,
        priv=0x1,
        secure=1,
        workload_class=2,
    )
    stats = WorkloadTraceStats(instruction_count=10, branch_count=1, cond=1)
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "ctx.btrace.json"
        write_workload_trace(path, [branch], stats, source={"workload": "ctx"})
        got, inst_count = read_workload_trace(path)

    assert inst_count == 10
    assert got[0].asid == branch.asid
    assert got[0].vmid == branch.vmid
    assert got[0].priv == branch.priv
    assert got[0].secure == branch.secure
    assert got[0].workload_class == branch.workload_class
