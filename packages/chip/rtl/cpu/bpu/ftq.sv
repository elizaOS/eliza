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

    assign full  = (wr_ptr_q[FTQ_IDX_W] != rd_ptr_q[FTQ_IDX_W]) &&
                   (wr_ptr_q[FTQ_IDX_W-1:0] == rd_ptr_q[FTQ_IDX_W-1:0]);
    assign empty = (wr_ptr_q == rd_ptr_q);

    assign push_ready = !full || (pop_ready && pop_valid);
    assign pop_valid  = !empty;
    assign pop_entry  = storage_q[rd_ptr_q[FTQ_IDX_W-1:0]];
    assign replay_entry = storage_q[replay_idx];

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
                    start_pc:     '0,
                    end_pc:       '0,
                    target_pc:    '0,
                    taken:        1'b0,
                    kind:         BR_NONE,
                    br_taken_mask:'0,
                    br_slots:     '0,
                    ftq_idx:      '0,
                    ras_spec_top: '0,
                    ras_restore_valid: 1'b0,
                    ras_restore_addr: '0,
                    ghist_snapshot: '0,
                    ittage_hist_snapshot: '0,
                    ittage_target_hist_snapshot: '0,
                    ittage_path_hist_snapshot: '0,
                    tage_provider: '0,
                    ittage_provider: '0,
                    tage_provider_ctr: '0,
                    tage_lowconf: 1'b0,
                    sc_override: 1'b0,
                    sc_taken: 1'b0
                };
            end
        end else begin
            if (flush_valid) begin
                wr_ptr_q <= {wr_ptr_q[FTQ_IDX_W], flush_idx};
            end else if (push_valid && push_ready) begin
                storage_q[wr_ptr_q[FTQ_IDX_W-1:0]] <= push_entry_with_idx;
                wr_ptr_q <= wr_ptr_q + 1'b1;
            end
            if (pop_ready && pop_valid) begin
                rd_ptr_q <= rd_ptr_q + 1'b1;
            end
        end
    end

endmodule : ftq
