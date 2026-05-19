`timescale 1ns/1ps

// e1_iommu_tb
//
// Harness wrapping e1_riscv_iommu with a synthetic downstream slave that
// always accepts traffic.  Used by cocotb tests under
// verify/cocotb/iommu/.

module e1_iommu_tb #(
    parameter int unsigned NUM_MASTERS = 2,
    parameter int unsigned ID_WIDTH    = 4,
    parameter int unsigned ADDR_WIDTH  = 40,
    parameter int unsigned DATA_WIDTH  = 128,
    parameter int unsigned USER_WIDTH  = 8,
    parameter int unsigned BURST_LEN_W = 8,
    parameter int unsigned DEVICE_ID_W = 24,
    parameter int unsigned PASID_W     = 20
) (
    input  logic clk,
    input  logic rst_n,

    // upstream masters
    input  logic [NUM_MASTERS-1:0]                    u_awvalid,
    output logic [NUM_MASTERS-1:0]                    u_awready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_awid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    u_awaddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   u_awlen,
    input  logic [NUM_MASTERS-1:0][2:0]               u_awsize,
    input  logic [NUM_MASTERS-1:0][1:0]               u_awburst,
    input  logic [NUM_MASTERS-1:0][3:0]               u_awcache,
    input  logic [NUM_MASTERS-1:0][2:0]               u_awprot,
    input  logic [NUM_MASTERS-1:0][3:0]               u_awqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    u_awuser,
    input  logic [NUM_MASTERS-1:0][DEVICE_ID_W-1:0]   u_aw_devid,
    input  logic [NUM_MASTERS-1:0][PASID_W-1:0]       u_aw_pasid,
    input  logic [NUM_MASTERS-1:0]                    u_wvalid,
    output logic [NUM_MASTERS-1:0]                    u_wready,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    u_wdata,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH/8-1:0]  u_wstrb,
    input  logic [NUM_MASTERS-1:0]                    u_wlast,
    output logic [NUM_MASTERS-1:0]                    u_bvalid,
    input  logic [NUM_MASTERS-1:0]                    u_bready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_bid,
    output logic [NUM_MASTERS-1:0][1:0]               u_bresp,
    input  logic [NUM_MASTERS-1:0]                    u_arvalid,
    output logic [NUM_MASTERS-1:0]                    u_arready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_arid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    u_araddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   u_arlen,
    input  logic [NUM_MASTERS-1:0][2:0]               u_arsize,
    input  logic [NUM_MASTERS-1:0][1:0]               u_arburst,
    input  logic [NUM_MASTERS-1:0][3:0]               u_arcache,
    input  logic [NUM_MASTERS-1:0][2:0]               u_arprot,
    input  logic [NUM_MASTERS-1:0][3:0]               u_arqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    u_aruser,
    input  logic [NUM_MASTERS-1:0][DEVICE_ID_W-1:0]   u_ar_devid,
    input  logic [NUM_MASTERS-1:0][PASID_W-1:0]       u_ar_pasid,
    output logic [NUM_MASTERS-1:0]                    u_rvalid,
    input  logic [NUM_MASTERS-1:0]                    u_rready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_rid,
    output logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    u_rdata,
    output logic [NUM_MASTERS-1:0][1:0]               u_rresp,
    output logic [NUM_MASTERS-1:0]                    u_rlast,

    // synthetic downstream (always-accept, OKAY)
    input  logic d_awready,
    input  logic d_wready,
    input  logic d_bvalid,
    input  logic d_arready,
    input  logic d_rvalid,

    // MMIO
    input  logic        mmio_awvalid,
    output logic        mmio_awready,
    input  logic [11:0] mmio_awaddr,
    input  logic        mmio_wvalid,
    output logic        mmio_wready,
    input  logic [63:0] mmio_wdata,
    input  logic [7:0]  mmio_wstrb,
    output logic        mmio_bvalid,
    input  logic        mmio_bready,
    output logic [1:0]  mmio_bresp,
    input  logic        mmio_arvalid,
    output logic        mmio_arready,
    input  logic [11:0] mmio_araddr,
    output logic        mmio_rvalid,
    input  logic        mmio_rready,
    output logic [63:0] mmio_rdata,
    output logic [1:0]  mmio_rresp,

    output logic        fault_irq,
    output logic        page_req_irq,
    output logic        cmd_complete_irq,
    output logic [31:0] fault_count_dbg,
    output logic [31:0] page_req_count_dbg
);

    logic                    d_awvalid_int;
    logic [ID_WIDTH-1:0]     d_awid_int;
    logic [ADDR_WIDTH-1:0]   d_awaddr_int;
    logic [BURST_LEN_W-1:0]  d_awlen_int;
    logic [2:0]              d_awsize_int;
    logic [1:0]              d_awburst_int;
    logic [3:0]              d_awcache_int;
    logic [2:0]              d_awprot_int;
    logic [3:0]              d_awqos_int;
    logic [USER_WIDTH-1:0]   d_awuser_int;
    logic                    d_wvalid_int;
    logic [DATA_WIDTH-1:0]   d_wdata_int;
    logic [DATA_WIDTH/8-1:0] d_wstrb_int;
    logic                    d_wlast_int;
    logic                    d_bready_int;
    logic [ID_WIDTH-1:0]     d_bid_int;
    logic [1:0]              d_bresp_int;
    logic                    d_arvalid_int;
    logic [ID_WIDTH-1:0]     d_arid_int;
    logic [ADDR_WIDTH-1:0]   d_araddr_int;
    logic [BURST_LEN_W-1:0]  d_arlen_int;
    logic [2:0]              d_arsize_int;
    logic [1:0]              d_arburst_int;
    logic [3:0]              d_arcache_int;
    logic [2:0]              d_arprot_int;
    logic [3:0]              d_arqos_int;
    logic [USER_WIDTH-1:0]   d_aruser_int;
    logic                    d_rready_int;
    logic [ID_WIDTH-1:0]     d_rid_int;
    logic [DATA_WIDTH-1:0]   d_rdata_int;
    logic [1:0]              d_rresp_int;
    logic                    d_rlast_int;

    assign d_bid_int   = '0;
    assign d_bresp_int = 2'b00;
    assign d_rid_int   = '0;
    assign d_rdata_int = '0;
    assign d_rresp_int = 2'b00;
    assign d_rlast_int = 1'b1;

    e1_riscv_iommu #(
        .ID_WIDTH    (ID_WIDTH),
        .ADDR_WIDTH  (ADDR_WIDTH),
        .DATA_WIDTH  (DATA_WIDTH),
        .USER_WIDTH  (USER_WIDTH),
        .BURST_LEN_W (BURST_LEN_W),
        .NUM_MASTERS (NUM_MASTERS),
        .DEVICE_ID_W (DEVICE_ID_W),
        .PASID_W     (PASID_W)
    ) u_iommu (
        .clk(clk), .rst_n(rst_n),
        .u_awvalid(u_awvalid), .u_awready(u_awready),
        .u_awid(u_awid), .u_awaddr(u_awaddr), .u_awlen(u_awlen),
        .u_awsize(u_awsize), .u_awburst(u_awburst),
        .u_awcache(u_awcache), .u_awprot(u_awprot), .u_awqos(u_awqos),
        .u_awuser(u_awuser), .u_aw_devid(u_aw_devid), .u_aw_pasid(u_aw_pasid),
        .u_wvalid(u_wvalid), .u_wready(u_wready),
        .u_wdata(u_wdata), .u_wstrb(u_wstrb), .u_wlast(u_wlast),
        .u_bvalid(u_bvalid), .u_bready(u_bready), .u_bid(u_bid), .u_bresp(u_bresp),
        .u_arvalid(u_arvalid), .u_arready(u_arready),
        .u_arid(u_arid), .u_araddr(u_araddr), .u_arlen(u_arlen),
        .u_arsize(u_arsize), .u_arburst(u_arburst),
        .u_arcache(u_arcache), .u_arprot(u_arprot), .u_arqos(u_arqos),
        .u_aruser(u_aruser), .u_ar_devid(u_ar_devid), .u_ar_pasid(u_ar_pasid),
        .u_rvalid(u_rvalid), .u_rready(u_rready),
        .u_rid(u_rid), .u_rdata(u_rdata), .u_rresp(u_rresp), .u_rlast(u_rlast),
        .d_awvalid(d_awvalid_int), .d_awready(d_awready),
        .d_awid(d_awid_int), .d_awaddr(d_awaddr_int), .d_awlen(d_awlen_int),
        .d_awsize(d_awsize_int), .d_awburst(d_awburst_int),
        .d_awcache(d_awcache_int), .d_awprot(d_awprot_int), .d_awqos(d_awqos_int),
        .d_awuser(d_awuser_int),
        .d_wvalid(d_wvalid_int), .d_wready(d_wready),
        .d_wdata(d_wdata_int), .d_wstrb(d_wstrb_int), .d_wlast(d_wlast_int),
        .d_bvalid(d_bvalid), .d_bready(d_bready_int),
        .d_bid(d_bid_int), .d_bresp(d_bresp_int),
        .d_arvalid(d_arvalid_int), .d_arready(d_arready),
        .d_arid(d_arid_int), .d_araddr(d_araddr_int), .d_arlen(d_arlen_int),
        .d_arsize(d_arsize_int), .d_arburst(d_arburst_int),
        .d_arcache(d_arcache_int), .d_arprot(d_arprot_int), .d_arqos(d_arqos_int),
        .d_aruser(d_aruser_int),
        .d_rvalid(d_rvalid), .d_rready(d_rready_int),
        .d_rid(d_rid_int), .d_rdata(d_rdata_int), .d_rresp(d_rresp_int),
        .d_rlast(d_rlast_int),
        .mmio_awvalid(mmio_awvalid), .mmio_awready(mmio_awready),
        .mmio_awaddr(mmio_awaddr),
        .mmio_wvalid(mmio_wvalid), .mmio_wready(mmio_wready),
        .mmio_wdata(mmio_wdata), .mmio_wstrb(mmio_wstrb),
        .mmio_bvalid(mmio_bvalid), .mmio_bready(mmio_bready), .mmio_bresp(mmio_bresp),
        .mmio_arvalid(mmio_arvalid), .mmio_arready(mmio_arready),
        .mmio_araddr(mmio_araddr),
        .mmio_rvalid(mmio_rvalid), .mmio_rready(mmio_rready),
        .mmio_rdata(mmio_rdata), .mmio_rresp(mmio_rresp),
        .fault_irq(fault_irq), .page_req_irq(page_req_irq),
        .cmd_complete_irq(cmd_complete_irq),
        .fault_count_dbg(fault_count_dbg),
        .page_req_count_dbg(page_req_count_dbg)
    );

endmodule
