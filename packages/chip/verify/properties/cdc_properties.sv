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

    logic req_active;
    logic ack_waiting;
    logic [$clog2(MAX_HANDSHAKE_CYCLES + 1)-1:0] ack_wait_count;

    always_ff @(posedge clk_dst) begin
        if (!rst_n_dst) begin
            req_active <= 1'b0;
            ack_waiting <= 1'b0;
            ack_wait_count <= '0;
        end else begin
            if (req_sync && !req_active) begin
                req_active <= 1'b1;
            end else if (ack) begin
                req_active <= 1'b0;
            end

            if (req_active && !ack) begin
                assert (req_sync);
            end

            if (ack && req_sync) begin
                ack_waiting <= 1'b1;
                ack_wait_count <= '0;
            end else if (!req_sync) begin
                ack_waiting <= 1'b0;
                ack_wait_count <= '0;
            end else if (ack_waiting && ack_wait_count < MAX_HANDSHAKE_CYCLES) begin
                ack_wait_count <= ack_wait_count + 1'b1;
            end

            if (ack_waiting) begin
                assert (ack_wait_count < MAX_HANDSHAKE_CYCLES);
            end
        end
    end

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

    logic [BUS_W-1:0] observed_bus_q;
    logic [BUS_W-1:0] observed_delta;
    logic observed_bus_q_valid;
    integer bit_index;
    integer changed_bits;

    always_comb begin
        observed_delta = observed_bus ^ observed_bus_q;
        changed_bits = 0;
        for (bit_index = 0; bit_index < BUS_W; bit_index = bit_index + 1) begin
            changed_bits = changed_bits + observed_delta[bit_index];
        end
    end

    always_ff @(posedge clk_dst) begin
        if (!rst_n_dst) begin
            observed_bus_q <= '0;
            observed_bus_q_valid <= 1'b0;
        end else begin
            if (observed_bus_q_valid) begin
                assert (changed_bits <= 1);
            end
            observed_bus_q <= observed_bus;
            observed_bus_q_valid <= 1'b1;
        end
    end

endmodule

`default_nettype wire

`endif // E1_CDC_PROPS_SV
