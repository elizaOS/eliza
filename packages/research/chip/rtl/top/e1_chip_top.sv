`timescale 1ns/1ps

module e1_chip_top (
`ifdef USE_POWER_PINS
    inout  wire        VPWR,
    inout  wire        VGND,
`endif
    input  logic       CLK_IN,
    input  logic       RST_N,

    input  logic       DBG_VALID,
    input  logic       DBG_LAUNCH,
    input  logic       DBG_WRITE,
    input  logic [3:0] DBG_ADDR,
    input  logic [3:0] DBG_WDATA,
    output logic [3:0] DBG_RDATA,
    output logic       DBG_READY,

    output logic       IRQ_TIMER,
    output logic       IRQ_DMA,
    output logic       IRQ_NPU,
    output logic       IRQ_VSYNC,
    output logic [7:0] GPIO,

    input  logic       TEST_MODE,
    input  logic       JTAG_TCK,
    input  logic       JTAG_TMS,
    input  logic       JTAG_TDI,
    output logic       JTAG_TDO
);

    logic rst_n_sync;
    logic mmio_valid;
    logic mmio_write;
    logic [31:0] mmio_addr;
    logic [31:0] mmio_wdata;
    logic [31:0] mmio_rdata;
    logic mmio_ready;
    logic msip_unused;
    logic mtip_unused;

    // ── IEEE 1149.1 JTAG TAP (rtl/dft/e1_jtag_tap.sv) ───────────────────────
    // The pad-facing JTAG port now drives a real TAP controller. TRST_N is
    // derived from the chip reset (no dedicated TRST pad in the v0 boundary).
    // TDO is driven from the TAP output and gated by tdo_oe so it is only
    // active in the Shift-DR/Shift-IR states, matching IEEE 1149.1 tri-state
    // pad behaviour (driven low otherwise to keep the simulated pad defined).
    // The decoded controller status (IR / capture/shift/update) is surfaced
    // for on-chip DFT consumers; only IDCODE/BYPASS data registers are live
    // until the boundary-scan register is generated from the final pad list
    // (see rtl/dft/e1_jtag_tap.sv and docs/pd/dft-strategy.md).
    logic jtag_tdo;
    logic jtag_tdo_oe;
    /* verilator lint_off UNUSEDSIGNAL */
    logic        jtag_test_logic_reset;
    logic        jtag_capture_dr;
    logic        jtag_shift_dr;
    logic        jtag_update_dr;
    logic [4:0]  jtag_ir;
    logic        unused_test_jtag;
    /* verilator lint_on UNUSEDSIGNAL */

    e1_jtag_tap u_jtag_tap (
        .tck              (JTAG_TCK),
        .tms              (JTAG_TMS),
        .tdi              (JTAG_TDI),
        .trst_n           (rst_n_sync),
        .tdo              (jtag_tdo),
        .tdo_oe           (jtag_tdo_oe),
        .test_logic_reset (jtag_test_logic_reset),
        .capture_dr       (jtag_capture_dr),
        .shift_dr         (jtag_shift_dr),
        .update_dr        (jtag_update_dr),
        .ir               (jtag_ir)
    );

    assign unused_test_jtag = ^{TEST_MODE, msip_unused, mtip_unused,
                                jtag_test_logic_reset, jtag_capture_dr,
                                jtag_shift_dr, jtag_update_dr, jtag_ir};
    assign JTAG_TDO = jtag_tdo_oe ? jtag_tdo : 1'b0;

    e1_reset_sync u_reset_sync (
        .clk(CLK_IN),
        .rst_n_async(RST_N),
        .rst_n_sync(rst_n_sync)
    );

    e1_dbg_mmio_bridge u_dbg_mmio_bridge (
        .clk(CLK_IN),
        .rst_n(rst_n_sync),
        .dbg_valid(DBG_VALID),
        .dbg_launch(DBG_LAUNCH),
        .dbg_write(DBG_WRITE),
        .dbg_addr(DBG_ADDR),
        .dbg_wdata(DBG_WDATA),
        .dbg_rdata(DBG_RDATA),
        .dbg_ready(DBG_READY),
        .mmio_valid(mmio_valid),
        .mmio_write(mmio_write),
        .mmio_addr(mmio_addr),
        .mmio_wdata(mmio_wdata),
        .mmio_rdata(mmio_rdata),
        .mmio_ready(mmio_ready)
    );

    e1_soc_top u_soc (
`ifdef USE_POWER_PINS
        .VPWR(VPWR),
        .VGND(VGND),
`endif
        .clk(CLK_IN),
        .rst_n(rst_n_sync),
        .mmio_valid(mmio_valid),
        .mmio_write(mmio_write),
        .mmio_addr(mmio_addr),
        .mmio_wdata(mmio_wdata),
        .mmio_rdata(mmio_rdata),
        .mmio_ready(mmio_ready),
        .irq_timer(IRQ_TIMER),
        .irq_dma(IRQ_DMA),
        .irq_npu(IRQ_NPU),
        .irq_vsync(IRQ_VSYNC),
        .msip_o(msip_unused),
        .mtip_o(mtip_unused),
        .gpio_out(GPIO)
    );

endmodule
