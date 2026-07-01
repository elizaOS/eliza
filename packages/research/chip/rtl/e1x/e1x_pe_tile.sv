`include "rtl/e1x/e1x_pkg.sv"

// Production E1X processing tile.
//
// Wires the real RV64IM_Zicsr_Zifencei ``e1x_pe_core`` (not the 4-instruction
// ``e1x_tiny_core_contract``) to the combinational mesh router so the actual
// compute element of the wafer mesh is exercised in an integrated tile context:
// boot a program into the PE local SRAM, run it, and exchange wavelets with the
// four mesh neighbours through the Local router port.
//
// The fabric port shape is identical to ``e1x_tile`` (four neighbour ports +
// the implicit Local port the core owns). The only interface delta versus the
// tiny-core tile is the explicit boot stream (``boot_en_i``/``boot_pc_i``):
// the PE core loads instr_valid words into its local SRAM while boot_en_i is
// asserted, then fetches from boot_pc_i once enable_i is high. This matches the
// boot model documented in e1x_pe_core.sv.
module e1x_pe_tile #(
  parameter int PORTS = e1x_pkg::E1X_PORTS,
  parameter int COLORS = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic core_enable_i,
  input  logic core_boot_en_i,
  input  logic [31:0] core_boot_pc_i,
  input  logic core_instr_valid_i,
  input  logic [31:0] core_instr_i,
  input  logic repair_enable_i,
  input  logic [PORTS-1:0] port_disable_i,
  input  logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input  logic [PORTS-2:0] fabric_valid_i,
  input  logic [PORTS-2:0][$clog2(COLORS)-1:0] fabric_color_i,
  input  logic [PORTS-2:0][PAYLOAD_BITS-1:0] fabric_payload_i,
  output logic [PORTS-2:0] fabric_ready_o,
  output logic [PORTS-2:0] fabric_valid_o,
  output logic [PORTS-2:0][$clog2(COLORS)-1:0] fabric_color_o,
  output logic [PORTS-2:0][PAYLOAD_BITS-1:0] fabric_payload_o,
  output logic [31:0] core_pc_o,
  output logic [63:0] core_x1_o,
  output logic [63:0] core_x2_o,
  output logic [63:0] core_x3_o,
  output logic [63:0] core_x10_o,
  output logic [63:0] core_x11_o,
  output logic core_halted_o,
  output logic core_active_o,
  output logic repaired_drop_o
);
  import e1x_pkg::*;

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

  always_comb begin
    router_in_valid = '0;
    router_in_color = '0;
    router_in_payload = '0;
    fabric_ready_o = '0;
    fabric_valid_o = '0;
    fabric_color_o = '0;
    fabric_payload_o = '0;

    for (int port = 0; port < PORTS - 1; port++) begin
      router_in_valid[port] = fabric_valid_i[port];
      router_in_color[port] = fabric_color_i[port];
      router_in_payload[port] = fabric_payload_i[port];
      fabric_ready_o[port] = router_in_ready[port];
      fabric_valid_o[port] = router_out_valid[port];
      fabric_color_o[port] = router_out_color[port];
      fabric_payload_o[port] = router_out_payload[port];
    end

    router_in_valid[E1X_DIR_LOCAL] = core_tx_valid;
    router_in_color[E1X_DIR_LOCAL] = '0;
    router_in_payload[E1X_DIR_LOCAL] = core_tx_payload;
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

  e1x_pe_core u_core (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .enable_i(core_enable_i),
    .boot_en_i(core_boot_en_i),
    .boot_pc_i(core_boot_pc_i),
    .instr_valid_i(core_instr_valid_i),
    .instr_i(core_instr_i),
    .wavelet_valid_i(router_out_valid[E1X_DIR_LOCAL]),
    .wavelet_payload_i(router_out_payload[E1X_DIR_LOCAL]),
    .wavelet_ready_o(core_rx_ready),
    .wavelet_valid_o(core_tx_valid),
    .wavelet_payload_o(core_tx_payload),
    .pc_o(core_pc_o),
    .x1_o(core_x1_o),
    .x2_o(core_x2_o),
    .x3_o(core_x3_o),
    .halted_o(core_halted_o),
    .active_o(core_active_o)
  );

  assign core_x10_o = u_core.regs[10];
  assign core_x11_o = u_core.regs[11];
  assign repaired_drop_o = |router_drop;
  logic unused_core_status;
  assign unused_core_status = core_rx_ready;
endmodule
