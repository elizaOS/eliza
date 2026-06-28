`timescale 1ns/1ps

// e1_iommu_tb
//
// Harness wrapping e1_riscv_iommu with a real backing-memory AXI4 slave on
// the downstream (walk) port.  The slave is a flat doubleword memory the
// cocotb test preloads with a Device Directory Table and Sv39/Sv39x4 page
// tables; the IOMMU page-table walker reads it over the downstream master.
//
// The slave services single-beat (AWLEN/ARLEN==0) accesses one at a time,
// which matches the walker's per-doubleword reads and the translated
// single-beat forwards used by the cocotb suite.  Memory is 64-bit-word
// addressed; reads return the addressed doubleword on a 128-bit beat with
// the doubleword placed in the lane selected by address bit [3].
//
// Used by cocotb tests under verify/cocotb/iommu/.

module e1_iommu_tb #(
    parameter int unsigned NUM_MASTERS = 2,
    parameter int unsigned ID_WIDTH    = 4,
    parameter int unsigned ADDR_WIDTH  = 40,
    parameter int unsigned DATA_WIDTH  = 128,
    parameter int unsigned USER_WIDTH  = 8,
    parameter int unsigned BURST_LEN_W = 8,
    parameter int unsigned DEVICE_ID_W = 24,
    parameter int unsigned PASID_W     = 20,
    parameter int unsigned MEM_WORDS   = 16384  // 64-bit doublewords (128 KiB)
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

    // ------------------------------------------------------------------
    // Downstream channel wiring between IOMMU and the backing-memory slave.
    // ------------------------------------------------------------------
    logic                    d_awvalid;
    logic                    d_awready;
    logic [ID_WIDTH-1:0]     d_awid;
    logic [ADDR_WIDTH-1:0]   d_awaddr;
    logic [BURST_LEN_W-1:0]  d_awlen;
    logic [2:0]              d_awsize;
    logic [1:0]              d_awburst;
    logic [3:0]              d_awcache;
    logic [2:0]              d_awprot;
    logic [3:0]              d_awqos;
    logic [USER_WIDTH-1:0]   d_awuser;
    logic                    d_wvalid;
    logic                    d_wready;
    logic [DATA_WIDTH-1:0]   d_wdata;
    logic [DATA_WIDTH/8-1:0] d_wstrb;
    logic                    d_wlast;
    logic                    d_bvalid;
    logic                    d_bready;
    logic [ID_WIDTH-1:0]     d_bid;
    logic [1:0]              d_bresp;
    logic                    d_arvalid;
    logic                    d_arready;
    logic [ID_WIDTH-1:0]     d_arid;
    logic [ADDR_WIDTH-1:0]   d_araddr;
    logic [BURST_LEN_W-1:0]  d_arlen;
    logic [2:0]              d_arsize;
    logic [1:0]              d_arburst;
    logic [3:0]              d_arcache;
    logic [2:0]              d_arprot;
    logic [3:0]              d_arqos;
    logic [USER_WIDTH-1:0]   d_aruser;
    logic                    d_rvalid;
    logic                    d_rready;
    logic [ID_WIDTH-1:0]     d_rid;
    logic [DATA_WIDTH-1:0]   d_rdata;
    logic [1:0]              d_rresp;
    logic                    d_rlast;

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
        .d_awvalid(d_awvalid), .d_awready(d_awready),
        .d_awid(d_awid), .d_awaddr(d_awaddr), .d_awlen(d_awlen),
        .d_awsize(d_awsize), .d_awburst(d_awburst),
        .d_awcache(d_awcache), .d_awprot(d_awprot), .d_awqos(d_awqos),
        .d_awuser(d_awuser),
        .d_wvalid(d_wvalid), .d_wready(d_wready),
        .d_wdata(d_wdata), .d_wstrb(d_wstrb), .d_wlast(d_wlast),
        .d_bvalid(d_bvalid), .d_bready(d_bready),
        .d_bid(d_bid), .d_bresp(d_bresp),
        .d_arvalid(d_arvalid), .d_arready(d_arready),
        .d_arid(d_arid), .d_araddr(d_araddr), .d_arlen(d_arlen),
        .d_arsize(d_arsize), .d_arburst(d_arburst),
        .d_arcache(d_arcache), .d_arprot(d_arprot), .d_arqos(d_arqos),
        .d_aruser(d_aruser),
        .d_rvalid(d_rvalid), .d_rready(d_rready),
        .d_rid(d_rid), .d_rdata(d_rdata), .d_rresp(d_rresp),
        .d_rlast(d_rlast),
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

    // ==================================================================
    // Backing-memory AXI4 slave (single outstanding, one beat at a time).
    //
    // `mem` is a flat 64-bit doubleword array; the cocotb test preloads it
    // by hierarchical poke (mem[word].value = <64-bit value>).  Word index
    // = byte address >> 3.
    // ==================================================================
    logic [63:0] mem [0:MEM_WORDS-1];

    function automatic int unsigned word_idx(input logic [ADDR_WIDTH-1:0] byte_addr);
        return byte_addr[ADDR_WIDTH-1:3] % MEM_WORDS;
    endfunction

    // ---- Read channel ----
    typedef enum logic [1:0] {S_RD_IDLE, S_RD_DATA} rd_e;
    rd_e rd_st;
    logic [ID_WIDTH-1:0]   rd_id;
    logic [63:0]           rd_word;
    logic                  rd_lane_hi;

    assign d_arready = (rd_st == S_RD_IDLE);
    assign d_rvalid  = (rd_st == S_RD_DATA);
    assign d_rid     = rd_id;
    assign d_rresp   = 2'b00;
    assign d_rlast   = (rd_st == S_RD_DATA);
    assign d_rdata   = rd_lane_hi ? {rd_word, 64'b0} : {64'b0, rd_word};

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_st      <= S_RD_IDLE;
            rd_id      <= '0;
            rd_word    <= '0;
            rd_lane_hi <= 1'b0;
        end else begin
            case (rd_st)
                S_RD_IDLE: if (d_arvalid) begin
                    rd_id      <= d_arid;
                    rd_word    <= mem[word_idx(d_araddr)];
                    rd_lane_hi <= d_araddr[3];
                    rd_st      <= S_RD_DATA;
                end
                S_RD_DATA: if (d_rready) rd_st <= S_RD_IDLE;
                default: rd_st <= S_RD_IDLE;
            endcase
        end
    end

    // ---- Write channel ----
    typedef enum logic [1:0] {S_WR_AW, S_WR_DATA, S_WR_RESP} wr_e;
    wr_e wr_st;
    logic [ID_WIDTH-1:0]   wr_id;
    logic [ADDR_WIDTH-1:0] wr_addr;

    assign d_awready = (wr_st == S_WR_AW);
    assign d_wready  = (wr_st == S_WR_DATA);
    assign d_bvalid  = (wr_st == S_WR_RESP);
    assign d_bid     = wr_id;
    assign d_bresp   = 2'b00;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_st   <= S_WR_AW;
            wr_id   <= '0;
            wr_addr <= '0;
        end else begin
            case (wr_st)
                S_WR_AW: if (d_awvalid) begin
                    wr_id   <= d_awid;
                    wr_addr <= d_awaddr;
                    wr_st   <= S_WR_DATA;
                end
                S_WR_DATA: if (d_wvalid) begin
                    // Store the addressed doubleword lane (byte-strobe aware
                    // only at doubleword granularity, sufficient for the
                    // walker/forwarding traffic in this suite).
                    if (wr_addr[3]) mem[word_idx(wr_addr)] <= d_wdata[127:64];
                    else            mem[word_idx(wr_addr)] <= d_wdata[63:0];
                    if (d_wlast) wr_st <= S_WR_RESP;
                end
                S_WR_RESP: if (d_bready) wr_st <= S_WR_AW;
                default: wr_st <= S_WR_AW;
            endcase
        end
    end

endmodule
