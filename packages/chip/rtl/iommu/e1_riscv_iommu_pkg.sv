`timescale 1ns/1ps

// e1_riscv_iommu_pkg
//
// RISC-V IOMMU v1.0.1 architectural constants.  Tracks the ratified
// specification at:
//
//   https://docs.riscv.org/reference/hardware/iommu/v20240911/_attachments/riscv-iommu.pdf
//
// Field encodings, register offsets, and fault types follow the spec
// exactly so that the upstream Linux RISC-V IOMMU driver (queued for
// merge in v6.10+) can use the same MMIO map.

package e1_riscv_iommu_pkg;

    // ------------------------------------------------------------------
    // MMIO register byte offsets (relative to iommu_base)
    // ------------------------------------------------------------------
    localparam logic [11:0] OFFS_CAPABILITIES = 12'h000;
    localparam logic [11:0] OFFS_FCTL         = 12'h008;
    localparam logic [11:0] OFFS_DDTP         = 12'h010;
    localparam logic [11:0] OFFS_CQB          = 12'h018;
    localparam logic [11:0] OFFS_CQH          = 12'h020;
    localparam logic [11:0] OFFS_CQT          = 12'h024;
    localparam logic [11:0] OFFS_FQB          = 12'h028;
    localparam logic [11:0] OFFS_FQH          = 12'h030;
    localparam logic [11:0] OFFS_FQT          = 12'h034;
    localparam logic [11:0] OFFS_PQB          = 12'h038;
    localparam logic [11:0] OFFS_PQH          = 12'h040;
    localparam logic [11:0] OFFS_PQT          = 12'h044;
    localparam logic [11:0] OFFS_CQCSR        = 12'h048;
    localparam logic [11:0] OFFS_FQCSR        = 12'h04C;
    localparam logic [11:0] OFFS_PQCSR        = 12'h050;
    localparam logic [11:0] OFFS_IPSR         = 12'h054;
    localparam logic [11:0] OFFS_IOCNTOVF     = 12'h058;
    localparam logic [11:0] OFFS_IOCNTINH     = 12'h05C;
    localparam logic [11:0] OFFS_IOHPMCYCLES  = 12'h060;
    localparam logic [11:0] OFFS_TR_REQ_IOVA  = 12'h258;
    localparam logic [11:0] OFFS_TR_REQ_CTL   = 12'h260;
    localparam logic [11:0] OFFS_TR_RESPONSE  = 12'h268;
    localparam logic [11:0] OFFS_ICVEC        = 12'h2F8;
    localparam logic [11:0] OFFS_MSI_CFG_TBL  = 12'h300;

    // ------------------------------------------------------------------
    // Device Directory Table (DDT) modes  (DDTP.iommu_mode)
    // ------------------------------------------------------------------
    localparam logic [3:0] DDTP_MODE_OFF        = 4'd0;
    localparam logic [3:0] DDTP_MODE_BARE       = 4'd1;
    localparam logic [3:0] DDTP_MODE_1LVL       = 4'd2;
    localparam logic [3:0] DDTP_MODE_2LVL       = 4'd3;
    localparam logic [3:0] DDTP_MODE_3LVL       = 4'd4;

    // ------------------------------------------------------------------
    // First-stage (Sv* / Sv-x4) modes
    // ------------------------------------------------------------------
    localparam logic [3:0] FS_MODE_BARE = 4'd0;
    localparam logic [3:0] FS_MODE_SV32 = 4'd8;
    localparam logic [3:0] FS_MODE_SV39 = 4'd8;
    localparam logic [3:0] FS_MODE_SV48 = 4'd9;
    localparam logic [3:0] FS_MODE_SV57 = 4'd10;

    // ------------------------------------------------------------------
    // Second-stage (G) modes
    // ------------------------------------------------------------------
    localparam logic [3:0] GS_MODE_BARE   = 4'd0;
    localparam logic [3:0] GS_MODE_SV32X4 = 4'd8;
    localparam logic [3:0] GS_MODE_SV39X4 = 4'd8;
    localparam logic [3:0] GS_MODE_SV48X4 = 4'd9;
    localparam logic [3:0] GS_MODE_SV57X4 = 4'd10;

    // ------------------------------------------------------------------
    // Fault / Event causes (spec section 3.3.1, table 11)
    // ------------------------------------------------------------------
    localparam logic [11:0] CAUSE_INSN_ADDR_MISALIGNED       = 12'd0;
    localparam logic [11:0] CAUSE_INSN_ACCESS_FAULT          = 12'd1;
    localparam logic [11:0] CAUSE_LOAD_ADDR_MISALIGNED       = 12'd4;
    localparam logic [11:0] CAUSE_LOAD_ACCESS_FAULT          = 12'd5;
    localparam logic [11:0] CAUSE_STORE_ADDR_MISALIGNED      = 12'd6;
    localparam logic [11:0] CAUSE_STORE_ACCESS_FAULT         = 12'd7;
    localparam logic [11:0] CAUSE_INSN_PAGE_FAULT            = 12'd12;
    localparam logic [11:0] CAUSE_LOAD_PAGE_FAULT            = 12'd13;
    localparam logic [11:0] CAUSE_STORE_PAGE_FAULT           = 12'd15;
    localparam logic [11:0] CAUSE_INSN_GUEST_PAGE_FAULT      = 12'd20;
    localparam logic [11:0] CAUSE_LOAD_GUEST_PAGE_FAULT      = 12'd21;
    localparam logic [11:0] CAUSE_STORE_GUEST_PAGE_FAULT     = 12'd23;
    localparam logic [11:0] CAUSE_ALL_INBOUND_DISALLOWED     = 12'd256;
    localparam logic [11:0] CAUSE_DDT_ENTRY_LOAD_ACCESS      = 12'd257;
    localparam logic [11:0] CAUSE_DDT_ENTRY_NOT_VALID        = 12'd258;
    localparam logic [11:0] CAUSE_DDT_ENTRY_MISCONFIGURED    = 12'd259;
    localparam logic [11:0] CAUSE_TRANSACTION_TYPE_DISALLOWED= 12'd260;
    localparam logic [11:0] CAUSE_MSI_PTE_LOAD_ACCESS        = 12'd261;
    localparam logic [11:0] CAUSE_MSI_PTE_NOT_VALID          = 12'd262;
    localparam logic [11:0] CAUSE_MSI_PTE_MISCONFIGURED      = 12'd263;
    localparam logic [11:0] CAUSE_MRIF_ACCESS_FAULT          = 12'd264;
    localparam logic [11:0] CAUSE_PDT_ENTRY_LOAD_ACCESS      = 12'd265;
    localparam logic [11:0] CAUSE_PDT_ENTRY_NOT_VALID        = 12'd266;
    localparam logic [11:0] CAUSE_PDT_ENTRY_MISCONFIGURED    = 12'd267;
    localparam logic [11:0] CAUSE_DDT_DATA_CORRUPTION        = 12'd268;
    localparam logic [11:0] CAUSE_PDT_DATA_CORRUPTION        = 12'd269;
    localparam logic [11:0] CAUSE_MSI_PT_DATA_CORRUPTION     = 12'd270;
    localparam logic [11:0] CAUSE_MSI_MRIF_DATA_CORRUPTION   = 12'd271;
    localparam logic [11:0] CAUSE_INTERNAL_DATAPATH_ERROR    = 12'd272;
    localparam logic [11:0] CAUSE_MSI_STORE_ACCESS_FAULT     = 12'd273;
    localparam logic [11:0] CAUSE_PT_DATA_CORRUPTION         = 12'd274;

    // ------------------------------------------------------------------
    // Transaction type identifiers (spec section 4.1.1).  These are the
    // TTYP values populated in fault queue records.
    // ------------------------------------------------------------------
    localparam logic [5:0] TTYP_UNTRANSLATED_READ_NO_AMO     = 6'd1;
    localparam logic [5:0] TTYP_UNTRANSLATED_WRITE_OR_AMO    = 6'd2;
    localparam logic [5:0] TTYP_UNTRANSLATED_READ_FOR_EXEC   = 6'd3;
    localparam logic [5:0] TTYP_TRANSLATED_READ_NO_AMO       = 6'd4;
    localparam logic [5:0] TTYP_TRANSLATED_WRITE_OR_AMO      = 6'd5;
    localparam logic [5:0] TTYP_TRANSLATED_READ_FOR_EXEC     = 6'd6;
    localparam logic [5:0] TTYP_PCIE_ATS_TRANSLATION_REQUEST = 6'd7;
    localparam logic [5:0] TTYP_PCIE_MESSAGE_REQUEST         = 6'd8;
    localparam logic [5:0] TTYP_PAGE_REQ_FROM_DEVICE         = 6'd9;

    // ------------------------------------------------------------------
    // PCIe ATS / page-request constants
    // ------------------------------------------------------------------
    localparam logic [3:0] PRGI_RESPONSE_SUCCESS              = 4'd0;
    localparam logic [3:0] PRGI_RESPONSE_INVALID_REQUEST      = 4'd1;
    localparam logic [3:0] PRGI_RESPONSE_RESPONSE_FAILURE     = 4'd15;

    // ------------------------------------------------------------------
    // Device-context (DC) field encodings (spec 2.1).  The base (non-MSI)
    // device context is four 64-bit doublewords:
    //   DW0 = tc   (translation control)
    //   DW1 = iohgatp (G-stage address-translation+protection)
    //   DW2 = ta   (translation attributes)
    //   DW3 = fsc  (first-stage context: iosatp when PDTV=0)
    // tc.V is bit 0 of DW0; tc.PDTV is bit 5.
    // iohgatp.MODE is bits [63:60], iohgatp.PPN is bits [43:0].
    // fsc.MODE   is bits [63:60], fsc.PPN   is bits [43:0] (iosatp form).
    // ------------------------------------------------------------------
    localparam int unsigned DC_DW_BYTES = 32;   // base-format DC size in bytes
    localparam int unsigned DDTE_BYTES  = 8;    // non-leaf DDT entry size

    // tc (DW0) bit positions
    localparam int unsigned DC_TC_V_BIT    = 0;
    localparam int unsigned DC_TC_PDTV_BIT = 5;

    // atp/hgatp common field slices (within a 64-bit doubleword)
    localparam int unsigned ATP_PPN_LSB  = 0;
    localparam int unsigned ATP_PPN_MSB  = 43;
    localparam int unsigned ATP_MODE_LSB = 60;
    localparam int unsigned ATP_MODE_MSB = 63;

    // Non-leaf DDT entry: bit 0 = V, PPN in [53:10] (PpnW=44)
    localparam int unsigned DDTE_V_BIT   = 0;
    localparam int unsigned DDTE_PPN_LSB = 10;
    localparam int unsigned DDTE_PPN_MSB = 53;

    // ------------------------------------------------------------------
    // Sv* page-table-entry bit positions (RISC-V privileged spec).  Used
    // for both first-stage and G-stage PTEs.
    // ------------------------------------------------------------------
    localparam int unsigned PTE_V_BIT   = 0;
    localparam int unsigned PTE_R_BIT   = 1;
    localparam int unsigned PTE_W_BIT   = 2;
    localparam int unsigned PTE_X_BIT   = 3;
    localparam int unsigned PTE_U_BIT   = 4;
    localparam int unsigned PTE_G_BIT   = 5;
    localparam int unsigned PTE_A_BIT   = 6;
    localparam int unsigned PTE_D_BIT   = 7;
    localparam int unsigned PTE_PPN_LSB = 10;
    localparam int unsigned PTE_PPN_MSB = 53;

    // Number of page-table levels per mode (Sv39 = 3, Sv48 = 4).
    localparam int unsigned SV39_LEVELS = 3;
    localparam int unsigned SV48_LEVELS = 4;

    // ------------------------------------------------------------------
    // Fault queue record layout (4x64-bit words = 32 bytes per spec 3.5.1)
    // ------------------------------------------------------------------
    typedef struct packed {
        logic [11:0] cause;
        logic [5:0]  ttyp;
        logic        priv;
        logic        rsvd_pid;
        logic [19:0] pid;
        logic [23:0] did;
        logic        custom;
        logic [3:0]  iotval_present;
        logic [63:0] iotval;
        logic [63:0] iotval2;
    } fault_record_t;

endpackage
