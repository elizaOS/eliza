// -----------------------------------------------------------------------------
// Eliza E1 — programmable clock stretcher (adaptive clock distribution)
//
// One instance per CPU big core and per NPU tile. On droop_alarm_i the
// stretcher slides the clock phase by one tap of a 16-tap phase blender,
// producing a single stretched cycle within one sample period of the upstream
// droop sensor.
//
// Architecture
// ------------
// Implementation in this RTL is a behavioral model of a phase-blender-based
// stretcher. A real implementation uses an analog mux of 16 PLL phase taps
// and an interpolator. Here we model the timing contract: when droop_alarm_i
// pulses, a 1-cycle stretch is inserted into clk_o by gating a fraction of
// one input-clock edge. The stretched-cycle event is exposed on stretch_o
// for the cocotb harness.
//
// Latency contract
// ----------------
// droop_alarm_i pulse -> stretch_o pulse must occur on the next rising edge
// of clk_in_i. cocotb test_droop_event verifies the 1-cycle response.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module clock_stretcher
    import power_pkg::*;
#(
    parameter int unsigned PHASE_TAPS    = CLKSTRETCH_PHASE_TAPS,
    parameter int unsigned SELECT_WIDTH  = CLKSTRETCH_SELECT_WIDTH,
    parameter int unsigned STRETCH_CYCLES = CLKSTRETCH_CYCLES
)(
    input  logic                     clk_in_i,
    input  logic                     rst_n,
    input  logic                     enable_i,
    input  logic                     droop_alarm_i,
    input  logic [SELECT_WIDTH-1:0]  phase_select_i,

    output logic                     clk_o,
    output logic                     stretch_o,
    output logic [31:0]              stretch_event_count_o
);

    // Latch a stretch request on droop_alarm_i rising edge.
    logic stretch_pending_q;
    logic [$clog2(STRETCH_CYCLES+1)-1:0] stretch_count_q;
    logic stretch_active;

    always_ff @(posedge clk_in_i or negedge rst_n) begin
        if (!rst_n) begin
            stretch_pending_q <= 1'b0;
            stretch_count_q   <= '0;
        end else if (enable_i) begin
            if (droop_alarm_i && !stretch_pending_q && !stretch_active) begin
                stretch_pending_q <= 1'b1;
                stretch_count_q   <= '0;
            end else if (stretch_pending_q) begin
                if (stretch_count_q == ($clog2(STRETCH_CYCLES+1))'(STRETCH_CYCLES - 1)) begin
                    stretch_pending_q <= 1'b0;
                    stretch_count_q   <= '0;
                end else begin
                    stretch_count_q <= stretch_count_q + 1'b1;
                end
            end
        end else begin
            stretch_pending_q <= 1'b0;
            stretch_count_q   <= '0;
        end
    end

    assign stretch_active = stretch_pending_q;
    assign stretch_o      = stretch_active;

    // Behavioral output clock: during the stretched cycle we hold clk_o low
    // for one input-clock period, modeling the worst-case 50% duty stretch
    // produced by the phase blender. Real implementation uses a glitch-free
    // mux of 16 PLL phase taps.
    /* verilator lint_off UNUSED */
    wire _unused_phase = |phase_select_i;
    /* verilator lint_on UNUSED */

    assign clk_o = stretch_active ? 1'b0 : clk_in_i;

    // Event count (telemetry to PMC)
    logic [31:0] event_count_q;
    logic        stretch_active_d;
    always_ff @(posedge clk_in_i or negedge rst_n) begin
        if (!rst_n) begin
            event_count_q    <= 32'h0;
            stretch_active_d <= 1'b0;
        end else begin
            stretch_active_d <= stretch_active;
            if (stretch_active && !stretch_active_d) begin
                event_count_q <= event_count_q + 32'h1;
            end
        end
    end
    assign stretch_event_count_o = event_count_q;

endmodule : clock_stretcher
