`timescale 1ns/1ps

module e1_npu_formal(input logic clk);
    logic rst_n = 1'b0;
    (* anyseq *) logic valid;
    (* anyseq *) logic write;
    (* anyseq *) logic [5:0] addr;
    (* anyseq *) logic [31:0] wdata;
    logic [31:0] rdata;
    logic irq;
    logic m_axil_awvalid;
    logic [31:0] m_axil_awaddr;
    logic m_axil_wvalid;
    logic [31:0] m_axil_wdata;
    logic [3:0] m_axil_wstrb;
    logic m_axil_bready;
    logic m_axil_arvalid;
    logic [31:0] m_axil_araddr;
    logic m_axil_rready;
    logic [3:0] opcode_shadow = 4'h0;
    logic [31:0] op_a_shadow = 32'h0;
    logic [31:0] op_b_shadow = 32'h0;
    logic [31:0] acc_shadow = 32'h0;

    e1_npu dut (
        .clk(clk),
        .rst_n(rst_n),
        .valid(valid),
        .write(write),
        .addr(addr),
        .wdata(wdata),
        .rdata(rdata),
        .irq(irq),
        .m_axil_awvalid(m_axil_awvalid),
        .m_axil_awready(1'b0),
        .m_axil_awaddr(m_axil_awaddr),
        .m_axil_wvalid(m_axil_wvalid),
        .m_axil_wready(1'b0),
        .m_axil_wdata(m_axil_wdata),
        .m_axil_wstrb(m_axil_wstrb),
        .m_axil_bvalid(1'b0),
        .m_axil_bready(m_axil_bready),
        .m_axil_bresp(2'b00),
        .m_axil_arvalid(m_axil_arvalid),
        .m_axil_arready(1'b0),
        .m_axil_araddr(m_axil_araddr),
        .m_axil_rvalid(1'b0),
        .m_axil_rready(m_axil_rready),
        .m_axil_rdata(32'h0),
        .m_axil_rresp(2'b00)
    );

    initial rst_n = 1'b0;

    always_ff @(posedge clk) begin
        rst_n <= 1'b1;
        assume(addr < 6'h08);
        assume(!(rst_n && valid && write && addr == 6'h03 && wdata[0]));

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

        if (rst_n && addr == 6'h04) begin
            assert(rdata == {28'h0, opcode_shadow});
        end

        if (rst_n && addr == 6'h00) begin
            assert(rdata == op_a_shadow);
        end

        if (rst_n && addr == 6'h01) begin
            assert(rdata == op_b_shadow);
        end

        if (rst_n && addr == 6'h05) begin
            assert(rdata == acc_shadow);
        end

        if (rst_n && addr == 6'h07) begin
            assert(rdata[31:7] == 25'h0);
        end

        if (rst_n) begin
            assert(!m_axil_arvalid);
            assert(!m_axil_rready);
        end

        if (rst_n && valid && write && addr == 6'h04) begin
            opcode_shadow <= wdata[3:0];
        end

        if (rst_n && valid && write && addr == 6'h00) begin
            op_a_shadow <= wdata;
        end

        if (rst_n && valid && write && addr == 6'h01) begin
            op_b_shadow <= wdata;
        end

        if (rst_n && valid && write && addr == 6'h05) begin
            acc_shadow <= wdata;
        end

    end
endmodule
