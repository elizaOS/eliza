`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_route_table_overflow_tb (
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
  input  logic lookup_valid,
  input  logic [31:0] lookup_from,
  input  logic [31:0] lookup_to,
  output logic lookup_hit,
  output logic [2:0] lookup_dir,
  output logic [15:0] lookup_hops
);
  logic [0:0][31:0] lookup_from_arr;
  logic [0:0][31:0] lookup_to_arr;
  logic [0:0] lookup_valid_arr;
  logic [0:0] lookup_hit_arr;
  logic [0:0][2:0] lookup_dir_arr;
  logic [0:0][15:0] lookup_hops_arr;

  assign lookup_valid_arr[0] = lookup_valid;
  assign lookup_from_arr[0] = lookup_from;
  assign lookup_to_arr[0] = lookup_to;
  assign lookup_hit = lookup_hit_arr[0];
  assign lookup_dir = lookup_dir_arr[0];
  assign lookup_hops = lookup_hops_arr[0];

  e1x_repair_route_table #(
    .LOOKUP_PORTS(1),
    .MAX_ROUTES(1)
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
    .lookup_valid_i(lookup_valid_arr),
    .lookup_from_i(lookup_from_arr),
    .lookup_to_i(lookup_to_arr),
    .lookup_hit_o(lookup_hit_arr),
    .lookup_dir_o(lookup_dir_arr),
    .lookup_hops_o(lookup_hops_arr)
  );
endmodule
