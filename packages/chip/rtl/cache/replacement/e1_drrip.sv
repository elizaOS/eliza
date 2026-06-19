`timescale 1ns/1ps

// e1_drrip
//
// Dynamic Re-Reference Interval Prediction (DRRIP), Jaleel et al., ISCA'10.
//
// DRRIP combines two RRIP variants:
//   SRRIP : inserts new lines at RRPV = 2
//   BRRIP : inserts new lines at RRPV = 2 with low probability (1/32),
//           otherwise at RRPV = 3
// and uses set dueling to pick the better policy globally.
//
// PSEL is a 10-bit signed counter:
//   - SRRIP misses decrement PSEL
//   - BRRIP misses increment PSEL
//   - PSEL > 0 => use BRRIP for follower sets
//   - PSEL < 0 => use SRRIP for follower sets
//
// Leader sets are chosen by index: SRRIP leaders at index & (NUM_SETS/32-1) == 0,
// BRRIP leaders at index & (NUM_SETS/32-1) == 1.
//
// This module provides:
//   - victim_o: which way to evict in the given set
//   - on hit: update RRPV (set to 0)
//   - on miss: insert new line at appropriate RRPV based on policy choice
//
// Storage:
//   rrpv [WAYS][SETS] : 2 bits per way per set
//   psel              : 10-bit signed

module e1_drrip #(
    parameter int unsigned WAYS = 16,
    parameter int unsigned SETS = 2048,
    parameter int unsigned BRRIP_BIP_NUMERATOR = 1,   // 1/32 distant insertion
    parameter int unsigned BRRIP_BIP_DENOMINATOR = 32
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // Access notification
    input  logic                       acc_valid,
    input  logic [$clog2(SETS)-1:0]    acc_set,
    input  logic                       acc_hit,
    input  logic [$clog2(WAYS)-1:0]    acc_way,
    input  logic                       acc_is_miss_install,

    // Victim selection (combinational)
    input  logic [$clog2(SETS)-1:0]    query_set,
    output logic [$clog2(WAYS)-1:0]    victim_way
);

    localparam int unsigned SET_W = $clog2(SETS);
    localparam int unsigned LEADER_GROUP = SETS / 32;
    localparam int unsigned LEADER_MASK_W = $clog2(LEADER_GROUP);

    logic [1:0] rrpv [WAYS][SETS];
    logic signed [9:0] psel_q;
    logic [4:0] bip_lfsr_q;

    function automatic logic is_srrip_leader(input logic [SET_W-1:0] s);
        return (s[LEADER_MASK_W-1:0] == '0);
    endfunction
    function automatic logic is_brrip_leader(input logic [SET_W-1:0] s);
        return (s[LEADER_MASK_W-1:0] == LEADER_MASK_W'(1));
    endfunction

    function automatic logic [$clog2(WAYS)-1:0] find_victim
        (input logic [SET_W-1:0] s);
        logic [$clog2(WAYS)-1:0] v;
        v = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (rrpv[w][s] == 2'b11) v = w[$clog2(WAYS)-1:0];
        end
        return v;
    endfunction

    assign victim_way = find_victim(query_set);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rrpv       <= '{default: '{default: 2'b11}};
            psel_q     <= 10'sd0;
            bip_lfsr_q <= 5'd0;
        end else begin : tick_block
            logic use_brrip;
            use_brrip = 1'b0;
            if (acc_valid) begin
                if (acc_hit) begin
                    rrpv[acc_way][acc_set] <= 2'b00;
                end else if (acc_is_miss_install) begin
                    bip_lfsr_q <= bip_lfsr_q + 5'd1;
                    use_brrip = is_brrip_leader(acc_set);
                    if (!is_srrip_leader(acc_set) && !is_brrip_leader(acc_set))
                        use_brrip = (psel_q > 0);
                    if (use_brrip) begin
                        if (bip_lfsr_q < BRRIP_BIP_NUMERATOR[4:0])
                            rrpv[acc_way][acc_set] <= 2'b10;
                        else
                            rrpv[acc_way][acc_set] <= 2'b11;
                    end else begin
                        rrpv[acc_way][acc_set] <= 2'b10;
                    end
                    if (is_srrip_leader(acc_set) && psel_q != 10'sd511)
                        psel_q <= psel_q + 10'sd1;
                    else if (is_brrip_leader(acc_set) && psel_q != -10'sd512)
                        psel_q <= psel_q - 10'sd1;
                end else begin
                    if (rrpv[0][acc_set] != 2'b11 &&
                        rrpv[1][acc_set] != 2'b11) begin
                        for (int w = 0; w < WAYS; w++)
                            if (rrpv[w][acc_set] != 2'b11)
                                rrpv[w][acc_set] <= rrpv[w][acc_set] + 2'b01;
                    end
                end
            end
        end
    end

    // BRRIP_BIP_DENOMINATOR is declared for documentation parity with the
    // paper; the LFSR bit width fixes the bimodal insertion frequency.
    /* verilator lint_off UNUSEDPARAM */
    /* verilator lint_on UNUSEDPARAM */

endmodule
