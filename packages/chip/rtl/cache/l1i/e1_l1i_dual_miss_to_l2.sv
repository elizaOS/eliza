`timescale 1ns/1ps

// e1_l1i_dual_miss_to_l2
//
// Bridges the L1I scalar miss pipe plus the optional lane-1 IFU demand miss
// pipe into the production L2 L1I acquire/grant channel. L2 returns a whole
// cache line; this adapter splits that line into the four 128-bit refill beats
// expected by e1_l1i_cache and demuxes the beats back to the miss source lane.

module e1_l1i_dual_miss_to_l2
    import e1_cache_pkg::*;
#(
    parameter int unsigned LINE_BYTES = L1I_LINE_BYTES,
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT
) (
    input  logic                    clk,
    input  logic                    rst_n,
    input  logic                    flush_i,

    input  logic                    miss_valid_i,
    output logic                    miss_ready_o,
    input  logic [PADDR_W-1:0]      miss_paddr_line_i,
    input  logic                    miss_is_prefetch_i,

    input  logic                    miss_valid_lane1_i,
    output logic                    miss_ready_lane1_o,
    input  logic [PADDR_W-1:0]      miss_paddr_line_lane1_i,
    input  logic                    miss_is_prefetch_lane1_i,

    output logic                    l2_l1i_acq_valid_o,
    input  logic                    l2_l1i_acq_ready_i,
    output logic [PADDR_W-1:0]      l2_l1i_acq_paddr_line_o,
    output logic                    l2_l1i_acq_is_prefetch_o,

    input  logic                    l2_l1i_grant_valid_i,
    output logic                    l2_l1i_grant_ready_o,
    input  logic [PADDR_W-1:0]      l2_l1i_grant_paddr_line_i,
    input  logic [8*LINE_BYTES-1:0] l2_l1i_grant_data_i,
    input  mesi_e                   l2_l1i_grant_state_i,

    output logic                    refill_valid_o,
    input  logic                    refill_ready_i,
    output logic [127:0]            refill_data_o,
    output logic [1:0]              refill_beat_idx_o,
    output logic                    refill_last_o,

    output logic                    refill_valid_lane1_o,
    input  logic                    refill_ready_lane1_i,
    output logic [127:0]            refill_data_lane1_o,
    output logic [1:0]              refill_beat_idx_lane1_o,
    output logic                    refill_last_lane1_o,

    output logic                    busy_o,
    output logic                    active_lane1_o
);
    localparam int unsigned LINE_BITS = 8 * LINE_BYTES;
    localparam int unsigned BEAT_BITS = 128;
    localparam int unsigned BEATS_PER_LINE = LINE_BITS / BEAT_BITS;
    localparam logic [1:0] LAST_BEAT = 2'd3;

    typedef enum logic [1:0] {
        S_IDLE,
        S_ACQ,
        S_GRANT,
        S_REFILL
    } state_e;

    state_e              state_q;
    logic                active_lane1_q;
    logic [PADDR_W-1:0]  active_paddr_q;
    logic                active_prefetch_q;
    logic [LINE_BITS-1:0] line_q;
    logic [1:0]          beat_q;

    logic pick_lane1_c;
    logic refill_fire_c;
    logic active_refill_ready_c;

    assign pick_lane1_c = !miss_valid_i && miss_valid_lane1_i;

    assign miss_ready_o =
        (state_q == S_IDLE) && !flush_i && miss_valid_i;
    assign miss_ready_lane1_o =
        (state_q == S_IDLE) && !flush_i && !miss_valid_i && miss_valid_lane1_i;

    assign l2_l1i_acq_valid_o = (state_q == S_ACQ);
    assign l2_l1i_acq_paddr_line_o = active_paddr_q;
    assign l2_l1i_acq_is_prefetch_o = active_prefetch_q;

    assign l2_l1i_grant_ready_o = (state_q == S_GRANT);

    assign refill_valid_o = (state_q == S_REFILL) && !active_lane1_q;
    assign refill_valid_lane1_o = (state_q == S_REFILL) && active_lane1_q;
    assign refill_data_o = line_q[beat_q*BEAT_BITS +: BEAT_BITS];
    assign refill_data_lane1_o = line_q[beat_q*BEAT_BITS +: BEAT_BITS];
    assign refill_beat_idx_o = beat_q;
    assign refill_beat_idx_lane1_o = beat_q;
    assign refill_last_o = refill_valid_o && (beat_q == LAST_BEAT);
    assign refill_last_lane1_o =
        refill_valid_lane1_o && (beat_q == LAST_BEAT);

    assign active_refill_ready_c = active_lane1_q ? refill_ready_lane1_i : refill_ready_i;
    assign refill_fire_c = (state_q == S_REFILL) && active_refill_ready_c;

    assign busy_o = (state_q != S_IDLE);
    assign active_lane1_o = active_lane1_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state_q <= S_IDLE;
            active_lane1_q <= 1'b0;
            active_paddr_q <= '0;
            active_prefetch_q <= 1'b0;
            line_q <= '0;
            beat_q <= '0;
        end else begin
            if (flush_i) begin
                state_q <= S_IDLE;
                active_lane1_q <= 1'b0;
                active_paddr_q <= '0;
                active_prefetch_q <= 1'b0;
                beat_q <= '0;
            end else begin
                case (state_q)
                    S_IDLE: begin
                        if (miss_valid_i || miss_valid_lane1_i) begin
                            active_lane1_q <= pick_lane1_c;
                            active_paddr_q <= pick_lane1_c
                                ? miss_paddr_line_lane1_i
                                : miss_paddr_line_i;
                            active_prefetch_q <= pick_lane1_c
                                ? miss_is_prefetch_lane1_i
                                : miss_is_prefetch_i;
                            state_q <= S_ACQ;
                        end
                    end
                    S_ACQ: begin
                        if (l2_l1i_acq_ready_i) begin
                            state_q <= S_GRANT;
                        end
                    end
                    S_GRANT: begin
                        if (l2_l1i_grant_valid_i) begin
                            line_q <= l2_l1i_grant_data_i;
                            beat_q <= '0;
                            state_q <= S_REFILL;
                        end
                    end
                    S_REFILL: begin
                        if (refill_fire_c) begin
                            if (beat_q == LAST_BEAT) begin
                                state_q <= S_IDLE;
                            end else begin
                                beat_q <= beat_q + 2'd1;
                            end
                        end
                    end
                    default: state_q <= S_IDLE;
                endcase
            end
        end
    end

    logic unused_l2_fields;
    assign unused_l2_fields = ^{l2_l1i_grant_paddr_line_i, l2_l1i_grant_state_i};
endmodule
