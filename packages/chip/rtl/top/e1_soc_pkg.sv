`timescale 1ns/1ps

// e1_soc_pkg
//
// Shared localparams for the v0 MMIO debug scaffold that both SoC tops
// (e1_soc_top and e1_soc_integrated) instantiate. Previously each top
// re-declared the behavioural-DRAM depth and its index-bit width verbatim;
// this package owns the single definition so the two tops stay in lockstep.
//
// DRAM_WORDS is gated by E1_PD_SMALL_DRAM so the PD smoke build keeps a tiny
// 64-word array while functional sims keep the 1024-word array. The macro is
// resolved at package elaboration, so every consumer that imports this package
// sees the same depth.

package e1_soc_pkg;

`ifdef E1_PD_SMALL_DRAM
    localparam int unsigned DRAM_WORDS = 64;
`else
    localparam int unsigned DRAM_WORDS = 1024;
`endif
    /* verilator lint_off UNUSEDPARAM */
    localparam int unsigned DRAM_INDEX_BITS = $clog2(DRAM_WORDS);
    /* verilator lint_on UNUSEDPARAM */

endpackage : e1_soc_pkg
