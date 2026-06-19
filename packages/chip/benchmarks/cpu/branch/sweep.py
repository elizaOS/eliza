#!/usr/bin/env python3
"""Branch-predictor experiment harness: sweep BPU geometry against the trace
set and rank configurations by misprediction rate.

This is the optimisation loop for the E1 BPU. It runs the behavioural
:class:`BPUSimulator` under a set of candidate geometries over a trace set
that spans the E1's real duty cycle and standard hard references:

  * ``agent_loop``  — real RV64 trace of the llama.cpp agent duty cycle
                      (GEMV-dominated, the common case).
  * ``agent_decode``— real RV64 trace weighted to the hard, data-dependent
                      tokenizer/sampler/stream branches.
  * ``cbp5:*``      — CBP2025 championship training-trace samples (the hard
                      discriminating reference; compared to the published
                      64 KB TAGE-SC-L results).

For each config it reports per-trace MPKI and a workload-weighted aggregate,
then writes a leaderboard and an evidence envelope. Tuning runs on a capped
branch prefix for turnaround by default; ``--window-mode`` can instead evaluate
middle/late/stratified capped windows so short optimisation runs do not overfit
the start of long traces. Re-run the winner with ``--max-branches 0`` on the
full traces to lock the number.

Config knobs map one-to-one to ``rtl/cpu/bpu/bpu_pkg.sv`` parameters, so a
winning config is a direct RTL proposal.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.cpu.branch.bpu_model import (  # noqa: E402
    DEFAULT_GEOMETRY,
    BPUSimulator,
    BranchEvent,
)
from benchmarks.cpu.branch.traces import SYNTHETIC_GENERATORS, read_cbp5_with_count  # noqa: E402
from benchmarks.cpu.branch.workload_trace import read_workload_trace  # noqa: E402

EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
SWEEP_JSON = EVIDENCE_DIR / "bpu_sweep_results.json"
LEADERBOARD_MD = EVIDENCE_DIR / "bpu_sweep_leaderboard.md"
WORKLOAD_DIR = ROOT / "external/workload-traces"
CBP5_DIR = ROOT / "external/cbp5-traces"

# CBP2016 64 KB TAGE-SC-L reference MPKI on the CBP2025 sample traces, used as
# the SOTA bar for the hard references (from run_mpki.CBP5_REFERENCE_PER_TRACE).
CBP5_REFERENCE = {"sample_int_trace": 5.1327, "sample_fp_trace": 0.5736}

ITTAGE_EVIDENCE_COUNTERS = (
    "ittage_hit",
    "ittage_target_used",
    "ittage_weak_yield_to_ftb",
    "ittage_updates",
    "ittage_allocations",
    "ittage_weak_target_replacements",
    "ittage_victim_replacements",
    "ittage_provider_evictions",
    "ittage_useful_aging",
)

TIMING_EVIDENCE_COUNTERS = (
    "sc_deferred_by_timing_model",
    "h2p_deferred_by_timing_model",
    "local_dir_deferred_by_timing_model",
    "ittage_deferred_by_timing_model",
    "l2_ftb_deferred_by_timing_model",
    "l2_ftb_late_redirect",
)

# Real RV64 workloads to include (besides the CBP-5 references). The agent
# traces cover the inference duty cycle; io_stream covers streaming/IO/parsing;
# system_mix covers broader CPU and GPU-control-plane branch shapes.
WORKLOAD_NAMES = (
    "agent_loop",
    "agent_decode",
    "http_parser",
    "text_log",
    "file_tlv",
    "video_blocks",
    "audio_frames",
    "build_compiler_proxy",
    "compression_proxy",
    "crypto_packet_proxy",
    "database_btree_proxy",
    "gpu_control_proxy",
    "browser_layout_proxy",
    "kernel_syscall_proxy",
    "gc_runtime_proxy",
    "gpu_memory_residency_proxy",
    "gpu_irq_fence_scheduler_proxy",
    "nn_delegate_fallback_proxy",
    "mobile_ui_frame_scheduler_proxy",
    "wasm_jit_osr_proxy",
)

SYNTHETIC_SWEEP_WORKLOADS = (
    "always_taken",
    "always_not_taken",
    "alternating",
    "loop_with_known_trip",
    "deep_recursion",
    "v8_indirect_dispatch",
    "mixed_workload",
    "jit_dispatch_warmup",
    "gpu_tile_kernel",
    "gpu_warp_divergence",
    "gpu_command_processor",
    "dual_branch_fetch_block",
    "nested_imli_loop",
    "correlated_xor_branches",
    "vtable_path_correlated",
    "interpreter_dispatch_mixed",
    "phase_change_server",
    "alias_thrash",
    "gpu_occupancy_phase",
    "gpu_nested_reconvergence",
    "control_indirect_pair",
    "command_buffer_validation",
    "work_stealing_queues",
    "hash_probe_inline_cache",
    "allocator_gc_barrier",
    "btb_confidence_churn",
    "l2_ftb_target_pressure",
    "gpu_wavefront_compaction",
    "epoll_rpc_dispatch",
    "json_parser_state_machine",
    "android_runtime_inline_cache",
    "signal_exception_unwind",
    "gpu_driver_submit_phases",
    "workload_class_phase_alias",
    "cross_asid_same_pc_alias",
    "wasm_threaded_interpreter_tiering",
    "return_mismatch_exceptions",
)

# Default per-trace weights for the aggregate objective: the E1's own workloads
# are the optimisation target, so they outweigh the championship references.
DEFAULT_WEIGHTS = {
    "agent_loop": 2.0,
    "agent_decode": 1.5,
    "http_parser": 1.5,
    "text_log": 1.5,
    "file_tlv": 1.5,
    "video_blocks": 1.5,
    "audio_frames": 1.5,
    "build_compiler_proxy": 1.25,
    "compression_proxy": 1.25,
    "crypto_packet_proxy": 1.0,
    "database_btree_proxy": 1.25,
    "gpu_control_proxy": 1.5,
    "browser_layout_proxy": 1.25,
    "kernel_syscall_proxy": 1.25,
    "gc_runtime_proxy": 1.25,
    "gpu_memory_residency_proxy": 1.35,
    "gpu_irq_fence_scheduler_proxy": 1.35,
    "nn_delegate_fallback_proxy": 1.2,
    "mobile_ui_frame_scheduler_proxy": 1.25,
    "wasm_jit_osr_proxy": 1.2,
    # Synthetic traces keep the objective honest around known hard shapes.
    # GPU-oriented traces get enough weight to steer tie-breaks without
    # overpowering the real RV64 and CBP-5 references.
    "synthetic:always_taken": 0.25,
    "synthetic:always_not_taken": 0.25,
    "synthetic:alternating": 0.35,
    "synthetic:loop_with_known_trip": 0.5,
    "synthetic:deep_recursion": 0.35,
    "synthetic:v8_indirect_dispatch": 0.5,
    "synthetic:mixed_workload": 0.75,
    "synthetic:jit_dispatch_warmup": 0.75,
    "synthetic:gpu_tile_kernel": 1.0,
    "synthetic:gpu_warp_divergence": 1.0,
    "synthetic:gpu_command_processor": 1.0,
    "synthetic:dual_branch_fetch_block": 0.75,
    "synthetic:nested_imli_loop": 0.75,
    "synthetic:correlated_xor_branches": 0.75,
    "synthetic:vtable_path_correlated": 0.75,
    "synthetic:interpreter_dispatch_mixed": 0.75,
    "synthetic:phase_change_server": 0.75,
    "synthetic:alias_thrash": 0.5,
    "synthetic:gpu_occupancy_phase": 0.75,
    "synthetic:gpu_nested_reconvergence": 0.75,
    "synthetic:control_indirect_pair": 0.75,
    "synthetic:command_buffer_validation": 0.85,
    "synthetic:work_stealing_queues": 0.85,
    "synthetic:hash_probe_inline_cache": 0.75,
    "synthetic:allocator_gc_barrier": 0.75,
    "synthetic:l2_ftb_target_pressure": 0.75,
    "synthetic:gpu_wavefront_compaction": 0.85,
    "synthetic:epoll_rpc_dispatch": 0.85,
    "synthetic:json_parser_state_machine": 0.75,
    "synthetic:android_runtime_inline_cache": 0.85,
    "synthetic:signal_exception_unwind": 0.5,
    "synthetic:gpu_driver_submit_phases": 0.85,
    "synthetic:workload_class_phase_alias": 0.75,
    "synthetic:cross_asid_same_pc_alias": 0.75,
    "synthetic:wasm_threaded_interpreter_tiering": 0.85,
    "synthetic:return_mismatch_exceptions": 0.35,
    "cbp5:sample_int_trace": 1.0,
    "cbp5:sample_fp_trace": 1.0,
}


def _geo(**overrides) -> dict:
    g = dict(DEFAULT_GEOMETRY)
    g.update(overrides)
    return g


PRE_OPT_R8_GEOMETRY = _geo(
    TAGE_ALLOC_DECREMENT=False,
    TAGE_UBIT_RESET_PERIOD=262_144,
    TAGE_HIST_LEN=(8, 13, 32, 64, 119),
    TAGE_ENTRIES_TABLE=4096,
    SC_ADAPTIVE=False,
)

PRE_TARGET_HISTORY_GEOMETRY = _geo(
    SC_THRESH_INIT=6,
    ITTAGE_TARGET_HISTORY_BITS=0,
)

PRE_ITTAGE_HIST_LONG_GEOMETRY = _geo(
    ITTAGE_HIST_LEN=(4, 8, 13, 16, 32),
)


# Candidate configurations. Each knob is a real bpu_pkg.sv parameter; lists
# that change a table count carry a matching-length history schedule.
CONFIGS: dict[str, dict] = {
    "baseline": _geo(),
    "pre_ittage_hist_long": PRE_ITTAGE_HIST_LONG_GEOMETRY,
    "pre_opt_r8": PRE_OPT_R8_GEOMETRY,
    "pre_target_history": PRE_TARGET_HISTORY_GEOMETRY,
    # ---- TAGE direction: history reach + capacity ----
    "tage_reach_long": _geo(TAGE_HIST_LEN=(8, 16, 44, 90, 195)),
    "tage_reach_xlong": _geo(TAGE_HIST_LEN=(10, 20, 50, 120, 260)),
    "tage6_tables": _geo(TAGE_TABLES=6, TAGE_HIST_LEN=(8, 13, 24, 48, 96, 195)),
    "tage7_tables": _geo(TAGE_TABLES=7, TAGE_HIST_LEN=(6, 11, 18, 32, 64, 128, 256)),
    "tage_big_tables": _geo(TAGE_ENTRIES_TABLE=8192),
    "bim_big": _geo(BIM_ENTRIES=32768),
    # ---- Statistical corrector ----
    "sc_thresh_low": _geo(SC_THRESH_INIT=4),
    "sc_thresh_mid": _geo(SC_THRESH_INIT=6),
    "sc_thresh_high": _geo(SC_THRESH_INIT=8),
    "sc_thresh_xhigh": _geo(SC_THRESH_INIT=10),
    "sc_thresh_12": _geo(SC_THRESH_INIT=12),
    "sc_adaptive": _geo(SC_ADAPTIVE=True),
    "sc_no_local_hist": _geo(SC_LOCAL_HISTORY_BITS=0),
    "sc_local_hist8": _geo(SC_LOCAL_HISTORY_BITS=8),
    "sc_local_hist12": _geo(SC_LOCAL_HISTORY_BITS=12),
    "sc_local_hist8_big": _geo(SC_LOCAL_HISTORY_BITS=8, SC_LOCAL_HISTORY_ENTRIES=2048),
    "sc_bias_default": _geo(SC_BIAS_ENABLE=True),
    "sc_bias_big": _geo(SC_BIAS_ENABLE=True, SC_BIAS_ENTRIES=4096, SC_BIAS_CTR_W=5),
    "h2p_off": _geo(H2P_ENABLE=False),
    "pre_h2p_big_t36": _geo(H2P_ENABLE=True, H2P_ENTRIES=512, H2P_HIST_LEN=64, H2P_THRESHOLD=36),
    "h2p_default": _geo(H2P_ENABLE=True),
    "h2p_meta_t1": _geo(H2P_ENABLE=True, H2P_META_ENABLE=True, H2P_META_THRESHOLD=1),
    "h2p_meta_t2": _geo(H2P_ENABLE=True, H2P_META_ENABLE=True, H2P_META_THRESHOLD=2),
    "h2p_meta_2k_t1": _geo(
        H2P_ENABLE=True,
        H2P_META_ENABLE=True,
        H2P_META_ENTRIES=2048,
        H2P_META_THRESHOLD=1,
    ),
    "h2p_small": _geo(H2P_ENABLE=True, H2P_ENTRIES=256, H2P_HIST_LEN=24, H2P_THRESHOLD=18),
    "h2p_long": _geo(H2P_ENABLE=True, H2P_ENTRIES=512, H2P_HIST_LEN=64, H2P_THRESHOLD=36),
    "h2p_long_t44": _geo(H2P_ENABLE=True, H2P_ENTRIES=512, H2P_HIST_LEN=64, H2P_THRESHOLD=44),
    "h2p_long_t60": _geo(H2P_ENABLE=True, H2P_ENTRIES=512, H2P_HIST_LEN=64, H2P_THRESHOLD=60),
    "h2p_lowconf_only": _geo(H2P_ENABLE=True, H2P_LOWCONF_ONLY=1),
    "h2p_big": _geo(H2P_ENABLE=True, H2P_ENTRIES=1024, H2P_HIST_LEN=48, H2P_THRESHOLD=30),
    "h2p_big_t36": _geo(H2P_ENABLE=True, H2P_ENTRIES=1024, H2P_HIST_LEN=48, H2P_THRESHOLD=36),
    "h2p_big_t42": _geo(H2P_ENABLE=True, H2P_ENTRIES=1024, H2P_HIST_LEN=48, H2P_THRESHOLD=42),
    "h2p_big_t50": _geo(H2P_ENABLE=True, H2P_ENTRIES=1024, H2P_HIST_LEN=48, H2P_THRESHOLD=50),
    "h2p_big_t36_lowconf": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_THRESHOLD=36,
        H2P_LOWCONF_ONLY=1,
    ),
    "h2p_mp_target": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=512,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=0,
        H2P_THRESHOLD=34,
    ),
    "h2p_mp_path": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=512,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=0,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=34,
    ),
    "h2p_mp_target_path": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=512,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=40,
    ),
    "h2p_mp_big": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=42,
    ),
    "h2p_mp_big_t50": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=50,
    ),
    "h2p_mp_big_t56": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=56,
    ),
    "h2p_mp_big_t64": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=64,
    ),
    "h2p_mp_big_t50_lowconf": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=50,
        H2P_LOWCONF_ONLY=1,
    ),
    "h2p_mp_big_meta_t1": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=42,
        H2P_META_ENABLE=True,
        H2P_META_THRESHOLD=1,
    ),
    "h2p_mp_big_meta_t2": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=1024,
        H2P_HIST_LEN=48,
        H2P_TARGET_HIST_LEN=16,
        H2P_PATH_HIST_LEN=16,
        H2P_THRESHOLD=42,
        H2P_META_ENABLE=True,
        H2P_META_THRESHOLD=2,
    ),
    "h2p_long_local_meta": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=512,
        H2P_HIST_LEN=64,
        H2P_THRESHOLD=36,
        LOCAL_DIR_ENABLE=True,
        LOCAL_DIR_META_ENABLE=True,
    ),
    "h2p_long_imli": _geo(
        H2P_ENABLE=True,
        H2P_ENTRIES=512,
        H2P_HIST_LEN=64,
        H2P_THRESHOLD=36,
        LOOP_IMLI_ENABLE=True,
        LOOP_IMLI_HIST_W=6,
        LOOP_IMLI_TOKEN_W=3,
    ),
    "local_dir_off": _geo(LOCAL_DIR_ENABLE=False),
    "local_dir_on": _geo(LOCAL_DIR_ENABLE=True),
    "local_dir_meta_off": _geo(LOCAL_DIR_ENABLE=True, LOCAL_DIR_META_ENABLE=False),
    "local_dir_meta": _geo(LOCAL_DIR_ENABLE=True, LOCAL_DIR_META_ENABLE=True),
    "local_dir_meta_big": _geo(
        LOCAL_DIR_ENABLE=True,
        LOCAL_DIR_META_ENABLE=True,
        LOCAL_DIR_META_ENTRIES=2048,
    ),
    "local_dir_big": _geo(LOCAL_DIR_ENABLE=True, LOCAL_DIR_ENTRIES=2048),
    "sc_wide": _geo(
        SC_TABLES=6,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44),
    ),
    "sc_wide_thresh6": _geo(
        SC_TABLES=6,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44),
        SC_THRESH_INIT=6,
    ),
    "sc_wide_long": _geo(
        SC_TABLES=8,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44, 72, 119),
    ),
    # ---- Loop predictor ----
    "loop_big": _geo(LOOP_ENTRIES=128),
    "loop_imli_off": _geo(LOOP_IMLI_ENABLE=False),
    "loop_imli_on": _geo(LOOP_IMLI_ENABLE=True),
    "loop_imli_hist4": _geo(LOOP_IMLI_ENABLE=True, LOOP_IMLI_HIST_W=4),
    "loop_imli_hist4_token2": _geo(
        LOOP_IMLI_ENABLE=True,
        LOOP_IMLI_HIST_W=4,
        LOOP_IMLI_TOKEN_W=2,
    ),
    "loop_imli_hist4_token3": _geo(
        LOOP_IMLI_ENABLE=True,
        LOOP_IMLI_HIST_W=6,
        LOOP_IMLI_TOKEN_W=3,
    ),
    "loop_imli_hist8": _geo(LOOP_IMLI_ENABLE=True, LOOP_IMLI_HIST_W=8),
    "loop_imli_hist8_token3": _geo(
        LOOP_IMLI_ENABLE=True,
        LOOP_IMLI_HIST_W=8,
        LOOP_IMLI_TOKEN_W=3,
    ),
    "loop_imli_hist8_token5": _geo(
        LOOP_IMLI_ENABLE=True,
        LOOP_IMLI_HIST_W=10,
        LOOP_IMLI_TOKEN_W=5,
    ),
    "loop_imli_hist24": _geo(LOOP_IMLI_ENABLE=True, LOOP_IMLI_HIST_W=24),
    # ---- Delayed L2 FTB target tier ----
    "l2_ftb_off": _geo(L2_FTB_ENTRIES=0),
    "l2_ftb_small": _geo(L2_FTB_ENTRIES=4096, L2_FTB_WAYS=8),
    "l2_ftb_big": _geo(L2_FTB_ENTRIES=16384, L2_FTB_WAYS=8),
    # ---- Predictor timing ablations: model late/next-cycle overrides ----
    "timing_slow_dir_deferred": _geo(
        SC_SAME_EVENT_OVERRIDE=False,
        H2P_SAME_EVENT_OVERRIDE=False,
        LOCAL_DIR_SAME_EVENT_OVERRIDE=False,
    ),
    "timing_ittage_deferred": _geo(ITTAGE_SAME_EVENT_TARGET=False),
    "timing_all_slow_deferred": _geo(
        SC_SAME_EVENT_OVERRIDE=False,
        H2P_SAME_EVENT_OVERRIDE=False,
        LOCAL_DIR_SAME_EVENT_OVERRIDE=False,
        ITTAGE_SAME_EVENT_TARGET=False,
    ),
    # ---- Fetch block front-end bandwidth ----
    "fetch_block_dual_branch": _geo(FETCH_BLOCK_BRANCH_SLOTS=2),
    # ---- TAGE allocation/aging policy (algorithmic, not just geometry) ----
    "tage_alloc_decr": _geo(TAGE_ALLOC_DECREMENT=True),
    "tage_ubit_reset": _geo(TAGE_UBIT_RESET_PERIOD=100_000),
    "tage_ubit_reset_fast": _geo(TAGE_UBIT_RESET_PERIOD=20_000),
    "tage_ubit_reset_slow": _geo(TAGE_UBIT_RESET_PERIOD=500_000),
    "tage_alloc_aging": _geo(TAGE_ALLOC_DECREMENT=True, TAGE_UBIT_RESET_PERIOD=100_000),
    "tage_alloc_rtl_aging": _geo(TAGE_ALLOC_DECREMENT=True),
    "tage_use_alt_on_na": _geo(TAGE_USE_ALT_ON_NA=1),
    "tage_alt_on_na_disabled": _geo(TAGE_ALT_ON_NA_ENTRIES=0),
    "tage_alt_on_na_conf": _geo(TAGE_ALT_ON_NA_ENTRIES=1024),
    "tage_no_path_history": _geo(TAGE_PATH_HISTORY_BITS=0),
    "tage_path_hist32": _geo(TAGE_PATH_HISTORY_BITS=32),
    "tage_path_hist64": _geo(TAGE_PATH_HISTORY_BITS=64),
    "tage_path_token4": _geo(TAGE_PATH_HISTORY_BITS=64, TAGE_PATH_HISTORY_TOKEN_BITS=4),
    "tage_path_token8": _geo(TAGE_PATH_HISTORY_BITS=64, TAGE_PATH_HISTORY_TOKEN_BITS=8),
    # ---- ITTAGE target-history ablations ----
    "ittage_no_target_hist": _geo(ITTAGE_TARGET_HISTORY_BITS=0),
    "ittage_tag9_no_path": _geo(
        ITTAGE_TAG_W=9,
        ITTAGE_PATH_HISTORY_BITS=0,
        ITTAGE_PATH_HISTORY_TOKEN_BITS=6,
    ),
    "ittage_no_path_history": _geo(ITTAGE_PATH_HISTORY_BITS=0, ITTAGE_PATH_HISTORY_TOKEN_BITS=6),
    "ittage_tag9": _geo(ITTAGE_TAG_W=9),
    "ittage_target_hist32": _geo(ITTAGE_TARGET_HISTORY_BITS=32),
    "ittage_target_hist96": _geo(ITTAGE_TARGET_HISTORY_BITS=96),
    "ittage_target_hist128": _geo(ITTAGE_TARGET_HISTORY_BITS=128),
    "ittage_target_token5": _geo(ITTAGE_TARGET_HISTORY_TOKEN_BITS=5),
    "ittage_target_token9": _geo(ITTAGE_TARGET_HISTORY_TOKEN_BITS=9),
    "ittage_target_shift2": _geo(ITTAGE_TARGET_HISTORY_SHIFT=2),
    "ittage_target_shift5": _geo(ITTAGE_TARGET_HISTORY_SHIFT=5),
    "ittage_target_shift8": _geo(ITTAGE_TARGET_HISTORY_SHIFT=8),
    "ittage_path_hist32": _geo(ITTAGE_PATH_HISTORY_BITS=32),
    "ittage_path_hist64": _geo(ITTAGE_PATH_HISTORY_BITS=64),
    "ittage_path_token4": _geo(ITTAGE_PATH_HISTORY_BITS=64, ITTAGE_PATH_HISTORY_TOKEN_BITS=4),
    "ittage_path_token8": _geo(ITTAGE_PATH_HISTORY_BITS=64, ITTAGE_PATH_HISTORY_TOKEN_BITS=8),
    "ittage_target_path": _geo(ITTAGE_TARGET_HISTORY_BITS=64, ITTAGE_PATH_HISTORY_BITS=64),
    "ittage_tag11_path_token8": _geo(
        ITTAGE_TAG_W=11,
        ITTAGE_PATH_HISTORY_BITS=64,
        ITTAGE_PATH_HISTORY_TOKEN_BITS=8,
    ),
    "ittage_direct_mapped": _geo(ITTAGE_WAYS=1),
    "ittage_4way": _geo(ITTAGE_WAYS=4),
    "ittage_pre_big": _geo(ITTAGE_ENTRIES=(512, 512, 1024, 1024, 1024)),
    "ittage_tag11": _geo(ITTAGE_TAG_W=11),
    "ittage_hist_long": _geo(ITTAGE_HIST_LEN=(4, 10, 20, 40, 80)),
    "ittage6_tables": _geo(
        ITTAGE_TABLES=6,
        ITTAGE_ENTRIES=(512, 512, 1024, 1024, 1024, 1024),
        ITTAGE_HIST_LEN=(4, 8, 13, 20, 32, 64),
    ),
    "ittage_no_weak_replace": _geo(ITTAGE_REPLACE_WEAK_CTR=0),
    "ittage_weak_replace2": _geo(ITTAGE_REPLACE_WEAK_CTR=2),
    "ittage_replace_all_providers": _geo(ITTAGE_REPLACE_MIN_PROVIDER=1),
    "ittage_replace_provider5": _geo(ITTAGE_REPLACE_MIN_PROVIDER=5),
    "ittage_weak_replace4": _geo(ITTAGE_REPLACE_WEAK_CTR=4),
    # ---- Promising combination (TAGE reach + adaptive SC + bigger tables) ----
    "combo_a": _geo(
        TAGE_HIST_LEN=(8, 16, 44, 90, 195),
        TAGE_ENTRIES_TABLE=8192,
        SC_ADAPTIVE=True,
    ),
    "combo_b": _geo(
        TAGE_TABLES=6,
        TAGE_HIST_LEN=(8, 13, 24, 48, 96, 195),
        SC_ADAPTIVE=True,
        SC_TABLES=6,
        SC_ENTRIES_TABLE=1024,
        SC_HIST_LEN=(0, 4, 10, 16, 27, 44),
    ),
    # ---- Algorithmic + geometry stack: the candidate "beat baseline" config ----
    "combo_algo": _geo(
        TAGE_ALLOC_DECREMENT=True,
        TAGE_UBIT_RESET_PERIOD=100_000,
        SC_ADAPTIVE=True,
    ),
    "combo_algo_geo": _geo(
        TAGE_ALLOC_DECREMENT=True,
        TAGE_UBIT_RESET_PERIOD=100_000,
        TAGE_HIST_LEN=(8, 16, 44, 90, 195),
        TAGE_ENTRIES_TABLE=8192,
        SC_ADAPTIVE=True,
    ),
    "combo_algo_geo_dual_fetch": _geo(
        TAGE_ALLOC_DECREMENT=True,
        TAGE_UBIT_RESET_PERIOD=100_000,
        TAGE_HIST_LEN=(8, 16, 44, 90, 195),
        TAGE_ENTRIES_TABLE=8192,
        SC_ADAPTIVE=True,
        FETCH_BLOCK_BRANCH_SLOTS=2,
    ),
}


@dataclass
class LoadedTrace:
    name: str
    events: list[BranchEvent]
    inst_count: int  # effective instruction count for the (possibly capped) prefix
    weight: float


def _proportional_inst(total_inst: int, selected_branches: int, total_branches: int) -> int:
    if total_branches <= 0:
        return 0
    return max(1, int(total_inst * (selected_branches / total_branches)))


def _contiguous_window(
    events: list[BranchEvent],
    total_inst: int,
    max_branches: int,
    start_frac: float,
) -> tuple[list[BranchEvent], int]:
    if not max_branches or len(events) <= max_branches:
        return events, total_inst
    count = max(1, min(max_branches, len(events)))
    max_start = len(events) - count
    start = int(max_start * start_frac)
    window = events[start : start + count]
    return window, _proportional_inst(total_inst, len(window), len(events))


def _stratified_window(
    events: list[BranchEvent],
    total_inst: int,
    max_branches: int,
) -> tuple[list[BranchEvent], int]:
    if not max_branches or len(events) <= max_branches:
        return events, total_inst
    per = max(1, max_branches // 3)
    windows: list[BranchEvent] = []
    used: set[int] = set()
    for start_frac in (0.0, 0.5, 1.0):
        count = min(per, len(events))
        max_start = len(events) - count
        start = int(max_start * start_frac)
        for idx in range(start, start + count):
            if idx not in used and len(windows) < max_branches:
                windows.append(events[idx])
                used.add(idx)
    return windows, _proportional_inst(total_inst, len(windows), len(events))


def _windowed_traces(
    name: str,
    events: list[BranchEvent],
    total_inst: int,
    max_branches: int,
    weight: float,
    window_mode: str,
) -> list[LoadedTrace]:
    if window_mode == "prefix" or not max_branches or len(events) <= max_branches:
        ev, inst = _contiguous_window(events, total_inst, max_branches, 0.0)
        return [LoadedTrace(name, ev, inst, weight)]

    windows: list[tuple[str, list[BranchEvent], int]] = []
    if window_mode in ("windows", "all"):
        for suffix, frac in (("prefix", 0.0), ("middle", 0.5), ("late", 1.0)):
            ev, inst = _contiguous_window(events, total_inst, max_branches, frac)
            windows.append((f"{name}@{suffix}", ev, inst))
    if window_mode in ("stratified", "all"):
        ev, inst = _stratified_window(events, total_inst, max_branches)
        windows.append((f"{name}@stratified", ev, inst))

    split_weight = weight / max(len(windows), 1)
    return [LoadedTrace(n, ev, inst, split_weight) for n, ev, inst in windows]


def _cap(events: list[BranchEvent], total_inst: int, max_branches: int):
    if max_branches and len(events) > max_branches:
        frac = max_branches / len(events)
        return events[:max_branches], int(total_inst * frac)
    return events, total_inst


def load_traces(
    max_branches: int,
    weights: dict[str, float],
    window_mode: str = "prefix",
    include_traces: set[str] | None = None,
) -> list[LoadedTrace]:
    traces: list[LoadedTrace] = []
    for name in WORKLOAD_NAMES:
        if include_traces is not None and name not in include_traces:
            continue
        p = WORKLOAD_DIR / f"{name}.btrace.json"
        if not p.is_file():
            continue
        events, inst = read_workload_trace(p)
        traces.extend(
            _windowed_traces(name, events, inst, max_branches, weights.get(name, 1.0), window_mode)
        )
    for name in SYNTHETIC_SWEEP_WORKLOADS:
        key = f"synthetic:{name}"
        if include_traces is not None and key not in include_traces and name not in include_traces:
            continue
        events = list(SYNTHETIC_GENERATORS[name]())
        traces.extend(
            _windowed_traces(
                key,
                events,
                len(events) * 5,
                max_branches,
                weights.get(key, 0.5),
                window_mode,
            )
        )
    for p in sorted(CBP5_DIR.glob("*.gz")):
        key = f"cbp5:{p.stem}"
        if (
            include_traces is not None
            and key not in include_traces
            and p.stem not in include_traces
        ):
            continue
        events, stats = read_cbp5_with_count(p)
        traces.extend(
            _windowed_traces(
                key,
                events,
                stats.instruction_count,
                max_branches,
                weights.get(key, 1.0),
                window_mode,
            )
        )
    return traces


# Globals populated per worker process (inherited via fork).
_WORKER_TRACES: list[LoadedTrace] = []


def _init_worker(traces: list[LoadedTrace]) -> None:
    global _WORKER_TRACES
    _WORKER_TRACES = traces


def _eval_config(item: tuple[str, dict]) -> tuple[str, dict]:
    name, geometry = item
    per_trace: dict[str, dict] = {}
    for tr in _WORKER_TRACES:
        sim = BPUSimulator(geometry=dict(geometry))
        sim.feed(tr.events)
        mpki = sim.mpki(tr.inst_count) if tr.inst_count else 0.0
        c = sim.stats()
        ittage_counters = {key: int(c.get(key, 0)) for key in ITTAGE_EVIDENCE_COUNTERS}
        timing_counters = {key: int(c.get(key, 0)) for key in TIMING_EVIDENCE_COUNTERS}
        per_trace[tr.name] = {
            "mpki": round(mpki, 6),
            "misp": int(c.get("misp", 0)),
            "branches": len(tr.events),
            "instructions": tr.inst_count,
            "weight": tr.weight,
            "ittage_counters": ittage_counters,
            "timing_counters": timing_counters,
        }
    wsum = sum(tr.weight for tr in _WORKER_TRACES)
    weighted = sum(per_trace[tr.name]["mpki"] * tr.weight for tr in _WORKER_TRACES) / max(
        wsum, 1e-9
    )
    ittage_totals = {
        key: sum(int(row["ittage_counters"].get(key, 0)) for row in per_trace.values())
        for key in ITTAGE_EVIDENCE_COUNTERS
    }
    timing_totals = {
        key: sum(int(row["timing_counters"].get(key, 0)) for row in per_trace.values())
        for key in TIMING_EVIDENCE_COUNTERS
    }
    return name, {
        "weighted_mpki": round(weighted, 6),
        "ittage_counter_totals": ittage_totals,
        "timing_counter_totals": timing_totals,
        "per_trace": per_trace,
    }


def run_sweep(
    configs: dict[str, dict],
    traces: list[LoadedTrace],
    jobs: int,
) -> dict[str, dict]:
    items = list(configs.items())
    if jobs > 1 and len(items) > 1:
        ctx = mp.get_context("fork")
        with ctx.Pool(processes=jobs, initializer=_init_worker, initargs=(traces,)) as pool:
            results = dict(pool.map(_eval_config, items))
    else:
        _init_worker(traces)
        results = dict(_eval_config(it) for it in items)
    return results


def _diff_from_default(geometry: dict) -> dict:
    return {
        k: (list(v) if isinstance(v, tuple) else v)
        for k, v in geometry.items()
        if DEFAULT_GEOMETRY.get(k) != v
    }


def write_leaderboard(
    results: dict[str, dict],
    traces: list[LoadedTrace],
    ranking: list[str],
    max_branches: int,
    path: Path = LEADERBOARD_MD,
) -> None:
    base = results["baseline"]["weighted_mpki"]
    lines = [
        "# BPU geometry sweep leaderboard",
        "",
        "Generated by `benchmarks/cpu/branch/sweep.py`. Each config is a "
        "`bpu_pkg.sv` geometry; MPKI is from the behavioural TAGE-SC-L+ITTAGE "
        "model over the E1 trace set. Lower is better; the aggregate is "
        "workload-weighted (the E1 duty cycle outweighs the references).",
        "",
        f"- Branch cap per trace: {'full trace' if not max_branches else f'{max_branches:,} branches'}",
        f"- Baseline weighted MPKI: {base:.4f}",
        "- Capped-window mode is recorded in the JSON evidence; trace names with "
        "`@prefix`, `@middle`, `@late`, or `@stratified` are sampled windows of "
        "the same source trace.",
        "",
        "## Ranking (by weighted MPKI)",
        "",
    ]
    trace_names = [t.name for t in traces]
    header = "| rank | config | weighted MPKI | Δ vs baseline | " + " | ".join(trace_names) + " |"
    lines.append(header)
    lines.append("| " + " | ".join(["---"] * (4 + len(trace_names))) + " |")
    for i, name in enumerate(ranking, 1):
        r = results[name]
        delta = r["weighted_mpki"] - base
        cells = [f"{r['per_trace'][tn]['mpki']:.4f}" for tn in trace_names]
        lines.append(
            f"| {i} | `{name}` | {r['weighted_mpki']:.4f} | {delta:+.4f} | "
            + " | ".join(cells)
            + " |"
        )
    lines += [
        "",
        "## CBP-5 reference bar (64 KB TAGE-SC-L)",
        "",
        "| trace | reference MPKI | best config MPKI |",
        "| --- | --- | --- |",
    ]
    best = ranking[0]
    for tn in trace_names:
        if tn.startswith("cbp5:"):
            stem = tn.split(":", 1)[1]
            ref = CBP5_REFERENCE.get(stem)
            got = results[best]["per_trace"][tn]["mpki"]
            lines.append(f"| {tn} | {ref if ref is not None else 'n/a'} | {got:.4f} |")
    lines += [
        "",
        f"Winning config: **`{best}`** "
        f"(weighted MPKI {results[best]['weighted_mpki']:.4f}, "
        f"{results[best]['weighted_mpki'] - base:+.4f} vs baseline).",
        "",
        "Diff from baseline geometry:",
        "",
        "```json",
        json.dumps(_diff_from_default(CONFIGS[best]), indent=2),
        "```",
        "",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")


def _print_summary(results: dict[str, dict], ranking: list[str]) -> None:
    base = results["baseline"]
    base_weighted = base["weighted_mpki"]
    print("\neliza-bpu-sweep: top candidates")
    for name in ranking[:10]:
        r = results[name]
        regressions = []
        for trace, values in r["per_trace"].items():
            delta = values["mpki"] - base["per_trace"][trace]["mpki"]
            if delta > 0:
                regressions.append((trace, delta))
        worst = sorted(regressions, key=lambda x: x[1], reverse=True)[:3]
        worst_text = ", ".join(f"{trace} +{delta:.4f}" for trace, delta in worst) or "none"
        print(
            f"  {name:24s} weighted={r['weighted_mpki']:.4f} "
            f"delta={r['weighted_mpki'] - base_weighted:+.4f} regressions={worst_text}"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--max-branches",
        type=int,
        default=1_200_000,
        help="cap branches per trace for turnaround (0 = full trace)",
    )
    ap.add_argument(
        "--window-mode",
        choices=("prefix", "windows", "stratified", "all"),
        default="prefix",
        help=(
            "how capped traces are sampled: prefix keeps legacy behavior; "
            "windows evaluates prefix/middle/late windows; stratified combines "
            "early/middle/late slices; all evaluates both"
        ),
    )
    ap.add_argument("--jobs", type=int, default=min(8, mp.cpu_count()))
    ap.add_argument(
        "--configs",
        nargs="*",
        default=list(CONFIGS.keys()),
        help="subset of config names to run (default: all)",
    )
    ap.add_argument(
        "--print-only",
        action="store_true",
        help="do not write evidence or leaderboard files",
    )
    ap.add_argument(
        "--include-traces",
        nargs="*",
        default=None,
        help=(
            "optional trace-name filter for sharded sweeps; names may be raw "
            "workload names, synthetic:<name>, or cbp5:<stem>"
        ),
    )
    ap.add_argument(
        "--output",
        type=Path,
        default=SWEEP_JSON,
        help=f"evidence JSON output path (default: {SWEEP_JSON.relative_to(ROOT)})",
    )
    ap.add_argument(
        "--leaderboard-output",
        type=Path,
        default=LEADERBOARD_MD,
        help=f"leaderboard markdown output path (default: {LEADERBOARD_MD.relative_to(ROOT)})",
    )
    args = ap.parse_args()

    for name in args.configs:
        if name not in CONFIGS:
            print(f"unknown config: {name}", file=sys.stderr)
            return 2
    if "baseline" not in args.configs:
        args.configs = ["baseline", *args.configs]
    selected = {k: CONFIGS[k] for k in args.configs}

    include_traces = set(args.include_traces) if args.include_traces is not None else None
    print(
        "eliza-bpu-sweep: loading traces "
        f"(cap={args.max_branches or 'full'}, window_mode={args.window_mode})"
    )
    traces = load_traces(args.max_branches, DEFAULT_WEIGHTS, args.window_mode, include_traces)
    if not traces:
        print("STATUS: BLOCKED bpu.sweep - no traces found", file=sys.stderr)
        return 2
    for t in traces:
        print(f"  {t.name:28s} branches={len(t.events):>9,} inst={t.inst_count:>11,} w={t.weight}")

    print(f"eliza-bpu-sweep: evaluating {len(selected)} configs on {args.jobs} jobs")
    results = run_sweep(selected, traces, args.jobs)
    ranking = sorted(results, key=lambda n: results[n]["weighted_mpki"])

    base = results["baseline"]["weighted_mpki"]
    best = ranking[0]
    envelope = {
        "schema": "eliza.bpu_sweep.v1",
        "status": "pass",
        "claim_boundary": (
            "behavioural BPU geometry sweep only; SPEC/AOSP/JetStream real-workload "
            "MPKI claims remain blocked until those trace sets are captured"
        ),
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "behavioural-bpu-model",
        "max_branches_per_trace": args.max_branches,
        "window_mode": args.window_mode,
        "trace_filter": sorted(include_traces) if include_traces is not None else None,
        "trace_set": [
            {
                "name": t.name,
                "branches": len(t.events),
                "instructions": t.inst_count,
                "weight": t.weight,
            }
            for t in traces
        ],
        "weights": DEFAULT_WEIGHTS,
        "cbp5_reference_mpki": CBP5_REFERENCE,
        "ittage_evidence_counters": list(ITTAGE_EVIDENCE_COUNTERS),
        "timing_evidence_counters": list(TIMING_EVIDENCE_COUNTERS),
        "baseline_weighted_mpki": base,
        "best_config": best,
        "best_weighted_mpki": results[best]["weighted_mpki"],
        "best_delta_vs_baseline": round(results[best]["weighted_mpki"] - base, 6),
        "best_geometry_diff": _diff_from_default(CONFIGS[best]),
        "ranking": ranking,
        "results": results,
    }
    if not args.print_only:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n")
        write_leaderboard(results, traces, ranking, args.max_branches, args.leaderboard_output)

    print("\neliza-bpu-sweep: ranking (weighted MPKI)")
    for i, name in enumerate(ranking, 1):
        r = results[name]
        print(f"  {i:2d}. {name:18s} {r['weighted_mpki']:.4f}  ({r['weighted_mpki'] - base:+.4f})")
    _print_summary(results, ranking)
    if args.print_only:
        print(f"\neliza-bpu-sweep: status=PASS best={best} (print-only)")
    else:
        out_display = args.output if args.output.is_absolute() else ROOT / args.output
        print(f"\neliza-bpu-sweep: status=PASS best={best} -> {out_display.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
