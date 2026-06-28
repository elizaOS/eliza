`timescale 1ns/1ps

module e1_pd_smoke_top (
    input  logic       CLK_IN,
    input  logic       RST_N,
    input  logic       DBG_VALID,
    input  logic       DBG_WRITE,
    input  logic [3:0] DBG_ADDR,
    input  logic [3:0] DBG_WDATA,
    output logic [3:0] DBG_RDATA,
    output logic       DBG_READY,
    output logic       IRQ_TIMER,
    output logic [3:0] GPIO
);

    logic [7:0] counter_q;
    logic [3:0] gpio_q;
    logic irq_q;

    always_ff @(posedge CLK_IN or negedge RST_N) begin
        if (!RST_N) begin
            counter_q <= 8'h00;
            gpio_q <= 4'h0;
            irq_q <= 1'b0;
        end else begin
            counter_q <= counter_q + 8'h01;
            irq_q <= &counter_q;
            if (DBG_VALID && DBG_WRITE && DBG_ADDR == 4'h1) begin
                gpio_q <= DBG_WDATA;
            end
        end
    end

    always_comb begin
        DBG_READY = DBG_VALID;
        case (DBG_ADDR)
            4'h0: DBG_RDATA = counter_q[3:0];
            4'h1: DBG_RDATA = gpio_q;
            4'h2: DBG_RDATA = {3'b000, irq_q};
            default: DBG_RDATA = 4'h0;
        endcase
    end

    assign IRQ_TIMER = irq_q;
    assign GPIO = gpio_q;

endmodule
