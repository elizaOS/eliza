`timescale 1ns/1ps

// e1_stride_prefetcher
//
// Per-PC stride prefetcher. Universal baseline.
//
// Each PC tracks last_addr and a stride. Once two consecutive accesses agree
// on a stride (state = STEADY), prefetch +k*stride lines ahead.

module e1_stride_prefetcher #(
    parameter int unsigned PC_W       = 64,
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned ENTRIES    = 16,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned DEGREE     = 2
) (
    input  logic                   clk,
    input  logic                   rst_n,

    input  logic                   obs_valid,
    input  logic [PC_W-1:0]        obs_pc,
    input  logic [PADDR_W-1:0]     obs_paddr,

    output logic                   pf_valid,
    input  logic                   pf_ready,
    output logic [PADDR_W-1:0]     pf_paddr_line
);

    localparam int unsigned OFFSET_W    = $clog2(LINE_BYTES);
    localparam int unsigned LINE_ADDR_W = PADDR_W - OFFSET_W;
    localparam int unsigned IDX_W       = $clog2(ENTRIES);
    localparam int signed   STRIDE_W    = 16;

    typedef enum logic [1:0] { INVALID, TRAIN, STEADY } stride_state_e;

    typedef struct packed {
        logic                       valid;
        logic [PC_W-1:0]            pc;
        logic [LINE_ADDR_W-1:0]     last_line;
        logic signed [STRIDE_W-1:0] stride;
        stride_state_e              state;
    } stride_entry_t;

    stride_entry_t tbl [ENTRIES];

    function automatic logic [IDX_W-1:0] lookup_pc
        (input logic [PC_W-1:0] pc, output logic found);
        logic [IDX_W-1:0] idx;
        idx = '0;
        found = 1'b0;
        for (int i = 0; i < ENTRIES; i++) begin
            if (tbl[i].valid && tbl[i].pc == pc) begin
                idx = i[IDX_W-1:0];
                found = 1'b1;
            end
        end
        return idx;
    endfunction

    function automatic logic [IDX_W-1:0] alloc_slot();
        logic [IDX_W-1:0] idx;
        idx = '0;
        for (int i = 0; i < ENTRIES; i++)
            if (!tbl[i].valid) idx = i[IDX_W-1:0];
        return idx;
    endfunction

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int i = 0; i < ENTRIES; i++) begin
                tbl[i].valid     <= 1'b0;
                tbl[i].pc        <= '0;
                tbl[i].last_line <= '0;
                tbl[i].stride    <= '0;
                tbl[i].state     <= INVALID;
            end
            pf_valid      <= 1'b0;
            pf_paddr_line <= '0;
        end else begin
            if (pf_valid && pf_ready) pf_valid <= 1'b0;

            if (obs_valid) begin
                logic found;
                logic [IDX_W-1:0] idx;
                logic [LINE_ADDR_W-1:0] new_line;
                logic signed [STRIDE_W-1:0] delta;
                new_line = obs_paddr[PADDR_W-1:OFFSET_W];
                idx = lookup_pc(obs_pc, found);
                if (!found) begin
                    idx = alloc_slot();
                    tbl[idx].valid     <= 1'b1;
                    tbl[idx].pc        <= obs_pc;
                    tbl[idx].last_line <= new_line;
                    tbl[idx].stride    <= '0;
                    tbl[idx].state     <= TRAIN;
                end else begin
                    delta = $signed(new_line) - $signed(tbl[idx].last_line);
                    if (tbl[idx].state == TRAIN) begin
                        tbl[idx].stride <= delta;
                        tbl[idx].state  <= STEADY;
                    end else if (tbl[idx].state == STEADY) begin
                        if (delta == tbl[idx].stride && delta != 0 && !pf_valid) begin
                            pf_valid      <= 1'b1;
                            pf_paddr_line <= {(new_line + (DEGREE * delta)),
                                              {OFFSET_W{1'b0}}};
                        end else if (delta != tbl[idx].stride) begin
                            tbl[idx].stride <= delta;
                            tbl[idx].state  <= TRAIN;
                        end
                    end
                    tbl[idx].last_line <= new_line;
                end
            end
        end
    end

endmodule
