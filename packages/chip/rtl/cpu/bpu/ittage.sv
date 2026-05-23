// ittage.sv — ITTAGE indirect-target predictor.
//
// Similar in shape to TAGE: a set of tagged tables, each indexed by a folded
// XOR of PC and the global history. Where TAGE outputs a taken/not-taken
// bit, ITTAGE stores the full target address. On commit, the table whose
// history length is longest among the misses is allocated (replacing an
// entry whose useful counter is zero).
//
// Per-table entry counts and history lengths come from bpu_pkg::ittage_*.
// To keep the synthesisable generate-loop simple, the maximum entry count
// across tables (`ITTAGE_ENTRIES_MAX`) is used for every table's storage and
// the table's index hash truncates to its actual size.

`timescale 1ns/1ps

module ittage
    import bpu_pkg::*;
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
    output logic [$clog2(ITTAGE_TABLES+1)-1:0] lkp_provider,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [TAGE_HIST_LEN_MAX-1:0] upd_hist,
    input  logic [VADDR_W-1:0]  upd_target,
    input  logic                upd_misp,
    input  logic [$clog2(ITTAGE_TABLES+1)-1:0] upd_provider
);
    localparam int unsigned ITTAGE_ENTRIES_MAX = 1024;
    localparam int unsigned ITT_IDX_W = $clog2(ITTAGE_ENTRIES_MAX);

    typedef struct packed {
        logic                       valid;
        logic [ITTAGE_TAG_W-1:0]    tag;
        logic [VADDR_W-1:0]         target;
        logic [ITTAGE_CTR_W-1:0]    ctr;
        logic [ITTAGE_USEFUL_W-1:0] useful;
    } ittage_entry_t;

    ittage_entry_t storage_q [ITTAGE_TABLES][ITTAGE_ENTRIES_MAX];

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
                     ITT_IDX_W'(ittage_entries(tid));
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
    /* verilator lint_off UNUSEDSIGNAL */
    logic [ITTAGE_USEFUL_W-1:0] tab_useful [ITTAGE_TABLES];
    /* verilator lint_on UNUSEDSIGNAL */

    always_comb begin
        for (int unsigned ti = 0; ti < ITTAGE_TABLES; ti++) begin
            automatic logic [ITT_IDX_W-1:0] idx = index_hash(ti, lkp_pc, lkp_hist);
            automatic logic [ITTAGE_TAG_W-1:0] tag = tag_hash(ti, lkp_pc, lkp_hist);
            tab_hit[ti]    = storage_q[ti][idx].valid && (storage_q[ti][idx].tag == tag);
            tab_target[ti] = storage_q[ti][idx].target;
            tab_useful[ti] = storage_q[ti][idx].useful;
        end
    end

    // Longest hitting table wins.
    always_comb begin
        lkp_hit      = 1'b0;
        lkp_target   = '0;
        lkp_provider = '0;
        for (int ti = ITTAGE_TABLES-1; ti >= 0; ti--) begin
            if (tab_hit[ti] && !lkp_hit) begin
                lkp_hit      = 1'b1;
                lkp_target   = tab_target[ti];
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
    logic [ITTAGE_TABLES-1:0] alloc_candidate;
    logic [ITTAGE_TABLES-1:0] alloc_grant;
    int unsigned              upd_prov;

    always_comb begin
        upd_prov = {{(32-$bits(upd_provider)){1'b0}}, upd_provider};
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            upd_idx_per_tab[t] = index_hash(t, upd_pc, upd_hist);
            upd_tag_per_tab[t] = tag_hash(t, upd_pc, upd_hist);
        end
        // Build per-table allocation eligibility. Only an empty slot in a
        // table whose rank is >= upd_prov qualifies; the model uses the
        // same gate (`idx not in self.storage[higher]`).
        alloc_candidate = '0;
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            if (t >= upd_prov &&
                !storage_q[t][upd_idx_per_tab[t]].valid) begin
                alloc_candidate[t] = 1'b1;
            end
        end
        // Priority encoder: grant the lowest-index candidate that is
        // eligible. This matches the model's "first empty wins" policy
        // and serializes allocation to a single table per misprediction.
        alloc_grant = '0;
        for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
            if (alloc_candidate[t] && (alloc_grant == '0)) begin
                alloc_grant[t] = 1'b1;
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            storage_q <= '{default: '{default: '{
                valid:  1'b0,
                tag:    '0,
                target: '0,
                ctr:    '0,
                useful: '0
            }}};
        end else if (upd_valid) begin
            // For the provider, refresh confidence and update target if the
            // observed target matches; if it disagrees the counter is
            // decremented and on saturation the table is invalidated so the
            // allocator can try a longer-history table.
            for (int unsigned t = 0; t < ITTAGE_TABLES; t++) begin
                automatic logic [ITT_IDX_W-1:0]    idx = upd_idx_per_tab[t];
                automatic logic [ITTAGE_TAG_W-1:0] tag = upd_tag_per_tab[t];
                if (upd_prov == t + 1) begin
                    if (storage_q[t][idx].valid && storage_q[t][idx].tag == tag) begin
                        if (storage_q[t][idx].target == upd_target) begin
                            if (storage_q[t][idx].ctr != {ITTAGE_CTR_W{1'b1}})
                                storage_q[t][idx].ctr <= storage_q[t][idx].ctr + 1'b1;
                            if (storage_q[t][idx].useful != {ITTAGE_USEFUL_W{1'b1}})
                                storage_q[t][idx].useful <= storage_q[t][idx].useful + 1'b1;
                        end else begin
                            if (storage_q[t][idx].ctr == '0)
                                storage_q[t][idx].valid <= 1'b0;
                            else
                                storage_q[t][idx].ctr <= storage_q[t][idx].ctr - 1'b1;
                        end
                    end
                end
                // Single-shot allocation on misprediction.
                if (upd_misp && alloc_grant[t]) begin
                    storage_q[t][idx] <= '{
                        valid:  1'b1,
                        tag:    tag,
                        target: upd_target,
                        ctr:    {1'b1, {(ITTAGE_CTR_W-1){1'b0}}},
                        useful: '0
                    };
                end
            end
        end
    end

endmodule : ittage
