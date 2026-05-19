// -----------------------------------------------------------------------------
// Eliza E1 — Power Management Core (PMC) top
//
// AON-resident wrapper for the Ibex RV32IMC management core. This module
// exposes:
//   - 4 KiB AHB-Lite-equivalent mailbox window for the S-mode Linux/SBI
//     stack (PMC_REG_* offsets in rtl/power/power_pkg.sv).
//   - External PMIC interface stubs (SPMI v2 master + I2C-FM-plus fallback).
//   - Droop / AVFS telemetry from the six DVFS-managed rails.
//
// The Ibex core itself is pinned via the BSP manifest; do NOT vendor sources.
// This wrapper instantiates a "u_ibex_pmc" symbolic black-box: actual binding
// resolves at integration in rtl/top/. See docs/pd/power-management-firmware.md
// and external manifest entry "ibex_pmc" for the pinned upstream tag.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module pmc_top
    import power_pkg::*;
(
    input  logic        clk_aon,                // AON clock (32 kHz ref divided to PMC PLL)
    input  logic        clk_sample,             // 200 MHz sample reference
    input  logic        rst_n,

    // S-mode mailbox interface (AHB-Lite-equivalent slave to SoC fabric)
    input  logic                          mbox_valid_i,
    input  logic                          mbox_write_i,
    input  logic [PMC_MBOX_AW-1:0]        mbox_addr_i,
    input  logic [PMC_MBOX_DW-1:0]        mbox_wdata_i,
    output logic [PMC_MBOX_DW-1:0]        mbox_rdata_o,
    output logic                          mbox_ready_o,

    // PMIC SPMI v2 master pins (open-drain, requires foundry IO cell)
    output logic        spmi_sclk_o,
    inout  wire         spmi_sdata_io,
    output logic        spmi_enable_o,

    // I2C-FM-plus fallback
    inout  wire         i2c_scl_io,
    inout  wire         i2c_sda_io,

    // Droop / AVFS telemetry inputs (per DVFS rail)
    input  logic [DVFS_RAIL_COUNT-1:0]                droop_alarm_i,
    input  logic [DVFS_RAIL_COUNT-1:0][31:0]          droop_event_count_i,
    input  logic [DVFS_RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] avfs_target_code_i,
    input  logic [DVFS_RAIL_COUNT-1:0][31:0]          avfs_raise_count_i,
    input  logic [DVFS_RAIL_COUNT-1:0][31:0]          avfs_lower_count_i,
    input  logic [DVFS_RAIL_COUNT-1:0]                avfs_fault_i,

    // Outbound DVFS request per rail
    output logic [DVFS_RAIL_COUNT-1:0][DVFS_CODE_WIDTH-1:0] dvfs_request_code_o,
    output logic [DVFS_RAIL_COUNT-1:0]                dvfs_request_valid_o,

    // PMIC enable lines (one per off-chip regulator; pin at integration)
    output logic [15:0] pmic_enable_o,

    // Wake / IRQ to AP
    output logic        wake_irq_o,
    output logic        thermal_irq_o
);

    // -------------------------------------------------------------------------
    // Mailbox register bank
    // -------------------------------------------------------------------------
    logic [PMC_MBOX_DW-1:0] reg_status_q;
    logic [PMC_MBOX_DW-1:0] reg_ctrl_q;
    logic [PMC_MBOX_DW-1:0] reg_dvfs_q [DVFS_RAIL_COUNT];

    // Aggregate droop telemetry
    logic [31:0] droop_total_q;
    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            droop_total_q <= 32'h0;
        end else begin
            droop_total_q <= droop_event_count_i[0]
                          + droop_event_count_i[1]
                          + droop_event_count_i[2]
                          + droop_event_count_i[3]
                          + droop_event_count_i[4]
                          + droop_event_count_i[5];
        end
    end

    // Aggregate AVFS fault
    logic any_avfs_fault;
    assign any_avfs_fault = |avfs_fault_i;

    // Status register composition
    always_ff @(posedge clk_aon or negedge rst_n) begin
        if (!rst_n) begin
            reg_status_q <= '0;
        end else begin
            reg_status_q                                <= '0;
            reg_status_q[PMC_STATUS_BUSY]               <= 1'b0;
            reg_status_q[PMC_STATUS_FAULT]              <= any_avfs_fault;
            reg_status_q[PMC_STATUS_TX_FULL]            <= 1'b0;
            reg_status_q[PMC_STATUS_RX_VALID]           <= 1'b0;
        end
    end

    // Mailbox read/write decode. Read path is registered to clk_aon.
    logic [PMC_MBOX_DW-1:0] rdata_q;
    always_ff @(posedge clk_aon or negedge rst_n) begin
        if (!rst_n) begin
            rdata_q     <= '0;
            reg_ctrl_q  <= '0;
            for (int i = 0; i < DVFS_RAIL_COUNT; i++) begin
                reg_dvfs_q[i] <= '0;
            end
        end else if (mbox_valid_i) begin
            if (mbox_write_i) begin
                case (mbox_addr_i)
                    PMC_REG_CTRL: reg_ctrl_q <= mbox_wdata_i;
                    default: begin
                        for (int i = 0; i < DVFS_RAIL_COUNT; i++) begin
                            if (mbox_addr_i == (PMC_REG_DVFS_BASE +
                                                PMC_MBOX_AW'(i * 4))) begin
                                reg_dvfs_q[i] <= mbox_wdata_i;
                            end
                        end
                    end
                endcase
            end else begin
                case (mbox_addr_i)
                    PMC_REG_STATUS:      rdata_q <= reg_status_q;
                    PMC_REG_CTRL:        rdata_q <= reg_ctrl_q;
                    PMC_REG_DROOP_COUNT: rdata_q <= droop_total_q;
                    PMC_REG_AVFS_STATUS: rdata_q <= {28'h0, avfs_fault_i};
                    default: begin
                        rdata_q <= '0;
                        for (int i = 0; i < DVFS_RAIL_COUNT; i++) begin
                            if (mbox_addr_i == (PMC_REG_DVFS_BASE +
                                                PMC_MBOX_AW'(i * 4))) begin
                                rdata_q <= reg_dvfs_q[i];
                            end
                        end
                    end
                endcase
            end
        end
    end

    assign mbox_rdata_o = rdata_q;
    assign mbox_ready_o = mbox_valid_i;

    // DVFS request fan-out from mailbox writes
    for (genvar g = 0; g < DVFS_RAIL_COUNT; g++) begin : gen_dvfs_out
        assign dvfs_request_code_o[g]  = reg_dvfs_q[g][DVFS_CODE_WIDTH-1:0];
        assign dvfs_request_valid_o[g] = reg_dvfs_q[g][31];
    end

    // -------------------------------------------------------------------------
    // PMIC interfaces — tied off here; real drivers run on Ibex firmware.
    // -------------------------------------------------------------------------
    assign spmi_sclk_o   = 1'b0;
    assign spmi_enable_o = reg_ctrl_q[0];
    assign pmic_enable_o = reg_ctrl_q[31:16];

    // Open-drain inout stubs: PMC firmware drives via bit-bang / SPMI master.
    /* verilator lint_off UNUSED */
    wire _unused_io = spmi_sdata_io ^ i2c_scl_io ^ i2c_sda_io;
    /* verilator lint_on UNUSED */

    // Wake / thermal IRQ outputs
    assign wake_irq_o    = reg_ctrl_q[1];
    assign thermal_irq_o = any_avfs_fault;

    // -------------------------------------------------------------------------
    // Ibex management core — black-box reference; resolved at integration.
    // -------------------------------------------------------------------------
`ifdef PMC_INSTANTIATE_IBEX
    ibex_top u_ibex_pmc (
        .clk_i        (clk_aon),
        .rst_ni       (rst_n)
        // remaining pins bound at integration
    );
`endif

    // Suppress unused on clk_sample / avfs_target_code_i / counters — exposed
    // via additional mailbox offsets in fw/pmc telemetry aggregator.
    /* verilator lint_off UNUSED */
    wire _unused_sample = clk_sample;
    wire _unused_avfs_t = |avfs_target_code_i[0];
    wire _unused_avfs_r = |avfs_raise_count_i[0];
    wire _unused_avfs_l = |avfs_lower_count_i[0];
    wire _unused_droop  = |droop_alarm_i;
    /* verilator lint_on UNUSED */

endmodule : pmc_top
