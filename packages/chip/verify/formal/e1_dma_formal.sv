`timescale 1ns/1ps

module e1_dma_formal(input logic clk);
    logic rst_n = 1'b0;
    (* anyseq *) logic valid;
    (* anyseq *) logic write;
    (* anyseq *) logic [5:0] addr;
    (* anyseq *) logic [31:0] wdata;
    logic [31:0] rdata;
    logic irq;
    logic [31:0] active_len;
    logic        tracking_transfer;
    logic        accepted_start;
    logic        write_issue_done_observed;
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
    logic [31:0] formal_status;
    logic [31:0] formal_len;
    logic [31:0] formal_bytes_done;
    logic [31:0] formal_beats_issued;
    logic [31:0] formal_read_beats;
    logic [31:0] formal_write_beats;
    logic [31:0] formal_error_count;
    logic [31:0] formal_remaining;
    logic [31:0] formal_cur_src;
    logic [31:0] formal_cur_dst;
    logic [2:0]  formal_state;
    logic        formal_write_addr_sent;
    logic        formal_write_data_sent;
    logic        formal_unsupported_align;

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
        .m_axil_rresp(m_axil_rresp),
        .formal_status(formal_status),
        .formal_len(formal_len),
        .formal_bytes_done(formal_bytes_done),
        .formal_beats_issued(formal_beats_issued),
        .formal_read_beats(formal_read_beats),
        .formal_write_beats(formal_write_beats),
        .formal_error_count(formal_error_count),
        .formal_remaining(formal_remaining),
        .formal_cur_src(formal_cur_src),
        .formal_cur_dst(formal_cur_dst),
        .formal_state(formal_state),
        .formal_write_addr_sent(formal_write_addr_sent),
        .formal_write_data_sent(formal_write_data_sent),
        .formal_unsupported_align(formal_unsupported_align)
    );

    initial rst_n = 1'b0;

    assign accepted_start = rst_n && valid && write && addr == 6'h03 && wdata[0] && !formal_status[0];
    assign write_issue_done_observed =
        (formal_write_addr_sent || (m_axil_awvalid && m_axil_awready)) &&
        (formal_write_data_sent || (m_axil_wvalid && m_axil_wready));

    always_ff @(posedge clk) begin
        rst_n <= 1'b1;
        assume(addr < 6'h0f);

        if (!rst_n) begin
            active_len <= 32'h0;
            tracking_transfer <= 1'b0;
        end else begin
            if (accepted_start) begin
                active_len <= formal_len;
                tracking_transfer <= formal_len != 32'h0 && !formal_unsupported_align;
            end else if (!formal_status[0]) begin
                tracking_transfer <= 1'b0;
            end
        end

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
            assert(formal_state <= 3'd4);
            assert(formal_write_beats == formal_beats_issued);
            assert(formal_read_beats == formal_write_beats ||
                   formal_read_beats == formal_write_beats + 32'd1);
            assert(formal_bytes_done <= active_len || !tracking_transfer);
            assert(!formal_status[0] || formal_state == 3'd4 || formal_remaining != 32'h0);
            assert(!formal_status[0] || formal_cur_src[1:0] == 2'b00);
            assert(!formal_status[0] || formal_cur_dst[1:0] == 2'b00);
            assert(!formal_status[2] || formal_status[1]);
            assert(irq == formal_status[1]);

            assert(!m_axil_arvalid || m_axil_rready);
            assert(!(m_axil_arvalid && m_axil_awvalid));
            assert(!(m_axil_arvalid && m_axil_wvalid));
            assert(!(m_axil_bready && (m_axil_awvalid || m_axil_wvalid)));

            if (m_axil_arvalid) begin
                assert(m_axil_araddr[1:0] == 2'b00);
                assert(formal_state == 3'd1);
            end

            if (m_axil_awvalid) begin
                assert(m_axil_awaddr[1:0] == 2'b00);
                assert(formal_state == 3'd2);
                assert(m_axil_wstrb == 4'h1 ||
                       m_axil_wstrb == 4'h3 ||
                       m_axil_wstrb == 4'h7 ||
                       m_axil_wstrb == 4'hf);
            end

            if (m_axil_wvalid) begin
                assert(formal_state == 3'd2);
                assert(m_axil_wstrb == 4'h1 ||
                       m_axil_wstrb == 4'h3 ||
                       m_axil_wstrb == 4'h7 ||
                       m_axil_wstrb == 4'hf);
            end

            if (formal_status[3]) begin
                assert($past(formal_state) == 3'd1);
                assert($past(m_axil_arvalid && m_axil_arready));
            end

            if (formal_status[4]) begin
                assert($past(formal_state) == 3'd2);
                assert($past(write_issue_done_observed));
                assert(formal_beats_issued == $past(formal_beats_issued) + 32'd1);
                assert(formal_write_beats == $past(formal_write_beats) + 32'd1);
            end else if (!$past(accepted_start) && !accepted_start) begin
                assert(formal_beats_issued <= $past(formal_beats_issued) + 32'd1);
                assert(formal_write_beats <= $past(formal_write_beats) + 32'd1);
            end

            if ($past(formal_state) == 3'd3 &&
                $past(m_axil_bvalid && m_axil_bready && m_axil_bresp == 2'b00)) begin
                assert(formal_bytes_done == $past(formal_bytes_done) +
                       (($past(formal_remaining) >= 32'd4) ? 32'd4 : $past(formal_remaining)));
            end

            if ($past(m_axil_rvalid && m_axil_rready && m_axil_rresp != 2'b00) ||
                $past(m_axil_bvalid && m_axil_bready && m_axil_bresp != 2'b00)) begin
                assert(formal_status[1]);
                assert(formal_status[2]);
                assert(!formal_status[0]);
                assert(formal_error_count == $past(formal_error_count) + 32'd1);
            end

            if ($past(valid && write && addr == 6'h03 && wdata[1]) &&
                !$past(accepted_start) &&
                !$past(formal_status[0]) &&
                $past(formal_state) != 3'd4 &&
                !$past(m_axil_rvalid && m_axil_rready && m_axil_rresp != 2'b00) &&
                !$past(m_axil_bvalid && m_axil_bready && m_axil_bresp != 2'b00)) begin
                assert(!formal_status[1]);
                assert(!formal_status[2]);
            end
        end
    end
endmodule
