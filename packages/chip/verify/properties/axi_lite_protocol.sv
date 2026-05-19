// SPDX-License-Identifier: Apache-2.0
//
// Open AXI-Lite protocol property pack for the e1 SoC.
//
// This file complements ``axi_lite.sv`` (the bind-able VALID/READY pack)
// with channel-ordering, response-code, and outstanding-bound properties
// expressed in a single self-contained module. It is meant to be bound to
// any AXI-Lite slave (e.g. ``rtl/memory/e1_axi_lite_dram.sv``) or master
// instance (e.g. ``rtl/interconnect/e1_axi_lite_interconnect.sv``).
//
// Properties covered, lifted from the public ARM AXI4-Lite spec (IHI 0022)
// and Yosys / SBY supportable SVA subset:
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
// The file does not duplicate ``axi_lite.sv`` — instead it imports the
// same shape with explicit symbolic names for the protocol gates so the
// SBY harness names them when reporting coverage.

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

    default clocking cb @(posedge clk); endclocking
    default disable iff (!rst_n);

    // -----------------------------------------------------------------
    // VALID and payload stability (mirrors axi_lite_props with the same
    // textbook semantics, but exposed under clearer per-channel names).
    // -----------------------------------------------------------------
    property p_valid_stable(valid, ready);
        valid && !ready |=> valid;
    endproperty
    property p_payload_stable(valid, ready, payload);
        valid && !ready |=> $stable(payload);
    endproperty

    a_aw_valid_stable: assert property (p_valid_stable(awvalid, awready));
    a_aw_addr_stable:  assert property (p_payload_stable(awvalid, awready, awaddr));
    a_w_valid_stable:  assert property (p_valid_stable(wvalid,  wready));
    a_w_data_stable:   assert property (p_payload_stable(wvalid,  wready,  wdata));
    a_w_strb_stable:   assert property (p_payload_stable(wvalid,  wready,  wstrb));
    a_ar_valid_stable: assert property (p_valid_stable(arvalid, arready));
    a_ar_addr_stable:  assert property (p_payload_stable(arvalid, arready, araddr));
    a_b_valid_stable:  assert property (p_valid_stable(bvalid,  bready));
    a_b_resp_stable:   assert property (p_payload_stable(bvalid,  bready,  bresp));
    a_r_valid_stable:  assert property (p_valid_stable(rvalid,  rready));
    a_r_data_stable:   assert property (p_payload_stable(rvalid,  rready,  rdata));
    a_r_resp_stable:   assert property (p_payload_stable(rvalid,  rready,  rresp));

    // -----------------------------------------------------------------
    // Response-code legality. AXI-Lite forbids ``EXOKAY`` (01).
    // -----------------------------------------------------------------
    a_bresp_legal: assert property (
        bvalid |-> (bresp inside {2'b00, 2'b10, 2'b11})
    );
    a_rresp_legal: assert property (
        rvalid |-> (rresp inside {2'b00, 2'b10, 2'b11})
    );

    // -----------------------------------------------------------------
    // Outstanding-transaction accounting + ordering.
    // -----------------------------------------------------------------
    logic [31:0] aw_outstanding;
    logic [31:0] ar_outstanding;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            aw_outstanding <= '0;
            ar_outstanding <= '0;
        end else begin
            aw_outstanding <= aw_outstanding
                + ((awvalid && awready) ? 32'd1 : 32'd0)
                - ((bvalid  && bready)  ? 32'd1 : 32'd0);
            ar_outstanding <= ar_outstanding
                + ((arvalid && arready) ? 32'd1 : 32'd0)
                - ((rvalid  && rready)  ? 32'd1 : 32'd0);
        end
    end

    a_no_unexpected_b: assert property (
        bvalid |-> (aw_outstanding != 0)
    );
    a_no_unexpected_r: assert property (
        rvalid |-> (ar_outstanding != 0)
    );
    a_aw_outstanding_bounded: assert property (
        aw_outstanding <= MAX_OUTST
    );
    a_ar_outstanding_bounded: assert property (
        ar_outstanding <= MAX_OUTST
    );

    // -----------------------------------------------------------------
    // Liveness (bounded fairness). Assumed for slave-side proofs; the
    // ``AXIL_PROTO_ASSUME_LIVENESS`` define flips the gate to an
    // assumption that the upstream environment will eventually grant
    // ready, which keeps the proof from spinning forever on dead inputs.
    // -----------------------------------------------------------------
    `ifdef AXIL_PROTO_ASSUME_LIVENESS
        assume property (@(posedge clk) disable iff (!rst_n)
            awvalid |-> ##[0:MAX_STALL] awready);
        assume property (@(posedge clk) disable iff (!rst_n)
            wvalid  |-> ##[0:MAX_STALL] wready);
        assume property (@(posedge clk) disable iff (!rst_n)
            arvalid |-> ##[0:MAX_STALL] arready);
    `else
        a_aw_liveness: assert property (@(posedge clk) disable iff (!rst_n)
            awvalid |-> ##[0:MAX_STALL] awready);
        a_w_liveness:  assert property (@(posedge clk) disable iff (!rst_n)
            wvalid  |-> ##[0:MAX_STALL] wready);
        a_ar_liveness: assert property (@(posedge clk) disable iff (!rst_n)
            arvalid |-> ##[0:MAX_STALL] arready);
    `endif

endmodule

`default_nettype wire

`endif // E1_AXI_LITE_PROTOCOL_SV
