`timescale 1ns/1ps

// e1_bdi_compress
//
// Base-Delta-Immediate compression encoder (Pekhimenko et al., PACT'12).
//
// Encodes a 64-byte cache line into one of:
//   ZERO   : all-zero (header only)
//   REPEAT : 8-byte base repeated (header + 8 B)
//   B8D1   : 8-byte base + 8 × 1-byte signed delta (header + 16 B)
//   B8D2   : 8-byte base + 8 × 2-byte signed delta (header + 24 B)
//   NONE   : uncompressed (header + 64 B)
//
// Single-cycle combinational encoder; the cache controller drives in a line
// and consumes the compressed form + payload.

module e1_bdi_compress
    import e1_cache_pkg::*;
#(
    parameter int unsigned LINE_BYTES = 64
) (
    input  logic [8*LINE_BYTES-1:0] line_in,
    output bdi_form_e               form_out,
    output logic [63:0]             base_out,
    output logic [127:0]            deltas_b8d1_out,  // 8 × 16 bits, sign-extended
    output logic [255:0]            deltas_b8d2_out   // 8 × 32 bits, sign-extended
);

    localparam int unsigned WORDS_PER_LINE = LINE_BYTES / 8;

    logic all_zero;
    logic all_repeat;
    logic b8d1_ok;
    logic b8d2_ok;
    logic [63:0] base;
    logic signed [63:0] words [WORDS_PER_LINE];

    always_comb begin
        all_zero   = (line_in == '0);
        all_repeat = 1'b1;
        b8d1_ok    = 1'b1;
        b8d2_ok    = 1'b1;
        base       = line_in[63:0];
        for (int wd = 0; wd < WORDS_PER_LINE; wd++) begin
            words[wd] = $signed(line_in[wd*64 +: 64]);
            if (words[wd] != $signed(base)) all_repeat = 1'b0;
        end
        for (int wd = 1; wd < WORDS_PER_LINE; wd++) begin
            automatic logic signed [63:0] d;
            d = words[wd] - $signed(base);
            if (d > 64'sd127 || d < -64'sd128) b8d1_ok = 1'b0;
            if (d > 64'sd32767 || d < -64'sd32768) b8d2_ok = 1'b0;
        end
    end

    always_comb begin
        if (all_zero) begin
            form_out = BDI_ZERO;
        end else if (all_repeat) begin
            form_out = BDI_REPEAT;
        end else if (b8d1_ok) begin
            form_out = BDI_B8D1;
        end else if (b8d2_ok) begin
            form_out = BDI_B8D2;
        end else begin
            form_out = BDI_NONE;
        end
    end

    assign base_out = base;

    always_comb begin
        deltas_b8d1_out = '0;
        deltas_b8d2_out = '0;
        for (int wd = 0; wd < WORDS_PER_LINE; wd++) begin
            automatic logic signed [63:0] d;
            d = words[wd] - $signed(base);
            deltas_b8d1_out[wd*16 +: 16] = d[15:0];
            deltas_b8d2_out[wd*32 +: 32] = d[31:0];
        end
    end

endmodule
