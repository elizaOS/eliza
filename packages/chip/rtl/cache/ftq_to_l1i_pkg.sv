`timescale 1ns/1ps

// e1_ftq_to_l1i_pkg
//
// Coordination interface between the BPU's Fetch Target Queue (FTQ) producer
// (owned by the BPU agent, rtl/cpu/bpu/) and the L1I cache consumer (owned by
// the cache agent, rtl/cache/l1i/).
//
// The BPU runs ahead of fetch, predicts targets, and writes prefetch requests
// into the FTQ. The L1I consumes these as FDIP-style prefetch requests
// (Reinman, Calder, Austin 1999; revisited by Kumar et al. arXiv:2006.13547).
//
// The BPU owns the FTQ producer side. The cache agent does not modify any
// BPU RTL. The two sides agree on the wire-level interface defined below.
//
// Width contract (per request):
//   - 40-bit physical address aligned to 64-byte L1I line boundary
//   - 3-bit confidence (0 = weakest, 7 = strongest taken-branch confidence)
//   - 1-bit branch-target hint (1 if request originates from a branch target,
//     0 if request is sequential or BTB miss recovery)
//
// Channel semantics:
//   - Single-cycle handshake (valid + ready)
//   - L1I MUST NOT speculate beyond what BPU has produced
//   - L1I MUST drop requests on flush (e.g. branch misprediction)
//   - On `flush` pulse, L1I drops any in-flight prefetch, but must not abort
//     in-progress L2 demand fills started by the FTQ request before the flush
//
// HPM events:
//   - L1I emits HPM_L1I_PREFETCH on a successful prefetch fill
//   - L1I does NOT count dropped FTQ requests as accesses
//
// This module declares wire bundle types. Both sides must `import` this
// package and use the typed signals. No logic is implemented here.

package e1_ftq_to_l1i_pkg;

    localparam int unsigned FTQ_PADDR_W       = 40;
    localparam int unsigned FTQ_CONFIDENCE_W  = 3;
    localparam int unsigned FTQ_LINE_BYTES    = 64;

    typedef struct packed {
        logic [FTQ_PADDR_W-1:0]      paddr_line;   // 64 B-aligned
        logic [FTQ_CONFIDENCE_W-1:0] confidence;   // 0..7
        logic                        branch_target;
    } ftq_prefetch_req_t;

    // Convenience initializer for default / quiescent state.
    function automatic ftq_prefetch_req_t ftq_prefetch_req_zero();
        ftq_prefetch_req_zero = '0;
    endfunction

endpackage : e1_ftq_to_l1i_pkg
