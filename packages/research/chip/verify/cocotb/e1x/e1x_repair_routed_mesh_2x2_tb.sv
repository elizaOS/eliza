`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_routed_mesh_2x2_tb (
  input  logic clk,
  input  logic rst_n,
  input  logic clear,
  input  logic repair_enable,
  input  logic [3:0] repair_word_valid,
  input  logic [3:0][63:0] repair_word,
  output logic [3:0] repair_word_ready,
  output logic [3:0] repair_load_done,
  output logic [3:0] repair_load_error,
  output logic [3:0] repair_overflow,
  output logic [3:0][31:0] repair_route_count,
  input  logic [3:0][4:0] port_disable,
  input  logic [3:0][e1x_pkg::E1X_ROUTING_COLORS*e1x_pkg::E1X_PORTS*3-1:0] route_table_flat,
  input  logic [3:0] inject_valid,
  input  logic [3:0][$clog2(e1x_pkg::E1X_ROUTING_COLORS)-1:0] inject_color,
  input  logic [3:0][e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] inject_payload,
  input  logic [3:0][31:0] inject_src_logical,
  input  logic [3:0][31:0] inject_dst_logical,
  output logic [3:0] inject_ready,
  output logic [3:0] local_valid,
  output logic [3:0][e1x_pkg::E1X_FABRIC_PAYLOAD_BITS-1:0] local_payload,
  output logic [3:0][4:0] repaired_drop,
  output logic [3:0][4:0] repair_override_used
);
  import e1x_pkg::*;

  logic [3:0][E1X_ROUTING_COLORS-1:0][E1X_PORTS-1:0][2:0] route_table;
  logic [3:0][E1X_PORTS-1:0] in_valid;
  logic [3:0][E1X_PORTS-1:0][$clog2(E1X_ROUTING_COLORS)-1:0] in_color;
  logic [3:0][E1X_PORTS-1:0][E1X_FABRIC_PAYLOAD_BITS-1:0] in_payload;
  logic [3:0][E1X_PORTS-1:0][31:0] in_src_logical;
  logic [3:0][E1X_PORTS-1:0][31:0] in_dst_logical;
  logic [3:0][E1X_PORTS-1:0] in_ready;
  logic [3:0][E1X_PORTS-1:0] out_valid;
  logic [3:0][E1X_PORTS-1:0][$clog2(E1X_ROUTING_COLORS)-1:0] out_color;
  logic [3:0][E1X_PORTS-1:0][E1X_FABRIC_PAYLOAD_BITS-1:0] out_payload;
  logic [3:0][E1X_PORTS-1:0][31:0] out_src_logical;
  logic [3:0][E1X_PORTS-1:0][31:0] out_dst_logical;
  logic [3:0][31:0] repair_remap_count;
  logic [3:0][E1X_PORTS-1:0][15:0] repair_route_hops;

  logic [7:0] link_valid_q;
  logic [7:0][$clog2(E1X_ROUTING_COLORS)-1:0] link_color_q;
  logic [7:0][E1X_FABRIC_PAYLOAD_BITS-1:0] link_payload_q;
  logic [7:0][31:0] link_src_q;
  logic [7:0][31:0] link_dst_q;

  localparam int L_0E_1W = 0;
  localparam int L_1W_0E = 1;
  localparam int L_0S_2N = 2;
  localparam int L_2N_0S = 3;
  localparam int L_2E_3W = 4;
  localparam int L_3W_2E = 5;
  localparam int L_1S_3N = 6;
  localparam int L_3N_1S = 7;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      link_valid_q <= '0;
      link_color_q <= '0;
      link_payload_q <= '0;
      link_src_q <= '0;
      link_dst_q <= '0;
    end else begin
      link_valid_q[L_0E_1W] <= out_valid[0][E1X_DIR_EAST];
      link_color_q[L_0E_1W] <= out_color[0][E1X_DIR_EAST];
      link_payload_q[L_0E_1W] <= out_payload[0][E1X_DIR_EAST];
      link_src_q[L_0E_1W] <= out_src_logical[0][E1X_DIR_EAST];
      link_dst_q[L_0E_1W] <= out_dst_logical[0][E1X_DIR_EAST];

      link_valid_q[L_1W_0E] <= out_valid[1][E1X_DIR_WEST];
      link_color_q[L_1W_0E] <= out_color[1][E1X_DIR_WEST];
      link_payload_q[L_1W_0E] <= out_payload[1][E1X_DIR_WEST];
      link_src_q[L_1W_0E] <= out_src_logical[1][E1X_DIR_WEST];
      link_dst_q[L_1W_0E] <= out_dst_logical[1][E1X_DIR_WEST];

      link_valid_q[L_0S_2N] <= out_valid[0][E1X_DIR_SOUTH];
      link_color_q[L_0S_2N] <= out_color[0][E1X_DIR_SOUTH];
      link_payload_q[L_0S_2N] <= out_payload[0][E1X_DIR_SOUTH];
      link_src_q[L_0S_2N] <= out_src_logical[0][E1X_DIR_SOUTH];
      link_dst_q[L_0S_2N] <= out_dst_logical[0][E1X_DIR_SOUTH];

      link_valid_q[L_2N_0S] <= out_valid[2][E1X_DIR_NORTH];
      link_color_q[L_2N_0S] <= out_color[2][E1X_DIR_NORTH];
      link_payload_q[L_2N_0S] <= out_payload[2][E1X_DIR_NORTH];
      link_src_q[L_2N_0S] <= out_src_logical[2][E1X_DIR_NORTH];
      link_dst_q[L_2N_0S] <= out_dst_logical[2][E1X_DIR_NORTH];

      link_valid_q[L_2E_3W] <= out_valid[2][E1X_DIR_EAST];
      link_color_q[L_2E_3W] <= out_color[2][E1X_DIR_EAST];
      link_payload_q[L_2E_3W] <= out_payload[2][E1X_DIR_EAST];
      link_src_q[L_2E_3W] <= out_src_logical[2][E1X_DIR_EAST];
      link_dst_q[L_2E_3W] <= out_dst_logical[2][E1X_DIR_EAST];

      link_valid_q[L_3W_2E] <= out_valid[3][E1X_DIR_WEST];
      link_color_q[L_3W_2E] <= out_color[3][E1X_DIR_WEST];
      link_payload_q[L_3W_2E] <= out_payload[3][E1X_DIR_WEST];
      link_src_q[L_3W_2E] <= out_src_logical[3][E1X_DIR_WEST];
      link_dst_q[L_3W_2E] <= out_dst_logical[3][E1X_DIR_WEST];

      link_valid_q[L_1S_3N] <= out_valid[1][E1X_DIR_SOUTH];
      link_color_q[L_1S_3N] <= out_color[1][E1X_DIR_SOUTH];
      link_payload_q[L_1S_3N] <= out_payload[1][E1X_DIR_SOUTH];
      link_src_q[L_1S_3N] <= out_src_logical[1][E1X_DIR_SOUTH];
      link_dst_q[L_1S_3N] <= out_dst_logical[1][E1X_DIR_SOUTH];

      link_valid_q[L_3N_1S] <= out_valid[3][E1X_DIR_NORTH];
      link_color_q[L_3N_1S] <= out_color[3][E1X_DIR_NORTH];
      link_payload_q[L_3N_1S] <= out_payload[3][E1X_DIR_NORTH];
      link_src_q[L_3N_1S] <= out_src_logical[3][E1X_DIR_NORTH];
      link_dst_q[L_3N_1S] <= out_dst_logical[3][E1X_DIR_NORTH];
    end
  end

  always_comb begin
    route_table = '0;
    for (int tile = 0; tile < 4; tile++) begin
      for (int color = 0; color < E1X_ROUTING_COLORS; color++) begin
        for (int port = 0; port < E1X_PORTS; port++) begin
          route_table[tile][color][port] =
            route_table_flat[tile][(color * E1X_PORTS + port) * 3 +: 3];
        end
      end
    end

    in_valid = '0;
    in_color = '0;
    in_payload = '0;
    in_src_logical = '0;
    in_dst_logical = '0;
    inject_ready = '0;
    local_valid = '0;
    local_payload = '0;

    for (int tile = 0; tile < 4; tile++) begin
      in_valid[tile][E1X_DIR_LOCAL] = inject_valid[tile];
      in_color[tile][E1X_DIR_LOCAL] = inject_color[tile];
      in_payload[tile][E1X_DIR_LOCAL] = inject_payload[tile];
      in_src_logical[tile][E1X_DIR_LOCAL] = inject_src_logical[tile];
      in_dst_logical[tile][E1X_DIR_LOCAL] = inject_dst_logical[tile];
      inject_ready[tile] = in_ready[tile][E1X_DIR_LOCAL];
      local_valid[tile] = out_valid[tile][E1X_DIR_LOCAL];
      local_payload[tile] = out_payload[tile][E1X_DIR_LOCAL];
    end

    in_valid[1][E1X_DIR_WEST] = link_valid_q[L_0E_1W];
    in_color[1][E1X_DIR_WEST] = link_color_q[L_0E_1W];
    in_payload[1][E1X_DIR_WEST] = link_payload_q[L_0E_1W];
    in_src_logical[1][E1X_DIR_WEST] = link_src_q[L_0E_1W];
    in_dst_logical[1][E1X_DIR_WEST] = link_dst_q[L_0E_1W];

    in_valid[0][E1X_DIR_EAST] = link_valid_q[L_1W_0E];
    in_color[0][E1X_DIR_EAST] = link_color_q[L_1W_0E];
    in_payload[0][E1X_DIR_EAST] = link_payload_q[L_1W_0E];
    in_src_logical[0][E1X_DIR_EAST] = link_src_q[L_1W_0E];
    in_dst_logical[0][E1X_DIR_EAST] = link_dst_q[L_1W_0E];

    in_valid[2][E1X_DIR_NORTH] = link_valid_q[L_0S_2N];
    in_color[2][E1X_DIR_NORTH] = link_color_q[L_0S_2N];
    in_payload[2][E1X_DIR_NORTH] = link_payload_q[L_0S_2N];
    in_src_logical[2][E1X_DIR_NORTH] = link_src_q[L_0S_2N];
    in_dst_logical[2][E1X_DIR_NORTH] = link_dst_q[L_0S_2N];

    in_valid[0][E1X_DIR_SOUTH] = link_valid_q[L_2N_0S];
    in_color[0][E1X_DIR_SOUTH] = link_color_q[L_2N_0S];
    in_payload[0][E1X_DIR_SOUTH] = link_payload_q[L_2N_0S];
    in_src_logical[0][E1X_DIR_SOUTH] = link_src_q[L_2N_0S];
    in_dst_logical[0][E1X_DIR_SOUTH] = link_dst_q[L_2N_0S];

    in_valid[3][E1X_DIR_WEST] = link_valid_q[L_2E_3W];
    in_color[3][E1X_DIR_WEST] = link_color_q[L_2E_3W];
    in_payload[3][E1X_DIR_WEST] = link_payload_q[L_2E_3W];
    in_src_logical[3][E1X_DIR_WEST] = link_src_q[L_2E_3W];
    in_dst_logical[3][E1X_DIR_WEST] = link_dst_q[L_2E_3W];

    in_valid[2][E1X_DIR_EAST] = link_valid_q[L_3W_2E];
    in_color[2][E1X_DIR_EAST] = link_color_q[L_3W_2E];
    in_payload[2][E1X_DIR_EAST] = link_payload_q[L_3W_2E];
    in_src_logical[2][E1X_DIR_EAST] = link_src_q[L_3W_2E];
    in_dst_logical[2][E1X_DIR_EAST] = link_dst_q[L_3W_2E];

    in_valid[3][E1X_DIR_NORTH] = link_valid_q[L_1S_3N];
    in_color[3][E1X_DIR_NORTH] = link_color_q[L_1S_3N];
    in_payload[3][E1X_DIR_NORTH] = link_payload_q[L_1S_3N];
    in_src_logical[3][E1X_DIR_NORTH] = link_src_q[L_1S_3N];
    in_dst_logical[3][E1X_DIR_NORTH] = link_dst_q[L_1S_3N];

    in_valid[1][E1X_DIR_SOUTH] = link_valid_q[L_3N_1S];
    in_color[1][E1X_DIR_SOUTH] = link_color_q[L_3N_1S];
    in_payload[1][E1X_DIR_SOUTH] = link_payload_q[L_3N_1S];
    in_src_logical[1][E1X_DIR_SOUTH] = link_src_q[L_3N_1S];
    in_dst_logical[1][E1X_DIR_SOUTH] = link_dst_q[L_3N_1S];
  end

  for (genvar tile = 0; tile < 4; tile++) begin : gen_tiles
    e1x_repair_routed_router #(
      .MAX_REMAPS(8),
      .MAX_ROUTES(8)
    ) u_router (
      .clk_i(clk),
      .rst_ni(rst_n),
      .clear_i(clear),
      .repair_enable_i(repair_enable),
      .repair_word_valid_i(repair_word_valid[tile]),
      .repair_word_i(repair_word[tile]),
      .repair_word_ready_o(repair_word_ready[tile]),
      .repair_load_done_o(repair_load_done[tile]),
      .repair_load_error_o(repair_load_error[tile]),
      .repair_overflow_o(repair_overflow[tile]),
      .repair_remap_count_o(repair_remap_count[tile]),
      .repair_route_count_o(repair_route_count[tile]),
      .port_disable_i(port_disable[tile]),
      .route_table_i(route_table[tile]),
      .in_valid_i(in_valid[tile]),
      .in_color_i(in_color[tile]),
      .in_payload_i(in_payload[tile]),
      .in_src_logical_i(in_src_logical[tile]),
      .in_dst_logical_i(in_dst_logical[tile]),
      .in_ready_o(in_ready[tile]),
      .out_valid_o(out_valid[tile]),
      .out_color_o(out_color[tile]),
      .out_payload_o(out_payload[tile]),
      .out_src_logical_o(out_src_logical[tile]),
      .out_dst_logical_o(out_dst_logical[tile]),
      .repaired_drop_o(repaired_drop[tile]),
      .repair_override_used_o(repair_override_used[tile]),
      .repair_route_hops_o(repair_route_hops[tile])
    );
  end

  logic unused_route_state;
  assign unused_route_state = ^repair_remap_count ^ ^repair_route_hops;
endmodule
