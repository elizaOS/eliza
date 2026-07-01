`timescale 1ns/1ps

// e1_power_datapath
//
// Adaptive-clocking / AVFS / dLDO power-delivery datapath integration wrapper.
//
// The four power leaf cells (droop_sensor, clock_stretcher, avfs_ctrl, dldo)
// were each unit-verified standalone but never instantiated in any top, so the
// closed droop-detect -> clock-stretch -> AVFS-adjust -> dLDO loop and the PMC
// telemetry ports (rtl/power/pmc_top.sv droop_*_i / avfs_*_i) had no real
// source. This wrapper instantiates one full loop per managed DVFS rail and
// presents the per-rail telemetry vectors that pmc_top consumes, so the PMC
// firmware observes real droop/AVFS state instead of constant zeros.
//
// Per rail (one of DVFS_RAIL_COUNT):
//   droop_sensor   : ring-osc count vs threshold -> droop_alarm + event count
//   clock_stretcher: droop_alarm -> 1-cycle clock stretch (stretched_clk_o)
//   avfs_ctrl      : canary margins -> DVFS target_code + raise/lower/fault
//   dldo           : target_code + Vout sample -> slice count / regulating
//
// sample_tick is generated locally from clk_sample (one pulse every
// SAMPLE_DIV cycles) and shared by every rail's droop_sensor and avfs_ctrl.
//
// This is synthesizable digital RTL. The ring-oscillator clock (ro_clk_i) and
// the dLDO Vout sample (vout_sample_i) are analog-boundary inputs supplied per
// rail; in the digital SoC they are driven from the rail clock taps / ADC
// sample bus. The threshold / canary / Vout calibration values are
// planning-only defaults (see docs/pd/droop-detection.md) until silicon
// characterization, which is recorded as a fail-closed PD dependency.

module e1_power_datapath
    import power_pkg::*;
#(
    parameter int unsigned RAIL_COUNT = DVFS_RAIL_COUNT,
    parameter int unsigned SAMPLE_DIV = 8,  // clk_sample cycles per sample tick
    // AVFS update cadence (sample ticks per DVFS code step). Defaults to the
    // power_pkg silicon value; a smoke/bring-up build may shorten it.
    parameter int unsigned AVFS_UPDATE = AVFS_UPDATE_CYCLES
) (
    input  logic clk_sample,   // 200 MHz droop/AVFS sample reference
    input  logic rst_n,

    // Per-rail enables (MMIO-controllable from the SoC top).
    input  logic [RAIL_COUNT-1:0] droop_enable_i,
    input  logic [RAIL_COUNT-1:0] avfs_enable_i,
    input  logic [RAIL_COUNT-1:0] dldo_enable_i,
    input  logic [RAIL_COUNT-1:0] clk_stretch_enable_i,

    // Per-rail ring-oscillator clocks (rail clock taps) feeding the droop
    // sensors, and the per-rail input clocks to be stretched.
    input  logic [RAIL_COUNT-1:0] ro_clk_i,
    input  logic [RAIL_COUNT-1:0] rail_clk_i,

    // Per-rail droop threshold (PMC-programmed after characterization).
    input  logic [RAIL_COUNT-1:0][DROOP_COUNTER_WIDTH-1:0] droop_threshold_i,

    // Per-rail AVFS canary margins (from canary replica paths).
    input  logic [RAIL_COUNT-1:0][AVFS_CANARY_COUNT-1:0] canary_margin_low_i,
    input  logic [RAIL_COUNT-1:0][AVFS_CANARY_COUNT-1:0] canary_margin_high_i,

    // Per-rail dLDO Vout sample (from the rail ADC) and load-step strobe.
    input  logic [RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] vout_sample_i,
    input  logic [RAIL_COUNT-1:0] load_step_i,

    // ── Telemetry to pmc_top ──────────────────────────────────────────────
    output logic [RAIL_COUNT-1:0]                    droop_alarm_o,
    output logic [RAIL_COUNT-1:0][31:0]              droop_event_count_o,
    output logic [RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] avfs_target_code_o,
    output logic [RAIL_COUNT-1:0][31:0]              avfs_raise_count_o,
    output logic [RAIL_COUNT-1:0][31:0]              avfs_lower_count_o,
    output logic [RAIL_COUNT-1:0]                    avfs_fault_o,

    // ── Observability for SoC MMIO / smoke ────────────────────────────────
    output logic [RAIL_COUNT-1:0] stretched_clk_o,
    output logic [RAIL_COUNT-1:0] stretch_active_o,
    output logic [RAIL_COUNT-1:0][31:0] stretch_event_count_o,
    output logic [RAIL_COUNT-1:0] dldo_regulating_o
);
    // ── Shared sample-tick generator ──────────────────────────────────────
    localparam int unsigned DIV_W = (SAMPLE_DIV <= 1) ? 1 : $clog2(SAMPLE_DIV);
    logic [DIV_W-1:0] tick_div_q;
    logic             sample_tick;

    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            tick_div_q <= '0;
        end else if (tick_div_q == DIV_W'(SAMPLE_DIV - 1)) begin
            tick_div_q <= '0;
        end else begin
            tick_div_q <= tick_div_q + DIV_W'(1);
        end
    end
    assign sample_tick = (tick_div_q == DIV_W'(SAMPLE_DIV - 1));

    // ── Per-rail closed loop ──────────────────────────────────────────────
    genvar r;
    generate
        for (r = 0; r < int'(RAIL_COUNT); r++) begin : gen_rail
            logic                        rail_droop_alarm;
            logic [DVFS_CODE_WIDTH-1:0]  rail_target_code;
            /* verilator lint_off UNUSEDSIGNAL */
            logic                        rail_target_update;
            logic [DROOP_COUNTER_WIDTH-1:0] rail_last_count;
            logic [$clog2(DLDO_SLICE_COUNT+1)-1:0] rail_slice_count;
            logic [DVFS_CODE_WIDTH-1:0]  rail_v_estimate;
            /* verilator lint_on UNUSEDSIGNAL */

            droop_sensor u_droop (
                .clk_sample          (clk_sample),
                .rst_n               (rst_n),
                .sample_tick_i       (sample_tick),
                .ro_clk_i            (ro_clk_i[r]),
                .threshold_i         (droop_threshold_i[r]),
                .enable_i            (droop_enable_i[r]),
                .droop_alarm_o       (rail_droop_alarm),
                .last_count_o        (rail_last_count),
                .droop_event_count_o (droop_event_count_o[r])
            );
            assign droop_alarm_o[r] = rail_droop_alarm;

            clock_stretcher u_stretch (
                .clk_in_i               (rail_clk_i[r]),
                .rst_n                  (rst_n),
                .enable_i               (clk_stretch_enable_i[r]),
                .droop_alarm_i          (rail_droop_alarm),
                .phase_select_i         ('0),
                .clk_o                  (stretched_clk_o[r]),
                .stretch_o              (stretch_active_o[r]),
                .stretch_event_count_o  (stretch_event_count_o[r])
            );

            avfs_ctrl #(
                .UPDATE_CYCLES (AVFS_UPDATE)
            ) u_avfs (
                .clk_sample            (clk_sample),
                .rst_n                 (rst_n),
                .enable_i              (avfs_enable_i[r]),
                .sample_tick_i         (sample_tick),
                .canary_margin_low_i   (canary_margin_low_i[r]),
                .canary_margin_high_i  (canary_margin_high_i[r]),
                .min_code_i            (DVFS_CODE_WIDTH'(8'h20)),
                .max_code_i            (DVFS_CODE_WIDTH'(8'hC0)),
                .init_code_i           (DVFS_CODE_WIDTH'(8'h80)),
                .target_code_o         (rail_target_code),
                .target_update_pulse_o (rail_target_update),
                .raise_event_count_o   (avfs_raise_count_o[r]),
                .lower_event_count_o   (avfs_lower_count_o[r]),
                .fault_o               (avfs_fault_o[r])
            );
            assign avfs_target_code_o[r] = rail_target_code;

            dldo u_dldo (
                .clk            (clk_sample),
                .rst_n          (rst_n),
                .enable_i       (dldo_enable_i[r]),
                .target_code_i  (rail_target_code),
                .vout_sample_i  (vout_sample_i[r]),
                .load_step_i    (load_step_i[r]),
                .slice_count_o  (rail_slice_count),
                .v_estimate_o   (rail_v_estimate),
                .regulating_o   (dldo_regulating_o[r])
            );
        end
    endgenerate

endmodule : e1_power_datapath
