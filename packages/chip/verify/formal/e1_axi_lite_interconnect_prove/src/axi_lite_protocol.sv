// SPDX-License-Identifier: Apache-2.0
//
// AXI-Lite protocol property pack for the e1 SoC.
//
// Bind this module to any AXI-Lite master or slave instance via
// SystemVerilog ``bind`` (see ``verify/properties/README.md``). It is the
// single source of truth for AXI-Lite protocol assertions in this repo —
// the older ``axi_lite.sv`` / ``axi_lite_props`` pack was collapsed into
// this one per ``docs/E1_SOTA_TAPEOUT_DOSSIER.md`` §3.4 H25.
//
// Properties covered, lifted from the public ARM AXI4-Lite spec (IHI 0022)
// and the Yosys / SBY supportable SVA subset:
//
//   - VALID stability and payload stability for AW, W, B, AR, R.
//   - Response-code legality (``OKAY``/``SLVERR``/``DECERR``;
//     ``EXOKAY`` is reserved for AXI4, not AXI-Lite).
//   - Outstanding-transaction balance (no spurious B/R; up to
//     ``MAX_OUTST`` simultaneously in flight).
//   - B response ordering: ``aw_outstanding`` strictly drains by ``B`` and
//     never exceeds ``MAX_OUTST``.
//   - R response ordering: ``ar_outstanding`` strictly drains by ``R``
//     and never exceeds ``MAX_OUTST``.
//
// Default parameter values (``MAX_OUTST``, ``MAX_STALL``) are documented in
// ``verify/properties/verification-budgets.md``. Binds may override them for
// a specific DUT; consult that document before changing a default.

`ifndef E1_AXI_LITE_PROTOCOL_SV
`define E1_AXI_LITE_PROTOCOL_SV

`default_nettype none

module axi_lite_protocol_props #(
    parameter int unsigned ADDR_W    = 32,
    parameter int unsigned DATA_W    = 32,
    parameter int unsigned MAX_OUTST = 16,
    parameter int unsigned MAX_STALL = 256
) (
    input  logic                clk,
    input  logic                rst_n,

    input  logic                awvalid,
    input  logic                awready,
    input  logic [ADDR_W-1:0]   awaddr,

    input  logic                wvalid,
    input  logic                wready,
    input  logic [DATA_W-1:0]   wdata,
    input  logic [DATA_W/8-1:0] wstrb,

    input  logic                bvalid,
    input  logic                bready,
    input  logic [1:0]          bresp,

    input  logic                arvalid,
    input  logic                arready,
    input  logic [ADDR_W-1:0]   araddr,

    input  logic                rvalid,
    input  logic                rready,
    input  logic [DATA_W-1:0]   rdata,
    input  logic [1:0]          rresp
);

    // Properties are expressed as immediate assertions inside a clocked
    // process. This is the SVA subset the native Yosys/SymbiYosys frontend
    // accepts (concurrent ``assert property`` with ``default clocking`` /
    // ``disable iff`` is not parsed by that frontend). Each assertion is
    // gated on ``rst_n`` and on ``$past(rst_n)`` where it references prior
    // state, which reproduces ``disable iff (!rst_n)`` semantics.

    logic        rst_n_q;

    logic        awvalid_q, awready_q, wvalid_q, wready_q;
    logic        arvalid_q, arready_q;
    logic [ADDR_W-1:0]   awaddr_q, araddr_q;
    logic [DATA_W-1:0]   wdata_q;
    logic [DATA_W/8-1:0] wstrb_q;

    logic        bvalid_q, bready_q, rvalid_q, rready_q;
    logic [1:0]  bresp_q, rresp_q;
    logic [DATA_W-1:0] rdata_q;

    // Stall counters for bounded-fairness liveness: each counts the number
    // of consecutive cycles a channel holds VALID without seeing READY.
    logic [31:0] aw_stall, w_stall, ar_stall;

    // Outstanding-transaction accounting.
    logic [31:0] aw_outstanding;
    logic [31:0] ar_outstanding;

    always_ff @(posedge clk) begin
        rst_n_q <= rst_n;

        awvalid_q <= awvalid; awready_q <= awready; awaddr_q <= awaddr;
        wvalid_q  <= wvalid;  wready_q  <= wready;  wdata_q  <= wdata; wstrb_q <= wstrb;
        arvalid_q <= arvalid; arready_q <= arready; araddr_q <= araddr;
        bvalid_q  <= bvalid;  bready_q  <= bready;  bresp_q  <= bresp;
        rvalid_q  <= rvalid;  rready_q  <= rready;  rresp_q  <= rresp; rdata_q <= rdata;

        if (!rst_n) begin
            aw_outstanding <= '0;
            ar_outstanding <= '0;
            aw_stall <= '0;
            w_stall  <= '0;
            ar_stall <= '0;
        end else begin
            aw_outstanding <= aw_outstanding
                + ((awvalid && awready) ? 32'd1 : 32'd0)
                - ((bvalid  && bready)  ? 32'd1 : 32'd0);
            ar_outstanding <= ar_outstanding
                + ((arvalid && arready) ? 32'd1 : 32'd0)
                - ((rvalid  && rready)  ? 32'd1 : 32'd0);

            aw_stall <= (awvalid && !awready) ? (aw_stall + 32'd1) : 32'd0;
            w_stall  <= (wvalid  && !wready)  ? (w_stall  + 32'd1) : 32'd0;
            ar_stall <= (arvalid && !arready) ? (ar_stall + 32'd1) : 32'd0;

            // -------------------------------------------------------------
            // VALID and payload stability (IHI 0022 §A3.2.1): once VALID is
            // asserted it may not deassert, and the payload must hold, until
            // the READY handshake completes. Checked one cycle later against
            // the registered copies.
            // -------------------------------------------------------------
            if (rst_n_q) begin
                if (awvalid_q && !awready_q) begin
                    a_aw_valid_stable: assert (awvalid);
                    a_aw_addr_stable:  assert (awaddr == awaddr_q);
                end
                if (wvalid_q && !wready_q) begin
                    a_w_valid_stable: assert (wvalid);
                    a_w_data_stable:  assert (wdata == wdata_q);
                    a_w_strb_stable:  assert (wstrb == wstrb_q);
                end
                if (arvalid_q && !arready_q) begin
                    a_ar_valid_stable: assert (arvalid);
                    a_ar_addr_stable:  assert (araddr == araddr_q);
                end
                if (bvalid_q && !bready_q) begin
                    a_b_valid_stable: assert (bvalid);
                    a_b_resp_stable:  assert (bresp == bresp_q);
                end
                if (rvalid_q && !rready_q) begin
                    a_r_valid_stable: assert (rvalid);
                    a_r_data_stable:  assert (rdata == rdata_q);
                    a_r_resp_stable:  assert (rresp == rresp_q);
                end
            end

            // -------------------------------------------------------------
            // Response-code legality. AXI-Lite forbids ``EXOKAY`` (01).
            // -------------------------------------------------------------
            // Legal codes are OKAY/SLVERR/DECERR (00/10/11); EXOKAY (01) is
            // reserved for AXI4 and forbidden on AXI-Lite.
            if (bvalid) a_bresp_legal: assert (bresp != 2'b01);
            if (rvalid) a_rresp_legal: assert (rresp != 2'b01);

            // -------------------------------------------------------------
            // Outstanding-transaction balance + ordering: no spurious B/R,
            // and the in-flight count never exceeds ``MAX_OUTST``.
            // -------------------------------------------------------------
            if (bvalid) a_no_unexpected_b: assert (aw_outstanding != 0);
            if (rvalid) a_no_unexpected_r: assert (ar_outstanding != 0);
            a_aw_outstanding_bounded: assert (aw_outstanding <= MAX_OUTST);
            a_ar_outstanding_bounded: assert (ar_outstanding <= MAX_OUTST);

            // -------------------------------------------------------------
            // Liveness (bounded fairness): a held VALID must see READY within
            // ``MAX_STALL`` cycles. With ``AXIL_PROTO_ASSUME_LIVENESS`` the
            // downstream environment is constrained to grant within the
            // window (used for master-side proofs where the slave is
            // abstracted); otherwise the DUT itself must meet the bound.
            // -------------------------------------------------------------
            `ifdef AXIL_PROTO_ASSUME_LIVENESS
                assume (aw_stall <= MAX_STALL);
                assume (w_stall  <= MAX_STALL);
                assume (ar_stall <= MAX_STALL);
            `else
                a_aw_liveness: assert (aw_stall <= MAX_STALL);
                a_w_liveness:  assert (w_stall  <= MAX_STALL);
                a_ar_liveness: assert (ar_stall <= MAX_STALL);
            `endif
        end
    end

endmodule

`default_nettype wire

`endif // E1_AXI_LITE_PROTOCOL_SV
