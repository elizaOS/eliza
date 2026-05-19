// ftq_formal.sv — SymbiYosys formal harness for the FTQ.
//
// Proves:
//   1. Occupancy never exceeds FTQ_ENTRIES.
//   2. push_ready is exactly the inverse of pmu_full.
//   3. pop_valid is exactly the inverse of pmu_empty.
//   4. push on a full FTQ does not advance the write pointer.

`timescale 1ns/1ps

module ftq_formal(input logic clk);
    import bpu_pkg::*;

    logic        rst_n = 1'b0;
    (* anyseq *) logic        push_valid;
    (* anyseq *) ftq_entry_t  push_entry;
    logic        push_ready;
    (* anyseq *) logic        pop_ready;
    logic        pop_valid;
    ftq_entry_t  pop_entry;
    (* anyseq *) logic        flush_valid;
    (* anyseq *) logic [FTQ_IDX_W-1:0] flush_idx;
    logic        pmu_full;
    logic        pmu_empty;
    logic [FTQ_IDX_W:0] occupancy;

    ftq dut(.*);

    initial rst_n = 1'b0;
    always_ff @(posedge clk) begin
        rst_n <= 1'b1;
        if (rst_n) begin
            assert(occupancy <= FTQ_ENTRIES[FTQ_IDX_W:0]);
            assert(push_ready != pmu_full);
            assert(pop_valid != pmu_empty);
            if ($past(push_valid) && !$past(push_ready) && !$past(flush_valid))
                assert(dut.wr_ptr_q == $past(dut.wr_ptr_q));
        end
    end
endmodule
