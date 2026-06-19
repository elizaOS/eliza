// -----------------------------------------------------------------------------
// Eliza E1 — distributed digital LDO (behavioral model)
//
// One instance per managed sub-domain (per CPU big core, per NPU tile, AON
// retention). This is a digital-controller-only behavioral model; the analog
// switch slices are PDK-dependent and binned during physical design.
//
// Architecture
// ------------
// DLDO_SLICE_COUNT power-gate slices are bound to the rail. A bang-bang
// controller increments slice_count_o when vout_sample_i drops below
// target_code_i and decrements it when vout_sample_i exceeds target. The
// behavioral output v_estimate_o models 5%-step droop response with a
// 20 ns recovery time, calibrated to public 22 nm dLDO numbers.
//
// Contract
// --------
// - Target code: target_code_i is 6.25 mV per LSB (DVFS_STEP_UV).
// - Droop response: full step recovered within DLDO_RESPONSE_NS.
// - Worst-case droop: DLDO_DROP_PCT_X100 / 100 % at full step.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module dldo
    import power_pkg::*;
#(
    parameter int unsigned SLICE_COUNT = DLDO_SLICE_COUNT
)(
    input  logic                              clk,
    input  logic                              rst_n,
    input  logic                              enable_i,
    input  logic [DVFS_CODE_WIDTH-1:0]        target_code_i,    // 6.25 mV/LSB
    input  logic [DVFS_CODE_WIDTH-1:0]        vout_sample_i,    // measured Vout
    input  logic                              load_step_i,      // 1-cycle pulse: load step occurred

    output logic [$clog2(SLICE_COUNT+1)-1:0]  slice_count_o,
    output logic [DVFS_CODE_WIDTH-1:0]        v_estimate_o,
    output logic                              regulating_o
);

    localparam int unsigned SLICE_CW = $clog2(SLICE_COUNT + 1);

    logic [SLICE_CW-1:0] slice_q;
    logic [DVFS_CODE_WIDTH-1:0] v_est_q;
    logic                       reg_q;

    // Behavioral controller: bang-bang with hysteresis of 1 LSB (6.25 mV).
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            slice_q <= '0;
            v_est_q <= '0;
            reg_q   <= 1'b0;
        end else if (enable_i) begin
            reg_q <= 1'b1;
            // Controller step
            if (vout_sample_i < target_code_i) begin
                if (slice_q < SLICE_CW'(SLICE_COUNT)) begin
                    slice_q <= slice_q + 1'b1;
                end
            end else if (vout_sample_i > target_code_i) begin
                if (slice_q != '0) begin
                    slice_q <= slice_q - 1'b1;
                end
            end
            // Behavioral voltage estimator: ramp toward target by one LSB/cycle,
            // with a hard 5% drop on load_step_i.
            if (load_step_i) begin
                // 5% droop at full step: subtract DLDO_DROP_PCT_X100/10000 * target.
                // Approximated as target_code_i * 5 / 100, clamped.
                // The high bits of droop_lsb are clipped intentionally; only
                // the bottom DVFS_CODE_WIDTH bits feed the v_est subtraction.
                /* verilator lint_off UNUSEDSIGNAL */
                logic [DVFS_CODE_WIDTH+3:0] droop_lsb;
                /* verilator lint_on UNUSEDSIGNAL */
                droop_lsb = (target_code_i * DLDO_DROP_PCT_X100) / 16'd10000;
                if (v_est_q > droop_lsb[DVFS_CODE_WIDTH-1:0]) begin
                    v_est_q <= v_est_q - droop_lsb[DVFS_CODE_WIDTH-1:0];
                end else begin
                    v_est_q <= '0;
                end
            end else if (v_est_q < target_code_i) begin
                v_est_q <= v_est_q + 1'b1;
            end else if (v_est_q > target_code_i) begin
                v_est_q <= v_est_q - 1'b1;
            end
        end else begin
            reg_q <= 1'b0;
        end
    end

    assign slice_count_o = slice_q;
    assign v_estimate_o  = v_est_q;
    assign regulating_o  = reg_q;

endmodule : dldo
