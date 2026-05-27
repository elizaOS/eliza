// h2p_corrector.sv - H2P/perceptron-style direction sidecar.
//
// A small signed-weight perceptron bank indexed by branch PC. The corrector is
// threshold-gated: it overrides only when the dot-product margin is strong,
// and trains on wrong or low-margin predictions. Optional target-history and
// path-history feature slices make this a compact multi-perspective corrector
// without changing the default global-history-only geometry.

`timescale 1ns/1ps

module h2p_corrector
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    input  logic [ITTAGE_TARGET_HISTORY_BITS-1:0] lkp_target_hist,
    input  logic [ITTAGE_PATH_HISTORY_BITS-1:0] lkp_path_hist,
    output logic                lkp_override,
    output logic                lkp_taken,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic [ITTAGE_TARGET_HISTORY_BITS-1:0] upd_target_hist,
    input  logic [ITTAGE_PATH_HISTORY_BITS-1:0] upd_path_hist,
    input  logic                upd_taken
);
    typedef logic signed [H2P_WEIGHT_W-1:0] h2p_weight_t;
    typedef logic signed [H2P_SCORE_W-1:0] h2p_score_t;

    h2p_weight_t weights_q [H2P_ENTRIES][H2P_FEATURES+1];

    function automatic logic [H2P_IDX_W-1:0] h2p_idx(
        input logic [VADDR_W-1:0] pc
    );
        logic [H2P_IDX_W-1:0] folded_lo;
        logic [H2P_IDX_W-1:0] folded_hi;
        folded_lo = '0;
        folded_hi = '0;
        for (int unsigned k = 2; k < VADDR_W; k++) begin
            folded_lo[(k - 2) % H2P_IDX_W] = folded_lo[(k - 2) % H2P_IDX_W] ^ pc[k];
        end
        for (int unsigned k = 11; k < VADDR_W; k++) begin
            folded_hi[(k - 11) % H2P_IDX_W] = folded_hi[(k - 11) % H2P_IDX_W] ^ pc[k];
        end
        h2p_idx = folded_lo ^ folded_hi;
    endfunction

    function automatic h2p_score_t h2p_abs(input h2p_score_t value);
        h2p_abs = value[H2P_SCORE_W-1] ? -value : value;
    endfunction

    function automatic h2p_score_t h2p_score(
        input logic [VADDR_W-1:0] pc,
        input logic [TAGE_HIST_LEN_MAX-1:0] hist,
        input logic [ITTAGE_TARGET_HISTORY_BITS-1:0] target_hist,
        input logic [ITTAGE_PATH_HISTORY_BITS-1:0] path_hist
    );
        h2p_score_t total;
        logic [H2P_IDX_W-1:0] idx;
        int unsigned feature_idx;
        idx = h2p_idx(pc);
        total = h2p_score_t'(weights_q[idx][0]);
        feature_idx = 1;
        for (int unsigned hist_bit = 0; hist_bit < H2P_HIST_LEN; hist_bit++) begin
            if (hist[hist_bit]) begin
                total = total + h2p_score_t'(weights_q[idx][feature_idx]);
            end else begin
                total = total - h2p_score_t'(weights_q[idx][feature_idx]);
            end
            feature_idx++;
        end
        /* verilator lint_off UNSIGNED */
        /* verilator lint_off UNUSED */
        for (int unsigned hist_bit = 0; hist_bit < H2P_TARGET_HIST_LEN; hist_bit++) begin
            if (target_hist[hist_bit % ITTAGE_TARGET_HISTORY_BITS]) begin
                total = total + h2p_score_t'(weights_q[idx][feature_idx]);
            end else begin
                total = total - h2p_score_t'(weights_q[idx][feature_idx]);
            end
            feature_idx++;
        end
        for (int unsigned hist_bit = 0; hist_bit < H2P_PATH_HIST_LEN; hist_bit++) begin
            if (path_hist[hist_bit % ITTAGE_PATH_HISTORY_BITS]) begin
                total = total + h2p_score_t'(weights_q[idx][feature_idx]);
            end else begin
                total = total - h2p_score_t'(weights_q[idx][feature_idx]);
            end
            feature_idx++;
        end
        /* verilator lint_on UNUSED */
        /* verilator lint_on UNSIGNED */
        h2p_score = total;
    endfunction

    function automatic h2p_weight_t sat_add_weight(
        input h2p_weight_t value,
        input logic signed [1:0] delta
    );
        h2p_weight_t hi;
        h2p_weight_t lo;
        h2p_score_t widened;
        hi = h2p_weight_t'((1 << (H2P_WEIGHT_W - 1)) - 1);
        lo = h2p_weight_t'(-(1 << (H2P_WEIGHT_W - 1)));
        widened = h2p_score_t'(value) + h2p_score_t'(delta);
        if (widened > h2p_score_t'(hi)) begin
            sat_add_weight = hi;
        end else if (widened < h2p_score_t'(lo)) begin
            sat_add_weight = lo;
        end else begin
            sat_add_weight = h2p_weight_t'(widened);
        end
    endfunction

    h2p_score_t lkp_score;
    h2p_score_t upd_score;
    logic [H2P_IDX_W-1:0] upd_idx;
    logic upd_pred_taken;
    logic upd_train;
    logic signed [1:0] actual_sign;

    always_comb begin
        lkp_score = h2p_score(lkp_pc, lkp_hist, lkp_target_hist, lkp_path_hist);
        lkp_taken = !lkp_score[H2P_SCORE_W-1];
        lkp_override = (H2P_ENABLE != 0) && lkp_valid &&
                       (h2p_abs(lkp_score) >= h2p_score_t'(H2P_THRESHOLD));

        upd_score = h2p_score(upd_pc, upd_hist, upd_target_hist, upd_path_hist);
        upd_idx = h2p_idx(upd_pc);
        upd_pred_taken = !upd_score[H2P_SCORE_W-1];
        upd_train = (H2P_ENABLE != 0) && upd_valid &&
                    ((upd_pred_taken != upd_taken) ||
                     (h2p_abs(upd_score) <= h2p_score_t'(H2P_THRESHOLD)));
        actual_sign = upd_taken ? 2'sd1 : -2'sd1;
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            /* verilator lint_off BLKSEQ */
            /* verilator lint_off UNUSED */
            for (int unsigned i = 0; i < H2P_ENTRIES; i++) begin
                for (int unsigned j = 0; j < H2P_FEATURES+1; j++) begin
                    weights_q[i][j] = '0;
                end
            end
            /* verilator lint_on UNUSED */
            /* verilator lint_on BLKSEQ */
        end else if (upd_train) begin
            weights_q[upd_idx][0] <= sat_add_weight(weights_q[upd_idx][0], actual_sign);
            for (int unsigned hist_bit = 0; hist_bit < H2P_HIST_LEN; hist_bit++) begin
                weights_q[upd_idx][hist_bit+1] <= sat_add_weight(
                    weights_q[upd_idx][hist_bit+1],
                    upd_hist[hist_bit] ? actual_sign : -actual_sign
                );
            end
            /* verilator lint_off UNSIGNED */
            /* verilator lint_off UNUSED */
            for (int unsigned hist_bit = 0; hist_bit < H2P_TARGET_HIST_LEN; hist_bit++) begin
                weights_q[upd_idx][H2P_HIST_LEN+1+hist_bit] <= sat_add_weight(
                    weights_q[upd_idx][H2P_HIST_LEN+1+hist_bit],
                    upd_target_hist[hist_bit % ITTAGE_TARGET_HISTORY_BITS] ?
                        actual_sign : -actual_sign
                );
            end
            for (int unsigned hist_bit = 0; hist_bit < H2P_PATH_HIST_LEN; hist_bit++) begin
                weights_q[upd_idx][H2P_HIST_LEN+H2P_TARGET_HIST_LEN+1+hist_bit] <=
                    sat_add_weight(
                    weights_q[upd_idx][H2P_HIST_LEN+H2P_TARGET_HIST_LEN+1+hist_bit],
                    upd_path_hist[hist_bit % ITTAGE_PATH_HISTORY_BITS] ?
                        actual_sign : -actual_sign
                );
            end
            /* verilator lint_on UNUSED */
            /* verilator lint_on UNSIGNED */
        end
    end
endmodule
