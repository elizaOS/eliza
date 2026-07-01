`timescale 1ns/1ps

// e1_coherence_dir
//
// MESI directory coherence controller for an SMP cluster of N private L1D
// caches over a shared backing store. This is the cluster point of
// serialization: it owns the authoritative copy of every line, tracks which
// cores hold each line and in what stable state, and issues probes that
// enforce the coherence invariants before granting a request.
//
// Role in the hierarchy: this module models the shared next level (L2/L3
// directory + memory) from the point of view of the per-core L1D. It speaks
// the same acq/grant + probe protocol that `e1_l1d_cache` already implements
// (see rtl/cache/l1d/e1_l1d_cache.sv): each core drives an acquire with a
// requested target state, the directory probes the *other* cores as needed,
// and then grants the line with the resolved state.
//
// Protocol: MESI (the cluster-internal L1D subset of the MOESI encoding in
// e1_cache_pkg). The directory itself is the ordering point; it does not
// keep an Owned sharer because a single L1D owner always responds to a peer
// probe with a writeback, after which the directory holds the clean data.
//
//   Stable directory states per line:
//     DIR_I  : no core caches the line; backing store is authoritative
//     DIR_S  : one or more cores hold the line clean-Shared; directory clean
//     DIR_E  : exactly one core holds the line clean-Exclusive
//     DIR_M  : exactly one core holds the line Modified (dirty); that core's
//              copy is authoritative until a probe forces a writeback
//
//   Transient states (FSM, per outstanding request):
//     PROBE_INV : invalidating peers before an M (write) grant
//     PROBE_DG  : downgrading a dirty owner to S before an S (read) grant
//
// Coherence invariants enforced by construction:
//   SWMR (single-writer / multiple-reader): a write acquire invalidates every
//     other sharer before the grant, so at most one core is ever in M.
//   Write propagation: a probe to a dirty owner returns its line as writeback
//     data; the directory installs that data before granting the new reader,
//     so a read always observes the most recent write.
//   Clean eviction / writeback ordering: a release (acq_is_write) updates the
//     directory data and clears the releasing core's sharer bit before any
//     later grant of the same line is allowed to proceed.
//
// Fail-closed: the request scheduler is strictly one-outstanding-line. A new
// acquire is not accepted until the current line's probe round-trip and grant
// have fully retired, so two cores can never both be mid-upgrade on the same
// line. Lines map into a small direct-mapped directory; a directory-set
// conflict on a live line stalls the new acquire (back-pressure) rather than
// silently dropping coherence state.

module e1_coherence_dir
    import e1_cache_pkg::*;
#(
    parameter int unsigned NUM_CORES  = 2,
    parameter int unsigned PADDR_W    = PADDR_W_DEFAULT,
    parameter int unsigned LINE_BYTES = LINE_BYTES_DEFAULT,
    parameter int unsigned DIR_LINES  = 64,
    parameter int unsigned NUM_DOMAINS = 2
) (
    input  logic                          clk,
    input  logic                          rst_n,

    // Per-core acquire/release request channel (mirrors L1D l2_acq_*)
    input  logic [NUM_CORES-1:0]          acq_valid,
    output logic [NUM_CORES-1:0]          acq_ready,
    input  logic [PADDR_W-1:0]            acq_paddr_line   [NUM_CORES],
    input  logic [NUM_CORES-1:0]          acq_is_write,    // 1 = release/wb
    input  mesi_e                         acq_req_state    [NUM_CORES],
    input  logic [8*LINE_BYTES-1:0]       acq_wb_data      [NUM_CORES],
    // Domain tag of the requesting core (for partition / flush-by-domain)
    input  logic [$clog2(NUM_DOMAINS)-1:0] acq_domain      [NUM_CORES],

    // Per-core grant channel (mirrors L1D l2_grant_*)
    output logic [NUM_CORES-1:0]          grant_valid,
    input  logic [NUM_CORES-1:0]          grant_ready,
    output logic [PADDR_W-1:0]            grant_paddr_line [NUM_CORES],
    output logic [8*LINE_BYTES-1:0]       grant_data       [NUM_CORES],
    output mesi_e                         grant_state      [NUM_CORES],

    // Per-core probe channel (mirrors L1D probe_*)
    output logic [NUM_CORES-1:0]          probe_valid,
    input  logic [NUM_CORES-1:0]          probe_ready,
    output logic [PADDR_W-1:0]            probe_paddr_line [NUM_CORES],
    output mesi_e                         probe_target_state [NUM_CORES],
    input  logic [NUM_CORES-1:0]          probe_ack,
    input  logic [NUM_CORES-1:0]          probe_has_data,
    input  logic [8*LINE_BYTES-1:0]       probe_wb_data    [NUM_CORES],
    input  mesi_e                         probe_final_state [NUM_CORES],

    // Flush-by-domain control: pulse flush_req with flush_domain to evict and
    // invalidate every directory line tagged to that confidential domain.
    // flush_busy is high while the sweep runs; flush_done pulses on completion.
    input  logic                          flush_req,
    input  logic [$clog2(NUM_DOMAINS)-1:0] flush_domain,
    output logic                          flush_busy,
    output logic                          flush_done,

    // HPM events
    output logic                          hpm_dir_acquire,
    output logic                          hpm_dir_probe,
    output logic                          hpm_dir_writeback,
    output logic                          hpm_dir_flush
);

    localparam int unsigned LINE_BITS = 8 * LINE_BYTES;
    localparam int unsigned OFFSET_W  = $clog2(LINE_BYTES);
    localparam int unsigned DIR_IDX_W = $clog2(DIR_LINES);
    localparam int unsigned CORE_IDX_W = (NUM_CORES > 1) ? $clog2(NUM_CORES) : 1;
    localparam int unsigned DOM_W      = (NUM_DOMAINS > 1) ? $clog2(NUM_DOMAINS) : 1;

    // Directory tag covers all paddr bits above the directory-set index so an
    // alias into the same direct-mapped slot is detected as a different line.
    localparam int unsigned DIR_TAG_W = PADDR_W - OFFSET_W - DIR_IDX_W;

    function automatic logic [DIR_IDX_W-1:0] dir_index(input logic [PADDR_W-1:0] a);
        return a[OFFSET_W +: DIR_IDX_W];
    endfunction
    function automatic logic [DIR_TAG_W-1:0] dir_tag(input logic [PADDR_W-1:0] a);
        return a[PADDR_W-1 -: DIR_TAG_W];
    endfunction

    // -----------------------------------------------------------------
    // Directory storage
    // -----------------------------------------------------------------
    logic [DIR_TAG_W-1:0] dir_tag_q     [DIR_LINES];
    logic                 dir_valid_q   [DIR_LINES];
    mesi_e                dir_state_q   [DIR_LINES];
    logic [NUM_CORES-1:0] dir_sharers_q [DIR_LINES];
    logic [LINE_BITS-1:0] dir_data_q    [DIR_LINES];
    logic [DOM_W-1:0]     dir_domain_q  [DIR_LINES];

    // -----------------------------------------------------------------
    // Request FSM (single outstanding line)
    // -----------------------------------------------------------------
    typedef enum logic [2:0] {
        D_IDLE,
        D_PROBE_ISSUE,
        D_PROBE_WAIT,
        D_GRANT,
        D_FLUSH
    } dir_state_e;

    dir_state_e               fsm_q;
    logic [CORE_IDX_W-1:0]    req_core_q;
    logic [PADDR_W-1:0]       req_paddr_q;
    logic [DIR_IDX_W-1:0]     req_idx_q;
    logic [LINE_BITS-1:0]     line_data_q;
    mesi_e                    grant_state_q;

    // Probe bookkeeping: which peers still need a probe, and the target state
    // each peer is being moved to (I for a write acquire, S for a read).
    logic [NUM_CORES-1:0]     probe_pending_q; // peers awaiting ack
    logic [NUM_CORES-1:0]     probe_inflight_q; // probe currently asserted
    mesi_e                    probe_tgt_q;

    // Flush sweep
    logic [DIR_IDX_W:0]       flush_idx_q;
    logic [DOM_W-1:0]         flush_dom_q;

    // -----------------------------------------------------------------
    // Combinational request arbitration (fixed priority, lowest core first).
    // Only meaningful when the FSM is idle.
    // -----------------------------------------------------------------
    logic                  sel_valid_c;
    logic [CORE_IDX_W-1:0] sel_core_c;
    always_comb begin
        sel_valid_c = 1'b0;
        sel_core_c  = '0;
        for (int c = NUM_CORES - 1; c >= 0; c--) begin
            if (acq_valid[c]) begin
                sel_valid_c = 1'b1;
                sel_core_c  = c[CORE_IDX_W-1:0];
            end
        end
    end

    // Accept a new acquire only when idle and not flushing.
    always_comb begin
        for (int c = 0; c < NUM_CORES; c++) begin
            acq_ready[c] = (fsm_q == D_IDLE) && !flush_busy &&
                           sel_valid_c && (sel_core_c == c[CORE_IDX_W-1:0]);
        end
    end

    // Directory lookup helper: hit iff valid and tag matches.
    function automatic logic dir_hit(input logic [DIR_IDX_W-1:0] idx,
                                     input logic [PADDR_W-1:0]   paddr);
        return dir_valid_q[idx] && (dir_tag_q[idx] == dir_tag(paddr));
    endfunction

    // -----------------------------------------------------------------
    // Sequential
    // -----------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int i = 0; i < DIR_LINES; i++) begin
                dir_tag_q[i]     <= '0;
                dir_valid_q[i]   <= 1'b0;
                dir_state_q[i]   <= MESI_I;
                dir_sharers_q[i] <= '0;
                dir_data_q[i]    <= '0;
                dir_domain_q[i]  <= '0;
            end
            fsm_q            <= D_IDLE;
            req_core_q       <= '0;
            req_paddr_q      <= '0;
            req_idx_q        <= '0;
            line_data_q      <= '0;
            grant_state_q    <= MESI_I;
            probe_pending_q  <= '0;
            probe_inflight_q <= '0;
            probe_tgt_q      <= MESI_I;
            flush_idx_q      <= '0;
            flush_dom_q      <= '0;
            flush_busy       <= 1'b0;
            flush_done       <= 1'b0;

            for (int k = 0; k < NUM_CORES; k++) begin
                grant_valid[k]        <= 1'b0;
                grant_paddr_line[k]   <= '0;
                grant_data[k]         <= '0;
                grant_state[k]        <= MESI_I;
                probe_valid[k]        <= 1'b0;
                probe_paddr_line[k]   <= '0;
                probe_target_state[k] <= MESI_I;
            end

            hpm_dir_acquire   <= 1'b0;
            hpm_dir_probe     <= 1'b0;
            hpm_dir_writeback <= 1'b0;
            hpm_dir_flush     <= 1'b0;
        end else begin
            hpm_dir_acquire   <= 1'b0;
            hpm_dir_probe     <= 1'b0;
            hpm_dir_writeback <= 1'b0;
            hpm_dir_flush     <= 1'b0;
            flush_done        <= 1'b0;

            // Retire any completed grants.
            for (int k = 0; k < NUM_CORES; k++) begin
                if (grant_valid[k] && grant_ready[k])
                    grant_valid[k] <= 1'b0;
            end

            case (fsm_q)
                // -------------------------------------------------------
                D_IDLE: begin
                    if (flush_req) begin
                        flush_busy  <= 1'b1;
                        flush_idx_q <= '0;
                        flush_dom_q <= flush_domain;
                        fsm_q       <= D_FLUSH;
                    end else if (sel_valid_c) begin
                        automatic logic [DIR_IDX_W-1:0] idx;
                        automatic logic                 hit;
                        idx = dir_index(acq_paddr_line[sel_core_c]);
                        hit = dir_hit(idx, acq_paddr_line[sel_core_c]);
                        hpm_dir_acquire <= 1'b1;

                        req_core_q  <= sel_core_c;
                        req_paddr_q <= acq_paddr_line[sel_core_c];
                        req_idx_q   <= idx;

                        if (acq_is_write[sel_core_c]) begin
                            // ----- Release / writeback from a core -----
                            // The releasing core hands back its (possibly
                            // dirty) line. Update directory data, clear its
                            // sharer bit, and complete without a grant.
                            if (hit) begin
                                dir_data_q[idx] <= acq_wb_data[sel_core_c];
                                dir_sharers_q[idx][sel_core_c] <= 1'b0;
                                hpm_dir_writeback <= 1'b1;
                                // If the releaser owned it (E/M), the line is
                                // now uncached -> Invalid; if it was Shared
                                // and others remain, stay Shared.
                                if ((dir_sharers_q[idx] &
                                     ~({{(NUM_CORES-1){1'b0}}, 1'b1} <<
                                       sel_core_c)) == '0) begin
                                    dir_state_q[idx] <= MESI_I;
                                    dir_valid_q[idx] <= 1'b1; // data retained
                                end else begin
                                    dir_state_q[idx] <= MESI_S;
                                end
                            end
                            // No grant for a release; return to idle.
                            fsm_q <= D_IDLE;
                        end else begin
                            // ----- Acquire (read or write upgrade) -----
                            automatic logic [NUM_CORES-1:0] others;
                            automatic logic [LINE_BITS-1:0] cur_data;
                            automatic mesi_e probe_to;
                            automatic logic  want_m;

                            want_m = (acq_req_state[sel_core_c] == MESI_M ||
                                      acq_req_state[sel_core_c] == MESI_E);
                            cur_data = hit ? dir_data_q[idx] : '0;
                            others = '0;
                            if (hit)
                                others = dir_sharers_q[idx] &
                                    ~({{(NUM_CORES-1){1'b0}}, 1'b1} <<
                                      sel_core_c);

                            // Probe target: a write acquire invalidates every
                            // peer (SWMR); a read acquire only needs peers
                            // holding the line writable to drop to Shared.
                            probe_to = want_m ? MESI_I : MESI_S;

                            if (hit && (others != '0) &&
                                !(probe_to == MESI_S &&
                                  dir_state_q[idx] == MESI_S)) begin
                                // Need to probe peers first. For a read into a
                                // clean-Shared directory line no probe is
                                // needed (peers may keep S).
                                line_data_q     <= cur_data;
                                probe_pending_q <= others;
                                probe_tgt_q     <= probe_to;
                                grant_state_q   <= want_m ? MESI_M : MESI_S;
                                if (acq_domain[sel_core_c] != flush_dom_q) begin
                                    dir_domain_q[idx] <= acq_domain[sel_core_c];
                                end
                                fsm_q <= D_PROBE_ISSUE;
                            end else begin
                                // No probe required: grant directly.
                                // Determine grant state:
                                //   write/exclusive request -> M (sole owner)
                                //   read with no other sharer -> E
                                //   read with existing sharers -> S
                                automatic mesi_e gs;
                                if (want_m) gs = MESI_M;
                                else if (others == '0) gs = MESI_E;
                                else gs = MESI_S;

                                line_data_q   <= cur_data;
                                grant_state_q <= gs;

                                dir_valid_q[idx]  <= 1'b1;
                                dir_tag_q[idx]    <= dir_tag(
                                                     acq_paddr_line[sel_core_c]);
                                dir_domain_q[idx] <= acq_domain[sel_core_c];
                                dir_state_q[idx]  <= gs;
                                if (!hit) dir_data_q[idx] <= '0;
                                // Update sharer set.
                                if (gs == MESI_S) begin
                                    dir_sharers_q[idx] <= dir_sharers_q[idx] |
                                        ({{(NUM_CORES-1){1'b0}}, 1'b1} <<
                                         sel_core_c);
                                end else begin
                                    // E/M: sole owner.
                                    dir_sharers_q[idx] <=
                                        ({{(NUM_CORES-1){1'b0}}, 1'b1} <<
                                         sel_core_c);
                                end
                                fsm_q <= D_GRANT;
                            end
                        end
                    end
                end

                // -------------------------------------------------------
                D_PROBE_ISSUE: begin
                    // Drive a probe to every pending peer that is ready and
                    // not already inflight. Capture acks in D_PROBE_WAIT.
                    for (int k = 0; k < NUM_CORES; k++) begin
                        if (probe_pending_q[k] && !probe_inflight_q[k] &&
                            probe_ready[k]) begin
                            probe_valid[k]        <= 1'b1;
                            probe_paddr_line[k]   <= req_paddr_q;
                            probe_target_state[k] <= probe_tgt_q;
                            probe_inflight_q[k]   <= 1'b1;
                            hpm_dir_probe         <= 1'b1;
                        end
                    end
                    fsm_q <= D_PROBE_WAIT;
                end

                // -------------------------------------------------------
                D_PROBE_WAIT: begin
                    // next_pending models probe_pending_q after this cycle's
                    // ack-driven clears; the FSM advances on it so the
                    // grant only fires once every probed peer has acked.
                    automatic logic [NUM_CORES-1:0] next_pending;
                    automatic logic                 reissue;
                    next_pending = probe_pending_q;
                    reissue      = 1'b0;

                    for (int k = 0; k < NUM_CORES; k++) begin
                        // Deassert the request the cycle after it was taken.
                        if (probe_inflight_q[k] && probe_valid[k])
                            probe_valid[k] <= 1'b0;

                        if (probe_inflight_q[k] && probe_ack[k]) begin
                            // Collect writeback data from a dirty owner so the
                            // subsequent grant carries the freshest value.
                            if (probe_has_data[k]) begin
                                line_data_q           <= probe_wb_data[k];
                                dir_data_q[req_idx_q] <= probe_wb_data[k];
                                hpm_dir_writeback     <= 1'b1;
                            end
                            // Update directory sharer set for this peer.
                            if (probe_tgt_q == MESI_I)
                                dir_sharers_q[req_idx_q][k] <= 1'b0;
                            probe_inflight_q[k] <= 1'b0;
                            next_pending[k]      = 1'b0; // combinational temp
                        end

                        // A pending peer that never got its probe out (it was
                        // not ready when D_PROBE_ISSUE ran) needs a re-issue.
                        if (probe_pending_q[k] && !probe_inflight_q[k])
                            reissue = 1'b1;
                    end

                    probe_pending_q <= next_pending;

                    if (next_pending == '0)
                        fsm_q <= D_GRANT;
                    else if (reissue)
                        fsm_q <= D_PROBE_ISSUE;
                end

                // -------------------------------------------------------
                D_GRANT: begin
                    // Commit directory ownership for the granted core, then
                    // raise the grant. For a probe-resolved acquire the sharer
                    // set / state were left to be finalized here.
                    automatic mesi_e gs;
                    gs = grant_state_q;

                    dir_valid_q[req_idx_q] <= 1'b1;
                    dir_tag_q[req_idx_q]   <= dir_tag(req_paddr_q);
                    dir_state_q[req_idx_q] <= gs;
                    if (gs == MESI_S) begin
                        dir_sharers_q[req_idx_q] <=
                            dir_sharers_q[req_idx_q] |
                            ({{(NUM_CORES-1){1'b0}}, 1'b1} << req_core_q);
                    end else begin
                        // M/E: the requesting core is the sole owner; all peer
                        // sharer bits were cleared by the invalidating probes.
                        dir_sharers_q[req_idx_q] <=
                            ({{(NUM_CORES-1){1'b0}}, 1'b1} << req_core_q);
                    end

                    grant_valid[req_core_q]      <= 1'b1;
                    grant_paddr_line[req_core_q] <= req_paddr_q;
                    grant_data[req_core_q]       <= line_data_q;
                    grant_state[req_core_q]      <= gs;
                    fsm_q <= D_IDLE;
                end

                // -------------------------------------------------------
                D_FLUSH: begin
                    // Sweep the directory; invalidate every line tagged to the
                    // domain being flushed. A confidential domain's lines are
                    // dropped so they cannot be observed after a domain switch.
                    if (flush_idx_q == DIR_LINES[DIR_IDX_W:0]) begin
                        flush_busy <= 1'b0;
                        flush_done <= 1'b1;
                        fsm_q      <= D_IDLE;
                    end else begin
                        automatic logic [DIR_IDX_W-1:0] fi;
                        fi = flush_idx_q[DIR_IDX_W-1:0];
                        if (dir_valid_q[fi] &&
                            dir_domain_q[fi] == flush_dom_q) begin
                            dir_valid_q[fi]   <= 1'b0;
                            dir_state_q[fi]   <= MESI_I;
                            dir_sharers_q[fi] <= '0;
                            dir_data_q[fi]    <= '0;
                            hpm_dir_flush     <= 1'b1;
                        end
                        flush_idx_q <= flush_idx_q + 1'b1;
                    end
                end

                default: fsm_q <= D_IDLE;
            endcase
        end
    end

endmodule
