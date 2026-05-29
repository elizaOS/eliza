`timescale 1ns/1ps

module e1_dma (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,
    output logic        irq,

    output logic        m_axil_awvalid,
    input  logic        m_axil_awready,
    output logic [31:0] m_axil_awaddr,
    output logic        m_axil_wvalid,
    input  logic        m_axil_wready,
    output logic [31:0] m_axil_wdata,
    output logic [3:0]  m_axil_wstrb,
    input  logic        m_axil_bvalid,
    output logic        m_axil_bready,
    input  logic [1:0]  m_axil_bresp,

    output logic        m_axil_arvalid,
    input  logic        m_axil_arready,
    output logic [31:0] m_axil_araddr,
    input  logic        m_axil_rvalid,
    output logic        m_axil_rready,
    input  logic [31:0] m_axil_rdata,
    input  logic [1:0]  m_axil_rresp
`ifdef FORMAL
    ,
    output logic [31:0] formal_status,
    output logic [31:0] formal_len,
    output logic [31:0] formal_bytes_done,
    output logic [31:0] formal_beats_issued,
    output logic [31:0] formal_read_beats,
    output logic [31:0] formal_write_beats,
    output logic [31:0] formal_error_count,
    output logic [31:0] formal_remaining,
    output logic [31:0] formal_cur_src,
    output logic [31:0] formal_cur_dst,
    output logic [2:0]  formal_state,
    output logic        formal_write_addr_sent,
    output logic        formal_write_data_sent,
    output logic        formal_unsupported_align
`endif
);
    localparam logic [2:0] DMA_IDLE   = 3'd0;
    localparam logic [2:0] DMA_READ   = 3'd1;
    localparam logic [2:0] DMA_WRITE  = 3'd2;
    localparam logic [2:0] DMA_WRESP  = 3'd3;
    localparam logic [2:0] DMA_DONE   = 3'd4;

    logic [31:0] src;
    logic [31:0] dst;
    logic [31:0] len;
    logic [31:0] status;
    logic [31:0] cfg;
    logic [31:0] bytes_done;
    logic [31:0] beats_issued;
    logic [31:0] cur_src;
    logic [31:0] cur_dst;
    logic [31:0] remaining;
    logic [31:0] last_src;
    logic [31:0] last_dst;
    logic [31:0] read_data_q;
    logic [31:0] read_beats;
    logic [31:0] write_beats;
    logic [31:0] error_count;
    logic [3:0]  last_wstrb;
    logic [2:0]  state;
    logic        read_addr_sent;
    logic        write_addr_sent;
    logic        write_data_sent;

    wire clear_req = valid && write && addr == 6'h03 && wdata[1];
    wire unsupported_align = (src[1:0] != 2'b00) || (dst[1:0] != 2'b00);
    wire [3:0] next_wstrb = (remaining >= 32'd4) ? 4'hF :
                             ((4'h1 << remaining[1:0]) - 4'h1);
    wire [31:0] beat_bytes = (remaining >= 32'd4) ? 32'd4 : remaining;
    wire read_fire = m_axil_arvalid && m_axil_arready;
    wire read_done = m_axil_rvalid && m_axil_rready;
    wire write_addr_fire = m_axil_awvalid && m_axil_awready;
    wire write_data_fire = m_axil_wvalid && m_axil_wready;
    wire write_issue_done = (write_addr_sent || write_addr_fire) &&
                            (write_data_sent || write_data_fire);
    wire write_done = m_axil_bvalid && m_axil_bready;

    assign irq = status[1];

    assign m_axil_arvalid = status[0] && state == DMA_READ && !read_addr_sent;
    assign m_axil_araddr  = cur_src;
    assign m_axil_rready  = status[0] && state == DMA_READ;
    assign m_axil_awvalid = status[0] && state == DMA_WRITE && !write_addr_sent;
    assign m_axil_awaddr  = cur_dst;
    assign m_axil_wvalid  = status[0] && state == DMA_WRITE && !write_data_sent;
    assign m_axil_wdata   = read_data_q;
    assign m_axil_wstrb   = next_wstrb;
    assign m_axil_bready  = status[0] && state == DMA_WRESP;

`ifdef FORMAL
    assign formal_status = status;
    assign formal_len = len;
    assign formal_bytes_done = bytes_done;
    assign formal_beats_issued = beats_issued;
    assign formal_read_beats = read_beats;
    assign formal_write_beats = write_beats;
    assign formal_error_count = error_count;
    assign formal_remaining = remaining;
    assign formal_cur_src = cur_src;
    assign formal_cur_dst = cur_dst;
    assign formal_state = state;
    assign formal_write_addr_sent = write_addr_sent;
    assign formal_write_data_sent = write_data_sent;
    assign formal_unsupported_align = unsupported_align;
`endif

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            src <= 32'h0;
            dst <= 32'h0;
            len <= 32'h0;
            status <= 32'h0;
            cfg <= 32'h0000_0004;
            bytes_done <= 32'h0;
            beats_issued <= 32'h0;
            cur_src <= 32'h0;
            cur_dst <= 32'h0;
            remaining <= 32'h0;
            last_src <= 32'h0;
            last_dst <= 32'h0;
            read_data_q <= 32'h0;
            read_beats <= 32'h0;
            write_beats <= 32'h0;
            error_count <= 32'h0;
            last_wstrb <= 4'h0;
            state <= DMA_IDLE;
            read_addr_sent <= 1'b0;
            write_addr_sent <= 1'b0;
            write_data_sent <= 1'b0;
        end else begin
            status[3] <= 1'b0;
            status[4] <= 1'b0;

            if (clear_req) begin
                status[1] <= 1'b0;
                status[2] <= 1'b0;
            end

            if (status[0]) begin
                unique case (state)
                    DMA_READ: begin
                        if (read_fire) begin
                            last_src <= cur_src;
                            status[3] <= 1'b1;
                            read_addr_sent <= 1'b1;
                        end
                        if (read_done) begin
                            read_data_q <= m_axil_rdata;
                            read_beats <= read_beats + 32'd1;
                            read_addr_sent <= 1'b0;
                            if (m_axil_rresp != 2'b00) begin
                                status[0] <= 1'b0;
                                status[1] <= 1'b1;
                                status[2] <= 1'b1;
                                error_count <= error_count + 32'd1;
                                state <= DMA_IDLE;
                            end else begin
                                state <= DMA_WRITE;
                            end
                        end
                    end
                    DMA_WRITE: begin
                        if (write_addr_fire) begin
                            write_addr_sent <= 1'b1;
                        end
                        if (write_data_fire) begin
                            write_data_sent <= 1'b1;
                        end
                        if (write_issue_done) begin
                            last_dst <= cur_dst;
                            last_wstrb <= next_wstrb;
                            status[4] <= 1'b1;
                            beats_issued <= beats_issued + 32'd1;
                            write_beats <= write_beats + 32'd1;
                            write_addr_sent <= 1'b0;
                            write_data_sent <= 1'b0;
                            state <= DMA_WRESP;
                        end
                    end
                    DMA_WRESP: begin
                        if (write_done) begin
                            if (m_axil_bresp != 2'b00) begin
                                status[0] <= 1'b0;
                                status[1] <= 1'b1;
                                status[2] <= 1'b1;
                                error_count <= error_count + 32'd1;
                                state <= DMA_IDLE;
                                read_addr_sent <= 1'b0;
                                write_addr_sent <= 1'b0;
                                write_data_sent <= 1'b0;
                            end else if (remaining <= 32'd4) begin
                                bytes_done <= bytes_done + beat_bytes;
                                remaining <= 32'h0;
                                state <= DMA_DONE;
                            end else begin
                                bytes_done <= bytes_done + 32'd4;
                                remaining <= remaining - 32'd4;
                                cur_src <= cur_src + 32'd4;
                                cur_dst <= cur_dst + 32'd4;
                                state <= DMA_READ;
                            end
                        end
                    end
                    DMA_DONE: begin
                        status[0] <= 1'b0;
                        status[1] <= 1'b1;
                        state <= DMA_IDLE;
                    end
                    default: begin
                        state <= DMA_IDLE;
                        status[0] <= 1'b0;
                        read_addr_sent <= 1'b0;
                        write_addr_sent <= 1'b0;
                        write_data_sent <= 1'b0;
                    end
                endcase
            end

            if (valid && write) begin
                unique case (addr)
                    6'h00: src <= wdata;
                    6'h01: dst <= wdata;
                    6'h02: len <= wdata;
                    6'h04: cfg <= wdata;
                    6'h03: begin
                        if (wdata[0] && !status[0]) begin
                            bytes_done <= 32'h0;
                            beats_issued <= 32'h0;
                            read_beats <= 32'h0;
                            write_beats <= 32'h0;
                            error_count <= 32'h0;
                            cur_src <= src;
                            cur_dst <= dst;
                            last_src <= src;
                            last_dst <= dst;
                            remaining <= len;
                            last_wstrb <= 4'h0;
                            read_addr_sent <= 1'b0;
                            write_addr_sent <= 1'b0;
                            write_data_sent <= 1'b0;
                            if (unsupported_align) begin
                                status <= 32'h0000_0006;
                                error_count <= 32'd1;
                                state <= DMA_IDLE;
                            end else if (len == 32'h0) begin
                                status <= 32'h0000_0002;
                                state <= DMA_IDLE;
                            end else begin
                                status <= 32'h0000_0001;
                                state <= DMA_READ;
                            end
                        end
                    end
                    default: begin end
                endcase
            end
        end
    end

    always_comb begin
        unique case (addr)
            6'h00: rdata = src;
            6'h01: rdata = dst;
            6'h02: rdata = len;
            6'h03: rdata = status;
            6'h04: rdata = cfg;
            6'h05: rdata = bytes_done;
            6'h06: rdata = beats_issued;
            6'h07: rdata = cur_src;
            6'h08: rdata = cur_dst;
            6'h09: rdata = last_src;
            6'h0a: rdata = last_dst;
            6'h0b: rdata = {21'h0, last_wstrb, 4'h0, state};
            6'h0c: rdata = read_beats;
            6'h0d: rdata = write_beats;
            6'h0e: rdata = error_count;
            default: rdata = 32'h0;
        endcase
    end
endmodule
