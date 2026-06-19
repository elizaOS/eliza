`timescale 1ns/1ps

// e1_clint
//
// Core-Local Interruptor register block for the v0 MMIO debug scaffold shared
// by e1_soc_top and e1_soc_integrated. This is the bring-up CLINT model
// (msip / mtime / mtimecmp) reachable through the 32-bit debug aperture; it is
// NOT the production timer subsystem. Both SoC tops previously inlined this
// block verbatim — it now lives here once.
//
// Register window (word offsets selected by mmio_addr[15:2], gated by sel_i):
//   0x0000 : msip     (bit 0)
//   0x1000 : mtimecmp[31:0]
//   0x1001 : mtimecmp[63:32]
//   0x2FFE : mtime[31:0]
//   0x2FFF : mtime[63:32]
//
// mtime free-runs every clock. msip_o / mtip_o are derived by the caller from
// the exported msip / mtime / mtimecmp so the interrupt wiring stays at the
// SoC-top boundary exactly as before.

module e1_clint (
    input  logic        clk,
    input  logic        rst_n,
    input  logic        mmio_valid,
    input  logic        mmio_write,
    input  logic [13:0] mmio_word_addr,  // mmio_addr[15:2]
    input  logic [31:0] mmio_wdata,
    input  logic        sel_i,
    output logic [31:0] clint_rdata,
    output logic        msip_o,
    output logic [63:0] mtime_o,
    output logic [63:0] mtimecmp_o
);
    logic        clint_msip;
    logic [63:0] clint_mtime;
    logic [63:0] clint_mtimecmp;

    assign msip_o     = clint_msip;
    assign mtime_o    = clint_mtime;
    assign mtimecmp_o = clint_mtimecmp;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            clint_msip     <= 1'b0;
            clint_mtime    <= 64'h0;
            clint_mtimecmp <= 64'hFFFF_FFFF_FFFF_FFFF;
        end else begin
            clint_mtime <= clint_mtime + 64'h1;
            if (mmio_valid && mmio_write && sel_i) begin
                unique case (mmio_word_addr)
                    14'h0000: clint_msip            <= mmio_wdata[0];
                    14'h1000: clint_mtimecmp[31:0]  <= mmio_wdata;
                    14'h1001: clint_mtimecmp[63:32] <= mmio_wdata;
                    14'h2FFE: clint_mtime[31:0]     <= mmio_wdata;
                    14'h2FFF: clint_mtime[63:32]    <= mmio_wdata;
                    default: begin end
                endcase
            end
        end
    end

    always_comb begin
        unique case (mmio_word_addr)
            14'h0000: clint_rdata = {31'h0, clint_msip};
            14'h1000: clint_rdata = clint_mtimecmp[31:0];
            14'h1001: clint_rdata = clint_mtimecmp[63:32];
            14'h2FFE: clint_rdata = clint_mtime[31:0];
            14'h2FFF: clint_rdata = clint_mtime[63:32];
            default:  clint_rdata = 32'h0;
        endcase
    end

endmodule : e1_clint
