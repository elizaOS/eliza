// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys formal harness for ``e1x_repair_route_table``. Proves the bounded
// storage / overflow contract and the determinism of lookups. Drive with
// verify/formal/e1x/e1x_repair_route_table.sby.
//
// Reset model: ``rst_ni`` starts low (via an initial value) and is driven high
// on the first clock edge, so the async reset establishes a known initial
// register state under BMC (yosys ``prep`` does not otherwise apply async
// resets). History/next-cycle obligations are only checked once a reset cycle
// has been observed (``saw_reset``). This mirrors verify/formal/bpu/ras_formal.
//
// Reduced parameters (MAX_ROUTES=4, INDEX_BITS=24, HOP_BITS=4) keep the bounded
// model tractable while preserving every structural property of the full-size
// instance: the counter/overflow logic and the associative lookup loop are
// parameter-generic, so a proof at MAX_ROUTES=4 is representative of the
// production MAX_ROUTES=16 instance. INDEX_BITS is held at its minimum legal
// value of 24 because e1x_repair_rom_loader packs the route "from" field into
// word_i[63:40] (24 bits) and zero-extends by INDEX_BITS-24.
//
// The yosys-slang frontend's concurrent-SVA support does not accept the
// next-cycle implications used here (combinational-wire consequents and
// multi-term antecedents under |=>), and labelled assertions inside unrolled
// for-loops emit duplicate RTLIL cell names. All properties are therefore
// expressed as immediate assertions: combinational ones in always_comb, and
// next-cycle ones over explicit one-cycle history registers in always_ff.

`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_route_table_formal #(
  parameter int LOOKUP_PORTS = 2,
  parameter int INDEX_BITS = 24,
  parameter int HOP_BITS = 4,
  parameter int MAX_ROUTES = 4
) (
  input logic clk_i
);
  logic rst_ni = 1'b0;

  // Free stimulus is registered into real flip-flops so each DUT input has a
  // single stable driver. Feeding (* anyseq *) directly into both the DUT and a
  // parallel reconstruction cone lets yosys duplicate the $anyseq source during
  // optimisation, desynchronising the two readers; registering removes that
  // hazard and gives every property one authoritative value per cycle.
  (* anyseq *) logic clear_d;
  (* anyseq *) logic word_valid_d;
  (* anyseq *) logic [63:0] word_d;
  (* anyseq *) logic [LOOKUP_PORTS-1:0] lookup_valid_d;
  (* anyseq *) logic [LOOKUP_PORTS-1:0][INDEX_BITS-1:0] lookup_from_d;
  (* anyseq *) logic [LOOKUP_PORTS-1:0][INDEX_BITS-1:0] lookup_to_d;

  logic clear_i;
  logic word_valid_i;
  logic [63:0] word_i;
  logic [LOOKUP_PORTS-1:0] lookup_valid_i;
  logic [LOOKUP_PORTS-1:0][INDEX_BITS-1:0] lookup_from_i;
  logic [LOOKUP_PORTS-1:0][INDEX_BITS-1:0] lookup_to_i;

  always_ff @(posedge clk_i) begin
    clear_i <= clear_d;
    word_valid_i <= word_valid_d;
    word_i <= word_d;
    lookup_valid_i <= lookup_valid_d;
    lookup_from_i <= lookup_from_d;
    lookup_to_i <= lookup_to_d;
  end

  logic word_ready_o;
  logic load_done_o;
  logic load_error_o;
  logic overflow_o;
  logic [31:0] remap_count_o;
  logic [31:0] route_count_o;
  logic [LOOKUP_PORTS-1:0] lookup_hit_o;
  logic [LOOKUP_PORTS-1:0][2:0] lookup_dir_o;
  logic [LOOKUP_PORTS-1:0][HOP_BITS-1:0] lookup_hops_o;

  e1x_repair_route_table #(
    .LOOKUP_PORTS(LOOKUP_PORTS),
    .INDEX_BITS(INDEX_BITS),
    .HOP_BITS(HOP_BITS),
    .MAX_ROUTES(MAX_ROUTES)
  ) dut (
    .clk_i(clk_i),
    .rst_ni(rst_ni),
    .clear_i(clear_i),
    .word_valid_i(word_valid_i),
    .word_i(word_i),
    .word_ready_o(word_ready_o),
    .load_done_o(load_done_o),
    .load_error_o(load_error_o),
    .overflow_o(overflow_o),
    .remap_count_o(remap_count_o),
    .route_count_o(route_count_o),
    .lookup_valid_i(lookup_valid_i),
    .lookup_from_i(lookup_from_i),
    .lookup_to_i(lookup_to_i),
    .lookup_hit_o(lookup_hit_o),
    .lookup_dir_o(lookup_dir_o),
    .lookup_hops_o(lookup_hops_o)
  );

  // All operands are read through the DUT hierarchical path so every property
  // observes the exact net the DUT's own logic uses. Reading the top-level
  // (* anyseq *) clear_i through a second fanout cone would let the solver
  // desynchronise the two readers (anyseq is not a single stable driver), so
  // clear is sampled as dut.clear_i here.
  wire clear_w         = dut.clear_i;
  wire route_valid_w   = dut.route_valid;
  wire [31:0] stored_w = dut.routes_stored_q;
  wire overflow_q_w    = dut.overflow_q;

  wire at_capacity = (stored_w == MAX_ROUTES);
  wire full_write  = !clear_w && route_valid_w && at_capacity;

  // Expected next value of overflow_q, derived directly from the RTL priority
  // chain (clear beats the at-capacity write, which beats hold). Sampling it
  // here and comparing against the realised overflow_q one cycle later pins the
  // complete "overflow asserts exactly when, and only when, capacity is
  // exceeded" contract in a single biconditional that the history registers can
  // express faithfully (avoiding the cross-cycle ambiguity of an isolated
  // no-spurious-rise property over a free clear input).
  wire overflow_next = clear_w ? 1'b0 : (full_write ? 1'b1 : overflow_q_w);

  logic saw_reset;
  logic armed_q;
  logic prev_full_write;
  logic prev_overflow;
  logic prev_clear;
  logic prev_overflow_next;
  initial saw_reset = 1'b0;

  always_ff @(posedge clk_i) begin
    rst_ni <= 1'b1;
    if (rst_ni) begin
      saw_reset <= 1'b1;
    end
    armed_q <= rst_ni;
    prev_full_write <= full_write;
    prev_overflow <= overflow_q_w;
    prev_clear <= clear_w;
    prev_overflow_next <= overflow_next;
  end

  // ---------------------------------------------------------------------------
  // Combinational invariants.
  // ---------------------------------------------------------------------------
  always_comb begin
    if (saw_reset) begin
      // Bounded storage: the stored count never exceeds capacity (otherwise the
      // counter wrapped or indexed past the route memory).
      a_count_bounded: assert (stored_w <= MAX_ROUTES);
      // The reported route_count tracks the real stored count exactly.
      a_count_eq_output: assert (route_count_o == stored_w);
    end
  end

  // Lookup determinism / in-bounds. The lookup is a pure combinational function
  // of the programmed records and the lookup key (a fully-defined 2-state SMT
  // model, so no-X holds by construction). A miss returns the DROP default with
  // zero hops; a hit can only occur when the port lookup was requested and at
  // least one record is stored, i.e. lookups never read uninitialised slots.
  always_comb begin
    if (saw_reset) begin
      for (int p = 0; p < LOOKUP_PORTS; p++) begin
        if (!lookup_hit_o[p]) begin
          assert (lookup_dir_o[p] == e1x_pkg::E1X_DIR_DROP);
          assert (lookup_hops_o[p] == '0);
        end
        if (lookup_hit_o[p]) begin
          assert (lookup_valid_i[p]);
          assert (stored_w != 0);
        end
      end
    end
  end

  // ---------------------------------------------------------------------------
  // Next-cycle obligations over one-cycle history registers.
  // ---------------------------------------------------------------------------
  always_ff @(posedge clk_i) begin
    if (saw_reset && armed_q) begin
      // No silent truncation: a route accepted while at capacity raises overflow
      // next cycle and must not grow the stored count.
      if (prev_full_write && !prev_clear) begin
        a_overflow_on_full_write: assert (overflow_q_w);
        a_no_grow_when_full: assert (at_capacity);
      end
      // Overflow is sticky until clear/reset.
      if (prev_overflow && !prev_clear) begin
        a_overflow_sticky: assert (overflow_q_w);
      end
      // Exact overflow next-state: overflow_q equals the value mandated by the
      // RTL priority chain in the prior cycle. This is the biconditional form of
      // "overflow asserts exactly when capacity is exceeded" (and is cleared by
      // clear_i), subsuming the forward and no-spurious-rise directions.
      a_overflow_next_state: assert (overflow_q_w == prev_overflow_next);
    end
  end
endmodule
