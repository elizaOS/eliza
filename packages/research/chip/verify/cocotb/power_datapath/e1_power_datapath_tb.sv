`timescale 1ns/1ps

// e1_power_datapath_tb
//
// Smoke wrapper for the adaptive-clocking/AVFS/dLDO power datapath integration.
// Instantiates e1_power_datapath exactly as e1_soc_integrated does, driving the
// analog-boundary inputs (RO clock, canary margins, Vout sample) so the closed
// loop runs and its telemetry (the same vectors fed to pmc_top) is observable.
//
// AVFS_UPDATE is shortened so the AVFS code adjustment is observable within a
// short cocotb run; the droop and dLDO paths use their native cadence.

module e1_power_datapath_tb
    import power_pkg::*;
#(
    parameter int unsigned RAIL_COUNT = DVFS_RAIL_COUNT
) (
    input  logic clk_sample,
    input  logic rst_n,
    input  logic [RAIL_COUNT-1:0] droop_enable_i,
    input  logic [RAIL_COUNT-1:0] avfs_enable_i,
    input  logic [RAIL_COUNT-1:0] dldo_enable_i,
    input  logic [RAIL_COUNT-1:0] clk_stretch_enable_i,
    input  logic [RAIL_COUNT-1:0] ro_clk_i,
    input  logic [RAIL_COUNT-1:0][AVFS_CANARY_COUNT-1:0] canary_margin_low_i,
    input  logic [RAIL_COUNT-1:0][AVFS_CANARY_COUNT-1:0] canary_margin_high_i,

    output logic [RAIL_COUNT-1:0]                    droop_alarm_o,
    output logic [RAIL_COUNT-1:0][31:0]              droop_event_count_o,
    output logic [RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] avfs_target_code_o,
    output logic [RAIL_COUNT-1:0][31:0]              avfs_lower_count_o,
    output logic [RAIL_COUNT-1:0]                    avfs_fault_o,
    output logic [RAIL_COUNT-1:0]                    stretch_active_o,
    output logic [RAIL_COUNT-1:0]                    dldo_regulating_o
);
    logic [RAIL_COUNT-1:0][DROOP_COUNTER_WIDTH-1:0] threshold;
    logic [RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0]     vout_sample;
    logic [RAIL_COUNT-1:0]                          rail_clk;
    logic [RAIL_COUNT-1:0]                          load_step;
    logic [RAIL_COUNT-1:0][31:0]                    raise_count;
    logic [RAIL_COUNT-1:0]                          stretched_clk;
    logic [RAIL_COUNT-1:0][31:0]                    stretch_event_count;

    genvar r;
    generate
        for (r = 0; r < int'(RAIL_COUNT); r++) begin : gen_in
            assign threshold[r]   = DROOP_COUNTER_WIDTH'(DROOP_DEFAULT_THRESHOLD);
            assign vout_sample[r] = DVFS_CODE_WIDTH'(8'h80);
            assign rail_clk[r]    = clk_sample;
            assign load_step[r]   = 1'b0;
        end
    endgenerate

    /* verilator lint_off UNUSEDSIGNAL */
    logic unused;
    assign unused = ^{raise_count, stretched_clk, stretch_event_count};
    /* verilator lint_on UNUSEDSIGNAL */

    e1_power_datapath #(
        .RAIL_COUNT (RAIL_COUNT),
        .AVFS_UPDATE (4)  // shortened so AVFS lowering is observable in the smoke
    ) u_dut (
        .clk_sample            (clk_sample),
        .rst_n                 (rst_n),
        .droop_enable_i        (droop_enable_i),
        .avfs_enable_i         (avfs_enable_i),
        .dldo_enable_i         (dldo_enable_i),
        .clk_stretch_enable_i  (clk_stretch_enable_i),
        .ro_clk_i              (ro_clk_i),
        .rail_clk_i            (rail_clk),
        .droop_threshold_i     (threshold),
        .canary_margin_low_i   (canary_margin_low_i),
        .canary_margin_high_i  (canary_margin_high_i),
        .vout_sample_i         (vout_sample),
        .load_step_i           (load_step),
        .droop_alarm_o         (droop_alarm_o),
        .droop_event_count_o   (droop_event_count_o),
        .avfs_target_code_o    (avfs_target_code_o),
        .avfs_raise_count_o    (raise_count),
        .avfs_lower_count_o    (avfs_lower_count_o),
        .avfs_fault_o          (avfs_fault_o),
        .stretched_clk_o       (stretched_clk),
        .stretch_active_o      (stretch_active_o),
        .stretch_event_count_o (stretch_event_count),
        .dldo_regulating_o     (dldo_regulating_o)
    );

endmodule : e1_power_datapath_tb
