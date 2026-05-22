`timescale 1ns/1ps

// e1_clint — RISC-V Core-Local Interruptor (production, Linux-bootable).
//
// Implements the SiFive/RISC-V CLINT memory map and semantics required to boot
// Linux/AOSP on the E1 RISC-V cores. Distinct from the bring-up MMIO register
// block at rtl/peripherals/e1_clint.sv (word-addressed debug aperture): this is
// a byte-addressed 32-bit AXI-Lite slave with the canonical CLINT register
// layout and a free-running mtime that drives mtip/msip per hart.
//
// Memory map (relative to the CLINT base, e.g. 0x0200_0000), per the
// riscv,clint0 / sifive,clint0 device-tree binding:
//   +0x0000 + 4*hart : msip[hart]        RW32, bit 0 = software interrupt pending
//   +0x4000 + 8*hart : mtimecmp[hart]    RW64 (lo @ +0, hi @ +4)
//   +0xBFF8          : mtime             RW64 (lo @ +0, hi @ +4), free-running
//
// Outputs (per hart):
//   msip_o[hart]  -> mip.MSIP : asserted while msip[hart].bit0 == 1
//   mtip_o[hart]  -> mip.MTIP : asserted while mtime >= mtimecmp[hart]
//
// The SoC-integration owner wires msip_o/mtip_o to the hart's mip bits
// (ipi_i / time_irq_i on e1_cpu_subsystem). mtime increments once per clock by
// default; a real platform divides the system clock down to the DT
// timebase-frequency, which is a board-level concern handled outside this leaf.
//
// 32-bit AXI-Lite slave, single outstanding transaction (CLINT is non-contended
// and accessed only by the M-mode CPU agent). All accesses are 32-bit word
// accesses; 64-bit registers are accessed as two 32-bit words per the binding.

module e1_clint #(
    parameter int unsigned NUM_HARTS = 1
) (
    input  logic        clk,
    input  logic        rst_n,

    // Per-hart interrupt outputs (drive mip.MSIP / mip.MTIP).
    output logic [NUM_HARTS-1:0] msip_o,
    output logic [NUM_HARTS-1:0] mtip_o,

    // 64-bit free-running time, exported for observation / DT timebase checks.
    output logic [63:0]          mtime_o,

    // AXI-Lite slave (32-bit data, byte-addressed within the CLINT window).
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
    // CLINT register offsets (byte addresses, masked to the 16-bit window).
    localparam logic [15:0] MTIMECMP_BASE = 16'h4000;
    localparam logic [15:0] MTIME_LO      = 16'hBFF8;
    localparam logic [15:0] MTIME_HI      = 16'hBFFC;

    // --- State -------------------------------------------------------------
    logic                msip   [NUM_HARTS];
    logic [63:0]         mtimecmp [NUM_HARTS];
    logic [63:0]         mtime;

    assign mtime_o = mtime;

    // --- AXI-Lite handshake (single outstanding) ---------------------------
    logic        write_addr_valid;
    logic        write_data_valid;
    logic [15:0] write_addr_q;   // window-relative byte address
    logic [31:0] write_data_q;
    logic [3:0]  write_strb_q;

    wire write_accept = write_addr_valid && write_data_valid && !s_axil_bvalid;
    wire read_accept  = s_axil_arvalid && s_axil_arready;

    assign s_axil_awready = !write_addr_valid && !s_axil_bvalid;
    assign s_axil_wready  = !write_data_valid && !s_axil_bvalid;
    assign s_axil_arready = !s_axil_rvalid;

    // Decode helpers (the write address is registered; reads decode the live
    // araddr in the same cycle the read is accepted).
    wire [15:0] wr_off  = write_addr_q;
    wire [15:0] rd_off  = s_axil_araddr[15:0];

    // mtimecmp hart index from a byte offset: (off - 0x4000) >> 3.
    function automatic int unsigned cmp_hart(input logic [15:0] off);
        cmp_hart = int'(({16'h0, off} - {16'h0, MTIMECMP_BASE}) >> 3);
    endfunction
    // msip hart index from a byte offset: (off - 0x0000) >> 2.
    function automatic int unsigned msip_hart(input logic [15:0] off);
        msip_hart = int'({16'h0, off} >> 2);
    endfunction

    // Address-class decode (write side).
    wire wr_is_msip = (wr_off < MTIMECMP_BASE) &&
                      (msip_hart(wr_off) < NUM_HARTS) && (wr_off[1:0] == 2'b00);
    wire wr_is_cmp  = (wr_off >= MTIMECMP_BASE) && (wr_off < MTIME_LO) &&
                      (cmp_hart(wr_off) < NUM_HARTS);
    wire wr_cmp_hi  = wr_off[2];           // 8-byte register: hi word at +4
    wire wr_is_mtime_lo = (wr_off == MTIME_LO);
    wire wr_is_mtime_hi = (wr_off == MTIME_HI);

    // --- Interrupt outputs -------------------------------------------------
    always_comb begin
        for (int unsigned h = 0; h < NUM_HARTS; h++) begin
            msip_o[h] = msip[h];
            mtip_o[h] = (mtime >= mtimecmp[h]);
        end
    end

    // --- Read data (combinational mux on the accepted read address) --------
    logic [31:0] rdata_next;
    always_comb begin
        rdata_next = 32'h0;
        if ((rd_off < MTIMECMP_BASE) && (msip_hart(rd_off) < NUM_HARTS) &&
            (rd_off[1:0] == 2'b00)) begin
            rdata_next = {31'h0, msip[msip_hart(rd_off)]};
        end else if ((rd_off >= MTIMECMP_BASE) && (rd_off < MTIME_LO) &&
                     (cmp_hart(rd_off) < NUM_HARTS)) begin
            rdata_next = rd_off[2] ? mtimecmp[cmp_hart(rd_off)][63:32]
                                   : mtimecmp[cmp_hart(rd_off)][31:0];
        end else if (rd_off == MTIME_LO) begin
            rdata_next = mtime[31:0];
        end else if (rd_off == MTIME_HI) begin
            rdata_next = mtime[63:32];
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned h = 0; h < NUM_HARTS; h++) begin
                msip[h]     <= 1'b0;
                mtimecmp[h] <= 64'hFFFF_FFFF_FFFF_FFFF; // no spurious timer IRQ at reset
            end
            mtime            <= 64'h0;
            write_addr_valid <= 1'b0;
            write_data_valid <= 1'b0;
            write_addr_q     <= 16'h0;
            write_data_q     <= 32'h0;
            write_strb_q     <= 4'h0;
            s_axil_bvalid    <= 1'b0;
            s_axil_bresp     <= 2'b00;
            s_axil_rvalid    <= 1'b0;
            s_axil_rdata     <= 32'h0;
            s_axil_rresp     <= 2'b00;
        end else begin
            // mtime free-runs (one tick per clock at the RTL boundary).
            mtime <= mtime + 64'h1;

            if (s_axil_bvalid && s_axil_bready) s_axil_bvalid <= 1'b0;
            if (s_axil_rvalid && s_axil_rready) s_axil_rvalid <= 1'b0;

            if (s_axil_awready && s_axil_awvalid) begin
                write_addr_valid <= 1'b1;
                write_addr_q     <= s_axil_awaddr[15:0];
            end
            if (s_axil_wready && s_axil_wvalid) begin
                write_data_valid <= 1'b1;
                write_data_q     <= s_axil_wdata;
                write_strb_q     <= s_axil_wstrb;
            end

            if (write_accept) begin
                if (wr_is_msip && write_strb_q[0]) begin
                    msip[msip_hart(wr_off)] <= write_data_q[0];
                end else if (wr_is_cmp) begin
                    if (wr_cmp_hi)
                        mtimecmp[cmp_hart(wr_off)][63:32] <= write_data_q;
                    else
                        mtimecmp[cmp_hart(wr_off)][31:0]  <= write_data_q;
                end else if (wr_is_mtime_lo) begin
                    mtime[31:0]  <= write_data_q;
                end else if (wr_is_mtime_hi) begin
                    mtime[63:32] <= write_data_q;
                end
                s_axil_bvalid    <= 1'b1;
                s_axil_bresp     <= 2'b00; // OKAY (unmapped writes are silently dropped, OKAY)
                write_addr_valid <= 1'b0;
                write_data_valid <= 1'b0;
            end

            if (read_accept) begin
                s_axil_rdata  <= rdata_next;
                s_axil_rvalid <= 1'b1;
                s_axil_rresp  <= 2'b00; // OKAY
            end
        end
    end

    // Unused upper write-address / read-address bits and write strobes.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    /* verilator lint_on UNUSEDSIGNAL */
    assign unused = ^{s_axil_awaddr[31:16], s_axil_araddr[31:16],
                      write_strb_q[3:1], write_data_q[31:1] & {31{wr_is_msip}}};

endmodule : e1_clint
