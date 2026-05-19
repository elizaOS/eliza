// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys harness binding ``axi_lite_protocol_props`` to the CPU master
// port of ``e1_axi_lite_interconnect``. Drive with
// ``verify/formal/e1_axi_lite_interconnect.sby``.
//
// The CPU port was chosen because it is the highest-traffic master and
// exercises the arbiter / outstanding-transaction accounting in the
// interconnect; the DMA and debug ports share the same fabric and are
// covered by transitive reasoning.

`default_nettype none

module e1_axi_lite_interconnect_props_top (
    input  logic clk,
    input  logic rst_n,

    input  logic        m_axil_awvalid,
    input  logic [31:0] m_axil_awaddr,
    input  logic        m_axil_wvalid,
    input  logic [31:0] m_axil_wdata,
    input  logic [3:0]  m_axil_wstrb,
    input  logic        m_axil_bready,

    input  logic        m_axil_arvalid,
    input  logic [31:0] m_axil_araddr,
    input  logic        m_axil_rready,

    input  logic        dma_m_awvalid,
    input  logic [31:0] dma_m_awaddr,
    input  logic        dma_m_wvalid,
    input  logic [31:0] dma_m_wdata,
    input  logic [3:0]  dma_m_wstrb,
    input  logic        dma_m_bready,

    input  logic        dma_m_arvalid,
    input  logic [31:0] dma_m_araddr,
    input  logic        dma_m_rready,

    input  logic        dbg_m_awvalid,
    input  logic [31:0] dbg_m_awaddr,
    input  logic        dbg_m_wvalid,
    input  logic [31:0] dbg_m_wdata,
    input  logic [3:0]  dbg_m_wstrb,
    input  logic        dbg_m_bready,

    input  logic        dbg_m_arvalid,
    input  logic [31:0] dbg_m_araddr,
    input  logic        dbg_m_rready,

    input  logic        dram_awready,
    input  logic        dram_wready,
    input  logic        dram_bvalid,
    input  logic [1:0]  dram_bresp,
    input  logic        dram_arready,
    input  logic        dram_rvalid,
    input  logic [31:0] dram_rdata,
    input  logic [1:0]  dram_rresp,

    input  logic        intc_awready,
    input  logic        intc_wready,
    input  logic        intc_bvalid,
    input  logic [1:0]  intc_bresp,
    input  logic        intc_arready,
    input  logic        intc_rvalid,
    input  logic [31:0] intc_rdata,
    input  logic [1:0]  intc_rresp,

    input  logic        dma_awready,
    input  logic        dma_wready,
    input  logic        dma_bvalid,
    input  logic [1:0]  dma_bresp,
    input  logic        dma_arready,
    input  logic        dma_rvalid,
    input  logic [31:0] dma_rdata,
    input  logic [1:0]  dma_rresp
);

    logic        m_axil_awready;
    logic        m_axil_wready;
    logic        m_axil_bvalid;
    logic [1:0]  m_axil_bresp;
    logic        m_axil_arready;
    logic        m_axil_rvalid;
    logic [31:0] m_axil_rdata;
    logic [1:0]  m_axil_rresp;

    logic        dma_m_awready;
    logic        dma_m_wready;
    logic        dma_m_bvalid;
    logic [1:0]  dma_m_bresp;
    logic        dma_m_arready;
    logic        dma_m_rvalid;
    logic [31:0] dma_m_rdata;
    logic [1:0]  dma_m_rresp;

    logic        dbg_m_awready;
    logic        dbg_m_wready;
    logic        dbg_m_bvalid;
    logic [1:0]  dbg_m_bresp;
    logic        dbg_m_arready;
    logic        dbg_m_rvalid;
    logic [31:0] dbg_m_rdata;
    logic [1:0]  dbg_m_rresp;

    logic        dram_awvalid;
    logic [31:0] dram_awaddr;
    logic        dram_wvalid;
    logic [31:0] dram_wdata;
    logic [3:0]  dram_wstrb;
    logic        dram_bready;
    logic        dram_arvalid;
    logic [31:0] dram_araddr;
    logic        dram_rready;

    logic        intc_awvalid;
    logic [31:0] intc_awaddr;
    logic        intc_wvalid;
    logic [31:0] intc_wdata;
    logic [3:0]  intc_wstrb;
    logic        intc_bready;
    logic        intc_arvalid;
    logic [31:0] intc_araddr;
    logic        intc_rready;

    logic        dma_awvalid;
    logic [31:0] dma_awaddr;
    logic        dma_wvalid;
    logic [31:0] dma_wdata;
    logic [3:0]  dma_wstrb;
    logic        dma_bready;
    logic        dma_arvalid;
    logic [31:0] dma_araddr;
    logic        dma_rready;

    logic [2:0]  arb_grant;
    logic [2:0]  timeout_irq;

    e1_axi_lite_interconnect u_dut (.*);

    bind e1_axi_lite_interconnect axi_lite_protocol_props #(
        .ADDR_W(32), .DATA_W(32), .MAX_OUTST(8), .MAX_STALL(1024)
    ) u_cpu_props (
        .clk     (clk),
        .rst_n   (rst_n),
        .awvalid (m_axil_awvalid),
        .awready (m_axil_awready),
        .awaddr  (m_axil_awaddr),
        .wvalid  (m_axil_wvalid),
        .wready  (m_axil_wready),
        .wdata   (m_axil_wdata),
        .wstrb   (m_axil_wstrb),
        .bvalid  (m_axil_bvalid),
        .bready  (m_axil_bready),
        .bresp   (m_axil_bresp),
        .arvalid (m_axil_arvalid),
        .arready (m_axil_arready),
        .araddr  (m_axil_araddr),
        .rvalid  (m_axil_rvalid),
        .rready  (m_axil_rready),
        .rdata   (m_axil_rdata),
        .rresp   (m_axil_rresp)
    );

endmodule

`default_nettype wire
