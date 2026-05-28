`include "rtl/e1x/e1x_pkg.sv"

module e1x_sram_ecc_tb (
  input  logic        clk,
  input  logic        rst_n,
  input  logic        clear,
  input  logic        enc_valid,
  input  logic [31:0] enc_data,
  output logic [38:0] enc_code,
  input  logic        dec_valid,
  input  logic [38:0] dec_code,
  output logic [31:0] dec_data,
  output logic        dec_single_error,
  output logic        dec_double_error,
  output logic [31:0] corrected_count,
  output logic [31:0] detected_double_count
);
  e1x_sram_ecc u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .clear_i(clear),
    .enc_valid_i(enc_valid),
    .enc_data_i(enc_data),
    .enc_code_o(enc_code),
    .dec_valid_i(dec_valid),
    .dec_code_i(dec_code),
    .dec_data_o(dec_data),
    .dec_single_error_o(dec_single_error),
    .dec_double_error_o(dec_double_error),
    .corrected_count_o(corrected_count),
    .detected_double_count_o(detected_double_count)
  );
endmodule
