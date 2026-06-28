`timescale 1ns/1ps

module e1_dbg_mmio_bridge (
    input  logic        clk,
    input  logic        rst_n,

    input  logic        dbg_valid,
    input  logic        dbg_launch,
    input  logic        dbg_write,
    input  logic [3:0]  dbg_addr,
    input  logic [3:0]  dbg_wdata,
    output logic [3:0]  dbg_rdata,
    output logic        dbg_ready,

    output logic        mmio_valid,
    output logic        mmio_write,
    output logic [31:0] mmio_addr,
    output logic [31:0] mmio_wdata,
    input  logic [31:0] mmio_rdata,
    input  logic        mmio_ready
);

    logic [31:0] addr_q;
    logic [31:0] wdata_q;
    logic [31:0] rdata_q;
    logic [2:0]  rsel_q;
    logic        launch;

    assign launch = dbg_valid && dbg_launch;

    assign mmio_valid = launch;
    assign mmio_write = dbg_write;
    assign mmio_addr  = addr_q;
    assign mmio_wdata = wdata_q;
    assign dbg_ready  = !launch || mmio_ready;

    always_comb begin
        dbg_rdata = rdata_q[{rsel_q, 2'b00} +: 4];
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            addr_q  <= 32'h0000_0000;
            wdata_q <= 32'h0000_0000;
            rdata_q <= 32'h0000_0000;
            rsel_q  <= 3'b000;
        end else if (dbg_valid) begin
            if (dbg_write && dbg_addr[3] == 1'b0) begin
                addr_q[{dbg_addr[2:0], 2'b00} +: 4] <= dbg_wdata;
            end else if (dbg_write && dbg_addr[3] == 1'b1) begin
                wdata_q[{dbg_addr[2:0], 2'b00} +: 4] <= dbg_wdata;
            end else if (!dbg_write && dbg_addr[3] == 1'b0) begin
                rsel_q <= dbg_addr[2:0];
            end

            if (launch && mmio_ready) begin
                rdata_q <= mmio_rdata;
            end
        end
    end

endmodule
