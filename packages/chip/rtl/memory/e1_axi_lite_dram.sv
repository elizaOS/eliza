`timescale 1ns/1ps

module e1_axi_lite_dram #(
    parameter int unsigned ADDR_WIDTH  = 16,
    parameter int unsigned DEPTH_WORDS = 1024
) (
    input  logic        clk,
    input  logic        rst_n,

    input  logic        s_axil_awvalid,
    output logic        s_axil_awready,
    input  logic [31:0] s_axil_awaddr,
    input  logic        s_axil_wvalid,
    output logic        s_axil_wready,
    input  logic [31:0] s_axil_wdata,
    input  logic [3:0]  s_axil_wstrb,
    output logic        s_axil_bvalid,
    input  logic        s_axil_bready,
    output logic [1:0]  s_axil_bresp,

    input  logic        s_axil_arvalid,
    output logic        s_axil_arready,
    input  logic [31:0] s_axil_araddr,
    output logic        s_axil_rvalid,
    input  logic        s_axil_rready,
    output logic [31:0] s_axil_rdata,
    output logic [1:0]  s_axil_rresp
);
    localparam int unsigned WORD_INDEX_WIDTH = $clog2(DEPTH_WORDS);

    logic [31:0] mem [0:DEPTH_WORDS-1];
    logic        write_addr_valid;
    logic        write_data_valid;
    logic [31:0] write_addr_q;
    logic [31:0] write_data_q;
    logic [3:0]  write_strb_q;

    wire [31:0] write_word_addr = {{(34-ADDR_WIDTH){1'b0}}, write_addr_q[ADDR_WIDTH-1:2]};
    wire [31:0] read_word_addr  = {{(34-ADDR_WIDTH){1'b0}}, s_axil_araddr[ADDR_WIDTH-1:2]};
    wire write_accept = write_addr_valid && write_data_valid && !s_axil_bvalid;
    wire read_accept  = s_axil_arvalid && s_axil_arready;

    wire write_in_range = write_addr_q[31:ADDR_WIDTH] == '0 &&
                          write_word_addr < DEPTH_WORDS;
    wire read_in_range  = s_axil_araddr[31:ADDR_WIDTH] == '0 &&
                          read_word_addr < DEPTH_WORDS;

    assign s_axil_awready = !write_addr_valid && !s_axil_bvalid;
    assign s_axil_wready  = !write_data_valid && !s_axil_bvalid;
    assign s_axil_arready = !s_axil_rvalid;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            s_axil_bvalid <= 1'b0;
            s_axil_bresp  <= 2'b00;
            s_axil_rvalid <= 1'b0;
            s_axil_rdata  <= 32'h0;
            s_axil_rresp  <= 2'b00;
            write_addr_valid <= 1'b0;
            write_data_valid <= 1'b0;
            write_addr_q     <= 32'h0;
            write_data_q     <= 32'h0;
            write_strb_q     <= 4'h0;
        end else begin
            if (s_axil_bvalid && s_axil_bready) begin
                s_axil_bvalid <= 1'b0;
            end

            if (s_axil_rvalid && s_axil_rready) begin
                s_axil_rvalid <= 1'b0;
            end

            if (s_axil_awready && s_axil_awvalid) begin
                write_addr_valid <= 1'b1;
                write_addr_q     <= s_axil_awaddr;
            end

            if (s_axil_wready && s_axil_wvalid) begin
                write_data_valid <= 1'b1;
                write_data_q     <= s_axil_wdata;
                write_strb_q     <= s_axil_wstrb;
            end

            if (write_accept) begin
                if (write_in_range && write_addr_q[1:0] == 2'b00) begin
                    if (write_strb_q[0]) mem[write_addr_q[2 +: WORD_INDEX_WIDTH]][7:0]   <= write_data_q[7:0];
                    if (write_strb_q[1]) mem[write_addr_q[2 +: WORD_INDEX_WIDTH]][15:8]  <= write_data_q[15:8];
                    if (write_strb_q[2]) mem[write_addr_q[2 +: WORD_INDEX_WIDTH]][23:16] <= write_data_q[23:16];
                    if (write_strb_q[3]) mem[write_addr_q[2 +: WORD_INDEX_WIDTH]][31:24] <= write_data_q[31:24];
                    s_axil_bresp <= 2'b00;
                end else begin
                    s_axil_bresp <= 2'b10;
                end
                s_axil_bvalid <= 1'b1;
                write_addr_valid <= 1'b0;
                write_data_valid <= 1'b0;
            end

            if (read_accept) begin
                if (read_in_range && s_axil_araddr[1:0] == 2'b00) begin
                    s_axil_rdata <= mem[s_axil_araddr[2 +: WORD_INDEX_WIDTH]];
                    s_axil_rresp <= 2'b00;
                end else begin
                    s_axil_rdata <= 32'hDEAD_BEEF;
                    s_axil_rresp <= 2'b10;
                end
                s_axil_rvalid <= 1'b1;
            end
        end
    end

endmodule
