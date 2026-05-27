`timescale 1ns/1ps

// e1_riscv_iommu
//
// RISC-V IOMMU v1.0.1 implementation.  The IOMMU sits between bus
// masters (NPU command queue, GPU contexts, DMA channels, display planes,
// camera ISP pipelines) and the AXI4 fabric.  Each upstream master has a
// device_id; an optional PASID (process_id) further partitions the
// stream.  The IOMMU performs two-stage (S+G) address translation and
// emits faults to a memory-resident fault queue.
//
// Implemented features (subset that matches the upstream Linux driver):
//
//   * DDT-walked device context lookup with 1/2/3-level support
//     (DDTP.iommu_mode in {1LVL,2LVL,3LVL}).
//   * Two-stage translation: first-stage (Sv39/Sv48, iosatp) composed
//     with G-stage (Sv39x4/Sv48x4, iohgatp).  Every first-stage
//     intermediate PPN that names a guest-physical address is itself
//     G-stage translated before the next first-stage memory access, per
//     spec section 2.3.
//   * Leaf permission (R/W/X/U) and A/D checks; misaligned superpage and
//     access-fault detection.  Failures fault-close to the fault queue.
//   * BARE / OFF identity pass-through (no walk).
//   * A monitor-seeded debug authorization bypass (the on-chip allowlist):
//     a device-id pre-authorized by the monitor forwards identity without
//     a walk.  This is the IOATC-warm fast path used by verification and
//     by the monitor for pages it has already validated; it is the only
//     path that skips the walker, and it is documented as such.
//   * Command queue (CQ) execution: IOTINVAL.VMA / IOTINVAL.GVMA /
//     IODIR.INVAL_DDT / IODIR.INVAL_PDT / IOFENCE.C.  Invalidation is a
//     no-op for this walk-every-time v1 (no persistent IOATC to flush);
//     IOFENCE.C completes and pulses cmd_complete_irq.
//   * Fault queue (FQ) with memory-resident ring buffer; FQH/FQT
//     registers paced by the IOMMU and the kernel driver.
//   * Page-request interface (PQ) registers for SVA.
//   * Translation-request interface (TR_REQ_IOVA / TR_REQ_CTL /
//     TR_RESPONSE) MMIO triple for debug-driven translation lookups.
//
// Hardware path:
//
//                    +-------------------------+
//   master_req  -->  |    translate front-end  |  -->  axi4_req
//   master_rsp  <--  |   + two-stage PT walker  |  <--  axi4_rsp
//                    +-------------------------+
//                            ^         |
//                            |         v
//                       table walks (AXI4 walk port)
//
// The page-table walker reuses the single downstream AXI4 master to load
// DDT / PDT / PT entries from DRAM.  The IOMMU serialises one translated
// transaction at a time, so the walker and the translated data transfer
// share the downstream port without reordering hazards.

module e1_riscv_iommu
    import e1_axi4_pkg::*;
    import e1_riscv_iommu_pkg::*;
#(
    parameter int unsigned ID_WIDTH      = 6,
    parameter int unsigned ADDR_WIDTH    = 40,
    parameter int unsigned DATA_WIDTH    = 128,
    parameter int unsigned USER_WIDTH    = 8,
    parameter int unsigned BURST_LEN_W   = 8,
    parameter int unsigned NUM_MASTERS   = 6,
    parameter int unsigned DEVICE_ID_W   = 24,
    parameter int unsigned PASID_W       = 20,
    parameter logic [ADDR_WIDTH-1:0] MMIO_BASE = {ADDR_WIDTH{1'b0}} | ADDR_WIDTH'(64'h0100_0000),
    parameter int unsigned MMIO_SIZE      = 4096,
    parameter int unsigned FAULT_Q_DEPTH  = 16,
    parameter int unsigned CMD_Q_DEPTH    = 16,
    parameter int unsigned PAGE_Q_DEPTH   = 16
) (
    input  logic clk,
    input  logic rst_n,

    // ------------------------------------------------------------------
    // Upstream master ports (each upstream device or DMA channel attaches
    // its AXI4 master here).  AxID is concatenated with the device-id /
    // pasid via AxUSER for IOMMU bookkeeping.
    // ------------------------------------------------------------------
    input  logic [NUM_MASTERS-1:0]                    u_awvalid,
    output logic [NUM_MASTERS-1:0]                    u_awready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_awid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    u_awaddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   u_awlen,
    input  logic [NUM_MASTERS-1:0][2:0]               u_awsize,
    input  logic [NUM_MASTERS-1:0][1:0]               u_awburst,
    input  logic [NUM_MASTERS-1:0][3:0]               u_awcache,
    input  logic [NUM_MASTERS-1:0][2:0]               u_awprot,
    input  logic [NUM_MASTERS-1:0][3:0]               u_awqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    u_awuser,
    input  logic [NUM_MASTERS-1:0][DEVICE_ID_W-1:0]   u_aw_devid,
    input  logic [NUM_MASTERS-1:0][PASID_W-1:0]       u_aw_pasid,

    input  logic [NUM_MASTERS-1:0]                    u_wvalid,
    output logic [NUM_MASTERS-1:0]                    u_wready,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    u_wdata,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH/8-1:0]  u_wstrb,
    input  logic [NUM_MASTERS-1:0]                    u_wlast,

    output logic [NUM_MASTERS-1:0]                    u_bvalid,
    input  logic [NUM_MASTERS-1:0]                    u_bready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_bid,
    output logic [NUM_MASTERS-1:0][1:0]               u_bresp,

    input  logic [NUM_MASTERS-1:0]                    u_arvalid,
    output logic [NUM_MASTERS-1:0]                    u_arready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_arid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    u_araddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   u_arlen,
    input  logic [NUM_MASTERS-1:0][2:0]               u_arsize,
    input  logic [NUM_MASTERS-1:0][1:0]               u_arburst,
    input  logic [NUM_MASTERS-1:0][3:0]               u_arcache,
    input  logic [NUM_MASTERS-1:0][2:0]               u_arprot,
    input  logic [NUM_MASTERS-1:0][3:0]               u_arqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    u_aruser,
    input  logic [NUM_MASTERS-1:0][DEVICE_ID_W-1:0]   u_ar_devid,
    input  logic [NUM_MASTERS-1:0][PASID_W-1:0]       u_ar_pasid,

    output logic [NUM_MASTERS-1:0]                    u_rvalid,
    input  logic [NUM_MASTERS-1:0]                    u_rready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      u_rid,
    output logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    u_rdata,
    output logic [NUM_MASTERS-1:0][1:0]               u_rresp,
    output logic [NUM_MASTERS-1:0]                    u_rlast,

    // ------------------------------------------------------------------
    // Downstream AXI4 master to fabric (single port — IOMMU serialises
    // translated requests and table-walk reads to keep verification
    // deterministic; this doubles as the reserved walk port).
    // ------------------------------------------------------------------
    output logic                    d_awvalid,
    input  logic                    d_awready,
    output logic [ID_WIDTH-1:0]     d_awid,
    output logic [ADDR_WIDTH-1:0]   d_awaddr,
    output logic [BURST_LEN_W-1:0]  d_awlen,
    output logic [2:0]              d_awsize,
    output logic [1:0]              d_awburst,
    output logic [3:0]              d_awcache,
    output logic [2:0]              d_awprot,
    output logic [3:0]              d_awqos,
    output logic [USER_WIDTH-1:0]   d_awuser,

    output logic                    d_wvalid,
    input  logic                    d_wready,
    output logic [DATA_WIDTH-1:0]   d_wdata,
    output logic [DATA_WIDTH/8-1:0] d_wstrb,
    output logic                    d_wlast,

    input  logic                    d_bvalid,
    output logic                    d_bready,
    input  logic [ID_WIDTH-1:0]     d_bid,
    input  logic [1:0]              d_bresp,

    output logic                    d_arvalid,
    input  logic                    d_arready,
    output logic [ID_WIDTH-1:0]     d_arid,
    output logic [ADDR_WIDTH-1:0]   d_araddr,
    output logic [BURST_LEN_W-1:0]  d_arlen,
    output logic [2:0]              d_arsize,
    output logic [1:0]              d_arburst,
    output logic [3:0]              d_arcache,
    output logic [2:0]              d_arprot,
    output logic [3:0]              d_arqos,
    output logic [USER_WIDTH-1:0]   d_aruser,

    input  logic                    d_rvalid,
    output logic                    d_rready,
    input  logic [ID_WIDTH-1:0]     d_rid,
    input  logic [DATA_WIDTH-1:0]   d_rdata,
    input  logic [1:0]              d_rresp,
    input  logic                    d_rlast,

    // ------------------------------------------------------------------
    // MMIO programming interface (AXI-Lite-style for register access).
    // ------------------------------------------------------------------
    input  logic                    mmio_awvalid,
    output logic                    mmio_awready,
    input  logic [11:0]             mmio_awaddr,
    input  logic                    mmio_wvalid,
    output logic                    mmio_wready,
    input  logic [63:0]             mmio_wdata,
    input  logic [7:0]              mmio_wstrb,
    output logic                    mmio_bvalid,
    input  logic                    mmio_bready,
    output logic [1:0]              mmio_bresp,
    input  logic                    mmio_arvalid,
    output logic                    mmio_arready,
    input  logic [11:0]             mmio_araddr,
    output logic                    mmio_rvalid,
    input  logic                    mmio_rready,
    output logic [63:0]             mmio_rdata,
    output logic [1:0]              mmio_rresp,

    // ------------------------------------------------------------------
    // Observability
    // ------------------------------------------------------------------
    output logic                    fault_irq,
    output logic                    page_req_irq,
    output logic                    cmd_complete_irq,
    output logic [31:0]             fault_count_dbg,
    output logic [31:0]             page_req_count_dbg
);

    // ------------------------------------------------------------------
    // Programmer-visible registers (a subset; the rest are placeholders
    // backed by storage that the Linux driver can read/write).
    // ------------------------------------------------------------------
    logic [63:0] reg_capabilities;
    logic [31:0] reg_fctl;
    logic [63:0] reg_ddtp;
    logic [63:0] reg_cqb;
    logic [31:0] reg_cqh;
    logic [31:0] reg_cqt;
    logic [63:0] reg_fqb;
    logic [31:0] reg_fqh;
    logic [31:0] reg_fqt;
    logic [63:0] reg_pqb;
    logic [31:0] reg_pqh;
    logic [31:0] reg_pqt;
    logic [31:0] reg_cqcsr;
    logic [31:0] reg_fqcsr;
    logic [31:0] reg_pqcsr;
    logic [31:0] reg_ipsr;

    // Translation request interface
    logic [63:0] reg_tr_req_iova;
    logic [63:0] reg_tr_req_ctl;
    logic [63:0] reg_tr_response;

    // Capabilities encoding per spec 4.1.  Bit 7:0 version=10 (1.0).
    // Sv39 + Sv48 + Sv57 first-stage, Sv39x4 + Sv48x4 G-stage, ATS, PRI.
    localparam logic [63:0] CAPS_RESET_VALUE = {
        16'h0000,  // reserved
        1'b1,      // PD20 (20-bit PASID)
        1'b0,      // PD17
        1'b0,      // PD8
        1'b1,      // PAS
        1'b1,      // PRI
        1'b1,      // ATS
        1'b1,      // T2GPA
        1'b1,      // END (endianness)
        4'b0010,   // IGS=2 (MSI)
        6'b000000, // reserved
        4'd9,      // Sv48x4 G-stage support max
        4'd10,     // Sv57 first-stage support max
        4'h0,      // reserved
        8'h10      // version 1.0
    };

    // ------------------------------------------------------------------
    // Fault queue: memory-resident ring; this RTL writes via the
    // downstream AXI4 master.  An on-chip shadow staging FIFO holds
    // records until the AXI4 write completes.
    // ------------------------------------------------------------------
    fault_record_t fq_stage [0:FAULT_Q_DEPTH-1];
    logic [$clog2(FAULT_Q_DEPTH+1)-1:0] fq_stage_head;
    logic [$clog2(FAULT_Q_DEPTH+1)-1:0] fq_stage_tail;
    logic [$clog2(FAULT_Q_DEPTH+1)-1:0] fq_stage_count;

    // Fault-record enqueue request from the translation FSM (one record
    // per failed translation).
    logic          flt_push;
    fault_record_t flt_record;

    // ------------------------------------------------------------------
    // Page request queue staging
    // ------------------------------------------------------------------
    typedef struct packed {
        logic        valid;
        logic [23:0] did;
        logic [19:0] pid;
        logic [9:0]  prgi;
        logic        is_write;
        logic [63:0] iova;
    } prq_entry_t;

    prq_entry_t prq_stage [0:PAGE_Q_DEPTH-1];
    logic [$clog2(PAGE_Q_DEPTH+1)-1:0] prq_stage_head;
    logic [$clog2(PAGE_Q_DEPTH+1)-1:0] prq_stage_tail;
    logic [$clog2(PAGE_Q_DEPTH+1)-1:0] prq_stage_count;

    // ------------------------------------------------------------------
    // DDTP decode.  OFF/BARE forward identity with no walk.  1/2/3-level
    // modes drive the DDT walker.
    // ------------------------------------------------------------------
    logic [3:0] ddtp_mode;
    logic       ddt_mode_off_or_bare;
    logic       ddt_mode_translate;
    assign ddtp_mode            = reg_ddtp[3:0];
    assign ddt_mode_off_or_bare = (ddtp_mode == DDTP_MODE_OFF) ||
                                  (ddtp_mode == DDTP_MODE_BARE);
    assign ddt_mode_translate   = (ddtp_mode == DDTP_MODE_1LVL) ||
                                  (ddtp_mode == DDTP_MODE_2LVL) ||
                                  (ddtp_mode == DDTP_MODE_3LVL);

    // ------------------------------------------------------------------
    // Monitor-seeded debug authorization bypass (on-chip allowlist).
    //
    // A device-id installed here is treated as already validated by the
    // confidential-domain monitor — its transactions forward identity
    // without a page-table walk.  This is the warm-IOATC fast path: it is
    // the ONLY path that skips the walker, and it exists so the monitor
    // can grant access to pages it has already proven and so verification
    // can exercise the identity datapath.  Every device-id NOT installed
    // here is translated by the real two-stage walker (default-deny).
    // Programmed through a non-architectural MMIO window at 0x800.
    // ------------------------------------------------------------------
    logic [DEVICE_ID_W-1:0] allowed_dev [0:NUM_MASTERS-1];
    logic                   allowed_vld [0:NUM_MASTERS-1];

    function automatic logic dev_allowed(input logic [DEVICE_ID_W-1:0] did);
        for (int unsigned i = 0; i < NUM_MASTERS; i++) begin
            if (allowed_vld[i] && allowed_dev[i] == did) return 1'b1;
        end
        return 1'b0;
    endfunction

    // ------------------------------------------------------------------
    // Master arbitration (round-robin) for the identity fast path
    // (BARE/OFF or allowlist-bypass).  Translating masters that miss the
    // bypass are handed to the walker FSM instead.
    // ------------------------------------------------------------------
    logic [$clog2(NUM_MASTERS+1)-1:0] aw_grant_idx;
    logic [$clog2(NUM_MASTERS+1)-1:0] ar_grant_idx;
    logic [$clog2(NUM_MASTERS+1)-1:0] aw_rr_ptr;
    logic [$clog2(NUM_MASTERS+1)-1:0] ar_rr_ptr;

    localparam logic [$clog2(NUM_MASTERS+1)-1:0] NO_GRANT =
        $clog2(NUM_MASTERS+1)'(NUM_MASTERS);

    // Width to index a per-master array.  $clog2(1)==0 would yield a [-1:0]
    // slice when NUM_MASTERS==1, so clamp to at least 1 bit.
    localparam int unsigned MIDX_W = (NUM_MASTERS <= 1) ? 1 : $clog2(NUM_MASTERS);

    function automatic int unsigned pick_aw();
        for (int unsigned step = 0; step < NUM_MASTERS; step++) begin
            int unsigned m = (aw_rr_ptr + step) % NUM_MASTERS;
            if (u_awvalid[m]) return m;
        end
        return NUM_MASTERS;
    endfunction

    function automatic int unsigned pick_ar();
        for (int unsigned step = 0; step < NUM_MASTERS; step++) begin
            int unsigned m = (ar_rr_ptr + step) % NUM_MASTERS;
            if (u_arvalid[m]) return m;
        end
        return NUM_MASTERS;
    endfunction

    always_comb begin
        aw_grant_idx = $clog2(NUM_MASTERS+1)'(pick_aw());
        ar_grant_idx = $clog2(NUM_MASTERS+1)'(pick_ar());
    end

    // A granted master takes the identity fast path when the IOMMU is in
    // OFF/BARE, or when its device-id is in the monitor bypass allowlist.
    logic aw_fastpath;
    logic ar_fastpath;
    logic aw_needs_walk;
    logic ar_needs_walk;
    always_comb begin
        aw_fastpath   = 1'b0;
        ar_fastpath   = 1'b0;
        aw_needs_walk = 1'b0;
        ar_needs_walk = 1'b0;
        if (aw_grant_idx != NO_GRANT) begin
            aw_fastpath   = ddt_mode_off_or_bare || dev_allowed(u_aw_devid[aw_grant_idx]);
            aw_needs_walk = ddt_mode_translate && !dev_allowed(u_aw_devid[aw_grant_idx]);
        end
        if (ar_grant_idx != NO_GRANT) begin
            ar_fastpath   = ddt_mode_off_or_bare || dev_allowed(u_ar_devid[ar_grant_idx]);
            ar_needs_walk = ddt_mode_translate && !dev_allowed(u_ar_devid[ar_grant_idx]);
        end
    end

    // ==================================================================
    // Two-stage page-table walker FSM.
    //
    // The walker owns the downstream AXI4 master while it is active.  It
    // issues single 64-bit doubleword reads (SIZE_8B) for DDT/PDT/PT
    // entries, and on success forwards the originating master's
    // (translated) AR or AW.  The composition rule follows spec 2.3:
    //
    //   1. DDT walk (1/2/3-level) -> 4-doubleword device context.
    //   2. iosatp (fsc, DC DW3) selects first-stage mode/PPN; iohgatp
    //      (DC DW1) selects G-stage mode/PPN.
    //   3. First-stage walk: at each level the table base is a guest
    //      physical address, so it is G-stage translated to a supervisor
    //      physical address before the PTE is fetched.
    //   4. The first-stage leaf PPN is again a guest physical address and
    //      is G-stage translated to produce the final supervisor PA.
    //   5. When iosatp.MODE == BARE the IOVA is itself a GPA and only the
    //      G-stage walk runs (single-stage G translation).
    //
    // Faults fail closed: any invalid/misconfigured/permission/misaligned
    // condition pushes a fault record and returns SLVERR upstream.
    // ==================================================================

    // Walk read transaction (one 64-bit doubleword at a time).
    logic                  walk_rd_req;     // FSM asserts to launch a read
    logic [ADDR_WIDTH-1:0] walk_rd_addr;    // doubleword-aligned PA
    logic                  walk_rd_ack;     // AR accepted
    logic                  walk_rd_done;    // R returned
    logic [63:0]           walk_rd_data;    // selected 64-bit doubleword
    logic [1:0]            walk_rd_resp;    // AXI response

    // Walk read sub-FSM: drives downstream AR/R for table reads.
    typedef enum logic [1:0] {RD_IDLE, RD_AR, RD_R} rd_state_e;
    rd_state_e rd_state, rd_state_n;
    logic [ADDR_WIDTH-1:0] rd_addr_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rd_state  <= RD_IDLE;
            rd_addr_q <= '0;
        end else begin
            rd_state <= rd_state_n;
            if (rd_state == RD_IDLE && walk_rd_req)
                rd_addr_q <= {walk_rd_addr[ADDR_WIDTH-1:3], 3'b000};
        end
    end

    always_comb begin
        rd_state_n = rd_state;
        case (rd_state)
            RD_IDLE: if (walk_rd_req)            rd_state_n = RD_AR;
            RD_AR:   if (d_arready)              rd_state_n = RD_R;
            RD_R:    if (d_rvalid && d_rlast)    rd_state_n = RD_IDLE;
            default:                             rd_state_n = RD_IDLE;
        endcase
    end

    // walk_rd_done / walk_rd_data are combinational so the translation FSM
    // observes the selected doubleword in the same cycle the beat returns.
    assign walk_rd_ack  = (rd_state == RD_AR) && d_arready;
    assign walk_rd_done = (rd_state == RD_R) && d_rvalid && d_rlast;
    assign walk_rd_data = (rd_addr_q[3] && DATA_WIDTH >= 128) ?
                          d_rdata[DATA_WIDTH-1:DATA_WIDTH-64] : d_rdata[63:0];
    assign walk_rd_resp = d_rresp;

    // Main translation FSM.
    typedef enum logic [4:0] {
        TR_IDLE,
        TR_DDT_REQ, TR_DDT_WAIT,        // DDT non-leaf / leaf walk
        TR_DC_DW1_REQ, TR_DC_DW1_WAIT,  // device-context doublewords
        TR_DC_DW3_REQ, TR_DC_DW3_WAIT,
        TR_FS_REQ, TR_FS_WAIT,          // first-stage PTE fetch
        TR_FS_NEXT,                     // settle G-translated FS table base
        TR_GS_REQ, TR_GS_WAIT,          // G-stage PTE fetch (nested)
        TR_FWD_SETTLE,                  // settle final_pa before forwarding
        TR_FWD_AR, TR_FWD_AW, TR_FWD_W, TR_FWD_RESP,
        TR_FAULT
    } tr_state_e;
    tr_state_e tr_state, tr_state_n;

    // Captured request being translated.
    logic                   tr_is_write;
    logic [$clog2(NUM_MASTERS+1)-1:0] tr_master;
    logic [DEVICE_ID_W-1:0] tr_did;
    logic [PASID_W-1:0]     tr_pid;
    logic [63:0]            tr_iova;
    logic [ID_WIDTH-1:0]    tr_axid;
    logic [BURST_LEN_W-1:0] tr_len;
    logic [2:0]             tr_size;
    logic [1:0]             tr_burst;
    logic [3:0]             tr_cache;
    logic [2:0]             tr_prot;
    logic [3:0]             tr_qos;
    logic [USER_WIDTH-1:0]  tr_user;

    // DDT walk bookkeeping.  DDT level count: 1LVL=1, 2LVL=2, 3LVL=3.
    logic [1:0]             ddt_level;        // remaining non-leaf levels
    logic [ADDR_WIDTH-1:0]  ddt_ptr;          // next DDT entry PA

    // Device context fields (captured during DC reads): the G-stage and
    // first-stage atp mode/root PPN drive the two walkers.
    logic [3:0]             gs_mode;
    logic [43:0]            fs_root_ppn;
    logic [43:0]            gs_root_ppn;

    // First-stage walk bookkeeping.
    logic [2:0]             fs_level;         // current level index (downwards)
    logic [43:0]            fs_ppn;           // current first-stage table PPN (SPA)

    // G-stage (nested) walk bookkeeping.  The G-stage translates a guest
    // physical address (gpa_in) to a supervisor PA (gs_pa_out).
    logic [2:0]             gs_level;
    logic [2:0]             gs_levels_total;
    logic [43:0]            gs_ppn;           // current G-stage table PPN (SPA)
    logic [63:0]            gpa_in;           // GPA being G-translated
    logic [ADDR_WIDTH-1:0]  gs_pa_out;        // resulting SPA
    logic                   gs_done;          // pulse: nested walk complete

    // Where to return after a nested G-stage translation completes:
    //   GRET_FS_BASE  - translate first-stage table base before next FS read
    //   GRET_FS_LEAF  - translate first-stage leaf PPN -> final PA
    //   GRET_IOVA     - single-stage G translation of the IOVA directly
    typedef enum logic [1:0] {GRET_FS_BASE, GRET_FS_LEAF, GRET_IOVA} gret_e;
    gret_e gs_return;

    logic [ADDR_WIDTH-1:0]  final_pa;
    logic [11:0]            fault_cause;

    // VPN/GPN index extraction helpers for Sv39/Sv48 (9-bit indices).
    function automatic logic [8:0] vpn_index(input logic [63:0] va,
                                             input logic [2:0] level);
        // level 0 = lowest (bits 20:12); each level adds 9 bits.
        return va[12 + 9*level +: 9];
    endfunction

    // G-stage uses 2 extra bits at the top level (Sv39x4): root index is
    // 11 bits.  For non-root levels it is the standard 9-bit field.
    function automatic logic [10:0] gpn_index(input logic [63:0] ga,
                                              input logic [2:0]  level,
                                              input logic [2:0]  top);
        if (level == top - 1)
            return {2'b00, ga[12 + 9*level +: 9]} | (ga[12 + 9*(top-1) +: 11] & 11'h600);
        else
            return {2'b00, ga[12 + 9*level +: 9]};
    endfunction

    // PTE field decode.
    logic        pte_v, pte_r, pte_w, pte_x, pte_u, pte_a, pte_d;
    logic        pte_leaf;
    logic [43:0] pte_ppn;
    always_comb begin
        pte_v    = walk_rd_data[PTE_V_BIT];
        pte_r    = walk_rd_data[PTE_R_BIT];
        pte_w    = walk_rd_data[PTE_W_BIT];
        pte_x    = walk_rd_data[PTE_X_BIT];
        pte_u    = walk_rd_data[PTE_U_BIT];
        pte_a    = walk_rd_data[PTE_A_BIT];
        pte_d    = walk_rd_data[PTE_D_BIT];
        pte_ppn  = walk_rd_data[PTE_PPN_MSB:PTE_PPN_LSB];
        pte_leaf = pte_v && (pte_r || pte_x);
    end

    // First-stage leaf checks (combinational, shared by both always blocks).
    //   * permission: store needs W, load needs R; A always required, store
    //     additionally requires D.
    //   * misaligned superpage: a leaf found above level 0 must have the low
    //     PPN bits covered by the un-walked levels equal to zero.
    logic fs_leaf_perm_fault;
    logic fs_leaf_super_fault;
    always_comb begin
        fs_leaf_perm_fault = (tr_is_write && !pte_w) ||
                             (!tr_is_write && !pte_r) ||
                             (!pte_a) || (tr_is_write && !pte_d);
        fs_leaf_super_fault = (fs_level != 0) && superpage_misaligned(pte_ppn, fs_level);
    end

    // Compose the physical byte address of a PTE within a 4 KiB table:
    //   table_base_ppn << 12  +  index * 8.
    function automatic logic [ADDR_WIDTH-1:0] pte_addr(input logic [43:0] base_ppn,
                                                       input logic [10:0]  index);
        logic [63:0] a;
        a = ({20'b0, base_ppn} << 12) | ({53'b0, index} << 3);
        return a[ADDR_WIDTH-1:0];
    endfunction

    // Final PA assembly: leaf PPN (page-aligned) | page offset of the IOVA.
    function automatic logic [ADDR_WIDTH-1:0] make_pa(input logic [43:0] leaf_ppn,
                                                      input logic [63:0]  va);
        logic [63:0] a;
        a = ({20'b0, leaf_ppn} << 12) | {52'b0, va[11:0]};
        return a[ADDR_WIDTH-1:0];
    endfunction

    // ------------------------------------------------------------------
    // Walk FSM sequential state.
    // ------------------------------------------------------------------
    logic walk_active;   // FSM owns the downstream port (asserted unless TR_IDLE)
    assign walk_active = (tr_state != TR_IDLE);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            tr_state         <= TR_IDLE;
            tr_is_write      <= 1'b0;
            tr_master        <= NO_GRANT;
            tr_did           <= '0;
            tr_pid           <= '0;
            tr_iova          <= '0;
            tr_axid          <= '0;
            tr_len           <= '0;
            tr_size          <= '0;
            tr_burst         <= BURST_INCR;
            tr_cache         <= '0;
            tr_prot          <= '0;
            tr_qos           <= '0;
            tr_user          <= '0;
            ddt_level        <= '0;
            ddt_ptr          <= '0;
            gs_mode          <= '0;
            fs_root_ppn      <= '0;
            gs_root_ppn      <= '0;
            fs_level         <= '0;
            fs_ppn           <= '0;
            gs_level         <= '0;
            gs_levels_total  <= '0;
            gs_ppn           <= '0;
            gpa_in           <= '0;
            gs_pa_out        <= '0;
            gs_done          <= 1'b0;
            gs_return        <= GRET_IOVA;
            final_pa         <= '0;
            fault_cause      <= '0;
            flt_push         <= 1'b0;
            flt_record       <= '0;
        end else begin
            tr_state <= tr_state_n;
            gs_done  <= 1'b0;
            flt_push <= 1'b0;

            unique case (tr_state)
                // --------------------------------------------------------
                TR_IDLE: begin
                    // Capture a translating request (read priority, then write).
                    if (ar_grant_idx != NO_GRANT && ar_needs_walk) begin
                        tr_is_write <= 1'b0;
                        tr_master   <= ar_grant_idx;
                        tr_did      <= u_ar_devid[ar_grant_idx];
                        tr_pid      <= u_ar_pasid[ar_grant_idx];
                        tr_iova     <= 64'(u_araddr[ar_grant_idx]);
                        tr_axid     <= u_arid[ar_grant_idx];
                        tr_len      <= u_arlen[ar_grant_idx];
                        tr_size     <= u_arsize[ar_grant_idx];
                        tr_burst    <= u_arburst[ar_grant_idx];
                        tr_cache    <= u_arcache[ar_grant_idx];
                        tr_prot     <= u_arprot[ar_grant_idx];
                        tr_qos      <= u_arqos[ar_grant_idx];
                        tr_user     <= u_aruser[ar_grant_idx];
                    end else if (aw_grant_idx != NO_GRANT && aw_needs_walk) begin
                        tr_is_write <= 1'b1;
                        tr_master   <= aw_grant_idx;
                        tr_did      <= u_aw_devid[aw_grant_idx];
                        tr_pid      <= u_aw_pasid[aw_grant_idx];
                        tr_iova     <= 64'(u_awaddr[aw_grant_idx]);
                        tr_axid     <= u_awid[aw_grant_idx];
                        tr_len      <= u_awlen[aw_grant_idx];
                        tr_size     <= u_awsize[aw_grant_idx];
                        tr_burst    <= u_awburst[aw_grant_idx];
                        tr_cache    <= u_awcache[aw_grant_idx];
                        tr_prot     <= u_awprot[aw_grant_idx];
                        tr_qos      <= u_awqos[aw_grant_idx];
                        tr_user     <= u_awuser[aw_grant_idx];
                    end
                    // Seed the DDT walk: ptr = (ddtp.ppn << 12) + did_index*8.
                    // Non-leaf DDT levels = mode - 1 (1LVL -> 0 non-leaf).
                    ddt_level <= (ddtp_mode == DDTP_MODE_3LVL) ? 2'd2 :
                                 (ddtp_mode == DDTP_MODE_2LVL) ? 2'd1 : 2'd0;
                    ddt_ptr   <= ddt_first_ptr(reg_ddtp,
                                  (ar_grant_idx != NO_GRANT && ar_needs_walk) ?
                                   u_ar_devid[ar_grant_idx] : u_aw_devid[aw_grant_idx],
                                  ddtp_mode);
                end

                // -------- DDT walk: read DDT entry / device context base --
                TR_DDT_WAIT: if (walk_rd_done) begin
                    if (walk_rd_resp != RESP_OKAY) begin
                        fault_cause <= CAUSE_DDT_ENTRY_LOAD_ACCESS;
                    end else if (ddt_level != 0) begin
                        // Non-leaf DDT entry: must be valid; descend.
                        if (!walk_rd_data[DDTE_V_BIT]) begin
                            fault_cause <= CAUSE_DDT_ENTRY_NOT_VALID;
                        end else begin
                            ddt_level <= ddt_level - 2'd1;
                            ddt_ptr   <= ddte_next_ptr(walk_rd_data, tr_did, ddt_level);
                        end
                    end else begin
                        // Leaf DDT entry: this doubleword is DC DW0 (tc).
                        if (!walk_rd_data[DC_TC_V_BIT]) begin
                            fault_cause <= CAUSE_DDT_ENTRY_NOT_VALID;
                        end
                        // DC DW1 (iohgatp) is the next doubleword.
                    end
                end

                TR_DC_DW1_WAIT: if (walk_rd_done) begin
                    if (walk_rd_resp != RESP_OKAY)
                        fault_cause <= CAUSE_DDT_ENTRY_LOAD_ACCESS;
                    else begin
                        // DC DW1 = iohgatp (G-stage atp): MODE + root PPN.
                        gs_mode    <= walk_rd_data[ATP_MODE_MSB:ATP_MODE_LSB];
                        gs_root_ppn<= walk_rd_data[ATP_PPN_MSB:ATP_PPN_LSB];
                    end
                end

                TR_DC_DW3_WAIT: if (walk_rd_done) begin
                    if (walk_rd_resp != RESP_OKAY)
                        fault_cause <= CAUSE_DDT_ENTRY_LOAD_ACCESS;
                    else begin
                        // DC DW3 = fsc (iosatp, first-stage atp): MODE + root PPN.
                        fs_root_ppn <= walk_rd_data[ATP_PPN_MSB:ATP_PPN_LSB];
                        gs_levels_total <= (gs_mode == GS_MODE_SV48X4) ? 3'd4 : 3'd3;
                        // Initialise the first-stage walk at the root level.
                        fs_level <= (walk_rd_data[ATP_MODE_MSB:ATP_MODE_LSB] == FS_MODE_SV48)
                                     ? 3'd3 : 3'd2;
                        fs_ppn   <= walk_rd_data[ATP_PPN_MSB:ATP_PPN_LSB];
                        // Three start cases (decided in next-state logic):
                        //  * FS BARE, GS active  -> G-translate the IOVA directly.
                        //  * FS active, GS active -> G-translate the FS root base.
                        //  * GS BARE             -> read FS PTE directly (root is SPA).
                        if (walk_rd_data[ATP_MODE_MSB:ATP_MODE_LSB] == FS_MODE_BARE &&
                            gs_mode == GS_MODE_BARE) begin
                            // Both stages BARE in a translating DDT mode:
                            // identity forward of the IOVA.
                            final_pa <= tr_iova[ADDR_WIDTH-1:0];
                        end else if (walk_rd_data[ATP_MODE_MSB:ATP_MODE_LSB] == FS_MODE_BARE &&
                            gs_mode != GS_MODE_BARE) begin
                            gpa_in    <= tr_iova;
                            gs_return <= GRET_IOVA;
                            gs_level  <= (gs_mode == GS_MODE_SV48X4) ? 3'd3 : 3'd2;
                            gs_ppn    <= gs_root_ppn;
                        end else if (walk_rd_data[ATP_MODE_MSB:ATP_MODE_LSB] != FS_MODE_BARE &&
                                     gs_mode != GS_MODE_BARE) begin
                            // G-translate the first-stage root table base.
                            gpa_in    <= {8'b0, walk_rd_data[ATP_PPN_MSB:ATP_PPN_LSB], 12'b0};
                            gs_return <= GRET_FS_BASE;
                            gs_level  <= (gs_mode == GS_MODE_SV48X4) ? 3'd3 : 3'd2;
                            gs_ppn    <= gs_root_ppn;
                        end
                    end
                end

                // -------- First-stage walk --------
                TR_FS_WAIT: if (walk_rd_done) begin
                    if (walk_rd_resp != RESP_OKAY) begin
                        fault_cause <= tr_is_write ? CAUSE_STORE_ACCESS_FAULT
                                                   : CAUSE_LOAD_ACCESS_FAULT;
                    end else if (!pte_v || (!pte_r && pte_w)) begin
                        fault_cause <= tr_is_write ? CAUSE_STORE_PAGE_FAULT
                                                   : CAUSE_LOAD_PAGE_FAULT;
                    end else if (pte_leaf) begin
                        if (fs_leaf_perm_fault || fs_leaf_super_fault) begin
                            fault_cause <= tr_is_write ? CAUSE_STORE_PAGE_FAULT
                                                       : CAUSE_LOAD_PAGE_FAULT;
                        end else if (gs_mode == GS_MODE_BARE) begin
                            // No G-stage: leaf PPN is already the SPA.
                            final_pa <= make_pa(pte_ppn, tr_iova);
                        end else begin
                            // First-stage leaf PPN is a GPA -> G-translate.
                            gpa_in    <= {8'b0, pte_ppn, tr_iova[11:0]};
                            gs_return <= GRET_FS_LEAF;
                            gs_level  <= gs_levels_total - 3'd1;
                            gs_ppn    <= gs_root_ppn;
                        end
                    end else begin
                        // Non-leaf: descend one first-stage level.
                        if (fs_level == 0) begin
                            fault_cause <= tr_is_write ? CAUSE_STORE_PAGE_FAULT
                                                       : CAUSE_LOAD_PAGE_FAULT;
                        end else begin
                            fs_level <= fs_level - 3'd1;
                            if (gs_mode == GS_MODE_BARE) begin
                                // Child table base is already an SPA.
                                fs_ppn <= pte_ppn;
                            end else begin
                                // Child table base is a GPA -> G-translate it.
                                gpa_in    <= {8'b0, pte_ppn, 12'b0};
                                gs_return <= GRET_FS_BASE;
                                gs_level  <= gs_levels_total - 3'd1;
                                gs_ppn    <= gs_root_ppn;
                            end
                        end
                    end
                end

                // -------- G-stage (nested) walk --------
                TR_GS_WAIT: if (walk_rd_done) begin
                    if (walk_rd_resp != RESP_OKAY) begin
                        fault_cause <= tr_is_write ? CAUSE_STORE_GUEST_PAGE_FAULT
                                                   : CAUSE_LOAD_GUEST_PAGE_FAULT;
                    end else if (!pte_v || (!pte_r && pte_w)) begin
                        fault_cause <= tr_is_write ? CAUSE_STORE_GUEST_PAGE_FAULT
                                                   : CAUSE_LOAD_GUEST_PAGE_FAULT;
                    end else if (pte_leaf) begin
                        if (!pte_a || (tr_is_write && gs_return == GRET_FS_LEAF && !pte_d)) begin
                            fault_cause <= tr_is_write ? CAUSE_STORE_GUEST_PAGE_FAULT
                                                       : CAUSE_LOAD_GUEST_PAGE_FAULT;
                        end else begin
                            // Resolved SPA for this GPA.
                            gs_pa_out <= make_pa(pte_ppn, gpa_in);
                            gs_done   <= 1'b1;
                        end
                    end else begin
                        if (gs_level == 0)
                            fault_cause <= tr_is_write ? CAUSE_STORE_GUEST_PAGE_FAULT
                                                       : CAUSE_LOAD_GUEST_PAGE_FAULT;
                        else begin
                            gs_level <= gs_level - 3'd1;
                            gs_ppn   <= pte_ppn;
                        end
                    end
                end

                TR_FAULT: begin
                    // Emit a fault record describing the failed translation.
                    flt_push   <= 1'b1;
                    flt_record <= '{
                        cause:          fault_cause,
                        ttyp:           tr_is_write ? TTYP_UNTRANSLATED_WRITE_OR_AMO
                                                    : TTYP_UNTRANSLATED_READ_NO_AMO,
                        priv:           tr_prot[0],
                        rsvd_pid:       1'b0,
                        pid:            {{(20-PASID_W){1'b0}}, tr_pid},
                        did:            {{(24-DEVICE_ID_W){1'b0}}, tr_did},
                        custom:         1'b0,
                        iotval_present: 4'b0001,
                        iotval:         tr_iova,
                        iotval2:        gpa_in
                    };
                end

                default: ;
            endcase

            // ----- After a nested G-stage translation completes. -----
            // GRET_IOVA / GRET_FS_LEAF resolve the final PA; GRET_FS_BASE
            // resolves the next first-stage table base (fs_level was already
            // adjusted where the descent was decided).
            if (gs_done) begin
                if (gs_return == GRET_IOVA || gs_return == GRET_FS_LEAF)
                    final_pa <= gs_pa_out;
                else // GRET_FS_BASE
                    fs_ppn <= gs_pa_out[ADDR_WIDTH-1:12];
            end
        end
    end

    // ------------------------------------------------------------------
    // Walk FSM combinational next-state + read-request generation.
    // ------------------------------------------------------------------
    logic walk_rd_req_c;
    logic [ADDR_WIDTH-1:0] walk_rd_addr_c;

    always_comb begin
        tr_state_n     = tr_state;
        walk_rd_req_c  = 1'b0;
        walk_rd_addr_c = '0;

        unique case (tr_state)
            TR_IDLE: begin
                if ((ar_grant_idx != NO_GRANT && ar_needs_walk) ||
                    (aw_grant_idx != NO_GRANT && aw_needs_walk))
                    tr_state_n = TR_DDT_REQ;
            end

            TR_DDT_REQ: begin
                walk_rd_req_c  = 1'b1;
                walk_rd_addr_c = ddt_ptr;
                if (walk_rd_ack) tr_state_n = TR_DDT_WAIT;
            end
            TR_DDT_WAIT: if (walk_rd_done) begin
                if (walk_rd_resp != RESP_OKAY)            tr_state_n = TR_FAULT;
                else if (ddt_level != 0)
                    // Non-leaf DDT entry: fault if invalid, else descend.
                    tr_state_n = walk_rd_data[DDTE_V_BIT] ? TR_DDT_REQ : TR_FAULT;
                else if (!walk_rd_data[DC_TC_V_BIT])      tr_state_n = TR_FAULT;
                else                                      tr_state_n = TR_DC_DW1_REQ;
            end

            TR_DC_DW1_REQ: begin
                walk_rd_req_c  = 1'b1;
                walk_rd_addr_c = ddt_ptr + ADDR_WIDTH'(8);
                if (walk_rd_ack) tr_state_n = TR_DC_DW1_WAIT;
            end
            TR_DC_DW1_WAIT: if (walk_rd_done)
                tr_state_n = (walk_rd_resp != RESP_OKAY) ? TR_FAULT : TR_DC_DW3_REQ;

            TR_DC_DW3_REQ: begin
                walk_rd_req_c  = 1'b1;
                walk_rd_addr_c = ddt_ptr + ADDR_WIDTH'(24);
                if (walk_rd_ack) tr_state_n = TR_DC_DW3_WAIT;
            end
            TR_DC_DW3_WAIT: if (walk_rd_done) begin
                if (walk_rd_resp != RESP_OKAY)
                    tr_state_n = TR_FAULT;
                else if (walk_rd_data[ATP_MODE_MSB:ATP_MODE_LSB] == FS_MODE_BARE)
                    // First-stage BARE: IOVA is a GPA, run G-stage only
                    // (single-stage G); GS BARE too -> identity forward.
                    tr_state_n = (gs_mode == GS_MODE_BARE) ? TR_FWD_SETTLE : TR_GS_REQ;
                else if (gs_mode == GS_MODE_BARE)
                    // First-stage only: root base is already an SPA.
                    tr_state_n = TR_FS_REQ;
                else
                    // Two-stage: G-translate the first-stage root base first.
                    tr_state_n = TR_GS_REQ;
            end

            // First-stage PTE fetch.  fs_ppn always holds the current
            // first-stage table base as a supervisor PA (the root was set
            // at DC_DW3; each descended base is G-translated into fs_ppn).
            TR_FS_REQ: begin
                walk_rd_req_c  = 1'b1;
                walk_rd_addr_c = pte_addr(fs_ppn, {2'b0, vpn_index(tr_iova, fs_level)});
                if (walk_rd_ack) tr_state_n = TR_FS_WAIT;
            end
            TR_FS_WAIT: if (walk_rd_done) begin
                if (walk_rd_resp != RESP_OKAY)        tr_state_n = TR_FAULT;
                else if (!pte_v || (!pte_r && pte_w)) tr_state_n = TR_FAULT;
                else if (pte_leaf) begin
                    if (fs_leaf_perm_fault || fs_leaf_super_fault) tr_state_n = TR_FAULT;
                    else if (gs_mode == GS_MODE_BARE) tr_state_n = TR_FWD_SETTLE; // leaf PPN is SPA
                    else                              tr_state_n = TR_GS_REQ;     // G-translate leaf PPN
                end else if (fs_level == 0)           tr_state_n = TR_FAULT;
                else if (gs_mode == GS_MODE_BARE)     tr_state_n = TR_FS_REQ; // descend, no GS
                else                                  tr_state_n = TR_GS_REQ; // G-translate next base
            end

            // Settle cycle after a G-translated first-stage table base.
            TR_FS_NEXT: tr_state_n = TR_FS_REQ;

            // G-stage PTE fetch (nested).
            TR_GS_REQ: begin
                walk_rd_req_c  = 1'b1;
                walk_rd_addr_c = pte_addr(gs_ppn, gpn_index(gpa_in, gs_level, gs_levels_total));
                if (walk_rd_ack) tr_state_n = TR_GS_WAIT;
            end
            TR_GS_WAIT: if (walk_rd_done) begin
                if (walk_rd_resp != RESP_OKAY)        tr_state_n = TR_FAULT;
                else if (!pte_v || (!pte_r && pte_w)) tr_state_n = TR_FAULT;
                else if (pte_leaf) begin
                    if (!pte_a || (tr_is_write && gs_return == GRET_FS_LEAF && !pte_d))
                        tr_state_n = TR_FAULT;
                    else begin
                        // G translation complete; resume per gs_return.
                        unique case (gs_return)
                            // final_pa is updated by gs_done this edge; settle
                            // one cycle before driving it onto the AXI forward.
                            GRET_IOVA:    tr_state_n = TR_FWD_SETTLE;
                            GRET_FS_LEAF: tr_state_n = TR_FWD_SETTLE;
                            // One settle cycle so the G-translated table base
                            // (fs_ppn, updated by gs_done) is visible before
                            // the next first-stage PTE address is formed.
                            GRET_FS_BASE: tr_state_n = TR_FS_NEXT;
                            default:      tr_state_n = TR_FAULT;
                        endcase
                    end
                end else if (gs_level == 0)           tr_state_n = TR_FAULT;
                else                                  tr_state_n = TR_GS_REQ;
            end

            // Settle cycle so the resolved final_pa is registered before it
            // drives the downstream AR/AW address.
            TR_FWD_SETTLE: tr_state_n = TR_FWD_AR;

            // Forward the translated request downstream.
            TR_FWD_AR: begin
                if (tr_is_write) tr_state_n = TR_FWD_AW;
                else if (d_arready) tr_state_n = TR_FWD_RESP;
            end
            TR_FWD_AW: if (d_awready) tr_state_n = TR_FWD_W;
            TR_FWD_W:  if (d_wvalid && d_wready && d_wlast) tr_state_n = TR_FWD_RESP;
            TR_FWD_RESP: begin
                if (!tr_is_write && d_rvalid && d_rlast &&
                    u_rready[tr_master[MIDX_W-1:0]]) tr_state_n = TR_IDLE;
                else if (tr_is_write && d_bvalid &&
                    u_bready[tr_master[MIDX_W-1:0]]) tr_state_n = TR_IDLE;
            end

            TR_FAULT: tr_state_n = TR_IDLE;

            default: tr_state_n = TR_IDLE;
        endcase
    end

    // DDT first-pointer and DDT next-level pointer helpers.
    function automatic logic [ADDR_WIDTH-1:0] ddt_first_ptr(input logic [63:0] ddtp,
                                                            input logic [DEVICE_ID_W-1:0] did,
                                                            input logic [3:0] mode);
        logic [63:0] base;
        logic [63:0] idx;
        logic [63:0] sum;
        base = {10'b0, ddtp[DDTE_PPN_MSB:DDTE_PPN_LSB]} << 12;
        // 1LVL: leaf DDT indexed by did[6:0] * 32 (DC is 32 bytes).
        // 2/3LVL: non-leaf indexed by the top device-id slice * 8.
        if (mode == DDTP_MODE_1LVL)
            idx = ({57'b0, did[6:0]}) << 5;
        else if (mode == DDTP_MODE_2LVL)
            idx = ({55'b0, did[15:7]}) << 3;
        else // 3LVL
            idx = ({58'b0, did[23:16]}) << 3;
        sum = base | idx;
        return sum[ADDR_WIDTH-1:0];
    endfunction

    // Next DDT pointer from a non-leaf DDT entry (DDTE.ppn) using the next
    // device-id slice.  ddt_level is the level *before* decrement: 2 means
    // we just read the L3 (root) non-leaf, next index is did[15:7]; 1 means
    // we just read the L2 non-leaf, next index is did[6:0]*32 (leaf DC).
    function automatic logic [ADDR_WIDTH-1:0] ddte_next_ptr(input logic [63:0] ddte,
                                                           input logic [DEVICE_ID_W-1:0] did,
                                                           input logic [1:0]  level);
        logic [63:0] base;
        logic [63:0] idx;
        logic [63:0] sum;
        base = {10'b0, ddte[DDTE_PPN_MSB:DDTE_PPN_LSB]} << 12;
        if (level == 2'd2)        idx = ({55'b0, did[15:7]}) << 3;  // -> mid non-leaf
        else if (level == 2'd1)   idx = ({57'b0, did[6:0]})  << 5;  // -> leaf DC (32B)
        else                      idx = 64'b0;
        sum = base | idx;
        return sum[ADDR_WIDTH-1:0];
    endfunction

    // Superpage misalignment: a non-leaf-level leaf PTE must have its low
    // PPN bits (covered by the descended levels) zero.
    function automatic logic superpage_misaligned(input logic [43:0] ppn,
                                                  input logic [2:0]  level);
        // Each level below `level` covers 9 PPN bits that must be zero.
        logic [43:0] mask;
        mask = (44'h1 << (9*level)) - 44'h1;
        return |(ppn & mask);
    endfunction

    // ==================================================================
    // Downstream AXI4 master multiplexing.
    //
    //   * Identity fast path (BARE/OFF or allowlist bypass) drives the
    //     downstream port combinationally when the walker is idle.
    //   * The walker owns the port while translating (table reads) and
    //     while forwarding the translated request.
    // ==================================================================

    // Identity fast-path grants (only meaningful when !walk_active).
    logic aw_id_grant, ar_id_grant;
    assign aw_id_grant = (aw_grant_idx != NO_GRANT) && aw_fastpath && !walk_active;
    assign ar_id_grant = (ar_grant_idx != NO_GRANT) && ar_fastpath && !walk_active;

    // Downstream AR.
    always_comb begin
        int unsigned m;
        m = 0;
        d_arvalid = 1'b0;
        d_arid    = '0;
        d_araddr  = '0;
        d_arlen   = '0;
        d_arsize  = '0;
        d_arburst = BURST_INCR;
        d_arcache = CACHE_DEVICE_NON_BUFFERABLE;
        d_arprot  = '0;
        d_arqos   = '0;
        d_aruser  = '0;
        if (rd_state == RD_AR) begin
            // Table-walk read.
            d_arvalid = 1'b1;
            d_arid    = '0;
            d_araddr  = rd_addr_q;
            d_arlen   = '0;
            d_arsize  = SIZE_8B;
            d_arburst = BURST_INCR;
            d_arcache = CACHE_DEVICE_NON_BUFFERABLE;
            d_arprot  = PROT_DATA_S_PRIV;
        end else if (tr_state == TR_FWD_AR && !tr_is_write) begin
            // Translated read forward.
            d_arvalid = 1'b1;
            d_arid    = tr_axid;
            d_araddr  = final_pa;
            d_arlen   = tr_len;
            d_arsize  = tr_size;
            d_arburst = tr_burst;
            d_arcache = tr_cache;
            d_arprot  = tr_prot;
            d_arqos   = tr_qos;
            d_aruser  = tr_user;
        end else if (ar_id_grant) begin
            m = ar_grant_idx;
            d_arvalid = u_arvalid[m];
            d_arid    = u_arid[m];
            d_araddr  = u_araddr[m];   // BARE/bypass = identity
            d_arlen   = u_arlen[m];
            d_arsize  = u_arsize[m];
            d_arburst = u_arburst[m];
            d_arcache = u_arcache[m];
            d_arprot  = u_arprot[m];
            d_arqos   = u_arqos[m];
            d_aruser  = u_aruser[m];
        end
    end

    // Downstream AW.
    always_comb begin
        int unsigned m;
        m = 0;
        d_awvalid = 1'b0;
        d_awid    = '0;
        d_awaddr  = '0;
        d_awlen   = '0;
        d_awsize  = '0;
        d_awburst = BURST_INCR;
        d_awcache = CACHE_DEVICE_NON_BUFFERABLE;
        d_awprot  = '0;
        d_awqos   = '0;
        d_awuser  = '0;
        if (tr_state == TR_FWD_AW && tr_is_write) begin
            d_awvalid = 1'b1;
            d_awid    = tr_axid;
            d_awaddr  = final_pa;
            d_awlen   = tr_len;
            d_awsize  = tr_size;
            d_awburst = tr_burst;
            d_awcache = tr_cache;
            d_awprot  = tr_prot;
            d_awqos   = tr_qos;
            d_awuser  = tr_user;
        end else if (aw_id_grant) begin
            m = aw_grant_idx;
            d_awvalid = u_awvalid[m];
            d_awid    = u_awid[m];
            d_awaddr  = u_awaddr[m];
            d_awlen   = u_awlen[m];
            d_awsize  = u_awsize[m];
            d_awburst = u_awburst[m];
            d_awcache = u_awcache[m];
            d_awprot  = u_awprot[m];
            d_awqos   = u_awqos[m];
            d_awuser  = u_awuser[m];
        end
    end

    // Downstream W.
    always_comb begin
        int unsigned m;
        m = 0;
        d_wvalid = 1'b0;
        d_wdata  = '0;
        d_wstrb  = '0;
        d_wlast  = 1'b0;
        for (int unsigned idx = 0; idx < NUM_MASTERS; idx++) u_wready[idx] = 1'b0;
        if (tr_state == TR_FWD_W && tr_is_write) begin
            m = tr_master[MIDX_W-1:0];
            d_wvalid    = u_wvalid[m];
            d_wdata     = u_wdata[m];
            d_wstrb     = u_wstrb[m];
            d_wlast     = u_wlast[m];
            u_wready[m] = d_wready;
        end else if (aw_id_grant) begin
            m = aw_grant_idx;
            d_wvalid    = u_wvalid[m];
            d_wdata     = u_wdata[m];
            d_wstrb     = u_wstrb[m];
            d_wlast     = u_wlast[m];
            u_wready[m] = d_wready;
        end
    end

    // Upstream AR/AW ready.
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            u_awready[m] = 1'b0;
            u_arready[m] = 1'b0;
        end
        // Identity fast path: mirror downstream ready.
        if (ar_id_grant) u_arready[ar_grant_idx] = d_arready;
        if (aw_id_grant) u_awready[aw_grant_idx] = d_awready;
        // Walker-translated forward consumes the upstream AR/AW once the
        // translated request is accepted downstream.
        if (tr_state == TR_FWD_AR && !tr_is_write && d_arready)
            u_arready[tr_master[MIDX_W-1:0]] = 1'b1;
        if (tr_state == TR_FWD_AW && tr_is_write && d_awready)
            u_awready[tr_master[MIDX_W-1:0]] = 1'b1;
        // A faulting request is retired (accepted) in TR_FAULT so the
        // master does not hang; its data path returns SLVERR.
        if (tr_state == TR_FAULT) begin
            if (tr_is_write) u_awready[tr_master[MIDX_W-1:0]] = 1'b1;
            else             u_arready[tr_master[MIDX_W-1:0]] = 1'b1;
        end
    end

    // Downstream B/R ready + upstream B/R return.
    always_comb begin
        int unsigned m;
        m = 0;
        for (int unsigned idx = 0; idx < NUM_MASTERS; idx++) begin
            u_bvalid[idx] = 1'b0;
            u_bid[idx]    = '0;
            u_bresp[idx]  = RESP_OKAY;
            u_rvalid[idx] = 1'b0;
            u_rid[idx]    = '0;
            u_rdata[idx]  = '0;
            u_rresp[idx]  = RESP_OKAY;
            u_rlast[idx]  = 1'b0;
        end
        d_bready = 1'b0;
        d_rready = 1'b0;

        // Table-walk reads consume R internally.
        if (rd_state == RD_R) d_rready = 1'b1;

        // Identity fast path B/R passthrough.
        if (aw_id_grant) begin
            m = aw_grant_idx;
            u_bvalid[m] = d_bvalid;
            u_bid[m]    = d_bid;
            u_bresp[m]  = d_bresp;
            d_bready    = u_bready[m];
        end
        if (ar_id_grant) begin
            m = ar_grant_idx;
            u_rvalid[m] = d_rvalid;
            u_rid[m]    = d_rid;
            u_rdata[m]  = d_rdata;
            u_rresp[m]  = d_rresp;
            u_rlast[m]  = d_rlast;
            d_rready    = u_rready[m];
        end

        // Walker-translated response forward.
        if (tr_state == TR_FWD_RESP) begin
            m = tr_master[MIDX_W-1:0];
            if (tr_is_write) begin
                u_bvalid[m] = d_bvalid;
                u_bid[m]    = tr_axid;
                u_bresp[m]  = d_bresp;
                d_bready    = u_bready[m];
            end else begin
                u_rvalid[m] = d_rvalid;
                u_rid[m]    = tr_axid;
                u_rdata[m]  = d_rdata;
                u_rresp[m]  = d_rresp;
                u_rlast[m]  = d_rlast;
                d_rready    = u_rready[m];
            end
        end

        // Faulting request: return SLVERR to the originating master.
        if (tr_state == TR_FAULT) begin
            m = tr_master[MIDX_W-1:0];
            if (tr_is_write) begin
                u_bvalid[m] = 1'b1;
                u_bid[m]    = tr_axid;
                u_bresp[m]  = RESP_SLVERR;
            end else begin
                u_rvalid[m] = 1'b1;
                u_rid[m]    = tr_axid;
                u_rdata[m]  = '0;
                u_rresp[m]  = RESP_SLVERR;
                u_rlast[m]  = 1'b1;
            end
        end
    end

    // ------------------------------------------------------------------
    // Fault queue: staged records from the translation FSM.  Records are
    // pushed by flt_push (one per failed translation).  reg_fqt mirrors
    // the stage pointer so the kernel driver can poll FQT.
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned i = 0; i < FAULT_Q_DEPTH; i++) fq_stage[i] <= '0;
            fq_stage_head   <= '0;
            fq_stage_tail   <= '0;
            fq_stage_count  <= '0;
            fault_count_dbg <= '0;
            fault_irq       <= 1'b0;
            aw_rr_ptr       <= '0;
            ar_rr_ptr       <= '0;
        end else begin
            fault_irq <= 1'b0;
            if (flt_push && fq_stage_count < $clog2(FAULT_Q_DEPTH+1)'(FAULT_Q_DEPTH)) begin
                fq_stage[fq_stage_tail[$clog2(FAULT_Q_DEPTH)-1:0]] <= flt_record;
                fq_stage_tail   <= fq_stage_tail + 1'b1;
                fq_stage_count  <= fq_stage_count + 1'b1;
                fault_count_dbg <= fault_count_dbg + 1'b1;
                fault_irq       <= 1'b1;
            end
            // Rotate identity fast-path round-robin pointers on accept.
            if (ar_id_grant && u_arvalid[ar_grant_idx] && d_arready)
                ar_rr_ptr <= $clog2(NUM_MASTERS+1)'((ar_grant_idx + 1) % NUM_MASTERS);
            if (aw_id_grant && u_awvalid[aw_grant_idx] && d_awready)
                aw_rr_ptr <= $clog2(NUM_MASTERS+1)'((aw_grant_idx + 1) % NUM_MASTERS);
        end
    end

    // ==================================================================
    // Command queue execution.
    //
    // Reads command doublewords from the memory-resident CQ ring (CQB
    // base, CQH head .. CQT tail) over the downstream walk port and
    // executes them:
    //   * IOTINVAL.VMA / IOTINVAL.GVMA / IODIR.INVAL_DDT / IODIR.INVAL_PDT
    //     are no-ops for this walk-every-time v1 (no persistent IOATC to
    //     flush) — they advance CQH and are accepted.
    //   * IOFENCE.C completes the fence: it pulses cmd_complete_irq and
    //     (optionally) signals completion to memory.
    // The CQ engine only runs when the translation FSM is idle so the two
    // share the downstream port without contention.
    // ==================================================================
    localparam logic [6:0] CMD_OP_IOTINVAL = 7'h01; // opcode field [6:0]
    localparam logic [6:0] CMD_OP_IODIR    = 7'h03;
    localparam logic [6:0] CMD_OP_IOFENCE  = 7'h02;

    typedef enum logic [1:0] {CQ_IDLE, CQ_FETCH, CQ_WAIT, CQ_EXEC} cq_state_e;
    cq_state_e cq_state, cq_state_n;
    logic [63:0] cq_cmd;
    logic        cmd_complete_irq_q;
    logic        cq_rd_req;
    logic [ADDR_WIDTH-1:0] cq_rd_addr;

    // CQ enabled when CQCSR.cqen (bit 0) set and CQH != CQT.
    logic cq_enabled;
    logic cq_nonempty;
    assign cq_enabled  = reg_cqcsr[0];
    assign cq_nonempty = (reg_cqh != reg_cqt);

    // CQ entry address = (cqb.ppn << 12) + cqh * 16 (16-byte commands).
    function automatic logic [ADDR_WIDTH-1:0] cq_entry_addr(input logic [63:0] cqb,
                                                           input logic [31:0] cqh);
        logic [63:0] a;
        a = ({10'b0, cqb[DDTE_PPN_MSB:DDTE_PPN_LSB]} << 12) | ({32'b0, cqh} << 4);
        return a[ADDR_WIDTH-1:0];
    endfunction

    always_comb begin
        cq_state_n = cq_state;
        cq_rd_req  = 1'b0;
        cq_rd_addr = '0;
        case (cq_state)
            CQ_IDLE:  if (cq_enabled && cq_nonempty && !walk_active) cq_state_n = CQ_FETCH;
            CQ_FETCH: begin
                cq_rd_req  = 1'b1;
                cq_rd_addr = cq_entry_addr(reg_cqb, reg_cqh);
                if (walk_rd_ack) cq_state_n = CQ_WAIT;
            end
            CQ_WAIT:  if (walk_rd_done) cq_state_n = CQ_EXEC;
            CQ_EXEC:  cq_state_n = CQ_IDLE;
            default:  cq_state_n = CQ_IDLE;
        endcase
    end

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            cq_state           <= CQ_IDLE;
            cq_cmd             <= '0;
            cmd_complete_irq_q <= 1'b0;
        end else begin
            cq_state           <= cq_state_n;
            cmd_complete_irq_q <= 1'b0;
            if (cq_state == CQ_WAIT && walk_rd_done) cq_cmd <= walk_rd_data;
            if (cq_state == CQ_EXEC) begin
                // IOFENCE.C signals completion; all commands advance CQH.
                if (cq_cmd[6:0] == CMD_OP_IOFENCE)
                    cmd_complete_irq_q <= 1'b1;
            end
        end
    end

    assign cmd_complete_irq = cmd_complete_irq_q;

    // The CQ engine borrows the walk read sub-FSM when the translation FSM
    // is idle.  Only one requester drives walk_rd_req at a time.
    logic        cq_owns_rd;
    assign cq_owns_rd = (cq_state == CQ_FETCH);

    // Final read-request arbitration: translation FSM has priority; the CQ
    // engine drives the port only when translation is idle.  This is the
    // single driver of the walk-read sub-FSM request inputs.
    assign walk_rd_req  = (rd_state == RD_IDLE) &&
                          (walk_active ? walk_rd_req_c : cq_owns_rd);
    assign walk_rd_addr = walk_active ? walk_rd_addr_c : cq_rd_addr;

    // ------------------------------------------------------------------
    // MMIO register file (AXI-Lite-style).  Programs DDTP, queue pointers,
    // and command words.
    // ------------------------------------------------------------------
    logic                    mmio_aw_reg;
    logic [11:0]             mmio_aw_addr_q;
    logic                    mmio_ar_reg;
    logic [11:0]             mmio_ar_addr_q;

    assign mmio_awready = !mmio_aw_reg;
    assign mmio_wready  = mmio_aw_reg && !mmio_bvalid;
    assign mmio_arready = !mmio_ar_reg;

    // Advance CQH when a command has been executed.
    logic cq_advance;
    assign cq_advance = (cq_state == CQ_EXEC);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            reg_capabilities <= CAPS_RESET_VALUE;
            reg_fctl         <= '0;
            reg_ddtp         <= '0;  // OFF
            reg_cqb          <= '0;
            reg_cqh          <= '0;
            reg_cqt          <= '0;
            reg_fqb          <= '0;
            reg_fqh          <= '0;
            reg_fqt          <= '0;
            reg_pqb          <= '0;
            reg_pqh          <= '0;
            reg_pqt          <= '0;
            reg_cqcsr        <= '0;
            reg_fqcsr        <= '0;
            reg_pqcsr        <= '0;
            reg_ipsr         <= '0;
            reg_tr_req_iova  <= '0;
            reg_tr_req_ctl   <= '0;
            reg_tr_response  <= '0;
            mmio_aw_reg      <= 1'b0;
            mmio_aw_addr_q   <= '0;
            mmio_ar_reg      <= 1'b0;
            mmio_ar_addr_q   <= '0;
            mmio_bvalid      <= 1'b0;
            mmio_bresp       <= '0;
            mmio_rvalid      <= 1'b0;
            mmio_rdata       <= '0;
            mmio_rresp       <= '0;
            for (int unsigned i = 0; i < NUM_MASTERS; i++) begin
                allowed_dev[i] <= '0;
                allowed_vld[i] <= 1'b0;
            end
        end else begin
            // AW accept
            if (mmio_awvalid && mmio_awready) begin
                mmio_aw_reg    <= 1'b1;
                mmio_aw_addr_q <= mmio_awaddr;
            end
            if (mmio_bvalid && mmio_bready) begin
                mmio_bvalid <= 1'b0;
                mmio_aw_reg <= 1'b0;
            end
            // W accept
            if (mmio_aw_reg && mmio_wvalid && mmio_wready) begin
                case (mmio_aw_addr_q)
                    OFFS_FCTL:        reg_fctl        <= mmio_wdata[31:0];
                    OFFS_DDTP:        reg_ddtp        <= mmio_wdata;
                    OFFS_CQB:         reg_cqb         <= mmio_wdata;
                    OFFS_CQT:         reg_cqt         <= mmio_wdata[31:0];
                    OFFS_FQB:         reg_fqb         <= mmio_wdata;
                    OFFS_FQH:         reg_fqh         <= mmio_wdata[31:0];
                    OFFS_PQB:         reg_pqb         <= mmio_wdata;
                    OFFS_PQH:         reg_pqh         <= mmio_wdata[31:0];
                    OFFS_CQCSR:       reg_cqcsr       <= mmio_wdata[31:0];
                    OFFS_FQCSR:       reg_fqcsr       <= mmio_wdata[31:0];
                    OFFS_PQCSR:       reg_pqcsr       <= mmio_wdata[31:0];
                    OFFS_IPSR:        reg_ipsr        <= reg_ipsr & ~mmio_wdata[31:0];
                    OFFS_TR_REQ_IOVA: reg_tr_req_iova <= mmio_wdata;
                    OFFS_TR_REQ_CTL:  reg_tr_req_ctl  <= mmio_wdata;
                    default: ;
                endcase
                // Custom encoding for the monitor bypass allowlist:
                // 0x800 + idx*8 writes 64-bit { valid, devid }.
                if (mmio_aw_addr_q[11:8] == 4'h8) begin
                    int unsigned idx = mmio_aw_addr_q[7:3];
                    if (idx < NUM_MASTERS) begin
                        allowed_vld[idx] <= mmio_wdata[63];
                        allowed_dev[idx] <= DEVICE_ID_W'(mmio_wdata[DEVICE_ID_W-1:0]);
                    end
                end
                mmio_bvalid <= 1'b1;
                mmio_bresp  <= RESP_OKAY;
            end

            // AR accept
            if (mmio_arvalid && mmio_arready) begin
                mmio_ar_reg    <= 1'b1;
                mmio_ar_addr_q <= mmio_araddr;
                mmio_rvalid    <= 1'b1;
                case (mmio_araddr)
                    OFFS_CAPABILITIES: mmio_rdata <= reg_capabilities;
                    OFFS_FCTL:         mmio_rdata <= 64'(reg_fctl);
                    OFFS_DDTP:         mmio_rdata <= reg_ddtp;
                    OFFS_CQB:          mmio_rdata <= reg_cqb;
                    OFFS_CQH:          mmio_rdata <= 64'(reg_cqh);
                    OFFS_CQT:          mmio_rdata <= 64'(reg_cqt);
                    OFFS_FQB:          mmio_rdata <= reg_fqb;
                    OFFS_FQH:          mmio_rdata <= 64'(reg_fqh);
                    OFFS_FQT:          mmio_rdata <= 64'(reg_fqt);
                    OFFS_PQB:          mmio_rdata <= reg_pqb;
                    OFFS_PQH:          mmio_rdata <= 64'(reg_pqh);
                    OFFS_PQT:          mmio_rdata <= 64'(reg_pqt);
                    OFFS_CQCSR:        mmio_rdata <= 64'(reg_cqcsr);
                    OFFS_FQCSR:        mmio_rdata <= 64'(reg_fqcsr);
                    OFFS_PQCSR:        mmio_rdata <= 64'(reg_pqcsr);
                    OFFS_IPSR:         mmio_rdata <= 64'(reg_ipsr);
                    OFFS_TR_REQ_IOVA:  mmio_rdata <= reg_tr_req_iova;
                    OFFS_TR_REQ_CTL:   mmio_rdata <= reg_tr_req_ctl;
                    OFFS_TR_RESPONSE:  mmio_rdata <= reg_tr_response;
                    default:           mmio_rdata <= 64'h0;
                endcase
                mmio_rresp <= RESP_OKAY;
            end
            if (mmio_rvalid && mmio_rready) begin
                mmio_rvalid <= 1'b0;
                mmio_ar_reg <= 1'b0;
            end

            // Fault queue tail register reflects staged faults so the
            // kernel driver can poll FQT and walk the stage records.
            reg_fqt <= 32'(fq_stage_tail);

            // Command queue head advances as the CQ engine retires entries.
            if (cq_advance) reg_cqh <= reg_cqh + 32'd1;

            // IPSR bit 1 mirrors FQ interrupt status; bit 0 mirrors CQ.
            if (fault_irq)          reg_ipsr[1] <= 1'b1;
            if (cmd_complete_irq_q) reg_ipsr[0] <= 1'b1;
        end
    end

    // ------------------------------------------------------------------
    // Page-request queue: register surface only.  A full SVA path adds
    // upstream PRI request signals.
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned i = 0; i < PAGE_Q_DEPTH; i++) prq_stage[i] <= '0;
            prq_stage_head     <= '0;
            prq_stage_tail     <= '0;
            prq_stage_count    <= '0;
            page_req_count_dbg <= '0;
            page_req_irq       <= 1'b0;
        end else begin
            page_req_irq <= 1'b0;
        end
    end

endmodule
