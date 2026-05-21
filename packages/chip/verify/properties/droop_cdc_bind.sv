// SPDX-License-Identifier: Apache-2.0
//
// Structural top that drives `droop_sensor` and binds the reusable CDC
// property pack (`cdc_properties.sv`) to the one real cross-clock path in the
// power domain: the ring-oscillator capture (`ro_clk_i`) brought back into the
// sample-clock (`clk_sample`) domain through the `ack_sync_q` two-flop
// synchroniser. The Hamming-1 invariant in `cdc_sync_no_glitch_props` policed
// against `ack_sync_q[1]` proves the synchroniser output never glitches by more
// than one bit per destination clock.
//
// Claim boundary: intent_manifest_only_not_cdc_rdc_signoff. This is a bounded
// formal anchor on the synchroniser invariant, not a full CDC signoff.

`default_nettype none

module droop_cdc_props_top
    import power_pkg::*;
(
    input  logic                     clk_sample,
    input  logic                     ro_clk_i,
    input  logic                     rst_n,
    input  logic                     sample_tick_i,
    input  logic                     enable_i,
    input  logic [DROOP_COUNTER_WIDTH-1:0] threshold_i
);

    logic                            droop_alarm_o;
    logic [DROOP_COUNTER_WIDTH-1:0]  last_count_o;
    logic [31:0]                     droop_event_count_o;

    droop_sensor u_dut (
        .clk_sample          (clk_sample),
        .rst_n               (rst_n),
        .sample_tick_i       (sample_tick_i),
        .ro_clk_i            (ro_clk_i),
        .threshold_i         (threshold_i),
        .enable_i            (enable_i),
        .droop_alarm_o       (droop_alarm_o),
        .last_count_o        (last_count_o),
        .droop_event_count_o (droop_event_count_o)
    );

    // The two-flop synchroniser output in the sample-clock domain. Its second
    // stage must never change by more than one bit per `clk_sample` edge.
    bind droop_sensor cdc_sync_no_glitch_props #(
        .BUS_W (1)
    ) u_ack_sync_no_glitch (
        .clk_dst      (clk_sample),
        .rst_n_dst    (rst_n),
        .observed_bus (ack_sync_q[1])
    );

endmodule

`default_nettype wire
