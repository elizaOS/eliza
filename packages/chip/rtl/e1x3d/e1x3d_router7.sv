`include "rtl/e1x/e1x_pkg.sv"
`include "rtl/e1x3d/e1x3d_pkg.sv"

// Synthesis top for open-PDK signoff of the E1X3D 3D fabric router: the verified
// PORTS-parametric e1x_mesh_router fixed to 7 ports (N=0/E=1/S=2/W=3/Local=4/
// Up=5/Down=6). This is the standalone PD target for the 3D fabric element; the
// per-PE local SRAM is a hard macro on the memory tier (see the tier-split
// manifest), not part of this logic-tier router block.
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
  e1x_mesh_router #(
    .PORTS(7),
    .COLORS(24),
    .PAYLOAD_BITS(32)
  ) u_router (
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
endmodule
