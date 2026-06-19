// e1_npu_weight_buffer_array.sv — NPU weight-buffer bank array.
//
// Instantiates EIGHT `e1_weight_buffer_sram` banks (each wrapping the Sky130
// pre-built `sky130_sram_2kbyte_1rw1r_32x512_8` hard macro) behind a flat
// 12-bit word address. The top three address bits select a bank; the low nine
// index the 512-word bank. A registered bank-select pipelines the read mux so
// the array keeps the macro's one-cycle registered-read timing.
//
// Purpose: give the E1 physical-design flow a REAL multi-movable-macro
// placement problem. The single-SRAM `e1_soc_top` floorplan has one fixed
// macro and therefore no placement decision to optimise; an 8-bank array is
// the smallest design where macro placement (relative bank positions, channel
// routing, halo packing) measurably changes post-route wirelength, congestion,
// and timing. This is the design that the macro-placement candidate replay
// harness targets.
//
// Banks are instantiated with flat names (`u_bank0` .. `u_bank7`) so the
// OpenLane `MACRO_PLACEMENT_CFG` can reference each macro instance directly
// without generate-block bracket escaping.
//
// Synthesis paths mirror `e1_weight_buffer_sram`:
//   E1_HAVE_HARD_SRAM defined   -> eight hard macros for OpenLane placement.
//   E1_HAVE_HARD_SRAM undefined -> eight behavioral models for lint/sim.

`timescale 1ns/1ps

module e1_npu_weight_buffer_array (
`ifdef USE_POWER_PINS
    inout  wire         VPWR,
    inout  wire         VGND,
`endif
    input  logic        clk,
    input  logic        rst_n,
    // Flat RW port across the bank array.
    input  logic        csb,            // active-low chip select
    input  logic        web,            // active-low write enable
    input  logic [3:0]  wmask,          // byte mask
    input  logic [11:0] addr,           // {bank_sel[2:0], word_addr[8:0]}
    input  logic [31:0] din,
    output logic [31:0] dout
);

    localparam int unsigned NUM_BANKS = 8;
    localparam int unsigned WORD_ADDR_BITS = 9;

    logic [2:0]                 bank_sel;
    logic [WORD_ADDR_BITS-1:0]  word_addr;
    assign bank_sel  = addr[WORD_ADDR_BITS +: 3];
    assign word_addr = addr[WORD_ADDR_BITS-1:0];

    // Per-bank chip-select: only the addressed bank sees an active csb.
    logic [NUM_BANKS-1:0] bank_csb;
    logic [31:0]          bank_dout [NUM_BANKS];
    for (genvar b = 0; b < NUM_BANKS; b++) begin : g_csb
        assign bank_csb[b] = csb | (bank_sel != b[2:0]);
    end

    // The macro registers reads one cycle, so the read mux selects on the
    // bank that was addressed in the previous cycle.
    logic [2:0] bank_sel_q;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) bank_sel_q <= '0;
        else        bank_sel_q <= bank_sel;
    end

    `define E1_BANK(IDX) \
        e1_weight_buffer_sram u_bank``IDX ( \
            .clk(clk), .rst_n(rst_n), \
            .p0_csb(bank_csb[IDX]), .p0_web(web), .p0_wmask(wmask), \
            .p0_addr(word_addr), .p0_din(din), .p0_dout(bank_dout[IDX]), \
            .p1_csb(1'b1), .p1_addr('0), .p1_dout())

`ifdef USE_POWER_PINS
    // Power pins are propagated to every bank under USE_POWER_PINS so the
    // SetPowerConnections odbpy step resolves vccd1/vssd1 to top VPWR/VGND.
    `define E1_BANK_P(IDX) \
        e1_weight_buffer_sram u_bank``IDX ( \
            .VPWR(VPWR), .VGND(VGND), \
            .clk(clk), .rst_n(rst_n), \
            .p0_csb(bank_csb[IDX]), .p0_web(web), .p0_wmask(wmask), \
            .p0_addr(word_addr), .p0_din(din), .p0_dout(bank_dout[IDX]), \
            .p1_csb(1'b1), .p1_addr('0), .p1_dout())
    `E1_BANK_P(0); `E1_BANK_P(1); `E1_BANK_P(2); `E1_BANK_P(3);
    `E1_BANK_P(4); `E1_BANK_P(5); `E1_BANK_P(6); `E1_BANK_P(7);
`else
    `E1_BANK(0); `E1_BANK(1); `E1_BANK(2); `E1_BANK(3);
    `E1_BANK(4); `E1_BANK(5); `E1_BANK(6); `E1_BANK(7);
`endif

    assign dout = bank_dout[bank_sel_q];

endmodule : e1_npu_weight_buffer_array
