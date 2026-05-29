`include "rtl/e1x/e1x_pkg.sv"

// Flat-port wrapper around e1x_credit_router for cocotb (Verilator) which
// cannot drive SystemVerilog packed-array top-level ports directly.
module e1x_credit_router_tb #(
  parameter int PORTS        = e1x_pkg::E1X_PORTS,
  parameter int COLORS       = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int FIFO_DEPTH   = 4,
  parameter int CREDIT_MAX   = 4
) (
  input  logic clk,
  input  logic rst_n,
  input  logic repair_enable,
  input  logic [PORTS-1:0] port_disable,

  input  logic                                              prog_we,
  input  logic [$clog2(COLORS)+$clog2(PORTS)-1:0]           prog_addr,
  input  logic [2:0]                                        prog_dir_in,
  output logic [2:0]                                        prog_dir_out,

  input  logic [PORTS-1:0]                                  in_valid,
  input  logic [PORTS*$clog2(COLORS)-1:0]                   in_color_flat,
  input  logic [PORTS*PAYLOAD_BITS-1:0]                     in_payload_flat,
  output logic [PORTS-1:0]                                  in_ready,

  output logic [PORTS-1:0]                                  out_valid,
  output logic [PORTS*$clog2(COLORS)-1:0]                   out_color_flat,
  output logic [PORTS*PAYLOAD_BITS-1:0]                     out_payload_flat,
  input  logic [PORTS-1:0]                                  out_ready,
  input  logic [PORTS-1:0]                                  out_credit,

  output logic [PORTS-1:0]                                  repaired_drop
);
  import e1x_pkg::*;
  localparam int COLOR_BITS = $clog2(COLORS);

  logic [PORTS-1:0][COLOR_BITS-1:0]   in_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload;
  logic [PORTS-1:0][COLOR_BITS-1:0]   out_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload;

  always_comb begin
    out_color_flat   = '0;
    out_payload_flat = '0;
    for (int p = 0; p < PORTS; p++) begin
      in_color[p]   = in_color_flat[p*COLOR_BITS +: COLOR_BITS];
      in_payload[p] = in_payload_flat[p*PAYLOAD_BITS +: PAYLOAD_BITS];
      out_color_flat[p*COLOR_BITS +: COLOR_BITS]     = out_color[p];
      out_payload_flat[p*PAYLOAD_BITS +: PAYLOAD_BITS] = out_payload[p];
    end
  end

  e1x_credit_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS),
    .FIFO_DEPTH(FIFO_DEPTH),
    .CREDIT_MAX(CREDIT_MAX)
  ) u_dut (
    .clk_i(clk),
    .rst_ni(rst_n),
    .repair_enable_i(repair_enable),
    .port_disable_i(port_disable),
    .prog_we_i(prog_we),
    .prog_addr_i(prog_addr),
    .prog_dir_i(prog_dir_in),
    .prog_dir_o(prog_dir_out),
    .in_valid_i(in_valid),
    .in_color_i(in_color),
    .in_payload_i(in_payload),
    .in_ready_o(in_ready),
    .out_valid_o(out_valid),
    .out_color_o(out_color),
    .out_payload_o(out_payload),
    .out_ready_i(out_ready),
    .out_credit_i(out_credit),
    .repaired_drop_o(repaired_drop)
  );
endmodule
