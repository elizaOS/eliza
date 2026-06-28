// sc.sv — Statistical Corrector.
//
// The SC adds signed-counter tables on top of TAGE. Each table is indexed by
// PC folded with a different history segment. An optional per-PC bias bank can
// be folded into the same vote so persistent static bias can be learned without
// spending global-history entries. The sum is compared against the threshold
// counter to decide whether to flip TAGE's prediction. Counter SRAM entries
// carry parity; corrupted entries contribute neutral zero until retrained.
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
    typedef logic signed [SC_BIAS_CTR_W-1:0] sc_bias_ctr_t;
    typedef struct packed {
        sc_ctr_t ctr;
        logic    parity;
    } sc_entry_t;
    typedef struct packed {
        sc_bias_ctr_t ctr;
        logic         parity;
    } sc_bias_entry_t;

    sc_entry_t storage_q [SC_TABLES][SC_ENTRIES_TABLE];
    sc_bias_entry_t bias_q [SC_BIAS_ENTRIES];
    logic [SC_LOCAL_HISTORY_BITS-1:0] local_history_q [SC_LOCAL_HISTORY_ENTRIES];
    logic signed [7:0] threshold_q;
    logic signed [5:0] threshold_ctrl_q;

    function automatic logic sc_ctr_parity(input sc_ctr_t ctr);
        sc_ctr_parity = ^ctr;
    endfunction

    function automatic logic sc_bias_ctr_parity(input sc_bias_ctr_t ctr);
        sc_bias_ctr_parity = ^ctr;
    endfunction

    function automatic sc_entry_t sc_entry_with_parity(input sc_ctr_t ctr);
        sc_entry_t fixed;
        fixed.ctr = ctr;
        fixed.parity = sc_ctr_parity(ctr);
        sc_entry_with_parity = fixed;
    endfunction

    function automatic sc_bias_entry_t sc_bias_entry_with_parity(input sc_bias_ctr_t ctr);
        sc_bias_entry_t fixed;
        fixed.ctr = ctr;
        fixed.parity = sc_bias_ctr_parity(ctr);
        sc_bias_entry_with_parity = fixed;
    endfunction

    function automatic sc_ctr_t sc_entry_ctr(input sc_entry_t entry);
        sc_entry_ctr = (entry.parity == sc_ctr_parity(entry.ctr)) ? entry.ctr : '0;
    endfunction

    function automatic sc_bias_ctr_t sc_bias_entry_ctr(input sc_bias_entry_t entry);
        sc_bias_entry_ctr =
            (entry.parity == sc_bias_ctr_parity(entry.ctr)) ? entry.ctr : '0;
    endfunction

    function automatic logic [SC_BIAS_IDX_W-1:0] sc_bias_idx(
        input logic [VADDR_W-1:0] pc
    );
        logic [SC_BIAS_IDX_W-1:0] folded;
        folded = '0;
        for (int unsigned k = 0; k < VADDR_W; k++) begin
            folded[k % SC_BIAS_IDX_W] = folded[k % SC_BIAS_IDX_W] ^ pc[k];
        end
        sc_bias_idx = folded;
    endfunction

    function automatic logic [SC_LOCAL_HISTORY_IDX_W-1:0] sc_local_idx(
        /* verilator lint_off UNUSEDSIGNAL */
        input logic [VADDR_W-1:0] pc
        /* verilator lint_on UNUSEDSIGNAL */
    );
        sc_local_idx = pc[1 +: SC_LOCAL_HISTORY_IDX_W];
    endfunction

    function automatic logic [SC_IDX_W-1:0] fold_local_hist(
        input logic [SC_LOCAL_HISTORY_BITS-1:0] local_hist
    );
        logic [SC_IDX_W-1:0] folded;
        folded = '0;
        for (int unsigned k = 0; k < SC_LOCAL_HISTORY_BITS; k++) begin
            folded[k % SC_IDX_W] = folded[k % SC_IDX_W] ^ local_hist[k];
        end
        fold_local_hist = folded;
    endfunction

    function automatic logic [SC_IDX_W-1:0] sc_idx(
        input int unsigned tid,
        input logic [VADDR_W-1:0] pc,
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        logic [SC_IDX_W-1:0] folded_pc;
        logic [SC_IDX_W-1:0] folded_h;
        logic [SC_IDX_W-1:0] folded_local;
        integer k;
        int unsigned hl;
        hl = sc_hist_len(tid);
        folded_pc = '0;
        folded_h  = '0;
        folded_local = fold_local_hist(local_history_q[sc_local_idx(pc)]);
        for (k = 0; k < VADDR_W; k++)
            folded_pc[k % SC_IDX_W] = folded_pc[k % SC_IDX_W] ^ pc[k];
        for (k = 0; k < int'(hl); k++)
            folded_h[k % SC_IDX_W] = folded_h[k % SC_IDX_W] ^ hist[k];
        sc_idx = folded_pc ^ folded_h ^ folded_local ^ tid[SC_IDX_W-1:0];
    endfunction

    function automatic logic signed [SC_CTR_W+3:0] sc_sum(
        input logic [VADDR_W-1:0] pc,
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        logic signed [SC_CTR_W+3:0] total;
        sc_bias_ctr_t bias_ctr;
        total = '0;
        for (int unsigned t = 0; t < SC_TABLES; t++) begin
            logic [SC_IDX_W-1:0] idx;
            sc_ctr_t ctr;
            idx = sc_idx(t, pc, hist);
            ctr = sc_entry_ctr(storage_q[t][idx]);
            total = total + $signed({{4{ctr[SC_CTR_W-1]}}, ctr});
        end
        if (SC_BIAS_ENABLE != 0) begin
            bias_ctr = sc_bias_entry_ctr(bias_q[sc_bias_idx(pc)]);
            total = total +
                $signed({{(SC_CTR_W + 4 - SC_BIAS_CTR_W){bias_ctr[SC_BIAS_CTR_W-1]}},
                         bias_ctr});
        end
        sc_sum = total;
    endfunction

    function automatic logic signed [SC_CTR_W+3:0] sc_abs(
        input logic signed [SC_CTR_W+3:0] value
    );
        sc_abs = value < 0 ? -value : value;
    endfunction

    logic signed [SC_CTR_W+3:0] sum;
    logic signed [SC_CTR_W+3:0] abs_sum;
    logic signed [SC_CTR_W+3:0] upd_sum;
    logic signed [SC_CTR_W+3:0] upd_abs_sum;
    logic signed [SC_CTR_W+3:0] threshold_cmp;
    logic                       upd_sc_taken;

    always_comb begin
        sum = sc_sum(lkp_pc, lkp_hist);
        abs_sum = sc_abs(sum);
        upd_sum = sc_sum(upd_pc, upd_hist);
        upd_abs_sum = sc_abs(upd_sum);
        threshold_cmp = $signed({{(SC_CTR_W+4-8){1'b0}}, threshold_q});
        upd_sc_taken = (upd_sum >= 0) ? 1'b1 : 1'b0;
        // Override TAGE only when TAGE was low confidence and SC has a
        // confident vote.
        lkp_override = lkp_valid && lkp_tage_lowconf &&
                        (abs_sum >= threshold_cmp);
        // Direction: positive sum => taken.
        lkp_taken = (sum >= 0) ? 1'b1 : 1'b0;
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            /* verilator lint_off BLKSEQ */
            for (int unsigned t = 0; t < SC_TABLES; t++) begin
                for (int unsigned i = 0; i < SC_ENTRIES_TABLE; i++) begin
                    storage_q[t][i] <= sc_entry_with_parity('0);
                end
            end
            for (int unsigned i = 0; i < SC_LOCAL_HISTORY_ENTRIES; i++) begin
                local_history_q[i] = '0;
            end
            if (SC_BIAS_ENABLE != 0) begin
                for (int unsigned i = 0; i < SC_BIAS_ENTRIES; i++) begin
                    bias_q[i] <= sc_bias_entry_with_parity('0);
                end
            end
            /* verilator lint_on BLKSEQ */
            threshold_q <= $signed(SC_THRESH_INIT[7:0]);
            threshold_ctrl_q <= '0;
        end else if (upd_valid) begin
            if (SC_BIAS_ENABLE != 0) begin
                automatic logic [SC_BIAS_IDX_W-1:0] bidx = sc_bias_idx(upd_pc);
                automatic sc_bias_ctr_t bias_base;
                automatic sc_bias_ctr_t bias_next;
                bias_base = sc_bias_entry_ctr(bias_q[bidx]);
                bias_next = bias_base;
                if (upd_taken) begin
                    if (bias_base != {1'b0, {(SC_BIAS_CTR_W-1){1'b1}}})
                        bias_next = bias_base + 1'b1;
                end else begin
                    if (bias_base != {1'b1, {(SC_BIAS_CTR_W-1){1'b0}}})
                        bias_next = bias_base - 1'b1;
                end
                bias_q[bidx] <= sc_bias_entry_with_parity(bias_next);
            end
            if (upd_tage_lowconf) begin
                // Adaptive threshold control: raise the threshold when SC was
                // confidently wrong, lower it when a confident SC vote matched.
                if (upd_sc_taken != upd_taken) begin
                    if (threshold_ctrl_q >= (SC_TC_LIMIT - 6'sd1)) begin
                        threshold_ctrl_q <= '0;
                        if (threshold_q < $signed(SC_THRESH_MAX[7:0]))
                            threshold_q <= threshold_q + 1'b1;
                    end else begin
                        threshold_ctrl_q <= threshold_ctrl_q + 1'b1;
                    end
            end else if (upd_abs_sum >= threshold_cmp) begin
                    if (threshold_ctrl_q <= -(SC_TC_LIMIT - 6'sd1)) begin
                        threshold_ctrl_q <= '0;
                        if (threshold_q > $signed(SC_THRESH_MIN[7:0]))
                            threshold_q <= threshold_q - 1'b1;
                    end else begin
                        threshold_ctrl_q <= threshold_ctrl_q - 1'b1;
                    end
                end
                for (int unsigned t = 0; t < SC_TABLES; t++) begin
                    automatic logic [SC_IDX_W-1:0] idx = sc_idx(t, upd_pc, upd_hist);
                    automatic sc_ctr_t ctr_base;
                    automatic sc_ctr_t ctr_next;
                    ctr_base = sc_entry_ctr(storage_q[t][idx]);
                    ctr_next = ctr_base;
                    if (upd_taken) begin
                        if (ctr_base != {1'b0, {(SC_CTR_W-1){1'b1}}})
                            ctr_next = ctr_base + 1'b1;
                    end else begin
                        if (ctr_base != {1'b1, {(SC_CTR_W-1){1'b0}}})
                            ctr_next = ctr_base - 1'b1;
                    end
                    storage_q[t][idx] <= sc_entry_with_parity(ctr_next);
                end
            end
            local_history_q[sc_local_idx(upd_pc)] <=
                {local_history_q[sc_local_idx(upd_pc)][SC_LOCAL_HISTORY_BITS-2:0],
                 upd_taken};
        end
    end

endmodule : sc
