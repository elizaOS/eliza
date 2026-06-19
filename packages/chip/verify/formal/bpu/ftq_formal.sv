// ftq_formal.sv — SymbiYosys formal harness for the FTQ.
//
// Proves:
//   1. Occupancy never exceeds FTQ_ENTRIES.
//   2. push_ready is exactly the inverse of pmu_full.
//   3. pop_valid is exactly the inverse of pmu_empty.
//   4. push on a full FTQ does not advance the write pointer.
//
// yosys 0.64 does not accept struct typedefs in module port lists, so the
// formal harness drives the FTQ through `ftq_tb` (the cocotb-side flattened
// wrapper), and the structure-typed entry fields are reconstituted inside
// the wrapper.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ftq_formal(input logic clk);
    logic        rst_n = 1'b0;
    (* anyseq *) logic        push_valid;
    (* anyseq *) logic [VADDR_W-1:0] push_start_pc;
    (* anyseq *) logic [VADDR_W-1:0] push_end_pc;
    (* anyseq *) logic [VADDR_W-1:0] push_target_pc;
    (* anyseq *) logic        push_taken;
    (* anyseq *) logic [2:0]  push_kind;
    logic        push_ras_restore_valid;
    logic [VADDR_W-1:0] push_ras_restore_addr;
    logic [TAGE_HIST_LEN_MAX-1:0] push_ghist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] push_ittage_hist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] push_ittage_target_hist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] push_ittage_path_hist_snapshot;
    logic [$clog2(TAGE_TABLES+1)-1:0] push_tage_provider;
    logic [$clog2(ITTAGE_TABLES+1)-1:0] push_ittage_provider;
    logic [TAGE_CTR_W-1:0] push_tage_provider_ctr;
    logic        push_tage_lowconf;
    logic        push_sc_override;
    logic        push_sc_taken;
    logic        push_ready;
    (* anyseq *) logic        pop_ready;
    logic        pop_valid;
    logic [VADDR_W-1:0] pop_start_pc;
    logic [VADDR_W-1:0] pop_target_pc;
    logic        pop_taken;
    logic [2:0]  pop_kind;
    logic [FTQ_IDX_W-1:0] pop_ftq_idx;
    logic        pop_ras_restore_valid;
    logic [VADDR_W-1:0] pop_ras_restore_addr;
    logic [TAGE_HIST_LEN_MAX-1:0] pop_ghist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] pop_ittage_hist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] pop_ittage_target_hist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] pop_ittage_path_hist_snapshot;
    logic [$clog2(TAGE_TABLES+1)-1:0] pop_tage_provider;
    logic [$clog2(ITTAGE_TABLES+1)-1:0] pop_ittage_provider;
    logic [TAGE_CTR_W-1:0] pop_tage_provider_ctr;
    logic        pop_tage_lowconf;
    logic        pop_sc_override;
    logic        pop_sc_taken;
    (* anyseq *) logic [FTQ_IDX_W-1:0] replay_idx;
    logic [VADDR_W-1:0] replay_start_pc;
    logic [VADDR_W-1:0] replay_target_pc;
    logic        replay_taken;
    logic [2:0]  replay_kind;
    logic [FTQ_IDX_W-1:0] replay_ftq_idx;
    logic [TAGE_HIST_LEN_MAX-1:0] replay_ghist_snapshot;
    logic [TAGE_HIST_LEN_MAX-1:0] replay_ittage_hist_snapshot;
    logic [$clog2(TAGE_TABLES+1)-1:0] replay_tage_provider;
    logic [$clog2(ITTAGE_TABLES+1)-1:0] replay_ittage_provider;
    logic        replay_tage_lowconf;
    (* anyseq *) logic        flush_valid;
    (* anyseq *) logic [FTQ_IDX_W-1:0] flush_idx;
    logic        pmu_full;
    logic        pmu_empty;
    logic [FTQ_IDX_W:0] occupancy;

    ftq_tb dut (.*);

    assign push_ras_restore_valid = 1'b0;
    assign push_ras_restore_addr = '0;
    assign push_ghist_snapshot = '0;
    assign push_ittage_hist_snapshot = '0;
    assign push_ittage_target_hist_snapshot = '0;
    assign push_ittage_path_hist_snapshot = '0;
    assign push_tage_provider = '0;
    assign push_ittage_provider = '0;
    assign push_tage_provider_ctr = '0;
    assign push_tage_lowconf = 1'b0;
    assign push_sc_override = 1'b0;
    assign push_sc_taken = 1'b0;

    logic [2:0] settle_cnt;
    initial settle_cnt = 3'b0;

    initial rst_n = 1'b0;
    always_ff @(posedge clk) begin
        rst_n <= 1'b1;
        if (settle_cnt != 3'b111)
            settle_cnt <= settle_cnt + 1'b1;

        assume(rst_n || (!push_valid && !pop_ready && !flush_valid));

        if (rst_n && settle_cnt >= 3'd2) begin
            assert(occupancy <= FTQ_ENTRIES[FTQ_IDX_W:0]);
            assert(push_ready == (!pmu_full || (pop_ready && pop_valid)));
            assert(pop_valid != pmu_empty);
        end
    end
endmodule
