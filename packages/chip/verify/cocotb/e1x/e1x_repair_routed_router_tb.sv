`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_routed_router_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic clear,
  input  logic repair_enable,
  input  logic repair_word_valid,
  input  logic [63:0] repair_word,
  output logic repair_word_ready,
  output logic repair_load_done,
  output logic repair_load_error,
  output logic repair_overflow,
  output logic [31:0] repair_remap_count,
  output logic [31:0] repair_route_count,
  input  logic [4:0] port_disable,
  input  logic [e1x_pkg::E1X_ROUTING_COLORS*e1x_pkg::E1X_PORTS*3-1:0] route_table_flat,
  input  logic [4:0] in_valid,
  input  logic [e1x_pkg::E1X_PORTS*$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] in_color_flat,
  input  logic [e1x_pkg::E1X_PORTS*e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] in_payload_flat,
  input  logic [e1x_pkg::E1X_PORTS*32-1:0] in_src_logical_flat,
  input  logic [e1x_pkg::E1X_PORTS*32-1:0] in_dst_logical_flat,
  output logic [4:0] in_ready,
  output logic [4:0] out_valid,
  output logic [e1x_pkg::E1X_PORTS*$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] out_color_flat,
  output logic [e1x_pkg::E1X_PORTS*e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] out_payload_flat,
  output logic [e1x_pkg::E1X_PORTS*32-1:0] out_src_logical_flat,
  output logic [e1x_pkg::E1X_PORTS*32-1:0] out_dst_logical_flat,
  output logic [4:0] repaired_drop,
  output logic [4:0] repair_override_used,
  output logic [e1x_pkg::E1X_PORTS*16-1:0] repair_route_hops_flat
);
  import e1x_pkg::*;

  logic [E1X_ROUTING_COLORS-1:0][E1X_PORTS-1:0][2:0] route_table;
  logic [E1X_PORTS-1:0][$clog2(E1X_ROUTING_COLORS)-1:0] in_color;
  logic [E1X_PORTS-1:0][$clog2(E1X_ROUTING_COLORS)-1:0] out_color;
  logic [E1X_PORTS-1:0][E1X_FABRIC_PAYLOAD_BITS-1:0] in_payload;
  logic [E1X_PORTS-1:0][E1X_FABRIC_PAYLOAD_BITS-1:0] out_payload;
  logic [E1X_PORTS-1:0][31:0] in_src_logical;
  logic [E1X_PORTS-1:0][31:0] in_dst_logical;
  logic [E1X_PORTS-1:0][31:0] out_src_logical;
  logic [E1X_PORTS-1:0][31:0] out_dst_logical;
  logic [E1X_PORTS-1:0][15:0] repair_route_hops;

  always_comb begin
    route_table = '0;
    in_color = '0;
    in_payload = '0;
    in_src_logical = '0;
    in_dst_logical = '0;
    out_payload_flat = '0;
    out_color_flat = '0;
    out_src_logical_flat = '0;
    out_dst_logical_flat = '0;
    repair_route_hops_flat = '0;
    for (int color = 0; color < E1X_ROUTING_COLORS; color++) begin
      for (int port = 0; port < E1X_PORTS; port++) begin
        route_table[color][port] =
          route_table_flat[(color * E1X_PORTS + port) * 3 +: 3];
      end
    end
    for (int port = 0; port < E1X_PORTS; port++) begin
      in_color[port] =
        in_color_flat[port * $clog2(E1X_ROUTING_COLORS) +: $clog2(E1X_ROUTING_COLORS)];
      in_payload[port] =
        in_payload_flat[port * E1X_FABRIC_PAYLOAD_BITS +: E1X_FABRIC_PAYLOAD_BITS];
      in_src_logical[port] = in_src_logical_flat[port * 32 +: 32];
      in_dst_logical[port] = in_dst_logical_flat[port * 32 +: 32];
      out_payload_flat[port * E1X_FABRIC_PAYLOAD_BITS +: E1X_FABRIC_PAYLOAD_BITS] =
        out_payload[port];
      out_color_flat[port * $clog2(E1X_ROUTING_COLORS) +: $clog2(E1X_ROUTING_COLORS)] =
        out_color[port];
      out_src_logical_flat[port * 32 +: 32] = out_src_logical[port];
      out_dst_logical_flat[port * 32 +: 32] = out_dst_logical[port];
      repair_route_hops_flat[port * 16 +: 16] = repair_route_hops[port];
    end
  end

  e1x_repair_routed_router #(
    .MAX_REMAPS(8),
    .MAX_ROUTES(8)
  ) u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .clear_i(clear),
    .repair_enable_i(repair_enable),
    .repair_word_valid_i(repair_word_valid),
    .repair_word_i(repair_word),
    .repair_word_ready_o(repair_word_ready),
    .repair_load_done_o(repair_load_done),
    .repair_load_error_o(repair_load_error),
    .repair_overflow_o(repair_overflow),
    .repair_remap_count_o(repair_remap_count),
    .repair_route_count_o(repair_route_count),
    .port_disable_i(port_disable),
    .route_table_i(route_table),
    .in_valid_i(in_valid),
    .in_color_i(in_color),
    .in_payload_i(in_payload),
    .in_src_logical_i(in_src_logical),
    .in_dst_logical_i(in_dst_logical),
    .in_ready_o(in_ready),
    .out_valid_o(out_valid),
    .out_color_o(out_color),
    .out_payload_o(out_payload),
    .out_src_logical_o(out_src_logical),
    .out_dst_logical_o(out_dst_logical),
    .repaired_drop_o(repaired_drop),
    .repair_override_used_o(repair_override_used),
    .repair_route_hops_o(repair_route_hops)
  );
endmodule
