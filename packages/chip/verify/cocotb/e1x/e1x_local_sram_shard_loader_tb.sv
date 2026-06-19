`include "rtl/e1x/e1x_pkg.sv"

module e1x_local_sram_shard_loader_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic clear,
  input  logic load_valid,
  input  logic [31:0] load_word_addr,
  input  logic [31:0] load_word,
  output logic load_ready,
  output logic overflow,
  output logic [31:0] capacity_bytes,
  output logic [31:0] loaded_words,
  output logic [31:0] loaded_bytes,
  output logic [31:0] checksum,
  input  logic read_valid,
  input  logic [31:0] read_word_addr,
  output logic read_valid_out,
  output logic read_error,
  output logic [31:0] read_word
);
  e1x_local_sram_shard_loader u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .clear_i(clear),
    .load_valid_i(load_valid),
    .load_word_addr_i(load_word_addr),
    .load_word_i(load_word),
    .load_ready_o(load_ready),
    .overflow_o(overflow),
    .capacity_bytes_o(capacity_bytes),
    .loaded_words_o(loaded_words),
    .loaded_bytes_o(loaded_bytes),
    .checksum_o(checksum),
    .read_valid_i(read_valid),
    .read_word_addr_i(read_word_addr),
    .read_valid_o(read_valid_out),
    .read_error_o(read_error),
    .read_word_o(read_word)
  );
endmodule
