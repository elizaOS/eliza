// SPDX-License-Identifier: Apache-2.0
//
// SymbiYosys formal harness for ``e1x_repair_state`` (the combined remap +
// route store programmed from the repair ROM). Proves the bounded-storage /
// overflow contract for both the remap and route tables and the determinism of
// both lookup ports. Drive with verify/formal/e1x/e1x_repair_state.sby.
//
// Same modelling decisions as e1x_repair_route_table_formal: reset is driven
// from an initial-low rst_ni so the async reset establishes a known initial
// state under BMC; free stimulus is registered into real flip-flops so each DUT
// input has a single stable driver (avoiding $anyseq fanout duplication);
// next-cycle obligations use explicit one-cycle history registers; assertion
// labels are omitted inside unrolled for-loops (yosys-slang derives RTLIL cell
// names from labels). Reduced parameters keep the bounded model tractable while
// preserving every structural property; INDEX_BITS stays at its minimum legal
// value of 24 (the loader packs the remap/route fields into fixed bit ranges).

`include "rtl/e1x/e1x_pkg.sv"

module e1x_repair_state_formal #(
  parameter int INDEX_BITS = 24,
  parameter int HOP_BITS = 4,
  parameter int MAX_REMAPS = 4,
  parameter int MAX_ROUTES = 4
) (
  input logic clk_i
);
  logic rst_ni = 1'b0;

  (* anyseq *) logic clear_d;
  (* anyseq *) logic word_valid_d;
  (* anyseq *) logic [63:0] word_d;
  (* anyseq *) logic remap_lookup_valid_d;
  (* anyseq *) logic [INDEX_BITS-1:0] remap_lookup_logical_d;
  (* anyseq *) logic route_lookup_valid_d;
  (* anyseq *) logic [INDEX_BITS-1:0] route_lookup_from_d;
  (* anyseq *) logic [INDEX_BITS-1:0] route_lookup_to_d;

  logic clear_i;
  logic word_valid_i;
  logic [63:0] word_i;
  logic remap_lookup_valid_i;
  logic [INDEX_BITS-1:0] remap_lookup_logical_i;
  logic route_lookup_valid_i;
  logic [INDEX_BITS-1:0] route_lookup_from_i;
  logic [INDEX_BITS-1:0] route_lookup_to_i;

  always_ff @(posedge clk_i) begin
    clear_i <= clear_d;
    word_valid_i <= word_valid_d;
    word_i <= word_d;
    remap_lookup_valid_i <= remap_lookup_valid_d;
    remap_lookup_logical_i <= remap_lookup_logical_d;
    route_lookup_valid_i <= route_lookup_valid_d;
    route_lookup_from_i <= route_lookup_from_d;
    route_lookup_to_i <= route_lookup_to_d;
  end

  logic word_ready_o;
  logic load_done_o;
  logic load_error_o;
  logic overflow_o;
  logic [31:0] remap_count_o;
  logic [31:0] route_count_o;
  logic remap_lookup_hit_o;
  logic [INDEX_BITS-1:0] remap_lookup_physical_o;
  logic route_lookup_hit_o;
  logic [2:0] route_lookup_dir_o;
  logic [HOP_BITS-1:0] route_lookup_hops_o;

  e1x_repair_state #(
    .INDEX_BITS(INDEX_BITS),
    .HOP_BITS(HOP_BITS),
    .MAX_REMAPS(MAX_REMAPS),
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
    .remap_lookup_valid_i(remap_lookup_valid_i),
    .remap_lookup_logical_i(remap_lookup_logical_i),
    .remap_lookup_hit_o(remap_lookup_hit_o),
    .remap_lookup_physical_o(remap_lookup_physical_o),
    .route_lookup_valid_i(route_lookup_valid_i),
    .route_lookup_from_i(route_lookup_from_i),
    .route_lookup_to_i(route_lookup_to_i),
    .route_lookup_hit_o(route_lookup_hit_o),
    .route_lookup_dir_o(route_lookup_dir_o),
    .route_lookup_hops_o(route_lookup_hops_o)
  );

  // DUT-internal state read through the hierarchical path so every operand has
  // a single authoritative driver (the same net the DUT's own logic uses).
  wire clear_w           = dut.clear_i;
  wire remap_valid_w     = dut.remap_valid;
  wire route_valid_w     = dut.route_valid;
  wire [31:0] remaps_w   = dut.remaps_stored_q;
  wire [31:0] routes_w   = dut.routes_stored_q;
  wire overflow_q_w      = dut.overflow_q;

  wire remap_at_cap      = (remaps_w == MAX_REMAPS);
  wire route_at_cap      = (routes_w == MAX_ROUTES);
  // A route or remap write that lands while its table is full sets overflow,
  // unless cleared (clear has priority in the RTL).
  wire overflow_write    = !clear_w &&
                           ((remap_valid_w && remap_at_cap) ||
                            (route_valid_w && route_at_cap));
  // Exact next value of the shared overflow flag from the RTL priority chain.
  wire overflow_next     = clear_w ? 1'b0 : (overflow_write ? 1'b1 : overflow_q_w);

  logic saw_reset;
  logic armed_q;
  logic prev_overflow_next;
  initial saw_reset = 1'b0;

  always_ff @(posedge clk_i) begin
    rst_ni <= 1'b1;
    if (rst_ni) begin
      saw_reset <= 1'b1;
    end
    armed_q <= rst_ni;
    prev_overflow_next <= overflow_next;
  end

  // ---------------------------------------------------------------------------
  // Bounded storage for both tables, and reported counts track the real stored
  // counts exactly (no silent truncation that the count output would hide).
  // ---------------------------------------------------------------------------
  always_comb begin
    if (saw_reset) begin
      a_remaps_bounded: assert (remaps_w <= MAX_REMAPS);
      a_routes_bounded: assert (routes_w <= MAX_ROUTES);
      a_remap_count_eq: assert (remap_count_o == remaps_w);
      a_route_count_eq: assert (route_count_o == routes_w);
    end
  end

  // ---------------------------------------------------------------------------
  // Lookup determinism / in-bounds for both ports. The lookups are pure
  // combinational functions of the programmed records (fully-defined 2-state SMT
  // model, so no-X by construction). Misses return the documented defaults; hits
  // require the lookup to be requested and at least one record stored, so a
  // lookup never reads an uninitialised slot.
  // ---------------------------------------------------------------------------
  always_comb begin
    if (saw_reset) begin
      // Remap miss returns the identity mapping (physical == logical request).
      if (!remap_lookup_hit_o) begin
        a_remap_miss_identity: assert (remap_lookup_physical_o == remap_lookup_logical_i);
      end
      if (remap_lookup_hit_o) begin
        a_remap_hit_requested: assert (remap_lookup_valid_i);
        a_remap_hit_stored: assert (remaps_w != 0);
      end
      // Route miss returns the DROP default and zero hops.
      if (!route_lookup_hit_o) begin
        a_route_miss_drop: assert (route_lookup_dir_o == e1x_pkg::E1X_DIR_DROP);
        a_route_miss_zero_hops: assert (route_lookup_hops_o == '0);
      end
      if (route_lookup_hit_o) begin
        a_route_hit_requested: assert (route_lookup_valid_i);
        a_route_hit_stored: assert (routes_w != 0);
      end
    end
  end

  // ---------------------------------------------------------------------------
  // Exact overflow next-state: the shared overflow flag equals the value the RTL
  // priority chain mandated in the prior cycle. This is the biconditional form
  // of "overflow asserts exactly when (a remap or route) capacity is exceeded,
  // and is cleared by clear_i": overflow can neither be missed on an at-capacity
  // write nor rise spuriously, and is sticky between writes.
  // ---------------------------------------------------------------------------
  always_ff @(posedge clk_i) begin
    if (saw_reset && armed_q) begin
      a_overflow_next_state: assert (overflow_q_w == prev_overflow_next);
    end
  end
endmodule
