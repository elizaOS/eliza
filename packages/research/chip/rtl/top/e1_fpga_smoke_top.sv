`timescale 1ns/1ps

// Small ULX3S-facing smoke top for the open FPGA toolchain release evidence.
// This intentionally exercises the same board-level pins as e1_chip_top
// without pulling the full SoC/NPU memory fabric into ECP5 synthesis.
module e1_fpga_smoke_top (
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

    logic [23:0] counter_q;
    logic [7:0]  gpio_q;
    logic [3:0]  irq_q;
    logic        launched_q;

    always_ff @(posedge CLK_IN or negedge RST_N) begin
        if (!RST_N) begin
            counter_q  <= 24'h0;
            gpio_q     <= 8'h00;
            irq_q      <= 4'h0;
            launched_q <= 1'b0;
        end else begin
            counter_q <= counter_q + 24'h1;
            irq_q <= {
                counter_q[23],
                counter_q[22],
                counter_q[21],
                counter_q[20]
            };
            if (DBG_VALID && DBG_LAUNCH) begin
                launched_q <= 1'b1;
            end
            if (DBG_VALID && DBG_WRITE && DBG_ADDR == 4'h1) begin
                gpio_q <= {DBG_WDATA, DBG_WDATA};
            end
        end
    end

    always_comb begin
        DBG_READY = DBG_VALID;
        unique case (DBG_ADDR)
            4'h0: DBG_RDATA = counter_q[23:20];
            4'h1: DBG_RDATA = gpio_q[3:0];
            4'h2: DBG_RDATA = irq_q;
            4'h3: DBG_RDATA = {TEST_MODE, launched_q, JTAG_TCK, JTAG_TMS};
            default: DBG_RDATA = {3'b000, JTAG_TDI};
        endcase
    end

    assign GPIO = gpio_q ^ {8{launched_q}};
    assign {IRQ_TIMER, IRQ_DMA, IRQ_NPU, IRQ_VSYNC} = irq_q;
    assign JTAG_TDO = JTAG_TDI ^ JTAG_TMS ^ JTAG_TCK ^ TEST_MODE;

endmodule
