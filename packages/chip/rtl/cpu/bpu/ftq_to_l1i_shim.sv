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
// This shim sits at the BPU-to-cache interface (per the cluster top) and
// performs the three field translations:
//
//   1. Virtual `target_pc` (39-bit Sv39) -> 40-bit physical line address.
//      The shim assumes a 1:1 V->P identity mapping at this stage. Real
//      translation requires an iTLB consult, which is owned by the cache
//      agent on the receive side; this shim therefore zero-extends and clears
//      the line offset bits.
//   2. The `kind` field is mapped onto a 3-bit confidence: BR_NONE=0,
//      BR_COND=4, BR_CALL=5, BR_RET=6. This is the simplest monotonic mapping
//      consistent with the cache agent's documented 0..7 scale.
//   3. `branch_target` is asserted whenever the FTQ entry's `taken` bit is
//      high. Sequential next-block fetches are not branch targets.
//
// The shim is purely combinational. A pipeline stage between the FTQ pop and
// the L1I prefetch send happens at the cluster boundary so the round-trip
// timing matches the cache agent's contract.

`timescale 1ns/1ps

/* verilator lint_off IMPORTSTAR */
import bpu_pkg::*;
import e1_ftq_to_l1i_pkg::*;
/* verilator lint_on IMPORTSTAR */

module ftq_to_l1i_shim (
    // FTQ entry from `bpu_top.fetch_entry`. Validity comes in on
    // `fetch_entry_valid` (paired with `bpu_top.fetch_valid`).
    input  logic                fetch_entry_valid,
    /* verilator lint_off UNUSEDSIGNAL */
    // Only target_pc, kind, taken, and valid feed the L1I prefetch request.
    // The other ftq_entry_t fields (start_pc, end_pc, br_taken_mask, ftq_idx,
    // RAS snapshot, and predictor-provider metadata) stay on the BPU side;
    // the cache agent does not consume them.
    input  ftq_entry_t          fetch_entry,
    /* verilator lint_on UNUSEDSIGNAL */

    // Misprediction flush from the resolver — flushes any L1I prefetch the
    // BPU has produced from now-stale FTQ entries.
    input  logic                flush_valid,

    // L1I prefetch channel. Single-cycle valid/ready handshake per
    // `e1_ftq_to_l1i_pkg`. `flush_o` mirrors `flush_valid` so the cache
    // agent can drop in-flight prefetches.
    output ftq_prefetch_req_t   l1i_req_o,
    output logic                l1i_valid_o,
    output logic                l1i_flush_o
);

    // 64 B L1I line offset is 6 bits. Preserve a 40-bit 64 B-aligned
    // physical address, matching e1_ftq_to_l1i_pkg::ftq_prefetch_req_t and
    // the L1I prefetch port.
    logic [FTQ_PADDR_W-1:0] paddr_line;
    always_comb begin
        paddr_line = '0;
        paddr_line[VADDR_W-1:6] = fetch_entry.target_pc[VADDR_W-1:6];
    end

    logic [FTQ_CONFIDENCE_W-1:0] confidence;
    always_comb begin
        unique case (fetch_entry.kind)
            BR_COND: confidence = 3'd4;
            BR_CALL: confidence = 3'd5;
            BR_RET:  confidence = 3'd6;
            default: confidence = 3'd0;
        endcase
    end

    always_comb begin
        l1i_req_o.paddr_line    = paddr_line;
        l1i_req_o.confidence    = confidence;
        l1i_req_o.branch_target = fetch_entry.taken;
        l1i_valid_o             = fetch_entry_valid && fetch_entry.valid && !flush_valid;
        l1i_flush_o             = flush_valid;
    end

endmodule : ftq_to_l1i_shim
