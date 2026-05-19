`timescale 1ns/1ps

module e1_dbg_mmio_bridge_formal;
    logic clk;
    logic rst_n;
    logic dbg_valid;
    logic dbg_launch;
    logic dbg_write;
    logic [3:0] dbg_addr;
    logic [3:0] dbg_wdata;
    logic [3:0] dbg_rdata;
    logic dbg_ready;
    logic mmio_valid;
    logic mmio_write;
    logic [31:0] mmio_addr;
    logic [31:0] mmio_wdata;
    logic [31:0] mmio_rdata;
    logic mmio_ready;

    initial clk = 1'b0;
    always #1 clk = !clk;

    e1_dbg_mmio_bridge dut (
        .clk(clk),
        .rst_n(rst_n),
        .dbg_valid(dbg_valid),
        .dbg_launch(dbg_launch),
        .dbg_write(dbg_write),
        .dbg_addr(dbg_addr),
        .dbg_wdata(dbg_wdata),
        .dbg_rdata(dbg_rdata),
        .dbg_ready(dbg_ready),
        .mmio_valid(mmio_valid),
        .mmio_write(mmio_write),
        .mmio_addr(mmio_addr),
        .mmio_wdata(mmio_wdata),
        .mmio_rdata(mmio_rdata),
        .mmio_ready(mmio_ready)
    );

    initial begin
        rst_n = 1'b0;
        assume(dbg_valid == 1'b0);
        assume(dbg_launch == 1'b0);
        assume(mmio_ready == 1'b1);
        #4 rst_n = 1'b1;
    end

    always_ff @(posedge clk) begin
        assume(mmio_ready == 1'b1);

        if (!rst_n) begin
            assert(mmio_valid == 1'b0);
            assert(mmio_write == 1'b0);
            assert(mmio_addr == 32'h0000_0000);
            assert(mmio_wdata == 32'h0000_0000);
        end else begin
            assert(mmio_valid == (dbg_valid && dbg_launch));
            if (mmio_valid) begin
                assert(mmio_write == dbg_write);
            end
            assert(dbg_ready == 1'b1);
        end
    end
endmodule
