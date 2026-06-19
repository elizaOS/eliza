`timescale 1ns/1ps

// e1_dma_sg
//
// Descriptor-based scatter-gather DMA engine with a full AXI4 master data
// mover.  Software programs a memory-resident descriptor ring head pointer and
// kicks the engine; the engine fetches each 32-byte descriptor over AXI4,
// executes a byte-accurate copy from src to dst using INCR bursts (with
// unaligned head/tail handling and byte strobes), writes a completion status
// word back into the descriptor, raises a per-descriptor completion interrupt
// when requested, and walks the `next` link until the chain ends.
//
// This is the production-direction successor to the AXI-Lite word-copy engine
// in e1_dma.sv.  It is a single AXI4 master (one outstanding burst per
// direction) and is fully synthesizable.  AXI SLVERR/DECERR on any beat sets
// the descriptor error status, raises the error interrupt, and halts the chain
// fail-closed -- it never reports a silent partial transfer as success.
//
// Descriptor ABI (little-endian, 32-byte / 8-word descriptors, 4-byte aligned
// chain pointers; see DESC_* offsets below):
//
//   +0x00  src_addr   source byte address
//   +0x04  dst_addr   destination byte address
//   +0x08  length     transfer length in bytes
//   +0x0C  flags      [0] OWN   (1 = engine owns / descriptor valid)
//                     [1] IRQ   (1 = raise completion IRQ after this descriptor)
//                     [2] LAST  (1 = last descriptor; ignore next_addr)
//   +0x10  next_addr  byte address of next descriptor (when !LAST)
//   +0x14  status     completion writeback (engine -> memory):
//                     [0] DONE  [1] ERR  [9:8] err_code (1=rd,2=wr,3=desc)
//   +0x18  resv0      reserved (read, ignored)
//   +0x1C  resv1      reserved (read, ignored)
//
// MMIO register map (word index on `addr`, 32-bit data):
//   0x00 RING_HEAD   first descriptor byte address
//   0x01 CTRL        W: [0] START (load RING_HEAD, run chain)
//                       [1] IRQ_CLR (W1C of done/err latched IRQ status)
//   0x02 STATUS      R: [0] BUSY [1] DONE [2] ERR [3] IRQ (latched, level)
//                       [9:8] err_code  [10] chain_complete
//   0x03 IRQ_EN      [0] enable done IRQ  [1] enable error IRQ
//   0x04 AXCACHE     [3:0] ARCACHE/AWCACHE attribute driven on the bus
//   0x05 CUR_DESC    R: address of the descriptor currently/last processed
//   0x06 DESC_DONE   R: count of descriptors completed OK
//   0x07 BYTES_DONE  R: total bytes moved across the chain
//   0x08 ERR_COUNT   R: count of error events
//   0x09 ERR_CODE    R: last error code (1=rd 2=wr 3=desc)
//   0x0A STATE       R: [3:0] FSM state (debug)

module e1_dma_sg #(
    parameter int unsigned ADDR_W      = 32,
    parameter int unsigned DATA_W      = 32,
    // Max AXI4 INCR burst length in beats (AxLEN = MAX_BEATS-1). 16 keeps the
    // engine inside the AXI3-compatible 4-bit AxLEN subset used by the local
    // interconnect while still amortizing address-phase overhead.
    parameter int unsigned MAX_BEATS   = 16
) (
    input  logic              clk,
    input  logic              rst_n,

    // Software register port (same lightweight MMIO shape as e1_dma).
    input  logic              valid,
    input  logic              write,
    input  logic [5:0]        addr,
    input  logic [31:0]       wdata,
    output logic [31:0]       rdata,
    output logic              irq,

    // AXI4 master -- read channel
    output logic              m_arvalid,
    input  logic              m_arready,
    output logic [ADDR_W-1:0] m_araddr,
    output logic [7:0]        m_arlen,
    output logic [2:0]        m_arsize,
    output logic [1:0]        m_arburst,
    output logic [3:0]        m_arcache,
    output logic [2:0]        m_arprot,
    input  logic              m_rvalid,
    output logic              m_rready,
    input  logic [DATA_W-1:0] m_rdata,
    input  logic              m_rlast,
    input  logic [1:0]        m_rresp,

    // AXI4 master -- write channel
    output logic              m_awvalid,
    input  logic              m_awready,
    output logic [ADDR_W-1:0] m_awaddr,
    output logic [7:0]        m_awlen,
    output logic [2:0]        m_awsize,
    output logic [1:0]        m_awburst,
    output logic [3:0]        m_awcache,
    output logic [2:0]        m_awprot,
    output logic              m_wvalid,
    input  logic              m_wready,
    output logic [DATA_W-1:0] m_wdata,
    output logic [DATA_W/8-1:0] m_wstrb,
    output logic              m_wlast,
    input  logic              m_bvalid,
    output logic              m_bready,
    input  logic [1:0]        m_bresp
);
    import e1_axi4_pkg::*;

    localparam int unsigned BYTES_PER_BEAT = DATA_W / 8;
    localparam logic [2:0]  AXSIZE_BEAT    = (DATA_W == 32) ? SIZE_4B :
                                             (DATA_W == 64) ? SIZE_8B : SIZE_4B;

    // Descriptor word offsets (byte offsets in the 32-byte descriptor).
    localparam logic [ADDR_W-1:0] DESC_SRC    = 32'h00;
    localparam logic [ADDR_W-1:0] DESC_DST    = 32'h04;
    localparam logic [ADDR_W-1:0] DESC_LEN    = 32'h08;
    localparam logic [ADDR_W-1:0] DESC_FLAGS  = 32'h0C;
    localparam logic [ADDR_W-1:0] DESC_NEXT   = 32'h10;
    localparam logic [ADDR_W-1:0] DESC_STATUS = 32'h14;
    localparam int unsigned       DESC_WORDS  = 8;  // 32-byte descriptor

    localparam logic FLAG_OWN  = 1'b1;
    localparam int   FLAG_OWN_BIT  = 0;
    localparam int   FLAG_IRQ_BIT  = 1;
    localparam int   FLAG_LAST_BIT = 2;

    localparam logic [1:0] ERR_NONE = 2'd0;
    localparam logic [1:0] ERR_RD   = 2'd1;
    localparam logic [1:0] ERR_WR   = 2'd2;
    localparam logic [1:0] ERR_DESC = 2'd3;

    // FSM states.
    typedef enum logic [4:0] {
        S_IDLE,        // waiting for START
        S_DFETCH_AR,   // issue descriptor read address
        S_DFETCH_R,    // collect descriptor beats
        S_DECODE,      // interpret descriptor
        S_RD_AR,       // issue payload read address
        S_RD_R,        // collect payload read beats into the realign buffer
        S_WR_AW,       // issue payload write address
        S_WR_W,        // stream payload write beats
        S_WR_B,        // collect write response
        S_SB_AW,       // status writeback address
        S_SB_W,        // status writeback data
        S_SB_B,        // status writeback response
        S_NEXT,        // advance to next descriptor / finish
        S_ERROR,       // fail-closed: latch error, write status, stop chain
        S_ERR_SB_AW,   // error-status writeback address
        S_ERR_SB_W,    // error-status writeback data
        S_ERR_SB_B     // error-status writeback response
    } state_e;

    state_e state;

    // --- software-visible registers ---
    logic [ADDR_W-1:0] ring_head;
    logic [3:0]        axcache;
    logic [1:0]        irq_en;       // [0] done, [1] error
    logic              st_busy;
    logic              st_done;
    logic              st_err;
    logic              st_irq;       // latched IRQ status (level)
    logic              st_chain_done;
    logic [1:0]        st_errcode;
    logic [ADDR_W-1:0] cur_desc;
    logic [31:0]       desc_done_cnt;
    logic [31:0]       bytes_done_cnt;
    logic [31:0]       err_cnt;

    // --- descriptor fetch buffer ---
    logic [31:0]              desc_word [DESC_WORDS];
    logic [$clog2(DESC_WORDS):0] dfetch_idx;

    // Decoded descriptor fields.
    logic [ADDR_W-1:0] d_src;
    logic [ADDR_W-1:0] d_dst;
    logic [ADDR_W-1:0] d_len;
    logic [31:0]       d_flags;
    logic [ADDR_W-1:0] d_next;

    // --- byte-accurate copy engine state ---
    // The copy is decomposed into bursts.  Each burst moves up to MAX_BEATS
    // beats of a word-aligned window; sub-word head/tail is handled by byte
    // strobes derived from the absolute src/dst byte offsets.  src and dst may
    // have different sub-word alignment, so reads are realigned to dst lanes in
    // a small per-burst byte buffer before being written.
    logic [ADDR_W-1:0] cur_src;       // current src byte address
    logic [ADDR_W-1:0] cur_dst;       // current dst byte address
    logic [ADDR_W-1:0] remaining;     // bytes left in this descriptor
    logic [31:0]       desc_bytes;    // total bytes for the descriptor

    // Per-burst working set (sized for the worst case: a window spanning
    // MAX_BEATS dst-aligned beats).
    localparam int unsigned BUF_BYTES = MAX_BEATS * BYTES_PER_BEAT;
    logic [7:0]        copybuf [BUF_BYTES];
    logic [ADDR_W-1:0] burst_bytes;    // bytes this burst will move
    logic [ADDR_W-1:0] rd_base;        // word-aligned src base for read burst
    logic [ADDR_W-1:0] wr_base;        // word-aligned dst base for write burst
    logic [8:0]        rd_beats;       // read beats this burst (1..MAX_BEATS)
    logic [8:0]        wr_beats;       // write beats this burst (1..MAX_BEATS)
    logic [8:0]        rd_idx;         // read beat counter
    logic [8:0]        wr_idx;         // write beat counter
    logic [ADDR_W-1:0] src_off;        // cur_src - rd_base (0..3)
    logic [ADDR_W-1:0] dst_off;        // cur_dst - wr_base (0..3)
    logic [ADDR_W-1:0] burst_first;    // first dst byte index relative to wr_base
    logic [ADDR_W-1:0] burst_last;     // last dst byte index (exclusive) relative to wr_base

    // Status writeback scratch.
    logic [31:0]       sb_status;

    // --- AXI handshake helpers ---
    wire ar_fire = m_arvalid && m_arready;
    wire r_fire  = m_rvalid  && m_rready;
    wire aw_fire = m_awvalid && m_awready;
    wire w_fire  = m_wvalid  && m_wready;
    wire b_fire  = m_bvalid  && m_bready;

    // START / clear decode on the register port.
    wire reg_we     = valid && write;
    wire start_req  = reg_we && (addr == 6'h01) && wdata[0] && !st_busy;
    wire irqclr_req = reg_we && (addr == 6'h01) && wdata[1];

    // ------------------------------------------------------------------
    // Combinational per-burst geometry.
    //
    // Given cur_src/cur_dst/remaining we compute the next read burst (aligned
    // to the src word containing cur_src) and write burst (aligned to the dst
    // word containing cur_dst).  Both bursts cover the same `burst_bytes`
    // payload window; their beat counts differ only by the head/tail alignment
    // of each address.
    // ------------------------------------------------------------------
    logic [ADDR_W-1:0] c_src_off;
    logic [ADDR_W-1:0] c_dst_off;
    logic [ADDR_W-1:0] c_rd_base;
    logic [ADDR_W-1:0] c_wr_base;
    logic [ADDR_W-1:0] c_burst_bytes;
    logic [8:0]        c_rd_beats;
    logic [8:0]        c_wr_beats;

    always_comb begin
        c_src_off = {{(ADDR_W-2){1'b0}}, cur_src[1:0]};
        c_dst_off = {{(ADDR_W-2){1'b0}}, cur_dst[1:0]};
        c_rd_base = cur_src & ~{{(ADDR_W-2){1'b0}}, 2'b11};
        c_wr_base = cur_dst & ~{{(ADDR_W-2){1'b0}}, 2'b11};

        // Cap payload by remaining and by what fits in MAX_BEATS dst-aligned
        // beats (the dst window can need one extra head beat, so the usable
        // payload is bounded by the dst geometry, which is the tighter side).
        if (remaining > (BUF_BYTES - c_dst_off)) begin
            c_burst_bytes = BUF_BYTES - c_dst_off;
        end else begin
            c_burst_bytes = remaining;
        end

        // Beat counts: ceil((offset + bytes)/BYTES_PER_BEAT).
        c_rd_beats = 9'((c_src_off + c_burst_bytes + (BYTES_PER_BEAT-1)) /
                        BYTES_PER_BEAT);
        c_wr_beats = 9'((c_dst_off + c_burst_bytes + (BYTES_PER_BEAT-1)) /
                        BYTES_PER_BEAT);
    end

    // ------------------------------------------------------------------
    // AXI output drivers (combinational, qualified by state).
    // ------------------------------------------------------------------
    logic [ADDR_W-1:0] ar_addr_d;
    logic [7:0]        ar_len_d;
    logic [ADDR_W-1:0] aw_addr_d;
    logic [7:0]        aw_len_d;

    always_comb begin
        // Defaults.
        ar_addr_d = '0;
        ar_len_d  = '0;
        aw_addr_d = '0;
        aw_len_d  = '0;

        unique case (state)
            S_DFETCH_AR: begin
                ar_addr_d = cur_desc;
                ar_len_d  = 8'(DESC_WORDS - 1);
            end
            S_RD_AR: begin
                // Present the combinational burst geometry; it is latched into
                // rd_base/rd_beats on AR handshake for use during S_RD_R.
                ar_addr_d = c_rd_base;
                ar_len_d  = 8'(c_rd_beats - 9'd1);
            end
            S_WR_AW: begin
                aw_addr_d = wr_base;
                aw_len_d  = 8'(wr_beats - 9'd1);
            end
            S_SB_AW, S_ERR_SB_AW: begin
                aw_addr_d = cur_desc + DESC_STATUS;
                aw_len_d  = 8'd0;
            end
            default: begin end
        endcase
    end

    assign m_arvalid = (state == S_DFETCH_AR) || (state == S_RD_AR);
    assign m_araddr  = ar_addr_d;
    assign m_arlen   = ar_len_d;
    assign m_arsize  = AXSIZE_BEAT;
    assign m_arburst = BURST_INCR;
    assign m_arcache = axcache;
    assign m_arprot  = PROT_DATA_NS_PRIV;
    assign m_rready  = (state == S_DFETCH_R) || (state == S_RD_R);

    assign m_awvalid = (state == S_WR_AW) || (state == S_SB_AW) ||
                       (state == S_ERR_SB_AW);
    assign m_awaddr  = aw_addr_d;
    assign m_awlen   = aw_len_d;
    assign m_awsize  = AXSIZE_BEAT;
    assign m_awburst = BURST_INCR;
    assign m_awcache = axcache;
    assign m_awprot  = PROT_DATA_NS_PRIV;

    // Write-data lane assembly for the payload write burst.
    logic [DATA_W-1:0]      wr_word;
    logic [DATA_W/8-1:0]    wr_strb;
    always_comb begin
        wr_word = '0;
        wr_strb = '0;
        // Byte b of this beat maps to dst byte index = wr_idx*BPB + b, which is
        // copybuf index relative to wr_base.  A byte is valid only if it lies
        // within [burst_first, burst_last).
        for (int b = 0; b < BYTES_PER_BEAT; b++) begin
            automatic logic [ADDR_W-1:0] bi =
                (wr_idx * BYTES_PER_BEAT) + b[ADDR_W-1:0];
            if ((bi >= burst_first) && (bi < burst_last)) begin
                wr_word[b*8 +: 8] = copybuf[bi];
                wr_strb[b]        = 1'b1;
            end
        end
    end

    wire sb_phase = (state == S_SB_W) || (state == S_ERR_SB_W);
    assign m_wvalid = (state == S_WR_W) || sb_phase;
    assign m_wdata  = sb_phase ? {{(DATA_W-32){1'b0}}, sb_status} : wr_word;
    assign m_wstrb  = sb_phase ? {{(DATA_W/8-4){1'b0}}, 4'hF} : wr_strb;
    assign m_wlast  = sb_phase ? 1'b1 : (wr_idx == (wr_beats - 9'd1));
    assign m_bready = (state == S_WR_B) || (state == S_SB_B) ||
                      (state == S_ERR_SB_B);

    assign irq = st_irq;

    // ------------------------------------------------------------------
    // Sequential engine.
    // ------------------------------------------------------------------
    logic [1:0] pending_err;  // error code captured before status writeback

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state          <= S_IDLE;
            ring_head      <= '0;
            axcache        <= CACHE_NORMAL_NON_CACHEABLE;
            irq_en         <= 2'b11;
            st_busy        <= 1'b0;
            st_done        <= 1'b0;
            st_err         <= 1'b0;
            st_irq         <= 1'b0;
            st_chain_done  <= 1'b0;
            st_errcode     <= ERR_NONE;
            cur_desc       <= '0;
            desc_done_cnt  <= '0;
            bytes_done_cnt <= '0;
            err_cnt        <= '0;
            dfetch_idx     <= '0;
            cur_src        <= '0;
            cur_dst        <= '0;
            remaining      <= '0;
            desc_bytes     <= '0;
            rd_idx         <= '0;
            wr_idx         <= '0;
            pending_err    <= ERR_NONE;
            for (int i = 0; i < DESC_WORDS; i++) desc_word[i] <= '0;
        end else begin
            // W1C of the latched IRQ + done/err status.
            if (irqclr_req) begin
                st_irq  <= 1'b0;
                st_done <= 1'b0;
                st_err  <= 1'b0;
            end

            unique case (state)
                // --------------------------------------------------------
                S_IDLE: begin
                    if (start_req) begin
                        st_busy       <= 1'b1;
                        st_done       <= 1'b0;
                        st_err        <= 1'b0;
                        st_chain_done <= 1'b0;
                        st_errcode    <= ERR_NONE;
                        desc_done_cnt <= '0;
                        bytes_done_cnt<= '0;
                        cur_desc      <= ring_head;
                        dfetch_idx    <= '0;
                        state         <= S_DFETCH_AR;
                    end
                end

                // --------------------------------------------------------
                // Fetch the 32-byte descriptor as one INCR read burst.
                S_DFETCH_AR: begin
                    if (ar_fire) begin
                        dfetch_idx <= '0;
                        state      <= S_DFETCH_R;
                    end
                end
                S_DFETCH_R: begin
                    if (r_fire) begin
                        if (m_rresp != RESP_OKAY) begin
                            pending_err <= ERR_DESC;
                            state       <= S_ERROR;
                        end else begin
                            desc_word[dfetch_idx[$clog2(DESC_WORDS)-1:0]] <= m_rdata[31:0];
                            dfetch_idx <= dfetch_idx + 1'b1;
                            if (m_rlast) state <= S_DECODE;
                        end
                    end
                end

                // --------------------------------------------------------
                S_DECODE: begin
                    d_src      <= desc_word[DESC_SRC[4:2]];
                    d_dst      <= desc_word[DESC_DST[4:2]];
                    d_len      <= desc_word[DESC_LEN[4:2]];
                    d_flags    <= desc_word[DESC_FLAGS[4:2]];
                    d_next     <= desc_word[DESC_NEXT[4:2]];
                    cur_src    <= desc_word[DESC_SRC[4:2]];
                    cur_dst    <= desc_word[DESC_DST[4:2]];
                    remaining  <= desc_word[DESC_LEN[4:2]];
                    desc_bytes <= desc_word[DESC_LEN[4:2]];

                    if (!desc_word[DESC_FLAGS[4:2]][FLAG_OWN_BIT]) begin
                        // Descriptor not owned by the engine -> programming
                        // fault, fail-closed.
                        pending_err <= ERR_DESC;
                        state       <= S_ERROR;
                    end else if (desc_word[DESC_LEN[4:2]] == 32'h0) begin
                        // Zero-length descriptor: nothing to move, write back
                        // DONE and advance.
                        sb_status <= 32'h0000_0001;
                        state     <= S_SB_AW;
                    end else begin
                        state <= S_RD_AR;
                    end
                end

                // --------------------------------------------------------
                // Plan + issue the payload read burst.
                S_RD_AR: begin
                    if (ar_fire) begin
                        // Latch the burst geometry committed on this AR.  The
                        // combinational c_* terms are stable across the burst
                        // because cur_src/cur_dst/remaining only advance after
                        // the write response.
                        src_off     <= c_src_off;
                        dst_off     <= c_dst_off;
                        rd_base     <= c_rd_base;
                        wr_base     <= c_wr_base;
                        burst_bytes <= c_burst_bytes;
                        rd_beats    <= c_rd_beats;
                        wr_beats    <= c_wr_beats;
                        burst_first <= c_dst_off;
                        burst_last  <= c_dst_off + c_burst_bytes;
                        rd_idx      <= '0;
                        state       <= S_RD_R;
                    end
                end
                S_RD_R: begin
                    if (r_fire) begin
                        if (m_rresp != RESP_OKAY) begin
                            pending_err <= ERR_RD;
                            state       <= S_ERROR;
                        end else begin
                            // Distribute the beat's bytes into copybuf indexed
                            // by dst-relative position.  src byte index of this
                            // beat's lane b is rd_idx*BPB + b; its payload
                            // offset (0-based within burst) is that minus
                            // src_off; its dst-relative index is payload_off +
                            // burst_first.
                            for (int b = 0; b < BYTES_PER_BEAT; b++) begin
                                automatic logic signed [ADDR_W:0] poff =
                                    $signed({1'b0, (rd_idx * BYTES_PER_BEAT)
                                             + b[ADDR_W-1:0]}) - $signed({1'b0, src_off});
                                if ((poff >= 0) &&
                                    (poff < $signed({1'b0, burst_bytes}))) begin
                                    copybuf[burst_first + poff[ADDR_W-1:0]]
                                        <= m_rdata[b*8 +: 8];
                                end
                            end
                            rd_idx <= rd_idx + 9'd1;
                            if (m_rlast) begin
                                wr_idx <= '0;
                                state  <= S_WR_AW;
                            end
                        end
                    end
                end

                // --------------------------------------------------------
                S_WR_AW: begin
                    if (aw_fire) begin
                        wr_idx <= '0;
                        state  <= S_WR_W;
                    end
                end
                S_WR_W: begin
                    if (w_fire) begin
                        if (wr_idx == (wr_beats - 9'd1)) begin
                            state <= S_WR_B;
                        end else begin
                            wr_idx <= wr_idx + 9'd1;
                        end
                    end
                end
                S_WR_B: begin
                    if (b_fire) begin
                        if (m_bresp != RESP_OKAY) begin
                            pending_err <= ERR_WR;
                            state       <= S_ERROR;
                        end else begin
                            bytes_done_cnt <= bytes_done_cnt + burst_bytes;
                            if (remaining <= burst_bytes) begin
                                // Descriptor payload complete -> writeback DONE.
                                remaining <= '0;
                                sb_status <= 32'h0000_0001;
                                state     <= S_SB_AW;
                            end else begin
                                remaining <= remaining - burst_bytes;
                                cur_src   <= cur_src + burst_bytes;
                                cur_dst   <= cur_dst + burst_bytes;
                                state     <= S_RD_AR;
                            end
                        end
                    end
                end

                // --------------------------------------------------------
                // Descriptor status writeback (single-beat word write).
                S_SB_AW: begin
                    if (aw_fire) state <= S_SB_W;
                end
                S_SB_W: begin
                    if (w_fire) state <= S_SB_B;
                end
                S_SB_B: begin
                    // A failed status writeback is itself a fail-closed error,
                    // but only when we were not already finishing an error
                    // path (handled separately in S_ERROR's writeback).
                    if (b_fire) begin
                        if (m_bresp != RESP_OKAY) begin
                            pending_err <= ERR_DESC;
                            state       <= S_ERROR;
                        end else begin
                            desc_done_cnt <= desc_done_cnt + 32'd1;
                            state         <= S_NEXT;
                        end
                    end
                end

                // --------------------------------------------------------
                S_NEXT: begin
                    // Raise completion IRQ for this descriptor if requested.
                    if (d_flags[FLAG_IRQ_BIT]) begin
                        st_done <= 1'b1;
                        if (irq_en[0]) st_irq <= 1'b1;
                    end
                    if (d_flags[FLAG_LAST_BIT] || (d_next == '0)) begin
                        st_busy       <= 1'b0;
                        st_chain_done <= 1'b1;
                        st_done       <= 1'b1;
                        if (irq_en[0]) st_irq <= 1'b1;
                        state         <= S_IDLE;
                    end else begin
                        cur_desc   <= d_next;
                        dfetch_idx <= '0;
                        state      <= S_DFETCH_AR;
                    end
                end

                // --------------------------------------------------------
                // Fail-closed error finish: latch error status, attempt to
                // write the error code into the descriptor (best-effort, but
                // we still stop the chain), raise the error IRQ, halt.
                S_ERROR: begin
                    st_err     <= 1'b1;
                    st_errcode <= pending_err;
                    err_cnt    <= err_cnt + 32'd1;
                    if (irq_en[1]) st_irq <= 1'b1;
                    // Write {DONE=0, ERR=1, err_code} to descriptor status.
                    // st_busy stays asserted until the writeback retires so a
                    // poller never observes idle before the error status word
                    // is committed to memory.
                    sb_status  <= {22'h0, pending_err, 6'h0, 1'b1, 1'b0};
                    state      <= S_ERR_SB_AW;
                end
                S_ERR_SB_AW: begin
                    if (aw_fire) state <= S_ERR_SB_W;
                end
                S_ERR_SB_W: begin
                    if (w_fire) state <= S_ERR_SB_B;
                end
                S_ERR_SB_B: begin
                    // Regardless of writeback response we stop the chain; the
                    // error is already latched in software-visible status.
                    if (b_fire) begin
                        st_busy <= 1'b0;
                        state   <= S_IDLE;
                    end
                end

                default: state <= S_IDLE;
            endcase

            // Register port writes (control/config).
            if (reg_we) begin
                unique case (addr)
                    6'h00: ring_head <= wdata[ADDR_W-1:0];
                    6'h03: irq_en    <= wdata[1:0];
                    6'h04: axcache   <= wdata[3:0];
                    default: begin end
                endcase
            end
        end
    end

    // ------------------------------------------------------------------
    // Register read mux.
    // ------------------------------------------------------------------
    always_comb begin
        unique case (addr)
            6'h00:   rdata = {{(32-ADDR_W){1'b0}}, ring_head};
            6'h02:   rdata = {21'h0, st_chain_done, st_errcode, 4'h0,
                              st_irq, st_err, st_done, st_busy};
            6'h03:   rdata = {30'h0, irq_en};
            6'h04:   rdata = {28'h0, axcache};
            6'h05:   rdata = {{(32-ADDR_W){1'b0}}, cur_desc};
            6'h06:   rdata = desc_done_cnt;
            6'h07:   rdata = bytes_done_cnt;
            6'h08:   rdata = err_cnt;
            6'h09:   rdata = {30'h0, st_errcode};
            6'h0a:   rdata = {27'h0, state};
            default: rdata = 32'h0;
        endcase
    end

endmodule
