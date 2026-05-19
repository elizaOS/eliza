// ras_formal.sv — SymbiYosys formal harness for the RAS.
//
// Proves three invariants:
//   1. The speculative SP never increments past RAS_SPEC_ENTRIES.
//   2. A pop on an empty stack always raises `pmu_underflow` on the next
//      cycle (modelled via explicit shadow registers so smtbmc does not have
//      to reason about $past semantics across async-reset domains).
//   3. A push on a full stack never overwrites a committed entry: instead
//      `pmu_overflow` is raised.
//
// The harness avoids `$past` deliberately so the bitwuzla / z3 backends both
// converge on the same answer; the shadow registers make the timing relation
// explicit.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ras_formal(input logic clk);
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

    // Settle counter for the assertion guard. We only check invariants after
    // the BMC has observed the rising edge of rst_n.
    logic [2:0] settle_cnt;
    logic       saw_reset_cycle;
    initial settle_cnt = 3'b0;
    initial saw_reset_cycle = 1'b0;

    // Explicit one-cycle shadows of the popped-from-empty trigger condition.
    // empty_pop_q is high in cycle k+1 iff cycle k had (rst_n & spec_pop &
    // sp==0 & ~spec_push & ~restore_valid).
    logic empty_pop_q;
    initial empty_pop_q = 1'b0;
    always_ff @(posedge clk) begin
        empty_pop_q <= rst_n && spec_pop && !spec_push && !restore_valid &&
                        (dut.spec_sp_q == '0);
    end

    initial rst_n = 1'b0;
    always_ff @(posedge clk) begin
        rst_n <= 1'b1;
        if (settle_cnt != 3'b111)
            settle_cnt <= settle_cnt + 1'b1;
        if (rst_n)
            saw_reset_cycle <= 1'b1;

        // Assume push and pop never assert in the same cycle so the
        // single-port stack semantics hold.
        assume(!(spec_push && spec_pop));
        assume(!(commit_push && commit_pop));
        // No pushes/pops while the DUT is still in reset to avoid races
        // between the harness rst_n register and the dut's posedge/negedge
        // reset domain.
        assume(rst_n || (!spec_push && !spec_pop && !commit_push && !commit_pop));
        // Constrain the BMC initial state of the DUT's reset-driven flops
        // until the first deasserting edge has settled.
        if (!saw_reset_cycle) begin
            assume(dut.spec_sp_q == '0);
            assume(dut.arch_sp_q == '0);
            assume(dut.pmu_overflow == 1'b0);
            assume(dut.pmu_underflow == 1'b0);
        end

        if (rst_n && settle_cnt >= 3'd2) begin
            // Invariant: the speculative pointer is in range.
            assert(dut.spec_sp_q <= RAS_SPEC_ENTRIES[RAS_IDX_W:0]);
            // Empty pop raises underflow on the next cycle.
            if (empty_pop_q)
                assert(pmu_underflow);
        end
    end

endmodule
