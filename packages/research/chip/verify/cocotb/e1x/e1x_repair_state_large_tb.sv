`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_state_large_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic clear,
  input  logic word_valid,
  input  logic [63:0] word,
  output logic word_ready,
  output logic load_done,
  output logic load_error,
  output logic overflow,
  output logic [31:0] remap_count,
  output logic [31:0] route_count,
  input  logic remap_lookup_valid,
  input  logic [31:0] remap_lookup_logical,
  output logic remap_lookup_hit,
  output logic [31:0] remap_lookup_physical,
  input  logic route_lookup_valid,
  input  logic [31:0] route_lookup_from,
  input  logic [31:0] route_lookup_to,
  output logic route_lookup_hit,
  output logic [2:0] route_lookup_dir,
  output logic [15:0] route_lookup_hops
);
  e1x_repair_state #(
    .MAX_REMAPS(4096),
    .MAX_ROUTES(128)
  ) u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .clear_i(clear),
    .word_valid_i(word_valid),
    .word_i(word),
    .word_ready_o(word_ready),
    .load_done_o(load_done),
    .load_error_o(load_error),
    .overflow_o(overflow),
    .remap_count_o(remap_count),
    .route_count_o(route_count),
    .remap_lookup_valid_i(remap_lookup_valid),
    .remap_lookup_logical_i(remap_lookup_logical),
    .remap_lookup_hit_o(remap_lookup_hit),
    .remap_lookup_physical_o(remap_lookup_physical),
    .route_lookup_valid_i(route_lookup_valid),
    .route_lookup_from_i(route_lookup_from),
    .route_lookup_to_i(route_lookup_to),
    .route_lookup_hit_o(route_lookup_hit),
    .route_lookup_dir_o(route_lookup_dir),
    .route_lookup_hops_o(route_lookup_hops)
  );
endmodule
