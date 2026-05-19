`timescale 1ns/1ps

// e1_lsu_to_l1d_pkg
//
// Coordination interface between the OoO core's Load/Store Unit (LSU) and the
// L1D cache. LSU side is owned by the CPU agent; L1D consumer side is owned
// by the cache agent.
//
// 2028 contract (big core):
//   - 2 read ports × 128-bit (two loads/cycle)
//   - 2 write ports × 128-bit (two stores/cycle — banked)
//   - 4-cycle load-use latency
//   - SECDED ECC on data
//
// The bandwidth is achieved by banking the L1D into 8 banks of 64 B
// (bank = paddr[6:4]). Two independent 128-bit transactions in different
// banks can complete each cycle. Bank conflicts replay the second access on
// the next cycle.
//
// Per-port request fields:
//   - paddr   : 40-bit physical address (post-TLB)
//   - size    : 0=byte, 1=half, 2=word, 3=double, 4=quad-128b
//   - is_load : 1 = load, 0 = store
//   - wdata   : 128-bit write data (ignored on loads)
//   - wstrb   : 16-bit write strobe (ignored on loads)
//   - tag     : LSU tag for tracking, opaque to L1D
//
// Per-port response fields:
//   - rdata   : 128-bit read data (loads only)
//   - tag     : echoed LSU tag
//   - ack     : single-cycle pulse when request completes
//   - replay  : single-cycle pulse when request must be reissued
//                (bank conflict, MSHR pressure, ECC double-bit, etc.)
//
// The LSU owns ordering decisions and store buffer; L1D presents a
// non-blocking 2R/2W view with bank conflicts surfaced as replay.

package e1_lsu_to_l1d_pkg;

    localparam int unsigned L1D_PADDR_W      = 40;
    localparam int unsigned L1D_DATA_W       = 128;
    localparam int unsigned L1D_STRB_W       = L1D_DATA_W / 8;
    localparam int unsigned L1D_SIZE_W       = 3;
    localparam int unsigned L1D_TAG_W        = 8;

    typedef struct packed {
        logic [L1D_PADDR_W-1:0] paddr;
        logic [L1D_SIZE_W-1:0]  size;
        logic                   is_load;
        logic [L1D_DATA_W-1:0]  wdata;
        logic [L1D_STRB_W-1:0]  wstrb;
        logic [L1D_TAG_W-1:0]   tag;
    } lsu_l1d_req_t;

    typedef struct packed {
        logic [L1D_DATA_W-1:0]  rdata;
        logic [L1D_TAG_W-1:0]   tag;
        logic                   ack;
        logic                   replay;
        logic                   ecc_uncorrectable;
    } lsu_l1d_resp_t;

    function automatic lsu_l1d_req_t lsu_l1d_req_zero();
        lsu_l1d_req_zero = '0;
    endfunction

endpackage : e1_lsu_to_l1d_pkg
