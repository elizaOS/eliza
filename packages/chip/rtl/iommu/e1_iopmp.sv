`timescale 1ns/1ps

// e1_iopmp.sv
//
// E1 I/O Physical Memory Protection (IOPMP) -- the hardware enforcement of the
// RoT-programmed source-ID I/O policy (docs/security/tee-plan/
// 03-secure-io-iommu-npu.md S1, work item P1.3; policy model
// docs/spec-db/tee-iopmp-source-id-map.json).
//
// Role in the secure-I/O lane: every DMA transaction carries a stable source ID
// (the per-master device-id of e1_riscv_iommu_pkg / dma-buf-v2.md). The IOPMP
// is a region-based, source-ID-gated permission layer that sits downstream of
// (and is redundant to) the IOMMU translation: it answers "may THIS source ID
// perform THIS op (R/W/X) at THIS physical address?" with default-deny. A
// transaction with no matching permit entry is denied and an error response is
// raised, never silently allowed.
//
// Entry model (RISC-V IOPMP-style priority table):
//   * NUM_ENTRY priority entries, entry 0 highest priority.
//   * Each entry = a PMP-NAPOT-encoded address range (base+size), a per-entry
//     R/W/X permission triple, and a SRCMD source-ID membership bitmask.
//   * Lookup: scan entries in priority order; the FIRST entry that both range-
//     matches the address AND admits the source ID (SRCMD bit set) decides the
//     verdict using its R/W/X bits. First-hit wins (a higher-priority match is
//     authoritative even if a lower-priority entry would also match).
//   * Default-deny by construction: if no entry both matches and admits, the
//     transaction is denied (VIOL_NO_MATCH). If the matching entry lacks the
//     requested permission it is denied (VIOL_PERMISSION).
//
// Programming + lock (RoT-owned):
//   * The entry table + CTRL register are writable ONLY while the IOPMP is
//     unlocked (the RoT's programming window). The RoT programs the policy from
//     tee-iopmp-source-id-map.json, then sets CTRL.lock (write-1-to-set,
//     sticky). After lock, all programming writes are dropped -- the host OS
//     cannot widen or self-authorize regions.
//   * policy_ready_o asserts once the IOPMP is enabled AND locked; the RoT
//     reset sequencer (e1_rot_reset_seq.iopmp_policy_ready_i) consumes it to
//     release the application cluster (the platform is not released until I/O
//     is default-deny gated).
//
// Violation record: the first denied transaction after each clear latches its
// source ID, address, and violation type into the ERR_* registers for the RoT
// to read; ERR_INFO.valid is write-1-to-clear.
//
// Synthesizable: single clock, single synchronous-release async-assert reset,
// no initial blocks, no delays.

module e1_iopmp
  import e1_iopmp_pkg::*;
#(
    parameter int unsigned PADDR_W   = e1_iopmp_pkg::PADDR_BITS,
    parameter int unsigned SRC_W     = e1_iopmp_pkg::SRC_ID_BITS,
    parameter int unsigned NUM_ENT   = e1_iopmp_pkg::NUM_ENTRY
) (
    input  logic clk,
    input  logic rst_n,

    // ----------------------------------------------------------------
    // MMIO programming slave (word-indexed valid/write/addr/wdata/rdata),
    // matching rtl/security/otp/e1_otp_map.sv. The RoT drives this during its
    // programming window. addr is the byte offset within the aperture.
    // ----------------------------------------------------------------
    input  logic        reg_valid,
    input  logic        reg_write,
    input  logic [11:0] reg_addr,
    input  logic [31:0] reg_wdata,
    output logic [31:0] reg_rdata,

    // ----------------------------------------------------------------
    // I/O transaction check port. A DMA master presents {source ID, address,
    // op}; the IOPMP returns a single-cycle combinational verdict. The fabric
    // gates the transaction on `allow` and converts `deny` into an error
    // response (W data sunk / B-R error), never a silent pass.
    // ----------------------------------------------------------------
    input  logic                 chk_valid,    // a transaction is being checked
    input  logic [SRC_W-1:0]     chk_src_id,
    input  logic [PADDR_W-1:0]   chk_addr,
    input  logic [1:0]           chk_type,     // REQ_READ / REQ_WRITE / REQ_EXEC
    output logic                 chk_allow,
    output logic                 chk_deny,

    // ----------------------------------------------------------------
    // Status to the RoT / SoC.
    // ----------------------------------------------------------------
    output logic policy_ready_o,  // enabled & locked -> feeds rot reset seq
    output logic locked_o,
    output logic violation_o      // pulses high the cycle a transaction is denied
);

  localparam int unsigned NUM_SRC_L = 1 << SRC_W;

  // ================================================================
  // Programmable state. Held in reset to a fully-closed configuration:
  // disabled, unlocked, every entry A=OFF (matches nothing). Because lookup is
  // default-deny, a disabled/empty table denies everything -- the platform is
  // released only after the RoT programs + locks a policy.
  // ================================================================
  logic                  cfg_enable_q;
  logic                  cfg_lock_q;

  // PMP-NAPOT address register, stored at word granule (physical addr >> 2),
  // exactly like RISC-V pmpaddr. Width = PADDR_W-2.
  localparam int unsigned ADDR_W = PADDR_W - 2;
  logic [ADDR_W-1:0]     ent_addr_q   [NUM_ENT];
  logic [1:0]            ent_a_q      [NUM_ENT];
  logic                  ent_r_q      [NUM_ENT];
  logic                  ent_w_q      [NUM_ENT];
  logic                  ent_x_q      [NUM_ENT];
  logic [NUM_SRC_L-1:0]  ent_srcmd_q  [NUM_ENT];

  // Latched violation record.
  logic                  err_valid_q;
  logic [1:0]            err_type_q;
  logic [SRC_W-1:0]      err_src_q;
  logic [PADDR_W-1:0]    err_addr_q;

  // ================================================================
  // Lookup (combinational). For each entry compute range-match and src-admit,
  // then take the first (highest-priority) entry that matches+admits.
  // ================================================================
  logic [NUM_ENT-1:0] ent_range_hit;
  logic [NUM_ENT-1:0] ent_src_admit;
  logic [NUM_ENT-1:0] ent_select;       // matches AND admits
  logic [NUM_ENT-1:0] ent_first;        // priority-decoded first-hit (one-hot or zero)

  for (genvar e = 0; e < NUM_ENT; e++) begin : gen_match
    // PMP NAPOT decode: the low run of 1s in ent_addr (after the addr[1:0]
    // implied by the >>2 word granule) sets the region size; the bits above
    // that run are the base. We compare chk_addr[PADDR_W-1:2] against the
    // entry's base under the NAPOT mask.
    logic [ADDR_W-1:0] cand;           // chk_addr >> 2
    logic [ADDR_W-1:0] base;           // entry base under the NAPOT mask
    logic [ADDR_W-1:0] napot_mask;     // 0 over the size run, 1 over the base

    assign cand = chk_addr[PADDR_W-1:2];

    // Derive the NAPOT mask from the stored word-granule value: a NAPOT field
    // is base bits followed by a 0 then a run of 1s. mask = ~(v ^ (v+1)) selects
    // the base bits (identical to the RISC-V PMP NAPOT decode).
    logic [ADDR_W-1:0] stored;
    assign stored     = ent_addr_q[e];
    assign napot_mask = ~(stored ^ (stored + 1'b1));
    assign base       = stored & napot_mask;

    assign ent_range_hit[e] = (ent_a_q[e] == A_NAPOT) &&
                              ((cand & napot_mask) == base);
    assign ent_src_admit[e] = ent_srcmd_q[e][chk_src_id];
    assign ent_select[e]    = ent_range_hit[e] && ent_src_admit[e];
  end

  // Priority lookup: scan entries low-to-high (entry 0 highest priority); the
  // first selected entry wins. `found` makes the scan a strict first-hit so
  // lower-priority matches cannot override it. A single combinational pass over
  // fixed-priority entries -- no feedback, no running vector.
  logic       any_match;
  logic       perm_ok;
  always_comb begin
    ent_first = '0;
    any_match = 1'b0;
    perm_ok   = 1'b0;
    for (int unsigned e = 0; e < NUM_ENT; e++) begin
      if (ent_select[e] && !any_match) begin
        ent_first[e] = 1'b1;
        any_match    = 1'b1;
        unique case (chk_type)
          REQ_READ:  perm_ok = ent_r_q[e];
          REQ_WRITE: perm_ok = ent_w_q[e];
          REQ_EXEC:  perm_ok = ent_x_q[e];
          default:   perm_ok = 1'b0;
        endcase
      end
    end
  end

  // Verdict. Default-deny: a transaction is allowed only when the IOPMP is
  // enabled, a priority entry matched+admitted, and that entry permits the op.
  // Anything else -- disabled, no match, wrong permission -- is denied.
  logic allow_int;
  logic [1:0] viol_type;
  assign allow_int = cfg_enable_q && any_match && perm_ok;
  always_comb begin
    if (allow_int) begin
      viol_type = VIOL_NONE;
    end else if (cfg_enable_q && any_match && !perm_ok) begin
      viol_type = VIOL_PERMISSION;
    end else begin
      viol_type = VIOL_NO_MATCH;
    end
  end

  assign chk_allow   = chk_valid &  allow_int;
  assign chk_deny    = chk_valid & ~allow_int;
  assign violation_o = chk_deny;

  // ================================================================
  // MMIO decode.
  // ================================================================
  logic        is_word;
  logic [9:0]  word_idx;          // reg_addr >> 2
  assign is_word  = reg_valid;
  assign word_idx = reg_addr[11:2];

  // Global control/status words (word index of OFFS_*).
  localparam logic [9:0] WI_CTRL        = OFFS_CTRL[11:2];
  localparam logic [9:0] WI_STATUS      = OFFS_STATUS[11:2];
  localparam logic [9:0] WI_ERR_INFO    = OFFS_ERR_INFO[11:2];
  localparam logic [9:0] WI_ERR_SRCID   = OFFS_ERR_SRCID[11:2];
  localparam logic [9:0] WI_ERR_ADDR_LO = OFFS_ERR_ADDR_LO[11:2];
  localparam logic [9:0] WI_ERR_ADDR_HI = OFFS_ERR_ADDR_HI[11:2];
  localparam logic [9:0] WI_ENTRY_BASE  = OFFS_ENTRY_BASE[11:2];

  // Entry region decode. ENTRY_STRIDE is a power of two (8 words), so the entry
  // index is the high bits of the word offset and the sub-word select is the
  // low $clog2(ENTRY_STRIDE) bits -- no general divide needed.
  localparam int unsigned STRIDE_BITS = $clog2(ENTRY_STRIDE);  // 3 for stride 8
  localparam int unsigned IDX_BITS    = (NUM_ENT > 1) ? $clog2(NUM_ENT) : 1;
  localparam logic [9:0]  WI_ENTRY_END =
      WI_ENTRY_BASE + 10'(NUM_ENT * ENTRY_STRIDE);

  localparam int unsigned OFF_BITS = IDX_BITS + STRIDE_BITS;  // bits to index the table

  logic                  in_entry;
  logic [9:0]            ent_word_off_full;  // full-width offset past the entry base
  logic [OFF_BITS-1:0]   ent_word_off;       // low bits used to index the table
  logic [IDX_BITS-1:0]   ent_index;
  logic [STRIDE_BITS-1:0] ent_sub;           // word within the entry
  assign in_entry          = (word_idx >= WI_ENTRY_BASE) && (word_idx < WI_ENTRY_END);
  assign ent_word_off_full = word_idx - WI_ENTRY_BASE;
  assign ent_word_off      = ent_word_off_full[OFF_BITS-1:0];
  assign ent_index         = ent_word_off[STRIDE_BITS +: IDX_BITS];
  assign ent_sub           = ent_word_off[STRIDE_BITS-1:0];

  // ent_index spans the full table when NUM_ENT is a power of two; in_entry
  // already bounds the access to the programmed region.
  logic ent_index_valid;
  assign ent_index_valid = in_entry;

  // Programming is permitted only while unlocked (the RoT window).
  logic prog_open;
  assign prog_open = ~cfg_lock_q;

  // ================================================================
  // Register / state update.
  // ================================================================
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      cfg_enable_q <= 1'b0;
      cfg_lock_q   <= 1'b0;
      err_valid_q  <= 1'b0;
      err_type_q   <= VIOL_NONE;
      err_src_q    <= '0;
      err_addr_q   <= '0;
      for (int unsigned e = 0; e < NUM_ENT; e++) begin
        ent_addr_q[e]  <= '0;
        ent_a_q[e]     <= A_OFF;
        ent_r_q[e]     <= 1'b0;
        ent_w_q[e]     <= 1'b0;
        ent_x_q[e]     <= 1'b0;
        ent_srcmd_q[e] <= '0;
      end
    end else begin
      // ---- Programming writes (gated by prog_open) ----
      if (is_word && reg_write && prog_open) begin
        if (word_idx == WI_CTRL) begin
          cfg_enable_q <= reg_wdata[CTRL_ENABLE];
          // lock is write-1-to-set, sticky (cannot be cleared except by reset).
          if (reg_wdata[CTRL_LOCK]) begin
            cfg_lock_q <= 1'b1;
          end
        end else if (ent_index_valid) begin
          unique case (ent_sub)
            ENTRY_ADDR_LO: ent_addr_q[ent_index][(ADDR_W < 32 ? ADDR_W : 32)-1:0]
                             <= reg_wdata[(ADDR_W < 32 ? ADDR_W : 32)-1:0];
            ENTRY_ADDR_HI: if (ADDR_W > 32)
                             ent_addr_q[ent_index][ADDR_W-1:32] <= reg_wdata[ADDR_W-33:0];
            ENTRY_CFG: begin
              ent_a_q[ent_index] <= reg_wdata[CFG_A_LSB +: 2];
              ent_r_q[ent_index] <= reg_wdata[CFG_R];
              ent_w_q[ent_index] <= reg_wdata[CFG_W];
              ent_x_q[ent_index] <= reg_wdata[CFG_X];
            end
            ENTRY_SRCMD_LO: ent_srcmd_q[ent_index][31:0] <= reg_wdata;
            ENTRY_SRCMD_HI: if (NUM_SRC_L > 32)
                              ent_srcmd_q[ent_index][NUM_SRC_L-1:32] <= reg_wdata[NUM_SRC_L-33:0];
            default: ; // reserved words: no-op
          endcase
        end
      end

      // ---- ERR_INFO.valid write-1-to-clear (allowed regardless of lock so the
      //      RoT can drain the violation log after lock). ----
      if (is_word && reg_write && (word_idx == WI_ERR_INFO) && reg_wdata[ERR_VALID]) begin
        err_valid_q <= 1'b0;
        err_type_q  <= VIOL_NONE;
      end

      // ---- Latch the first denied transaction after each clear. ----
      if (chk_deny && !err_valid_q) begin
        err_valid_q <= 1'b1;
        err_type_q  <= viol_type;
        err_src_q   <= chk_src_id;
        err_addr_q  <= chk_addr;
      end
    end
  end

  // ================================================================
  // Register read mux (combinational read of latched state).
  // ================================================================
  logic [31:0] entry_rdata;
  always_comb begin
    entry_rdata = 32'h0;
    if (ent_index_valid) begin
      unique case (ent_sub)
        ENTRY_ADDR_LO: entry_rdata = 32'(ent_addr_q[ent_index]);
        ENTRY_ADDR_HI: entry_rdata = (ADDR_W > 32)
                                     ? 32'(ent_addr_q[ent_index] >> 32)
                                     : 32'h0;
        ENTRY_CFG: entry_rdata = {27'h0, ent_x_q[ent_index],
                                  ent_w_q[ent_index], ent_r_q[ent_index],
                                  ent_a_q[ent_index]};
        ENTRY_SRCMD_LO: entry_rdata = ent_srcmd_q[ent_index][31:0];
        ENTRY_SRCMD_HI: entry_rdata = (NUM_SRC_L > 32)
                                      ? {{(64-NUM_SRC_L){1'b0}}, ent_srcmd_q[ent_index][NUM_SRC_L-1:32]}[31:0]
                                      : 32'h0;
        default: entry_rdata = 32'h0;
      endcase
    end
  end

  logic [31:0] status_word;
  logic [31:0] errinfo_word;
  always_comb begin
    status_word = 32'h0;
    status_word[STATUS_LOCKED]       = cfg_lock_q;
    status_word[STATUS_ENABLE]       = cfg_enable_q;
    status_word[STATUS_POLICY_READY] = policy_ready_o;
    errinfo_word = 32'h0;
    errinfo_word[ERR_VALID]              = err_valid_q;
    errinfo_word[ERR_TYPE_LSB +: 2]      = err_type_q;
  end

  always_comb begin
    reg_rdata = 32'h0;
    if (reg_valid && !reg_write) begin
      unique case (word_idx)
        WI_CTRL:        reg_rdata = {30'h0, cfg_lock_q, cfg_enable_q};
        WI_STATUS:      reg_rdata = status_word;
        WI_ERR_INFO:    reg_rdata = errinfo_word;
        WI_ERR_SRCID:   reg_rdata = {{(32-SRC_W){1'b0}}, err_src_q};
        WI_ERR_ADDR_LO: reg_rdata = err_addr_q[31:0];
        WI_ERR_ADDR_HI: reg_rdata = (PADDR_W > 32)
                                    ? {{(64-PADDR_W){1'b0}}, err_addr_q[PADDR_W-1:32]}[31:0]
                                    : 32'h0;
        default:        reg_rdata = in_entry ? entry_rdata : 32'h0;
      endcase
    end
  end

  // ================================================================
  // Status outputs.
  // ================================================================
  assign locked_o       = cfg_lock_q;
  // Policy is ready (RoT may release the platform) only once the IOPMP is both
  // enabled and locked: a default-deny policy is installed and can no longer be
  // widened by the host. Fail-closed: an unlocked or disabled IOPMP is never
  // "ready".
  assign policy_ready_o = cfg_enable_q & cfg_lock_q;

  // Tie off bits read for completeness but not otherwise consumed: the byte
  // offset within a word (the slave is word-granular) and the priority-decode
  // intermediates (ent_first selects the winning entry inside the always_comb,
  // and the final higher_sel rung folds into any_match).
  /* verilator lint_off UNUSED */
  wire _unused = ^{reg_addr[1:0], ent_first, ent_range_hit, ent_src_admit,
                   ent_word_off_full[9:OFF_BITS]};
  /* verilator lint_on UNUSED */

endmodule : e1_iopmp
