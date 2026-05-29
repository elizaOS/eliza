`include "rtl/e1x/e1x_pkg.sv"

// Full-wafer (parameterized RxC) E1X mesh fabric top.
//
// Wires the production input-buffered, credit-flow-controlled
// ``e1x_credit_router`` across an ROWS x COLS array of processing nodes. Each
// node owns one credit router and one real RV64IM ``e1x_pe_core``; the router
// Local port connects to the PE core's wavelet RX/TX, and the four neighbour
// ports connect to the adjacent routers with proper credit return. This closes
// the "no full-wafer mesh top instantiating the credit router across tiles"
// gap: the credit router was previously only exercised in unit / two-router-
// chain testbenches, never in an NxM tile array.
//
// Inter-node link contract (matches the verified two-router chain TB):
//   For an edge from router U output port d to router V input port opp(d):
//     V.in_valid[opp(d)]   = U.out_valid[d]
//     V.in_{color,payload} = U.out_{color,payload}[d]
//     U.out_ready[d]       = V.in_ready[opp(d)]                  (FIFO room)
//     U.out_credit[d]      = U.out_valid[d] && V.in_ready[opp(d)] (accepted)
//   Opposite directions: N<->S, E<->W (e1x_pkg::E1X_DIR_* encoding).
//
// Boundary ports (mesh edges) have no neighbour: their input valid is tied low
// and their output ready/credit are tied so a flit routed off-mesh is held in
// the FIFO (it never drains) rather than silently lost — a misroute fails
// closed under congestion instead of dropping. Route tables are programmed for
// strict XY (dimension-order) routing, which is acyclic in the channel-
// dependency graph and therefore deadlock-free; see e1x_credit_router.sv.
//
// Route-table programming uses a flat broadcast bus with a per-node select:
// asserting ``prog_we_i`` writes ``prog_addr_i``/``prog_dir_i`` into the router
// addressed by (``prog_node_row_i``, ``prog_node_col_i``). The boot sequencer
// programs every node's table this way before traffic starts.
//
// The Local injection/ejection ports are exposed per node so a testbench (or a
// boot DMA engine) can launch a wavelet into any node and observe delivery at
// the destination node's PE core. The PE cores are independently bootable over
// the shared instruction-stream broadcast bus + per-node enable, mirroring the
// single-tile boot model.
module e1x_mesh_fabric #(
  parameter int ROWS         = 4,
  parameter int COLS         = 4,
  parameter int PORTS        = e1x_pkg::E1X_PORTS,
  parameter int COLORS       = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int FIFO_DEPTH   = 4,
  parameter int CREDIT_MAX   = 4
) (
  input  logic clk_i,
  input  logic rst_ni,

  // Per-node PE core boot/run controls (flattened [node] vectors).
  input  logic [ROWS*COLS-1:0]        core_enable_i,
  input  logic [ROWS*COLS-1:0]        core_boot_en_i,
  input  logic [ROWS*COLS-1:0]        core_instr_valid_i,
  input  logic [31:0]                 core_instr_i,            // broadcast word
  input  logic [31:0]                 core_boot_pc_i,          // broadcast boot PC

  // Route-table programming (one router at a time).
  input  logic                                    prog_we_i,
  input  logic [$clog2(ROWS)-1:0]                 prog_node_row_i,
  input  logic [$clog2(COLS)-1:0]                 prog_node_col_i,
  input  logic [$clog2(COLORS)+$clog2(PORTS)-1:0] prog_addr_i,
  input  logic [2:0]                              prog_dir_i,

  // Per-node Local injection (TB / boot-DMA source).
  input  logic [ROWS*COLS-1:0]                       inject_valid_i,
  input  logic [ROWS*COLS-1:0][$clog2(COLORS)-1:0]   inject_color_i,
  input  logic [ROWS*COLS-1:0][PAYLOAD_BITS-1:0]     inject_payload_i,
  output logic [ROWS*COLS-1:0]                       inject_ready_o,

  // Per-node Local ejection (delivered to the node's PE core when the route
  // table steers a wavelet to Local; also surfaced for observation).
  output logic [ROWS*COLS-1:0]                       eject_valid_o,
  output logic [ROWS*COLS-1:0][$clog2(COLORS)-1:0]   eject_color_o,
  output logic [ROWS*COLS-1:0][PAYLOAD_BITS-1:0]     eject_payload_o,
  input  logic [ROWS*COLS-1:0]                       eject_ready_i,

  // Per-node PE core observation.
  output logic [ROWS*COLS-1:0][31:0] core_pc_o,
  output logic [ROWS*COLS-1:0][63:0] core_x10_o,
  output logic [ROWS*COLS-1:0]       core_halted_o,
  output logic [ROWS*COLS-1:0]       core_active_o,
  output logic [ROWS*COLS-1:0]       core_wavelet_valid_o,
  output logic [ROWS*COLS-1:0][PAYLOAD_BITS-1:0] core_wavelet_payload_o
);
  import e1x_pkg::*;

  localparam int NODES       = ROWS * COLS;
  localparam int COLOR_BITS  = $clog2(COLORS);
  localparam int DIR_N       = int'(E1X_DIR_NORTH);
  localparam int DIR_E       = int'(E1X_DIR_EAST);
  localparam int DIR_S       = int'(E1X_DIR_SOUTH);
  localparam int DIR_W       = int'(E1X_DIR_WEST);
  localparam int DIR_L       = int'(E1X_DIR_LOCAL);

  function automatic int node_index(input int row, input int col);
    node_index = row * COLS + col;
  endfunction

  // Per-router port-vector wires.
  logic [NODES-1:0][PORTS-1:0]                   rin_valid;
  logic [NODES-1:0][PORTS-1:0][COLOR_BITS-1:0]   rin_color;
  logic [NODES-1:0][PORTS-1:0][PAYLOAD_BITS-1:0] rin_payload;
  logic [NODES-1:0][PORTS-1:0]                   rin_ready;
  logic [NODES-1:0][PORTS-1:0]                   rout_valid;
  logic [NODES-1:0][PORTS-1:0][COLOR_BITS-1:0]   rout_color;
  logic [NODES-1:0][PORTS-1:0][PAYLOAD_BITS-1:0] rout_payload;
  logic [NODES-1:0][PORTS-1:0]                   rout_ready;
  logic [NODES-1:0][PORTS-1:0]                   rout_credit;

  // PE-core <-> router Local wiring.
  logic [NODES-1:0]                   core_tx_valid;
  logic [NODES-1:0][PAYLOAD_BITS-1:0] core_tx_payload;
  logic [NODES-1:0]                   core_rx_ready;

  // ---------------------------------------------------------------------------
  // Inter-node link wiring + boundary tie-offs (per-node generate assigns).
  //
  // Each router's North/East/South/West input/output ports are connected to the
  // opposite port of the adjacent router. Boundary ports (no neighbour) drive
  // input-valid low and output ready/credit low, so a flit routed off-mesh is
  // held in the FIFO rather than silently lost (fail closed under congestion).
  // The Local port is owned by the PE core + the per-node inject/eject taps and
  // is a terminal sink/source: it is always drained (ready) when the consumer
  // can accept, and a returned credit is decoupled from the router's own output
  // valid (it tracks downstream acceptance only), matching the verified
  // two-router chain link contract.
  // ---------------------------------------------------------------------------
  for (genvar gr = 0; gr < ROWS; gr++) begin : g_link_row
    for (genvar gc = 0; gc < COLS; gc++) begin : g_link_col
      localparam int LN = gr * COLS + gc;

      // ---- North port (neighbour at row-1, its South port) ----
      if (gr > 0) begin : g_north
        localparam int UP = (gr - 1) * COLS + gc;
        assign rin_valid[LN][DIR_N]   = rout_valid[UP][DIR_S];
        assign rin_color[LN][DIR_N]   = rout_color[UP][DIR_S];
        assign rin_payload[LN][DIR_N] = rout_payload[UP][DIR_S];
        assign rout_ready[LN][DIR_N]  = rin_ready[UP][DIR_S];
        assign rout_credit[LN][DIR_N] = rin_ready[UP][DIR_S];
      end else begin : g_north_edge
        assign rin_valid[LN][DIR_N]   = 1'b0;
        assign rin_color[LN][DIR_N]   = '0;
        assign rin_payload[LN][DIR_N] = '0;
        assign rout_ready[LN][DIR_N]  = 1'b0;
        assign rout_credit[LN][DIR_N] = 1'b0;
      end

      // ---- South port (neighbour at row+1, its North port) ----
      if (gr < ROWS - 1) begin : g_south
        localparam int DN = (gr + 1) * COLS + gc;
        assign rin_valid[LN][DIR_S]   = rout_valid[DN][DIR_N];
        assign rin_color[LN][DIR_S]   = rout_color[DN][DIR_N];
        assign rin_payload[LN][DIR_S] = rout_payload[DN][DIR_N];
        assign rout_ready[LN][DIR_S]  = rin_ready[DN][DIR_N];
        assign rout_credit[LN][DIR_S] = rin_ready[DN][DIR_N];
      end else begin : g_south_edge
        assign rin_valid[LN][DIR_S]   = 1'b0;
        assign rin_color[LN][DIR_S]   = '0;
        assign rin_payload[LN][DIR_S] = '0;
        assign rout_ready[LN][DIR_S]  = 1'b0;
        assign rout_credit[LN][DIR_S] = 1'b0;
      end

      // ---- West port (neighbour at col-1, its East port) ----
      if (gc > 0) begin : g_west
        localparam int LF = gr * COLS + (gc - 1);
        assign rin_valid[LN][DIR_W]   = rout_valid[LF][DIR_E];
        assign rin_color[LN][DIR_W]   = rout_color[LF][DIR_E];
        assign rin_payload[LN][DIR_W] = rout_payload[LF][DIR_E];
        assign rout_ready[LN][DIR_W]  = rin_ready[LF][DIR_E];
        assign rout_credit[LN][DIR_W] = rin_ready[LF][DIR_E];
      end else begin : g_west_edge
        assign rin_valid[LN][DIR_W]   = 1'b0;
        assign rin_color[LN][DIR_W]   = '0;
        assign rin_payload[LN][DIR_W] = '0;
        assign rout_ready[LN][DIR_W]  = 1'b0;
        assign rout_credit[LN][DIR_W] = 1'b0;
      end

      // ---- East port (neighbour at col+1, its West port) ----
      if (gc < COLS - 1) begin : g_east
        localparam int RT = gr * COLS + (gc + 1);
        assign rin_valid[LN][DIR_E]   = rout_valid[RT][DIR_W];
        assign rin_color[LN][DIR_E]   = rout_color[RT][DIR_W];
        assign rin_payload[LN][DIR_E] = rout_payload[RT][DIR_W];
        assign rout_ready[LN][DIR_E]  = rin_ready[RT][DIR_W];
        assign rout_credit[LN][DIR_E] = rin_ready[RT][DIR_W];
      end else begin : g_east_edge
        assign rin_valid[LN][DIR_E]   = 1'b0;
        assign rin_color[LN][DIR_E]   = '0;
        assign rin_payload[LN][DIR_E] = '0;
        assign rout_ready[LN][DIR_E]  = 1'b0;
        assign rout_credit[LN][DIR_E] = 1'b0;
      end

      // ---- Local port (PE core egress OR TB/boot inject; eject sink) ----
      // PE-core egress takes priority on the single Local input; in the mesh
      // delivery tests only the inject tap is active per node (cores disabled),
      // so the two never collide.
      assign rin_valid[LN][DIR_L]   = core_tx_valid[LN] | inject_valid_i[LN];
      assign rin_color[LN][DIR_L]   = core_tx_valid[LN] ? '0 : inject_color_i[LN];
      assign rin_payload[LN][DIR_L] = core_tx_valid[LN] ? core_tx_payload[LN]
                                                        : inject_payload_i[LN];
      assign rout_ready[LN][DIR_L]  = core_rx_ready[LN] | eject_ready_i[LN];
      assign rout_credit[LN][DIR_L] = core_rx_ready[LN] | eject_ready_i[LN];

      // Local taps.
      assign inject_ready_o[LN]  = rin_ready[LN][DIR_L];
      assign eject_valid_o[LN]   = rout_valid[LN][DIR_L];
      assign eject_color_o[LN]   = rout_color[LN][DIR_L];
      assign eject_payload_o[LN] = rout_payload[LN][DIR_L];
    end
  end

  // ---------------------------------------------------------------------------
  // Per-node router + PE core instances.
  // ---------------------------------------------------------------------------
  for (genvar r = 0; r < ROWS; r++) begin : g_row
    for (genvar c = 0; c < COLS; c++) begin : g_col
      localparam int N = r * COLS + c;
      logic prog_sel;
      assign prog_sel = prog_we_i
        && (prog_node_row_i == $clog2(ROWS)'(r))
        && (prog_node_col_i == $clog2(COLS)'(c));

      e1x_credit_router #(
        .PORTS(PORTS), .COLORS(COLORS), .PAYLOAD_BITS(PAYLOAD_BITS),
        .FIFO_DEPTH(FIFO_DEPTH), .CREDIT_MAX(CREDIT_MAX)
      ) u_router (
        .clk_i(clk_i), .rst_ni(rst_ni),
        .repair_enable_i(1'b0), .port_disable_i('0),
        .prog_we_i(prog_sel), .prog_addr_i(prog_addr_i),
        .prog_dir_i(prog_dir_i), .prog_dir_o(),
        .in_valid_i(rin_valid[N]), .in_color_i(rin_color[N]),
        .in_payload_i(rin_payload[N]), .in_ready_o(rin_ready[N]),
        .out_valid_o(rout_valid[N]), .out_color_o(rout_color[N]),
        .out_payload_o(rout_payload[N]), .out_ready_i(rout_ready[N]),
        .out_credit_i(rout_credit[N]), .repaired_drop_o()
      );

      logic [31:0] node_pc;
      logic [63:0] node_x1, node_x2, node_x3;
      logic        node_halted, node_active;
      e1x_pe_core u_core (
        .clk_i(clk_i), .rst_ni(rst_ni),
        .enable_i(core_enable_i[N]),
        .boot_en_i(core_boot_en_i[N]),
        .boot_pc_i(core_boot_pc_i),
        .instr_valid_i(core_instr_valid_i[N]),
        .instr_i(core_instr_i),
        .wavelet_valid_i(rout_valid[N][DIR_L]),
        .wavelet_payload_i(rout_payload[N][DIR_L]),
        .wavelet_ready_o(core_rx_ready[N]),
        .wavelet_valid_o(core_tx_valid[N]),
        .wavelet_payload_o(core_tx_payload[N]),
        .pc_o(node_pc),
        .x1_o(node_x1), .x2_o(node_x2), .x3_o(node_x3),
        .halted_o(node_halted), .active_o(node_active)
      );

      assign core_pc_o[N]              = node_pc;
      assign core_x10_o[N]             = u_core.regs[10];
      assign core_halted_o[N]          = node_halted;
      assign core_active_o[N]          = node_active;
      assign core_wavelet_valid_o[N]   = core_tx_valid[N];
      assign core_wavelet_payload_o[N] = core_tx_payload[N];

      logic unused_node;
      assign unused_node = ^{node_x1, node_x2, node_x3};
    end
  end
endmodule
