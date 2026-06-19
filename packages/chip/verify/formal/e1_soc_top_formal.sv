`timescale 1ns/1ps

module e1_soc_top_formal(input logic clk);
    logic rst_n = 1'b0;
    (* anyseq *) logic mmio_valid;
    (* anyseq *) logic mmio_write;
    (* anyseq *) logic [31:0] mmio_addr;
    (* anyseq *) logic [31:0] mmio_wdata;
    logic [31:0] mmio_rdata;
    logic mmio_ready;
    logic irq_timer;
    logic irq_dma;
    logic irq_npu;
    logic irq_vsync;
    logic msip_o;
    logic mtip_o;
    logic [7:0] gpio_out;

    e1_soc_top dut (
        .clk(clk),
        .rst_n(rst_n),
        .mmio_valid(mmio_valid),
        .mmio_write(mmio_write),
        .mmio_addr(mmio_addr),
        .mmio_wdata(mmio_wdata),
        .mmio_rdata(mmio_rdata),
        .mmio_ready(mmio_ready),
        .irq_timer(irq_timer),
        .irq_dma(irq_dma),
        .irq_npu(irq_npu),
        .irq_vsync(irq_vsync),
        .msip_o(msip_o),
        .mtip_o(mtip_o),
        .gpio_out(gpio_out)
    );

    initial rst_n = 1'b0;

    wire implemented_window = mmio_addr[11:8] == 4'h0 && mmio_addr[1:0] == 2'b00;
    wire bootrom_sel = mmio_addr[1:0] == 2'b00 && mmio_addr[31:16] == 16'h0000;
    wire periph_sel  = implemented_window && mmio_addr[31:12] == 20'h1000_0;
    wire dma_sel     = implemented_window && mmio_addr[31:12] == 20'h1001_0;
    wire npu_sel     = implemented_window && mmio_addr[31:12] == 20'h1002_0;
    wire display_sel = implemented_window && mmio_addr[31:12] == 20'h1003_0;
    wire clint_sel   = mmio_addr[1:0] == 2'b00 && mmio_addr[31:16] == 16'h0200 &&
                       mmio_addr[15:14] != 2'b11;
    wire dram_sel    = mmio_addr[1:0] == 2'b00 && mmio_addr[31:12] == 20'h8000_0;
    wire mapped = bootrom_sel || periph_sel || dma_sel || npu_sel || display_sel ||
                  clint_sel || dram_sel;

    always_ff @(posedge clk) begin
        rst_n <= 1'b1;

        assert(mmio_ready == mmio_valid);

        if (rst_n && mmio_valid && !mapped) begin
            assert(mmio_rdata == 32'hDEAD_BEEF);
        end

        if (rst_n && mmio_valid && bootrom_sel && mmio_addr[15:2] == 14'h0000) begin
            assert(mmio_rdata == 32'h4F50_534F);
        end

        if (rst_n && mmio_valid && clint_sel && mmio_addr[15:2] == 14'h0000) begin
            assert(mmio_rdata[31:1] == 31'h0);
        end

        if (rst_n && mmio_valid && mmio_addr[31:16] == 16'h0200 && mmio_addr[15:14] == 2'b11) begin
            assert(mmio_rdata == 32'hDEAD_BEEF);
        end

        if (rst_n && gpio_out != 8'h0) begin
            assert($past(rst_n));
        end
    end
endmodule
