`include "rtl/e1x/e1x_pkg.sv"

// Two credit routers chained East-to-West: router A's East output feeds
// router B's West input, with credit returned from B's input-FIFO occupancy
// back to A's East output. Used to prove a multi-packet burst crosses a
// two-router hop with zero loss.
module e1x_credit_router_chain_tb #(
  parameter int PORTS        = e1x_pkg::E1X_PORTS,
  parameter int COLORS       = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int FIFO_DEPTH   = 4,
  parameter int CREDIT_MAX   = 4
) (
  input  logic clk,
  input  logic rst_n,

  input  logic                                          prog_we,
  input  logic [$clog2(COLORS)+$clog2(PORTS)-1:0]       prog_addr,
  input  logic [2:0]                                    prog_dir_in,
  input  logic                                          prog_sel_b,

  // Inject at router A West input.
  input  logic                                          a_in_valid,
  input  logic [$clog2(COLORS)-1:0]                     a_in_color,
  input  logic [PAYLOAD_BITS-1:0]                       a_in_payload,
  output logic                                          a_in_ready,

  // Consume at router B Local output.
  output logic                                          b_out_valid,
  output logic [$clog2(COLORS)-1:0]                     b_out_color,
  output logic [PAYLOAD_BITS-1:0]                       b_out_payload,
  input  logic                                          b_out_ready
);
  import e1x_pkg::*;
  localparam int COLOR_BITS = $clog2(COLORS);
  localparam int DIR_EAST   = int'(E1X_DIR_EAST);
  localparam int DIR_WEST   = int'(E1X_DIR_WEST);
  localparam int DIR_LOCAL  = int'(E1X_DIR_LOCAL);

  // ---- Router A ----
  logic [PORTS-1:0]                   a_in_valid_v, a_in_ready_v;
  logic [PORTS-1:0][COLOR_BITS-1:0]   a_in_color_v;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] a_in_payload_v;
  logic [PORTS-1:0]                   a_out_valid_v, a_out_ready_v, a_out_credit_v;
  logic [PORTS-1:0][COLOR_BITS-1:0]   a_out_color_v;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] a_out_payload_v;

  // ---- Router B ----
  logic [PORTS-1:0]                   b_in_valid_v, b_in_ready_v;
  logic [PORTS-1:0][COLOR_BITS-1:0]   b_in_color_v;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] b_in_payload_v;
  logic [PORTS-1:0]                   b_out_valid_v, b_out_ready_v, b_out_credit_v;
  logic [PORTS-1:0][COLOR_BITS-1:0]   b_out_color_v;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] b_out_payload_v;

  // Inject into router A West.
  always_comb begin
    a_in_valid_v   = '0;
    a_in_color_v   = '0;
    a_in_payload_v = '0;
    a_in_valid_v[DIR_WEST]   = a_in_valid;
    a_in_color_v[DIR_WEST]   = a_in_color;
    a_in_payload_v[DIR_WEST] = a_in_payload;
  end
  assign a_in_ready = a_in_ready_v[DIR_WEST];

  // A East -> B West link with credit-coupled handshake.
  // B accepts on its West input when b_in_ready; that ready acts as A-East
  // downstream ready, and each accepted flit returns one credit to A East.
  always_comb begin
    b_in_valid_v   = '0;
    b_in_color_v   = '0;
    b_in_payload_v = '0;
    b_in_valid_v[DIR_WEST]   = a_out_valid_v[DIR_EAST];
    b_in_color_v[DIR_WEST]   = a_out_color_v[DIR_EAST];
    b_in_payload_v[DIR_WEST] = a_out_payload_v[DIR_EAST];
  end

  // A East downstream handshake = B West FIFO acceptance.
  logic link_fire;
  assign link_fire = a_out_valid_v[DIR_EAST] && b_in_ready_v[DIR_WEST];

  always_comb begin
    a_out_ready_v  = '0;
    a_out_credit_v = '0;
    a_out_ready_v[DIR_EAST]  = b_in_ready_v[DIR_WEST];
    a_out_credit_v[DIR_EAST] = link_fire;
  end

  // Router B Local output exposed to TB; always crediting + ready-driven.
  always_comb begin
    b_out_ready_v  = '0;
    b_out_credit_v = '0;
    b_out_ready_v[DIR_LOCAL]  = b_out_ready;
    b_out_credit_v[DIR_LOCAL] = b_out_valid_v[DIR_LOCAL] && b_out_ready;
  end
  assign b_out_valid   = b_out_valid_v[DIR_LOCAL];
  assign b_out_color   = b_out_color_v[DIR_LOCAL];
  assign b_out_payload = b_out_payload_v[DIR_LOCAL];

  e1x_credit_router #(
    .PORTS(PORTS), .COLORS(COLORS), .PAYLOAD_BITS(PAYLOAD_BITS),
    .FIFO_DEPTH(FIFO_DEPTH), .CREDIT_MAX(CREDIT_MAX)
  ) u_a (
    .clk_i(clk), .rst_ni(rst_n),
    .repair_enable_i(1'b0), .port_disable_i('0),
    .prog_we_i(prog_we && !prog_sel_b), .prog_addr_i(prog_addr),
    .prog_dir_i(prog_dir_in), .prog_dir_o(),
    .in_valid_i(a_in_valid_v), .in_color_i(a_in_color_v),
    .in_payload_i(a_in_payload_v), .in_ready_o(a_in_ready_v),
    .out_valid_o(a_out_valid_v), .out_color_o(a_out_color_v),
    .out_payload_o(a_out_payload_v), .out_ready_i(a_out_ready_v),
    .out_credit_i(a_out_credit_v), .repaired_drop_o()
  );

  e1x_credit_router #(
    .PORTS(PORTS), .COLORS(COLORS), .PAYLOAD_BITS(PAYLOAD_BITS),
    .FIFO_DEPTH(FIFO_DEPTH), .CREDIT_MAX(CREDIT_MAX)
  ) u_b (
    .clk_i(clk), .rst_ni(rst_n),
    .repair_enable_i(1'b0), .port_disable_i('0),
    .prog_we_i(prog_we && prog_sel_b), .prog_addr_i(prog_addr),
    .prog_dir_i(prog_dir_in), .prog_dir_o(),
    .in_valid_i(b_in_valid_v), .in_color_i(b_in_color_v),
    .in_payload_i(b_in_payload_v), .in_ready_o(b_in_ready_v),
    .out_valid_o(b_out_valid_v), .out_color_o(b_out_color_v),
    .out_payload_o(b_out_payload_v), .out_ready_i(b_out_ready_v),
    .out_credit_i(b_out_credit_v), .repaired_drop_o()
  );
endmodule
