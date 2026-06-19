`timescale 1ns/1ps

// e1_aia_sg_harness — verification harness for the integrated scatter-gather
// DMA + RISC-V AIA fabric inside e1_soc_top (compiled with E1_SOC_AIA_SG).
//
// This test-only top (under verify/) instantiates e1_soc_top with the
// E1_SOC_AIA_SG production fabric enabled, forwards the SoC external MMIO debug
// port and the new top-level observables (sg_dma_irq_o, aia_eip_o), and
// attaches an e1_axi4_dram_model to the SG-DMA's exported AXI4 data-mover
// master. The DRAM model's storage (u_sg_dram.mem) sits at this harness top so
// the cocotb suite can seed descriptors/payload and read back the copy, exactly
// the white-box memory pattern used by verify/cocotb/iommu and dma_sg.
//
// Nothing here is synthesizable product RTL: the harness exists only to stand
// the integrated SoC up against a burst-capable memory model in simulation.

module e1_aia_sg_harness #(
    parameter int unsigned SG_DRAM_BYTES = 4096
) (
    input  logic        clk,
    input  logic        rst_n,

    // SoC external MMIO debug port (master 0 of the SoC fabric arbiter).
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    output logic [31:0] mmio_rdata,
    output logic        mmio_ready,

    // Integrated-fabric observables.
    output logic        sg_dma_irq_o,
    output logic [1:0]  aia_eip_o
);
    // SoC peripheral IRQ + CLINT lines (legacy config — observed, not used here).
    /* verilator lint_off UNUSEDSIGNAL */
    logic irq_timer, irq_dma, irq_npu, irq_vsync, msip_o, mtip_o;
    logic [7:0] gpio_out;
    /* verilator lint_on UNUSEDSIGNAL */

    // SG-DMA exported AXI4 master <-> burst DRAM model.
    logic        sg_arvalid, sg_arready;
    logic [31:0] sg_araddr;
    logic [7:0]  sg_arlen;
    logic [2:0]  sg_arsize;
    logic [1:0]  sg_arburst;
    logic [3:0]  sg_arcache;
    logic [2:0]  sg_arprot;
    logic        sg_rvalid, sg_rready;
    logic [31:0] sg_rdata;
    logic        sg_rlast;
    logic [1:0]  sg_rresp;
    logic        sg_awvalid, sg_awready;
    logic [31:0] sg_awaddr;
    logic [7:0]  sg_awlen;
    logic [2:0]  sg_awsize;
    logic [1:0]  sg_awburst;
    logic [3:0]  sg_awcache;
    logic [2:0]  sg_awprot;
    logic        sg_wvalid, sg_wready;
    logic [31:0] sg_wdata;
    logic [3:0]  sg_wstrb;
    logic        sg_wlast;
    logic        sg_bvalid, sg_bready;
    logic [1:0]  sg_bresp;

    e1_soc_top u_soc (
        .clk              (clk),
        .rst_n            (rst_n),
        .mmio_valid       (mmio_valid),
        .mmio_write       (mmio_write),
        .mmio_addr        (mmio_addr),
        .mmio_wdata       (mmio_wdata),
        .mmio_rdata       (mmio_rdata),
        .mmio_ready       (mmio_ready),
        .irq_timer        (irq_timer),
        .irq_dma          (irq_dma),
        .irq_npu          (irq_npu),
        .irq_vsync        (irq_vsync),
        .msip_o           (msip_o),
        .mtip_o           (mtip_o),
        .sg_dma_irq_o     (sg_dma_irq_o),
        .aia_eip_o        (aia_eip_o),
        .sg_dma_m_arvalid (sg_arvalid),
        .sg_dma_m_arready (sg_arready),
        .sg_dma_m_araddr  (sg_araddr),
        .sg_dma_m_arlen   (sg_arlen),
        .sg_dma_m_arsize  (sg_arsize),
        .sg_dma_m_arburst (sg_arburst),
        .sg_dma_m_arcache (sg_arcache),
        .sg_dma_m_arprot  (sg_arprot),
        .sg_dma_m_rvalid  (sg_rvalid),
        .sg_dma_m_rready  (sg_rready),
        .sg_dma_m_rdata   (sg_rdata),
        .sg_dma_m_rlast   (sg_rlast),
        .sg_dma_m_rresp   (sg_rresp),
        .sg_dma_m_awvalid (sg_awvalid),
        .sg_dma_m_awready (sg_awready),
        .sg_dma_m_awaddr  (sg_awaddr),
        .sg_dma_m_awlen   (sg_awlen),
        .sg_dma_m_awsize  (sg_awsize),
        .sg_dma_m_awburst (sg_awburst),
        .sg_dma_m_awcache (sg_awcache),
        .sg_dma_m_awprot  (sg_awprot),
        .sg_dma_m_wvalid  (sg_wvalid),
        .sg_dma_m_wready  (sg_wready),
        .sg_dma_m_wdata   (sg_wdata),
        .sg_dma_m_wstrb   (sg_wstrb),
        .sg_dma_m_wlast   (sg_wlast),
        .sg_dma_m_bvalid  (sg_bvalid),
        .sg_dma_m_bready  (sg_bready),
        .sg_dma_m_bresp   (sg_bresp),
        .gpio_out         (gpio_out)
    );

    // Burst-capable scratch DRAM (u_sg_dram.mem) backing the SG-DMA master.
    // 32-bit data matches the SG-DMA beat width; the model's ID/lock/qos/user
    // inputs are tied off (the SG-DMA master does not drive them).
    /* verilator lint_off UNUSEDSIGNAL */
    logic [3:0] sg_dram_bid_unused;
    logic [3:0] sg_dram_rid_unused;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_axi4_dram_model #(
        .ID_WIDTH    (4),
        .ADDR_WIDTH  (32),
        .DATA_WIDTH  (32),
        .USER_WIDTH  (1),
        .BURST_LEN_W (8),
        .DEPTH_BYTES (SG_DRAM_BYTES),
        .CMD_LATENCY (2),
        .DATA_LATENCY(1)
    ) u_sg_dram (
        .clk      (clk),
        .rst_n    (rst_n),
        .s_awvalid(sg_awvalid),
        .s_awready(sg_awready),
        .s_awid   (4'd0),
        .s_awaddr (sg_awaddr),
        .s_awlen  (sg_awlen),
        .s_awsize (sg_awsize),
        .s_awburst(sg_awburst),
        .s_awlock (1'b0),
        .s_awcache(sg_awcache),
        .s_awprot (sg_awprot),
        .s_awqos  (4'd0),
        .s_awuser (1'b0),
        .s_wvalid (sg_wvalid),
        .s_wready (sg_wready),
        .s_wdata  (sg_wdata),
        .s_wstrb  (sg_wstrb),
        .s_wlast  (sg_wlast),
        .s_bvalid (sg_bvalid),
        .s_bready (sg_bready),
        .s_bid    (sg_dram_bid_unused),
        .s_bresp  (sg_bresp),
        .s_arvalid(sg_arvalid),
        .s_arready(sg_arready),
        .s_arid   (4'd0),
        .s_araddr (sg_araddr),
        .s_arlen  (sg_arlen),
        .s_arsize (sg_arsize),
        .s_arburst(sg_arburst),
        .s_arlock (1'b0),
        .s_arcache(sg_arcache),
        .s_arprot (sg_arprot),
        .s_arqos  (4'd0),
        .s_aruser (1'b0),
        .s_rvalid (sg_rvalid),
        .s_rready (sg_rready),
        .s_rid    (sg_dram_rid_unused),
        .s_rdata  (sg_rdata),
        .s_rresp  (sg_rresp),
        .s_rlast  (sg_rlast)
    );

endmodule : e1_aia_sg_harness
