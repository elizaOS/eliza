`timescale 1ns/1ps

// e1_mcie_pkg
//
// Architectural constants for the E1 Memory Crypto + Integrity Engine (MCIE),
// rtl/security/mcie/e1_mcie.sv. The MCIE sits at the memory-controller boundary
// (downstream of the system cache and the MTT check, upstream of the LPDDR5X
// PHY) and provides confidentiality + integrity + anti-replay for confidential
// DRAM pages (lane 01, docs/security/tee-plan/01-tee-core-architecture.md S3;
// the ciphertext-side-channel requirements in 04-side-channel-physical-
// hardening.md S3; and the pure-software contract scripts/tee/
// mee_freshness_model.py that this RTL must agree with).
//
// CONFIDENTIALITY -- counter-mode AES, NOT XTS (S3.1). AES-XTS is rejected for
// DRAM because it is deterministic per address (same plaintext at the same
// address always yields the same ciphertext), which is exactly the
// ciphertext-equality leak TEE.fail / CipherLeaks exploited. The MCIE encrypts
// with AES-CTR: keystream = AES_K({line_addr, counter}); ciphertext = plaintext
// XOR keystream. A monotonic per-line write counter freshens the keystream on
// every write, so identical plaintext written twice to the same line produces
// DIFFERENT ciphertext -- non-deterministic, defeating the side channel.
//
// INTEGRITY + ANTI-REPLAY -- counter-integrity (Bonsai/Merkle) tree (S3.2). A
// per-line MAC = CBC-MAC_Kmac({line_addr, counter} || ciphertext) detects
// tampering of the stored ciphertext/counter. A counter-integrity tree binds
// the per-line counters so a replayed (ciphertext, counter, MAC) triple with a
// rolled-back counter is detected: verification requires the presented counter
// to EQUAL the authoritative on-die counter for that line. The authoritative
// counters live in an on-die counter cache backed by the tree; the tree ROOT
// is held in on-die SRAM (never attacker-visible DRAM) and is reseeded with a
// fresh random value on every cold boot, so a cross-boot replay cannot verify.
//
// FAIL-CLOSED (S3.2). A verification failure is FATAL: no plaintext is
// returned, an integrity-fault is raised to the RoT/alert network, and the
// fault is latched. There is no soft-fail and no log-and-continue.
//
// MATCH TO THE FRESHNESS MODEL (scripts/tee/mee_freshness_model.py):
//   * per-line monotonic write counter, COUNTER_BITS wide (the model uses
//     64-bit little-endian counters);
//   * keystream is a function of (boot_seed/key, line_addr, counter);
//   * MAC is a keyed function of (line_addr, counter, ciphertext);
//   * verify() requires presented counter == on-die counter (anti-rollback),
//     then the recomputed MAC to match; a stale counter or cross-boot triple
//     fails. The RTL enforces the identical invariant in hardware.

package e1_mcie_pkg;

  // ------------------------------------------------------------------
  // Datapath widths. One protected "line" is one AES block (128b), which also
  // matches the e1_dram_ctrl DATA_WIDTH beat, so a line maps to one memory
  // beat in the model. (On real LPDDR5X a cache line spans several beats; the
  // tree/counter scheme is identical, just wider -- see the claim boundary.)
  // ------------------------------------------------------------------
  localparam int unsigned LINE_BITS    = 128;  // protected line = one AES block
  localparam int unsigned ADDR_BITS    = 64;   // line address used in the AES input/MAC
  localparam int unsigned KEY_BITS     = 128;  // AES-128 confidentiality + MAC keys
  localparam int unsigned MAC_BITS     = 128;  // full-block CBC-MAC tag stored per line

  // ------------------------------------------------------------------
  // Counter widths and the integrity-tree arity. The per-line write counter is
  // 64-bit to match the freshness model (counter.to_bytes(8, "little")). The
  // counter-integrity tree is an 8-ary (octal) Bonsai-Merkle tree over the
  // counters: each tree node binds TREE_ARITY child counters with one node MAC,
  // the standard SGX-MEE/Bonsai arity that balances node fan-out against the
  // per-node MAC width. The on-die counter CACHE holds recently-touched leaf
  // counters; a miss walks the tree to memory and verifies node MACs up to the
  // on-die root. The root never leaves on-die SRAM and is reseeded per boot.
  // ------------------------------------------------------------------
  localparam int unsigned COUNTER_BITS = 64;
  localparam int unsigned TREE_ARITY   = 8;    // 8 child counters per tree node
  localparam int unsigned TREE_LEVELS  = 4;    // 8^4 = 4096 leaves per cached subtree

  // On-die counter-cache geometry. Direct-mapped, COUNTER_CACHE_ENTRIES lines;
  // each entry holds {valid, tag(line address), 64-bit authoritative counter}.
  localparam int unsigned COUNTER_CACHE_ENTRIES = 16;
  localparam int unsigned CC_IDX_BITS = $clog2(COUNTER_CACHE_ENTRIES);

  // ------------------------------------------------------------------
  // Page class carried alongside each access (sourced from the MTT, S3.1).
  // Only private/measured/device-assigned pages are encrypted+integrity-
  // protected; free/shared pages pass through plaintext (the host needs them).
  // Encoding mirrors e1_mtt_pkg.sv PS_* so the same 3-bit field flows through.
  // ------------------------------------------------------------------
  localparam logic [2:0] PS_FREE            = 3'd0;
  localparam logic [2:0] PS_MEASURED        = 3'd1;
  localparam logic [2:0] PS_PRIVATE         = 3'd2;
  localparam logic [2:0] PS_SHARED          = 3'd3;
  localparam logic [2:0] PS_DEVICE_ASSIGNED = 3'd4;
  localparam logic [2:0] PS_SCRUB_PENDING   = 3'd5;

  // confidential(state): the page is encrypted+protected by the MCIE.
  function automatic logic is_confidential(input logic [2:0] state);
    is_confidential = (state == PS_PRIVATE) ||
                      (state == PS_MEASURED) ||
                      (state == PS_DEVICE_ASSIGNED);
  endfunction

  // passthrough(state): free/shared pages are plaintext (the host needs them);
  // scrub-pending should never reach the MCIE (the MTT denies it upstream), so
  // a scrub-pending access is treated as a non-confidential passthrough here
  // and the access-policy fault is owned by e1_mtt_checker.sv, not the MCIE.
  function automatic logic is_passthrough(input logic [2:0] state);
    is_passthrough = (state == PS_FREE) ||
                     (state == PS_SHARED) ||
                     (state == PS_SCRUB_PENDING);
  endfunction

  // ------------------------------------------------------------------
  // Request op.
  // ------------------------------------------------------------------
  localparam logic OP_READ  = 1'b0;
  localparam logic OP_WRITE = 1'b1;

  // ------------------------------------------------------------------
  // Integrity-fault cause codes (latched for the RoT/alert network).
  // ------------------------------------------------------------------
  localparam logic [1:0] FAULT_NONE      = 2'd0;
  localparam logic [1:0] FAULT_MAC       = 2'd1;  // recomputed MAC != stored MAC (tamper/forge)
  localparam logic [1:0] FAULT_ROLLBACK  = 2'd2;  // presented counter != on-die counter (replay)
  localparam logic [1:0] FAULT_NO_COUNTER= 2'd3;  // read of a confidential line never written

endpackage
