`timescale 1ns/1ps

module e1_linux_soc_contract #(
    parameter int unsigned NUM_IRQ_SOURCES = 4
) (
    input  logic        clk,
    input  logic        rst_n,

    input  logic        cpu_awvalid,
    output logic        cpu_awready,
    input  logic [31:0] cpu_awaddr,
    input  logic        cpu_wvalid,
    output logic        cpu_wready,
    input  logic [31:0] cpu_wdata,
    input  logic [3:0]  cpu_wstrb,
    output logic        cpu_bvalid,
    input  logic        cpu_bready,
    output logic [1:0]  cpu_bresp,

    input  logic        cpu_arvalid,
    output logic        cpu_arready,
    input  logic [31:0] cpu_araddr,
    output logic        cpu_rvalid,
    input  logic        cpu_rready,
    output logic [31:0] cpu_rdata,
    output logic [1:0]  cpu_rresp,

    input  logic [NUM_IRQ_SOURCES-1:0] irq_sources,
    output logic                       cpu_external_irq,
    output logic [31:0]                irq_pending
);
    logic        cpu_mem_awvalid, cpu_mem_awready;
    logic [31:0] cpu_mem_awaddr;
    logic        cpu_mem_wvalid, cpu_mem_wready;
    logic [31:0] cpu_mem_wdata;
    logic [3:0]  cpu_mem_wstrb;
    logic        cpu_mem_bvalid, cpu_mem_bready;
    logic [1:0]  cpu_mem_bresp;
    logic        cpu_mem_arvalid, cpu_mem_arready;
    logic [31:0] cpu_mem_araddr;
    logic        cpu_mem_rvalid, cpu_mem_rready;
    logic [31:0] cpu_mem_rdata;
    logic [1:0]  cpu_mem_rresp;

    logic        dma_mmio_awvalid, dma_mmio_awready;
    logic [31:0] dma_mmio_awaddr;
    logic        dma_mmio_wvalid, dma_mmio_wready;
    logic [31:0] dma_mmio_wdata;
    logic [3:0]  dma_mmio_wstrb;
    logic        dma_mmio_bvalid, dma_mmio_bready;
    logic [1:0]  dma_mmio_bresp;
    logic        dma_mmio_arvalid, dma_mmio_arready;
    logic [31:0] dma_mmio_araddr;
    logic        dma_mmio_rvalid, dma_mmio_rready;
    logic [31:0] dma_mmio_rdata;
    logic [31:0] dma_mmio_rdata_q;
    logic [1:0]  dma_mmio_rresp;

    logic        dma_mem_awvalid, dma_mem_awready;
    logic [31:0] dma_mem_awaddr;
    logic        dma_mem_wvalid, dma_mem_wready;
    logic [31:0] dma_mem_wdata;
    logic [3:0]  dma_mem_wstrb;
    logic        dma_mem_bvalid, dma_mem_bready;
    logic [1:0]  dma_mem_bresp;
    logic        dma_mem_arvalid, dma_mem_arready;
    logic [31:0] dma_mem_araddr;
    logic        dma_mem_rvalid, dma_mem_rready;
    logic [31:0] dma_mem_rdata;
    logic [1:0]  dma_mem_rresp;

    logic        intc_awvalid, intc_awready;
    logic [31:0] intc_awaddr;
    logic        intc_wvalid, intc_wready;
    logic [31:0] intc_wdata;
    logic [3:0]  intc_wstrb;
    logic        intc_bvalid, intc_bready;
    logic [1:0]  intc_bresp;
    logic        intc_arvalid, intc_arready;
    logic [31:0] intc_araddr;
    logic        intc_rvalid, intc_rready;
    logic [31:0] intc_rdata;
    logic [1:0]  intc_rresp;

    logic        dram_awvalid, dram_awready;
    logic [31:0] dram_awaddr;
    logic        dram_wvalid, dram_wready;
    logic [31:0] dram_wdata;
    logic [3:0]  dram_wstrb;
    logic        dram_bvalid, dram_bready;
    logic [1:0]  dram_bresp;
    logic        dram_arvalid, dram_arready;
    logic [31:0] dram_araddr;
    logic        dram_rvalid, dram_rready;
    logic [31:0] dram_rdata;
    logic [1:0]  dram_rresp;
    logic        wr_dma_owner, rd_dma_owner;
    logic        wr_active, rd_active;
    logic        dma_irq;
    logic        unused_dma_awready, unused_dma_wready, unused_dma_arready;
    logic        unused_dma_bvalid, unused_dma_rvalid;
    logic [1:0]  unused_dma_bresp, unused_dma_rresp;
    logic [31:0] unused_dma_rdata;
    logic        unused_dbg_awready, unused_dbg_wready, unused_dbg_arready;
    logic        unused_dbg_bvalid, unused_dbg_rvalid;
    logic [1:0]  unused_dbg_bresp, unused_dbg_rresp;
    logic [31:0] unused_dbg_rdata;
    logic [2:0]  unused_grants;
    logic [2:0]  unused_timeouts;
    /* verilator lint_off UNUSEDSIGNAL */
    logic        unused_dma_mmio;
    /* verilator lint_on UNUSEDSIGNAL */

    wire cpu_wr_req = cpu_mem_awvalid && cpu_mem_wvalid;
    wire dma_wr_req = dma_mem_awvalid && dma_mem_wvalid;
    wire grant_dma_wr = !cpu_wr_req && dma_wr_req;
    wire cpu_rd_req = cpu_mem_arvalid;
    wire dma_rd_req = dma_mem_arvalid;
    wire grant_dma_rd = !cpu_rd_req && dma_rd_req;
    assign unused_dma_mmio = ^{dma_mmio_awaddr[31:8], dma_mmio_awaddr[1:0],
                               dma_mmio_wstrb,
                               dma_mmio_araddr[31:8], dma_mmio_araddr[1:0]};

    e1_axi_lite_interconnect u_interconnect (
        .clk(clk),
        .rst_n(rst_n),
        .m_axil_awvalid(cpu_awvalid),
        .m_axil_awready(cpu_awready),
        .m_axil_awaddr(cpu_awaddr),
        .m_axil_wvalid(cpu_wvalid),
        .m_axil_wready(cpu_wready),
        .m_axil_wdata(cpu_wdata),
        .m_axil_wstrb(cpu_wstrb),
        .m_axil_bvalid(cpu_bvalid),
        .m_axil_bready(cpu_bready),
        .m_axil_bresp(cpu_bresp),
        .m_axil_arvalid(cpu_arvalid),
        .m_axil_arready(cpu_arready),
        .m_axil_araddr(cpu_araddr),
        .m_axil_rvalid(cpu_rvalid),
        .m_axil_rready(cpu_rready),
        .m_axil_rdata(cpu_rdata),
        .m_axil_rresp(cpu_rresp),
        .dma_m_awvalid(1'b0),
        .dma_m_awready(unused_dma_awready),
        .dma_m_awaddr(32'h0),
        .dma_m_wvalid(1'b0),
        .dma_m_wready(unused_dma_wready),
        .dma_m_wdata(32'h0),
        .dma_m_wstrb(4'h0),
        .dma_m_bvalid(unused_dma_bvalid),
        .dma_m_bready(1'b1),
        .dma_m_bresp(unused_dma_bresp),
        .dma_m_arvalid(1'b0),
        .dma_m_arready(unused_dma_arready),
        .dma_m_araddr(32'h0),
        .dma_m_rvalid(unused_dma_rvalid),
        .dma_m_rready(1'b1),
        .dma_m_rdata(unused_dma_rdata),
        .dma_m_rresp(unused_dma_rresp),
        .dbg_m_awvalid(1'b0),
        .dbg_m_awready(unused_dbg_awready),
        .dbg_m_awaddr(32'h0),
        .dbg_m_wvalid(1'b0),
        .dbg_m_wready(unused_dbg_wready),
        .dbg_m_wdata(32'h0),
        .dbg_m_wstrb(4'h0),
        .dbg_m_bvalid(unused_dbg_bvalid),
        .dbg_m_bready(1'b1),
        .dbg_m_bresp(unused_dbg_bresp),
        .dbg_m_arvalid(1'b0),
        .dbg_m_arready(unused_dbg_arready),
        .dbg_m_araddr(32'h0),
        .dbg_m_rvalid(unused_dbg_rvalid),
        .dbg_m_rready(1'b1),
        .dbg_m_rdata(unused_dbg_rdata),
        .dbg_m_rresp(unused_dbg_rresp),
        .dram_awvalid(cpu_mem_awvalid),
        .dram_awready(cpu_mem_awready),
        .dram_awaddr(cpu_mem_awaddr),
        .dram_wvalid(cpu_mem_wvalid),
        .dram_wready(cpu_mem_wready),
        .dram_wdata(cpu_mem_wdata),
        .dram_wstrb(cpu_mem_wstrb),
        .dram_bvalid(cpu_mem_bvalid),
        .dram_bready(cpu_mem_bready),
        .dram_bresp(cpu_mem_bresp),
        .dram_arvalid(cpu_mem_arvalid),
        .dram_arready(cpu_mem_arready),
        .dram_araddr(cpu_mem_araddr),
        .dram_rvalid(cpu_mem_rvalid),
        .dram_rready(cpu_mem_rready),
        .dram_rdata(cpu_mem_rdata),
        .dram_rresp(cpu_mem_rresp),
        .intc_awvalid(intc_awvalid),
        .intc_awready(intc_awready),
        .intc_awaddr(intc_awaddr),
        .intc_wvalid(intc_wvalid),
        .intc_wready(intc_wready),
        .intc_wdata(intc_wdata),
        .intc_wstrb(intc_wstrb),
        .intc_bvalid(intc_bvalid),
        .intc_bready(intc_bready),
        .intc_bresp(intc_bresp),
        .intc_arvalid(intc_arvalid),
        .intc_arready(intc_arready),
        .intc_araddr(intc_araddr),
        .intc_rvalid(intc_rvalid),
        .intc_rready(intc_rready),
        .intc_rdata(intc_rdata),
        .intc_rresp(intc_rresp),
        .dma_awvalid(dma_mmio_awvalid),
        .dma_awready(dma_mmio_awready),
        .dma_awaddr(dma_mmio_awaddr),
        .dma_wvalid(dma_mmio_wvalid),
        .dma_wready(dma_mmio_wready),
        .dma_wdata(dma_mmio_wdata),
        .dma_wstrb(dma_mmio_wstrb),
        .dma_bvalid(dma_mmio_bvalid),
        .dma_bready(dma_mmio_bready),
        .dma_bresp(dma_mmio_bresp),
        .dma_arvalid(dma_mmio_arvalid),
        .dma_arready(dma_mmio_arready),
        .dma_araddr(dma_mmio_araddr),
        .dma_rvalid(dma_mmio_rvalid),
        .dma_rready(dma_mmio_rready),
        .dma_rdata(dma_mmio_rdata_q),
        .dma_rresp(dma_mmio_rresp),
        .arb_grant(unused_grants),
        .timeout_irq(unused_timeouts)
    );

    assign dram_awvalid = !wr_active && (grant_dma_wr ? dma_mem_awvalid : cpu_mem_awvalid);
    assign dram_wvalid  = !wr_active && (grant_dma_wr ? dma_mem_wvalid  : cpu_mem_wvalid);
    assign dram_awaddr  = grant_dma_wr ? (dma_mem_awaddr - 32'h8000_0000) : cpu_mem_awaddr;
    assign dram_wdata   = grant_dma_wr ? dma_mem_wdata  : cpu_mem_wdata;
    assign dram_wstrb   = grant_dma_wr ? dma_mem_wstrb  : cpu_mem_wstrb;
    assign cpu_mem_awready = !wr_active && !grant_dma_wr && dram_awready && dram_wready;
    assign cpu_mem_wready  = cpu_mem_awready;
    assign dma_mem_awready = !wr_active && grant_dma_wr && dram_awready && dram_wready;
    assign dma_mem_wready  = dma_mem_awready;
    assign dram_bready = wr_dma_owner ? dma_mem_bready : cpu_mem_bready;
    assign cpu_mem_bvalid = wr_active && !wr_dma_owner && dram_bvalid;
    assign cpu_mem_bresp  = dram_bresp;
    assign dma_mem_bvalid = wr_active && wr_dma_owner && dram_bvalid;
    assign dma_mem_bresp  = dram_bresp;

    assign dram_arvalid = !rd_active && (grant_dma_rd ? dma_mem_arvalid : cpu_mem_arvalid);
    assign dram_araddr  = grant_dma_rd ? (dma_mem_araddr - 32'h8000_0000) : cpu_mem_araddr;
    assign cpu_mem_arready = !rd_active && !grant_dma_rd && dram_arready;
    assign dma_mem_arready = !rd_active && grant_dma_rd && dram_arready;
    assign dram_rready = rd_dma_owner ? dma_mem_rready : cpu_mem_rready;
    assign cpu_mem_rvalid = rd_active && !rd_dma_owner && dram_rvalid;
    assign cpu_mem_rdata  = dram_rdata;
    assign cpu_mem_rresp  = dram_rresp;
    assign dma_mem_rvalid = rd_active && rd_dma_owner && dram_rvalid;
    assign dma_mem_rdata  = dram_rdata;
    assign dma_mem_rresp  = dram_rresp;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_active <= 1'b0;
            wr_dma_owner <= 1'b0;
            rd_active <= 1'b0;
            rd_dma_owner <= 1'b0;
        end else begin
            if (!wr_active && dram_awvalid && dram_awready && dram_wvalid && dram_wready) begin
                wr_active <= 1'b1;
                wr_dma_owner <= grant_dma_wr;
            end else if (wr_active && dram_bvalid && dram_bready) begin
                wr_active <= 1'b0;
            end

            if (!rd_active && dram_arvalid && dram_arready) begin
                rd_active <= 1'b1;
                rd_dma_owner <= grant_dma_rd;
            end else if (rd_active && dram_rvalid && dram_rready) begin
                rd_active <= 1'b0;
            end
        end
    end

    e1_dma u_dma (
        .clk(clk),
        .rst_n(rst_n),
        .valid((dma_mmio_awvalid && dma_mmio_wvalid && dma_mmio_awready && dma_mmio_wready) ||
               (dma_mmio_arvalid && dma_mmio_arready)),
        .write(dma_mmio_awvalid && dma_mmio_wvalid),
        .addr((dma_mmio_awvalid && dma_mmio_wvalid) ? dma_mmio_awaddr[7:2] : dma_mmio_araddr[7:2]),
        .wdata(dma_mmio_wdata),
        .rdata(dma_mmio_rdata),
        .irq(dma_irq),
        .m_axil_awvalid(dma_mem_awvalid),
        .m_axil_awready(dma_mem_awready),
        .m_axil_awaddr(dma_mem_awaddr),
        .m_axil_wvalid(dma_mem_wvalid),
        .m_axil_wready(dma_mem_wready),
        .m_axil_wdata(dma_mem_wdata),
        .m_axil_wstrb(dma_mem_wstrb),
        .m_axil_bvalid(dma_mem_bvalid),
        .m_axil_bready(dma_mem_bready),
        .m_axil_bresp(dma_mem_bresp),
        .m_axil_arvalid(dma_mem_arvalid),
        .m_axil_arready(dma_mem_arready),
        .m_axil_araddr(dma_mem_araddr),
        .m_axil_rvalid(dma_mem_rvalid),
        .m_axil_rready(dma_mem_rready),
        .m_axil_rdata(dma_mem_rdata),
        .m_axil_rresp(dma_mem_rresp)
    );

    assign dma_mmio_awready = !dma_mmio_bvalid;
    assign dma_mmio_wready  = !dma_mmio_bvalid;
    assign dma_mmio_bresp   = 2'b00;
    assign dma_mmio_arready = !dma_mmio_rvalid;
    assign dma_mmio_rresp   = 2'b00;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            dma_mmio_bvalid <= 1'b0;
            dma_mmio_rvalid <= 1'b0;
            dma_mmio_rdata_q <= 32'h0;
        end else begin
            if (dma_mmio_bvalid && dma_mmio_bready) begin
                dma_mmio_bvalid <= 1'b0;
            end
            if (dma_mmio_rvalid && dma_mmio_rready) begin
                dma_mmio_rvalid <= 1'b0;
            end
            if (dma_mmio_awvalid && dma_mmio_awready && dma_mmio_wvalid && dma_mmio_wready) begin
                dma_mmio_bvalid <= 1'b1;
            end
            if (dma_mmio_arvalid && dma_mmio_arready) begin
                dma_mmio_rvalid <= 1'b1;
                dma_mmio_rdata_q <= dma_mmio_rdata;
            end
        end
    end

    e1_axi_lite_dram u_dram (
        .clk(clk),
        .rst_n(rst_n),
        .s_axil_awvalid(dram_awvalid),
        .s_axil_awready(dram_awready),
        .s_axil_awaddr(dram_awaddr),
        .s_axil_wvalid(dram_wvalid),
        .s_axil_wready(dram_wready),
        .s_axil_wdata(dram_wdata),
        .s_axil_wstrb(dram_wstrb),
        .s_axil_bvalid(dram_bvalid),
        .s_axil_bready(dram_bready),
        .s_axil_bresp(dram_bresp),
        .s_axil_arvalid(dram_arvalid),
        .s_axil_arready(dram_arready),
        .s_axil_araddr(dram_araddr),
        .s_axil_rvalid(dram_rvalid),
        .s_axil_rready(dram_rready),
        .s_axil_rdata(dram_rdata),
        .s_axil_rresp(dram_rresp)
    );

    e1_interrupt_controller #(
        .NUM_SOURCES(NUM_IRQ_SOURCES)
    ) u_interrupt_controller (
        .clk(clk),
        .rst_n(rst_n),
        .irq_sources(irq_sources | {{(NUM_IRQ_SOURCES-1){1'b0}}, dma_irq}),
        .cpu_external_irq(cpu_external_irq),
        .pending_status(irq_pending),
        .s_axil_awvalid(intc_awvalid),
        .s_axil_awready(intc_awready),
        .s_axil_awaddr(intc_awaddr),
        .s_axil_wvalid(intc_wvalid),
        .s_axil_wready(intc_wready),
        .s_axil_wdata(intc_wdata),
        .s_axil_wstrb(intc_wstrb),
        .s_axil_bvalid(intc_bvalid),
        .s_axil_bready(intc_bready),
        .s_axil_bresp(intc_bresp),
        .s_axil_arvalid(intc_arvalid),
        .s_axil_arready(intc_arready),
        .s_axil_araddr(intc_araddr),
        .s_axil_rvalid(intc_rvalid),
        .s_axil_rready(intc_rready),
        .s_axil_rdata(intc_rdata),
        .s_axil_rresp(intc_rresp)
    );

endmodule
