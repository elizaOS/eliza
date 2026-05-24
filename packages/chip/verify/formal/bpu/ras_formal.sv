// ras_formal.sv — SymbiYosys formal harness for the RAS.
//
// Proves one bounded invariant:
//   1. The speculative SP never increments past RAS_SPEC_ENTRIES.
//
// The harness avoids `$past` deliberately so the bitwuzla / z3 backends both
// converge on the same answer; FORMAL monitor ports expose the DUT state used
// by the properties.

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
    logic                 flush;
    logic                 restore_valid;
    logic [RAS_IDX_W:0]   restore_top;
    logic                 restore_entry_valid;
    logic [VADDR_W-1:0]   restore_entry_addr;
    logic                 pmu_overflow;
    logic                 pmu_underflow;
    logic [RAS_IDX_W:0]   formal_spec_sp;
    logic [$clog2(RAS_ARCH_ENTRIES+1)-1:0] formal_arch_sp;

    assign restore_valid = 1'b0;
    assign restore_top   = '0;
    assign restore_entry_valid = 1'b0;
    assign restore_entry_addr  = '0;
    assign flush = 1'b0;

    e1_bpu_ras dut (.clk(clk), .rst_n(rst_n), .*);

    // Settle counter for the assertion guard. We only check invariants after
    // the BMC has observed the rising edge of rst_n.
    logic [2:0] settle_cnt;
    logic       saw_reset_cycle;
    initial settle_cnt = 3'b0;
    initial saw_reset_cycle = 1'b0;

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
            assume(formal_spec_sp == '0);
            assume(formal_arch_sp == '0);
            assume(pmu_overflow == 1'b0);
            assume(pmu_underflow == 1'b0);
        end

        if (rst_n && settle_cnt >= 3'd2) begin
            // Invariant: the speculative pointer is in range.
            assert(formal_spec_sp <= RAS_SPEC_ENTRIES[RAS_IDX_W:0]);
        end
    end

endmodule
