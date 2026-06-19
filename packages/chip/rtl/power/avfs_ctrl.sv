// -----------------------------------------------------------------------------
// Eliza E1 — Adaptive Voltage / Frequency Scaling (AVFS) controller
//
// One instance per DVFS-managed rail (CPU_BIG, CPU_LITTLE, NPU, GPU,
// SOC_FABRIC, SRAM). Closed-loop voltage tuning driven by in-situ timing
// margin monitors (canary FFs). 100 us update period, 6.25 mV voltage delta.
//
// Architecture
// ------------
// AVFS_CANARY_COUNT replicas of a critical-path FF report their margin every
// AVFS_UPDATE_CYCLES sample cycles. If any canary reports "margin lost"
// (canary_margin_low_i) the controller raises target_code_o by one LSB
// (6.25 mV). If all canaries report "margin headroom" (canary_margin_high_i)
// the controller lowers target_code_o by one LSB. The output target_code_o
// feeds rtl/power/dldo.sv and the off-chip PMIC sequencer in fw/pmc.
//
// Behavioral safety
// -----------------
// The output target_code_o is clamped between min_code_i and max_code_i,
// which the PMC firmware programs from the per-corner DVFS table.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module avfs_ctrl
    import power_pkg::*;
#(
    parameter int unsigned CANARY_COUNT  = AVFS_CANARY_COUNT,
    parameter int unsigned UPDATE_CYCLES = AVFS_UPDATE_CYCLES
)(
    input  logic                          clk_sample,
    input  logic                          rst_n,
    input  logic                          enable_i,
    input  logic                          sample_tick_i,        // 200 MHz pulse
    input  logic [CANARY_COUNT-1:0]       canary_margin_low_i,
    input  logic [CANARY_COUNT-1:0]       canary_margin_high_i,
    input  logic [DVFS_CODE_WIDTH-1:0]    min_code_i,
    input  logic [DVFS_CODE_WIDTH-1:0]    max_code_i,
    input  logic [DVFS_CODE_WIDTH-1:0]    init_code_i,

    output logic [DVFS_CODE_WIDTH-1:0]    target_code_o,
    output logic                          target_update_pulse_o,
    output logic [31:0]                   raise_event_count_o,
    output logic [31:0]                   lower_event_count_o,
    output logic                          fault_o
);

    logic [$clog2(UPDATE_CYCLES+1)-1:0] cycle_q;
    logic                                update_tick;

    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            cycle_q <= '0;
        end else if (sample_tick_i && enable_i) begin
            if (cycle_q == ($clog2(UPDATE_CYCLES+1))'(UPDATE_CYCLES - 1)) begin
                cycle_q <= '0;
            end else begin
                cycle_q <= cycle_q + 1'b1;
            end
        end else if (!enable_i) begin
            cycle_q <= '0;
        end
    end

    assign update_tick = enable_i && sample_tick_i &&
                         (cycle_q == ($clog2(UPDATE_CYCLES+1))'(UPDATE_CYCLES - 1));

    // ---------------- target code FSM --------------------------------------
    logic [DVFS_CODE_WIDTH-1:0] target_q;
    logic                       update_pulse_q;
    logic                       fault_q;
    logic                       any_low;
    logic                       all_high;

    assign any_low  = |canary_margin_low_i;
    assign all_high = (&canary_margin_high_i) & ~any_low;

    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            target_q       <= init_code_i;
            update_pulse_q <= 1'b0;
            fault_q        <= 1'b0;
        end else if (!enable_i) begin
            target_q       <= init_code_i;
            update_pulse_q <= 1'b0;
            fault_q        <= 1'b0;
        end else if (update_tick) begin
            update_pulse_q <= 1'b1;
            if (any_low) begin
                if (target_q < max_code_i) begin
                    target_q <= target_q + 1'b1;
                end else begin
                    fault_q  <= 1'b1;  // saturated at max; cannot raise further
                end
            end else if (all_high) begin
                if (target_q > min_code_i) begin
                    target_q <= target_q - 1'b1;
                end
            end
        end else begin
            update_pulse_q <= 1'b0;
        end
    end

    assign target_code_o        = target_q;
    assign target_update_pulse_o = update_pulse_q;
    assign fault_o              = fault_q;

    // Event counters
    logic [31:0] raise_q, lower_q;
    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            raise_q <= 32'h0;
            lower_q <= 32'h0;
        end else if (update_tick && enable_i) begin
            if (any_low && (target_q < max_code_i)) begin
                raise_q <= raise_q + 32'h1;
            end else if (all_high && (target_q > min_code_i)) begin
                lower_q <= lower_q + 32'h1;
            end
        end
    end
    assign raise_event_count_o = raise_q;
    assign lower_event_count_o = lower_q;

endmodule : avfs_ctrl
