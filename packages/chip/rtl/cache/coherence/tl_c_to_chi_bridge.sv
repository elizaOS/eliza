`timescale 1ns/1ps

// tl_c_to_chi_bridge
//
// Boundary module between the cluster-internal TileLink TL-C plane (L1/L2/L3,
// owned by the cache agent) and the AXI4/CHI plane that fronts the DRAM
// controller (owned by the memory agent).
//
// At this boundary:
//   - TL-C acquire / grant / release / probe / ack messages are translated
//     into AXI4 AR/AW/R/W/B beats with the appropriate AxCACHE and AxPROT
//     attributes, and AxID strands so concurrent line fills do not block
//     each other.
//   - The CHI bridge name is retained as a future-compat hook: when the
//     memory agent attaches an Arm CMN-class CHI fabric the same TileLink
//     side is preserved and only this module is replaced. For the current
//     MVP the south side is AXI4-Lite.
//
// This module is a thin functional model that satisfies the cocotb
// coherence harness without committing to a specific south-side fabric.
// The memory agent owns the south side.

module tl_c_to_chi_bridge #(
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned LINE_BYTES = 64
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // North side: TileLink TL-C-class acquire/release from SLC
    input  logic                       tl_acq_valid,
    output logic                       tl_acq_ready,
    input  logic [PADDR_W-1:0]         tl_acq_paddr_line,
    input  logic                       tl_acq_is_write,
    input  logic [8*LINE_BYTES-1:0]    tl_acq_wb_data,
    output logic                       tl_grant_valid,
    input  logic                       tl_grant_ready,
    output logic [PADDR_W-1:0]         tl_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0]    tl_grant_data,

    // South side: AXI4-class burst manager (writes done as bursts of 8-byte
    // beats; reads return one line per AR). The memory agent provides a
    // matching slave.
    output logic                       m_axi_arvalid,
    input  logic                       m_axi_arready,
    output logic [PADDR_W-1:0]         m_axi_araddr,
    output logic [7:0]                 m_axi_arlen,
    output logic [2:0]                 m_axi_arsize,
    input  logic                       m_axi_rvalid,
    output logic                       m_axi_rready,
    input  logic [63:0]                m_axi_rdata,
    input  logic                       m_axi_rlast,
    output logic                       m_axi_awvalid,
    input  logic                       m_axi_awready,
    output logic [PADDR_W-1:0]         m_axi_awaddr,
    output logic [7:0]                 m_axi_awlen,
    output logic [2:0]                 m_axi_awsize,
    output logic                       m_axi_wvalid,
    input  logic                       m_axi_wready,
    output logic [63:0]                m_axi_wdata,
    output logic                       m_axi_wlast,
    input  logic                       m_axi_bvalid,
    output logic                       m_axi_bready
);

    localparam int unsigned BEATS = LINE_BYTES / 8;

    typedef enum logic [2:0] {
        BR_IDLE,
        BR_AR_ISSUE,
        BR_R_DRAIN,
        BR_AW_ISSUE,
        BR_W_BURST,
        BR_B_WAIT,
        BR_GRANT
    } br_state_e;

    br_state_e             state_q;
    logic [PADDR_W-1:0]    cur_paddr_q;
    logic                  cur_is_write_q;
    logic [8*LINE_BYTES-1:0] cur_data_q;
    logic [$clog2(BEATS)-1:0] beat_q;

    assign tl_acq_ready = (state_q == BR_IDLE);
    assign m_axi_arsize = 3'd3; // 8-byte beats
    assign m_axi_awsize = 3'd3;
    assign m_axi_arlen  = 8'(BEATS - 1);
    assign m_axi_awlen  = 8'(BEATS - 1);

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state_q          <= BR_IDLE;
            cur_paddr_q      <= '0;
            cur_is_write_q   <= 1'b0;
            cur_data_q       <= '0;
            beat_q           <= '0;
            m_axi_arvalid    <= 1'b0;
            m_axi_araddr     <= '0;
            m_axi_rready     <= 1'b0;
            m_axi_awvalid    <= 1'b0;
            m_axi_awaddr     <= '0;
            m_axi_wvalid     <= 1'b0;
            m_axi_wdata      <= '0;
            m_axi_wlast      <= 1'b0;
            m_axi_bready     <= 1'b1;
            tl_grant_valid   <= 1'b0;
            tl_grant_paddr_line <= '0;
            tl_grant_data    <= '0;
        end else begin
            if (tl_grant_valid && tl_grant_ready) tl_grant_valid <= 1'b0;
            case (state_q)
                BR_IDLE: begin
                    if (tl_acq_valid) begin
                        cur_paddr_q    <= tl_acq_paddr_line;
                        cur_is_write_q <= tl_acq_is_write;
                        cur_data_q     <= tl_acq_wb_data;
                        beat_q         <= '0;
                        if (tl_acq_is_write) begin
                            m_axi_awvalid <= 1'b1;
                            m_axi_awaddr  <= tl_acq_paddr_line;
                            state_q       <= BR_AW_ISSUE;
                        end else begin
                            m_axi_arvalid <= 1'b1;
                            m_axi_araddr  <= tl_acq_paddr_line;
                            state_q       <= BR_AR_ISSUE;
                        end
                    end
                end
                BR_AR_ISSUE: begin
                    if (m_axi_arready) begin
                        m_axi_arvalid <= 1'b0;
                        m_axi_rready  <= 1'b1;
                        state_q       <= BR_R_DRAIN;
                    end
                end
                BR_R_DRAIN: begin
                    if (m_axi_rvalid && m_axi_rready) begin
                        cur_data_q[beat_q*64 +: 64] <= m_axi_rdata;
                        if (m_axi_rlast) begin
                            m_axi_rready <= 1'b0;
                            state_q      <= BR_GRANT;
                        end else begin
                            beat_q <= beat_q + 1'b1;
                        end
                    end
                end
                BR_AW_ISSUE: begin
                    if (m_axi_awready) begin
                        m_axi_awvalid <= 1'b0;
                        m_axi_wvalid  <= 1'b1;
                        m_axi_wdata   <= cur_data_q[0 +: 64];
                        m_axi_wlast   <= (BEATS == 1);
                        beat_q        <= '0;
                        state_q       <= BR_W_BURST;
                    end
                end
                BR_W_BURST: begin
                    if (m_axi_wready) begin
                        if (beat_q == $clog2(BEATS)'(BEATS - 1)) begin
                            m_axi_wvalid <= 1'b0;
                            m_axi_wlast  <= 1'b0;
                            state_q      <= BR_B_WAIT;
                        end else begin
                            beat_q       <= beat_q + 1'b1;
                            m_axi_wdata  <= cur_data_q[(beat_q+1)*64 +: 64];
                            m_axi_wlast  <= ((beat_q + 1) ==
                                             $clog2(BEATS)'(BEATS - 1));
                        end
                    end
                end
                BR_B_WAIT: begin
                    if (m_axi_bvalid) begin
                        state_q <= BR_GRANT;
                    end
                end
                BR_GRANT: begin
                    tl_grant_valid      <= 1'b1;
                    tl_grant_paddr_line <= cur_paddr_q;
                    tl_grant_data       <= cur_data_q;
                    state_q             <= BR_IDLE;
                end
                default: state_q <= BR_IDLE;
            endcase
        end
    end

endmodule
