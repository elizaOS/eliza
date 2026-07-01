`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_rom_loader_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic clear,
  input  logic word_valid,
  input  logic [63:0] word,
  output logic word_ready,
  output logic header_valid,
  output logic remap_valid,
  output logic [31:0] remap_logical,
  output logic [31:0] remap_physical,
  output logic route_valid,
  output logic [31:0] route_logical_from,
  output logic [31:0] route_logical_to,
  output logic [2:0] route_dir,
  output logic [15:0] route_hops,
  output logic done,
  output logic error,
  output logic [31:0] remap_count,
  output logic [31:0] route_count,
  output logic [31:0] words_seen
);
  e1x_repair_rom_loader u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .clear_i(clear),
    .word_valid_i(word_valid),
    .word_i(word),
    .word_ready_o(word_ready),
    .header_valid_o(header_valid),
    .remap_valid_o(remap_valid),
    .remap_logical_o(remap_logical),
    .remap_physical_o(remap_physical),
    .route_valid_o(route_valid),
    .route_logical_from_o(route_logical_from),
    .route_logical_to_o(route_logical_to),
    .route_dir_o(route_dir),
    .route_hops_o(route_hops),
    .done_o(done),
    .error_o(error),
    .remap_count_o(remap_count),
    .route_count_o(route_count),
    .words_seen_o(words_seen)
  );
endmodule
