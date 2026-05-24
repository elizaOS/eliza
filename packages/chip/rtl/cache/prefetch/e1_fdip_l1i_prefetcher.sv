`timescale 1ns/1ps

// e1_fdip_l1i_prefetcher
//
// FDIP-style L1I prefetcher (Reinman, Calder, Austin 1999; revisited
// Kumar et al. arXiv:2006.13547).
//
// Consumes FTQ prefetch requests from the BPU (see ftq_to_l1i_pkg.sv) and
// forwards them to the L1I cache's prefetch port. The L1I miss pipe remains
// scalar, but this receiver can consume the two-lane FTQ bundle in one cycle
// into a bounded ordered slice so the shim does not have to serialize lanes
// before FDIP. A small confidence filter drops requests with confidence below
// MIN_CONF to avoid polluting the L1I. The receiver also keeps a short
// recently-issued line filter and a weak non-target throttle so repeated FTQ
// fragments do not keep refetching the same line or displace useful demand
// lines under a noisy predictor stream.

module e1_fdip_l1i_prefetcher
    import e1_ftq_to_l1i_pkg::*;
#(
    parameter int unsigned MIN_CONF = 2,
    parameter int unsigned PADDR_W  = 40,
    parameter int unsigned RECENT_DEPTH = 4,
    parameter int unsigned POLLUTION_BUDGET = 2
) (
    input  logic                  clk,
    input  logic                  rst_n,

    // From BPU FTQ
    input  logic                  ftq_in_valid,
    output logic                  ftq_in_ready,
    input  ftq_prefetch_req_t     ftq_in_req,
    input  ftq_prefetch_bundle_t  ftq_in_bundle,
    output logic [FTQ_PREFETCH_MAX_REQS-1:0] ftq_in_ready_vec,

    // To L1I prefetch port
    output logic                  pf_out_valid,
    input  logic                  pf_out_ready,
    output ftq_prefetch_req_t     pf_out_req,

    // Flush from BPU (drops in-flight)
    input  logic                  flush
);

    localparam int unsigned QUEUE_DEPTH = FTQ_PREFETCH_MAX_REQS;
    localparam int unsigned QUEUE_COUNT_W = $clog2(QUEUE_DEPTH + 1);
    localparam int unsigned POLLUTION_COUNT_W = $clog2(POLLUTION_BUDGET + 2);

    ftq_prefetch_req_t queue_q [QUEUE_DEPTH];
    logic [QUEUE_COUNT_W-1:0] count_q;
    logic [PADDR_W-1:0]       recent_line_q [RECENT_DEPTH];
    logic [RECENT_DEPTH-1:0]  recent_valid_q;
    logic [POLLUTION_COUNT_W-1:0] weak_pollution_q;
    logic                     pop_c;
    logic                     bundle_valid_c;
    logic [QUEUE_COUNT_W-1:0] free_slots_c;

    assign pop_c          = pf_out_valid && pf_out_ready;
    assign bundle_valid_c = |ftq_in_bundle.valid;
    assign free_slots_c   = QUEUE_COUNT_W'(QUEUE_DEPTH) - count_q +
                            {{(QUEUE_COUNT_W-1){1'b0}}, pop_c};

    assign ftq_in_ready = !flush && !bundle_valid_c && (count_q == '0);
    always_comb begin
        ftq_in_ready_vec = '0;
        if (!flush && bundle_valid_c) begin
            for (int unsigned i = 0; i < FTQ_PREFETCH_MAX_REQS; i++) begin
                ftq_in_ready_vec[i] = free_slots_c > QUEUE_COUNT_W'(i);
            end
        end
    end

    assign pf_out_valid = count_q != '0;
    assign pf_out_req   = (count_q != '0) ? queue_q[0] : ftq_prefetch_req_zero();

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            count_q <= '0;
            recent_valid_q <= '0;
            weak_pollution_q <= '0;
            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                queue_q[i] <= ftq_prefetch_req_zero();
            end
            for (int unsigned i = 0; i < RECENT_DEPTH; i++) begin
                recent_line_q[i] <= '0;
            end
        end else if (flush) begin
            count_q <= '0;
            recent_valid_q <= '0;
            weak_pollution_q <= '0;
            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                queue_q[i] <= ftq_prefetch_req_zero();
            end
            for (int unsigned i = 0; i < RECENT_DEPTH; i++) begin
                recent_line_q[i] <= '0;
            end
        end else begin
            automatic ftq_prefetch_req_t queue_next [QUEUE_DEPTH];
            automatic logic [QUEUE_COUNT_W-1:0] count_next;
            automatic logic [PADDR_W-1:0] recent_line_next [RECENT_DEPTH];
            automatic logic [RECENT_DEPTH-1:0] recent_valid_next;
            automatic logic [POLLUTION_COUNT_W-1:0] weak_pollution_next;
            automatic logic accepted_weak;

            queue_next = '{default: ftq_prefetch_req_zero()};
            count_next = '0;
            recent_line_next = recent_line_q;
            recent_valid_next = recent_valid_q;
            weak_pollution_next = weak_pollution_q;
            accepted_weak = 1'b0;

            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                if (i < count_q && !(pop_c && i == 0)) begin
                    queue_next[count_next] = queue_q[i];
                    count_next = count_next + 1'b1;
                end
            end

            if (bundle_valid_c) begin
                for (int unsigned i = 0; i < FTQ_PREFETCH_MAX_REQS; i++) begin
                    automatic logic duplicate;
                    automatic logic weak_non_target;

                    duplicate = 1'b0;
                    weak_non_target = !ftq_in_bundle.req[i].branch_target &&
                                      (ftq_in_bundle.req[i].confidence <= MIN_CONF[2:0]);
                    for (int unsigned q = 0; q < QUEUE_DEPTH; q++) begin
                        if ((q < count_next) &&
                            (queue_next[q].paddr_line == ftq_in_bundle.req[i].paddr_line)) begin
                            duplicate = 1'b1;
                        end
                    end
                    for (int unsigned r = 0; r < RECENT_DEPTH; r++) begin
                        if (recent_valid_next[r] &&
                            (recent_line_next[r] == ftq_in_bundle.req[i].paddr_line)) begin
                            duplicate = 1'b1;
                        end
                    end

                    if (ftq_in_bundle.valid[i] && ftq_in_ready_vec[i] &&
                        ftq_in_bundle.req[i].confidence >= MIN_CONF[2:0] &&
                        !duplicate &&
                        (!weak_non_target ||
                         (weak_pollution_next < POLLUTION_COUNT_W'(POLLUTION_BUDGET)))) begin
                        queue_next[count_next] = ftq_in_bundle.req[i];
                        count_next = count_next + 1'b1;
                        for (int unsigned r = RECENT_DEPTH - 1; r > 0; r--) begin
                            recent_line_next[r] = recent_line_next[r - 1];
                            recent_valid_next[r] = recent_valid_next[r - 1];
                        end
                        recent_line_next[0] = ftq_in_bundle.req[i].paddr_line;
                        recent_valid_next[0] = 1'b1;
                        if (weak_non_target) begin
                            weak_pollution_next = weak_pollution_next + 1'b1;
                            accepted_weak = 1'b1;
                        end
                    end
                end
            end else if (ftq_in_valid && ftq_in_ready &&
                         ftq_in_req.confidence >= MIN_CONF[2:0]) begin
                automatic logic duplicate;
                automatic logic weak_non_target;

                duplicate = 1'b0;
                weak_non_target = !ftq_in_req.branch_target &&
                                  (ftq_in_req.confidence <= MIN_CONF[2:0]);
                for (int unsigned q = 0; q < QUEUE_DEPTH; q++) begin
                    if ((q < count_next) &&
                        (queue_next[q].paddr_line == ftq_in_req.paddr_line)) begin
                        duplicate = 1'b1;
                    end
                end
                for (int unsigned r = 0; r < RECENT_DEPTH; r++) begin
                    if (recent_valid_next[r] &&
                        (recent_line_next[r] == ftq_in_req.paddr_line)) begin
                        duplicate = 1'b1;
                    end
                end

                if (!duplicate &&
                    (!weak_non_target ||
                     (weak_pollution_next < POLLUTION_COUNT_W'(POLLUTION_BUDGET)))) begin
                    queue_next[count_next] = ftq_in_req;
                    count_next = count_next + 1'b1;
                    for (int unsigned r = RECENT_DEPTH - 1; r > 0; r--) begin
                        recent_line_next[r] = recent_line_next[r - 1];
                        recent_valid_next[r] = recent_valid_next[r - 1];
                    end
                    recent_line_next[0] = ftq_in_req.paddr_line;
                    recent_valid_next[0] = 1'b1;
                    if (weak_non_target) begin
                        weak_pollution_next = weak_pollution_next + 1'b1;
                        accepted_weak = 1'b1;
                    end
                end
            end

            if (!accepted_weak && (weak_pollution_next != '0)) begin
                weak_pollution_next = weak_pollution_next - 1'b1;
            end

            count_q <= count_next;
            recent_valid_q <= recent_valid_next;
            weak_pollution_q <= weak_pollution_next;
            for (int unsigned i = 0; i < QUEUE_DEPTH; i++) begin
                queue_q[i] <= queue_next[i];
            end
            for (int unsigned i = 0; i < RECENT_DEPTH; i++) begin
                recent_line_q[i] <= recent_line_next[i];
            end
        end
    end

endmodule
