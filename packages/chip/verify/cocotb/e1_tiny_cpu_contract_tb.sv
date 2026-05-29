`timescale 1ns/1ps

module e1_tiny_cpu_contract_tb (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        cpu_enable,
    input  logic        stall_cpu_aw,
    input  logic        stall_cpu_w,
    input  logic        stall_cpu_ar,

    input  logic        loader_awvalid,
    output logic        loader_awready,
    input  logic [31:0] loader_awaddr,
    input  logic        loader_wvalid,
    output logic        loader_wready,
    input  logic [31:0] loader_wdata,
    input  logic [3:0]  loader_wstrb,
    output logic        loader_bvalid,
    input  logic        loader_bready,
    output logic [1:0]  loader_bresp,

    input  logic        loader_arvalid,
    output logic        loader_arready,
    input  logic [31:0] loader_araddr,
    output logic        loader_rvalid,
    input  logic        loader_rready,
    output logic [31:0] loader_rdata,
    output logic [1:0]  loader_rresp,

    input  logic [3:0]  irq_sources,
    input  logic        timer_irq,
    input  logic        software_irq,
    output logic        cpu_halted,
    output logic        cpu_irq_pending,
    output logic        cpu_external_irq,
    output logic [31:0] cpu_reset_pc,
    output logic [31:0] cpu_hart_id,
    output logic [31:0] irq_pending
);
    logic        cpu_awvalid;
    logic        cpu_awready;
    logic [31:0] cpu_awaddr;
    logic        cpu_wvalid;
    logic        cpu_wready;
    logic [31:0] cpu_wdata;
    logic [3:0]  cpu_wstrb;
    logic        cpu_bvalid;
    logic        cpu_bready;
    logic [1:0]  cpu_bresp;
    logic        cpu_arvalid;
    logic        cpu_arready;
    logic [31:0] cpu_araddr;
    logic        cpu_rvalid;
    logic        cpu_rready;
    logic [31:0] cpu_rdata;
    logic [1:0]  cpu_rresp;

    logic        bus_awvalid;
    logic        bus_awready;
    logic [31:0] bus_awaddr;
    logic        bus_wvalid;
    logic        bus_wready;
    logic [31:0] bus_wdata;
    logic [3:0]  bus_wstrb;
    logic        bus_bvalid;
    logic        bus_bready;
    logic [1:0]  bus_bresp;
    logic        bus_arvalid;
    logic        bus_arready;
    logic [31:0] bus_araddr;
    logic        bus_rvalid;
    logic        bus_rready;
    logic [31:0] bus_rdata;
    logic [1:0]  bus_rresp;
    logic [31:0] reset_pc;
    logic [31:0] hart_id;

    assign bus_awvalid = cpu_enable ? (cpu_awvalid & ~stall_cpu_aw) : loader_awvalid;
    assign bus_awaddr  = cpu_enable ? cpu_awaddr  : loader_awaddr;
    assign bus_wvalid  = cpu_enable ? (cpu_wvalid & ~stall_cpu_w) : loader_wvalid;
    assign bus_wdata   = cpu_enable ? cpu_wdata   : loader_wdata;
    assign bus_wstrb   = cpu_enable ? cpu_wstrb   : loader_wstrb;
    assign bus_bready  = cpu_enable ? cpu_bready  : loader_bready;
    assign bus_arvalid = cpu_enable ? (cpu_arvalid & ~stall_cpu_ar) : loader_arvalid;
    assign bus_araddr  = cpu_enable ? cpu_araddr  : loader_araddr;
    assign bus_rready  = cpu_enable ? cpu_rready  : loader_rready;

    assign cpu_awready = cpu_enable ? (bus_awready & ~stall_cpu_aw) : 1'b0;
    assign cpu_wready  = cpu_enable ? (bus_wready & ~stall_cpu_w) : 1'b0;
    assign cpu_bvalid  = cpu_enable ? bus_bvalid  : 1'b0;
    assign cpu_bresp   = bus_bresp;
    assign cpu_arready = cpu_enable ? (bus_arready & ~stall_cpu_ar) : 1'b0;
    assign cpu_rvalid  = cpu_enable ? bus_rvalid  : 1'b0;
    assign cpu_rdata   = bus_rdata;
    assign cpu_rresp   = bus_rresp;

    assign loader_awready = cpu_enable ? 1'b0 : bus_awready;
    assign loader_wready  = cpu_enable ? 1'b0 : bus_wready;
    assign loader_bvalid  = cpu_enable ? 1'b0 : bus_bvalid;
    assign loader_bresp   = bus_bresp;
    assign loader_arready = cpu_enable ? 1'b0 : bus_arready;
    assign loader_rvalid  = cpu_enable ? 1'b0 : bus_rvalid;
    assign loader_rdata   = bus_rdata;
    assign loader_rresp   = bus_rresp;

    assign cpu_reset_pc = reset_pc;
    assign cpu_hart_id  = hart_id;

    e1_tiny_cpu_contract #(
        .RESET_PC(32'h8000_0000),
        .HART_ID(32'h0)
    ) u_cpu (
        .clk(clk),
        .rst_n(rst_n & cpu_enable),
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
        .timer_irq(timer_irq),
        .software_irq(software_irq),
        .external_irq(cpu_external_irq),
        .reset_pc(reset_pc),
        .hart_id(hart_id),
        .cpu_halted(cpu_halted),
        .irq_pending(cpu_irq_pending)
    );

    e1_linux_soc_contract #(
        .NUM_IRQ_SOURCES(4)
    ) u_contract (
        .clk(clk),
        .rst_n(rst_n),
        .cpu_awvalid(bus_awvalid),
        .cpu_awready(bus_awready),
        .cpu_awaddr(bus_awaddr),
        .cpu_wvalid(bus_wvalid),
        .cpu_wready(bus_wready),
        .cpu_wdata(bus_wdata),
        .cpu_wstrb(bus_wstrb),
        .cpu_bvalid(bus_bvalid),
        .cpu_bready(bus_bready),
        .cpu_bresp(bus_bresp),
        .cpu_arvalid(bus_arvalid),
        .cpu_arready(bus_arready),
        .cpu_araddr(bus_araddr),
        .cpu_rvalid(bus_rvalid),
        .cpu_rready(bus_rready),
        .cpu_rdata(bus_rdata),
        .cpu_rresp(bus_rresp),
        .irq_sources(irq_sources),
        .cpu_external_irq(cpu_external_irq),
        .irq_pending(irq_pending)
    );

endmodule
