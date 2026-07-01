`timescale 1ns/1ps

// e1_berti_prefetcher
//
// Berti-style L1D prefetcher (Navarro-Torres et al., MICRO'22).
//
// Maintains a small per-PC tbl of recent deltas and their observed
// latencies. On a demand access from a tracked PC, the prefetcher computes
// the most-confident delta and emits a prefetch request at +K * delta lines
// ahead, where K is the lookahead (degree).
//
// This is a synthesizable, parameterizable RTL approximation of Berti
// suitable for cocotb verification. It is not a bit-for-bit port of the
// MICRO'22 paper: full Berti requires storing latency cycles per delta and
// performing periodic ranking. Here we store hit counts per delta and pick
// the max-count delta as the prefetch candidate.
//
// Parameters:
//   PC_W       : PC width (low bits stored)
//   PADDR_W    : physical address width
//   ENTRIES    : per-PC tracked entries (default 24, paper recommends 24)
//   DELTAS_PER : number of deltas tracked per entry (default 4)
//   LOOKAHEAD  : number of lines ahead to prefetch (default 1)

module e1_berti_prefetcher #(
    parameter int unsigned PC_W       = 64,
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned ENTRIES    = 24,
    parameter int unsigned DELTAS_PER = 4,
    parameter int unsigned LOOKAHEAD  = 1,
    parameter int unsigned LINE_BYTES = 64
) (
    input  logic                   clk,
    input  logic                   rst_n,

    // Observed demand access (one per cycle)
    input  logic                   obs_valid,
    input  logic [PC_W-1:0]        obs_pc,
    input  logic [PADDR_W-1:0]     obs_paddr,

    // Emitted prefetch request
    output logic                   pf_valid,
    input  logic                   pf_ready,
    output logic [PADDR_W-1:0]     pf_paddr_line
);

    localparam int unsigned OFFSET_W = $clog2(LINE_BYTES);
    localparam int unsigned LINE_ADDR_W = PADDR_W - OFFSET_W;
    localparam int unsigned ENTRY_IDX_W = $clog2(ENTRIES);
    localparam int unsigned DELTA_IDX_W = $clog2(DELTAS_PER);
    localparam int signed   DELTA_W     = 16;

    // Per-entry tracked state. The deltas / counts arrays are kept as
    // separate top-level arrays so we can declare them as 2-D unpacked
    // memory rather than embedding unpacked arrays inside a packed struct
    // (forbidden by IEEE 1800-2023 7.2.1).
    logic                       tbl_valid      [ENTRIES];
    logic [PC_W-1:0]            tbl_pc         [ENTRIES];
    logic [LINE_ADDR_W-1:0]     tbl_last_line  [ENTRIES];
    logic signed [DELTA_W-1:0]  tbl_deltas     [ENTRIES][DELTAS_PER];
    logic [3:0]                 tbl_counts     [ENTRIES][DELTAS_PER];

    function automatic logic [ENTRY_IDX_W-1:0] lookup_pc
        (input logic [PC_W-1:0] pc, output logic found);
        logic [ENTRY_IDX_W-1:0] idx;
        idx = '0;
        found = 1'b0;
        for (int i = 0; i < ENTRIES; i++) begin
            if (tbl_valid[i] && tbl_pc[i] == pc) begin
                idx = i[ENTRY_IDX_W-1:0];
                found = 1'b1;
            end
        end
        return idx;
    endfunction

    function automatic logic [ENTRY_IDX_W-1:0] alloc_slot
        ();
        logic [ENTRY_IDX_W-1:0] idx;
        idx = '0;
        for (int i = 0; i < ENTRIES; i++) begin
            if (!tbl_valid[i]) idx = i[ENTRY_IDX_W-1:0];
        end
        return idx;
    endfunction

    function automatic logic [DELTA_IDX_W-1:0] best_delta_idx
        (input logic [ENTRY_IDX_W-1:0] entry);
        logic [DELTA_IDX_W-1:0] idx;
        logic [3:0] best;
        idx = '0;
        best = 4'h0;
        for (int d = 0; d < DELTAS_PER; d++) begin
            if (tbl_counts[entry][d] > best) begin
                best = tbl_counts[entry][d];
                idx  = d[DELTA_IDX_W-1:0];
            end
        end
        return idx;
    endfunction

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int i = 0; i < ENTRIES; i++) begin
                tbl_valid[i]     <= 1'b0;
                tbl_pc[i]        <= '0;
                tbl_last_line[i] <= '0;
                for (int d = 0; d < DELTAS_PER; d++) begin
                    tbl_deltas[i][d] <= '0;
                    tbl_counts[i][d] <= 4'h0;
                end
            end
            pf_valid      <= 1'b0;
            pf_paddr_line <= '0;
        end else begin
            if (pf_valid && pf_ready) pf_valid <= 1'b0;

            if (obs_valid) begin : obs_block
                logic                       found;
                logic [ENTRY_IDX_W-1:0]     idx;
                logic [LINE_ADDR_W-1:0]     new_line;
                logic signed [DELTA_W-1:0]  new_delta;
                logic                       matched;
                logic [DELTA_IDX_W-1:0]     victim;
                logic [3:0]                 lowest;
                logic [DELTA_IDX_W-1:0]     best_idx;
                logic signed [DELTA_W-1:0]  best_d;
                new_line  = obs_paddr[PADDR_W-1:OFFSET_W];
                idx       = lookup_pc(obs_pc, found);
                matched   = 1'b0;
                victim    = '0;
                lowest    = 4'hF;
                best_idx  = '0;
                best_d    = '0;
                new_delta = '0;
                if (!found) begin
                    idx = alloc_slot();
                    tbl_valid[idx]     <= 1'b1;
                    tbl_pc[idx]        <= obs_pc;
                    tbl_last_line[idx] <= new_line;
                    for (int d = 0; d < DELTAS_PER; d++) begin
                        tbl_deltas[idx][d] <= '0;
                        tbl_counts[idx][d] <= 4'h0;
                    end
                end else begin
                    new_delta = $signed(new_line) - $signed(tbl_last_line[idx]);
                    for (int d = 0; d < DELTAS_PER; d++) begin
                        if (tbl_deltas[idx][d] == new_delta && !matched) begin
                            if (tbl_counts[idx][d] != 4'hF)
                                tbl_counts[idx][d] <= tbl_counts[idx][d] + 1;
                            matched = 1'b1;
                        end
                    end
                    if (!matched) begin
                        for (int d = 0; d < DELTAS_PER; d++) begin
                            if (tbl_counts[idx][d] < lowest) begin
                                lowest = tbl_counts[idx][d];
                                victim = d[DELTA_IDX_W-1:0];
                            end
                        end
                        tbl_deltas[idx][victim] <= new_delta;
                        tbl_counts[idx][victim] <= 4'h1;
                    end
                    tbl_last_line[idx] <= new_line;

                    if (!pf_valid) begin
                        best_idx = best_delta_idx(idx);
                        best_d   = tbl_deltas[idx][best_idx];
                        if (tbl_counts[idx][best_idx] >= 4'h2 && best_d != 0) begin
                            pf_valid      <= 1'b1;
                            pf_paddr_line <= {(new_line + (LOOKAHEAD * best_d)),
                                              {OFFSET_W{1'b0}}};
                        end
                    end
                end
            end
        end
    end

endmodule
