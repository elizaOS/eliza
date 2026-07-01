`timescale 1ns/1ps

module e1_peripherals (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,
    output logic        irq_timer,
    output logic [7:0]  gpio_out
);
    logic [31:0] timer_count;
    logic [31:0] timer_compare;
    logic [31:0] scratch;

    assign irq_timer = timer_compare != 32'h0 && timer_count >= timer_compare;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            timer_count <= 32'h0;
            timer_compare <= 32'h0;
            scratch <= 32'h0;
            gpio_out <= 8'h0;
        end else begin
            timer_count <= timer_count + 32'h1;
            if (valid && write) begin
                unique case (addr)
                    6'h01: scratch <= wdata;
                    6'h02: gpio_out <= wdata[7:0];
                    6'h04: timer_compare <= wdata;
                    default: begin end
                endcase
            end
        end
    end

    always_comb begin
        unique case (addr)
            6'h00: rdata = 32'h1000_0001;
            6'h01: rdata = scratch;
            6'h02: rdata = {24'h0, gpio_out};
            6'h03: rdata = timer_count;
            6'h04: rdata = timer_compare;
            6'h05: rdata = {31'h0, irq_timer};
            default: rdata = 32'h0;
        endcase
    end
endmodule
