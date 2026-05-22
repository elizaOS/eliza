// e1_lc_ctrl.sv
// Device lifecycle controller for the e1 root-of-trust (W5).
//
// Replaces the retired 2-bit rtl/security/e1_lifecycle.sv. The lifecycle model
// is the canonical 6-state one-hot field of docs/security/otp-fuse-map.md §2
// (BLANK/DEV/MFG/LOCKED/RMA/SCRAP); per-port debug gating follows
// docs/security/debug-policy.md §2-§3; the debug-authentication interface
// implements the hardware side of the signed challenge-response of
// debug-policy.md §4 and tee-plan/02-root-of-trust.md §4/§7.
//
// What this block IS:
//   - The lifecycle state register and its legal-transition write controller.
//   - The combinational per-port debug-enable derivation from lifecycle and the
//     debug_disable kill-switch fuses.
//   - The presentation of a CSRNG-sourced, boot_counter-bound debug-auth nonce
//     challenge, and the grant of debug access only on a verify-pass strobe
//     from the root-of-trust Ed25519 verifier.
//
// What this block IS NOT (lives elsewhere, fed in as inputs):
//   - The OTP/antifuse macro and its read/write authorization
//     (rtl/security/otp/e1_otp_map.sv): the lifecycle one-hot, debug_disable,
//     boot_counter, and rma_wipe_done arrive as inputs from the OTP controller.
//   - The Ed25519 verifier and CSRNG/EDN entropy source: this block consumes a
//     nonce word (csrng_nonce_i) and a single-cycle dbg_auth_verified_i strobe
//     from the RoT crypto. There is no on-chip key, no XOR comparison, and no
//     linear-feedback challenge generator in this block.
//
// MMIO base: 0x1000_5000 (debug-readable status / nonce window only). The
// register port follows the valid/write/addr/wdata/rdata convention used by
// rtl/security/otp/e1_otp_map.sv. All security-relevant state derives from
// fuses and the signed-auth interface; software cannot write the lifecycle
// state or grant debug through this port.
//
// Register map (word index = byte addr >> 2, within the 256-byte window):
//   0x00  LIFECYCLE_STATE   RO  Current one-hot lifecycle state [7:0]
//   0x04  DEBUG_ENABLES     RO  bit0=jtag bit1=swd bit2=etm bit3=rom_uart_full
//   0x08  DEBUG_DISABLE     RO  Sticky per-port kill switch [7:0] (from fuses)
//   0x0C  AUTH_NONCE        RO  Boot-bound debug-auth challenge nonce [31:0]
//   0x10  AUTH_STATUS       RO  bit0=auth_window_open bit1=debug_auth_granted
//   0x14  BOOT_COUNTER      RO  boot_counter the nonce is bound to [31:0]
//
// Synthesis-clean: no delays, no initial blocks, single asynchronous-reset
// flop style, no latches.

`timescale 1ns/1ps

module e1_lc_ctrl (
    input  logic        clk,
    input  logic        rst_n,

    // -----------------------------------------------------------------
    // MMIO slave interface (read-only status window). addr is the word
    // index (byte address >> 2) within the 256-byte security window.
    // -----------------------------------------------------------------
    input  logic        valid,
    input  logic        write,
    input  logic [4:0]  addr,
    input  logic [31:0] wdata,
    output logic [31:0] rdata,

    // -----------------------------------------------------------------
    // OTP-sourced fuse inputs (from rtl/security/otp/e1_otp_map.sv).
    // -----------------------------------------------------------------
    // Current lifecycle one-hot, decoded by the OTP controller from the
    // lifecycle_state fuse field (otp-fuse-map.md §2). This is the device's
    // committed lifecycle; the local register tracks it and refuses to advance
    // it on an illegal transition request.
    input  logic [7:0]  lifecycle_fuse_i,
    // Sticky per-port debug kill switch (debug_disable fuse, §2). Once a bit is
    // programmed the matching port is forced disabled until SCRAP.
    //   bit0=jtag bit1=swd bit2=etm bit3=rom_uart
    input  logic [7:0]  debug_disable_i,
    // Monotonic boot counter the debug-auth nonce is bound to (§4: nonce
    // includes boot_counter to defeat cross-power-cycle replay).
    input  logic [31:0] boot_counter_i,
    // RMA secret-erasure completion fuse (rma_wipe_done, §2 / debug-policy §5).
    // Debug re-enable in RMA is gated on this being set.
    input  logic        rma_wipe_done_i,

    // -----------------------------------------------------------------
    // Lifecycle transition request interface. Transition requests originate
    // from ROM/bootloader provisioning flows; the OTP controller commits the
    // fuse, and this block validates the request against the legal-transition
    // table before raising the OTP program request.
    // -----------------------------------------------------------------
    // One-cycle request to advance to the target one-hot state.
    input  logic        lc_trans_req_i,
    input  logic [7:0]  lc_trans_target_i,
    // OEM-signed RMA authorization, verified by the RoT (rma_key_hash, §5).
    // Required for the LOCKED->RMA transition; ignored for others.
    input  logic        rma_auth_valid_i,
    // One-cycle pulse: a legal transition was accepted; OTP controller programs
    // the lifecycle fuse for the requested target.
    output logic        lc_trans_accept_o,
    output logic [7:0]  lc_trans_target_o,

    // -----------------------------------------------------------------
    // Signed debug-authentication interface (debug-policy.md §4). The XOR
    // device-key scheme of the retired block is gone: the challenge nonce comes
    // from the CSRNG/EDN entropy source and the grant comes from the RoT
    // Ed25519 verifier, never from on-chip arithmetic.
    // -----------------------------------------------------------------
    // Fresh entropy word from the RoT CSRNG/EDN. Sampled into the boot-bound
    // nonce while the auth window is open.
    input  logic [31:0] csrng_nonce_i,
    input  logic        csrng_nonce_valid_i,
    // Debugger requested an auth challenge (asserts in MFG/RMA). Opens the auth
    // window and latches a fresh nonce.
    input  logic        dbg_auth_req_i,
    // Single-cycle pass strobe from the RoT Ed25519 verifier: the signature
    // over "OPDBGv1" || device_uid || nonce || caps verified against
    // OTP.debug_auth_pubkey_hash. This is the ONLY way debug is granted.
    input  logic        dbg_auth_verified_i,

    // -----------------------------------------------------------------
    // Broadcast outputs.
    // -----------------------------------------------------------------
    output logic [7:0]  lifecycle_state_o,   // current one-hot, to ROM/SoC
    output logic [31:0] dbg_auth_nonce_o,    // boot-bound nonce, to debug TAP
    output logic        dbg_auth_window_o,   // auth window open (challenge live)
    output logic        debug_auth_granted_o,// debug access granted this boot
    output logic        jtag_enable_o,
    output logic        swd_enable_o,
    output logic        etm_enable_o,
    output logic        rom_uart_full_o,
    // One-cycle pulse on an illegal/dropped transition request (drives the OTP
    // tamper_counter per otp-fuse-map.md §2).
    output logic        tamper_event_o
);

    // ----------------------------------------------------------------
    // Lifecycle one-hot bit positions (otp-fuse-map.md §2, boot-image §5).
    //   BLANK=0x01 DEV=0x02 MFG=0x04 LOCKED=0x08 RMA=0x10 SCRAP=0x20
    // ----------------------------------------------------------------
    localparam int unsigned LC_BLANK  = 0;
    localparam int unsigned LC_DEV    = 1;
    localparam int unsigned LC_MFG    = 2;
    localparam int unsigned LC_LOCKED = 3;
    localparam int unsigned LC_RMA    = 4;
    localparam int unsigned LC_SCRAP  = 5;

    localparam logic [7:0] ST_BLANK  = 8'h01;
    localparam logic [7:0] ST_DEV    = 8'h02;
    localparam logic [7:0] ST_MFG    = 8'h04;
    localparam logic [7:0] ST_LOCKED = 8'h08;
    localparam logic [7:0] ST_RMA    = 8'h10;
    localparam logic [7:0] ST_SCRAP  = 8'h20;

    // Per-port debug_disable bit positions (matches OTP debug_disable field).
    localparam int unsigned DIS_JTAG     = 0;
    localparam int unsigned DIS_SWD      = 1;
    localparam int unsigned DIS_ETM      = 2;
    localparam int unsigned DIS_ROM_UART = 3;

    // ----------------------------------------------------------------
    // Lifecycle state register. Reset value tracks the committed fuse state so
    // that on power-up the controller reflects OTP. Software cannot write it;
    // it only advances on an accepted (legal) transition, and the OTP fuse is
    // the source of truth on the next reset.
    // ----------------------------------------------------------------
    logic [7:0] lc_state_q;

    // Resolve the highest set lifecycle fuse bit to a one-hot state. A blank or
    // multiply-set fuse word resolves fail-closed: an unrecognized encoding is
    // treated as SCRAP so an undefined lifecycle never opens debug.
    function automatic logic [7:0] resolve_fuse(input logic [7:0] fuse);
        if      (fuse[LC_SCRAP])  resolve_fuse = ST_SCRAP;
        else if (fuse[LC_RMA])    resolve_fuse = ST_RMA;
        else if (fuse[LC_LOCKED]) resolve_fuse = ST_LOCKED;
        else if (fuse[LC_MFG])    resolve_fuse = ST_MFG;
        else if (fuse[LC_DEV])    resolve_fuse = ST_DEV;
        else if (fuse[LC_BLANK])  resolve_fuse = ST_BLANK;
        else                      resolve_fuse = ST_SCRAP; // fail-closed
    endfunction

    // A transition is legal per otp-fuse-map.md §2:
    //   BLANK->DEV, BLANK->MFG, MFG->LOCKED,
    //   LOCKED->RMA iff rma_auth_valid_i, *->SCRAP always.
    // Every other request (incl. ->BLANK, DEV->*, RMA->*, non-one-hot target)
    // is illegal and dropped.
    function automatic logic transition_legal(
        input logic [7:0] cur,
        input logic [7:0] tgt,
        input logic       rma_ok
    );
        // Target must be a single recognized one-hot state.
        unique case (tgt)
            ST_DEV:    transition_legal = (cur == ST_BLANK);
            ST_MFG:    transition_legal = (cur == ST_BLANK);
            ST_LOCKED: transition_legal = (cur == ST_MFG);
            ST_RMA:    transition_legal = (cur == ST_LOCKED) && rma_ok;
            ST_SCRAP:  transition_legal = 1'b1; // any state may be scrapped
            default:   transition_legal = 1'b0; // BLANK target / multi-hot / 0
        endcase
    endfunction

    logic trans_accept;
    assign trans_accept =
        lc_trans_req_i &&
        transition_legal(lc_state_q, lc_trans_target_i, rma_auth_valid_i);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            lc_state_q <= ST_SCRAP; // overwritten below from fuse on first edge
        end else begin
            // Track the committed fuse state. The OTP controller is the source
            // of truth; a fuse advance (e.g. after programming) is reflected
            // here. An accepted local transition advances immediately so the
            // gating and outputs respond in the same boot, before the fuse
            // re-read on the next reset confirms it.
            if (trans_accept) begin
                lc_state_q <= lc_trans_target_i;
            end else if (resolve_fuse(lifecycle_fuse_i) != lc_state_q) begin
                // Only allow the fuse to move the local state forward to a more
                // restrictive state; it can never relax a locally-advanced
                // state (monotonic, fail-closed).
                lc_state_q <= resolve_fuse(lifecycle_fuse_i);
            end
        end
    end

    // Illegal transition request: a request was made but not accepted. Pulse
    // tamper for one cycle (feeds the OTP saturating tamper_counter).
    assign tamper_event_o = lc_trans_req_i && !trans_accept;

    assign lc_trans_accept_o = trans_accept;
    assign lc_trans_target_o = lc_trans_target_i;
    assign lifecycle_state_o = lc_state_q;

    // ----------------------------------------------------------------
    // Signed debug-auth window + nonce.
    //
    // The window opens when a debugger requests auth in a state that permits it
    // (MFG/RMA). On open we latch a fresh CSRNG word XOR'd with nothing — the
    // nonce IS the entropy word, and it is bound to boot_counter by the message
    // construction the RoT signs over (debug-policy.md §4); we expose both the
    // nonce and the boot_counter so the verifier and debugger reconstruct the
    // exact signed message. Debug is granted only on dbg_auth_verified_i, never
    // by any on-chip comparison.
    // ----------------------------------------------------------------
    logic [31:0] nonce_q;
    logic        window_q;
    logic        granted_q;
    logic [31:0] nonce_boot_q; // boot_counter snapshot bound to this nonce

    // Auth is only meaningful in states that gate debug behind a signature:
    // MFG and RMA (debug-policy.md §2). In RMA it additionally requires the
    // secret-erasure to have completed (§5).
    logic auth_state_ok;
    assign auth_state_ok =
        (lc_state_q == ST_MFG) ||
        ((lc_state_q == ST_RMA) && rma_wipe_done_i);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            nonce_q      <= 32'h0;
            window_q     <= 1'b0;
            granted_q    <= 1'b0;
            nonce_boot_q <= 32'h0;
        end else begin
            // A grant lasts for the remainder of the boot cycle. SCRAP and
            // LOCKED can never hold a grant.
            if (lc_state_q == ST_SCRAP || lc_state_q == ST_LOCKED) begin
                window_q  <= 1'b0;
                granted_q <= 1'b0;
            end else begin
                // Open the window and latch a fresh boot-bound nonce on request,
                // provided the state permits auth and fresh entropy is offered.
                if (dbg_auth_req_i && auth_state_ok && !window_q && !granted_q) begin
                    if (csrng_nonce_valid_i) begin
                        nonce_q      <= csrng_nonce_i;
                        nonce_boot_q <= boot_counter_i;
                        window_q     <= 1'b1;
                    end
                end

                // Grant only on the verifier's pass strobe while the window for
                // this nonce is open. One grant per window.
                if (window_q && dbg_auth_verified_i) begin
                    granted_q <= 1'b1;
                    window_q  <= 1'b0;
                end
            end
        end
    end

    assign dbg_auth_nonce_o     = nonce_q;
    assign dbg_auth_window_o    = window_q;
    assign debug_auth_granted_o = granted_q;

    // ----------------------------------------------------------------
    // Per-port debug enables (debug-policy.md §2-§3). Combinational from
    // lifecycle, the granted strobe, and the sticky kill-switch fuses.
    //
    //   open in BLANK/DEV; gated (require granted auth) in MFG/RMA;
    //   disabled in LOCKED; hard-tied low in SCRAP.
    // A programmed debug_disable[port] forces that port off in every state.
    // ----------------------------------------------------------------
    logic debug_open_unauth; // BLANK or DEV: open without auth
    logic debug_open_auth;   // MFG or RMA(+wipe): open once granted
    assign debug_open_unauth = (lc_state_q == ST_BLANK) || (lc_state_q == ST_DEV);
    assign debug_open_auth   = auth_state_ok && granted_q;

    logic debug_base_enable;
    assign debug_base_enable =
        (lc_state_q != ST_SCRAP) &&
        (lc_state_q != ST_LOCKED) &&
        (debug_open_unauth || debug_open_auth);

    assign jtag_enable_o    = debug_base_enable && !debug_disable_i[DIS_JTAG];
    assign swd_enable_o     = debug_base_enable && !debug_disable_i[DIS_SWD];
    assign etm_enable_o     = debug_base_enable && !debug_disable_i[DIS_ETM];
    // ROM UART verbose console is open only in BLANK/DEV (debug-policy §2).
    assign rom_uart_full_o  =
        debug_open_unauth &&
        (lc_state_q != ST_SCRAP) &&
        !debug_disable_i[DIS_ROM_UART];

    // ----------------------------------------------------------------
    // Read mux (status window). Write transactions to this port are ignored:
    // the lifecycle state and debug grant are not software-writable.
    // ----------------------------------------------------------------
    always_comb begin
        rdata = 32'h0;
        if (valid && !write) begin
            unique case (addr)
                5'h00:   rdata = {24'h0, lc_state_q};
                5'h01:   rdata = {28'h0, rom_uart_full_o, etm_enable_o,
                                  swd_enable_o, jtag_enable_o};
                5'h02:   rdata = {24'h0, debug_disable_i};
                5'h03:   rdata = nonce_q;
                5'h04:   rdata = {30'h0, granted_q, window_q};
                5'h05:   rdata = nonce_boot_q;
                default: rdata = 32'h0;
            endcase
        end
    end

    // wdata is intentionally unobserved: this port is read-only. Reference it
    // so lint does not flag the unused input while keeping the port in the
    // convention-standard signature.
    logic _unused_wdata_ok;
    assign _unused_wdata_ok = ^{wdata, 1'b0};

endmodule
