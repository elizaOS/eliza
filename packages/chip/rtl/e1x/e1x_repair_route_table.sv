`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_route_table #(
  parameter int LOOKUP_PORTS = e1x_pkg::E1X_PORTS,
  parameter int INDEX_BITS = 32,
  parameter int HOP_BITS = 16,
  parameter int MAX_ROUTES = 16
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,
  input  logic word_valid_i,
  input  logic [63:0] word_i,
  output logic word_ready_o,
  output logic load_done_o,
  output logic load_error_o,
  output logic overflow_o,
  output logic [31:0] remap_count_o,
  output logic [31:0] route_count_o,
  input  logic [LOOKUP_PORTS-1:0] lookup_valid_i,
  input  logic [LOOKUP_PORTS-1:0][INDEX_BITS-1:0] lookup_from_i,
  input  logic [LOOKUP_PORTS-1:0][INDEX_BITS-1:0] lookup_to_i,
  output logic [LOOKUP_PORTS-1:0] lookup_hit_o,
  output logic [LOOKUP_PORTS-1:0][2:0] lookup_dir_o,
  output logic [LOOKUP_PORTS-1:0][HOP_BITS-1:0] lookup_hops_o
);
  logic header_valid;
  logic remap_valid;
  logic [INDEX_BITS-1:0] remap_logical;
  logic [INDEX_BITS-1:0] remap_physical;
  logic route_valid;
  logic [INDEX_BITS-1:0] route_logical_from;
  logic [INDEX_BITS-1:0] route_logical_to;
  logic [2:0] route_dir;
  logic [HOP_BITS-1:0] route_hops;
  logic [31:0] rom_remap_count;
  logic [31:0] rom_route_count;
  logic [31:0] words_seen;

  logic [INDEX_BITS-1:0] route_from_mem [MAX_ROUTES-1:0];
  logic [INDEX_BITS-1:0] route_to_mem [MAX_ROUTES-1:0];
  logic [2:0] route_dir_mem [MAX_ROUTES-1:0];
  logic [HOP_BITS-1:0] route_hops_mem [MAX_ROUTES-1:0];
  logic [31:0] routes_stored_q;
  logic overflow_q;

  e1x_repair_rom_loader #(
    .INDEX_BITS(INDEX_BITS),
    .HOP_BITS(HOP_BITS)
  ) u_loader (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .clear_i(clear_i),
    .word_valid_i(word_valid_i),
    .word_i(word_i),
    .word_ready_o(word_ready_o),
    .header_valid_o(header_valid),
    .remap_valid_o(remap_valid),
    .remap_logical_o(remap_logical),
    .remap_physical_o(remap_physical),
    .route_valid_o(route_valid),
    .route_logical_from_o(route_logical_from),
    .route_logical_to_o(route_logical_to),
    .route_dir_o(route_dir),
    .route_hops_o(route_hops),
    .done_o(load_done_o),
    .error_o(load_error_o),
    .remap_count_o(rom_remap_count),
    .route_count_o(rom_route_count),
    .words_seen_o(words_seen)
  );

  assign route_count_o = routes_stored_q;
  assign remap_count_o = rom_remap_count;
  assign overflow_o = overflow_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      routes_stored_q <= '0;
      overflow_q <= 1'b0;
      for (int idx = 0; idx < MAX_ROUTES; idx++) begin
        route_from_mem[idx] <= '0;
        route_to_mem[idx] <= '0;
        route_dir_mem[idx] <= '0;
        route_hops_mem[idx] <= '0;
      end
    end else if (clear_i) begin
      routes_stored_q <= '0;
      overflow_q <= 1'b0;
    end else if (route_valid) begin
      if (routes_stored_q < MAX_ROUTES) begin
        route_from_mem[routes_stored_q] <= route_logical_from;
        route_to_mem[routes_stored_q] <= route_logical_to;
        route_dir_mem[routes_stored_q] <= route_dir;
        route_hops_mem[routes_stored_q] <= route_hops;
        routes_stored_q <= routes_stored_q + 32'd1;
      end else begin
        overflow_q <= 1'b1;
      end
    end
  end

  always_comb begin
    lookup_hit_o = '0;
    lookup_dir_o = '0;
    lookup_hops_o = '0;
    for (int port = 0; port < LOOKUP_PORTS; port++) begin
      lookup_dir_o[port] = e1x_pkg::E1X_DIR_DROP;
      if (lookup_valid_i[port]) begin
        for (int idx = 0; idx < MAX_ROUTES; idx++) begin
          if (
            idx < routes_stored_q &&
            route_from_mem[idx] == lookup_from_i[port] &&
            route_to_mem[idx] == lookup_to_i[port]
          ) begin
            lookup_hit_o[port] = 1'b1;
            lookup_dir_o[port] = route_dir_mem[idx];
            lookup_hops_o[port] = route_hops_mem[idx];
          end
        end
      end
    end
  end

  logic unused_loader_fields;
  assign unused_loader_fields =
    header_valid ^ remap_valid ^ ^remap_logical ^ ^remap_physical ^ ^rom_remap_count ^
    ^rom_route_count ^ ^words_seen;
endmodule
