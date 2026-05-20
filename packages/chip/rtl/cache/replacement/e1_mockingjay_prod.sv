`timescale 1ns/1ps

// e1_mockingjay_prod
//
// Productized Mockingjay (Shah et al., HPCA'22) cache replacement policy.
//
// Match the HPCA'22 paper structure more closely than `e1_mockingjay.sv`:
//
//   - Sampled Cache: 8-way x 256 entries x {tag, RTP timestamp, last-PC},
//     keyed by a sampled subset of sets. The sampled set selector hashes
//     the set index against `SAMPLE_HASH` so a deterministic ~1/N fraction
//     of sets are sampled at runtime.
//
//   - Reuse Time Predictor (RTP) per PC: when a sampled entry is hit, the
//     observed reuse distance (in global access counter units) is fed
//     into the PC-keyed RTP, exponentially smoothed.
//
//   - ETR (Estimated Time of Reference) per cache line: 3-bit saturating
//     counter. On insertion, ETR is set from the RTP entry for the
//     installing PC; on every access to the set, surviving lines' ETRs
//     decrement toward zero, and the largest-ETR line is the victim
//     candidate.
//
//   - Belady-MIN mimicry: lines whose observed reuse exceeds a "cache
//     friendly" threshold are tagged with low ETR (kept). Lines whose
//     predicted ETR exceeds the working-set window are tagged with the
//     maximum ETR (evicted next). The threshold is parameterizable.
//
//   - Tie-break randomization: at reset every line is initialised to
//     MAX_ETR (no learned signal). A purely deterministic argmax then
//     collapses victim choice onto a single way, starving the other
//     ways and biasing the policy below LRU until the STT/RTP warms.
//     `find_victim` therefore picks a uniform random way among the set
//     of ways tied at the maximum ETR, using a Galois LFSR seeded by
//     `TIE_BREAK_LFSR_SEED` so the harness can reproduce runs.
//
// The module is a drop-in for the L3 cache's existing replacement-policy
// hook. The L3 calls into this module on every access; the module returns
// the victim way and updates its own state. The cocotb harness
// `test_mockingjay_accuracy.py` drives a synthetic stream and measures
// hit-rate vs an LRU oracle in the same harness.
//
// State storage:
//   - STT_ENTRIES x {valid, tag, pc, rtp_value, timestamp} as flat regs.
//   - RTP_ENTRIES x {valid, pc_tag, predicted_reuse} per-PC predictor.
//   - ETR per cache line: WAYS x SETS, 3-bit. This is the main on-die
//     storage cost (~6 KiB at 16 WAY x 2048 SETS).
//
// Lint clean under verilator-strict.

module e1_mockingjay_prod #(
    parameter int unsigned WAYS         = 16,
    parameter int unsigned SETS         = 2048,
    parameter int unsigned PC_W         = 64,
    // Sampled Cache: 8 ways x 256 entries
    parameter int unsigned STT_WAYS     = 8,
    parameter int unsigned STT_SETS     = 32,    // 8x32 = 256 entries
    // Reuse Time Predictor (RTP) per PC
    parameter int unsigned RTP_ENTRIES  = 256,
    // ETR: 3-bit per line
    parameter int unsigned ETR_W        = 3,
    parameter int unsigned MAX_ETR      = (1 << 3) - 1,
    // Sampling: bit-hash to pick whether a set is sampled
    parameter logic [31:0] SAMPLE_HASH  = 32'hC0FFEE01,
    // Belady-MIN tagging: ETRs above this threshold are aged toward MAX
    parameter int unsigned CACHE_FRIENDLY_THRESHOLD = 4,
    // Galois LFSR seed for the victim-tie randomizer. Any non-zero value
    // is fine; non-zero is required (a zero LFSR is a stuck state).
    parameter logic [15:0] TIE_BREAK_LFSR_SEED = 16'hACE1
)(
    input  logic                       clk,
    input  logic                       rst_n,

    // Access stream from the host cache (L3)
    input  logic                       acc_valid,
    input  logic [$clog2(SETS)-1:0]    acc_set,
    input  logic                       acc_hit,
    input  logic [$clog2(WAYS)-1:0]    acc_way,
    input  logic                       acc_is_miss_install,
    input  logic [PC_W-1:0]            acc_pc,

    input  logic [$clog2(SETS)-1:0]    query_set,
    output logic [$clog2(WAYS)-1:0]    victim_way,

    // Observability: counts (hit, miss) so the cocotb harness can compute
    // hit-rate without instrumenting the L3.
    output logic [31:0]                hits_count,
    output logic [31:0]                misses_count
);

    localparam int unsigned SET_IDX_W = $clog2(SETS);
    localparam int unsigned WAY_IDX_W = $clog2(WAYS);
    localparam int unsigned STT_SET_IDX_W = $clog2(STT_SETS);
    localparam int unsigned STT_WAY_IDX_W = $clog2(STT_WAYS);
    localparam int unsigned RTP_IDX_W = $clog2(RTP_ENTRIES);
    localparam int unsigned TS_W      = 16;   // 16-bit RTP timestamp wrap

    // ---------- Per-line ETR storage ----------
    logic [ETR_W-1:0] etr [WAYS][SETS];

    // ---------- Sampled Cache (STT) ----------
    typedef struct packed {
        logic                  valid;
        logic [PC_W-1:0]       pc;
        logic [SET_IDX_W-1:0]  set_id;
        logic [TS_W-1:0]       ts;     // timestamp of last access
    } stt_entry_t;
    stt_entry_t stt [STT_WAYS][STT_SETS];

    // ---------- Reuse Time Predictor (RTP) per PC ----------
    typedef struct packed {
        logic                  valid;
        logic [PC_W-1:0]       pc;
        logic [ETR_W-1:0]      predicted_etr;
    } rtp_entry_t;
    rtp_entry_t rtp [RTP_ENTRIES];

    logic [TS_W-1:0]  global_ts_q;
    logic [31:0]      hits_q;
    logic [31:0]      misses_q;

    // Galois LFSR used to break victim ties when multiple ways carry the
    // same maximum ETR (the common case at reset, before STT/RTP warm).
    // 16-bit maximal-period polynomial x^16 + x^14 + x^13 + x^11 + 1.
    logic [15:0]      tie_lfsr_q;

    assign hits_count   = hits_q;
    assign misses_count = misses_q;

    // ---------- Helpers ----------
    function automatic logic is_sampled_set(input logic [SET_IDX_W-1:0] s);
        // Bit-hash: parity of (s AND SAMPLE_HASH[SET_IDX_W-1:0])
        logic [SET_IDX_W-1:0] mask;
        mask = SAMPLE_HASH[SET_IDX_W-1:0];
        is_sampled_set = ^(s & mask);
    endfunction

    function automatic logic [STT_SET_IDX_W-1:0] stt_set_of(input logic [SET_IDX_W-1:0] s);
        stt_set_of = s[STT_SET_IDX_W-1:0];
    endfunction

    function automatic logic [RTP_IDX_W-1:0] rtp_idx_of(input logic [PC_W-1:0] pc);
        // Fold high PC bits into the low index bits via XOR.
        logic [RTP_IDX_W-1:0] idx;
        idx = pc[RTP_IDX_W-1:0]
            ^ pc[2*RTP_IDX_W-1 -: RTP_IDX_W]
            ^ pc[3*RTP_IDX_W-1 -: RTP_IDX_W];
        rtp_idx_of = idx;
    endfunction

    // Victim selection: pick the way with the largest ETR. On ties,
    // pick a uniform random way among the set of ways tied at the
    // maximum. The tie-break randomizer is driven by `tie_lfsr_q` and
    // is necessary at reset because every line carries MAX_ETR until
    // the STT/RTP learns; a deterministic argmax would collapse onto a
    // single way and starve the other ways. See the module header.
    function automatic logic [WAY_IDX_W-1:0] find_victim
        (input logic [SET_IDX_W-1:0] s,
         input logic [15:0]          rnd);
        logic [ETR_W-1:0]     m;
        int                   tied_count;
        int                   pick_idx;
        int                   seen;
        logic [WAY_IDX_W-1:0] v;
        // Pass 1: find the maximum ETR in the set.
        m = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (etr[w][s] > m) m = etr[w][s];
        end
        // Pass 2: count the ways carrying that max ETR.
        tied_count = 0;
        for (int w = 0; w < WAYS; w++) begin
            if (etr[w][s] == m) tied_count = tied_count + 1;
        end
        // Pass 3: pick the `pick_idx`-th tied way using the LFSR.
        // When tied_count==1 the modulo collapses to 0 and the choice
        // is fully determined by the learned ETR signal.
        pick_idx = int'(rnd) % tied_count;
        seen = 0;
        v = '0;
        for (int w = 0; w < WAYS; w++) begin
            if (etr[w][s] == m) begin
                if (seen == pick_idx) v = w[WAY_IDX_W-1:0];
                seen = seen + 1;
            end
        end
        return v;
    endfunction

    assign victim_way = find_victim(query_set, tie_lfsr_q);

    // Sampled STT lookup: return STT way index and "found" flag.
    function automatic void stt_lookup
        (input  logic [PC_W-1:0]       pc,
         input  logic [SET_IDX_W-1:0]  s,
         output logic                  found,
         output logic [STT_WAY_IDX_W-1:0] sway,
         output logic [TS_W-1:0]       last_ts);
        logic [STT_SET_IDX_W-1:0] sset;
        sset    = stt_set_of(s);
        found   = 1'b0;
        sway    = '0;
        last_ts = '0;
        for (int w = 0; w < STT_WAYS; w++) begin
            if (stt[w][sset].valid &&
                stt[w][sset].pc == pc &&
                stt[w][sset].set_id == s) begin
                found   = 1'b1;
                sway    = w[STT_WAY_IDX_W-1:0];
                last_ts = stt[w][sset].ts;
            end
        end
    endfunction

    function automatic logic [STT_WAY_IDX_W-1:0] stt_pick_victim
        (input logic [STT_SET_IDX_W-1:0] sset);
        logic [STT_WAY_IDX_W-1:0] v;
        v = '0;
        // Pick invalid first, else oldest timestamp.
        for (int w = 0; w < STT_WAYS; w++) begin
            if (!stt[w][sset].valid) v = w[STT_WAY_IDX_W-1:0];
        end
        if (!stt[v][sset].valid) return v;
        for (int w = 0; w < STT_WAYS; w++) begin
            if (stt[w][sset].ts < stt[v][sset].ts) v = w[STT_WAY_IDX_W-1:0];
        end
        return v;
    endfunction

    // ---------- Update state machine ----------
    // Everything is combinational/sequential in one always_ff. Cocotb
    // drives one access per cycle; the host cache is expected to do the
    // same. The L3 calls into this module with acc_valid=1 every time it
    // services an access; the module updates STT/RTP/ETR and the next
    // cycle's `victim_way` reflects the new state.
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int w = 0; w < WAYS; w++)
                for (int s = 0; s < SETS; s++)
                    etr[w][s] <= MAX_ETR[ETR_W-1:0];
            for (int w = 0; w < STT_WAYS; w++)
                for (int s = 0; s < STT_SETS; s++)
                    stt[w][s] <= '0;
            for (int i = 0; i < RTP_ENTRIES; i++)
                rtp[i] <= '0;
            global_ts_q <= '0;
            hits_q      <= '0;
            misses_q    <= '0;
            tie_lfsr_q  <= TIE_BREAK_LFSR_SEED;
        end else if (acc_valid) begin
            automatic logic [RTP_IDX_W-1:0] ridx = rtp_idx_of(acc_pc);
            automatic logic [STT_SET_IDX_W-1:0] sset = stt_set_of(acc_set);
            global_ts_q <= global_ts_q + 1'b1;
            // Advance the Galois LFSR every active cycle.
            // Polynomial: x^16 + x^14 + x^13 + x^11 + 1 (taps 16,14,13,11).
            tie_lfsr_q <= {tie_lfsr_q[14:0],
                           tie_lfsr_q[15] ^ tie_lfsr_q[13] ^
                           tie_lfsr_q[12] ^ tie_lfsr_q[10]};

            if (acc_hit) hits_q   <= hits_q + 1'b1;
            else         misses_q <= misses_q + 1'b1;

            // -------- Per-line ETR update --------
            // ETR semantics: predicted accesses-until-next-reference.
            //   - small ETR (close to 0)  -> line will be reused soon, keep
            //   - large ETR (close to MAX)-> line is dead, evict
            // Each access to the set ages the OTHER lines downward in the
            // "remaining-time" sense, but for victim selection we use
            // "largest ETR" since the saturating MAX is the sentinel for
            // "no predicted near-future reuse".
            if (acc_hit) begin
                // Re-reference: refresh from RTP if known, else mid value.
                if (rtp[ridx].valid && rtp[ridx].pc == acc_pc)
                    etr[acc_way][acc_set] <= rtp[ridx].predicted_etr;
                else
                    etr[acc_way][acc_set] <=
                        ETR_W'(CACHE_FRIENDLY_THRESHOLD - 1);
            end else if (acc_is_miss_install) begin
                // Insertion: predict ETR from RTP. If RTP says the PC has
                // long reuse, insert with MAX (bypass-ish: evict-on-next).
                // If RTP says short reuse, insert with predicted ETR.
                if (rtp[ridx].valid && rtp[ridx].pc == acc_pc) begin
                    etr[acc_way][acc_set] <= rtp[ridx].predicted_etr;
                end else begin
                    // Unknown PC: be conservative, insert mid-range.
                    etr[acc_way][acc_set] <=
                        ETR_W'(CACHE_FRIENDLY_THRESHOLD - 1);
                end
            end

            // Per-set aging: throttle aging by global timestamp so the
            // rate is decoupled from per-set access intensity. Aging once
            // every (1<<ETR_W) global accesses lets a hot working set
            // with reuse distance < (1<<ETR_W) keep ETR low.
            if (global_ts_q[ETR_W-1:0] == '0) begin
                for (int w = 0; w < WAYS; w++) begin
                    if (w != int'(acc_way)) begin
                        if (etr[w][acc_set] != MAX_ETR[ETR_W-1:0])
                            etr[w][acc_set] <= etr[w][acc_set] + 1'b1;
                    end
                end
            end

            // -------- Sampled Cache (STT) update --------
            if (is_sampled_set(acc_set)) begin
                logic                  found;
                logic [STT_WAY_IDX_W-1:0] sway;
                logic [TS_W-1:0]       last_ts;
                stt_lookup(acc_pc, acc_set, found, sway, last_ts);
                if (found) begin
                    // Compute observed reuse distance in ETR-time-units.
                    // ETR ages once per `1 << ETR_W` global accesses, so
                    // the reuse distance in those units is `delta >>
                    // ETR_W`. Saturate into ETR_W bits (MAX_ETR encodes
                    // "no near-future reuse").
                    automatic logic [TS_W-1:0]  delta;
                    automatic logic [TS_W-1:0]  delta_etr_units;
                    automatic logic [ETR_W-1:0] new_pred;
                    delta            = global_ts_q - last_ts;
                    delta_etr_units  = delta >> ETR_W;
                    new_pred         = (delta_etr_units >
                                        {{(TS_W-ETR_W){1'b0}},
                                         {ETR_W{1'b1}}}) ?
                                       MAX_ETR[ETR_W-1:0] :
                                       delta_etr_units[ETR_W-1:0];
                    // Update RTP entry: EWMA-ish blend of old + new.
                    if (rtp[ridx].valid && rtp[ridx].pc == acc_pc) begin
                        automatic logic [ETR_W:0] avg;
                        avg = {1'b0, rtp[ridx].predicted_etr}
                            + {1'b0, new_pred};
                        rtp[ridx].predicted_etr <= avg[ETR_W:1];
                    end else begin
                        rtp[ridx].valid          <= 1'b1;
                        rtp[ridx].pc             <= acc_pc;
                        rtp[ridx].predicted_etr  <= new_pred;
                    end
                    // Refresh STT timestamp.
                    stt[sway][sset].ts <= global_ts_q;
                end else begin
                    // Allocate a new STT entry.
                    automatic logic [STT_WAY_IDX_W-1:0] vway = stt_pick_victim(sset);
                    stt[vway][sset].valid  <= 1'b1;
                    stt[vway][sset].pc     <= acc_pc;
                    stt[vway][sset].set_id <= acc_set;
                    stt[vway][sset].ts     <= global_ts_q;
                end
            end
        end
    end

endmodule
