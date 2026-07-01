`include "rtl/e1x/e1x_pkg.sv"
`include "rtl/e1x3d/e1x3d_pkg.sv"

// Synthesis top for open-PDK signoff of the E1X3D 3D fabric router: the verified
// PORTS-parametric e1x_mesh_router fixed to 7 ports (N=0/E=1/S=2/W=3/Local=4/
// Up=5/Down=6). This is the standalone PD target for the 3D fabric element; the
// per-PE local SRAM is a hard macro on the memory tier (see the tier-split
// manifest), not part of this logic-tier router block.
//
// The block is a pipelined router stage: every primary input is registered, the
// combinational e1x_mesh_router routes between the input and output register
// stages, and every primary output is registered. So the pads drive flops (a
// single, well-bounded load) rather than deep combinational logic, the routing
// logic is flop-to-flop (fully timed, internal-only slew the resizer can fix),
// and clk_i/rst_ni drive ~1800 real flops for a meaningful clock tree.
//
// Port widths are literals matching e1x3d_pkg (PORTS=7, COLORS=24,
// PAYLOAD_BITS=32, COLOR_BITS=ceil(log2(24))=5) so the top elaborates without
// Verilog parameter passing through the PD flow.
module e1x3d_router7 (
  input  logic clk_i,
  input  logic rst_ni,
  input  logic repair_enable_i,
  input  logic [6:0] port_disable_i,
  input  logic [23:0][6:0][2:0] route_table_i,
  input  logic [6:0] in_valid_i,
  input  logic [6:0][4:0] in_color_i,
  input  logic [6:0][31:0] in_payload_i,
  output logic [6:0] in_ready_o,
  output logic [6:0] out_valid_o,
  output logic [6:0][4:0] out_color_o,
  output logic [6:0][31:0] out_payload_o,
  output logic [6:0] repaired_drop_o
);
  // Input register stage.
  logic repair_enable_q;
  logic [6:0] port_disable_q;
  logic [23:0][6:0][2:0] route_table_q;
  logic [6:0] in_valid_q;
  logic [6:0][4:0] in_color_q;
  logic [6:0][31:0] in_payload_q;

  // Combinational router outputs (between the input and output register stages).
  logic [6:0] in_ready_c;
  logic [6:0] out_valid_c;
  logic [6:0][4:0] out_color_c;
  logic [6:0][31:0] out_payload_c;
  logic [6:0] repaired_drop_c;

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      repair_enable_q <= 1'b0;
      port_disable_q <= '0;
      route_table_q <= '0;
      in_valid_q <= '0;
      in_color_q <= '0;
      in_payload_q <= '0;
    end else begin
      repair_enable_q <= repair_enable_i;
      port_disable_q <= port_disable_i;
      route_table_q <= route_table_i;
      in_valid_q <= in_valid_i;
      in_color_q <= in_color_i;
      in_payload_q <= in_payload_i;
    end
  end

  e1x_mesh_router #(
    .PORTS(7),
    .COLORS(24),
    .PAYLOAD_BITS(32)
  ) u_router (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .repair_enable_i(repair_enable_q),
    .port_disable_i(port_disable_q),
    .route_table_i(route_table_q),
    .in_valid_i(in_valid_q),
    .in_color_i(in_color_q),
    .in_payload_i(in_payload_q),
    .in_ready_o(in_ready_c),
    .out_valid_o(out_valid_c),
    .out_color_o(out_color_c),
    .out_payload_o(out_payload_c),
    .repaired_drop_o(repaired_drop_c)
  );

  // Output register stage.
  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      in_ready_o <= '0;
      out_valid_o <= '0;
      out_color_o <= '0;
      out_payload_o <= '0;
      repaired_drop_o <= '0;
    end else begin
      in_ready_o <= in_ready_c;
      out_valid_o <= out_valid_c;
      out_color_o <= out_color_c;
      out_payload_o <= out_payload_c;
      repaired_drop_o <= repaired_drop_c;
    end
  end
endmodule
