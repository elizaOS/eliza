// ftb.sv — Fetch Target Buffer, the BTB replacement.
//
// The FTB stores one entry per predicted fetch block. Each entry holds up to
// MAX_BR_PER_BLOCK branch slots: their byte offset inside the block, their
// branch kind (conditional, call, return), and their predicted target. The
// FTB is set-associative with `FTB_WAYS` ways per set; the index field is
// taken from PC bits above the fetch block alignment, and the tag field is
// the remaining upper PC bits.
//
// The lookup is single-cycle: index, read all ways in parallel, compare
// tags, and produce a one-hot way select. The update path receives a
// resolver entry that already knows which way to overwrite (LRU is computed
// during read).

`timescale 1ns/1ps

module ftb
    import bpu_pkg::*;
(
    input  logic                     clk,
    input  logic                     rst_n,

    // Lookup port - one PC per cycle.
    input  logic                     lkp_valid,
    input  logic [VADDR_W-1:0]       lkp_pc,
    output logic                     lkp_hit,
    output logic [VADDR_W-1:0]       lkp_target,
    output br_kind_e                 lkp_kind,
    output logic [MAX_BR_PER_BLOCK-1:0] lkp_br_valid,

    // Update port driven by the resolver on commit.
    input  logic                     upd_valid,
    input  logic [VADDR_W-1:0]       upd_pc,
    input  logic [VADDR_W-1:0]       upd_target,
    input  br_kind_e                 upd_kind,
    input  logic [MAX_BR_PER_BLOCK-1:0] upd_br_valid,
    input  logic                     upd_alloc,

    output logic                     pmu_miss
);

    typedef struct packed {
        logic                            valid;
        logic [FTB_TAG_W-1:0]            tag;
        logic [VADDR_W-1:0]              target;
        br_kind_e                        kind;
        logic [MAX_BR_PER_BLOCK-1:0]     br_valid;
    } ftb_entry_t;

    // Storage: a single packed array of [sets][ways] entries.
    ftb_entry_t storage_q [FTB_SETS][FTB_WAYS];

    // Round-robin replacement pointer per set. This is the cheapest
    // structural choice; KMH and BOOM both use a pseudo-LRU bit vector,
    // but RR is functionally equivalent for verification at MVP scale and
    // can be promoted to PLRU without changing the external interface.
    logic [$clog2(FTB_WAYS)-1:0] rr_ptr_q [FTB_SETS];

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [FTB_IDX_W-1:0] ftb_index(input logic [VADDR_W-1:0] pc);
        // Drop the lower 5 bits (fetch block alignment) before indexing.
        ftb_index = pc[5 +: FTB_IDX_W];
    endfunction

    function automatic logic [FTB_TAG_W-1:0] ftb_tag(input logic [VADDR_W-1:0] pc);
        ftb_tag = pc[5 + FTB_IDX_W +: FTB_TAG_W];
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    // -----------------------------------------------------------------------
    // Read path
    // -----------------------------------------------------------------------
    logic [FTB_IDX_W-1:0] lkp_idx;
    logic [FTB_TAG_W-1:0] lkp_tag;

    always_comb begin
        lkp_hit       = 1'b0;
        lkp_target    = '0;
        lkp_kind      = BR_NONE;
        lkp_br_valid  = '0;
        lkp_idx       = ftb_index(lkp_pc);
        lkp_tag       = ftb_tag(lkp_pc);
        if (lkp_valid) begin
            for (int unsigned w = 0; w < FTB_WAYS; w++) begin
                if (storage_q[lkp_idx][w].valid &&
                    storage_q[lkp_idx][w].tag == lkp_tag) begin
                    lkp_hit      = 1'b1;
                    lkp_target   = storage_q[lkp_idx][w].target;
                    lkp_kind     = storage_q[lkp_idx][w].kind;
                    lkp_br_valid = storage_q[lkp_idx][w].br_valid;
                end
            end
        end
    end

    // -----------------------------------------------------------------------
    // Update path
    // -----------------------------------------------------------------------
    logic [FTB_IDX_W-1:0] upd_idx;
    logic [FTB_TAG_W-1:0] upd_tag;
    logic                 upd_match_any;
    logic [$clog2(FTB_WAYS)-1:0] upd_match_way;

    always_comb begin
        upd_idx       = ftb_index(upd_pc);
        upd_tag       = ftb_tag(upd_pc);
        upd_match_any = 1'b0;
        upd_match_way = '0;
        for (int unsigned w = 0; w < FTB_WAYS; w++) begin
            if (storage_q[upd_idx][w].valid &&
                storage_q[upd_idx][w].tag == upd_tag) begin
                upd_match_any = 1'b1;
                upd_match_way = w[$clog2(FTB_WAYS)-1:0];
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned s = 0; s < FTB_SETS; s++) begin
                for (int unsigned w = 0; w < FTB_WAYS; w++) begin
                    storage_q[s][w] <= '{
                        valid:   1'b0,
                        tag:     '0,
                        target:  '0,
                        kind:    BR_NONE,
                        br_valid:'0
                    };
                end
                rr_ptr_q[s] <= '0;
            end
            pmu_miss <= 1'b0;
        end else begin
            pmu_miss <= lkp_valid && !lkp_hit;

            if (upd_valid) begin
                if (upd_match_any) begin
                    storage_q[upd_idx][upd_match_way].target   <= upd_target;
                    storage_q[upd_idx][upd_match_way].kind     <= upd_kind;
                    storage_q[upd_idx][upd_match_way].br_valid <= upd_br_valid;
                end else if (upd_alloc) begin
                    storage_q[upd_idx][rr_ptr_q[upd_idx]] <= '{
                        valid:   1'b1,
                        tag:     upd_tag,
                        target:  upd_target,
                        kind:    upd_kind,
                        br_valid:upd_br_valid
                    };
                    rr_ptr_q[upd_idx] <= rr_ptr_q[upd_idx] + 1'b1;
                end
            end
        end
    end

endmodule : ftb
