`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_state #(
  parameter int INDEX_BITS = 32,
  parameter int HOP_BITS = 16,
  parameter int MAX_REMAPS = 16,
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
  input  logic remap_lookup_valid_i,
  input  logic [INDEX_BITS-1:0] remap_lookup_logical_i,
  output logic remap_lookup_hit_o,
  output logic [INDEX_BITS-1:0] remap_lookup_physical_o,
  input  logic route_lookup_valid_i,
  input  logic [INDEX_BITS-1:0] route_lookup_from_i,
  input  logic [INDEX_BITS-1:0] route_lookup_to_i,
  output logic route_lookup_hit_o,
  output logic [2:0] route_lookup_dir_o,
  output logic [HOP_BITS-1:0] route_lookup_hops_o
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

  logic [INDEX_BITS-1:0] remap_logical_mem [MAX_REMAPS-1:0];
  logic [INDEX_BITS-1:0] remap_physical_mem [MAX_REMAPS-1:0];
  logic [INDEX_BITS-1:0] route_from_mem [MAX_ROUTES-1:0];
  logic [INDEX_BITS-1:0] route_to_mem [MAX_ROUTES-1:0];
  logic [2:0] route_dir_mem [MAX_ROUTES-1:0];
  logic [HOP_BITS-1:0] route_hops_mem [MAX_ROUTES-1:0];
  logic [31:0] remaps_stored_q;
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

  assign remap_count_o = remaps_stored_q;
  assign route_count_o = routes_stored_q;
  assign overflow_o = overflow_q;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      remaps_stored_q <= '0;
      routes_stored_q <= '0;
      overflow_q <= 1'b0;
      for (int idx = 0; idx < MAX_REMAPS; idx++) begin
        remap_logical_mem[idx] <= '0;
        remap_physical_mem[idx] <= '0;
      end
      for (int idx = 0; idx < MAX_ROUTES; idx++) begin
        route_from_mem[idx] <= '0;
        route_to_mem[idx] <= '0;
        route_dir_mem[idx] <= '0;
        route_hops_mem[idx] <= '0;
      end
    end else if (clear_i) begin
      remaps_stored_q <= '0;
      routes_stored_q <= '0;
      overflow_q <= 1'b0;
    end else begin
      if (remap_valid) begin
        if (remaps_stored_q < MAX_REMAPS) begin
          remap_logical_mem[remaps_stored_q] <= remap_logical;
          remap_physical_mem[remaps_stored_q] <= remap_physical;
          remaps_stored_q <= remaps_stored_q + 32'd1;
        end else begin
          overflow_q <= 1'b1;
        end
      end

      if (route_valid) begin
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
  end

  always_comb begin
    remap_lookup_hit_o = 1'b0;
    remap_lookup_physical_o = remap_lookup_logical_i;
    if (remap_lookup_valid_i) begin
      for (int idx = 0; idx < MAX_REMAPS; idx++) begin
        if (idx < remaps_stored_q && remap_logical_mem[idx] == remap_lookup_logical_i) begin
          remap_lookup_hit_o = 1'b1;
          remap_lookup_physical_o = remap_physical_mem[idx];
        end
      end
    end
  end

  always_comb begin
    route_lookup_hit_o = 1'b0;
    route_lookup_dir_o = e1x_pkg::E1X_DIR_DROP;
    route_lookup_hops_o = '0;
    if (route_lookup_valid_i) begin
      for (int idx = 0; idx < MAX_ROUTES; idx++) begin
        if (
          idx < routes_stored_q &&
          route_from_mem[idx] == route_lookup_from_i &&
          route_to_mem[idx] == route_lookup_to_i
        ) begin
          route_lookup_hit_o = 1'b1;
          route_lookup_dir_o = route_dir_mem[idx];
          route_lookup_hops_o = route_hops_mem[idx];
        end
      end
    end
  end

  logic unused_status;
  assign unused_status = header_valid ^ ^rom_remap_count ^ ^rom_route_count ^ ^words_seen;
endmodule
