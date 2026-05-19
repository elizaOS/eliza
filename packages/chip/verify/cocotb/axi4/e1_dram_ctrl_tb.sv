`timescale 1ns/1ps

// e1_dram_ctrl_tb
//
// Cocotb harness that wraps the production e1_dram_ctrl wrapper between
// the AXI4 fabric and the behavioural DRAM model.  Until a closed-IP
// LPDDR5X/6 PHY is licensed (docs/evidence/memory/lpddr-phy-procurement.yaml),
// the controller stub generates DFI 5.0 north commands from synthetic
// observability hooks driven by a small command-shaper.  The test
// (test_dfi_traffic.py) reads a few addresses through the AXI4 master
// and confirms the dfi_* output signals fire on the matching cycles.

module e1_dram_ctrl_tb #(
    parameter int unsigned NUM_MASTERS = 1,
    parameter int unsigned NUM_SLAVES  = 4,
    parameter int unsigned ADDR_WIDTH  = 40,
    parameter int unsigned DATA_WIDTH  = 128,
    parameter int unsigned ID_WIDTH    = 4,
    parameter int unsigned USER_WIDTH  = 8,
    parameter int unsigned MAX_OUTST   = 4,
    parameter int unsigned BURST_LEN_W = 8
) (
    input  logic clk,
    input  logic rst_n,

    input  logic [NUM_MASTERS-1:0]                    m_awvalid,
    output logic [NUM_MASTERS-1:0]                    m_awready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_awid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    m_awaddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   m_awlen,
    input  logic [NUM_MASTERS-1:0][2:0]               m_awsize,
    input  logic [NUM_MASTERS-1:0][1:0]               m_awburst,
    input  logic [NUM_MASTERS-1:0]                    m_awlock,
    input  logic [NUM_MASTERS-1:0][3:0]               m_awcache,
    input  logic [NUM_MASTERS-1:0][2:0]               m_awprot,
    input  logic [NUM_MASTERS-1:0][3:0]               m_awqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    m_awuser,

    input  logic [NUM_MASTERS-1:0]                    m_wvalid,
    output logic [NUM_MASTERS-1:0]                    m_wready,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    m_wdata,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH/8-1:0]  m_wstrb,
    input  logic [NUM_MASTERS-1:0]                    m_wlast,

    output logic [NUM_MASTERS-1:0]                    m_bvalid,
    input  logic [NUM_MASTERS-1:0]                    m_bready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_bid,
    output logic [NUM_MASTERS-1:0][1:0]               m_bresp,

    input  logic [NUM_MASTERS-1:0]                    m_arvalid,
    output logic [NUM_MASTERS-1:0]                    m_arready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_arid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    m_araddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   m_arlen,
    input  logic [NUM_MASTERS-1:0][2:0]               m_arsize,
    input  logic [NUM_MASTERS-1:0][1:0]               m_arburst,
    input  logic [NUM_MASTERS-1:0]                    m_arlock,
    input  logic [NUM_MASTERS-1:0][3:0]               m_arcache,
    input  logic [NUM_MASTERS-1:0][2:0]               m_arprot,
    input  logic [NUM_MASTERS-1:0][3:0]               m_arqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    m_aruser,

    output logic [NUM_MASTERS-1:0]                    m_rvalid,
    input  logic [NUM_MASTERS-1:0]                    m_rready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_rid,
    output logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    m_rdata,
    output logic [NUM_MASTERS-1:0][1:0]               m_rresp,
    output logic [NUM_MASTERS-1:0]                    m_rlast,

    // DFI 5.0 north observability — driven by the controller's internal
    // command shaper.  These reach the cocotb test verbatim.
    output logic [ADDR_WIDTH-1:0]   dfi_addr,
    output logic [3:0]              dfi_bank,
    output logic                    dfi_cs_n,
    output logic                    dfi_act_n,
    output logic                    dfi_ras_n,
    output logic                    dfi_cas_n,
    output logic                    dfi_we_n,
    output logic                    dfi_reset_n,
    output logic                    dfi_cke,
    output logic                    dfi_odt,
    output logic [DATA_WIDTH-1:0]   dfi_wrdata,
    output logic [DATA_WIDTH/8-1:0] dfi_wrdata_mask,
    output logic                    dfi_wrdata_en,
    output logic                    dfi_rddata_en,
    output logic                    dfi_init_start,
    output logic                    dfi_ctrlupd_req,
    output logic                    refresh_active
);

    localparam logic [ADDR_WIDTH-1:0] DRAM_BASE  = {ADDR_WIDTH{1'b0}};
    localparam logic [ADDR_WIDTH-1:0] DRAM_MASK  = {{(ADDR_WIDTH-32){1'b0}}, 32'h0000_FFFF};
    localparam logic [ADDR_WIDTH-1:0] UNMAP_BASE = {ADDR_WIDTH{1'b1}};
    localparam logic [ADDR_WIDTH-1:0] UNMAP_MASK = {ADDR_WIDTH{1'b0}};

    logic [NUM_SLAVES-1:0]                                                  s_awvalid;
    logic [NUM_SLAVES-1:0]                                                  s_awready;
    logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]               s_awid;
    logic [NUM_SLAVES-1:0][ADDR_WIDTH-1:0]                                   s_awaddr;
    logic [NUM_SLAVES-1:0][BURST_LEN_W-1:0]                                  s_awlen;
    logic [NUM_SLAVES-1:0][2:0]                                              s_awsize;
    logic [NUM_SLAVES-1:0][1:0]                                              s_awburst;
    logic [NUM_SLAVES-1:0]                                                   s_awlock;
    logic [NUM_SLAVES-1:0][3:0]                                              s_awcache;
    logic [NUM_SLAVES-1:0][2:0]                                              s_awprot;
    logic [NUM_SLAVES-1:0][3:0]                                              s_awqos;
    logic [NUM_SLAVES-1:0][USER_WIDTH-1:0]                                   s_awuser;
    logic [NUM_SLAVES-1:0]                                                   s_wvalid;
    logic [NUM_SLAVES-1:0]                                                   s_wready;
    logic [NUM_SLAVES-1:0][DATA_WIDTH-1:0]                                   s_wdata;
    logic [NUM_SLAVES-1:0][DATA_WIDTH/8-1:0]                                 s_wstrb;
    logic [NUM_SLAVES-1:0]                                                   s_wlast;
    logic [NUM_SLAVES-1:0]                                                   s_bvalid;
    logic [NUM_SLAVES-1:0]                                                   s_bready;
    logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]               s_bid;
    logic [NUM_SLAVES-1:0][1:0]                                              s_bresp;
    logic [NUM_SLAVES-1:0]                                                   s_arvalid;
    logic [NUM_SLAVES-1:0]                                                   s_arready;
    logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]               s_arid;
    logic [NUM_SLAVES-1:0][ADDR_WIDTH-1:0]                                   s_araddr;
    logic [NUM_SLAVES-1:0][BURST_LEN_W-1:0]                                  s_arlen;
    logic [NUM_SLAVES-1:0][2:0]                                              s_arsize;
    logic [NUM_SLAVES-1:0][1:0]                                              s_arburst;
    logic [NUM_SLAVES-1:0]                                                   s_arlock;
    logic [NUM_SLAVES-1:0][3:0]                                              s_arcache;
    logic [NUM_SLAVES-1:0][2:0]                                              s_arprot;
    logic [NUM_SLAVES-1:0][3:0]                                              s_arqos;
    logic [NUM_SLAVES-1:0][USER_WIDTH-1:0]                                   s_aruser;
    logic [NUM_SLAVES-1:0]                                                   s_rvalid;
    logic [NUM_SLAVES-1:0]                                                   s_rready;
    logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]               s_rid;
    logic [NUM_SLAVES-1:0][DATA_WIDTH-1:0]                                   s_rdata;
    logic [NUM_SLAVES-1:0][1:0]                                              s_rresp;
    logic [NUM_SLAVES-1:0]                                                   s_rlast;

    logic [NUM_MASTERS-1:0]      decode_err_irq;
    logic [NUM_MASTERS-1:0]      exclusive_fail_irq;
    logic [NUM_MASTERS-1:0][31:0] outstanding_count_dbg;

    e1_axi4_interconnect #(
        .NUM_MASTERS (NUM_MASTERS),
        .NUM_SLAVES  (NUM_SLAVES),
        .ADDR_WIDTH  (ADDR_WIDTH),
        .DATA_WIDTH  (DATA_WIDTH),
        .ID_WIDTH    (ID_WIDTH),
        .USER_WIDTH  (USER_WIDTH),
        .MAX_OUTST   (MAX_OUTST),
        .BURST_LEN_W (BURST_LEN_W),
        .SLAVE_BASE  ('{DRAM_BASE, UNMAP_BASE, UNMAP_BASE, UNMAP_BASE}),
        .SLAVE_MASK  ('{DRAM_MASK, UNMAP_MASK, UNMAP_MASK, UNMAP_MASK})
    ) u_xbar (
        .clk(clk), .rst_n(rst_n),
        .m_awvalid(m_awvalid), .m_awready(m_awready),
        .m_awid(m_awid), .m_awaddr(m_awaddr), .m_awlen(m_awlen),
        .m_awsize(m_awsize), .m_awburst(m_awburst), .m_awlock(m_awlock),
        .m_awcache(m_awcache), .m_awprot(m_awprot), .m_awqos(m_awqos),
        .m_awuser(m_awuser),
        .m_wvalid(m_wvalid), .m_wready(m_wready),
        .m_wdata(m_wdata), .m_wstrb(m_wstrb), .m_wlast(m_wlast),
        .m_bvalid(m_bvalid), .m_bready(m_bready),
        .m_bid(m_bid), .m_bresp(m_bresp),
        .m_arvalid(m_arvalid), .m_arready(m_arready),
        .m_arid(m_arid), .m_araddr(m_araddr), .m_arlen(m_arlen),
        .m_arsize(m_arsize), .m_arburst(m_arburst), .m_arlock(m_arlock),
        .m_arcache(m_arcache), .m_arprot(m_arprot), .m_arqos(m_arqos),
        .m_aruser(m_aruser),
        .m_rvalid(m_rvalid), .m_rready(m_rready),
        .m_rid(m_rid), .m_rdata(m_rdata), .m_rresp(m_rresp), .m_rlast(m_rlast),
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
        .decode_err_irq(decode_err_irq),
        .exclusive_fail_irq(exclusive_fail_irq),
        .outstanding_count_dbg(outstanding_count_dbg),
        .irq_status_clear_we              (1'b0),
        .irq_status_decode_err_clear_mask ('0),
        .irq_status_excl_fail_clear_mask  ('0)
    );

    logic [31:0] dfi_corrected;
    logic [31:0] dfi_uncorrected;
    logic [31:0] dfi_linkecc_corr;
    logic [31:0] dfi_linkecc_uncorr;
    logic        dfi_ecc_irq;
    logic        dfi_zqcs_active;
    logic        dfi_zqcl_active;
    logic        dfi_dram_clk_disable;

    e1_dram_ctrl #(
        .ID_WIDTH    (ID_WIDTH + $clog2(NUM_MASTERS+1)),
        .ADDR_WIDTH  (ADDR_WIDTH),
        .DATA_WIDTH  (DATA_WIDTH),
        .USER_WIDTH  (USER_WIDTH),
        .BURST_LEN_W (BURST_LEN_W),
        // Compress the refresh interval so the cocotb test exercises
        // refresh_active without simulating millions of cycles.
        .TREFI_CYCLES (256),
        .TRFCAB_CYCLES(32),
        .TRFCPB_CYCLES(16),
        .ZQCS_INTERVAL(512),
        .ZQCL_INTERVAL(4096)
    ) u_ctrl (
        .clk(clk), .rst_n(rst_n),
        .s_awvalid(s_awvalid[0]), .s_awready(s_awready[0]),
        .s_awid(s_awid[0]), .s_awaddr(s_awaddr[0]), .s_awlen(s_awlen[0]),
        .s_awsize(s_awsize[0]), .s_awburst(s_awburst[0]), .s_awlock(s_awlock[0]),
        .s_awcache(s_awcache[0]), .s_awprot(s_awprot[0]), .s_awqos(s_awqos[0]),
        .s_awuser(s_awuser[0]),
        .s_wvalid(s_wvalid[0]), .s_wready(s_wready[0]),
        .s_wdata(s_wdata[0]), .s_wstrb(s_wstrb[0]), .s_wlast(s_wlast[0]),
        .s_bvalid(s_bvalid[0]), .s_bready(s_bready[0]),
        .s_bid(s_bid[0]), .s_bresp(s_bresp[0]),
        .s_arvalid(s_arvalid[0]), .s_arready(s_arready[0]),
        .s_arid(s_arid[0]), .s_araddr(s_araddr[0]), .s_arlen(s_arlen[0]),
        .s_arsize(s_arsize[0]), .s_arburst(s_arburst[0]), .s_arlock(s_arlock[0]),
        .s_arcache(s_arcache[0]), .s_arprot(s_arprot[0]), .s_arqos(s_arqos[0]),
        .s_aruser(s_aruser[0]),
        .s_rvalid(s_rvalid[0]), .s_rready(s_rready[0]),
        .s_rid(s_rid[0]), .s_rdata(s_rdata[0]), .s_rresp(s_rresp[0]), .s_rlast(s_rlast[0]),
        // DFI 5.0 north — wired out for cocotb observation.
        .dfi_addr(dfi_addr),
        .dfi_bank(dfi_bank),
        .dfi_cs_n(dfi_cs_n),
        .dfi_act_n(dfi_act_n),
        .dfi_ras_n(dfi_ras_n),
        .dfi_cas_n(dfi_cas_n),
        .dfi_we_n(dfi_we_n),
        .dfi_reset_n(dfi_reset_n),
        .dfi_cke(dfi_cke),
        .dfi_odt(dfi_odt),
        .dfi_wrdata(dfi_wrdata),
        .dfi_wrdata_mask(dfi_wrdata_mask),
        .dfi_wrdata_en(dfi_wrdata_en),
        .dfi_rddata('0),
        .dfi_rddata_valid(1'b0),
        .dfi_rddata_en(dfi_rddata_en),
        .dfi_init_start(dfi_init_start),
        .dfi_init_complete(1'b1),
        .dfi_ctrlupd_req(dfi_ctrlupd_req),
        .dfi_ctrlupd_ack(1'b1),
        .dfi_dram_clk_disable(dfi_dram_clk_disable),
        .refresh_active(refresh_active),
        .zqcs_active(dfi_zqcs_active),
        .zqcl_active(dfi_zqcl_active),
        .odecc_corrected_count(dfi_corrected),
        .odecc_uncorrected_count(dfi_uncorrected),
        .linkecc_corrected_count(dfi_linkecc_corr),
        .linkecc_uncorrected_count(dfi_linkecc_uncorr),
        .ecc_uncorrected_irq(dfi_ecc_irq)
    );

    generate
        for (genvar gs = 1; gs < NUM_SLAVES; gs++) begin : g_tie_slave
            assign s_awready[gs] = 1'b1;
            assign s_wready[gs]  = 1'b1;
            assign s_bvalid[gs]  = 1'b0;
            assign s_bid[gs]     = '0;
            assign s_bresp[gs]   = 2'b00;
            assign s_arready[gs] = 1'b1;
            assign s_rvalid[gs]  = 1'b0;
            assign s_rid[gs]     = '0;
            assign s_rdata[gs]   = '0;
            assign s_rresp[gs]   = 2'b00;
            assign s_rlast[gs]   = 1'b0;
        end
    endgenerate

endmodule
