// SPDX-License-Identifier: Apache-2.0
//
// Reusable AXI-Lite property pack for the e1 SoC.
//
// This module is parametric in address/data width and is intended to be
// bound to any AXI-Lite master or slave instance via SystemVerilog `bind`.
// It defines:
//   - VALID/READY stability (no de-assertion before handshake).
//   - Channel liveness under bounded fairness assumptions.
//   - Response-code well-formedness.
//   - Payload stability while VALID is held.
//
// The pack assumes a single AXI-Lite channel set (AW/W/B for writes,
// AR/R for reads). Bursts are not modeled.
//
// See verify/properties/README.md for bind usage.

`ifndef E1_AXI_LITE_PROPS_SV
`define E1_AXI_LITE_PROPS_SV

`default_nettype none

module axi_lite_props #(
    parameter int unsigned ADDR_W = 32,
    parameter int unsigned DATA_W = 32,
    parameter int unsigned MAX_STALL = 64
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

    property p_valid_stable(valid, ready);
        valid && !ready |=> valid;
    endproperty

    property p_payload_stable(valid, ready, payload);
        valid && !ready |=> $stable(payload);
    endproperty

    a_aw_valid_stable:  assert property (p_valid_stable(awvalid, awready));
    a_aw_addr_stable:   assert property (p_payload_stable(awvalid, awready, awaddr));
    a_w_valid_stable:   assert property (p_valid_stable(wvalid, wready));
    a_w_data_stable:    assert property (p_payload_stable(wvalid, wready, wdata));
    a_w_strb_stable:    assert property (p_payload_stable(wvalid, wready, wstrb));
    a_ar_valid_stable:  assert property (p_valid_stable(arvalid, arready));
    a_ar_addr_stable:   assert property (p_payload_stable(arvalid, arready, araddr));
    a_b_valid_stable:   assert property (p_valid_stable(bvalid, bready));
    a_b_resp_stable:    assert property (p_payload_stable(bvalid, bready, bresp));
    a_r_valid_stable:   assert property (p_valid_stable(rvalid, rready));
    a_r_data_stable:    assert property (p_payload_stable(rvalid, rready, rdata));
    a_r_resp_stable:    assert property (p_payload_stable(rvalid, rready, rresp));

    a_bresp_legal: assert property (
        bvalid |-> (bresp inside {2'b00, 2'b10, 2'b11})
    );
    a_rresp_legal: assert property (
        rvalid |-> (rresp inside {2'b00, 2'b10, 2'b11})
    );

    `ifdef AXIL_PROPS_ASSUME_LIVENESS
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

    // Outstanding-transaction balance: no spurious B/R responses.
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

endmodule

`default_nettype wire

`endif // E1_AXI_LITE_PROPS_SV
