`timescale 1ns/1ps

// e1_dram_ctrl_mem_tb
//
// Direct AXI4-master harness for the e1_dram_ctrl memory-controller
// boundary.  Unlike the DFI-shape harness under verify/cocotb/axi4, this
// testbench drives the controller's AXI4 slave port directly from cocotb so
// the data-integrity, multiple-outstanding, backpressure, large-region
// memtest, DECERR, and capacity-readback assertions exercise the controller
// in isolation.
//
// The controller is instantiated with its real discoverable geometry
// (MEM_BASE_ADDR = 0x8000_0000, MEM_CAPACITY_BYTES = 2 GiB) so the test can
// validate boot-time capacity discovery and out-of-range DECERR at the true
// aperture boundary.  Row-access latencies are kept modest (but > 1) so the
// row-hit/miss model is exercised without inflating simulation time.

module e1_dram_ctrl_mem_tb
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_WIDTH    = 6,
    parameter int unsigned ADDR_WIDTH  = 40,
    parameter int unsigned DATA_WIDTH  = 128,
    parameter int unsigned USER_WIDTH  = 8,
    parameter int unsigned BURST_LEN_W = 8
) (
    input  logic clk,
    input  logic rst_n,

    input  logic                    s_awvalid,
    output logic                    s_awready,
    input  logic [ID_WIDTH-1:0]     s_awid,
    input  logic [ADDR_WIDTH-1:0]   s_awaddr,
    input  logic [BURST_LEN_W-1:0]  s_awlen,
    input  logic [2:0]              s_awsize,
    input  logic [1:0]              s_awburst,
    input  logic                    s_awlock,
    input  logic [3:0]              s_awcache,
    input  logic [2:0]              s_awprot,
    input  logic [3:0]              s_awqos,
    input  logic [USER_WIDTH-1:0]   s_awuser,

    input  logic                    s_wvalid,
    output logic                    s_wready,
    input  logic [DATA_WIDTH-1:0]   s_wdata,
    input  logic [DATA_WIDTH/8-1:0] s_wstrb,
    input  logic                    s_wlast,

    output logic                    s_bvalid,
    input  logic                    s_bready,
    output logic [ID_WIDTH-1:0]     s_bid,
    output logic [1:0]              s_bresp,

    input  logic                    s_arvalid,
    output logic                    s_arready,
    input  logic [ID_WIDTH-1:0]     s_arid,
    input  logic [ADDR_WIDTH-1:0]   s_araddr,
    input  logic [BURST_LEN_W-1:0]  s_arlen,
    input  logic [2:0]              s_arsize,
    input  logic [1:0]              s_arburst,
    input  logic                    s_arlock,
    input  logic [3:0]              s_arcache,
    input  logic [2:0]              s_arprot,
    input  logic [3:0]              s_arqos,
    input  logic [USER_WIDTH-1:0]   s_aruser,

    output logic                    s_rvalid,
    input  logic                    s_rready,
    output logic [ID_WIDTH-1:0]     s_rid,
    output logic [DATA_WIDTH-1:0]   s_rdata,
    output logic [1:0]              s_rresp,
    output logic                    s_rlast,

    // Discoverable geometry, surfaced to the cocotb test.
    output logic [63:0]             mem_base_addr,
    output logic [63:0]             mem_capacity_bytes
);

    logic [ADDR_WIDTH-1:0]   dfi_addr;
    logic [3:0]              dfi_bank;
    logic                    dfi_cs_n, dfi_act_n, dfi_ras_n, dfi_cas_n, dfi_we_n;
    logic                    dfi_reset_n, dfi_cke, dfi_odt;
    logic [DATA_WIDTH-1:0]   dfi_wrdata;
    logic [DATA_WIDTH/8-1:0] dfi_wrdata_mask;
    logic                    dfi_wrdata_en, dfi_rddata_en;
    logic                    dfi_init_start, dfi_ctrlupd_req, dfi_dram_clk_disable;
    logic                    refresh_active, zqcs_active, zqcl_active, ecc_irq;
    logic [31:0]             odecc_c, odecc_u, linkecc_c, linkecc_u;

    e1_dram_ctrl #(
        .ID_WIDTH    (ID_WIDTH),
        .ADDR_WIDTH  (ADDR_WIDTH),
        .DATA_WIDTH  (DATA_WIDTH),
        .USER_WIDTH  (USER_WIDTH),
        .BURST_LEN_W (BURST_LEN_W),
        // Real discoverable geometry: 2 GiB main memory at 0x8000_0000.
        .MEM_BASE_ADDR      (40'h00_8000_0000),
        .MEM_CAPACITY_BYTES (64'h0000_0000_8000_0000),
        // Modest, > 1 cycle row-access latencies so the row-hit/miss model is
        // exercised without inflating the memtest sweep runtime.
        .ROW_HIT_LATENCY  (3),
        .ROW_MISS_LATENCY (6),
        .WRITE_LATENCY    (3),
        .TCCD_CYCLES      (2),
        .WR_Q_DEPTH       (8),
        .RD_Q_DEPTH       (8),
        // Compress refresh cadence for observability.
        .TREFI_CYCLES (512),
        .TRFCAB_CYCLES(32),
        .TRFCPB_CYCLES(16),
        .ZQCS_INTERVAL(1024),
        .ZQCL_INTERVAL(8192)
    ) u_ctrl (
        .clk(clk), .rst_n(rst_n),
        .s_awvalid(s_awvalid), .s_awready(s_awready),
        .s_awid(s_awid), .s_awaddr(s_awaddr), .s_awlen(s_awlen),
        .s_awsize(s_awsize), .s_awburst(s_awburst), .s_awlock(s_awlock),
        .s_awcache(s_awcache), .s_awprot(s_awprot), .s_awqos(s_awqos),
        .s_awuser(s_awuser),
        .s_wvalid(s_wvalid), .s_wready(s_wready),
        .s_wdata(s_wdata), .s_wstrb(s_wstrb), .s_wlast(s_wlast),
        .s_bvalid(s_bvalid), .s_bready(s_bready),
        .s_bid(s_bid), .s_bresp(s_bresp),
        .s_arvalid(s_arvalid), .s_arready(s_arready),
        .s_arid(s_arid), .s_araddr(s_araddr), .s_arlen(s_arlen),
        .s_arsize(s_arsize), .s_arburst(s_arburst), .s_arlock(s_arlock),
        .s_arcache(s_arcache), .s_arprot(s_arprot), .s_arqos(s_arqos),
        .s_aruser(s_aruser),
        .s_rvalid(s_rvalid), .s_rready(s_rready),
        .s_rid(s_rid), .s_rdata(s_rdata), .s_rresp(s_rresp), .s_rlast(s_rlast),
        .mem_base_addr(mem_base_addr),
        .mem_capacity_bytes(mem_capacity_bytes),
        .dfi_addr(dfi_addr), .dfi_bank(dfi_bank),
        .dfi_cs_n(dfi_cs_n), .dfi_act_n(dfi_act_n), .dfi_ras_n(dfi_ras_n),
        .dfi_cas_n(dfi_cas_n), .dfi_we_n(dfi_we_n), .dfi_reset_n(dfi_reset_n),
        .dfi_cke(dfi_cke), .dfi_odt(dfi_odt),
        .dfi_wrdata(dfi_wrdata), .dfi_wrdata_mask(dfi_wrdata_mask),
        .dfi_wrdata_en(dfi_wrdata_en),
        .dfi_rddata('0), .dfi_rddata_valid(1'b0), .dfi_rddata_en(dfi_rddata_en),
        .dfi_init_start(dfi_init_start), .dfi_init_complete(1'b1),
        .dfi_ctrlupd_req(dfi_ctrlupd_req), .dfi_ctrlupd_ack(1'b1),
        .dfi_dram_clk_disable(dfi_dram_clk_disable),
        .refresh_active(refresh_active),
        .zqcs_active(zqcs_active), .zqcl_active(zqcl_active),
        .odecc_corrected_count(odecc_c), .odecc_uncorrected_count(odecc_u),
        .linkecc_corrected_count(linkecc_c), .linkecc_uncorrected_count(linkecc_u),
        .ecc_uncorrected_irq(ecc_irq)
    );

endmodule
