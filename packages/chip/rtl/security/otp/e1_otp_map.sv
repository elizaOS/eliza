// e1_otp_map.sv
// OTP controller for the e1 root-of-trust (W4).
//
// Implements the fuse map defined by docs/security/otp-fuse-map.md and the
// machine-readable partition model docs/spec-db/tee-otp-fuse-map.json. The
// word-granular partition layout (32-bit words) matches the JSON model that
// scripts/check_otp_fuse_map.py validates; the per-field write authorization
// and read fault semantics come from otp-fuse-map.md §2-§4.
//
// Storage model (pre-silicon, no OTP IP selected): each logical 32-bit word is
// backed by three redundant physical rows (1-of-3 replication, §3). The rows
// are antifuse-style: bits are OR-only / one-time-program and never cleared in
// the field. At reset the three rows are sampled into a shadow register; reads
// serve a 2-of-3 bitwise majority of the shadow rows. A word whose three rows
// have no bitwise majority on any bit (a double-row fault) drives the hard
// parity-fault output, which ROM must observe before consuming any value
// (HALT: code=OTP_PARITY).
//
// MMIO slave interface follows the convention used by rtl/security/lc/e1_lc_ctrl.sv:
// a single valid/write/addr/wdata/rdata register port. addr is the word index
// into the OTP image (byte address >> 2). Reads return the majority value of the
// addressed word. Writes are gated by the write controller and silently dropped
// when illegal, raising a one-cycle tamper_event_o pulse.
//
// The backing rows are loaded at reset from the provisioning ports
// (otp_row*_init_i): a behavioral macro model. Synthesis-clean: no delays, no
// initial blocks, single synchronous reset.

`timescale 1ns/1ps

module e1_otp_map #(
    // Word-granular partition layout, mirrored from
    // docs/spec-db/tee-otp-fuse-map.json. Offsets and widths are in 32-bit words.
    parameter int unsigned WORD_BITS            = 32,
    parameter int unsigned CREATOR_ROOT_OFF     = 0,
    parameter int unsigned CREATOR_ROOT_WORDS   = 8,
    parameter int unsigned OWNER_ROOT_OFF       = 8,
    parameter int unsigned OWNER_ROOT_WORDS     = 8,
    parameter int unsigned DEVICE_ID_OFF        = 16,
    parameter int unsigned DEVICE_ID_WORDS      = 4,
    parameter int unsigned LIFECYCLE_OFF        = 20,
    parameter int unsigned LIFECYCLE_WORDS      = 2,
    parameter int unsigned ROLLBACK_OFF         = 22,
    parameter int unsigned ROLLBACK_WORDS       = 2,
    parameter int unsigned DEBUG_AUTH_OFF       = 24,
    parameter int unsigned DEBUG_AUTH_WORDS     = 8,
    // Total addressable words. Must cover the last partition.
    parameter int unsigned OTP_WORDS            = 32
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // MMIO slave port (word-indexed). addr is the OTP word index.
    input  logic                       valid,
    input  logic                       write,
    input  logic [$clog2(OTP_WORDS)-1:0] addr,
    input  logic [WORD_BITS-1:0]       wdata,
    output logic [WORD_BITS-1:0]       rdata,

    // Sensitive-write authorization: asserted by ROM/key manager when a signed
    // authorization blob has been verified for this transaction (§4.2). Gates
    // LOCKED->RMA, root rotation and revocation programming.
    input  logic                       auth_ok_i,

    // Backing macro initial contents, one bus per redundant row. A behavioral
    // model of the antifuse macro: the provisioning environment / cocotb drives
    // the programmed image; silicon replaces this with the OTP read port.
    input  logic [OTP_WORDS*WORD_BITS-1:0] otp_row0_init_i,
    input  logic [OTP_WORDS*WORD_BITS-1:0] otp_row1_init_i,
    input  logic [OTP_WORDS*WORD_BITS-1:0] otp_row2_init_i,

    // Hard fault: at least one consumed word has no 2-of-3 bitwise majority.
    // Sticky once set; ROM halts before any signature check.
    output logic                       otp_parity_fault_o,

    // One-cycle pulse on a dropped (unauthorized / illegal) write attempt.
    output logic                       tamper_event_o,

    // Decoded lifecycle state, one-hot per otp-fuse-map.md §2 (bit index =
    // state). Reflects the majority value of the lifecycle word.
    output logic [7:0]                 lifecycle_state_o
);

    // ----------------------------------------------------------------
    // Lifecycle one-hot bit positions (otp-fuse-map.md §2)
    // ----------------------------------------------------------------
    localparam int unsigned LC_BLANK  = 0;
    localparam int unsigned LC_DEV    = 1;
    localparam int unsigned LC_MFG    = 2;
    localparam int unsigned LC_LOCKED = 3;
    localparam int unsigned LC_RMA    = 4;
    localparam int unsigned LC_SCRAP  = 5;

    // ----------------------------------------------------------------
    // Backing storage: three redundant rows per word, shadow-loaded at reset.
    // Antifuse semantics: a write may only set bits (OR), never clear them.
    // ----------------------------------------------------------------
    logic [WORD_BITS-1:0] row0_q [OTP_WORDS];
    logic [WORD_BITS-1:0] row1_q [OTP_WORDS];
    logic [WORD_BITS-1:0] row2_q [OTP_WORDS];

    // 2-of-3 bitwise majority of the three shadow rows for a given word.
    function automatic logic [WORD_BITS-1:0] majority3(
        input logic [WORD_BITS-1:0] a,
        input logic [WORD_BITS-1:0] b,
        input logic [WORD_BITS-1:0] c
    );
        return (a & b) | (a & c) | (b & c);
    endfunction

    // Parity fault detection (§3 "parity-mismatch read raises a hard fault").
    // A row is corrupt when it differs from the 2-of-3 majority on any bit. One
    // corrupt row is tolerated because majority recovers the true value; two or
    // three corrupt rows mean the majority is no longer trustworthy, so the
    // word is faulted.
    function automatic logic word_faulted(
        input logic [WORD_BITS-1:0] a,
        input logic [WORD_BITS-1:0] b,
        input logic [WORD_BITS-1:0] c
    );
        logic [WORD_BITS-1:0] maj;
        logic a_bad;
        logic b_bad;
        logic c_bad;
        maj   = majority3(a, b, c);
        a_bad = |(a ^ maj);
        b_bad = |(b ^ maj);
        c_bad = |(c ^ maj);
        return ((a_bad ? 1 : 0) + (b_bad ? 1 : 0) + (c_bad ? 1 : 0)) >= 2;
    endfunction

    // ----------------------------------------------------------------
    // Partition / field decode helpers
    // ----------------------------------------------------------------
    function automatic logic in_partition(
        input logic [$clog2(OTP_WORDS)-1:0] word_idx,
        input int unsigned base,
        input int unsigned len
    );
        int unsigned idx;
        idx = {{(32-$clog2(OTP_WORDS)){1'b0}}, word_idx};
        return (idx >= base) && (idx < (base + len));
    endfunction

    // Word index of the addressed transaction.
    logic [$clog2(OTP_WORDS)-1:0] sel;
    assign sel = addr;

    // Majority value of the addressed word (read data path).
    logic [WORD_BITS-1:0] sel_majority;
    assign sel_majority = majority3(row0_q[sel], row1_q[sel], row2_q[sel]);

    // ----------------------------------------------------------------
    // Lifecycle decode (low word of the lifecycle partition holds the one-hot)
    // ----------------------------------------------------------------
    logic [WORD_BITS-1:0] lifecycle_word;
    assign lifecycle_word =
        majority3(row0_q[LIFECYCLE_OFF], row1_q[LIFECYCLE_OFF], row2_q[LIFECYCLE_OFF]);
    assign lifecycle_state_o = lifecycle_word[7:0];

    // A blank (unprogrammed) fuse array reads all-zero, so BLANK is the absence
    // of any set lifecycle bit. The effective state is the highest set bit
    // (§2: "Reader reports the highest set bit"); later states OR in over the
    // device lifetime but the highest bit governs gating.
    logic lc_blank;
    logic lc_dev;
    logic lc_mfg;
    logic lc_locked;
    logic lc_rma;
    logic lc_scrap;
    assign lc_dev    = lifecycle_word[LC_DEV];
    assign lc_mfg    = lifecycle_word[LC_MFG];
    assign lc_locked = lifecycle_word[LC_LOCKED];
    assign lc_rma    = lifecycle_word[LC_RMA];
    assign lc_scrap  = lifecycle_word[LC_SCRAP];
    assign lc_blank  = (lifecycle_word[7:0] == 8'h00);

    // Effective state = highest set bit. Used for the per-field write gates.
    logic lc_at_or_after_locked;
    assign lc_at_or_after_locked = lc_locked || lc_rma || lc_scrap;
    // Current effective state ordinal (BLANK<DEV<MFG<LOCKED<RMA<SCRAP).
    logic [2:0] lc_state;
    always_comb begin
        if (lc_scrap)       lc_state = 3'(LC_SCRAP);
        else if (lc_rma)    lc_state = 3'(LC_RMA);
        else if (lc_locked) lc_state = 3'(LC_LOCKED);
        else if (lc_mfg)    lc_state = 3'(LC_MFG);
        else if (lc_dev)    lc_state = 3'(LC_DEV);
        else                lc_state = 3'(LC_BLANK);
    end

    // MFG one-time write window: open while the device is in BLANK/DEV/MFG and
    // not yet LOCKED. Closes once LOCKED (or beyond) is reached. This models
    // "valid one-time write window opened by ROM during MFG flow, closed on
    // first reset after MFG->LOCKED" (§4.3): because shadow rows are reloaded at
    // reset, the window is purely a function of the loaded lifecycle state.
    logic mfg_window_open;
    assign mfg_window_open = !lc_at_or_after_locked;

    // ----------------------------------------------------------------
    // Write authorization: classify the addressed word and decide acceptance.
    // ----------------------------------------------------------------
    logic is_creator_root;
    logic is_owner_root;
    logic is_device_id;
    logic is_lifecycle;
    logic is_rollback;
    logic is_debug_auth;

    always_comb begin
        is_creator_root = in_partition(sel, CREATOR_ROOT_OFF, CREATOR_ROOT_WORDS);
        is_owner_root   = in_partition(sel, OWNER_ROOT_OFF, OWNER_ROOT_WORDS);
        is_device_id    = in_partition(sel, DEVICE_ID_OFF, DEVICE_ID_WORDS);
        is_lifecycle    = in_partition(sel, LIFECYCLE_OFF, LIFECYCLE_WORDS);
        is_rollback     = in_partition(sel, ROLLBACK_OFF, ROLLBACK_WORDS);
        is_debug_auth   = in_partition(sel, DEBUG_AUTH_OFF, DEBUG_AUTH_WORDS);
    end

    // OR-only delta: bits the write wants to set that are not already set.
    logic [WORD_BITS-1:0] set_bits;
    assign set_bits = wdata & ~sel_majority;

    // A write attempts to clear a programmed bit (illegal for antifuse fields).
    logic clears_bits;
    assign clears_bits = |(sel_majority & ~wdata);

    // Lifecycle transition legality (§2). A write OR's in exactly one new state
    // bit; the legal next bit is a function of the current effective state.
    // SCRAP is allowed from any state; LOCKED->RMA requires signed auth.
    logic lc_legal;
    always_comb begin
        lc_legal = 1'b0;
        if (set_bits == (32'b1 << LC_SCRAP)) begin
            lc_legal = 1'b1;                                  // * -> SCRAP
        end else if (lc_blank && set_bits == (32'b1 << LC_DEV)) begin
            lc_legal = 1'b1;                                  // BLANK -> DEV
        end else if (lc_blank && set_bits == (32'b1 << LC_MFG)) begin
            lc_legal = 1'b1;                                  // BLANK -> MFG
        end else if ((lc_state == 3'(LC_MFG)) &&
                     set_bits == (32'b1 << LC_LOCKED)) begin
            lc_legal = 1'b1;                                  // MFG -> LOCKED
        end else if ((lc_state == 3'(LC_LOCKED)) && auth_ok_i &&
                     set_bits == (32'b1 << LC_RMA)) begin
            lc_legal = 1'b1;                                  // LOCKED -> RMA (gated)
        end
    end

    // Per-field write acceptance.
    logic write_accept;
    always_comb begin
        write_accept = 1'b0;
        if (valid && write) begin
            if (clears_bits) begin
                // Antifuse cannot clear a programmed bit; always illegal.
                write_accept = 1'b0;
            end else if (set_bits == '0) begin
                // No-op write (all requested bits already set): accept silently,
                // no state change, no tamper.
                write_accept = 1'b1;
            end else if (is_lifecycle) begin
                write_accept = lc_legal;
            end else if (is_rollback) begin
                // Unary advance-only: any OR-only set is a legal advance. The
                // OR-only / clears_bits guard above already forbids un-setting.
                write_accept = 1'b1;
            end else if (is_creator_root || is_owner_root) begin
                // Root key hashes: MFG window only, locked once LOCKED.
                // Root rotation after lock requires signed auth (§4.2).
                write_accept = mfg_window_open || (lc_at_or_after_locked && auth_ok_i);
            end else if (is_debug_auth) begin
                // debug_auth_pubkey_hash: MFG-only programming.
                write_accept = mfg_window_open;
            end else if (is_device_id) begin
                // device_id: MFG-only programming.
                write_accept = mfg_window_open;
            end else begin
                // Reserved / unknown words: not writable through this port.
                write_accept = 1'b0;
            end
        end
    end

    logic write_drop;
    assign write_drop = valid && write && !write_accept;

    // ----------------------------------------------------------------
    // Storage update (antifuse OR-only) and reset shadow load.
    // ----------------------------------------------------------------
    integer i;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (i = 0; i < OTP_WORDS; i = i + 1) begin
                row0_q[i] <= otp_row0_init_i[i*WORD_BITS +: WORD_BITS];
                row1_q[i] <= otp_row1_init_i[i*WORD_BITS +: WORD_BITS];
                row2_q[i] <= otp_row2_init_i[i*WORD_BITS +: WORD_BITS];
            end
        end else if (valid && write && write_accept && (set_bits != '0)) begin
            // Program the set bits into all three redundant rows (OR-only).
            row0_q[sel] <= row0_q[sel] | set_bits;
            row1_q[sel] <= row1_q[sel] | set_bits;
            row2_q[sel] <= row2_q[sel] | set_bits;
        end
    end

    // ----------------------------------------------------------------
    // Parity fault: sticky once any consumed word shows a double-row fault.
    // Scanned across all words every cycle so the fault asserts before ROM
    // consumes a value, independent of the current MMIO address.
    // ----------------------------------------------------------------
    logic any_word_faulted;
    always_comb begin
        any_word_faulted = 1'b0;
        for (int unsigned w = 0; w < OTP_WORDS; w = w + 1) begin
            if (word_faulted(row0_q[w], row1_q[w], row2_q[w])) begin
                any_word_faulted = 1'b1;
            end
        end
    end

    logic parity_fault_q;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            parity_fault_q <= 1'b0;
        end else if (any_word_faulted) begin
            parity_fault_q <= 1'b1;
        end
    end
    assign otp_parity_fault_o = parity_fault_q || any_word_faulted;

    // ----------------------------------------------------------------
    // Tamper pulse on dropped write.
    // ----------------------------------------------------------------
    logic tamper_q;
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tamper_q <= 1'b0;
        end else begin
            tamper_q <= write_drop;
        end
    end
    assign tamper_event_o = tamper_q;

    // ----------------------------------------------------------------
    // Read data: majority value of the addressed word on a read transaction.
    // ----------------------------------------------------------------
    always_comb begin
        rdata = '0;
        if (valid && !write) begin
            rdata = sel_majority;
        end
    end

endmodule
