// -----------------------------------------------------------------------------
// Cocotb testbench wrapper: droop_sensor + clock_stretcher
//
// Exposes the two clocks (clk_sample, ro_clk, clk_in) and the contract pins
// so cocotb can stimulate them directly.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module droop_stretch_tb
    import power_pkg::*;
(
    input  logic                              clk_sample,
    input  logic                              ro_clk,
    input  logic                              clk_in,
    input  logic                              rst_n,
    input  logic                              sample_tick_i,
    input  logic [DROOP_COUNTER_WIDTH-1:0]    threshold_i,
    input  logic                              enable_i,
    input  logic [CLKSTRETCH_SELECT_WIDTH-1:0] phase_select_i,

    output logic                              droop_alarm,
    output logic [DROOP_COUNTER_WIDTH-1:0]    last_count,
    output logic [31:0]                       droop_event_count,
    output logic                              clk_stretched,
    output logic                              stretch_pulse,
    output logic [31:0]                       stretch_event_count
);

    droop_sensor #(
        .RO_STAGES       (DROOP_RO_STAGES),
        .COUNTER_WIDTH   (DROOP_COUNTER_WIDTH),
        .CONFIRM_SAMPLES (DROOP_CONFIRM_SAMPLES)
    ) u_droop (
        .clk_sample          (clk_sample),
        .rst_n               (rst_n),
        .sample_tick_i       (sample_tick_i),
        .ro_clk_i            (ro_clk),
        .threshold_i         (threshold_i),
        .enable_i            (enable_i),
        .droop_alarm_o       (droop_alarm),
        .last_count_o        (last_count),
        .droop_event_count_o (droop_event_count)
    );

    clock_stretcher #(
        .PHASE_TAPS     (CLKSTRETCH_PHASE_TAPS),
        .SELECT_WIDTH   (CLKSTRETCH_SELECT_WIDTH),
        .STRETCH_CYCLES (CLKSTRETCH_CYCLES)
    ) u_stretch (
        .clk_in_i              (clk_in),
        .rst_n                 (rst_n),
        .enable_i              (enable_i),
        .droop_alarm_i         (droop_alarm),
        .phase_select_i        (phase_select_i),
        .clk_o                 (clk_stretched),
        .stretch_o             (stretch_pulse),
        .stretch_event_count_o (stretch_event_count)
    );

endmodule : droop_stretch_tb
