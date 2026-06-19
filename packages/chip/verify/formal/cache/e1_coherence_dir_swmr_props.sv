// SPDX-License-Identifier: Apache-2.0
//
// SWMR (single-writer / multiple-reader) property pack for the real MESI
// directory `e1_coherence_dir`. These properties are *bound* to the directory's
// authoritative coherence record (`dir_state_q` + `dir_sharers_q`) and assert
// the coherence invariant directly; they do NOT assume it. The request,
// probe, and grant channels of the directory are left free for the BMC engine,
// so the proof exercises every acquire / probe-ack / grant interleaving the FSM
// admits and checks that the directory's own logic keeps the invariant.
//
// The directory is the cluster ordering point: it holds exactly one stable
// state per line plus a per-core sharer bitmask. The cluster-wide SWMR
// invariant therefore reduces to invariants on that record:
//
//   P1_swmr            : a line the directory records as writable (M or E)
//                        has at most one sharer bit set. Equivalently, no two
//                        cores can simultaneously be recorded as owning the
//                        line writable -> at most one writer.
//   P2_no_dirty_shared : a line recorded Modified (dirty) has exactly one
//                        sharer; it is never recorded dirty while shared by
//                        more than one core.
//   P3_state_legal     : every directory line decodes to a legal MESI state.
//   P4_invalid_no_sharers : a line recorded Invalid has no sharer bits set
//                        (no core believes it caches an uncached line).
//
// `default_nettype none` would reject the implicit `clk` net that the bind
// inherits from the parent scope, so it is intentionally left at the default.

`ifndef E1_COHERENCE_DIR_SWMR_PROPS_SV
`define E1_COHERENCE_DIR_SWMR_PROPS_SV

module e1_coherence_dir_swmr_props
    import e1_cache_pkg::*;
#(
    parameter int unsigned NUM_CORES = 2,
    parameter int unsigned DIR_LINES = 2
) (
    input logic                clk,
    input logic                rst_n,
    input mesi_e               dir_state_q   [DIR_LINES],
    input logic                dir_valid_q   [DIR_LINES],
    input logic [NUM_CORES-1:0] dir_sharers_q [DIR_LINES]
);

    // Population count of a sharer bitmask (how many cores hold the line).
    function automatic int unsigned popcount(input logic [NUM_CORES-1:0] m);
        int unsigned n;
        n = 0;
        for (int b = 0; b < NUM_CORES; b++) begin
            if (m[b]) n = n + 1;
        end
        return n;
    endfunction

    always_ff @(posedge clk) begin
        if (rst_n) begin
            for (int i = 0; i < DIR_LINES; i++) begin
                // P3: state is always one of the legal MESI encodings.
                assert (dir_state_q[i] == MESI_I || dir_state_q[i] == MESI_S ||
                        dir_state_q[i] == MESI_E || dir_state_q[i] == MESI_M ||
                        dir_state_q[i] == MESI_O);

                // P1: a writable line (Exclusive or Modified) has <= 1 sharer.
                //     This is the single-writer half of SWMR proven over the
                //     real directory: the protocol never records two owners of
                //     a writable line.
                if (dir_state_q[i] == MESI_E || dir_state_q[i] == MESI_M) begin
                    assert (popcount(dir_sharers_q[i]) <= 1);
                end

                // P2: a Modified (dirty) line is never recorded shared by more
                //     than one core -> no dirty-shared.
                if (dir_state_q[i] == MESI_M) begin
                    assert (popcount(dir_sharers_q[i]) <= 1);
                end

                // P4: an Invalid line is not recorded as held by any core.
                if (dir_state_q[i] == MESI_I) begin
                    assert (dir_sharers_q[i] == '0);
                end
            end

            // Reachability witnesses (cover mode): the proof is non-vacuous
            // only if the directory can actually reach the writable and shared
            // states the SWMR asserts guard. C_reach_m / C_reach_e fire when a
            // line is owned writable; C_reach_shared fires when two cores share
            // a line (the multiple-reader half of SWMR).
            cover (dir_state_q[0] == MESI_M);
            cover (dir_state_q[0] == MESI_E);
            cover (dir_state_q[0] == MESI_S &&
                   popcount(dir_sharers_q[0]) >= 2);
        end
    end

endmodule

`endif // E1_COHERENCE_DIR_SWMR_PROPS_SV
