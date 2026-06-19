`ifndef E1X3D_PKG_SV
`define E1X3D_PKG_SV

// E1X3D: 3D-stacked extension of the E1X wafer mesh. The fabric gains a Z axis
// (UP/DOWN inter-tier links) on top of the planar N/E/S/W mesh. The direction
// encoding reuses the E1X 3-bit field (rtl/e1x/e1x_pkg.sv) and fills its two
// previously-unused codes (5, 6) with UP and DOWN, so the repair-ROM route word
// and the parametric e1x_mesh_router carry 3D routes with no format break.
package e1x3d_pkg;
  parameter int E1X3D_LOGICAL_ROWS  = 4;
  parameter int E1X3D_LOGICAL_COLS  = 4;
  parameter int E1X3D_LOGICAL_TIERS = 2;
  parameter int E1X3D_SPARE_ROWS    = 1;
  parameter int E1X3D_SPARE_COLS    = 1;
  parameter int E1X3D_SPARE_TIERS   = 0;
  parameter int E1X3D_PHYSICAL_ROWS  = E1X3D_LOGICAL_ROWS + E1X3D_SPARE_ROWS;
  parameter int E1X3D_PHYSICAL_COLS  = E1X3D_LOGICAL_COLS + E1X3D_SPARE_COLS;
  parameter int E1X3D_PHYSICAL_TIERS = E1X3D_LOGICAL_TIERS + E1X3D_SPARE_TIERS;

  parameter int E1X3D_FABRIC_PAYLOAD_BITS = 32;
  parameter int E1X3D_ROUTING_COLORS = 24;
  // Seven router ports: four planar neighbors, local core, and two Z neighbors.
  parameter int E1X3D_PORTS = 7;

  typedef enum logic [2:0] {
    E1X3D_DIR_NORTH = 3'd0,
    E1X3D_DIR_EAST  = 3'd1,
    E1X3D_DIR_SOUTH = 3'd2,
    E1X3D_DIR_WEST  = 3'd3,
    E1X3D_DIR_LOCAL = 3'd4,
    E1X3D_DIR_UP    = 3'd5,
    E1X3D_DIR_DOWN  = 3'd6,
    E1X3D_DIR_DROP  = 3'd7
  } e1x3d_dir_e;
endpackage

`endif
