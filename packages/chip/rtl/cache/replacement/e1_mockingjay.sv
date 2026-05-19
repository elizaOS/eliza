`timescale 1ns/1ps

// e1_mockingjay
//
// Mockingjay (Shah et al., HPCA'22) cache replacement.
//
// Mockingjay predicts the expected re-reference interval for each insertion
// and stores it as an ETR (Estimated Time Remaining) per cache line. On a
// miss, the victim is the line with the largest ETR. ETRs are computed by
// CRC: a per-PC table records the average distance (in number of accesses)
// between the same PC's accesses; on insertion, that distance becomes the
// ETR for the new line. Each cycle the ETR counters of all lines decrement
// by 1.
//
// This RTL approximation:
//   - 64-entry per-PC Sampled Tag Table (STT) recording observed RDs
//   - 8-bit ETR per cache line (range 0..255, saturating)
//   - Per-set scan for the maximum ETR on victim selection
//
// Full Mockingjay paper is ~7-9% area over LRU and ~15% LLC IPC gain. The
// approximation in this module is a synthesizable starting point; cocotb
// tests verify the basic invariant (newly-inserted lines from
// "high-distance" PCs become victims first) but do not match the paper's
// metrics. Productizing Mockingjay to its full form is documented in
// docs/arch/cache-hierarchy.md as a 6-9 person-month follow-on.

module e1_mockingjay #(
    parameter int unsigned WAYS = 16,
    parameter int unsigned SETS = 2048,
    parameter int unsigned PC_W = 64,
    parameter int unsigned STT_ENTRIES = 64,
    parameter int unsigned MAX_ETR = 8'd255
) (
    input  logic                       clk,
    input  logic                       rst_n,

    input  logic                       acc_valid,
    input  logic [$clog2(SETS)-1:0]    acc_set,
    input  logic                       acc_hit,
    input  logic [$clog2(WAYS)-1:0]    acc_way,
    input  logic                       acc_is_miss_install,
    input  logic [PC_W-1:0]            acc_pc,

    input  logic [$clog2(SETS)-1:0]    query_set,
    output logic [$clog2(WAYS)-1:0]    victim_way
);

    localparam int unsigned ETR_W = 8;
    localparam int unsigned STT_IDX_W = $clog2(STT_ENTRIES);

    logic [ETR_W-1:0] etr [WAYS][SETS];

    typedef struct packed {
        logic                  valid;
        logic [PC_W-1:0]       pc;
        logic [31:0]           last_access_cnt;
        logic [ETR_W-1:0]      avg_distance;
    } stt_entry_t;
    stt_entry_t stt [STT_ENTRIES];
    logic [31:0] access_cnt_q;

    function automatic logic [STT_IDX_W-1:0] stt_lookup
        (input logic [PC_W-1:0] pc, output logic found);
        logic [STT_IDX_W-1:0] idx;
        idx = '0;
        found = 1'b0;
        for (int i = 0; i < STT_ENTRIES; i++) begin
            if (stt[i].valid && stt[i].pc == pc) begin
                idx = i[STT_IDX_W-1:0];
                found = 1'b1;
            end
        end
        return idx;
    endfunction

    function automatic logic [STT_IDX_W-1:0] stt_alloc();
        logic [STT_IDX_W-1:0] idx;
        idx = '0;
        for (int i = 0; i < STT_ENTRIES; i++)
            if (!stt[i].valid) idx = i[STT_IDX_W-1:0];
        return idx;
    endfunction

    function automatic logic [$clog2(WAYS)-1:0] find_victim
        (input logic [$clog2(SETS)-1:0] s);
        logic [$clog2(WAYS)-1:0] v;
        logic [ETR_W-1:0] m;
        v = '0;
        m = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (etr[w][s] > m) begin
                m = etr[w][s];
                v = w[$clog2(WAYS)-1:0];
            end
        end
        return v;
    endfunction

    assign victim_way = find_victim(query_set);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int w = 0; w < WAYS; w++)
                for (int s = 0; s < SETS; s++)
                    etr[w][s] <= MAX_ETR;
            for (int i = 0; i < STT_ENTRIES; i++)
                stt[i] <= '0;
            access_cnt_q <= '0;
        end else begin
            if (acc_valid) begin
                logic stt_found;
                logic [STT_IDX_W-1:0] sidx;
                sidx = stt_lookup(acc_pc, stt_found);
                access_cnt_q <= access_cnt_q + 32'd1;

                if (acc_hit) begin
                    if (stt_found) begin
                        logic [31:0] new_avg32;
                        new_avg32 = (32'(stt[sidx].avg_distance) >> 1) +
                                    ((access_cnt_q - stt[sidx].last_access_cnt) >> 1);
                        etr[acc_way][acc_set]    <= stt[sidx].avg_distance;
                        stt[sidx].avg_distance   <= new_avg32[ETR_W-1:0];
                        stt[sidx].last_access_cnt<= access_cnt_q;
                    end else begin
                        etr[acc_way][acc_set] <= 8'd16;
                    end
                end else if (acc_is_miss_install) begin
                    if (!stt_found) begin
                        sidx = stt_alloc();
                        stt[sidx].valid          <= 1'b1;
                        stt[sidx].pc             <= acc_pc;
                        stt[sidx].last_access_cnt<= access_cnt_q;
                        stt[sidx].avg_distance   <= 8'd16;
                        etr[acc_way][acc_set]    <= 8'd16;
                    end else begin
                        etr[acc_way][acc_set] <= stt[sidx].avg_distance;
                    end
                end

                // Periodic decay: every 64th access, age all ETRs in the set
                if (access_cnt_q[5:0] == 6'd0) begin
                    for (int w = 0; w < WAYS; w++)
                        if (etr[w][acc_set] != MAX_ETR)
                            etr[w][acc_set] <= etr[w][acc_set] + 8'd1;
                end
            end
        end
    end

endmodule
