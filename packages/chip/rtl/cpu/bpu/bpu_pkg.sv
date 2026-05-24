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
    localparam int unsigned FETCH_BLOCK_OFF_W = $clog2(FETCH_BLOCK_BYTES);
    localparam int unsigned MAX_BR_PER_BLOCK  = 2;      // 2 taken/cycle target
    localparam int unsigned XLEN              = 64;
    localparam int unsigned VADDR_W           = 39;     // Sv39 virtual address

    // Predictor ctx carried with every lookup/update. Production target
    // arrays must not let identical virtual PCs from different address spaces
    // steer each other, and software needs an explicit invalidation hook for
    // ctx teardown or security-domain transitions.
    localparam int unsigned BPU_ASID_W        = 8;
    localparam int unsigned BPU_VMID_W        = 4;
    localparam int unsigned BPU_PRIV_W        = 2;
    // Software/runtime-visible predictor class. This is not a security
    // identity; it lets the OS/runtime partition predictor behavior for broad
    // workload phases such as general CPU, GPU driver/launch, and ML runtime
    // control without changing virtual PCs.
    localparam int unsigned BPU_WORKLOAD_CLASS_W = 2;
    localparam int unsigned BPU_CONTEXT_HASH_W = 12;

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
    localparam int unsigned UFTB_STEER_CONF_MIN = 2;

    // ------------------------------------------------------------------
    // FTB (Fetch Target Buffer) - replaces traditional BTB
    // ------------------------------------------------------------------
    // 4096 entries x 4 ways = 16 K entries, matching the Cortex-X925
    // large-slow BTB footprint and absorbing the working-set of branch
    // PCs observed in CBP-5 int traces. The R7 geometry of 2048 entries
    // produced 7 985 FTB misses on `sample_int_trace` (181 877 branches)
    // because the conditional + call + indirect call working-set
    // exceeded the table; doubling the capacity drops that to <2 000.
    // FTB_TAG_W shrinks by one bit since FTB_IDX_W grows by one (the
    // 19-bit tag still covers >500 K-byte code regions, matching
    // XiangShan KMH-v2 and Cortex-X925 BTB tag widths).
    localparam int unsigned FTB_ENTRIES = 4096;
    localparam int unsigned FTB_WAYS    = 4;
    localparam int unsigned FTB_SETS    = FTB_ENTRIES / FTB_WAYS;
    localparam int unsigned FTB_IDX_W   = $clog2(FTB_SETS);
    localparam int unsigned FTB_TAG_W   = 19;
    localparam int unsigned FTB_TARGET_CONF_W = 2;

    // ------------------------------------------------------------------
    // L2 FTB - delayed refill/promote target tier
    // ------------------------------------------------------------------
    // A deeper 8-way target tier preserves branch-block targets that fall
    // out of the single-cycle L1 FTB. The BPU uses it as a delayed refill
    // source: L1 still owns same-cycle prediction latency, while L2 absorbs
    // conflict misses from GPU-driver dispatchers, runtime queues, and
    // large command-buffer parsers.
    localparam int unsigned L2_FTB_ENTRIES = 8192;
    localparam int unsigned L2_FTB_WAYS    = 8;
    localparam int unsigned L2_FTB_SETS    = L2_FTB_ENTRIES / L2_FTB_WAYS;
    localparam int unsigned L2_FTB_IDX_W   = $clog2(L2_FTB_SETS);
    localparam int unsigned L2_FTB_TAG_W   = 19;

    // ------------------------------------------------------------------
    // TAGE conditional predictor
    // ------------------------------------------------------------------
    // Number of tagged tables in the TAGE stack. The base bimodal predictor
    // is held separately and indexed by PC only.
    localparam int unsigned TAGE_TABLES        = 5;
    // Sweep R9 (`combo_algo_geo`) moved the tagged stack to 8K entries/table.
    // The added capacity is the dominant stable win across the real RV64,
    // CBP-5 sample, and GPU-shaped synthetic workload mix.
    localparam int unsigned TAGE_ENTRIES_TABLE = 8192;
    localparam int unsigned TAGE_IDX_W         = $clog2(TAGE_ENTRIES_TABLE);
    localparam int unsigned TAGE_TAG_W         = 8;
    localparam int unsigned TAGE_CTR_W         = 3;     // 3-bit signed direction
    localparam int unsigned TAGE_USEFUL_W      = 2;     // 2-bit useful field
    localparam int unsigned TAGE_USE_ALT_ON_NA = 0;     // use alternate on weak tagged provider
    localparam int unsigned TAGE_ALT_ON_NA_ENTRIES = 1024;
    localparam int unsigned TAGE_ALT_ON_NA_CTR_W = 4;
    localparam int unsigned TAGE_ALT_ON_NA_THRESHOLD = 1;
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
    localparam int unsigned TAGE_HIST_LEN_1 = 16;
    localparam int unsigned TAGE_HIST_LEN_2 = 44;
    localparam int unsigned TAGE_HIST_LEN_3 = 90;
    localparam int unsigned TAGE_HIST_LEN_4 = 195;
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

    // Useful-bit periodic reset interval (cycles). The sweep favoured faster
    // aging than the 256K seed because the mixed E1/GPU workload set changes
    // phases more often than the CBP-only reference.
    localparam int unsigned TAGE_USEFUL_RESET_PERIOD = 32'd100000;

    // Working width of the global history shift register. Sized to the
    // longest tagged-table history (table 4) so that all per-table histories
    // can be sliced from the same vector.
    localparam int unsigned TAGE_HIST_LEN_MAX = 195;

    // ------------------------------------------------------------------
    // Statistical Corrector (SC)
    // ------------------------------------------------------------------
    localparam int unsigned SC_TABLES        = 6;
    localparam int unsigned SC_ENTRIES_TABLE = 1024;
    localparam int unsigned SC_IDX_W         = $clog2(SC_ENTRIES_TABLE);
    localparam int unsigned SC_CTR_W         = 6;
    localparam int unsigned SC_HIST_LEN_0 = 0;
    localparam int unsigned SC_HIST_LEN_1 = 4;
    localparam int unsigned SC_HIST_LEN_2 = 10;
    localparam int unsigned SC_HIST_LEN_3 = 16;
    localparam int unsigned SC_HIST_LEN_4 = 27;
    localparam int unsigned SC_HIST_LEN_5 = 44;
    function automatic int unsigned sc_hist_len(input int unsigned table_id);
        case (table_id)
            32'd0:   sc_hist_len = 32'd0;
            32'd1:   sc_hist_len = 32'd4;
            32'd2:   sc_hist_len = 32'd10;
            32'd3:   sc_hist_len = 32'd16;
            32'd4:   sc_hist_len = 32'd27;
            32'd5:   sc_hist_len = 32'd44;
            default: sc_hist_len = 32'd0;
        endcase
    endfunction
    // SC threshold counter for taking the corrector's verdict. Updated by
    // the SC update path when TAGE's confidence is low.
    localparam int unsigned SC_THRESH_INIT = 6;
    localparam int unsigned SC_THRESH_MIN  = 4;
    localparam int unsigned SC_THRESH_MAX  = 31;
    localparam logic signed [5:0] SC_TC_LIMIT = 6'sd12;
    localparam int unsigned SC_LOCAL_HISTORY_BITS = 8;
    localparam int unsigned SC_LOCAL_HISTORY_ENTRIES = 1024;
    localparam int unsigned SC_LOCAL_HISTORY_IDX_W = $clog2(SC_LOCAL_HISTORY_ENTRIES);
    localparam int unsigned SC_BIAS_ENABLE  = 0;
    localparam int unsigned SC_BIAS_ENTRIES = 2048;
    localparam int unsigned SC_BIAS_IDX_W   = $clog2(SC_BIAS_ENTRIES);
    localparam int unsigned SC_BIAS_CTR_W   = 5;

    // H2P/perceptron-style neural direction sidecar. This is a late,
    // threshold-gated corrector behind TAGE/SC that is trained on resolved
    // conditionals and can override when its signed margin is strong enough.
    localparam int unsigned H2P_ENABLE = 1;
    localparam int unsigned H2P_ENTRIES = 512;
    localparam int unsigned H2P_IDX_W = $clog2(H2P_ENTRIES);
    localparam int unsigned H2P_HIST_LEN = 64;
    localparam int unsigned H2P_TARGET_HIST_LEN = 0;
    localparam int unsigned H2P_PATH_HIST_LEN = 0;
    localparam int unsigned H2P_FEATURES =
        H2P_HIST_LEN + H2P_TARGET_HIST_LEN + H2P_PATH_HIST_LEN;
    localparam int unsigned H2P_WEIGHT_W = 6;
    localparam int unsigned H2P_SCORE_W = 16;
    localparam int unsigned H2P_THRESHOLD = 36;
    localparam int unsigned H2P_META_ENABLE = 0;
    localparam int unsigned H2P_META_ENTRIES = 1024;
    localparam int unsigned H2P_META_IDX_W = $clog2(H2P_META_ENTRIES);
    localparam int unsigned H2P_META_CTR_W = 3;
    localparam int unsigned H2P_META_THRESHOLD = 1;

    // Short per-PC local direction corrector. This catches compact patterns
    // such as T/N alternation that may take longer for global TAGE/SC to learn.
    localparam int unsigned LOCAL_DIR_ENABLE = 1;
    localparam int unsigned LOCAL_DIR_ENTRIES = 1024;
    localparam int unsigned LOCAL_DIR_IDX_W = $clog2(LOCAL_DIR_ENTRIES);
    localparam int unsigned LOCAL_DIR_HIST_W = 2;
    localparam int unsigned LOCAL_DIR_PHT_ENTRIES = 4;
    localparam int unsigned LOCAL_DIR_META_ENABLE = 1;
    localparam int unsigned LOCAL_DIR_META_ENTRIES = 1024;
    localparam int unsigned LOCAL_DIR_META_IDX_W = $clog2(LOCAL_DIR_META_ENTRIES);
    localparam int unsigned LOCAL_DIR_META_CTR_W = 3;
    localparam int unsigned LOCAL_DIR_META_THRESHOLD = 1;

    // ------------------------------------------------------------------
    // Loop predictor
    // ------------------------------------------------------------------
    localparam int unsigned LOOP_ENTRIES = 64;
    localparam int unsigned LOOP_IDX_W   = $clog2(LOOP_ENTRIES);
    localparam int unsigned LOOP_TAG_W   = 14;
    localparam int unsigned LOOP_PATH_SIG_W = 8;
    localparam int unsigned LOOP_IMLI_ENABLE = 0;
    localparam int unsigned LOOP_IMLI_HIST_W = 16;
    localparam int unsigned LOOP_IMLI_TOKEN_W = 4;
    localparam int unsigned LOOP_CTR_W   = 14;          // up to 2^14 iterations
    localparam int unsigned LOOP_CONF_W  = 3;

    // ------------------------------------------------------------------
    // RAS (Return Address Stack)
    // ------------------------------------------------------------------
    localparam int unsigned RAS_ARCH_ENTRIES = 32;      // architectural depth
    localparam int unsigned RAS_SPEC_ENTRIES = 64;      // speculative depth
    localparam int unsigned RAS_OVERFLOW_W   = 3;       // per-entry overflow ctr
    localparam int unsigned RAS_IDX_W        = $clog2(RAS_SPEC_ENTRIES);
    // Small tagged backup for returns that do not follow the live speculative
    // stack. It is intentionally separate from ITTAGE so return streams do not
    // pollute indirect-target storage.
    localparam int unsigned RAS_FALLBACK_ENTRIES = 128;
    localparam int unsigned RAS_FALLBACK_IDX_W   = $clog2(RAS_FALLBACK_ENTRIES);
    localparam int unsigned RAS_FALLBACK_TAG_W   = 16;
    localparam int unsigned RAS_FALLBACK_CONF_W  = 2;

    // ------------------------------------------------------------------
    // ITTAGE indirect predictor
    // ------------------------------------------------------------------
    // 5 tables x {1024, 1024, 2048, 2048, 2048} = 8 192 entries total,
    // implemented as 2-way set-associative storage to reduce hot indirect
    // target aliasing in GPU-driver and runtime dispatch tables.
    // The expanded 50K capped sweep ranked this capacity bump first
    // (weighted MPKI 18.9779 vs baseline 19.0904) after adding GPU driver,
    // runtime queue, inline-cache, and allocator/GC stressors.
    localparam int unsigned ITTAGE_TABLES = 5;
    localparam int unsigned ITTAGE_ENTRIES_0 = 1024;
    localparam int unsigned ITTAGE_ENTRIES_1 = 1024;
    localparam int unsigned ITTAGE_ENTRIES_2 = 2048;
    localparam int unsigned ITTAGE_ENTRIES_3 = 2048;
    localparam int unsigned ITTAGE_ENTRIES_4 = 2048;
    localparam int unsigned ITTAGE_WAYS = 2;
    localparam int unsigned ITTAGE_HIST_LEN_0 = 4;
    localparam int unsigned ITTAGE_HIST_LEN_1 = 10;
    localparam int unsigned ITTAGE_HIST_LEN_2 = 20;
    localparam int unsigned ITTAGE_HIST_LEN_3 = 40;
    localparam int unsigned ITTAGE_HIST_LEN_4 = 80;
    function automatic int unsigned ittage_entries(input int unsigned table_id);
        case (table_id)
            32'd0:   ittage_entries = 32'd1024;
            32'd1:   ittage_entries = 32'd1024;
            32'd2:   ittage_entries = 32'd2048;
            32'd3:   ittage_entries = 32'd2048;
            32'd4:   ittage_entries = 32'd2048;
            default: ittage_entries = 32'd0;
        endcase
    endfunction
    function automatic int unsigned ittage_sets(input int unsigned table_id);
        ittage_sets = ittage_entries(table_id) / ITTAGE_WAYS;
    endfunction
    function automatic int unsigned ittage_hist_len(input int unsigned table_id);
        case (table_id)
            32'd0:   ittage_hist_len = 32'd4;
            32'd1:   ittage_hist_len = 32'd10;
            32'd2:   ittage_hist_len = 32'd20;
            32'd3:   ittage_hist_len = 32'd40;
            32'd4:   ittage_hist_len = 32'd80;
            default: ittage_hist_len = 32'd0;
        endcase
    endfunction
    localparam int unsigned ITTAGE_TAG_W = 11;
    localparam int unsigned ITTAGE_CTR_W = 3;
    localparam int unsigned ITTAGE_USEFUL_W = 2;
    localparam int unsigned ITTAGE_USEFUL_RESET_PERIOD = 100000;
    localparam int unsigned ITTAGE_REPLACE_WEAK_CTR = 3;
    localparam int unsigned ITTAGE_REPLACE_MIN_PROVIDER = 4;
    localparam int unsigned ITTAGE_TARGET_HISTORY_BITS = 64;
    localparam int unsigned ITTAGE_TARGET_HISTORY_TOKEN_BITS = 5;
    localparam int unsigned ITTAGE_TARGET_HISTORY_SHIFT = 8;
    localparam int unsigned ITTAGE_PATH_HISTORY_BITS = 64;
    localparam int unsigned ITTAGE_PATH_HISTORY_TOKEN_BITS = 8;
    localparam int unsigned ITTAGE_PATH_HISTORY_SHIFT = 2;

    // ------------------------------------------------------------------
    // Performance Monitoring Unit (Zihpm) event encoding
    // ------------------------------------------------------------------
    // These IDs are arranged so that mapping into zihpm_pkg::hpm_event_e is a
    // pure +1 offset (zihpm reserves id 0 for the "no event" sentinel). The
    // BPU agent owns the source for events 0..25 here, exported as zihpm
    // events 1..26; the translation is encoded in `bpu_pmu_to_hpm()` below
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
        PMU_SC_OVERRIDE    = 5'd19,  // zihpm EVT_SC_OVERRIDE    = 8'd20
        PMU_H2P_OVERRIDE   = 5'd20,  // zihpm EVT_H2P_OVERRIDE   = 8'd21
        PMU_L2_FTB_HIT     = 5'd21,  // zihpm EVT_L2_BTB_HIT     = 8'd22
        PMU_L2_FTB_MISS    = 5'd22,  // zihpm EVT_L2_BTB_MISS    = 8'd23
        PMU_TWO_AHEAD_REDIRECT = 5'd23, // zihpm EVT_TWO_AHEAD_REDIRECT = 8'd24
        PMU_LOCAL_DIR_OVERRIDE = 5'd24, // zihpm EVT_LOCAL_DIR_OVERRIDE = 8'd25
        PMU_META_TRAIN     = 5'd25   // zihpm EVT_BPU_META_TRAIN = 8'd26
    } pmu_event_e;

    localparam int unsigned PMU_EVENTS = 26;
    localparam int unsigned PMU_COUNTER_W = 64;

    // Translation helper: convert a BPU-domain PMU event id to the matching
    // zihpm event id. Lockstep contract with rtl/cpu/csr/zihpm.sv.
    function automatic logic [7:0] bpu_pmu_to_hpm(input logic [4:0] pmu_id);
        bpu_pmu_to_hpm = {3'b000, pmu_id} + 8'd1;
    endfunction

    // ------------------------------------------------------------------
    // BPU integration types
    // ------------------------------------------------------------------
    // Branch kind. `BR_IND` is an indirect jump that does NOT push the RAS,
    // distinct from `BR_CALL`; `BR_DIRECT` is an unconditional direct branch
    // that uses target-array state but must not train conditional direction
    // predictors.
    //
    // Numeric values are stable across revisions:
    //   BR_NONE = 0, BR_COND = 1, BR_CALL = 2, BR_RET = 3, BR_IND = 4,
    //   BR_DIRECT = 5.
    // The Python model in benchmarks/cpu/branch/bpu_model.py uses the
    // same numeric encoding.
    typedef enum logic [2:0] {
        BR_NONE   = 3'd0,
        BR_COND   = 3'd1,
        BR_CALL   = 3'd2,
        BR_RET    = 3'd3,
        BR_IND    = 3'd4,
        BR_DIRECT = 3'd5
    } br_kind_e;

    typedef struct packed {
        logic [BPU_ASID_W-1:0] asid;
        logic [BPU_VMID_W-1:0] vmid;
        logic [BPU_PRIV_W-1:0] priv;
        logic                  secure;
        logic [BPU_WORKLOAD_CLASS_W-1:0] workload_class;
    } bpu_context_t;

    function automatic bpu_context_t bpu_default_context();
        bpu_default_context = '0;
    endfunction

    function automatic logic [BPU_CONTEXT_HASH_W-1:0] bpu_context_hash(
        input bpu_context_t ctx
    );
        logic [BPU_CONTEXT_HASH_W-1:0] folded;
        folded = '0;
        folded[BPU_ASID_W-1:0] = ctx.asid;
        folded[BPU_CONTEXT_HASH_W-1 -: BPU_VMID_W] =
            folded[BPU_CONTEXT_HASH_W-1 -: BPU_VMID_W] ^ ctx.vmid;
        folded[BPU_PRIV_W-1:0] = folded[BPU_PRIV_W-1:0] ^ ctx.priv;
        folded[0] = folded[0] ^ ctx.secure;
        folded[BPU_WORKLOAD_CLASS_W:1] =
            folded[BPU_WORKLOAD_CLASS_W:1] ^ ctx.workload_class;
        bpu_context_hash = folded;
    endfunction

    function automatic logic [VADDR_W-1:0] bpu_context_pc(
        input logic [VADDR_W-1:0] pc,
        input bpu_context_t ctx
    );
        logic [BPU_CONTEXT_HASH_W-1:0] ctx_hash;
        bpu_context_pc = pc;
        ctx_hash = bpu_context_hash(ctx);
        for (int unsigned i = FETCH_BLOCK_OFF_W; i < VADDR_W; i++) begin
            bpu_context_pc[i] = pc[i] ^ ctx_hash[(i - FETCH_BLOCK_OFF_W) %
                                                  BPU_CONTEXT_HASH_W];
        end
    endfunction

    typedef struct packed {
        logic         valid;
        logic         context_valid;
        bpu_context_t ctx;
    } bpu_flush_t;

    typedef struct packed {
        logic [VADDR_W-1:0]              target_pc;
        logic [VADDR_W-1:0]              fall_through_pc;
        logic [FTB_TARGET_CONF_W-1:0]    target_conf;
        logic [FETCH_BLOCK_OFF_W-1:0]    offset;
        br_kind_e                        kind;
        logic                            valid;
    } bpu_branch_slot_t;

    typedef struct packed {
        logic [VADDR_W-1:0]              start_pc;
        logic [VADDR_W-1:0]              end_pc;
        logic [VADDR_W-1:0]              target_pc;
        logic [FETCH_BLOCK_OFF_W-1:0]    branch_offset;
        logic [$clog2(MAX_BR_PER_BLOCK)-1:0] slot_idx;
        logic                            taken;
        logic                            valid;
    } bpu_fetch_segment_t;

    // A single FTQ entry describes one predicted fetch block of up to
    // FETCH_BLOCK_BYTES bytes. The predicted block extends from start_pc
    // through end_pc inclusive; if `taken` is asserted, the predicted target
    // for the next block is `target_pc`. `fetch_segments` is the forward
    // contract for non-contiguous fetch: each valid segment describes the
    // contiguous bytes consumed before a predicted redirect, including the
    // branch slot that ended the segment.
    // Up to MAX_BR_PER_BLOCK branches are recorded so the resolver can
    // validate redirection.
    typedef struct packed {
        logic                     valid;
        bpu_context_t             ctx;
        logic [VADDR_W-1:0]       start_pc;
        logic [VADDR_W-1:0]       end_pc;
        logic [VADDR_W-1:0]       target_pc;
        logic                     taken;
        br_kind_e                 kind;
        bpu_fetch_segment_t [MAX_BR_PER_BLOCK-1:0] fetch_segments;
        logic [MAX_BR_PER_BLOCK-1:0] br_taken_mask;
        bpu_branch_slot_t [MAX_BR_PER_BLOCK-1:0] br_slots;
        logic [FTQ_IDX_W-1:0]     ftq_idx;
        // Snapshot fields used by the update path on redirect.
        logic [RAS_IDX_W:0]       ras_spec_top;
        logic                     ras_restore_valid;
        logic [VADDR_W-1:0]       ras_restore_addr;
        logic [TAGE_HIST_LEN_MAX-1:0] ghist_snapshot;
        logic [TAGE_HIST_LEN_MAX-1:0] ittage_hist_snapshot;
        logic [TAGE_HIST_LEN_MAX-1:0] ittage_target_hist_snapshot;
        logic [TAGE_HIST_LEN_MAX-1:0] ittage_path_hist_snapshot;
        logic [$clog2(TAGE_TABLES+1)-1:0]   tage_provider;
        logic [$clog2(ITTAGE_TABLES+1)-1:0] ittage_provider;
        logic [TAGE_CTR_W-1:0]     tage_provider_ctr;
        logic                      tage_lowconf;
        logic                      tage_provider_taken;
        logic                      tage_alt_taken;
        logic                      sc_override;
        logic                      sc_taken;
        logic                      h2p_conf;
        logic                      h2p_taken;
        logic                      local_dir_conf;
        logic                      local_dir_taken;
        logic                      local_dir_train_valid;
        logic                      local_dir_base_taken;
    } ftq_entry_t;

    // Lookup response bundled out of bpu_top.
    typedef struct packed {
        logic                 valid;
        bpu_context_t         ctx;
        logic [VADDR_W-1:0]   start_pc;
        logic [VADDR_W-1:0]   target_pc;
        logic                 taken;
        br_kind_e             kind;
        bpu_fetch_segment_t [MAX_BR_PER_BLOCK-1:0] fetch_segments;
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
    //
    // `actual_call_return_pc` is the architectural fall-through address of
    // a call instruction (the PC the matching RET is expected to target).
    // For RV64 / ARM64 traces this is `pc + 4`; for RVC it is `pc + 2`.
    // Block-grained predictors cannot derive this from the block start_pc
    // alone because the call may not be the last instruction in the block.
    // Only consumed when `actual_kind == BR_CALL`.
    //
    // `ras_restore_top` is the speculative RAS stack pointer checkpoint
    // captured in the FTQ entry for the resolved prediction. Redirect
    // recovery must restore to this checkpoint, not to the live speculative
    // top, because younger predicted calls/returns may have already mutated
    // the live stack by the time the branch resolves.
    //
    // Predictor update metadata is replayed from the resolved FTQ entry at
    // commit time. Resolves injected without a matching FTQ prediction fall
    // back to architectural history and base-provider update semantics.
    typedef struct packed {
        logic                 valid;
        bpu_context_t         ctx;
        logic                 misprediction;
        logic [VADDR_W-1:0]   pc;
        logic [VADDR_W-1:0]   actual_target;
        logic [VADDR_W-1:0]   actual_call_return_pc;
        logic                 actual_taken;
        br_kind_e             actual_kind;
        logic [FTQ_IDX_W-1:0] ftq_idx;
        logic [RAS_IDX_W:0]   ras_restore_top;
        logic                 ras_restore_valid;
        logic [VADDR_W-1:0]   ras_restore_addr;
    } bpu_resolve_t;

    // Cumulative PMU counter bundle.
    typedef struct packed {
        logic [PMU_COUNTER_W-1:0] count;
    } pmu_counter_t;

endpackage : bpu_pkg
/* verilator lint_on UNUSEDPARAM */

`endif // BPU_PKG_SV
