`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_aware_router_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic repair_enable,
  input  logic [4:0] port_disable,
  input  logic [e1x_pkg::E1X_ROUTING_COLORS*e1x_pkg::E1X_PORTS*3-1:0] route_table_flat,
  input  logic [4:0] repair_route_hit,
  input  logic [e1x_pkg::E1X_PORTS*3-1:0] repair_route_dir_flat,
  input  logic [4:0] in_valid,
  input  logic [e1x_pkg::E1X_PORTS*$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] in_color_flat,
  input  logic [e1x_pkg::E1X_PORTS*e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] in_payload_flat,
  output logic [4:0] in_ready,
  output logic [4:0] out_valid,
  output logic [e1x_pkg::E1X_PORTS*$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] out_color_flat,
  output logic [e1x_pkg::E1X_PORTS*e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] out_payload_flat,
  output logic [4:0] repaired_drop,
  output logic [4:0] repair_override_used
);
  import e1x_pkg::*;

  logic [E1X_ROUTING_COLORS-1:0][E1X_PORTS-1:0][2:0] route_table;
  logic [E1X_PORTS-1:0][2:0] repair_route_dir;
  logic [E1X_PORTS-1:0][$clog2(E1X_ROUTING_COLORS)-1:0] in_color;
  logic [E1X_PORTS-1:0][$clog2(E1X_ROUTING_COLORS)-1:0] out_color;
  logic [E1X_PORTS-1:0][E1X_FABRIC_PAYLOAD_BITS-1:0] in_payload;
  logic [E1X_PORTS-1:0][E1X_FABRIC_PAYLOAD_BITS-1:0] out_payload;

  always_comb begin
    route_table = '0;
    repair_route_dir = '0;
    in_color = '0;
    in_payload = '0;
    out_payload_flat = '0;
    out_color_flat = '0;
    for (int color = 0; color < E1X_ROUTING_COLORS; color++) begin
      for (int port = 0; port < E1X_PORTS; port++) begin
        route_table[color][port] =
          route_table_flat[(color * E1X_PORTS + port) * 3 +: 3];
      end
    end
    for (int port = 0; port < E1X_PORTS; port++) begin
      repair_route_dir[port] = repair_route_dir_flat[port * 3 +: 3];
      in_color[port] =
        in_color_flat[port * $clog2(E1X_ROUTING_COLORS) +: $clog2(E1X_ROUTING_COLORS)];
      in_payload[port] =
        in_payload_flat[port * E1X_FABRIC_PAYLOAD_BITS +: E1X_FABRIC_PAYLOAD_BITS];
      out_payload_flat[port * E1X_FABRIC_PAYLOAD_BITS +: E1X_FABRIC_PAYLOAD_BITS] =
        out_payload[port];
      out_color_flat[port * $clog2(E1X_ROUTING_COLORS) +: $clog2(E1X_ROUTING_COLORS)] =
        out_color[port];
    end
  end

  e1x_repair_aware_router u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .repair_enable_i(repair_enable),
    .port_disable_i(port_disable),
    .route_table_i(route_table),
    .repair_route_hit_i(repair_route_hit),
    .repair_route_dir_i(repair_route_dir),
    .in_valid_i(in_valid),
    .in_color_i(in_color),
    .in_payload_i(in_payload),
    .in_ready_o(in_ready),
    .out_valid_o(out_valid),
    .out_color_o(out_color),
    .out_payload_o(out_payload),
    .repaired_drop_o(repaired_drop),
    .repair_override_used_o(repair_override_used)
  );
endmodule
