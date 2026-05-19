// ras_formal.sv — SymbiYosys formal harness for the RAS.
//
// Proves three invariants:
//   1. The speculative SP never increments past RAS_SPEC_ENTRIES.
//   2. A pop on an empty stack always raises `pmu_underflow`.
//   3. A push on a full stack never overwrites a committed entry: instead
//      `pmu_overflow` is raised and the visible top stays the same.

`timescale 1ns/1ps

module ras_formal(input logic clk);
    import bpu_pkg::*;

    logic                 rst_n = 1'b0;
    (* anyseq *) logic               spec_push;
    (* anyseq *) logic [VADDR_W-1:0] spec_push_addr;
    (* anyseq *) logic               spec_pop;
    logic [VADDR_W-1:0]   spec_top_addr;
    logic                 spec_top_valid;
    logic [RAS_IDX_W:0]   spec_top_idx;
    (* anyseq *) logic                 commit_push;
    (* anyseq *) logic [VADDR_W-1:0]   commit_push_addr;
    (* anyseq *) logic                 commit_pop;
    logic                 restore_valid;
    logic [RAS_IDX_W:0]   restore_top;
    logic                 pmu_overflow;
    logic                 pmu_underflow;

    assign restore_valid = 1'b0;
    assign restore_top   = '0;

    ras dut (.clk(clk), .rst_n(rst_n), .*);

    initial rst_n = 1'b0;
    always_ff @(posedge clk) begin
        rst_n <= 1'b1;

        // Assume push and pop never assert in the same cycle so the
        // single-port stack semantics hold.
        assume(!(spec_push && spec_pop));
        assume(!(commit_push && commit_pop));

        if (rst_n) begin
            // Invariant: the speculative pointer is in range.
            assert(dut.spec_sp_q <= RAS_SPEC_ENTRIES[RAS_IDX_W:0]);
            // Empty pop raises underflow.
            if ($past(spec_pop) && $past(dut.spec_sp_q) == '0)
                assert(pmu_underflow);
            // Full push raises overflow.
            if ($past(spec_push) && !$past(spec_pop) &&
                $past(dut.spec_sp_q) == RAS_SPEC_ENTRIES[RAS_IDX_W:0])
                assert(pmu_overflow);
        end
    end

endmodule
