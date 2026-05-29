`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_route_table_tb (
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
  input  logic [3:0] lookup_valid,
  input  logic [4*32-1:0] lookup_from_flat,
  input  logic [4*32-1:0] lookup_to_flat,
  output logic [3:0] lookup_hit,
  output logic [4*3-1:0] lookup_dir_flat,
  output logic [4*16-1:0] lookup_hops_flat
);
  logic [3:0][31:0] lookup_from;
  logic [3:0][31:0] lookup_to;
  logic [3:0][2:0] lookup_dir;
  logic [3:0][15:0] lookup_hops;

  always_comb begin
    lookup_from = '0;
    lookup_to = '0;
    lookup_dir_flat = '0;
    lookup_hops_flat = '0;
    for (int port = 0; port < 4; port++) begin
      lookup_from[port] = lookup_from_flat[port * 32 +: 32];
      lookup_to[port] = lookup_to_flat[port * 32 +: 32];
      lookup_dir_flat[port * 3 +: 3] = lookup_dir[port];
      lookup_hops_flat[port * 16 +: 16] = lookup_hops[port];
    end
  end

  e1x_repair_route_table #(
    .LOOKUP_PORTS(4),
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
    .lookup_valid_i(lookup_valid),
    .lookup_from_i(lookup_from),
    .lookup_to_i(lookup_to),
    .lookup_hit_o(lookup_hit),
    .lookup_dir_o(lookup_dir),
    .lookup_hops_o(lookup_hops)
  );
endmodule
