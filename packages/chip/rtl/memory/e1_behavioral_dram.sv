`timescale 1ns/1ps

// e1_behavioral_dram
//
// Behavioural scratch-DRAM model for the v0 MMIO debug scaffold shared by
// e1_soc_top and e1_soc_integrated. It backs the DMA / NPU AXI-Lite masters
// and the display framebuffer read port with a single deterministic word
// array, and serves the CPU/debug MMIO DRAM window. This is the simulation
// model only (e1_axi_lite_dram and the AXI4 e1_axi4_dram_model remain the
// real memory paths); both tops previously inlined this block verbatim.
//
// Behaviour is identical to the inlined logic: word array depth from
// e1_soc_pkg::DRAM_WORDS, write arbitration giving the DMA master priority,
// 0xDEAD_BEEF on out-of-window or unmapped reads, and a single-cycle B/R
// handshake per master. The DRAM window check is 0x8000_0xxx, word-aligned.

module e1_behavioral_dram
(
    input  logic        clk,
    input  logic        rst_n,

    // CPU/debug MMIO path
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [31:0] mmio_addr,
    input  logic [31:0] mmio_wdata,
    input  logic        dram_sel,
    output logic [31:0] mmio_dram_rdata,

    // DMA AXI-Lite master
    input  logic        dma_m_awvalid,
    output logic        dma_m_awready,
    input  logic [31:0] dma_m_awaddr,
    input  logic        dma_m_wvalid,
    output logic        dma_m_wready,
    input  logic [31:0] dma_m_wdata,
    input  logic [3:0]  dma_m_wstrb,
    output logic        dma_m_bvalid,
    input  logic        dma_m_bready,
    output logic [1:0]  dma_m_bresp,
    input  logic        dma_m_arvalid,
    output logic        dma_m_arready,
    input  logic [31:0] dma_m_araddr,
    output logic        dma_m_rvalid,
    input  logic        dma_m_rready,
    output logic [31:0] dma_m_rdata,
    output logic [1:0]  dma_m_rresp,

    // NPU AXI-Lite master
    input  logic        npu_m_awvalid,
    output logic        npu_m_awready,
    input  logic [31:0] npu_m_awaddr,
    input  logic        npu_m_wvalid,
    output logic        npu_m_wready,
    input  logic [31:0] npu_m_wdata,
    input  logic [3:0]  npu_m_wstrb,
    output logic        npu_m_bvalid,
    input  logic        npu_m_bready,
    output logic [1:0]  npu_m_bresp,
    input  logic        npu_m_arvalid,
    output logic        npu_m_arready,
    input  logic [31:0] npu_m_araddr,
    output logic        npu_m_rvalid,
    input  logic        npu_m_rready,
    output logic [31:0] npu_m_rdata,
    output logic [1:0]  npu_m_rresp,

    // Display framebuffer read port
    input  logic        display_fb_read_valid,
    input  logic [31:0] display_fb_read_addr,
    output logic [31:0] display_fb_read_data,
    output logic        display_fb_read_ready
);
    logic [31:0] dram_mem [0:e1_soc_pkg::DRAM_WORDS-1];

    wire [e1_soc_pkg::DRAM_INDEX_BITS-1:0] mmio_dram_word = mmio_addr[2 +: e1_soc_pkg::DRAM_INDEX_BITS];
    wire [e1_soc_pkg::DRAM_INDEX_BITS-1:0] dma_wr_word = dma_m_awaddr[2 +: e1_soc_pkg::DRAM_INDEX_BITS];
    wire [e1_soc_pkg::DRAM_INDEX_BITS-1:0] npu_wr_word = npu_m_awaddr[2 +: e1_soc_pkg::DRAM_INDEX_BITS];
    wire [e1_soc_pkg::DRAM_INDEX_BITS-1:0] dma_rd_word = dma_m_araddr[2 +: e1_soc_pkg::DRAM_INDEX_BITS];
    wire [e1_soc_pkg::DRAM_INDEX_BITS-1:0] npu_rd_word = npu_m_araddr[2 +: e1_soc_pkg::DRAM_INDEX_BITS];
    wire [e1_soc_pkg::DRAM_INDEX_BITS-1:0] display_rd_word = display_fb_read_addr[2 +: e1_soc_pkg::DRAM_INDEX_BITS];
    wire        dma_wr_fire = dma_m_awvalid && dma_m_awready && dma_m_wvalid && dma_m_wready;
    wire        npu_wr_fire = npu_m_awvalid && npu_m_awready && npu_m_wvalid && npu_m_wready;
    wire        dma_rd_fire = dma_m_arvalid && dma_m_arready;
    wire        npu_rd_fire = npu_m_arvalid && npu_m_arready;
    wire        dma_wr_ok = (dma_m_awaddr[31:12] == 20'h8000_0) && (dma_m_awaddr[1:0] == 2'b00);
    wire        npu_wr_ok = (npu_m_awaddr[31:12] == 20'h8000_0) && (npu_m_awaddr[1:0] == 2'b00);
    wire        dma_rd_ok = (dma_m_araddr[31:12] == 20'h8000_0) && (dma_m_araddr[1:0] == 2'b00);
    wire        npu_rd_ok = (npu_m_araddr[31:12] == 20'h8000_0) && (npu_m_araddr[1:0] == 2'b00);
    wire        display_rd_ok = display_fb_read_valid &&
                                (display_fb_read_addr[31:12] == 20'h8000_0) &&
                                (display_fb_read_addr[1:0] == 2'b00);

    assign mmio_dram_rdata = dram_mem[mmio_dram_word];

    assign dma_m_awready = !dma_m_bvalid && !npu_m_bvalid;
    assign dma_m_wready  = !dma_m_bvalid && !npu_m_bvalid;
    assign npu_m_awready = !npu_m_bvalid && !dma_m_awvalid && !dma_m_bvalid;
    assign npu_m_wready  = !npu_m_bvalid && !dma_m_wvalid && !dma_m_bvalid;
    assign dma_m_arready = !dma_m_rvalid && !npu_m_arvalid;
    assign npu_m_arready = !npu_m_rvalid && !dma_m_arvalid && !dma_m_rvalid;
    assign display_fb_read_ready = display_rd_ok;
    assign display_fb_read_data  = display_rd_ok ? dram_mem[display_rd_word] : 32'hDEAD_BEEF;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            dma_m_bvalid <= 1'b0;
            dma_m_bresp  <= 2'b00;
            npu_m_bvalid <= 1'b0;
            npu_m_bresp  <= 2'b00;
            dma_m_rvalid <= 1'b0;
            dma_m_rdata  <= 32'h0;
            dma_m_rresp  <= 2'b00;
            npu_m_rvalid <= 1'b0;
            npu_m_rdata  <= 32'h0;
            npu_m_rresp  <= 2'b00;
        end else begin
            if (dma_m_bvalid && dma_m_bready) dma_m_bvalid <= 1'b0;
            if (npu_m_bvalid && npu_m_bready) npu_m_bvalid <= 1'b0;
            if (dma_m_rvalid && dma_m_rready) dma_m_rvalid <= 1'b0;
            if (npu_m_rvalid && npu_m_rready) npu_m_rvalid <= 1'b0;

            if (mmio_valid && mmio_write && dram_sel) begin
                dram_mem[mmio_dram_word] <= mmio_wdata;
            end

            if (dma_wr_fire) begin
                if (dma_wr_ok) begin
                    if (dma_m_wstrb[0]) dram_mem[dma_wr_word][7:0]   <= dma_m_wdata[7:0];
                    if (dma_m_wstrb[1]) dram_mem[dma_wr_word][15:8]  <= dma_m_wdata[15:8];
                    if (dma_m_wstrb[2]) dram_mem[dma_wr_word][23:16] <= dma_m_wdata[23:16];
                    if (dma_m_wstrb[3]) dram_mem[dma_wr_word][31:24] <= dma_m_wdata[31:24];
                    dma_m_bresp <= 2'b00;
                end else begin
                    dma_m_bresp <= 2'b10;
                end
                dma_m_bvalid <= 1'b1;
            end

            if (npu_wr_fire) begin
                if (npu_wr_ok) begin
                    if (npu_m_wstrb[0]) dram_mem[npu_wr_word][7:0]   <= npu_m_wdata[7:0];
                    if (npu_m_wstrb[1]) dram_mem[npu_wr_word][15:8]  <= npu_m_wdata[15:8];
                    if (npu_m_wstrb[2]) dram_mem[npu_wr_word][23:16] <= npu_m_wdata[23:16];
                    if (npu_m_wstrb[3]) dram_mem[npu_wr_word][31:24] <= npu_m_wdata[31:24];
                    npu_m_bresp <= 2'b00;
                end else begin
                    npu_m_bresp <= 2'b10;
                end
                npu_m_bvalid <= 1'b1;
            end

            if (dma_rd_fire) begin
                if (dma_rd_ok) begin
                    dma_m_rdata <= dram_mem[dma_rd_word];
                    dma_m_rresp <= 2'b00;
                end else begin
                    dma_m_rdata <= 32'hDEAD_BEEF;
                    dma_m_rresp <= 2'b10;
                end
                dma_m_rvalid <= 1'b1;
            end

            if (npu_rd_fire) begin
                if (npu_rd_ok) begin
                    npu_m_rdata <= dram_mem[npu_rd_word];
                    npu_m_rresp <= 2'b00;
                end else begin
                    npu_m_rdata <= 32'hDEAD_BEEF;
                    npu_m_rresp <= 2'b10;
                end
                npu_m_rvalid <= 1'b1;
            end
        end
    end

endmodule : e1_behavioral_dram
