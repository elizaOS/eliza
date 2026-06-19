// e1_weight_buffer_sram.sv — NPU weight-staging SRAM wrapper.
//
// Wraps the Sky130 pre-built OpenRAM macro `sky130_sram_2kbyte_1rw1r_32x512_8`
// (2 KB, 1RW + 1R, 32-bit, 9-bit address) so the SoC carries at least one
// real hard macro through the OpenLane release flow. This is the minimum
// surface area required for AlphaChip and DREAMPlace to demonstrate macro
// placement value on e1 — without a hard macro both tools degrade to
// placing zero blocks (see research/alpha_chip_macro_placement/06_e1_notes/
// openlane_full_release_2026-05-19.md, where `Macros: 0`).
//
// Two synthesis paths:
//
//   E1_HAVE_HARD_SRAM defined (release synthesis path):
//     instantiates the Sky130 macro by name. OpenLane reads its LEF/Liberty
//     via EXTRA_LEFS / EXTRA_LIBS in pd/openlane/config.sky130.json and
//     treats the instance as a hard macro for placement / PDN.
//
//   E1_HAVE_HARD_SRAM undefined (simulation/lint path):
//     behavioral 32x512 single-port memory model. Verilator and Yosys can
//     elaborate this without the OpenRAM source. The behavioral path is
//     functionally equivalent to the macro for our access pattern: one
//     RW port driven by the SoC, the second read port is tied off.
//
// Ports follow the Sky130 OpenRAM convention exactly so that swapping
// between behavioral and macro paths is a one-define change.

`timescale 1ns/1ps

module e1_weight_buffer_sram (
`ifdef USE_POWER_PINS
    inout  wire         VPWR,
    inout  wire         VGND,
`endif
    input  logic        clk,
    input  logic        rst_n,
    // Port 0: RW (chip-side scratch interface)
    input  logic        p0_csb,         // active-low chip select
    input  logic        p0_web,         // active-low write enable
    input  logic [3:0]  p0_wmask,       // byte mask
    input  logic [8:0]  p0_addr,
    input  logic [31:0] p0_din,
    output logic [31:0] p0_dout,
    // Port 1: R (currently unused — tied off)
    input  logic        p1_csb,
    input  logic [8:0]  p1_addr,
    output logic [31:0] p1_dout
);

`ifdef E1_HAVE_HARD_SRAM
    // Hard macro path: instantiate the Sky130 pre-built OpenRAM SRAM.
    // The Verilog black-box model lives in pd/openlane/.
    // OpenLane EXTRA_LEFS / EXTRA_LIBS / MACROS point to the macro
    // GDS/LEF/LIB. Power pins are propagated through the hierarchy
    // (e1_chip_top -> e1_soc_top -> here) under USE_POWER_PINS so the
    // SetPowerConnections odbpy step can resolve vccd1/vssd1 to the
    // top-level VPWR/VGND nets.
    /* verilator lint_off UNUSEDSIGNAL */
    logic unused_rst_n = rst_n;
    /* verilator lint_on UNUSEDSIGNAL */

    sky130_sram_2kbyte_1rw1r_32x512_8 u_sram (
`ifdef USE_POWER_PINS
        .vccd1(VPWR),
        .vssd1(VGND),
`endif
        .clk0   (clk),
        .csb0   (p0_csb),
        .web0   (p0_web),
        .wmask0 (p0_wmask),
        .addr0  (p0_addr),
        .din0   (p0_din),
        .dout0  (p0_dout),
        .clk1   (clk),
        .csb1   (p1_csb),
        .addr1  (p1_addr),
        .dout1  (p1_dout)
    );
`else
    // Behavioral model. Matches the macro's registered-input, registered-
    // output single-cycle behavior. Reset clears the registered outputs only;
    // SRAM contents are X until written, matching real silicon.
    logic [31:0] mem [0:511];
    logic [31:0] dout0_q;
    logic [31:0] dout1_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            dout0_q <= 32'h0;
            dout1_q <= 32'h0;
        end else begin
            if (!p0_csb) begin
                if (!p0_web) begin
                    if (p0_wmask[0]) mem[p0_addr][7:0]   <= p0_din[7:0];
                    if (p0_wmask[1]) mem[p0_addr][15:8]  <= p0_din[15:8];
                    if (p0_wmask[2]) mem[p0_addr][23:16] <= p0_din[23:16];
                    if (p0_wmask[3]) mem[p0_addr][31:24] <= p0_din[31:24];
                end
                dout0_q <= mem[p0_addr];
            end
            if (!p1_csb) begin
                dout1_q <= mem[p1_addr];
            end
        end
    end

    assign p0_dout = dout0_q;
    assign p1_dout = dout1_q;
`endif

endmodule : e1_weight_buffer_sram
