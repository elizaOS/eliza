`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_aware_router #(
  parameter int PORTS = e1x_pkg::E1X_PORTS,
  parameter int COLORS = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic repair_enable_i,
  input  logic [PORTS-1:0] port_disable_i,
  input  logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input  logic [PORTS-1:0] repair_route_hit_i,
  input  logic [PORTS-1:0][2:0] repair_route_dir_i,
  input  logic [PORTS-1:0] in_valid_i,
  input  logic [PORTS-1:0][$clog2(COLORS)-1:0] in_color_i,
  input  logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload_i,
  output logic [PORTS-1:0] in_ready_o,
  output logic [PORTS-1:0] out_valid_o,
  output logic [PORTS-1:0][$clog2(COLORS)-1:0] out_color_o,
  output logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload_o,
  output logic [PORTS-1:0] repaired_drop_o,
  output logic [PORTS-1:0] repair_override_used_o
);
  logic [COLORS-1:0][PORTS-1:0][2:0] effective_route_table;

  always_comb begin
    effective_route_table = route_table_i;
    repair_override_used_o = '0;
    if (repair_enable_i) begin
      for (int port = 0; port < PORTS; port++) begin
        if (in_valid_i[port] && repair_route_hit_i[port]) begin
          effective_route_table[in_color_i[port]][port] = repair_route_dir_i[port];
          repair_override_used_o[port] = 1'b1;
        end
      end
    end
  end

  e1x_mesh_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS)
  ) u_router (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .repair_enable_i(repair_enable_i),
    .port_disable_i(port_disable_i),
    .route_table_i(effective_route_table),
    .in_valid_i(in_valid_i),
    .in_color_i(in_color_i),
    .in_payload_i(in_payload_i),
    .in_ready_o(in_ready_o),
    .out_valid_o(out_valid_o),
    .out_color_o(out_color_o),
    .out_payload_o(out_payload_o),
    .repaired_drop_o(repaired_drop_o)
  );
endmodule
