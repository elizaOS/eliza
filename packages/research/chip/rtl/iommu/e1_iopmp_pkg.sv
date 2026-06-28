`timescale 1ns/1ps

// e1_iopmp_pkg
//
// Architectural constants for the E1 I/O Physical Memory Protection (IOPMP)
// block, rtl/iommu/e1_iopmp.sv. The IOPMP is the source-ID-gated region
// permission layer of the secure-I/O lane (docs/security/tee-plan/
// 03-secure-io-iommu-npu.md S1, work item P1.3): downstream of and redundant
// to the IOMMU translation, it enforces address-range + R/W/X permission per
// DMA source ID, default-deny, with monitor/RoT-locked entries.
//
// Model: a flat priority-ordered entry table (RISC-V IOPMP-style). Entry 0 is
// highest priority; the first entry that both matches the transaction's address
// range AND admits the transaction's source ID decides the verdict (its R/W/X
// permission bits). No matching entry => default-deny. This mirrors the RISC-V
// IOPMP "priority entries, first-hit" lookup and the RISC-V PMP NAPOT/TOR range
// shape. Source-ID membership is a per-entry bitmask (SRCMD) over the supported
// source-ID space, so one region can admit several masters with one entry.
//
// The source IDs themselves are the per-master DMA source IDs declared in
// docs/spec-db/tee-iopmp-source-id-map.json (usb=16, emmc-ufs=17, display=18,
// isp=19, npu-dma=20, network=21, debug-transport=22), matching the IOMMU
// device-id convention. SRC_ID_BITS sizes the membership mask to cover them.

package e1_iopmp_pkg;

  // ------------------------------------------------------------------
  // Sizing parameters. Defaults cover the E1 source-ID policy
  // (tee-iopmp-source-id-map.json) with headroom; the module re-exposes them
  // as parameters so an integrator can scale the table.
  // ------------------------------------------------------------------
  localparam int unsigned PADDR_BITS  = 40;   // physical I/O address width
  localparam int unsigned SRC_ID_BITS = 6;    // source-ID width (0..63)
  localparam int unsigned NUM_ENTRY   = 16;   // priority entries

  // Address-range encoding per entry (PMP-style addr-matching field).
  localparam logic [1:0] A_OFF   = 2'd0;  // entry disabled (never matches)
  localparam logic [1:0] A_NAPOT = 2'd1;  // naturally-aligned power-of-two

  // ------------------------------------------------------------------
  // MMIO register map (byte offsets within the IOPMP programming aperture).
  // Word-indexed valid/write/addr/wdata/rdata slave, matching the convention
  // of rtl/security/otp/e1_otp_map.sv and rtl/security/lc/e1_lc_ctrl.sv.
  //
  // Global control / status block (offset < ENTRY_BASE):
  // ------------------------------------------------------------------
  localparam logic [11:0] OFFS_CTRL       = 12'h000;  // [0]=enable [1]=lock(W1S)
  localparam logic [11:0] OFFS_STATUS     = 12'h004;  // [0]=locked [1]=enable [2]=policy_ready
  localparam logic [11:0] OFFS_ERR_INFO   = 12'h008;  // [0]=valid (RW1C) [2:1]=type
  localparam logic [11:0] OFFS_ERR_SRCID  = 12'h00C;  // latched violating source ID
  localparam logic [11:0] OFFS_ERR_ADDR_LO= 12'h010;  // latched violating addr [31:0]
  localparam logic [11:0] OFFS_ERR_ADDR_HI= 12'h014;  // latched violating addr [PADDR-1:32]

  // Per-entry register block. Each entry occupies 8 words (32 bytes):
  //   +0  ADDR_LO   addr[31:0]   (PMP-NAPOT encoded base/size, addr>>2)
  //   +1  ADDR_HI   addr[PADDR-1:32]
  //   +2  CFG       [1:0]=A (OFF/NAPOT) [2]=R [3]=W [4]=X
  //   +3  SRCMD_LO  source-ID membership bits [31:0]
  //   +4  SRCMD_HI  source-ID membership bits [NUM_SRC-1:32]
  //   +5..+7 reserved
  localparam logic [11:0] OFFS_ENTRY_BASE = 12'h100;
  localparam int unsigned ENTRY_STRIDE    = 8;        // words per entry
  localparam logic [2:0]  ENTRY_ADDR_LO   = 3'd0;
  localparam logic [2:0]  ENTRY_ADDR_HI   = 3'd1;
  localparam logic [2:0]  ENTRY_CFG       = 3'd2;
  localparam logic [2:0]  ENTRY_SRCMD_LO  = 3'd3;
  localparam logic [2:0]  ENTRY_SRCMD_HI  = 3'd4;

  // CTRL register bit positions.
  localparam int unsigned CTRL_ENABLE = 0;
  localparam int unsigned CTRL_LOCK   = 1;

  // STATUS register bit positions.
  localparam int unsigned STATUS_LOCKED       = 0;
  localparam int unsigned STATUS_ENABLE       = 1;
  localparam int unsigned STATUS_POLICY_READY = 2;

  // ERR_INFO register bit positions.
  localparam int unsigned ERR_VALID = 0;  // RW1C latched-violation flag
  localparam int unsigned ERR_TYPE_LSB = 1;  // [2:1] violation type

  // Per-entry CFG bit positions.
  localparam int unsigned CFG_A_LSB = 0;  // [1:0]
  localparam int unsigned CFG_R     = 2;
  localparam int unsigned CFG_W     = 3;
  localparam int unsigned CFG_X     = 4;

  // Transaction request type (the kind of access being checked).
  localparam logic [1:0] REQ_READ  = 2'd0;
  localparam logic [1:0] REQ_WRITE = 2'd1;
  localparam logic [1:0] REQ_EXEC  = 2'd2;

  // Violation type latched in ERR_INFO[2:1].
  localparam logic [1:0] VIOL_NONE         = 2'd0;
  localparam logic [1:0] VIOL_NO_MATCH     = 2'd1;  // default-deny: no entry admitted
  localparam logic [1:0] VIOL_PERMISSION   = 2'd2;  // matched entry, op not permitted

endpackage
