// bpu_pkg.sv — Branch Prediction Unit parameter and type package.
//
// Topology is XiangShan Kunminghu-style, scaled toward a 2028 phone-class
// application processor envelope: decoupled BPU running ahead of fetch via an
// FTQ, with uFTB + FTB for next-block target prediction, TAGE-SC + ITTAGE for
// conditional and indirect direction/target prediction, RAS for call/return,
// and a loop predictor for short-trip-count loops.
//
// The minimum 2028 thresholds enforced by
// scripts/check_branch_prediction.py mirror the targets in
// docs/arch/branch-prediction.md and docs/architecture-optimization/
// sota-2028/branch-predictors.md. Synthesis and area cost are managed by the
// COMPACT_BUILD compile knob: a smaller geometry suitable for cocotb / formal
// regression at MVP scale, gated against the production geometry by the
// branch-prediction-check evidence script.
//
// Every parameter in `bpu_params_t` is exposed to the integration top via
// localparams in `bpu_top.sv` and may be overridden by build defines. The
// evidence script reads the production geometry from this file and refuses
// to declare a clean status if the geometry drops below the 2028 minimums.

`ifndef BPU_PKG_SV
`define BPU_PKG_SV

`timescale 1ns/1ps

// Many of the localparams below are intentionally not referenced by every
// importer. They form the externally checkable geometry consumed by
// scripts/check_branch_prediction.py and the docs gate, so verilator's
// strict-lint UNUSEDPARAM warning is silenced for the whole package.
/* verilator lint_off UNUSEDPARAM */
package bpu_pkg;

    // ------------------------------------------------------------------
    // Fetch/prediction block
    // ------------------------------------------------------------------
    // Predicted in a single BPU cycle. 32 B prediction block matches Zen 5 /
    // X925 / Lion Cove and fits up to 16 RVC instructions.
    localparam int unsigned FETCH_BLOCK_BYTES = 32;
    localparam int unsigned MAX_BR_PER_BLOCK  = 2;      // 2 taken/cycle target
    localparam int unsigned XLEN              = 64;
    localparam int unsigned VADDR_W           = 39;     // Sv39 virtual address

    // ------------------------------------------------------------------
    // FTQ (Fetch Target Queue) - decoupled BPU/fetch buffer
    // ------------------------------------------------------------------
    localparam int unsigned FTQ_ENTRIES = 64;           // KMH-class
    localparam int unsigned FTQ_IDX_W   = $clog2(FTQ_ENTRIES);

    // ------------------------------------------------------------------
    // uFTB (micro Fetch Target Buffer) - zero-bubble next-line predictor
    // ------------------------------------------------------------------
    localparam int unsigned UFTB_ENTRIES = 512;         // above KMH 256
    localparam int unsigned UFTB_WAYS    = 4;
    localparam int unsigned UFTB_SETS    = UFTB_ENTRIES / UFTB_WAYS;
    localparam int unsigned UFTB_IDX_W   = $clog2(UFTB_SETS);
    localparam int unsigned UFTB_TAG_W   = 10;

    // ------------------------------------------------------------------
    // FTB (Fetch Target Buffer) - replaces traditional BTB
    // ------------------------------------------------------------------
    localparam int unsigned FTB_ENTRIES = 2048;         // KMH-v2 floor
    localparam int unsigned FTB_WAYS    = 4;
    localparam int unsigned FTB_SETS    = FTB_ENTRIES / FTB_WAYS;
    localparam int unsigned FTB_IDX_W   = $clog2(FTB_SETS);
    localparam int unsigned FTB_TAG_W   = 20;

    // ------------------------------------------------------------------
    // TAGE conditional predictor
    // ------------------------------------------------------------------
    // Number of tagged tables in the TAGE stack. The base bimodal predictor
    // is held separately and indexed by PC only.
    localparam int unsigned TAGE_TABLES        = 5;
    localparam int unsigned TAGE_ENTRIES_TABLE = 4096;
    localparam int unsigned TAGE_IDX_W         = $clog2(TAGE_ENTRIES_TABLE);
    localparam int unsigned TAGE_TAG_W         = 8;
    localparam int unsigned TAGE_CTR_W         = 3;     // 3-bit signed direction
    localparam int unsigned TAGE_USEFUL_W      = 2;     // 2-bit useful field
    // Base bimodal predictor sized to match KMH bimodal floor.
    localparam int unsigned BIM_ENTRIES = 16384;
    localparam int unsigned BIM_IDX_W   = $clog2(BIM_ENTRIES);
    localparam int unsigned BIM_CTR_W   = 2;            // 2-bit saturating

    // Geometric history lengths used to compute the per-table indices.
    // Each entry is the global history length used when folding into the
    // TAGE index and tag. The bottom table is the shortest history.
    //
    // Both an individual `TAGE_HIST_LEN_*` localparam and a constant
    // function are exposed; downstream RTL uses the localparams from
    // generate-time elaboration so yosys (no constant-function support for
    // module port widths) can also parse the package.
    localparam int unsigned TAGE_HIST_LEN_0 = 8;
    localparam int unsigned TAGE_HIST_LEN_1 = 13;
    localparam int unsigned TAGE_HIST_LEN_2 = 32;
    localparam int unsigned TAGE_HIST_LEN_3 = 64;
    localparam int unsigned TAGE_HIST_LEN_4 = 119;
    function automatic int unsigned tage_hist_len(input int unsigned table_id);
        case (table_id)
            32'd0:   tage_hist_len = TAGE_HIST_LEN_0;
            32'd1:   tage_hist_len = TAGE_HIST_LEN_1;
            32'd2:   tage_hist_len = TAGE_HIST_LEN_2;
            32'd3:   tage_hist_len = TAGE_HIST_LEN_3;
            32'd4:   tage_hist_len = TAGE_HIST_LEN_4;
            default: tage_hist_len = 32'd0;
        endcase
    endfunction

    // Useful-bit periodic reset interval (cycles). Matches Seznec CBP-5
    // recommendation: alternate-half reset on every 256K predictions.
    localparam int unsigned TAGE_USEFUL_RESET_PERIOD = 32'h0004_0000;

    // Working width of the global history shift register. Sized to the
    // longest tagged-table history (table 4) so that all per-table histories
    // can be sliced from the same vector.
    localparam int unsigned TAGE_HIST_LEN_MAX = 119;

    // ------------------------------------------------------------------
    // Statistical Corrector (SC)
    // ------------------------------------------------------------------
    localparam int unsigned SC_TABLES        = 4;
    localparam int unsigned SC_ENTRIES_TABLE = 512;
    localparam int unsigned SC_IDX_W         = $clog2(SC_ENTRIES_TABLE);
    localparam int unsigned SC_CTR_W         = 6;
    localparam int unsigned SC_HIST_LEN_0 = 0;
    localparam int unsigned SC_HIST_LEN_1 = 4;
    localparam int unsigned SC_HIST_LEN_2 = 10;
    localparam int unsigned SC_HIST_LEN_3 = 16;
    function automatic int unsigned sc_hist_len(input int unsigned table_id);
        case (table_id)
            32'd0:   sc_hist_len = 32'd0;
            32'd1:   sc_hist_len = 32'd4;
            32'd2:   sc_hist_len = 32'd10;
            32'd3:   sc_hist_len = 32'd16;
            default: sc_hist_len = 32'd0;
        endcase
    endfunction
    // SC threshold counter for taking the corrector's verdict. Updated by
    // the SC update path when TAGE's confidence is low.
    localparam int unsigned SC_THRESH_INIT = 6;

    // ------------------------------------------------------------------
    // Loop predictor
    // ------------------------------------------------------------------
    localparam int unsigned LOOP_ENTRIES = 64;
    localparam int unsigned LOOP_IDX_W   = $clog2(LOOP_ENTRIES);
    localparam int unsigned LOOP_TAG_W   = 14;
    localparam int unsigned LOOP_CTR_W   = 14;          // up to 2^14 iterations
    localparam int unsigned LOOP_CONF_W  = 3;

    // ------------------------------------------------------------------
    // RAS (Return Address Stack)
    // ------------------------------------------------------------------
    localparam int unsigned RAS_ARCH_ENTRIES = 32;      // architectural depth
    localparam int unsigned RAS_SPEC_ENTRIES = 64;      // speculative depth
    localparam int unsigned RAS_OVERFLOW_W   = 3;       // per-entry overflow ctr
    localparam int unsigned RAS_IDX_W        = $clog2(RAS_SPEC_ENTRIES);

    // ------------------------------------------------------------------
    // ITTAGE indirect predictor
    // ------------------------------------------------------------------
    localparam int unsigned ITTAGE_TABLES = 5;
    localparam int unsigned ITTAGE_ENTRIES_0 = 256;
    localparam int unsigned ITTAGE_ENTRIES_1 = 256;
    localparam int unsigned ITTAGE_ENTRIES_2 = 512;
    localparam int unsigned ITTAGE_ENTRIES_3 = 512;
    localparam int unsigned ITTAGE_ENTRIES_4 = 512;
    localparam int unsigned ITTAGE_HIST_LEN_0 = 4;
    localparam int unsigned ITTAGE_HIST_LEN_1 = 8;
    localparam int unsigned ITTAGE_HIST_LEN_2 = 13;
    localparam int unsigned ITTAGE_HIST_LEN_3 = 16;
    localparam int unsigned ITTAGE_HIST_LEN_4 = 32;
    // Per-table entry counts mirror Kunminghu v2.
    function automatic int unsigned ittage_entries(input int unsigned table_id);
        case (table_id)
            32'd0:   ittage_entries = 32'd256;
            32'd1:   ittage_entries = 32'd256;
            32'd2:   ittage_entries = 32'd512;
            32'd3:   ittage_entries = 32'd512;
            32'd4:   ittage_entries = 32'd512;
            default: ittage_entries = 32'd0;
        endcase
    endfunction
    function automatic int unsigned ittage_hist_len(input int unsigned table_id);
        case (table_id)
            32'd0:   ittage_hist_len = 32'd4;
            32'd1:   ittage_hist_len = 32'd8;
            32'd2:   ittage_hist_len = 32'd13;
            32'd3:   ittage_hist_len = 32'd16;
            32'd4:   ittage_hist_len = 32'd32;
            default: ittage_hist_len = 32'd0;
        endcase
    endfunction
    localparam int unsigned ITTAGE_TAG_W = 9;
    localparam int unsigned ITTAGE_CTR_W = 3;
    localparam int unsigned ITTAGE_USEFUL_W = 2;

    // ------------------------------------------------------------------
    // Performance Monitoring Unit (Zihpm) event encoding
    // ------------------------------------------------------------------
    // These IDs are arranged so that mapping into zihpm_pkg::hpm_event_e is a
    // pure +1 offset (zihpm reserves id 0 for the "no event" sentinel). The
    // BPU agent owns the source for events 0..19 here, exported as zihpm
    // events 1..20; the translation is encoded in `bpu_pmu_to_hpm()` below
    // and the documentation table in docs/arch/branch-prediction.md.
    //
    // Order is therefore locked to the zihpm enum and must change in lockstep
    // with rtl/cpu/csr/zihpm.sv if either side is rearranged.
    typedef enum logic [4:0] {
        PMU_BR_PRED        = 5'd0,   // zihpm EVT_BR_PRED        = 8'd1
        PMU_BR_TAKEN       = 5'd1,   // zihpm EVT_BR_TAKEN       = 8'd2
        PMU_BR_MISP        = 5'd2,   // zihpm EVT_BR_MISP        = 8'd3
        PMU_BR_COND        = 5'd3,   // zihpm EVT_BR_COND        = 8'd4
        PMU_BR_COND_MISP   = 5'd4,   // zihpm EVT_BR_COND_MISP   = 8'd5
        PMU_BR_IND         = 5'd5,   // zihpm EVT_BR_IND         = 8'd6
        PMU_BR_IND_MISP    = 5'd6,   // zihpm EVT_BR_IND_MISP    = 8'd7
        PMU_BR_CALL        = 5'd7,   // zihpm EVT_BR_CALL        = 8'd8
        PMU_BR_RET         = 5'd8,   // zihpm EVT_BR_RET         = 8'd9
        PMU_BR_RET_MISP    = 5'd9,   // zihpm EVT_BR_RET_MISP    = 8'd10
        PMU_RAS_OVERFLOW   = 5'd10,  // zihpm EVT_RAS_OVERFLOW   = 8'd11
        PMU_RAS_UNDERFLOW  = 5'd11,  // zihpm EVT_RAS_UNDERFLOW  = 8'd12
        PMU_FTQ_FULL       = 5'd12,  // zihpm EVT_FTQ_FULL       = 8'd13
        PMU_FTQ_EMPTY      = 5'd13,  // zihpm EVT_FTQ_EMPTY      = 8'd14
        PMU_FETCH_BUBBLE   = 5'd14,  // zihpm EVT_FETCH_BUBBLE   = 8'd15
        PMU_FTB_MISS       = 5'd15,  // zihpm EVT_BTB_MISS       = 8'd16
        PMU_UFTB_HIT       = 5'd16,  // zihpm EVT_UFTB_HIT       = 8'd17
        PMU_TAGE_ALLOC     = 5'd17,  // zihpm EVT_TAGE_ALLOC     = 8'd18
        PMU_LOOP_HIT       = 5'd18,  // zihpm EVT_LOOP_HIT       = 8'd19
        PMU_SC_OVERRIDE    = 5'd19   // zihpm EVT_SC_OVERRIDE    = 8'd20
    } pmu_event_e;

    localparam int unsigned PMU_EVENTS = 20;
    localparam int unsigned PMU_COUNTER_W = 64;

    // Translation helper: convert a BPU-domain PMU event id to the matching
    // zihpm event id. Lockstep contract with rtl/cpu/csr/zihpm.sv.
    function automatic logic [7:0] bpu_pmu_to_hpm(input logic [4:0] pmu_id);
        bpu_pmu_to_hpm = {3'b000, pmu_id} + 8'd1;
    endfunction

    // ------------------------------------------------------------------
    // BPU integration types
    // ------------------------------------------------------------------
    typedef enum logic [1:0] {
        BR_NONE   = 2'd0,
        BR_COND   = 2'd1,
        BR_CALL   = 2'd2,
        BR_RET    = 2'd3
    } br_kind_e;

    // A single FTQ entry describes one predicted fetch block of up to
    // FETCH_BLOCK_BYTES bytes. The predicted block extends from start_pc
    // through end_pc inclusive; if `taken` is asserted, the predicted target
    // for the next block is `target_pc`. Up to MAX_BR_PER_BLOCK branches are
    // recorded so the resolver can validate redirection.
    typedef struct packed {
        logic                     valid;
        logic [VADDR_W-1:0]       start_pc;
        logic [VADDR_W-1:0]       end_pc;
        logic [VADDR_W-1:0]       target_pc;
        logic                     taken;
        br_kind_e                 kind;
        logic [MAX_BR_PER_BLOCK-1:0] br_taken_mask;
        logic [FTQ_IDX_W-1:0]     ftq_idx;
        // Snapshot fields used by the update path on redirect.
        logic [RAS_IDX_W:0]       ras_spec_top;
    } ftq_entry_t;

    // Lookup response bundled out of bpu_top.
    typedef struct packed {
        logic                 valid;
        logic [VADDR_W-1:0]   start_pc;
        logic [VADDR_W-1:0]   target_pc;
        logic                 taken;
        br_kind_e             kind;
        logic                 from_uftb;
        logic                 from_ftb;
        logic                 from_tage;
        logic                 from_ittage;
        logic                 from_ras;
        logic                 from_loop;
        logic                 from_sc;
    } bpu_lookup_t;

    // Resolver feedback from the back-end. Drives BPU state update and
    // redirect on misprediction.
    typedef struct packed {
        logic                 valid;
        logic                 misprediction;
        logic [VADDR_W-1:0]   pc;
        logic [VADDR_W-1:0]   actual_target;
        logic                 actual_taken;
        br_kind_e             actual_kind;
        logic [FTQ_IDX_W-1:0] ftq_idx;
    } bpu_resolve_t;

    // Cumulative PMU counter bundle.
    typedef struct packed {
        logic [PMU_COUNTER_W-1:0] count;
    } pmu_counter_t;

endpackage : bpu_pkg
/* verilator lint_on UNUSEDPARAM */

`endif // BPU_PKG_SV
