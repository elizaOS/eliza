// -----------------------------------------------------------------------------
// Eliza E1 — power management shared parameters
//
// Shared widths, register-map offsets, and DVFS step granularity used by:
//   - rtl/power/droop_sensor.sv
//   - rtl/power/clock_stretcher.sv
//   - rtl/power/dldo.sv
//   - rtl/power/avfs_ctrl.sv
//   - rtl/power/pmc_top.sv
//
// All numeric targets cross-reference docs/pd/rail-plan-2028.yaml and
// docs/architecture-optimization/sota-2028/power-delivery.md.
// -----------------------------------------------------------------------------
`ifndef ELIZA_POWER_PKG_SV
`define ELIZA_POWER_PKG_SV

package power_pkg;

    // ---- DVFS granularity --------------------------------------------------
    // 6.25 mV per LSB; 8-bit code spans 0 .. 1.6 V.
    parameter int unsigned DVFS_CODE_WIDTH = 8;
    parameter int unsigned DVFS_STEP_UV    = 6250;   // 6.25 mV

    // Encoded DVFS reference for each managed rail (subset that supports DVFS).
    parameter int unsigned DVFS_RAIL_COUNT = 6;
    typedef enum logic [2:0] {
        DVFS_RAIL_CPU_BIG    = 3'd0,
        DVFS_RAIL_CPU_LITTLE = 3'd1,
        DVFS_RAIL_NPU        = 3'd2,
        DVFS_RAIL_GPU        = 3'd3,
        DVFS_RAIL_SOC_FABRIC = 3'd4,
        DVFS_RAIL_SRAM       = 3'd5
    } dvfs_rail_e;

    // ---- Droop sensor ------------------------------------------------------
    // Ring oscillator: NUM_STAGES inverter delay chain;
    // ALARM asserts when measured period exceeds threshold for two consecutive
    // 200 MHz sample windows.
    parameter int unsigned DROOP_RO_STAGES         = 31;
    parameter int unsigned DROOP_COUNTER_WIDTH     = 16;
    parameter int unsigned DROOP_SAMPLE_HZ         = 200_000_000;
    parameter int unsigned DROOP_DEFAULT_THRESHOLD = 16'd2048;
    parameter int unsigned DROOP_CONFIRM_SAMPLES   = 2;

    // ---- Clock stretcher ---------------------------------------------------
    // Phase blender: 16 taps -> 4-bit phase select. STRETCH_CYCLES is the
    // number of stretched cycles inserted per droop alarm pulse.
    parameter int unsigned CLKSTRETCH_PHASE_TAPS   = 16;
    parameter int unsigned CLKSTRETCH_SELECT_WIDTH = 4;
    parameter int unsigned CLKSTRETCH_CYCLES       = 1;

    // ---- dLDO -------------------------------------------------------------
    // Distributed digital LDO: 32 power-gate slices.
    // Behavioral model only — full step recovers in <= DLDO_RESPONSE_NS ns.
    parameter int unsigned DLDO_SLICE_COUNT   = 32;
    parameter int unsigned DLDO_RESPONSE_NS   = 20;
    parameter int unsigned DLDO_DROP_PCT_X100 = 500;  // 5.00% in units of 0.01%

    // ---- AVFS controller --------------------------------------------------
    // 100 us update period at 200 MHz reference => 20_000 cycles per update.
    parameter int unsigned AVFS_UPDATE_CYCLES = 32'd20_000;
    parameter int unsigned AVFS_CANARY_COUNT  = 16;

    // ---- PMC mailbox register map (PMC_TOP, RPMI v1.0 envelope) -----------
    // 4 KiB AHB-Lite window at SoC-defined base. Offsets are stable contract.
    parameter int unsigned PMC_MBOX_AW = 12;
    parameter int unsigned PMC_MBOX_DW = 32;

    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_MBOX_TX_HEAD = 12'h000;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_MBOX_TX_DATA = 12'h004;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_MBOX_RX_HEAD = 12'h008;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_MBOX_RX_DATA = 12'h00C;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_STATUS       = 12'h010;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_CTRL         = 12'h014;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_DROOP_COUNT  = 12'h020;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_AVFS_STATUS  = 12'h024;
    // Sticky aggregated droop-event count. Reads return the latched count
    // accumulated since last clear. Write a bitmask of '1' bits to clear the
    // corresponding bits (write-1-to-clear). A full clear is `0xFFFFFFFF`.
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_DROOP_STICKY = 12'h028;
    parameter logic [PMC_MBOX_AW-1:0] PMC_REG_DVFS_BASE    = 12'h040;  // 6 rails x 4 B

    // PMC status bits
    parameter int unsigned PMC_STATUS_TX_FULL  = 0;
    parameter int unsigned PMC_STATUS_RX_VALID = 1;
    parameter int unsigned PMC_STATUS_BUSY     = 2;
    parameter int unsigned PMC_STATUS_FAULT    = 3;

endpackage : power_pkg

`endif // ELIZA_POWER_PKG_SV
