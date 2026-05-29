`timescale 1ns/1ps

// Testbench harness for the L1D (72,64) Hsiao SEC-DED codec in e1_cache_pkg.
//
// Exposes the package codec functions on combinational ports so the cocotb
// injection test can drive an encode, corrupt the 72-bit codeword bit by bit,
// and assert the decode classification + correction directly against the RTL.
// Registered saturating counters mirror the production HPM corrected/
// uncorrectable event surface (HPM_L1D_ECC_CORR / HPM_L1D_ECC_UNCORR).

module e1_l1d_ecc_codec_tb
    import e1_cache_pkg::*;
(
    input  logic        clk,
    input  logic        rst_n,
    input  logic        clear,

    // Encode path.
    input  logic [63:0] enc_data,
    output logic [7:0]  enc_check,

    // Decode path: present (possibly corrupted) data + check bits.
    input  logic        dec_valid,
    input  logic [63:0] dec_data,
    input  logic [7:0]  dec_check,
    output logic [7:0]  dec_syndrome,
    output logic        dec_single,
    output logic        dec_double,
    output logic [63:0] dec_corrected,

    // Saturating status counters (cleared by reset or clear).
    output logic [31:0] corrected_count,
    output logic [31:0] uncorrectable_count
);
    assign enc_check = secded_encode(enc_data);

    logic [7:0] syn;
    assign syn           = secded_syndrome(dec_data, dec_check);
    assign dec_syndrome  = syn;
    assign dec_single    = secded_is_single(syn);
    assign dec_double    = secded_is_double(syn);
    assign dec_corrected = secded_correct(dec_data, syn);

    logic [31:0] corrected_q;
    logic [31:0] uncorrectable_q;
    assign corrected_count     = corrected_q;
    assign uncorrectable_count = uncorrectable_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            corrected_q     <= '0;
            uncorrectable_q <= '0;
        end else if (clear) begin
            corrected_q     <= '0;
            uncorrectable_q <= '0;
        end else begin
            if (dec_valid && dec_single && corrected_q != 32'hFFFF_FFFF) begin
                corrected_q <= corrected_q + 32'd1;
            end
            if (dec_valid && dec_double && uncorrectable_q != 32'hFFFF_FFFF) begin
                uncorrectable_q <= uncorrectable_q + 32'd1;
            end
        end
    end
endmodule
