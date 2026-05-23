// bimodal.sv — base bimodal predictor for the TAGE stack.
//
// 2-bit saturating counters indexed by a folded PC hash. This is the bottom
// table of the TAGE direction predictor: it always provides a default
// prediction, and tagged tables override it when they hit. The bimodal also
// hosts the meta predictor weight in some TAGE variants, but here we use it
// purely as a direction baseline and host useful-bit reset state in
// tage_table.sv.

`timescale 1ns/1ps

module bimodal
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    /* verilator lint_off UNUSEDSIGNAL */
    // Same convention as the tagged tables: the bimodal is a pure RAM read
    // on lkp_pc; the consumer gates the result.
    input  logic                lkp_valid,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic [VADDR_W-1:0]  lkp_pc,
    output logic                lkp_taken,
    output logic [BIM_CTR_W-1:0] lkp_ctr,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic                upd_taken
);

    logic [BIM_CTR_W-1:0] table_q [BIM_ENTRIES];

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [BIM_IDX_W-1:0] bim_idx(input logic [VADDR_W-1:0] pc);
        // Drop the lowest bit (compressed/uncompressed alignment) and fold
        // two BIM_IDX_W-bit slices of the upper PC with XOR for a cheap
        // index hash. Bits above 2*BIM_IDX_W are intentionally unused.
        logic [BIM_IDX_W-1:0] low;
        logic [BIM_IDX_W-1:0] high;
        low  = pc[1 +: BIM_IDX_W];
        high = pc[1 + BIM_IDX_W +: BIM_IDX_W];
        bim_idx = low ^ high;
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    logic [BIM_IDX_W-1:0] lkp_i;
    logic [BIM_IDX_W-1:0] upd_i;

    assign lkp_i = bim_idx(lkp_pc);
    assign upd_i = bim_idx(upd_pc);

    always_comb begin
        lkp_ctr   = table_q[lkp_i];
        lkp_taken = table_q[lkp_i][BIM_CTR_W-1];
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            // Weakly-taken on reset: backwards-taken loops and uncond-direct
            // jumps mapped to the conditional path both expect an initial
            // "taken" guess. Matches the behavioural model in
            // benchmarks/cpu/branch/bpu_model.py and the CBP-5 reference
            // predictor. The previous weakly-not-taken seed caused thousands
            // of avoidable cold-cond mispredictions on real traces; see
            // docs/evidence/cpu_ap/mpki_cbp5_vs_tagesc_l_64kb.md.
            table_q <= '{default: {1'b1, {(BIM_CTR_W-1){1'b0}}}};
        end else if (upd_valid) begin
            if (upd_taken) begin
                if (table_q[upd_i] != {BIM_CTR_W{1'b1}})
                    table_q[upd_i] <= table_q[upd_i] + 1'b1;
            end else begin
                if (table_q[upd_i] != '0)
                    table_q[upd_i] <= table_q[upd_i] - 1'b1;
            end
        end
    end

endmodule : bimodal
