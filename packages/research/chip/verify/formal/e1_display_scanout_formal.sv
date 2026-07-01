`timescale 1ns/1ps

// Port-observable formal harness for e1_display_scanout.
//
// The harness programs a tiny 2x2 XR24 mode through the MMIO interface, holds
// the AXI read-data channel empty, and then checks the digital display
// boundary. This deliberately proves only the synthesizable controller
// contract: scan timing sidebands, fail-closed underflow pixels/status, and
// AXI read attributes. The DSI PHY/panel boundary remains a separate product
// integration gap tracked in the RTL work order.

import e1_axi4_pkg::*;

module e1_display_scanout_formal(input logic clk);

    logic rst_n = 1'b0;
    logic [7:0] cycle = 8'h0;

    logic        valid;
    logic        write;
    logic [5:0]  addr;
    logic [31:0] wdata;
    logic [31:0] rdata;

    logic        m_arvalid;
    logic        m_arready;
    logic [3:0]  m_arid;
    logic [31:0] m_araddr;
    logic [7:0]  m_arlen;
    logic [2:0]  m_arsize;
    logic [1:0]  m_arburst;
    logic [3:0]  m_arcache;
    logic [2:0]  m_arprot;
    logic [3:0]  m_arqos;

    logic        m_rvalid;
    logic        m_rready;
    logic [3:0]  m_rid;
    logic        m_rlast;
    logic [31:0] m_rdata;
    logic [1:0]  m_rresp;

    logic        pix_de;
    logic        pix_hsync;
    logic        pix_vsync;
    logic        pix_valid;
    logic [23:0] pix_data;
    logic        dcs_vsync_pulse;
    logic        irq_vsync;

    logic [31:0] formal_fb_base;
    logic [15:0] formal_h_active;
    logic [15:0] formal_v_active;
    logic [15:0] formal_h_count;
    logic [15:0] formal_v_count;
    logic [15:0] formal_h_total;
    logic [15:0] formal_v_total;
    logic [15:0] formal_v_sync_end;
    logic [31:0] formal_stride_bytes;
    logic [31:0] formal_format;
    logic        formal_enable;
    logic        formal_active;
    logic [15:0] formal_words_per_line;
    logic [31:0] formal_fetch_addr;
    logic [31:0] formal_line_start_addr;
    logic [15:0] formal_line_words_left;
    logic [15:0] formal_fetch_line;
    logic [15:0] formal_outstanding_cnt;
    logic [15:0] formal_fifo_level;
    logic [4:0]  formal_byte_cnt;
    logic        formal_prefetch_arm;
    logic        formal_line_realign;
    logic        formal_underflow_now;
    logic        formal_underflow_sticky;
    logic [31:0] formal_underflow_count;
    logic [31:0] formal_fetched_word_count;
    logic        formal_collect_en;
    logic        formal_fetch_busy;

    e1_display_scanout #(
        .FIFO_DEPTH(8),
        .OUTSTANDING(2)
    ) dut (
        .clk(clk),
        .rst_n(rst_n),
        .valid(valid),
        .write(write),
        .addr(addr),
        .wdata(wdata),
        .rdata(rdata),
        .m_arvalid(m_arvalid),
        .m_arready(m_arready),
        .m_arid(m_arid),
        .m_araddr(m_araddr),
        .m_arlen(m_arlen),
        .m_arsize(m_arsize),
        .m_arburst(m_arburst),
        .m_arcache(m_arcache),
        .m_arprot(m_arprot),
        .m_arqos(m_arqos),
        .m_rvalid(m_rvalid),
        .m_rready(m_rready),
        .m_rid(m_rid),
        .m_rlast(m_rlast),
        .m_rdata(m_rdata),
        .m_rresp(m_rresp),
        .pix_de(pix_de),
        .pix_hsync(pix_hsync),
        .pix_vsync(pix_vsync),
        .pix_valid(pix_valid),
        .pix_data(pix_data),
        .dcs_vsync_pulse(dcs_vsync_pulse),
        .irq_vsync(irq_vsync),
        .formal_fb_base(formal_fb_base),
        .formal_h_active(formal_h_active),
        .formal_v_active(formal_v_active),
        .formal_h_count(formal_h_count),
        .formal_v_count(formal_v_count),
        .formal_h_total(formal_h_total),
        .formal_v_total(formal_v_total),
        .formal_v_sync_end(formal_v_sync_end),
        .formal_stride_bytes(formal_stride_bytes),
        .formal_format(formal_format),
        .formal_enable(formal_enable),
        .formal_active(formal_active),
        .formal_words_per_line(formal_words_per_line),
        .formal_fetch_addr(formal_fetch_addr),
        .formal_line_start_addr(formal_line_start_addr),
        .formal_line_words_left(formal_line_words_left),
        .formal_fetch_line(formal_fetch_line),
        .formal_outstanding_cnt(formal_outstanding_cnt),
        .formal_fifo_level(formal_fifo_level),
        .formal_byte_cnt(formal_byte_cnt),
        .formal_prefetch_arm(formal_prefetch_arm),
        .formal_line_realign(formal_line_realign),
        .formal_underflow_now(formal_underflow_now),
        .formal_underflow_sticky(formal_underflow_sticky),
        .formal_underflow_count(formal_underflow_count),
        .formal_fetched_word_count(formal_fetched_word_count),
        .formal_collect_en(formal_collect_en),
        .formal_fetch_busy(formal_fetch_busy)
    );

    always_comb begin
        valid = 1'b0;
        write = 1'b0;
        addr  = 6'h0c; // observe underflow status whenever not writing
        wdata = 32'h0;

        unique case (cycle)
            8'd3: begin valid = 1'b1; write = 1'b1; addr = 6'h00; wdata = 32'h0000_1000; end
            8'd4: begin valid = 1'b1; write = 1'b1; addr = 6'h01; wdata = {16'd2, 16'd2}; end
            8'd5: begin valid = 1'b1; write = 1'b1; addr = 6'h02; wdata = {16'd1, 16'd1}; end
            8'd6: begin valid = 1'b1; write = 1'b1; addr = 6'h03; wdata = {16'd1, 16'd1}; end
            8'd7: begin valid = 1'b1; write = 1'b1; addr = 6'h04; wdata = {16'd1, 16'd1}; end
            8'd8: begin valid = 1'b1; write = 1'b1; addr = 6'h05; wdata = 32'd8; end
            8'd9: begin valid = 1'b1; write = 1'b1; addr = 6'h06; wdata = 32'h3432_5258; end
            8'd10: begin valid = 1'b1; write = 1'b1; addr = 6'h07; wdata = 32'h1; end
            8'd18: begin valid = 1'b1; write = 1'b1; addr = 6'h06; wdata = 32'h0000_0000; end
            8'd26: begin valid = 1'b1; write = 1'b1; addr = 6'h0C; wdata = 32'h1; end
            default: begin end
        endcase
    end

    always_ff @(posedge clk) begin
        cycle <= cycle + 8'd1;
        rst_n <= (cycle >= 8'd2);
    end

    // Keep the memory response channel empty so active pixels must exercise the
    // controller's defined fail-closed underflow path.
    assign m_arready = 1'b1;
    assign m_rvalid  = 1'b0;
    assign m_rlast   = 1'b0;
    assign m_rid     = 4'h0;
    assign m_rdata   = 32'h0;
    assign m_rresp   = RESP_OKAY;

    logic saw_active_underflow = 1'b0;
    logic saw_irq_vsync = 1'b0;
    logic saw_ar = 1'b0;
    logic saw_underflow_clear = 1'b0;
    logic [31:0] prev_araddr = 32'h0;
    logic [31:0] prev_line_start_addr = 32'h0;

    always_ff @(posedge clk) begin
        if (!rst_n) begin
            assert(!m_arvalid);
            assert(!pix_de);
            assert(!pix_hsync);
            assert(!pix_vsync);
            assert(!pix_valid);
            assert(!irq_vsync);
            assert(!dcs_vsync_pulse);
            assert(!formal_enable);
            assert(formal_fifo_level == 4'h0);
            assert(formal_byte_cnt == 5'h0);
            assert(formal_outstanding_cnt == '0);
        end else begin
            assert(dcs_vsync_pulse == pix_vsync);
            assert(pix_de == pix_valid);
            assert(pix_de == formal_active);
            assert(!irq_vsync || pix_vsync);
            if (cycle > 8'd10) begin
                assert(formal_h_count < formal_h_total);
                assert(formal_v_count < formal_v_total);
            end
            assert(formal_fifo_level <= 16'd8);
            assert(formal_byte_cnt <= 5'd12);
            assert(formal_outstanding_cnt <= 2);
            assert(m_rready == (formal_fifo_level < 16'd8));
            assert(!m_arvalid || formal_fetch_busy);
            assert(!m_arvalid || formal_line_words_left != 16'd0);

            if (cycle < 8'd12) begin
                assert(!m_arvalid);
                assert(!pix_de);
                assert(!pix_valid);
            end

            if (m_arvalid) begin
                saw_ar <= 1'b1;
                assert(m_arid == 4'h0);
                assert(m_araddr[1:0] == 2'b00);
                assert(m_arlen <= 8'd3);
                assert(m_arsize == SIZE_4B);
                assert(m_arburst == BURST_INCR);
                assert(m_arcache == CACHE_NORMAL_NON_CACHEABLE);
                assert(m_arprot == PROT_DATA_NS_PRIV);
                assert(m_arqos == QOS_DISPLAY_RT);
                assert(m_araddr == formal_fetch_addr);
                assert(m_araddr >= formal_line_start_addr);
                assert(m_araddr < formal_line_start_addr + {16'h0, formal_words_per_line, 2'b00});
                if (saw_ar && formal_line_start_addr == prev_line_start_addr) begin
                    assert(m_araddr >= prev_araddr);
                end
                prev_araddr <= m_araddr;
                prev_line_start_addr <= formal_line_start_addr;
            end

            if (pix_de) begin
                saw_active_underflow <= 1'b1;
                assert(pix_valid);
                assert(pix_data == 24'h00_0000);
                assert(formal_underflow_now);
            end

            if (formal_underflow_now) begin
                assert(pix_de);
                assert(pix_data == 24'h00_0000);
            end

            if (irq_vsync) begin
                saw_irq_vsync <= 1'b1;
            end

            if (cycle > 8'd19) begin
                assert(formal_fb_base == 32'h0000_1000);
                assert(formal_h_active == 16'd2);
                assert(formal_v_active == 16'd2);
                assert(formal_stride_bytes == 32'd8);
                assert(formal_format == 32'h3432_5258);
            end

            if (formal_prefetch_arm) begin
                assert(formal_h_count == 16'd0);
                assert(formal_v_count == formal_v_sync_end);
            end

            if (formal_line_realign) begin
                assert(formal_enable);
                assert(formal_h_count == formal_h_active);
            end

            if (saw_active_underflow && cycle < 8'd27 && !valid && addr == 6'h0c) begin
                assert(rdata[0]);
            end

            if ($past(rst_n) && $past(valid && write && addr == 6'h0C && wdata[0])) begin
                saw_underflow_clear <= 1'b1;
                assert(!formal_underflow_sticky || formal_underflow_now);
                assert(formal_underflow_count == 32'h0 || formal_underflow_now);
            end

            if (saw_underflow_clear && !formal_underflow_now) begin
                cover(!formal_underflow_sticky);
            end

            cover(saw_ar);
            cover(saw_active_underflow);
            cover(saw_irq_vsync);
        end
    end
endmodule
