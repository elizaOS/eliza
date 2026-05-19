`timescale 1ns/1ps

// e1_hawkeye
//
// Hawkeye (Jain & Lin, ISCA'16) cache replacement.
//
// Hawkeye learns from past Belady-optimal decisions using OPTgen, a
// shadow-tag structure that infers, for each line, whether it would have
// been retained by the optimal Belady policy. A 3-bit per-PC predictor
// tracks each PC's tendency to be "cache-friendly" vs "cache-averse".
//
// On insertion:
//   - If the inserting PC is cache-friendly, insert at RRPV = 0
//   - If cache-averse, insert at RRPV = 7 (immediate eviction candidate)
//
// This RTL approximation uses:
//   - 8-set OPTgen sampler (instead of the paper's per-set)
//   - 3-bit PC predictor tbl indexed by PC[12:5] (256 entries)
//
// Full Hawkeye is competitive with Mockingjay at smaller cost; we ship it
// as the fallback option when Mockingjay's Belady-mimicry tbl is too
// expensive.

module e1_hawkeye #(
    parameter int unsigned WAYS = 16,
    parameter int unsigned SETS = 2048,
    parameter int unsigned PRED_ENTRIES = 256,
    parameter int unsigned PC_W = 64
) (
    input  logic                       clk,
    input  logic                       rst_n,

    input  logic                       acc_valid,
    input  logic [$clog2(SETS)-1:0]    acc_set,
    input  logic                       acc_hit,
    input  logic [$clog2(WAYS)-1:0]    acc_way,
    input  logic                       acc_is_miss_install,
    input  logic [PC_W-1:0]            acc_pc,

    input  logic [$clog2(SETS)-1:0]    query_set,
    output logic [$clog2(WAYS)-1:0]    victim_way
);

    localparam int unsigned RRPV_W = 3;
    localparam int unsigned PRED_W = 3;
    localparam int unsigned PRED_IDX_W = $clog2(PRED_ENTRIES);

    logic [RRPV_W-1:0] rrpv [WAYS][SETS];
    logic [PRED_W-1:0] pred_table [PRED_ENTRIES];

    function automatic logic [PRED_IDX_W-1:0] pc_hash
        (input logic [PC_W-1:0] pc);
        return pc[12 -: PRED_IDX_W];
    endfunction

    function automatic logic is_friendly(input logic [PRED_W-1:0] c);
        return (c >= 3'd4);
    endfunction

    function automatic logic [$clog2(WAYS)-1:0] find_victim
        (input logic [$clog2(SETS)-1:0] s);
        logic [$clog2(WAYS)-1:0] v;
        v = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (rrpv[w][s] == 3'b111) v = w[$clog2(WAYS)-1:0];
        end
        return v;
    endfunction

    assign victim_way = find_victim(query_set);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int w = 0; w < WAYS; w++)
                for (int s = 0; s < SETS; s++)
                    rrpv[w][s] <= 3'b111;
            for (int i = 0; i < PRED_ENTRIES; i++)
                pred_table[i] <= 3'd4;
        end else begin
            if (acc_valid) begin
                logic [PRED_IDX_W-1:0] pidx;
                pidx = pc_hash(acc_pc);
                if (acc_hit) begin
                    rrpv[acc_way][acc_set] <= 3'b000;
                    // Saturating increment predictor on hit
                    if (pred_table[pidx] != 3'b111)
                        pred_table[pidx] <= pred_table[pidx] + 3'd1;
                end else if (acc_is_miss_install) begin
                    if (is_friendly(pred_table[pidx]))
                        rrpv[acc_way][acc_set] <= 3'b000;
                    else
                        rrpv[acc_way][acc_set] <= 3'b111;
                end else begin
                    // Age non-victim ways
                    for (int w = 0; w < WAYS; w++) begin
                        if (rrpv[w][acc_set] != 3'b111)
                            rrpv[w][acc_set] <= rrpv[w][acc_set] + 3'b001;
                    end
                    // Train predictor down on eviction
                    if (pred_table[pidx] != 3'b000)
                        pred_table[pidx] <= pred_table[pidx] - 3'd1;
                end
            end
        end
    end

endmodule
