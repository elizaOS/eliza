// fetch_stream_to_l1i_demand.sv
//
// Queues ordered fetch-control lanes into L1I IFU demand lanes. Lane 0 feeds
// the scalar demand path, while lane 1 exposes the next ordered taken target
// for downstream fetch/cache implementations that can consume a second demand
// in the same cycle. Ready/backpressure keeps FTQ pop from dropping lanes.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module fetch_stream_to_l1i_demand #(
    parameter int unsigned PADDR_W = 40,
    parameter int unsigned QUEUE_DEPTH = 4
) (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                enable,
    input  logic                flush_valid,

    input  logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_valid,
    input  logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] fetch_stream_target_pc,
    input  logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] fetch_stream_ftq_idx,
    input  logic [MAX_BR_PER_BLOCK-1:0][$clog2(MAX_BR_PER_BLOCK)-1:0]
        fetch_stream_segment_idx,
    input  logic [MAX_BR_PER_BLOCK-1:0] fetch_stream_taken,
    input  logic [MAX_BR_PER_BLOCK-1:0][2:0] fetch_stream_kind,
    input  logic                fetch_stream_accept,
    output logic                fetch_stream_ready,

    output logic                ifu_req_valid,
    input  logic                ifu_req_ready,
    output logic [PADDR_W-1:0]  ifu_req_paddr,
    output logic [FTQ_IDX_W-1:0] ifu_req_ftq_idx,
    output logic [$clog2(MAX_BR_PER_BLOCK)-1:0] ifu_req_segment_idx,
    output logic [2:0]          ifu_req_kind,
    output logic                ifu_req_valid_lane1,
    input  logic                ifu_req_ready_lane1,
    output logic [PADDR_W-1:0]  ifu_req_paddr_lane1,
    output logic [FTQ_IDX_W-1:0] ifu_req_ftq_idx_lane1,
    output logic [$clog2(MAX_BR_PER_BLOCK)-1:0] ifu_req_segment_idx_lane1,
    output logic [2:0]          ifu_req_kind_lane1,

    output logic [$clog2(QUEUE_DEPTH + 1)-1:0] queue_occupancy,
    output logic                queue_overflow
);

    localparam int unsigned COUNT_W = $clog2(QUEUE_DEPTH + 1);

    logic [PADDR_W-1:0] queue_q [QUEUE_DEPTH];
    logic [FTQ_IDX_W-1:0] queue_ftq_idx_q [QUEUE_DEPTH];
    logic [$clog2(MAX_BR_PER_BLOCK)-1:0] queue_segment_idx_q [QUEUE_DEPTH];
    logic [2:0] queue_kind_q [QUEUE_DEPTH];
    logic [COUNT_W-1:0] count_q;
    logic overflow_q;

    logic pop_c;
    logic pop_lane1_c;
    logic [1:0] pop_count_c;
    logic [1:0] push_count_c;
    logic [COUNT_W:0] demand_count_after_pop_c;
    logic [COUNT_W:0] free_slots_after_pop_c;

    assign ifu_req_valid = enable && !flush_valid && (count_q != '0);
    assign ifu_req_paddr = queue_q[0];
    assign ifu_req_ftq_idx = queue_ftq_idx_q[0];
    assign ifu_req_segment_idx = queue_segment_idx_q[0];
    assign ifu_req_kind = queue_kind_q[0];
    assign ifu_req_valid_lane1 = enable && !flush_valid && (count_q > 1);
    assign ifu_req_paddr_lane1 = queue_q[1];
    assign ifu_req_ftq_idx_lane1 = queue_ftq_idx_q[1];
    assign ifu_req_segment_idx_lane1 = queue_segment_idx_q[1];
    assign ifu_req_kind_lane1 = queue_kind_q[1];
    assign queue_occupancy = count_q;
    assign queue_overflow = overflow_q;
    assign pop_c = ifu_req_valid && ifu_req_ready;
    assign pop_lane1_c = pop_c && ifu_req_valid_lane1 && ifu_req_ready_lane1;
    assign pop_count_c = {1'b0, pop_c} + {1'b0, pop_lane1_c};
    assign demand_count_after_pop_c = {1'b0, count_q} - pop_count_c;
    assign free_slots_after_pop_c = QUEUE_DEPTH[COUNT_W:0] - demand_count_after_pop_c;

    always_comb begin
        push_count_c = 2'd0;
        if (enable && !flush_valid) begin
            for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
                if (fetch_stream_valid[i] && fetch_stream_taken[i]) begin
                    push_count_c = push_count_c + 2'd1;
                end
            end
        end
    end

    assign fetch_stream_ready =
        !enable || flush_valid || ({1'b0, push_count_c} <= free_slots_after_pop_c);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            count_q <= '0;
            overflow_q <= 1'b0;
            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                queue_q[i] <= '0;
                queue_ftq_idx_q[i] <= '0;
                queue_segment_idx_q[i] <= '0;
                queue_kind_q[i] <= '0;
            end
        end else if (flush_valid || !enable) begin
            count_q <= '0;
            overflow_q <= 1'b0;
            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                queue_q[i] <= '0;
                queue_ftq_idx_q[i] <= '0;
                queue_segment_idx_q[i] <= '0;
                queue_kind_q[i] <= '0;
            end
        end else begin
            logic [PADDR_W-1:0] next_queue [QUEUE_DEPTH];
            logic [FTQ_IDX_W-1:0] next_ftq_idx [QUEUE_DEPTH];
            logic [$clog2(MAX_BR_PER_BLOCK)-1:0] next_segment_idx [QUEUE_DEPTH];
            logic [2:0] next_kind [QUEUE_DEPTH];
            logic [COUNT_W:0] next_count;
            logic [COUNT_W:0] append_idx;

            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                next_queue[i] = '0;
                next_ftq_idx[i] = '0;
                next_segment_idx[i] = '0;
                next_kind[i] = '0;
            end

            next_count = {1'b0, count_q};
            if (pop_count_c != 2'd0) begin
                next_count = next_count - pop_count_c;
                for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                    if ((i + pop_count_c) < QUEUE_DEPTH) begin
                        next_queue[i] = queue_q[i + pop_count_c];
                        next_ftq_idx[i] = queue_ftq_idx_q[i + pop_count_c];
                        next_segment_idx[i] = queue_segment_idx_q[i + pop_count_c];
                        next_kind[i] = queue_kind_q[i + pop_count_c];
                    end
                end
            end else begin
                for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                    next_queue[i] = queue_q[i];
                    next_ftq_idx[i] = queue_ftq_idx_q[i];
                    next_segment_idx[i] = queue_segment_idx_q[i];
                    next_kind[i] = queue_kind_q[i];
                end
            end

            append_idx = next_count;
            for (int unsigned lane = 0; lane < MAX_BR_PER_BLOCK; lane++) begin
                if (fetch_stream_accept && fetch_stream_valid[lane] &&
                    fetch_stream_taken[lane]) begin
                    if (append_idx < QUEUE_DEPTH[COUNT_W:0]) begin
                        next_queue[append_idx[COUNT_W-1:0]] =
                            {{(PADDR_W-VADDR_W){1'b0}}, fetch_stream_target_pc[lane]};
                        next_ftq_idx[append_idx[COUNT_W-1:0]] =
                            fetch_stream_ftq_idx[lane];
                        next_segment_idx[append_idx[COUNT_W-1:0]] =
                            fetch_stream_segment_idx[lane];
                        next_kind[append_idx[COUNT_W-1:0]] =
                            fetch_stream_kind[lane];
                        append_idx = append_idx + 1'b1;
                    end else begin
                        overflow_q <= 1'b1;
                    end
                end
            end

            count_q <= append_idx[COUNT_W-1:0];
            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                queue_q[i] <= next_queue[i];
                queue_ftq_idx_q[i] <= next_ftq_idx[i];
                queue_segment_idx_q[i] <= next_segment_idx[i];
                queue_kind_q[i] <= next_kind[i];
            end
        end
    end

endmodule : fetch_stream_to_l1i_demand
