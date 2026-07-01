`timescale 1ns/1ps

// e1_best_offset_prefetcher
//
// Best-Offset Prefetcher (Michaud, DPC-2 winner).
//
// Periodically evaluates a set of candidate offsets against a recent-request
// table. The offset with the highest score over the last evaluation phase
// becomes the prefetch offset until the next phase.
//
// For a synthesizable RTL approximation:
//   - Recent-Request table holds the last RR_DEPTH line-addresses observed
//   - Each of OFFSETS candidate offsets has a saturating score
//   - When a demand line is observed, for each candidate offset O, if
//     (line - O) is in the RR table, score[O]++
//   - Every ROUND_LEN cycles the best-scoring offset is committed as
//     "active offset" and scores are reset

module e1_best_offset_prefetcher #(
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned RR_DEPTH   = 16,
    parameter int unsigned OFFSETS    = 8,
    parameter int unsigned ROUND_LEN  = 256
) (
    input  logic                   clk,
    input  logic                   rst_n,

    input  logic                   obs_valid,
    input  logic [PADDR_W-1:0]     obs_paddr,

    output logic                   pf_valid,
    input  logic                   pf_ready,
    output logic [PADDR_W-1:0]     pf_paddr_line
);

    localparam int unsigned OFFSET_W    = $clog2(LINE_BYTES);
    localparam int unsigned LINE_ADDR_W = PADDR_W - OFFSET_W;
    localparam int signed   SCORE_W     = 8;

    // Fixed candidate offsets: 1, 2, 3, 4, -1, -2, 8, 16
    logic signed [7:0] candidate_offsets [OFFSETS];

    logic [LINE_ADDR_W-1:0] rr [RR_DEPTH];
    logic [$clog2(RR_DEPTH)-1:0] rr_head_q;
    logic signed [SCORE_W-1:0]  scores [OFFSETS];
    logic [15:0]                round_cnt_q;
    logic signed [7:0]          active_offset_q;

    function automatic logic in_rr(input logic [LINE_ADDR_W-1:0] line);
        logic hit;
        hit = 1'b0;
        for (int i = 0; i < RR_DEPTH; i++)
            if (rr[i] == line) hit = 1'b1;
        return hit;
    endfunction

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            candidate_offsets[0] <=  8'sd1;
            candidate_offsets[1] <=  8'sd2;
            candidate_offsets[2] <=  8'sd3;
            candidate_offsets[3] <=  8'sd4;
            candidate_offsets[4] <= -8'sd1;
            candidate_offsets[5] <= -8'sd2;
            candidate_offsets[6] <=  8'sd8;
            candidate_offsets[7] <=  8'sd16;
            for (int i = 0; i < RR_DEPTH; i++) rr[i] <= '0;
            for (int i = 0; i < OFFSETS; i++) scores[i] <= '0;
            rr_head_q       <= '0;
            round_cnt_q     <= '0;
            active_offset_q <= 8'sd1;
            pf_valid        <= 1'b0;
            pf_paddr_line   <= '0;
        end else begin
            if (pf_valid && pf_ready) pf_valid <= 1'b0;

            if (obs_valid) begin
                logic [LINE_ADDR_W-1:0] line;
                line = obs_paddr[PADDR_W-1:OFFSET_W];

                // Insert into RR
                rr[rr_head_q] <= line;
                rr_head_q     <= rr_head_q + 1'b1;

                // Score each candidate
                for (int i = 0; i < OFFSETS; i++) begin
                    if (in_rr(line - LINE_ADDR_W'($signed(candidate_offsets[i])))) begin
                        if (scores[i] != 8'sd127)
                            scores[i] <= scores[i] + 8'sd1;
                    end
                end

                // Emit prefetch using active offset
                if (!pf_valid) begin
                    pf_valid      <= 1'b1;
                    pf_paddr_line <= {(line + LINE_ADDR_W'($signed(active_offset_q))),
                                      {OFFSET_W{1'b0}}};
                end

                round_cnt_q <= round_cnt_q + 1'b1;
                if (round_cnt_q == ROUND_LEN[15:0]) begin
                    // Pick best
                    logic signed [SCORE_W-1:0] best_s;
                    logic signed [7:0]         best_o;
                    best_s = -8'sd128;
                    best_o = 8'sd1;
                    for (int i = 0; i < OFFSETS; i++) begin
                        if (scores[i] > best_s) begin
                            best_s = scores[i];
                            best_o = candidate_offsets[i];
                        end
                    end
                    active_offset_q <= best_o;
                    for (int i = 0; i < OFFSETS; i++) scores[i] <= '0;
                    round_cnt_q <= '0;
                end
            end
        end
    end

endmodule
