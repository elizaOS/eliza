// -----------------------------------------------------------------------------
// Eliza E1 — all-digital droop sensor
//
// Behavioral, synthesizable RTL port of the 22 nm all-digital adaptive clock
// distribution (ADCD) family (Bowman/Tokunaga, ISSCC 2015). One instance per
// managed voltage domain (CPU_BIG, CPU_LITTLE, NPU, GPU, SOC_FABRIC, SRAM).
//
// Architecture
// ------------
// A free-running ring oscillator on the monitored rail clocks an asynchronous
// counter. Every 200 MHz sample period (sample_tick_i) the counter is captured
// and reset. If the captured count drops below threshold_i the supply has
// drooped; if it falls below threshold_i for DROOP_CONFIRM_SAMPLES consecutive
// samples, droop_alarm_o pulses for one sample_tick_i cycle.
//
// Calibration
// -----------
// threshold_i must be set by the AVFS / PMC firmware after silicon
// characterization. The RO frequency vs Vdd curve is calibrated per silicon
// corner. The reset value DROOP_DEFAULT_THRESHOLD is planning_only and is not
// release-grade. See docs/pd/droop-detection.md.
//
// Latency contract
// ----------------
// Detection latency = one sample period (5 ns @ 200 MHz) + 1 stretch cycle.
// The downstream clock stretcher must observe droop_alarm_o the same sample
// tick to satisfy the 1-cycle response in docs/pd/droop-detection.md.
// -----------------------------------------------------------------------------
`timescale 1ns/1ps

module droop_sensor
    import power_pkg::*;
#(
    parameter int unsigned RO_STAGES         = DROOP_RO_STAGES,
    parameter int unsigned COUNTER_WIDTH     = DROOP_COUNTER_WIDTH,
    parameter int unsigned CONFIRM_SAMPLES   = DROOP_CONFIRM_SAMPLES
)(
    input  logic                         clk_sample,        // 200 MHz reference
    input  logic                         rst_n,
    input  logic                         sample_tick_i,     // 1-cycle pulse per sample
    input  logic                         ro_clk_i,          // ring-osc clock on monitored rail
    input  logic [COUNTER_WIDTH-1:0]     threshold_i,
    input  logic                         enable_i,

    output logic                         droop_alarm_o,
    output logic [COUNTER_WIDTH-1:0]     last_count_o,
    output logic [31:0]                  droop_event_count_o
);

    // -------------------------------------------------------------------------
    // RO-domain free-running counter
    // -------------------------------------------------------------------------
    logic [COUNTER_WIDTH-1:0] ro_counter_q;
    logic                     ro_capture_req;
    logic                     ro_capture_ack;
    logic [COUNTER_WIDTH-1:0] ro_captured;

    // Asynchronous reset path on ro_clk_i; behavioral.
    /* verilator lint_off SYNCASYNCNET */
    always_ff @(posedge ro_clk_i or negedge rst_n) begin
        if (!rst_n) begin
            ro_counter_q <= '0;
        end else begin
            ro_counter_q <= ro_counter_q + COUNTER_WIDTH'(1);
        end
    end
    /* verilator lint_on SYNCASYNCNET */

    // -------------------------------------------------------------------------
    // Two-flop synchronizer for sample_tick_i into the RO domain
    // -------------------------------------------------------------------------
    logic [1:0] tick_sync_q;
    always_ff @(posedge ro_clk_i or negedge rst_n) begin
        if (!rst_n) begin
            tick_sync_q <= 2'b00;
        end else begin
            tick_sync_q <= {tick_sync_q[0], sample_tick_i};
        end
    end
    assign ro_capture_req = tick_sync_q[1];

    // Capture latch on RO domain (rising edge of synchronized tick)
    logic ro_capture_req_d;
    always_ff @(posedge ro_clk_i or negedge rst_n) begin
        if (!rst_n) begin
            ro_captured       <= '0;
            ro_capture_req_d  <= 1'b0;
        end else begin
            ro_capture_req_d <= ro_capture_req;
            if (ro_capture_req && !ro_capture_req_d) begin
                ro_captured <= ro_counter_q;
            end
        end
    end

    assign ro_capture_ack = ro_capture_req_d;

    // -------------------------------------------------------------------------
    // Bring the captured count back into the sample-clock domain.
    // Two-flop sync on ro_capture_ack provides a stable window.
    // -------------------------------------------------------------------------
    logic [1:0] ack_sync_q;
    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            ack_sync_q <= 2'b00;
        end else begin
            ack_sync_q <= {ack_sync_q[0], ro_capture_ack};
        end
    end

    logic [COUNTER_WIDTH-1:0] last_count_q;
    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            last_count_q <= '0;
        end else if (sample_tick_i && enable_i) begin
            last_count_q <= ro_captured;
        end
    end
    assign last_count_o = last_count_q;

    // -------------------------------------------------------------------------
    // Threshold compare + confirm-window
    // -------------------------------------------------------------------------
    logic                                below_threshold;
    logic [$clog2(CONFIRM_SAMPLES+1)-1:0] confirm_q;
    logic                                alarm_q;

    assign below_threshold = enable_i && (last_count_q < threshold_i);

    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            confirm_q <= '0;
            alarm_q   <= 1'b0;
        end else if (sample_tick_i) begin
            if (below_threshold) begin
                if (confirm_q == ($clog2(CONFIRM_SAMPLES+1))'(CONFIRM_SAMPLES - 1)) begin
                    alarm_q   <= 1'b1;
                end else begin
                    confirm_q <= confirm_q + 1'b1;
                    alarm_q   <= 1'b0;
                end
            end else begin
                confirm_q <= '0;
                alarm_q   <= 1'b0;
            end
        end else begin
            alarm_q <= 1'b0;  // pulse one sample only
        end
    end
    assign droop_alarm_o = alarm_q;

    // -------------------------------------------------------------------------
    // Event count (telemetry to PMC)
    // -------------------------------------------------------------------------
    logic [31:0] event_count_q;
    always_ff @(posedge clk_sample or negedge rst_n) begin
        if (!rst_n) begin
            event_count_q <= 32'h0;
        end else if (alarm_q) begin
            event_count_q <= event_count_q + 32'h1;
        end
    end
    assign droop_event_count_o = event_count_q;

    // Suppress lint on unused: rest of ack_sync_q's first bit is intentional
    /* verilator lint_off UNUSED */
    wire _unused_ack_sync = |ack_sync_q;
    /* verilator lint_on UNUSED */

endmodule : droop_sensor
