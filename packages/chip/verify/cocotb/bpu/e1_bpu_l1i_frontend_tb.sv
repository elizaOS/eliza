// e1_bpu_l1i_frontend_tb.sv
//
// Narrow cocotb wrapper for the BPU -> FTQ/L1I shim -> FDIP -> L1I path.
// It keeps the branch predictor and cache RTL unmodified while exposing the
// handshakes needed to prove that a taken target can become a useful L1I
// prefetch.

`timescale 1ns/1ps

import bpu_pkg::*;
import e1_ftq_to_l1i_pkg::*;

module e1_bpu_l1i_frontend_tb (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    output logic                pred_valid,
    output logic                pred_taken,
    output logic [VADDR_W-1:0]  pred_target,
    output logic [2:0]          pred_kind,
    output logic                pred_from_ftb,

    input  logic                fetch_pop,
    output logic                fetch_valid,
    output logic [VADDR_W-1:0]  fetch_start_pc,
    output logic [VADDR_W-1:0]  fetch_target_pc,
    output logic                fetch_taken,
    output logic [2:0]          fetch_kind,

    input  logic                resolve_valid,
    input  logic                resolve_misp,
    input  logic [VADDR_W-1:0]  resolve_pc,
    input  logic [VADDR_W-1:0]  resolve_target,
    input  logic [VADDR_W-1:0]  resolve_call_return_pc,
    input  logic                resolve_taken,
    input  logic [2:0]          resolve_kind,
    input  logic [FTQ_IDX_W-1:0] resolve_ftq_idx,
    input  logic [RAS_IDX_W:0]  resolve_ras_restore_top,
    input  logic [$clog2(TAGE_TABLES+1)-1:0] resolve_tage_provider,
    input  logic [$clog2(ITTAGE_TABLES+1)-1:0] resolve_ittage_provider,

    input  logic                ifu_req_valid,
    output logic                ifu_req_ready,
    input  logic [39:0]         ifu_req_paddr,
    input  logic                ifu_flush,
    output logic                ifu_resp_valid,
    output logic [63:0]         ifu_resp_data,
    output logic                ifu_resp_paddr_eq_req,

    output logic                shim_l1i_valid,
    output logic [39:0]         shim_l1i_paddr_line,
    output logic [2:0]          shim_l1i_confidence,
    output logic                shim_l1i_branch_target,
    output logic                fdip_ftq_ready,
    output logic                fdip_pf_valid,
    output logic                l1i_ftq_ready,

    output logic                miss_valid,
    input  logic                miss_ready,
    output logic [39:0]         miss_paddr_line,
    output logic                miss_is_prefetch,

    input  logic                refill_valid,
    output logic                refill_ready,
    input  logic [127:0]        refill_data,
    input  logic [1:0]          refill_beat_idx,
    input  logic                refill_last,

    input  logic                probe_valid,
    output logic                probe_ready,
    input  logic [39:0]         probe_paddr_line,
    output logic                probe_ack,

    output logic                hpm_l1i_access,
    output logic                hpm_l1i_miss,
    output logic                hpm_l1i_prefetch,
    output logic [PMU_EVENTS-1:0] bpu_pmu_strb
);

    bpu_lookup_t         pred_w;
    ftq_entry_t          fetch_w;
    bpu_resolve_t        resolve_w;
    ftq_prefetch_req_t   shim_req_w;
    ftq_prefetch_req_t   fdip_req_w;
    logic                shim_flush_w;
    logic [63:0]         unused_csr_rdata;

    always_comb begin
        resolve_w = '0;
        resolve_w.valid                 = resolve_valid;
        resolve_w.misprediction         = resolve_misp;
        resolve_w.pc                    = resolve_pc;
        resolve_w.actual_target         = resolve_target;
        resolve_w.actual_call_return_pc = resolve_call_return_pc;
        resolve_w.actual_taken          = resolve_taken;
        resolve_w.actual_kind           = br_kind_e'(resolve_kind);
        resolve_w.ftq_idx               = resolve_ftq_idx;
        resolve_w.ras_restore_top       = resolve_ras_restore_top;
        resolve_w.tage_provider         = resolve_tage_provider;
        resolve_w.ittage_provider       = resolve_ittage_provider;
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
        .csr_re     (1'b0),
        .csr_addr   ('0),
        .csr_rdata  (unused_csr_rdata),
        .pmu_strb   (bpu_pmu_strb)
    );

    ftq_to_l1i_shim u_shim (
        .fetch_entry_valid(fetch_valid),
        .fetch_entry      (fetch_w),
        .flush_valid      (resolve_valid && resolve_misp),
        .l1i_req_o        (shim_req_w),
        .l1i_valid_o      (shim_l1i_valid),
        .l1i_flush_o      (shim_flush_w)
    );

    e1_fdip_l1i_prefetcher u_fdip (
        .clk          (clk),
        .rst_n        (rst_n),
        .ftq_in_valid (shim_l1i_valid),
        .ftq_in_ready (fdip_ftq_ready),
        .ftq_in_req   (shim_req_w),
        .pf_out_valid (fdip_pf_valid),
        .pf_out_ready (l1i_ftq_ready),
        .pf_out_req   (fdip_req_w),
        .flush        (shim_flush_w || ifu_flush)
    );

    e1_l1i_cache u_l1i (
        .clk                  (clk),
        .rst_n                (rst_n),
        .ifu_req_valid        (ifu_req_valid),
        .ifu_req_ready        (ifu_req_ready),
        .ifu_req_paddr        (ifu_req_paddr),
        .ifu_flush            (ifu_flush),
        .ifu_resp_valid       (ifu_resp_valid),
        .ifu_resp_data        (ifu_resp_data),
        .ifu_resp_paddr_eq_req(ifu_resp_paddr_eq_req),
        .ftq_req_valid        (fdip_pf_valid),
        .ftq_req_ready        (l1i_ftq_ready),
        .ftq_req              (fdip_req_w),
        .miss_valid           (miss_valid),
        .miss_ready           (miss_ready),
        .miss_paddr_line      (miss_paddr_line),
        .miss_is_prefetch     (miss_is_prefetch),
        .refill_valid         (refill_valid),
        .refill_ready         (refill_ready),
        .refill_data          (refill_data),
        .refill_beat_idx      (refill_beat_idx),
        .refill_last          (refill_last),
        .probe_valid          (probe_valid),
        .probe_ready          (probe_ready),
        .probe_paddr_line     (probe_paddr_line),
        .probe_ack            (probe_ack),
        .hpm_l1i_access       (hpm_l1i_access),
        .hpm_l1i_miss         (hpm_l1i_miss),
        .hpm_l1i_prefetch     (hpm_l1i_prefetch)
    );

    assign pred_taken             = pred_w.taken;
    assign pred_target            = pred_w.target_pc;
    assign pred_kind              = pred_w.kind;
    assign pred_from_ftb          = pred_w.from_ftb;
    assign fetch_start_pc         = fetch_w.start_pc;
    assign fetch_target_pc        = fetch_w.target_pc;
    assign fetch_taken            = fetch_w.taken;
    assign fetch_kind             = fetch_w.kind;
    assign shim_l1i_paddr_line    = shim_req_w.paddr_line;
    assign shim_l1i_confidence    = shim_req_w.confidence;
    assign shim_l1i_branch_target = shim_req_w.branch_target;

endmodule : e1_bpu_l1i_frontend_tb
