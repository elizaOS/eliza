`timescale 1ns/1ps

module e1_interrupt_controller #(
    parameter int unsigned NUM_SOURCES = 4
) (
    input  logic        clk,
    input  logic        rst_n,

    input  logic [NUM_SOURCES-1:0] irq_sources,
    output logic                   cpu_external_irq,
    output logic [31:0]            pending_status,

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
    localparam logic [31:0] ID_VALUE = 32'h1C00_0001;

    logic [NUM_SOURCES-1:0] enable;
    logic [NUM_SOURCES-1:0] pending;
    logic [31:0]            claim_id;
    logic                   write_addr_valid;
    logic                   write_data_valid;
    logic [31:0]            write_addr_q;
    logic [31:0]            write_data_q;

    wire       write_accept = write_addr_valid && write_data_valid && !s_axil_bvalid;
    wire       read_accept  = s_axil_arvalid && s_axil_arready;
    wire [3:0] write_word   = write_addr_q[5:2];
    wire [3:0] read_word    = s_axil_araddr[5:2];

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_axil_addr;
    logic unused_wstrb;
    /* verilator lint_on UNUSEDSIGNAL */
    assign unused_axil_addr = ^{write_addr_q[31:6], write_addr_q[1:0],
                                s_axil_araddr[31:6], s_axil_araddr[1:0]};
    assign unused_wstrb = ^s_axil_wstrb;

    assign s_axil_awready = !write_addr_valid && !s_axil_bvalid;
    assign s_axil_wready  = !write_data_valid && !s_axil_bvalid;
    assign s_axil_arready = !s_axil_rvalid;
    assign cpu_external_irq = |(pending & enable);
    assign pending_status = {{(32-NUM_SOURCES){1'b0}}, pending};

    integer i;
    integer clear_idx;
    always_comb begin
        claim_id = 32'h0;
        for (i = NUM_SOURCES - 1; i >= 0; i = i - 1) begin
            if (pending[i] && enable[i]) begin
                claim_id = $unsigned(i + 1);
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            enable        <= '0;
            pending       <= '0;
            s_axil_bvalid <= 1'b0;
            s_axil_bresp  <= 2'b00;
            s_axil_rvalid <= 1'b0;
            s_axil_rdata  <= 32'h0;
            s_axil_rresp  <= 2'b00;
            write_addr_valid <= 1'b0;
            write_data_valid <= 1'b0;
            write_addr_q     <= 32'h0;
            write_data_q     <= 32'h0;
        end else begin
            pending <= pending | irq_sources;

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
            end

            if (write_accept) begin
                unique case (write_word)
                    4'h2: enable <= write_data_q[NUM_SOURCES-1:0];
                    4'h3: begin
                        for (clear_idx = 0; clear_idx < NUM_SOURCES; clear_idx = clear_idx + 1) begin
                            if (write_data_q == $unsigned(clear_idx + 1)) begin
                                pending[clear_idx] <= 1'b0;
                            end
                        end
                    end
                    default: begin end
                endcase
                s_axil_bvalid <= 1'b1;
                s_axil_bresp  <= 2'b00;
                write_addr_valid <= 1'b0;
                write_data_valid <= 1'b0;
            end

            if (read_accept) begin
                unique case (read_word)
                    4'h0: s_axil_rdata <= ID_VALUE;
                    4'h1: s_axil_rdata <= pending_status;
                    4'h2: s_axil_rdata <= {{(32-NUM_SOURCES){1'b0}}, enable};
                    4'h3: s_axil_rdata <= claim_id;
                    default: s_axil_rdata <= 32'h0;
                endcase
                s_axil_rvalid <= 1'b1;
                s_axil_rresp  <= 2'b00;
            end
        end
    end

endmodule
