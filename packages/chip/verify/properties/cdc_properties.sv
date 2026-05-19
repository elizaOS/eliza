// SPDX-License-Identifier: Apache-2.0
//
// Reusable clock-domain-crossing (CDC) handshake property pack.
//
// Scope: the bulk of the e1 SoC RTL is single-clock — every block lives in
// the ``clk`` / ``rst_n`` domain. Two crossings exist today and live in
// ``rtl/power/``:
//
//   * ``rtl/power/droop_sensor.sv`` — ring-oscillator ``ro_clk_i`` sampled
//     into the ``clk_sample`` domain.
//   * ``rtl/power/avfs_ctrl.sv``    — ``clk_sample`` domain consuming the
//     droop sensor output and producing AVFS knobs into the ``clk`` domain.
//
// This property pack expresses the canonical two-flop synchroniser
// invariant plus a four-phase handshake invariant for request / ack pairs:
//
//   1. ``p_sync_stable``  — once a request is sampled by the receiver, it
//                            stays stable until the receiver asserts ack.
//   2. ``p_ack_settles``  — once ack is asserted, the source must
//                            eventually drop its request; this is the
//                            liveness half of the handshake.
//   3. ``p_no_glitch``    — the synchronised request, observed in the
//                            destination domain, can change by at most one
//                            bit per destination clock (Hamming-1).
//
// If the bound RTL is single-clock, the file documents the absence of
// cross-clock paths so the formal flow still has a deterministic anchor.

`ifndef E1_CDC_PROPS_SV
`define E1_CDC_PROPS_SV

`default_nettype none

module cdc_handshake_props #(
    parameter int unsigned MAX_HANDSHAKE_CYCLES = 64
) (
    input  logic clk_dst,
    input  logic rst_n_dst,
    input  logic req_sync,   // request after the two-flop synchroniser
    input  logic ack
);

    default clocking cb @(posedge clk_dst); endclocking
    default disable iff (!rst_n_dst);

    // 1. Synchronised request must be stable until ack.
    property p_sync_stable;
        $rose(req_sync) |-> req_sync until_with ack;
    endproperty

    a_sync_stable: assert property (p_sync_stable);

    // 2. ack must eventually retire the request within the bounded window.
    property p_ack_settles;
        ack |-> ##[0:MAX_HANDSHAKE_CYCLES] !req_sync;
    endproperty

    a_ack_settles: assert property (p_ack_settles);

endmodule

// Two-flop synchroniser invariant. The internal stage must not change by
// more than one bit per destination clock so the receiver never sees an
// invalid intermediate code when a multi-bit signal is mistakenly crossed
// without a request / ack handshake.
module cdc_sync_no_glitch_props #(
    parameter int unsigned BUS_W = 1
) (
    input  logic              clk_dst,
    input  logic              rst_n_dst,
    input  logic [BUS_W-1:0]  observed_bus
);

    default clocking cb @(posedge clk_dst); endclocking
    default disable iff (!rst_n_dst);

    function automatic int unsigned popcount(input logic [BUS_W-1:0] value);
        int unsigned count;
        count = 0;
        for (int i = 0; i < BUS_W; i++) begin
            count += value[i];
        end
        return count;
    endfunction

    a_hamming1: assert property (
        @(posedge clk_dst) disable iff (!rst_n_dst)
        popcount(observed_bus ^ $past(observed_bus)) <= 1
    );

endmodule

`default_nettype wire

`endif // E1_CDC_PROPS_SV
