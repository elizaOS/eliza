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

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_test_jtag;
    /* verilator lint_on UNUSEDSIGNAL */

    assign unused_test_jtag = ^{TEST_MODE, JTAG_TCK, JTAG_TMS, JTAG_TDI, msip_unused, mtip_unused};
    assign JTAG_TDO = 1'b0;

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
