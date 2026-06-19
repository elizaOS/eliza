`timescale 1ns/1ps

// e1_mtt_pkg
//
// Architectural constants for the E1 memory-tracking-table (MTT / RISC-V
// Smmtt) checker, rtl/security/mtt/e1_mtt_checker.sv. The MTT is the whole-OS
// memory-isolation spine of the TEE-native confidential VM (lane 01,
// docs/security/tee-plan/01-tee-core-architecture.md S2; the page-state
// contract docs/security/confidential-domain.md and the machine-readable
// transition model docs/spec-db/tee-page-state-transitions.json).
//
// What the MTT is (01-tee-core-architecture.md S2.1): a hardware-walked,
// monitor-owned table indexed by host-physical page that records the
// confidentiality class (page state) and owning domain of every page of DRAM.
// On every access that reaches the system bus the page's MTT entry is walked
// and checked against the requester's world (domain id). The checker makes the
// six Confidential Domain Contract page states real and enforces the I/O rule:
// a confidential (private/measured) or scrub-pending page is denied to the
// untrusted host/hypervisor world; a shared page is the only bounce path both
// worlds may touch; an unmapped page is default-deny.
//
// Walk model: a two-level radix walk over a memory-resident table reached
// through a read-only AXI4 master (the table lives in DRAM, walked like a page
// table; the TSM programs only the root pointer + config through MMIO). The
// physical page number splits into a root index (high bits) and a leaf index
// (low bits). The root level may hold a LEAF entry that covers an entire
// superpage region in one step, or a POINTER entry to a leaf table walked at
// the second level. Unmapped/invalid at any level => default-deny.
//
// Page-state encoding: the 3-bit state field of an MTT entry uses exactly the
// six states of docs/spec-db/tee-page-state-transitions.json, in the same order
// the policy/model lists them, so the RTL and the pure-Python page_state_model
// share one numbering. The checker enforces access policy per state; the
// legality of state *transitions* is owned by the TSM software (it programs the
// table) and proven by scripts/tee/page_state_model.py. The hardware enforces
// the access invariants that must hold even if the TSM is buggy.

package e1_mtt_pkg;

  // ------------------------------------------------------------------
  // Sizing. Defaults cover the E1 confidential-VM footprint with headroom.
  // ------------------------------------------------------------------
  localparam int unsigned PADDR_BITS  = 40;   // host-physical address width
  localparam int unsigned PAGE_SHIFT  = 12;   // 4 KiB base page
  localparam int unsigned DOMAIN_BITS = 4;    // requester / owner world id width
  localparam int unsigned ENTRY_BITS  = 64;   // one MTT entry per 64-bit word

  // Radix split of the physical page number (PPN = paddr >> PAGE_SHIFT). The
  // two levels together cover the FULL PPN (ROOT_IDX_BITS + LEAF_IDX_BITS ==
  // PPN_BITS), so every physical page is reachable by the walk; "unmapped" is
  // therefore an INVALID entry (default-deny), never an address out of range.
  localparam int unsigned PPN_BITS      = PADDR_BITS - PAGE_SHIFT;  // 28
  localparam int unsigned LEAF_IDX_BITS = PPN_BITS / 2;             // 14
  localparam int unsigned ROOT_IDX_BITS = PPN_BITS - LEAF_IDX_BITS; // 14
  // A root LEAF entry covers one superpage of 2^(LEAF_IDX_BITS+PAGE_SHIFT) bytes
  // (here 2^26 = 64 MiB), exactly the leaf-table span it replaces.

  // ------------------------------------------------------------------
  // Page-state encoding. EXACTLY docs/spec-db/tee-page-state-transitions.json
  // "states" order: free, measured, private, shared, device-assigned,
  // scrub-pending. Kept in sync with scripts/tee/page_state_model.py via the
  // shared JSON; the cocotb suite reads the JSON and asserts this numbering.
  // ------------------------------------------------------------------
  localparam logic [2:0] PS_FREE            = 3'd0;
  localparam logic [2:0] PS_MEASURED        = 3'd1;
  localparam logic [2:0] PS_PRIVATE         = 3'd2;
  localparam logic [2:0] PS_SHARED          = 3'd3;
  localparam logic [2:0] PS_DEVICE_ASSIGNED = 3'd4;
  localparam logic [2:0] PS_SCRUB_PENDING   = 3'd5;

  // ------------------------------------------------------------------
  // Requester world (domain id). The untrusted host/hypervisor is a reserved
  // id; confidential guest domains and measured devices carry their own ids.
  // The host id is fixed so the I/O rule ("host may never read a confidential
  // page") is structural, not a programmed value the host could spoof.
  // ------------------------------------------------------------------
  localparam logic [DOMAIN_BITS-1:0] DOMAIN_HOST = '0;  // untrusted host = 0

  // ------------------------------------------------------------------
  // MTT entry layout (64-bit, little-endian word fetched from the table).
  //   [0]      valid     entry is populated
  //   [1]      leaf      1 = leaf (state/owner valid); 0 = pointer to next level
  //   [4:2]    state     PS_* page state (leaf only)
  //   [8:5]    owner     owning domain id (leaf only; DOMAIN_HOST for free)
  //   [9]      dev_ok    device-assigned permit flag: the IOMMU/lane-03
  //                      source-ID match is asserted for this page (leaf only)
  //   [PADDR_BITS-1:PAGE_SHIFT]+offset : next-level table PPN (pointer only)
  // The pointer's next-table physical address = next_ppn << PAGE_SHIFT.
  // ------------------------------------------------------------------
  localparam int unsigned E_VALID    = 0;
  localparam int unsigned E_LEAF     = 1;
  localparam int unsigned E_STATE_LSB = 2;   // [4:2]
  localparam int unsigned E_OWNER_LSB = 5;   // [8:5]
  localparam int unsigned E_DEVOK     = 9;
  // Pointer next-table PPN occupies [10 +: PPN_BITS].
  localparam int unsigned E_NEXTPPN_LSB = 10;

  // ------------------------------------------------------------------
  // MMIO register map (byte offsets within the MTT programming aperture).
  // Word-indexed valid/write/addr/wdata/rdata slave, the convention of
  // rtl/security/otp/e1_otp_map.sv and rtl/iommu/e1_iopmp.sv. 32-bit words.
  // ------------------------------------------------------------------
  localparam logic [11:0] OFFS_CTRL        = 12'h000;  // [0]=enable [1]=lock(W1S)
  localparam logic [11:0] OFFS_STATUS      = 12'h004;  // [0]=locked [1]=enable [2]=ready
  localparam logic [11:0] OFFS_ROOT_LO     = 12'h008;  // root-table phys addr [31:0]
  localparam logic [11:0] OFFS_ROOT_HI     = 12'h00C;  // root-table phys addr [PADDR-1:32]
  localparam logic [11:0] OFFS_FAULT_INFO  = 12'h010;  // [0]=valid(RW1C) [3:1]=state [4]=write
  localparam logic [11:0] OFFS_FAULT_DOM   = 12'h014;  // latched requester domain id
  localparam logic [11:0] OFFS_FAULT_ADDR_LO = 12'h018;  // latched faulting addr [31:0]
  localparam logic [11:0] OFFS_FAULT_ADDR_HI = 12'h01C;  // latched faulting addr [PADDR-1:32]
  localparam logic [11:0] OFFS_SCRUB       = 12'h020;  // [0]=scrub_done pulse-in (W1)

  // CTRL register bit positions.
  localparam int unsigned CTRL_ENABLE = 0;
  localparam int unsigned CTRL_LOCK   = 1;

  // STATUS register bit positions.
  localparam int unsigned STATUS_LOCKED = 0;
  localparam int unsigned STATUS_ENABLE = 1;
  localparam int unsigned STATUS_READY  = 2;  // enabled & locked & root programmed

  // FAULT_INFO register bit positions.
  localparam int unsigned FAULT_VALID     = 0;  // RW1C latched-fault flag
  localparam int unsigned FAULT_STATE_LSB = 1;  // [3:1] page state at fault
  localparam int unsigned FAULT_WRITE     = 4;  // the faulting op was a write
  localparam int unsigned FAULT_KIND_LSB  = 5;  // [6:5] verdict kind (V_*)

  // ------------------------------------------------------------------
  // Check verdict (combinational classification of a walked access).
  // ------------------------------------------------------------------
  localparam logic [1:0] V_ALLOW       = 2'd0;
  localparam logic [1:0] V_DENY_UNMAP  = 2'd1;  // unmapped / invalid -> default-deny
  localparam logic [1:0] V_DENY_STATE  = 2'd2;  // mapped but state forbids this world/op

endpackage
