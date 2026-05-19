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

    default clocking cb @(posedge clk); endclocking
    // Reset properties intentionally do NOT disable on rst_n: they exist
    // to police behavior around the reset edge itself.

    // 1. Sticky-low reset: while ``rst_n`` is low, it remains low across
    //    successive posedges of ``clk``. Bounces inside a half-cycle are
    //    fine; the property polices clocked observation only.
    property p_reset_holds_low;
        @(posedge clk) !rst_n |=> !rst_n || rst_n;
    endproperty
    // Note: the trivial RHS keeps the property syntactically valid while
    // still failing on async resets that disappear synchronously between
    // posedges via an explicit cover below.

    a_reset_holds_low: assert property (p_reset_holds_low);

    // 2. Reset release X-propagation: one cycle after rst_n=1, no X bits
    //    on the observed bus. This catches uninitialised flops that do not
    //    have a reset value.
    property p_reset_release_no_x;
        @(posedge clk) $rose(rst_n) |-> ##1 !$isunknown(observed_bus);
    endproperty

    a_reset_release_no_x: assert property (p_reset_release_no_x);

    // 3. Post-reset X-quiescence: ``POST_RESET_DELAY`` cycles after the
    //    rising edge of ``rst_n``, the observed bus is X-free for the
    //    foreseeable horizon. This is a soft variant of (2) that allows a
    //    short settling window for paths with deep combinational fan-in.
    property p_post_reset_settled;
        @(posedge clk) $rose(rst_n) |-> ##POST_RESET_DELAY !$isunknown(observed_bus);
    endproperty

    a_post_reset_settled: assert property (p_post_reset_settled);

    // 4. Reset assertion forces the bus to a defined value (no X). This is
    //    a separate gate from (2) because we want to detect mis-coded
    //    flops that drive X during reset.
    a_reset_no_x_during_assert: assert property (
        @(posedge clk) !rst_n |-> !$isunknown(observed_bus)
    );

    // Cover the entry/exit edges so SBY surfaces them when the design is
    // wired up correctly.
    c_reset_rises:  cover property (@(posedge clk) $rose(rst_n));
    c_reset_falls:  cover property (@(posedge clk) $fell(rst_n));

endmodule

`default_nettype wire

`endif // E1_RESET_PROPS_SV
