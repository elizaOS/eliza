// SPDX-License-Identifier: Apache-2.0
//
// Structural top that drives `e1_reset_sync` and binds the reusable reset
// property pack (`reset_properties.sv`) to it. The bound `reset_props` instance
// observes the synchroniser output `rst_n_sync` and enforces that, around the
// reset edge, the output is never X (reset-release X-propagation and post-reset
// X-quiescence) and that the entry/exit reset edges are covered.
//
// Claim boundary: intent_manifest_only_not_cdc_rdc_signoff. This is a bounded
// reset-behaviour anchor on the synchroniser, not a full RDC signoff.

`default_nettype none

module reset_sync_props_top (
    input  logic clk,
    input  logic rst_n_async
);

    logic rst_n_sync;

    e1_reset_sync u_dut (
        .clk         (clk),
        .rst_n_async (rst_n_async),
        .rst_n_sync  (rst_n_sync)
    );

    // Police reset behaviour on the synchroniser output bus. The reset of the
    // property pack itself is the asynchronous input so the properties observe
    // the same reset edge the DUT sees.
    bind e1_reset_sync reset_props #(
        .BUS_W            (3),
        .POST_RESET_DELAY (2)
    ) u_reset_props (
        .clk          (clk),
        .rst_n        (rst_n_async),
        .observed_bus ({sync_q, rst_n_sync})
    );

endmodule

`default_nettype wire
