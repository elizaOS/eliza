`timescale 1ns/1ps

// e1_bdi_decompress
//
// Base-Delta-Immediate compression decoder. Single-cycle combinational.

module e1_bdi_decompress
    import e1_cache_pkg::*;
#(
    parameter int unsigned LINE_BYTES = 64
) (
    input  bdi_form_e               form_in,
    input  logic [63:0]             base_in,
    input  logic [127:0]            deltas_b8d1_in,
    input  logic [255:0]            deltas_b8d2_in,
    input  logic [8*LINE_BYTES-1:0] raw_in,
    output logic [8*LINE_BYTES-1:0] line_out
);

    localparam int unsigned WORDS_PER_LINE = LINE_BYTES / 8;

    always_comb begin
        line_out = '0;
        case (form_in)
            BDI_ZERO: line_out = '0;
            BDI_REPEAT: begin
                for (int wd = 0; wd < WORDS_PER_LINE; wd++)
                    line_out[wd*64 +: 64] = base_in;
            end
            BDI_B8D1: begin
                line_out[63:0] = base_in;
                for (int wd = 1; wd < WORDS_PER_LINE; wd++) begin
                    automatic logic signed [15:0] d = deltas_b8d1_in[wd*16 +: 16];
                    line_out[wd*64 +: 64] = base_in + $signed({{48{d[15]}}, d});
                end
            end
            BDI_B8D2: begin
                line_out[63:0] = base_in;
                for (int wd = 1; wd < WORDS_PER_LINE; wd++) begin
                    automatic logic signed [31:0] d = deltas_b8d2_in[wd*32 +: 32];
                    line_out[wd*64 +: 64] = base_in + $signed({{32{d[31]}}, d});
                end
            end
            BDI_NONE: line_out = raw_in;
            default:  line_out = raw_in;
        endcase
    end

endmodule
