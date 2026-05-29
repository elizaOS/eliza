`timescale 1ns/1ps

// e1_cpu_mmio_path_tb
//
// Testbench top that exercises the CPU -> peripheral access path that
// e1_soc_top instantiates internally, at a scope where cocotb can drive the
// CVA6-side AXI4 master directly.
//
// The chain under test is exactly the production chain inside e1_soc_top:
//
//   AXI4 master  ->  e1_cpu_axi_bridge  ->  e1_axil_to_mmio  ->  e1_mmio_arb2
//                                                                    |
//                                          +-------------------------+
//                                          v
//                          e1_mmio_decode + real peripheral fabric
//                          (bootrom / GPIO peripherals / NPU CSR)
//
// A second simple MMIO master (m0_*) models the external debug bridge so the
// 2-master arbiter is exercised with both masters live. This proves the CPU
// AXI-Lite master no longer dead-ends at 0xDEAD_BEEF: a CPU read/write of a
// real peripheral returns a real OKAY response with real data.

module e1_cpu_mmio_path_tb (
    input  logic        clk,
    input  logic        rst_n,

    // ── CVA6-side AXI4 master (driven by cocotb) ──────────────────────────
    // Read address channel
    input  logic [3:0]  cpu_ar_id,
    input  logic [63:0] cpu_ar_addr,
    input  logic        cpu_ar_valid,
    output logic        cpu_ar_ready,
    // Read data channel
    output logic [3:0]  cpu_r_id,
    output logic [63:0] cpu_r_data,
    output logic [1:0]  cpu_r_resp,
    output logic        cpu_r_valid,
    input  logic        cpu_r_ready,
    // Write address channel
    input  logic [3:0]  cpu_aw_id,
    input  logic [63:0] cpu_aw_addr,
    input  logic        cpu_aw_valid,
    output logic        cpu_aw_ready,
    // Write data channel
    input  logic [63:0] cpu_w_data,
    input  logic [7:0]  cpu_w_strb,
    input  logic        cpu_w_valid,
    output logic        cpu_w_ready,
    // Write response channel
    output logic [3:0]  cpu_b_id,
    output logic [1:0]  cpu_b_resp,
    output logic        cpu_b_valid,
    input  logic        cpu_b_ready,

    // ── External debug-bridge MMIO master (driven by cocotb) ──────────────
    input  logic        dbg_valid,
    input  logic        dbg_write,
    input  logic [31:0] dbg_addr,
    input  logic [31:0] dbg_wdata,
    output logic [31:0] dbg_rdata,
    output logic        dbg_ready,

    output logic [7:0]  gpio_out
);
    // ── CPU AXI4 master -> AXI-Lite bridge ────────────────────────────────
    logic        cpu_axil_awvalid, cpu_axil_awready;
    logic [31:0] cpu_axil_awaddr;
    logic        cpu_axil_wvalid,  cpu_axil_wready;
    logic [31:0] cpu_axil_wdata;
    logic [3:0]  cpu_axil_wstrb;
    logic        cpu_axil_bvalid,  cpu_axil_bready;
    logic [1:0]  cpu_axil_bresp;
    logic        cpu_axil_arvalid, cpu_axil_arready;
    logic [31:0] cpu_axil_araddr;
    logic        cpu_axil_rvalid,  cpu_axil_rready;
    logic [31:0] cpu_axil_rdata;
    logic [1:0]  cpu_axil_rresp;

    e1_cpu_axi_bridge u_cpu_bridge (
        .clk_i          (clk),
        .rst_ni         (rst_n),
        .s_axi_ar_id    (cpu_ar_id),
        .s_axi_ar_addr  (cpu_ar_addr),
        .s_axi_ar_len   (8'h0),
        .s_axi_ar_size  (3'b011),
        .s_axi_ar_burst (2'b01),
        .s_axi_ar_lock  (1'b0),
        .s_axi_ar_cache (4'h0),
        .s_axi_ar_prot  (3'h0),
        .s_axi_ar_qos   (4'h0),
        .s_axi_ar_region(4'h0),
        .s_axi_ar_user  (1'b0),
        .s_axi_ar_valid (cpu_ar_valid),
        .s_axi_ar_ready (cpu_ar_ready),
        .s_axi_r_id     (cpu_r_id),
        .s_axi_r_data   (cpu_r_data),
        .s_axi_r_resp   (cpu_r_resp),
        .s_axi_r_last   (),
        .s_axi_r_user   (),
        .s_axi_r_valid  (cpu_r_valid),
        .s_axi_r_ready  (cpu_r_ready),
        .s_axi_aw_id    (cpu_aw_id),
        .s_axi_aw_addr  (cpu_aw_addr),
        .s_axi_aw_len   (8'h0),
        .s_axi_aw_size  (3'b011),
        .s_axi_aw_burst (2'b01),
        .s_axi_aw_lock  (1'b0),
        .s_axi_aw_cache (4'h0),
        .s_axi_aw_user  (1'b0),
        .s_axi_aw_valid (cpu_aw_valid),
        .s_axi_aw_ready (cpu_aw_ready),
        .s_axi_w_data   (cpu_w_data),
        .s_axi_w_strb   (cpu_w_strb),
        .s_axi_w_last   (1'b1),
        .s_axi_w_user   (1'b0),
        .s_axi_w_valid  (cpu_w_valid),
        .s_axi_w_ready  (cpu_w_ready),
        .s_axi_b_id     (cpu_b_id),
        .s_axi_b_resp   (cpu_b_resp),
        .s_axi_b_user   (),
        .s_axi_b_valid  (cpu_b_valid),
        .s_axi_b_ready  (cpu_b_ready),
        .m_axil_awvalid (cpu_axil_awvalid),
        .m_axil_awready (cpu_axil_awready),
        .m_axil_awaddr  (cpu_axil_awaddr),
        .m_axil_wvalid  (cpu_axil_wvalid),
        .m_axil_wready  (cpu_axil_wready),
        .m_axil_wdata   (cpu_axil_wdata),
        .m_axil_wstrb   (cpu_axil_wstrb),
        .m_axil_bvalid  (cpu_axil_bvalid),
        .m_axil_bready  (cpu_axil_bready),
        .m_axil_bresp   (cpu_axil_bresp),
        .m_axil_arvalid (cpu_axil_arvalid),
        .m_axil_arready (cpu_axil_arready),
        .m_axil_araddr  (cpu_axil_araddr),
        .m_axil_rvalid  (cpu_axil_rvalid),
        .m_axil_rready  (cpu_axil_rready),
        .m_axil_rdata   (cpu_axil_rdata),
        .m_axil_rresp   (cpu_axil_rresp)
    );

    // ── AXI-Lite -> simple MMIO master adapter ────────────────────────────
    logic        cpu_mmio_valid, cpu_mmio_write;
    logic [31:0] cpu_mmio_addr,  cpu_mmio_wdata;
    logic [3:0]  cpu_mmio_wstrb;
    logic [31:0] cpu_mmio_rdata;
    logic        cpu_mmio_ready;

    e1_axil_to_mmio u_axil_to_mmio (
        .clk            (clk),
        .rst_n          (rst_n),
        .s_axil_awvalid (cpu_axil_awvalid),
        .s_axil_awready (cpu_axil_awready),
        .s_axil_awaddr  (cpu_axil_awaddr),
        .s_axil_wvalid  (cpu_axil_wvalid),
        .s_axil_wready  (cpu_axil_wready),
        .s_axil_wdata   (cpu_axil_wdata),
        .s_axil_wstrb   (cpu_axil_wstrb),
        .s_axil_bvalid  (cpu_axil_bvalid),
        .s_axil_bready  (cpu_axil_bready),
        .s_axil_bresp   (cpu_axil_bresp),
        .s_axil_arvalid (cpu_axil_arvalid),
        .s_axil_arready (cpu_axil_arready),
        .s_axil_araddr  (cpu_axil_araddr),
        .s_axil_rvalid  (cpu_axil_rvalid),
        .s_axil_rready  (cpu_axil_rready),
        .s_axil_rdata   (cpu_axil_rdata),
        .s_axil_rresp   (cpu_axil_rresp),
        .mmio_valid     (cpu_mmio_valid),
        .mmio_write     (cpu_mmio_write),
        .mmio_addr      (cpu_mmio_addr),
        .mmio_wdata     (cpu_mmio_wdata),
        .mmio_wstrb     (cpu_mmio_wstrb),
        .mmio_rdata     (cpu_mmio_rdata),
        .mmio_ready     (cpu_mmio_ready)
    );

    // ── 2-master arbiter (debug master m0 + CPU master m1) ────────────────
    assign dbg_rdata = fab_rdata; // expose granted return for the dbg master
    logic        fab_valid, fab_write;
    logic [31:0] fab_addr,  fab_wdata;
    logic [3:0]  fab_wstrb;
    logic [31:0] fab_rdata;
    logic        fab_ready;

    e1_mmio_arb2 u_arb (
        .clk        (clk),
        .rst_n      (rst_n),
        .m0_valid   (dbg_valid),
        .m0_write   (dbg_write),
        .m0_addr    (dbg_addr),
        .m0_wdata   (dbg_wdata),
        .m0_rdata   (),
        .m0_ready   (dbg_ready),
        .m1_valid   (cpu_mmio_valid),
        .m1_write   (cpu_mmio_write),
        .m1_addr    (cpu_mmio_addr),
        .m1_wdata   (cpu_mmio_wdata),
        .m1_wstrb   (cpu_mmio_wstrb),
        .m1_rdata   (cpu_mmio_rdata),
        .m1_ready   (cpu_mmio_ready),
        .mmio_valid (fab_valid),
        .mmio_write (fab_write),
        .mmio_addr  (fab_addr),
        .mmio_wdata (fab_wdata),
        .mmio_wstrb (fab_wstrb),
        .mmio_rdata (fab_rdata),
        .mmio_ready (fab_ready)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_wstrb;
    assign unused_wstrb = ^fab_wstrb;
    /* verilator lint_on UNUSEDSIGNAL */

    // ── Real peripheral fabric: decode + bootrom + GPIO peripherals + NPU ──
    logic word_aligned, implemented_window;
    logic bootrom_sel, periph_sel, dma_sel, npu_sel, display_sel;
    logic wbuf_sel, clint_sel, dram_sel;

    e1_mmio_decode u_decode (
        .mmio_addr          (fab_addr),
        .word_aligned       (word_aligned),
        .implemented_window (implemented_window),
        .bootrom_sel        (bootrom_sel),
        .periph_sel         (periph_sel),
        .dma_sel            (dma_sel),
        .npu_sel            (npu_sel),
        .display_sel        (display_sel),
        .wbuf_sel           (wbuf_sel),
        .clint_sel          (clint_sel),
        .dram_sel           (dram_sel)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_sel;
    assign unused_sel = ^{dma_sel, display_sel, wbuf_sel, clint_sel, dram_sel,
                          implemented_window, word_aligned};
    /* verilator lint_on UNUSEDSIGNAL */

    logic [31:0] bootrom_rdata, periph_rdata, npu_rdata;
    logic        periph_irq_timer, npu_irq;

    // Bootrom image: the TB-staged identity header is enough to prove the read
    // path returns real ROM data (word 0 = magic) rather than 0xDEAD_BEEF.
    e1_bootrom u_bootrom (
        .addr  (fab_addr[15:2]),
        .rdata (bootrom_rdata)
    );

    e1_peripherals u_peripherals (
        .clk      (clk),
        .rst_n    (rst_n),
        .valid    (fab_valid && periph_sel),
        .write    (fab_write),
        .addr     (fab_addr[7:2]),
        .wdata    (fab_wdata),
        .rdata    (periph_rdata),
        .irq_timer(periph_irq_timer),
        .gpio_out (gpio_out)
    );

    // NPU CSR slave: AXI master ports are unused in this path test (the NPU's
    // DMA engine is not exercised), so leave the master read/write idle.
    logic        npu_m_awvalid, npu_m_wvalid, npu_m_arvalid;
    logic [31:0] npu_m_awaddr, npu_m_wdata, npu_m_araddr;
    logic [3:0]  npu_m_wstrb;
    logic        npu_m_bready, npu_m_rready;
    e1_npu u_npu (
        .clk            (clk),
        .rst_n          (rst_n),
        .valid          (fab_valid && npu_sel),
        .write          (fab_write),
        .addr           (fab_addr[7:2]),
        .wdata          (fab_wdata),
        .rdata          (npu_rdata),
        .irq            (npu_irq),
        .m_axil_awvalid (npu_m_awvalid),
        .m_axil_awready (1'b0),
        .m_axil_awaddr  (npu_m_awaddr),
        .m_axil_wvalid  (npu_m_wvalid),
        .m_axil_wready  (1'b0),
        .m_axil_wdata   (npu_m_wdata),
        .m_axil_wstrb   (npu_m_wstrb),
        .m_axil_bvalid  (1'b0),
        .m_axil_bready  (npu_m_bready),
        .m_axil_bresp   (2'b00),
        .m_axil_arvalid (npu_m_arvalid),
        .m_axil_arready (1'b0),
        .m_axil_araddr  (npu_m_araddr),
        .m_axil_rvalid  (1'b0),
        .m_axil_rready  (npu_m_rready),
        .m_axil_rdata   (32'h0),
        .m_axil_rresp   (2'b00)
    );

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_npu_master;
    assign unused_npu_master = ^{npu_m_awvalid, npu_m_wvalid, npu_m_arvalid,
                                 npu_m_awaddr, npu_m_wdata, npu_m_araddr,
                                 npu_m_wstrb, npu_m_bready, npu_m_rready,
                                 periph_irq_timer, npu_irq};
    /* verilator lint_on UNUSEDSIGNAL */

    // ── Fabric return (single-cycle legacy regions) ───────────────────────
    assign fab_ready = fab_valid;
    always_comb begin
        priority case (1'b1)
            bootrom_sel: fab_rdata = bootrom_rdata;
            periph_sel:  fab_rdata = periph_rdata;
            npu_sel:     fab_rdata = npu_rdata;
            default:     fab_rdata = 32'hDEAD_BEEF;
        endcase
    end

endmodule : e1_cpu_mmio_path_tb
