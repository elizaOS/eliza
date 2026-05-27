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
    input  bpu_context_t        lkp_context,
    output logic                lkp_hit,
    output logic [VADDR_W-1:0]  lkp_next_pc,
    output logic [VADDR_W-1:0]  lkp_fall_through_pc,
    output br_kind_e            lkp_kind,
    output logic [FTB_TARGET_CONF_W-1:0] lkp_conf,

    input  logic                upd_valid,
    input  logic [VADDR_W-1:0]  upd_pc,
    input  bpu_context_t        upd_context,
    input  logic [VADDR_W-1:0]  upd_next_pc,
    input  logic [VADDR_W-1:0]  upd_fall_through_pc,
    input  br_kind_e            upd_kind,

    input  logic                flush_valid,
    input  logic                flush_context_valid,
    input  bpu_context_t        flush_context,

    input  logic                test_corrupt_parity_valid,
    input  logic [UFTB_IDX_W-1:0] test_corrupt_parity_idx,
    input  logic [$clog2(UFTB_WAYS)-1:0] test_corrupt_parity_way,

    output logic                pmu_hit
);

    typedef struct packed {
        logic                       valid;
        logic                       parity;
        bpu_context_t               ctx;
        logic [UFTB_TAG_W-1:0]      tag;
        logic [VADDR_W-1:0]         next_pc;
        logic [VADDR_W-1:0]         fall_through_pc;
        br_kind_e                   kind;
        logic [FTB_TARGET_CONF_W-1:0] conf;
        logic [3:0]                 age;
    } uftb_entry_t;

    uftb_entry_t storage_q [UFTB_SETS][UFTB_WAYS];

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic uftb_payload_parity(input uftb_entry_t entry);
        uftb_payload_parity = ^{
            entry.ctx,
            entry.tag,
            entry.next_pc,
            entry.fall_through_pc,
            entry.kind,
            entry.conf
        };
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    /* verilator lint_off UNUSEDSIGNAL */
    // Match the FTB and top-level predictor contract: lookup happens at the
    // fetch-block PC, while updates arrive at the resolved branch PC. Dropping
    // the full fetch-block offset lets a nonzero-offset branch train the same
    // uFTB entry that the next block lookup will consult.
    function automatic logic [UFTB_IDX_W-1:0] uftb_idx_for_context(
        input logic [VADDR_W-1:0] pc,
        input bpu_context_t ctx
    );
        logic [BPU_CONTEXT_HASH_W-1:0] ctx_hash;
        logic [UFTB_IDX_W-1:0] ctx_idx;
        ctx_hash = bpu_context_hash(ctx);
        ctx_idx = '0;
        for (int unsigned i = 0; i < UFTB_IDX_W; i++) begin
            ctx_idx[i] = ctx_hash[i % BPU_CONTEXT_HASH_W];
        end
        uftb_idx_for_context = pc[FETCH_BLOCK_OFF_W +: UFTB_IDX_W] ^ ctx_idx;
    endfunction

    function automatic logic [UFTB_TAG_W-1:0] uftb_tag_for_context(
        input logic [VADDR_W-1:0] pc,
        input bpu_context_t ctx
    );
        logic [BPU_CONTEXT_HASH_W-1:0] ctx_hash;
        logic [UFTB_TAG_W-1:0] ctx_tag;
        ctx_hash = bpu_context_hash(ctx);
        ctx_tag = '0;
        for (int unsigned i = 0; i < UFTB_TAG_W; i++) begin
            ctx_tag[i] = ctx_hash[(i + UFTB_IDX_W) % BPU_CONTEXT_HASH_W];
        end
        uftb_tag_for_context =
            pc[FETCH_BLOCK_OFF_W + UFTB_IDX_W +: UFTB_TAG_W] ^ ctx_tag;
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    logic [UFTB_IDX_W-1:0] lkp_i;
    logic [UFTB_TAG_W-1:0] lkp_t;
    logic [$clog2(UFTB_WAYS)-1:0] lkp_way;
    logic [$clog2(UFTB_WAYS)-1:0] lkp_corrupt_way;
    logic lkp_corrupt_hit;
    logic entry_parity_ok;
    always_comb begin
        lkp_i       = uftb_idx_for_context(lkp_pc, lkp_context);
        lkp_t       = uftb_tag_for_context(lkp_pc, lkp_context);
        lkp_hit     = 1'b0;
        lkp_next_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
        lkp_fall_through_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
        lkp_kind    = BR_NONE;
        lkp_conf    = '0;
        lkp_way     = '0;
        lkp_corrupt_way = '0;
        lkp_corrupt_hit = 1'b0;
        entry_parity_ok = 1'b0;
        if (lkp_valid && !flush_valid) begin
            for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                entry_parity_ok =
                    storage_q[lkp_i][w].parity ==
                    uftb_payload_parity(storage_q[lkp_i][w]);
                if (storage_q[lkp_i][w].valid &&
                    storage_q[lkp_i][w].ctx == lkp_context &&
                    storage_q[lkp_i][w].tag == lkp_t &&
                    !entry_parity_ok) begin
                    lkp_corrupt_hit = 1'b1;
                    lkp_corrupt_way = w[$clog2(UFTB_WAYS)-1:0];
                end
                if (storage_q[lkp_i][w].valid &&
                    entry_parity_ok &&
                    storage_q[lkp_i][w].ctx == lkp_context &&
                    storage_q[lkp_i][w].tag == lkp_t) begin
                    lkp_hit     = 1'b1;
                    lkp_next_pc = storage_q[lkp_i][w].next_pc;
                    lkp_fall_through_pc = storage_q[lkp_i][w].fall_through_pc;
                    lkp_kind = storage_q[lkp_i][w].kind;
                    lkp_conf = storage_q[lkp_i][w].conf;
                    lkp_way = w[$clog2(UFTB_WAYS)-1:0];
                end
            end
            if (upd_valid &&
                lkp_i == upd_i &&
                lkp_t == upd_t &&
                lkp_context == upd_context) begin
                lkp_hit = 1'b1;
                lkp_next_pc = upd_match_any ?
                    upd_next_entry.next_pc : alloc_entry.next_pc;
                lkp_fall_through_pc = upd_match_any ?
                    upd_next_entry.fall_through_pc :
                    alloc_entry.fall_through_pc;
                lkp_kind = upd_match_any ? upd_next_entry.kind : alloc_entry.kind;
                lkp_conf = upd_match_any ? upd_next_entry.conf : alloc_entry.conf;
                lkp_way = upd_match_any ? upd_match_way : repl_way;
            end
        end
    end

    logic [UFTB_IDX_W-1:0] upd_i;
    logic [UFTB_TAG_W-1:0] upd_t;
    logic                  upd_match_any;
    logic [$clog2(UFTB_WAYS)-1:0] upd_match_way;
    logic [$clog2(UFTB_WAYS)-1:0] repl_way;
    logic [4:0] repl_score;
    logic [4:0] cand_score;
    uftb_entry_t upd_next_entry;
    uftb_entry_t alloc_entry;
    always_comb begin
        upd_i         = uftb_idx_for_context(upd_pc, upd_context);
        upd_t         = uftb_tag_for_context(upd_pc, upd_context);
        upd_match_any = 1'b0;
        upd_match_way = '0;
        repl_way      = '0;
        repl_score    = '0;
        upd_next_entry = '0;
        alloc_entry = '{
            valid:1'b1,
            parity:1'b0,
            ctx:upd_context,
            tag:upd_t,
            next_pc:upd_next_pc,
            fall_through_pc:upd_fall_through_pc,
            kind:upd_kind,
            conf:FTB_TARGET_CONF_W'(1),
            age:'0
        };
        alloc_entry.parity = uftb_payload_parity(alloc_entry);
        for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
            if (storage_q[upd_i][w].valid &&
                storage_q[upd_i][w].parity ==
                    uftb_payload_parity(storage_q[upd_i][w]) &&
                storage_q[upd_i][w].ctx == upd_context &&
                storage_q[upd_i][w].tag == upd_t) begin
                upd_match_any = 1'b1;
                upd_match_way = w[$clog2(UFTB_WAYS)-1:0];
            end
            cand_score = storage_q[upd_i][w].valid ?
                {1'b0, storage_q[upd_i][w].age} : 5'h1f;
            if (cand_score >= repl_score) begin
                repl_score = cand_score;
                repl_way = w[$clog2(UFTB_WAYS)-1:0];
            end
        end
        if (upd_match_any) begin
            upd_next_entry = storage_q[upd_i][upd_match_way];
            upd_next_entry.next_pc = upd_next_pc;
            upd_next_entry.fall_through_pc = upd_fall_through_pc;
            upd_next_entry.kind = upd_kind;
            upd_next_entry.age = '0;
            if (storage_q[upd_i][upd_match_way].next_pc == upd_next_pc &&
                storage_q[upd_i][upd_match_way].kind == upd_kind) begin
                upd_next_entry.conf =
                    (storage_q[upd_i][upd_match_way].conf == '1) ?
                    storage_q[upd_i][upd_match_way].conf :
                    storage_q[upd_i][upd_match_way].conf + 1'b1;
            end else begin
                upd_next_entry.conf = FTB_TARGET_CONF_W'(1);
            end
            upd_next_entry.parity = uftb_payload_parity(upd_next_entry);
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            storage_q <= '{default: '{default: '{
                valid:1'b0,
                parity:1'b0,
                ctx:'0,
                tag:'0,
                next_pc:'0,
                fall_through_pc:'0,
                kind:BR_NONE,
                conf:'0,
                age:'0
            }}};
            pmu_hit <= 1'b0;
        end else begin
            pmu_hit <= lkp_valid && lkp_hit;
            if (test_corrupt_parity_valid) begin
                storage_q[test_corrupt_parity_idx][test_corrupt_parity_way].parity <=
                    ~storage_q[test_corrupt_parity_idx][test_corrupt_parity_way].parity;
            end
            if (lkp_corrupt_hit) begin
                storage_q[lkp_i][lkp_corrupt_way].valid <= 1'b0;
            end
            if (flush_valid) begin
                /* verilator lint_off BLKSEQ */
                for (int unsigned s = 0; s < UFTB_SETS; s++) begin
                    for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                        if (!flush_context_valid ||
                            storage_q[s][w].ctx == flush_context) begin
                            storage_q[s][w].valid = 1'b0;
                        end
                    end
                end
                /* verilator lint_on BLKSEQ */
            end else begin
            if (lkp_valid && lkp_hit) begin
                for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                    if (w[$clog2(UFTB_WAYS)-1:0] == lkp_way) begin
                        storage_q[lkp_i][w].age <= '0;
                    end else if (storage_q[lkp_i][w].valid &&
                                 storage_q[lkp_i][w].age != '1) begin
                        storage_q[lkp_i][w].age <= storage_q[lkp_i][w].age + 1'b1;
                    end
                end
            end
            if (upd_valid) begin
                if (upd_match_any) begin
                    if (!(lkp_valid && lkp_hit && lkp_i == upd_i)) begin
                        for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                            if (w[$clog2(UFTB_WAYS)-1:0] == upd_match_way) begin
                                storage_q[upd_i][w].age <= '0;
                            end else if (storage_q[upd_i][w].valid &&
                                         storage_q[upd_i][w].age != '1) begin
                                storage_q[upd_i][w].age <=
                                    storage_q[upd_i][w].age + 1'b1;
                            end
                        end
                    end
                    storage_q[upd_i][upd_match_way] <= upd_next_entry;
                end else begin
                    if (!(lkp_valid && lkp_hit && lkp_i == upd_i)) begin
                        for (int unsigned w = 0; w < UFTB_WAYS; w++) begin
                            if (w[$clog2(UFTB_WAYS)-1:0] != repl_way &&
                                storage_q[upd_i][w].valid &&
                                storage_q[upd_i][w].age != '1) begin
                                storage_q[upd_i][w].age <=
                                    storage_q[upd_i][w].age + 1'b1;
                            end
                        end
                    end
                    storage_q[upd_i][repl_way] <= alloc_entry;
                end
            end
            end
        end
    end

endmodule : uftb
