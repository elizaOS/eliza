// tage_table.sv — single tagged TAGE table.
//
// Each entry has a tag, a TAGE_CTR_W-bit signed-magnitude saturating
// direction counter (split into msb=sign and lower=magnitude), and a
// TAGE_USEFUL_W-bit useful field. The table is indexed by a folded XOR of
// PC and the global history register, with a parallel tag hash. This is the
// Seznec/TAGE-SC-L primitive at simulator scale.
//
// Useful-bit periodic reset is handled here: the entire table's useful field
// is decremented by one when the reset strobe is asserted. The PMU exposes
// allocations through `pmu_alloc`.

`timescale 1ns/1ps

module tage_table
    import bpu_pkg::*;
#(
    parameter int unsigned TABLE_ID   = 0,
    parameter int unsigned ENTRIES    = TAGE_ENTRIES_TABLE,
    parameter int unsigned HIST_LEN   = 8
)(
    input  logic                clk,
    input  logic                rst_n,

    // Lookup
    /* verilator lint_off UNUSEDSIGNAL */
    // Lookup is a pure SRAM read on hashed (lkp_pc, lkp_hist). The consumer
    // (tage.sv) gates the produced hit with its own valid bit.
    input  logic                lkp_valid,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  logic [HIST_LEN-1:0] lkp_hist,
    output logic                lkp_hit,
    output logic                lkp_taken,
    output logic [TAGE_CTR_W-1:0] lkp_ctr,
    output logic [TAGE_USEFUL_W-1:0] lkp_useful,

    // Update on commit. `upd_alloc` only allocates when the table missed and
    // the upper-table allocation policy chose this table.
    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  logic [HIST_LEN-1:0] upd_hist,
    input  logic                upd_taken,
    /* verilator lint_off UNUSEDSIGNAL */
    // upd_correct is part of the API for completeness with Seznec-style TAGE
    // training; the current implementation derives the counter update from
    // upd_taken alone and exposes useful tracking via upd_useful_*.
    input  logic                upd_correct,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic                upd_alloc,
    input  logic                upd_useful_inc,
    input  logic                upd_useful_dec,
    output logic                upd_hit_o,
    output logic                upd_taken_o,
    output logic [TAGE_CTR_W-1:0] upd_ctr_o,
    output logic [TAGE_USEFUL_W-1:0] upd_useful_o,

    input  logic                useful_reset_lsb,
    input  logic                useful_reset_msb,

    output logic                pmu_alloc
);

    localparam int unsigned IDX_W = $clog2(ENTRIES);

    typedef struct packed {
        logic                       valid;
        logic [TAGE_TAG_W-1:0]      tag;
        logic [TAGE_CTR_W-1:0]      ctr;
        logic [TAGE_USEFUL_W-1:0]   useful;
    } tage_entry_t;

    tage_entry_t storage_q [ENTRIES];
    tage_entry_t storage_d [ENTRIES];
    logic        pmu_alloc_d;

    // Index hash: fold PC and history together. Verilog does not have a
    // built-in modulo on wide vectors; XOR-fold both operands into IDX_W
    // bits and combine.
    function automatic logic [IDX_W-1:0] index_hash(
        input logic [VADDR_W-1:0] pc,
        input logic [HIST_LEN-1:0] hist
    );
        logic [IDX_W-1:0] folded_pc;
        logic [IDX_W-1:0] folded_h;
        integer k;
        folded_pc = '0;
        folded_h  = '0;
        for (k = 0; k < VADDR_W; k++) begin
            folded_pc[k % IDX_W] = folded_pc[k % IDX_W] ^ pc[k];
        end
        for (k = 0; k < HIST_LEN; k++) begin
            folded_h[k % IDX_W] = folded_h[k % IDX_W] ^ hist[k];
        end
        index_hash = folded_pc ^ folded_h ^ TABLE_ID[IDX_W-1:0];
    endfunction

    function automatic logic [TAGE_TAG_W-1:0] tag_hash(
        input logic [VADDR_W-1:0] pc,
        input logic [HIST_LEN-1:0] hist
    );
        logic [TAGE_TAG_W-1:0] folded_pc;
        logic [TAGE_TAG_W-1:0] folded_h;
        integer k;
        folded_pc = '0;
        folded_h  = '0;
        for (k = 0; k < VADDR_W; k++) begin
            folded_pc[k % TAGE_TAG_W] = folded_pc[k % TAGE_TAG_W] ^ pc[k];
        end
        for (k = 0; k < HIST_LEN; k++) begin
            folded_h[k % TAGE_TAG_W] = folded_h[k % TAGE_TAG_W] ^ hist[k];
        end
        tag_hash = folded_pc ^ {folded_h[TAGE_TAG_W-2:0], folded_h[TAGE_TAG_W-1]} ^
                   TABLE_ID[TAGE_TAG_W-1:0];
    endfunction

    logic [IDX_W-1:0]      lkp_i;
    logic [TAGE_TAG_W-1:0] lkp_t;
    always_comb begin
        lkp_i      = index_hash(lkp_pc, lkp_hist);
        lkp_t      = tag_hash(lkp_pc, lkp_hist);
        lkp_hit    = storage_q[lkp_i].valid && (storage_q[lkp_i].tag == lkp_t);
        lkp_ctr    = storage_q[lkp_i].ctr;
        lkp_useful = storage_q[lkp_i].useful;
        // The MSB of the centered counter encodes direction. Counter
        // representation: 0=strongly-not-taken … 2^N-1=strongly-taken.
        lkp_taken  = storage_q[lkp_i].ctr[TAGE_CTR_W-1];
    end

    logic [IDX_W-1:0]      upd_i;
    logic [TAGE_TAG_W-1:0] upd_t;
    /* verilator lint_off UNUSEDSIGNAL */
    logic                  upd_hit;
    /* verilator lint_on UNUSEDSIGNAL */

    always_comb begin
        upd_i = index_hash(upd_pc, upd_hist);
        upd_t = tag_hash(upd_pc, upd_hist);
        upd_hit = storage_q[upd_i].valid && (storage_q[upd_i].tag == upd_t);
        upd_hit_o = upd_hit;
        upd_ctr_o = storage_q[upd_i].ctr;
        upd_useful_o = storage_q[upd_i].useful;
        upd_taken_o = storage_q[upd_i].ctr[TAGE_CTR_W-1];
    end

    always_comb begin
        storage_d = storage_q;
        pmu_alloc_d = 1'b0;

        // Periodic useful-bit reset: alternates MSB/LSB to slowly age out
        // entries that have not proven useful since last reset.
        if (useful_reset_lsb || useful_reset_msb) begin
            for (int unsigned e = 0; e < ENTRIES; e++) begin
                if (useful_reset_msb && storage_d[e].useful != '0)
                    storage_d[e].useful[TAGE_USEFUL_W-1] = 1'b0;
                if (useful_reset_lsb && storage_d[e].useful != '0)
                    storage_d[e].useful[0] = 1'b0;
            end
        end

        if (upd_valid) begin
            if (upd_hit) begin
                // Update the direction counter toward the actual outcome.
                if (upd_taken && storage_q[upd_i].ctr != {TAGE_CTR_W{1'b1}})
                    storage_d[upd_i].ctr = storage_q[upd_i].ctr + 1'b1;
                else if (!upd_taken && storage_q[upd_i].ctr != '0)
                    storage_d[upd_i].ctr = storage_q[upd_i].ctr - 1'b1;

                // Useful field saturates upward when correct and the lower
                // table was wrong; saturates downward on the periodic reset
                // path above.
                if (upd_useful_inc && storage_q[upd_i].useful != {TAGE_USEFUL_W{1'b1}})
                    storage_d[upd_i].useful = storage_q[upd_i].useful + 1'b1;
                else if (upd_useful_dec && storage_q[upd_i].useful != '0)
                    storage_d[upd_i].useful = storage_q[upd_i].useful - 1'b1;
            end else if (upd_alloc) begin
                // Allocation policy is owned by the TAGE top, which only
                // raises `upd_alloc` when this table is the chosen one and
                // a victim (useful==0) was identified by the read path.
                if (storage_q[upd_i].useful == '0 || !storage_q[upd_i].valid) begin
                    storage_d[upd_i] = '{
                        valid: 1'b1,
                        tag:   upd_t,
                        ctr:   upd_taken
                            ? {1'b1, {(TAGE_CTR_W-1){1'b0}}}
                            : {1'b0, {(TAGE_CTR_W-1){1'b1}}},
                        useful:'0
                    };
                    pmu_alloc_d = 1'b1;
                end
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            storage_q <= '{default: '{
                valid:  1'b0,
                tag:    '0,
                ctr:    {1'b0, {(TAGE_CTR_W-1){1'b1}}},
                useful: '0
            }};
            pmu_alloc <= 1'b0;
        end else begin
            storage_q <= storage_d;
            pmu_alloc <= pmu_alloc_d;
        end
    end

endmodule : tage_table
