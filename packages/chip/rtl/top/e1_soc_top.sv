// e1_soc_top.sv
//
// CPU wiring notes:
//   • e1_cpu_subsystem (rtl/cpu/e1_cva6_wrapper.sv) replaces the old
//     e1_cpu_subsystem_stub.  It presents a 64-bit AXI4 master port.
//   • e1_cpu_axi_bridge (rtl/cpu/e1_cpu_axi_bridge.sv) converts that
//     AXI4 master to the 32-bit AXI-Lite interface consumed by the e1-chip
//     interconnect.
//   • ipi_i  ← CLINT msip_o (software interrupt)
//   • time_irq_i ← CLINT mtip_o (timer interrupt)
//   • irq_i[0] ← external interrupt controller claim output
//   • debug_req_i tied to 0 until JTAG bring-up
//
// To use real CVA6: compile with +define+E1_HAVE_CVA6 and include
//   external/cva6/ in your search path (see scripts/clone_cva6.sh).
//
// synthesis translate_off
// WARNING: E1_HAVE_CVA6 not defined.  e1_cpu_subsystem will compile as
// a stub with all AXI master outputs tied to idle.  The SoC will simulate
// correctly but the CPU will not execute instructions.  To enable the real
// CVA6 core, define E1_HAVE_CVA6 and add external/cva6/ to the include
// path per the instructions in scripts/clone_cva6.sh.
// synthesis translate_on

`timescale 1ns/1ps

// E1_SOC_REAL_SUBSYS is the umbrella define: it is set whenever either the
// real interrupt path (E1_SOC_REAL_IRQ) or the real main-memory path
// (E1_SOC_REAL_DRAM) is requested, so the e1_soc_real_subsys composite (which
// always contains all three production leaves) is instantiated once.
`ifdef E1_SOC_REAL_IRQ
  `define E1_SOC_REAL_SUBSYS
`endif
`ifdef E1_SOC_REAL_DRAM
  `define E1_SOC_REAL_SUBSYS
`endif

module e1_soc_top
(
`ifdef USE_POWER_PINS
    inout  wire         VPWR,
    inout  wire         VGND,
`endif
    input  logic        clk,
    input  logic        rst_n,
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    output logic [31:0] mmio_rdata,
    output logic        mmio_ready,
    output logic        irq_timer,
    output logic        irq_dma,
    output logic        irq_npu,
    output logic        irq_vsync,
    output logic        msip_o,
    output logic        mtip_o,
`ifdef E1_SOC_REAL_IRQ
    // Real-PLIC external-interrupt line to the CPU (mip.MEIP). Only present in
    // the E1_SOC_REAL_IRQ config; the legacy path has no PLIC claim output.
    output logic        meip_o,
`endif
`ifdef E1_SOC_REAL_DRAM
    // Discoverable main-memory geometry from the real AXI4 DRAM controller,
    // surfaced for boot enumeration / DTB memory-node sizing.
    output logic [63:0] mem_capacity_bytes,
    output logic [63:0] mem_base_addr,
`endif
`ifdef E1_SOC_ROT_GATED
    // RoT-gated boot (rtl/security/rot/e1_rot_reset_seq.sv): the CPU cluster is
    // held in reset until the mask-ROM secure-boot verifier strobes
    // boot_verified_i AND the IOPMP source-ID policy is programmed
    // (iopmp_policy_ready_i). Fail-closed: no timeout release; lc_scrap_i
    // latches a permanent halt. See docs/security/tee-plan/02-root-of-trust.md.
    input  logic        boot_verified_i,
    input  logic        iopmp_policy_ready_i,
    input  logic        lc_scrap_i,
    output logic [2:0]  rot_state_o,
    output logic        platform_released_o,
    output logic        rot_halted_o,
`endif
    output logic [7:0]  gpio_out
);
    logic [31:0] bootrom_rdata;
    logic [31:0] dma_rdata;
    logic [31:0] npu_rdata;
    logic [31:0] display_rdata;
    logic [31:0] periph_rdata;
    logic [31:0] clint_rdata;
    logic dma_m_awvalid;
    logic dma_m_awready;
    logic [31:0] dma_m_awaddr;
    logic dma_m_wvalid;
    logic dma_m_wready;
    logic [31:0] dma_m_wdata;
    logic [3:0] dma_m_wstrb;
    logic dma_m_bvalid;
    logic dma_m_bready;
    logic [1:0] dma_m_bresp;
    logic dma_m_arvalid;
    logic dma_m_arready;
    logic [31:0] dma_m_araddr;
    logic dma_m_rvalid;
    logic dma_m_rready;
    logic [31:0] dma_m_rdata;
    logic [1:0] dma_m_rresp;
    logic npu_m_awvalid;
    logic npu_m_awready;
    logic [31:0] npu_m_awaddr;
    logic npu_m_wvalid;
    logic npu_m_wready;
    logic [31:0] npu_m_wdata;
    logic [3:0] npu_m_wstrb;
    logic npu_m_bvalid;
    logic npu_m_bready;
    logic [1:0] npu_m_bresp;
    logic npu_m_arvalid;
    logic npu_m_arready;
    logic [31:0] npu_m_araddr;
    logic npu_m_rvalid;
    logic npu_m_rready;
    logic [31:0] npu_m_rdata;
    logic [1:0] npu_m_rresp;
    logic display_scan_hsync;
    logic display_scan_vsync;
    logic display_scan_active;
    logic [15:0] display_scan_x;
    logic [15:0] display_scan_y;
    logic [31:0] display_scan_fb_addr;
    logic [23:0] display_scan_rgb;
    logic display_fb_read_valid;
    logic [31:0] display_fb_read_addr;
    logic [31:0] display_fb_read_data;
    logic        display_fb_read_ready;

    logic bootrom_sel;
    logic dma_sel;
    logic npu_sel;
    logic display_sel;
    logic periph_sel;
    logic dram_sel;
    logic clint_sel;
    logic wbuf_sel;
    logic word_aligned;
    logic implemented_window;
    logic [31:0] mmio_dram_rdata;
    logic [63:0] clint_mtime;
    logic [63:0] clint_mtimecmp;

    // Shared MMIO address decode (rtl/peripherals/e1_mmio_decode.sv).
    // Driven from the arbitrated fabric bus (fab_*), not the external port,
    // so both the external debug bridge and the CPU are decoded identically.
    e1_mmio_decode u_mmio_decode (
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

    // Bring-up CLINT outputs feed the CPU only in the legacy config. In the
    // E1_SOC_REAL_IRQ config the real e1_clint (in e1_soc_real_subsys) drives
    // msip_o/mtip_o and the bring-up block is not instantiated.
    logic        legacy_msip;
    logic [31:0] legacy_clint_rdata;

`ifndef E1_SOC_REAL_IRQ
    // Shared bring-up CLINT (rtl/peripherals/e1_clint.sv).
    e1_clint u_clint (
        .clk            (clk),
        .rst_n          (rst_n),
        .mmio_valid     (fab_valid),
        .mmio_write     (fab_write),
        .mmio_word_addr (fab_addr[15:2]),
        .mmio_wdata     (fab_wdata),
        .sel_i          (clint_sel),
        .clint_rdata    (legacy_clint_rdata),
        .msip_o         (legacy_msip),
        .mtime_o        (clint_mtime),
        .mtimecmp_o     (clint_mtimecmp)
    );
    assign msip_o      = legacy_msip;
    assign mtip_o      = clint_mtime >= clint_mtimecmp;
    assign clint_rdata = legacy_clint_rdata;
`else
    // Real-IRQ config: bring-up CLINT nets are unused; tie them to keep lint
    // clean. msip_o/mtip_o/clint_rdata are driven by u_real_subsys below.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_legacy_clint;
    assign unused_legacy_clint = ^{legacy_msip, legacy_clint_rdata};
    /* verilator lint_on UNUSEDSIGNAL */
    assign legacy_msip        = 1'b0;
    assign legacy_clint_rdata = 32'h0;
    assign clint_mtime        = 64'h0;
    assign clint_mtimecmp     = 64'hFFFF_FFFF_FFFF_FFFF;
    // msip_o/mtip_o/clint_rdata are driven from the real subsys (rs_*) wires,
    // assigned after the subsys instantiation below.
`endif

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_display_scanout;
    assign unused_display_scanout = ^{
        display_scan_hsync,
        display_scan_vsync,
        display_scan_active,
        display_scan_x,
        display_scan_y,
        display_scan_fb_addr,
        display_scan_rgb
    };
    /* verilator lint_on UNUSEDSIGNAL */

    // ── Real interrupt + main-memory subsystem (E1_SOC_REAL_IRQ / _DRAM) ──
    //
    // Behind these defines the production CLINT, PLIC, and AXI4 DRAM
    // controller (each cocotb-verified standalone) are composed onto the v0
    // MMIO aperture by e1_soc_real_subsys. The legacy bring-up CLINT +
    // behavioural-DRAM path is preserved when the defines are absent, so the
    // existing gates (test_e1_soc.py, PD/synth/formal) stay green.
    //
    //   E1_SOC_REAL_IRQ  : real CLINT @ 0x0200_0000 drives msip_o/mtip_o;
    //                      real PLIC  @ 0x0C00_0000 drives meip_o via a
    //                      claim/complete round-trip. PLIC sources are the
    //                      peripheral IRQs (timer/dma/npu/vsync).
    //   E1_SOC_REAL_DRAM : real AXI4 DRAM controller (2 GiB @ 0x8000_0000)
    //                      backs the CPU/debug MMIO DRAM window.
`ifdef E1_SOC_REAL_SUBSYS
    localparam int unsigned PLIC_NUM_SOURCES = 4;

    // PLIC decode window: 0x0C00_0000 .. 0x0FFF_FFFF (64 MiB), word-aligned.
    logic        rs_plic_sel;
    assign rs_plic_sel = word_aligned && (fab_addr[31:26] == 6'b0000_11);

    // The real subsys handles a region only when that real define is active;
    // otherwise the legacy block keeps the region (selects forced 0 here).
`ifdef E1_SOC_REAL_IRQ
    wire rs_clint_sel = clint_sel;
    wire rs_plic_sel_q = rs_plic_sel;
`else
    wire rs_clint_sel = 1'b0;
    wire rs_plic_sel_q = 1'b0;
`endif
`ifdef E1_SOC_REAL_DRAM
    wire rs_dram_sel = dram_sel;
`else
    wire rs_dram_sel = 1'b0;
`endif

    logic [31:0] rs_clint_rdata;
    logic [31:0] rs_plic_rdata;
    logic [31:0] rs_dram_rdata;
    logic        rs_mmio_ready;
    logic        rs_msip;
    logic        rs_mtip;
    logic        rs_meip;
    logic [63:0] rs_mtime;
    logic [63:0] rs_mem_base;
    logic [63:0] rs_mem_cap;

    // PLIC sources: peripheral device IRQs. Source id 1=timer, 2=dma, 3=npu,
    // 4=vsync (index 0 == source id 1 in the PLIC gateway).
    wire [PLIC_NUM_SOURCES-1:0] rs_plic_sources = {irq_vsync, irq_npu,
                                                   irq_dma, irq_timer};

    e1_soc_real_subsys #(
        .NUM_HARTS        (1),
        .PLIC_NUM_SOURCES (PLIC_NUM_SOURCES)
    ) u_real_subsys (
        .clk          (clk),
        .rst_n        (rst_n),
        .mmio_valid   (fab_valid),
        .mmio_write   (fab_write),
        .mmio_addr    (fab_addr),
        .mmio_wdata   (fab_wdata),
        .clint_sel    (rs_clint_sel),
        .plic_sel     (rs_plic_sel_q),
        .dram_sel     (rs_dram_sel),
        .clint_rdata  (rs_clint_rdata),
        .plic_rdata   (rs_plic_rdata),
        .dram_rdata   (rs_dram_rdata),
        .mmio_ready_o (rs_mmio_ready),
        .msip_o       (rs_msip),
        .mtip_o       (rs_mtip),
        .meip_o       (rs_meip),
        .mtime_o      (rs_mtime),
        .plic_sources (rs_plic_sources),
        .mem_base_addr      (rs_mem_base),
        .mem_capacity_bytes (rs_mem_cap)
    );

    // rs_mtime is observability-only; rs_*_rdata / rs_msip / rs_mtip / rs_meip
    // are consumed by the muxes below only when E1_SOC_REAL_IRQ/_DRAM are set,
    // so absorb them here to keep lint clean across the define matrix.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_rs;
    assign unused_rs = ^{rs_mtime, rs_clint_rdata, rs_plic_rdata, rs_dram_rdata,
                         rs_msip, rs_mtip, rs_meip, rs_mem_base, rs_mem_cap};
    /* verilator lint_on UNUSEDSIGNAL */
`endif

`ifdef E1_SOC_REAL_DRAM
    assign mem_base_addr      = rs_mem_base;
    assign mem_capacity_bytes = rs_mem_cap;
`endif
`ifdef E1_SOC_REAL_IRQ
    assign meip_o      = rs_meip;
    assign msip_o      = rs_msip;
    assign mtip_o      = rs_mtip;
    assign clint_rdata = rs_clint_rdata;
`endif

    // Shared behavioural scratch-DRAM model (rtl/memory/e1_behavioral_dram.sv).
    // Backs the DMA / NPU AXI-Lite masters, the display framebuffer read port,
    // and the CPU/debug MMIO DRAM window with one deterministic word array.
    e1_behavioral_dram u_behavioral_dram (
        .clk                   (clk),
        .rst_n                 (rst_n),
        .mmio_valid            (fab_valid),
        .mmio_write            (fab_write),
        .mmio_addr             (fab_addr),
        .mmio_wdata            (fab_wdata),
        .dram_sel              (dram_sel),
        .mmio_dram_rdata       (mmio_dram_rdata),
        .dma_m_awvalid         (dma_m_awvalid),
        .dma_m_awready         (dma_m_awready),
        .dma_m_awaddr          (dma_m_awaddr),
        .dma_m_wvalid          (dma_m_wvalid),
        .dma_m_wready          (dma_m_wready),
        .dma_m_wdata           (dma_m_wdata),
        .dma_m_wstrb           (dma_m_wstrb),
        .dma_m_bvalid          (dma_m_bvalid),
        .dma_m_bready          (dma_m_bready),
        .dma_m_bresp           (dma_m_bresp),
        .dma_m_arvalid         (dma_m_arvalid),
        .dma_m_arready         (dma_m_arready),
        .dma_m_araddr          (dma_m_araddr),
        .dma_m_rvalid          (dma_m_rvalid),
        .dma_m_rready          (dma_m_rready),
        .dma_m_rdata           (dma_m_rdata),
        .dma_m_rresp           (dma_m_rresp),
        .npu_m_awvalid         (npu_m_awvalid),
        .npu_m_awready         (npu_m_awready),
        .npu_m_awaddr          (npu_m_awaddr),
        .npu_m_wvalid          (npu_m_wvalid),
        .npu_m_wready          (npu_m_wready),
        .npu_m_wdata           (npu_m_wdata),
        .npu_m_wstrb           (npu_m_wstrb),
        .npu_m_bvalid          (npu_m_bvalid),
        .npu_m_bready          (npu_m_bready),
        .npu_m_bresp           (npu_m_bresp),
        .npu_m_arvalid         (npu_m_arvalid),
        .npu_m_arready         (npu_m_arready),
        .npu_m_araddr          (npu_m_araddr),
        .npu_m_rvalid          (npu_m_rvalid),
        .npu_m_rready          (npu_m_rready),
        .npu_m_rdata           (npu_m_rdata),
        .npu_m_rresp           (npu_m_rresp),
        .display_fb_read_valid (display_fb_read_valid),
        .display_fb_read_addr  (display_fb_read_addr),
        .display_fb_read_data  (display_fb_read_data),
        .display_fb_read_ready (display_fb_read_ready)
    );

    // ── CPU subsystem AXI4 master wires (CVA6 → AXI bridge) ───────────────
    // Read address channel
    logic [3:0]  cpu_axi_ar_id;
    logic [63:0] cpu_axi_ar_addr;
    logic [7:0]  cpu_axi_ar_len;
    logic [2:0]  cpu_axi_ar_size;
    logic [1:0]  cpu_axi_ar_burst;
    logic        cpu_axi_ar_lock;
    logic [3:0]  cpu_axi_ar_cache;
    logic [2:0]  cpu_axi_ar_prot;
    logic [3:0]  cpu_axi_ar_qos;
    logic [3:0]  cpu_axi_ar_region;
    logic        cpu_axi_ar_user;
    logic        cpu_axi_ar_valid;
    logic        cpu_axi_ar_ready;
    // Read data channel
    logic [3:0]  cpu_axi_r_id;
    logic [63:0] cpu_axi_r_data;
    logic [1:0]  cpu_axi_r_resp;
    logic        cpu_axi_r_last;
    logic        cpu_axi_r_user;
    logic        cpu_axi_r_valid;
    logic        cpu_axi_r_ready;
    // Write address channel
    logic [3:0]  cpu_axi_aw_id;
    logic [63:0] cpu_axi_aw_addr;
    logic [7:0]  cpu_axi_aw_len;
    logic [2:0]  cpu_axi_aw_size;
    logic [1:0]  cpu_axi_aw_burst;
    logic        cpu_axi_aw_lock;
    logic [3:0]  cpu_axi_aw_cache;
    logic [2:0]  cpu_axi_aw_prot;
    logic [3:0]  cpu_axi_aw_qos;
    logic [3:0]  cpu_axi_aw_region;
    logic [5:0]  cpu_axi_aw_atop;
    logic        cpu_axi_aw_user;
    logic        cpu_axi_aw_valid;
    logic        cpu_axi_aw_ready;
    // Write data channel
    logic [63:0] cpu_axi_w_data;
    logic [7:0]  cpu_axi_w_strb;
    logic        cpu_axi_w_last;
    logic        cpu_axi_w_user;
    logic        cpu_axi_w_valid;
    logic        cpu_axi_w_ready;
    // Write response channel
    logic [3:0]  cpu_axi_b_id;
    logic [1:0]  cpu_axi_b_resp;
    logic        cpu_axi_b_user;
    logic        cpu_axi_b_valid;
    logic        cpu_axi_b_ready;

    // ── AXI-Lite bridge output wires (bridge → SoC interconnect) ──────────
    logic        cpu_axil_awvalid;
    logic        cpu_axil_awready;
    logic [31:0] cpu_axil_awaddr;
    logic        cpu_axil_wvalid;
    logic        cpu_axil_wready;
    logic [31:0] cpu_axil_wdata;
    logic [3:0]  cpu_axil_wstrb;
    logic        cpu_axil_bvalid;
    logic        cpu_axil_bready;
    logic [1:0]  cpu_axil_bresp;
    logic        cpu_axil_arvalid;
    logic        cpu_axil_arready;
    logic [31:0] cpu_axil_araddr;
    logic        cpu_axil_rvalid;
    logic        cpu_axil_rready;
    logic [31:0] cpu_axil_rdata;
    logic [1:0]  cpu_axil_rresp;

    // ── CPU observability (unused in current integration; kept for debug) ──
    /* verilator lint_off UNUSEDSIGNAL */
    logic [63:0] cpu_dbg_pc;
    logic        cpu_dbg_valid;
    logic [2:0]  cpu_axi_aw_prot_unused;
    logic [3:0]  cpu_axi_aw_qos_unused;
    logic [3:0]  cpu_axi_aw_region_unused;
    logic [5:0]  cpu_axi_aw_atop_unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign cpu_axi_aw_prot_unused   = cpu_axi_aw_prot;
    assign cpu_axi_aw_qos_unused    = cpu_axi_aw_qos;
    assign cpu_axi_aw_region_unused = cpu_axi_aw_region;
    assign cpu_axi_aw_atop_unused   = cpu_axi_aw_atop;

    // ── External interrupt from PLIC/interrupt controller ─────────────────
    // Wire to the e1_interrupt_controller claim output when the PLIC is
    // fully integrated.  For now the interrupt controller drives irq_npu and
    // irq_dma; the external IRQ line to the CPU carries the combined OR of all
    // enabled pending sources (same signal that the AXI-Lite scaffold exposes).
    // This is a placeholder — replace with the PLIC claim output when the full
    // PLIC is wired in.
    logic        cpu_ext_irq;
`ifdef E1_SOC_REAL_IRQ
    // Real config: the external IRQ line is the PLIC's per-context request
    // (mip.MEIP), gated through a real claim/complete. The timer IRQ comes
    // from the real CLINT's mtip_o.
    assign cpu_ext_irq    = rs_meip;
    wire   cpu_time_irq   = rs_mtip;
`else
    assign cpu_ext_irq    = irq_timer | irq_dma | irq_npu | irq_vsync;
    wire   cpu_time_irq   = clint_mtime >= clint_mtimecmp;
`endif

    // ── RoT reset sequencer (E1_SOC_ROT_GATED) ─────────────────────────────
    // Holds the CPU cluster in reset until secure-boot is verified and the
    // IOPMP policy is programmed. cpu_rst_n is the CPU's effective reset.
    logic cpu_rst_n;
`ifdef E1_SOC_ROT_GATED
    logic rot_cva6_rst_no;
    /* verilator lint_off UNUSEDSIGNAL */
    logic rot_rst_no_unused;
    logic rot_pmc_rst_no_unused;
    /* verilator lint_on UNUSEDSIGNAL */
    e1_rot_reset_seq u_rot_reset_seq (
        .clk_i                (clk),
        .rst_ni               (rst_n),
        .boot_verified_i      (boot_verified_i),
        .iopmp_policy_ready_i (iopmp_policy_ready_i),
        .lc_scrap_i           (lc_scrap_i),
        .rot_rst_no           (rot_rst_no_unused),
        .cva6_rst_no          (rot_cva6_rst_no),
        .pmc_rst_no           (rot_pmc_rst_no_unused),
        .state_o              (rot_state_o),
        .platform_released_o  (platform_released_o),
        .halted_o             (rot_halted_o)
    );
    // CPU stays in reset until the RoT releases the application cluster.
    assign cpu_rst_n = rst_n & rot_cva6_rst_no;
`else
    assign cpu_rst_n = rst_n;
`endif

    // ── CPU subsystem ──────────────────────────────────────────────────────
    e1_cpu_subsystem #(
        // Boot vector matches e1_chip_cpu_variant.boot.reset_vector in
        // sw/platform/e1_platform_contract.json (0x0000_1000).
        .BOOT_ADDR (64'h0000_0000_0000_1000)
    ) u_cpu (
        .clk_i          (clk),
        .rst_ni         (cpu_rst_n),
        // Interrupts wired from CLINT and combined external IRQ
        .ipi_i          (msip_o),              // CLINT msip → software IRQ
        .time_irq_i     (cpu_time_irq),        // CLINT mtip
        .irq_i          ({cpu_ext_irq, 1'b0}), // [1]=M-mode ext, [0]=S-mode
        .debug_req_i    (1'b0),                // JTAG debug: tie 0 for now
        // AXI4 master → bridge
        .axi_ar_id      (cpu_axi_ar_id),
        .axi_ar_addr    (cpu_axi_ar_addr),
        .axi_ar_len     (cpu_axi_ar_len),
        .axi_ar_size    (cpu_axi_ar_size),
        .axi_ar_burst   (cpu_axi_ar_burst),
        .axi_ar_lock    (cpu_axi_ar_lock),
        .axi_ar_cache   (cpu_axi_ar_cache),
        .axi_ar_prot    (cpu_axi_ar_prot),
        .axi_ar_qos     (cpu_axi_ar_qos),
        .axi_ar_region  (cpu_axi_ar_region),
        .axi_ar_user    (cpu_axi_ar_user),
        .axi_ar_valid   (cpu_axi_ar_valid),
        .axi_ar_ready   (cpu_axi_ar_ready),
        .axi_r_id       (cpu_axi_r_id),
        .axi_r_data     (cpu_axi_r_data),
        .axi_r_resp     (cpu_axi_r_resp),
        .axi_r_last     (cpu_axi_r_last),
        .axi_r_user     (cpu_axi_r_user),
        .axi_r_valid    (cpu_axi_r_valid),
        .axi_r_ready    (cpu_axi_r_ready),
        .axi_aw_id      (cpu_axi_aw_id),
        .axi_aw_addr    (cpu_axi_aw_addr),
        .axi_aw_len     (cpu_axi_aw_len),
        .axi_aw_size    (cpu_axi_aw_size),
        .axi_aw_burst   (cpu_axi_aw_burst),
        .axi_aw_lock    (cpu_axi_aw_lock),
        .axi_aw_cache   (cpu_axi_aw_cache),
        .axi_aw_prot    (cpu_axi_aw_prot),
        .axi_aw_qos     (cpu_axi_aw_qos),
        .axi_aw_region  (cpu_axi_aw_region),
        .axi_aw_atop    (cpu_axi_aw_atop),
        .axi_aw_user    (cpu_axi_aw_user),
        .axi_aw_valid   (cpu_axi_aw_valid),
        .axi_aw_ready   (cpu_axi_aw_ready),
        .axi_w_data     (cpu_axi_w_data),
        .axi_w_strb     (cpu_axi_w_strb),
        .axi_w_last     (cpu_axi_w_last),
        .axi_w_user     (cpu_axi_w_user),
        .axi_w_valid    (cpu_axi_w_valid),
        .axi_w_ready    (cpu_axi_w_ready),
        .axi_b_id       (cpu_axi_b_id),
        .axi_b_resp     (cpu_axi_b_resp),
        .axi_b_user     (cpu_axi_b_user),
        .axi_b_valid    (cpu_axi_b_valid),
        .axi_b_ready    (cpu_axi_b_ready),
        .hart_id_i      (64'd0),
        // Observability
        .dbg_pc_o       (cpu_dbg_pc),
        .dbg_valid_o    (cpu_dbg_valid)
    );

    // ── AXI4→AXI-Lite bridge ───────────────────────────────────────────────
    // Converts the 64-bit AXI4 CPU master to the 32-bit AXI-Lite interconnect.
    // The bridge output (cpu_axil_*) feeds the SoC decode logic below.
    e1_cpu_axi_bridge u_cpu_bridge (
        .clk_i          (clk),
        .rst_ni         (rst_n),
        // AXI4 slave side (from CPU)
        .s_axi_ar_id    (cpu_axi_ar_id),
        .s_axi_ar_addr  (cpu_axi_ar_addr),
        .s_axi_ar_len   (cpu_axi_ar_len),
        .s_axi_ar_size  (cpu_axi_ar_size),
        .s_axi_ar_burst (cpu_axi_ar_burst),
        .s_axi_ar_lock  (cpu_axi_ar_lock),
        .s_axi_ar_cache (cpu_axi_ar_cache),
        .s_axi_ar_prot  (cpu_axi_ar_prot),
        .s_axi_ar_qos   (cpu_axi_ar_qos),
        .s_axi_ar_region(cpu_axi_ar_region),
        .s_axi_ar_user  (cpu_axi_ar_user),
        .s_axi_ar_valid (cpu_axi_ar_valid),
        .s_axi_ar_ready (cpu_axi_ar_ready),
        .s_axi_r_id     (cpu_axi_r_id),
        .s_axi_r_data   (cpu_axi_r_data),
        .s_axi_r_resp   (cpu_axi_r_resp),
        .s_axi_r_last   (cpu_axi_r_last),
        .s_axi_r_user   (cpu_axi_r_user),
        .s_axi_r_valid  (cpu_axi_r_valid),
        .s_axi_r_ready  (cpu_axi_r_ready),
        .s_axi_aw_id    (cpu_axi_aw_id),
        .s_axi_aw_addr  (cpu_axi_aw_addr),
        .s_axi_aw_len   (cpu_axi_aw_len),
        .s_axi_aw_size  (cpu_axi_aw_size),
        .s_axi_aw_burst (cpu_axi_aw_burst),
        .s_axi_aw_lock  (cpu_axi_aw_lock),
        .s_axi_aw_cache (cpu_axi_aw_cache),
        .s_axi_aw_user  (cpu_axi_aw_user),
        .s_axi_aw_valid (cpu_axi_aw_valid),
        .s_axi_aw_ready (cpu_axi_aw_ready),
        .s_axi_w_data   (cpu_axi_w_data),
        .s_axi_w_strb   (cpu_axi_w_strb),
        .s_axi_w_last   (cpu_axi_w_last),
        .s_axi_w_user   (cpu_axi_w_user),
        .s_axi_w_valid  (cpu_axi_w_valid),
        .s_axi_w_ready  (cpu_axi_w_ready),
        .s_axi_b_id     (cpu_axi_b_id),
        .s_axi_b_resp   (cpu_axi_b_resp),
        .s_axi_b_user   (cpu_axi_b_user),
        .s_axi_b_valid  (cpu_axi_b_valid),
        .s_axi_b_ready  (cpu_axi_b_ready),
        // AXI-Lite master side (to SoC interconnect / decode)
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

    // ── CPU AXI-Lite → simple MMIO master adapter ──────────────────────────
    // Converts the CVA6 bridge's downstream AXI-Lite port into a single MMIO
    // request at a time on the shared peripheral-fabric bus. The adapter output
    // is master 1 of the e1_mmio_arb2 arbiter below; the external debug bridge
    // (mmio_* port) is master 0 (priority). This is the real CPU→peripheral
    // path that replaces the former 0xDEAD_BEEF tie-off.
    logic        cpu_mmio_valid;
    logic        cpu_mmio_write;
    logic [31:0] cpu_mmio_addr;
    logic [31:0] cpu_mmio_wdata;
    logic [3:0]  cpu_mmio_wstrb;
    logic [31:0] cpu_mmio_rdata;
    logic        cpu_mmio_ready;

    e1_axil_to_mmio u_cpu_axil_to_mmio (
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

    // ── 2-master MMIO arbiter (external debug bridge + CPU) ─────────────────
    // Merges the external debug/MMIO bridge (port mmio_*, priority) and the CPU
    // adapter (cpu_mmio_*) onto the single fabric bus (fab_*) consumed by the
    // decode, peripherals, behavioural DRAM, and real subsystem below. The
    // arbiter grant-locks per transaction so multi-cycle fabric regions are
    // never torn mid-access.
    logic        fab_valid;
    logic        fab_write;
    logic [31:0] fab_addr;
    logic [31:0] fab_wdata;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [3:0]  fab_wstrb;  // word-granular fabric ignores strobes
    /* verilator lint_on UNUSEDSIGNAL */
    logic [31:0] fab_rdata;
    logic        fab_ready;

    e1_mmio_arb2 u_mmio_arb (
        .clk        (clk),
        .rst_n      (rst_n),
        .m0_valid   (mmio_valid),
        .m0_write   (mmio_write),
        .m0_addr    (mmio_addr),
        .m0_wdata   (mmio_wdata),
        .m0_rdata   (mmio_rdata),
        .m0_ready   (mmio_ready),
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

    e1_bootrom u_bootrom (
        .addr(fab_addr[15:2]),
        .rdata(bootrom_rdata)
    );

    e1_peripherals u_peripherals (
        .clk(clk),
        .rst_n(rst_n),
        .valid(fab_valid && periph_sel),
        .write(fab_write),
        .addr(fab_addr[7:2]),
        .wdata(fab_wdata),
        .rdata(periph_rdata),
        .irq_timer(irq_timer),
        .gpio_out(gpio_out)
    );

    e1_dma u_dma (
        .clk(clk),
        .rst_n(rst_n),
        .valid(fab_valid && dma_sel),
        .write(fab_write),
        .addr(fab_addr[7:2]),
        .wdata(fab_wdata),
        .rdata(dma_rdata),
        .irq(irq_dma),
        .m_axil_awvalid(dma_m_awvalid),
        .m_axil_awready(dma_m_awready),
        .m_axil_awaddr(dma_m_awaddr),
        .m_axil_wvalid(dma_m_wvalid),
        .m_axil_wready(dma_m_wready),
        .m_axil_wdata(dma_m_wdata),
        .m_axil_wstrb(dma_m_wstrb),
        .m_axil_bvalid(dma_m_bvalid),
        .m_axil_bready(dma_m_bready),
        .m_axil_bresp(dma_m_bresp),
        .m_axil_arvalid(dma_m_arvalid),
        .m_axil_arready(dma_m_arready),
        .m_axil_araddr(dma_m_araddr),
        .m_axil_rvalid(dma_m_rvalid),
        .m_axil_rready(dma_m_rready),
        .m_axil_rdata(dma_m_rdata),
        .m_axil_rresp(dma_m_rresp)
    );

    e1_npu u_npu (
        .clk(clk),
        .rst_n(rst_n),
        .valid(fab_valid && npu_sel),
        .write(fab_write),
        .addr(fab_addr[7:2]),
        .wdata(fab_wdata),
        .rdata(npu_rdata),
        .irq(irq_npu),
        .m_axil_awvalid(npu_m_awvalid),
        .m_axil_awready(npu_m_awready),
        .m_axil_awaddr(npu_m_awaddr),
        .m_axil_wvalid(npu_m_wvalid),
        .m_axil_wready(npu_m_wready),
        .m_axil_wdata(npu_m_wdata),
        .m_axil_wstrb(npu_m_wstrb),
        .m_axil_bvalid(npu_m_bvalid),
        .m_axil_bready(npu_m_bready),
        .m_axil_bresp(npu_m_bresp),
        .m_axil_arvalid(npu_m_arvalid),
        .m_axil_arready(npu_m_arready),
        .m_axil_araddr(npu_m_araddr),
        .m_axil_rvalid(npu_m_rvalid),
        .m_axil_rready(npu_m_rready),
        .m_axil_rdata(npu_m_rdata),
        .m_axil_rresp(npu_m_rresp)
    );

    e1_display u_display (
        .clk(clk),
        .rst_n(rst_n),
        .valid(fab_valid && display_sel),
        .write(fab_write),
        .addr(fab_addr[7:2]),
        .wdata(fab_wdata),
        .rdata(display_rdata),
        .irq_vsync(irq_vsync),
        .scan_hsync(display_scan_hsync),
        .scan_vsync(display_scan_vsync),
        .scan_active(display_scan_active),
        .scan_x(display_scan_x),
        .scan_y(display_scan_y),
        .scan_fb_addr(display_scan_fb_addr),
        .scan_rgb(display_scan_rgb),
        .fb_read_valid(display_fb_read_valid),
        .fb_read_addr(display_fb_read_addr),
        .fb_read_data(display_fb_read_data),
        .fb_read_ready(display_fb_read_ready)
    );

    // NPU weight-staging SRAM. This is the first hard macro on the e1 SoC
    // floorplan; it carries the AlphaChip / DREAMPlace / OpenROAD macro-
    // placement evidence loop. Address window 0x1004_0000–0x1004_07FF
    // (2 KB, 512 x 32). Behavioral model in simulation, Sky130 OpenRAM
    // pre-built macro at signoff via E1_HAVE_HARD_SRAM.
    logic [31:0] wbuf_rdata;
    logic [3:0]  wbuf_wmask;
    /* verilator lint_off UNUSEDSIGNAL */
    logic [31:0] wbuf_p1_dout_unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign wbuf_wmask = {4{fab_write}};
    e1_weight_buffer_sram u_weight_buffer (
`ifdef USE_POWER_PINS
        .VPWR    (VPWR),
        .VGND    (VGND),
`endif
        .clk     (clk),
        .rst_n   (rst_n),
        .p0_csb  (~(fab_valid && wbuf_sel)),
        .p0_web  (~fab_write),
        .p0_wmask(wbuf_wmask),
        .p0_addr (fab_addr[10:2]),
        .p0_din  (fab_wdata),
        .p0_dout (wbuf_rdata),
        .p1_csb  (1'b1),
        .p1_addr (9'h0),
        .p1_dout (wbuf_p1_dout_unused)
    );

    // Which regions are served by the real subsystem (multi-cycle AXI shim)
    // vs the single-cycle legacy blocks. In the legacy config all of these
    // are 0 and the bus behaves exactly as before.
`ifdef E1_SOC_REAL_IRQ
    wire real_clint_region = clint_sel;
    wire real_plic_region  = rs_plic_sel;
`else
    wire real_clint_region = 1'b0;
    wire real_plic_region  = 1'b0;
`endif
`ifdef E1_SOC_REAL_DRAM
    wire real_dram_region  = dram_sel;
`else
    wire real_dram_region  = 1'b0;
`endif
    wire real_region = real_clint_region | real_plic_region | real_dram_region;

    // Fabric return path. fab_ready / fab_rdata feed the e1_mmio_arb2 instance
    // above, which routes them to whichever master (external debug bridge or
    // CPU) currently holds the grant.
    always_comb begin
        // Real-subsys regions hold the bus until the AXI(-Lite) transfer
        // drains (rs_mmio_ready); every legacy region completes in one cycle.
`ifdef E1_SOC_REAL_SUBSYS
        fab_ready = real_region ? (fab_valid & rs_mmio_ready)
                                : fab_valid;
`else
        fab_ready = fab_valid;
`endif
        // Legacy CLINT/DRAM arms are suppressed when the real subsystem owns
        // that region, so the case stays one-hot under `priority`.
        priority case (1'b1)
`ifdef E1_SOC_REAL_IRQ
            real_plic_region:                    fab_rdata = rs_plic_rdata;
            real_clint_region:                   fab_rdata = rs_clint_rdata;
`endif
`ifdef E1_SOC_REAL_DRAM
            real_dram_region:                    fab_rdata = rs_dram_rdata;
`endif
            bootrom_sel:                         fab_rdata = bootrom_rdata;
            periph_sel:                          fab_rdata = periph_rdata;
            dma_sel:                             fab_rdata = dma_rdata;
            npu_sel:                             fab_rdata = npu_rdata;
            display_sel:                         fab_rdata = display_rdata;
            wbuf_sel:                            fab_rdata = wbuf_rdata;
            (clint_sel && !real_clint_region):   fab_rdata = clint_rdata;
            (dram_sel  && !real_dram_region):    fab_rdata = mmio_dram_rdata;
            default:                             fab_rdata = 32'hDEAD_BEEF;
        endcase
    end

endmodule
