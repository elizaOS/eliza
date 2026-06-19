`timescale 1ns/1ps

// e1_axi4_dram_model
//
// Behavioural AXI4 DRAM slave model used for burst-capable interconnect
// verification.  This is NOT a real DRAM controller.  Real LPDDR5X/LPDDR6
// controllers are blocked under
// docs/evidence/memory/lpddr-phy-procurement.yaml and require a closed-IP
// PHY at 10.67 / 14.4 Gbps.  The behavioural model implements:
//
//   * AXI4 INCR, WRAP, FIXED bursts with AWLEN/ARLEN up to 256.
//   * AxSIZE-aware byte addressing within DATA_WIDTH-wide beats.
//   * Independent backpressure on every channel; one in-flight write or
//     read burst per ID, with per-ID FIFO ordering kept by the upstream
//     interconnect.
//   * Behavioural latency: a constant CMD_LATENCY + per-beat DATA_LATENCY
//     to approximate refresh/bank-conflict averaged jitter.  The wrapper
//     under compiler/runtime/dramsim_wrap/ replaces this with DRAMSim3 or
//     Ramulator2 cycle-accurate timing.
//   * Decode-aligned aperture: storage is parameterised in bytes.
//
// The model is intentionally pessimistic: it serves one outstanding
// request at a time per channel to keep the interconnect verification
// surface deterministic.

module e1_axi4_dram_model
    import e1_axi4_pkg::*;
#(
    parameter int unsigned ID_WIDTH      = 6,
    parameter int unsigned ADDR_WIDTH    = 40,
    parameter int unsigned DATA_WIDTH    = 128,
    parameter int unsigned USER_WIDTH    = 8,
    parameter int unsigned BURST_LEN_W   = 8,
    parameter int unsigned DEPTH_BYTES   = 4096,
    parameter int unsigned CMD_LATENCY   = 8,
    parameter int unsigned DATA_LATENCY  = 1
) (
    input  logic clk,
    input  logic rst_n,

    input  logic                    s_awvalid,
    output logic                    s_awready,
    input  logic [ID_WIDTH-1:0]     s_awid,
    input  logic [ADDR_WIDTH-1:0]   s_awaddr,
    input  logic [BURST_LEN_W-1:0]  s_awlen,
    input  logic [2:0]              s_awsize,
    input  logic [1:0]              s_awburst,
    input  logic                    s_awlock,
    input  logic [3:0]              s_awcache,
    input  logic [2:0]              s_awprot,
    input  logic [3:0]              s_awqos,
    input  logic [USER_WIDTH-1:0]   s_awuser,

    input  logic                    s_wvalid,
    output logic                    s_wready,
    input  logic [DATA_WIDTH-1:0]   s_wdata,
    input  logic [DATA_WIDTH/8-1:0] s_wstrb,
    input  logic                    s_wlast,

    output logic                    s_bvalid,
    input  logic                    s_bready,
    output logic [ID_WIDTH-1:0]     s_bid,
    output logic [1:0]              s_bresp,

    input  logic                    s_arvalid,
    output logic                    s_arready,
    input  logic [ID_WIDTH-1:0]     s_arid,
    input  logic [ADDR_WIDTH-1:0]   s_araddr,
    input  logic [BURST_LEN_W-1:0]  s_arlen,
    input  logic [2:0]              s_arsize,
    input  logic [1:0]              s_arburst,
    input  logic                    s_arlock,
    input  logic [3:0]              s_arcache,
    input  logic [2:0]              s_arprot,
    input  logic [3:0]              s_arqos,
    input  logic [USER_WIDTH-1:0]   s_aruser,

    output logic                    s_rvalid,
    input  logic                    s_rready,
    output logic [ID_WIDTH-1:0]     s_rid,
    output logic [DATA_WIDTH-1:0]   s_rdata,
    output logic [1:0]              s_rresp,
    output logic                    s_rlast
);

    localparam int unsigned BYTES_PER_BEAT = DATA_WIDTH / 8;
    localparam int unsigned BEAT_WORDS     = BYTES_PER_BEAT / 4;
    localparam int unsigned NUM_BEATS      = DEPTH_BYTES / BYTES_PER_BEAT;
    localparam int unsigned BEAT_IDX_W     = $clog2(NUM_BEATS);

    // Byte-addressable storage organized as data-wide beats
    logic [DATA_WIDTH-1:0] mem [0:NUM_BEATS-1];

    // ------------------------------------------------------------------
    // Write state machine
    // ------------------------------------------------------------------
    typedef enum logic [2:0] {
        W_IDLE,
        W_CMD_LAT,
        W_DATA,
        W_RESP_LAT,
        W_RESP
    } w_state_e;

    w_state_e               w_state;
    logic [ID_WIDTH-1:0]    w_id_q;
    logic [ADDR_WIDTH-1:0]  w_addr_q;
    logic [BURST_LEN_W-1:0] w_len_q;
    logic [2:0]             w_size_q;
    logic [1:0]             w_burst_q;
    logic [BURST_LEN_W:0]   w_beat_idx;
    logic                   w_addr_oob;
    logic [$clog2(CMD_LATENCY+1)-1:0] w_lat;

    function automatic logic [ADDR_WIDTH-1:0] next_addr(
        input logic [ADDR_WIDTH-1:0] base,
        input logic [ADDR_WIDTH-1:0] cur,
        input logic [BURST_LEN_W-1:0] len,
        input logic [2:0] size,
        input logic [1:0] burst
    );
        logic [ADDR_WIDTH-1:0] inc;
        inc = ADDR_WIDTH'(1) << size;
        case (burst)
            BURST_FIXED: next_addr = cur;
            BURST_WRAP: begin
                logic [ADDR_WIDTH-1:0] wrap_size;
                wrap_size = inc * (ADDR_WIDTH'(len) + ADDR_WIDTH'(1));
                next_addr = (cur + inc) & ~(wrap_size - 1) | (base & ~(wrap_size - 1));
                // Simple wrap: keep upper bits from base, lower bits roll over
                next_addr = (base & ~(wrap_size - 1)) |
                            ((cur + inc) & (wrap_size - 1));
            end
            default: next_addr = cur + inc;
        endcase
    endfunction

    assign s_awready = (w_state == W_IDLE);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            w_state    <= W_IDLE;
            w_id_q     <= '0;
            w_addr_q   <= '0;
            w_len_q    <= '0;
            w_size_q   <= '0;
            w_burst_q  <= BURST_INCR;
            w_beat_idx <= '0;
            w_addr_oob <= 1'b0;
            w_lat      <= '0;
            s_bvalid   <= 1'b0;
            s_bid      <= '0;
            s_bresp    <= RESP_OKAY;
        end else begin
            unique case (w_state)
                W_IDLE: begin
                    if (s_awvalid && s_awready) begin
                        w_id_q     <= s_awid;
                        w_addr_q   <= s_awaddr;
                        w_len_q    <= s_awlen;
                        w_size_q   <= s_awsize;
                        w_burst_q  <= s_awburst;
                        w_beat_idx <= '0;
                        w_addr_oob <= 1'b0;
                        w_lat      <= '0;
                        w_state    <= W_CMD_LAT;
                    end
                end
                W_CMD_LAT: begin
                    if (w_lat == $clog2(CMD_LATENCY+1)'(CMD_LATENCY - 1)) begin
                        w_state <= W_DATA;
                        w_lat   <= '0;
                    end else begin
                        w_lat <= w_lat + 1'b1;
                    end
                end
                W_DATA: begin
                    if (s_wvalid && s_wready) begin
                        logic [ADDR_WIDTH-1:0] beat_byte_addr;
                        beat_byte_addr = w_addr_q;
                        if (beat_byte_addr >= ADDR_WIDTH'(DEPTH_BYTES)) begin
                            w_addr_oob <= 1'b1;
                        end else begin
                            logic [BEAT_IDX_W-1:0] beat_idx;
                            beat_idx = beat_byte_addr[BEAT_IDX_W-1+$clog2(BYTES_PER_BEAT) : $clog2(BYTES_PER_BEAT)];
                            for (int b = 0; b < BYTES_PER_BEAT; b++) begin
                                if (s_wstrb[b]) begin
                                    mem[beat_idx][b*8 +: 8] <= s_wdata[b*8 +: 8];
                                end
                            end
                        end
                        w_addr_q <= next_addr(w_addr_q, w_addr_q, w_len_q, w_size_q, w_burst_q);
                        w_beat_idx <= w_beat_idx + 1'b1;
                        if (s_wlast) begin
                            w_state <= W_RESP_LAT;
                            w_lat   <= '0;
                        end
                    end
                end
                W_RESP_LAT: begin
                    if (w_lat == $clog2(CMD_LATENCY+1)'(DATA_LATENCY)) begin
                        s_bvalid <= 1'b1;
                        s_bid    <= w_id_q;
                        s_bresp  <= w_addr_oob ? RESP_SLVERR : RESP_OKAY;
                        w_state  <= W_RESP;
                        w_lat    <= '0;
                    end else begin
                        w_lat <= w_lat + 1'b1;
                    end
                end
                W_RESP: begin
                    if (s_bvalid && s_bready) begin
                        s_bvalid <= 1'b0;
                        w_state  <= W_IDLE;
                    end
                end
                default: w_state <= W_IDLE;
            endcase
        end
    end

    assign s_wready = (w_state == W_DATA);

    // ------------------------------------------------------------------
    // Read state machine
    // ------------------------------------------------------------------
    typedef enum logic [2:0] {
        R_IDLE,
        R_CMD_LAT,
        R_DATA
    } r_state_e;

    r_state_e               r_state;
    logic [ID_WIDTH-1:0]    r_id_q;
    logic [ADDR_WIDTH-1:0]  r_addr_q;
    logic [BURST_LEN_W-1:0] r_len_q;
    logic [BURST_LEN_W:0]   r_beat_idx;
    logic [2:0]             r_size_q;
    logic [1:0]             r_burst_q;
    logic [$clog2(CMD_LATENCY+1)-1:0] r_lat;

    assign s_arready = (r_state == R_IDLE);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            r_state    <= R_IDLE;
            r_id_q     <= '0;
            r_addr_q   <= '0;
            r_len_q    <= '0;
            r_beat_idx <= '0;
            r_size_q   <= '0;
            r_burst_q  <= BURST_INCR;
            r_lat      <= '0;
            s_rvalid   <= 1'b0;
            s_rid      <= '0;
            s_rdata    <= '0;
            s_rresp    <= RESP_OKAY;
            s_rlast    <= 1'b0;
        end else begin
            unique case (r_state)
                R_IDLE: begin
                    if (s_arvalid && s_arready) begin
                        r_id_q     <= s_arid;
                        r_addr_q   <= s_araddr;
                        r_len_q    <= s_arlen;
                        r_size_q   <= s_arsize;
                        r_burst_q  <= s_arburst;
                        r_beat_idx <= '0;
                        r_lat      <= '0;
                        r_state    <= R_CMD_LAT;
                    end
                end
                R_CMD_LAT: begin
                    if (r_lat == $clog2(CMD_LATENCY+1)'(CMD_LATENCY - 1)) begin
                        r_state <= R_DATA;
                        r_lat   <= '0;
                    end else begin
                        r_lat <= r_lat + 1'b1;
                    end
                end
                R_DATA: begin
                    // Phase A: prefill (a new burst — no in-flight beat yet)
                    if (!s_rvalid) begin
                        logic [ADDR_WIDTH-1:0] beat_byte_addr;
                        beat_byte_addr = r_addr_q;
                        if (beat_byte_addr >= ADDR_WIDTH'(DEPTH_BYTES)) begin
                            s_rdata <= {DATA_WIDTH{1'b0}} | DATA_WIDTH'(64'hDEAD_BEEF_DEAD_BEEF);
                            s_rresp <= RESP_SLVERR;
                        end else begin
                            logic [BEAT_IDX_W-1:0] beat_idx;
                            beat_idx = beat_byte_addr[BEAT_IDX_W-1+$clog2(BYTES_PER_BEAT) : $clog2(BYTES_PER_BEAT)];
                            s_rdata <= mem[beat_idx];
                            s_rresp <= RESP_OKAY;
                        end
                        s_rvalid <= 1'b1;
                        s_rid    <= r_id_q;
                        s_rlast  <= (r_beat_idx == r_len_q);
                    end else if (s_rready) begin
                        // Phase B: beat handshake completed this cycle.
                        if (s_rlast) begin
                            s_rvalid <= 1'b0;
                            s_rlast  <= 1'b0;
                            r_state  <= R_IDLE;
                        end else begin
                            logic [ADDR_WIDTH-1:0] next_byte_addr;
                            next_byte_addr = next_addr(r_addr_q, r_addr_q, r_len_q,
                                                       r_size_q, r_burst_q);
                            r_addr_q   <= next_byte_addr;
                            r_beat_idx <= r_beat_idx + 1'b1;
                            if (next_byte_addr >= ADDR_WIDTH'(DEPTH_BYTES)) begin
                                s_rdata <= {DATA_WIDTH{1'b0}} | DATA_WIDTH'(64'hDEAD_BEEF_DEAD_BEEF);
                                s_rresp <= RESP_SLVERR;
                            end else begin
                                logic [BEAT_IDX_W-1:0] beat_idx_n;
                                beat_idx_n = next_byte_addr[BEAT_IDX_W-1+$clog2(BYTES_PER_BEAT) : $clog2(BYTES_PER_BEAT)];
                                s_rdata <= mem[beat_idx_n];
                                s_rresp <= RESP_OKAY;
                            end
                            // Keep s_rvalid=1, set rlast if this is the new last beat
                            s_rlast <= ((r_beat_idx + 1'b1) == r_len_q);
                        end
                    end
                end
                default: r_state <= R_IDLE;
            endcase
        end
    end

endmodule
