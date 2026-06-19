`timescale 1ns/1ps

// e1_pythia_stub
//
// Pythia (Bera et al., MICRO'21) RL-based hardware prefetcher.
//
// Full Pythia includes:
//   - Q-table indexed by program features (PC, last delta, page address)
//   - Tile-coded continuous features
//   - SARSA update on prefetch-useful / wasted feedback
//
// The reference C++ implementation (github.com/CMU-SAFARI/Pythia) is ~3000
// lines and uses a large Q-table. Productizing it as RTL is a 6-9
// person-month effort.
//
// This module is a STUB: it accepts observations, holds a fixed Q-table
// initialized to favor +1 line, and emits +1 line prefetches identical to a
// next-line prefetcher. Its RTL footprint is held intentionally small so
// the full Pythia drop-in is a localized change at integration time.
//
// The presence of this stub keeps the integration surface explicit:
// downstream code that says "use prefetcher = pythia" gets a syntactically
// valid module today, and a real Pythia later, without changing the
// integration. The cache evidence gate marks Pythia as BLOCKED until a real
// productized RTL drop-in lands.

module e1_pythia_stub #(
    parameter int unsigned PC_W       = 64,
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned LINE_BYTES = 64
) (
    input  logic               clk,
    input  logic               rst_n,

    input  logic               obs_valid,
    input  logic [PC_W-1:0]    obs_pc,
    input  logic [PADDR_W-1:0] obs_paddr,
    input  logic               obs_was_useful, // training feedback
    input  logic               obs_was_wasted,

    output logic               pf_valid,
    input  logic               pf_ready,
    output logic [PADDR_W-1:0] pf_paddr_line
);

    localparam int unsigned OFFSET_W    = $clog2(LINE_BYTES);
    localparam int unsigned LINE_ADDR_W = PADDR_W - OFFSET_W;

    // Mark unused inputs so Verilator is content while the real Pythia is
    // BLOCKED.
    /* verilator lint_off UNUSEDSIGNAL */
    logic _unused_pc;
    logic _unused_useful;
    logic _unused_wasted;
    assign _unused_pc     = |obs_pc;
    assign _unused_useful = obs_was_useful;
    assign _unused_wasted = obs_was_wasted;
    /* verilator lint_on UNUSEDSIGNAL */

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            pf_valid      <= 1'b0;
            pf_paddr_line <= '0;
        end else begin
            if (pf_valid && pf_ready) pf_valid <= 1'b0;
            if (obs_valid && !pf_valid) begin
                pf_valid <= 1'b1;
                pf_paddr_line <=
                    {(obs_paddr[PADDR_W-1:OFFSET_W] + LINE_ADDR_W'(1)),
                     {OFFSET_W{1'b0}}};
            end
        end
    end

endmodule
