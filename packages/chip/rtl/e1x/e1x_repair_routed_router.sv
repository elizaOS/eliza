`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_routed_router #(
  parameter int PORTS = e1x_pkg::E1X_PORTS,
  parameter int COLORS = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int INDEX_BITS = 32,
  parameter int HOP_BITS = 16,
  parameter int MAX_REMAPS = 16,
  parameter int MAX_ROUTES = 16
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,
  input  logic repair_enable_i,
  input  logic repair_word_valid_i,
  input  logic [63:0] repair_word_i,
  output logic repair_word_ready_o,
  output logic repair_load_done_o,
  output logic repair_load_error_o,
  output logic repair_overflow_o,
  output logic [31:0] repair_remap_count_o,
  output logic [31:0] repair_route_count_o,
  input  logic [PORTS-1:0] port_disable_i,
  input  logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input  logic [PORTS-1:0] in_valid_i,
  input  logic [PORTS-1:0][$clog2(COLORS)-1:0] in_color_i,
  input  logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload_i,
  input  logic [PORTS-1:0][INDEX_BITS-1:0] in_src_logical_i,
  input  logic [PORTS-1:0][INDEX_BITS-1:0] in_dst_logical_i,
  output logic [PORTS-1:0] in_ready_o,
  output logic [PORTS-1:0] out_valid_o,
  output logic [PORTS-1:0][$clog2(COLORS)-1:0] out_color_o,
  output logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload_o,
  output logic [PORTS-1:0][INDEX_BITS-1:0] out_src_logical_o,
  output logic [PORTS-1:0][INDEX_BITS-1:0] out_dst_logical_o,
  output logic [PORTS-1:0] repaired_drop_o,
  output logic [PORTS-1:0] repair_override_used_o,
  output logic [PORTS-1:0][HOP_BITS-1:0] repair_route_hops_o
);
  logic [PORTS-1:0] route_lookup_hit;
  logic [PORTS-1:0][2:0] route_lookup_dir;
  logic [PORTS-1:0][HOP_BITS-1:0] route_lookup_hops;
  logic [PORTS-1:0] repair_route_hit;
  logic [COLORS-1:0][PORTS-1:0][2:0] effective_route_table;

  assign repair_route_hops_o = route_lookup_hops;

  e1x_repair_route_table #(
    .LOOKUP_PORTS(PORTS),
    .INDEX_BITS(INDEX_BITS),
    .HOP_BITS(HOP_BITS),
    .MAX_ROUTES(MAX_ROUTES)
  ) u_repair_route_table (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .clear_i(clear_i),
    .word_valid_i(repair_word_valid_i),
    .word_i(repair_word_i),
    .word_ready_o(repair_word_ready_o),
    .load_done_o(repair_load_done_o),
    .load_error_o(repair_load_error_o),
    .overflow_o(repair_overflow_o),
    .remap_count_o(repair_remap_count_o),
    .route_count_o(repair_route_count_o),
    .lookup_valid_i(in_valid_i),
    .lookup_from_i(in_src_logical_i),
    .lookup_to_i(in_dst_logical_i),
    .lookup_hit_o(route_lookup_hit),
    .lookup_dir_o(route_lookup_dir),
    .lookup_hops_o(route_lookup_hops)
  );

  always_comb begin
    automatic logic [PORTS-1:0] used_metadata_outputs;
    for (int port = 0; port < PORTS; port++) begin
      repair_route_hit[port] = route_lookup_hit[port] & in_valid_i[port];
    end
    effective_route_table = route_table_i;
    if (repair_enable_i) begin
      for (int port = 0; port < PORTS; port++) begin
        if (repair_route_hit[port]) begin
          effective_route_table[in_color_i[port]][port] = route_lookup_dir[port];
        end
      end
    end

    out_src_logical_o = '0;
    out_dst_logical_o = '0;
    used_metadata_outputs = '0;
    for (int in_port = 0; in_port < PORTS; in_port++) begin
      automatic logic [2:0] raw_dir;
      automatic int out_port;

      raw_dir = effective_route_table[in_color_i[in_port]][in_port];
      out_port = int'(raw_dir);
      if (
        in_valid_i[in_port] &&
        !port_disable_i[in_port] &&
        raw_dir != e1x_pkg::E1X_DIR_DROP &&
        out_port < PORTS &&
        !port_disable_i[out_port] &&
        !used_metadata_outputs[out_port]
      ) begin
        out_src_logical_o[out_port] = in_src_logical_i[in_port];
        out_dst_logical_o[out_port] = in_dst_logical_i[in_port];
        used_metadata_outputs[out_port] = 1'b1;
      end
    end
  end

  e1x_repair_aware_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS)
  ) u_router (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .repair_enable_i(repair_enable_i),
    .port_disable_i(port_disable_i),
    .route_table_i(route_table_i),
    .repair_route_hit_i(repair_route_hit),
    .repair_route_dir_i(route_lookup_dir),
    .in_valid_i(in_valid_i),
    .in_color_i(in_color_i),
    .in_payload_i(in_payload_i),
    .in_ready_o(in_ready_o),
    .out_valid_o(out_valid_o),
    .out_color_o(out_color_o),
    .out_payload_o(out_payload_o),
    .repaired_drop_o(repaired_drop_o),
    .repair_override_used_o(repair_override_used_o)
  );
  logic unused_max_remaps;
  assign unused_max_remaps = ^MAX_REMAPS;
endmodule
