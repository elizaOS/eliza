// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys formal harness for ``e1x_mesh_router``. The router is a purely
// combinational crossbar (clk_i/rst_ni are unused inputs); every property is a
// per-cycle combinational assertion over the inputs, the programmed route
// table, and the outputs. Drive with verify/formal/e1x/e1x_mesh_router.sby.
//
// Modelled directions (from e1x_pkg::e1x_dir_e):
//   NORTH=0 EAST=1 SOUTH=2 WEST=3 LOCAL=4 (all < PORTS=5), DROP=7.
//
// Assumption (documented): each route_table_i entry is constrained to a legal
// encoding, i.e. a port index in [0,PORTS) or DROP (7), and each in_color_i is
// a programmed color in [0,COLORS). The hardware route table is programmed by
// trusted boot firmware (e1x_repair_rom_loader / e1x_repair_route_table), so
// out-of-range raw directions are not a runtime input. Without the direction
// assumption the router still cannot forward to an out-of-range port (the
// out_port < PORTS guard blocks it), but such states are not meaningful
// programmed configurations to reason about.
//
// Assertion labels are intentionally omitted inside unrolled for-loops: the
// yosys-slang frontend derives RTLIL cell names from labels, so a labelled
// assertion inside a loop body would emit duplicate cell names and abort
// elaboration. Loop-body assertions therefore stay anonymous; their intent is
// documented in the surrounding comments.

`include "rtl/e1x/e1x_pkg.sv"

module e1x_mesh_router_formal
  import e1x_pkg::*;
#(
  parameter int PORTS = e1x_pkg::E1X_PORTS,
  parameter int COLORS = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS
) (
  input logic clk_i,
  input logic rst_ni,
  input logic repair_enable_i,
  input logic [PORTS-1:0] port_disable_i,
  input logic [COLORS-1:0][PORTS-1:0][2:0] route_table_i,
  input logic [PORTS-1:0] in_valid_i,
  input logic [PORTS-1:0][$clog2(COLORS)-1:0] in_color_i,
  input logic [PORTS-1:0][PAYLOAD_BITS-1:0] in_payload_i
);
  localparam int CW = $clog2(COLORS);

  logic [PORTS-1:0] in_ready_o;
  logic [PORTS-1:0] out_valid_o;
  logic [PORTS-1:0][CW-1:0] out_color_o;
  logic [PORTS-1:0][PAYLOAD_BITS-1:0] out_payload_o;
  logic [PORTS-1:0] repaired_drop_o;

  e1x_mesh_router #(
    .PORTS(PORTS),
    .COLORS(COLORS),
    .PAYLOAD_BITS(PAYLOAD_BITS)
  ) dut (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .repair_enable_i(repair_enable_i),
    .port_disable_i(port_disable_i),
    .route_table_i(route_table_i),
    .in_valid_i(in_valid_i),
    .in_color_i(in_color_i),
    .in_payload_i(in_payload_i),
    .in_ready_o(in_ready_o),
    .out_valid_o(out_valid_o),
    .out_color_o(out_color_o),
    .out_payload_o(out_payload_o),
    .repaired_drop_o(repaired_drop_o)
  );

  // ---------------------------------------------------------------------------
  // Assumptions
  // ---------------------------------------------------------------------------
  always_comb begin
    for (int p = 0; p < PORTS; p++) begin
      // Programmed color index is within the legal color range.
      assume (in_color_i[p] < CW'(COLORS));
    end
    for (int c = 0; c < COLORS; c++) begin
      for (int p = 0; p < PORTS; p++) begin
        // Each route-table direction is a legal port index or DROP.
        assume (route_table_i[c][p] < 3'(PORTS) ||
                route_table_i[c][p] == E1X_DIR_DROP);
      end
    end
  end

  // Per-input intended forwarding destination.
  function automatic logic [2:0] raw_dir_of(int in_port);
    return route_table_i[in_color_i[in_port]][in_port];
  endfunction

  // ---------------------------------------------------------------------------
  // Property (a): no output contention. For each output port reconstruct the
  // count of inputs the router accepted and forwarded to that port; assert it
  // never exceeds one and that out_valid tracks exactly that single driver.
  // ---------------------------------------------------------------------------
  always_comb begin
    for (int op = 0; op < PORTS; op++) begin
      automatic int drivers;
      drivers = 0;
      for (int ip = 0; ip < PORTS; ip++) begin
        if (in_ready_o[ip] && !repaired_drop_o[ip] &&
            int'(raw_dir_of(ip)) == op) begin
          drivers++;
        end
      end
      assert (drivers <= 1);
      assert (out_valid_o[op] == (drivers == 1));
    end
  end

  // ---------------------------------------------------------------------------
  // Property (b): a disabled port never produces out_valid and never appears as
  // a forwarding destination of an accepted+forwarded input.
  // ---------------------------------------------------------------------------
  always_comb begin
    for (int op = 0; op < PORTS; op++) begin
      if (port_disable_i[op]) begin
        assert (!out_valid_o[op]);
        for (int ip = 0; ip < PORTS; ip++) begin
          assert (!(in_ready_o[ip] && !repaired_drop_o[ip] &&
                    int'(raw_dir_of(ip)) == op));
        end
      end
    end
  end

  // ---------------------------------------------------------------------------
  // Property (c): with repair_enable_i = 0, a valid input on an enabled port,
  // whose route is a non-DROP target to an enabled output with no competing
  // eligible input, is NOT spuriously dropped: it is forwarded with its payload
  // and color, in_ready is set, and repaired_drop is clear.
  // ---------------------------------------------------------------------------
  always_comb begin
    for (int ip = 0; ip < PORTS; ip++) begin
      automatic logic [2:0] d;
      automatic int op;
      automatic logic eligible;
      automatic int contenders;
      d = raw_dir_of(ip);
      op = int'(d);
      eligible = in_valid_i[ip] && !port_disable_i[ip] && (d != E1X_DIR_DROP) &&
                 (op < PORTS) && !port_disable_i[op];
      contenders = 0;
      for (int jp = 0; jp < PORTS; jp++) begin
        if (jp != ip && in_valid_i[jp] && !port_disable_i[jp]) begin
          automatic logic [2:0] dj;
          dj = raw_dir_of(jp);
          if (dj != E1X_DIR_DROP && int'(dj) == op) begin
            contenders++;
          end
        end
      end
      if (!repair_enable_i && eligible && contenders == 0) begin
        assert (out_valid_o[op]);
        assert (in_ready_o[ip]);
        assert (!repaired_drop_o[ip]);
        assert (out_payload_o[op] == in_payload_i[ip]);
        assert (out_color_o[op] == in_color_i[ip]);
      end
    end
  end

  // ---------------------------------------------------------------------------
  // Property (d): repaired_drop only asserts under repair_enable, and only for a
  // valid input; with repair disabled no port is ever repaired-dropped.
  // ---------------------------------------------------------------------------
  always_comb begin
    d_drop_implies_repair: assert (repaired_drop_o == '0 || repair_enable_i);
    for (int ip = 0; ip < PORTS; ip++) begin
      if (repaired_drop_o[ip]) begin
        assert (repair_enable_i);
        assert (in_valid_i[ip]);
      end
      if (!repair_enable_i) begin
        assert (!repaired_drop_o[ip]);
      end
    end
  end
endmodule
