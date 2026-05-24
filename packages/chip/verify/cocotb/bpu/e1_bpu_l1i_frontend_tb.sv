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
    output logic [MAX_BR_PER_BLOCK-1:0] pred_redirect_valid,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] pred_redirect_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] pred_redirect_kind,

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

    input  logic                ifu_req_valid,
    output logic                ifu_req_ready,
    input  logic [39:0]         ifu_req_paddr,
    input  logic                ifu_flush,
    output logic                ifu_resp_valid,
    output logic [63:0]         ifu_resp_data,
    output logic                ifu_resp_paddr_eq_req,
    output logic                ifu_resp_valid_lane1,
    output logic [63:0]         ifu_resp_data_lane1,
    output logic                ifu_resp_paddr_eq_req_lane1,

    output logic                shim_l1i_valid,
    output logic [39:0]         shim_l1i_paddr_line,
    output logic [2:0]          shim_l1i_confidence,
    output logic                shim_l1i_branch_target,
    input  logic [FTQ_PREFETCH_MAX_REQS-1:0] shim_l1i_ready_vec,
    input  logic                fdip_bundle_enable,
    output logic [FTQ_PREFETCH_MAX_REQS-1:0] shim_l1i_valid_vec,
    output logic [FTQ_PREFETCH_MAX_REQS-1:0][39:0] shim_l1i_paddr_line_vec,
    output logic [FTQ_PREFETCH_MAX_REQS-1:0][2:0] shim_l1i_confidence_vec,
    output logic [FTQ_PREFETCH_MAX_REQS-1:0] shim_l1i_branch_target_vec,
    output logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_valid,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_target_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] fetch_stream_ftq_idx,
    output logic [MAX_BR_PER_BLOCK-1:0][$clog2(MAX_BR_PER_BLOCK)-1:0]
        fetch_stream_segment_idx,
    output logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_taken,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] fetch_stream_kind,
    output logic                fetch_stream_ready,
    input  logic                fetch_demand_enable,
    output logic                fetch_demand_valid,
    output logic                fetch_demand_ready,
    output logic [39:0]         fetch_demand_paddr,
    output logic [FTQ_IDX_W-1:0] fetch_demand_ftq_idx,
    output logic [$clog2(MAX_BR_PER_BLOCK)-1:0] fetch_demand_segment_idx,
    output logic [2:0]          fetch_demand_kind,
    output logic                fetch_demand_valid_lane1,
    output logic                fetch_demand_ready_lane1,
    output logic [39:0]         fetch_demand_paddr_lane1,
    output logic [FTQ_IDX_W-1:0] fetch_demand_ftq_idx_lane1,
    output logic [$clog2(MAX_BR_PER_BLOCK)-1:0] fetch_demand_segment_idx_lane1,
    output logic [2:0]          fetch_demand_kind_lane1,
    output logic [2:0]          fetch_demand_occupancy,
    output logic                fetch_demand_overflow,
    output logic                fdip_ftq_ready,
    output logic [FTQ_PREFETCH_MAX_REQS-1:0] fdip_ftq_ready_vec,
    output logic                fdip_pf_valid,
    output logic                l1i_ftq_ready,

    output logic                miss_valid,
    input  logic                miss_ready,
    output logic [39:0]         miss_paddr_line,
    output logic                miss_is_prefetch,
    output logic                miss_valid_lane1,
    input  logic                miss_ready_lane1,
    output logic [39:0]         miss_paddr_line_lane1,
    output logic                miss_is_prefetch_lane1,

    input  logic                refill_valid,
    output logic                refill_ready,
    input  logic [127:0]        refill_data,
    input  logic [1:0]          refill_beat_idx,
    input  logic                refill_last,
    input  logic                refill_valid_lane1,
    output logic                refill_ready_lane1,
    input  logic [127:0]        refill_data_lane1,
    input  logic [1:0]          refill_beat_idx_lane1,
    input  logic                refill_last_lane1,

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
    bpu_context_t        default_context_w;
    bpu_flush_t          predictor_flush_w;
    ftq_prefetch_req_t   shim_req_w;
    ftq_prefetch_bundle_t shim_bundle_w;
    ftq_prefetch_req_t   fdip_req_w;
    logic                shim_flush_w;
    logic [FTQ_PREFETCH_MAX_REQS-1:0] fdip_ftq_ready_vec_w;
    logic [63:0]         unused_csr_rdata;
    logic                late_redirect_valid_unused;
    logic [VADDR_W-1:0]  late_redirect_pc_unused;
    logic [FTQ_IDX_W-1:0] late_redirect_ftq_idx_unused;
    logic [MAX_BR_PER_BLOCK-1:0] late_redirect_valid_lanes_unused;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] late_redirect_pc_lanes_unused;
    logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] late_redirect_ftq_idx_lanes_unused;
    logic                l1i_ifu_req_valid_w;
    logic                l1i_ifu_req_ready_w;
    logic [39:0]         l1i_ifu_req_paddr_w;
    logic                fetch_accept_w;

    assign fetch_accept_w = fetch_pop && fetch_stream_ready;

    always_comb begin
        default_context_w = bpu_default_context();
        predictor_flush_w = '0;
        resolve_w = '0;
        resolve_w.ctx                   = default_context_w;
        resolve_w.valid                 = resolve_valid;
        resolve_w.misprediction         = resolve_misp;
        resolve_w.pc                    = resolve_pc;
        resolve_w.actual_target         = resolve_target;
        resolve_w.actual_call_return_pc = resolve_call_return_pc;
        resolve_w.actual_taken          = resolve_taken;
        resolve_w.actual_kind           = br_kind_e'(resolve_kind);
        resolve_w.ftq_idx               = resolve_ftq_idx;
        resolve_w.ras_restore_top       = resolve_ras_restore_top;
    end

    bpu_top u_bpu (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_context(default_context_w),
        .pred_valid (pred_valid),
        .pred       (pred_w),
        .pred_redirect_valid(pred_redirect_valid),
        .pred_redirect_pc(pred_redirect_pc),
        .pred_redirect_kind(pred_redirect_kind),
        .fetch_pop  (fetch_accept_w),
        .fetch_valid(fetch_valid),
        .fetch_entry(fetch_w),
        .late_redirect_valid(late_redirect_valid_unused),
        .late_redirect_pc(late_redirect_pc_unused),
        .late_redirect_ftq_idx(late_redirect_ftq_idx_unused),
        .late_redirect_valid_lanes(late_redirect_valid_lanes_unused),
        .late_redirect_pc_lanes(late_redirect_pc_lanes_unused),
        .late_redirect_ftq_idx_lanes(late_redirect_ftq_idx_lanes_unused),
        .resolve    (resolve_w),
        .predictor_flush(predictor_flush_w),
        .csr_re     (1'b0),
        .csr_addr   ('0),
        .csr_rdata  (unused_csr_rdata),
        .pmu_strb   (bpu_pmu_strb)
    );

    ftq_to_l1i_shim u_shim (
        .clk              (clk),
        .rst_n            (rst_n),
        .fetch_entry_valid(fetch_valid && fetch_accept_w),
        .fetch_entry      (fetch_w),
        .flush_valid      (resolve_valid && resolve_misp),
        .l1i_ready_i      (fdip_ftq_ready),
        .l1i_req_o        (shim_req_w),
        .l1i_valid_o      (shim_l1i_valid),
        .l1i_ready_vec_i  (shim_l1i_ready_vec |
                            (fdip_bundle_enable ? fdip_ftq_ready_vec_w : '0)),
        .l1i_bundle_o     (shim_bundle_w),
        .l1i_flush_o      (shim_flush_w)
    );

    ftq_to_fetch_stream u_fetch_stream (
        .clk                     (clk),
        .rst_n                   (rst_n),
        .pred_valid              (pred_valid),
        .pred                    (pred_w),
        .pred_redirect_valid     (pred_redirect_valid),
        .pred_redirect_pc        (pred_redirect_pc),
        .pred_redirect_kind      (pred_redirect_kind),
        .fetch_entry_valid       (fetch_valid),
        .fetch_entry             (fetch_w),
        .fetch_accept            (fetch_accept_w),
        .flush_valid             (resolve_valid && resolve_misp),
        .fetch_stream_valid_o    (fetch_stream_valid),
        .fetch_stream_pc_o       (fetch_stream_pc),
        .fetch_stream_target_pc_o(fetch_stream_target_pc),
        .fetch_stream_ftq_idx_o  (fetch_stream_ftq_idx),
        .fetch_stream_segment_idx_o(fetch_stream_segment_idx),
        .fetch_stream_taken_o    (fetch_stream_taken),
        .fetch_stream_kind_o     (fetch_stream_kind)
    );

    fetch_stream_to_l1i_demand u_fetch_demand (
        .clk                   (clk),
        .rst_n                 (rst_n),
        .enable                (fetch_demand_enable),
        .flush_valid           ((resolve_valid && resolve_misp) || ifu_flush),
        .fetch_stream_valid    (fetch_stream_valid),
        .fetch_stream_target_pc(fetch_stream_target_pc),
        .fetch_stream_ftq_idx  (fetch_stream_ftq_idx),
        .fetch_stream_segment_idx(fetch_stream_segment_idx),
        .fetch_stream_taken    (fetch_stream_taken),
        .fetch_stream_kind     (fetch_stream_kind),
        .fetch_stream_accept   (fetch_accept_w),
        .fetch_stream_ready    (fetch_stream_ready),
        .ifu_req_valid         (fetch_demand_valid),
        .ifu_req_ready         (fetch_demand_ready),
        .ifu_req_paddr         (fetch_demand_paddr),
        .ifu_req_ftq_idx       (fetch_demand_ftq_idx),
        .ifu_req_segment_idx   (fetch_demand_segment_idx),
        .ifu_req_kind          (fetch_demand_kind),
        .ifu_req_valid_lane1   (fetch_demand_valid_lane1),
        .ifu_req_ready_lane1   (fetch_demand_ready_lane1),
        .ifu_req_paddr_lane1   (fetch_demand_paddr_lane1),
        .ifu_req_ftq_idx_lane1 (fetch_demand_ftq_idx_lane1),
        .ifu_req_segment_idx_lane1(fetch_demand_segment_idx_lane1),
        .ifu_req_kind_lane1    (fetch_demand_kind_lane1),
        .queue_occupancy       (fetch_demand_occupancy),
        .queue_overflow        (fetch_demand_overflow)
    );

    always_comb begin
        l1i_ifu_req_valid_w = ifu_req_valid;
        l1i_ifu_req_paddr_w = ifu_req_paddr;
        if (!ifu_req_valid && fetch_demand_valid) begin
            l1i_ifu_req_valid_w = 1'b1;
            l1i_ifu_req_paddr_w = fetch_demand_paddr;
        end

        ifu_req_ready = l1i_ifu_req_ready_w && !fetch_demand_valid;
        fetch_demand_ready = l1i_ifu_req_ready_w && !ifu_req_valid;
    end

    e1_fdip_l1i_prefetcher u_fdip (
        .clk          (clk),
        .rst_n        (rst_n),
        .ftq_in_valid (shim_l1i_valid),
        .ftq_in_ready (fdip_ftq_ready),
        .ftq_in_req   (shim_req_w),
        .ftq_in_bundle(fdip_bundle_enable ? shim_bundle_w :
                       ftq_prefetch_bundle_zero()),
        .ftq_in_ready_vec(fdip_ftq_ready_vec_w),
        .pf_out_valid (fdip_pf_valid),
        .pf_out_ready (l1i_ftq_ready),
        .pf_out_req   (fdip_req_w),
        .flush        (shim_flush_w || ifu_flush)
    );

    e1_l1i_cache u_l1i (
        .clk                  (clk),
        .rst_n                (rst_n),
        .ifu_req_valid        (l1i_ifu_req_valid_w),
        .ifu_req_ready        (l1i_ifu_req_ready_w),
        .ifu_req_paddr        (l1i_ifu_req_paddr_w),
        .ifu_flush            (ifu_flush),
        .ifu_resp_valid       (ifu_resp_valid),
        .ifu_resp_data        (ifu_resp_data),
        .ifu_resp_paddr_eq_req(ifu_resp_paddr_eq_req),
        .ifu_req_valid_lane1  (fetch_demand_valid_lane1),
        .ifu_req_ready_lane1  (fetch_demand_ready_lane1),
        .ifu_req_paddr_lane1  (fetch_demand_paddr_lane1),
        .ifu_resp_valid_lane1 (ifu_resp_valid_lane1),
        .ifu_resp_data_lane1  (ifu_resp_data_lane1),
        .ifu_resp_paddr_eq_req_lane1(ifu_resp_paddr_eq_req_lane1),
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
        .miss_valid_lane1     (miss_valid_lane1),
        .miss_ready_lane1     (miss_ready_lane1),
        .miss_paddr_line_lane1(miss_paddr_line_lane1),
        .miss_is_prefetch_lane1(miss_is_prefetch_lane1),
        .refill_valid_lane1   (refill_valid_lane1),
        .refill_ready_lane1   (refill_ready_lane1),
        .refill_data_lane1    (refill_data_lane1),
        .refill_beat_idx_lane1(refill_beat_idx_lane1),
        .refill_last_lane1    (refill_last_lane1),
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
    assign shim_l1i_valid_vec     = shim_bundle_w.valid;
    assign fdip_ftq_ready_vec     = fdip_ftq_ready_vec_w;
    for (genvar i = 0; i < FTQ_PREFETCH_MAX_REQS; i++) begin : g_shim_bundle_probe
        assign shim_l1i_paddr_line_vec[i] = shim_bundle_w.req[i].paddr_line;
        assign shim_l1i_confidence_vec[i] = shim_bundle_w.req[i].confidence;
        assign shim_l1i_branch_target_vec[i] = shim_bundle_w.req[i].branch_target;
    end

endmodule : e1_bpu_l1i_frontend_tb
