`timescale 1ns/1ps

// e1_mtt_checker.sv
//
// E1 memory-tracking-table (MTT / RISC-V Smmtt) checker -- the whole-OS
// memory-isolation spine of the TEE-native confidential VM (lane 01,
// docs/security/tee-plan/01-tee-core-architecture.md S2). It is the hardware
// that makes the six Confidential Domain Contract page states real
// (docs/security/confidential-domain.md, docs/spec-db/
// tee-page-state-transitions.json).
//
// Role: on every inbound access that reaches the system bus (CPU load/store or
// DMA), the checker is presented {requester domain id, physical address,
// write?}. It walks a memory-resident, monitor-owned MTT to fetch the page's
// entry {state, owner domain} and returns a permit/deny verdict per the page
// state and the I/O rule. Default-deny by construction: an unmapped page, an
// invalid entry, a disabled/unprogrammed checker, or any walk error denies.
//
// Walk (S2.1): a two-level radix walk reached through a read-only AXI4 master.
// The table lives in DRAM and is walked like a page table; the TSM programs
// only the root pointer + enable + lock through the MMIO slave. The physical
// page number splits root[high] / leaf[low]. The root entry may be a LEAF that
// covers a whole superpage in one step, or a POINTER to a leaf table fetched at
// the second level. PPNs above the walked space are unmapped (default-deny).
//
// Page-state access policy (the per-access invariants HW owns even if the TSM
// is buggy, S2.2). Requester worlds: DOMAIN_HOST (the untrusted host /
// hypervisor, a fixed reserved id) versus a confidential guest domain id.
//   * free            : host-only scratch. Host R/W ok; a confidential domain
//                       has no business there -> deny (it is not its memory).
//   * private/measured: confidential, owning-domain-only. Host (or any
//                       non-owner) access DENIED -> fault. Owner R ok; owner
//                       write to measured DENIED once launch-frozen (the TSM
//                       sets measured only on frozen launch pages).
//   * shared          : the bounce buffer. Both the owner and the host may
//                       access it (the I/O rule's only cross-world path).
//   * device-assigned : owner + a measured device may access, gated by the
//                       per-entry dev_ok flag (lane 03 supplies the source-ID
//                       match). Host DENIED.
//   * scrub-pending   : no world may access until zeroized -> deny-all until
//                       the scrub engine returns scrub_done; the checker holds
//                       deny-all for these pages regardless of requester.
//
// Programming + lock (TSM-owned, S2.2): the root pointer/enable/lock are
// writable through MMIO ONLY while unlocked AND the requester is the TSM
// (prog_unlock_i asserted by the privileged TSM port). The TSM sets CTRL.lock
// (W1S, sticky) after programming; thereafter all programming writes are
// dropped so untrusted M-mode firmware cannot reprogram the table even though
// it shares M-mode. ready_o (enabled & locked & root set) gates platform
// release.
//
// Fault record: the first denied access after each clear latches its requester
// domain, address, page state, and op into the FAULT_* registers for the TSM /
// RoT to read; FAULT_INFO.valid is write-1-to-clear.
//
// Synthesizable: single clock, single synchronous-release async-assert reset,
// no initial blocks, no delays. The AXI4 walk master is read-only (AR/R only);
// the checker never writes the table (the TSM does, out of band).

module e1_mtt_checker
  import e1_mtt_pkg::*;
#(
    parameter int unsigned PADDR_W = e1_mtt_pkg::PADDR_BITS,
    parameter int unsigned DOM_W   = e1_mtt_pkg::DOMAIN_BITS
) (
    input  logic clk,
    input  logic rst_n,

    // ----------------------------------------------------------------
    // MMIO programming slave (word-indexed valid/write/addr/wdata/rdata),
    // matching rtl/security/otp/e1_otp_map.sv and rtl/iommu/e1_iopmp.sv. The
    // TSM drives this. prog_unlock_i is the privileged-requester gate: only the
    // TSM asserts it, so untrusted M-mode firmware cannot edit the root/config.
    // ----------------------------------------------------------------
    input  logic        reg_valid,
    input  logic        reg_write,
    input  logic        prog_unlock_i,   // requester is the TSM (privileged)
    input  logic [11:0] reg_addr,
    input  logic [31:0] reg_wdata,
    output logic [31:0] reg_rdata,

    // ----------------------------------------------------------------
    // Access check port. A requester presents {domain id, address, write?} and
    // asserts chk_valid for one cycle. The checker walks the MTT and returns
    // chk_done with chk_allow / chk_deny; the fabric gates the transaction on
    // the verdict and converts a deny into a fault response, never a silent
    // pass. chk_busy is high while a walk is outstanding (one walk at a time).
    // ----------------------------------------------------------------
    input  logic                 chk_valid,
    input  logic [DOM_W-1:0]     chk_domain,
    input  logic [PADDR_W-1:0]   chk_addr,
    input  logic                 chk_write,
    output logic                 chk_busy,
    output logic                 chk_done,
    output logic                 chk_allow,
    output logic                 chk_deny,

    // ----------------------------------------------------------------
    // Read-only AXI4 walk master to the fabric (table-walk reads only). Single
    // outstanding beat: the walker issues an AR, takes one R beat per level.
    // ----------------------------------------------------------------
    output logic                 w_arvalid,
    input  logic                 w_arready,
    output logic [PADDR_W-1:0]   w_araddr,
    input  logic                 w_rvalid,
    output logic                 w_rready,
    input  logic [ENTRY_BITS-1:0] w_rdata,
    input  logic [1:0]           w_rresp,

    // ----------------------------------------------------------------
    // Scrub-engine handshake. scrub_done_i pulses when the zeroization engine
    // has cleared a scrub-pending page; the TSM then transitions it to free in
    // the table. The checker tracks an armed flag only for status visibility;
    // scrub-pending pages deny-all regardless until the table entry changes.
    // ----------------------------------------------------------------
    input  logic                 scrub_done_i,

    // ----------------------------------------------------------------
    // Status to the TSM / RoT.
    // ----------------------------------------------------------------
    output logic                 ready_o,    // enabled & locked & root set
    output logic                 locked_o,
    output logic                 fault_o     // pulses the cycle an access is denied
);

  // AXI response codes.
  localparam logic [1:0] RESP_OKAY = 2'b00;

  // ================================================================
  // Programmable state. Held in reset to a fully-closed configuration:
  // disabled, unlocked, root unset. Because the verdict is default-deny, a
  // disabled/unprogrammed checker denies every access -- the platform is
  // released only after the TSM programs a root and locks.
  // ================================================================
  logic                cfg_enable_q;
  logic                cfg_lock_q;
  logic [PADDR_W-1:0]  root_paddr_q;     // root-table physical base address
  logic                root_set_q;       // root pointer has been programmed

  // Latched fault record.
  logic                flt_valid_q;
  logic [2:0]          flt_state_q;
  logic                flt_write_q;
  logic [1:0]          flt_kind_q;
  logic [DOM_W-1:0]    flt_dom_q;
  logic [PADDR_W-1:0]  flt_addr_q;

  // Status visibility of the scrub handshake (last scrub_done observed).
  logic                scrub_seen_q;

  // ================================================================
  // Captured access under check (latched at accept so the inputs may change
  // during the multi-cycle walk).
  // ================================================================
  logic [DOM_W-1:0]    req_dom_q;
  logic [PADDR_W-1:0]  req_addr_q;
  logic                req_write_q;

  // Physical page number and its radix split. The walk uses the registered
  // req_addr_q in every state EXCEPT acceptance, where the live chk_addr is the
  // request being captured this cycle; the root-table index must reflect the
  // incoming address so the first AR (issued the cycle after accept) targets the
  // correct root slot.
  localparam int unsigned WALK_BITS = ROOT_IDX_BITS + LEAF_IDX_BITS;  // == PPN_BITS
  logic [PADDR_W-1:0]  cur_addr;
  assign cur_addr = (state_q == S_IDLE) ? chk_addr : req_addr_q;

  logic [PPN_BITS-1:0]      cur_ppn;
  logic [LEAF_IDX_BITS-1:0] leaf_idx;
  logic [ROOT_IDX_BITS-1:0] root_idx;
  assign cur_ppn  = cur_addr[PADDR_W-1:PAGE_SHIFT];
  assign leaf_idx = cur_ppn[LEAF_IDX_BITS-1:0];
  assign root_idx = cur_ppn[WALK_BITS-1:LEAF_IDX_BITS];

  // ================================================================
  // Walk FSM. One walk at a time over the read-only AXI master.
  //   IDLE     : accept a chk_valid; if out of range or not ready, deny now.
  //   ROOT_AR  : issue AR for the root entry.
  //   ROOT_R   : take the R beat; classify pointer/leaf/invalid.
  //   LEAF_AR  : issue AR for the leaf entry (pointer case).
  //   LEAF_R   : take the R beat; classify leaf/invalid.
  //   DONE     : pulse chk_done + verdict for one cycle.
  // ================================================================
  typedef enum logic [2:0] {
    S_IDLE, S_ROOT_AR, S_ROOT_R, S_LEAF_AR, S_LEAF_R, S_DONE
  } walk_state_e;
  walk_state_e state_q, state_n;

  // Walked entry result.
  logic              ent_valid;
  logic              ent_leaf;
  logic [2:0]        ent_state;
  logic [DOM_W-1:0]  ent_owner;
  logic              ent_devok;
  logic [PPN_BITS-1:0] ent_nextppn;

  // Decode the most recent R beat (combinational view of w_rdata).
  logic              rd_valid;
  logic              rd_leaf;
  logic [2:0]        rd_state;
  logic [DOM_W-1:0]  rd_owner;
  logic              rd_devok;
  logic [PPN_BITS-1:0] rd_nextppn;
  assign rd_valid   = w_rdata[E_VALID];
  assign rd_leaf    = w_rdata[E_LEAF];
  assign rd_state   = w_rdata[E_STATE_LSB +: 3];
  assign rd_owner   = w_rdata[E_OWNER_LSB +: DOM_W];
  assign rd_devok   = w_rdata[E_DEVOK];
  assign rd_nextppn = w_rdata[E_NEXTPPN_LSB +: PPN_BITS];

  // The captured-entry fields drive the verdict in S_DONE. A flag marks whether
  // the walk reached a usable leaf or terminated unmapped (default-deny).
  logic              walk_unmapped;   // set when any level is invalid/out-of-range
  logic              walk_resp_err;   // an AXI R beat returned a non-OKAY response

  // AXI address for the current level's entry fetch.
  logic [PADDR_W-1:0] level_table_base;   // base of the table being indexed
  logic [WALK_BITS-1:0] level_index;      // entry index within that table (zero-extended use)
  logic [PADDR_W-1:0] level_addr;
  // entry stride = ENTRY_BITS/8 bytes.
  localparam int unsigned ENTRY_BYTES = ENTRY_BITS / 8;
  assign level_addr = level_table_base + (PADDR_W'(level_index) * PADDR_W'(ENTRY_BYTES));

  // At ROOT level index by root_idx into root_paddr_q; at LEAF level index by
  // leaf_idx into the pointer's next table.
  logic [PADDR_W-1:0] leaf_table_base_q;

  always_comb begin
    if (state_q == S_LEAF_AR) begin
      level_table_base = leaf_table_base_q;
      level_index      = WALK_BITS'(leaf_idx);
    end else begin
      level_table_base = root_paddr_q;
      level_index      = WALK_BITS'(root_idx);
    end
  end

  // ----------------------------------------------------------------
  // Verdict (combinational) over the captured entry + page-state policy.
  // Computed continuously; consumed in S_DONE. Default-deny everywhere the
  // policy does not explicitly permit.
  // ----------------------------------------------------------------
  logic              req_is_host;
  logic              req_is_owner;
  assign req_is_host  = (req_dom_q == DOMAIN_HOST);
  assign req_is_owner = (req_dom_q == ent_owner) && !req_is_host;

  logic        verdict_allow;
  logic [1:0]  verdict_kind;
  always_comb begin
    verdict_allow = 1'b0;
    verdict_kind  = V_DENY_UNMAP;
    if (walk_unmapped || walk_resp_err || !ent_valid || !ent_leaf) begin
      // Unmapped / invalid / non-leaf terminal / bus error -> default-deny.
      verdict_allow = 1'b0;
      verdict_kind  = V_DENY_UNMAP;
    end else begin
      verdict_kind = V_DENY_STATE;  // mapped: any deny below is a state denial
      unique case (ent_state)
        PS_FREE: begin
          // Host scratch only; a confidential domain has no claim to free RAM.
          verdict_allow = req_is_host;
        end
        PS_PRIVATE: begin
          // Owning confidential domain only; host DENIED (the I/O rule).
          verdict_allow = req_is_owner;
        end
        PS_MEASURED: begin
          // Owning domain may READ; writes to a measured (launch-frozen) page
          // are denied. Host DENIED outright.
          verdict_allow = req_is_owner && !req_write_q;
        end
        PS_SHARED: begin
          // The bounce buffer: both the owner and the host may access it.
          verdict_allow = req_is_owner || req_is_host;
        end
        PS_DEVICE_ASSIGNED: begin
          // Owner, or a measured device whose source-ID match (dev_ok) is set.
          // Host DENIED.
          verdict_allow = req_is_owner || (!req_is_host && ent_devok);
        end
        PS_SCRUB_PENDING: begin
          // No world may touch it until zeroized -> deny-all.
          verdict_allow = 1'b0;
        end
        default: verdict_allow = 1'b0;
      endcase
    end
    if (verdict_allow) begin
      verdict_kind = V_ALLOW;
    end
  end

  // ================================================================
  // FSM next-state + datapath.
  // ================================================================
  // accept_now: a fresh check can be accepted (idle and ready). When the
  // checker is not ready (disabled/unlocked/no root) or the address is out of
  // the walked range, the access is denied without a bus walk.
  logic checker_ready;
  assign checker_ready = cfg_enable_q && cfg_lock_q && root_set_q;

  logic accept;
  assign accept = (state_q == S_IDLE) && chk_valid;

  always_comb begin
    state_n = state_q;
    unique case (state_q)
      S_IDLE: begin
        if (chk_valid) begin
          // Fast-path denial: a disabled/unlocked/unprogrammed checker denies
          // with no bus walk. Otherwise begin the root walk.
          if (!checker_ready) begin
            state_n = S_DONE;
          end else begin
            state_n = S_ROOT_AR;
          end
        end
      end
      S_ROOT_AR: if (w_arvalid && w_arready) state_n = S_ROOT_R;
      S_ROOT_R:  if (w_rvalid) begin
        // Pointer with a valid next level -> walk the leaf table; otherwise the
        // root entry is terminal (leaf or invalid) and we are done.
        if (w_rresp != RESP_OKAY)            state_n = S_DONE;
        else if (rd_valid && !rd_leaf)       state_n = S_LEAF_AR;
        else                                  state_n = S_DONE;
      end
      S_LEAF_AR: if (w_arvalid && w_arready) state_n = S_LEAF_R;
      S_LEAF_R:  if (w_rvalid)                state_n = S_DONE;
      S_DONE:                                 state_n = S_IDLE;
      default:                                state_n = S_IDLE;
    endcase
  end

  // AXI master drive. AR is presented in the *_AR states; R is accepted in the
  // *_R states. Read-only: no write channels.
  assign w_arvalid = (state_q == S_ROOT_AR) || (state_q == S_LEAF_AR);
  assign w_araddr  = level_addr;
  assign w_rready  = (state_q == S_ROOT_R) || (state_q == S_LEAF_R);

  // chk_busy is high from accept until DONE; chk_done pulses in DONE.
  assign chk_busy  = (state_q != S_IDLE) && (state_q != S_DONE);
  assign chk_done  = (state_q == S_DONE);
  assign chk_allow = (state_q == S_DONE) && verdict_allow;
  assign chk_deny  = (state_q == S_DONE) && !verdict_allow;
  assign fault_o   = chk_deny;

  // ================================================================
  // Sequential: capture the request, walk results, registers, fault record.
  // ================================================================
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state_q           <= S_IDLE;
      cfg_enable_q      <= 1'b0;
      cfg_lock_q        <= 1'b0;
      root_paddr_q      <= '0;
      root_set_q        <= 1'b0;
      flt_valid_q       <= 1'b0;
      flt_state_q       <= PS_FREE;
      flt_write_q       <= 1'b0;
      flt_kind_q        <= V_DENY_UNMAP;
      flt_dom_q         <= '0;
      flt_addr_q        <= '0;
      scrub_seen_q      <= 1'b0;
      req_dom_q         <= '0;
      req_addr_q        <= '0;
      req_write_q       <= 1'b0;
      leaf_table_base_q <= '0;
      ent_valid         <= 1'b0;
      ent_leaf          <= 1'b0;
      ent_state         <= PS_FREE;
      ent_owner         <= '0;
      ent_devok         <= 1'b0;
      ent_nextppn       <= '0;
      walk_unmapped     <= 1'b0;
      walk_resp_err     <= 1'b0;
    end else begin
      state_q <= state_n;

      // ---- Scrub-engine status latch (visibility only). ----
      if (scrub_done_i) begin
        scrub_seen_q <= 1'b1;
      end

      // ---- Capture the request on accept; reset walk flags. ----
      if (accept) begin
        req_dom_q     <= chk_domain;
        req_addr_q    <= chk_addr;
        req_write_q   <= chk_write;
        walk_unmapped <= !checker_ready;
        walk_resp_err <= 1'b0;
        ent_valid     <= 1'b0;
        ent_leaf      <= 1'b0;
        ent_state     <= PS_FREE;
        ent_owner     <= '0;
        ent_devok     <= 1'b0;
      end

      // ---- Capture the root R beat. ----
      if (state_q == S_ROOT_R && w_rvalid) begin
        if (w_rresp != RESP_OKAY) begin
          walk_resp_err <= 1'b1;
        end else if (!rd_valid) begin
          walk_unmapped <= 1'b1;
        end else if (rd_leaf) begin
          // Root superpage leaf entry: terminal.
          ent_valid <= 1'b1;
          ent_leaf  <= 1'b1;
          ent_state <= rd_state;
          ent_owner <= rd_owner;
          ent_devok <= rd_devok;
        end else begin
          // Pointer: record next-table base for the leaf walk.
          ent_nextppn       <= rd_nextppn;
          leaf_table_base_q <= PADDR_W'(rd_nextppn) << PAGE_SHIFT;
        end
      end

      // ---- Capture the leaf R beat. ----
      if (state_q == S_LEAF_R && w_rvalid) begin
        if (w_rresp != RESP_OKAY) begin
          walk_resp_err <= 1'b1;
        end else if (!rd_valid || !rd_leaf) begin
          // A second-level entry must be a valid leaf; otherwise unmapped.
          walk_unmapped <= 1'b1;
        end else begin
          ent_valid <= 1'b1;
          ent_leaf  <= 1'b1;
          ent_state <= rd_state;
          ent_owner <= rd_owner;
          ent_devok <= rd_devok;
        end
      end

      // ---- Latch the first denied access after each clear (in DONE). ----
      if (state_q == S_DONE && !verdict_allow && !flt_valid_q) begin
        flt_valid_q <= 1'b1;
        flt_state_q <= ent_state;
        flt_write_q <= req_write_q;
        flt_kind_q  <= verdict_kind;
        flt_dom_q   <= req_dom_q;
        flt_addr_q  <= req_addr_q;
      end

      // ---- Programming writes: gated by unlock window AND TSM privilege. ----
      if (reg_valid && reg_write && prog_unlock_i && !cfg_lock_q) begin
        unique case (reg_addr[11:2])
          OFFS_CTRL[11:2]: begin
            cfg_enable_q <= reg_wdata[CTRL_ENABLE];
            if (reg_wdata[CTRL_LOCK]) begin
              cfg_lock_q <= 1'b1;  // W1S, sticky until reset
            end
          end
          OFFS_ROOT_LO[11:2]: begin
            root_paddr_q[31:0] <= reg_wdata;
            root_set_q         <= 1'b1;
          end
          OFFS_ROOT_HI[11:2]: begin
            if (PADDR_W > 32) begin
              root_paddr_q[PADDR_W-1:32] <= reg_wdata[PADDR_W-33:0];
            end
          end
          default: ; // other words not programmable
        endcase
      end

      // ---- FAULT_INFO.valid write-1-to-clear: allowed regardless of lock so
      //      the TSM can drain the fault log after lock. Requires TSM privilege.
      if (reg_valid && reg_write && prog_unlock_i &&
          (reg_addr[11:2] == OFFS_FAULT_INFO[11:2]) && reg_wdata[FAULT_VALID]) begin
        flt_valid_q <= 1'b0;
      end
    end
  end

  // ================================================================
  // Register read mux (combinational read of latched state). The host may read
  // status but the fault detail is meaningful only to the TSM; reads are not
  // privilege-gated (no secret in these words) but writes are.
  // ================================================================
  logic [31:0] status_word;
  logic [31:0] faultinfo_word;
  always_comb begin
    status_word = 32'h0;
    status_word[STATUS_LOCKED] = cfg_lock_q;
    status_word[STATUS_ENABLE] = cfg_enable_q;
    status_word[STATUS_READY]  = ready_o;
    faultinfo_word = 32'h0;
    faultinfo_word[FAULT_VALID]          = flt_valid_q;
    faultinfo_word[FAULT_STATE_LSB +: 3] = flt_state_q;
    faultinfo_word[FAULT_WRITE]          = flt_write_q;
    faultinfo_word[FAULT_KIND_LSB +: 2]  = flt_kind_q;
  end

  // SCRUB register read alias (status visibility of the scrub handshake).
  localparam logic [9:0] WI_SCRUB = OFFS_SCRUB[11:2];

  always_comb begin
    reg_rdata = 32'h0;
    if (reg_valid && !reg_write) begin
      unique case (reg_addr[11:2])
        OFFS_CTRL[11:2]:         reg_rdata = {30'h0, cfg_lock_q, cfg_enable_q};
        OFFS_STATUS[11:2]:       reg_rdata = status_word;
        OFFS_ROOT_LO[11:2]:      reg_rdata = root_paddr_q[31:0];
        OFFS_ROOT_HI[11:2]:      reg_rdata = (PADDR_W > 32)
                                   ? {{(64-PADDR_W){1'b0}}, root_paddr_q[PADDR_W-1:32]}[31:0]
                                   : 32'h0;
        OFFS_FAULT_INFO[11:2]:   reg_rdata = faultinfo_word;
        OFFS_FAULT_DOM[11:2]:    reg_rdata = {{(32-DOM_W){1'b0}}, flt_dom_q};
        OFFS_FAULT_ADDR_LO[11:2]: reg_rdata = flt_addr_q[31:0];
        OFFS_FAULT_ADDR_HI[11:2]: reg_rdata = (PADDR_W > 32)
                                   ? {{(64-PADDR_W){1'b0}}, flt_addr_q[PADDR_W-1:32]}[31:0]
                                   : 32'h0;
        WI_SCRUB:                reg_rdata = {31'h0, scrub_seen_q};
        default:                 reg_rdata = 32'h0;
      endcase
    end
  end

  // ================================================================
  // Status outputs. ready_o gates platform release: a default-deny policy is
  // installed (root programmed) and can no longer be widened (locked) and the
  // checker is enabled. Fail-closed: anything less is never "ready".
  // ================================================================
  assign locked_o = cfg_lock_q;
  assign ready_o  = cfg_enable_q & cfg_lock_q & root_set_q;

  // Intentionally-unused bits: the captured next-PPN beyond the leaf base (the
  // base is what the walk uses), the AXI rresp low bit folded into walk_resp_err
  // comparison, and the device flag is consumed in the verdict.
  /* verilator lint_off UNUSED */
  wire _unused = ^{ent_nextppn, reg_addr[1:0], cur_addr[PAGE_SHIFT-1:0]};
  /* verilator lint_on UNUSED */

endmodule : e1_mtt_checker
