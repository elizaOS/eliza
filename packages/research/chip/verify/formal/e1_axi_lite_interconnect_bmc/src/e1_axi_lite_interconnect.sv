`timescale 1ns/1ps

// e1_axi_lite_interconnect
//
// Multi-master AXI-Lite 3-to-5 interconnect with priority arbiter.
//
// Masters (port indices):
//   0  CPU          - highest priority (ports: m_axil_*)
//   1  DMA          - medium  priority (ports: dma_m_*)
//   2  Debug bridge - lowest  priority (ports: dbg_m_*)
//
// Slaves:
//   DRAM  0x8000_0000 - 0x8FFF_FFFF  (256 MiB aperture)
//   INTC  0x0C00_0000 - 0x0C00_0FFF  (4 KiB)
//   DMA   0x1001_0000 - 0x1001_0FFF  (4 KiB)
//   NPU   0x1002_0000 - 0x1002_0FFF  (4 KiB)
//   DISP  0x1003_0000 - 0x1003_0FFF  (4 KiB)
//   Unmapped regions -> SLVERR (last bad address captured in debug reg)
//
// Internal debug registers (no external slave port):
//   0x1FFF_FFF0  DECODE_ERR_ADDR - last unmapped byte address (RO sticky)
//   0x1FFF_FFF4  TIMEOUT_STATUS  - per-master timeout flags; write 1-to-clear
//
// Pipeline:
//   One register stage on the AR/AW input from each master (breaks long comb
//   paths to slave AR/AW ports).  One register stage on B/R responses back to
//   each master.  Each master may have up to MAX_OUTST=4 in-flight
//   transactions before back-pressure is asserted.
//
// Watchdog:
//   If an outstanding transaction on any master receives no response within
//   1024 cycles, timeout_irq[m] is pulsed, TIMEOUT_STATUS[m] is set, and a
//   synthetic SLVERR response is injected.

module e1_axi_lite_interconnect #(
    parameter int unsigned NUM_MASTERS = 3
) (
    input  logic        clk,
    input  logic        rst_n,

    // Master 0 - CPU
    input  logic        m_axil_awvalid,
    output logic        m_axil_awready,
    input  logic [31:0] m_axil_awaddr,
    input  logic        m_axil_wvalid,
    output logic        m_axil_wready,
    input  logic [31:0] m_axil_wdata,
    input  logic [3:0]  m_axil_wstrb,
    output logic        m_axil_bvalid,
    input  logic        m_axil_bready,
    output logic [1:0]  m_axil_bresp,

    input  logic        m_axil_arvalid,
    output logic        m_axil_arready,
    input  logic [31:0] m_axil_araddr,
    output logic        m_axil_rvalid,
    input  logic        m_axil_rready,
    output logic [31:0] m_axil_rdata,
    output logic [1:0]  m_axil_rresp,

    // Master 1 - DMA
    input  logic        dma_m_awvalid,
    output logic        dma_m_awready,
    input  logic [31:0] dma_m_awaddr,
    input  logic        dma_m_wvalid,
    output logic        dma_m_wready,
    input  logic [31:0] dma_m_wdata,
    input  logic [3:0]  dma_m_wstrb,
    output logic        dma_m_bvalid,
    input  logic        dma_m_bready,
    output logic [1:0]  dma_m_bresp,

    input  logic        dma_m_arvalid,
    output logic        dma_m_arready,
    input  logic [31:0] dma_m_araddr,
    output logic        dma_m_rvalid,
    input  logic        dma_m_rready,
    output logic [31:0] dma_m_rdata,
    output logic [1:0]  dma_m_rresp,

    // Master 2 - Debug bridge
    input  logic        dbg_m_awvalid,
    output logic        dbg_m_awready,
    input  logic [31:0] dbg_m_awaddr,
    input  logic        dbg_m_wvalid,
    output logic        dbg_m_wready,
    input  logic [31:0] dbg_m_wdata,
    input  logic [3:0]  dbg_m_wstrb,
    output logic        dbg_m_bvalid,
    input  logic        dbg_m_bready,
    output logic [1:0]  dbg_m_bresp,

    input  logic        dbg_m_arvalid,
    output logic        dbg_m_arready,
    input  logic [31:0] dbg_m_araddr,
    output logic        dbg_m_rvalid,
    input  logic        dbg_m_rready,
    output logic [31:0] dbg_m_rdata,
    output logic [1:0]  dbg_m_rresp,

    // Slave - DRAM
    output logic        dram_awvalid,
    input  logic        dram_awready,
    output logic [31:0] dram_awaddr,
    output logic        dram_wvalid,
    input  logic        dram_wready,
    output logic [31:0] dram_wdata,
    output logic [3:0]  dram_wstrb,
    input  logic        dram_bvalid,
    output logic        dram_bready,
    input  logic [1:0]  dram_bresp,
    output logic        dram_arvalid,
    input  logic        dram_arready,
    output logic [31:0] dram_araddr,
    input  logic        dram_rvalid,
    output logic        dram_rready,
    input  logic [31:0] dram_rdata,
    input  logic [1:0]  dram_rresp,

    // Slave - Interrupt controller
    output logic        intc_awvalid,
    input  logic        intc_awready,
    output logic [31:0] intc_awaddr,
    output logic        intc_wvalid,
    input  logic        intc_wready,
    output logic [31:0] intc_wdata,
    output logic [3:0]  intc_wstrb,
    input  logic        intc_bvalid,
    output logic        intc_bready,
    input  logic [1:0]  intc_bresp,
    output logic        intc_arvalid,
    input  logic        intc_arready,
    output logic [31:0] intc_araddr,
    input  logic        intc_rvalid,
    output logic        intc_rready,
    input  logic [31:0] intc_rdata,
    input  logic [1:0]  intc_rresp,

    // Slave - DMA MMIO
    output logic        dma_awvalid,
    input  logic        dma_awready,
    output logic [31:0] dma_awaddr,
    output logic        dma_wvalid,
    input  logic        dma_wready,
    output logic [31:0] dma_wdata,
    output logic [3:0]  dma_wstrb,
    input  logic        dma_bvalid,
    output logic        dma_bready,
    input  logic [1:0]  dma_bresp,
    output logic        dma_arvalid,
    input  logic        dma_arready,
    output logic [31:0] dma_araddr,
    input  logic        dma_rvalid,
    output logic        dma_rready,
    input  logic [31:0] dma_rdata,
    input  logic [1:0]  dma_rresp,

    // Slave - NPU MMIO
    output logic        npu_awvalid,
    input  logic        npu_awready,
    output logic [31:0] npu_awaddr,
    output logic        npu_wvalid,
    input  logic        npu_wready,
    output logic [31:0] npu_wdata,
    output logic [3:0]  npu_wstrb,
    input  logic        npu_bvalid,
    output logic        npu_bready,
    input  logic [1:0]  npu_bresp,
    output logic        npu_arvalid,
    input  logic        npu_arready,
    output logic [31:0] npu_araddr,
    input  logic        npu_rvalid,
    output logic        npu_rready,
    input  logic [31:0] npu_rdata,
    input  logic [1:0]  npu_rresp,

    // Slave - Display MMIO
    output logic        display_awvalid,
    input  logic        display_awready,
    output logic [31:0] display_awaddr,
    output logic        display_wvalid,
    input  logic        display_wready,
    output logic [31:0] display_wdata,
    output logic [3:0]  display_wstrb,
    input  logic        display_bvalid,
    output logic        display_bready,
    input  logic [1:0]  display_bresp,
    output logic        display_arvalid,
    input  logic        display_arready,
    output logic [31:0] display_araddr,
    input  logic        display_rvalid,
    output logic        display_rready,
    input  logic [31:0] display_rdata,
    input  logic [1:0]  display_rresp,

    // Observability / interrupt outputs
    output logic [NUM_MASTERS-1:0] arb_grant,   // one-hot read-channel grant
    output logic [NUM_MASTERS-1:0] timeout_irq  // per-master watchdog pulse
);

    // -----------------------------------------------------------------------
    // Local constants
    // -----------------------------------------------------------------------

    // Slave selector encoding
    localparam logic [2:0] SEL_NONE = 3'h0;
    localparam logic [2:0] SEL_DRAM = 3'h1;
    localparam logic [2:0] SEL_INTC = 3'h2;
    localparam logic [2:0] SEL_DMA  = 3'h3;
    localparam logic [2:0] SEL_NPU  = 3'h4;
    localparam logic [2:0] SEL_DISP = 3'h5;
    localparam logic [2:0] SEL_ERR  = 3'h6;  // unmapped -> SLVERR
    localparam logic [2:0] SEL_DBG  = 3'h7;  // internal debug registers

    // Address decode: base address and mask (region_size - 1)
    localparam logic [31:0] DRAM_BASE = 32'h8000_0000;
    localparam logic [31:0] DRAM_MASK = 32'h0FFF_FFFF;  // 256 MiB
    localparam logic [31:0] INTC_BASE = 32'h0C00_0000;
    localparam logic [31:0] INTC_MASK = 32'h0000_0FFF;  // 4 KiB
    localparam logic [31:0] DMA_BASE  = 32'h1001_0000;
    localparam logic [31:0] DMA_MASK  = 32'h0000_0FFF;  // 4 KiB
    localparam logic [31:0] NPU_BASE  = 32'h1002_0000;
    localparam logic [31:0] NPU_MASK  = 32'h0000_0FFF;  // 4 KiB
    localparam logic [31:0] DISP_BASE = 32'h1003_0000;
    localparam logic [31:0] DISP_MASK = 32'h0000_0FFF;  // 4 KiB

    // Internal debug register addresses
    localparam logic [31:0] DBG_DECODE_ERR_ADDR = 32'h1FFF_FFF0;
    localparam logic [31:0] DBG_TIMEOUT_ADDR    = 32'h1FFF_FFF4;

    // AXI-Lite response codes
    localparam logic [1:0] RESP_OKAY   = 2'b00;
    localparam logic [1:0] RESP_SLVERR = 2'b10;

    // Outstanding transaction limit per master
    localparam int unsigned MAX_OUTST = 4;
    localparam int unsigned OST_W     = $clog2(MAX_OUTST + 1);  // 3 bits

    // Watchdog limit (cycles)
    localparam int unsigned WD_LIMIT = 1024;
    localparam int unsigned WD_W     = $clog2(WD_LIMIT + 1);    // 11 bits

    // -----------------------------------------------------------------------
    // Address decode function
    // -----------------------------------------------------------------------
    function automatic logic [2:0] decode_addr(input logic [31:0] addr);
        if (addr == DBG_DECODE_ERR_ADDR || addr == DBG_TIMEOUT_ADDR)
            decode_addr = SEL_DBG;
        else if ((addr & ~DRAM_MASK) == DRAM_BASE)
            decode_addr = SEL_DRAM;
        else if ((addr & ~INTC_MASK) == INTC_BASE)
            decode_addr = SEL_INTC;
        else if ((addr & ~DMA_MASK) == DMA_BASE)
            decode_addr = SEL_DMA;
        else if ((addr & ~NPU_MASK) == NPU_BASE)
            decode_addr = SEL_NPU;
        else if ((addr & ~DISP_MASK) == DISP_BASE)
            decode_addr = SEL_DISP;
        else
            decode_addr = SEL_ERR;
    endfunction

    // -----------------------------------------------------------------------
    // Master input/output arrays (index 0=CPU, 1=DMA, 2=DBG)
    // -----------------------------------------------------------------------
    logic        mi_awvalid [0:NUM_MASTERS-1];
    logic [31:0] mi_awaddr  [0:NUM_MASTERS-1];
    logic        mi_wvalid  [0:NUM_MASTERS-1];
    logic [31:0] mi_wdata   [0:NUM_MASTERS-1];
    logic [3:0]  mi_wstrb   [0:NUM_MASTERS-1];
    logic        mi_bready  [0:NUM_MASTERS-1];
    logic        mi_arvalid [0:NUM_MASTERS-1];
    logic [31:0] mi_araddr  [0:NUM_MASTERS-1];
    logic        mi_rready  [0:NUM_MASTERS-1];

    logic        mo_awready [0:NUM_MASTERS-1];
    logic        mo_wready  [0:NUM_MASTERS-1];
    logic        mo_bvalid  [0:NUM_MASTERS-1];
    logic [1:0]  mo_bresp   [0:NUM_MASTERS-1];
    logic        mo_arready [0:NUM_MASTERS-1];
    logic        mo_rvalid  [0:NUM_MASTERS-1];
    logic [31:0] mo_rdata   [0:NUM_MASTERS-1];
    logic [1:0]  mo_rresp   [0:NUM_MASTERS-1];

    // Map flat ports into arrays
    always_comb begin
        mi_awvalid[0] = m_axil_awvalid;  mi_awaddr[0] = m_axil_awaddr;
        mi_wvalid[0]  = m_axil_wvalid;   mi_wdata[0]  = m_axil_wdata;
        mi_wstrb[0]   = m_axil_wstrb;    mi_bready[0] = m_axil_bready;
        mi_arvalid[0] = m_axil_arvalid;  mi_araddr[0] = m_axil_araddr;
        mi_rready[0]  = m_axil_rready;

        mi_awvalid[1] = dma_m_awvalid;   mi_awaddr[1] = dma_m_awaddr;
        mi_wvalid[1]  = dma_m_wvalid;    mi_wdata[1]  = dma_m_wdata;
        mi_wstrb[1]   = dma_m_wstrb;     mi_bready[1] = dma_m_bready;
        mi_arvalid[1] = dma_m_arvalid;   mi_araddr[1] = dma_m_araddr;
        mi_rready[1]  = dma_m_rready;

        mi_awvalid[2] = dbg_m_awvalid;   mi_awaddr[2] = dbg_m_awaddr;
        mi_wvalid[2]  = dbg_m_wvalid;    mi_wdata[2]  = dbg_m_wdata;
        mi_wstrb[2]   = dbg_m_wstrb;     mi_bready[2] = dbg_m_bready;
        mi_arvalid[2] = dbg_m_arvalid;   mi_araddr[2] = dbg_m_araddr;
        mi_rready[2]  = dbg_m_rready;
    end

    // Map array outputs back to flat ports
    assign m_axil_awready = mo_awready[0];
    assign m_axil_wready  = mo_wready[0];
    assign m_axil_bvalid  = mo_bvalid[0];
    assign m_axil_bresp   = mo_bresp[0];
    assign m_axil_arready = mo_arready[0];
    assign m_axil_rvalid  = mo_rvalid[0];
    assign m_axil_rdata   = mo_rdata[0];
    assign m_axil_rresp   = mo_rresp[0];

    assign dma_m_awready  = mo_awready[1];
    assign dma_m_wready   = mo_wready[1];
    assign dma_m_bvalid   = mo_bvalid[1];
    assign dma_m_bresp    = mo_bresp[1];
    assign dma_m_arready  = mo_arready[1];
    assign dma_m_rvalid   = mo_rvalid[1];
    assign dma_m_rdata    = mo_rdata[1];
    assign dma_m_rresp    = mo_rresp[1];

    assign dbg_m_awready  = mo_awready[2];
    assign dbg_m_wready   = mo_wready[2];
    assign dbg_m_bvalid   = mo_bvalid[2];
    assign dbg_m_bresp    = mo_bresp[2];
    assign dbg_m_arready  = mo_arready[2];
    assign dbg_m_rvalid   = mo_rvalid[2];
    assign dbg_m_rdata    = mo_rdata[2];
    assign dbg_m_rresp    = mo_rresp[2];

    // -----------------------------------------------------------------------
    // AW+W hold registers: accept AW and W independently, pair before pipeline
    // -----------------------------------------------------------------------
    logic        aw_held_vld  [0:NUM_MASTERS-1];
    logic [31:0] aw_held_addr [0:NUM_MASTERS-1];
    logic        w_held_vld   [0:NUM_MASTERS-1];
    logic [31:0] w_held_data  [0:NUM_MASTERS-1];
    logic [3:0]  w_held_strb  [0:NUM_MASTERS-1];

    // -----------------------------------------------------------------------
    // Pipeline registers: one stage per master
    // AR channel
    // -----------------------------------------------------------------------
    logic        ar_pip_vld  [0:NUM_MASTERS-1];
    logic [31:0] ar_pip_addr [0:NUM_MASTERS-1];
    logic [2:0]  ar_pip_sel  [0:NUM_MASTERS-1];

    // AW+W channel (paired)
    logic        aw_pip_vld  [0:NUM_MASTERS-1];
    logic [31:0] aw_pip_addr [0:NUM_MASTERS-1];
    logic [31:0] w_pip_data  [0:NUM_MASTERS-1];
    logic [3:0]  w_pip_strb  [0:NUM_MASTERS-1];
    logic [2:0]  aw_pip_sel  [0:NUM_MASTERS-1];

    // -----------------------------------------------------------------------
    // Outstanding transaction tracking FIFOs
    // -----------------------------------------------------------------------
    logic [2:0]       rd_fifo [0:NUM_MASTERS-1][0:MAX_OUTST-1];
    logic [OST_W-1:0] rd_head [0:NUM_MASTERS-1];
    logic [OST_W-1:0] rd_tail [0:NUM_MASTERS-1];
    logic [OST_W-1:0] rd_ost  [0:NUM_MASTERS-1];

    logic [2:0]       wr_fifo [0:NUM_MASTERS-1][0:MAX_OUTST-1];
    logic [OST_W-1:0] wr_head [0:NUM_MASTERS-1];
    logic [OST_W-1:0] wr_tail [0:NUM_MASTERS-1];
    logic [OST_W-1:0] wr_ost  [0:NUM_MASTERS-1];

    // Latched AR address for debug-register read responses
    logic [31:0] rd_dbg_laddr [0:NUM_MASTERS-1];

    // -----------------------------------------------------------------------
    // Watchdog counters
    // -----------------------------------------------------------------------
    logic [WD_W-1:0] rd_wd [0:NUM_MASTERS-1];
    logic [WD_W-1:0] wr_wd [0:NUM_MASTERS-1];

    // -----------------------------------------------------------------------
    // Internal debug / error sticky registers
    // -----------------------------------------------------------------------
    logic [31:0]            dec_err_addr_q;
    logic                   dec_err_vld_q;
    logic [NUM_MASTERS-1:0] timeout_status_q;

    // -----------------------------------------------------------------------
    // Full-flag helpers
    // -----------------------------------------------------------------------
    logic rd_ost_full [0:NUM_MASTERS-1];
    logic wr_ost_full [0:NUM_MASTERS-1];
    always_comb begin
        for (int m = 0; m < NUM_MASTERS; m++) begin
            rd_ost_full[m] = (rd_ost[m] == OST_W'(MAX_OUTST));
            wr_ost_full[m] = (wr_ost[m] == OST_W'(MAX_OUTST));
        end
    end

    // AW/W hold-register accept: allow when hold reg empty and not full
    always_comb begin
        for (int m = 0; m < NUM_MASTERS; m++) begin
            mo_awready[m] = !aw_held_vld[m] && !wr_ost_full[m];
            mo_wready[m]  = !w_held_vld[m]  && !wr_ost_full[m];
        end
    end

    // -----------------------------------------------------------------------
    // Arbitration: strict fixed priority (0 > 1 > 2)
    // Candidate = pipeline slot valid AND outstanding count not full
    // -----------------------------------------------------------------------
    logic rd_cand [0:NUM_MASTERS-1];
    logic wr_cand [0:NUM_MASTERS-1];
    always_comb begin
        for (int m = 0; m < NUM_MASTERS; m++) begin
            rd_cand[m] = ar_pip_vld[m] && !rd_ost_full[m];
            wr_cand[m] = aw_pip_vld[m] && !wr_ost_full[m];
        end
    end

    logic [NUM_MASTERS-1:0] rd_grant;
    logic [NUM_MASTERS-1:0] wr_grant;

    always_comb begin
        rd_grant = '0;
        if      (rd_cand[0]) rd_grant = NUM_MASTERS'(3'b001);
        else if (rd_cand[1]) rd_grant = NUM_MASTERS'(3'b010);
        else if (rd_cand[2]) rd_grant = NUM_MASTERS'(3'b100);
    end

    always_comb begin
        wr_grant = '0;
        if      (wr_cand[0]) wr_grant = NUM_MASTERS'(3'b001);
        else if (wr_cand[1]) wr_grant = NUM_MASTERS'(3'b010);
        else if (wr_cand[2]) wr_grant = NUM_MASTERS'(3'b100);
    end

    assign arb_grant = rd_grant;

    // Grant index (2-bit)
    logic [1:0] rd_gidx;
    logic [1:0] wr_gidx;
    always_comb begin
        rd_gidx = 2'd0;
        if (rd_grant[1]) rd_gidx = 2'd1;
        if (rd_grant[2]) rd_gidx = 2'd2;
    end
    always_comb begin
        wr_gidx = 2'd0;
        if (wr_grant[1]) wr_gidx = 2'd1;
        if (wr_grant[2]) wr_gidx = 2'd2;
    end

    // -----------------------------------------------------------------------
    // Slave AR forward mux
    // -----------------------------------------------------------------------
    logic ar_slv_fire;   // slave accepted the AR this cycle
    logic ar_is_noslv;   // ERR/DBG: no slave port needed

    always_comb begin
        dram_arvalid = 1'b0;
        dram_araddr  = 32'h0;
        intc_arvalid = 1'b0;
        intc_araddr  = 32'h0;
        dma_arvalid  = 1'b0;
        dma_araddr   = 32'h0;
        npu_arvalid  = 1'b0;
        npu_araddr   = 32'h0;
        display_arvalid = 1'b0;
        display_araddr  = 32'h0;
        ar_slv_fire  = 1'b0;
        ar_is_noslv  = 1'b0;

        if (|rd_grant) begin
            unique case (ar_pip_sel[rd_gidx])
                SEL_DRAM: begin
                    dram_arvalid = 1'b1;
                    dram_araddr  = ar_pip_addr[rd_gidx] - DRAM_BASE;
                    ar_slv_fire  = dram_arready;
                end
                SEL_INTC: begin
                    intc_arvalid = 1'b1;
                    intc_araddr  = ar_pip_addr[rd_gidx] - INTC_BASE;
                    ar_slv_fire  = intc_arready;
                end
                SEL_DMA: begin
                    dma_arvalid  = 1'b1;
                    dma_araddr   = ar_pip_addr[rd_gidx] - DMA_BASE;
                    ar_slv_fire  = dma_arready;
                end
                SEL_NPU: begin
                    npu_arvalid  = 1'b1;
                    npu_araddr   = ar_pip_addr[rd_gidx] - NPU_BASE;
                    ar_slv_fire  = npu_arready;
                end
                SEL_DISP: begin
                    display_arvalid = 1'b1;
                    display_araddr  = ar_pip_addr[rd_gidx] - DISP_BASE;
                    ar_slv_fire     = display_arready;
                end
                SEL_ERR, SEL_DBG: ar_is_noslv = 1'b1;
                default: ;
            endcase
        end
    end

    // AR pipeline drain signals
    logic ar_pip_drain [0:NUM_MASTERS-1];
    always_comb begin
        for (int m = 0; m < NUM_MASTERS; m++)
            ar_pip_drain[m] = rd_grant[m] && (ar_slv_fire || ar_is_noslv);
    end

    // arready: accept from master when pipeline slot will be free next cycle
    always_comb begin
        for (int m = 0; m < NUM_MASTERS; m++)
            mo_arready[m] = !rd_ost_full[m] && (!ar_pip_vld[m] || ar_pip_drain[m]);
    end

    // -----------------------------------------------------------------------
    // Slave AW/W forward mux
    // -----------------------------------------------------------------------
    logic aw_slv_fire;
    logic aw_is_noslv;

    always_comb begin
        dram_awvalid = 1'b0;  dram_awaddr = 32'h0;
        dram_wvalid  = 1'b0;  dram_wdata  = 32'h0;  dram_wstrb = 4'h0;
        intc_awvalid = 1'b0;  intc_awaddr = 32'h0;
        intc_wvalid  = 1'b0;  intc_wdata  = 32'h0;  intc_wstrb = 4'h0;
        dma_awvalid  = 1'b0;  dma_awaddr  = 32'h0;
        dma_wvalid   = 1'b0;  dma_wdata   = 32'h0;  dma_wstrb  = 4'h0;
        npu_awvalid  = 1'b0;  npu_awaddr  = 32'h0;
        npu_wvalid   = 1'b0;  npu_wdata   = 32'h0;  npu_wstrb  = 4'h0;
        display_awvalid = 1'b0;  display_awaddr = 32'h0;
        display_wvalid  = 1'b0;  display_wdata  = 32'h0;  display_wstrb = 4'h0;
        aw_slv_fire  = 1'b0;
        aw_is_noslv  = 1'b0;

        if (|wr_grant) begin
            unique case (aw_pip_sel[wr_gidx])
                SEL_DRAM: begin
                    dram_awvalid = 1'b1;
                    dram_awaddr  = aw_pip_addr[wr_gidx] - DRAM_BASE;
                    dram_wvalid  = 1'b1;
                    dram_wdata   = w_pip_data[wr_gidx];
                    dram_wstrb   = w_pip_strb[wr_gidx];
                    aw_slv_fire  = dram_awready && dram_wready;
                end
                SEL_INTC: begin
                    intc_awvalid = 1'b1;
                    intc_awaddr  = aw_pip_addr[wr_gidx] - INTC_BASE;
                    intc_wvalid  = 1'b1;
                    intc_wdata   = w_pip_data[wr_gidx];
                    intc_wstrb   = w_pip_strb[wr_gidx];
                    aw_slv_fire  = intc_awready && intc_wready;
                end
                SEL_DMA: begin
                    dma_awvalid  = 1'b1;
                    dma_awaddr   = aw_pip_addr[wr_gidx] - DMA_BASE;
                    dma_wvalid   = 1'b1;
                    dma_wdata    = w_pip_data[wr_gidx];
                    dma_wstrb    = w_pip_strb[wr_gidx];
                    aw_slv_fire  = dma_awready && dma_wready;
                end
                SEL_NPU: begin
                    npu_awvalid  = 1'b1;
                    npu_awaddr   = aw_pip_addr[wr_gidx] - NPU_BASE;
                    npu_wvalid   = 1'b1;
                    npu_wdata    = w_pip_data[wr_gidx];
                    npu_wstrb    = w_pip_strb[wr_gidx];
                    aw_slv_fire  = npu_awready && npu_wready;
                end
                SEL_DISP: begin
                    display_awvalid = 1'b1;
                    display_awaddr  = aw_pip_addr[wr_gidx] - DISP_BASE;
                    display_wvalid  = 1'b1;
                    display_wdata   = w_pip_data[wr_gidx];
                    display_wstrb   = w_pip_strb[wr_gidx];
                    aw_slv_fire     = display_awready && display_wready;
                end
                SEL_ERR, SEL_DBG: aw_is_noslv = 1'b1;
                default: ;
            endcase
        end
    end

    logic aw_pip_drain [0:NUM_MASTERS-1];
    always_comb begin
        for (int m = 0; m < NUM_MASTERS; m++)
            aw_pip_drain[m] = wr_grant[m] && (aw_slv_fire || aw_is_noslv);
    end

    // -----------------------------------------------------------------------
    // Read response steering back to masters
    // -----------------------------------------------------------------------
    always_comb begin
        dram_rready = 1'b0;
        intc_rready = 1'b0;
        dma_rready  = 1'b0;
        npu_rready  = 1'b0;
        display_rready = 1'b0;
        for (int m = 0; m < NUM_MASTERS; m++) begin
            mo_rvalid[m] = 1'b0;
            mo_rdata[m]  = 32'h0;
            mo_rresp[m]  = RESP_OKAY;
        end

        for (int m = 0; m < NUM_MASTERS; m++) begin
            if (rd_ost[m] > '0) begin
                unique case (rd_fifo[m][rd_head[m][OST_W-2:0]])
                    SEL_DRAM: begin
                        mo_rvalid[m] = dram_rvalid;
                        mo_rdata[m]  = dram_rdata;
                        mo_rresp[m]  = dram_rresp;
                        if (mi_rready[m] && dram_rvalid) dram_rready = 1'b1;
                    end
                    SEL_INTC: begin
                        mo_rvalid[m] = intc_rvalid;
                        mo_rdata[m]  = intc_rdata;
                        mo_rresp[m]  = intc_rresp;
                        if (mi_rready[m] && intc_rvalid) intc_rready = 1'b1;
                    end
                    SEL_DMA: begin
                        mo_rvalid[m] = dma_rvalid;
                        mo_rdata[m]  = dma_rdata;
                        mo_rresp[m]  = dma_rresp;
                        if (mi_rready[m] && dma_rvalid) dma_rready = 1'b1;
                    end
                    SEL_NPU: begin
                        mo_rvalid[m] = npu_rvalid;
                        mo_rdata[m]  = npu_rdata;
                        mo_rresp[m]  = npu_rresp;
                        if (mi_rready[m] && npu_rvalid) npu_rready = 1'b1;
                    end
                    SEL_DISP: begin
                        mo_rvalid[m] = display_rvalid;
                        mo_rdata[m]  = display_rdata;
                        mo_rresp[m]  = display_rresp;
                        if (mi_rready[m] && display_rvalid) display_rready = 1'b1;
                    end
                    SEL_ERR: begin
                        mo_rvalid[m] = 1'b1;
                        mo_rdata[m]  = 32'hDEAD_BEEF;
                        mo_rresp[m]  = RESP_SLVERR;
                    end
                    SEL_DBG: begin
                        mo_rvalid[m] = 1'b1;
                        mo_rresp[m]  = RESP_OKAY;
                        if (rd_dbg_laddr[m] == DBG_DECODE_ERR_ADDR)
                            mo_rdata[m] = dec_err_vld_q ? dec_err_addr_q : 32'h0;
                        else
                            mo_rdata[m] = 32'(timeout_status_q);
                    end
                    default: ;
                endcase
            end
        end
    end

    // -----------------------------------------------------------------------
    // Write response steering back to masters
    // -----------------------------------------------------------------------
    always_comb begin
        dram_bready = 1'b0;
        intc_bready = 1'b0;
        dma_bready  = 1'b0;
        npu_bready  = 1'b0;
        display_bready = 1'b0;
        for (int m = 0; m < NUM_MASTERS; m++) begin
            mo_bvalid[m] = 1'b0;
            mo_bresp[m]  = RESP_OKAY;
        end

        for (int m = 0; m < NUM_MASTERS; m++) begin
            if (wr_ost[m] > '0) begin
                unique case (wr_fifo[m][wr_head[m][OST_W-2:0]])
                    SEL_DRAM: begin
                        mo_bvalid[m] = dram_bvalid;
                        mo_bresp[m]  = dram_bresp;
                        if (mi_bready[m] && dram_bvalid) dram_bready = 1'b1;
                    end
                    SEL_INTC: begin
                        mo_bvalid[m] = intc_bvalid;
                        mo_bresp[m]  = intc_bresp;
                        if (mi_bready[m] && intc_bvalid) intc_bready = 1'b1;
                    end
                    SEL_DMA: begin
                        mo_bvalid[m] = dma_bvalid;
                        mo_bresp[m]  = dma_bresp;
                        if (mi_bready[m] && dma_bvalid) dma_bready = 1'b1;
                    end
                    SEL_NPU: begin
                        mo_bvalid[m] = npu_bvalid;
                        mo_bresp[m]  = npu_bresp;
                        if (mi_bready[m] && npu_bvalid) npu_bready = 1'b1;
                    end
                    SEL_DISP: begin
                        mo_bvalid[m] = display_bvalid;
                        mo_bresp[m]  = display_bresp;
                        if (mi_bready[m] && display_bvalid) display_bready = 1'b1;
                    end
                    SEL_ERR, SEL_DBG: begin
                        mo_bvalid[m] = 1'b1;
                        mo_bresp[m]  = RESP_SLVERR;
                    end
                    default: ;
                endcase
            end
        end
    end

    // -----------------------------------------------------------------------
    // Sequential logic
    // -----------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int m = 0; m < NUM_MASTERS; m++) begin
                aw_held_vld[m]   <= 1'b0;
                aw_held_addr[m]  <= 32'h0;
                w_held_vld[m]    <= 1'b0;
                w_held_data[m]   <= 32'h0;
                w_held_strb[m]   <= 4'h0;
                ar_pip_vld[m]    <= 1'b0;
                ar_pip_addr[m]   <= 32'h0;
                ar_pip_sel[m]    <= SEL_NONE;
                aw_pip_vld[m]    <= 1'b0;
                aw_pip_addr[m]   <= 32'h0;
                w_pip_data[m]    <= 32'h0;
                w_pip_strb[m]    <= 4'h0;
                aw_pip_sel[m]    <= SEL_NONE;
                rd_head[m]       <= '0;
                rd_tail[m]       <= '0;
                rd_ost[m]        <= '0;
                wr_head[m]       <= '0;
                wr_tail[m]       <= '0;
                wr_ost[m]        <= '0;
                rd_dbg_laddr[m]  <= 32'h0;
                rd_wd[m]         <= '0;
                wr_wd[m]         <= '0;
                for (int d = 0; d < MAX_OUTST; d++) begin
                    rd_fifo[m][d] <= SEL_NONE;
                    wr_fifo[m][d] <= SEL_NONE;
                end
            end
            dec_err_addr_q   <= 32'h0;
            dec_err_vld_q    <= 1'b0;
            timeout_status_q <= '0;
            timeout_irq      <= '0;
        end else begin
            timeout_irq <= '0;  // deassert by default; set below on timeout

            for (int m = 0; m < NUM_MASTERS; m++) begin
                // ----------------------------------------------------------
                // AW/W hold register accept
                // ----------------------------------------------------------
                if (mo_awready[m] && mi_awvalid[m]) begin
                    aw_held_vld[m]  <= 1'b1;
                    aw_held_addr[m] <= mi_awaddr[m];
                end
                if (mo_wready[m] && mi_wvalid[m]) begin
                    w_held_vld[m]  <= 1'b1;
                    w_held_data[m] <= mi_wdata[m];
                    w_held_strb[m] <= mi_wstrb[m];
                end

                // ----------------------------------------------------------
                // AR pipeline push
                // ----------------------------------------------------------
                if (mo_arready[m] && mi_arvalid[m]) begin
                    ar_pip_vld[m]   <= 1'b1;
                    ar_pip_addr[m]  <= mi_araddr[m];
                    ar_pip_sel[m]   <= decode_addr(mi_araddr[m]);
                    rd_dbg_laddr[m] <= mi_araddr[m];
                end else if (ar_pip_drain[m]) begin
                    ar_pip_vld[m] <= 1'b0;
                end

                // ----------------------------------------------------------
                // AR pipeline drain: enqueue into rd_fifo, bump outstanding
                // ----------------------------------------------------------
                if (ar_pip_drain[m]) begin
                    rd_fifo[m][rd_tail[m][OST_W-2:0]] <= ar_pip_sel[m];
                    rd_tail[m] <= rd_tail[m] + 1'b1;
                    rd_ost[m]  <= rd_ost[m] + 1'b1;
                    if (ar_pip_sel[m] == SEL_ERR) begin
                        dec_err_addr_q <= ar_pip_addr[m];
                        dec_err_vld_q  <= 1'b1;
                    end
                end

                // ----------------------------------------------------------
                // AW pipeline push (requires both AW and W to be held)
                // ----------------------------------------------------------
                if (aw_held_vld[m] && w_held_vld[m] &&
                    (!aw_pip_vld[m] || aw_pip_drain[m])) begin
                    aw_pip_vld[m]  <= 1'b1;
                    aw_pip_addr[m] <= aw_held_addr[m];
                    w_pip_data[m]  <= w_held_data[m];
                    w_pip_strb[m]  <= w_held_strb[m];
                    aw_pip_sel[m]  <= decode_addr(aw_held_addr[m]);
                    aw_held_vld[m] <= 1'b0;
                    w_held_vld[m]  <= 1'b0;
                end else if (aw_pip_drain[m]) begin
                    aw_pip_vld[m] <= 1'b0;
                end

                // ----------------------------------------------------------
                // AW pipeline drain: enqueue into wr_fifo, bump outstanding
                // ----------------------------------------------------------
                if (aw_pip_drain[m]) begin
                    wr_fifo[m][wr_tail[m][OST_W-2:0]] <= aw_pip_sel[m];
                    wr_tail[m] <= wr_tail[m] + 1'b1;
                    wr_ost[m]  <= wr_ost[m] + 1'b1;
                    if (aw_pip_sel[m] == SEL_ERR) begin
                        dec_err_addr_q <= aw_pip_addr[m];
                        dec_err_vld_q  <= 1'b1;
                    end
                end

                // ----------------------------------------------------------
                // Read response consumed
                // ----------------------------------------------------------
                if (mo_rvalid[m] && mi_rready[m]) begin
                    rd_head[m] <= rd_head[m] + 1'b1;
                    rd_ost[m]  <= rd_ost[m] - 1'b1;
                    rd_wd[m]   <= '0;
                    timeout_status_q[m] <= 1'b0;
                end

                // ----------------------------------------------------------
                // Write response consumed
                // ----------------------------------------------------------
                if (mo_bvalid[m] && mi_bready[m]) begin
                    wr_head[m] <= wr_head[m] + 1'b1;
                    wr_ost[m]  <= wr_ost[m] - 1'b1;
                    wr_wd[m]   <= '0;
                    timeout_status_q[m] <= 1'b0;
                end

                // ----------------------------------------------------------
                // Watchdog: increment while outstanding; fire at limit
                // ----------------------------------------------------------
                if (rd_ost[m] > '0) begin
                    if (rd_wd[m] < WD_W'(WD_LIMIT)) begin
                        rd_wd[m] <= rd_wd[m] + 1'b1;
                    end else begin
                        timeout_irq[m]      <= 1'b1;
                        timeout_status_q[m] <= 1'b1;
                        rd_fifo[m][rd_head[m][OST_W-2:0]] <= SEL_ERR;
                    end
                end else begin
                    rd_wd[m] <= '0;
                end

                if (wr_ost[m] > '0) begin
                    if (wr_wd[m] < WD_W'(WD_LIMIT)) begin
                        wr_wd[m] <= wr_wd[m] + 1'b1;
                    end else begin
                        timeout_irq[m]      <= 1'b1;
                        timeout_status_q[m] <= 1'b1;
                        wr_fifo[m][wr_head[m][OST_W-2:0]] <= SEL_ERR;
                    end
                end else begin
                    wr_wd[m] <= '0;
                end

            end  // for m
        end  // else
    end  // always_ff

endmodule
