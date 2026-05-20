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
    output logic                pred_valid,
    output bpu_lookup_t         pred,

    // Fetch consumer.
    input  logic                fetch_pop,
    output logic                fetch_valid,
    output ftq_entry_t          fetch_entry,

    // Resolver feedback.
    input  bpu_resolve_t        resolve,

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

    // -----------------------------------------------------------------------
    // Sub-block instantiations
    // -----------------------------------------------------------------------
    logic                  uftb_hit;
    logic [VADDR_W-1:0]    uftb_next_pc;
    logic                  uftb_pmu_hit;

    uftb u_uftb (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_hit    (uftb_hit),
        .lkp_next_pc(uftb_next_pc),
        .upd_valid  (resolve.valid),
        .upd_pc     (resolve.pc),
        .upd_next_pc(resolve.actual_target),
        .pmu_hit    (uftb_pmu_hit)
    );

    logic                  ftb_hit;
    logic [VADDR_W-1:0]    ftb_target;
    logic [VADDR_W-1:0]    ftb_fall_through_pc;
    br_kind_e              ftb_kind;
    // FTB returns up to MAX_BR_PER_BLOCK valid branch slots per fetch block.
    // Reserved for the two-taken-per-cycle extension (BLOCKED until the
    // dual-port FTB read path is implemented per docs/arch/branch-prediction.md).
    /* verilator lint_off UNUSEDSIGNAL */
    logic [MAX_BR_PER_BLOCK-1:0] ftb_br_valid;
    /* verilator lint_on UNUSEDSIGNAL */
    logic                  ftb_pmu_miss;

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
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_hit    (ftb_hit),
        .lkp_target (ftb_target),
        .lkp_fall_through_pc(ftb_fall_through_pc),
        .lkp_kind   (ftb_kind),
        .lkp_br_valid(ftb_br_valid),
        .upd_valid  (resolve.valid),
        .upd_pc     (resolve.pc),
        .upd_target (resolve.actual_target),
        .upd_fall_through_pc(resolve.actual_call_return_pc),
        .upd_kind   (resolve.actual_kind),
        .upd_br_valid({MAX_BR_PER_BLOCK{1'b1}}),
        .upd_alloc  (resolve.valid && resolve.actual_kind != BR_NONE),
        .pmu_miss   (ftb_pmu_miss)
    );

    logic                  tage_taken;
    // Alternate prediction (next-longest TAGE table) is exported by the
    // tagged stack for use by the SC training path. Currently consumed only
    // for future extensions of the SC update policy; observable in waves.
    /* verilator lint_off UNUSEDSIGNAL */
    logic                  tage_taken_alt;
    logic [TAGE_TABLES:0]  tage_hit_vec;
    /* verilator lint_on UNUSEDSIGNAL */
    logic [$clog2(TAGE_TABLES+1)-1:0] tage_provider;
    logic [TAGE_CTR_W-1:0] tage_provider_ctr;
    logic                  tage_pmu_alloc;

    logic useful_reset_lsb;
    logic useful_reset_msb;

    tage u_tage (
        .clk            (clk),
        .rst_n          (rst_n),
        .lkp_valid      (lkp_valid),
        .lkp_pc         (lkp_pc),
        .lkp_hist       (ghist_spec_q),
        .lkp_taken      (tage_taken),
        .lkp_taken_alt  (tage_taken_alt),
        .lkp_hit_vec    (tage_hit_vec),
        .lkp_provider   (tage_provider),
        .upd_valid      (resolve.valid && resolve.actual_kind == BR_COND),
        .upd_pc         (resolve.pc),
        .upd_hist       (ghist_arch_q),
        .upd_taken      (resolve.actual_taken),
        .upd_misp       (resolve.misprediction),
        .upd_provider   (tage_provider),
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

    logic sc_override;
    logic sc_taken;

    sc u_sc (
        .clk            (clk),
        .rst_n          (rst_n),
        .lkp_valid      (lkp_valid),
        .lkp_pc         (lkp_pc),
        .lkp_hist       (ghist_spec_q),
        .lkp_tage_taken (tage_taken),
        .lkp_tage_lowconf(tage_lowconf),
        .lkp_override   (sc_override),
        .lkp_taken      (sc_taken),
        .upd_valid      (resolve.valid && resolve.actual_kind == BR_COND),
        .upd_pc         (resolve.pc),
        .upd_hist       (ghist_arch_q),
        .upd_taken      (resolve.actual_taken),
        .upd_tage_lowconf(tage_lowconf)
    );

    logic loop_hit;
    logic loop_taken;
    logic loop_pmu_hit;

    loop_predictor u_loop (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_hit    (loop_hit),
        .lkp_taken  (loop_taken),
        .pmu_hit    (loop_pmu_hit),
        .upd_valid  (resolve.valid && resolve.actual_kind == BR_COND),
        .upd_pc     (resolve.pc),
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

    // RAS push/pop signals are derived from the FTB-decoded branch kind.
    // CALL: push the call's fall-through PC (stored in the FTB on the
    // matching update); the resolver supplies the same address on commit.
    // RET: pop the top. Pure indirect (BR_IND) does not push or pop.
    assign ras_spec_push      = lkp_valid && ftb_hit && (ftb_kind == BR_CALL);
    assign ras_spec_pop       = lkp_valid && ftb_hit && (ftb_kind == BR_RET);
    assign ras_spec_push_addr = ftb_fall_through_pc;

    e1_bpu_ras u_ras (
        .clk            (clk),
        .rst_n          (rst_n),
        .spec_push      (ras_spec_push),
        .spec_push_addr (ras_spec_push_addr),
        .spec_pop       (ras_spec_pop),
        .spec_top_addr  (ras_top_addr),
        .spec_top_valid (ras_top_valid),
        .spec_top_idx   (ras_top_idx),
        .commit_push    (resolve.valid && resolve.actual_kind == BR_CALL),
        .commit_push_addr(resolve.actual_call_return_pc),
        .commit_pop     (resolve.valid && resolve.actual_kind == BR_RET),
        .restore_valid  (resolve.valid && resolve.misprediction),
        .restore_top    (ras_top_idx),
        .pmu_overflow   (ras_pmu_ovf),
        .pmu_underflow  (ras_pmu_unf)
    );

    logic                                  itt_hit;
    logic [VADDR_W-1:0]                    itt_target;
    logic [$clog2(ITTAGE_TABLES+1)-1:0]    itt_provider;

    // ITTAGE trains on both call and pure-indirect targets. Returns are
    // handled by the RAS and must not be fed into ITTAGE, otherwise the
    // table is corrupted by the return-address stream.
    ittage u_ittage (
        .clk        (clk),
        .rst_n      (rst_n),
        .lkp_valid  (lkp_valid),
        .lkp_pc     (lkp_pc),
        .lkp_hist   (ghist_spec_q),
        .lkp_hit    (itt_hit),
        .lkp_target (itt_target),
        .lkp_provider(itt_provider),
        .upd_valid  (resolve.valid && (resolve.actual_kind == BR_CALL ||
                                         resolve.actual_kind == BR_IND)),
        .upd_pc     (resolve.pc),
        .upd_hist   (ghist_arch_q),
        .upd_target (resolve.actual_target),
        .upd_misp   (resolve.misprediction),
        .upd_provider(itt_provider)
    );

    // -----------------------------------------------------------------------
    // Final prediction arbitration. Priority:
    //   1. Loop predictor (when confident)
    //   2. SC override of TAGE
    //   3. TAGE direction for conditional branches
    //   4. RAS for returns
    //   5. ITTAGE for indirect jumps
    //   6. FTB target otherwise
    // -----------------------------------------------------------------------
    bpu_lookup_t pred_d;
    logic        pred_taken_final;

    always_comb begin
        pred_d           = '0;
        pred_taken_final = 1'b0;
        if (lkp_valid) begin
            pred_d.valid    = 1'b1;
            pred_d.start_pc = lkp_pc[VADDR_W-1:0];
            pred_d.kind     = ftb_hit ? ftb_kind : BR_NONE;
            pred_d.from_uftb = uftb_hit;
            pred_d.from_ftb  = ftb_hit;

            if (ftb_hit && ftb_kind == BR_RET) begin
                pred_d.target_pc = ras_top_valid ? ras_top_addr : ftb_target;
                pred_d.taken     = 1'b1;
                pred_d.from_ras  = ras_top_valid;
            end else if (ftb_hit && (ftb_kind == BR_CALL || ftb_kind == BR_IND)) begin
                // Call and pure indirect both use ITTAGE for target prediction.
                // RAS push is gated separately on BR_CALL above.
                pred_d.target_pc = itt_hit ? itt_target : ftb_target;
                pred_d.taken     = 1'b1;
                pred_d.from_ittage = itt_hit;
            end else if (ftb_hit && ftb_kind == BR_COND) begin
                if (loop_hit) begin
                    pred_taken_final = loop_taken;
                    pred_d.from_loop = 1'b1;
                end else if (sc_override) begin
                    pred_taken_final = sc_taken;
                    pred_d.from_sc   = 1'b1;
                end else begin
                    pred_taken_final = tage_taken;
                    pred_d.from_tage = (tage_provider != 0);
                end
                pred_d.taken     = pred_taken_final;
                pred_d.target_pc = pred_taken_final ? ftb_target :
                                                       (lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES));
            end else if (uftb_hit) begin
                pred_d.target_pc = uftb_next_pc;
                pred_d.taken     = 1'b1;
            end else begin
                pred_d.target_pc = lkp_pc + VADDR_W'(FETCH_BLOCK_BYTES);
                pred_d.taken     = 1'b0;
            end
        end
    end

    assign pred_valid = lkp_valid;
    assign pred       = pred_d;

    // -----------------------------------------------------------------------
    // FTQ enqueue: package the prediction into an FTQ entry.
    // -----------------------------------------------------------------------
    ftq_entry_t push_entry;
    logic       push_valid;
    // FTQ backpressure: the BPU currently emits predictions speculatively and
    // relies on the FTQ-full PMU strobe + resolver replay to recover when the
    // FTQ is saturated. Wiring push_ready into a stall is part of the FDIP
    // workstream tracked in docs/arch/branch-prediction.md.
    /* verilator lint_off UNUSEDSIGNAL */
    logic       push_ready;
    /* verilator lint_on UNUSEDSIGNAL */

    always_comb begin
        push_entry              = '0;
        push_entry.valid        = lkp_valid && pred_d.valid;
        push_entry.start_pc     = pred_d.start_pc;
        push_entry.end_pc       = pred_d.start_pc + VADDR_W'(FETCH_BLOCK_BYTES - 1);
        push_entry.target_pc    = pred_d.target_pc;
        push_entry.taken        = pred_d.taken;
        push_entry.kind         = pred_d.kind;
        push_entry.br_taken_mask= {{(MAX_BR_PER_BLOCK-1){1'b0}}, pred_d.taken};
        push_entry.ras_spec_top = ras_top_idx;
        push_valid              = lkp_valid && pred_d.valid;
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
        .pop_ready   (fetch_pop),
        .pop_valid   (fetch_valid),
        .pop_entry   (fetch_entry),
        .flush_valid (resolve.valid && resolve.misprediction),
        .flush_idx   (resolve.ftq_idx),
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
        end else begin
            if (resolve.valid && resolve.misprediction) begin
                // On misprediction, rebuild the speculative history from the
                // architectural history (committed truth) and shift in the
                // resolved direction.
                ghist_spec_q <= {ghist_arch_q[TAGE_HIST_LEN_MAX-2:0],
                                 resolve.actual_taken};
            end else if (lkp_valid && pred_d.valid && pred_d.kind == BR_COND) begin
                ghist_spec_q <= {ghist_spec_q[TAGE_HIST_LEN_MAX-2:0],
                                 pred_d.taken};
            end
            if (resolve.valid && resolve.actual_kind == BR_COND) begin
                ghist_arch_q <= {ghist_arch_q[TAGE_HIST_LEN_MAX-2:0],
                                 resolve.actual_taken};
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
