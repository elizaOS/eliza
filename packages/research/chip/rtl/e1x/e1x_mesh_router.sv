`include "rtl/e1x/e1x_pkg.sv"

module e1x_mesh_router #(
  parameter int PORTS = e1x_pkg::E1X_PORTS,
  parameter int COLORS = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic repair_enable_i,
  input  logic [PORTS-1:0] port_disable_i,
  input  logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input  logic [PORTS-1:0] in_valid_i,
  input  logic [PORTS-1:0][$clog2(COLORS)-1:0] in_color_i,
  input  logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload_i,
  output logic [PORTS-1:0] in_ready_o,
  output logic [PORTS-1:0] out_valid_o,
  output logic [PORTS-1:0][$clog2(COLORS)-1:0] out_color_o,
  output logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload_o,
  output logic [PORTS-1:0] repaired_drop_o
);

  always_comb begin
    logic [PORTS-1:0] used_outputs;
    logic [2:0] raw_dir;
    logic [$clog2(COLORS)-1:0] color;
    int out_port;
    in_ready_o = '0;
    out_valid_o = '0;
    out_color_o = '0;
    out_payload_o = '0;
    repaired_drop_o = '0;
    used_outputs = '0;

    for (int in_port = 0; in_port < PORTS; in_port++) begin
      color = in_color_i[in_port];
      raw_dir = route_table_i[color][in_port];
      out_port = int'(raw_dir);

      if (in_valid_i[in_port] && !port_disable_i[in_port] && raw_dir != e1x_pkg::E1X_DIR_DROP) begin
        if (out_port < PORTS && !port_disable_i[out_port] && !used_outputs[out_port]) begin
          out_valid_o[out_port] = 1'b1;
          used_outputs[out_port] = 1'b1;
          out_color_o[out_port] = color;
          out_payload_o[out_port] = in_payload_i[in_port];
          in_ready_o[in_port] = 1'b1;
        end else if (repair_enable_i) begin
          repaired_drop_o[in_port] = 1'b1;
          in_ready_o[in_port] = 1'b1;
        end
      end else if (in_valid_i[in_port] && repair_enable_i) begin
        repaired_drop_o[in_port] = 1'b1;
        in_ready_o[in_port] = 1'b1;
      end
    end
  end

  logic unused_clk;
  logic unused_rst_n;
  assign unused_clk = clk_i;
  assign unused_rst_n = rst_ni;
endmodule
