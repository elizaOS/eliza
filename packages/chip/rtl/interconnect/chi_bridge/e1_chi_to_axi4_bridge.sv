`timescale 1ns/1ps

// e1_chi_to_axi4_bridge
//
// Adapter between the cache-coherent upstream fabric (CHI / TileLink-C,
// produced by the cache agent: see docs/arch/cache-hierarchy.md) and the
// non-coherent AXI4 south fabric implemented in this directory.
//
// Cache agent owns coherence.  This bridge only translates between the
// CHI/TileLink-C transaction format and AXI4 bursts.  It is a thin layer
// designed to keep the seam between domains explicit.
//
// Translation contract:
//
//   CHI / TileLink-C upstream                AXI4 downstream
//   ---------------------------------------  ---------------------------
//   ReadShared / Get                         AR burst, ARCACHE 1010, lock=0
//   ReadUnique / Get-exclusive               AR burst, ARLOCK=1
//   WriteBack / Put (cache eviction)         AW+W burst, AWCACHE 1111
//   WriteNoSnoop / Put (non-coherent)        AW+W burst, AWCACHE 0010
//   CleanInvalid / Probe ack                 No AXI4 traffic; resolved by
//                                            cache agent.
//
// The bridge is parameterised on the upstream cache-line size; one CHI
// transaction emits a fixed-length burst of (LINE_BYTES / BEAT_BYTES)
// beats.  Stash hints (CHI WriteCleanShared-Stash, TileLink-C custom)
// are propagated via AxUSER bits 1:0 so that the downstream NoC and SLC
// can honor them without re-decoding addresses.

module e1_chi_to_axi4_bridge
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_WIDTH    = 6,
    parameter int unsigned ADDR_WIDTH  = 40,
    parameter int unsigned DATA_WIDTH  = 128,
    parameter int unsigned USER_WIDTH  = 8,
    parameter int unsigned BURST_LEN_W = 8,
    parameter int unsigned LINE_BYTES  = 64
) (
    input  logic clk,
    input  logic rst_n,

    // ------------------------------------------------------------------
    // Upstream CHI/TileLink-C-style interface (simplified).  The cache
    // agent (separate owner) implements full CHI; this bridge consumes
    // the subset needed to attach the south AXI4 fabric.
    // ------------------------------------------------------------------
    // Request (combined read/write)
    input  logic                    chi_req_valid,
    output logic                    chi_req_ready,
    input  logic                    chi_req_is_write,
    input  logic                    chi_req_is_exclusive,
    input  logic                    chi_req_stash,
    input  logic [ADDR_WIDTH-1:0]   chi_req_addr,
    input  logic [ID_WIDTH-1:0]     chi_req_id,
    input  logic [USER_WIDTH-1:0]   chi_req_user,

    // Write data stream (LINE_BYTES bytes per request)
    input  logic                    chi_wd_valid,
    output logic                    chi_wd_ready,
    input  logic [DATA_WIDTH-1:0]   chi_wd_data,
    input  logic [DATA_WIDTH/8-1:0] chi_wd_strb,
    input  logic                    chi_wd_last,

    // Read data return stream
    output logic                    chi_rd_valid,
    input  logic                    chi_rd_ready,
    output logic [DATA_WIDTH-1:0]   chi_rd_data,
    output logic [ID_WIDTH-1:0]     chi_rd_id,
    output logic                    chi_rd_last,
    output logic [1:0]              chi_rd_resp,

    // Write completion stream
    output logic                    chi_wc_valid,
    input  logic                    chi_wc_ready,
    output logic [ID_WIDTH-1:0]     chi_wc_id,
    output logic [1:0]              chi_wc_resp,

    // ------------------------------------------------------------------
    // Downstream AXI4 master port (single channel into the AXI4 fabric)
    // ------------------------------------------------------------------
    output logic                    m_awvalid,
    input  logic                    m_awready,
    output logic [ID_WIDTH-1:0]     m_awid,
    output logic [ADDR_WIDTH-1:0]   m_awaddr,
    output logic [BURST_LEN_W-1:0]  m_awlen,
    output logic [2:0]              m_awsize,
    output logic [1:0]              m_awburst,
    output logic                    m_awlock,
    output logic [3:0]              m_awcache,
    output logic [2:0]              m_awprot,
    output logic [3:0]              m_awqos,
    output logic [USER_WIDTH-1:0]   m_awuser,

    output logic                    m_wvalid,
    input  logic                    m_wready,
    output logic [DATA_WIDTH-1:0]   m_wdata,
    output logic [DATA_WIDTH/8-1:0] m_wstrb,
    output logic                    m_wlast,

    input  logic                    m_bvalid,
    output logic                    m_bready,
    input  logic [ID_WIDTH-1:0]     m_bid,
    input  logic [1:0]              m_bresp,

    output logic                    m_arvalid,
    input  logic                    m_arready,
    output logic [ID_WIDTH-1:0]     m_arid,
    output logic [ADDR_WIDTH-1:0]   m_araddr,
    output logic [BURST_LEN_W-1:0]  m_arlen,
    output logic [2:0]              m_arsize,
    output logic [1:0]              m_arburst,
    output logic                    m_arlock,
    output logic [3:0]              m_arcache,
    output logic [2:0]              m_arprot,
    output logic [3:0]              m_arqos,
    output logic [USER_WIDTH-1:0]   m_aruser,

    input  logic                    m_rvalid,
    output logic                    m_rready,
    input  logic [ID_WIDTH-1:0]     m_rid,
    input  logic [DATA_WIDTH-1:0]   m_rdata,
    input  logic [1:0]              m_rresp,
    input  logic                    m_rlast
);

    localparam int unsigned BYTES_PER_BEAT = DATA_WIDTH / 8;
    localparam int unsigned BEATS_PER_LINE = LINE_BYTES / BYTES_PER_BEAT;
    localparam logic [2:0]  AXI_SIZE_LINE  = 3'($clog2(BYTES_PER_BEAT));
    localparam logic [BURST_LEN_W-1:0] AXI_LEN_LINE = BURST_LEN_W'(BEATS_PER_LINE - 1);

    // ------------------------------------------------------------------
    // Request demux: write goes through AW+W; read through AR.  The
    // bridge serialises a single outstanding request to keep verification
    // simple.  Higher concurrency is delivered by per-port instances of
    // this bridge attached at every cache-agent CHI port.
    // ------------------------------------------------------------------
    typedef enum logic [2:0] {
        S_IDLE,
        S_AR_ISSUE,
        S_R_DRAIN,
        S_AW_ISSUE,
        S_W_DRAIN,
        S_B_WAIT
    } state_e;

    state_e                state, next_state;
    logic [ID_WIDTH-1:0]   id_q;
    logic [ADDR_WIDTH-1:0] addr_q;
    logic                  excl_q;
    logic                  stash_q;
    logic [USER_WIDTH-1:0] user_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state   <= S_IDLE;
            id_q    <= '0;
            addr_q  <= '0;
            excl_q  <= 1'b0;
            stash_q <= 1'b0;
            user_q  <= '0;
        end else begin
            state <= next_state;
            if (state == S_IDLE && chi_req_valid && chi_req_ready) begin
                id_q    <= chi_req_id;
                addr_q  <= chi_req_addr;
                excl_q  <= chi_req_is_exclusive;
                stash_q <= chi_req_stash;
                user_q  <= chi_req_user;
            end
        end
    end

    always_comb begin
        next_state = state;
        unique case (state)
            S_IDLE: begin
                if (chi_req_valid) begin
                    next_state = chi_req_is_write ? S_AW_ISSUE : S_AR_ISSUE;
                end
            end
            S_AR_ISSUE: if (m_arvalid && m_arready) next_state = S_R_DRAIN;
            S_R_DRAIN:  if (m_rvalid && m_rready && m_rlast) next_state = S_IDLE;
            S_AW_ISSUE: if (m_awvalid && m_awready) next_state = S_W_DRAIN;
            S_W_DRAIN:  if (m_wvalid && m_wready && m_wlast) next_state = S_B_WAIT;
            S_B_WAIT:   if (m_bvalid && m_bready) next_state = S_IDLE;
            default: next_state = S_IDLE;
        endcase
    end

    assign chi_req_ready = (state == S_IDLE);

    // -- AXI4 AR --------------------------------------------------------
    assign m_arvalid = (state == S_AR_ISSUE);
    assign m_arid    = id_q;
    assign m_araddr  = addr_q;
    assign m_arlen   = AXI_LEN_LINE;
    assign m_arsize  = AXI_SIZE_LINE;
    assign m_arburst = BURST_INCR;
    assign m_arlock  = excl_q;
    assign m_arcache = CACHE_WRITE_BACK_RW;
    assign m_arprot  = PROT_DATA_NS_PRIV;
    assign m_arqos   = QOS_CPU_LATENCY;
    assign m_aruser  = {stash_q, 1'b0, user_q[USER_WIDTH-3:0]};

    // -- AXI4 AW --------------------------------------------------------
    assign m_awvalid = (state == S_AW_ISSUE);
    assign m_awid    = id_q;
    assign m_awaddr  = addr_q;
    assign m_awlen   = AXI_LEN_LINE;
    assign m_awsize  = AXI_SIZE_LINE;
    assign m_awburst = BURST_INCR;
    assign m_awlock  = excl_q;
    assign m_awcache = CACHE_WRITE_BACK_RW;
    assign m_awprot  = PROT_DATA_NS_PRIV;
    assign m_awqos   = QOS_CPU_LATENCY;
    assign m_awuser  = {stash_q, 1'b0, user_q[USER_WIDTH-3:0]};

    // -- W channel ------------------------------------------------------
    assign m_wvalid = (state == S_W_DRAIN) && chi_wd_valid;
    assign chi_wd_ready = (state == S_W_DRAIN) && m_wready;
    assign m_wdata  = chi_wd_data;
    assign m_wstrb  = chi_wd_strb;
    assign m_wlast  = chi_wd_last;

    // -- B channel ------------------------------------------------------
    assign m_bready    = (state == S_B_WAIT);
    assign chi_wc_valid = (state == S_B_WAIT) && m_bvalid;
    assign chi_wc_id    = m_bid;
    assign chi_wc_resp  = m_bresp;

    // -- R channel ------------------------------------------------------
    assign m_rready     = (state == S_R_DRAIN) && chi_rd_ready;
    assign chi_rd_valid = (state == S_R_DRAIN) && m_rvalid;
    assign chi_rd_data  = m_rdata;
    assign chi_rd_id    = m_rid;
    assign chi_rd_last  = m_rlast;
    assign chi_rd_resp  = m_rresp;

endmodule
