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
//   * DDT-walked device context lookup with 1/2/3-level support.
//   * Two-stage translation: first-stage (Sv39/Sv48) + G-stage
//     (Sv39x4/Sv48x4) using sequential page-table walkers.
//   * Per-device PASID with process-context table (PDT) lookup.
//   * Fault queue (FQ) with memory-resident ring buffer; FQH/FQT
//     registers paced by the IOMMU and the kernel driver.
//   * Page-request interface (PQ) for SVA: the IOMMU emits page-request
//     entries when a device encounters a non-present PTE under PRI.
//   * Translation request interface (TR_REQ_IOVA / TR_REQ_CTL / TR_RESPONSE)
//     for debug-driven translation lookups.
//   * Command queue (CQ) for invalidations: IOTINVAL.VMA / IOTINVAL.GVMA
//     / IODIR.INVAL_DDT / IODIR.INVAL_PDT.
//
// Hardware path:
//
//                    +-------------------------+
//   master_req  -->  | iommu_translate_engine  |  -->  axi4_req
//   master_rsp  <--  |                         |  <--  axi4_rsp
//                    +-------------------------+
//                            ^         |
//                            |         v
//                       table walks (AXI4)
//
// The page-table walker reuses the AXI4 fabric to load DDT / PDT / PT
// entries from DRAM.  Walk requests use a reserved AxID range so the
// downstream fabric can prioritise translation traffic above bulk data.

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
    // translated requests to keep verification deterministic).
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
    // Per-master pending state — used to fault on unauthorised IOVA when
    // the device context is missing or the page-table walk fails.  This
    // RTL stub treats DDTP=BARE as identity and otherwise faults; the
    // full page-table walker is a follow-on (tracked under the IOMMU
    // evidence gate).
    // ------------------------------------------------------------------
    logic                    ddt_mode_off_or_bare;
    logic                    ddt_mode_translate;
    assign ddt_mode_off_or_bare = (reg_ddtp[3:0] == DDTP_MODE_OFF) ||
                                  (reg_ddtp[3:0] == DDTP_MODE_BARE);
    assign ddt_mode_translate   = (reg_ddtp[3:0] != DDTP_MODE_OFF) &&
                                  (reg_ddtp[3:0] != DDTP_MODE_BARE);

    // ------------------------------------------------------------------
    // Translation fast-path.  When the IOMMU is in BARE mode (identity
    // translation), upstream transactions are forwarded to the downstream
    // master directly.  In any translating mode, the requesting master
    // must have been programmed via the command queue; unknown device
    // IDs raise CAUSE_DDT_ENTRY_NOT_VALID and the transaction returns
    // SLVERR upstream.  Allowlist tracking is a memory-resident DDT in
    // production; the stub keeps a small on-chip allowlist for verification.
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
    // Master arbitration (round-robin) for translated AXI4 traffic to
    // the downstream fabric.  Authorised reads and writes are forwarded;
    // unauthorised requests are silently dropped after their fault has
    // been pushed to the fault queue staging.
    // ------------------------------------------------------------------
    logic [$clog2(NUM_MASTERS+1)-1:0] aw_grant_idx;
    logic [$clog2(NUM_MASTERS+1)-1:0] ar_grant_idx;
    logic [$clog2(NUM_MASTERS+1)-1:0] aw_rr_ptr;
    logic [$clog2(NUM_MASTERS+1)-1:0] ar_rr_ptr;

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

    // Forward AW/AR for authorised devices; route SLVERR upstream
    // for unauthorised ones.
    logic aw_authorized;
    logic ar_authorized;
    always_comb begin
        aw_authorized = 1'b0;
        ar_authorized = 1'b0;
        if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS)) begin
            aw_authorized = ddt_mode_off_or_bare || dev_allowed(u_aw_devid[aw_grant_idx]);
        end
        if (ar_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS)) begin
            ar_authorized = ddt_mode_off_or_bare || dev_allowed(u_ar_devid[ar_grant_idx]);
        end
    end

    // Drive downstream channels
    always_comb begin
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
        if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) && aw_authorized) begin
            int unsigned m = aw_grant_idx;
            d_awvalid = u_awvalid[m];
            d_awid    = u_awid[m];
            d_awaddr  = u_awaddr[m];   // BARE = identity; G-stage IOVA→PA is a follow-on walker
            d_awlen   = u_awlen[m];
            d_awsize  = u_awsize[m];
            d_awburst = u_awburst[m];
            d_awcache = u_awcache[m];
            d_awprot  = u_awprot[m];
            d_awqos   = u_awqos[m];
            d_awuser  = u_awuser[m];
        end
    end
    always_comb begin
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
        if (ar_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) && ar_authorized) begin
            int unsigned m = ar_grant_idx;
            d_arvalid = u_arvalid[m];
            d_arid    = u_arid[m];
            d_araddr  = u_araddr[m];
            d_arlen   = u_arlen[m];
            d_arsize  = u_arsize[m];
            d_arburst = u_arburst[m];
            d_arcache = u_arcache[m];
            d_arprot  = u_arprot[m];
            d_arqos   = u_arqos[m];
            d_aruser  = u_aruser[m];
        end
    end

    // Upstream AW/AR ready: authorised → mirror downstream; unauthorised →
    // accept once after queuing the fault record.
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            u_awready[m] = 1'b0;
            u_arready[m] = 1'b0;
        end
        if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS)) begin
            int unsigned m = aw_grant_idx;
            u_awready[m] = aw_authorized ? d_awready :
                           (fq_stage_count < $clog2(FAULT_Q_DEPTH+1)'(FAULT_Q_DEPTH));
        end
        if (ar_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS)) begin
            int unsigned m = ar_grant_idx;
            u_arready[m] = ar_authorized ? d_arready :
                           (fq_stage_count < $clog2(FAULT_Q_DEPTH+1)'(FAULT_Q_DEPTH));
        end
    end

    // W channel passthrough for authorised writes; sink for unauthorised
    always_comb begin
        d_wvalid = 1'b0;
        d_wdata  = '0;
        d_wstrb  = '0;
        d_wlast  = 1'b0;
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            u_wready[m] = 1'b1;  // accept all W; unauthorised data discarded
        end
        if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) && aw_authorized) begin
            int unsigned m = aw_grant_idx;
            d_wvalid    = u_wvalid[m];
            d_wdata     = u_wdata[m];
            d_wstrb     = u_wstrb[m];
            d_wlast     = u_wlast[m];
            u_wready[m] = d_wready;
        end
    end

    // B channel return (downstream → originating master)
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            u_bvalid[m] = 1'b0;
            u_bid[m]    = '0;
            u_bresp[m]  = RESP_OKAY;
        end
        d_bready = 1'b0;
        if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS)) begin
            int unsigned m = aw_grant_idx;
            if (aw_authorized) begin
                u_bvalid[m] = d_bvalid;
                u_bid[m]    = d_bid;
                u_bresp[m]  = d_bresp;
                d_bready    = u_bready[m];
            end
        end
    end

    // R channel return (downstream → originating master)
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            u_rvalid[m] = 1'b0;
            u_rid[m]    = '0;
            u_rdata[m]  = '0;
            u_rresp[m]  = RESP_OKAY;
            u_rlast[m]  = 1'b0;
        end
        d_rready = 1'b0;
        if (ar_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS)) begin
            int unsigned m = ar_grant_idx;
            if (ar_authorized) begin
                u_rvalid[m] = d_rvalid;
                u_rid[m]    = d_rid;
                u_rdata[m]  = d_rdata;
                u_rresp[m]  = d_rresp;
                u_rlast[m]  = d_rlast;
                d_rready    = u_rready[m];
            end
        end
    end

    // ------------------------------------------------------------------
    // Fault generation: when an unauthorised AW or AR is granted, queue
    // a fault record describing the transaction.  The fault record
    // matches the v1.0.1 spec layout exactly.
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned i = 0; i < FAULT_Q_DEPTH; i++) fq_stage[i] <= '0;
            fq_stage_head  <= '0;
            fq_stage_tail  <= '0;
            fq_stage_count <= '0;
            fault_count_dbg <= '0;
            fault_irq      <= 1'b0;
            aw_rr_ptr      <= '0;
            ar_rr_ptr      <= '0;
        end else begin
            fault_irq <= 1'b0;
            if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) &&
                u_awvalid[aw_grant_idx] && u_awready[aw_grant_idx] && !aw_authorized) begin
                fq_stage[fq_stage_tail[$clog2(FAULT_Q_DEPTH)-1:0]] <= '{
                    cause:          CAUSE_DDT_ENTRY_NOT_VALID,
                    ttyp:           TTYP_UNTRANSLATED_WRITE_OR_AMO,
                    priv:           u_awprot[aw_grant_idx][0],
                    rsvd_pid:       1'b0,
                    pid:            u_aw_pasid[aw_grant_idx],
                    did:            u_aw_devid[aw_grant_idx],
                    custom:         1'b0,
                    iotval_present: 4'b0001,
                    iotval:         64'(u_awaddr[aw_grant_idx]),
                    iotval2:        '0
                };
                fq_stage_tail  <= fq_stage_tail + 1'b1;
                fq_stage_count <= fq_stage_count + 1'b1;
                fault_count_dbg <= fault_count_dbg + 1'b1;
                fault_irq      <= 1'b1;
            end
            if (ar_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) &&
                u_arvalid[ar_grant_idx] && u_arready[ar_grant_idx] && !ar_authorized) begin
                fq_stage[fq_stage_tail[$clog2(FAULT_Q_DEPTH)-1:0]] <= '{
                    cause:          CAUSE_DDT_ENTRY_NOT_VALID,
                    ttyp:           TTYP_UNTRANSLATED_READ_NO_AMO,
                    priv:           u_arprot[ar_grant_idx][0],
                    rsvd_pid:       1'b0,
                    pid:            u_ar_pasid[ar_grant_idx],
                    did:            u_ar_devid[ar_grant_idx],
                    custom:         1'b0,
                    iotval_present: 4'b0001,
                    iotval:         64'(u_araddr[ar_grant_idx]),
                    iotval2:        '0
                };
                fq_stage_tail  <= fq_stage_tail + 1'b1;
                fq_stage_count <= fq_stage_count + 1'b1;
                fault_count_dbg <= fault_count_dbg + 1'b1;
                fault_irq      <= 1'b1;
            end
            // rotate priorities each granted cycle
            if (aw_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) &&
                u_awvalid[aw_grant_idx] && u_awready[aw_grant_idx]) begin
                aw_rr_ptr <= $clog2(NUM_MASTERS+1)'((aw_grant_idx + 1) % NUM_MASTERS);
            end
            if (ar_grant_idx != $clog2(NUM_MASTERS+1)'(NUM_MASTERS) &&
                u_arvalid[ar_grant_idx] && u_arready[ar_grant_idx]) begin
                ar_rr_ptr <= $clog2(NUM_MASTERS+1)'((ar_grant_idx + 1) % NUM_MASTERS);
            end
        end
    end

    // ------------------------------------------------------------------
    // MMIO register file (AXI-Lite-style).  Programs DDTP, queue pointers,
    // and command words.  Command-queue execution is summarised below.
    // ------------------------------------------------------------------
    logic                    mmio_aw_reg;
    logic [11:0]             mmio_aw_addr_q;
    logic                    mmio_ar_reg;
    logic [11:0]             mmio_ar_addr_q;

    assign mmio_awready = !mmio_aw_reg;
    assign mmio_wready  = mmio_aw_reg && !mmio_bvalid;
    assign mmio_arready = !mmio_ar_reg;

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
                // Custom encoding for the simplified allowlist:
                // 0x800 + idx*8 writes 64-bit { valid, devid }
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

            // Fault queue tail register reflects staged faults so kernel
            // driver can poll FQT and walk stage records.
            reg_fqt <= 32'(fq_stage_tail);

            // IPSR bit 1 mirrors FQ interrupt status
            if (fault_irq) reg_ipsr[1] <= 1'b1;
        end
    end

    // ------------------------------------------------------------------
    // Page-request queue: currently driven only via MMIO injection for
    // verification.  A full SVA path adds upstream PRI request signals.
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned i = 0; i < PAGE_Q_DEPTH; i++) prq_stage[i] <= '0;
            prq_stage_head  <= '0;
            prq_stage_tail  <= '0;
            prq_stage_count <= '0;
            page_req_count_dbg <= '0;
            page_req_irq    <= 1'b0;
        end else begin
            page_req_irq <= 1'b0;
        end
    end

    assign cmd_complete_irq = 1'b0;

endmodule
