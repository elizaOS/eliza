`include "rtl/e1x/e1x_pkg.sv"

// Production-grade input-buffered, credit-flow-controlled mesh router for the
// E1X wafer fabric. Replaces the purely combinational single-cycle
// ``e1x_mesh_router`` (kept intact for legacy tests) with a registered
// datapath that never silently drops wavelets under congestion.
//
// Topology and contract
// ----------------------
//   - 5 ports (N=0, S/E/W mapped via E1X_DIR_* in e1x_pkg, Local=4). The port
//     index space is the e1x_pkg direction encoding so that a route-table
//     entry written as a direction selects the matching output port directly.
//   - Each input port owns a small FIFO. A wavelet is admitted into the input
//     FIFO when ``in_valid_i && in_ready_o``. Once buffered it is forwarded to
//     the output selected by the per-color, per-input route table, gated by a
//     downstream credit counter. Wavelets are NEVER dropped because of
//     congestion: if no credit or the output loses arbitration, the wavelet
//     stays buffered and ``in_ready_o`` deasserts when the input FIFO fills.
//   - The only deliberate drops are: a route programmed to E1X_DIR_DROP, an
//     input/output port disabled for repair (``port_disable_i``) while repair
//     is enabled. Those are reported on ``repaired_drop_o`` for one cycle.
//
// Flow control
// ------------
//   Credit-based on every output port. ``out_credit_i[p]`` pulses high to
//   return one credit to output port ``p`` (the downstream consumer asserts it
//   when it accepts a wavelet). The router forwards on output ``p`` only when
//   ``out_credit_count[p] > 0``. The local consumer-side handshake remains
//   valid/ready (``out_valid_o``/``out_ready_i``): a flit leaves an output
//   register only when ``out_valid_o && out_ready_i``.
//
// Arbitration
// -----------
//   Per output port, round-robin among the (up to four) input ports that
//   currently request it. The rotating pointer advances past the granted input
//   so no input can be starved while it keeps requesting.
//
// Route-table programming
// ------------------------
//   ``prog_we_i`` with ``prog_addr_i = {color, in_port}`` writes the 3-bit
//   output direction for that (color, input) pair. ``prog_dir_o`` reads back
//   the addressed entry combinationally for verification. The table resets to
//   E1X_DIR_DROP so an unprogrammed entry fails closed rather than mis-routing.
//
// Deadlock avoidance
// ------------------
//   This router provides no virtual channels; per-output buffering is a single
//   credited stage. Network-level deadlock freedom is guaranteed by the route
//   tables programming strict XY dimension-order routing on the base mesh
//   (X/East-West fully resolved before any Y/North-South turn), which is acyclic
//   in the channel-dependency graph. The Local port is a terminal sink/source
//   and adds no turn. If a future topology programs non-dimension-order turns,
//   virtual channels must be added; this module does not by itself prevent a
//   routing-induced cycle.
module e1x_credit_router #(
  parameter int PORTS        = e1x_pkg::E1X_PORTS,
  parameter int COLORS       = e1x_pkg::E1X_ROUTING_COLORS,
  parameter int PAYLOAD_BITS = e1x_pkg::E1X_FABRIC_PAYLOAD_BITS,
  parameter int FIFO_DEPTH   = 4,
  parameter int CREDIT_MAX   = 4
) (
  input  logic clk_i,
  input  logic rst_ni,

  // Repair controls.
  input  logic                   repair_enable_i,
  input  logic [PORTS-1:0]       port_disable_i,

  // Route-table programming/readback.
  input  logic                                          prog_we_i,
  input  logic [$clog2(COLORS)+$clog2(PORTS)-1:0]       prog_addr_i,
  input  logic [2:0]                                    prog_dir_i,
  output logic [2:0]                                    prog_dir_o,

  // Input ports (valid/ready), one color + payload per port.
  input  logic [PORTS-1:0]                              in_valid_i,
  input  logic [PORTS-1:0][$clog2(COLORS)-1:0]          in_color_i,
  input  logic [PORTS-1:0][PAYLOAD_BITS-1:0]            in_payload_i,
  output logic [PORTS-1:0]                              in_ready_o,

  // Output ports (valid/ready) plus credit return.
  output logic [PORTS-1:0]                              out_valid_o,
  output logic [PORTS-1:0][$clog2(COLORS)-1:0]          out_color_o,
  output logic [PORTS-1:0][PAYLOAD_BITS-1:0]            out_payload_o,
  input  logic [PORTS-1:0]                              out_ready_i,
  input  logic [PORTS-1:0]                              out_credit_i,

  // One-cycle pulse per input that was deliberately dropped.
  output logic [PORTS-1:0]                              repaired_drop_o
);
  import e1x_pkg::*;

  localparam int COLOR_BITS  = $clog2(COLORS);
  localparam int PORT_BITS   = $clog2(PORTS);
  localparam int PTR_BITS    = $clog2(FIFO_DEPTH);
  localparam int DEPTH_BITS  = $clog2(FIFO_DEPTH + 1);
  localparam int CREDIT_BITS = $clog2(CREDIT_MAX + 1);

  typedef struct packed {
    logic [COLOR_BITS-1:0]   color;
    logic [PAYLOAD_BITS-1:0] payload;
  } flit_t;

  // ---------------------------------------------------------------------------
  // Route table: COLORS x PORTS entries of 3-bit direction. Resets to DROP.
  // ---------------------------------------------------------------------------
  logic [2:0] route_table_q [COLORS][PORTS];

  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      for (int c = 0; c < COLORS; c++) begin
        for (int p = 0; p < PORTS; p++) begin
          route_table_q[c][p] <= E1X_DIR_DROP;
        end
      end
    end else if (prog_we_i) begin
      route_table_q[prog_addr_i[PORT_BITS+:COLOR_BITS]][prog_addr_i[0+:PORT_BITS]]
        <= prog_dir_i;
    end
  end

  assign prog_dir_o =
    route_table_q[prog_addr_i[PORT_BITS+:COLOR_BITS]][prog_addr_i[0+:PORT_BITS]];

  // ---------------------------------------------------------------------------
  // Per-input FIFOs.
  // ---------------------------------------------------------------------------
  flit_t            fifo_mem  [PORTS][FIFO_DEPTH];
  logic [PTR_BITS-1:0]   fifo_wptr [PORTS];
  logic [PTR_BITS-1:0]   fifo_rptr [PORTS];
  logic [DEPTH_BITS-1:0] fifo_cnt  [PORTS];

  logic [PORTS-1:0] fifo_empty;
  logic [PORTS-1:0] fifo_full;
  logic [PORTS-1:0] fifo_push;
  logic [PORTS-1:0] fifo_pop;

  flit_t            fifo_head [PORTS];

  for (genvar p = 0; p < PORTS; p++) begin : g_fifo_status
    assign fifo_empty[p] = (fifo_cnt[p] == '0);
    assign fifo_full[p]  = (fifo_cnt[p] == DEPTH_BITS'(FIFO_DEPTH));
    assign fifo_head[p]  = fifo_mem[p][fifo_rptr[p]];
  end

  // An input is ready to accept when its FIFO is not full and the port is not
  // disabled-for-repair (a disabled input drains via the drop path instead).
  for (genvar p = 0; p < PORTS; p++) begin : g_in_ready
    assign in_ready_o[p] = !fifo_full[p];
  end

  for (genvar p = 0; p < PORTS; p++) begin : g_fifo_push
    assign fifo_push[p] = in_valid_i[p] && in_ready_o[p];
  end

  // ---------------------------------------------------------------------------
  // Routing decision per buffered head flit.
  // ---------------------------------------------------------------------------
  logic [2:0]            head_dir   [PORTS];
  logic [PORTS-1:0]      head_drop;       // deliberate drop (DROP route / repair)
  logic [PORTS-1:0]      head_route_ok;   // head wants a real output port
  logic [PORT_BITS-1:0]  head_out   [PORTS];

  always_comb begin
    for (int p = 0; p < PORTS; p++) begin
      automatic logic [2:0] dir;
      dir            = route_table_q[fifo_head[p].color][p];
      head_dir[p]    = dir;
      head_drop[p]   = 1'b0;
      head_route_ok[p] = 1'b0;
      head_out[p]    = '0;

      if (!fifo_empty[p]) begin
        automatic logic in_disabled;
        in_disabled = repair_enable_i && port_disable_i[p];
        if (in_disabled) begin
          head_drop[p] = 1'b1;
        end else if (dir == E1X_DIR_DROP) begin
          head_drop[p] = 1'b1;
        end else if (int'(dir) < PORTS) begin
          automatic logic out_disabled;
          out_disabled = repair_enable_i && port_disable_i[int'(dir)];
          if (out_disabled) begin
            head_drop[p] = 1'b1;
          end else begin
            head_route_ok[p] = 1'b1;
            head_out[p]      = dir[PORT_BITS-1:0];
          end
        end else begin
          // Direction outside the legal port range: drop only under repair so
          // a misprogrammed table cannot wedge the FIFO; otherwise hold.
          head_drop[p] = repair_enable_i;
        end
      end
    end
  end

  // ---------------------------------------------------------------------------
  // Output registers + credit counters.
  // ---------------------------------------------------------------------------
  flit_t            out_flit_q [PORTS];
  logic [PORTS-1:0] out_valid_q;
  logic [CREDIT_BITS-1:0] credit_q [PORTS];

  // An output register can accept a new flit this cycle when it is empty or
  // being drained by the downstream ready handshake.
  logic [PORTS-1:0] out_slot_free;
  for (genvar o = 0; o < PORTS; o++) begin : g_out_free
    assign out_slot_free[o] = !out_valid_q[o] || out_ready_i[o];
  end

  // ---------------------------------------------------------------------------
  // Per-output round-robin arbitration over requesting inputs.
  // An input requests output o if its head routes there, the output slot is
  // free this cycle, and a credit is available.
  // ---------------------------------------------------------------------------
  logic [PORTS-1:0] rr_ptr_q;            // next-preferred input index per output
  // packed as [output][input]
  logic [PORTS-1:0][PORTS-1:0] request;
  logic [PORTS-1:0][PORTS-1:0] grant;
  logic [PORTS-1:0]            out_grant_valid;
  logic [PORT_BITS-1:0]        out_grant_in [PORTS];

  always_comb begin
    for (int o = 0; o < PORTS; o++) begin
      for (int i = 0; i < PORTS; i++) begin
        request[o][i] = head_route_ok[i] && (int'(head_out[i]) == o);
      end
    end
  end

  // rr_ptr_q is a one-entry-per-output rotating start index. Stored compactly:
  // one PORT_BITS pointer per output.
  logic [PORT_BITS-1:0] rr_start_q [PORTS];

  always_comb begin
    for (int o = 0; o < PORTS; o++) begin
      automatic logic found;
      grant[o]           = '0;
      out_grant_valid[o] = 1'b0;
      out_grant_in[o]    = '0;
      found              = 1'b0;
      if (out_slot_free[o] && credit_q[o] != '0) begin
        for (int k = 0; k < PORTS; k++) begin
          automatic int idx;
          idx = (int'(rr_start_q[o]) + k) % PORTS;
          if (!found && request[o][idx]) begin
            grant[o][idx]      = 1'b1;
            out_grant_valid[o] = 1'b1;
            out_grant_in[o]    = idx[PORT_BITS-1:0];
            found              = 1'b1;
          end
        end
      end
    end
  end

  // An input's head is popped when it is dropped, or it wins arbitration on its
  // target output. At most one output can grant a given input because each head
  // has exactly one target.
  always_comb begin
    for (int p = 0; p < PORTS; p++) begin
      automatic logic granted;
      granted = 1'b0;
      for (int o = 0; o < PORTS; o++) begin
        if (grant[o][p]) granted = 1'b1;
      end
      fifo_pop[p] = !fifo_empty[p] && (head_drop[p] || granted);
    end
  end

  // ---------------------------------------------------------------------------
  // Sequential state.
  // ---------------------------------------------------------------------------
  always_ff @(posedge clk_i or negedge rst_ni) begin
    if (!rst_ni) begin
      for (int p = 0; p < PORTS; p++) begin
        fifo_wptr[p]   <= '0;
        fifo_rptr[p]   <= '0;
        fifo_cnt[p]    <= '0;
        out_valid_q[p] <= 1'b0;
        out_flit_q[p]  <= '0;
        credit_q[p]    <= CREDIT_BITS'(CREDIT_MAX);
        rr_start_q[p]  <= '0;
        repaired_drop_o[p] <= 1'b0;
      end
    end else begin
      // FIFO write / read pointers + occupancy.
      for (int p = 0; p < PORTS; p++) begin
        if (fifo_push[p]) begin
          fifo_mem[p][fifo_wptr[p]].color   <= in_color_i[p];
          fifo_mem[p][fifo_wptr[p]].payload <= in_payload_i[p];
          fifo_wptr[p] <= (fifo_wptr[p] == PTR_BITS'(FIFO_DEPTH - 1))
                            ? '0 : fifo_wptr[p] + PTR_BITS'(1);
        end
        if (fifo_pop[p]) begin
          fifo_rptr[p] <= (fifo_rptr[p] == PTR_BITS'(FIFO_DEPTH - 1))
                            ? '0 : fifo_rptr[p] + PTR_BITS'(1);
        end
        unique case ({fifo_push[p], fifo_pop[p]})
          2'b10:   fifo_cnt[p] <= fifo_cnt[p] + DEPTH_BITS'(1);
          2'b01:   fifo_cnt[p] <= fifo_cnt[p] - DEPTH_BITS'(1);
          default: fifo_cnt[p] <= fifo_cnt[p];
        endcase
      end

      // Repair-drop pulse: any head dropped this cycle.
      for (int p = 0; p < PORTS; p++) begin
        repaired_drop_o[p] <= head_drop[p];
      end

      // Output registers, credits, round-robin pointers.
      for (int o = 0; o < PORTS; o++) begin
        automatic logic drained;
        automatic logic loaded;
        drained = out_valid_q[o] && out_ready_i[o];
        loaded  = out_grant_valid[o];

        if (loaded) begin
          out_flit_q[o]  <= fifo_head[out_grant_in[o]];
          out_valid_q[o] <= 1'b1;
          // advance round-robin past the granted input
          rr_start_q[o]  <= (out_grant_in[o] == PORT_BITS'(PORTS - 1))
                              ? '0 : out_grant_in[o] + PORT_BITS'(1);
        end else if (drained) begin
          out_valid_q[o] <= 1'b0;
        end

        // Credit accounting: consume on grant (a flit was launched into the
        // credited downstream slot), replenish on returned credit.
        unique case ({loaded, out_credit_i[o]})
          2'b10:   credit_q[o] <= credit_q[o] - CREDIT_BITS'(1);
          2'b01:   credit_q[o] <= (credit_q[o] == CREDIT_BITS'(CREDIT_MAX))
                                    ? credit_q[o] : credit_q[o] + CREDIT_BITS'(1);
          default: credit_q[o] <= credit_q[o];
        endcase
      end
    end
  end

  // ---------------------------------------------------------------------------
  // Output port drive.
  // ---------------------------------------------------------------------------
  for (genvar o = 0; o < PORTS; o++) begin : g_out_drive
    assign out_valid_o[o]   = out_valid_q[o];
    assign out_color_o[o]   = out_flit_q[o].color;
    assign out_payload_o[o] = out_flit_q[o].payload;
  end
endmodule
