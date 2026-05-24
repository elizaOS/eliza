// loop_predictor.sv — short-trip-count loop predictor.
//
// Each entry records the observed iteration count of a backward conditional
// branch and its confidence. On lookup, if the entry hits and its confidence
// is at the top of the scale, the loop predictor overrides TAGE-SC and
// predicts "taken" until the iteration counter reaches the observed bound.
//
// Implementation matches Seznec's TAGE-SC-L appendix: a small fully
// associative table is functionally simpler than a hashed table at this
// entry count (64) and is allowed because loop entries are extremely rare
// relative to direction predictions. Replacement is invalid-first and then
// weak/old-first so a trained loop is not displaced by one-shot loop noise.

`timescale 1ns/1ps

module loop_predictor
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [LOOP_PATH_SIG_W-1:0] lkp_path_sig,
    output logic                lkp_hit,
    output logic                lkp_taken,
    output logic                pmu_hit,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [LOOP_PATH_SIG_W-1:0] upd_path_sig,
    input  logic [VADDR_W-1:0]  upd_target,
    input  logic                upd_taken
);

    localparam int unsigned LOOP_PC_SIG_W = 8;

    typedef struct packed {
        logic                       valid;
        logic [LOOP_TAG_W-1:0]      tag;
        logic [LOOP_PC_SIG_W-1:0]   pc_sig;
        logic [LOOP_PATH_SIG_W-1:0] path_sig;
        logic [LOOP_CTR_W-1:0]      iter_cur;
        logic [LOOP_CTR_W-1:0]      iter_max;
        logic [LOOP_CONF_W-1:0]     conf;
        logic                       early_exit_seen;
        logic [3:0]                 age;
    } loop_entry_t;

    loop_entry_t storage_q [LOOP_ENTRIES];
    logic [LOOP_IMLI_HIST_W-1:0] imli_hist_q;

    function automatic logic [LOOP_TAG_W-1:0] tag_hash(input logic [VADDR_W-1:0] pc);
        logic [LOOP_TAG_W-1:0] folded;
        integer k;
        folded = '0;
        for (k = 0; k < VADDR_W; k++)
            folded[k % LOOP_TAG_W] = folded[k % LOOP_TAG_W] ^ pc[k];
        tag_hash = folded;
    endfunction

    function automatic logic [LOOP_PC_SIG_W-1:0] pc_signature(
        /* verilator lint_off UNUSEDSIGNAL */
        input logic [VADDR_W-1:0] pc
        /* verilator lint_on UNUSEDSIGNAL */
    );
        pc_signature = pc[21:14] ^ pc[29:22] ^ {1'b0, pc[38:32]};
    endfunction

    function automatic logic [LOOP_IMLI_TOKEN_W-1:0] imli_token(
        input logic [VADDR_W-1:0] pc,
        input logic [LOOP_CTR_W-1:0] iter_count
    );
        logic [LOOP_IMLI_TOKEN_W-1:0] folded;
        folded = '0;
        for (int unsigned k = 0; k < LOOP_CTR_W; k++) begin
            folded[k % LOOP_IMLI_TOKEN_W] =
                folded[k % LOOP_IMLI_TOKEN_W] ^ iter_count[k];
        end
        for (int unsigned k = 0; k < VADDR_W; k++) begin
            folded[k % LOOP_IMLI_TOKEN_W] =
                folded[k % LOOP_IMLI_TOKEN_W] ^ pc[k];
        end
        imli_token = folded;
    endfunction

    function automatic logic [LOOP_PATH_SIG_W-1:0] imli_path_sig(
        input logic [LOOP_PATH_SIG_W-1:0] path_sig,
        input logic [LOOP_IMLI_HIST_W-1:0] imli_hist
    );
        logic [LOOP_PATH_SIG_W-1:0] folded;
        folded = '0;
        for (int unsigned k = 0; k < LOOP_IMLI_HIST_W; k++) begin
            folded[k % LOOP_PATH_SIG_W] =
                folded[k % LOOP_PATH_SIG_W] ^ imli_hist[k];
        end
        imli_path_sig =
            (LOOP_IMLI_ENABLE != 0) ? (path_sig ^ folded) : path_sig;
    endfunction

    logic [LOOP_TAG_W-1:0] lkp_t;
    logic [LOOP_PC_SIG_W-1:0] lkp_sig;
    logic [LOOP_PATH_SIG_W-1:0] lkp_effective_path_sig;
    logic [LOOP_IDX_W-1:0] hit_idx;
    logic                  hit_found;

    always_comb begin
        lkp_t     = tag_hash(lkp_pc);
        lkp_sig   = pc_signature(lkp_pc);
        lkp_effective_path_sig = imli_path_sig(lkp_path_sig, imli_hist_q);
        hit_found = 1'b0;
        hit_idx   = '0;
        for (int unsigned li = 0; li < LOOP_ENTRIES; li++) begin
            if (storage_q[li].valid && storage_q[li].tag == lkp_t &&
                storage_q[li].pc_sig == lkp_sig &&
                storage_q[li].path_sig == lkp_effective_path_sig) begin
                hit_found = 1'b1;
                hit_idx   = li[LOOP_IDX_W-1:0];
            end
        end
        lkp_hit = lkp_valid && hit_found && (storage_q[hit_idx].conf == {LOOP_CONF_W{1'b1}});
        lkp_taken = lkp_hit &&
                     (storage_q[hit_idx].iter_cur < storage_q[hit_idx].iter_max);
    end

    logic [LOOP_TAG_W-1:0] upd_t;
    logic [LOOP_PC_SIG_W-1:0] upd_sig;
    logic [LOOP_PATH_SIG_W-1:0] upd_effective_path_sig;
    logic [LOOP_IDX_W-1:0] upd_hit_idx;
    logic                  upd_hit_found;
    logic                  upd_backward;
    logic [LOOP_IDX_W-1:0] repl_idx;
    logic [4:0]            repl_score;
    logic [4:0]            cand_score;

    assign upd_backward = upd_target < upd_pc;

    always_comb begin
        upd_t         = tag_hash(upd_pc);
        upd_sig       = pc_signature(upd_pc);
        upd_effective_path_sig = imli_path_sig(upd_path_sig, imli_hist_q);
        upd_hit_found = 1'b0;
        upd_hit_idx   = '0;
        for (int unsigned li = 0; li < LOOP_ENTRIES; li++) begin
            if (storage_q[li].valid && storage_q[li].tag == upd_t &&
                storage_q[li].pc_sig == upd_sig &&
                storage_q[li].path_sig == upd_effective_path_sig) begin
                upd_hit_found = 1'b1;
                upd_hit_idx   = li[LOOP_IDX_W-1:0];
            end
        end
    end

    always_comb begin
        repl_idx   = '0;
        repl_score = '0;
        for (int unsigned li = 0; li < LOOP_ENTRIES; li++) begin
            if (!storage_q[li].valid) begin
                cand_score = 5'h1f;
            end else if (storage_q[li].conf == '0) begin
                cand_score = {1'b1, storage_q[li].age};
            end else begin
                cand_score = {1'b0, storage_q[li].age};
            end

            if (cand_score >= repl_score) begin
                repl_score = cand_score;
                repl_idx   = li[LOOP_IDX_W-1:0];
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned li = 0; li < LOOP_ENTRIES; li++) begin
                storage_q[li] <= '{
                    valid:1'b0,
                    tag:'0,
                    pc_sig:'0,
                    path_sig:'0,
                    iter_cur:'0,
                    iter_max:'0,
                    conf:'0,
                    early_exit_seen:1'b0,
                    age:'0
                };
            end
            pmu_hit  <= 1'b0;
            imli_hist_q <= '0;
        end else begin
            pmu_hit <= lkp_hit;
            for (int unsigned li = 0; li < LOOP_ENTRIES; li++) begin
                if (storage_q[li].valid && storage_q[li].age != '1)
                    storage_q[li].age <= storage_q[li].age + 1'b1;
            end
            if (lkp_valid && hit_found)
                storage_q[hit_idx].age <= '0;
            if (upd_valid) begin
                if (!upd_backward) begin
                    if (upd_hit_found) begin
                        // Forward conditionals are not loops. If a stale entry
                        // aliases this PC/tag, clear it instead of letting a
                        // hot forward branch learn a bogus trip count.
                        storage_q[upd_hit_idx].iter_cur <= '0;
                        storage_q[upd_hit_idx].iter_max <= '0;
                        storage_q[upd_hit_idx].conf     <= '0;
                        storage_q[upd_hit_idx].early_exit_seen <= 1'b0;
                        storage_q[upd_hit_idx].age      <= '0;
                    end
                end else if (upd_hit_found) begin
                    storage_q[upd_hit_idx].age <= '0;
                    if (upd_taken) begin
                        // If the branch keeps taking after the learned exit
                        // count, the old trip count is stale. Drop confidence
                        // immediately so a variable-phase loop does not keep
                        // overriding TAGE-SC with a false exit prediction.
                        if ((storage_q[upd_hit_idx].iter_max != '0) &&
                            (storage_q[upd_hit_idx].iter_cur >=
                             storage_q[upd_hit_idx].iter_max)) begin
                            storage_q[upd_hit_idx].conf <= '0;
                            storage_q[upd_hit_idx].early_exit_seen <= 1'b0;
                        end
                        if (storage_q[upd_hit_idx].iter_cur !=
                            {LOOP_CTR_W{1'b1}})
                            storage_q[upd_hit_idx].iter_cur <=
                                storage_q[upd_hit_idx].iter_cur + 1'b1;
                    end else begin
                        // Loop exit: latch the observed max, raise confidence
                        // if the max matches the previous observation.
                        if (storage_q[upd_hit_idx].iter_max ==
                            storage_q[upd_hit_idx].iter_cur) begin
                            if (storage_q[upd_hit_idx].conf !=
                                {LOOP_CONF_W{1'b1}})
                                storage_q[upd_hit_idx].conf <=
                                    storage_q[upd_hit_idx].conf + 1'b1;
                            storage_q[upd_hit_idx].early_exit_seen <= 1'b0;
                            if (LOOP_IMLI_ENABLE != 0) begin
                                imli_hist_q <=
                                    {imli_hist_q[LOOP_IMLI_HIST_W-LOOP_IMLI_TOKEN_W-1:0],
                                     imli_token(upd_pc, storage_q[upd_hit_idx].iter_cur)};
                            end
                        end else if ((storage_q[upd_hit_idx].iter_max != '0) &&
                                     (storage_q[upd_hit_idx].iter_cur <
                                      storage_q[upd_hit_idx].iter_max) &&
                                     !storage_q[upd_hit_idx].early_exit_seen) begin
                            storage_q[upd_hit_idx].early_exit_seen <= 1'b1;
                            if (storage_q[upd_hit_idx].conf != '0)
                                storage_q[upd_hit_idx].conf <=
                                    storage_q[upd_hit_idx].conf - 1'b1;
                            if (LOOP_IMLI_ENABLE != 0) begin
                                imli_hist_q <=
                                    {imli_hist_q[LOOP_IMLI_HIST_W-LOOP_IMLI_TOKEN_W-1:0],
                                     imli_token(upd_pc, storage_q[upd_hit_idx].iter_cur)};
                            end
                        end else begin
                            storage_q[upd_hit_idx].iter_max <=
                                storage_q[upd_hit_idx].iter_cur;
                            storage_q[upd_hit_idx].conf <= '0;
                            storage_q[upd_hit_idx].early_exit_seen <= 1'b0;
                            if (LOOP_IMLI_ENABLE != 0) begin
                                imli_hist_q <=
                                    {imli_hist_q[LOOP_IMLI_HIST_W-LOOP_IMLI_TOKEN_W-1:0],
                                     imli_token(upd_pc, storage_q[upd_hit_idx].iter_cur)};
                            end
                        end
                        storage_q[upd_hit_idx].iter_cur <= '0;
                    end
                end else begin
                    // Allocate only when this looks like a backward
                    // conditional taken branch.
                    if (upd_taken) begin
                        storage_q[repl_idx] <= '{
                            valid:1'b1,
                            tag:  upd_t,
                            pc_sig: upd_sig,
                            path_sig: upd_effective_path_sig,
                            iter_cur: 'd1,
                            iter_max: '0,
                            conf: '0,
                            early_exit_seen: 1'b0,
                            age: '0
                        };
                    end
                end
            end
        end
    end

endmodule : loop_predictor
