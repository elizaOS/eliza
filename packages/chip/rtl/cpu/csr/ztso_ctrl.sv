// ztso_ctrl.sv  —  Ztso (Total Store Order) per-page selection logic.
//
// Background: RISC-V base is RVWMO (Weak Memory Ordering). Ztso is a
// ratified extension that forces TSO semantics in a controlled scope.
// The Ztso spec leaves the implementation choice of "always TSO" vs
// "selectable TSO" to the implementer; per
// docs/architecture-optimization/sota-2028/ooo-execution.md Section C the
// e1 big core targets per-page selectable TSO, controlled by a software-
// allocated PTE bit, so x86 / ARM binary translation (Box64, FEX-Emu, the
// like) can avoid the 5-15 % fence-spam tax.
//
// Encoding (informative, not yet ratified by RISC-V):
//   - PTE bit 7 (currently a "reserved for software" bit in Sv39/Sv48/Sv57)
//     is reused as the Ztso indicator: 1 = TSO required, 0 = RVWMO.
//   - The TLB carries this bit alongside the rest of the PTE leaf state.
//   - When the LSU dispatches a load/store, it consults the TLB's Ztso bit
//     and tags the memory op with ord_mode = TSO | RVWMO.
//   - When *any* in-flight memory op is TSO-tagged, the LSU must (a) drain
//     the store queue on store ordering, (b) inhibit load reordering past
//     a TSO load.
//   - A whole-core toggle (CSR menvcfg.ztso=1 in RVA23 hypervisor mode) is
//     planned but not in this stub.
//
// This module is the *control* surface. The actual LSU enforcement lives
// in the OoO LSU when that lands; the memory agent owns the cache/SLC
// side. We expose a CSR-readable "current effective Ztso mode" and a TLB-
// fed "page TSO bit" so cocotb can prove the plumbing end-to-end.
//
// SAFETY: this is a research feature. It MUST default to RVWMO at reset.
// Per the Ztso spec, code generated under RVWMO must remain correct under
// TSO (TSO is stricter), so flipping a page to TSO never breaks correct
// RVWMO software; the opposite is unsafe and is fail-closed gated.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
module ztso_ctrl #(
    parameter int unsigned XLEN = 64
) (
    input  logic              clk_i,
    input  logic              rst_ni,

    // CSR write port. Ztso global enable lives in custom CSR 0x7C0
    // (machine-mode custom region 0x7C0..0x7FF), bit 0 = global Ztso
    // permission (page bits still required). Bit 1 = whole-core TSO
    // override (forces all pages TSO, for testing).
    input  logic              csr_we_i,
    input  logic [11:0]       csr_addr_i,
    input  logic [XLEN-1:0]   csr_wdata_i,

    input  logic [11:0]       csr_raddr_i,
    output logic [XLEN-1:0]   csr_rdata_o,
    output logic              csr_rvalid_o,

    // TLB feed: when a memory op resolves a translation, the TLB tells us
    // whether the resolved page has its Ztso bit set.
    input  logic              tlb_resolve_valid_i,
    input  logic              tlb_page_ztso_bit_i,

    // LSU effective-mode export: 1 = this op should follow TSO, 0 = RVWMO.
    output logic              lsu_op_is_tso_o
);

    logic ztso_global_en_q;
    logic ztso_core_force_q;
    logic ztso_last_page_q;

    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            ztso_global_en_q  <= 1'b0;
            ztso_core_force_q <= 1'b0;
            ztso_last_page_q  <= 1'b0;
        end else begin
            if (csr_we_i && csr_addr_i == 12'h7C0) begin
                ztso_global_en_q  <= csr_wdata_i[0];
                ztso_core_force_q <= csr_wdata_i[1];
            end
            if (tlb_resolve_valid_i) begin
                ztso_last_page_q <= tlb_page_ztso_bit_i;
            end
        end
    end

    always_comb begin
        csr_rdata_o  = '0;
        csr_rvalid_o = 1'b0;
        if (csr_raddr_i == 12'h7C0) begin
            csr_rdata_o[0] = ztso_global_en_q;
            csr_rdata_o[1] = ztso_core_force_q;
            csr_rdata_o[2] = ztso_last_page_q;
            csr_rvalid_o   = 1'b1;
        end
    end

    // Effective Ztso for the next LSU op:
    //   - if core-force, always TSO
    //   - else if global enabled and the last resolved page was TSO, TSO
    //   - else RVWMO
    assign lsu_op_is_tso_o = ztso_core_force_q
                             | (ztso_global_en_q & ztso_last_page_q);

    // Only csr_wdata_i[1:0] is consumed by the e1_ztso_ctrl CSR. The upper
    // bits are reserved for future microarchitectural knobs; document the
    // intent so the unused-bit lint is satisfied without hiding real bugs.
    logic unused_csr_wdata_upper;
    assign unused_csr_wdata_upper = ^csr_wdata_i[XLEN-1:2];

endmodule
/* verilator lint_on DECLFILENAME */
