// zihpm.sv  —  RISC-V Zihpm hardware performance counters for the e1 cluster.
//
// Zihpm spec: counters 3..31 are programmable. Counter 0 (mcycle) is the
// cycle counter; 1 is reserved; 2 (minstret) is the retired-instruction
// counter. We expose 13 programmable HPM counters (3..15) driven by event
// selectors at the cluster boundary. Each counter is 64-bit and has an
// hpmevent CSR that selects which cluster event drives it.
//
// Event encoding is the canonical OoO/CSR cross-domain contract. The BPU,
// cache, IOMMU, and memory agents emit raw per-domain events; the
// `bpu_to_zihpm_remap` and per-domain remap adapters in `rtl/cpu/csr/`
// translate each into a one-hot strobe on `event_bus_i[id]` using the
// `hpm_event_e` enumeration below. The CSR-visible event IDs in
// `hpm_event_e` are the authoritative system-level identifiers.
//
// CSR mapping (machine mode, supervisor mirrors below):
//   mcycle           = 0xB00  (counter[0])
//   minstret         = 0xB02  (counter[2])
//   mhpmcounter3..15 = 0xB03..0xB0F
//   mhpmevent3..15   = 0x323..0x32F
//
// Per Sscofpmf, overflow generates an LCOFI interrupt; counter_overflow_o
// strobes on wrap so the integrator can route them to a Smaia interrupt
// file. Full LCOFI delivery (mhpmevent[63] inhibit, scountovf CSR) is the
// integrator's responsibility.
//
// Event IDs are encoded in `hpm_event_e`. The selector value `0` is the
// canonical "no event" — the counter stays still even when not inhibited.

`timescale 1ns/1ps

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDPARAM */
`ifndef ZIHPM_PKG_DEFINED
`define ZIHPM_PKG_DEFINED
package zihpm_pkg;

    // Event identifier bit width. 8 bits is enough for the 30 events we
    // currently enumerate plus room for caches/IOMMU agents to add their
    // own up to ~250 total.
    localparam int unsigned EVT_W = 8;

    // PMU event identifiers — coordinated across the OoO, BPU, cache,
    // memory, and IOMMU agents. Event 0 is the no-event sentinel.
    typedef enum logic [EVT_W-1:0] {
        EVT_NONE                = 8'd0,

        // ---- Branch / front-end events (BPU agent owns the source) ----
        EVT_BR_PRED             = 8'd1,
        EVT_BR_TAKEN            = 8'd2,
        EVT_BR_MISP             = 8'd3,
        EVT_BR_COND             = 8'd4,
        EVT_BR_COND_MISP        = 8'd5,
        EVT_BR_IND              = 8'd6,
        EVT_BR_IND_MISP         = 8'd7,
        EVT_BR_CALL             = 8'd8,
        EVT_BR_RET              = 8'd9,
        EVT_BR_RET_MISP         = 8'd10,
        EVT_RAS_OVERFLOW        = 8'd11,
        EVT_RAS_UNDERFLOW       = 8'd12,
        EVT_FTQ_FULL            = 8'd13,
        EVT_FTQ_EMPTY           = 8'd14,
        EVT_FETCH_BUBBLE        = 8'd15,
        EVT_BTB_MISS            = 8'd16,
        EVT_UFTB_HIT            = 8'd17,
        EVT_TAGE_ALLOC          = 8'd18,
        EVT_LOOP_HIT            = 8'd19,
        EVT_SC_OVERRIDE         = 8'd20,

        // ---- Cache / memory events (cache agent owns the source) ----
        EVT_L1I_MISS            = 8'd32,
        EVT_L1D_MISS            = 8'd33,
        EVT_L2_MISS             = 8'd34,
        EVT_L3_MISS             = 8'd35,
        EVT_SLC_MISS            = 8'd36,
        EVT_L1I_PREFETCH        = 8'd37,
        EVT_L1D_PREFETCH        = 8'd38,
        EVT_L2_PREFETCH         = 8'd39,
        EVT_DCACHE_HIT_UNDER_MISS = 8'd40,

        // ---- MMU / TLB events (memory agent + this agent share) -----
        EVT_DTLB_MISS           = 8'd48,
        EVT_ITLB_MISS           = 8'd49,
        EVT_PTW_WALK            = 8'd50,
        EVT_PTW_MULTI_LEVEL     = 8'd51,
        EVT_TLB_SHOOTDOWN       = 8'd52,

        // ---- OoO core events (this agent owns the source) -----------
        EVT_DISPATCH            = 8'd64,
        EVT_RETIRE              = 8'd65,
        EVT_ROB_FULL_STALL      = 8'd66,
        EVT_LQ_FULL_STALL       = 8'd67,
        EVT_SQ_FULL_STALL       = 8'd68,
        EVT_RS_FULL_STALL       = 8'd69,
        EVT_STORE_SET_MISP      = 8'd70,
        EVT_FUSION_FIRED        = 8'd71,
        EVT_FENCE_STALL         = 8'd72,
        EVT_AMO_OP              = 8'd73
    } hpm_event_e;

    localparam int unsigned MAX_HPM_EVENT_ID = 32'd255;

    // Convenience predicate used by remap adapters and the strict
    // harmonization checker (`scripts/check_pmu_event_alignment.py`).
    function automatic logic is_branch_event(input logic [EVT_W-1:0] id);
        return (id >= EVT_BR_PRED) && (id <= EVT_SC_OVERRIDE);
    endfunction

endpackage : zihpm_pkg
`endif

module zihpm #(
    parameter int unsigned NUM_COUNTERS = 13,  // mhpmcounter 3..15
    parameter int unsigned EVT_BUS_W    = 256, // up to 256 simultaneous events
    parameter int unsigned EVT_W        = zihpm_pkg::EVT_W
) (
    input  logic                       clk_i,
    input  logic                       rst_ni,

    // Event bus: bit `i` asserted on a cycle means event id `i` fired this
    // cycle. Counter increments by popcount of (event_mask & selector_mask)
    // per cycle — equivalent to one increment per selected event firing.
    input  logic [EVT_BUS_W-1:0]       event_bus_i,

    // Inhibit per counter (per mcountinhibit). Bit 0 → cycle (counter 0),
    // bit 2 → instret, bits 3..15 → programmable counters. Bit 1 is reserved.
    input  logic [15:0]                mcountinhibit_i,

    // Hard-wired "instruction retired this cycle" pulse from rename/retire.
    input  logic                       instret_pulse_i,

    // CSR write interface for event selector + counter writes.
    input  logic                       csr_we_i,
    input  logic [11:0]                csr_addr_i,
    input  logic [63:0]                csr_wdata_i,

    // CSR read interface.
    input  logic [11:0]                csr_raddr_i,
    output logic [63:0]                csr_rdata_o,
    output logic                       csr_rvalid_o,

    // Counter overflow strobes (one bit per programmable counter). The
    // back-end can route these to LCOFI per Sscofpmf when implemented.
    output logic [NUM_COUNTERS-1:0]    counter_overflow_o
);

    // -------------------------------------------------------------------
    // Counters
    // -------------------------------------------------------------------
    logic [63:0] mcycle;
    logic [63:0] minstret;
    logic [63:0] mhpmcounter [NUM_COUNTERS];

    // Event selectors. Per Zihpm, an mhpmevent value of 0 disables the
    // counter; non-zero selects the event ID to count.
    logic [EVT_W-1:0] mhpmevent [NUM_COUNTERS];

    // -------------------------------------------------------------------
    // Counter update logic
    // -------------------------------------------------------------------
    // mcycle - free-running cycle counter unless inhibited.
    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            mcycle <= '0;
        end else if (!mcountinhibit_i[0]) begin
            mcycle <= mcycle + 64'd1;
        end
    end

    // minstret - retired instruction counter.
    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            minstret <= '0;
        end else if (!mcountinhibit_i[2] && instret_pulse_i) begin
            minstret <= minstret + 64'd1;
        end
    end

    // Programmable counters: increment by 1 every cycle the selected event
    // fires. Selecting EVT_NONE (=0) keeps the counter quiescent.
    logic [NUM_COUNTERS-1:0]       inhibit_w;
    logic [NUM_COUNTERS-1:0]       sel_fired_w;
    logic [63:0]                   next_val_w [NUM_COUNTERS];
    for (genvar ci = 0; ci < NUM_COUNTERS; ci++) begin : g_hpmcounter
        always_comb begin
            sel_fired_w[ci] = 1'b0;
            if (mhpmevent[ci] != '0) begin
                sel_fired_w[ci] = event_bus_i[mhpmevent[ci]];
            end
            next_val_w[ci] = mhpmcounter[ci] + 64'd1;
        end
        // bit 3+ci of mcountinhibit gates counter (ci+3). Bit 1 is reserved
        // per Zihpm and intentionally left unconsumed; the selector code
        // path leaves bit 1 unchecked but the lint waiver below documents
        // that.
        assign inhibit_w[ci] = mcountinhibit_i[ci + 3];
        always_ff @(posedge clk_i or negedge rst_ni) begin
            if (!rst_ni) begin
                mhpmcounter[ci]        <= '0;
                counter_overflow_o[ci] <= 1'b0;
            end else if (!inhibit_w[ci] && sel_fired_w[ci]) begin
                mhpmcounter[ci]        <= next_val_w[ci];
                counter_overflow_o[ci] <= (next_val_w[ci] == 64'd0);
            end else begin
                counter_overflow_o[ci] <= 1'b0;
            end
        end
    end

    // Width-matched per-counter index for array access. NUM_COUNTERS=13
    // needs 4 bits; we always slice the low IDX_W bits of the subtracted
    // CSR address so verilator stays happy under strict widths.
    localparam int unsigned IDX_W = (NUM_COUNTERS <= 1) ? 1 : $clog2(NUM_COUNTERS);

    // Subtracted indices, sized down to IDX_W so the part-select on the
    // mhpmcounter / mhpmevent arrays is a single clean slice. The upper
    // bits of the subtracted CSR address are checked via the range guards
    // below; only the bottom IDX_W bits index the array.
    logic [IDX_W-1:0] wr_hpmevent_off;
    logic [IDX_W-1:0] wr_hpmcnt_off;
    logic [IDX_W-1:0] rd_hpmcnt_off;
    logic [IDX_W-1:0] rd_hpmevent_off;
    assign wr_hpmevent_off = IDX_W'(csr_addr_i  - 12'h323);
    assign wr_hpmcnt_off   = IDX_W'(csr_addr_i  - 12'hB03);
    assign rd_hpmcnt_off   = IDX_W'(csr_raddr_i - 12'hB03);
    assign rd_hpmevent_off = IDX_W'(csr_raddr_i - 12'h323);

    // Bit 1 of mcountinhibit is reserved by the Zihpm spec; we ignore it
    // but document the intent so the unused-bit lint stays clean.
    logic unused_mcountinhibit_bit1;
    assign unused_mcountinhibit_bit1 = mcountinhibit_i[1];

    // -------------------------------------------------------------------
    // CSR write path
    // -------------------------------------------------------------------
    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            for (int unsigned i = 0; i < NUM_COUNTERS; i++) begin
                mhpmevent[i] <= '0;
            end
        end else if (csr_we_i) begin
            // mhpmevent3..15 → 0x323..0x32F
            if (csr_addr_i >= 12'h323 &&
                csr_addr_i < 12'h323 + 12'(NUM_COUNTERS)) begin
                mhpmevent[wr_hpmevent_off] <= csr_wdata_i[EVT_W-1:0];
            end
            // mhpmcounter writes are allowed in M-mode per spec; CSR writes
            // to mhpmcounter clobber the value. Real impls usually disable
            // this; here we keep it for software bring-up.
            if (csr_addr_i == 12'hB00) mcycle   <= csr_wdata_i;
            if (csr_addr_i == 12'hB02) minstret <= csr_wdata_i;
            if (csr_addr_i >= 12'hB03 &&
                csr_addr_i < 12'hB03 + 12'(NUM_COUNTERS)) begin
                mhpmcounter[wr_hpmcnt_off] <= csr_wdata_i;
            end
        end
    end

    // -------------------------------------------------------------------
    // CSR read path
    // -------------------------------------------------------------------
    always_comb begin
        csr_rdata_o  = 64'd0;
        csr_rvalid_o = 1'b0;
        if (csr_raddr_i == 12'hB00) begin
            csr_rdata_o  = mcycle; csr_rvalid_o = 1'b1;
        end else if (csr_raddr_i == 12'hB02) begin
            csr_rdata_o  = minstret; csr_rvalid_o = 1'b1;
        end else if (csr_raddr_i >= 12'hB03 &&
                     csr_raddr_i < 12'hB03 + 12'(NUM_COUNTERS)) begin
            csr_rdata_o  = mhpmcounter[rd_hpmcnt_off];
            csr_rvalid_o = 1'b1;
        end else if (csr_raddr_i >= 12'h323 &&
                     csr_raddr_i < 12'h323 + 12'(NUM_COUNTERS)) begin
            csr_rdata_o  = {{(64-EVT_W){1'b0}},
                            mhpmevent[rd_hpmevent_off]};
            csr_rvalid_o = 1'b1;
        end
    end

endmodule
/* verilator lint_on UNUSEDPARAM */
/* verilator lint_on DECLFILENAME */
