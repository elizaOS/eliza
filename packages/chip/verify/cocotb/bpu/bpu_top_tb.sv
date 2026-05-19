// bpu_top_tb.sv — cocotb wrapper around bpu_top.
//
// Flattens the structured ports of bpu_top into raw logic vectors so cocotb
// can drive them from Python without depending on SystemVerilog struct
// support in the underlying simulator. The shape exposed here matches the
// behavioral contract documented in docs/arch/branch-prediction.md.

`timescale 1ns/1ps

import bpu_pkg::*;

module bpu_top_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    output logic                pred_valid,
    output logic                pred_taken,
    output logic [VADDR_W-1:0]  pred_target,
    output logic [1:0]          pred_kind,
    output logic                pred_from_uftb,
    output logic                pred_from_ftb,
    output logic                pred_from_tage,
    output logic                pred_from_ittage,
    output logic                pred_from_ras,
    output logic                pred_from_loop,
    output logic                pred_from_sc,

    input  logic                fetch_pop,
    output logic                fetch_valid,
    output logic [VADDR_W-1:0]  fetch_start_pc,
    output logic [VADDR_W-1:0]  fetch_target_pc,
    output logic                fetch_taken,
    output logic [1:0]          fetch_kind,
    output logic [FTQ_IDX_W-1:0] fetch_ftq_idx,

    input  logic                resolve_valid,
    input  logic                resolve_misp,
    input  logic [VADDR_W-1:0]  resolve_pc,
    input  logic [VADDR_W-1:0]  resolve_target,
    input  logic                resolve_taken,
    input  logic [1:0]          resolve_kind,
    input  logic [FTQ_IDX_W-1:0] resolve_ftq_idx,

    input  logic                csr_re,
    input  logic [4:0]          csr_addr,
    output logic [63:0]         csr_rdata,

    output logic [PMU_EVENTS-1:0] pmu_strb
);

    bpu_lookup_t pred_w;
    ftq_entry_t  fetch_w;
    bpu_resolve_t resolve_w;

    always_comb begin
        resolve_w = '0;
        resolve_w.valid          = resolve_valid;
        resolve_w.misprediction  = resolve_misp;
        resolve_w.pc             = resolve_pc;
        resolve_w.actual_target  = resolve_target;
        resolve_w.actual_taken   = resolve_taken;
        resolve_w.actual_kind    = br_kind_e'(resolve_kind);
        resolve_w.ftq_idx        = resolve_ftq_idx;
    end

    bpu_top u_bpu (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .pred_valid (pred_valid),
        .pred       (pred_w),
        .fetch_pop  (fetch_pop),
        .fetch_valid(fetch_valid),
        .fetch_entry(fetch_w),
        .resolve    (resolve_w),
        .csr_re     (csr_re),
        .csr_addr   (csr_addr),
        .csr_rdata  (csr_rdata),
        .pmu_strb   (pmu_strb)
    );

    assign pred_taken      = pred_w.taken;
    assign pred_target     = pred_w.target_pc;
    assign pred_kind       = pred_w.kind;
    assign pred_from_uftb  = pred_w.from_uftb;
    assign pred_from_ftb   = pred_w.from_ftb;
    assign pred_from_tage  = pred_w.from_tage;
    assign pred_from_ittage= pred_w.from_ittage;
    assign pred_from_ras   = pred_w.from_ras;
    assign pred_from_loop  = pred_w.from_loop;
    assign pred_from_sc    = pred_w.from_sc;

    assign fetch_start_pc  = fetch_w.start_pc;
    assign fetch_target_pc = fetch_w.target_pc;
    assign fetch_taken     = fetch_w.taken;
    assign fetch_kind      = fetch_w.kind;
    assign fetch_ftq_idx   = fetch_w.ftq_idx;

endmodule : bpu_top_tb
