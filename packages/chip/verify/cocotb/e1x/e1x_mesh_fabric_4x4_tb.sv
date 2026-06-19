`include "rtl/e1x/e1x_pkg.sv"

// 4x4 credit-router mesh fabric testbench wrapper.
//
// Flattens the per-node packed vectors of e1x_mesh_fabric into wide scalar
// buses that cocotb can drive/observe directly, for the default ROWS=COLS=4
// production mesh.
module e1x_mesh_fabric_4x4_tb #(
  parameter int ROWS         = 4,
  parameter int COLS         = 4,
  parameter int PORTS        = e1x_pkg::E1X_PORTS,
  parameter int COLORS       = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS
) (
  input  logic clk,
  input  logic rst_n,

  input  logic                                    prog_we,
  input  logic [$clog2(ROWS)-1:0]                 prog_node_row,
  input  logic [$clog2(COLS)-1:0]                 prog_node_col,
  input  logic [$clog2(COLORS)+$clog2(PORTS)-1:0] prog_addr,
  input  logic [2:0]                              prog_dir,

  // Single-node injection selected by node index (keeps the TB surface small;
  // the delivery tests inject at one source node at a time).
  input  logic [$clog2(ROWS*COLS)-1:0]            inj_node,
  input  logic                                    inj_valid,
  input  logic [$clog2(COLORS)-1:0]               inj_color,
  input  logic [PAYLOAD_BITS-1:0]                  inj_payload,
  output logic                                    inj_ready,

  // Per-node PE core boot/run controls (flat buses) + broadcast instr/PC.
  input  logic [ROWS*COLS-1:0]                     core_enable_flat,
  input  logic [ROWS*COLS-1:0]                     core_boot_en_flat,
  input  logic [ROWS*COLS-1:0]                     core_instr_valid_flat,
  input  logic [31:0]                              core_instr,
  input  logic [31:0]                              core_boot_pc,

  // Flat eject observation (valid + payload per node).
  output logic [ROWS*COLS-1:0]                     eject_valid_flat,
  output logic [ROWS*COLS*PAYLOAD_BITS-1:0]        eject_payload_flat,
  input  logic [ROWS*COLS-1:0]                     eject_ready_flat,

  // Flat PE core observation.
  output logic [ROWS*COLS-1:0]                     core_halted_flat,
  output logic [ROWS*COLS*64-1:0]                  core_x10_flat
);
  import e1x_pkg::*;
  localparam int NODES      = ROWS * COLS;
  localparam int COLOR_BITS = $clog2(COLORS);

  logic [NODES-1:0]                   inject_valid;
  logic [NODES-1:0][COLOR_BITS-1:0]   inject_color;
  logic [NODES-1:0][PAYLOAD_BITS-1:0] inject_payload;
  logic [NODES-1:0]                   inject_ready;

  logic [NODES-1:0]                   eject_valid;
  logic [NODES-1:0][COLOR_BITS-1:0]   eject_color;
  logic [NODES-1:0][PAYLOAD_BITS-1:0] eject_payload;
  logic [NODES-1:0]                   eject_ready;

  logic [NODES-1:0][31:0] core_pc;
  logic [NODES-1:0][63:0] core_x10;
  logic [NODES-1:0]       core_halted;
  logic [NODES-1:0]       core_active;
  logic [NODES-1:0]       core_wavelet_valid;
  logic [NODES-1:0][PAYLOAD_BITS-1:0] core_wavelet_payload;

  always_comb begin
    inject_valid   = '0;
    inject_color   = '0;
    inject_payload = '0;
    inject_valid[inj_node]   = inj_valid;
    inject_color[inj_node]   = inj_color;
    inject_payload[inj_node] = inj_payload;

    eject_valid_flat   = '0;
    eject_payload_flat = '0;
    eject_ready        = '0;
    core_halted_flat   = '0;
    core_x10_flat      = '0;
    for (int n = 0; n < NODES; n++) begin
      eject_valid_flat[n] = eject_valid[n];
      eject_payload_flat[n * PAYLOAD_BITS +: PAYLOAD_BITS] = eject_payload[n];
      eject_ready[n] = eject_ready_flat[n];
      core_halted_flat[n] = core_halted[n];
      core_x10_flat[n * 64 +: 64] = core_x10[n];
    end
  end
  assign inj_ready = inject_ready[inj_node];

  e1x_mesh_fabric #(
    .ROWS(ROWS), .COLS(COLS), .PORTS(PORTS),
    .COLORS(COLORS), .PAYLOAD_BITS(PAYLOAD_BITS)
  ) u_fabric (
    .clk_i(clk), .rst_ni(rst_n),
    .core_enable_i(core_enable_flat),
    .core_boot_en_i(core_boot_en_flat),
    .core_instr_valid_i(core_instr_valid_flat),
    .core_instr_i(core_instr),
    .core_boot_pc_i(core_boot_pc),
    .prog_we_i(prog_we),
    .prog_node_row_i(prog_node_row),
    .prog_node_col_i(prog_node_col),
    .prog_addr_i(prog_addr),
    .prog_dir_i(prog_dir),
    .inject_valid_i(inject_valid),
    .inject_color_i(inject_color),
    .inject_payload_i(inject_payload),
    .inject_ready_o(inject_ready),
    .eject_valid_o(eject_valid),
    .eject_color_o(eject_color),
    .eject_payload_o(eject_payload),
    .eject_ready_i(eject_ready),
    .core_pc_o(core_pc),
    .core_x10_o(core_x10),
    .core_halted_o(core_halted),
    .core_active_o(core_active),
    .core_wavelet_valid_o(core_wavelet_valid),
    .core_wavelet_payload_o(core_wavelet_payload)
  );

  logic unused;
  assign unused = ^{eject_color, core_pc, core_x10, core_halted,
                    core_active, core_wavelet_valid, core_wavelet_payload};
endmodule
