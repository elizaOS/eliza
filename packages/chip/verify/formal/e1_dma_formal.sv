`timescale 1ns/1ps

module e1_dma_formal(input logic clk);
    logic rst_n = 1'b0;
    (* anyseq *) logic valid;
    (* anyseq *) logic write;
    (* anyseq *) logic [5:0] addr;
    (* anyseq *) logic [31:0] wdata;
    logic [31:0] rdata;
    logic irq;
    (* anyseq *) logic m_axil_awready;
    (* anyseq *) logic m_axil_wready;
    (* anyseq *) logic m_axil_bvalid;
    (* anyseq *) logic [1:0] m_axil_bresp;
    (* anyseq *) logic m_axil_arready;
    (* anyseq *) logic m_axil_rvalid;
    (* anyseq *) logic [31:0] m_axil_rdata;
    (* anyseq *) logic [1:0] m_axil_rresp;
    logic m_axil_awvalid;
    logic [31:0] m_axil_awaddr;
    logic m_axil_wvalid;
    logic [31:0] m_axil_wdata;
    logic [3:0] m_axil_wstrb;
    logic m_axil_bready;
    logic m_axil_arvalid;
    logic [31:0] m_axil_araddr;
    logic m_axil_rready;

    e1_dma dut (
        .clk(clk),
        .rst_n(rst_n),
        .valid(valid),
        .write(write),
        .addr(addr),
        .wdata(wdata),
        .rdata(rdata),
        .irq(irq),
        .m_axil_awvalid(m_axil_awvalid),
        .m_axil_awready(m_axil_awready),
        .m_axil_awaddr(m_axil_awaddr),
        .m_axil_wvalid(m_axil_wvalid),
        .m_axil_wready(m_axil_wready),
        .m_axil_wdata(m_axil_wdata),
        .m_axil_wstrb(m_axil_wstrb),
        .m_axil_bvalid(m_axil_bvalid),
        .m_axil_bready(m_axil_bready),
        .m_axil_bresp(m_axil_bresp),
        .m_axil_arvalid(m_axil_arvalid),
        .m_axil_arready(m_axil_arready),
        .m_axil_araddr(m_axil_araddr),
        .m_axil_rvalid(m_axil_rvalid),
        .m_axil_rready(m_axil_rready),
        .m_axil_rdata(m_axil_rdata),
        .m_axil_rresp(m_axil_rresp)
    );

    initial rst_n = 1'b0;

    always_ff @(posedge clk) begin
        rst_n <= 1'b1;
        assume(addr < 6'h0c);

        if (!$past(rst_n)) begin
            assert(!irq);
        end

        if (rst_n && addr == 6'h03) begin
            assert(irq == rdata[1]);
            assert(!(rdata[0] && rdata[1]));
            assert(!(rdata[0] && rdata[2]));
            if (rdata[2]) begin
                assert(rdata[1]);
                assert(irq);
            end
        end

        if (rst_n && irq && addr == 6'h03) begin
            assert(rdata[1]);
        end

        if (rst_n && addr == 6'h0b) begin
            assert(rdata[6:3] == 4'h0);
            assert(rdata[31:11] == 21'h0);
        end

        if (rst_n) begin
            assert(!m_axil_arvalid || m_axil_rready);
            assert(!(m_axil_arvalid && m_axil_awvalid));

            if (m_axil_arvalid) begin
                assert(m_axil_araddr[1:0] == 2'b00);
            end

            if (m_axil_awvalid) begin
                assert(m_axil_awaddr[1:0] == 2'b00);
                assert(m_axil_wstrb == 4'h1 ||
                       m_axil_wstrb == 4'h3 ||
                       m_axil_wstrb == 4'h7 ||
                       m_axil_wstrb == 4'hf);
            end
        end
    end
endmodule
