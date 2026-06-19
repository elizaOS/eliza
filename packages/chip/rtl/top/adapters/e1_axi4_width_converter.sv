`timescale 1ns/1ps

// e1_axi4_width_converter
//
// Parameterised AXI4 data-width converter between an upstream master port
// of width `UPSTREAM_DATA_W` and a downstream slave port of width
// `DOWNSTREAM_DATA_W`.  Used at the SoC top to bridge the OpenHW Group
// CVA6 v5.3.0 native 64-bit AXI4 master into the e1-chip cluster slot 0
// per-core AXI4 port, which is 128-bit (matches the L1D cache-line port).
//
// The adapter handles three configurations selected at elaboration:
//
//   1. UPSTREAM_DATA_W == DOWNSTREAM_DATA_W
//      Passthrough.  All channels wire directly through.
//
//   2. UPSTREAM_DATA_W <  DOWNSTREAM_DATA_W   (upsizer / narrow -> wide)
//      AXI4 IHI 0022 A8.4.1 ("Upsizing").  The downstream bus is wider
//      than the upstream bus.  When an upstream master issues a
//      transaction with AxSIZE < log2(DOWNSTREAM_DATA_W/8), AXI4 allows
//      the transaction to flow through the wider bus 1:1 by placing the
//      narrow data on the lane selected by the address's low byte-lane
//      bits.  AxLEN is unchanged; AxSIZE is unchanged.  WSTRB selects
//      the active byte lanes within each wider beat.  Read data is
//      muxed back onto the narrow upstream lanes from the same address
//      lane.
//
//   3. UPSTREAM_DATA_W >  DOWNSTREAM_DATA_W   (downsizer / wide -> narrow)
//      AXI4 IHI 0022 A8.4.2 ("Downsizing").  Each upstream beat is
//      serialised into RATIO = UPSTREAM_DATA_W / DOWNSTREAM_DATA_W
//      downstream beats.  AxLEN is scaled: new_len + 1 = (old_len + 1)
//      * RATIO when old AxSIZE >= log2(DOWNSTREAM_DATA_W/8).  Smaller
//      AxSIZE follows the upsizer's lane-mux pattern on a per-beat
//      basis.  Read data assembles RATIO consecutive downstream beats
//      back into a single upstream beat.
//
// All three configurations are produced by a single body; the choice is
// driven by the relative widths.  The conversion is **single inflight**:
// at most one outstanding AR and one outstanding AW are accepted at the
// upstream port.  That keeps the burst-length/address arithmetic local
// to a small FSM and matches the CVA6 v5.3.0 NoC port behaviour (CVA6
// cv64a6 disables write bursts entirely and issues one read miss per
// cache fill).
//
// Constraints enforced at elaboration (synthesis translate_off blocks):
//   * Both widths must be a power of two.
//   * Both widths must be >= 8.
//   * One width must be an integer power-of-two multiple of the other.
//   * ID/ADDR/USER widths are passed through unchanged.
//
// Owner: SoC integration.  Lives under `rtl/top/adapters/` per the
// project convention that domain RTL never absorbs cross-domain width
// drift.

/* verilator lint_off DECLFILENAME */
/* verilator lint_off UNUSEDSIGNAL */
module e1_axi4_width_converter #(
    parameter int unsigned UPSTREAM_DATA_W   = 64,
    parameter int unsigned DOWNSTREAM_DATA_W = 128,
    parameter int unsigned ID_W              = 4,
    parameter int unsigned ADDR_W            = 64,
    parameter int unsigned USER_W            = 1,
    parameter int unsigned BURST_LEN_W       = 8
) (
    input  logic                                 clk_i,
    input  logic                                 rst_ni,

    // ====================================================================
    // Upstream slave port (a narrow / wide master is connected here)
    // ====================================================================
    // AW
    input  logic [ID_W-1:0]                      up_aw_id,
    input  logic [ADDR_W-1:0]                    up_aw_addr,
    input  logic [BURST_LEN_W-1:0]               up_aw_len,
    input  logic [2:0]                           up_aw_size,
    input  logic [1:0]                           up_aw_burst,
    input  logic                                 up_aw_lock,
    input  logic [3:0]                           up_aw_cache,
    input  logic [2:0]                           up_aw_prot,
    input  logic [3:0]                           up_aw_qos,
    input  logic [3:0]                           up_aw_region,
    input  logic [5:0]                           up_aw_atop,
    input  logic [USER_W-1:0]                    up_aw_user,
    input  logic                                 up_aw_valid,
    output logic                                 up_aw_ready,

    // W
    input  logic [UPSTREAM_DATA_W-1:0]           up_w_data,
    input  logic [(UPSTREAM_DATA_W/8)-1:0]       up_w_strb,
    input  logic                                 up_w_last,
    input  logic [USER_W-1:0]                    up_w_user,
    input  logic                                 up_w_valid,
    output logic                                 up_w_ready,

    // B
    output logic [ID_W-1:0]                      up_b_id,
    output logic [1:0]                           up_b_resp,
    output logic [USER_W-1:0]                    up_b_user,
    output logic                                 up_b_valid,
    input  logic                                 up_b_ready,

    // AR
    input  logic [ID_W-1:0]                      up_ar_id,
    input  logic [ADDR_W-1:0]                    up_ar_addr,
    input  logic [BURST_LEN_W-1:0]               up_ar_len,
    input  logic [2:0]                           up_ar_size,
    input  logic [1:0]                           up_ar_burst,
    input  logic                                 up_ar_lock,
    input  logic [3:0]                           up_ar_cache,
    input  logic [2:0]                           up_ar_prot,
    input  logic [3:0]                           up_ar_qos,
    input  logic [3:0]                           up_ar_region,
    input  logic [USER_W-1:0]                    up_ar_user,
    input  logic                                 up_ar_valid,
    output logic                                 up_ar_ready,

    // R
    output logic [ID_W-1:0]                      up_r_id,
    output logic [UPSTREAM_DATA_W-1:0]           up_r_data,
    output logic [1:0]                           up_r_resp,
    output logic                                 up_r_last,
    output logic [USER_W-1:0]                    up_r_user,
    output logic                                 up_r_valid,
    input  logic                                 up_r_ready,

    // ====================================================================
    // Downstream master port (wider / narrower bus connected here)
    // ====================================================================
    // AW
    output logic [ID_W-1:0]                      dn_aw_id,
    output logic [ADDR_W-1:0]                    dn_aw_addr,
    output logic [BURST_LEN_W-1:0]               dn_aw_len,
    output logic [2:0]                           dn_aw_size,
    output logic [1:0]                           dn_aw_burst,
    output logic                                 dn_aw_lock,
    output logic [3:0]                           dn_aw_cache,
    output logic [2:0]                           dn_aw_prot,
    output logic [3:0]                           dn_aw_qos,
    output logic [3:0]                           dn_aw_region,
    output logic [5:0]                           dn_aw_atop,
    output logic [USER_W-1:0]                    dn_aw_user,
    output logic                                 dn_aw_valid,
    input  logic                                 dn_aw_ready,

    // W
    output logic [DOWNSTREAM_DATA_W-1:0]         dn_w_data,
    output logic [(DOWNSTREAM_DATA_W/8)-1:0]     dn_w_strb,
    output logic                                 dn_w_last,
    output logic [USER_W-1:0]                    dn_w_user,
    output logic                                 dn_w_valid,
    input  logic                                 dn_w_ready,

    // B
    input  logic [ID_W-1:0]                      dn_b_id,
    input  logic [1:0]                           dn_b_resp,
    input  logic [USER_W-1:0]                    dn_b_user,
    input  logic                                 dn_b_valid,
    output logic                                 dn_b_ready,

    // AR
    output logic [ID_W-1:0]                      dn_ar_id,
    output logic [ADDR_W-1:0]                    dn_ar_addr,
    output logic [BURST_LEN_W-1:0]               dn_ar_len,
    output logic [2:0]                           dn_ar_size,
    output logic [1:0]                           dn_ar_burst,
    output logic                                 dn_ar_lock,
    output logic [3:0]                           dn_ar_cache,
    output logic [2:0]                           dn_ar_prot,
    output logic [3:0]                           dn_ar_qos,
    output logic [3:0]                           dn_ar_region,
    output logic [USER_W-1:0]                    dn_ar_user,
    output logic                                 dn_ar_valid,
    input  logic                                 dn_ar_ready,

    // R
    input  logic [ID_W-1:0]                      dn_r_id,
    input  logic [DOWNSTREAM_DATA_W-1:0]         dn_r_data,
    input  logic [1:0]                           dn_r_resp,
    input  logic                                 dn_r_last,
    input  logic [USER_W-1:0]                    dn_r_user,
    input  logic                                 dn_r_valid,
    output logic                                 dn_r_ready
);

    // -----------------------------------------------------------------
    // Elaboration-time sanity checks.
    // -----------------------------------------------------------------
    // synthesis translate_off
    initial begin
        automatic int u = UPSTREAM_DATA_W;
        automatic int d = DOWNSTREAM_DATA_W;
        if (u < 8 || d < 8) begin
            $fatal(1, "e1_axi4_width_converter: widths must be >= 8 (got u=%0d d=%0d)", u, d);
        end
        if ((u & (u-1)) != 0 || (d & (d-1)) != 0) begin
            $fatal(1, "e1_axi4_width_converter: widths must be powers of two (got u=%0d d=%0d)", u, d);
        end
        if (u != d) begin
            automatic int hi = (u > d) ? u : d;
            automatic int lo = (u > d) ? d : u;
            if ((hi % lo) != 0) begin
                $fatal(1, "e1_axi4_width_converter: widths must be integer-ratio (u=%0d d=%0d)", u, d);
            end
        end
    end
    // synthesis translate_on

    // -----------------------------------------------------------------
    // Configuration discriminator.
    // -----------------------------------------------------------------
    localparam bit IS_PASS_THROUGH = (UPSTREAM_DATA_W == DOWNSTREAM_DATA_W);
    localparam bit IS_UPSIZE       = (UPSTREAM_DATA_W <  DOWNSTREAM_DATA_W);
    localparam bit IS_DOWNSIZE     = (UPSTREAM_DATA_W >  DOWNSTREAM_DATA_W);

    // RATIO is always >= 1 and selects how many narrow beats fit inside
    // one wide beat.  Defined relative to the wider side.
    localparam int unsigned RATIO_UP_TO_DN  = IS_UPSIZE   ? (DOWNSTREAM_DATA_W / UPSTREAM_DATA_W) : 1;
    localparam int unsigned RATIO_DN_TO_UP  = IS_DOWNSIZE ? (UPSTREAM_DATA_W   / DOWNSTREAM_DATA_W) : 1;

    // Number of byte-lane select bits on the wider side, used to locate
    // a narrow beat inside a wider beat.  Always >= 0; equal to log2(RATIO).
    function automatic int unsigned f_log2(input int unsigned x);
        int unsigned r;
        int unsigned v;
        begin
            r = 0;
            v = x;
            while (v > 1) begin
                v = v >> 1;
                r = r + 1;
            end
            f_log2 = r;
        end
    endfunction

    localparam int unsigned LANE_SEL_W_UP   = f_log2(RATIO_UP_TO_DN);   // upsize
    localparam int unsigned LANE_SEL_W_DN   = f_log2(RATIO_DN_TO_UP);   // downsize
    localparam int unsigned UP_BYTES        = UPSTREAM_DATA_W   / 8;
    localparam int unsigned DN_BYTES        = DOWNSTREAM_DATA_W / 8;
    localparam int unsigned UP_BYTE_OFF_W   = f_log2(UP_BYTES);
    localparam int unsigned DN_BYTE_OFF_W   = f_log2(DN_BYTES);

    // =================================================================
    // Configuration 1: passthrough
    // =================================================================
    generate
        if (IS_PASS_THROUGH) begin : g_passthrough
            assign dn_aw_id     = up_aw_id;
            assign dn_aw_addr   = up_aw_addr;
            assign dn_aw_len    = up_aw_len;
            assign dn_aw_size   = up_aw_size;
            assign dn_aw_burst  = up_aw_burst;
            assign dn_aw_lock   = up_aw_lock;
            assign dn_aw_cache  = up_aw_cache;
            assign dn_aw_prot   = up_aw_prot;
            assign dn_aw_qos    = up_aw_qos;
            assign dn_aw_region = up_aw_region;
            assign dn_aw_atop   = up_aw_atop;
            assign dn_aw_user   = up_aw_user;
            assign dn_aw_valid  = up_aw_valid;
            assign up_aw_ready  = dn_aw_ready;

            assign dn_w_data    = up_w_data;
            assign dn_w_strb    = up_w_strb;
            assign dn_w_last    = up_w_last;
            assign dn_w_user    = up_w_user;
            assign dn_w_valid   = up_w_valid;
            assign up_w_ready   = dn_w_ready;

            assign up_b_id      = dn_b_id;
            assign up_b_resp    = dn_b_resp;
            assign up_b_user    = dn_b_user;
            assign up_b_valid   = dn_b_valid;
            assign dn_b_ready   = up_b_ready;

            assign dn_ar_id     = up_ar_id;
            assign dn_ar_addr   = up_ar_addr;
            assign dn_ar_len    = up_ar_len;
            assign dn_ar_size   = up_ar_size;
            assign dn_ar_burst  = up_ar_burst;
            assign dn_ar_lock   = up_ar_lock;
            assign dn_ar_cache  = up_ar_cache;
            assign dn_ar_prot   = up_ar_prot;
            assign dn_ar_qos    = up_ar_qos;
            assign dn_ar_region = up_ar_region;
            assign dn_ar_user   = up_ar_user;
            assign dn_ar_valid  = up_ar_valid;
            assign up_ar_ready  = dn_ar_ready;

            assign up_r_id      = dn_r_id;
            assign up_r_data    = dn_r_data;
            assign up_r_resp    = dn_r_resp;
            assign up_r_last    = dn_r_last;
            assign up_r_user    = dn_r_user;
            assign up_r_valid   = dn_r_valid;
            assign dn_r_ready   = up_r_ready;
        end
    endgenerate

    // =================================================================
    // Configuration 2: upsize (narrow upstream -> wider downstream)
    //
    // AXI4 A8.4.1: when the master AxSIZE is smaller than the slave bus
    // size, beats flow 1:1 with data placed on the lane selected by the
    // low bits of the address.  AxLEN and AxSIZE are passed through.
    // WSTRB is replicated on the active lane and zero elsewhere.  Read
    // data is muxed off the same lane back to the narrow upstream.
    //
    // The implementation is single-inflight: a one-entry FIFO holds the
    // address bits used to pick the lane for W beats and R beats.  AW
    // and W are independent on the upstream side; the lane select for
    // W is sourced from the most recently accepted AW.
    // =================================================================
    generate
        if (IS_UPSIZE) begin : g_upsize
            // For up_w lane select we need the address bits [UP_BYTE_OFF_W +: LANE_SEL_W_UP].
            // For INCR bursts with AxSIZE == log2(UP_BYTES) the address advances by
            // UP_BYTES each beat, so the lane index advances by one per beat modulo
            // RATIO_UP_TO_DN.  The W-channel lane counter tracks that.  For AxSIZE
            // less than that the address is sub-bus and we use the same low bits.
            //
            // FSM signals.
            logic                       w_busy_q;
            logic [LANE_SEL_W_UP-1:0]   w_lane_q;
            logic [2:0]                 w_size_q;
            logic [BURST_LEN_W-1:0]     w_beats_left_q;

            logic                       r_busy_q;
            logic [LANE_SEL_W_UP-1:0]   r_lane_q;
            logic [2:0]                 r_size_q;
            logic [BURST_LEN_W-1:0]     r_beats_left_q;

            // ---------- AW / W path ----------
            // AW handshake passes through but is gated by w_busy so we
            // only accept a new AW after the previous write burst has
            // finished its B response (single inflight write).
            logic                       w_pending_q;

            // Initial lane derived from up_aw_addr.
            logic [LANE_SEL_W_UP-1:0]   aw_lane_init;
            assign aw_lane_init = up_aw_addr[UP_BYTE_OFF_W +: LANE_SEL_W_UP];

            assign dn_aw_id     = up_aw_id;
            assign dn_aw_addr   = up_aw_addr;
            assign dn_aw_len    = up_aw_len;
            assign dn_aw_size   = up_aw_size;
            assign dn_aw_burst  = up_aw_burst;
            assign dn_aw_lock   = up_aw_lock;
            assign dn_aw_cache  = up_aw_cache;
            assign dn_aw_prot   = up_aw_prot;
            assign dn_aw_qos    = up_aw_qos;
            assign dn_aw_region = up_aw_region;
            assign dn_aw_atop   = up_aw_atop;
            assign dn_aw_user   = up_aw_user;
            assign dn_aw_valid  = up_aw_valid & ~w_pending_q;
            assign up_aw_ready  = dn_aw_ready & ~w_pending_q;

            // W data: place up_w_data on the lane selected by w_lane_q.
            always_comb begin
                dn_w_data = '0;
                dn_w_strb = '0;
                dn_w_data[w_lane_q*UPSTREAM_DATA_W +: UPSTREAM_DATA_W] = up_w_data;
                dn_w_strb[w_lane_q*UP_BYTES        +: UP_BYTES]        = up_w_strb;
            end
            assign dn_w_last   = up_w_last;
            assign dn_w_user   = up_w_user;
            assign dn_w_valid  = up_w_valid & w_busy_q;
            assign up_w_ready  = dn_w_ready & w_busy_q;

            assign up_b_id     = dn_b_id;
            assign up_b_resp   = dn_b_resp;
            assign up_b_user   = dn_b_user;
            assign up_b_valid  = dn_b_valid;
            assign dn_b_ready  = up_b_ready;

            // FSM (writes)
            always_ff @(posedge clk_i or negedge rst_ni) begin
                if (!rst_ni) begin
                    w_pending_q   <= 1'b0;
                    w_busy_q      <= 1'b0;
                    w_lane_q      <= '0;
                    w_size_q      <= 3'd0;
                    w_beats_left_q<= '0;
                end else begin
                    // Accept AW: latch lane for W stream.
                    if (up_aw_valid && up_aw_ready) begin
                        w_pending_q   <= 1'b1;
                        w_busy_q      <= 1'b1;
                        w_lane_q      <= aw_lane_init;
                        w_size_q      <= up_aw_size;
                        w_beats_left_q<= up_aw_len;
                    end
                    // W beat fires: advance lane modulo RATIO if size is exactly
                    // the upstream bus width, else hold (sub-bus burst).
                    if (up_w_valid && up_w_ready) begin
                        if (w_size_q == 3'(UP_BYTE_OFF_W)) begin
                            w_lane_q <= w_lane_q + 1'b1;
                        end
                        if (up_w_last) begin
                            w_busy_q <= 1'b0;
                        end else begin
                            w_beats_left_q <= w_beats_left_q - 1'b1;
                        end
                    end
                    // B handshake clears pending.
                    if (dn_b_valid && dn_b_ready) begin
                        w_pending_q <= 1'b0;
                    end
                end
            end

            // ---------- AR / R path ----------
            logic                       r_pending_q;
            logic [LANE_SEL_W_UP-1:0]   ar_lane_init;
            assign ar_lane_init = up_ar_addr[UP_BYTE_OFF_W +: LANE_SEL_W_UP];

            assign dn_ar_id     = up_ar_id;
            assign dn_ar_addr   = up_ar_addr;
            assign dn_ar_len    = up_ar_len;
            assign dn_ar_size   = up_ar_size;
            assign dn_ar_burst  = up_ar_burst;
            assign dn_ar_lock   = up_ar_lock;
            assign dn_ar_cache  = up_ar_cache;
            assign dn_ar_prot   = up_ar_prot;
            assign dn_ar_qos    = up_ar_qos;
            assign dn_ar_region = up_ar_region;
            assign dn_ar_user   = up_ar_user;
            assign dn_ar_valid  = up_ar_valid & ~r_pending_q;
            assign up_ar_ready  = dn_ar_ready & ~r_pending_q;

            // R data: mux off the lane.
            assign up_r_id    = dn_r_id;
            assign up_r_data  = dn_r_data[r_lane_q*UPSTREAM_DATA_W +: UPSTREAM_DATA_W];
            assign up_r_resp  = dn_r_resp;
            assign up_r_last  = dn_r_last;
            assign up_r_user  = dn_r_user;
            assign up_r_valid = dn_r_valid & r_busy_q;
            assign dn_r_ready = up_r_ready & r_busy_q;

            always_ff @(posedge clk_i or negedge rst_ni) begin
                if (!rst_ni) begin
                    r_pending_q   <= 1'b0;
                    r_busy_q      <= 1'b0;
                    r_lane_q      <= '0;
                    r_size_q      <= 3'd0;
                    r_beats_left_q<= '0;
                end else begin
                    if (up_ar_valid && up_ar_ready) begin
                        r_pending_q   <= 1'b1;
                        r_busy_q      <= 1'b1;
                        r_lane_q      <= ar_lane_init;
                        r_size_q      <= up_ar_size;
                        r_beats_left_q<= up_ar_len;
                    end
                    if (dn_r_valid && dn_r_ready) begin
                        if (r_size_q == 3'(UP_BYTE_OFF_W)) begin
                            r_lane_q <= r_lane_q + 1'b1;
                        end
                        if (dn_r_last) begin
                            r_busy_q    <= 1'b0;
                            r_pending_q <= 1'b0;
                        end else begin
                            r_beats_left_q <= r_beats_left_q - 1'b1;
                        end
                    end
                end
            end
        end
    endgenerate

    // =================================================================
    // Configuration 3: downsize (wide upstream -> narrower downstream)
    //
    // AXI4 A8.4.2: each upstream beat with AxSIZE == log2(UP_BYTES) is
    // serialised into RATIO_DN_TO_UP downstream beats with the same
    // AxSIZE narrowed to log2(DN_BYTES).  AxLEN is scaled:
    //   new_len + 1 = (old_len + 1) * RATIO_DN_TO_UP    when sub-beat
    //                                                   matches widest
    //   new_len + 1 = (old_len + 1)                     when AxSIZE
    //                                                   already <= DN
    //
    // Single inflight write, single inflight read; B is forwarded 1:1.
    // The W path serialises one upstream beat into RATIO downstream
    // beats; the R path collects RATIO downstream beats into one
    // upstream beat.
    // =================================================================
    generate
        if (IS_DOWNSIZE) begin : g_downsize
            localparam logic [LANE_SEL_W_DN-1:0] DN_LAST_SUB =
                LANE_SEL_W_DN'(RATIO_DN_TO_UP-1);
            // ----- AW path -----
            logic                       aw_pending_q;
            logic [BURST_LEN_W-1:0]     dn_aw_len_calc;
            logic [2:0]                 dn_aw_size_calc;

            // Scaling: only scale if the upstream AxSIZE matches the upstream
            // bus width.  For smaller AxSIZE we keep len/size and let the
            // narrow downstream bus carry the same sub-beat.
            always_comb begin
                if (up_aw_size == 3'(UP_BYTE_OFF_W)) begin
                    dn_aw_size_calc = 3'(DN_BYTE_OFF_W);
                    dn_aw_len_calc  = ((up_aw_len + 1) * RATIO_DN_TO_UP) - 1;
                end else begin
                    dn_aw_size_calc = up_aw_size;
                    dn_aw_len_calc  = up_aw_len;
                end
            end

            assign dn_aw_id     = up_aw_id;
            assign dn_aw_addr   = up_aw_addr;
            assign dn_aw_len    = dn_aw_len_calc;
            assign dn_aw_size   = dn_aw_size_calc;
            assign dn_aw_burst  = up_aw_burst;
            assign dn_aw_lock   = up_aw_lock;
            assign dn_aw_cache  = up_aw_cache;
            assign dn_aw_prot   = up_aw_prot;
            assign dn_aw_qos    = up_aw_qos;
            assign dn_aw_region = up_aw_region;
            assign dn_aw_atop   = up_aw_atop;
            assign dn_aw_user   = up_aw_user;
            assign dn_aw_valid  = up_aw_valid & ~aw_pending_q;
            assign up_aw_ready  = dn_aw_ready & ~aw_pending_q;

            // ----- W path: serialise one wide beat to RATIO narrow beats -----
            logic [LANE_SEL_W_DN-1:0]   w_sub_q;
            logic                       w_active_q;
            logic                       w_was_last_q;
            logic [2:0]                 w_size_q_dn;

            assign dn_w_data = up_w_data[w_sub_q*DOWNSTREAM_DATA_W +: DOWNSTREAM_DATA_W];
            assign dn_w_strb = up_w_strb[w_sub_q*DN_BYTES          +: DN_BYTES];
            // dn_w_last fires on the last sub-beat of the upstream's last beat.
            assign dn_w_last = up_w_last & (w_sub_q == DN_LAST_SUB);
            assign dn_w_user = up_w_user;
            assign dn_w_valid = up_w_valid & w_active_q;
            // up_w_ready: only acknowledge upstream beat when we've finished
            // emitting RATIO sub-beats downstream.
            assign up_w_ready = w_active_q & dn_w_ready & (w_sub_q == DN_LAST_SUB);

            always_ff @(posedge clk_i or negedge rst_ni) begin
                if (!rst_ni) begin
                    aw_pending_q <= 1'b0;
                    w_sub_q      <= '0;
                    w_active_q   <= 1'b0;
                    w_was_last_q <= 1'b0;
                    w_size_q_dn  <= '0;
                end else begin
                    if (up_aw_valid && up_aw_ready) begin
                        aw_pending_q <= 1'b1;
                        w_active_q   <= 1'b1;
                        w_sub_q      <= '0;
                        w_size_q_dn  <= dn_aw_size_calc;
                    end
                    if (dn_w_valid && dn_w_ready) begin
                        if (w_size_q_dn == 3'(DN_BYTE_OFF_W)) begin
                            w_sub_q <= w_sub_q + 1'b1;
                        end
                    end
                    if (up_w_valid && up_w_ready) begin
                        w_sub_q <= '0;
                        if (up_w_last) begin
                            w_active_q <= 1'b0;
                        end
                    end
                    if (dn_b_valid && dn_b_ready) begin
                        aw_pending_q <= 1'b0;
                    end
                end
            end

            // B passthrough
            assign up_b_id    = dn_b_id;
            assign up_b_resp  = dn_b_resp;
            assign up_b_user  = dn_b_user;
            assign up_b_valid = dn_b_valid;
            assign dn_b_ready = up_b_ready;

            // ----- AR path -----
            logic                       ar_pending_q;
            logic [BURST_LEN_W-1:0]     dn_ar_len_calc;
            logic [2:0]                 dn_ar_size_calc;
            always_comb begin
                if (up_ar_size == 3'(UP_BYTE_OFF_W)) begin
                    dn_ar_size_calc = 3'(DN_BYTE_OFF_W);
                    dn_ar_len_calc  = ((up_ar_len + 1) * RATIO_DN_TO_UP) - 1;
                end else begin
                    dn_ar_size_calc = up_ar_size;
                    dn_ar_len_calc  = up_ar_len;
                end
            end
            assign dn_ar_id     = up_ar_id;
            assign dn_ar_addr   = up_ar_addr;
            assign dn_ar_len    = dn_ar_len_calc;
            assign dn_ar_size   = dn_ar_size_calc;
            assign dn_ar_burst  = up_ar_burst;
            assign dn_ar_lock   = up_ar_lock;
            assign dn_ar_cache  = up_ar_cache;
            assign dn_ar_prot   = up_ar_prot;
            assign dn_ar_qos    = up_ar_qos;
            assign dn_ar_region = up_ar_region;
            assign dn_ar_user   = up_ar_user;
            assign dn_ar_valid  = up_ar_valid & ~ar_pending_q;
            assign up_ar_ready  = dn_ar_ready & ~ar_pending_q;

            // ----- R path: collect RATIO narrow beats into one wide beat -----
            logic [UPSTREAM_DATA_W-1:0] r_buf_q;
            logic [LANE_SEL_W_DN-1:0]   r_sub_q;
            logic                       r_active_q;
            logic [ID_W-1:0]            r_id_q;
            logic [1:0]                 r_resp_q;
            logic [USER_W-1:0]          r_user_q;
            logic [2:0]                 r_size_q_dn;

            // up_r data is the buffered upstream beat composed of the last
            // RATIO downstream beats.  We assemble in r_buf_q and present
            // it once the final sub-beat arrives.
            logic                       r_present;
            assign r_present = dn_r_valid & r_active_q &
                               (r_sub_q == DN_LAST_SUB);
            assign dn_r_ready = r_active_q & (~r_present | up_r_ready);

            logic [UPSTREAM_DATA_W-1:0] r_combined;
            always_comb begin
                r_combined = r_buf_q;
                r_combined[r_sub_q*DOWNSTREAM_DATA_W +: DOWNSTREAM_DATA_W] = dn_r_data;
            end

            assign up_r_id    = r_id_q;
            assign up_r_data  = r_combined;
            assign up_r_resp  = r_resp_q;
            assign up_r_last  = dn_r_last;
            assign up_r_user  = r_user_q;
            assign up_r_valid = r_present;

            always_ff @(posedge clk_i or negedge rst_ni) begin
                if (!rst_ni) begin
                    ar_pending_q <= 1'b0;
                    r_buf_q      <= '0;
                    r_sub_q      <= '0;
                    r_active_q   <= 1'b0;
                    r_id_q       <= '0;
                    r_resp_q     <= 2'b00;
                    r_user_q     <= '0;
                    r_size_q_dn  <= '0;
                end else begin
                    if (up_ar_valid && up_ar_ready) begin
                        ar_pending_q <= 1'b1;
                        r_active_q   <= 1'b1;
                        r_sub_q      <= '0;
                        r_buf_q      <= '0;
                        r_size_q_dn  <= dn_ar_size_calc;
                    end
                    // Latch sub-beats into the buffer; combine the highest
                    // priority resp (SLVERR > DECERR > EXOKAY > OKAY by
                    // AXI4 A3.4.4, but a simple OR-of-non-zero is acceptable
                    // for single-id streams).
                    if (dn_r_valid && dn_r_ready) begin
                        r_buf_q[r_sub_q*DOWNSTREAM_DATA_W +: DOWNSTREAM_DATA_W] <= dn_r_data;
                        r_id_q   <= dn_r_id;
                        r_user_q <= dn_r_user;
                        if (dn_r_resp != 2'b00) r_resp_q <= dn_r_resp;
                        if (r_size_q_dn == 3'(DN_BYTE_OFF_W)) begin
                            if (r_sub_q == DN_LAST_SUB) begin
                                r_sub_q <= '0;
                                r_resp_q <= 2'b00;
                            end else begin
                                r_sub_q <= r_sub_q + 1'b1;
                            end
                        end
                        if (dn_r_last) begin
                            r_active_q   <= 1'b0;
                            ar_pending_q <= 1'b0;
                        end
                    end
                end
            end
        end
    endgenerate

endmodule
/* verilator lint_on UNUSEDSIGNAL */
/* verilator lint_on DECLFILENAME */
