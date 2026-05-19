`timescale 1ns/1ps

// e1_fdip_l1i_prefetcher
//
// FDIP-style L1I prefetcher (Reinman, Calder, Austin 1999; revisited
// Kumar et al. arXiv:2006.13547).
//
// Consumes FTQ prefetch requests from the BPU (see ftq_to_l1i_pkg.sv) and
// forwards them to the L1I cache's prefetch port. This module exists as a
// pass-through with a small confidence filter: only requests with
// confidence >= MIN_CONF are forwarded; otherwise they are dropped to avoid
// polluting the L1I.

module e1_fdip_l1i_prefetcher
    import e1_ftq_to_l1i_pkg::*;
#(
    parameter int unsigned MIN_CONF = 2,
    parameter int unsigned PADDR_W  = 40
) (
    input  logic                  clk,
    input  logic                  rst_n,

    // From BPU FTQ
    input  logic                  ftq_in_valid,
    output logic                  ftq_in_ready,
    input  ftq_prefetch_req_t     ftq_in_req,

    // To L1I prefetch port
    output logic                  pf_out_valid,
    input  logic                  pf_out_ready,
    output ftq_prefetch_req_t     pf_out_req,

    // Flush from BPU (drops in-flight)
    input  logic                  flush
);

    logic                  buf_valid_q;
    ftq_prefetch_req_t     buf_req_q;

    assign ftq_in_ready = !buf_valid_q;
    assign pf_out_valid = buf_valid_q;
    assign pf_out_req   = buf_req_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            buf_valid_q <= 1'b0;
            buf_req_q   <= ftq_prefetch_req_zero();
        end else if (flush) begin
            buf_valid_q <= 1'b0;
        end else begin
            if (ftq_in_valid && ftq_in_ready &&
                ftq_in_req.confidence >= MIN_CONF[2:0]) begin
                buf_valid_q <= 1'b1;
                buf_req_q   <= ftq_in_req;
            end else if (pf_out_valid && pf_out_ready) begin
                buf_valid_q <= 1'b0;
            end
        end
    end

endmodule
