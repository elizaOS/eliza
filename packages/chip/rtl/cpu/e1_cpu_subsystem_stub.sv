`timescale 1ns/1ps

// Compatibility alias for legacy source lists.
//
// The executable tiny CPU contract lives in `e1_tiny_cpu_contract`.  This
// module name is kept only so older top-levels and scripts continue to
// elaborate while evidence gates can distinguish the contract model from any
// future production CPU/AP wrapper.
module e1_cpu_subsystem_stub #(
    parameter logic [31:0] RESET_PC = 32'h0000_0000,
    parameter logic [31:0] HART_ID  = 32'h0000_0000
) (
    input  logic        clk,
    input  logic        rst_n,

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
    input  logic [1:0]  m_axil_rresp,

    input  logic        timer_irq,
    input  logic        software_irq,
    input  logic        external_irq,

    output logic [31:0] reset_pc,
    output logic [31:0] hart_id,
    output logic        cpu_halted,
    output logic        irq_pending
);

    e1_tiny_cpu_contract #(
        .RESET_PC(RESET_PC),
        .HART_ID (HART_ID)
    ) u_tiny_cpu_contract (
        .clk            (clk),
        .rst_n          (rst_n),
        .m_axil_awvalid (m_axil_awvalid),
        .m_axil_awready (m_axil_awready),
        .m_axil_awaddr  (m_axil_awaddr),
        .m_axil_wvalid  (m_axil_wvalid),
        .m_axil_wready  (m_axil_wready),
        .m_axil_wdata   (m_axil_wdata),
        .m_axil_wstrb   (m_axil_wstrb),
        .m_axil_bvalid  (m_axil_bvalid),
        .m_axil_bready  (m_axil_bready),
        .m_axil_bresp   (m_axil_bresp),
        .m_axil_arvalid (m_axil_arvalid),
        .m_axil_arready (m_axil_arready),
        .m_axil_araddr  (m_axil_araddr),
        .m_axil_rvalid  (m_axil_rvalid),
        .m_axil_rready  (m_axil_rready),
        .m_axil_rdata   (m_axil_rdata),
        .m_axil_rresp   (m_axil_rresp),
        .timer_irq      (timer_irq),
        .software_irq   (software_irq),
        .external_irq   (external_irq),
        .reset_pc       (reset_pc),
        .hart_id        (hart_id),
        .cpu_halted     (cpu_halted),
        .irq_pending    (irq_pending)
    );

endmodule
