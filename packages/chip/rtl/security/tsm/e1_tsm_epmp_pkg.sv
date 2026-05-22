// e1_tsm_epmp_pkg.sv
//
// Shared constants for the E1 TSM Smepmp/ePMP protection wall
// (rtl/security/tsm/e1_tsm_epmp_wall.sv), the Dorami-pattern intra-M-mode wall
// that isolates the tiny M-mode TEE Security Manager (TSM) from the untrusted
// OpenSBI that shares M-mode (docs/security/tee-plan/01-tee-core-architecture.md
// S1, work item W4).
//
// This package fixes the RISC-V privilege encodings, the pmpcfg bit layout, the
// pmpcfg.A address-matching modes, the access type encoding, and the mseccfg
// (Smepmp) bit positions exactly as the privileged ISA defines them, so the
// checker RTL and its cocotb model agree on the wire-level meaning.

`ifndef E1_TSM_EPMP_PKG_SV
`define E1_TSM_EPMP_PKG_SV

`timescale 1ns/1ps

package e1_tsm_epmp_pkg;

  // ----------------------------------------------------------------
  // RISC-V privilege modes (mstatus/cur_priv encoding).
  // ----------------------------------------------------------------
  typedef enum logic [1:0] {
    PRIV_U = 2'b00,
    PRIV_S = 2'b01,
    PRIV_RSVD = 2'b10,
    PRIV_M = 2'b11
  } priv_e;

  // ----------------------------------------------------------------
  // Access type presented on the check port. RISC-V PMP distinguishes
  // instruction fetch (X), load (R), and store/AMO (W).
  // ----------------------------------------------------------------
  typedef enum logic [1:0] {
    ACC_FETCH = 2'b00,  // instruction fetch  -> requires X
    ACC_READ  = 2'b01,  // load               -> requires R
    ACC_WRITE = 2'b10   // store / AMO        -> requires W
  } access_e;

  // ----------------------------------------------------------------
  // pmpcfg byte bit layout (one byte per PMP entry).
  //   bit 0 R, bit 1 W, bit 2 X, bits 4:3 A, bit 7 L. bits 6:5 are WARL 0.
  // ----------------------------------------------------------------
  localparam int unsigned CFG_R_BIT = 0;
  localparam int unsigned CFG_W_BIT = 1;
  localparam int unsigned CFG_X_BIT = 2;
  localparam int unsigned CFG_A_LSB = 3;  // A occupies [4:3]
  localparam int unsigned CFG_L_BIT = 7;

  // pmpcfg.A address-matching modes.
  typedef enum logic [1:0] {
    A_OFF   = 2'b00,  // entry disabled
    A_TOR   = 2'b01,  // top-of-range: [pmpaddr[i-1], pmpaddr[i])
    A_NA4   = 2'b10,  // naturally aligned 4-byte
    A_NAPOT = 2'b11   // naturally aligned power-of-two >= 8
  } addr_mode_e;

  // ----------------------------------------------------------------
  // mseccfg (Smepmp) bit positions.
  //   bit 0 MML  : Machine Mode Lockdown -- re-interpret pmpcfg per the MML
  //                truth table; once set it is sticky (WARL, cannot clear).
  //   bit 1 MMWP : Machine Mode Whitelist Policy -- M-mode default-DENY on an
  //                access that matches no rule; sticky once set.
  //   bit 2 RLB  : Rule-Locking Bypass -- while 1, locked (L=1) rules may be
  //                modified; once cleared to 0 it can never be set again, so
  //                locked rules become immutable until reset.
  // ----------------------------------------------------------------
  localparam int unsigned SECCFG_MML_BIT  = 0;
  localparam int unsigned SECCFG_MMWP_BIT = 1;
  localparam int unsigned SECCFG_RLB_BIT  = 2;

endpackage

`endif
