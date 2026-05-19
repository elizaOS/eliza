// bpu_csr.sv — BPU performance-monitoring counters and CSR-readable view.
//
// Aggregates Zihpm event strobes from the BPU into 64-bit counters, exposes
// them on a read-only MMIO/CSR port for software, and produces the periodic
// useful-bit reset strobes consumed by the TAGE tables. The event encoding
// is fixed in bpu_pkg::pmu_event_e and mirrored in
// docs/arch/branch-prediction.md.

`timescale 1ns/1ps

module bpu_csr
    import bpu_pkg::*;
(
    input  logic                clk,
    input  logic                rst_n,

    input  logic [PMU_EVENTS-1:0] event_strb,

    // Read-only CSR interface: address indexes a single 64-bit counter.
    input  logic                csr_re,
    input  logic [4:0]          csr_addr,
    output logic [63:0]         csr_rdata,

    output logic                useful_reset_lsb,
    output logic                useful_reset_msb
);

    logic [PMU_COUNTER_W-1:0] counters_q [PMU_EVENTS];
    logic [31:0] reset_period_q;
    logic        reset_phase_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned e = 0; e < PMU_EVENTS; e++) counters_q[e] <= '0;
            reset_period_q   <= '0;
            reset_phase_q    <= 1'b0;
            useful_reset_lsb <= 1'b0;
            useful_reset_msb <= 1'b0;
        end else begin
            useful_reset_lsb <= 1'b0;
            useful_reset_msb <= 1'b0;
            for (int unsigned e = 0; e < PMU_EVENTS; e++) begin
                if (event_strb[e] && counters_q[e] != {PMU_COUNTER_W{1'b1}})
                    counters_q[e] <= counters_q[e] + 1'b1;
            end
            if (reset_period_q == TAGE_USEFUL_RESET_PERIOD) begin
                reset_period_q <= '0;
                reset_phase_q  <= !reset_phase_q;
                useful_reset_lsb <=  reset_phase_q;
                useful_reset_msb <= !reset_phase_q;
            end else begin
                reset_period_q <= reset_period_q + 1'b1;
            end
        end
    end

    always_comb begin
        csr_rdata = '0;
        if (csr_re && csr_addr < PMU_EVENTS[4:0]) begin
            csr_rdata = counters_q[csr_addr];
        end
    end

endmodule : bpu_csr
