// bpu_top.sv — decoupled Branch Prediction Unit top-level integration.
//
// Wires together uFTB, FTB, TAGE-SC-L, ITTAGE, RAS, and Loop predictor;
// owns the global history register and the FTQ; emits the integrated
// prediction onto the BPU/fetch interface; consumes the resolver feedback
// from the back-end; aggregates PMU strobes into bpu_csr.
//
// Pipeline (logical, before retiming):
//   Stage 0: uFTB lookup with PC drives next-cycle PC. Drives prefetch hint.
//   Stage 1: FTB lookup, TAGE/SC/ITTAGE/Loop reads.
//   Stage 2: Direction arbitration (TAGE -> SC override -> Loop override),
//            RAS push/pop for call/return, FTQ enqueue.
//
// At MVP fidelity the three stages are flattened into a single cycle behind
// `bpu_pred_valid`; the FTQ provides the decoupling between BPU and fetch.
// PD/timing closure can split the stages without changing this interface.

`timescale 1ns/1ps

module bpu_top
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    // BPU lookup PC. Driven by the redirect mux: reset PC at boot, the
    // predicted next PC from the FTQ tail otherwise, the resolver target on
    // misprediction.
    input  logic                lkp_valid,
    input  logic [VADDR_W-1:0]  lkp_pc,
    input  bpu_context_t        lkp_context,
    output logic                pred_valid,
    output bpu_lookup_t         pred,
    output logic [MAX_BR_PER_BLOCK-1:0] pred_redirect_valid,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] pred_redirect_pc,
    output logic [MAX_BR_PER_BLOCK-1:0][2:0] pred_redirect_kind,

    // Fetch consumer.
    input  logic                fetch_pop,
    output logic                fetch_valid,
    output ftq_entry_t          fetch_entry,
    output logic                late_redirect_valid,
    output logic [VADDR_W-1:0]  late_redirect_pc,
    output logic [FTQ_IDX_W-1:0] late_redirect_ftq_idx,
    output logic [MAX_BR_PER_BLOCK-1:0] late_redirect_valid_lanes,
    output logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] late_redirect_pc_lanes,
    output logic [MAX_BR_PER_BLOCK-1:0][FTQ_IDX_W-1:0] late_redirect_ftq_idx_lanes,

    // Resolver feedback.
    input  bpu_resolve_t        resolve,

    // Software/integration predictor invalidation. A global flush clears
    // volatile front-end queues, histories, RAS, and predictor entries; a
    // ctx-valid flush invalidates tagged target-array entries for one
    // domain while still blocking same-cycle updates.
    input  bpu_flush_t          predictor_flush,

    // CSR/PMU read port.
    input  logic                csr_re,
    input  logic [4:0]          csr_addr,
    output logic [63:0]         csr_rdata,

    // Top-level PMU strobes for SoC-level Zihpm aggregation.
    output logic [PMU_EVENTS-1:0] pmu_strb
);

    // -----------------------------------------------------------------------
    // Global history register. Shared between TAGE, ITTAGE, and SC.
    // Updated speculatively at prediction time and rolled back on
    // misprediction via the resolver feedback path.
    // -----------------------------------------------------------------------
    logic [TAGE_HIST_LEN_MAX-1:0] ghist_spec_q;
    logic [TAGE_HIST_LEN_MAX-1:0] ghist_arch_q;
    localparam int unsigned ITTAGE_TARGET_HISTORY_PAD =
        TAGE_HIST_LEN_MAX - ITTAGE_TARGET_HISTORY_BITS;
    localparam int unsigned ITTAGE_PATH_HISTORY_PHYS_BITS = 64;
    localparam int unsigned ITTAGE_PATH_HISTORY_PAD =
        TAGE_HIST_LEN_MAX - ITTAGE_PATH_HISTORY_PHYS_BITS;
    logic [ITTAGE_TARGET_HISTORY_BITS-1:0] ittage_target_hist_spec_q;
    logic [ITTAGE_TARGET_HISTORY_BITS-1:0] ittage_target_hist_arch_q;
    logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] ittage_path_hist_spec_q;
    logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] ittage_path_hist_arch_q;
    logic [TAGE_HIST_LEN_MAX-1:0] ittage_target_hist_spec_ext;
    logic [TAGE_HIST_LEN_MAX-1:0] ittage_target_hist_arch_ext;
    logic [TAGE_HIST_LEN_MAX-1:0] ittage_path_hist_spec_ext;
    logic [TAGE_HIST_LEN_MAX-1:0] ittage_path_hist_arch_ext;
    logic [TAGE_HIST_LEN_MAX-1:0] ittage_lkp_hist;
    logic [TAGE_HIST_LEN_MAX-1:0] ittage_upd_hist;
    /* verilator lint_off UNUSEDSIGNAL */
    ftq_entry_t                   ftq_replay_entry;
    /* verilator lint_on UNUSEDSIGNAL */
    logic                         ftq_replay_valid;
    logic [TAGE_HIST_LEN_MAX-1:0] replay_tage_hist;
    logic [TAGE_HIST_LEN_MAX-1:0] replay_ittage_hist;
    logic [$clog2(TAGE_TABLES+1)-1:0] replay_tage_provider;
    logic [$clog2(ITTAGE_TABLES+1)-1:0] replay_ittage_provider;
    logic                         replay_tage_lowconf;
    logic                         replay_tage_provider_taken;
    logic                         replay_tage_alt_taken;
    logic                         replay_sc_override;
    logic                         replay_h2p_conf;
    logic                         replay_h2p_taken;
    logic                         replay_local_dir_conf;
    logic                         replay_local_dir_taken;
    logic                         replay_local_dir_train_valid;
    logic                         replay_local_dir_base_taken;
    logic [RAS_IDX_W:0]           replay_ras_restore_top;
    logic                         replay_ras_restore_valid;
    logic [VADDR_W-1:0]           replay_ras_restore_addr;
    logic [TAGE_HIST_LEN_MAX-1:0] redirect_ghist_spec;
    logic [ITTAGE_TARGET_HISTORY_BITS-1:0] redirect_target_hist_spec;
    logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] redirect_path_hist_spec;
    logic                         push_ready;
    logic                         lkp_fire;
    logic [FTQ_IDX_W:0]           ftq_push_ptr;
    ftq_entry_t                   ftq_patch_entry;
    logic                         ftq_patch_applied;
    logic                         resolve_update_valid;
    logic [VADDR_W-1:0]           lkp_context_pc;
    logic [VADDR_W-1:0]           resolve_context_pc;
    logic [VADDR_W-1:0]           ftb_first_slot_context_pc;
    logic [VADDR_W-1:0]           second_slot_context_pc;
    logic [VADDR_W-1:0]           l2_first_slot_context_pc;

    assign lkp_fire = lkp_valid && push_ready;
    assign resolve_update_valid = resolve.valid && !predictor_flush.valid;
    assign lkp_context_pc = bpu_context_pc(lkp_pc, lkp_context);
    assign resolve_context_pc = bpu_context_pc(resolve.pc, resolve.ctx);

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [ITTAGE_TARGET_HISTORY_BITS-1:0] ittage_target_hist_push(
        input logic [ITTAGE_TARGET_HISTORY_BITS-1:0] hist,
        input logic [VADDR_W-1:0] target
    );
        logic [ITTAGE_TARGET_HISTORY_TOKEN_BITS-1:0] token;
        token = target[ITTAGE_TARGET_HISTORY_SHIFT +: ITTAGE_TARGET_HISTORY_TOKEN_BITS];
        ittage_target_hist_push =
            {token, hist[ITTAGE_TARGET_HISTORY_BITS-1:ITTAGE_TARGET_HISTORY_TOKEN_BITS]};
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] ittage_path_hist_push(
        input logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] hist,
        input logic [VADDR_W-1:0] pc
    );
        logic [ITTAGE_PATH_HISTORY_TOKEN_BITS-1:0] token;
        token = '0;
        for (int unsigned i = ITTAGE_PATH_HISTORY_SHIFT; i < VADDR_W; i++) begin
            token[(i - ITTAGE_PATH_HISTORY_SHIFT) % ITTAGE_PATH_HISTORY_TOKEN_BITS] =
                token[(i - ITTAGE_PATH_HISTORY_SHIFT) % ITTAGE_PATH_HISTORY_TOKEN_BITS] ^ pc[i];
        end
        ittage_path_hist_push = {token, hist[ITTAGE_PATH_HISTORY_PHYS_BITS-1:ITTAGE_PATH_HISTORY_TOKEN_BITS]};
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [LOOP_PATH_SIG_W-1:0] loop_path_signature(
        input logic [TAGE_HIST_LEN_MAX-1:0] context_hist,
        input logic [VADDR_W-1:0] pc
    );
        logic [LOOP_PATH_SIG_W-1:0] folded;
        folded = pc[2 +: LOOP_PATH_SIG_W] ^ pc[10 +: LOOP_PATH_SIG_W];
        for (int unsigned k = 0; k < TAGE_HIST_LEN_MAX; k++) begin
            folded[k % LOOP_PATH_SIG_W] =
                folded[k % LOOP_PATH_SIG_W] ^ context_hist[k];
        end
        loop_path_signature = folded;
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    /* verilator lint_off UNUSEDSIGNAL */
    function automatic logic [ITTAGE_TARGET_HISTORY_BITS-1:0] ittage_target_hist_from_ext(
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        ittage_target_hist_from_ext = hist[TAGE_HIST_LEN_MAX-1 -: ITTAGE_TARGET_HISTORY_BITS];
    endfunction

    function automatic logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] ittage_path_hist_from_ext(
        input logic [TAGE_HIST_LEN_MAX-1:0] hist
    );
        ittage_path_hist_from_ext = hist[TAGE_HIST_LEN_MAX-1 -: ITTAGE_PATH_HISTORY_PHYS_BITS];
    endfunction
    /* verilator lint_on UNUSEDSIGNAL */

    assign ittage_target_hist_spec_ext =
        {ittage_target_hist_spec_q, {ITTAGE_TARGET_HISTORY_PAD{1'b0}}};
    assign ittage_target_hist_arch_ext =
        {ittage_target_hist_arch_q, {ITTAGE_TARGET_HISTORY_PAD{1'b0}}};
    assign ittage_path_hist_spec_ext =
        (ITTAGE_PATH_HISTORY_BITS == 0) ? '0 :
        {ittage_path_hist_spec_q, {ITTAGE_PATH_HISTORY_PAD{1'b0}}};
    assign ittage_path_hist_arch_ext =
        (ITTAGE_PATH_HISTORY_BITS == 0) ? '0 :
        {ittage_path_hist_arch_q, {ITTAGE_PATH_HISTORY_PAD{1'b0}}};
    assign ittage_lkp_hist =
        ghist_spec_q ^
        ittage_target_hist_spec_ext ^
        ittage_path_hist_spec_ext;
    assign ittage_upd_hist =
        ghist_arch_q ^
        ittage_target_hist_arch_ext ^
        ittage_path_hist_arch_ext;
    assign ftq_replay_valid =
        ftq_replay_entry.valid &&
        (ftq_replay_entry.ctx == resolve.ctx) &&
        (ftq_replay_entry.ftq_idx == resolve.ftq_idx) &&
        (resolve.pc >= ftq_replay_entry.start_pc) &&
        (resolve.pc <= ftq_replay_entry.end_pc);
    assign replay_tage_hist =
        ftq_replay_valid ? ftq_replay_entry.ghist_snapshot : ghist_arch_q;
    assign replay_ittage_hist =
        ftq_replay_valid ? ftq_replay_entry.ittage_hist_snapshot : ittage_upd_hist;
    assign replay_tage_provider =
        ftq_replay_valid ? ftq_replay_entry.tage_provider : '0;
    assign replay_ittage_provider =
        ftq_replay_valid ? ftq_replay_entry.ittage_provider : '0;
    assign replay_tage_provider_taken =
        ftq_replay_valid ? ftq_replay_entry.tage_provider_taken : resolve.actual_taken;
    assign replay_tage_alt_taken =
        ftq_replay_valid ? ftq_replay_entry.tage_alt_taken : resolve.actual_taken;
    assign replay_sc_override =
        ftq_replay_valid ? ftq_replay_entry.sc_override : 1'b0;
    assign replay_h2p_conf =
        ftq_replay_valid ? ftq_replay_entry.h2p_conf : 1'b0;
    assign replay_h2p_taken =
        ftq_replay_valid ? ftq_replay_entry.h2p_taken : resolve.actual_taken;
    assign replay_local_dir_conf =
        ftq_replay_valid ? ftq_replay_entry.local_dir_conf : 1'b0;
    assign replay_local_dir_taken =
        ftq_replay_valid ? ftq_replay_entry.local_dir_taken : resolve.actual_taken;
    assign replay_local_dir_train_valid =
        ftq_replay_valid ? ftq_replay_entry.local_dir_train_valid : 1'b0;
    assign replay_local_dir_base_taken =
        ftq_replay_valid ? ftq_replay_entry.local_dir_base_taken : replay_tage_provider_taken;
    assign replay_ras_restore_top =
        ftq_replay_valid ? ftq_replay_entry.ras_spec_top : resolve.ras_restore_top;
    assign replay_ras_restore_valid =
        ftq_replay_valid ? ftq_replay_entry.ras_restore_valid : resolve.ras_restore_valid;
    assign replay_ras_restore_addr =
        ftq_replay_valid ? ftq_replay_entry.ras_restore_addr : resolve.ras_restore_addr;

    always_comb begin
        redirect_ghist_spec = replay_tage_hist;
        if (resolve.actual_kind == BR_COND) begin
            redirect_ghist_spec = {replay_tage_hist[TAGE_HIST_LEN_MAX-2:0],
                                   resolve.actual_taken};
        end

        redirect_target_hist_spec = ftq_replay_valid ?
            ittage_target_hist_from_ext(ftq_replay_entry.ittage_target_hist_snapshot) :
            ittage_target_hist_arch_q;
        if (resolve.actual_kind == BR_CALL || resolve.actual_kind == BR_IND) begin
            redirect_target_hist_spec =
                ittage_target_hist_push(redirect_target_hist_spec, resolve.actual_target);
        end

        redirect_path_hist_spec = ftq_replay_valid ?
            ittage_path_hist_from_ext(ftq_replay_entry.ittage_path_hist_snapshot) :
            ittage_path_hist_arch_q;
        if (ITTAGE_PATH_HISTORY_BITS != 0 && resolve.actual_kind != BR_NONE) begin
            redirect_path_hist_spec =
                ittage_path_hist_push(redirect_path_hist_spec, resolve.pc);
        end
    end

    // -----------------------------------------------------------------------
    // Sub-block instantiations
    // -----------------------------------------------------------------------
    logic                  uftb_hit;
    logic [VADDR_W-1:0]    uftb_next_pc;
    logic [VADDR_W-1:0]    uftb_fall_through_pc;
    br_kind_e              uftb_kind;
    logic [FTB_TARGET_CONF_W-1:0] uftb_conf;
    logic                  uftb_steer_hit;
    logic                  uftb_pmu_hit;

    uftb u_uftb (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_fire),
        .lkp_pc     (lkp_pc),
        .lkp_context(lkp_context),
        .lkp_hit    (uftb_hit),
        .lkp_next_pc(uftb_next_pc),
        .lkp_fall_through_pc(uftb_fall_through_pc),
        .lkp_kind   (uftb_kind),
        .lkp_conf   (uftb_conf),
        .upd_valid  (resolve_update_valid && resolve.actual_taken &&
                      resolve.actual_kind != BR_NONE),
        .upd_pc     (resolve.pc),
        .upd_context(resolve.ctx),
        .upd_next_pc(resolve.actual_target),
        .upd_fall_through_pc(resolve.actual_call_return_pc),
        .upd_kind   (resolve.actual_kind),
        .flush_valid(predictor_flush.valid),
        .flush_context_valid(predictor_flush.context_valid),
        .flush_context(predictor_flush.ctx),
        .test_corrupt_parity_valid(1'b0),
        .test_corrupt_parity_idx('0),
        .test_corrupt_parity_way('0),
        .pmu_hit    (uftb_pmu_hit)
    );

    assign uftb_steer_hit =
        uftb_hit && (uftb_conf >= FTB_TARGET_CONF_W'(UFTB_STEER_CONF_MIN));

    logic                  ftb_hit;
    logic [VADDR_W-1:0]    ftb_target;
    logic [FTB_TARGET_CONF_W-1:0] ftb_target_conf;
    logic [VADDR_W-1:0]    ftb_fall_through_pc;
    br_kind_e              ftb_kind;
    // FTB returns up to MAX_BR_PER_BLOCK valid branch slots per fetch block.
    // Reserved for the two-taken-per-cycle extension (BLOCKED until the
    // dual-port FTB read path is implemented per docs/arch/branch-prediction.md).
    /* verilator lint_off UNUSEDSIGNAL */
    logic [MAX_BR_PER_BLOCK-1:0] ftb_br_valid;
    /* verilator lint_on UNUSEDSIGNAL */
    logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] ftb_slot_offset;
    logic [MAX_BR_PER_BLOCK-1:0][2:0] ftb_slot_kind;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] ftb_slot_target;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] ftb_slot_fall_through_pc;
    logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] ftb_slot_target_conf;
    logic                  ftb2_hit;
    logic [VADDR_W-1:0]    ftb2_target;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [FTB_TARGET_CONF_W-1:0] ftb2_target_conf;
    logic [VADDR_W-1:0]    ftb2_fall_through_pc;
    /* verilator lint_on UNUSEDSIGNAL */
    br_kind_e              ftb2_kind;
    logic [MAX_BR_PER_BLOCK-1:0] ftb2_br_valid;
    logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] ftb2_slot_offset;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [MAX_BR_PER_BLOCK-1:0][2:0] ftb2_slot_kind;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] ftb2_slot_target;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] ftb2_slot_fall_through_pc;
    logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] ftb2_slot_target_conf;
    /* verilator lint_on UNUSEDSIGNAL */
    logic                  ftb2_lkp_valid;
    logic [VADDR_W-1:0]    ftb2_lkp_pc;
    logic [VADDR_W-1:0]    ftb2_first_slot_pc;
    logic [VADDR_W-1:0]    ftb2_first_slot_context_pc;
    logic [FETCH_BLOCK_OFF_W-1:0] ftb2_first_slot_offset;
    logic                  ftb2_first_slot_seen;
    logic                  ftb2_redirect_valid;
    logic [VADDR_W-1:0]    ftb2_redirect_pc;
    logic                  ftb2_cond_bim_taken;
    logic [BIM_CTR_W-1:0]  ftb2_cond_bim_ctr;
    logic                  ftb2_cond_strong_taken;
    logic                  ftb2_ret_redirect_valid;
    logic [VADDR_W-1:0]    ftb2_ret_redirect_pc;
    logic                  ftb_pmu_miss;
    logic [FETCH_BLOCK_OFF_W-1:0] ftb_first_slot_offset;
    logic                  ftb_first_slot_seen;
    logic [VADDR_W-1:0]    ftb_first_slot_pc;
    logic [VADDR_W-1:0]    ftb_first_slot_fall_through_pc;
    logic [MAX_BR_PER_BLOCK-1:0] ftb_first_slot_mask;
    logic                  l2_req_valid_q;
    logic [VADDR_W-1:0]    l2_req_pc_q;
    bpu_context_t          l2_req_context_q;
    logic [FTQ_IDX_W:0]    l2_req_ftq_ptr_q;
    logic [7:0]            l2_req_epoch_q;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [TAGE_HIST_LEN_MAX-1:0] l2_req_ghist_snapshot_q;
    /* verilator lint_on UNUSEDSIGNAL */
    logic [ITTAGE_TARGET_HISTORY_BITS-1:0] l2_req_target_hist_snapshot_q;
    logic [ITTAGE_PATH_HISTORY_PHYS_BITS-1:0] l2_req_path_hist_snapshot_q;
    logic [RAS_IDX_W:0]    l2_req_ras_top_q;
    logic                  l2_req_ras_top_valid_q;
    logic [VADDR_W-1:0]    l2_req_ras_top_addr_q;
    logic                  l2_req_uftb_ret_popped_q;
    logic [7:0]            bpu_epoch_q;
    logic                  l2_ftb_hit;
    logic [VADDR_W-1:0]    l2_ftb_target;
    logic [FTB_TARGET_CONF_W-1:0] l2_ftb_target_conf;
    logic [VADDR_W-1:0]    l2_ftb_fall_through_pc;
    br_kind_e              l2_ftb_kind;
    logic [MAX_BR_PER_BLOCK-1:0] l2_ftb_br_valid;
    logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] l2_ftb_slot_offset;
    logic [MAX_BR_PER_BLOCK-1:0][2:0] l2_ftb_slot_kind;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] l2_ftb_slot_target;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] l2_ftb_slot_fall_through_pc;
    logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] l2_ftb_slot_target_conf;
    /* verilator lint_off UNUSEDSIGNAL */
    logic                  l2_ftb_pmu_miss;
    logic                  l2_ftb2_hit;
    logic [VADDR_W-1:0]    l2_ftb2_target;
    logic [FTB_TARGET_CONF_W-1:0] l2_ftb2_target_conf;
    logic [VADDR_W-1:0]    l2_ftb2_fall_through_pc;
    br_kind_e              l2_ftb2_kind;
    logic [MAX_BR_PER_BLOCK-1:0] l2_ftb2_br_valid;
    logic [MAX_BR_PER_BLOCK-1:0][FETCH_BLOCK_OFF_W-1:0] l2_ftb2_slot_offset;
    logic [MAX_BR_PER_BLOCK-1:0][2:0] l2_ftb2_slot_kind;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] l2_ftb2_slot_target;
    logic [MAX_BR_PER_BLOCK-1:0][VADDR_W-1:0] l2_ftb2_slot_fall_through_pc;
    logic [MAX_BR_PER_BLOCK-1:0][FTB_TARGET_CONF_W-1:0] l2_ftb2_slot_target_conf;
    /* verilator lint_on UNUSEDSIGNAL */
    logic                  l2_refill_valid;
    logic [FETCH_BLOCK_OFF_W-1:0] l2_first_slot_offset;
    logic                  l2_first_slot_seen;
    logic [VADDR_W-1:0]    l2_first_slot_pc;
    logic [MAX_BR_PER_BLOCK-1:0] l2_first_slot_mask;
    logic                  l2_late_redirect_candidate;
    logic                  l2_cond_bim_taken;
    logic [BIM_CTR_W-1:0]  l2_cond_bim_ctr;
    logic                  l2_cond_strong_taken;
    logic                  l2_ret_late_redirect_candidate;
    logic [VADDR_W-1:0]    l2_late_redirect_target;

    // R8: FTB allocates on every resolve, not just on misprediction. The
    // behavioural model (benchmarks/cpu/branch/bpu_model.py) writes its
    // FTB on every retired branch (`self.ftb.update(event.pc, ...)` in
    // every kind branch of `_step`). Gating allocation on misprediction
    // added ~7 500 structural cold-miss mispredictions on
    // `sample_int_trace` because the unique-branch working set is
    // ~7 500 PCs. Filtering BR_NONE keeps no-branch resolves out of the
    // FTB; the new gate matches the model and drops `ftb_miss` from
    // 7 985 to 418.
    ftb u_ftb (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_fire),
        .lkp_pc     (lkp_pc),
        .lkp_context(lkp_context),
        .lkp_hit    (ftb_hit),
        .lkp_target (ftb_target),
        .lkp_target_conf(ftb_target_conf),
        .lkp_fall_through_pc(ftb_fall_through_pc),
        .lkp_kind   (ftb_kind),
        .lkp_br_valid(ftb_br_valid),
        .lkp_slot_offset(ftb_slot_offset),
        .lkp_slot_kind(ftb_slot_kind),
        .lkp_slot_target(ftb_slot_target),
        .lkp_slot_fall_through_pc(ftb_slot_fall_through_pc),
        .lkp_slot_target_conf(ftb_slot_target_conf),
        .lkp2_valid (ftb2_lkp_valid),
        .lkp2_pc    (ftb2_lkp_pc),
        .lkp2_context(lkp_context),
        .lkp2_hit   (ftb2_hit),
        .lkp2_target(ftb2_target),
        .lkp2_target_conf(ftb2_target_conf),
        .lkp2_fall_through_pc(ftb2_fall_through_pc),
        .lkp2_kind  (ftb2_kind),
        .lkp2_br_valid(ftb2_br_valid),
        .lkp2_slot_offset(ftb2_slot_offset),
        .lkp2_slot_kind(ftb2_slot_kind),
        .lkp2_slot_target(ftb2_slot_target),
        .lkp2_slot_fall_through_pc(ftb2_slot_fall_through_pc),
        .lkp2_slot_target_conf(ftb2_slot_target_conf),
        .upd_valid  (resolve_update_valid && resolve.actual_kind != BR_NONE),
        .upd_pc     (resolve.pc),
        .upd_context(resolve.ctx),
        .upd_target (resolve.actual_target),
        .upd_fall_through_pc(resolve.actual_call_return_pc),
        .upd_kind   (resolve.actual_kind),
        .upd_br_valid({MAX_BR_PER_BLOCK{1'b1}}),
        .upd_alloc  (resolve_update_valid && resolve.actual_kind != BR_NONE),
        .refill_valid(l2_refill_valid),
        .refill_pc   (l2_req_pc_q),
        .refill_context(l2_req_context_q),
        .refill_target(l2_ftb_target),
        .refill_target_conf(l2_ftb_target_conf),
        .refill_fall_through_pc(l2_ftb_fall_through_pc),
        .refill_kind (l2_ftb_kind),
        .refill_br_valid(l2_ftb_br_valid),
        .refill_slot_offset(l2_ftb_slot_offset),
        .refill_slot_kind(l2_ftb_slot_kind),
        .refill_slot_target(l2_ftb_slot_target),
        .refill_slot_fall_through_pc(l2_ftb_slot_fall_through_pc),
        .refill_slot_target_conf(l2_ftb_slot_target_conf),
        .flush_valid(predictor_flush.valid),
        .flush_context_valid(predictor_flush.context_valid),
        .flush_context(predictor_flush.ctx),
        .test_corrupt_parity_valid(1'b0),
        .test_corrupt_parity_idx('0),
        .test_corrupt_parity_way('0),
        .pmu_miss   (ftb_pmu_miss)
    );

    ftb #(
        .ENTRIES(L2_FTB_ENTRIES),
        .WAYS   (L2_FTB_WAYS),
        .SETS   (L2_FTB_SETS),
        .IDX_W  (L2_FTB_IDX_W),
        .TAG_W  (L2_FTB_TAG_W)
    ) u_l2_ftb (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (l2_req_valid_q),
        .lkp_pc     (l2_req_pc_q),
        .lkp_context(l2_req_context_q),
        .lkp_hit    (l2_ftb_hit),
        .lkp_target (l2_ftb_target),
        .lkp_target_conf(l2_ftb_target_conf),
        .lkp_fall_through_pc(l2_ftb_fall_through_pc),
        .lkp_kind   (l2_ftb_kind),
        .lkp_br_valid(l2_ftb_br_valid),
        .lkp_slot_offset(l2_ftb_slot_offset),
        .lkp_slot_kind(l2_ftb_slot_kind),
        .lkp_slot_target(l2_ftb_slot_target),
        .lkp_slot_fall_through_pc(l2_ftb_slot_fall_through_pc),
        .lkp_slot_target_conf(l2_ftb_slot_target_conf),
        .lkp2_valid (1'b0),
        .lkp2_pc    ('0),
        .lkp2_context(bpu_default_context()),
        .lkp2_hit   (l2_ftb2_hit),
        .lkp2_target(l2_ftb2_target),
        .lkp2_target_conf(l2_ftb2_target_conf),
        .lkp2_fall_through_pc(l2_ftb2_fall_through_pc),
        .lkp2_kind  (l2_ftb2_kind),
        .lkp2_br_valid(l2_ftb2_br_valid),
        .lkp2_slot_offset(l2_ftb2_slot_offset),
        .lkp2_slot_kind(l2_ftb2_slot_kind),
        .lkp2_slot_target(l2_ftb2_slot_target),
        .lkp2_slot_fall_through_pc(l2_ftb2_slot_fall_through_pc),
        .lkp2_slot_target_conf(l2_ftb2_slot_target_conf),
        .upd_valid  (resolve_update_valid && resolve.actual_kind != BR_NONE),
        .upd_pc     (resolve.pc),
        .upd_context(resolve.ctx),
        .upd_target (resolve.actual_target),
        .upd_fall_through_pc(resolve.actual_call_return_pc),
        .upd_kind   (resolve.actual_kind),
        .upd_br_valid({MAX_BR_PER_BLOCK{1'b1}}),
        .upd_alloc  (resolve_update_valid && resolve.actual_kind != BR_NONE),
        .refill_valid(1'b0),
        .refill_pc   ('0),
        .refill_context(bpu_default_context()),
        .refill_target('0),
        .refill_target_conf('0),
        .refill_fall_through_pc('0),
        .refill_kind (BR_NONE),
        .refill_br_valid('0),
        .refill_slot_offset('0),
        .refill_slot_kind('0),
        .refill_slot_target('0),
        .refill_slot_fall_through_pc('0),
        .refill_slot_target_conf('0),
        .flush_valid(predictor_flush.valid),
        .flush_context_valid(predictor_flush.context_valid),
        .flush_context(predictor_flush.ctx),
        .test_corrupt_parity_valid(1'b0),
        .test_corrupt_parity_idx('0),
        .test_corrupt_parity_way('0),
        .pmu_miss   (l2_ftb_pmu_miss)
    );

    assign l2_refill_valid = l2_req_valid_q && l2_ftb_hit &&
                             l2_req_epoch_q == bpu_epoch_q &&
                             !predictor_flush.valid &&
                             !(resolve.valid && resolve.misprediction);

    always_comb begin
        l2_first_slot_offset = '1;
        l2_first_slot_seen   = 1'b0;
        l2_first_slot_mask   = '0;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (l2_ftb_br_valid[i] &&
                l2_ftb_slot_offset[i] < l2_first_slot_offset) begin
                l2_first_slot_offset = l2_ftb_slot_offset[i];
                l2_first_slot_seen = 1'b1;
            end
        end
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (l2_ftb_br_valid[i] &&
                l2_ftb_slot_offset[i] == l2_first_slot_offset) begin
                l2_first_slot_mask[i] = 1'b1;
            end
        end
        l2_first_slot_pc = l2_first_slot_seen ?
            {l2_req_pc_q[VADDR_W-1:FETCH_BLOCK_OFF_W], l2_first_slot_offset} :
            l2_req_pc_q;
        l2_first_slot_context_pc =
            bpu_context_pc(l2_first_slot_pc, l2_req_context_q);
    end

    bimodal u_l2_cond_bimodal (
        .clk       (clk),
        .rst_n     (rst_n),
        .lkp_valid (l2_refill_valid && l2_ftb_kind == BR_COND),
        .lkp_pc    (l2_first_slot_context_pc),
        .lkp_taken (l2_cond_bim_taken),
        .lkp_ctr   (l2_cond_bim_ctr),
        .upd_valid (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc    (resolve_context_pc),
        .upd_taken (resolve.actual_taken)
    );

    assign l2_cond_strong_taken =
        l2_cond_bim_taken && &l2_cond_bim_ctr;

    assign l2_ret_late_redirect_candidate =
        l2_ftb_kind == BR_RET &&
        l2_req_ras_top_valid_q &&
        !l2_req_uftb_ret_popped_q;

    assign l2_late_redirect_candidate =
        l2_refill_valid && l2_first_slot_seen &&
        ((l2_ftb_kind == BR_CALL) ||
         (l2_ftb_kind == BR_IND) ||
         (l2_ftb_kind == BR_DIRECT) ||
         (l2_ftb_kind == BR_COND && l2_cond_strong_taken) ||
         l2_ret_late_redirect_candidate);

    assign l2_late_redirect_target =
        (l2_ftb_kind == BR_RET) ? l2_req_ras_top_addr_q : l2_ftb_target;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            l2_req_valid_q <= 1'b0;
            l2_req_pc_q <= '0;
            l2_req_context_q <= bpu_default_context();
            l2_req_ftq_ptr_q <= '0;
            l2_req_epoch_q <= '0;
            l2_req_ghist_snapshot_q <= '0;
            l2_req_target_hist_snapshot_q <= '0;
            l2_req_path_hist_snapshot_q <= '0;
            l2_req_ras_top_q <= '0;
            l2_req_ras_top_valid_q <= 1'b0;
            l2_req_ras_top_addr_q <= '0;
            l2_req_uftb_ret_popped_q <= 1'b0;
            bpu_epoch_q <= '0;
        end else begin
            if (predictor_flush.valid) begin
                bpu_epoch_q <= bpu_epoch_q + 1'b1;
                l2_req_valid_q <= 1'b0;
                l2_req_context_q <= bpu_default_context();
            end else if (resolve.valid && resolve.misprediction) begin
                bpu_epoch_q <= bpu_epoch_q + 1'b1;
                l2_req_valid_q <= 1'b0;
            end else begin
                l2_req_valid_q <= lkp_fire && !ftb_hit;
                l2_req_pc_q <= lkp_pc;
                l2_req_context_q <= lkp_context;
                l2_req_ftq_ptr_q <= ftq_push_ptr;
                l2_req_epoch_q <= bpu_epoch_q;
                l2_req_ghist_snapshot_q <= ghist_spec_q;
                l2_req_target_hist_snapshot_q <= ittage_target_hist_spec_q;
                l2_req_path_hist_snapshot_q <= ittage_path_hist_spec_q;
                l2_req_ras_top_q <= ras_top_idx;
                l2_req_ras_top_valid_q <= ras_top_valid;
                l2_req_ras_top_addr_q <= ras_top_addr;
                l2_req_uftb_ret_popped_q <=
                    uftb_steer_hit && uftb_kind == BR_RET;
            end
        end
    end

    always_comb begin
        ftb_first_slot_offset = '1;
        ftb_first_slot_seen   = 1'b0;
        ftb_first_slot_fall_through_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
        ftb_first_slot_mask   = '0;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (ftb_br_valid[i] && ftb_slot_offset[i] < ftb_first_slot_offset) begin
                ftb_first_slot_offset = ftb_slot_offset[i];
                ftb_first_slot_seen = 1'b1;
                ftb_first_slot_fall_through_pc = ftb_slot_fall_through_pc[i];
            end
        end
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (ftb_br_valid[i] && ftb_slot_offset[i] == ftb_first_slot_offset) begin
                ftb_first_slot_mask[i] = 1'b1;
            end
        end
        ftb_first_slot_pc = ftb_first_slot_seen ?
            {lkp_pc[VADDR_W-1:FETCH_BLOCK_OFF_W], ftb_first_slot_offset} :
            lkp_pc;
        ftb_first_slot_context_pc =
            bpu_context_pc(ftb_first_slot_pc, lkp_context);
    end

    logic                  tage_taken;
    // Alternate prediction (next-longest TAGE table) is exported by the
    // tagged stack for use by the SC training path. Currently consumed only
    // for future extensions of the SC update policy; observable in waves.
    /* verilator lint_off UNUSEDSIGNAL */
    logic                  tage_taken_alt;
    logic [TAGE_TABLES:0]  tage_hit_vec;
    /* verilator lint_on UNUSEDSIGNAL */
    logic [$clog2(TAGE_TABLES+1)-1:0] tage_provider;
    logic                  tage_provider_taken;
    logic [TAGE_CTR_W-1:0] tage_provider_ctr;
    logic                  tage_pmu_alloc;

    logic useful_reset_lsb;
    logic useful_reset_msb;

    tage u_tage (
        .clk            (clk),
        .rst_n          (rst_n),
        .lkp_valid      (lkp_fire),
        .lkp_pc         (ftb_first_slot_context_pc),
        .lkp_hist       (ghist_spec_q),
        .lkp_taken      (tage_taken),
        .lkp_taken_alt  (tage_taken_alt),
        .lkp_hit_vec    (tage_hit_vec),
        .lkp_provider   (tage_provider),
        .lkp_provider_taken(tage_provider_taken),
        .upd_valid      (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc         (resolve_context_pc),
        .upd_hist       (replay_tage_hist),
        .upd_taken      (resolve.actual_taken),
        .upd_misp       (resolve.misprediction),
        .upd_provider   (replay_tage_provider),
        .upd_provider_taken(replay_tage_provider_taken),
        .upd_alt_taken  (replay_tage_alt_taken),
        .upd_provider_weak(replay_tage_lowconf),
        .useful_reset_lsb(useful_reset_lsb),
        .useful_reset_msb(useful_reset_msb),
        .lkp_provider_ctr(tage_provider_ctr),
        .pmu_alloc      (tage_pmu_alloc)
    );

    // SC override path. Confidence is "low" when the provider counter is
    // at the centered weak point (msb just flipped). For the 3-bit TAGE
    // counter, that means value 3 (0b011) or 4 (0b100).
    logic tage_lowconf;
    assign tage_lowconf = (tage_provider != 0) &&
                           ((tage_provider_ctr == 3'b011) ||
                            (tage_provider_ctr == 3'b100));
    assign replay_tage_lowconf =
        ftq_replay_valid ? ftq_replay_entry.tage_lowconf : tage_lowconf;

    logic sc_override;
    logic sc_taken;

    sc u_sc (
        .clk            (clk),
        .rst_n          (rst_n),
        .lkp_valid      (lkp_fire),
        .lkp_pc         (ftb_first_slot_context_pc),
        .lkp_hist       (ghist_spec_q),
        .lkp_tage_taken (tage_taken),
        .lkp_tage_lowconf(tage_lowconf),
        .lkp_override   (sc_override),
        .lkp_taken      (sc_taken),
        .upd_valid      (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc         (resolve_context_pc),
        .upd_hist       (replay_tage_hist),
        .upd_taken      (resolve.actual_taken),
        .upd_tage_lowconf(replay_tage_lowconf)
    );

    logic h2p_raw_override;
    logic h2p_override;
    logic h2p_effective_override;
    logic h2p_taken;

    h2p_corrector u_h2p (
        .clk            (clk),
        .rst_n          (rst_n),
        .lkp_valid      (lkp_fire),
        .lkp_pc         (ftb_first_slot_context_pc),
        .lkp_hist       (ghist_spec_q),
        .lkp_target_hist(ittage_target_hist_spec_q),
        .lkp_path_hist  (ittage_path_hist_spec_q),
        .lkp_override   (h2p_raw_override),
        .lkp_taken      (h2p_taken),
        .upd_valid      (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc         (resolve_context_pc),
        .upd_hist       (replay_tage_hist),
        .upd_target_hist(ftq_replay_valid ?
            ittage_target_hist_from_ext(ftq_replay_entry.ittage_target_hist_snapshot) :
            ittage_target_hist_arch_q),
        .upd_path_hist  (ftq_replay_valid ?
            ittage_path_hist_from_ext(ftq_replay_entry.ittage_path_hist_snapshot) :
            ittage_path_hist_arch_q),
        .upd_taken      (resolve.actual_taken)
    );

    typedef logic signed [H2P_META_CTR_W-1:0] h2p_meta_ctr_t;
    h2p_meta_ctr_t h2p_meta_ctr_q [H2P_META_ENTRIES];
    logic [H2P_META_IDX_W-1:0] h2p_meta_lkp_idx;
    logic [H2P_META_IDX_W-1:0] h2p_meta_upd_idx;
    logic h2p_meta_allow;
    logic h2p_meta_side_correct;
    logic h2p_meta_base_correct;

    function automatic logic [H2P_META_IDX_W-1:0] h2p_meta_idx(
        input logic [VADDR_W-1:0] pc
    );
        logic [H2P_META_IDX_W-1:0] folded;
        folded = '0;
        for (int unsigned k = 2; k < VADDR_W; k++) begin
            folded[(k - 2) % H2P_META_IDX_W] =
                folded[(k - 2) % H2P_META_IDX_W] ^ pc[k];
        end
        h2p_meta_idx = folded;
    endfunction

    assign h2p_meta_lkp_idx = h2p_meta_idx(ftb_first_slot_context_pc);
    assign h2p_meta_upd_idx = h2p_meta_idx(resolve_context_pc);
    assign h2p_meta_allow =
        (H2P_META_ENABLE == 0) ||
        (h2p_meta_ctr_q[h2p_meta_lkp_idx] >=
         h2p_meta_ctr_t'(H2P_META_THRESHOLD));
    assign h2p_override = h2p_raw_override && h2p_meta_allow;
    assign h2p_effective_override =
        lkp_fire && ftb_hit && (ftb_kind == BR_COND) &&
        !loop_hit && !sc_override && h2p_override;
    assign h2p_meta_side_correct = replay_h2p_taken == resolve.actual_taken;
    assign h2p_meta_base_correct = replay_tage_provider_taken == resolve.actual_taken;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            /* verilator lint_off UNUSEDLOOP */
            for (int unsigned i = 0; i < H2P_META_ENTRIES; i++) begin
                h2p_meta_ctr_q[i] <= '0;
            end
            /* verilator lint_on UNUSEDLOOP */
        end else if ((H2P_META_ENABLE != 0) &&
                     resolve_update_valid && resolve.actual_kind == BR_COND &&
                     replay_h2p_conf &&
                     !replay_sc_override &&
                     (h2p_meta_side_correct != h2p_meta_base_correct)) begin
            if (h2p_meta_side_correct) begin
                if (h2p_meta_ctr_q[h2p_meta_upd_idx] !=
                    h2p_meta_ctr_t'((1 << (H2P_META_CTR_W - 1)) - 1)) begin
                    h2p_meta_ctr_q[h2p_meta_upd_idx] <=
                        h2p_meta_ctr_q[h2p_meta_upd_idx] + h2p_meta_ctr_t'(1);
                end
            end else begin
                if (h2p_meta_ctr_q[h2p_meta_upd_idx] !=
                    h2p_meta_ctr_t'(-(1 << (H2P_META_CTR_W - 1)))) begin
                    h2p_meta_ctr_q[h2p_meta_upd_idx] <=
                        h2p_meta_ctr_q[h2p_meta_upd_idx] - h2p_meta_ctr_t'(1);
                end
            end
        end
    end

    // Short local-history corrector for simple per-PC patterns that global TAGE
    // may learn slowly after redirect replay, such as T/N alternation at one
    // hot branch. It only overrides when its 2-bit counter is saturated.
    typedef logic [1:0] local_dir_ctr_t;
    typedef logic signed [LOCAL_DIR_META_CTR_W-1:0] local_dir_meta_ctr_t;

    logic [LOCAL_DIR_HIST_W-1:0] local_dir_hist_q [LOCAL_DIR_ENTRIES];
    local_dir_ctr_t local_dir_ctr_q [LOCAL_DIR_ENTRIES][LOCAL_DIR_PHT_ENTRIES];
    local_dir_meta_ctr_t local_dir_meta_ctr_q [LOCAL_DIR_META_ENTRIES];
    logic [LOCAL_DIR_IDX_W-1:0] local_dir_lkp_idx;
    logic [LOCAL_DIR_IDX_W-1:0] local_dir_upd_idx;
    logic [LOCAL_DIR_META_IDX_W-1:0] local_dir_meta_lkp_idx;
    logic [LOCAL_DIR_META_IDX_W-1:0] local_dir_meta_upd_idx;
    logic [LOCAL_DIR_HIST_W-1:0] local_dir_lkp_hist;
    logic [LOCAL_DIR_HIST_W-1:0] local_dir_upd_hist;
    local_dir_ctr_t local_dir_lkp_ctr;
    logic local_dir_conf;
    logic local_dir_taken;
    logic local_dir_meta_allow;
    logic local_dir_meta_side_correct;
    logic local_dir_meta_base_correct;

    assign local_dir_lkp_idx =
        ftb_first_slot_context_pc[2 +: LOCAL_DIR_IDX_W];
    assign local_dir_upd_idx =
        resolve_context_pc[2 +: LOCAL_DIR_IDX_W];
    assign local_dir_meta_lkp_idx =
        ftb_first_slot_context_pc[2 +: LOCAL_DIR_META_IDX_W];
    assign local_dir_meta_upd_idx =
        resolve_context_pc[2 +: LOCAL_DIR_META_IDX_W];
    assign local_dir_lkp_hist = local_dir_hist_q[local_dir_lkp_idx];
    assign local_dir_upd_hist = local_dir_hist_q[local_dir_upd_idx];
    assign local_dir_lkp_ctr =
        local_dir_ctr_q[local_dir_lkp_idx][local_dir_lkp_hist];
    assign local_dir_taken = local_dir_lkp_ctr[1];
    assign local_dir_conf = (LOCAL_DIR_ENABLE != 0) &&
                            ((local_dir_lkp_ctr == 2'b00) ||
                             (local_dir_lkp_ctr == 2'b11));
    assign local_dir_meta_allow =
        (LOCAL_DIR_META_ENABLE == 0) ||
        (local_dir_meta_ctr_q[local_dir_meta_lkp_idx] >=
         local_dir_meta_ctr_t'(LOCAL_DIR_META_THRESHOLD));
    assign local_dir_meta_side_correct =
        (replay_local_dir_taken == resolve.actual_taken);
    assign local_dir_meta_base_correct =
        (replay_local_dir_base_taken == resolve.actual_taken);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            /* verilator lint_off UNUSEDLOOP */
            for (int unsigned i = 0; i < LOCAL_DIR_ENTRIES; i++) begin
                local_dir_hist_q[i] <= '0;
                for (int unsigned h = 0; h < LOCAL_DIR_PHT_ENTRIES; h++) begin
                    local_dir_ctr_q[i][h] <= 2'b01;
                end
            end
            for (int unsigned i = 0; i < LOCAL_DIR_META_ENTRIES; i++) begin
                local_dir_meta_ctr_q[i] <= '0;
            end
            /* verilator lint_on UNUSEDLOOP */
        end else if ((LOCAL_DIR_ENABLE != 0) &&
                     resolve_update_valid && resolve.actual_kind == BR_COND) begin
            if ((LOCAL_DIR_META_ENABLE != 0) && replay_local_dir_conf &&
                replay_local_dir_train_valid &&
                (local_dir_meta_side_correct != local_dir_meta_base_correct)) begin
                if (local_dir_meta_side_correct) begin
                    if (local_dir_meta_ctr_q[local_dir_meta_upd_idx] !=
                        local_dir_meta_ctr_t'((1 << (LOCAL_DIR_META_CTR_W - 1)) - 1)) begin
                        local_dir_meta_ctr_q[local_dir_meta_upd_idx] <=
                            local_dir_meta_ctr_q[local_dir_meta_upd_idx] +
                            local_dir_meta_ctr_t'(1);
                    end
                end else begin
                    if (local_dir_meta_ctr_q[local_dir_meta_upd_idx] !=
                        local_dir_meta_ctr_t'(-(1 << (LOCAL_DIR_META_CTR_W - 1)))) begin
                        local_dir_meta_ctr_q[local_dir_meta_upd_idx] <=
                            local_dir_meta_ctr_q[local_dir_meta_upd_idx] -
                            local_dir_meta_ctr_t'(1);
                    end
                end
            end
            if (resolve.actual_taken) begin
                if (local_dir_ctr_q[local_dir_upd_idx][local_dir_upd_hist] != 2'b11)
                    local_dir_ctr_q[local_dir_upd_idx][local_dir_upd_hist] <=
                        local_dir_ctr_q[local_dir_upd_idx][local_dir_upd_hist] + 2'b01;
            end else begin
                if (local_dir_ctr_q[local_dir_upd_idx][local_dir_upd_hist] != 2'b00)
                    local_dir_ctr_q[local_dir_upd_idx][local_dir_upd_hist] <=
                        local_dir_ctr_q[local_dir_upd_idx][local_dir_upd_hist] - 2'b01;
            end
            local_dir_hist_q[local_dir_upd_idx] <=
                {local_dir_hist_q[local_dir_upd_idx][LOCAL_DIR_HIST_W-2:0],
                 resolve.actual_taken};
        end
    end

    logic [VADDR_W-1:0] second_slot_pc;
    logic               second_slot_cond_valid;
    logic               second_slot_seen;
    logic [VADDR_W-1:0] second_slot_target;
    logic               second_slot_bim_taken;
    logic [MAX_BR_PER_BLOCK-1:0] second_slot_mask;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [BIM_CTR_W-1:0] second_slot_bim_ctr;
    /* verilator lint_on UNUSEDSIGNAL */

    bimodal u_second_slot_bimodal (
        .clk       (clk),
        .rst_n     (rst_n),
        .lkp_valid (lkp_fire && second_slot_cond_valid),
        .lkp_pc    (second_slot_context_pc),
        .lkp_taken (second_slot_bim_taken),
        .lkp_ctr   (second_slot_bim_ctr),
        .upd_valid (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc    (resolve_context_pc),
        .upd_taken (resolve.actual_taken)
    );

    bimodal u_ftb2_cond_bimodal (
        .clk       (clk),
        .rst_n     (rst_n),
        .lkp_valid (ftb2_lkp_valid && ftb2_hit && ftb2_first_slot_seen &&
                    ftb2_kind == BR_COND),
        .lkp_pc    (ftb2_first_slot_context_pc),
        .lkp_taken (ftb2_cond_bim_taken),
        .lkp_ctr   (ftb2_cond_bim_ctr),
        .upd_valid (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc    (resolve_context_pc),
        .upd_taken (resolve.actual_taken)
    );

    assign ftb2_cond_strong_taken =
        ftb2_cond_bim_taken && &ftb2_cond_bim_ctr;

    always_comb begin
        second_slot_pc = lkp_pc;
        second_slot_context_pc = lkp_context_pc;
        second_slot_target = '0;
        second_slot_cond_valid = 1'b0;
        second_slot_seen = 1'b0;
        second_slot_mask = '0;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (ftb_br_valid[i] &&
                ftb_slot_offset[i] > ftb_first_slot_offset &&
                (!second_slot_seen ||
                 ftb_slot_offset[i] < second_slot_pc[FETCH_BLOCK_OFF_W-1:0])) begin
                second_slot_pc = {lkp_pc[VADDR_W-1:FETCH_BLOCK_OFF_W], ftb_slot_offset[i]};
                second_slot_context_pc = bpu_context_pc(second_slot_pc, lkp_context);
                second_slot_target = ftb_slot_target[i];
                second_slot_cond_valid = ftb_slot_kind[i] == BR_COND;
                second_slot_seen = 1'b1;
            end
        end
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (second_slot_seen &&
                ftb_br_valid[i] &&
                ftb_slot_offset[i] == second_slot_pc[FETCH_BLOCK_OFF_W-1:0]) begin
                second_slot_mask[i] = 1'b1;
            end
        end
    end

    logic loop_hit;
    logic loop_taken;
    logic loop_pmu_hit;

    loop_predictor u_loop (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_fire),
        .lkp_pc     (ftb_first_slot_context_pc),
        .lkp_path_sig(loop_path_signature(ittage_target_hist_spec_ext,
                                          ftb_first_slot_context_pc)),
        .lkp_hit    (loop_hit),
        .lkp_taken  (loop_taken),
        .pmu_hit    (loop_pmu_hit),
        .upd_valid  (resolve_update_valid && resolve.actual_kind == BR_COND),
        .upd_pc     (resolve_context_pc),
        .upd_path_sig(loop_path_signature(
            ftq_replay_valid ?
                ftq_replay_entry.ittage_target_hist_snapshot :
                ittage_target_hist_arch_ext,
            resolve_context_pc)),
        .upd_target (resolve.actual_target),
        .upd_taken  (resolve.actual_taken)
    );

    logic [VADDR_W-1:0]    ras_top_addr;
    logic                  ras_top_valid;
    logic [RAS_IDX_W:0]    ras_top_idx;
    logic                  ras_pmu_ovf;
    logic                  ras_pmu_unf;
    logic                  ras_spec_push;
    logic                  ras_spec_pop;
    logic [VADDR_W-1:0]    ras_spec_push_addr;
    logic                  ras_restore_valid_mux;
    logic [RAS_IDX_W:0]    ras_restore_top_mux;
    logic                  ras_restore_entry_valid_mux;
    logic [VADDR_W-1:0]    ras_restore_entry_addr_mux;
    typedef struct packed {
        logic                            valid;
        logic [RAS_FALLBACK_TAG_W-1:0]  tag;
        bpu_context_t                    ctx;
        logic [VADDR_W-1:0]              target;
        logic [RAS_FALLBACK_CONF_W-1:0]  conf;
    } ras_fallback_entry_t;

    localparam logic [RAS_FALLBACK_CONF_W-1:0] RAS_FALLBACK_CONF_MAX =
        {RAS_FALLBACK_CONF_W{1'b1}};
    localparam logic [RAS_FALLBACK_CONF_W-1:0] RAS_FALLBACK_OVERRIDE_CONF =
        {RAS_FALLBACK_CONF_W{1'b1}};

    ras_fallback_entry_t ras_fallback_q [RAS_FALLBACK_ENTRIES];
    logic [RAS_FALLBACK_IDX_W-1:0] ras_fallback_lkp_idx;
    logic [RAS_FALLBACK_IDX_W-1:0] ras_fallback_upd_idx;
    logic [RAS_FALLBACK_TAG_W-1:0] ras_fallback_lkp_tag;
    logic [RAS_FALLBACK_TAG_W-1:0] ras_fallback_upd_tag;
    logic [VADDR_W-1:0]            ras_fallback_lkp_pc;
    logic                          ras_fallback_hit;
    logic                          ras_fallback_override;
    logic [VADDR_W-1:0]            ras_fallback_target;
    logic                          ras_fallback_upd_same_target;
    ras_fallback_entry_t           ras_fallback_update_entry_n;

    function automatic logic [RAS_FALLBACK_IDX_W-1:0] ras_fallback_index(
        input logic [VADDR_W-1:0] pc
    );
        logic [RAS_FALLBACK_IDX_W-1:0] folded;
        folded = pc[2 +: RAS_FALLBACK_IDX_W];
        for (int unsigned i = 2 + RAS_FALLBACK_IDX_W; i < VADDR_W; i++) begin
            folded[(i - 2 - RAS_FALLBACK_IDX_W) % RAS_FALLBACK_IDX_W] =
                folded[(i - 2 - RAS_FALLBACK_IDX_W) % RAS_FALLBACK_IDX_W] ^ pc[i];
        end
        ras_fallback_index = folded;
    endfunction

    function automatic logic [RAS_FALLBACK_TAG_W-1:0] ras_fallback_tag(
        input logic [VADDR_W-1:0] pc
    );
        logic [RAS_FALLBACK_TAG_W-1:0] folded;
        folded = pc[2 +: RAS_FALLBACK_TAG_W];
        for (int unsigned i = 2 + RAS_FALLBACK_TAG_W; i < VADDR_W; i++) begin
            folded[(i - 2 - RAS_FALLBACK_TAG_W) % RAS_FALLBACK_TAG_W] =
                folded[(i - 2 - RAS_FALLBACK_TAG_W) % RAS_FALLBACK_TAG_W] ^ pc[i];
        end
        ras_fallback_tag = folded;
    endfunction

    // RAS push/pop signals are derived from the FTB-decoded branch kind or,
    // on an FTB miss, a confident uFTB fast-path branch kind.
    // CALL: push the call's fall-through PC (stored in the FTB on the
    // matching update, and mirrored in the uFTB); the resolver supplies the
    // same address on commit.
    // RET: pop the top. Pure indirect (BR_IND) does not push or pop.
    assign ras_spec_push      = lkp_fire &&
                                ((ftb_hit && ftb_kind == BR_CALL) ||
                                 (!ftb_hit && uftb_steer_hit && uftb_kind == BR_CALL));
    assign ras_spec_pop       = lkp_fire &&
                                ((ftb_hit && ftb_kind == BR_RET) ||
                                 (!ftb_hit && uftb_steer_hit && uftb_kind == BR_RET));
    assign ras_spec_push_addr = ftb_hit ? ftb_fall_through_pc : uftb_fall_through_pc;
    assign ras_restore_valid_mux =
        (resolve.valid && resolve.misprediction) ||
        (ftq_patch_applied && l2_ftb_kind == BR_RET);
    assign ras_restore_top_mux =
        (resolve.valid && resolve.misprediction) ? replay_ras_restore_top :
        (l2_req_ras_top_q - 1'b1);
    assign ras_restore_entry_valid_mux =
        (resolve.valid && resolve.misprediction) ? replay_ras_restore_valid : 1'b0;
    assign ras_restore_entry_addr_mux =
        (resolve.valid && resolve.misprediction) ? replay_ras_restore_addr : '0;

    assign ras_fallback_lkp_pc =
        (ftb_hit && ftb_first_slot_seen) ? ftb_first_slot_context_pc : lkp_context_pc;
    assign ras_fallback_lkp_idx = ras_fallback_index(ras_fallback_lkp_pc);
    assign ras_fallback_lkp_tag = ras_fallback_tag(ras_fallback_lkp_pc);
    assign ras_fallback_upd_idx = ras_fallback_index(resolve_context_pc);
    assign ras_fallback_upd_tag = ras_fallback_tag(resolve_context_pc);
    assign ras_fallback_hit =
        ras_fallback_q[ras_fallback_lkp_idx].valid &&
        ras_fallback_q[ras_fallback_lkp_idx].tag == ras_fallback_lkp_tag &&
        ras_fallback_q[ras_fallback_lkp_idx].ctx == lkp_context;
    assign ras_fallback_target = ras_fallback_q[ras_fallback_lkp_idx].target;
    assign ras_fallback_override =
        ras_fallback_hit &&
        ras_fallback_q[ras_fallback_lkp_idx].conf >= RAS_FALLBACK_OVERRIDE_CONF &&
        (!ras_top_valid || ras_top_addr != ras_fallback_target);
    assign ras_fallback_upd_same_target =
        ras_fallback_q[ras_fallback_upd_idx].valid &&
        ras_fallback_q[ras_fallback_upd_idx].tag == ras_fallback_upd_tag &&
        ras_fallback_q[ras_fallback_upd_idx].ctx == resolve.ctx &&
        ras_fallback_q[ras_fallback_upd_idx].target == resolve.actual_target;

    always_comb begin
        ras_fallback_update_entry_n = ras_fallback_q[ras_fallback_upd_idx];
        if (!ras_fallback_q[ras_fallback_upd_idx].valid ||
            ras_fallback_q[ras_fallback_upd_idx].tag != ras_fallback_upd_tag ||
            ras_fallback_q[ras_fallback_upd_idx].ctx != resolve.ctx) begin
            ras_fallback_update_entry_n.valid = 1'b1;
            ras_fallback_update_entry_n.tag = ras_fallback_upd_tag;
            ras_fallback_update_entry_n.ctx = resolve.ctx;
            ras_fallback_update_entry_n.target = resolve.actual_target;
            ras_fallback_update_entry_n.conf = RAS_FALLBACK_CONF_W'(1);
        end else if (ras_fallback_upd_same_target) begin
            if (ras_fallback_update_entry_n.conf != RAS_FALLBACK_CONF_MAX) begin
                ras_fallback_update_entry_n.conf =
                    ras_fallback_update_entry_n.conf + 1'b1;
            end
        end else if (ras_fallback_update_entry_n.conf == '0) begin
            ras_fallback_update_entry_n.target = resolve.actual_target;
            ras_fallback_update_entry_n.conf = RAS_FALLBACK_CONF_W'(1);
        end else begin
            ras_fallback_update_entry_n.conf =
                ras_fallback_update_entry_n.conf - 1'b1;
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned i = 0; i < RAS_FALLBACK_ENTRIES; i++) begin
                ras_fallback_q[i] <= '0;
            end
        end else if (predictor_flush.valid) begin
            for (int unsigned i = 0; i < RAS_FALLBACK_ENTRIES; i++) begin
                if (!predictor_flush.context_valid ||
                    ras_fallback_q[i].ctx == predictor_flush.ctx) begin
                    ras_fallback_q[i] <= '0;
                end
            end
        end else if (resolve_update_valid && resolve.actual_kind == BR_RET) begin
            ras_fallback_q[ras_fallback_upd_idx] <= ras_fallback_update_entry_n;
        end
    end

    e1_bpu_ras u_ras (
        .clk            (clk),
        .rst_n          (rst_n),
        .spec_push      (ras_spec_push),
        .spec_push_addr (ras_spec_push_addr),
        .spec_pop       (ras_spec_pop),
        .spec_top_addr  (ras_top_addr),
        .spec_top_valid (ras_top_valid),
        .spec_top_idx   (ras_top_idx),
        .commit_push    (resolve_update_valid && resolve.actual_kind == BR_CALL),
        .commit_push_addr(resolve.actual_call_return_pc),
        .commit_pop     (resolve_update_valid && resolve.actual_kind == BR_RET),
        .flush          (predictor_flush.valid),
        .restore_valid  (ras_restore_valid_mux),
        .restore_top    (ras_restore_top_mux),
        .restore_entry_valid(ras_restore_entry_valid_mux),
        .restore_entry_addr(ras_restore_entry_addr_mux),
        .pmu_overflow   (ras_pmu_ovf),
        .pmu_underflow  (ras_pmu_unf)
    );

    logic                                  itt_hit;
    logic [VADDR_W-1:0]                    itt_target;
    logic [ITTAGE_CTR_W-1:0]               itt_ctr;
    logic [$clog2(ITTAGE_TABLES+1)-1:0]    itt_provider;
    logic                                  prefer_ftb_indirect_target;
    localparam logic [ITTAGE_CTR_W-1:0] ITTAGE_WEAK_CTR_MAX =
        1 << (ITTAGE_CTR_W - 1);

    assign prefer_ftb_indirect_target =
        ftb_hit && itt_hit && ftb_target_conf[FTB_TARGET_CONF_W-1] &&
        (itt_ctr <= ITTAGE_WEAK_CTR_MAX);

    // ITTAGE trains on both call and pure-indirect targets. Returns are
    // handled by the RAS and must not be fed into ITTAGE, otherwise the
    // table is corrupted by the return-address stream.
    ittage u_ittage (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_fire),
        .lkp_pc     (lkp_context_pc),
        .lkp_hist   (ittage_lkp_hist),
        .lkp_hit    (itt_hit),
        .lkp_target (itt_target),
        .lkp_ctr    (itt_ctr),
        .lkp_provider(itt_provider),
        .upd_valid  (resolve_update_valid && (resolve.actual_kind == BR_CALL ||
                                         resolve.actual_kind == BR_IND)),
        .upd_pc     (resolve_context_pc),
        .upd_hist   (replay_ittage_hist),
        .upd_target (resolve.actual_target),
        .upd_misp   (resolve.misprediction),
        .upd_provider(replay_ittage_provider)
    );

    // -----------------------------------------------------------------------
    // Final prediction arbitration. Priority:
    //   1. Loop predictor (when confident)
    //   2. SC override of TAGE
    //   3. TAGE direction for conditional branches
    //   4. RAS for returns
    //   5. FTB target for direct unconditional jumps
    //   6. ITTAGE for indirect jumps/calls
    //   7. FTB/uFTB target otherwise
    // -----------------------------------------------------------------------
    bpu_lookup_t pred_d;
    logic        pred_taken_final;
    logic        pred_takes_second_slot;

    always_comb begin
        pred_d           = '0;
        pred_taken_final = 1'b0;
        pred_takes_second_slot = 1'b0;
        if (lkp_fire) begin
            pred_d.valid    = 1'b1;
            pred_d.ctx  = lkp_context;
            pred_d.start_pc = lkp_pc[VADDR_W-1:0];
            pred_d.kind     = ftb_hit ? ftb_kind : (uftb_steer_hit ? uftb_kind : BR_NONE);
            pred_d.from_uftb = uftb_steer_hit;
            pred_d.from_ftb  = ftb_hit;

            if (ftb_hit && ftb_kind == BR_RET) begin
                pred_d.target_pc =
                    ras_fallback_override ? ras_fallback_target :
                    (ras_top_valid ? ras_top_addr :
                     (ras_fallback_hit ? ras_fallback_target : ftb_target));
                pred_d.taken     = 1'b1;
                pred_d.from_ras  = ras_top_valid && !ras_fallback_override;
            end else if (ftb_hit && ftb_kind == BR_DIRECT) begin
                pred_d.target_pc = ftb_target;
                pred_d.taken     = 1'b1;
            end else if (ftb_hit && (ftb_kind == BR_CALL || ftb_kind == BR_IND)) begin
                // Call and pure indirect both use ITTAGE for target prediction.
                // RAS push is gated separately on BR_CALL above.
                pred_d.target_pc = (itt_hit && !prefer_ftb_indirect_target) ?
                                   itt_target : ftb_target;
                pred_d.taken     = 1'b1;
                pred_d.from_ittage = itt_hit;
            end else if (ftb_hit && ftb_kind == BR_COND) begin
                if (loop_hit) begin
                    pred_taken_final = loop_taken;
                    pred_d.from_loop = 1'b1;
                end else if (sc_override) begin
                    pred_taken_final = sc_taken;
                    pred_d.from_sc   = 1'b1;
                end else if (h2p_override) begin
                    pred_taken_final = h2p_taken;
                end else if (local_dir_conf && local_dir_meta_allow) begin
                    pred_taken_final = local_dir_taken;
                end else begin
                    pred_taken_final = tage_taken;
                    pred_d.from_tage = (tage_provider != 0);
                end
                pred_d.taken     = pred_taken_final;
                if (pred_taken_final) begin
                    pred_d.target_pc = ftb_target;
                end else if (second_slot_seen && second_slot_cond_valid && second_slot_bim_taken) begin
                    pred_d.taken     = 1'b1;
                    pred_d.target_pc = second_slot_target;
                    pred_takes_second_slot = 1'b1;
                end else begin
                    pred_d.target_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
                end
            end else if (uftb_steer_hit) begin
                pred_d.target_pc =
                    (uftb_kind == BR_RET && ras_fallback_override) ?
                        ras_fallback_target :
                    (uftb_kind == BR_RET && ras_top_valid) ?
                        ras_top_addr :
                    (uftb_kind == BR_RET && ras_fallback_hit) ?
                        ras_fallback_target :
                        uftb_next_pc;
                pred_d.taken     = 1'b1;
                pred_d.from_ras  = (uftb_kind == BR_RET) && ras_top_valid &&
                                   !ras_fallback_override;
            end else begin
                pred_d.target_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
                pred_d.taken     = 1'b0;
            end

            pred_d.fetch_segments[0].valid = 1'b1;
            pred_d.fetch_segments[0].start_pc = pred_d.start_pc;
            pred_d.fetch_segments[0].end_pc = ftb_hit ?
                {lkp_pc[VADDR_W-1:FETCH_BLOCK_OFF_W], ftb_first_slot_offset} :
                (lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES - 1));
            pred_d.fetch_segments[0].target_pc = pred_takes_second_slot ?
                ftb_first_slot_fall_through_pc : pred_d.target_pc;
            pred_d.fetch_segments[0].branch_offset = ftb_hit ?
                ftb_first_slot_offset : '0;
            pred_d.fetch_segments[0].taken = pred_d.taken && !pred_takes_second_slot;
            for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
                if (ftb_hit && ftb_first_slot_mask[i]) begin
                    pred_d.fetch_segments[0].slot_idx =
                        i[$clog2(MAX_BR_PER_BLOCK)-1:0];
                end
            end
            if (pred_takes_second_slot) begin
                pred_d.fetch_segments[1].valid = 1'b1;
                pred_d.fetch_segments[1].start_pc = ftb_first_slot_fall_through_pc;
                pred_d.fetch_segments[1].end_pc = second_slot_pc;
                pred_d.fetch_segments[1].target_pc = pred_d.target_pc;
                pred_d.fetch_segments[1].branch_offset =
                    second_slot_pc[FETCH_BLOCK_OFF_W-1:0];
                pred_d.fetch_segments[1].taken = 1'b1;
                for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
                    if (second_slot_mask[i]) begin
                        pred_d.fetch_segments[1].slot_idx =
                            i[$clog2(MAX_BR_PER_BLOCK)-1:0];
                    end
                end
            end
        end
    end

    assign pred_valid = lkp_fire;
    assign pred       = pred_d;

    assign ftb2_lkp_valid = pred_d.valid && pred_d.taken && !pred_takes_second_slot;
    assign ftb2_lkp_pc = pred_d.target_pc;

    always_comb begin
        ftb2_first_slot_offset = '1;
        ftb2_first_slot_seen = 1'b0;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (ftb2_br_valid[i] &&
                ftb2_slot_offset[i] < ftb2_first_slot_offset) begin
                ftb2_first_slot_offset = ftb2_slot_offset[i];
                ftb2_first_slot_seen = 1'b1;
            end
        end
        ftb2_first_slot_pc = ftb2_first_slot_seen ?
            {ftb2_lkp_pc[VADDR_W-1:FETCH_BLOCK_OFF_W], ftb2_first_slot_offset} :
            ftb2_lkp_pc;
        ftb2_first_slot_context_pc =
            bpu_context_pc(ftb2_first_slot_pc, lkp_context);
    end

    assign ftb2_redirect_valid =
        ftb2_lkp_valid && ftb2_hit && ftb2_first_slot_seen &&
        ((ftb2_kind == BR_DIRECT) || (ftb2_kind == BR_CALL) ||
         (ftb2_kind == BR_IND) ||
         (ftb2_kind == BR_COND && ftb2_cond_strong_taken) ||
         ftb2_ret_redirect_valid);
    assign ftb2_ret_redirect_valid =
        (ftb2_kind == BR_RET) &&
        (((pred_d.kind == BR_CALL) && (ftb_hit || uftb_steer_hit)) ||
         ((pred_d.kind != BR_RET) && ras_top_valid));
    assign ftb2_ret_redirect_pc =
        (pred_d.kind == BR_CALL) ?
            (ftb_hit ? ftb_fall_through_pc : uftb_fall_through_pc) :
            ras_top_addr;
    assign ftb2_redirect_pc =
        (ftb2_kind == BR_RET) ? ftb2_ret_redirect_pc : ftb2_target;

    always_comb begin
        pred_redirect_valid = '0;
        pred_redirect_pc = '0;
        pred_redirect_kind = '0;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            pred_redirect_valid[i] =
                pred_d.valid && pred_d.fetch_segments[i].valid &&
                pred_d.fetch_segments[i].taken;
            pred_redirect_pc[i] = pred_d.fetch_segments[i].target_pc;
            pred_redirect_kind[i] = pred_d.kind;
        end
        if (ftb2_redirect_valid) begin
            pred_redirect_valid[1] = 1'b1;
            pred_redirect_pc[1] = ftb2_redirect_pc;
            pred_redirect_kind[1] = ftb2_kind;
        end
    end

    // -----------------------------------------------------------------------
    // FTQ enqueue: package the prediction into an FTQ entry.
    // -----------------------------------------------------------------------
    ftq_entry_t push_entry;
    logic       push_valid;
    logic [MAX_BR_PER_BLOCK-1:0] pred_taken_slot_mask;
    always_comb begin
        pred_taken_slot_mask = '0;
        if (pred_d.valid && pred_d.taken && ftb_hit) begin
            pred_taken_slot_mask = pred_takes_second_slot ?
                second_slot_mask : ftb_first_slot_mask;
        end
    end

    always_comb begin
        push_entry              = '0;
        push_entry.valid        = lkp_fire && pred_d.valid;
        push_entry.ctx      = lkp_context;
        push_entry.start_pc     = pred_d.start_pc;
        push_entry.end_pc       = pred_d.start_pc + VADDR_W'(FETCH_BLOCK_BYTES - 1);
        push_entry.target_pc    = pred_d.target_pc;
        push_entry.taken        = pred_d.taken;
        push_entry.kind         = pred_d.kind;
        push_entry.fetch_segments = pred_d.fetch_segments;
        push_entry.br_taken_mask= pred_taken_slot_mask;
        push_entry.ras_spec_top = ras_top_idx;
        push_entry.ras_restore_valid = ras_top_valid;
        push_entry.ras_restore_addr = ras_top_addr;
        push_entry.ghist_snapshot = ghist_spec_q;
        push_entry.ittage_hist_snapshot = ittage_lkp_hist;
        push_entry.ittage_target_hist_snapshot = ittage_target_hist_spec_ext;
        push_entry.ittage_path_hist_snapshot = ittage_path_hist_spec_ext;
        push_entry.tage_provider = tage_provider;
        push_entry.ittage_provider = itt_provider;
        push_entry.tage_provider_ctr = tage_provider_ctr;
        push_entry.tage_lowconf = tage_lowconf;
        push_entry.tage_provider_taken = tage_provider_taken;
        push_entry.tage_alt_taken = tage_taken_alt;
        push_entry.sc_override = sc_override;
        push_entry.sc_taken = sc_taken;
        push_entry.h2p_conf = h2p_raw_override;
        push_entry.h2p_taken = h2p_taken;
        push_entry.local_dir_conf = local_dir_conf;
        push_entry.local_dir_taken = local_dir_taken;
        push_entry.local_dir_train_valid =
            ftb_hit && (ftb_kind == BR_COND) && !loop_hit &&
            !sc_override && !h2p_override;
        push_entry.local_dir_base_taken = tage_taken;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            push_entry.br_slots[i].valid = ftb_br_valid[i];
            push_entry.br_slots[i].offset = ftb_slot_offset[i];
            push_entry.br_slots[i].kind = br_kind_e'(ftb_slot_kind[i]);
            push_entry.br_slots[i].target_pc = ftb_slot_target[i];
            push_entry.br_slots[i].fall_through_pc = ftb_slot_fall_through_pc[i];
            push_entry.br_slots[i].target_conf = ftb_slot_target_conf[i];
        end
        push_valid              = lkp_fire && pred_d.valid;
    end

    always_comb begin
        ftq_patch_entry = '0;
        ftq_patch_entry.valid = 1'b1;
        ftq_patch_entry.ctx = l2_req_context_q;
        ftq_patch_entry.start_pc = l2_req_pc_q;
        ftq_patch_entry.end_pc = l2_first_slot_pc;
        ftq_patch_entry.target_pc = l2_late_redirect_target;
        ftq_patch_entry.taken = 1'b1;
        ftq_patch_entry.kind = l2_ftb_kind;
        ftq_patch_entry.fetch_segments[0].valid = 1'b1;
        ftq_patch_entry.fetch_segments[0].start_pc = l2_req_pc_q;
        ftq_patch_entry.fetch_segments[0].end_pc = l2_first_slot_pc;
        ftq_patch_entry.fetch_segments[0].target_pc = l2_late_redirect_target;
        ftq_patch_entry.fetch_segments[0].branch_offset = l2_first_slot_offset;
        ftq_patch_entry.fetch_segments[0].taken = 1'b1;
        ftq_patch_entry.br_taken_mask = l2_first_slot_mask;
        for (int unsigned i = 0; i < MAX_BR_PER_BLOCK; i++) begin
            if (l2_first_slot_mask[i]) begin
                ftq_patch_entry.fetch_segments[0].slot_idx =
                    i[$clog2(MAX_BR_PER_BLOCK)-1:0];
            end
            ftq_patch_entry.br_slots[i].valid = l2_ftb_br_valid[i];
            ftq_patch_entry.br_slots[i].offset = l2_ftb_slot_offset[i];
            ftq_patch_entry.br_slots[i].kind = br_kind_e'(l2_ftb_slot_kind[i]);
            ftq_patch_entry.br_slots[i].target_pc = l2_ftb_slot_target[i];
            ftq_patch_entry.br_slots[i].fall_through_pc =
                l2_ftb_slot_fall_through_pc[i];
            ftq_patch_entry.br_slots[i].target_conf =
                l2_ftb_slot_target_conf[i];
        end
    end

    assign late_redirect_valid = ftq_patch_applied;
    assign late_redirect_pc = l2_late_redirect_target;
    assign late_redirect_ftq_idx = l2_req_ftq_ptr_q[FTQ_IDX_W-1:0];
    always_comb begin
        late_redirect_valid_lanes = '0;
        late_redirect_pc_lanes = '0;
        late_redirect_ftq_idx_lanes = '0;
        late_redirect_valid_lanes[0] = late_redirect_valid;
        late_redirect_pc_lanes[0] = late_redirect_pc;
        late_redirect_ftq_idx_lanes[0] = late_redirect_ftq_idx;
    end

    logic                    ftq_pmu_full;
    logic                    ftq_pmu_empty;
    // Live FTQ occupancy is wired up for waveform debug and the read-port
    // PMU readout via bpu_csr; not surfaced on the bpu_top external boundary.
    /* verilator lint_off UNUSEDSIGNAL */
    logic [FTQ_IDX_W:0]      ftq_occupancy;
    /* verilator lint_on UNUSEDSIGNAL */

    ftq u_ftq (
        .clk         (clk),
        .rst_n       (rst_n),
        .push_valid  (push_valid),
        .push_entry  (push_entry),
        .push_ready  (push_ready),
        .push_ptr    (ftq_push_ptr),
        .patch_valid (l2_late_redirect_candidate),
        .patch_ptr   (l2_req_ftq_ptr_q),
        .patch_entry (ftq_patch_entry),
        .patch_flush_younger(1'b1),
        .patch_applied(ftq_patch_applied),
        .pop_ready   (fetch_pop),
        .pop_valid   (fetch_valid),
        .pop_entry   (fetch_entry),
        .replay_idx  (resolve.ftq_idx),
        .replay_entry(ftq_replay_entry),
        .flush_valid (resolve.valid && resolve.misprediction),
        .flush_idx   (resolve.ftq_idx),
        .global_flush(predictor_flush.valid),
        .pmu_full    (ftq_pmu_full),
        .pmu_empty   (ftq_pmu_empty),
        .occupancy   (ftq_occupancy)
    );

    // -----------------------------------------------------------------------
    // Global history update. Speculative path shifts in the predicted
    // direction bit on every conditional prediction. Architectural path
    // shifts in the actual direction bit on every resolved conditional.
    // -----------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ghist_spec_q <= '0;
            ghist_arch_q <= '0;
            ittage_target_hist_spec_q <= '0;
            ittage_target_hist_arch_q <= '0;
            ittage_path_hist_spec_q <= '0;
            ittage_path_hist_arch_q <= '0;
        end else begin
            if (predictor_flush.valid) begin
                ghist_spec_q <= '0;
                ghist_arch_q <= '0;
                ittage_target_hist_spec_q <= '0;
                ittage_target_hist_arch_q <= '0;
                ittage_path_hist_spec_q <= '0;
                ittage_path_hist_arch_q <= '0;
            end else if (resolve.valid && resolve.misprediction) begin
                // Redirect recovery starts from the resolved FTQ entry's
                // prediction-time snapshot, then applies the resolved outcome.
                // The current flush policy discards all younger entries on a
                // misprediction, so no younger FTQ effects survive this point.
                ghist_spec_q <= redirect_ghist_spec;
                ittage_target_hist_spec_q <= redirect_target_hist_spec;
                ittage_path_hist_spec_q <= redirect_path_hist_spec;
            end else if (ftq_patch_applied) begin
                // A delayed L2 target-tier hit changes the prediction after
                // the original FTQ enqueue. Rebase speculative histories to
                // the request-time snapshots before applying that branch so
                // predictor state matches the patched FTQ contract.
                if (l2_ftb_kind == BR_COND) begin
                    ghist_spec_q <=
                        {l2_req_ghist_snapshot_q[TAGE_HIST_LEN_MAX-2:0], 1'b1};
                end
                if (l2_ftb_kind == BR_CALL || l2_ftb_kind == BR_IND) begin
                    ittage_target_hist_spec_q <=
                        ittage_target_hist_push(l2_req_target_hist_snapshot_q,
                                                l2_ftb_target);
                end
                if (ITTAGE_PATH_HISTORY_BITS != 0 && l2_ftb_kind != BR_NONE) begin
                    ittage_path_hist_spec_q <=
                        ittage_path_hist_push(l2_req_path_hist_snapshot_q,
                                              l2_first_slot_pc);
                end
            end else if (lkp_fire && pred_d.valid && pred_d.kind == BR_COND) begin
                ghist_spec_q <= {ghist_spec_q[TAGE_HIST_LEN_MAX-2:0],
                                 pred_d.taken};
            end else if (lkp_fire && pred_d.valid &&
                         (pred_d.kind == BR_CALL || pred_d.kind == BR_IND)) begin
                ittage_target_hist_spec_q <=
                    ittage_target_hist_push(ittage_target_hist_spec_q,
                                            pred_d.target_pc);
            end
            if (ITTAGE_PATH_HISTORY_BITS != 0 &&
                !(resolve.valid && resolve.misprediction) &&
                !ftq_patch_applied &&
                lkp_fire && pred_d.valid && pred_d.kind != BR_NONE) begin
                ittage_path_hist_spec_q <=
                    ittage_path_hist_push(ittage_path_hist_spec_q, ftb_first_slot_pc);
            end
            if (resolve_update_valid && resolve.actual_kind == BR_COND) begin
                ghist_arch_q <= {ghist_arch_q[TAGE_HIST_LEN_MAX-2:0],
                                 resolve.actual_taken};
            end
            if (resolve_update_valid &&
                (resolve.actual_kind == BR_CALL || resolve.actual_kind == BR_IND)) begin
                ittage_target_hist_arch_q <=
                    ittage_target_hist_push(ittage_target_hist_arch_q,
                                            resolve.actual_target);
            end
            if (ITTAGE_PATH_HISTORY_BITS != 0 &&
                resolve_update_valid && resolve.actual_kind != BR_NONE) begin
                ittage_path_hist_arch_q <=
                    ittage_path_hist_push(ittage_path_hist_arch_q, resolve.pc);
            end
        end
    end

    // -----------------------------------------------------------------------
    // PMU strobes. One bit per pmu_event_e enum. Aggregated into 64-bit
    // counters by bpu_csr.
    // -----------------------------------------------------------------------
    always_comb begin
        pmu_strb = '0;
        if (pred_valid && pred_d.valid) begin
            pmu_strb[PMU_BR_PRED]   = 1'b1;
            if (pred_d.taken)            pmu_strb[PMU_BR_TAKEN] = 1'b1;
            if (pred_d.kind == BR_COND)  pmu_strb[PMU_BR_COND]  = 1'b1;
            if (pred_d.kind == BR_CALL)  pmu_strb[PMU_BR_CALL]  = 1'b1;
            if (pred_d.kind == BR_RET)   pmu_strb[PMU_BR_RET]   = 1'b1;
            // PMU_BR_IND counts pure indirect jumps (switch dispatch, PLT,
            // vtable). Calls have their own counter; they are distinguished
            // by kind, not by ITTAGE provider hit.
            if (pred_d.kind == BR_IND)   pmu_strb[PMU_BR_IND]   = 1'b1;
        end
        if (resolve.valid && resolve.misprediction) begin
            pmu_strb[PMU_BR_MISP] = 1'b1;
            if (resolve.actual_kind == BR_COND) pmu_strb[PMU_BR_COND_MISP] = 1'b1;
            // Indirect mispredict counter aggregates BR_IND and BR_CALL: both
            // are predicted by ITTAGE so the misp domain is the same.
            if (resolve.actual_kind == BR_IND ||
                resolve.actual_kind == BR_CALL) pmu_strb[PMU_BR_IND_MISP] = 1'b1;
            if (resolve.actual_kind == BR_RET)  pmu_strb[PMU_BR_RET_MISP]  = 1'b1;
        end
        if (ras_pmu_ovf)  pmu_strb[PMU_RAS_OVERFLOW]  = 1'b1;
        if (ras_pmu_unf)  pmu_strb[PMU_RAS_UNDERFLOW] = 1'b1;
        if (ftq_pmu_full) pmu_strb[PMU_FTQ_FULL]      = 1'b1;
        if (ftq_pmu_empty) pmu_strb[PMU_FTQ_EMPTY]    = 1'b1;
        if (ftb_pmu_miss) pmu_strb[PMU_FTB_MISS]      = 1'b1;
        if (uftb_pmu_hit) pmu_strb[PMU_UFTB_HIT]      = 1'b1;
        if (tage_pmu_alloc) pmu_strb[PMU_TAGE_ALLOC]  = 1'b1;
        if (loop_pmu_hit) pmu_strb[PMU_LOOP_HIT]      = 1'b1;
        if (sc_override) pmu_strb[PMU_SC_OVERRIDE]    = 1'b1;
        if (h2p_effective_override) pmu_strb[PMU_H2P_OVERRIDE] = 1'b1;
        if (l2_refill_valid) pmu_strb[PMU_L2_FTB_HIT] = 1'b1;
        if (l2_ftb_pmu_miss) pmu_strb[PMU_L2_FTB_MISS] = 1'b1;
        if (ftb2_redirect_valid) pmu_strb[PMU_TWO_AHEAD_REDIRECT] = 1'b1;
        if (lkp_fire && ftb_hit && (ftb_kind == BR_COND) &&
            !loop_hit && !sc_override && !h2p_override &&
            local_dir_conf && local_dir_meta_allow) begin
            pmu_strb[PMU_LOCAL_DIR_OVERRIDE] = 1'b1;
        end
        if (((H2P_META_ENABLE != 0) &&
             resolve_update_valid && resolve.actual_kind == BR_COND &&
             replay_h2p_conf && !replay_sc_override &&
             (h2p_meta_side_correct != h2p_meta_base_correct)) ||
            ((LOCAL_DIR_META_ENABLE != 0) &&
             resolve_update_valid && resolve.actual_kind == BR_COND &&
             replay_local_dir_conf && replay_local_dir_train_valid &&
             (local_dir_meta_side_correct != local_dir_meta_base_correct))) begin
            pmu_strb[PMU_META_TRAIN] = 1'b1;
        end
        // FETCH_BUBBLE strobed when there is no valid FTQ output but fetch
        // is requesting work.
        if (fetch_pop && !fetch_valid) pmu_strb[PMU_FETCH_BUBBLE] = 1'b1;
    end

    bpu_csr u_csr (
        .clk             (clk),
        .rst_n           (rst_n),
        .event_strb      (pmu_strb),
        .csr_re          (csr_re),
        .csr_addr        (csr_addr),
        .csr_rdata       (csr_rdata),
        .useful_reset_lsb(useful_reset_lsb),
        .useful_reset_msb(useful_reset_msb)
    );

endmodule : bpu_top
