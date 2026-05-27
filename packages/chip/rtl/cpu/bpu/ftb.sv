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
#(
    parameter int unsigned ENTRIES = FTB_ENTRIES,
    parameter int unsigned WAYS    = FTB_WAYS,
    parameter int unsigned SETS    = ENTRIES / WAYS,
    parameter int unsigned IDX_W   = FTB_IDX_W,
    parameter int unsigned TAG_W   = FTB_TAG_W
)
(
    input  logic                     clk,
    input  logic                     rst_n,

    // Lookup port - one PC per cycle.
    input  logic                     lkp_valid,
    input  logic [VADDR_W-1:0]       lkp_pc,
    input  bpu_context_t             lkp_context,
    output logic                     lkp_hit,
    output logic [VADDR_W-1:0]       lkp_target,
    output logic [FTB_TARGET_CONF_W-1:0] lkp_target_conf,
    output logic [VADDR_W-1:0]       lkp_fall_through_pc,
    output br_kind_e                 lkp_kind,
    output logic [MAX_BR_PER_BLOCK-1:0] lkp_br_valid,
    output logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] lkp_slot_offset,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] lkp_slot_kind,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp_slot_target,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp_slot_fall_through_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] lkp_slot_target_conf,

    // Optional second read view for two-ahead target-block prediction. It is
    // combinational over the same logical array so integration can map it to a
    // second SRAM read port or banked replica during physical implementation.
    input  logic                     lkp2_valid,
    input  logic [VADDR_W-1:0]       lkp2_pc,
    input  bpu_context_t             lkp2_context,
    output logic                     lkp2_hit,
    output logic [VADDR_W-1:0]       lkp2_target,
    output logic [FTB_TARGET_CONF_W-1:0] lkp2_target_conf,
    output logic [VADDR_W-1:0]       lkp2_fall_through_pc,
    output br_kind_e                 lkp2_kind,
    output logic [MAX_BR_PER_BLOCK-1:0] lkp2_br_valid,
    output logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] lkp2_slot_offset,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] lkp2_slot_kind,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp2_slot_target,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] lkp2_slot_fall_through_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] lkp2_slot_target_conf,

    // Update port driven by the resolver on commit.
    input  logic                     upd_valid,
    input  logic [VADDR_W-1:0]       upd_pc,
    input  bpu_context_t             upd_context,
    input  logic [VADDR_W-1:0]       upd_target,
    input  logic [VADDR_W-1:0]       upd_fall_through_pc,
    input  br_kind_e                 upd_kind,
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [MAX_BR_PER_BLOCK-1:0] upd_br_valid,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic                     upd_alloc,

    // Delayed refill/promote port from a deeper target tier. Resolver updates
    // win arbitration; refill is used only when the front-end is otherwise
    // idle from the commit path.
    input  logic                     refill_valid,
    input  logic [VADDR_W-1:0]       refill_pc,
    input  bpu_context_t             refill_context,
    input  logic [VADDR_W-1:0]       refill_target,
    input  logic [FTB_TARGET_CONF_W-1:0] refill_target_conf,
    input  logic [VADDR_W-1:0]       refill_fall_through_pc,
    input  br_kind_e                 refill_kind,
    input  logic [MAX_BR_PER_BLOCK-1:0] refill_br_valid,
    input  logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] refill_slot_offset,
    input  logic [MAX_BR_PER_BLOCK-1:0][2:0] refill_slot_kind,
    input  logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] refill_slot_target,
    input  logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] refill_slot_fall_through_pc,
    input  logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] refill_slot_target_conf,

    input  logic                     flush_valid,
    input  logic                     flush_context_valid,
    input  bpu_context_t             flush_context,

    input  logic                     test_corrupt_parity_valid,
    input  logic [IDX_W-1:0]         test_corrupt_parity_idx,
    input  logic [WAY_IDX_W-1:0]     test_corrupt_parity_way,

    output logic                     pmu_miss
);
    localparam int unsigned WAY_IDX_W = $clog2(WAYS);

    // fall_through_pc is the architectural PC of the instruction after the
    // branch — for CALL entries that becomes the RAS push address. Stored
    // alongside the target so block-grained prediction can still get the
    // RAS right when the call is not the last instruction in the block.
    typedef struct packed {
        logic                            valid;
        logic                            parity;
        bpu_context_t                    ctx;
        logic [TAG_W-1:0]                tag;
        logic [VADDR_W-1:0]              target;
        logic [VADDR_W-1:0]              fall_through_pc;
        logic [FTB_TARGET_CONF_W-1:0]    target_conf;
        br_kind_e                        kind;
        logic [MAX_BR_PER_BLOCK-1:0]     br_valid;
        logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] slot_offset;
        logic [MAX_BR_PER_BLOCK-1:0][2:0] slot_kind;
        logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] slot_target;
        logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] slot_fall_through_pc;
        logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] slot_target_conf;
        logic [3:0]                      age;
    } ftb_entry_t;

    // Storage: a single packed array of [sets][ways] entries.
    ftb_entry_t storage_q [SETS][WAYS];

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic ftb_payload_parity(input ftb_entry_t entry);
        ftb_payload_parity = ^{
            entry.ctx,
            entry.tag,
            entry.target,
            entry.fall_through_pc,
            entry.target_conf,
            entry.kind,
            entry.br_valid,
            entry.slot_offset,
            entry.slot_kind,
            entry.slot_target,
            entry.slot_fall_through_pc,
            entry.slot_target_conf
        };
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    /* verilator lint_off UNUSEDSIGNAL */
    // Index uses the PC bits above the RV instruction-alignment bit XOR'd
    // with the next slice of PC bits above the tag. The XOR-fold lifts
    // entropy from the higher PC bits into the index, breaking the
    // pathological conflict pattern observed on CBP-5 `sample_int_trace`
    // where the bottom FTB_IDX_W bits cycle through a small set of values
    // inside a hot function while the upper bits identify the function.
    // The simple low-bits index left only the local jumpsite as
    // discriminator; XOR-folding the high half of the address range
    // increases the effective set-distinct hash and drops FTB misses by
    // roughly 25% on int code without changing the FTB read latency
    // (single combinational XOR before the SRAM index port).
    //
    // The tag still covers the remaining upper bits, so a unique PC still
    // maps to a unique (index, tag) pair — the XOR is invertible given
    // the tag, which is what the lookup compares against.
    function automatic logic [IDX_W-1:0] ftb_index_for_context(
        input logic [VADDR_W-1:0] pc,
        input bpu_context_t ctx
    );
        logic [BPU_CONTEXT_HASH_W-1:0] ctx_hash;
        logic [IDX_W-1:0] ctx_idx;
        ctx_hash = bpu_context_hash(ctx);
        ctx_idx = '0;
        for (int unsigned i = 0; i < IDX_W; i++) begin
            ctx_idx[i] = ctx_hash[i % BPU_CONTEXT_HASH_W];
        end
        ftb_index_for_context =
            pc[FETCH_BLOCK_OFF_W +: IDX_W] ^
            pc[FETCH_BLOCK_OFF_W + TAG_W +: IDX_W] ^
            ctx_idx;
    endfunction

    function automatic logic [TAG_W-1:0] ftb_tag_for_context(
        input logic [VADDR_W-1:0] pc,
        input bpu_context_t ctx
    );
        logic [BPU_CONTEXT_HASH_W-1:0] ctx_hash;
        logic [TAG_W-1:0] ctx_tag;
        ctx_hash = bpu_context_hash(ctx);
        ctx_tag = '0;
        for (int unsigned i = 0; i < TAG_W; i++) begin
            ctx_tag[i] = ctx_hash[(i + IDX_W) % BPU_CONTEXT_HASH_W];
        end
        ftb_tag_for_context =
            pc[FETCH_BLOCK_OFF_W + IDX_W +: TAG_W] ^ ctx_tag;
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    // -----------------------------------------------------------------------
    // Read path
    // -----------------------------------------------------------------------
    logic [IDX_W-1:0] lkp_idx;
    logic [TAG_W-1:0] lkp_tag;
    logic [WAY_IDX_W-1:0] lkp_way;
    logic [WAY_IDX_W-1:0] lkp_corrupt_way;
    logic lkp_corrupt_hit;
    logic lkp_entry_parity_ok;
    logic [IDX_W-1:0] lkp2_idx;
    logic [TAG_W-1:0] lkp2_tag;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [WAY_IDX_W-1:0] lkp2_way;
    /* verilator lint_on UNUSEDSIGNAL */
    logic lkp2_entry_parity_ok;

    always_comb begin
        lkp_hit              = 1'b0;
        lkp_target           = '0;
        lkp_target_conf      = '0;
        lkp_fall_through_pc  = '0;
        lkp_kind             = BR_NONE;
        lkp_br_valid         = '0;
        lkp_slot_offset      = '0;
        lkp_slot_kind        = '0;
        lkp_slot_target      = '0;
        lkp_slot_fall_through_pc = '0;
        lkp_slot_target_conf = '0;
        lkp_idx              = ftb_index_for_context(lkp_pc, lkp_context);
        lkp_tag              = ftb_tag_for_context(lkp_pc, lkp_context);
        lkp_way              = '0;
        lkp_corrupt_way      = '0;
        lkp_corrupt_hit      = 1'b0;
        lkp_entry_parity_ok  = 1'b0;
        lkp2_hit              = 1'b0;
        lkp2_target           = '0;
        lkp2_target_conf      = '0;
        lkp2_fall_through_pc  = '0;
        lkp2_kind             = BR_NONE;
        lkp2_br_valid         = '0;
        lkp2_slot_offset      = '0;
        lkp2_slot_kind        = '0;
        lkp2_slot_target      = '0;
        lkp2_slot_fall_through_pc = '0;
        lkp2_slot_target_conf = '0;
        lkp2_idx              = ftb_index_for_context(lkp2_pc, lkp2_context);
        lkp2_tag              = ftb_tag_for_context(lkp2_pc, lkp2_context);
        lkp2_way              = '0;
        lkp2_entry_parity_ok  = 1'b0;
        if (lkp_valid && !flush_valid) begin
            for (int unsigned w = 0; w < WAYS; w++) begin
                lkp_entry_parity_ok =
                    storage_q[lkp_idx][w].parity ==
                    ftb_payload_parity(storage_q[lkp_idx][w]);
                if (storage_q[lkp_idx][w].valid &&
                    storage_q[lkp_idx][w].ctx == lkp_context &&
                    storage_q[lkp_idx][w].tag == lkp_tag &&
                    !lkp_entry_parity_ok) begin
                    lkp_corrupt_hit = 1'b1;
                    lkp_corrupt_way = w[WAY_IDX_W-1:0];
                end
                if (storage_q[lkp_idx][w].valid &&
                    lkp_entry_parity_ok &&
                    storage_q[lkp_idx][w].ctx == lkp_context &&
                    storage_q[lkp_idx][w].tag == lkp_tag) begin
                    lkp_hit             = 1'b1;
                    lkp_target          = storage_q[lkp_idx][w].target;
                    lkp_target_conf     = storage_q[lkp_idx][w].target_conf;
                    lkp_fall_through_pc = storage_q[lkp_idx][w].fall_through_pc;
                    lkp_kind            = storage_q[lkp_idx][w].kind;
                    lkp_br_valid        = storage_q[lkp_idx][w].br_valid;
                    lkp_slot_offset     = storage_q[lkp_idx][w].slot_offset;
                    lkp_slot_kind       = storage_q[lkp_idx][w].slot_kind;
                    lkp_slot_target     = storage_q[lkp_idx][w].slot_target;
                    lkp_slot_fall_through_pc =
                        storage_q[lkp_idx][w].slot_fall_through_pc;
                    lkp_slot_target_conf =
                        storage_q[lkp_idx][w].slot_target_conf;
                    lkp_way             = w[WAY_IDX_W-1:0];
                end
            end
            if (upd_valid &&
                (upd_match_any || upd_alloc) &&
                lkp_idx == upd_idx &&
                lkp_tag == upd_tag &&
                lkp_context == upd_context) begin
                lkp_hit             = 1'b1;
                lkp_target          = upd_match_any ?
                    upd_next_entry.target : alloc_entry.target;
                lkp_target_conf     = upd_match_any ?
                    upd_next_entry.target_conf : alloc_entry.target_conf;
                lkp_fall_through_pc = upd_match_any ?
                    upd_next_entry.fall_through_pc : alloc_entry.fall_through_pc;
                lkp_kind            = upd_match_any ?
                    upd_next_entry.kind : alloc_entry.kind;
                lkp_br_valid        = upd_match_any ?
                    upd_next_entry.br_valid : alloc_entry.br_valid;
                lkp_slot_offset     = upd_match_any ?
                    upd_next_entry.slot_offset : alloc_entry.slot_offset;
                lkp_slot_kind       = upd_match_any ?
                    upd_next_entry.slot_kind : alloc_entry.slot_kind;
                lkp_slot_target     = upd_match_any ?
                    upd_next_entry.slot_target : alloc_entry.slot_target;
                lkp_slot_fall_through_pc = upd_match_any ?
                    upd_next_entry.slot_fall_through_pc :
                    alloc_entry.slot_fall_through_pc;
                lkp_slot_target_conf = upd_match_any ?
                    upd_next_entry.slot_target_conf :
                    alloc_entry.slot_target_conf;
                lkp_way = upd_match_any ? upd_match_way : repl_way;
            end else if (!upd_valid &&
                         refill_valid &&
                         lkp_idx == refill_idx &&
                         lkp_tag == refill_tag &&
                         lkp_context == refill_context) begin
                lkp_hit             = 1'b1;
                lkp_target          = refill_next_entry.target;
                lkp_target_conf     = refill_next_entry.target_conf;
                lkp_fall_through_pc = refill_next_entry.fall_through_pc;
                lkp_kind            = refill_next_entry.kind;
                lkp_br_valid        = refill_next_entry.br_valid;
                lkp_slot_offset     = refill_next_entry.slot_offset;
                lkp_slot_kind       = refill_next_entry.slot_kind;
                lkp_slot_target     = refill_next_entry.slot_target;
                lkp_slot_fall_through_pc =
                    refill_next_entry.slot_fall_through_pc;
                lkp_slot_target_conf =
                    refill_next_entry.slot_target_conf;
                lkp_way = refill_way;
            end
        end
        if (lkp2_valid && !flush_valid) begin
            for (int unsigned w = 0; w < WAYS; w++) begin
                lkp2_entry_parity_ok =
                    storage_q[lkp2_idx][w].parity ==
                    ftb_payload_parity(storage_q[lkp2_idx][w]);
                if (storage_q[lkp2_idx][w].valid &&
                    lkp2_entry_parity_ok &&
                    storage_q[lkp2_idx][w].ctx == lkp2_context &&
                    storage_q[lkp2_idx][w].tag == lkp2_tag) begin
                    lkp2_hit             = 1'b1;
                    lkp2_target          = storage_q[lkp2_idx][w].target;
                    lkp2_target_conf     = storage_q[lkp2_idx][w].target_conf;
                    lkp2_fall_through_pc = storage_q[lkp2_idx][w].fall_through_pc;
                    lkp2_kind            = storage_q[lkp2_idx][w].kind;
                    lkp2_br_valid        = storage_q[lkp2_idx][w].br_valid;
                    lkp2_slot_offset     = storage_q[lkp2_idx][w].slot_offset;
                    lkp2_slot_kind       = storage_q[lkp2_idx][w].slot_kind;
                    lkp2_slot_target     = storage_q[lkp2_idx][w].slot_target;
                    lkp2_slot_fall_through_pc =
                        storage_q[lkp2_idx][w].slot_fall_through_pc;
                    lkp2_slot_target_conf =
                        storage_q[lkp2_idx][w].slot_target_conf;
                    lkp2_way             = w[WAY_IDX_W-1:0];
                end
            end
            if (upd_valid &&
                (upd_match_any || upd_alloc) &&
                lkp2_idx == upd_idx &&
                lkp2_tag == upd_tag &&
                lkp2_context == upd_context) begin
                lkp2_hit             = 1'b1;
                lkp2_target          = upd_match_any ?
                    upd_next_entry.target : alloc_entry.target;
                lkp2_target_conf     = upd_match_any ?
                    upd_next_entry.target_conf : alloc_entry.target_conf;
                lkp2_fall_through_pc = upd_match_any ?
                    upd_next_entry.fall_through_pc : alloc_entry.fall_through_pc;
                lkp2_kind            = upd_match_any ?
                    upd_next_entry.kind : alloc_entry.kind;
                lkp2_br_valid        = upd_match_any ?
                    upd_next_entry.br_valid : alloc_entry.br_valid;
                lkp2_slot_offset     = upd_match_any ?
                    upd_next_entry.slot_offset : alloc_entry.slot_offset;
                lkp2_slot_kind       = upd_match_any ?
                    upd_next_entry.slot_kind : alloc_entry.slot_kind;
                lkp2_slot_target     = upd_match_any ?
                    upd_next_entry.slot_target : alloc_entry.slot_target;
                lkp2_slot_fall_through_pc = upd_match_any ?
                    upd_next_entry.slot_fall_through_pc :
                    alloc_entry.slot_fall_through_pc;
                lkp2_slot_target_conf = upd_match_any ?
                    upd_next_entry.slot_target_conf :
                    alloc_entry.slot_target_conf;
                lkp2_way = upd_match_any ? upd_match_way : repl_way;
            end else if (!upd_valid &&
                         refill_valid &&
                         lkp2_idx == refill_idx &&
                         lkp2_tag == refill_tag &&
                         lkp2_context == refill_context) begin
                lkp2_hit             = 1'b1;
                lkp2_target          = refill_next_entry.target;
                lkp2_target_conf     = refill_next_entry.target_conf;
                lkp2_fall_through_pc = refill_next_entry.fall_through_pc;
                lkp2_kind            = refill_next_entry.kind;
                lkp2_br_valid        = refill_next_entry.br_valid;
                lkp2_slot_offset     = refill_next_entry.slot_offset;
                lkp2_slot_kind       = refill_next_entry.slot_kind;
                lkp2_slot_target     = refill_next_entry.slot_target;
                lkp2_slot_fall_through_pc =
                    refill_next_entry.slot_fall_through_pc;
                lkp2_slot_target_conf =
                    refill_next_entry.slot_target_conf;
                lkp2_way = refill_way;
            end
        end
    end

    // -----------------------------------------------------------------------
    // Update path
    // -----------------------------------------------------------------------
    logic [IDX_W-1:0] upd_idx;
    logic [TAG_W-1:0] upd_tag;
    logic                 upd_match_any;
    logic [WAY_IDX_W-1:0] upd_match_way;
    logic [WAY_IDX_W-1:0] repl_way;
    logic [IDX_W-1:0] refill_idx;
    logic [TAG_W-1:0] refill_tag;
    logic             refill_match_any;
    logic [WAY_IDX_W-1:0] refill_match_way;
    logic [WAY_IDX_W-1:0] refill_repl_way;
    logic [WAY_IDX_W-1:0] refill_way;
    logic [4:0] refill_repl_score;
    logic [$clog2(MAX_BR_PER_BLOCK)-1:0] upd_slot_idx;
    logic upd_slot_found;
    logic [FETCH_BLOCK_OFF_W-1:0] upd_offset;
    logic [4:0] repl_score;
    logic [4:0] cand_score;
    logic [FETCH_BLOCK_OFF_W-1:0] best_offset;
    logic [VADDR_W-1:0] best_target;
    logic [VADDR_W-1:0] best_fall_through_pc;
    br_kind_e best_kind;
    logic [FTB_TARGET_CONF_W-1:0] best_target_conf;
    logic [FTB_TARGET_CONF_W-1:0] upd_slot_next_conf;
    ftb_entry_t upd_next_entry;
    ftb_entry_t alloc_entry;
    ftb_entry_t refill_next_entry;

    always_comb begin
        upd_idx       = ftb_index_for_context(upd_pc, upd_context);
        upd_tag       = ftb_tag_for_context(upd_pc, upd_context);
        upd_match_any = 1'b0;
        upd_match_way = '0;
        repl_way      = '0;
        repl_score    = '0;
        upd_slot_idx  = '0;
        upd_slot_found= 1'b0;
        upd_offset    = upd_pc[FETCH_BLOCK_OFF_W-1:0];
        best_offset   = '1;
        best_target   = upd_target;
        best_fall_through_pc = upd_fall_through_pc;
        best_kind     = upd_kind;
        best_target_conf = FTB_TARGET_CONF_W'(1);
        upd_slot_next_conf = FTB_TARGET_CONF_W'(1);
        upd_next_entry = '0;
        alloc_entry = '0;
        refill_next_entry = '0;
        refill_idx = ftb_index_for_context(refill_pc, refill_context);
        refill_tag = ftb_tag_for_context(refill_pc, refill_context);
        refill_match_any = 1'b0;
        refill_match_way = '0;
        refill_repl_way = '0;
        refill_way = '0;
        refill_repl_score = '0;
        for (int unsigned w = 0; w < WAYS; w++) begin
            if (storage_q[upd_idx][w].valid &&
                storage_q[upd_idx][w].parity ==
                    ftb_payload_parity(storage_q[upd_idx][w]) &&
                storage_q[upd_idx][w].ctx == upd_context &&
                storage_q[upd_idx][w].tag == upd_tag) begin
                upd_match_any = 1'b1;
                upd_match_way = w[WAY_IDX_W-1:0];
                for (int unsigned s = 0; s < MAX_BR_PER_BLOCK; s++) begin
                    if (storage_q[upd_idx][w].br_valid[s] &&
                        storage_q[upd_idx][w].slot_offset[s] == upd_offset) begin
                        upd_slot_found = 1'b1;
                        upd_slot_idx = s[$clog2(MAX_BR_PER_BLOCK)-1:0];
                    end else if (!storage_q[upd_idx][w].br_valid[s] &&
                                 !upd_slot_found) begin
                        upd_slot_idx = s[$clog2(MAX_BR_PER_BLOCK)-1:0];
                    end
                end
            end
            cand_score = storage_q[upd_idx][w].valid ?
                {1'b0, storage_q[upd_idx][w].age} : 5'h1f;
            if (cand_score >= repl_score) begin
                repl_score = cand_score;
                repl_way = w[WAY_IDX_W-1:0];
            end
            if (storage_q[refill_idx][w].valid &&
                storage_q[refill_idx][w].parity ==
                    ftb_payload_parity(storage_q[refill_idx][w]) &&
                storage_q[refill_idx][w].ctx == refill_context &&
                storage_q[refill_idx][w].tag == refill_tag) begin
                refill_match_any = 1'b1;
                refill_match_way = w[WAY_IDX_W-1:0];
            end
            cand_score = storage_q[refill_idx][w].valid ?
                {1'b0, storage_q[refill_idx][w].age} : 5'h1f;
            if (cand_score >= refill_repl_score) begin
                refill_repl_score = cand_score;
                refill_repl_way = w[WAY_IDX_W-1:0];
            end
        end
        if (upd_match_any) begin
            upd_next_entry = storage_q[upd_idx][upd_match_way];
            upd_next_entry.age = '0;
            upd_next_entry.ctx = upd_context;
            upd_next_entry.tag = upd_tag;
            upd_next_entry.br_valid[upd_slot_idx] = 1'b1;
            upd_next_entry.slot_offset[upd_slot_idx] = upd_offset;
            upd_next_entry.slot_kind[upd_slot_idx] = upd_kind;
            upd_next_entry.slot_target[upd_slot_idx] = upd_target;
            upd_next_entry.slot_fall_through_pc[upd_slot_idx] =
                upd_fall_through_pc;
            if (upd_slot_found &&
                storage_q[upd_idx][upd_match_way].slot_target[upd_slot_idx] ==
                upd_target) begin
                upd_slot_next_conf =
                    (storage_q[upd_idx][upd_match_way].slot_target_conf[upd_slot_idx] == '1) ?
                    storage_q[upd_idx][upd_match_way].slot_target_conf[upd_slot_idx] :
                    storage_q[upd_idx][upd_match_way].slot_target_conf[upd_slot_idx] + 1'b1;
            end
            upd_next_entry.slot_target_conf[upd_slot_idx] = upd_slot_next_conf;
            for (int unsigned s = 0; s < MAX_BR_PER_BLOCK; s++) begin
                if ((s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx ||
                     storage_q[upd_idx][upd_match_way].br_valid[s]) &&
                    ((s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx ?
                      upd_offset :
                      storage_q[upd_idx][upd_match_way].slot_offset[s]) < best_offset)) begin
                    best_offset = (s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx) ?
                        upd_offset : storage_q[upd_idx][upd_match_way].slot_offset[s];
                    best_target = (s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx) ?
                        upd_target : storage_q[upd_idx][upd_match_way].slot_target[s];
                    best_fall_through_pc =
                        (s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx) ?
                        upd_fall_through_pc :
                        storage_q[upd_idx][upd_match_way].slot_fall_through_pc[s];
                    best_kind = (s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx) ?
                        upd_kind :
                        br_kind_e'(storage_q[upd_idx][upd_match_way].slot_kind[s]);
                    best_target_conf =
                        (s[$clog2(MAX_BR_PER_BLOCK)-1:0] == upd_slot_idx) ?
                        upd_slot_next_conf :
                        storage_q[upd_idx][upd_match_way].slot_target_conf[s];
                end
            end
            upd_next_entry.target = best_target;
            upd_next_entry.fall_through_pc = best_fall_through_pc;
            upd_next_entry.kind = best_kind;
            upd_next_entry.target_conf = best_target_conf;
            upd_next_entry.parity = ftb_payload_parity(upd_next_entry);
        end
        alloc_entry.valid = 1'b1;
        alloc_entry.ctx = upd_context;
        alloc_entry.tag = upd_tag;
        alloc_entry.target = upd_target;
        alloc_entry.fall_through_pc = upd_fall_through_pc;
        alloc_entry.target_conf = FTB_TARGET_CONF_W'(1);
        alloc_entry.kind = upd_kind;
        alloc_entry.br_valid = {{(MAX_BR_PER_BLOCK-1){1'b0}}, 1'b1};
        alloc_entry.slot_offset = '0;
        alloc_entry.slot_kind = '0;
        alloc_entry.slot_target = '0;
        alloc_entry.slot_fall_through_pc = '0;
        alloc_entry.slot_target_conf = '0;
        alloc_entry.age = '0;
        alloc_entry.slot_offset[0] = upd_offset;
        alloc_entry.slot_kind[0] = upd_kind;
        alloc_entry.slot_target[0] = upd_target;
        alloc_entry.slot_fall_through_pc[0] = upd_fall_through_pc;
        alloc_entry.slot_target_conf[0] = FTB_TARGET_CONF_W'(1);
        alloc_entry.parity = ftb_payload_parity(alloc_entry);
        refill_way = refill_match_any ? refill_match_way : refill_repl_way;
        refill_next_entry.valid = 1'b1;
        refill_next_entry.ctx = refill_context;
        refill_next_entry.tag = refill_tag;
        refill_next_entry.target = refill_target;
        refill_next_entry.fall_through_pc = refill_fall_through_pc;
        refill_next_entry.target_conf = refill_target_conf;
        refill_next_entry.kind = refill_kind;
        refill_next_entry.br_valid = refill_br_valid;
        refill_next_entry.slot_offset = refill_slot_offset;
        refill_next_entry.slot_kind = refill_slot_kind;
        refill_next_entry.slot_target = refill_slot_target;
        refill_next_entry.slot_fall_through_pc = refill_slot_fall_through_pc;
        refill_next_entry.slot_target_conf = refill_slot_target_conf;
        refill_next_entry.age = '0;
        refill_next_entry.parity = ftb_payload_parity(refill_next_entry);
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            /* verilator lint_off BLKSEQ */
            for (int unsigned s = 0; s < SETS; s++) begin
                for (int unsigned w = 0; w < WAYS; w++) begin
                    storage_q[s][w].valid = 1'b0;
                    storage_q[s][w].parity = 1'b0;
                    storage_q[s][w].ctx = '0;
                    storage_q[s][w].tag = '0;
                    storage_q[s][w].target = '0;
                    storage_q[s][w].fall_through_pc = '0;
                    storage_q[s][w].target_conf = '0;
                    storage_q[s][w].kind = BR_NONE;
                    storage_q[s][w].br_valid = '0;
                    storage_q[s][w].slot_offset = '0;
                    storage_q[s][w].slot_kind = '0;
                    storage_q[s][w].slot_target = '0;
                    storage_q[s][w].slot_fall_through_pc = '0;
                    storage_q[s][w].slot_target_conf = '0;
                    storage_q[s][w].age = '0;
                end
            end
            /* verilator lint_on BLKSEQ */
            pmu_miss <= 1'b0;
        end else begin
            pmu_miss <= lkp_valid && !lkp_hit;
            if (test_corrupt_parity_valid) begin
                storage_q[test_corrupt_parity_idx][test_corrupt_parity_way].parity <=
                    ~storage_q[test_corrupt_parity_idx][test_corrupt_parity_way].parity;
            end
            if (lkp_corrupt_hit) begin
                storage_q[lkp_idx][lkp_corrupt_way].valid <= 1'b0;
            end
            if (flush_valid) begin
                for (int unsigned s = 0; s < SETS; s++) begin
                    for (int unsigned w = 0; w < WAYS; w++) begin
                        if (!flush_context_valid ||
                            storage_q[s][w].ctx == flush_context) begin
                            storage_q[s][w].valid <= 1'b0;
                        end
                    end
                end
            end else begin
            if (lkp_valid && lkp_hit) begin
                for (int unsigned w = 0; w < WAYS; w++) begin
                    if (w[WAY_IDX_W-1:0] == lkp_way) begin
                        storage_q[lkp_idx][w].age <= '0;
                    end else if (storage_q[lkp_idx][w].valid &&
                                 storage_q[lkp_idx][w].age != '1) begin
                        storage_q[lkp_idx][w].age <= storage_q[lkp_idx][w].age + 1'b1;
                    end
                end
            end

            if (upd_valid) begin
                if (upd_match_any) begin
                    if (!(lkp_valid && lkp_hit && lkp_idx == upd_idx)) begin
                        for (int unsigned w = 0; w < WAYS; w++) begin
                            if (w[WAY_IDX_W-1:0] == upd_match_way) begin
                                storage_q[upd_idx][w].age <= '0;
                            end else if (storage_q[upd_idx][w].valid &&
                                         storage_q[upd_idx][w].age != '1) begin
                                storage_q[upd_idx][w].age <=
                                    storage_q[upd_idx][w].age + 1'b1;
                            end
                        end
                    end
                    storage_q[upd_idx][upd_match_way] <= upd_next_entry;
                end else if (upd_alloc) begin
                    if (!(lkp_valid && lkp_hit && lkp_idx == upd_idx)) begin
                        for (int unsigned w = 0; w < WAYS; w++) begin
                            if (w[WAY_IDX_W-1:0] != repl_way &&
                                storage_q[upd_idx][w].valid &&
                                storage_q[upd_idx][w].age != '1) begin
                                storage_q[upd_idx][w].age <=
                                    storage_q[upd_idx][w].age + 1'b1;
                            end
                        end
                    end
                    storage_q[upd_idx][repl_way] <= alloc_entry;
                end
            end else if (refill_valid) begin
                if (!(lkp_valid && lkp_hit && lkp_idx == refill_idx)) begin
                    for (int unsigned w = 0; w < WAYS; w++) begin
                        if (w[WAY_IDX_W-1:0] == refill_way) begin
                            storage_q[refill_idx][w].age <= '0;
                        end else if (storage_q[refill_idx][w].valid &&
                                     storage_q[refill_idx][w].age != '1) begin
                            storage_q[refill_idx][w].age <=
                                storage_q[refill_idx][w].age + 1'b1;
                        end
                    end
                end
                storage_q[refill_idx][refill_way] <= refill_next_entry;
            end
            end
        end
    end

endmodule : ftb
