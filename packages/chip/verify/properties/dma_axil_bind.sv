// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys harness binding the AXI-Lite property pack to the
// e1_dma master interface. Drive with verify/properties/dma_axil.sby.

`default_nettype none

module dma_axil_props_top (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,
    output logic        irq,

    output logic        m_axil_awvalid,
    input  logic        m_axil_awready,
    output logic [31:0] m_axil_awaddr,
    output logic        m_axil_wvalid,
    input  logic        m_axil_wready,
    output logic [31:0] m_axil_wdata,
    output logic [3:0]  m_axil_wstrb,
    input  logic        m_axil_bvalid,
    output logic        m_axil_bready,
    input  logic [1:0]  m_axil_bresp,

    output logic        m_axil_arvalid,
    input  logic        m_axil_arready,
    output logic [31:0] m_axil_araddr,
    input  logic        m_axil_rvalid,
    output logic        m_axil_rready,
    input  logic [31:0] m_axil_rdata,
    input  logic [1:0]  m_axil_rresp
);

    e1_dma u_dma (.*);

    bind e1_dma axi_lite_protocol_props #(
        .ADDR_W(32), .DATA_W(32), .MAX_OUTST(1), .MAX_STALL(64)
    ) u_axil_props (
            .clk      (clk),
            .rst_n    (rst_n),
            .awvalid  (m_axil_awvalid),
            .awready  (m_axil_awready),
            .awaddr   (m_axil_awaddr),
            .wvalid   (m_axil_wvalid),
            .wready   (m_axil_wready),
            .wdata    (m_axil_wdata),
            .wstrb    (m_axil_wstrb),
            .bvalid   (m_axil_bvalid),
            .bready   (m_axil_bready),
            .bresp    (m_axil_bresp),
            .arvalid  (m_axil_arvalid),
            .arready  (m_axil_arready),
            .araddr   (m_axil_araddr),
            .rvalid   (m_axil_rvalid),
            .rready   (m_axil_rready),
            .rdata    (m_axil_rdata),
            .rresp    (m_axil_rresp)
        );

endmodule

`default_nettype wire
