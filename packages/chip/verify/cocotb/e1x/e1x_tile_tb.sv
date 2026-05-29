`include "rtl/e1x/e1x_pkg.sv"

module e1x_tile_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic core_enable,
  input  logic core_instr_valid,
  input  logic [31:0] core_instr,
  input  logic repair_enable,
  input  logic [4:0] port_disable,
  input  logic [e1x_pkg::E1X_ROUTING_COLORS*e1x_pkg::E1X_PORTS*3-1:0] route_table_flat,
  input  logic [3:0] fabric_valid,
  input  logic [4*$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] fabric_color_flat,
  input  logic [4*e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] fabric_payload_flat,
  output logic [3:0] fabric_ready,
  output logic [3:0] fabric_valid_out,
  output logic [4*$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] fabric_color_out_flat,
  output logic [4*e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] fabric_payload_out_flat,
  output logic [31:0] core_pc,
  output logic [63:0] core_x1,
  output logic [63:0] core_x2,
  output logic [63:0] core_x3,
  output logic [63:0] core_x10,
  output logic core_halted,
  output logic core_active,
  output logic repaired_drop
);
  import e1x_pkg::*;

  logic [E1X_ROUTING_COLORS-1:0][E1X_PORTS-1:0][2:0] route_table;
  logic [3:0][$clog2(E1X_ROUTING_COLORS)-1:0] fabric_color;
  logic [3:0][$clog2(E1X_ROUTING_COLORS)-1:0] fabric_color_out;
  logic [3:0][E1X_FABRIC_PAYLOAD_BITS-1:0] fabric_payload;
  logic [3:0][E1X_FABRIC_PAYLOAD_BITS-1:0] fabric_payload_out;

  always_comb begin
    route_table = '0;
    for (int color = 0; color < E1X_ROUTING_COLORS; color++) begin
      for (int port = 0; port < E1X_PORTS; port++) begin
        route_table[color][port] =
          route_table_flat[(color * E1X_PORTS + port) * 3 +: 3];
      end
    end

    fabric_color = '0;
    fabric_payload = '0;
    fabric_color_out_flat = '0;
    fabric_payload_out_flat = '0;
    for (int port = 0; port < 4; port++) begin
      fabric_color[port] =
        fabric_color_flat[port * $clog2(E1X_ROUTING_COLORS) +: $clog2(E1X_ROUTING_COLORS)];
      fabric_payload[port] =
        fabric_payload_flat[port * E1X_FABRIC_PAYLOAD_BITS +: E1X_FABRIC_PAYLOAD_BITS];
      fabric_color_out_flat[port * $clog2(E1X_ROUTING_COLORS) +: $clog2(E1X_ROUTING_COLORS)] =
        fabric_color_out[port];
      fabric_payload_out_flat[port * E1X_FABRIC_PAYLOAD_BITS +: E1X_FABRIC_PAYLOAD_BITS] =
        fabric_payload_out[port];
    end
  end

  e1x_tile u_tile (
    .clk_i(clk),
    .rst_ni(rst_n),
    .core_enable_i(core_enable),
    .core_instr_valid_i(core_instr_valid),
    .core_instr_i(core_instr),
    .repair_enable_i(repair_enable),
    .port_disable_i(port_disable),
    .route_table_i(route_table),
    .fabric_valid_i(fabric_valid),
    .fabric_color_i(fabric_color),
    .fabric_payload_i(fabric_payload),
    .fabric_ready_o(fabric_ready),
    .fabric_valid_o(fabric_valid_out),
    .fabric_color_o(fabric_color_out),
    .fabric_payload_o(fabric_payload_out),
    .core_pc_o(core_pc),
    .core_x1_o(core_x1),
    .core_x2_o(core_x2),
    .core_x3_o(core_x3),
    .core_x10_o(core_x10),
    .core_halted_o(core_halted),
    .core_active_o(core_active),
    .repaired_drop_o(repaired_drop)
  );
endmodule
