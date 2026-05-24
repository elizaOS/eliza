// ftq_to_l1i_shim.sv — translation glue from the BPU's FTQ output to the
// L1I-prefetch interface owned by the cache domain.
//
// The BPU agent produces `bpu_pkg::ftq_entry_t` records on its `fetch_entry`
// port whenever fetch pops a predicted block. The cache agent declares the
// L1I-prefetch request bundle in `rtl/cache/ftq_to_l1i_pkg.sv` as
// `e1_ftq_to_l1i_pkg::ftq_prefetch_req_t`, which holds a 40-bit physical
// address aligned to a 64 B L1I line, a 3-bit confidence, and a 1-bit
// branch-target hint.
//
// This shim sits at the BPU-to-cache interface (per the cluster top). It
// exposes the current scalar valid/ready channel and a widened two-request
// bundle for consumers that can accept multiple non-contiguous fetch fragments
// in one cycle. It performs the three field translations:
//
//   1. Virtual segment target PC (39-bit Sv39) -> 40-bit physical line
//      address.
//      The shim assumes a 1:1 V->P identity mapping at this stage. Real
//      translation requires an iTLB consult, which is owned by the cache
//      agent on the receive side; this shim therefore zero-extends and clears
//      the line offset bits.
//   2. The `kind` field is mapped onto a 3-bit confidence: BR_NONE=0,
//      BR_COND=4, BR_CALL=5, BR_RET=6. This is the simplest monotonic mapping
//      consistent with the cache agent's documented 0..7 scale.
//   3. `branch_target` is asserted whenever the selected FTQ segment's
//      `taken` bit is high. Sequential next-block fetches are not branch
//      targets.
//
// When the predictor emits the forward `fetch_segments` contract, each valid
// segment is materialized into its matching bundle lane. Older scalar FTQ
// entries with no segment metadata fall back to lane 0 using
// `fetch_entry.target_pc`/`fetch_entry.taken`. Existing scalar consumers see
// the first pending lane and drain later lanes in order; widened consumers can
// assert `l1i_ready_vec_i` to consume any ready lanes independently. Incoming
// FTQ pops are staged into a small ordered FIFO so predictor-ahead prefetches
// are not dropped merely because an older L1I prefetch is still draining.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
import e1_ftq_to_l1i_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ftq_to_l1i_shim (
    input  logic                clk,
    input  logic                rst_n,

    // FTQ entry from `bpu_top.fetch_entry`. Validity comes in on
    // `fetch_entry_valid` (paired with `bpu_top.fetch_valid`).
    input  logic                fetch_entry_valid,
    /* verilator lint_off UNUSEDSIGNAL */
    // Only target_pc, kind, taken, valid, and fetch_segments feed the L1I
    // prefetch request.
    // The other ftq_entry_t fields (start_pc, end_pc, br_taken_mask, ftq_idx,
    // RAS snapshot, and predictor-provider metadata) stay on the BPU side;
    // the cache agent does not consume them.
    input  ftq_entry_t          fetch_entry,
    /* verilator lint_on UNUSEDSIGNAL */

    // Misprediction flush from the resolver — flushes any L1I prefetch the
    // BPU has produced from now-stale FTQ entries.
    input  logic                flush_valid,

    // L1I prefetch channel. Valid/ready handshake per `e1_ftq_to_l1i_pkg`.
    // `flush_o` mirrors `flush_valid` so the cache agent can drop in-flight
    // prefetches.
    input  logic                l1i_ready_i,
    output ftq_prefetch_req_t   l1i_req_o,
    output logic                l1i_valid_o,
    input  logic [FTQ_PREFETCH_MAX_REQS-1:0] l1i_ready_vec_i,
    output ftq_prefetch_bundle_t l1i_bundle_o,
    output logic                l1i_flush_o
);

    localparam int unsigned SEG_IDX_W = (MAX_BR_PER_BLOCK <= 1) ? 1 :
                                        $clog2(MAX_BR_PER_BLOCK);
    localparam int unsigned PREFETCH_FIFO_DEPTH = 8;
    localparam int unsigned PREFETCH_FIFO_COUNT_W =
        $clog2(PREFETCH_FIFO_DEPTH + 1);

    ftq_prefetch_req_t fifo_q [PREFETCH_FIFO_DEPTH];
    ftq_prefetch_req_t fifo_d [PREFETCH_FIFO_DEPTH];
    logic [PREFETCH_FIFO_COUNT_W-1:0] fifo_count_q;
    logic [PREFETCH_FIFO_COUNT_W-1:0] fifo_count_d;
    ftq_prefetch_req_t incoming_req [FTQ_PREFETCH_MAX_REQS];
    logic [FTQ_PREFETCH_MAX_REQS-1:0] incoming_valid;
    logic [PREFETCH_FIFO_DEPTH-1:0] consume;
    logic scalar_consume;

    function automatic ftq_prefetch_req_t make_prefetch_req(
        input logic [VADDR_W-1:0] pc,
        input logic taken,
        input br_kind_e kind
    );
        ftq_prefetch_req_t req;
        begin
            req = '0;
            // 64 B L1I line offset is 6 bits. Preserve a 40-bit 64 B-aligned
            // physical address, matching e1_ftq_to_l1i_pkg::ftq_prefetch_req_t.
            req.paddr_line[VADDR_W-1:6] = pc[VADDR_W-1:6];
            unique case (kind)
                BR_COND: req.confidence = 3'd4;
                BR_CALL: req.confidence = 3'd5;
                BR_RET:  req.confidence = 3'd6;
                default: req.confidence = 3'd0;
            endcase
            req.branch_target = taken;
            return req;
        end
    endfunction

    always_comb begin
        scalar_consume = l1i_valid_o && l1i_ready_i;
        incoming_req = '{default: '0};
        incoming_valid = '0;
        consume = '0;
        fifo_d = '{default: '0};
        fifo_count_d = '0;

        if (fetch_entry_valid && fetch_entry.valid) begin
            if (fetch_entry.fetch_segments[0].valid) begin
                for (int unsigned i = 0; i < FTQ_PREFETCH_MAX_REQS; i++) begin
                    if (fetch_entry.fetch_segments[i].valid) begin
                        incoming_req[i] = make_prefetch_req(
                            fetch_entry.fetch_segments[i].target_pc,
                            fetch_entry.fetch_segments[i].taken,
                            fetch_entry.kind
                        );
                        incoming_valid[i] = 1'b1;
                    end
                end
            end else begin
                incoming_req[0] = make_prefetch_req(
                    fetch_entry.target_pc,
                    fetch_entry.taken,
                    fetch_entry.kind
                );
                incoming_valid[0] = 1'b1;
            end
        end

        consume[0] = (fifo_count_q > 0) &&
                     (scalar_consume || l1i_ready_vec_i[0]);
        consume[1] = (fifo_count_q > 1) && l1i_ready_vec_i[1];

        for (int unsigned i = 0; i < PREFETCH_FIFO_DEPTH; i++) begin
            if (i < fifo_count_q && !consume[i]) begin
                fifo_d[fifo_count_d] = fifo_q[i];
                fifo_count_d = fifo_count_d + 1'b1;
            end
        end

        for (int unsigned i = 0; i < FTQ_PREFETCH_MAX_REQS; i++) begin
            if (incoming_valid[i]) begin
                if (fifo_count_d < PREFETCH_FIFO_DEPTH) begin
                    fifo_d[fifo_count_d] = incoming_req[i];
                    fifo_count_d = fifo_count_d + 1'b1;
                end
            end
        end
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            fifo_count_q <= '0;
            for (int unsigned i = 0; i < PREFETCH_FIFO_DEPTH; i++) begin
                fifo_q[i] <= '0;
            end
        end else if (flush_valid) begin
            fifo_count_q <= '0;
            for (int unsigned i = 0; i < PREFETCH_FIFO_DEPTH; i++) begin
                fifo_q[i] <= '0;
            end
        end else begin
            fifo_count_q <= fifo_count_d;
            for (int unsigned i = 0; i < PREFETCH_FIFO_DEPTH; i++) begin
                fifo_q[i] <= fifo_d[i];
            end
        end
    end

    always_comb begin
        l1i_req_o   = (fifo_count_q > 0) ? fifo_q[0] : '0;
        l1i_valid_o = (fifo_count_q > 0) && !flush_valid;
        l1i_bundle_o = '0;
        l1i_bundle_o.valid[0] = !flush_valid && (fifo_count_q > 0);
        l1i_bundle_o.valid[1] = !flush_valid && (fifo_count_q > 1);
        for (int unsigned i = 0; i < FTQ_PREFETCH_MAX_REQS; i++) begin
            l1i_bundle_o.req[i] = (i < fifo_count_q) ? fifo_q[i] : '0;
        end
        l1i_flush_o = flush_valid;
    end

endmodule : ftq_to_l1i_shim
