`timescale 1ns/1ps

// e1_l1i_cache
//
// L1 instruction cache for the e1 big core.
//
// Default geometry (parameterizable):
//   64 KB total, 8-way set-associative, 64 B line.
//   128 sets per way * 8 ways = 1024 lines * 64 B = 64 KB.
//
// Pipeline:
//   stage 0 : tag read (combinational on incoming vaddr)
//   stage 1 : hit detect, way select, data array read
//   stage 2 : aligned word extract, return rdata
//   stage 3 : LSU/IFU consumes rdata (load-use latency = 4 from request)
//
// Misses inject demand fetch into the L1I-to-L2 manager port (paddr_o,
// l2_*). Refill data arrives line-at-a-time over a 256-bit beat (4 beats
// per 64 B line); the cache stalls on miss and forwards the requested word
// to the IFU as soon as the critical beat arrives ("critical-word-first").
//
// Coherence: L1I is read-only and participates in the directory as a tag
// snoop responder; it accepts back-invalidate (probe inv) but never has
// dirty data so it never sources data.
//
// Parity: each tag and data line carries one parity bit. Parity error on a
// hit forces a miss + refetch and a parity-error HPM pulse. Parity is much
// cheaper than SECDED on L1I (instructions are read-only; refetch is free).
//
// FDIP prefetch: FTQ requests arrive via `ftq_*` (see ftq_to_l1i_pkg.sv).
// Each FTQ request that misses pulls a line through the same miss handler
// but tags the line as "prefetched" until the IFU touches it; an unused
// prefetched line is counted as a wasted-prefetch event when evicted.

module e1_l1i_cache
    import e1_cache_pkg::*;
    import e1_ftq_to_l1i_pkg::*;
#(
    parameter int unsigned SIZE_BYTES = L1I_SIZE_BYTES,
    parameter int unsigned WAYS       = L1I_WAYS,
    parameter int unsigned LINE_BYTES = L1I_LINE_BYTES,
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT,
    parameter int unsigned FETCH_W    = 64    // IFU fetch width in bits
) (
    input  logic                  clk,
    input  logic                  rst_n,

    // -----------------------------------------------------------------
    // IFU request port (read-only; single port, single outstanding)
    // -----------------------------------------------------------------
    input  logic                  ifu_req_valid,
    output logic                  ifu_req_ready,
    input  logic [PADDR_W-1:0]    ifu_req_paddr,
    input  logic                  ifu_flush,      // pulse: drop in-flight & prefetches
    output logic                  ifu_resp_valid,
    output logic [FETCH_W-1:0]    ifu_resp_data,
    output logic                  ifu_resp_paddr_eq_req,

    // Optional secondary IFU demand lane for non-contiguous fetch. Hits return
    // in parallel with lane 0. A cold lane-1 target is accepted into a small
    // ordered pending slot and can drain through the lane-1 miss/refill channel
    // independently of the scalar IFU/prefetch miss pipe.
    input  logic                  ifu_req_valid_lane1,
    output logic                  ifu_req_ready_lane1,
    input  logic [PADDR_W-1:0]    ifu_req_paddr_lane1,
    output logic                  ifu_resp_valid_lane1,
    output logic [FETCH_W-1:0]    ifu_resp_data_lane1,
    output logic                  ifu_resp_paddr_eq_req_lane1,

    // -----------------------------------------------------------------
    // FDIP / FTQ prefetch request port
    // -----------------------------------------------------------------
    input  logic                  ftq_req_valid,
    output logic                  ftq_req_ready,
    input  ftq_prefetch_req_t     ftq_req,

    // -----------------------------------------------------------------
    // L1I -> L2 miss request channel (one scalar outstanding line fill)
    //
    // miss_valid       : assert when L1I needs a line
    // miss_paddr_line  : 64 B-aligned line address
    // miss_is_prefetch : 1 if request originated from FTQ prefetch
    // -----------------------------------------------------------------
    output logic                  miss_valid,
    input  logic                  miss_ready,
    output logic [PADDR_W-1:0]    miss_paddr_line,
    output logic                  miss_is_prefetch,

    // Refill data return (4 beats of 128 bits = 512 bits per line)
    input  logic                  refill_valid,
    output logic                  refill_ready,
    input  logic [127:0]          refill_data,
    input  logic [1:0]            refill_beat_idx, // 0..3
    input  logic                  refill_last,

    // Secondary lane-1 demand miss/refill channel. This port is lane-1 demand
    // only; FTQ prefetches continue to use the scalar miss pipe.
    output logic                  miss_valid_lane1,
    input  logic                  miss_ready_lane1,
    output logic [PADDR_W-1:0]    miss_paddr_line_lane1,
    output logic                  miss_is_prefetch_lane1,

    input  logic                  refill_valid_lane1,
    output logic                  refill_ready_lane1,
    input  logic [127:0]          refill_data_lane1,
    input  logic [1:0]            refill_beat_idx_lane1,
    input  logic                  refill_last_lane1,

    // -----------------------------------------------------------------
    // Probe (back-invalidate) from L2 / coherence engine
    // -----------------------------------------------------------------
    input  logic                  probe_valid,
    output logic                  probe_ready,
    input  logic [PADDR_W-1:0]    probe_paddr_line,
    output logic                  probe_ack,

    // -----------------------------------------------------------------
    // HPM events (1-cycle pulses)
    // -----------------------------------------------------------------
    output logic                  hpm_l1i_access,
    output logic                  hpm_l1i_miss,
    output logic                  hpm_l1i_prefetch
);

    // -----------------------------------------------------------------
    // Derived geometry
    // -----------------------------------------------------------------
    localparam int unsigned SETS       = SIZE_BYTES / (WAYS * LINE_BYTES);
    localparam int unsigned INDEX_W    = $clog2(SETS);
    localparam int unsigned OFFSET_W   = $clog2(LINE_BYTES);
    localparam int unsigned TAG_W      = PADDR_W - INDEX_W - OFFSET_W;
    localparam int unsigned LINE_BITS  = 8 * LINE_BYTES;
    localparam int unsigned BEAT_BITS  = 128;
    localparam int unsigned BEATS_PER_LINE = LINE_BITS / BEAT_BITS;
    /* verilator lint_off UNUSEDPARAM */
    localparam int unsigned BEAT_IDX_W = $clog2(BEATS_PER_LINE);
    /* verilator lint_on UNUSEDPARAM */

    function automatic logic [INDEX_W-1:0] addr_index(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W +: INDEX_W];
    endfunction
    function automatic logic [TAG_W-1:0] addr_tag(input logic [PADDR_W-1:0] a);
        return a[PADDR_W-1 -: TAG_W];
    endfunction
    function automatic logic [OFFSET_W-1:0] addr_offset(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W-1:0];
    endfunction

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------
    logic [TAG_W-1:0] tag_array [WAYS][SETS];
    logic             vld_array [WAYS][SETS];
    logic             pfb_array [WAYS][SETS];   // prefetched-but-untouched bit
    logic             par_array [WAYS][SETS];   // parity over tag+data
    logic [LINE_BITS-1:0] data_array [WAYS][SETS];

    // Pseudo-LRU bits per set, NRU-class for low area on L1.
    // For 8-way: 7 PLRU bits (tree pseudo-LRU).
    logic [WAYS-2:0] plru [SETS];

    // -----------------------------------------------------------------
    // Lookup pipeline registers
    // -----------------------------------------------------------------
    logic                  s0_valid_q;
    logic [PADDR_W-1:0]    s0_paddr_q;
    logic                  s0_is_prefetch_q;
    logic                  s0_resp_lane1_q;

    logic                  s1_valid_q;
    logic [PADDR_W-1:0]    s1_paddr_q;
    logic                  s1_is_prefetch_q;
    logic                  s1_resp_lane1_q;
    logic                  s1_hit_q;
    logic [$clog2(WAYS)-1:0] s1_hit_way_q;
    logic [LINE_BITS-1:0]  s1_line_q;
    logic                  s1_parity_bad_q;

    // -----------------------------------------------------------------
    // Miss state machine
    // -----------------------------------------------------------------
    typedef enum logic [2:0] {
        MS_IDLE,
        MS_REQ,
        MS_FILL,
        MS_RESP
    } miss_state_e;
    miss_state_e               miss_state_q;
    logic [PADDR_W-1:0]        miss_paddr_q;
    logic                      miss_is_pf_q;
    logic                      miss_resp_lane1_q;
    logic [LINE_BITS-1:0]      miss_line_buf_q;
    logic [BEATS_PER_LINE-1:0] miss_beat_seen_q;
    logic [$clog2(WAYS)-1:0]   miss_victim_way_q;

    miss_state_e               lane1_miss_state_q;
    logic [PADDR_W-1:0]        lane1_miss_active_paddr_q;
    logic [LINE_BITS-1:0]      lane1_miss_line_buf_q;
    logic [BEATS_PER_LINE-1:0] lane1_miss_beat_seen_q;
    logic [$clog2(WAYS)-1:0]   lane1_miss_victim_way_q;

    // -----------------------------------------------------------------
    // s0 stage: pick a request source and read tag array
    //
    // Priority: IFU demand > FTQ prefetch. Demand never blocked by
    // prefetch when an MSHR slot is free.
    // -----------------------------------------------------------------
    logic        s0_can_accept;
    logic        s0_select_lane1_pending;
    logic        s0_select_demand;
    logic        s0_select_pf;
    logic        lane1_miss_pending_q;
    logic [PADDR_W-1:0] lane1_miss_paddr_q;

    assign s0_can_accept   = (miss_state_q == MS_IDLE) && !s0_valid_q;
    assign s0_select_lane1_pending = 1'b0;
    assign s0_select_demand = s0_can_accept && !lane1_miss_pending_q && ifu_req_valid;
    assign s0_select_pf     = s0_can_accept && !lane1_miss_pending_q &&
                              !ifu_req_valid && ftq_req_valid;
    assign ifu_req_ready    = s0_can_accept && !lane1_miss_pending_q;
    assign ftq_req_ready    = s0_can_accept && !lane1_miss_pending_q &&
                              !ifu_req_valid;

    // -----------------------------------------------------------------
    // s1 stage: tag compare and way select
    // -----------------------------------------------------------------
    logic [WAYS-1:0]            hit_vec_c;
    logic                       hit_any_c;
    logic [$clog2(WAYS)-1:0]    hit_way_c;
    logic [LINE_BITS-1:0]       sel_line_c;
    logic                       sel_parity_c;

    always_comb begin
        hit_vec_c = '0;
        hit_way_c = '0;
        sel_line_c = '0;
        sel_parity_c = 1'b0;
        for (int w = 0; w < WAYS; w++) begin
            if (vld_array[w][addr_index(s0_paddr_q)] &&
                tag_array[w][addr_index(s0_paddr_q)] == addr_tag(s0_paddr_q)) begin
                hit_vec_c[w] = 1'b1;
            end
        end
        hit_any_c = |hit_vec_c;
        for (int w = 0; w < WAYS; w++) begin
            if (hit_vec_c[w]) begin
                hit_way_c    = w[$clog2(WAYS)-1:0];
                sel_line_c   = data_array[w][addr_index(s0_paddr_q)];
                sel_parity_c = par_array[w][addr_index(s0_paddr_q)];
            end
        end
    end

    function automatic logic compute_parity(input logic [LINE_BITS-1:0] line,
                                             input logic [TAG_W-1:0] tag);
        compute_parity = ^{line, tag};
    endfunction

    logic s1_parity_expected_c;
    assign s1_parity_expected_c = compute_parity(sel_line_c,
                                                 addr_tag(s0_paddr_q));
    logic s1_parity_bad_c;
    assign s1_parity_bad_c = hit_any_c && (s1_parity_expected_c != sel_parity_c);

    // -----------------------------------------------------------------
    // Secondary demand lane: parallel hit-only lookup.
    // -----------------------------------------------------------------
    logic [WAYS-1:0]            lane1_hit_vec_c;
    logic                       lane1_hit_any_c;
    logic [$clog2(WAYS)-1:0]    lane1_hit_way_c;
    logic [LINE_BITS-1:0]       lane1_line_c;
    logic                       lane1_parity_c;
    logic                       lane1_parity_expected_c;
    logic                       lane1_parity_bad_c;
    logic [OFFSET_W-1:0]        lane1_off_c;
    logic [FETCH_W-1:0]         lane1_word_c;
    logic                       lane1_accept_c;
    logic                       lane1_accept_hit_c;
    logic                       lane1_accept_miss_c;

    always_comb begin
        lane1_hit_vec_c = '0;
        lane1_hit_way_c = '0;
        lane1_line_c = '0;
        lane1_parity_c = 1'b0;
        for (int w = 0; w < WAYS; w++) begin
            if (vld_array[w][addr_index(ifu_req_paddr_lane1)] &&
                tag_array[w][addr_index(ifu_req_paddr_lane1)] ==
                    addr_tag(ifu_req_paddr_lane1)) begin
                lane1_hit_vec_c[w] = 1'b1;
            end
        end
        lane1_hit_any_c = |lane1_hit_vec_c;
        for (int w = 0; w < WAYS; w++) begin
            if (lane1_hit_vec_c[w]) begin
                lane1_hit_way_c = w[$clog2(WAYS)-1:0];
                lane1_line_c = data_array[w][addr_index(ifu_req_paddr_lane1)];
                lane1_parity_c = par_array[w][addr_index(ifu_req_paddr_lane1)];
            end
        end
    end

    assign lane1_parity_expected_c = compute_parity(
        lane1_line_c, addr_tag(ifu_req_paddr_lane1));
    assign lane1_parity_bad_c =
        lane1_hit_any_c && (lane1_parity_expected_c != lane1_parity_c);
    assign lane1_accept_hit_c =
        s0_select_demand && ifu_req_valid_lane1 &&
        lane1_hit_any_c && !lane1_parity_bad_c && !ifu_flush;
    assign lane1_accept_miss_c =
        s0_select_demand && ifu_req_valid_lane1 &&
        (!lane1_hit_any_c || lane1_parity_bad_c) &&
        !lane1_miss_pending_q && (lane1_miss_state_q == MS_IDLE) && !ifu_flush;
    assign lane1_accept_c = lane1_accept_hit_c || lane1_accept_miss_c;
    assign ifu_req_ready_lane1 = lane1_accept_c;

    assign lane1_off_c = addr_offset(ifu_req_paddr_lane1);
    always_comb begin
        lane1_word_c = '0;
        for (int b = 0; b < FETCH_W; b++) begin
            automatic int unsigned bit_idx = (32'(lane1_off_c) * 8) + b;
            if (bit_idx < LINE_BITS)
                lane1_word_c[b] = lane1_line_c[bit_idx];
        end
    end

    // -----------------------------------------------------------------
    // Victim selection (tree-PLRU). On 8 ways, 7-bit tree; we use a small
    // synthesizable reduction.
    // -----------------------------------------------------------------
    function automatic logic [$clog2(WAYS)-1:0] plru_victim
        (input logic [WAYS-2:0] tree);
        logic [$clog2(WAYS)-1:0] way;
        int unsigned node;
        node = 0;
        way  = '0;
        for (int level = 0; level < $clog2(WAYS); level++) begin
            way[$clog2(WAYS)-1-level] = tree[node];
            node = (node * 2) + 1 + (tree[node] ? 1 : 0);
        end
        return way;
    endfunction

    function automatic logic [WAYS-2:0] plru_update
        (input logic [WAYS-2:0] tree, input logic [$clog2(WAYS)-1:0] way);
        logic [WAYS-2:0] next_tree;
        int unsigned node;
        next_tree = tree;
        node = 0;
        for (int level = 0; level < $clog2(WAYS); level++) begin
            // Flip child opposite of the touched way's bit at this level
            next_tree[node] = ~way[$clog2(WAYS)-1-level];
            node = (node * 2) + 1 +
                   (way[$clog2(WAYS)-1-level] ? 1 : 0);
        end
        return next_tree;
    endfunction

    // -----------------------------------------------------------------
    // Probe (back-invalidate). One-cycle: lookup, invalidate any matching
    // way, ack. Probes have priority over fills only when not mid-fill.
    // -----------------------------------------------------------------
    logic [INDEX_W-1:0] probe_idx_c;
    logic [TAG_W-1:0]   probe_tag_c;
    assign probe_idx_c = addr_index(probe_paddr_line);
    assign probe_tag_c = addr_tag(probe_paddr_line);
    assign probe_ready = (miss_state_q != MS_FILL) &&
                         (lane1_miss_state_q != MS_FILL);
    // probe_ack is asserted in the always_ff below

    // -----------------------------------------------------------------
    // Output (IFU response) word selection
    // -----------------------------------------------------------------
    logic [OFFSET_W-1:0] s1_off_c;
    assign s1_off_c = addr_offset(s1_paddr_q);
    logic [FETCH_W-1:0]  s1_word_c;
    always_comb begin
        s1_word_c = '0;
        // Extract FETCH_W bits at bit offset (s1_off_c * 8)
        for (int b = 0; b < FETCH_W; b++) begin
            automatic int unsigned bit_idx = (32'(s1_off_c) * 8) + b;
            if (bit_idx < LINE_BITS)
                s1_word_c[b] = s1_line_q[bit_idx];
        end
    end

    // -----------------------------------------------------------------
    // Sequential logic
    // -----------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tag_array  <= '{default: '{default: '0}};
            vld_array  <= '{default: '{default: 1'b0}};
            pfb_array  <= '{default: '{default: 1'b0}};
            par_array  <= '{default: '{default: 1'b0}};
            data_array <= '{default: '{default: '0}};
            plru       <= '{default: '0};

            s0_valid_q <= 1'b0;
            s0_paddr_q <= '0;
            s0_is_prefetch_q <= 1'b0;
            s0_resp_lane1_q <= 1'b0;

            s1_valid_q <= 1'b0;
            s1_paddr_q <= '0;
            s1_is_prefetch_q <= 1'b0;
            s1_resp_lane1_q <= 1'b0;
            s1_hit_q <= 1'b0;
            s1_hit_way_q <= '0;
            s1_line_q <= '0;
            s1_parity_bad_q <= 1'b0;

            miss_state_q     <= MS_IDLE;
            miss_paddr_q     <= '0;
            miss_is_pf_q     <= 1'b0;
            miss_resp_lane1_q <= 1'b0;
            miss_line_buf_q  <= '0;
            miss_beat_seen_q <= '0;
            miss_victim_way_q <= '0;
            lane1_miss_state_q <= MS_IDLE;
            lane1_miss_active_paddr_q <= '0;
            lane1_miss_line_buf_q <= '0;
            lane1_miss_beat_seen_q <= '0;
            lane1_miss_victim_way_q <= '0;
            lane1_miss_pending_q <= 1'b0;
            lane1_miss_paddr_q <= '0;

            ifu_resp_valid    <= 1'b0;
            ifu_resp_data     <= '0;
            ifu_resp_paddr_eq_req <= 1'b0;
            ifu_resp_valid_lane1 <= 1'b0;
            ifu_resp_data_lane1 <= '0;
            ifu_resp_paddr_eq_req_lane1 <= 1'b0;

            miss_valid       <= 1'b0;
            miss_paddr_line  <= '0;
            miss_is_prefetch <= 1'b0;
            refill_ready     <= 1'b1;
            miss_valid_lane1 <= 1'b0;
            miss_paddr_line_lane1 <= '0;
            miss_is_prefetch_lane1 <= 1'b0;
            refill_ready_lane1 <= 1'b1;

            probe_ack        <= 1'b0;

            hpm_l1i_access   <= 1'b0;
            hpm_l1i_miss     <= 1'b0;
            hpm_l1i_prefetch <= 1'b0;
        end else begin
            // Default 1-cycle pulses
            hpm_l1i_access   <= 1'b0;
            hpm_l1i_miss     <= 1'b0;
            hpm_l1i_prefetch <= 1'b0;
            probe_ack        <= 1'b0;
            ifu_resp_valid   <= 1'b0;
            ifu_resp_valid_lane1 <= 1'b0;

            // ------ Flush handling ------
            if (ifu_flush) begin
                s0_valid_q       <= 1'b0;
                s1_valid_q       <= 1'b0;
                s0_resp_lane1_q  <= 1'b0;
                s1_resp_lane1_q  <= 1'b0;
                lane1_miss_pending_q <= 1'b0;
                // Cancel any in-progress prefetch miss, but allow in-progress
                // demand miss to complete (its target may still be needed,
                // and tearing down mid-FILL leaves the line in an
                // inconsistent state in the L2 channel).
                if (miss_state_q == MS_REQ && miss_is_pf_q) begin
                    miss_valid   <= 1'b0;
                    miss_state_q <= MS_IDLE;
                end
                if (lane1_miss_state_q == MS_REQ) begin
                    miss_valid_lane1 <= 1'b0;
                    lane1_miss_state_q <= MS_IDLE;
                end
            end

            // ------ Secondary IFU hit lane ------
            if (lane1_accept_hit_c) begin
                ifu_resp_valid_lane1 <= 1'b1;
                ifu_resp_data_lane1 <= lane1_word_c;
                ifu_resp_paddr_eq_req_lane1 <= 1'b1;
                if (pfb_array[lane1_hit_way_c][addr_index(ifu_req_paddr_lane1)]) begin
                    pfb_array[lane1_hit_way_c][addr_index(ifu_req_paddr_lane1)] <= 1'b0;
                    hpm_l1i_prefetch <= 1'b1;
                end
                plru[addr_index(ifu_req_paddr_lane1)] <=
                    plru_update(plru[addr_index(ifu_req_paddr_lane1)],
                                lane1_hit_way_c);
            end else if (lane1_accept_miss_c) begin
                lane1_miss_pending_q <= 1'b1;
                lane1_miss_paddr_q <= {ifu_req_paddr_lane1[PADDR_W-1:OFFSET_W],
                                       {OFFSET_W{1'b0}}};
                hpm_l1i_access <= 1'b1;
            end

            // ------ s0 enqueue ------
            if (s0_select_lane1_pending && !ifu_flush) begin
                s0_valid_q       <= 1'b1;
                s0_paddr_q       <= lane1_miss_paddr_q;
                s0_is_prefetch_q <= 1'b0;
                s0_resp_lane1_q  <= 1'b1;
                lane1_miss_pending_q <= 1'b0;
            end else if (s0_select_demand && !ifu_flush) begin
                s0_valid_q       <= 1'b1;
                s0_paddr_q       <= ifu_req_paddr;
                s0_is_prefetch_q <= 1'b0;
                s0_resp_lane1_q  <= 1'b0;
                hpm_l1i_access   <= 1'b1;
            end else if (s0_select_pf && !ifu_flush) begin
                s0_valid_q       <= 1'b1;
                s0_paddr_q       <= {ftq_req.paddr_line[PADDR_W-1:OFFSET_W],
                                     {OFFSET_W{1'b0}}};
                s0_is_prefetch_q <= 1'b1;
                s0_resp_lane1_q  <= 1'b0;
            end else if (s1_valid_q || miss_state_q != MS_IDLE) begin
                // Wait
            end else begin
                s0_valid_q <= 1'b0;
                s0_resp_lane1_q <= 1'b0;
            end

            // ------ s0 -> s1 advance (tag compare done) ------
            if (s0_valid_q && !ifu_flush) begin
                s1_valid_q       <= 1'b1;
                s1_paddr_q       <= s0_paddr_q;
                s1_is_prefetch_q <= s0_is_prefetch_q;
                s1_resp_lane1_q  <= s0_resp_lane1_q;
                s1_hit_q         <= hit_any_c && !s1_parity_bad_c;
                s1_hit_way_q     <= hit_way_c;
                s1_line_q        <= sel_line_c;
                s1_parity_bad_q  <= s1_parity_bad_c;
                s0_valid_q       <= 1'b0;
                s0_resp_lane1_q  <= 1'b0;

                // On hit, mark prefetched-bit-touched (FTQ prefetch became
                // "useful").
                if (hit_any_c && !s1_parity_bad_c && !s0_is_prefetch_q) begin
                    if (pfb_array[hit_way_c][addr_index(s0_paddr_q)]) begin
                        pfb_array[hit_way_c][addr_index(s0_paddr_q)] <= 1'b0;
                        hpm_l1i_prefetch <= 1'b1;
                    end
                    // Update PLRU on hit
                    plru[addr_index(s0_paddr_q)] <=
                        plru_update(plru[addr_index(s0_paddr_q)], hit_way_c);
                end
            end

            // ------ s1: deliver hit, or kick off miss ------
            if (s1_valid_q && !ifu_flush) begin
                if (s1_hit_q && !s1_is_prefetch_q) begin
                    if (s1_resp_lane1_q) begin
                        ifu_resp_valid_lane1 <= 1'b1;
                        ifu_resp_data_lane1 <= s1_word_c;
                        ifu_resp_paddr_eq_req_lane1 <= 1'b1;
                    end else begin
                        ifu_resp_valid        <= 1'b1;
                        ifu_resp_data         <= s1_word_c;
                        ifu_resp_paddr_eq_req <= 1'b1;
                    end
                    s1_valid_q            <= 1'b0;
                end else if (s1_hit_q && s1_is_prefetch_q) begin
                    // Prefetch hit: nothing to do, drop request silently
                    s1_valid_q <= 1'b0;
                end else if (!s1_hit_q && miss_state_q == MS_IDLE) begin
                    miss_state_q     <= MS_REQ;
                    miss_paddr_q     <= {s1_paddr_q[PADDR_W-1:OFFSET_W],
                                         {OFFSET_W{1'b0}}};
                    miss_is_pf_q     <= s1_is_prefetch_q;
                    miss_resp_lane1_q <= s1_resp_lane1_q;
                    miss_victim_way_q <= plru_victim(plru[addr_index(s1_paddr_q)]);
                    hpm_l1i_miss     <= !s1_is_prefetch_q;
                    s1_valid_q       <= 1'b0;
                end
                if (s1_parity_bad_q && !s1_is_prefetch_q) begin
                    // Treat parity error as a miss: refetch from L2
                    miss_state_q     <= MS_REQ;
                    miss_paddr_q     <= {s1_paddr_q[PADDR_W-1:OFFSET_W],
                                         {OFFSET_W{1'b0}}};
                    miss_is_pf_q     <= 1'b0;
                    miss_resp_lane1_q <= s1_resp_lane1_q;
                    miss_victim_way_q <= s1_hit_way_q;
                    hpm_l1i_miss     <= 1'b1;
                    s1_valid_q       <= 1'b0;
                end
            end

            // ------ Secondary lane-1 miss state machine ------
            if (lane1_miss_pending_q && lane1_miss_state_q == MS_IDLE && !ifu_flush) begin
                lane1_miss_state_q <= MS_REQ;
                lane1_miss_active_paddr_q <= lane1_miss_paddr_q;
                lane1_miss_victim_way_q <=
                    plru_victim(plru[addr_index(lane1_miss_paddr_q)]);
                lane1_miss_pending_q <= 1'b0;
            end

            case (lane1_miss_state_q)
                MS_IDLE: begin
                    miss_valid_lane1 <= 1'b0;
                    miss_paddr_line_lane1 <= '0;
                    miss_is_prefetch_lane1 <= 1'b0;
                end
                MS_REQ: begin
                    if (!miss_valid_lane1) begin
                        miss_valid_lane1 <= 1'b1;
                        miss_paddr_line_lane1 <= lane1_miss_active_paddr_q;
                        miss_is_prefetch_lane1 <= 1'b0;
                    end else if (miss_ready_lane1) begin
                        miss_valid_lane1 <= 1'b0;
                        lane1_miss_state_q <= MS_FILL;
                        lane1_miss_beat_seen_q <= '0;
                        lane1_miss_line_buf_q <= '0;
                    end
                end
                MS_FILL: begin
                    if (refill_valid_lane1 && refill_ready_lane1) begin
                        lane1_miss_line_buf_q[
                            refill_beat_idx_lane1*BEAT_BITS +: BEAT_BITS
                        ] <= refill_data_lane1;
                        lane1_miss_beat_seen_q[refill_beat_idx_lane1] <= 1'b1;
                        if (refill_last_lane1) begin
                            lane1_miss_state_q <= MS_RESP;
                        end
                    end
                end
                MS_RESP: begin
                    tag_array[lane1_miss_victim_way_q]
                        [addr_index(lane1_miss_active_paddr_q)]
                        <= addr_tag(lane1_miss_active_paddr_q);
                    vld_array[lane1_miss_victim_way_q]
                        [addr_index(lane1_miss_active_paddr_q)]
                        <= 1'b1;
                    data_array[lane1_miss_victim_way_q]
                        [addr_index(lane1_miss_active_paddr_q)]
                        <= lane1_miss_line_buf_q;
                    par_array[lane1_miss_victim_way_q]
                        [addr_index(lane1_miss_active_paddr_q)]
                        <= compute_parity(
                            lane1_miss_line_buf_q,
                            addr_tag(lane1_miss_active_paddr_q)
                        );
                    pfb_array[lane1_miss_victim_way_q]
                        [addr_index(lane1_miss_active_paddr_q)]
                        <= 1'b0;
                    plru[addr_index(lane1_miss_active_paddr_q)] <=
                        plru_update(
                            plru[addr_index(lane1_miss_active_paddr_q)],
                            lane1_miss_victim_way_q
                        );

                    ifu_resp_valid_lane1 <= 1'b1;
                    ifu_resp_paddr_eq_req_lane1 <= 1'b1;
                    for (int b = 0; b < FETCH_W; b++) begin
                        automatic int unsigned bit_idx =
                            (32'(addr_offset(lane1_miss_active_paddr_q)) * 8) + b;
                        if (bit_idx < LINE_BITS)
                            ifu_resp_data_lane1[b] <=
                                lane1_miss_line_buf_q[bit_idx];
                    end
                    lane1_miss_state_q <= MS_IDLE;
                end
                default: lane1_miss_state_q <= MS_IDLE;
            endcase

            // ------ Miss state machine ------
            case (miss_state_q)
                MS_IDLE: begin
                    miss_valid       <= 1'b0;
                    miss_paddr_line  <= '0;
                    miss_is_prefetch <= 1'b0;
                end
                MS_REQ: begin
                    if (!miss_valid) begin
                        miss_valid       <= 1'b1;
                        miss_paddr_line  <= miss_paddr_q;
                        miss_is_prefetch <= miss_is_pf_q;
                    end else if (miss_ready) begin
                        miss_valid       <= 1'b0;
                        miss_state_q     <= MS_FILL;
                        miss_beat_seen_q <= '0;
                        miss_line_buf_q  <= '0;
                    end
                end
                MS_FILL: begin
                    if (refill_valid && refill_ready) begin
                        miss_line_buf_q[refill_beat_idx*BEAT_BITS +: BEAT_BITS]
                            <= refill_data;
                        miss_beat_seen_q[refill_beat_idx] <= 1'b1;
                        if (refill_last) begin
                            miss_state_q <= MS_RESP;
                        end
                    end
                end
                MS_RESP: begin
                    // Commit line into chosen victim way
                    tag_array[miss_victim_way_q][addr_index(miss_paddr_q)]
                        <= addr_tag(miss_paddr_q);
                    vld_array[miss_victim_way_q][addr_index(miss_paddr_q)]
                        <= 1'b1;
                    data_array[miss_victim_way_q][addr_index(miss_paddr_q)]
                        <= miss_line_buf_q;
                    par_array[miss_victim_way_q][addr_index(miss_paddr_q)]
                        <= compute_parity(miss_line_buf_q,
                                          addr_tag(miss_paddr_q));
                    pfb_array[miss_victim_way_q][addr_index(miss_paddr_q)]
                        <= miss_is_pf_q;
                    plru[addr_index(miss_paddr_q)] <=
                        plru_update(plru[addr_index(miss_paddr_q)],
                                    miss_victim_way_q);

                    if (!miss_is_pf_q) begin
                        // Critical-word-first delivery: synthesize a hit
                        // response from the just-filled line.
                        if (miss_resp_lane1_q) begin
                            ifu_resp_valid_lane1 <= 1'b1;
                            ifu_resp_paddr_eq_req_lane1 <= 1'b1;
                            for (int b = 0; b < FETCH_W; b++) begin
                                automatic int unsigned bit_idx =
                                    (32'(addr_offset(miss_paddr_q)) * 8) + b;
                                if (bit_idx < LINE_BITS)
                                    ifu_resp_data_lane1[b] <= miss_line_buf_q[bit_idx];
                            end
                        end else begin
                            ifu_resp_valid <= 1'b1;
                            ifu_resp_paddr_eq_req <= 1'b1;
                            for (int b = 0; b < FETCH_W; b++) begin
                                automatic int unsigned bit_idx =
                                    (32'(addr_offset(miss_paddr_q)) * 8) + b;
                                if (bit_idx < LINE_BITS)
                                    ifu_resp_data[b] <= miss_line_buf_q[bit_idx];
                            end
                        end
                    end
                    miss_state_q <= MS_IDLE;
                    miss_resp_lane1_q <= 1'b0;
                end
                default: miss_state_q <= MS_IDLE;
            endcase

            // ------ Probe (back-invalidate) ------
            if (probe_valid && probe_ready) begin
                for (int w = 0; w < WAYS; w++) begin
                    if (vld_array[w][probe_idx_c] &&
                        tag_array[w][probe_idx_c] == probe_tag_c) begin
                        vld_array[w][probe_idx_c] <= 1'b0;
                    end
                end
                probe_ack <= 1'b1;
            end
        end
    end

endmodule
