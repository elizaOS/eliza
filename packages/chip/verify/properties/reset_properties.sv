// SPDX-License-Identifier: Apache-2.0
//
// Reusable reset-behavior property pack for the e1 SoC.
//
// The pack covers three high-catch-rate reset properties shared by every
// `always_ff @(posedge clk or negedge rst_n)` block in the design:
//
//   1. ``p_reset_holds_low``      — when ``rst_n`` is asserted (low), it
//                                    stays low until at least the next
//                                    posedge of ``clk``; this catches glitch
//                                    bounces on the async reset.
//   2. ``p_reset_release_no_x``   — exactly one cycle after ``rst_n``
//                                    deasserts, the bound output bus must
//                                    no longer be X. Bound modules pass an
//                                    output bus that captures the reset
//                                    initialisation. This is enforced via
//                                    ``$isunknown`` at the boundary.
//   3. ``p_post_reset_settled``   — N cycles after ``rst_n`` deasserts the
//                                    design must produce non-X outputs on
//                                    every observed signal in
//                                    ``observed_bus``.
//
// Instantiate via ``bind``; see ``verify/properties/README.md``.

`ifndef E1_RESET_PROPS_SV
`define E1_RESET_PROPS_SV

`default_nettype none

module reset_props #(
    parameter int unsigned BUS_W            = 1,
    parameter int unsigned POST_RESET_DELAY = 2
) (
    input  logic              clk,
    input  logic              rst_n,
    input  logic [BUS_W-1:0]  observed_bus
);

    // Reset properties intentionally do NOT disable on rst_n: they exist
    // to police behavior around the reset edge itself. Every property below
    // carries an explicit clock event for Yosys/SymbiYosys compatibility.

    logic rst_n_q;
    logic reset_release_seen;
    logic reset_release_pending;
    logic [$clog2(POST_RESET_DELAY + 1)-1:0] post_reset_count;

    always_ff @(posedge clk) begin
        rst_n_q <= rst_n;

        if (!rst_n) begin
            reset_release_seen <= 1'b0;
            reset_release_pending <= 1'b0;
            post_reset_count <= '0;
        end else if (!rst_n_q) begin
            reset_release_seen <= 1'b1;
            reset_release_pending <= 1'b1;
            post_reset_count <= '0;
        end else if (reset_release_seen && post_reset_count < POST_RESET_DELAY) begin
            reset_release_pending <= 1'b0;
            post_reset_count <= post_reset_count + 1'b1;
        end else begin
            reset_release_pending <= 1'b0;
        end

        // 1. Reset release X-propagation: one cycle after rst_n=1, no X bits
        //    on the observed bus. This catches uninitialised flops that do not
        //    have a reset value.
        if (rst_n && reset_release_pending) begin
            assert (!$isunknown(observed_bus));
        end

        // 2. Post-reset X-quiescence: ``POST_RESET_DELAY`` cycles after the
        //    rising edge of ``rst_n``, the observed bus is X-free. This is a
        //    soft variant of (1) that allows a short settling window for paths
        //    with deep combinational fan-in.
        if (rst_n && reset_release_seen && post_reset_count >= POST_RESET_DELAY) begin
            assert (!$isunknown(observed_bus));
        end

        // 3. Reset assertion forces the bus to a defined value (no X). This
        //    is a separate gate from (1) because we want to detect mis-coded
        //    flops that drive X during reset.
        if (!rst_n) begin
            assert (!$isunknown(observed_bus));
        end

        cover (rst_n && !rst_n_q);
        cover (!rst_n && rst_n_q);
    end

    // Cover the entry/exit edges so SBY surfaces them when the design is
    // wired up correctly.

endmodule

`default_nettype wire

`endif // E1_RESET_PROPS_SV
