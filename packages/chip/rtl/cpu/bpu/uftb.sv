// uftb.sv — micro Fetch Target Buffer.
//
// The uFTB is the zero-bubble next-line predictor that runs ahead of the FTB.
// It is smaller, simpler, and consulted every cycle; its only job is to emit
// a guess at the next fetch block start PC fast enough that the BPU pipeline
// can issue an L1I prefetch on the same cycle. A hit drives the next PC
// directly; a miss falls back to PC+block.
//
// The uFTB is a small set-associative cache parameterized in bpu_pkg.

`timescale 1ns/1ps

module uftb
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    output logic                lkp_hit,
    output logic [VADDR_W-1:0]  lkp_next_pc,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [VADDR_W-1:0]  upd_next_pc,

    output logic                pmu_hit
);

    typedef struct packed {
        logic                       valid;
        logic [UFTB_TAG_W-1:0]      tag;
        logic [VADDR_W-1:0]         next_pc;
    } uftb_entry_t;

    uftb_entry_t storage_q [UFTB_SETS][UFTB_WAYS];
    logic [$clog2(UFTB_WAYS)-1:0] rr_ptr_q [UFTB_SETS];

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [UFTB_IDX_W-1:0] uftb_idx(input logic [VADDR_W-1:0] pc);
        uftb_idx = pc[5 +: UFTB_IDX_W];
    endfunction

    function automatic logic [UFTB_TAG_W-1:0] uftb_tag(input logic [VADDR_W-1:0] pc);
        uftb_tag = pc[5 + UFTB_IDX_W +: UFTB_TAG_W];
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    logic [UFTB_IDX_W-1:0] lkp_i;
    logic [UFTB_TAG_W-1:0] lkp_t;
    always_comb begin
        lkp_i       = uftb_idx(lkp_pc);
        lkp_t       = uftb_tag(lkp_pc);
        lkp_hit     = 1'b0;
        lkp_next_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
        if (lkp_valid) begin
            for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                if (storage_q[lkp_i][w].valid &&
                    storage_q[lkp_i][w].tag == lkp_t) begin
                    lkp_hit     = 1'b1;
                    lkp_next_pc = storage_q[lkp_i][w].next_pc;
                end
            end
        end
    end

    logic [UFTB_IDX_W-1:0] upd_i;
    logic [UFTB_TAG_W-1:0] upd_t;
    logic                  upd_match_any;
    logic [$clog2(UFTB_WAYS)-1:0] upd_match_way;
    always_comb begin
        upd_i         = uftb_idx(upd_pc);
        upd_t         = uftb_tag(upd_pc);
        upd_match_any = 1'b0;
        upd_match_way = '0;
        for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
            if (storage_q[upd_i][w].valid &&
                storage_q[upd_i][w].tag == upd_t) begin
                upd_match_any = 1'b1;
                upd_match_way = w[$clog2(UFTB_WAYS)-1:0];
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned s = 0; s < UFTB_SETS; s++) begin
                for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                    storage_q[s][w] <= '{valid:1'b0, tag:'0, next_pc:'0};
                end
                rr_ptr_q[s] <= '0;
            end
            pmu_hit <= 1'b0;
        end else begin
            pmu_hit <= lkp_valid && lkp_hit;
            if (upd_valid) begin
                if (upd_match_any) begin
                    storage_q[upd_i][upd_match_way].next_pc <= upd_next_pc;
                end else begin
                    storage_q[upd_i][rr_ptr_q[upd_i]] <= '{
                        valid:   1'b1,
                        tag:     upd_t,
                        next_pc: upd_next_pc
                    };
                    rr_ptr_q[upd_i] <= rr_ptr_q[upd_i] + 1'b1;
                end
            end
        end
    end

endmodule : uftb
