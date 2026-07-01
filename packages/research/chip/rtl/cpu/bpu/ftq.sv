// ftq.sv — Fetch Target Queue.
//
// Decouples the BPU from instruction fetch. The BPU writes predicted fetch
// blocks into the FTQ; the fetch engine pops them and issues L1I requests.
// The resolver updates an FTQ entry on branch resolve, and on misprediction
// flushes the FTQ tail back to the offending entry so a new prediction can
// be written.
//
// Pointers are one bit wider than the index width so wraparound is handled
// by comparing the high bit (full when read and write pointers differ only
// in the high bit, empty when equal).

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ftq (
    input  logic                clk,
    input  logic                rst_n,

    // BPU push interface.
    input  logic                push_valid,
    input  ftq_entry_t          push_entry,
    output logic                push_ready,
    output logic [FTQ_IDX_W:0]  push_ptr,

    // Late target patch. Delayed predictor tiers may correct an entry that
    // has already been enqueued; the FTQ keeps prediction-time metadata and
    // only patches the forward fetch contract and branch-slot payload.
    input  logic                patch_valid,
    input  logic [FTQ_IDX_W:0]  patch_ptr,
    input  ftq_entry_t          patch_entry,
    input  logic                patch_flush_younger,
    output logic                patch_applied,

    // Fetch pop interface.
    input  logic                pop_ready,
    output logic                pop_valid,
    output ftq_entry_t          pop_entry,

    // Commit/replay metadata read. The resolver supplies the FTQ index of
    // the retiring branch; predictor update paths replay the prediction-time
    // metadata from that entry instead of requiring the backend to mirror it.
    input  logic [FTQ_IDX_W-1:0] replay_idx,
    output ftq_entry_t          replay_entry,

    // Resolver flush: drop every entry above (inclusive of) `flush_idx`.
    input  logic                flush_valid,
    input  logic [FTQ_IDX_W-1:0] flush_idx,
    input  logic                global_flush,

    output logic                pmu_full,
    output logic                pmu_empty,
    output logic [FTQ_IDX_W:0]  occupancy
);

    ftq_entry_t storage_q [FTQ_ENTRIES];
    logic [FTQ_IDX_W:0] wr_ptr_q;
    logic [FTQ_IDX_W:0] rd_ptr_q;

    logic full;
    logic empty;
    ftq_entry_t push_entry_with_idx;
    logic patch_live;
    logic patch_popping_head;
    logic flush_popping_head;
    /* verilator lint_off UNUSEDSIGNAL */
    ftq_entry_t patch_entry_unused;
    /* verilator lint_on UNUSEDSIGNAL */

    assign full  = (wr_ptr_q[FTQ_IDX_W] != rd_ptr_q[FTQ_IDX_W]) &&
                   (wr_ptr_q[FTQ_IDX_W-1:0] == rd_ptr_q[FTQ_IDX_W-1:0]);
    assign empty = (wr_ptr_q == rd_ptr_q);

    assign push_ready = !full || (pop_ready && pop_valid);
    assign pop_valid  = !empty;
    assign pop_entry  = storage_q[rd_ptr_q[FTQ_IDX_W-1:0]];
    assign replay_entry = storage_q[replay_idx];
    assign push_ptr = wr_ptr_q;
    assign patch_entry_unused = patch_entry;

    assign patch_live = ((patch_ptr - rd_ptr_q) < (wr_ptr_q - rd_ptr_q));
    assign patch_popping_head = pop_ready && pop_valid && (patch_ptr == rd_ptr_q);
    assign patch_applied = patch_valid && patch_live && !patch_popping_head &&
                           !flush_valid && !global_flush;
    assign flush_popping_head =
        pop_ready && pop_valid && (flush_idx == rd_ptr_q[FTQ_IDX_W-1:0]);

    assign occupancy = wr_ptr_q - rd_ptr_q;
    assign pmu_full  = full;
    assign pmu_empty = empty;

    always_comb begin
        push_entry_with_idx         = push_entry;
        push_entry_with_idx.ftq_idx = wr_ptr_q[FTQ_IDX_W-1:0];
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr_q <= '0;
            rd_ptr_q <= '0;
            for (int unsigned i = 0; i < FTQ_ENTRIES; i++) begin
                storage_q[i] <= '{
                    valid:        1'b0,
                    ctx:      '0,
                    start_pc:     '0,
                    end_pc:       '0,
                    target_pc:    '0,
                    taken:        1'b0,
                    kind:         BR_NONE,
                    fetch_segments:'0,
                    br_taken_mask:'0,
                    br_slots:     '0,
                    ftq_idx:      '0,
                    ras_spec_top: '0,
                    ras_restore_valid: 1'b0,
                    ras_restore_addr: '0,
                    ghist_snapshot: '0,
                    tage_path_hist_snapshot: '0,
                    ittage_hist_snapshot: '0,
                    ittage_target_hist_snapshot: '0,
                    ittage_path_hist_snapshot: '0,
                    tage_provider: '0,
                    ittage_provider: '0,
                    tage_provider_ctr: '0,
                    tage_lowconf: 1'b0,
                    tage_provider_taken: 1'b0,
                    tage_alt_taken: 1'b0,
                    sc_override: 1'b0,
                    sc_taken: 1'b0,
                    h2p_conf: 1'b0,
                    h2p_taken: 1'b0,
                    local_dir_conf: 1'b0,
                    local_dir_taken: 1'b0,
                    local_dir_train_valid: 1'b0,
                    local_dir_base_taken: 1'b0
                };
            end
        end else begin
            if (global_flush) begin
                wr_ptr_q <= rd_ptr_q;
                for (int unsigned i = 0; i < FTQ_ENTRIES; i++) begin
                    storage_q[i].valid <= 1'b0;
                end
            end else if (flush_valid) begin
                wr_ptr_q <= flush_popping_head ?
                    (rd_ptr_q + 1'b1) : {wr_ptr_q[FTQ_IDX_W], flush_idx};
            end else begin
                if (patch_applied) begin
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].end_pc <=
                        patch_entry.end_pc;
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].target_pc <=
                        patch_entry.target_pc;
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].taken <=
                        patch_entry.taken;
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].kind <=
                        patch_entry.kind;
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].fetch_segments <=
                        patch_entry.fetch_segments;
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].br_taken_mask <=
                        patch_entry.br_taken_mask;
                    storage_q[patch_ptr[FTQ_IDX_W-1:0]].br_slots <=
                        patch_entry.br_slots;
                    if (patch_flush_younger) begin
                        wr_ptr_q <= patch_ptr + 1'b1;
                    end
                end
                if ((!patch_applied || !patch_flush_younger) &&
                    push_valid && push_ready) begin
                    storage_q[wr_ptr_q[FTQ_IDX_W-1:0]] <= push_entry_with_idx;
                    wr_ptr_q <= wr_ptr_q + 1'b1;
                end
            end
            if (!global_flush && pop_ready && pop_valid) begin
                rd_ptr_q <= rd_ptr_q + 1'b1;
            end
        end
    end

endmodule : ftq
