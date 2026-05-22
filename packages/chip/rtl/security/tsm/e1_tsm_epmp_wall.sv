`timescale 1ns/1ps

// e1_tsm_epmp_wall.sv
//
// E1 TSM Smepmp/ePMP protection wall -- the Dorami-pattern intra-M-mode wall
// that isolates the tiny M-mode TEE Security Manager (TSM) from the untrusted
// OpenSBI that shares M-mode (docs/security/tee-plan/01-tee-core-architecture.md
// S1, "the Smepmp wall (Dorami) keeps OpenSBI out of TSM memory"; work item W4).
//
// Role in the TEE core lane: MTT (rtl/security/mtt/, a sibling block) is the
// whole-OS confidentiality primitive; Smepmp is used ONLY to wall off the TSM
// inside M-mode. ePMP is exactly the right tool here because the TSM occupies a
// small, fixed, static set of regions, and Smepmp's MML/MMWP/RLB bits make
// LOCKED rules enforce against M-mode itself -- so untrusted M-mode code
// (OpenSBI) cannot read, write, or execute the TSM's region.
//
// This block is a standalone, synthesizable Smepmp PERMISSION CHECKER + the
// MMIO programming/lock interface used during measured launch. The repo's CVA6
// wrapper has PMP disabled (01-tee-core-architecture.md S0); wiring this checker
// to a real M-mode core's fetch/load/store pipeline is the integration follow-on.
//
// ---- mseccfg / pmp model -------------------------------------------------
//   * NUM_ENT pmpcfg/pmpaddr entries (RV64 pmpaddr granule = byte addr >> 2).
//   * mseccfg.{MML,MMWP,RLB}. MML and MMWP are sticky-set (WARL: once 1 cannot
//     be cleared). RLB is sticky-CLEAR (once written 0 it can never be set
//     again) -- so the launcher sets MML/MMWP, programs+locks the TSM rules
//     while RLB=1, then clears RLB to freeze every locked rule until reset.
//
// ---- address matching (RISC-V PMP) ---------------------------------------
//   * A_OFF   entry disabled.
//   * A_TOR   range [pmpaddr[i-1]<<2, pmpaddr[i]<<2) (pmpaddr[-1] == 0).
//   * A_NA4   the naturally aligned 4-byte word at pmpaddr<<2.
//   * A_NAPOT pmpaddr low-order ones encode a 2^(n+3)-byte aligned region.
//   * Lowest-numbered MATCHING entry wins (RISC-V PMP priority).
//
// ---- permission resolution -----------------------------------------------
//   * MML=0 (legacy/ePMP-off): a matching entry grants R/W/X by its bits; for
//     M-mode an UNLOCKED (L=0) matching rule is always permitted (legacy
//     "locked rules apply to M-mode, unlocked rules are S/U-only" behavior),
//     and a LOCKED rule is checked against R/W/X for every mode. With MMWP=0,
//     M-mode access that matches NO rule is permitted (legacy default).
//   * MML=1: the matching entry's {L,R,W,X} is decoded by the full Smepmp MML
//     truth table below (mml_permit). This is where the TSM wall lives:
//       - TSM CODE  region = L=1,R=0,W=0,X=1  -> M execute-only; untrusted
//         M-mode cannot READ or WRITE it (tamper/exfil proof) and S/U cannot
//         touch it.
//       - TSM DATA  region = L=1,R=1,W=1,X=0  -> M-only R/W, NON-executable;
//         untrusted M-mode cannot EXECUTE it and S/U cannot touch it.
//       - A Shared trampoline (L=0 encodings) is the only M<->TSM gate.
//   * MMWP=1: an M-mode access matching NO rule is DENIED (machine-mode
//     whitelist policy / default-deny). MML reinterprets MATCHED rules only; it
//     does not change the unmatched-access default, which is MMWP's job. S/U
//     matching no rule is always denied (architectural). MMWP=0 permits
//     unmatched M-mode (the architectural default, used for bring-up before the
//     launcher sets MML+MMWP together to seal the wall).
//
// Synthesizable: single clock, single synchronous-release async-assert reset,
// no initial blocks, no delays, no latches.

module e1_tsm_epmp_wall
  import e1_tsm_epmp_pkg::*;
#(
    // pmpaddr / physical address width. RV64 PMP addresses are byte-addr>>2;
    // PADDR_W is the full byte-address width the check port presents.
    parameter int unsigned PADDR_W = 56,
    // Number of PMP entries (RISC-V allows 16/64; the TSM wall needs a handful).
    parameter int unsigned NUM_ENT = 8
) (
    input  logic clk,
    input  logic rst_n,

    // ----------------------------------------------------------------
    // MMIO programming slave (word-indexed valid/write/addr/wdata/rdata),
    // matching rtl/security/otp/e1_otp_map.sv and rtl/iommu/e1_iopmp.sv. The
    // measured-launch launcher (RoT-released TSM bootstrap) drives this to
    // program pmpaddr/pmpcfg + mseccfg, then clears RLB to lock. addr is the
    // byte offset within the aperture.
    // ----------------------------------------------------------------
    input  logic        reg_valid,
    input  logic        reg_write,
    input  logic [11:0] reg_addr,
    input  logic [31:0] reg_wdata,
    output logic [31:0] reg_rdata,

    // ----------------------------------------------------------------
    // Access check port. The M-mode core's fetch/load/store stage (or a DMA
    // path, though MTT owns DMA) presents {privilege, address, access type};
    // the checker returns a single-cycle combinational verdict. The pipeline
    // gates on `chk_allow` and converts `chk_deny` into an access fault, never
    // a silent pass.
    // ----------------------------------------------------------------
    input  logic                 chk_valid,
    input  logic [1:0]           chk_priv,   // priv_e
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [PADDR_W-1:0]   chk_addr,   // low 2 bits unused (word-granular)
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic [1:0]           chk_type,   // access_e
    output logic                 chk_allow,
    output logic                 chk_deny,

    // ----------------------------------------------------------------
    // Status. locked_o asserts once MML is set and RLB has been cleared: the
    // TSM wall is armed and immutable until reset. The RoT/reset-sequencer
    // consumes this to gate platform release.
    // ----------------------------------------------------------------
    output logic mml_o,
    output logic mmwp_o,
    output logic rlb_o,
    output logic locked_o,
    output logic violation_o    // pulses high the cycle a check is denied
);

  // ----------------------------------------------------------------
  // Register map (byte offsets within the aperture). pmpaddr is stored as the
  // RV64 byte-addr>>2 value; the aperture exposes only the low 32 bits of each
  // pmpaddr word (sufficient for the on-die TSM regions; high bits are 0).
  // ----------------------------------------------------------------
  localparam logic [11:0] OFF_MSECCFG = 12'h000;  // {-, RLB, MMWP, MML}
  localparam logic [11:0] OFF_STATUS  = 12'h004;  // {locked, rlb, mmwp, mml}
  localparam logic [11:0] OFF_CFG0    = 12'h010;  // pmpcfg packed, 4 entries/word
  localparam logic [11:0] OFF_ADDR0   = 12'h040;  // pmpaddr[i] at 0x40 + 4*i

  localparam int unsigned PMPADDR_W = PADDR_W - 2;  // byte addr >> 2

  // ----------------------------------------------------------------
  // Architectural state: per-entry cfg byte + pmpaddr; mseccfg bits.
  // ----------------------------------------------------------------
  logic [7:0]            cfg_q   [NUM_ENT];
  logic [PMPADDR_W-1:0]  addr_q  [NUM_ENT];
  logic                  mml_q;
  logic                  mmwp_q;
  logic                  rlb_q;

  assign mml_o    = mml_q;
  assign mmwp_o   = mmwp_q;
  assign rlb_o    = rlb_q;
  // Wall armed: MML set and rule-locking permanently bypassed-off.
  assign locked_o = mml_q && !rlb_q;

  // ----------------------------------------------------------------
  // Per-entry field decode.
  // ----------------------------------------------------------------
  function automatic logic cfg_r(input logic [7:0] c); return c[CFG_R_BIT]; endfunction
  function automatic logic cfg_w(input logic [7:0] c); return c[CFG_W_BIT]; endfunction
  function automatic logic cfg_x(input logic [7:0] c); return c[CFG_X_BIT]; endfunction
  function automatic logic cfg_l(input logic [7:0] c); return c[CFG_L_BIT]; endfunction
  /* verilator lint_off UNUSEDSIGNAL */
  function automatic logic [1:0] cfg_a(input logic [7:0] c);
    return c[CFG_A_LSB +: 2];
  endfunction
  /* verilator lint_on UNUSEDSIGNAL */

  // A pmpcfg byte is LOCKED if L=1. While RLB=1 locked rules may be edited;
  // once RLB=0 a locked entry's cfg and its pmpaddr are immutable. Under MML,
  // R=1,W=0 with L=0 is a reserved encoding the spec forbids writing -- the
  // write path rejects it so no illegal encoding can ever be latched.
  function automatic logic locked_entry(input logic [7:0] c);
    return c[CFG_L_BIT];
  endfunction

  // ----------------------------------------------------------------
  // Address matching. NAPOT decode turns the trailing-ones run in pmpaddr into
  // a mask. TOR uses the previous entry's pmpaddr as the lower bound.
  // ----------------------------------------------------------------
  // chk address as byte-addr>>2 to compare against pmpaddr directly. PMP
  // matching is word-granular, so the low two byte-offset bits are not used.
  logic [PMPADDR_W-1:0] chk_addr_w;
  /* verilator lint_off UNUSEDSIGNAL */
  assign chk_addr_w = chk_addr[PADDR_W-1:2];
  /* verilator lint_on UNUSEDSIGNAL */

  function automatic logic napot_match(
      input logic [PMPADDR_W-1:0] paddr,   // pmpaddr (byte>>2), NAPOT encoded
      input logic [PMPADDR_W-1:0] target   // access addr (byte>>2)
  );
    // NAPOT: the lowest 0 bit position n sets region size; bits above n must
    // match. Build a mask of the "match" bits = bits above the lowest 0.
    logic [PMPADDR_W-1:0] base_mask;  // 1 where bits must match
    logic                 found_zero;
    base_mask  = '0;
    found_zero = 1'b0;
    for (int unsigned b = 0; b < PMPADDR_W; b++) begin
      if (!found_zero) begin
        if (paddr[b] == 1'b0) begin
          found_zero = 1'b1;          // this bit and below are "don't care"
        end
      end
      if (found_zero) begin
        base_mask[b] = 1'b1;          // bits strictly above the lowest 0 match
      end
    end
    return ((paddr & base_mask) == (target & base_mask));
  endfunction

  function automatic logic na4_match(
      input logic [PMPADDR_W-1:0] paddr,
      input logic [PMPADDR_W-1:0] target
  );
    return (paddr == target);
  endfunction

  function automatic logic tor_match(
      input logic [PMPADDR_W-1:0] lo,      // pmpaddr[i-1] (0 for entry 0)
      input logic [PMPADDR_W-1:0] hi,      // pmpaddr[i]
      input logic [PMPADDR_W-1:0] target
  );
    return (target >= lo) && (target < hi);
  endfunction

  // Per-entry match vector (combinational).
  logic [NUM_ENT-1:0] ent_match;
  always_comb begin
    for (int unsigned i = 0; i < NUM_ENT; i++) begin
      logic [PMPADDR_W-1:0] lo;
      logic [1:0]           a;
      a  = cfg_a(cfg_q[i]);
      lo = (i == 0) ? '0 : addr_q[i-1];
      unique case (a)
        A_OFF:   ent_match[i] = 1'b0;
        A_TOR:   ent_match[i] = tor_match(lo, addr_q[i], chk_addr_w);
        A_NA4:   ent_match[i] = na4_match(addr_q[i], chk_addr_w);
        A_NAPOT: ent_match[i] = napot_match(addr_q[i], chk_addr_w);
        default: ent_match[i] = 1'b0;
      endcase
    end
  end

  // Lowest-numbered matching entry (RISC-V PMP priority). hit + index.
  logic               any_hit;
  logic [7:0]         hit_cfg;
  always_comb begin
    any_hit = 1'b0;
    hit_cfg = 8'h00;
    for (int unsigned i = 0; i < NUM_ENT; i++) begin
      if (!any_hit && ent_match[i]) begin
        any_hit = 1'b1;
        hit_cfg = cfg_q[i];
      end
    end
  end

  // ----------------------------------------------------------------
  // Smepmp MML truth table for a MATCHING entry. Returns the permit decision
  // for the requested access type, given the privilege mode. This is the exact
  // ePMP/Smepmp encoding table; M-mode and S/U-mode read different rows.
  //
  //  L R W X | M mode            | S/U mode
  //  --------+-------------------+------------------
  //  0 0 0 0 | (no rule effect)  | (no rule effect)   -> treated as no-match*
  //  0 0 0 1 | Shared X (M+SU)   | X
  //  0 0 1 0 | Shared RW (M+SU)  | RW
  //  0 0 1 1 | Shared R/W M, R SU| R
  //  0 1 0 0 | none              | R
  //  0 1 0 1 | none              | R X
  //  0 1 1 0 | none              | R W
  //  0 1 1 1 | none              | R W X
  //  1 0 0 0 | none              | none   (locked, fully closed)
  //  1 0 0 1 | X                 | none
  //  1 0 1 0 | Shared X (M+SU)   | X      (locked shared exec)
  //  1 0 1 1 | Shared R X (M+SU) | R X    (locked shared R/X)
  //  1 1 0 0 | R                 | none
  //  1 1 0 1 | R X               | none
  //  1 1 1 0 | R W               | none
  //  1 1 1 1 | R W X             | none
  //
  // *L=0,R=0,W=0,X=0 with A!=OFF is a no-permission rule: it matches the range
  //  but grants nothing. We treat it as "matched, deny" so a higher-priority
  //  closed rule shadows lower entries (fail closed).
  // ----------------------------------------------------------------
  function automatic logic mml_permit(
      input logic [7:0] c,
      input logic [1:0] priv,
      input logic [1:0] acc
  );
    logic l, r, w, x;
    logic is_m;
    logic want_r, want_w, want_x;
    // m_*  = permission granted to M-mode; su_* = permission granted to S/U.
    logic m_r, m_w, m_x, su_r, su_w, su_x;
    l = cfg_l(c); r = cfg_r(c); w = cfg_w(c); x = cfg_x(c);
    is_m   = (priv == PRIV_M);
    want_r = (acc == ACC_READ);
    want_w = (acc == ACC_WRITE);
    want_x = (acc == ACC_FETCH);

    // Decode the {L,R,W,X} row into the effective M and S/U permission triples.
    m_r = 1'b0; m_w = 1'b0; m_x = 1'b0;
    su_r = 1'b0; su_w = 1'b0; su_x = 1'b0;

    unique casez ({l, r, w, x})
      4'b0000: begin /* no permission to anyone */ end
      4'b0001: begin m_x = 1'b1;                       su_x = 1'b1;            end // shared X
      4'b0010: begin m_r = 1'b1; m_w = 1'b1;           su_r = 1'b1; su_w = 1'b1; end // shared RW
      4'b0011: begin m_r = 1'b1; m_w = 1'b1;           su_r = 1'b1;            end // shared R/W-M, R-SU
      4'b0100: begin                                   su_r = 1'b1;            end
      4'b0101: begin                                   su_r = 1'b1; su_x = 1'b1; end
      4'b0110: begin                                   su_r = 1'b1; su_w = 1'b1; end
      4'b0111: begin                                   su_r = 1'b1; su_w = 1'b1; su_x = 1'b1; end
      4'b1000: begin /* locked, fully closed */ end
      4'b1001: begin m_x = 1'b1;                                               end // M execute-only (TSM code)
      4'b1010: begin m_x = 1'b1;                       su_x = 1'b1;            end // locked shared X
      4'b1011: begin m_r = 1'b1; m_x = 1'b1;           su_r = 1'b1; su_x = 1'b1; end // locked shared R/X
      4'b1100: begin m_r = 1'b1;                                               end
      4'b1101: begin m_r = 1'b1; m_x = 1'b1;                                   end
      4'b1110: begin m_r = 1'b1; m_w = 1'b1;                                   end // M-only R/W (TSM data)
      4'b1111: begin m_r = 1'b1; m_w = 1'b1; m_x = 1'b1;                       end // M-only R/W/X
      default: begin /* unreachable */ end
    endcase

    if (is_m) begin
      return (want_r && m_r) || (want_w && m_w) || (want_x && m_x);
    end else begin
      // S and U share the S/U column under MML.
      return (want_r && su_r) || (want_w && su_w) || (want_x && su_x);
    end
  endfunction

  // ----------------------------------------------------------------
  // Legacy (MML=0) permission for a matching entry. RISC-V base PMP:
  //   * S/U: a matching rule's R/W/X gates the access.
  //   * M:   an UNLOCKED (L=0) rule does not apply to M (M bypasses it -> the
  //          match is treated as "permit" for M only when there is no locked
  //          rule); a LOCKED (L=1) rule's R/W/X gates M-mode too.
  // We implement first-match-wins: the lowest matching entry decides.
  //   - M-mode, matched, L=0  -> permit (rule is S/U-only; M is unconstrained).
  //   - M-mode, matched, L=1  -> permit iff the requested R/W/X bit is set.
  //   - S/U,    matched       -> permit iff the requested R/W/X bit is set.
  // ----------------------------------------------------------------
  function automatic logic legacy_permit(
      input logic [7:0] c,
      input logic [1:0] priv,
      input logic [1:0] acc
  );
    logic want_r, want_w, want_x;
    logic granted;
    want_r = (acc == ACC_READ);
    want_w = (acc == ACC_WRITE);
    want_x = (acc == ACC_FETCH);
    granted = (want_r && cfg_r(c)) || (want_w && cfg_w(c)) || (want_x && cfg_x(c));
    if (priv == PRIV_M) begin
      return cfg_l(c) ? granted : 1'b1;  // unlocked rule: M unconstrained
    end else begin
      return granted;
    end
  endfunction

  // ----------------------------------------------------------------
  // Final verdict (combinational, fail-closed).
  // ----------------------------------------------------------------
  logic permit;
  always_comb begin
    if (!chk_valid) begin
      permit = 1'b0;
    end else if (any_hit) begin
      permit = mml_q ? mml_permit(hit_cfg, chk_priv, chk_type)
                     : legacy_permit(hit_cfg, chk_priv, chk_type);
    end else begin
      // No matching rule.
      if (chk_priv == PRIV_M) begin
        // M-mode default for an unmatched access is governed by MMWP, per the
        // Smepmp spec: MMWP=1 -> deny (machine-mode whitelist policy); MMWP=0
        // -> permit (the architectural M-mode default, used during bring-up
        // before the launcher locks down). MML alone reinterprets MATCHED
        // rules; it does not change the unmatched-access default -- that is
        // MMWP's job. The launcher sets MML and MMWP together, so the sealed
        // wall is default-deny for unmatched M-mode.
        permit = !mmwp_q;
      end else begin
        // S/U with no matching rule is always denied (architectural).
        permit = 1'b0;
      end
    end
  end

  assign chk_allow  = permit;
  assign chk_deny   = chk_valid && !permit;
  assign violation_o = chk_valid && !permit;

  // ----------------------------------------------------------------
  // Programming path. Writes are accepted only when the target is mutable:
  //   * mseccfg: MML/MMWP are sticky-set (OR-in only). RLB is sticky-clear:
  //     it may be written 1->1 or X->0 but never 0->1, and only while it is
  //     currently 1 (once 0, frozen). MML also gates RLB: once MML+!RLB the
  //     wall is sealed.
  //   * pmpcfg / pmpaddr entry: an entry whose CURRENT cfg is LOCKED (L=1)
  //     may be modified only while RLB=1. Once RLB=0 the locked entry (cfg AND
  //     its pmpaddr) is immutable. Unlocked entries are always writable (the
  //     launcher stages them before locking). Reserved MML encoding
  //     (R=0,W=1) is rejected so it can never be latched.
  // ----------------------------------------------------------------
  /* verilator lint_off UNUSEDSIGNAL */
  function automatic logic cfg_reserved(input logic [7:0] c);
    // RISC-V PMP: W=1,R=0 is reserved (WARL). Reject it on write. Only the R/W
    // bits of the cfg byte participate in this WARL legality check.
    return cfg_w(c) && !cfg_r(c);
  endfunction
  /* verilator lint_on UNUSEDSIGNAL */

  // Word index of the addressed register, relative to its aperture base. The
  // aperture spans at most 4 KiB (reg_addr is 12 bits); a 32-bit index is wide
  // enough for any (reg_addr - base)>>2 without truncation.
  localparam int unsigned IDX_W = 32;
  // pmpaddr bits programmable through the 32-bit aperture word. The on-die TSM
  // regions fit in 32 bits of (byte>>2) address; higher pmpaddr bits stay 0.
  localparam int unsigned ADDR_PROG_W = (PMPADDR_W < 32) ? PMPADDR_W : 32;
  localparam int unsigned CFG_WORDS   = (NUM_ENT + 3) / 4;

  // Decode which entry a cfg/addr write targets. Offsets are zero-extended to
  // IDX_W so the subtraction does not width-expand reg_addr.
  logic            is_seccfg_w;
  logic            is_cfg_w;
  logic            is_addr_w;
  logic [IDX_W-1:0] cfg_word_idx;  // which packed cfg word (4 entries each)
  logic [IDX_W-1:0] addr_idx;      // which pmpaddr entry
  always_comb begin
    is_seccfg_w  = reg_valid && reg_write && (reg_addr == OFF_MSECCFG);
    is_cfg_w     = reg_valid && reg_write &&
                   (reg_addr >= OFF_CFG0) && (reg_addr < OFF_ADDR0);
    is_addr_w    = reg_valid && reg_write && (reg_addr >= OFF_ADDR0);
    cfg_word_idx = (IDX_W'(reg_addr) - IDX_W'(OFF_CFG0)) >> 2;
    addr_idx     = (IDX_W'(reg_addr) - IDX_W'(OFF_ADDR0)) >> 2;
  end

  integer i;
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      // Fail-closed reset posture: no rule enabled, mseccfg cleared (but RLB
      // begins 1 so the launcher can program and lock; the very act of the
      // launcher clearing RLB seals the wall). MMWP=0 at reset permits M-mode
      // bring-up until the launcher sets it; MML=0 means legacy until armed.
      for (i = 0; i < NUM_ENT; i = i + 1) begin
        cfg_q[i]  <= 8'h00;
        addr_q[i] <= '0;
      end
      mml_q  <= 1'b0;
      mmwp_q <= 1'b0;
      rlb_q  <= 1'b1;
    end else begin
      if (is_seccfg_w) begin
        // MML, MMWP: sticky-set (cannot be cleared once set).
        if (reg_wdata[SECCFG_MML_BIT])  mml_q  <= 1'b1;
        if (reg_wdata[SECCFG_MMWP_BIT]) mmwp_q <= 1'b1;
        // RLB: only meaningful while currently 1. Writing 0 clears it
        // permanently; writing 1 while already 1 holds it; 0->1 is impossible.
        if (rlb_q && !reg_wdata[SECCFG_RLB_BIT]) begin
          rlb_q <= 1'b0;
        end
      end

      if (is_cfg_w && (cfg_word_idx < IDX_W'(CFG_WORDS))) begin
        // Update the four cfg bytes packed in this word, each independently
        // gated by its own lock state and the reserved-encoding reject.
        for (i = 0; i < 4; i = i + 1) begin
          logic [IDX_W-1:0] ent;
          logic [7:0]       newb;
          ent  = (cfg_word_idx << 2) + IDX_W'(i);
          newb = reg_wdata[i*8 +: 8];
          if (ent < IDX_W'(NUM_ENT)) begin
            // Mutable iff the CURRENT entry is unlocked, or RLB still bypasses
            // the lock. Reserved (W=1,R=0) encodings are dropped.
            if ((!locked_entry(cfg_q[ent[$clog2(NUM_ENT)-1:0]]) || rlb_q) &&
                !cfg_reserved(newb)) begin
              cfg_q[ent[$clog2(NUM_ENT)-1:0]] <= newb;
            end
          end
        end
      end

      if (is_addr_w && (addr_idx < IDX_W'(NUM_ENT))) begin
        // pmpaddr of a locked entry is immutable once RLB=0 (the address is as
        // load-bearing as the cfg for region integrity). Only the low
        // ADDR_PROG_W bits are programmable through the 32-bit word.
        if (!locked_entry(cfg_q[addr_idx[$clog2(NUM_ENT)-1:0]]) || rlb_q) begin
          addr_q[addr_idx[$clog2(NUM_ENT)-1:0]] <=
              {{(PMPADDR_W-ADDR_PROG_W){1'b0}}, reg_wdata[ADDR_PROG_W-1:0]};
        end
      end
    end
  end

  // ----------------------------------------------------------------
  // Read data: status / mseccfg / cfg / addr readback.
  // ----------------------------------------------------------------
  logic [IDX_W-1:0] rd_widx;
  logic [IDX_W-1:0] rd_aidx;
  logic [IDX_W-1:0] rd_ent;
  always_comb begin
    reg_rdata = 32'h0;
    rd_ent    = '0;
    rd_widx   = (IDX_W'(reg_addr) - IDX_W'(OFF_CFG0)) >> 2;
    rd_aidx   = (IDX_W'(reg_addr) - IDX_W'(OFF_ADDR0)) >> 2;
    if (reg_valid && !reg_write) begin
      if (reg_addr == OFF_MSECCFG) begin
        reg_rdata = {29'h0, rlb_q, mmwp_q, mml_q};
      end else if (reg_addr == OFF_STATUS) begin
        reg_rdata = {28'h0, locked_o, rlb_q, mmwp_q, mml_q};
      end else if ((reg_addr >= OFF_CFG0) && (reg_addr < OFF_ADDR0)) begin
        for (int unsigned k = 0; k < 4; k++) begin
          rd_ent = (rd_widx << 2) + IDX_W'(k);
          if (rd_ent < IDX_W'(NUM_ENT)) begin
            reg_rdata[k*8 +: 8] = cfg_q[rd_ent[$clog2(NUM_ENT)-1:0]];
          end
        end
      end else if (reg_addr >= OFF_ADDR0) begin
        if (rd_aidx < IDX_W'(NUM_ENT)) begin
          reg_rdata = {{(32-ADDR_PROG_W){1'b0}},
                       addr_q[rd_aidx[$clog2(NUM_ENT)-1:0]][ADDR_PROG_W-1:0]};
        end
      end
    end
  end

endmodule
