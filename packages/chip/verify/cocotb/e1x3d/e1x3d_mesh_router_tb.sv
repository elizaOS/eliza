`include "rtl/e1x3d/e1x3d_pkg.sv"
`include "rtl/e1x/e1x_pkg.sv"

// 3D fabric router testbench: the verified PORTS-parametric e1x_mesh_router
// instantiated with seven ports (N/E/S/W/LOCAL/UP/DOWN). It proves the router
// forwards on the inter-tier UP/DOWN directions and repair-drops a disabled Z
// link, with no change to the router RTL.
module e1x3d_mesh_router_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic repair_enable,
  input  logic [e1x3d_pkg::E1X3D_PORTS-1:0] port_disable,
  input  logic [e1x3d_pkg::E1X3D_ROUTING_COLORS*e1x3d_pkg::E1X3D_PORTS*3-1:0] route_table_flat,
  input  logic [e1x3d_pkg::E1X3D_PORTS-1:0] in_valid,
  input  logic [e1x3d_pkg::E1X3D_PORTS*$clog2(e1x3d_pkg::E1X3D_ROUTING_COLORS)-1:0] in_color_flat,
  input  logic [e1x3d_pkg::E1X3D_PORTS*e1x3d_pkg::E1X3D_FABRIC_PAYLOAD_BITS-1:0] in_payload_flat,
  output logic [e1x3d_pkg::E1X3D_PORTS-1:0] in_ready,
  output logic [e1x3d_pkg::E1X3D_PORTS-1:0] out_valid,
  output logic [e1x3d_pkg::E1X3D_PORTS*$clog2(e1x3d_pkg::E1X3D_ROUTING_COLORS)-1:0] out_color_flat,
  output logic [e1x3d_pkg::E1X3D_PORTS*e1x3d_pkg::E1X3D_FABRIC_PAYLOAD_BITS-1:0] out_payload_flat,
  output logic [e1x3d_pkg::E1X3D_PORTS-1:0] repaired_drop
);
  import e1x3d_pkg::*;
  localparam int PORTS = E1X3D_PORTS;
  localparam int COLORS = E1X3D_ROUTING_COLORS;
  localparam int PAYLOAD_BITS = E1X3D_FABRIC_PAYLOAD_BITS;
  localparam int COLOR_BITS = $clog2(COLORS);

  logic [COLORS-1:0][PORTS-1:0][2:0] route_table;
  logic [PORTS-1:0][COLOR_BITS-1:0] in_color;
  logic [PORTS-1:0][COLOR_BITS-1:0] out_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload;

  always_comb begin
    route_table = '0;
    for (int color = 0; color < COLORS; color++) begin
      for (int port = 0; port < PORTS; port++) begin
        route_table[color][port] = route_table_flat[(color * PORTS + port) * 3 +: 3];
      end
    end
    in_color = '0;
    in_payload = '0;
    out_payload_flat = '0;
    out_color_flat = '0;
    for (int port = 0; port < PORTS; port++) begin
      in_color[port] = in_color_flat[port * COLOR_BITS +: COLOR_BITS];
      in_payload[port] = in_payload_flat[port * PAYLOAD_BITS +: PAYLOAD_BITS];
      out_payload_flat[port * PAYLOAD_BITS +: PAYLOAD_BITS] = out_payload[port];
      out_color_flat[port * COLOR_BITS +: COLOR_BITS] = out_color[port];
    end
  end

  e1x_mesh_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS)
  ) u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .repair_enable_i(repair_enable),
    .port_disable_i(port_disable),
    .route_table_i(route_table),
    .in_valid_i(in_valid),
    .in_color_i(in_color),
    .in_payload_i(in_payload),
    .in_ready_o(in_ready),
    .out_valid_o(out_valid),
    .out_color_o(out_color),
    .out_payload_o(out_payload),
    .repaired_drop_o(repaired_drop)
  );
endmodule
