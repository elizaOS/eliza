`timescale 1ns/1ps

// e1_l1d_cache
//
// L1 data cache for the e1 big core.
//
// Default geometry (parameterizable):
//   64 KB total, 8-way, 64 B line, 128 sets.
//
// Bandwidth: 2 read ports + 2 write ports (independent), 128-bit each, via
// 8 banks (bank = paddr[6:4]). Two requests in the same bank cause the
// second to replay. SECDED (72,64) ECC per 64-bit word.
//
// Coherence: MESI on TileLink TL-C. L1D may hold lines in M/E/S, transitions
// to I on probe inv, and downgrades M->S on probe shr (writes back dirty).
//
// Miss handler: 4-entry MSHR for non-blocking misses. Each MSHR tracks one
// outstanding line fill plus a small per-MSHR pending-request FIFO
// (MSHR_PEND_DEPTH deep) so secondary misses on the same line coalesce onto
// the primary MSHR instead of allocating a second entry or issuing a second
// L2 acquire. The FIFO records each coalesced secondary request's LSU tag
// and load/store class. After the primary fill installs the line, the FIFO
// is drained one entry per idle port-0 cycle: each coalesced tag is replayed
// to the LSU so the request is re-presented against the now-resident line.
// The MSHR frees once its fill is done and its FIFO is empty.
//
// This is the canonical pipeline:
//   stage 0 : LSU presents request, TLB-translated paddr already supplied
//   stage 1 : tag read, bank arbitrate, data read
//   stage 2 : hit detect + ECC check (correct single-bit, flag double)
//   stage 3 : LSU consumes rdata (load-use = 4)

module e1_l1d_cache
    import e1_cache_pkg::*;
    import e1_lsu_to_l1d_pkg::*;
#(
    parameter int unsigned SIZE_BYTES = L1D_SIZE_BYTES,
    parameter int unsigned WAYS       = L1D_WAYS,
    parameter int unsigned LINE_BYTES = L1D_LINE_BYTES,
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT,
    parameter int unsigned BANKS      = 8,
    parameter int unsigned MSHR_DEPTH = 4,
    parameter int unsigned MSHR_PEND_DEPTH = 2  // per-MSHR secondary-miss FIFO
) (
    input  logic                  clk,
    input  logic                  rst_n,

    // 2 read/2 write ports from LSU
    input  logic                  lsu_p0_valid,
    output logic                  lsu_p0_ready,
    input  lsu_l1d_req_t          lsu_p0_req,
    output logic                  lsu_p0_resp_valid,
    output lsu_l1d_resp_t         lsu_p0_resp,

    input  logic                  lsu_p1_valid,
    output logic                  lsu_p1_ready,
    input  lsu_l1d_req_t          lsu_p1_req,
    output logic                  lsu_p1_resp_valid,
    output lsu_l1d_resp_t         lsu_p1_resp,

    // L1D <-> L2 line interface
    output logic                  l2_acq_valid,
    input  logic                  l2_acq_ready,
    output logic [PADDR_W-1:0]    l2_acq_paddr_line,
    output logic                  l2_acq_is_write, // 1 = release/writeback, 0 = acquire
    output mesi_e                 l2_acq_request_state, // requested upgrade
    output logic [8*LINE_BYTES-1:0] l2_acq_wb_data,
    input  logic                  l2_grant_valid,
    output logic                  l2_grant_ready,
    input  logic [PADDR_W-1:0]    l2_grant_paddr_line,
    input  logic [8*LINE_BYTES-1:0] l2_grant_data,
    input  mesi_e                 l2_grant_state,

    // Probe interface
    input  logic                  probe_valid,
    output logic                  probe_ready,
    input  logic [PADDR_W-1:0]    probe_paddr_line,
    input  mesi_e                 probe_target_state, // S or I
    output logic                  probe_ack,
    output logic                  probe_has_data,
    output logic [8*LINE_BYTES-1:0] probe_wb_data,
    output mesi_e                 probe_final_state,

    // HPM events
    output logic                  hpm_l1d_access,
    output logic                  hpm_l1d_miss,
    output logic                  hpm_l1d_ecc_corr,
    output logic                  hpm_l1d_ecc_uncorr
);

    // -----------------------------------------------------------------
    // Derived geometry
    // -----------------------------------------------------------------
    localparam int unsigned SETS         = SIZE_BYTES / (WAYS * LINE_BYTES);
    localparam int unsigned INDEX_W      = $clog2(SETS);
    localparam int unsigned OFFSET_W     = $clog2(LINE_BYTES);
    localparam int unsigned TAG_W        = PADDR_W - INDEX_W - OFFSET_W;
    localparam int unsigned LINE_BITS    = 8 * LINE_BYTES;
    localparam int unsigned WORDS_PER_LINE = LINE_BYTES / 8;
    localparam int unsigned BANK_W       = $clog2(BANKS);
    localparam int unsigned BANK_SHIFT   = $clog2(LINE_BYTES / BANKS); // typically 3 for 64 B / 8 banks
    localparam int unsigned MSHR_IDX_W   = $clog2(MSHR_DEPTH);

    function automatic logic [INDEX_W-1:0] addr_index(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W +: INDEX_W];
    endfunction
    function automatic logic [TAG_W-1:0] addr_tag(input logic [PADDR_W-1:0] a);
        return a[PADDR_W-1 -: TAG_W];
    endfunction
    function automatic logic [BANK_W-1:0] addr_bank(input logic [PADDR_W-1:0] a);
        return a[BANK_SHIFT +: BANK_W];
    endfunction

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------
    logic [TAG_W-1:0] tag_array  [WAYS][SETS];
    mesi_e            state_array [WAYS][SETS];
    // Data: one 64-bit word + 8-bit ECC per word, WORDS_PER_LINE words per line.
    logic [63:0]      data_array [WAYS][SETS][WORDS_PER_LINE];
    logic [7:0]       ecc_array  [WAYS][SETS][WORDS_PER_LINE];
    logic [WAYS-2:0]  plru [SETS];

    // -----------------------------------------------------------------
    // MSHR
    // -----------------------------------------------------------------
    typedef struct packed {
        logic                  valid;
        logic [PADDR_W-1:0]    paddr_line;
        mesi_e                 req_state;
        logic                  is_write;
        logic [LINE_BITS-1:0]  wb_data;
        logic [$clog2(WAYS)-1:0] victim_way;
        logic [INDEX_W-1:0]    set_idx;
        logic                  granted;
    } mshr_t;

    mshr_t mshr [MSHR_DEPTH];

    // Per-MSHR pending-request FIFO for secondary misses on the same line.
    // A secondary miss does not allocate a new MSHR or issue a second
    // acquire; it enqueues here against the primary MSHR. Each slot records
    // the coalesced request's LSU tag and load/store class.
    //
    // After the line fills, the FIFO is drained one entry per idle port-0
    // cycle: each coalesced request's LSU tag is replayed so the LSU
    // re-presents it against the now-resident line. The MSHR is freed once
    // its primary fill is done and the FIFO is empty.
    localparam int unsigned PEND_CNT_W = $clog2(MSHR_PEND_DEPTH + 1);
    localparam int unsigned PEND_IDX_W = (MSHR_PEND_DEPTH > 1) ? $clog2(MSHR_PEND_DEPTH) : 1;
    logic [PEND_CNT_W-1:0]  mshr_pend_count [MSHR_DEPTH];
    logic [PEND_IDX_W-1:0]  mshr_pend_head  [MSHR_DEPTH];
    logic                   mshr_filled     [MSHR_DEPTH];
    logic [L1D_TAG_W-1:0]   mshr_pend_tag   [MSHR_DEPTH][MSHR_PEND_DEPTH];
    /* verilator lint_off UNUSEDSIGNAL */
    logic                   mshr_pend_load  [MSHR_DEPTH][MSHR_PEND_DEPTH];
    /* verilator lint_on UNUSEDSIGNAL */

    // Outgoing acq channel single-shot driver
	    logic                          acq_pending_q;
	    logic [MSHR_IDX_W-1:0]         acq_mshr_q;
	    logic                          mshr_alloc_available_c;
	    logic [MSHR_IDX_W-1:0]         mshr_alloc_idx_c;
	    logic                          grant_mshr_hit_c;
	    logic [MSHR_IDX_W-1:0]         grant_mshr_idx_c;

	    always_comb begin
	        mshr_alloc_available_c = 1'b0;
	        mshr_alloc_idx_c       = '0;
	        for (int m = 0; m < MSHR_DEPTH; m++) begin
	            if (!mshr[m].valid && !mshr_alloc_available_c) begin
	                mshr_alloc_available_c = 1'b1;
	                mshr_alloc_idx_c       = m[MSHR_IDX_W-1:0];
	            end
	        end
	    end

	    always_comb begin
	        grant_mshr_hit_c = 1'b0;
	        grant_mshr_idx_c = '0;
	        for (int m = 0; m < MSHR_DEPTH; m++) begin
	            if (mshr[m].valid && mshr[m].paddr_line == l2_grant_paddr_line &&
	                !grant_mshr_hit_c) begin
	                grant_mshr_hit_c = 1'b1;
	                grant_mshr_idx_c = m[MSHR_IDX_W-1:0];
	            end
	        end
	    end

    // Same-line match for an incoming port-0 miss: a secondary miss to a
    // line already tracked by a valid MSHR coalesces onto that MSHR rather
    // than allocating a new one. Port 1 misses already replay without
    // allocating, so port 0 is the only MSHR allocation source and the only
    // path that can create a duplicate same-line MSHR.
    function automatic logic [PADDR_W-1:0] line_of(input logic [PADDR_W-1:0] paddr);
        return {paddr[PADDR_W-1:OFFSET_W], {OFFSET_W{1'b0}}};
    endfunction

    logic                  p0_mshr_line_hit_c;
    logic [MSHR_IDX_W-1:0] p0_mshr_line_idx_c;
    always_comb begin
        p0_mshr_line_hit_c = 1'b0;
        p0_mshr_line_idx_c = '0;
        for (int m = 0; m < MSHR_DEPTH; m++) begin
            if (mshr[m].valid &&
                mshr[m].paddr_line == line_of(lsu_p0_req.paddr) &&
                !p0_mshr_line_hit_c) begin
                p0_mshr_line_hit_c = 1'b1;
                p0_mshr_line_idx_c = m[MSHR_IDX_W-1:0];
            end
        end
    end
    // A secondary miss coalesces only while its primary MSHR's FIFO has
    // room; otherwise it replays without consuming a new MSHR.
    logic p0_can_coalesce_c;
    assign p0_can_coalesce_c = p0_mshr_line_hit_c &&
        (mshr_pend_count[p0_mshr_line_idx_c] < PEND_CNT_W'(MSHR_PEND_DEPTH));

    // -----------------------------------------------------------------
    // Per-port lookup helpers
    // -----------------------------------------------------------------
    function automatic logic [WAYS-1:0] tag_match
        (input logic [PADDR_W-1:0] paddr);
        logic [WAYS-1:0] vec;
        vec = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (state_array[w][addr_index(paddr)] != MESI_I &&
                tag_array[w][addr_index(paddr)] == addr_tag(paddr)) begin
                vec[w] = 1'b1;
            end
        end
        return vec;
    endfunction

    function automatic logic [$clog2(WAYS)-1:0] one_hot_idx
        (input logic [WAYS-1:0] vec);
        logic [$clog2(WAYS)-1:0] idx;
        idx = '0;
        for (int w = 0; w < WAYS; w++)
            if (vec[w]) idx = w[$clog2(WAYS)-1:0];
        return idx;
    endfunction

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
            next_tree[node] = ~way[$clog2(WAYS)-1-level];
            node = (node * 2) + 1 + (way[$clog2(WAYS)-1-level] ? 1 : 0);
        end
        return next_tree;
    endfunction

    // -----------------------------------------------------------------
    // Port arbitration: two requests in different banks proceed together.
    // Same-bank or same-set conflict -> p1 replays.
    // -----------------------------------------------------------------
    logic p0_active_c;
    logic p1_active_c;
    logic bank_conflict_c;
    assign p0_active_c     = lsu_p0_valid;
    assign bank_conflict_c = p0_active_c && lsu_p1_valid &&
                             (addr_bank(lsu_p0_req.paddr) ==
                              addr_bank(lsu_p1_req.paddr));
    assign p1_active_c     = lsu_p1_valid && !bank_conflict_c;

	    // Port 0 accepts a request when it is idle, when an MSHR slot is
	    // free, or when a secondary miss can coalesce onto an in-flight
	    // same-line MSHR (no new slot needed).
	    assign lsu_p0_ready    = !p0_active_c || mshr_alloc_available_c ||
	                             p0_can_coalesce_c;
	    assign lsu_p1_ready    = !bank_conflict_c &&
	                             (mshr_alloc_available_c || !p1_active_c);

    // -----------------------------------------------------------------
    // Per-port hit detection (combinational; ECC checked the same cycle
    // for the cocotb-friendly model. A real implementation pipelines this
    // across the s1/s2 boundary; the timing closure is documented in the
    // contract doc, but the functional model is single-cycle for sim).
    // -----------------------------------------------------------------
    function automatic logic [63:0] word_extract
        (input logic [LINE_BITS-1:0] line, input logic [OFFSET_W-1:0] off);
        logic [63:0] w;
        w = '0;
        // off is byte offset within line; word width is 8 bytes
        for (int b = 0; b < 64; b++) begin
            automatic int unsigned bit_idx = 32'(off) * 8 + b;
            if (bit_idx < LINE_BITS)
                w[b] = line[bit_idx];
        end
        return w;
    endfunction

    // -----------------------------------------------------------------
    // ECC scrub on a hit
    //
    // Single-error correction over the addressed 64-bit word using the
    // (72,64) Hsiao corrector in e1_cache_pkg. When the syndrome `s` names a
    // data-bit column the offending bit is flipped back; a check-bit flip
    // leaves data intact; a double-bit error is gated upstream (ecc_double)
    // and never reaches the load-return path.
    // -----------------------------------------------------------------
    function automatic logic [63:0] ecc_correct
        (input logic [63:0] d, input logic [7:0] s);
        ecc_correct = secded_correct(d, s);
    endfunction

    typedef struct packed {
        logic                   hit;
        logic [$clog2(WAYS)-1:0] way;
        logic [LINE_BITS-1:0]   line;
        logic [7:0]             ecc_word;
        logic [7:0]             ecc_syndrome;
        logic [63:0]            word;
        logic                   ecc_single;
        logic                   ecc_double;
    } lookup_t;

    function automatic lookup_t do_lookup
        (input logic [PADDR_W-1:0] paddr);
        lookup_t r;
        logic [WAYS-1:0] hits;
        logic [LINE_BITS-1:0] line;
        logic [63:0] word;
        logic [7:0]  ecc_word;
        logic [7:0]  syn;
        r = '0;
        hits = tag_match(paddr);
        r.hit = |hits;
        if (r.hit) begin
            r.way = one_hot_idx(hits);
            line = '0;
            for (int wd = 0; wd < WORDS_PER_LINE; wd++) begin
                automatic int unsigned base = wd * 64;
                automatic logic [63:0] w =
                    data_array[r.way][addr_index(paddr)][wd];
                for (int b = 0; b < 64; b++)
                    line[base + b] = w[b];
            end
            r.line = line;
            // ECC check on the addressed 8-byte word
            word = word_extract(line, paddr[OFFSET_W-1:0]);
            ecc_word = ecc_array[r.way][addr_index(paddr)]
                                [paddr[OFFSET_W-1:3]];
            syn = secded_syndrome(word, ecc_word);
            r.word = word;
            r.ecc_word = ecc_word;
            r.ecc_syndrome = syn;
            r.ecc_single = secded_is_single(syn);
            r.ecc_double = secded_is_double(syn);
        end
        return r;
    endfunction

    // -----------------------------------------------------------------
    // Probe channel implementation
    // -----------------------------------------------------------------
    assign probe_ready = !acq_pending_q;

    // -----------------------------------------------------------------
    // Sequential
    // -----------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tag_array   <= '{default: '{default: '0}};
            state_array <= '{default: '{default: MESI_I}};
            data_array  <= '{default: '{default: '{default: '0}}};
            ecc_array   <= '{default: '{default: '{default: '0}}};
            plru        <= '{default: '0};
            mshr        <= '{default: '0};
            mshr_pend_count <= '{default: '0};
            mshr_pend_head  <= '{default: '0};
            mshr_filled     <= '{default: 1'b0};
            mshr_pend_tag   <= '{default: '{default: '0}};
            mshr_pend_load  <= '{default: '{default: '0}};

            acq_pending_q     <= 1'b0;
            acq_mshr_q        <= '0;

            l2_acq_valid          <= 1'b0;
            l2_acq_paddr_line     <= '0;
            l2_acq_is_write       <= 1'b0;
            l2_acq_request_state  <= MESI_I;
            l2_acq_wb_data        <= '0;
            l2_grant_ready        <= 1'b1;

            lsu_p0_resp_valid <= 1'b0;
            lsu_p0_resp       <= '0;
            lsu_p1_resp_valid <= 1'b0;
            lsu_p1_resp       <= '0;

            probe_ack          <= 1'b0;
            probe_has_data     <= 1'b0;
            probe_wb_data      <= '0;
            probe_final_state  <= MESI_I;

            hpm_l1d_access    <= 1'b0;
            hpm_l1d_miss      <= 1'b0;
            hpm_l1d_ecc_corr  <= 1'b0;
            hpm_l1d_ecc_uncorr<= 1'b0;
        end else begin
            // Default pulses
            hpm_l1d_access    <= 1'b0;
            hpm_l1d_miss      <= 1'b0;
            hpm_l1d_ecc_corr  <= 1'b0;
            hpm_l1d_ecc_uncorr<= 1'b0;
            lsu_p0_resp_valid <= 1'b0;
            lsu_p1_resp_valid <= 1'b0;
            probe_ack         <= 1'b0;
            probe_has_data    <= 1'b0;

            // ------ Port 0 handling ------
            if (lsu_p0_valid && lsu_p0_ready) begin
                automatic lookup_t r0 = do_lookup(lsu_p0_req.paddr);
                hpm_l1d_access <= 1'b1;
                if (r0.hit && !r0.ecc_double &&
                    (lsu_p0_req.is_load ||
                     state_array[r0.way][addr_index(lsu_p0_req.paddr)]
                                != MESI_S)) begin
                    if (lsu_p0_req.is_load) begin
                        lsu_p0_resp_valid       <= 1'b1;
                        lsu_p0_resp.rdata       <= {64'h0,
                            ecc_correct(r0.word, r0.ecc_syndrome)};
                        lsu_p0_resp.tag         <= lsu_p0_req.tag;
                        lsu_p0_resp.ack         <= 1'b1;
                        lsu_p0_resp.replay      <= 1'b0;
                        lsu_p0_resp.ecc_uncorrectable <= r0.ecc_double;
                        if (r0.ecc_single) hpm_l1d_ecc_corr <= 1'b1;
                    end else begin
                        // Store hit: write the word, update ECC, set M
                        automatic logic [63:0] new_word =
                            lsu_p0_req.wdata[63:0];
                        data_array[r0.way][addr_index(lsu_p0_req.paddr)]
                                  [lsu_p0_req.paddr[OFFSET_W-1:3]]
                            <= new_word;
                        ecc_array [r0.way][addr_index(lsu_p0_req.paddr)]
                                  [lsu_p0_req.paddr[OFFSET_W-1:3]]
                            <= secded_encode(new_word);
                        state_array[r0.way][addr_index(lsu_p0_req.paddr)]
                            <= MESI_M;
                        lsu_p0_resp_valid <= 1'b1;
                        lsu_p0_resp.ack   <= 1'b1;
                        lsu_p0_resp.tag   <= lsu_p0_req.tag;
                    end
                    plru[addr_index(lsu_p0_req.paddr)] <=
                        plru_update(plru[addr_index(lsu_p0_req.paddr)], r0.way);
                end else begin
                    // Miss or upgrade-required.
                    hpm_l1d_miss <= 1'b1;
                    lsu_p0_resp_valid <= 1'b1;
                    lsu_p0_resp.ack   <= 1'b0;
                    lsu_p0_resp.replay<= 1'b1;
                    lsu_p0_resp.tag   <= lsu_p0_req.tag;
                    lsu_p0_resp.ecc_uncorrectable <= r0.ecc_double;
                    if (r0.ecc_double) hpm_l1d_ecc_uncorr <= 1'b1;
                    if (p0_mshr_line_hit_c) begin
                        // Secondary miss on an in-flight line: coalesce onto
                        // the primary MSHR. No second MSHR, no second acquire.
                        if (p0_can_coalesce_c) begin
                            automatic logic [PEND_IDX_W-1:0] tail =
                                PEND_IDX_W'(mshr_pend_head[p0_mshr_line_idx_c] +
                                            mshr_pend_count[p0_mshr_line_idx_c]);
                            mshr_pend_tag[p0_mshr_line_idx_c][tail]
                                <= lsu_p0_req.tag;
                            mshr_pend_load[p0_mshr_line_idx_c][tail]
                                <= lsu_p0_req.is_load;
                            mshr_pend_count[p0_mshr_line_idx_c]
                                <= mshr_pend_count[p0_mshr_line_idx_c] + PEND_CNT_W'(1);
                        end
                        // FIFO full: the request still replays and will
                        // coalesce on a later cycle once a slot frees.
                    end else if (mshr_alloc_available_c) begin
                        // Primary miss: allocate a fresh MSHR with an empty
                        // pending FIFO.
                        mshr[mshr_alloc_idx_c] <= '{
                            valid: 1'b1,
                            paddr_line: {lsu_p0_req.paddr[PADDR_W-1:OFFSET_W],
                                         {OFFSET_W{1'b0}}},
                            req_state: lsu_p0_req.is_load ? MESI_S : MESI_M,
                            is_write: 1'b0,
                            wb_data: '0,
                            victim_way: plru_victim(plru[addr_index(lsu_p0_req.paddr)]),
                            set_idx: addr_index(lsu_p0_req.paddr),
                            granted: 1'b0
                        };
                        mshr_pend_count[mshr_alloc_idx_c] <= '0;
                        mshr_pend_head[mshr_alloc_idx_c]  <= '0;
                        mshr_filled[mshr_alloc_idx_c]     <= 1'b0;
                    end
                end
            end

            // ------ Port 1 handling (mirror of port 0 minus duplication) ------
            if (lsu_p1_valid && lsu_p1_ready && !bank_conflict_c) begin
                automatic lookup_t r1 = do_lookup(lsu_p1_req.paddr);
                hpm_l1d_access <= 1'b1;
                if (r1.hit && !r1.ecc_double &&
                    (lsu_p1_req.is_load ||
                     state_array[r1.way][addr_index(lsu_p1_req.paddr)]
                                != MESI_S)) begin
                    if (lsu_p1_req.is_load) begin
                        lsu_p1_resp_valid <= 1'b1;
                        lsu_p1_resp.rdata <= {64'h0,
                            ecc_correct(r1.word, r1.ecc_syndrome)};
                        lsu_p1_resp.tag   <= lsu_p1_req.tag;
                        lsu_p1_resp.ack   <= 1'b1;
                        lsu_p1_resp.ecc_uncorrectable <= r1.ecc_double;
                        if (r1.ecc_single) hpm_l1d_ecc_corr <= 1'b1;
                    end else begin
                        automatic logic [63:0] new_word =
                            lsu_p1_req.wdata[63:0];
                        data_array[r1.way][addr_index(lsu_p1_req.paddr)]
                                  [lsu_p1_req.paddr[OFFSET_W-1:3]]
                            <= new_word;
                        ecc_array [r1.way][addr_index(lsu_p1_req.paddr)]
                                  [lsu_p1_req.paddr[OFFSET_W-1:3]]
                            <= secded_encode(new_word);
                        state_array[r1.way][addr_index(lsu_p1_req.paddr)]
                            <= MESI_M;
                        lsu_p1_resp_valid <= 1'b1;
                        lsu_p1_resp.ack   <= 1'b1;
                        lsu_p1_resp.tag   <= lsu_p1_req.tag;
                    end
                    plru[addr_index(lsu_p1_req.paddr)] <=
                        plru_update(plru[addr_index(lsu_p1_req.paddr)], r1.way);
                end else begin
                    hpm_l1d_miss <= 1'b1;
                    lsu_p1_resp_valid <= 1'b1;
                    lsu_p1_resp.replay<= 1'b1;
                    lsu_p1_resp.tag   <= lsu_p1_req.tag;
                    lsu_p1_resp.ecc_uncorrectable <= r1.ecc_double;
                    if (r1.ecc_double) hpm_l1d_ecc_uncorr <= 1'b1;
                end
            end else if (lsu_p1_valid && bank_conflict_c) begin
                lsu_p1_resp_valid <= 1'b1;
                lsu_p1_resp.replay<= 1'b1;
                lsu_p1_resp.tag   <= lsu_p1_req.tag;
            end

            // ------ Issue MSHR onto L2 channel ------
	            if (acq_pending_q && l2_acq_valid && l2_acq_ready) begin
	                mshr[acq_mshr_q].granted <= 1'b1;
	                acq_pending_q <= 1'b0;
	                l2_acq_valid  <= 1'b0;
	            end else if (!acq_pending_q) begin
	                for (int m = 0; m < MSHR_DEPTH; m++) begin
	                    if (mshr[m].valid && !mshr[m].granted) begin
                        acq_pending_q         <= 1'b1;
                        acq_mshr_q            <= m[MSHR_IDX_W-1:0];
                        l2_acq_valid          <= 1'b1;
                        l2_acq_paddr_line     <= mshr[m].paddr_line;
                        l2_acq_is_write       <= mshr[m].is_write;
                        l2_acq_request_state  <= mshr[m].req_state;
                        l2_acq_wb_data        <= mshr[m].wb_data;
                        break;
                    end
                end
	            end

	            // ------ Receive grant ------
	            if (l2_grant_valid && l2_grant_ready && grant_mshr_hit_c) begin
	                // Fill the MSHR's victim slot. Tag is the high TAG_W bits of
	                // the granted physical address (matching addr_tag()).
	                automatic mshr_t m = mshr[grant_mshr_idx_c];
                tag_array[m.victim_way][m.set_idx] <=
                    addr_tag(l2_grant_paddr_line);
                state_array[m.victim_way][m.set_idx] <= l2_grant_state;
                for (int wd = 0; wd < WORDS_PER_LINE; wd++) begin
                    automatic logic [63:0] w = l2_grant_data[wd*64 +: 64];
                    data_array[m.victim_way][m.set_idx][wd] <= w;
                    ecc_array [m.victim_way][m.set_idx][wd] <=
                        secded_encode(w);
                end
                plru[m.set_idx] <=
                    plru_update(plru[m.set_idx], m.victim_way);
	                // Fill installs the line for the primary miss. If no
	                // secondary request coalesced, free the MSHR now. Otherwise
	                // mark it filled and let the drain step replay each pending
	                // request before freeing it.
	                if (mshr_pend_count[grant_mshr_idx_c] == '0) begin
	                    mshr[grant_mshr_idx_c] <= '0;
	                    mshr_filled[grant_mshr_idx_c] <= 1'b0;
	                end else begin
	                    mshr_filled[grant_mshr_idx_c] <= 1'b1;
	                    mshr[grant_mshr_idx_c].granted <= 1'b1;
	                end
	            end

            // ------ Drain coalesced secondary requests ------
            // On an idle port-0 cycle, replay one pending request from a
            // filled MSHR's FIFO. The replayed tag tells the LSU to
            // re-present the request; the line is resident so the replay
            // hits. The MSHR frees when its FIFO empties.
            // Port 0 sets lsu_p0_resp_valid only inside its accept branch
            // (lsu_p0_valid && lsu_p0_ready); when that branch did not run
            // the response slot is free for the drain to use this cycle.
            if (!(lsu_p0_valid && lsu_p0_ready)) begin
                automatic logic                  drain_hit  = 1'b0;
                automatic logic [MSHR_IDX_W-1:0] drain_idx  = '0;
                for (int m = 0; m < MSHR_DEPTH; m++) begin
                    if (mshr[m].valid && mshr_filled[m] &&
                        mshr_pend_count[m] != '0 && !drain_hit) begin
                        drain_hit = 1'b1;
                        drain_idx = m[MSHR_IDX_W-1:0];
                    end
                end
                if (drain_hit) begin
                    lsu_p0_resp_valid <= 1'b1;
                    lsu_p0_resp.ack   <= 1'b0;
                    lsu_p0_resp.replay<= 1'b1;
                    lsu_p0_resp.tag   <= mshr_pend_tag[drain_idx][mshr_pend_head[drain_idx]];
                    mshr_pend_head[drain_idx] <=
                        PEND_IDX_W'(mshr_pend_head[drain_idx] + PEND_IDX_W'(1));
                    mshr_pend_count[drain_idx] <=
                        mshr_pend_count[drain_idx] - PEND_CNT_W'(1);
                    if (mshr_pend_count[drain_idx] == PEND_CNT_W'(1)) begin
                        // Last pending entry drained: free the MSHR.
                        mshr[drain_idx]        <= '0;
                        mshr_filled[drain_idx] <= 1'b0;
                    end
                end
            end

            // ------ Probe handling ------
            if (probe_valid && probe_ready) begin
                automatic logic [WAYS-1:0] hits;
                hits = '0;
                for (int w = 0; w < WAYS; w++) begin
                    if (state_array[w][addr_index(probe_paddr_line)] != MESI_I &&
                        tag_array[w][addr_index(probe_paddr_line)] ==
                            addr_tag(probe_paddr_line)) begin
                        hits[w] = 1'b1;
                    end
                end
                if (|hits) begin
                    automatic int unsigned hw;
                    hw = 0;
                    for (int w = 0; w < WAYS; w++)
                        if (hits[w]) hw = w;
                    if (state_array[hw][addr_index(probe_paddr_line)] == MESI_M
                        && probe_target_state == MESI_I) begin
                        // Writeback dirty data on invalidation
                        probe_has_data <= 1'b1;
                        for (int wd = 0; wd < WORDS_PER_LINE; wd++) begin
                            probe_wb_data[wd*64 +: 64]
                                <= data_array[hw][addr_index(probe_paddr_line)][wd];
                        end
                    end
                    if (state_array[hw][addr_index(probe_paddr_line)] == MESI_M
                        && probe_target_state == MESI_S) begin
                        // Downgrade M -> S: writeback dirty data, keep shared
                        probe_has_data <= 1'b1;
                        for (int wd = 0; wd < WORDS_PER_LINE; wd++) begin
                            probe_wb_data[wd*64 +: 64]
                                <= data_array[hw][addr_index(probe_paddr_line)][wd];
                        end
                    end
                    state_array[hw][addr_index(probe_paddr_line)]
                        <= probe_target_state;
                end
                probe_ack <= 1'b1;
                probe_final_state <= probe_target_state;
            end
        end
    end

endmodule
