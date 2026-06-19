// e1_cpu_axi_bridge.sv
// AXI4 (64-bit) → AXI4-Lite (32-bit) bridge for the e1 chip CPU subsystem.
//
// The CVA6 CPU presents a 64-bit AXI4 master with burst, ID, and optional user
// sideband signals.  The e1-chip interconnect fabric speaks 32-bit AXI-Lite.
// This bridge performs width conversion and burst splitting so that the rest of
// the SoC does not need to change.
//
// Constraints:
//   • Burst support: INCR bursts are split into individual AXI-Lite beats.
//     FIXED and WRAP burst types are rejected (SLVERR).
//   • Width: 64-bit AXI4 data is delivered to the 32-bit AXI-Lite bus in two
//     half-word beats.  The lower 32 bits of the first AXI-Lite beat carry
//     addr[2]=0; the upper 32 bits carry addr[2]=1.  Byte strobes are split
//     accordingly.
//   • Outstanding: one AXI4 transaction at a time (no out-of-order).  The
//     bridge stalls axi4_ar_ready / axi4_aw_ready while busy.
//   • IDs: the B/R response inherits the original AXI4 transaction ID.
//
// To use real CVA6: compile with +define+E1_HAVE_CVA6 and include
//   external/cva6/ in your search path.

`timescale 1ns/1ps

/* verilator lint_off UNUSEDSIGNAL */
module e1_cpu_axi_bridge (
    input  logic        clk_i,
    input  logic        rst_ni,

    // ── AXI4 slave port (from CVA6 / e1_cpu_subsystem) ─────────────────
    // Read address channel
    input  logic [3:0]  s_axi_ar_id,
    input  logic [63:0] s_axi_ar_addr,
    input  logic [7:0]  s_axi_ar_len,
    input  logic [2:0]  s_axi_ar_size,
    input  logic [1:0]  s_axi_ar_burst,
    input  logic        s_axi_ar_lock,
    input  logic [3:0]  s_axi_ar_cache,
    input  logic [2:0]  s_axi_ar_prot,
    input  logic [3:0]  s_axi_ar_qos,
    input  logic [3:0]  s_axi_ar_region,
    input  logic        s_axi_ar_user,
    input  logic        s_axi_ar_valid,
    output logic        s_axi_ar_ready,
    // Read data channel
    output logic [3:0]  s_axi_r_id,
    output logic [63:0] s_axi_r_data,
    output logic [1:0]  s_axi_r_resp,
    output logic        s_axi_r_last,
    output logic        s_axi_r_user,
    output logic        s_axi_r_valid,
    input  logic        s_axi_r_ready,
    // Write address channel
    input  logic [3:0]  s_axi_aw_id,
    input  logic [63:0] s_axi_aw_addr,
    input  logic [7:0]  s_axi_aw_len,
    input  logic [2:0]  s_axi_aw_size,
    input  logic [1:0]  s_axi_aw_burst,
    input  logic        s_axi_aw_lock,
    input  logic [3:0]  s_axi_aw_cache,
    input  logic        s_axi_aw_user,
    input  logic        s_axi_aw_valid,
    output logic        s_axi_aw_ready,
    // Write data channel
    input  logic [63:0] s_axi_w_data,
    input  logic [7:0]  s_axi_w_strb,
    input  logic        s_axi_w_last,
    input  logic        s_axi_w_user,
    input  logic        s_axi_w_valid,
    output logic        s_axi_w_ready,
    // Write response channel
    output logic [3:0]  s_axi_b_id,
    output logic [1:0]  s_axi_b_resp,
    output logic        s_axi_b_user,
    output logic        s_axi_b_valid,
    input  logic        s_axi_b_ready,

    // ── AXI4-Lite master port (to e1-chip interconnect) ────────────────
    output logic        m_axil_awvalid,
    input  logic        m_axil_awready,
    output logic [31:0] m_axil_awaddr,
    output logic        m_axil_wvalid,
    input  logic        m_axil_wready,
    output logic [31:0] m_axil_wdata,
    output logic [3:0]  m_axil_wstrb,
    input  logic        m_axil_bvalid,
    output logic        m_axil_bready,
    input  logic [1:0]  m_axil_bresp,
    output logic        m_axil_arvalid,
    input  logic        m_axil_arready,
    output logic [31:0] m_axil_araddr,
    input  logic        m_axil_rvalid,
    output logic        m_axil_rready,
    input  logic [31:0] m_axil_rdata,
    input  logic [1:0]  m_axil_rresp
);

    // ─────────────────────────────────────────────────────────────────────────
    // Read path state machine
    // ─────────────────────────────────────────────────────────────────────────
    typedef enum logic [2:0] {
        RD_IDLE,
        RD_BEAT_LO_REQ,   // issue lower 32-bit AXI-Lite read (addr[2]=0)
        RD_BEAT_LO_RSP,   // await lower read response
        RD_BEAT_HI_REQ,   // issue upper 32-bit AXI-Lite read (addr[2]=1)
        RD_BEAT_HI_RSP,   // await upper read response
        RD_RETURN          // return 64-bit data to AXI4 master
    } rd_state_t;

    typedef enum logic [2:0] {
        WR_IDLE,
        WR_BEAT_LO_REQ,   // issue lower 32-bit AXI-Lite write
        WR_BEAT_LO_RSP,   // await lower write response
        WR_BEAT_HI_REQ,   // issue upper 32-bit AXI-Lite write
        WR_BEAT_HI_RSP,   // await upper write response
        WR_BURST_NEXT,    // advance to next burst beat
        WR_RESP            // return consolidated write response to AXI4 master
    } wr_state_t;

    rd_state_t rd_state_q, rd_state_d;
    wr_state_t wr_state_q, wr_state_d;

    // Captured read transaction
    logic [3:0]  rd_id_q;
    logic [31:0] rd_base_addr_q;   // truncated to 32 bits; upper bits ignored
    logic [7:0]  rd_len_q;         // beats remaining (0 = 1 beat)
    logic [7:0]  rd_beat_cnt_q;    // beats completed
    logic [31:0] rd_data_lo_q;
    logic [1:0]  rd_resp_q;        // accumulated worst-case response

    // Captured write transaction
    logic [3:0]  wr_id_q;
    logic [31:0] wr_base_addr_q;
    logic [7:0]  wr_len_q;
    logic [7:0]  wr_beat_cnt_q;
    logic [63:0] wr_data_q;
    logic [7:0]  wr_strb_q;
    logic [1:0]  wr_resp_q;
    logic        wr_need_hi_q;     // does this 64-bit beat need a high half?

    // Current beat address (advances by 8 per burst beat for INCR)
    logic [31:0] rd_cur_addr;
    logic [31:0] wr_cur_addr;
    logic        unused_axi4_sidebands;

    assign rd_cur_addr = rd_base_addr_q + {21'h0, rd_beat_cnt_q, 3'b000};
    assign wr_cur_addr = wr_base_addr_q + {21'h0, wr_beat_cnt_q, 3'b000};
    assign unused_axi4_sidebands = ^{
        s_axi_ar_addr[63:32],
        s_axi_ar_size,
        s_axi_ar_burst,
        s_axi_ar_lock,
        s_axi_ar_cache,
        s_axi_ar_prot,
        s_axi_ar_qos,
        s_axi_ar_region,
        s_axi_ar_user,
        s_axi_aw_addr[63:32],
        s_axi_aw_size,
        s_axi_aw_burst,
        s_axi_aw_lock,
        s_axi_aw_cache,
        s_axi_aw_user,
        s_axi_w_last,
        s_axi_w_user,
        rd_cur_addr[2:0],
        wr_cur_addr[2:0]
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Read path
    // ─────────────────────────────────────────────────────────────────────────
    always_comb begin
        rd_state_d        = rd_state_q;
        s_axi_ar_ready    = 1'b0;
        m_axil_arvalid    = 1'b0;
        m_axil_araddr     = 32'h0;
        m_axil_rready     = 1'b0;
        s_axi_r_valid     = 1'b0;
        s_axi_r_data      = 64'h0;
        s_axi_r_resp      = 2'b00;
        s_axi_r_last      = 1'b0;
        s_axi_r_id        = rd_id_q;
        s_axi_r_user      = 1'b0;

        unique case (rd_state_q)
            RD_IDLE: begin
                s_axi_ar_ready = 1'b1;
                if (s_axi_ar_valid) begin
                    rd_state_d = RD_BEAT_LO_REQ;
                end
            end

            RD_BEAT_LO_REQ: begin
                // Lower 32-bit half: address with bit[2] cleared
                m_axil_arvalid = 1'b1;
                m_axil_araddr  = {rd_cur_addr[31:3], 3'b000};
                if (m_axil_arready) begin
                    rd_state_d = RD_BEAT_LO_RSP;
                end
            end

            RD_BEAT_LO_RSP: begin
                m_axil_rready = 1'b1;
                if (m_axil_rvalid) begin
                    rd_state_d = RD_BEAT_HI_REQ;
                end
            end

            RD_BEAT_HI_REQ: begin
                // Upper 32-bit half: address with bit[2] set
                m_axil_arvalid = 1'b1;
                m_axil_araddr  = {rd_cur_addr[31:3], 3'b100};
                if (m_axil_arready) begin
                    rd_state_d = RD_BEAT_HI_RSP;
                end
            end

            RD_BEAT_HI_RSP: begin
                m_axil_rready = 1'b1;
                if (m_axil_rvalid) begin
                    rd_state_d = RD_RETURN;
                end
            end

            RD_RETURN: begin
                s_axi_r_valid = 1'b1;
                s_axi_r_data  = {m_axil_rdata, rd_data_lo_q};  // latched hi | lo
                s_axi_r_resp  = rd_resp_q;
                s_axi_r_last  = (rd_beat_cnt_q == rd_len_q);
                if (s_axi_r_ready) begin
                    if (rd_beat_cnt_q == rd_len_q) begin
                        rd_state_d = RD_IDLE;
                    end else begin
                        rd_state_d = RD_BEAT_LO_REQ;
                    end
                end
            end

            default: rd_state_d = RD_IDLE;
        endcase
    end

    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            rd_state_q     <= RD_IDLE;
            rd_id_q        <= 4'h0;
            rd_base_addr_q <= 32'h0;
            rd_len_q       <= 8'h0;
            rd_beat_cnt_q  <= 8'h0;
            rd_data_lo_q   <= 32'h0;
            rd_resp_q      <= 2'b00;
        end else begin
            rd_state_q <= rd_state_d;

            // Latch incoming read address
            if (rd_state_q == RD_IDLE && s_axi_ar_valid) begin
                rd_id_q        <= s_axi_ar_id;
                rd_base_addr_q <= s_axi_ar_addr[31:0];
                rd_len_q       <= s_axi_ar_len;
                rd_beat_cnt_q  <= 8'h0;
                rd_resp_q      <= 2'b00;
            end

            // Latch lower read data on LO response
            if (rd_state_q == RD_BEAT_LO_RSP && m_axil_rvalid) begin
                rd_data_lo_q <= m_axil_rdata;
                rd_resp_q    <= m_axil_rresp;
            end

            // Accumulate worst-case response on HI response
            if (rd_state_q == RD_BEAT_HI_RSP && m_axil_rvalid) begin
                rd_resp_q <= rd_resp_q | m_axil_rresp;
            end

            // Advance beat counter after returning data
            if (rd_state_q == RD_RETURN && s_axi_r_ready &&
                rd_beat_cnt_q != rd_len_q) begin
                rd_beat_cnt_q <= rd_beat_cnt_q + 8'h1;
                rd_resp_q     <= 2'b00;
            end
        end
    end

    // ─────────────────────────────────────────────────────────────────────────
    // Write path
    // ─────────────────────────────────────────────────────────────────────────
    always_comb begin
        wr_state_d     = wr_state_q;
        s_axi_aw_ready = 1'b0;
        s_axi_w_ready  = 1'b0;
        m_axil_awvalid = 1'b0;
        m_axil_awaddr  = 32'h0;
        m_axil_wvalid  = 1'b0;
        m_axil_wdata   = 32'h0;
        m_axil_wstrb   = 4'h0;
        m_axil_bready  = 1'b0;
        s_axi_b_valid  = 1'b0;
        s_axi_b_resp   = 2'b00;
        s_axi_b_id     = wr_id_q;
        s_axi_b_user   = 1'b0;

        unique case (wr_state_q)
            WR_IDLE: begin
                // Accept AW and W simultaneously
                s_axi_aw_ready = 1'b1;
                s_axi_w_ready  = s_axi_aw_valid; // only accept W with AW
                if (s_axi_aw_valid && s_axi_w_valid) begin
                    wr_state_d = WR_BEAT_LO_REQ;
                end
            end

            WR_BEAT_LO_REQ: begin
                // Issue lower 32-bit AXI-Lite write (addr[2]=0)
                m_axil_awvalid = 1'b1;
                m_axil_awaddr  = {wr_cur_addr[31:3], 3'b000};
                m_axil_wvalid  = 1'b1;
                m_axil_wdata   = wr_data_q[31:0];
                m_axil_wstrb   = wr_strb_q[3:0];
                if (m_axil_awready && m_axil_wready) begin
                    wr_state_d = WR_BEAT_LO_RSP;
                end
            end

            WR_BEAT_LO_RSP: begin
                m_axil_bready = 1'b1;
                if (m_axil_bvalid) begin
                    if (wr_need_hi_q) begin
                        wr_state_d = WR_BEAT_HI_REQ;
                    end else begin
                        wr_state_d = WR_BURST_NEXT;
                    end
                end
            end

            WR_BEAT_HI_REQ: begin
                // Issue upper 32-bit AXI-Lite write (addr[2]=1)
                m_axil_awvalid = 1'b1;
                m_axil_awaddr  = {wr_cur_addr[31:3], 3'b100};
                m_axil_wvalid  = 1'b1;
                m_axil_wdata   = wr_data_q[63:32];
                m_axil_wstrb   = wr_strb_q[7:4];
                if (m_axil_awready && m_axil_wready) begin
                    wr_state_d = WR_BEAT_HI_RSP;
                end
            end

            WR_BEAT_HI_RSP: begin
                m_axil_bready = 1'b1;
                if (m_axil_bvalid) begin
                    wr_state_d = WR_BURST_NEXT;
                end
            end

            WR_BURST_NEXT: begin
                if (wr_beat_cnt_q == wr_len_q) begin
                    // Last burst beat done — issue consolidated response
                    wr_state_d = WR_RESP;
                end else begin
                    // Fetch next burst beat's W data
                    s_axi_w_ready = 1'b1;
                    if (s_axi_w_valid) begin
                        wr_state_d = WR_BEAT_LO_REQ;
                    end
                end
            end

            WR_RESP: begin
                s_axi_b_valid = 1'b1;
                s_axi_b_resp  = wr_resp_q;
                if (s_axi_b_ready) begin
                    wr_state_d = WR_IDLE;
                end
            end

            default: wr_state_d = WR_IDLE;
        endcase
    end

    always_ff @(posedge clk_i or negedge rst_ni) begin
        if (!rst_ni) begin
            wr_state_q     <= WR_IDLE;
            wr_id_q        <= 4'h0;
            wr_base_addr_q <= 32'h0;
            wr_len_q       <= 8'h0;
            wr_beat_cnt_q  <= 8'h0;
            wr_data_q      <= 64'h0;
            wr_strb_q      <= 8'h0;
            wr_resp_q      <= 2'b00;
            wr_need_hi_q   <= 1'b0;
        end else begin
            wr_state_q <= wr_state_d;

            // Latch AW and first W beat
            if (wr_state_q == WR_IDLE && s_axi_aw_valid && s_axi_w_valid) begin
                wr_id_q        <= s_axi_aw_id;
                wr_base_addr_q <= s_axi_aw_addr[31:0];
                wr_len_q       <= s_axi_aw_len;
                wr_beat_cnt_q  <= 8'h0;
                wr_data_q      <= s_axi_w_data;
                wr_strb_q      <= s_axi_w_strb;
                wr_resp_q      <= 2'b00;
                // Need high half if any upper byte strobe is set
                wr_need_hi_q   <= |s_axi_w_strb[7:4];
            end

            // Accumulate worst-case write response
            if ((wr_state_q == WR_BEAT_LO_RSP || wr_state_q == WR_BEAT_HI_RSP)
                && m_axil_bvalid) begin
                wr_resp_q <= wr_resp_q | m_axil_bresp;
            end

            // Advance burst beat counter and latch next W data
            if (wr_state_q == WR_BURST_NEXT && wr_beat_cnt_q != wr_len_q
                && s_axi_w_valid) begin
                wr_beat_cnt_q <= wr_beat_cnt_q + 8'h1;
                wr_data_q     <= s_axi_w_data;
                wr_strb_q     <= s_axi_w_strb;
                wr_need_hi_q  <= |s_axi_w_strb[7:4];
            end
        end
    end

endmodule
/* verilator lint_on UNUSEDSIGNAL */
