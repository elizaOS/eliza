`ifndef E1X_PKG_SV
`define E1X_PKG_SV

package e1x_pkg;
  parameter int E1X_LOGICAL_ROWS = 32;
  parameter int E1X_LOGICAL_COLS = 32;
  parameter int E1X_SPARE_ROWS = 2;
  parameter int E1X_SPARE_COLS = 2;
  parameter int E1X_PHYSICAL_ROWS = E1X_LOGICAL_ROWS + E1X_SPARE_ROWS;
  parameter int E1X_PHYSICAL_COLS = E1X_LOGICAL_COLS + E1X_SPARE_COLS;
  parameter int E1X_LOCAL_SRAM_KIB = 48;
  parameter int E1X_FABRIC_PAYLOAD_BITS = 32;
  parameter int E1X_ROUTING_COLORS = 24;
  parameter int E1X_PORTS = 5;

  typedef enum logic [2:0] {
    E1X_DIR_NORTH = 3'd0,
    E1X_DIR_EAST  = 3'd1,
    E1X_DIR_SOUTH = 3'd2,
    E1X_DIR_WEST  = 3'd3,
    E1X_DIR_LOCAL = 3'd4,
    E1X_DIR_DROP  = 3'd7
  } e1x_dir_e;

  typedef struct packed {
    logic [E1X_FABRIC_PAYLOAD_BITS-1:0] payload;
    logic [$clog2(E1X_ROUTING_COLORS)-1:0] color;
    logic [15:0] src_logical;
    logic [15:0] dst_logical;
  } e1x_wavelet_t;
endpackage

`endif
