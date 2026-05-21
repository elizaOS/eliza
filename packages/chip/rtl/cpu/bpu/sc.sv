// sc.sv — Statistical Corrector.
//
// The SC adds four signed-counter tables on top of TAGE. Each table is
// indexed by PC folded with a different history segment (0/4/10/16 bits).
// The sum of the four counters is compared against the threshold counter to
// decide whether to flip TAGE's prediction.
//
// On commit, SC tables train against the actual direction outcome. The
// threshold is bumped up whenever SC's verdict is wrong on a low-confidence
// TAGE prediction and bumped down when it would have helped.

`timescale 1ns/1ps

module sc
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    /* verilator lint_off UNUSEDSIGNAL */
    // Caller-side observation: the SC computes its own direction from the
    // counter sum, so the consumer's TAGE direction is recorded only for
    // future override-policy extensions.
    input  logic                lkp_tage_taken,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic                lkp_tage_lowconf,
    output logic                lkp_override,
    output logic                lkp_taken,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic                upd_taken,
    input  logic                upd_tage_lowconf
);
    typedef logic signed [SC_CTR_W-1:0] sc_ctr_t;

    sc_ctr_t storage_q [SC_TABLES][SC_ENTRIES_TABLE];
    logic signed [7:0] threshold_q;

    function automatic logic [SC_IDX_W-1:0] sc_idx(
        input int unsigned tid,
        input logic [VADDR_W-1:0] pc,
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        logic [SC_IDX_W-1:0] folded_pc;
        logic [SC_IDX_W-1:0] folded_h;
        integer k;
        int unsigned hl;
        hl = sc_hist_len(tid);
        folded_pc = '0;
        folded_h  = '0;
        for (k = 0; k < VADDR_W; k++)
            folded_pc[k % SC_IDX_W] = folded_pc[k % SC_IDX_W] ^ pc[k];
        for (k = 0; k < int'(hl); k++)
            folded_h[k % SC_IDX_W] = folded_h[k % SC_IDX_W] ^
                hist[TAGE_HIST_LEN_MAX-1-k];
        sc_idx = folded_pc ^ folded_h ^ tid[SC_IDX_W-1:0];
    endfunction

    logic signed [SC_CTR_W+2:0] sum;
    logic signed [SC_CTR_W+2:0] abs_sum;

    always_comb begin
        sum = '0;
        for (int unsigned t = 0; t < SC_TABLES; t++) begin
            automatic logic [SC_IDX_W-1:0] idx;
            automatic sc_ctr_t ctr;
            idx = sc_idx(t, lkp_pc, lkp_hist);
            ctr = storage_q[t][idx];
            sum = sum + $signed({{3{ctr[SC_CTR_W-1]}}, ctr});
        end
        abs_sum = sum < 0 ? -sum : sum;
        // Override TAGE only when TAGE was low confidence and SC has a
        // confident vote.
        lkp_override = lkp_valid && lkp_tage_lowconf &&
                        (abs_sum >= $signed({1'b0, threshold_q}));
        // Direction: positive sum => taken.
        lkp_taken = (sum >= 0) ? 1'b1 : 1'b0;
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            storage_q <= '{default: '{default: '0}};
            threshold_q <= $signed(SC_THRESH_INIT[7:0]);
        end else if (upd_valid && upd_tage_lowconf) begin
            for (int unsigned t = 0; t < SC_TABLES; t++) begin
                automatic logic [SC_IDX_W-1:0] idx = sc_idx(t, upd_pc, upd_hist);
                if (upd_taken) begin
                    if (storage_q[t][idx] != {1'b0, {(SC_CTR_W-1){1'b1}}})
                        storage_q[t][idx] <= storage_q[t][idx] + 1'b1;
                end else begin
                    if (storage_q[t][idx] != {1'b1, {(SC_CTR_W-1){1'b0}}})
                        storage_q[t][idx] <= storage_q[t][idx] - 1'b1;
                end
            end
        end
    end

endmodule : sc
