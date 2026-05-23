`timescale 1ns/1ps

// Thin cocotb harness for e1_display_scanout. Exposes the scanout DUT's MMIO
// register port, AXI4 read-master channel, and DPI/DSI pixel boundary directly
// to the Python testbench. The Python side models the AXI4 read slave (a
// byte-addressed framebuffer in DRAM) and samples the DPI pixel stream.
module e1_display_scanout_tb #(
    parameter int unsigned ID_WIDTH = 4
) (
    input  logic        clk,
    input  logic        rst_n,

    input  logic        valid,
    input  logic        write,
    input  logic [5:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,

    output logic        m_arvalid,
    input  logic        m_arready,
    output logic [ID_WIDTH-1:0] m_arid,
    output logic [31:0] m_araddr,
    output logic [7:0]  m_arlen,
    output logic [2:0]  m_arsize,
    output logic [1:0]  m_arburst,
    output logic [3:0]  m_arcache,
    output logic [2:0]  m_arprot,
    output logic [3:0]  m_arqos,

    input  logic        m_rvalid,
    output logic        m_rready,
    input  logic [ID_WIDTH-1:0] m_rid,
    input  logic        m_rlast,
    input  logic [31:0] m_rdata,
    input  logic [1:0]  m_rresp,

    output logic        pix_de,
    output logic        pix_hsync,
    output logic        pix_vsync,
    output logic        pix_valid,
    output logic [23:0] pix_data,
    output logic        dcs_vsync_pulse,
    output logic        irq_vsync
);

    e1_display_scanout #(
        .ADDR_WIDTH(32),
        .DATA_WIDTH(32),
        .ID_WIDTH(ID_WIDTH),
        .FIFO_DEPTH(64),
        .OUTSTANDING(4)
    ) u_scanout (
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
        .irq_vsync(irq_vsync)
    );

endmodule
