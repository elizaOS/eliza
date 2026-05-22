`timescale 1ns/1ps

// e1_display_scanout
//
// Production framebuffer-to-scanout controller for the E1 display path. This
// is the buildable subset of the display pipeline: a real AXI4 read master
// that streams a framebuffer out of DRAM, a pixel-format unpack stage, a
// register-programmed mode timing generator, and the controller -> PHY
// (DPI/DSI command+pixel) boundary.
//
// PHYSICAL DEPENDENCY (out of scope, modelled at the boundary only): the DSI
// analog PHY, the D-PHY lane serializers, and the panel DCS init sequence are
// physical/analog and cannot be simulated as synthesizable digital RTL. This
// module drives the *digital* pixel-clock-domain DPI interface
// (pix_de/pix_hsync/pix_vsync/pix_valid/pix_data) plus a DCS command sideband
// (dcs_*). A real product wires those to a DSI host controller + D-PHY. The
// boundary signals here are exactly what that PHY consumes.
//
// Datapath (single clock domain in this model; a real product crosses an
// async FIFO into the pixel clock — that CDC is the PHY integrator's seam and
// is documented, not stubbed):
//
//   AXI4 read master  ->  line FIFO  ->  format unpack  ->  DPI pixel stream
//
//   * AXI4: INCR bursts of FIFO_DEPTH/2 beats max, QoS = QOS_DISPLAY_RT, up to
//     OUTSTANDING concurrent address phases to hide DRAM latency. Address
//     generation walks fb_base + line*stride + x*bpp with programmable stride.
//   * Line FIFO: decouples burst-y memory delivery from the constant-rate
//     scanout. Backpressure on the AXI R channel is the FIFO `full` signal.
//   * Underflow policy (fail-closed): if the timing generator needs a pixel
//     during active DE but the FIFO is empty, the controller emits the defined
//     UNDERFLOW_FILL colour (black), sets a sticky `underflow` status bit, and
//     increments `underflow_count`. It does NOT stall the pixel clock and does
//     NOT emit stale/garbage data. The pipeline resynchronises at the next
//     vsync (frame restart re-aligns the fetch address to fb_base).

module e1_display_scanout
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ADDR_WIDTH  = 32,
    parameter int unsigned DATA_WIDTH  = 32,   // one 32-bit word per AXI beat
    parameter int unsigned ID_WIDTH    = 4,
    parameter int unsigned FIFO_DEPTH  = 64,   // words; power of two
    parameter int unsigned OUTSTANDING = 4     // max concurrent read bursts
) (
    input  logic                    clk,
    input  logic                    rst_n,

    // ---- MMIO register port (simple valid/write/addr/wdata/rdata family) ----
    input  logic                    valid,
    input  logic                    write,
    input  logic [5:0]              addr,
    input  logic [31:0]             wdata,
    output logic [31:0]             rdata,

    // ---- AXI4 read master (read-only; AW/W/B tied off by integrator) -------
    output logic                    m_arvalid,
    input  logic                    m_arready,
    output logic [ID_WIDTH-1:0]     m_arid,
    output logic [ADDR_WIDTH-1:0]   m_araddr,
    output logic [7:0]              m_arlen,
    output logic [2:0]              m_arsize,
    output logic [1:0]              m_arburst,
    output logic [3:0]              m_arcache,
    output logic [2:0]              m_arprot,
    output logic [3:0]              m_arqos,

    input  logic                    m_rvalid,
    output logic                    m_rready,
    /* verilator lint_off UNUSEDSIGNAL */
    input  logic [ID_WIDTH-1:0]     m_rid,
    input  logic                    m_rlast,
    /* verilator lint_on UNUSEDSIGNAL */
    input  logic [DATA_WIDTH-1:0]   m_rdata,
    input  logic [1:0]              m_rresp,

    // ---- DPI / DSI pixel boundary (pixel-clock domain in a real product) ---
    output logic                    pix_de,
    output logic                    pix_hsync,
    output logic                    pix_vsync,
    output logic                    pix_valid,
    output logic [23:0]             pix_data,   // packed {R[23:16],G[15:8],B[7:0]}

    // ---- DCS command sideband to the DSI host (panel init at the boundary) -
    output logic                    dcs_vsync_pulse,  // frame-start event for host
    output logic                    irq_vsync
);

    // ------------------------------------------------------------------
    // Pixel format encodings (DRM fourcc-style values, matched by sw)
    // ------------------------------------------------------------------
    localparam logic [31:0] FORMAT_XR24  = 32'h3432_5258; // 'XR24' XRGB8888
    localparam logic [31:0] FORMAT_RG16  = 32'h3631_4752; // 'RG16' RGB565
    localparam logic [31:0] FORMAT_RG24  = 32'h3432_4752; // 'RG24' RGB888 packed

    localparam logic [23:0] UNDERFLOW_FILL = 24'h00_0000; // defined fail-closed colour

    localparam int unsigned FIFO_AW = $clog2(FIFO_DEPTH);

    // ------------------------------------------------------------------
    // Programmable registers
    // ------------------------------------------------------------------
    logic [31:0] fb_base;
    logic [15:0] h_active, v_active;
    logic [15:0] h_front, h_sync, h_back;
    logic [15:0] v_front, v_sync, v_back;
    logic [31:0] stride_bytes;        // bytes per framebuffer line
    logic [31:0] format;
    logic        enable;
    logic        underflow_sticky;    // W1C status
    logic [31:0] underflow_count;
    logic [31:0] fetched_word_count;

    // Bytes-per-pixel derived from format (1 word can hold 1 or 2 pixels)
    logic [2:0]  bytes_per_pixel;
    always_comb begin
        unique case (format)
            FORMAT_RG16: bytes_per_pixel = 3'd2;
            FORMAT_RG24: bytes_per_pixel = 3'd3;
            default:     bytes_per_pixel = 3'd4; // XR24
        endcase
    end

    // ------------------------------------------------------------------
    // Timing generator (single counter pair; DPI/DE/HSYNC/VSYNC)
    // ------------------------------------------------------------------
    logic [15:0] h_count, v_count;
    logic [15:0] h_sync_start, h_sync_end, h_total;
    logic [15:0] v_sync_start, v_sync_end, v_total;

    assign h_sync_start = h_active + h_front;
    assign h_sync_end   = h_sync_start + h_sync;
    assign h_total      = h_sync_end + h_back;
    assign v_sync_start = v_active + v_front;
    assign v_sync_end   = v_sync_start + v_sync;
    assign v_total      = v_sync_end + v_back;

    logic in_h_active, in_v_active, active;
    assign in_h_active = (h_count < h_active);
    assign in_v_active = (v_count < v_active);
    assign active      = enable && in_h_active && in_v_active;

    assign pix_de    = active;
    assign pix_hsync = enable && (h_count >= h_sync_start) && (h_count < h_sync_end);
    assign pix_vsync = enable && (v_count >= v_sync_start) && (v_count < v_sync_end);

    // The fetch engine and FIFO re-arm at the start of vertical back porch
    // (h==0, v==v_sync_end), giving the line buffer v_back lines of lead time
    // to prefill before the first visible pixel of the next frame at (0,0).
    // This is the scanout prefetch window: without it the FIFO would be empty
    // at the first active pixel and underflow on every frame.
    logic prefetch_arm;
    assign prefetch_arm = enable && (h_count == 16'd0) && (v_count == v_sync_end);
    assign irq_vsync       = enable && (h_count == 16'd0) && (v_count == v_sync_start);
    assign dcs_vsync_pulse = pix_vsync;

    // ------------------------------------------------------------------
    // Line FIFO (synchronous, single clock). Holds fetched 32-bit words.
    // ------------------------------------------------------------------
    logic [DATA_WIDTH-1:0] fifo_mem [FIFO_DEPTH];
    logic [FIFO_AW:0]      fifo_wptr, fifo_rptr; // extra MSB for full/empty
    logic                  fifo_we, fifo_re;
    logic [DATA_WIDTH-1:0] fifo_wdata;
    logic [DATA_WIDTH-1:0] fifo_rdata;
    logic                  fifo_full, fifo_empty;
    logic [FIFO_AW:0]      fifo_level;

    assign fifo_level = fifo_wptr - fifo_rptr;
    assign fifo_empty = (fifo_wptr == fifo_rptr);
    assign fifo_full  = (fifo_level >= (FIFO_AW+1)'(FIFO_DEPTH));
    assign fifo_rdata = fifo_mem[fifo_rptr[FIFO_AW-1:0]];

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            fifo_wptr <= '0;
            fifo_rptr <= '0;
        end else if (!enable || prefetch_arm) begin
            // Flush at frame re-arm so the new frame starts FIFO-aligned. Any
            // in-flight AXI beats that arrive after this are discarded because
            // the fetch engine also resets its line counters here.
            fifo_wptr <= '0;
            fifo_rptr <= '0;
        end else begin
            if (fifo_we && !fifo_full) begin
                fifo_mem[fifo_wptr[FIFO_AW-1:0]] <= fifo_wdata;
                fifo_wptr <= fifo_wptr + 1'b1;
            end
            if (fifo_re && !fifo_empty) begin
                fifo_rptr <= fifo_rptr + 1'b1;
            end
        end
    end

    // ------------------------------------------------------------------
    // AXI4 read master: fetch one framebuffer line at a time into the FIFO.
    // Address walks fb_base + v_active_line*stride, advancing by the burst
    // byte count. Up to OUTSTANDING bursts may be in flight; the R-channel
    // drains into the FIFO and applies backpressure via fifo_full.
    // ------------------------------------------------------------------
    localparam int unsigned BURST_BEATS = (FIFO_DEPTH/2 > 16) ? 16 : FIFO_DEPTH/2;

    logic [ADDR_WIDTH-1:0] fetch_addr;        // next AR address within current line
    logic [ADDR_WIDTH-1:0] line_start_addr;   // base address of current fetch line
    logic [15:0]           words_per_line;    // 32-bit words to fetch per line
    logic [15:0]           line_words_left;   // words still to request this line
    logic [15:0]           fetch_line;        // which framebuffer line we fetch next
    logic [$clog2(OUTSTANDING+1)-1:0] outstanding_cnt;
    logic [7:0]            cur_burst_beats;
    logic                  fetch_busy;        // armed and not yet done with the frame

    // words/line: ceil(h_active * bpp / 4). h_active <= 65535 and bpp <= 4, so
    // the product fits in 18 bits; words_per_line fits in 16.
    logic [17:0] line_bytes;
    assign line_bytes      = ({2'h0, h_active} * {15'h0, bytes_per_pixel});
    assign words_per_line  = (line_bytes[1:0] != 2'b00)
                           ? line_bytes[17:2] + 16'd1
                           : line_bytes[17:2];

    logic can_issue;
    assign can_issue = enable && fetch_busy && (line_words_left != 16'd0)
                     && (outstanding_cnt < OUTSTANDING[$clog2(OUTSTANDING+1)-1:0])
                     && !fifo_full;

    // beats for this burst: min(line_words_left, BURST_BEATS)
    always_comb begin
        if (line_words_left >= BURST_BEATS[15:0]) begin
            cur_burst_beats = BURST_BEATS[7:0];
        end else begin
            cur_burst_beats = line_words_left[7:0];
        end
    end

    assign m_arvalid = can_issue;
    assign m_arid    = '0;
    assign m_araddr  = fetch_addr;
    assign m_arlen   = cur_burst_beats - 8'd1;
    assign m_arsize  = SIZE_4B;
    assign m_arburst = BURST_INCR;
    assign m_arcache = CACHE_NORMAL_NON_CACHEABLE;
    assign m_arprot  = PROT_DATA_NS_PRIV;
    assign m_arqos   = QOS_DISPLAY_RT;

    // `fetch_busy` gates AR *issue* (all bursts for the frame issued). The
    // separate `collect_en` flag gates FIFO *writes*: it stays high from the
    // prefetch re-arm until the next re-arm, so data still in flight after the
    // last AR is captured. Cross-frame corruption is prevented by flushing the
    // FIFO at prefetch_arm (collect_en is just re-set there).
    logic collect_en;

    // Accept read data whenever the FIFO can take it.
    assign m_rready  = !fifo_full;
    logic r_fire;
    assign r_fire    = m_rvalid && m_rready;
    assign fifo_we   = r_fire && collect_en;
    assign fifo_wdata = m_rdata;

    logic ar_fire;
    assign ar_fire = m_arvalid && m_arready;

    // sticky AXI error: SLVERR/DECERR on a beat is treated as an underflow
    // condition for the affected pixels (fail-closed, observable).
    logic axi_err;
    assign axi_err = r_fire && collect_en && (m_rresp != RESP_OKAY);

    // last line of the frame is the one being issued now
    logic last_line_issued;
    assign last_line_issued = (fetch_line + 16'd1 >= v_active);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n || !enable) begin
            fetch_addr      <= fb_base;
            line_start_addr <= fb_base;
            line_words_left <= '0;
            fetch_line      <= '0;
            outstanding_cnt <= '0;
            fetch_busy      <= 1'b0;
            collect_en      <= 1'b0;
        end else begin
            if (prefetch_arm) begin
                // Re-arm for the upcoming frame: realign to fb_base, prefill.
                fetch_addr      <= fb_base;
                line_start_addr <= fb_base;
                line_words_left <= words_per_line;
                fetch_line      <= 16'd0;
                fetch_busy      <= 1'b1;
                collect_en      <= 1'b1;
            end else if (fetch_busy && ar_fire) begin
                fetch_addr      <= fetch_addr + ({24'h0, cur_burst_beats} << 2);
                line_words_left <= line_words_left - {8'h0, cur_burst_beats};
                // On the burst that drains the current line, jump to the next
                // line (line_start + stride) or finish issuing the frame.
                if ({8'h0, cur_burst_beats} >= line_words_left) begin
                    if (last_line_issued) begin
                        fetch_busy <= 1'b0;
                    end else begin
                        fetch_line      <= fetch_line + 16'd1;
                        line_start_addr <= line_start_addr + stride_bytes;
                        fetch_addr      <= line_start_addr + stride_bytes;
                        line_words_left <= words_per_line;
                    end
                end
            end

            // outstanding tracking runs whenever armed: +1 on AR fire, -1 on
            // the RLAST beat of a burst.
            if (!prefetch_arm) begin
                unique case ({ar_fire, r_fire && m_rlast})
                    2'b10:   outstanding_cnt <= outstanding_cnt + 1'b1;
                    2'b01:   outstanding_cnt <= (outstanding_cnt == '0) ? '0 : outstanding_cnt - 1'b1;
                    default: outstanding_cnt <= outstanding_cnt;
                endcase
            end else begin
                outstanding_cnt <= ar_fire ? {{($clog2(OUTSTANDING+1)-1){1'b0}}, 1'b1} : '0;
            end
        end
    end

    // ------------------------------------------------------------------
    // Byte-assembly pixel extractor. The FIFO holds 32-bit (4-byte) words in
    // little-endian DRAM order. A residual byte buffer accumulates words and
    // hands out `bytes_per_pixel` bytes per active DE cycle, so the pipeline
    // handles densely-packed formats whose pixel size does not divide the
    // 4-byte fetch granule (RGB565 -> 2B, packed RGB888 -> 3B, XRGB8888 -> 4B)
    // including 3-byte pixels that straddle word boundaries.
    //
    //   byte_buf : up to 12 valid bytes, byte 0 = lowest framebuffer address.
    //   byte_cnt : number of valid bytes currently in byte_buf (0..12).
    // A 12-byte buffer (3 fetch words) lets a 4-byte refill stay ahead of the
    // 3-byte/pixel drain: refilling whenever there is room for a word keeps at
    // least one whole pixel available every active clock for all of RGB565
    // (2B), packed RGB888 (3B), and XRGB8888 (4B).
    // ------------------------------------------------------------------
    logic [95:0] byte_buf;
    logic [4:0]  byte_cnt;        // 0..12

    logic        can_refill;      // room for another word and FIFO has one
    logic        have_pixel;      // enough buffered bytes to emit a pixel
    logic        emit_pixel;      // active DE pixel slot delivered this cycle
    logic        underflow_now;

    // The byte assembler only draws words on lines it will actually scan out:
    // the active rows, plus the single line immediately before row 0 (the last
    // back-porch line) to prefill the first visible line. It realigns at the
    // first horizontal-blanking cycle of those lines (h_count == h_active) so
    // partial bytes left over from a line whose width*bpp is not a multiple of
    // the 4-byte fetch granule do not bleed into the next line, and so the
    // assembler does not drain the FIFO on idle vertical-blanking lines. The
    // fetch engine issues exactly words_per_line words per line, so each
    // line's words enter the FIFO as a contiguous group aligned to this flush.
    // The byte assembler is refilled continuously on scanned lines so it
    // keeps pace with one pixel per active clock. It realigns once per line at
    // the first horizontal-blanking cycle (h_count == h_active) to drop the
    // residual bytes of a line whose width*bpp is not a multiple of the 4-byte
    // fetch granule. Scanned lines are the active rows plus the single line
    // before row 0 (last back porch) that prefills the first visible line; on
    // that prefill line refill is held until after the realign so the FIFO is
    // not drained by words that the realign would then discard.
    logic line_scanned;   // this line emits (or prefills for) visible pixels
    logic line_realign;
    logic in_h_blank;
    logic has_residual;   // fetched line bytes are not a whole pixel multiple
    assign line_scanned = in_v_active || (v_count == v_total - 16'd1);
    assign in_h_blank   = (h_count >= h_active);
    // A flush is only needed when words_per_line*4 over-fetches past the
    // pixel bytes of the line (line_bytes not 4-byte aligned). When the line
    // packs exactly into whole words there is no residual and flushing would
    // wrongly discard the next line's already-prefetched leading pixel.
    assign has_residual = (line_bytes[1:0] != 2'b00);
    assign line_realign = enable && line_scanned && has_residual && (h_count == h_active);

    assign can_refill = (byte_cnt <= 5'd8) && !fifo_empty && !line_realign
                      && line_scanned && (in_v_active || in_h_blank);
    assign have_pixel = (byte_cnt >= {2'b0, bytes_per_pixel});
    assign emit_pixel = active && have_pixel;
    assign underflow_now = active && !have_pixel;

    // Pop a word from the FIFO when refilling.
    assign fifo_re = can_refill;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n || !enable || prefetch_arm || line_realign) begin
            byte_buf <= 96'h0;
            byte_cnt <= 5'h0;
        end else begin
            logic [95:0] nbuf;
            logic [4:0]  ncnt;
            nbuf = byte_buf;
            ncnt = byte_cnt;
            // Consume a pixel's worth of bytes (shift the buffer down).
            if (emit_pixel) begin
                nbuf = nbuf >> ({4'h0, bytes_per_pixel} << 3);
                ncnt = ncnt - {2'b0, bytes_per_pixel};
            end
            // Append a freshly popped word at the current byte offset.
            if (can_refill) begin
                nbuf = nbuf | ({64'h0, fifo_rdata} << ({3'h0, ncnt} << 3));
                ncnt = ncnt + 5'd4;
            end
            byte_buf <= nbuf;
            byte_cnt <= ncnt;
        end
    end

    // Format unpack from the low bytes of the assembly buffer. DRAM byte order
    // is little-endian: byte0 is the lowest address. XRGB8888 stores B,G,R,X;
    // packed RGB888 stores B,G,R; RGB565 stores the 16-bit value low byte first.
    logic [7:0]  b0, b1, b2;
    logic [15:0] rg16;
    logic [23:0] unpacked_rgb;
    assign b0   = byte_buf[7:0];
    assign b1   = byte_buf[15:8];
    assign b2   = byte_buf[23:16];
    assign rg16 = {b1, b0};

    always_comb begin
        unique case (format)
            FORMAT_RG16: begin
                // RGB565 -> RGB888: replicate the high bits of each channel
                // into the freed low bits (matches (c << n) | (c >> (w-n))).
                unpacked_rgb = {
                    rg16[15:11], rg16[15:13], // R: r5 | r5[4:2]
                    rg16[10:5],  rg16[10:9],  // G: g6 | g6[5:4]
                    rg16[4:0],   rg16[4:2]    // B: b5 | b5[4:2]
                };
            end
            // packed RGB888 / XRGB8888: low 3 bytes are B,G,R (alpha ignored).
            default: unpacked_rgb = {b2, b1, b0};
        endcase
    end

    // Drive the DPI pixel stream. Underflow -> defined fill, valid still high
    // (the PHY must receive a pixel every active DE clock); status bit set.
    assign pix_valid = active;
    assign pix_data  = underflow_now ? UNDERFLOW_FILL : unpacked_rgb;

    // ------------------------------------------------------------------
    // Status counters
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            underflow_sticky   <= 1'b0;
            underflow_count    <= 32'h0;
            fetched_word_count <= 32'h0;
        end else begin
            if (valid && write && addr == 6'h0C) begin
                // W1C: writing bit0=1 clears the sticky underflow + count
                if (wdata[0]) begin
                    underflow_sticky <= 1'b0;
                    underflow_count  <= 32'h0;
                end
            end else begin
                if (underflow_now || axi_err) begin
                    underflow_sticky <= 1'b1;
                    underflow_count  <= underflow_count + 32'd1;
                end
            end
            if (fifo_we && !fifo_full) begin
                fetched_word_count <= fetched_word_count + 32'd1;
            end
            if (valid && write && addr == 6'h0D && wdata[0]) begin
                fetched_word_count <= 32'h0;
            end
        end
    end

    // ------------------------------------------------------------------
    // Timing counter advance
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            h_count <= 16'h0;
            v_count <= 16'h0;
        end else if (!enable) begin
            // Park at the start of vertical back porch so that the cycle
            // `enable` asserts lands in the prefetch window (prefetch_arm),
            // giving the line FIFO v_back lines of lead time before the first
            // visible pixel of the first frame.
            h_count <= 16'h0;
            v_count <= v_sync_end;
        end else if (h_count >= h_total - 16'd1) begin
            h_count <= 16'h0;
            if (v_count >= v_total - 16'd1) begin
                v_count <= 16'h0;
            end else begin
                v_count <= v_count + 16'd1;
            end
        end else begin
            h_count <= h_count + 16'd1;
        end
    end

    // ------------------------------------------------------------------
    // Register write decode
    // ------------------------------------------------------------------
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            fb_base      <= 32'h0;
            h_active     <= 16'd640;
            v_active     <= 16'd480;
            h_front      <= 16'd16;
            h_sync       <= 16'd96;
            h_back       <= 16'd48;
            v_front      <= 16'd10;
            v_sync       <= 16'd2;
            v_back       <= 16'd33;
            stride_bytes <= 32'd2560; // 640 * 4
            format       <= FORMAT_XR24;
            enable       <= 1'b0;
        end else if (valid && write) begin
            unique case (addr)
                6'h00: fb_base <= wdata;
                6'h01: begin
                    h_active <= (wdata[15:0]  == 16'h0) ? 16'd1 : wdata[15:0];
                    v_active <= (wdata[31:16] == 16'h0) ? 16'd1 : wdata[31:16];
                end
                6'h02: begin
                    h_front <= wdata[15:0];
                    h_sync  <= wdata[31:16];
                end
                6'h03: begin
                    h_back  <= wdata[15:0];
                    v_front <= wdata[31:16];
                end
                6'h04: begin
                    v_sync <= wdata[15:0];
                    v_back <= wdata[31:16];
                end
                6'h05: stride_bytes <= wdata;
                6'h06: begin
                    if (wdata == FORMAT_XR24 || wdata == FORMAT_RG16 ||
                        wdata == FORMAT_RG24) begin
                        format <= wdata;
                    end
                end
                6'h07: enable <= wdata[0];
                default: begin end
            endcase
        end
    end

    // ------------------------------------------------------------------
    // Register read
    // ------------------------------------------------------------------
    always_comb begin
        unique case (addr)
            6'h00: rdata = fb_base;
            6'h01: rdata = {v_active, h_active};
            6'h02: rdata = {h_sync, h_front};
            6'h03: rdata = {v_front, h_back};
            6'h04: rdata = {v_back, v_sync};
            6'h05: rdata = stride_bytes;
            6'h06: rdata = format;
            6'h07: rdata = {31'h0, enable};
            6'h08: rdata = {31'h0, irq_vsync};
            6'h09: rdata = {16'h0, words_per_line};
            6'h0A: rdata = {{(32-($clog2(OUTSTANDING+1))){1'b0}}, outstanding_cnt};
            6'h0B: rdata = {{(31-FIFO_AW){1'b0}}, fifo_level};
            6'h0C: rdata = {31'h0, underflow_sticky};
            6'h0D: rdata = fetched_word_count;
            6'h0E: rdata = underflow_count;
            default: rdata = 32'h0;
        endcase
    end

endmodule
