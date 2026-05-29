// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys harness binding ``axi_lite_protocol_props`` to the AXI-Lite
// slave port of ``e1_interrupt_controller``. Drive with
// ``verify/formal/e1_interrupt_controller.sby``.

`default_nettype none

module e1_interrupt_controller_props_top (
    input  logic        clk,
    input  logic        rst_n,
    input  logic [3:0]  irq_sources,

    input  logic        s_axil_awvalid,
    input  logic [31:0] s_axil_awaddr,
    input  logic        s_axil_wvalid,
    input  logic [31:0] s_axil_wdata,
    input  logic [3:0]  s_axil_wstrb,
    input  logic        s_axil_bready,

    input  logic        s_axil_arvalid,
    input  logic [31:0] s_axil_araddr,
    input  logic        s_axil_rready
);

    logic        cpu_external_irq;
    logic [31:0] pending_status;
    logic        s_axil_awready;
    logic        s_axil_wready;
    logic        s_axil_bvalid;
    logic [1:0]  s_axil_bresp;
    logic        s_axil_arready;
    logic        s_axil_rvalid;
    logic [31:0] s_axil_rdata;
    logic [1:0]  s_axil_rresp;

    e1_interrupt_controller #(
        .NUM_SOURCES(4)
    ) u_dut (.*);

    bind e1_interrupt_controller axi_lite_protocol_props #(
        .ADDR_W(32), .DATA_W(32), .MAX_OUTST(4), .MAX_STALL(64)
    ) u_intc_props (
        .clk     (clk),
        .rst_n   (rst_n),
        .awvalid (s_axil_awvalid),
        .awready (s_axil_awready),
        .awaddr  (s_axil_awaddr),
        .wvalid  (s_axil_wvalid),
        .wready  (s_axil_wready),
        .wdata   (s_axil_wdata),
        .wstrb   (s_axil_wstrb),
        .bvalid  (s_axil_bvalid),
        .bready  (s_axil_bready),
        .bresp   (s_axil_bresp),
        .arvalid (s_axil_arvalid),
        .arready (s_axil_arready),
        .araddr  (s_axil_araddr),
        .rvalid  (s_axil_rvalid),
        .rready  (s_axil_rready),
        .rdata   (s_axil_rdata),
        .rresp   (s_axil_rresp)
    );

endmodule

`default_nettype wire
