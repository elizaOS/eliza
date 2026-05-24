// ftq_to_fetch_stream.sv -- observational fetch-control stream adapter.
//
// This adapter exposes the BPU's existing forward-fetch contract as ordered
// fetch-control lanes. Same-block multi-segment predictions come from the FTQ
// entry itself. Target-block two-ahead redirects are currently emitted only as
// pred_redirect_valid[1]/pred_redirect_pc[1]/pred_redirect_kind[1], so this
// block captures that sideband at lookup time and attaches it to the matching
// FTQ pop.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ftq_to_fetch_stream (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                pred_valid,
    input  bpu_lookup_t         pred,
    input  logic [MAX_BR_PER_BLOCK-1:0] pred_redirect_valid,
    input  logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] pred_redirect_pc,
    input  logic [MAX_BR_PER_BLOCK-1:0][2:0] pred_redirect_kind,

    input  logic                fetch_entry_valid,
    input  ftq_entry_t          fetch_entry,
    input  logic                fetch_accept,
    input  logic                flush_valid,

    output logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_valid_o,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_pc_o,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_target_pc_o,
    output logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] fetch_stream_ftq_idx_o,
    output logic [MAX_BR_PER_BLOCK-1:0][$clog2(MAX_BR_PER_BLOCK)-1:0]
        fetch_stream_segment_idx_o,
    output logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_taken_o,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] fetch_stream_kind_o
);

    logic                pending_target_block_valid_q;
    logic [VADDR_W-1:0]  pending_start_pc_q;
    logic [VADDR_W-1:0]  pending_first_target_pc_q;
    logic [VADDR_W-1:0]  pending_second_target_pc_q;
    logic [2:0]          pending_second_kind_q;

    logic fetch_matches_pending;
    assign fetch_matches_pending =
        pending_target_block_valid_q &&
        fetch_entry_valid && fetch_entry.valid &&
        (fetch_entry.start_pc == pending_start_pc_q) &&
        (fetch_entry.target_pc == pending_first_target_pc_q);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            pending_target_block_valid_q <= 1'b0;
            pending_start_pc_q <= '0;
            pending_first_target_pc_q <= '0;
            pending_second_target_pc_q <= '0;
            pending_second_kind_q <= '0;
        end else if (flush_valid) begin
            pending_target_block_valid_q <= 1'b0;
            pending_start_pc_q <= '0;
            pending_first_target_pc_q <= '0;
            pending_second_target_pc_q <= '0;
            pending_second_kind_q <= '0;
        end else begin
            if (fetch_matches_pending && fetch_accept) begin
                pending_target_block_valid_q <= 1'b0;
            end
            if (pred_valid && pred.valid &&
                pred_redirect_valid[0] && pred_redirect_valid[1] &&
                pred.fetch_segments[0].valid && !pred.fetch_segments[1].valid) begin
                pending_target_block_valid_q <= 1'b1;
                pending_start_pc_q <= pred.start_pc;
                pending_first_target_pc_q <= pred_redirect_pc[0];
                pending_second_target_pc_q <= pred_redirect_pc[1];
                pending_second_kind_q <= pred_redirect_kind[1];
            end
        end
    end

    always_comb begin
        fetch_stream_valid_o = '0;
        fetch_stream_pc_o = '0;
        fetch_stream_target_pc_o = '0;
        fetch_stream_ftq_idx_o = '0;
        fetch_stream_segment_idx_o = '0;
        fetch_stream_taken_o = '0;
        fetch_stream_kind_o = '0;

        if (fetch_entry_valid && fetch_entry.valid && !flush_valid) begin
            for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
                if (fetch_entry.fetch_segments[i].valid) begin
                    fetch_stream_valid_o[i] = 1'b1;
                    fetch_stream_pc_o[i] = fetch_entry.fetch_segments[i].start_pc;
                    fetch_stream_target_pc_o[i] =
                        fetch_entry.fetch_segments[i].target_pc;
                    fetch_stream_ftq_idx_o[i] = fetch_entry.ftq_idx;
                    fetch_stream_segment_idx_o[i] =
                        fetch_entry.fetch_segments[i].slot_idx;
                    fetch_stream_taken_o[i] = fetch_entry.fetch_segments[i].taken;
                    fetch_stream_kind_o[i] = fetch_entry.kind;
                end
            end

            if (fetch_matches_pending && !fetch_entry.fetch_segments[1].valid) begin
                fetch_stream_valid_o[1] = 1'b1;
                fetch_stream_pc_o[1] = fetch_entry.target_pc;
                fetch_stream_target_pc_o[1] = pending_second_target_pc_q;
                fetch_stream_ftq_idx_o[1] = fetch_entry.ftq_idx;
                fetch_stream_segment_idx_o[1] = 1;
                fetch_stream_taken_o[1] = 1'b1;
                fetch_stream_kind_o[1] = pending_second_kind_q;
            end
        end
    end

endmodule : ftq_to_fetch_stream
