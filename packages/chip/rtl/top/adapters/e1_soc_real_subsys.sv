`timescale 1ns/1ps

// e1_soc_real_subsys
//
// SoC-integration adapter that drops the production interrupt + main-memory
// blocks behind the e1_soc_top 32-bit MMIO debug aperture so the standalone,
// cocotb-verified leaves compose into a bootable-class interrupt+memory
// subsystem without re-architecting the v0 bus.
//
// Real blocks instantiated here (each verified standalone under verify/cocotb):
//   * e1_clint  (rtl/interrupts/e1_clint.sv)  — RISC-V CLINT, 32-bit AXI-Lite,
//                spec map @ 0x0200_0000, drives mip.MSIP / mip.MTIP.
//   * e1_plic   (rtl/interrupts/e1_plic.sv)   — RISC-V PLIC v1.0.0, 32-bit
//                AXI-Lite, spec map @ 0x0C00_0000, claim/complete -> mip.MEIP.
//   * e1_dram_ctrl (rtl/memory/dram_ctrl/e1_dram_ctrl.sv) — full AXI4 main
//                memory controller, 2 GiB @ 0x8000_0000.
//
// The single 32-bit MMIO debug master (mmio_*) that e1_soc_top already drives
// is bridged to these slaves by combinational, single-outstanding AXI-Lite /
// AXI4 request shims. Each MMIO access is one word: a 4-byte AXI-Lite
// transfer for CLINT/PLIC, or a single-beat (AWLEN=0, SIZE=4B) AXI4 transfer
// for the DRAM controller, with the 32-bit MMIO lane placed on / extracted
// from the controller's 128-bit data bus by the word's address bits [3:2].
//
// The shims block the MMIO bus (the consuming top reads dram_ready/irq_ready
// only after the transfer drains) so each leaf's real ready/valid handshake is
// exercised end to end. This is deliberately one outstanding transaction at a
// time: the v0 MMIO aperture is itself single-outstanding, so there is no
// pipelining to preserve, and a single FSM keeps the path observable.
//
// Outputs msip_o / mtip_o / meip_o feed the CPU's ipi_i / time_irq_i / irq_i.

module e1_soc_real_subsys
    import e1_axi4_pkg::*;
#(
    parameter int unsigned NUM_HARTS        = 1,
    parameter int unsigned PLIC_NUM_SOURCES = 4,
    parameter int unsigned DRAM_ID_W        = 6,
    parameter int unsigned DRAM_ADDR_W      = 40,
    parameter int unsigned DRAM_DATA_W      = 128
) (
    input  logic        clk,
    input  logic        rst_n,

    // ---- MMIO debug-aperture request from e1_soc_top -------------------
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,

    // Region selects (decoded in the top: CLINT RTL, PLIC RTL, DRAM RTL path).
    input  logic        clint_sel,
    input  logic        plic_sel,
    input  logic        dram_sel,

    // ---- Read data back to the top's MMIO mux --------------------------
    output logic [31:0] clint_rdata,
    output logic [31:0] plic_rdata,
    output logic [31:0] dram_rdata,

    // High for one MMIO access once the selected real region's shim has
    // drained the AXI(-Lite) transfer (B for a write, R for a read). The top
    // gates mmio_ready on this so a multi-cycle real-region access holds the
    // single-outstanding MMIO bus until the real handshake completes.
    output logic        mmio_ready_o,

    // ---- Interrupt outputs to the CPU ----------------------------------
    output logic [NUM_HARTS-1:0] msip_o,   // -> ipi_i (mip.MSIP)
    output logic [NUM_HARTS-1:0] mtip_o,   // -> time_irq_i (mip.MTIP)
    output logic [NUM_HARTS-1:0] meip_o,   // -> irq_i[1] (mip.MEIP)
    output logic [63:0]          mtime_o,

    // Level-sensitive external interrupt source lines into the PLIC gateway
    // (index 0 == PLIC source id 1). In e1_soc_top these are wired from the
    // peripheral IRQs (timer/dma/npu/vsync) so a device IRQ round-trips
    // through a real claim/complete.
    input  logic [PLIC_NUM_SOURCES-1:0] plic_sources,

    // ---- Discoverable main-memory geometry (boot enumeration) ----------
    output logic [63:0] mem_base_addr,
    output logic [63:0] mem_capacity_bytes
);
    localparam int unsigned DRAM_STRB_W = DRAM_DATA_W/8;

    // Per-shim done strobes (1 cycle, when the transfer drains).
    logic clint_done, plic_done, dram_done;
    assign mmio_ready_o = (clint_sel & clint_done) |
                          (plic_sel  & plic_done)  |
                          (dram_sel  & dram_done);

    // ====================================================================
    // CLINT + PLIC share one tiny AXI-Lite request shim each. The shim is a
    // 4-state FSM: drive AW+W (or AR), wait for the slave's B (or R), latch
    // read data. mmio_valid is held by the top until the FSM reports the
    // word is done (ldone), so the MMIO aperture sees a single-cycle-visible
    // result exactly as the bring-up path does.
    // ====================================================================

    // ---- CLINT AXI-Lite slave nets -------------------------------------
    logic        clint_awvalid, clint_awready;
    logic [31:0] clint_awaddr;
    logic        clint_wvalid,  clint_wready;
    logic [31:0] clint_wdata;
    logic [3:0]  clint_wstrb;
    logic        clint_bvalid,  clint_bready;
    logic [1:0]  clint_bresp;
    logic        clint_arvalid, clint_arready;
    logic [31:0] clint_araddr;
    logic        clint_rvalid,  clint_rready;
    logic [31:0] clint_rdata_w;
    logic [1:0]  clint_rresp;

    e1_clint #(.NUM_HARTS(NUM_HARTS)) u_clint_real (
        .clk            (clk),
        .rst_n          (rst_n),
        .msip_o         (msip_o),
        .mtip_o         (mtip_o),
        .mtime_o        (mtime_o),
        .s_axil_awvalid (clint_awvalid),
        .s_axil_awready (clint_awready),
        .s_axil_awaddr  (clint_awaddr),
        .s_axil_wvalid  (clint_wvalid),
        .s_axil_wready  (clint_wready),
        .s_axil_wdata   (clint_wdata),
        .s_axil_wstrb   (clint_wstrb),
        .s_axil_bvalid  (clint_bvalid),
        .s_axil_bready  (clint_bready),
        .s_axil_bresp   (clint_bresp),
        .s_axil_arvalid (clint_arvalid),
        .s_axil_arready (clint_arready),
        .s_axil_araddr  (clint_araddr),
        .s_axil_rvalid  (clint_rvalid),
        .s_axil_rready  (clint_rready),
        .s_axil_rdata   (clint_rdata_w),
        .s_axil_rresp   (clint_rresp)
    );

    // ---- PLIC AXI-Lite slave nets --------------------------------------
    logic        plic_awvalid, plic_awready;
    logic [31:0] plic_awaddr;
    logic        plic_wvalid,  plic_wready;
    logic [31:0] plic_wdata;
    logic [3:0]  plic_wstrb;
    logic        plic_bvalid,  plic_bready;
    logic [1:0]  plic_bresp;
    logic        plic_arvalid, plic_arready;
    logic [31:0] plic_araddr;
    logic        plic_rvalid,  plic_rready;
    logic [31:0] plic_rdata_w;
    logic [1:0]  plic_rresp;

    e1_plic #(
        .NUM_SOURCES  (PLIC_NUM_SOURCES),
        .NUM_CONTEXTS (NUM_HARTS)
    ) u_plic_real (
        .clk            (clk),
        .rst_n          (rst_n),
        .irq_sources    (plic_sources),
        .irq_o          (meip_o),
        .s_axil_awvalid (plic_awvalid),
        .s_axil_awready (plic_awready),
        .s_axil_awaddr  (plic_awaddr),
        .s_axil_wvalid  (plic_wvalid),
        .s_axil_wready  (plic_wready),
        .s_axil_wdata   (plic_wdata),
        .s_axil_wstrb   (plic_wstrb),
        .s_axil_bvalid  (plic_bvalid),
        .s_axil_bready  (plic_bready),
        .s_axil_bresp   (plic_bresp),
        .s_axil_arvalid (plic_arvalid),
        .s_axil_arready (plic_arready),
        .s_axil_araddr  (plic_araddr),
        .s_axil_rvalid  (plic_rvalid),
        .s_axil_rready  (plic_rready),
        .s_axil_rdata   (plic_rdata_w),
        .s_axil_rresp   (plic_rresp)
    );

    // ---- Generic single-outstanding AXI-Lite request shim --------------
    // One instance per AXI-Lite slave (CLINT, PLIC). The shim is fed by the
    // top's MMIO request when its `sel` is high; it sequences one read or
    // write and presents the read data on `rdata` (held until the next
    // access). The address handed to the slave is the window-relative byte
    // offset (mmio_addr low bits — both leaves mask their own window).

    // CLINT shim
    e1_axil_mmio_shim u_clint_shim (
        .clk        (clk),
        .rst_n      (rst_n),
        .sel        (clint_sel),
        .mmio_valid (mmio_valid),
        .mmio_write (mmio_write),
        .mmio_addr  (mmio_addr),
        .mmio_wdata (mmio_wdata),
        .rdata      (clint_rdata),
        .done       (clint_done),
        .s_awvalid  (clint_awvalid),
        .s_awready  (clint_awready),
        .s_awaddr   (clint_awaddr),
        .s_wvalid   (clint_wvalid),
        .s_wready   (clint_wready),
        .s_wdata    (clint_wdata),
        .s_wstrb    (clint_wstrb),
        .s_bvalid   (clint_bvalid),
        .s_bready   (clint_bready),
        .s_bresp    (clint_bresp),
        .s_arvalid  (clint_arvalid),
        .s_arready  (clint_arready),
        .s_araddr   (clint_araddr),
        .s_rvalid   (clint_rvalid),
        .s_rready   (clint_rready),
        .s_rdata    (clint_rdata_w),
        .s_rresp    (clint_rresp)
    );

    // PLIC shim
    e1_axil_mmio_shim u_plic_shim (
        .clk        (clk),
        .rst_n      (rst_n),
        .sel        (plic_sel),
        .mmio_valid (mmio_valid),
        .mmio_write (mmio_write),
        .mmio_addr  (mmio_addr),
        .mmio_wdata (mmio_wdata),
        .rdata      (plic_rdata),
        .done       (plic_done),
        .s_awvalid  (plic_awvalid),
        .s_awready  (plic_awready),
        .s_awaddr   (plic_awaddr),
        .s_wvalid   (plic_wvalid),
        .s_wready   (plic_wready),
        .s_wdata    (plic_wdata),
        .s_wstrb    (plic_wstrb),
        .s_bvalid   (plic_bvalid),
        .s_bready   (plic_bready),
        .s_bresp    (plic_bresp),
        .s_arvalid  (plic_arvalid),
        .s_arready  (plic_arready),
        .s_araddr   (plic_araddr),
        .s_rvalid   (plic_rvalid),
        .s_rready   (plic_rready),
        .s_rdata    (plic_rdata_w),
        .s_rresp    (plic_rresp)
    );

    // ====================================================================
    // AXI4 DRAM-controller RTL model. The MMIO word access is bridged to a single
    // AXI4 beat (AWLEN/ARLEN=0, SIZE=4B) by e1_axi4_mmio_shim, which selects
    // the 32-bit lane within the 128-bit data bus from mmio_addr[3:2].
    // ====================================================================
    logic                    d_awvalid, d_awready;
    logic [DRAM_ID_W-1:0]    d_awid;
    logic [DRAM_ADDR_W-1:0]  d_awaddr;
    logic [7:0]              d_awlen;
    logic [2:0]              d_awsize;
    logic [1:0]              d_awburst;
    logic                    d_wvalid,  d_wready;
    logic [DRAM_DATA_W-1:0]  d_wdata;
    logic [DRAM_STRB_W-1:0]  d_wstrb;
    logic                    d_wlast;
    logic                    d_bvalid,  d_bready;
    logic [DRAM_ID_W-1:0]    d_bid;
    logic [1:0]              d_bresp;
    logic                    d_arvalid, d_arready;
    logic [DRAM_ID_W-1:0]    d_arid;
    logic [DRAM_ADDR_W-1:0]  d_araddr;
    logic [7:0]              d_arlen;
    logic [2:0]              d_arsize;
    logic [1:0]              d_arburst;
    logic                    d_rvalid,  d_rready;
    logic [DRAM_ID_W-1:0]    d_rid;
    logic [DRAM_DATA_W-1:0]  d_rdata;
    logic [1:0]              d_rresp;
    logic                    d_rlast;

    e1_axi4_mmio_shim #(
        .ID_W   (DRAM_ID_W),
        .ADDR_W (DRAM_ADDR_W),
        .DATA_W (DRAM_DATA_W)
    ) u_dram_shim (
        .clk        (clk),
        .rst_n      (rst_n),
        .sel        (dram_sel),
        .mmio_valid (mmio_valid),
        .mmio_write (mmio_write),
        .mmio_addr  (mmio_addr),
        .mmio_wdata (mmio_wdata),
        .rdata      (dram_rdata),
        .done       (dram_done),
        .m_awvalid  (d_awvalid),
        .m_awready  (d_awready),
        .m_awid     (d_awid),
        .m_awaddr   (d_awaddr),
        .m_awlen    (d_awlen),
        .m_awsize   (d_awsize),
        .m_awburst  (d_awburst),
        .m_wvalid   (d_wvalid),
        .m_wready   (d_wready),
        .m_wdata    (d_wdata),
        .m_wstrb    (d_wstrb),
        .m_wlast    (d_wlast),
        .m_bvalid   (d_bvalid),
        .m_bready   (d_bready),
        .m_bid      (d_bid),
        .m_bresp    (d_bresp),
        .m_arvalid  (d_arvalid),
        .m_arready  (d_arready),
        .m_arid     (d_arid),
        .m_araddr   (d_araddr),
        .m_arlen    (d_arlen),
        .m_arsize   (d_arsize),
        .m_arburst  (d_arburst),
        .m_rvalid   (d_rvalid),
        .m_rready   (d_rready),
        .m_rid      (d_rid),
        .m_rdata    (d_rdata),
        .m_rresp    (d_rresp),
        .m_rlast    (d_rlast)
    );

    // DFI south boundary + observability are not consumed at this top; tie
    // the controller's PHY inputs to a benign always-ready / never-error
    // value and absorb its outputs.
    /* verilator lint_off UNUSEDSIGNAL */
    logic [DRAM_ADDR_W-1:0] dfi_addr;
    logic [3:0]             dfi_bank;
    logic                   dfi_cs_n, dfi_act_n, dfi_ras_n, dfi_cas_n, dfi_we_n;
    logic                   dfi_reset_n, dfi_cke, dfi_odt;
    logic [DRAM_DATA_W-1:0] dfi_wrdata;
    logic [DRAM_STRB_W-1:0] dfi_wrdata_mask;
    logic                   dfi_wrdata_en, dfi_rddata_en;
    logic                   dfi_init_start, dfi_ctrlupd_req, dfi_dram_clk_disable;
    logic                   refresh_active, zqcs_active, zqcl_active;
    logic [31:0]            odecc_corrected_count, odecc_uncorrected_count;
    logic [31:0]            linkecc_corrected_count, linkecc_uncorrected_count;
    logic                   ecc_uncorrected_irq;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_dram_ctrl #(
        .ID_WIDTH   (DRAM_ID_W),
        .ADDR_WIDTH (DRAM_ADDR_W),
        .DATA_WIDTH (DRAM_DATA_W)
    ) u_dram_real (
        .clk        (clk),
        .rst_n      (rst_n),
        .s_awvalid  (d_awvalid),
        .s_awready  (d_awready),
        .s_awid     (d_awid),
        .s_awaddr   (d_awaddr),
        .s_awlen    (d_awlen),
        .s_awsize   (d_awsize),
        .s_awburst  (d_awburst),
        .s_awlock   (1'b0),
        .s_awcache  (4'h0),
        .s_awprot   (3'h0),
        .s_awqos    (4'h0),
        .s_awuser   (8'h0),
        .s_wvalid   (d_wvalid),
        .s_wready   (d_wready),
        .s_wdata    (d_wdata),
        .s_wstrb    (d_wstrb),
        .s_wlast    (d_wlast),
        .s_bvalid   (d_bvalid),
        .s_bready   (d_bready),
        .s_bid      (d_bid),
        .s_bresp    (d_bresp),
        .s_arvalid  (d_arvalid),
        .s_arready  (d_arready),
        .s_arid     (d_arid),
        .s_araddr   (d_araddr),
        .s_arlen    (d_arlen),
        .s_arsize   (d_arsize),
        .s_arburst  (d_arburst),
        .s_arlock   (1'b0),
        .s_arcache  (4'h0),
        .s_arprot   (3'h0),
        .s_arqos    (4'h0),
        .s_aruser   (8'h0),
        .s_rvalid   (d_rvalid),
        .s_rready   (d_rready),
        .s_rid      (d_rid),
        .s_rdata    (d_rdata),
        .s_rresp    (d_rresp),
        .s_rlast    (d_rlast),
        .mem_base_addr      (mem_base_addr),
        .mem_capacity_bytes (mem_capacity_bytes),
        .dfi_addr             (dfi_addr),
        .dfi_bank             (dfi_bank),
        .dfi_cs_n             (dfi_cs_n),
        .dfi_act_n            (dfi_act_n),
        .dfi_ras_n            (dfi_ras_n),
        .dfi_cas_n            (dfi_cas_n),
        .dfi_we_n             (dfi_we_n),
        .dfi_reset_n          (dfi_reset_n),
        .dfi_cke              (dfi_cke),
        .dfi_odt              (dfi_odt),
        .dfi_wrdata           (dfi_wrdata),
        .dfi_wrdata_mask      (dfi_wrdata_mask),
        .dfi_wrdata_en        (dfi_wrdata_en),
        .dfi_rddata           ('0),
        .dfi_rddata_valid     (1'b0),
        .dfi_rddata_en        (dfi_rddata_en),
        .dfi_init_start       (dfi_init_start),
        .dfi_init_complete    (1'b1),
        .dfi_ctrlupd_req      (dfi_ctrlupd_req),
        .dfi_ctrlupd_ack      (1'b1),
        .dfi_dram_clk_disable (dfi_dram_clk_disable),
        .refresh_active            (refresh_active),
        .zqcs_active               (zqcs_active),
        .zqcl_active               (zqcl_active),
        .odecc_corrected_count     (odecc_corrected_count),
        .odecc_uncorrected_count   (odecc_uncorrected_count),
        .linkecc_corrected_count   (linkecc_corrected_count),
        .linkecc_uncorrected_count (linkecc_uncorrected_count),
        .ecc_uncorrected_irq       (ecc_uncorrected_irq)
    );

endmodule : e1_soc_real_subsys

// ----------------------------------------------------------------------
// e1_axil_mmio_shim
//
// One-word MMIO -> 32-bit AXI-Lite request bridge, single outstanding. The
// MMIO master holds mmio_valid for the duration; this shim sequences AW+W
// (write) or AR (read) and latches the read data. The byte address handed to
// the slave is the low 16 bits of mmio_addr (each leaf masks its own window).
// ----------------------------------------------------------------------
module e1_axil_mmio_shim (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        sel,
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    output logic [31:0] rdata,
    output logic        done,

    output logic        s_awvalid,
    input  logic        s_awready,
    output logic [31:0] s_awaddr,
    output logic        s_wvalid,
    input  logic        s_wready,
    output logic [31:0] s_wdata,
    output logic [3:0]  s_wstrb,
    input  logic        s_bvalid,
    output logic        s_bready,
    input  logic [1:0]  s_bresp,
    output logic        s_arvalid,
    input  logic        s_arready,
    output logic [31:0] s_araddr,
    input  logic        s_rvalid,
    output logic        s_rready,
    input  logic [31:0] s_rdata,
    input  logic [1:0]  s_rresp
);
    typedef enum logic [2:0] {
        S_IDLE, S_AW, S_W, S_B, S_AR, S_R, S_DONE
    } st_e;
    st_e st;

    logic        active;       // a transfer is in flight for the current MMIO
    logic        served;       // current MMIO access already serviced
    // 26-bit window-relative byte address: covers the CLINT 64 KiB map and the
    // PLIC 64 MiB map (claim/complete sits at offset 0x20_0004).
    logic [25:0] addr_q;

    // Edge-detect a fresh MMIO access while `sel` is high. The top deasserts
    // mmio_valid between accesses, so served clears when valid drops.
    wire start = sel && mmio_valid && !served && (st == S_IDLE);

    assign s_awaddr  = {6'h0, addr_q};
    assign s_araddr  = {6'h0, addr_q};
    assign s_wstrb   = 4'hF;
    assign s_awvalid = (st == S_AW);
    assign s_wvalid  = (st == S_W) || (st == S_AW);
    assign s_arvalid = (st == S_AR);
    assign s_bready  = 1'b1;
    assign s_rready  = 1'b1;
    assign s_wdata   = mmio_wdata;
    assign done      = served;

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    assign unused = ^{s_bresp, s_rresp, mmio_addr[31:26], active};
    /* verilator lint_on UNUSEDSIGNAL */

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st     <= S_IDLE;
            active <= 1'b0;
            served <= 1'b0;
            addr_q <= 26'h0;
            rdata  <= 32'h0;
        end else begin
            if (!mmio_valid || !sel) served <= 1'b0;
            unique case (st)
                S_IDLE: begin
                    if (start) begin
                        addr_q <= mmio_addr[25:0];
                        active <= 1'b1;
                        st     <= mmio_write ? S_AW : S_AR;
                    end
                end
                S_AW: begin
                    // Present AW and W together; advance each as it is accepted.
                    if (s_awready && s_wready) st <= S_B;
                    else if (s_awready)        st <= S_W;
                end
                S_W: begin
                    if (s_wready) st <= S_B;
                end
                S_B: begin
                    if (s_bvalid) begin
                        st     <= S_DONE;
                        active <= 1'b0;
                    end
                end
                S_AR: begin
                    if (s_arready) st <= S_R;
                end
                S_R: begin
                    if (s_rvalid) begin
                        rdata  <= s_rdata;
                        st     <= S_DONE;
                        active <= 1'b0;
                    end
                end
                S_DONE: begin
                    served <= 1'b1;
                    st     <= S_IDLE;
                end
                default: st <= S_IDLE;
            endcase
        end
    end
endmodule : e1_axil_mmio_shim

// ----------------------------------------------------------------------
// e1_axi4_mmio_shim
//
// One-word MMIO -> single-beat AXI4 request bridge for the DRAM controller.
// Each MMIO access becomes one AXI4 beat (AWLEN/ARLEN=0, SIZE=4B, INCR). The
// 32-bit MMIO lane is placed on / extracted from the 128-bit AXI4 data bus by
// the word offset mmio_addr[3:2]; WSTRB enables only that lane. The full
// physical address handed to the controller is the configured DRAM base
// (0x8000_0000) + the window word offset, so the controller's in-range check
// and discoverable-capacity contract are exercised at the true address.
// ----------------------------------------------------------------------
module e1_axi4_mmio_shim
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_W   = 6,
    parameter int unsigned ADDR_W = 40,
    parameter int unsigned DATA_W = 128
) (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        sel,
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    output logic [31:0] rdata,
    output logic        done,

    output logic              m_awvalid,
    input  logic              m_awready,
    output logic [ID_W-1:0]   m_awid,
    output logic [ADDR_W-1:0] m_awaddr,
    output logic [7:0]        m_awlen,
    output logic [2:0]        m_awsize,
    output logic [1:0]        m_awburst,
    output logic              m_wvalid,
    input  logic              m_wready,
    output logic [DATA_W-1:0] m_wdata,
    output logic [DATA_W/8-1:0] m_wstrb,
    output logic              m_wlast,
    input  logic              m_bvalid,
    output logic              m_bready,
    input  logic [ID_W-1:0]   m_bid,
    input  logic [1:0]        m_bresp,
    output logic              m_arvalid,
    input  logic              m_arready,
    output logic [ID_W-1:0]   m_arid,
    output logic [ADDR_W-1:0] m_araddr,
    output logic [7:0]        m_arlen,
    output logic [2:0]        m_arsize,
    output logic [1:0]        m_arburst,
    input  logic              m_rvalid,
    output logic              m_rready,
    input  logic [ID_W-1:0]   m_rid,
    input  logic [DATA_W-1:0] m_rdata,
    input  logic [1:0]        m_rresp,
    input  logic              m_rlast
);
    // The DRAM controller's discoverable base; the MMIO window only carries
    // the low offset bits, so reconstruct the full PA at the controller base.
    localparam logic [ADDR_W-1:0] DRAM_BASE = ADDR_W'(64'h0000_0000_8000_0000);
    localparam int unsigned LANE_LSB = $clog2(DATA_W/8); // 4 for 128-bit bus

    typedef enum logic [2:0] {
        S_IDLE, S_AW, S_W, S_B, S_AR, S_R, S_DONE
    } st_e;
    st_e st;

    logic        served;
    logic [ADDR_W-1:0] addr_q;     // full physical address
    logic [LANE_LSB-1:2] lane_q;   // 32-bit lane index within the beat

    wire start = sel && mmio_valid && !served && (st == S_IDLE);

    // Full PA = base + the window word offset (mmio_addr low 12 bits hold the
    // 0x8000_0xxx window's word index; keep them as the offset).
    wire [ADDR_W-1:0] full_addr = DRAM_BASE | ADDR_W'(mmio_addr[11:0]);

    assign m_awid    = '0;
    assign m_arid    = '0;
    assign m_awaddr  = addr_q;
    assign m_araddr  = addr_q;
    assign m_awlen   = 8'd0;
    assign m_arlen   = 8'd0;
    assign m_awsize  = SIZE_4B;
    assign m_arsize  = SIZE_4B;
    assign m_awburst = BURST_INCR;
    assign m_arburst = BURST_INCR;
    assign m_wlast   = 1'b1;
    assign m_awvalid = (st == S_AW);
    assign m_wvalid  = (st == S_W) || (st == S_AW);
    assign m_arvalid = (st == S_AR);
    assign m_bready  = 1'b1;
    assign m_rready  = 1'b1;
    assign done      = served;

    // Place the 32-bit lane on the wide bus; strobe only that lane.
    always_comb begin
        m_wdata = '0;
        m_wstrb = '0;
        m_wdata[{lane_q, 5'b0} +: 32] = mmio_wdata;
        m_wstrb[{lane_q, 2'b0} +: 4]  = 4'hF;
    end

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    assign unused = ^{m_bid, m_bresp, m_rid, m_rresp, m_rlast,
                      mmio_addr[31:12]};
    /* verilator lint_on UNUSEDSIGNAL */

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st     <= S_IDLE;
            served <= 1'b0;
            addr_q <= '0;
            lane_q <= '0;
            rdata  <= 32'h0;
        end else begin
            if (!mmio_valid || !sel) served <= 1'b0;
            unique case (st)
                S_IDLE: begin
                    if (start) begin
                        addr_q <= full_addr;
                        lane_q <= mmio_addr[LANE_LSB-1:2];
                        st     <= mmio_write ? S_AW : S_AR;
                    end
                end
                S_AW: begin
                    if (m_awready && m_wready) st <= S_B;
                    else if (m_awready)        st <= S_W;
                end
                S_W: begin
                    if (m_wready) st <= S_B;
                end
                S_B: begin
                    if (m_bvalid) st <= S_DONE;
                end
                S_AR: begin
                    if (m_arready) st <= S_R;
                end
                S_R: begin
                    if (m_rvalid) begin
                        rdata <= m_rdata[{lane_q, 5'b0} +: 32];
                        st    <= S_DONE;
                    end
                end
                S_DONE: begin
                    served <= 1'b1;
                    st     <= S_IDLE;
                end
                default: st <= S_IDLE;
            endcase
        end
    end
endmodule : e1_axi4_mmio_shim
