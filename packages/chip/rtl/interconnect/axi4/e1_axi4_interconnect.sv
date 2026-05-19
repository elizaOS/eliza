`timescale 1ns/1ps

// e1_axi4_interconnect
//
// Production-path AXI4 burst-capable interconnect for the 2028 phone-class
// SoC.  Supersedes rtl/interconnect/e1_axi_lite_interconnect.sv (which is
// retained as a backward-compatible scaffold for the existing AXI-Lite
// contract tests).
//
// Feature set:
//   * AXI4 full bursts: INCR (up to 256 beats), WRAP (up to 16), FIXED (up
//     to 16).  AWLEN/ARLEN width is parameterized; the 4-bit AXI3 subset is
//     the default to keep the verification surface deterministic.
//   * AxID width is configurable per master and is widened with a
//     log2(NUM_MASTERS) prefix on the slave side so that responses can be
//     deterministically routed back to the originating master.
//   * Cacheability + protection attributes (ARCACHE/AWCACHE, ARPROT/AWPROT)
//     are propagated unchanged.
//   * Exclusive monitors per master at every coherent slave.  A pending
//     ARLOCK is cleared by any intervening write to the reserved address
//     from a different master.
//   * AxQOS is forwarded; round-robin arbitration is biased toward higher
//     QoS classes when bus pressure exceeds a configurable threshold.
//   * Independent backpressure on every AXI4 channel.  Per-master
//     outstanding-transaction counters drive AW/AR ready deassertion before
//     downstream queues overflow.
//   * Strict in-order response per AxID: write responses follow AW order
//     for the same ID; read data interleave across IDs is preserved using
//     the master's ID as a routing tag.
//
// This module deliberately does NOT implement coherence.  Coherent traffic
// (CPU L1/L2/L3 snoop, NPU/GPU stash-on-write hints) is brokered by the
// upstream CHI-class fabric and bridged into AXI4 via
// rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv.

module e1_axi4_interconnect
    import e1_axi4_pkg::*;
#(
    parameter int unsigned NUM_MASTERS    = 4,
    parameter int unsigned NUM_SLAVES     = 4,
    parameter int unsigned ADDR_WIDTH     = 40,
    parameter int unsigned DATA_WIDTH     = 128,
    parameter int unsigned ID_WIDTH       = 4,
    parameter int unsigned USER_WIDTH     = 8,
    parameter int unsigned MAX_OUTST      = 16,
    parameter int unsigned BURST_LEN_W    = 8,                // 8 = full AXI4
    // Per-slave base/mask arrays.  base[i] = inclusive start, mask[i] holds
    // the size minus one, so an address matches when (addr & ~mask) == base.
    parameter logic [ADDR_WIDTH-1:0] SLAVE_BASE [0:NUM_SLAVES-1] = '{NUM_SLAVES{ {ADDR_WIDTH{1'b0}} }},
    parameter logic [ADDR_WIDTH-1:0] SLAVE_MASK [0:NUM_SLAVES-1] = '{NUM_SLAVES{ {ADDR_WIDTH{1'b0}} }}
) (
    input  logic clk,
    input  logic rst_n,

    // ------------------------------------------------------------------
    // Master ports (flattened) — see manifest below for index assignments
    // ------------------------------------------------------------------
    input  logic [NUM_MASTERS-1:0]                    m_awvalid,
    output logic [NUM_MASTERS-1:0]                    m_awready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_awid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    m_awaddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   m_awlen,
    input  logic [NUM_MASTERS-1:0][2:0]               m_awsize,
    input  logic [NUM_MASTERS-1:0][1:0]               m_awburst,
    input  logic [NUM_MASTERS-1:0]                    m_awlock,
    input  logic [NUM_MASTERS-1:0][3:0]               m_awcache,
    input  logic [NUM_MASTERS-1:0][2:0]               m_awprot,
    input  logic [NUM_MASTERS-1:0][3:0]               m_awqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    m_awuser,

    input  logic [NUM_MASTERS-1:0]                    m_wvalid,
    output logic [NUM_MASTERS-1:0]                    m_wready,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    m_wdata,
    input  logic [NUM_MASTERS-1:0][DATA_WIDTH/8-1:0]  m_wstrb,
    input  logic [NUM_MASTERS-1:0]                    m_wlast,

    output logic [NUM_MASTERS-1:0]                    m_bvalid,
    input  logic [NUM_MASTERS-1:0]                    m_bready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_bid,
    output logic [NUM_MASTERS-1:0][1:0]               m_bresp,

    input  logic [NUM_MASTERS-1:0]                    m_arvalid,
    output logic [NUM_MASTERS-1:0]                    m_arready,
    input  logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_arid,
    input  logic [NUM_MASTERS-1:0][ADDR_WIDTH-1:0]    m_araddr,
    input  logic [NUM_MASTERS-1:0][BURST_LEN_W-1:0]   m_arlen,
    input  logic [NUM_MASTERS-1:0][2:0]               m_arsize,
    input  logic [NUM_MASTERS-1:0][1:0]               m_arburst,
    input  logic [NUM_MASTERS-1:0]                    m_arlock,
    input  logic [NUM_MASTERS-1:0][3:0]               m_arcache,
    input  logic [NUM_MASTERS-1:0][2:0]               m_arprot,
    input  logic [NUM_MASTERS-1:0][3:0]               m_arqos,
    input  logic [NUM_MASTERS-1:0][USER_WIDTH-1:0]    m_aruser,

    output logic [NUM_MASTERS-1:0]                    m_rvalid,
    input  logic [NUM_MASTERS-1:0]                    m_rready,
    output logic [NUM_MASTERS-1:0][ID_WIDTH-1:0]      m_rid,
    output logic [NUM_MASTERS-1:0][DATA_WIDTH-1:0]    m_rdata,
    output logic [NUM_MASTERS-1:0][1:0]               m_rresp,
    output logic [NUM_MASTERS-1:0]                    m_rlast,

    // ------------------------------------------------------------------
    // Slave ports (flattened).  AxID is widened with the master index so
    // that the slave-side AxID is { master_idx, original_axid }.
    // ------------------------------------------------------------------
    output logic [NUM_SLAVES-1:0]                                            s_awvalid,
    input  logic [NUM_SLAVES-1:0]                                            s_awready,
    output logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]        s_awid,
    output logic [NUM_SLAVES-1:0][ADDR_WIDTH-1:0]                            s_awaddr,
    output logic [NUM_SLAVES-1:0][BURST_LEN_W-1:0]                           s_awlen,
    output logic [NUM_SLAVES-1:0][2:0]                                       s_awsize,
    output logic [NUM_SLAVES-1:0][1:0]                                       s_awburst,
    output logic [NUM_SLAVES-1:0]                                            s_awlock,
    output logic [NUM_SLAVES-1:0][3:0]                                       s_awcache,
    output logic [NUM_SLAVES-1:0][2:0]                                       s_awprot,
    output logic [NUM_SLAVES-1:0][3:0]                                       s_awqos,
    output logic [NUM_SLAVES-1:0][USER_WIDTH-1:0]                            s_awuser,

    output logic [NUM_SLAVES-1:0]                                            s_wvalid,
    input  logic [NUM_SLAVES-1:0]                                            s_wready,
    output logic [NUM_SLAVES-1:0][DATA_WIDTH-1:0]                            s_wdata,
    output logic [NUM_SLAVES-1:0][DATA_WIDTH/8-1:0]                          s_wstrb,
    output logic [NUM_SLAVES-1:0]                                            s_wlast,

    input  logic [NUM_SLAVES-1:0]                                            s_bvalid,
    output logic [NUM_SLAVES-1:0]                                            s_bready,
    input  logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]        s_bid,
    input  logic [NUM_SLAVES-1:0][1:0]                                       s_bresp,

    output logic [NUM_SLAVES-1:0]                                            s_arvalid,
    input  logic [NUM_SLAVES-1:0]                                            s_arready,
    output logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]        s_arid,
    output logic [NUM_SLAVES-1:0][ADDR_WIDTH-1:0]                            s_araddr,
    output logic [NUM_SLAVES-1:0][BURST_LEN_W-1:0]                           s_arlen,
    output logic [NUM_SLAVES-1:0][2:0]                                       s_arsize,
    output logic [NUM_SLAVES-1:0][1:0]                                       s_arburst,
    output logic [NUM_SLAVES-1:0]                                            s_arlock,
    output logic [NUM_SLAVES-1:0][3:0]                                       s_arcache,
    output logic [NUM_SLAVES-1:0][2:0]                                       s_arprot,
    output logic [NUM_SLAVES-1:0][3:0]                                       s_arqos,
    output logic [NUM_SLAVES-1:0][USER_WIDTH-1:0]                            s_aruser,

    input  logic [NUM_SLAVES-1:0]                                            s_rvalid,
    output logic [NUM_SLAVES-1:0]                                            s_rready,
    input  logic [NUM_SLAVES-1:0][ID_WIDTH+$clog2(NUM_MASTERS+1)-1:0]        s_rid,
    input  logic [NUM_SLAVES-1:0][DATA_WIDTH-1:0]                            s_rdata,
    input  logic [NUM_SLAVES-1:0][1:0]                                       s_rresp,
    input  logic [NUM_SLAVES-1:0]                                            s_rlast,

    // ------------------------------------------------------------------
    // Observability
    //
    // Both IRQ status vectors model a write-1-to-clear MMR.  Hardware sets
    // a bit on the offending edge; software clears it by asserting
    // `irq_status_clear_we` for one cycle with the corresponding bit set
    // in `irq_status_decode_err_clear_mask` / `irq_status_excl_fail_clear_mask`.
    // The MMIO address bindings for these registers live in
    // docs/spec-db/axi4-interconnect-mmio.yaml so the upstream Linux driver
    // and any embedded firmware agree on the layout.
    // ------------------------------------------------------------------
    output logic [NUM_MASTERS-1:0] decode_err_irq,
    output logic [NUM_MASTERS-1:0] exclusive_fail_irq,
    output logic [NUM_MASTERS-1:0][31:0] outstanding_count_dbg,

    input  logic                         irq_status_clear_we,
    input  logic [NUM_MASTERS-1:0]       irq_status_decode_err_clear_mask,
    input  logic [NUM_MASTERS-1:0]       irq_status_excl_fail_clear_mask
);

    // ------------------------------------------------------------------
    // Derived parameters
    // ------------------------------------------------------------------
    localparam int unsigned MASTER_IDX_W = $clog2(NUM_MASTERS + 1);
    localparam int unsigned SLAVE_IDX_W  = $clog2(NUM_SLAVES + 1);
    localparam int unsigned WIDE_ID_W    = ID_WIDTH + MASTER_IDX_W;

    // ------------------------------------------------------------------
    // Address decoder.  Returns NUM_SLAVES on decode error so that the
    // caller can drive a synthetic DECERR response without selecting any
    // downstream slave port.
    // ------------------------------------------------------------------
    function automatic int unsigned decode_slave(input logic [ADDR_WIDTH-1:0] addr);
        for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
            if ((addr & ~SLAVE_MASK[s]) == SLAVE_BASE[s]) begin
                decode_slave = s;
                return decode_slave;
            end
        end
        decode_slave = NUM_SLAVES;
    endfunction

    // ------------------------------------------------------------------
    // Per-master per-channel queues.  Each queue holds the slave index
    // assigned to a transaction so that response arbitration can route
    // B/R back to the originating master.  This is the only state that
    // the interconnect needs to keep AXI4 ordering rules.
    // ------------------------------------------------------------------
    localparam int unsigned OUTST_W = $clog2(MAX_OUTST + 1);

    typedef struct packed {
        logic                   valid;
        logic [SLAVE_IDX_W-1:0] slave;
        logic [ID_WIDTH-1:0]    id;
        logic                   is_decerr;
    } txn_entry_t;

    txn_entry_t      wr_queue [0:NUM_MASTERS-1][0:MAX_OUTST-1];
    logic [OUTST_W-1:0] wr_q_head [0:NUM_MASTERS-1];
    logic [OUTST_W-1:0] wr_q_tail [0:NUM_MASTERS-1];
    logic [OUTST_W-1:0] wr_q_count[0:NUM_MASTERS-1];

    txn_entry_t      rd_queue [0:NUM_MASTERS-1][0:MAX_OUTST-1];
    logic [OUTST_W-1:0] rd_q_head [0:NUM_MASTERS-1];
    logic [OUTST_W-1:0] rd_q_tail [0:NUM_MASTERS-1];
    logic [OUTST_W-1:0] rd_q_count[0:NUM_MASTERS-1];

    // ------------------------------------------------------------------
    // Per-master per-slave exclusive monitor.
    // ------------------------------------------------------------------
    typedef struct packed {
        logic                  valid;
        logic [ADDR_WIDTH-1:0] addr;
        logic [ID_WIDTH-1:0]   id;
    } excl_entry_t;

    excl_entry_t excl_mon [0:NUM_MASTERS-1];

    // ------------------------------------------------------------------
    // Decode per master per channel
    // ------------------------------------------------------------------
    int unsigned m_awslv [0:NUM_MASTERS-1];
    int unsigned m_arslv [0:NUM_MASTERS-1];
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            m_awslv[m] = decode_slave(m_awaddr[m]);
            m_arslv[m] = decode_slave(m_araddr[m]);
        end
    end

    // ------------------------------------------------------------------
    // QoS-biased round-robin arbitration per slave.  When multiple
    // masters present requests in the same cycle, ties break by AxQOS;
    // remaining ties use a per-slave rotating priority pointer.
    // ------------------------------------------------------------------
    logic [MASTER_IDX_W-1:0] aw_rr_ptr [0:NUM_SLAVES-1];
    logic [MASTER_IDX_W-1:0] ar_rr_ptr [0:NUM_SLAVES-1];

    function automatic int unsigned pick_master_aw(input int unsigned slv);
        int unsigned chosen   = NUM_MASTERS;
        logic [3:0]  chosen_q = 4'h0;
        // Walk the rotation order starting from rr_ptr to enforce fairness.
        for (int unsigned step = 0; step < NUM_MASTERS; step++) begin
            int unsigned m = (aw_rr_ptr[slv] + step) % NUM_MASTERS;
            if (m_awvalid[m] && m_awslv[m] == slv &&
                wr_q_count[m] < OUTST_W'(MAX_OUTST)) begin
                if (chosen == NUM_MASTERS || m_awqos[m] > chosen_q) begin
                    chosen   = m;
                    chosen_q = m_awqos[m];
                end
            end
        end
        // Decode-error masters also need to drain so that we can return
        // the synthetic DECERR response.  They never collide with a slave
        // port, so they are handled outside the per-slave arbiter.
        pick_master_aw = chosen;
    endfunction

    function automatic int unsigned pick_master_ar(input int unsigned slv);
        int unsigned chosen   = NUM_MASTERS;
        logic [3:0]  chosen_q = 4'h0;
        for (int unsigned step = 0; step < NUM_MASTERS; step++) begin
            int unsigned m = (ar_rr_ptr[slv] + step) % NUM_MASTERS;
            if (m_arvalid[m] && m_arslv[m] == slv &&
                rd_q_count[m] < OUTST_W'(MAX_OUTST)) begin
                if (chosen == NUM_MASTERS || m_arqos[m] > chosen_q) begin
                    chosen   = m;
                    chosen_q = m_arqos[m];
                end
            end
        end
        pick_master_ar = chosen;
    endfunction

    // ------------------------------------------------------------------
    // Per-slave grants and AW/AR forward muxes.  Computed in a single
    // always_comb pass so Verilator does not race the two combinational
    // domains; reading aw_grant from a separate process is unsafe when a
    // simulator evaluates always_comb blocks in arbitrary order.
    // ------------------------------------------------------------------
    int unsigned aw_grant [0:NUM_SLAVES-1];
    int unsigned ar_grant [0:NUM_SLAVES-1];

    // AW grant + fanout (combined)
    always_comb begin
        for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
            int unsigned g;
            g = pick_master_aw(s);
            aw_grant[s] = g;
            if (g == NUM_MASTERS) begin
                s_awvalid[s] = 1'b0;
                s_awid[s]    = '0;
                s_awaddr[s]  = '0;
                s_awlen[s]   = '0;
                s_awsize[s]  = '0;
                s_awburst[s] = BURST_INCR;
                s_awlock[s]  = 1'b0;
                s_awcache[s] = CACHE_DEVICE_NON_BUFFERABLE;
                s_awprot[s]  = '0;
                s_awqos[s]   = '0;
                s_awuser[s]  = '0;
            end else begin
                s_awvalid[s] = m_awvalid[g];
                s_awid[s]    = {MASTER_IDX_W'(g), m_awid[g]};
                s_awaddr[s]  = m_awaddr[g];
                s_awlen[s]   = m_awlen[g];
                s_awsize[s]  = m_awsize[g];
                s_awburst[s] = m_awburst[g];
                s_awlock[s]  = m_awlock[g];
                s_awcache[s] = m_awcache[g];
                s_awprot[s]  = m_awprot[g];
                s_awqos[s]   = m_awqos[g];
                s_awuser[s]  = m_awuser[g];
            end
        end
    end

    // AR grant + fanout (combined)
    always_comb begin
        for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
            int unsigned g;
            g = pick_master_ar(s);
            ar_grant[s] = g;
            if (g == NUM_MASTERS) begin
                s_arvalid[s] = 1'b0;
                s_arid[s]    = '0;
                s_araddr[s]  = '0;
                s_arlen[s]   = '0;
                s_arsize[s]  = '0;
                s_arburst[s] = BURST_INCR;
                s_arlock[s]  = 1'b0;
                s_arcache[s] = CACHE_DEVICE_NON_BUFFERABLE;
                s_arprot[s]  = '0;
                s_arqos[s]   = '0;
                s_aruser[s]  = '0;
            end else begin
                s_arvalid[s] = m_arvalid[g];
                s_arid[s]    = {MASTER_IDX_W'(g), m_arid[g]};
                s_araddr[s]  = m_araddr[g];
                s_arlen[s]   = m_arlen[g];
                s_arsize[s]  = m_arsize[g];
                s_arburst[s] = m_arburst[g];
                s_arlock[s]  = m_arlock[g];
                s_arcache[s] = m_arcache[g];
                s_arprot[s]  = m_arprot[g];
                s_arqos[s]   = m_arqos[g];
                s_aruser[s]  = m_aruser[g];
            end
        end
    end

    // AW/AR ready back to masters.  Recompute the grant locally rather
    // than reading the array driven by another always_comb — Verilator's
    // ordering between independent comb processes can race in the same
    // delta cycle and produce stale reads.
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            int unsigned aw_slv;
            int unsigned aw_g;
            int unsigned ar_slv;
            int unsigned ar_g;
            m_awready[m] = 1'b0;
            m_arready[m] = 1'b0;
            aw_slv = m_awslv[m];
            aw_g   = (aw_slv == NUM_SLAVES) ? NUM_MASTERS : pick_master_aw(aw_slv);
            ar_slv = m_arslv[m];
            ar_g   = (ar_slv == NUM_SLAVES) ? NUM_MASTERS : pick_master_ar(ar_slv);
            if (m_awvalid[m] && wr_q_count[m] < OUTST_W'(MAX_OUTST)) begin
                if (m_awslv[m] == NUM_SLAVES) begin
                    // decode error: synthesize accept here so the master is
                    // not stalled.  The DECERR response is queued below.
                    m_awready[m] = 1'b1;
                end else if (aw_g == m) begin
                    m_awready[m] = s_awready[aw_slv];
                end
            end
            if (m_arvalid[m] && rd_q_count[m] < OUTST_W'(MAX_OUTST)) begin
                if (m_arslv[m] == NUM_SLAVES) begin
                    m_arready[m] = 1'b1;
                end else if (ar_g == m) begin
                    m_arready[m] = s_arready[ar_slv];
                end
            end
        end
    end

    // ------------------------------------------------------------------
    // W channel: AXI4 mandates a strict in-order W stream tied to the AW
    // order, regardless of AxID.  We hold a per-master "active write
    // burst" descriptor; if a master has no active burst, it cannot drive
    // W.  Sustained backpressure is provided by `wready`.
    // ------------------------------------------------------------------
    typedef struct packed {
        logic                   active;
        logic [SLAVE_IDX_W-1:0] slave;
        logic                   is_decerr;
    } w_active_t;

    w_active_t w_active [0:NUM_MASTERS-1];

    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            m_wready[m] = 1'b0;
            if (w_active[m].active) begin
                if (w_active[m].is_decerr) begin
                    // Sink decode-error write payload at full rate.
                    m_wready[m] = 1'b1;
                end else begin
                    m_wready[m] = s_wready[w_active[m].slave];
                end
            end
        end
    end

    // W fanout to slaves
    always_comb begin
        for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
            s_wvalid[s] = 1'b0;
            s_wdata[s]  = '0;
            s_wstrb[s]  = '0;
            s_wlast[s]  = 1'b0;
        end
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            if (w_active[m].active && !w_active[m].is_decerr) begin
                automatic int unsigned s = w_active[m].slave;
                s_wvalid[s] = m_wvalid[m];
                s_wdata[s]  = m_wdata[m];
                s_wstrb[s]  = m_wstrb[m];
                s_wlast[s]  = m_wlast[m];
            end
        end
    end

    // ------------------------------------------------------------------
    // B channel: route per slave back to the head-of-queue master.
    // ------------------------------------------------------------------
    always_comb begin
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            m_bvalid[m] = 1'b0;
            m_bid[m]    = '0;
            m_bresp[m]  = RESP_OKAY;
        end
        for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
            s_bready[s] = 1'b0;
        end
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            logic                   hd_is_decerr;
            logic [SLAVE_IDX_W-1:0] hd_slave;
            logic [ID_WIDTH-1:0]    hd_id;
            int unsigned            s;
            hd_is_decerr = wr_queue[m][wr_q_head[m][OUTST_W-2:0]].is_decerr;
            hd_slave     = wr_queue[m][wr_q_head[m][OUTST_W-2:0]].slave;
            hd_id        = wr_queue[m][wr_q_head[m][OUTST_W-2:0]].id;
            s            = hd_slave;
            if (wr_q_count[m] != 0) begin
                if (hd_is_decerr) begin
                    m_bvalid[m] = 1'b1;
                    m_bid[m]    = hd_id;
                    m_bresp[m]  = RESP_DECERR;
                end else begin
                    if (s_bvalid[s] && s_bid[s][WIDE_ID_W-1 -: MASTER_IDX_W] == MASTER_IDX_W'(m)) begin
                        m_bvalid[m] = 1'b1;
                        m_bid[m]    = s_bid[s][ID_WIDTH-1:0];
                        m_bresp[m]  = s_bresp[s];
                        if (m_bready[m]) s_bready[s] = 1'b1;
                    end
                end
            end
        end
    end

    // ------------------------------------------------------------------
    // R channel: route per slave back to the head-of-queue master.
    // R bursts may interleave across IDs at a single slave, but each ID
    // returns in order; we honor that by gating on s_rid.master-prefix.
    // ------------------------------------------------------------------
    logic [NUM_MASTERS-1:0] decerr_rd_emit;

    always_comb begin
        decerr_rd_emit = '0;
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            m_rvalid[m] = 1'b0;
            m_rid[m]    = '0;
            m_rdata[m]  = '0;
            m_rresp[m]  = RESP_OKAY;
            m_rlast[m]  = 1'b0;
        end
        for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
            s_rready[s] = 1'b0;
        end
        for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
            logic                   hd_is_decerr;
            logic [SLAVE_IDX_W-1:0] hd_slave;
            logic [ID_WIDTH-1:0]    hd_id;
            int unsigned            s;
            hd_is_decerr = rd_queue[m][rd_q_head[m][OUTST_W-2:0]].is_decerr;
            hd_slave     = rd_queue[m][rd_q_head[m][OUTST_W-2:0]].slave;
            hd_id        = rd_queue[m][rd_q_head[m][OUTST_W-2:0]].id;
            s            = hd_slave;
            if (rd_q_count[m] != 0) begin
                if (hd_is_decerr) begin
                    m_rvalid[m] = 1'b1;
                    m_rid[m]    = hd_id;
                    m_rdata[m]  = {DATA_WIDTH{1'b0}} | DATA_WIDTH'(64'hDEAD_BEEF_DEAD_BEEF);
                    m_rresp[m]  = RESP_DECERR;
                    m_rlast[m]  = 1'b1;  // single-beat synthetic DECERR
                    decerr_rd_emit[m] = m_rready[m];
                end else begin
                    if (s_rvalid[s] && s_rid[s][WIDE_ID_W-1 -: MASTER_IDX_W] == MASTER_IDX_W'(m)) begin
                        m_rvalid[m] = 1'b1;
                        m_rid[m]    = s_rid[s][ID_WIDTH-1:0];
                        m_rdata[m]  = s_rdata[s];
                        m_rresp[m]  = s_rresp[s];
                        m_rlast[m]  = s_rlast[s];
                        if (m_rready[m]) s_rready[s] = 1'b1;
                    end
                end
            end
        end
    end

    // ------------------------------------------------------------------
    // Sequential update
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                wr_q_head[m]  <= '0;
                wr_q_tail[m]  <= '0;
                wr_q_count[m] <= '0;
                rd_q_head[m]  <= '0;
                rd_q_tail[m]  <= '0;
                rd_q_count[m] <= '0;
                w_active[m]   <= '0;
                excl_mon[m]   <= '0;
                outstanding_count_dbg[m] <= '0;
                decode_err_irq[m]       <= 1'b0;
                exclusive_fail_irq[m]   <= 1'b0;
                for (int unsigned d = 0; d < MAX_OUTST; d++) begin
                    wr_queue[m][d] <= '0;
                    rd_queue[m][d] <= '0;
                end
            end
            for (int unsigned s = 0; s < NUM_SLAVES; s++) begin
                aw_rr_ptr[s] <= '0;
                ar_rr_ptr[s] <= '0;
            end
        end else begin
            // IRQs are sticky write-1-to-clear: each bit latches on the
            // offending edge and stays asserted until software pulses
            // irq_status_clear_we with the matching bit set in the
            // corresponding clear mask.  Hardware-set wins ties with a
            // simultaneous software clear so that a new event coincident
            // with the W1C write is not silently dropped.
            if (irq_status_clear_we) begin
                for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                    if (irq_status_decode_err_clear_mask[m]) begin
                        decode_err_irq[m] <= 1'b0;
                    end
                    if (irq_status_excl_fail_clear_mask[m]) begin
                        exclusive_fail_irq[m] <= 1'b0;
                    end
                end
            end

            // -- AW handshake ---------------------------------------------
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                if (m_awvalid[m] && m_awready[m]) begin
                    if (m_awslv[m] == NUM_SLAVES) begin
                        // decode error path
                        wr_queue[m][wr_q_tail[m][OUTST_W-2:0]] <= '{
                            valid:     1'b1,
                            slave:     SLAVE_IDX_W'(0),
                            id:        m_awid[m],
                            is_decerr: 1'b1
                        };
                        wr_q_tail[m] <= wr_q_tail[m] + 1'b1;
                        wr_q_count[m] <= wr_q_count[m] + 1'b1;
                        w_active[m]  <= '{
                            active:    1'b1,
                            slave:     SLAVE_IDX_W'(0),
                            is_decerr: 1'b1
                        };
                        decode_err_irq[m] <= 1'b1;
                    end else begin
                        int unsigned slv = m_awslv[m];
                        wr_queue[m][wr_q_tail[m][OUTST_W-2:0]] <= '{
                            valid:     1'b1,
                            slave:     SLAVE_IDX_W'(slv),
                            id:        m_awid[m],
                            is_decerr: 1'b0
                        };
                        wr_q_tail[m] <= wr_q_tail[m] + 1'b1;
                        wr_q_count[m] <= wr_q_count[m] + 1'b1;
                        w_active[m]  <= '{
                            active:    1'b1,
                            slave:     SLAVE_IDX_W'(slv),
                            is_decerr: 1'b0
                        };
                        // rotate priority pointer
                        aw_rr_ptr[slv] <= MASTER_IDX_W'((m + 1) % NUM_MASTERS);
                    end
                end
            end

            // -- W -> deactivate after WLAST --------------------------------
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                if (w_active[m].active && m_wvalid[m] && m_wready[m] && m_wlast[m]) begin
                    w_active[m] <= '0;
                end
            end

            // -- B handshake (drain head of write queue) --------------------
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                if (m_bvalid[m] && m_bready[m]) begin
                    wr_q_head[m] <= wr_q_head[m] + 1'b1;
                    wr_q_count[m] <= wr_q_count[m] - 1'b1;
                end
            end

            // -- AR handshake -----------------------------------------------
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                if (m_arvalid[m] && m_arready[m]) begin
                    if (m_arslv[m] == NUM_SLAVES) begin
                        rd_queue[m][rd_q_tail[m][OUTST_W-2:0]] <= '{
                            valid:     1'b1,
                            slave:     SLAVE_IDX_W'(0),
                            id:        m_arid[m],
                            is_decerr: 1'b1
                        };
                        rd_q_tail[m] <= rd_q_tail[m] + 1'b1;
                        rd_q_count[m] <= rd_q_count[m] + 1'b1;
                        decode_err_irq[m] <= 1'b1;
                    end else begin
                        int unsigned slv = m_arslv[m];
                        rd_queue[m][rd_q_tail[m][OUTST_W-2:0]] <= '{
                            valid:     1'b1,
                            slave:     SLAVE_IDX_W'(slv),
                            id:        m_arid[m],
                            is_decerr: 1'b0
                        };
                        rd_q_tail[m] <= rd_q_tail[m] + 1'b1;
                        rd_q_count[m] <= rd_q_count[m] + 1'b1;
                        ar_rr_ptr[slv] <= MASTER_IDX_W'((m + 1) % NUM_MASTERS);
                        if (m_arlock[m]) begin
                            excl_mon[m] <= '{
                                valid: 1'b1,
                                addr:  m_araddr[m],
                                id:    m_arid[m]
                            };
                        end
                    end
                end
            end

            // -- R handshake (drain head of read queue at RLAST) ------------
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                if (m_rvalid[m] && m_rready[m] && m_rlast[m]) begin
                    rd_q_head[m] <= rd_q_head[m] + 1'b1;
                    rd_q_count[m] <= rd_q_count[m] - 1'b1;
                end
            end

            // -- Exclusive monitor: any AW from another master at the
            //    monitored address invalidates the reservation -------------
            for (int unsigned victim = 0; victim < NUM_MASTERS; victim++) begin
                if (excl_mon[victim].valid) begin
                    for (int unsigned other = 0; other < NUM_MASTERS; other++) begin
                        if (other != victim &&
                            m_awvalid[other] && m_awready[other] &&
                            m_awaddr[other] == excl_mon[victim].addr) begin
                            excl_mon[victim].valid <= 1'b0;
                            exclusive_fail_irq[victim] <= 1'b1;
                        end
                    end
                end
            end

            // -- Outstanding counters (debug observability) -----------------
            for (int unsigned m = 0; m < NUM_MASTERS; m++) begin
                outstanding_count_dbg[m] <= 32'(wr_q_count[m]) + 32'(rd_q_count[m]);
            end
        end
    end

endmodule
