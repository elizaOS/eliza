// ftq_tb.sv — cocotb wrapper around the FTQ.
//
// Flattens the ftq_entry_t structure into raw vectors on the push and pop
// ports so cocotb tests can drive and observe entries without depending on
// the Verilator+VPI struct interface.

`timescale 1ns/1ps

import bpu_pkg::*;

module ftq_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                push_valid,
    input  logic [VADDR_W-1:0]  push_start_pc,
    input  logic [VADDR_W-1:0]  push_end_pc,
    input  logic [VADDR_W-1:0]  push_target_pc,
    input  logic                push_taken,
    input  logic [2:0]          push_kind,
    input  logic                push_ras_restore_valid,
    input  logic [VADDR_W-1:0]  push_ras_restore_addr,
    input  logic [TAGE_HIST_LEN_MAX-1:0] push_ghist_snapshot,
    input  logic [TAGE_HIST_LEN_MAX-1:0] push_ittage_hist_snapshot,
    input  logic [TAGE_HIST_LEN_MAX-1:0] push_ittage_target_hist_snapshot,
    input  logic [TAGE_HIST_LEN_MAX-1:0] push_ittage_path_hist_snapshot,
    input  logic [$clog2(TAGE_TABLES+1)-1:0] push_tage_provider,
    input  logic [$clog2(ITTAGE_TABLES+1)-1:0] push_ittage_provider,
    input  logic [TAGE_CTR_W-1:0] push_tage_provider_ctr,
    input  logic                push_tage_lowconf,
    input  logic                push_sc_override,
    input  logic                push_sc_taken,
    output logic                push_ready,

    input  logic                pop_ready,
    output logic                pop_valid,
    output logic [VADDR_W-1:0]  pop_start_pc,
    output logic [VADDR_W-1:0]  pop_target_pc,
    output logic                pop_taken,
    output logic [2:0]          pop_kind,
    output logic [FTQ_IDX_W-1:0] pop_ftq_idx,
    output logic                pop_ras_restore_valid,
    output logic [VADDR_W-1:0]  pop_ras_restore_addr,
    output logic [TAGE_HIST_LEN_MAX-1:0] pop_ghist_snapshot,
    output logic [TAGE_HIST_LEN_MAX-1:0] pop_ittage_hist_snapshot,
    output logic [TAGE_HIST_LEN_MAX-1:0] pop_ittage_target_hist_snapshot,
    output logic [TAGE_HIST_LEN_MAX-1:0] pop_ittage_path_hist_snapshot,
    output logic [$clog2(TAGE_TABLES+1)-1:0] pop_tage_provider,
    output logic [$clog2(ITTAGE_TABLES+1)-1:0] pop_ittage_provider,
    output logic [TAGE_CTR_W-1:0] pop_tage_provider_ctr,
    output logic                pop_tage_lowconf,
    output logic                pop_sc_override,
    output logic                pop_sc_taken,

    input  logic [FTQ_IDX_W-1:0] replay_idx,
    output logic [VADDR_W-1:0]  replay_start_pc,
    output logic [VADDR_W-1:0]  replay_target_pc,
    output logic                replay_taken,
    output logic [2:0]          replay_kind,
    output logic [FTQ_IDX_W-1:0] replay_ftq_idx,
    output logic [TAGE_HIST_LEN_MAX-1:0] replay_ghist_snapshot,
    output logic [TAGE_HIST_LEN_MAX-1:0] replay_ittage_hist_snapshot,
    output logic [$clog2(TAGE_TABLES+1)-1:0] replay_tage_provider,
    output logic [$clog2(ITTAGE_TABLES+1)-1:0] replay_ittage_provider,
    output logic                replay_tage_lowconf,

    input  logic                flush_valid,
    input  logic [FTQ_IDX_W-1:0] flush_idx,

    output logic                pmu_full,
    output logic                pmu_empty,
    output logic [FTQ_IDX_W:0]  occupancy
);

    ftq_entry_t push_w;
    ftq_entry_t pop_w;
    ftq_entry_t replay_w;
    logic [FTQ_IDX_W:0] push_ptr_unused;
    logic patch_applied_unused;

    always_comb begin
        push_w               = '0;
        push_w.valid         = push_valid;
        push_w.start_pc      = push_start_pc;
        push_w.end_pc        = push_end_pc;
        push_w.target_pc     = push_target_pc;
        push_w.taken         = push_taken;
        push_w.kind          = br_kind_e'(push_kind);
        push_w.br_taken_mask = {{(MAX_BR_PER_BLOCK-1){1'b0}}, push_taken};
        push_w.ras_restore_valid = push_ras_restore_valid;
        push_w.ras_restore_addr = push_ras_restore_addr;
        push_w.ghist_snapshot = push_ghist_snapshot;
        push_w.ittage_hist_snapshot = push_ittage_hist_snapshot;
        push_w.ittage_target_hist_snapshot = push_ittage_target_hist_snapshot;
        push_w.ittage_path_hist_snapshot = push_ittage_path_hist_snapshot;
        push_w.tage_provider = push_tage_provider;
        push_w.ittage_provider = push_ittage_provider;
        push_w.tage_provider_ctr = push_tage_provider_ctr;
        push_w.tage_lowconf = push_tage_lowconf;
        push_w.sc_override = push_sc_override;
        push_w.sc_taken = push_sc_taken;
    end

    ftq u_ftq (
        .clk        (clk),
        .rst_n      (rst_n),
        .push_valid (push_valid),
        .push_entry (push_w),
        .push_ready (push_ready),
        .push_ptr   (push_ptr_unused),
        .patch_valid(1'b0),
        .patch_ptr  ('0),
        .patch_entry('0),
        .patch_flush_younger(1'b0),
        .patch_applied(patch_applied_unused),
        .pop_ready  (pop_ready),
        .pop_valid  (pop_valid),
        .pop_entry  (pop_w),
        .replay_idx (replay_idx),
        .replay_entry(replay_w),
        .flush_valid(flush_valid),
        .flush_idx  (flush_idx),
        .global_flush(1'b0),
        .pmu_full   (pmu_full),
        .pmu_empty  (pmu_empty),
        .occupancy  (occupancy)
    );

    assign pop_start_pc  = pop_w.start_pc;
    assign pop_target_pc = pop_w.target_pc;
    assign pop_taken     = pop_w.taken;
    assign pop_kind      = pop_w.kind;
    assign pop_ftq_idx   = pop_w.ftq_idx;
    assign pop_ras_restore_valid = pop_w.ras_restore_valid;
    assign pop_ras_restore_addr = pop_w.ras_restore_addr;
    assign pop_ghist_snapshot = pop_w.ghist_snapshot;
    assign pop_ittage_hist_snapshot = pop_w.ittage_hist_snapshot;
    assign pop_ittage_target_hist_snapshot = pop_w.ittage_target_hist_snapshot;
    assign pop_ittage_path_hist_snapshot = pop_w.ittage_path_hist_snapshot;
    assign pop_tage_provider = pop_w.tage_provider;
    assign pop_ittage_provider = pop_w.ittage_provider;
    assign pop_tage_provider_ctr = pop_w.tage_provider_ctr;
    assign pop_tage_lowconf = pop_w.tage_lowconf;
    assign pop_sc_override = pop_w.sc_override;
    assign pop_sc_taken = pop_w.sc_taken;
    assign replay_start_pc = replay_w.start_pc;
    assign replay_target_pc = replay_w.target_pc;
    assign replay_taken = replay_w.taken;
    assign replay_kind = replay_w.kind;
    assign replay_ftq_idx = replay_w.ftq_idx;
    assign replay_ghist_snapshot = replay_w.ghist_snapshot;
    assign replay_ittage_hist_snapshot = replay_w.ittage_hist_snapshot;
    assign replay_tage_provider = replay_w.tage_provider;
    assign replay_ittage_provider = replay_w.ittage_provider;
    assign replay_tage_lowconf = replay_w.tage_lowconf;
endmodule
