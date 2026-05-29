`include "rtl/e1x3d/e1x3d_pkg.sv"
`include "rtl/e1x/e1x_pkg.sv"

// E1X3D tile: a tiny-core contract plus a 7-port 3D mesh router. The six fabric
// neighbor ports (N/E/S/W/UP/DOWN) are exposed as a compact [5:0] bus; router
// port 4 (LOCAL) is bound to the core. The router itself is the verified,
// PORTS-parametric e1x_mesh_router instantiated with PORTS=7, so the 3D tile
// reuses the planar fabric proof and adds only the Z port wiring.
module e1x3d_tile #(
  parameter int PORTS = e1x3d_pkg::E1X3D_PORTS,
  parameter int COLORS = e1x3d_pkg::E1X3D_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x3d_pkg::E1X3D_FABRIC_PAYLOAD_BITS,
  parameter int FABRIC_PORTS = 6
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic core_enable_i,
  input  logic core_instr_valid_i,
  input  logic [31:0] core_instr_i,
  input  logic repair_enable_i,
  input  logic [PORTS-1:0] port_disable_i,
  input  logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input  logic [FABRIC_PORTS-1:0] fabric_valid_i,
  input  logic [FABRIC_PORTS-1:0][$clog2(COLORS)-1:0] fabric_color_i,
  input  logic [FABRIC_PORTS-1:0][PAYLOAD_BITS-1:0] fabric_payload_i,
  output logic [FABRIC_PORTS-1:0] fabric_ready_o,
  output logic [FABRIC_PORTS-1:0] fabric_valid_o,
  output logic [FABRIC_PORTS-1:0][$clog2(COLORS)-1:0] fabric_color_o,
  output logic [FABRIC_PORTS-1:0][PAYLOAD_BITS-1:0] fabric_payload_o,
  output logic [31:0] core_pc_o,
  output logic [63:0] core_x1_o,
  output logic core_halted_o,
  output logic core_active_o,
  output logic repaired_drop_o
);

  logic [PORTS-1:0] router_in_valid;
  logic [PORTS-1:0][$clog2(COLORS)-1:0] router_in_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] router_in_payload;
  logic [PORTS-1:0] router_in_ready;
  logic [PORTS-1:0] router_out_valid;
  logic [PORTS-1:0][$clog2(COLORS)-1:0] router_out_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] router_out_payload;
  logic [PORTS-1:0] router_drop;
  logic core_tx_valid;
  logic [PAYLOAD_BITS-1:0] core_tx_payload;
  logic core_rx_ready;
  logic [63:0] unused_x2;
  logic [63:0] unused_x3;

  // External fabric index -> router port. 0..3 are N/E/S/W; 4 -> UP; 5 -> DOWN.
  // Router port indices come from e1x3d_pkg, hoisted to localparams so the
  // index mapping is inlined (yosys/synthesis does not accept a module-scope
  // function here); Verilator/cocotb behaviour is unchanged.
  localparam int RP_LOCAL = int'(e1x3d_pkg::E1X3D_DIR_LOCAL);
  localparam int RP_UP    = int'(e1x3d_pkg::E1X3D_DIR_UP);
  localparam int RP_DOWN  = int'(e1x3d_pkg::E1X3D_DIR_DOWN);

  always_comb begin
    int rp;
    router_in_valid = '0;
    router_in_color = '0;
    router_in_payload = '0;
    fabric_ready_o = '0;
    fabric_valid_o = '0;
    fabric_color_o = '0;
    fabric_payload_o = '0;

    for (int ext = 0; ext < FABRIC_PORTS; ext++) begin
      if (ext < 4) rp = ext;
      else if (ext == 4) rp = RP_UP;
      else rp = RP_DOWN;
      router_in_valid[rp] = fabric_valid_i[ext];
      router_in_color[rp] = fabric_color_i[ext];
      router_in_payload[rp] = fabric_payload_i[ext];
      fabric_ready_o[ext] = router_in_ready[rp];
      fabric_valid_o[ext] = router_out_valid[rp];
      fabric_color_o[ext] = router_out_color[rp];
      fabric_payload_o[ext] = router_out_payload[rp];
    end

    router_in_valid[RP_LOCAL] = core_tx_valid;
    router_in_color[RP_LOCAL] = '0;
    router_in_payload[RP_LOCAL] = core_tx_payload;
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
    .route_table_i(route_table_i),
    .in_valid_i(router_in_valid),
    .in_color_i(router_in_color),
    .in_payload_i(router_in_payload),
    .in_ready_o(router_in_ready),
    .out_valid_o(router_out_valid),
    .out_color_o(router_out_color),
    .out_payload_o(router_out_payload),
    .repaired_drop_o(router_drop)
  );

  e1x_tiny_core_contract u_core (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .enable_i(core_enable_i),
    .boot_pc_i(32'h0000_0000),
    .instr_valid_i(core_instr_valid_i),
    .instr_i(core_instr_i),
    .wavelet_valid_i(router_out_valid[RP_LOCAL]),
    .wavelet_payload_i(router_out_payload[RP_LOCAL]),
    .wavelet_ready_o(core_rx_ready),
    .wavelet_valid_o(core_tx_valid),
    .wavelet_payload_o(core_tx_payload),
    .pc_o(core_pc_o),
    .x1_o(core_x1_o),
    .x2_o(unused_x2),
    .x3_o(unused_x3),
    .halted_o(core_halted_o),
    .active_o(core_active_o)
  );

  assign repaired_drop_o = |router_drop;
  logic unused_core_status;
  assign unused_core_status = core_rx_ready ^ (^unused_x2) ^ (^unused_x3);
endmodule
