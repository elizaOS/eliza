`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_routed_tile #(
  parameter int PORTS = e1x_pkg::E1X_PORTS,
  parameter int COLORS = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int INDEX_BITS = 32,
  parameter int MAX_REMAPS = 16,
  parameter int MAX_ROUTES = 16
) (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic clear_i,
  input  logic core_enable_i,
  input  logic core_instr_valid_i,
  input  logic [31:0] core_instr_i,
  input  logic repair_enable_i,
  input  logic repair_word_valid_i,
  input  logic [63:0] repair_word_i,
  output logic repair_word_ready_o,
  output logic repair_load_done_o,
  output logic repair_load_error_o,
  output logic repair_overflow_o,
  output logic [31:0] repair_remap_count_o,
  output logic [31:0] repair_route_count_o,
  input  logic [PORTS-1:0] port_disable_i,
  input  logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input  logic [PORTS-2:0] fabric_valid_i,
  input  logic [PORTS-2:0][$clog2(COLORS)-1:0] fabric_color_i,
  input  logic [PORTS-2:0][PAYLOAD_BITS-1:0] fabric_payload_i,
  input  logic [PORTS-2:0][INDEX_BITS-1:0] fabric_src_logical_i,
  input  logic [PORTS-2:0][INDEX_BITS-1:0] fabric_dst_logical_i,
  input  logic [INDEX_BITS-1:0] local_src_logical_i,
  input  logic [INDEX_BITS-1:0] local_dst_logical_i,
  output logic [PORTS-2:0] fabric_ready_o,
  output logic [PORTS-2:0] fabric_valid_o,
  output logic [PORTS-2:0][$clog2(COLORS)-1:0] fabric_color_o,
  output logic [PORTS-2:0][PAYLOAD_BITS-1:0] fabric_payload_o,
  output logic [31:0] core_pc_o,
  output logic [63:0] core_x1_o,
  output logic [63:0] core_x2_o,
  output logic [63:0] core_x3_o,
  output logic [63:0] core_x10_o,
  output logic core_halted_o,
  output logic core_active_o,
  output logic repaired_drop_o,
  output logic [PORTS-1:0] repair_override_used_o
);
  import e1x_pkg::*;

  logic [PORTS-1:0] router_in_valid;
  logic [PORTS-1:0][$clog2(COLORS)-1:0] router_in_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] router_in_payload;
  logic [PORTS-1:0][INDEX_BITS-1:0] router_in_src_logical;
  logic [PORTS-1:0][INDEX_BITS-1:0] router_in_dst_logical;
  logic [PORTS-1:0] router_in_ready;
  logic [PORTS-1:0] router_out_valid;
  logic [PORTS-1:0][$clog2(COLORS)-1:0] router_out_color;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] router_out_payload;
  logic [PORTS-1:0][INDEX_BITS-1:0] router_out_src_logical;
  logic [PORTS-1:0][INDEX_BITS-1:0] router_out_dst_logical;
  logic [PORTS-1:0] router_drop;
  logic [PORTS-1:0][15:0] repair_route_hops;
  logic core_tx_valid;
  logic [PAYLOAD_BITS-1:0] core_tx_payload;
  logic core_rx_ready;

  always_comb begin
    router_in_valid = '0;
    router_in_color = '0;
    router_in_payload = '0;
    router_in_src_logical = '0;
    router_in_dst_logical = '0;
    fabric_ready_o = '0;
    fabric_valid_o = '0;
    fabric_color_o = '0;
    fabric_payload_o = '0;

    for (int port = 0; port < PORTS - 1; port++) begin
      router_in_valid[port] = fabric_valid_i[port];
      router_in_color[port] = fabric_color_i[port];
      router_in_payload[port] = fabric_payload_i[port];
      router_in_src_logical[port] = fabric_src_logical_i[port];
      router_in_dst_logical[port] = fabric_dst_logical_i[port];
      fabric_ready_o[port] = router_in_ready[port];
      fabric_valid_o[port] = router_out_valid[port];
      fabric_color_o[port] = router_out_color[port];
      fabric_payload_o[port] = router_out_payload[port];
    end

    router_in_valid[E1X_DIR_LOCAL] = core_tx_valid;
    router_in_color[E1X_DIR_LOCAL] = '0;
    router_in_payload[E1X_DIR_LOCAL] = core_tx_payload;
    router_in_src_logical[E1X_DIR_LOCAL] = local_src_logical_i;
    router_in_dst_logical[E1X_DIR_LOCAL] = local_dst_logical_i;
  end

  e1x_repair_routed_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS),
    .INDEX_BITS(INDEX_BITS),
    .MAX_REMAPS(MAX_REMAPS),
    .MAX_ROUTES(MAX_ROUTES)
  ) u_router (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .clear_i(clear_i),
    .repair_enable_i(repair_enable_i),
    .repair_word_valid_i(repair_word_valid_i),
    .repair_word_i(repair_word_i),
    .repair_word_ready_o(repair_word_ready_o),
    .repair_load_done_o(repair_load_done_o),
    .repair_load_error_o(repair_load_error_o),
    .repair_overflow_o(repair_overflow_o),
    .repair_remap_count_o(repair_remap_count_o),
    .repair_route_count_o(repair_route_count_o),
    .port_disable_i(port_disable_i),
    .route_table_i(route_table_i),
    .in_valid_i(router_in_valid),
    .in_color_i(router_in_color),
    .in_payload_i(router_in_payload),
    .in_src_logical_i(router_in_src_logical),
    .in_dst_logical_i(router_in_dst_logical),
    .in_ready_o(router_in_ready),
    .out_valid_o(router_out_valid),
    .out_color_o(router_out_color),
    .out_payload_o(router_out_payload),
    .out_src_logical_o(router_out_src_logical),
    .out_dst_logical_o(router_out_dst_logical),
    .repaired_drop_o(router_drop),
    .repair_override_used_o(repair_override_used_o),
    .repair_route_hops_o(repair_route_hops)
  );

  e1x_tiny_core_contract u_core (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .enable_i(core_enable_i),
    .boot_pc_i(32'h0000_0000),
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
  assign repaired_drop_o = |router_drop;
  logic unused_core_status;
  assign unused_core_status = core_rx_ready ^ ^repair_route_hops ^ ^router_out_src_logical ^ ^router_out_dst_logical;
endmodule
