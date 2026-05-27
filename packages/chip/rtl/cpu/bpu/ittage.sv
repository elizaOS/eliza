// ittage.sv — ITTAGE indirect-target predictor.
//
// Similar in shape to TAGE: a set of tagged tables, each indexed by a folded
// XOR of PC and the global history. Where TAGE outputs a taken/not-taken
// bit, ITTAGE stores the full target address. On commit, the table whose
// history length is longest among the misses is allocated (replacing an
// entry whose useful counter is zero).
//
// Per-table entry counts and history lengths come from bpu_pkg::ittage_*.
// Storage is set-associative: the entry count is split across ITTAGE_WAYS,
// and the table's index hash truncates to the per-table set count.

`timescale 1ns/1ps

module ittage
    import bpu_pkg::*;
#(
    parameter int unsigned USEFUL_RESET_PERIOD = ITTAGE_USEFUL_RESET_PERIOD
)
(
    input  logic                clk,
    input  logic                rst_n,

    /* verilator lint_off UNUSEDSIGNAL */
    // lkp_valid is part of the external contract but the table lookup is
    // hash-deterministic on lkp_pc + lkp_hist; the consumer gates the result
    // with its own pred_valid signal at the top.
    input  logic                lkp_valid,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] lkp_hist,
    output logic                lkp_hit,
    output logic [VADDR_W-1:0]  lkp_target,
    output logic [ITTAGE_CTR_W-1:0] lkp_ctr,
    output logic [$clog2(ITTAGE_TABLES+1)-1:0] lkp_provider,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic [VADDR_W-1:0]  upd_target,
    input  logic                upd_misp,
    input  logic [$clog2(ITTAGE_TABLES+1)-1:0] upd_provider
);
    localparam int unsigned ITTAGE_ENTRIES_MAX_01 =
        (ITTAGE_ENTRIES_0 > ITTAGE_ENTRIES_1) ? ITTAGE_ENTRIES_0 : ITTAGE_ENTRIES_1;
    localparam int unsigned ITTAGE_ENTRIES_MAX_23 =
        (ITTAGE_ENTRIES_2 > ITTAGE_ENTRIES_3) ? ITTAGE_ENTRIES_2 : ITTAGE_ENTRIES_3;
    localparam int unsigned ITTAGE_ENTRIES_MAX_0123 =
        (ITTAGE_ENTRIES_MAX_01 > ITTAGE_ENTRIES_MAX_23) ?
            ITTAGE_ENTRIES_MAX_01 : ITTAGE_ENTRIES_MAX_23;
    localparam int unsigned ITTAGE_ENTRIES_MAX =
        (ITTAGE_ENTRIES_MAX_0123 > ITTAGE_ENTRIES_4) ?
            ITTAGE_ENTRIES_MAX_0123 : ITTAGE_ENTRIES_4;
    localparam int unsigned ITTAGE_SETS_MAX = ITTAGE_ENTRIES_MAX / ITTAGE_WAYS;
    localparam int unsigned ITT_IDX_W = $clog2(ITTAGE_SETS_MAX);
    localparam int unsigned ITT_WAY_W = $clog2(ITTAGE_WAYS);

    typedef struct packed {
        logic                       valid;
        logic [ITTAGE_TAG_W-1:0]    tag;
        logic [VADDR_W-1:0]         target;
        logic [ITTAGE_CTR_W-1:0]    ctr;
        logic [ITTAGE_USEFUL_W-1:0] useful;
    } ittage_entry_t;

    ittage_entry_t storage_q [ITTAGE_TABLES][ITTAGE_SETS_MAX][ITTAGE_WAYS];
    logic [$clog2(USEFUL_RESET_PERIOD+1)-1:0] useful_reset_ctr_q;

    function automatic logic [ITT_IDX_W-1:0] index_hash(
        input int unsigned tid,
        input logic [VADDR_W-1:0] pc,
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        logic [ITT_IDX_W-1:0] folded_pc;
        logic [ITT_IDX_W-1:0] folded_h;
        integer k;
        int unsigned hl;
        hl = ittage_hist_len(tid);
        folded_pc = '0;
        folded_h  = '0;
        for (k = 0; k < VADDR_W; k++)
            folded_pc[k % ITT_IDX_W] = folded_pc[k % ITT_IDX_W] ^ pc[k];
        for (k = 0; k < int'(hl); k++)
            folded_h[k % ITT_IDX_W] = folded_h[k % ITT_IDX_W] ^
                hist[TAGE_HIST_LEN_MAX-1-k];
        index_hash = (folded_pc ^ folded_h ^ tid[ITT_IDX_W-1:0]) %
                     ITT_IDX_W'(ittage_sets(tid));
    endfunction

    function automatic logic [ITTAGE_TAG_W-1:0] tag_hash(
        input int unsigned tid,
        input logic [VADDR_W-1:0] pc,
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        logic [ITTAGE_TAG_W-1:0] folded_pc;
        logic [ITTAGE_TAG_W-1:0] folded_h;
        integer k;
        int unsigned hl;
        hl = ittage_hist_len(tid);
        folded_pc = '0;
        folded_h  = '0;
        for (k = 0; k < VADDR_W; k++)
            folded_pc[k % ITTAGE_TAG_W] = folded_pc[k % ITTAGE_TAG_W] ^ pc[k];
        for (k = 0; k < int'(hl); k++)
            folded_h[k % ITTAGE_TAG_W] = folded_h[k % ITTAGE_TAG_W] ^
                hist[TAGE_HIST_LEN_MAX-1-k];
        tag_hash = folded_pc ^ {folded_h[ITTAGE_TAG_W-2:0], folded_h[ITTAGE_TAG_W-1]} ^
                   tid[ITTAGE_TAG_W-1:0];
    endfunction

    logic [ITTAGE_TABLES-1:0] tab_hit;
    logic [VADDR_W-1:0]       tab_target [ITTAGE_TABLES];
    logic [ITTAGE_CTR_W-1:0]  tab_ctr [ITTAGE_TABLES];
    /* verilator lint_off UNUSEDSIGNAL */
    logic [ITTAGE_USEFUL_W-1:0] tab_useful [ITTAGE_TABLES];
    /* verilator lint_on UNUSEDSIGNAL */

    always_comb begin
        for (int unsigned ti = 0; ti < ITTAGE_TABLES; ti++) begin
            automatic logic [ITT_IDX_W-1:0] idx = index_hash(ti, lkp_pc, lkp_hist);
            automatic logic [ITTAGE_TAG_W-1:0] tag = tag_hash(ti, lkp_pc, lkp_hist);
            tab_hit[ti]    = 1'b0;
            tab_target[ti] = '0;
            tab_ctr[ti]    = '0;
            tab_useful[ti] = '0;
            for (int unsigned way = 0; way < ITTAGE_WAYS; way++) begin
                if (!tab_hit[ti] &&
                    storage_q[ti][idx][way].valid &&
                    (storage_q[ti][idx][way].tag == tag)) begin
                    tab_hit[ti]    = 1'b1;
                    tab_target[ti] = storage_q[ti][idx][way].target;
                    tab_ctr[ti]    = storage_q[ti][idx][way].ctr;
                    tab_useful[ti] = storage_q[ti][idx][way].useful;
                end
            end
        end
    end

    // Longest hitting table wins.
    always_comb begin
        lkp_hit      = 1'b0;
        lkp_target   = '0;
        lkp_ctr      = '0;
        lkp_provider = '0;
        for (int ti = ITTAGE_TABLES-1; ti >= 0; ti--) begin
            if (tab_hit[ti] && !lkp_hit) begin
                lkp_hit      = 1'b1;
                lkp_target   = tab_target[ti];
                lkp_ctr      = tab_ctr[ti];
                lkp_provider = ti[$clog2(ITTAGE_TABLES+1)-1:0] + 1;
            end
        end
    end

    // -----------------------------------------------------------------------
    // Update path
    // -----------------------------------------------------------------------
    // Allocates at most one table entry per misprediction, matching the
    // software branch-predictor model's first-empty-table policy.
    logic [ITT_IDX_W-1:0]     upd_idx_per_tab [ITTAGE_TABLES];
    logic [ITTAGE_TAG_W-1:0]  upd_tag_per_tab [ITTAGE_TABLES];
    logic [ITTAGE_TABLES-1:0] alloc_invalid_candidate;
    logic [ITTAGE_TABLES-1:0] alloc_useful0_candidate;
    logic [ITTAGE_TABLES-1:0] alloc_grant;
    logic [ITT_WAY_W-1:0]     upd_match_way_per_tab [ITTAGE_TABLES];
    logic [ITTAGE_TABLES-1:0] upd_match_per_tab;
    logic [ITT_WAY_W-1:0]     alloc_invalid_way [ITTAGE_TABLES];
    logic [ITT_WAY_W-1:0]     alloc_useful0_way [ITTAGE_TABLES];
    logic [ITT_WAY_W-1:0]     alloc_way [ITTAGE_TABLES];
    int unsigned              upd_prov;

    always_comb begin
        upd_prov = {{(32-$bits(upd_provider)){1'b0}}, upd_provider};
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            upd_idx_per_tab[t] = index_hash(t, upd_pc, upd_hist);
            upd_tag_per_tab[t] = tag_hash(t, upd_pc, upd_hist);
            upd_match_per_tab[t] = 1'b0;
            upd_match_way_per_tab[t] = '0;
            alloc_invalid_way[t] = '0;
            alloc_useful0_way[t] = '0;
            alloc_way[t] = '0;
            for (int unsigned way = 0; way < ITTAGE_WAYS; way++) begin
                if (!upd_match_per_tab[t] &&
                    storage_q[t][upd_idx_per_tab[t]][way].valid &&
                    (storage_q[t][upd_idx_per_tab[t]][way].tag == upd_tag_per_tab[t])) begin
                    upd_match_per_tab[t] = 1'b1;
                    upd_match_way_per_tab[t] = way[ITT_WAY_W-1:0];
                end
            end
        end
        // Build per-table allocation eligibility. Prefer invalid slots, then
        // occupied slots whose useful counter has aged to zero; this matches
        // the software model and prevents indirect-target allocation
        // starvation under alias pressure.
        alloc_invalid_candidate = '0;
        alloc_useful0_candidate = '0;
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            if (t >= upd_prov) begin
                for (int unsigned way = 0; way < ITTAGE_WAYS; way++) begin
                    if (!alloc_invalid_candidate[t] &&
                        !storage_q[t][upd_idx_per_tab[t]][way].valid) begin
                        alloc_invalid_candidate[t] = 1'b1;
                        alloc_invalid_way[t] = way[ITT_WAY_W-1:0];
                    end
                    if (!alloc_useful0_candidate[t] &&
                        (storage_q[t][upd_idx_per_tab[t]][way].useful == '0)) begin
                        alloc_useful0_candidate[t] = 1'b1;
                        alloc_useful0_way[t] = way[ITT_WAY_W-1:0];
                    end
                end
            end
        end
        // Priority encoder: grant the lowest-index candidate that is
        // eligible and serialize allocation to a single table per
        // misprediction.
        alloc_grant = '0;
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            if (alloc_invalid_candidate[t] && (alloc_grant == '0)) begin
                alloc_grant[t] = 1'b1;
                alloc_way[t] = alloc_invalid_way[t];
            end
        end
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            if (alloc_useful0_candidate[t] && (alloc_grant == '0)) begin
                alloc_grant[t] = 1'b1;
                alloc_way[t] = alloc_useful0_way[t];
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            /* verilator lint_off BLKSEQ */
            for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
                for (int unsigned i = 0; i < ITTAGE_SETS_MAX; i++) begin
                    for (int unsigned way = 0; way < ITTAGE_WAYS; way++) begin
                        storage_q[t][i][way].valid  = 1'b0;
                        storage_q[t][i][way].tag    = '0;
                        storage_q[t][i][way].target = '0;
                        storage_q[t][i][way].ctr    = '0;
                        storage_q[t][i][way].useful = '0;
                    end
                end
            end
            /* verilator lint_on BLKSEQ */
            useful_reset_ctr_q <= '0;
        end else if (upd_valid) begin
            if (useful_reset_ctr_q == $bits(useful_reset_ctr_q)'(USEFUL_RESET_PERIOD - 1)) begin
                useful_reset_ctr_q <= '0;
                /* verilator lint_off BLKSEQ */
                for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
                    for (int unsigned i = 0; i < ITTAGE_SETS_MAX; i++) begin
                        for (int unsigned way = 0; way < ITTAGE_WAYS; way++) begin
                            if (storage_q[t][i][way].useful != '0)
                                storage_q[t][i][way].useful =
                                    storage_q[t][i][way].useful - 1'b1;
                        end
                    end
                end
                /* verilator lint_on BLKSEQ */
            end else begin
                useful_reset_ctr_q <= useful_reset_ctr_q + 1'b1;
            end
            // For the provider, refresh confidence and update target if the
            // observed target matches; if it disagrees the counter is
            // decremented and on saturation the table is invalidated so the
            // allocator can try a longer-history table.
            for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
                automatic logic [ITT_IDX_W-1:0]    idx = upd_idx_per_tab[t];
                automatic logic [ITTAGE_TAG_W-1:0] tag = upd_tag_per_tab[t];
                automatic logic [ITT_WAY_W-1:0]    way = upd_match_way_per_tab[t];
                if (upd_prov == t + 1) begin
                    if (upd_match_per_tab[t]) begin
                        if (storage_q[t][idx][way].target == upd_target) begin
                            if (storage_q[t][idx][way].ctr != {ITTAGE_CTR_W{1'b1}})
                                storage_q[t][idx][way].ctr <=
                                    storage_q[t][idx][way].ctr + 1'b1;
                            if (storage_q[t][idx][way].useful != {ITTAGE_USEFUL_W{1'b1}})
                                storage_q[t][idx][way].useful <=
                                    storage_q[t][idx][way].useful + 1'b1;
                        end else if ((upd_prov >= ITTAGE_REPLACE_MIN_PROVIDER) &&
                                     (storage_q[t][idx][way].ctr <=
                                      ITTAGE_CTR_W'(ITTAGE_REPLACE_WEAK_CTR))) begin
                            storage_q[t][idx][way].target <= upd_target;
                            storage_q[t][idx][way].ctr    <= {1'b1, {(ITTAGE_CTR_W-1){1'b0}}};
                            storage_q[t][idx][way].useful <= '0;
                        end else begin
                            if (storage_q[t][idx][way].ctr == '0)
                                storage_q[t][idx][way].valid <= 1'b0;
                            else begin
                                storage_q[t][idx][way].ctr <= storage_q[t][idx][way].ctr - 1'b1;
                                if (storage_q[t][idx][way].useful != '0)
                                    storage_q[t][idx][way].useful <=
                                        storage_q[t][idx][way].useful - 1'b1;
                            end
                        end
                    end
                end
                // Single-shot allocation on misprediction.
                if (upd_misp && alloc_grant[t]) begin
                    storage_q[t][idx][alloc_way[t]].valid  <= 1'b1;
                    storage_q[t][idx][alloc_way[t]].tag    <= tag;
                    storage_q[t][idx][alloc_way[t]].target <= upd_target;
                    storage_q[t][idx][alloc_way[t]].ctr    <= {1'b1, {(ITTAGE_CTR_W-1){1'b0}}};
                    storage_q[t][idx][alloc_way[t]].useful <= '0;
                end
            end
        end
    end

endmodule : ittage
