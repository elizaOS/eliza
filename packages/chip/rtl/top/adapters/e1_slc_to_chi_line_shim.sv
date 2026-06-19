`timescale 1ns/1ps

// e1_slc_to_chi_line_shim
//
// Top-level integration adapter between the SLC `dram_acq_*` line-grain
// port (64-byte cache line carried as a single 512-bit beat) and the
// `e1_chi_to_axi4_bridge` CHI request/write-data/read-data interface
// (per-beat DATA_WIDTH transport).
//
// The SLC issues:
//   - `dram_acq_valid` with `dram_acq_paddr_line`, `dram_acq_is_write`,
//     and a `dram_acq_wb_data` payload that holds the full LINE_BYTES line.
//   - It waits for `dram_grant_valid` with `dram_grant_data` (LINE_BYTES line).
//
// The CHI bridge expects:
//   - `chi_req_valid` with addr/id/is_write/exclusive/stash/user.
//   - For writes: `chi_wd_valid` with `BEATS = LINE_BYTES / (DATA_WIDTH/8)`
//     beats of `chi_wd_data` and the final beat marked `chi_wd_last`.
//   - For reads: returns BEATS of `chi_rd_data`, last beat marked
//     `chi_rd_last`. Writes produce a `chi_wc_valid` completion handshake.
//
// This shim serialises a single outstanding line request, splits the line
// into per-beat write data on the way down, and re-assembles the per-beat
// read data on the way back up. ID is fixed at the integration ID assigned
// by `e1_soc_integrated` (only one SLC client at this top).
//
// Owner: SoC integration. Lives under `rtl/top/adapters/` per the
// project convention that domain RTL never absorbs cross-domain width
// drift.

/* verilator lint_off UNUSEDSIGNAL */
module e1_slc_to_chi_line_shim #(
    parameter int unsigned PADDR_W    = 40,
    parameter int unsigned LINE_BYTES = 64,
    parameter int unsigned DATA_WIDTH = 128,
    parameter int unsigned ID_WIDTH   = 6,
    parameter int unsigned USER_WIDTH = 8,
    parameter logic [ID_WIDTH-1:0]   REQ_ID   = '0,
    parameter logic [USER_WIDTH-1:0] REQ_USER = '0
) (
    input  logic                       clk,
    input  logic                       rst_n,

    // SLC line-grain port
    input  logic                       slc_acq_valid,
    output logic                       slc_acq_ready,
    input  logic [PADDR_W-1:0]         slc_acq_paddr_line,
    input  logic                       slc_acq_is_write,
    input  logic [8*LINE_BYTES-1:0]    slc_acq_wb_data,
    output logic                       slc_grant_valid,
    input  logic                       slc_grant_ready,
    output logic [PADDR_W-1:0]         slc_grant_paddr_line,
    output logic [8*LINE_BYTES-1:0]    slc_grant_data,

    // CHI bridge request side
    output logic                       chi_req_valid,
    input  logic                       chi_req_ready,
    output logic                       chi_req_is_write,
    output logic                       chi_req_is_exclusive,
    output logic                       chi_req_stash,
    output logic [PADDR_W-1:0]         chi_req_addr,
    output logic [ID_WIDTH-1:0]        chi_req_id,
    output logic [USER_WIDTH-1:0]      chi_req_user,

    output logic                       chi_wd_valid,
    input  logic                       chi_wd_ready,
    output logic [DATA_WIDTH-1:0]      chi_wd_data,
    output logic [DATA_WIDTH/8-1:0]    chi_wd_strb,
    output logic                       chi_wd_last,

    input  logic                       chi_rd_valid,
    output logic                       chi_rd_ready,
    input  logic [DATA_WIDTH-1:0]      chi_rd_data,
    input  logic [ID_WIDTH-1:0]        chi_rd_id,
    input  logic                       chi_rd_last,
    input  logic [1:0]                 chi_rd_resp,

    input  logic                       chi_wc_valid,
    output logic                       chi_wc_ready,
    input  logic [ID_WIDTH-1:0]        chi_wc_id,
    input  logic [1:0]                 chi_wc_resp
);

    localparam int unsigned BEATS    = LINE_BYTES / (DATA_WIDTH / 8);
    localparam int unsigned BEAT_IDX_W = (BEATS <= 1) ? 1 : $clog2(BEATS);

    typedef enum logic [2:0] {
        S_IDLE,
        S_REQ,
        S_WD,
        S_WC,
        S_RD,
        S_GRANT
    } state_e;

    state_e                       state_q;
    logic [PADDR_W-1:0]           addr_q;
    logic                         is_write_q;
    logic [8*LINE_BYTES-1:0]      line_q;
    logic [BEAT_IDX_W-1:0]        beat_q;

    assign chi_req_id           = REQ_ID;
    assign chi_req_user         = REQ_USER;
    assign chi_req_is_exclusive = 1'b0;
    assign chi_req_stash        = 1'b0;
    assign chi_req_addr         = addr_q;
    assign chi_req_is_write     = is_write_q;
    assign chi_req_valid        = (state_q == S_REQ);

    assign chi_wd_valid = (state_q == S_WD);
    assign chi_wd_data  = line_q[beat_q*DATA_WIDTH +: DATA_WIDTH];
    assign chi_wd_strb  = '1;
    assign chi_wd_last  = (state_q == S_WD) &&
                          (beat_q == BEAT_IDX_W'(BEATS - 1));

    assign chi_rd_ready = (state_q == S_RD);
    assign chi_wc_ready = (state_q == S_WC);

    assign slc_acq_ready        = (state_q == S_IDLE);
    assign slc_grant_valid      = (state_q == S_GRANT);
    assign slc_grant_paddr_line = addr_q;
    assign slc_grant_data       = line_q;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state_q     <= S_IDLE;
            addr_q      <= '0;
            is_write_q  <= 1'b0;
            line_q      <= '0;
            beat_q      <= '0;
        end else begin
            unique case (state_q)
                S_IDLE: begin
                    if (slc_acq_valid) begin
                        addr_q     <= slc_acq_paddr_line;
                        is_write_q <= slc_acq_is_write;
                        line_q     <= slc_acq_wb_data;
                        beat_q     <= '0;
                        state_q    <= S_REQ;
                    end
                end
                S_REQ: begin
                    if (chi_req_ready) begin
                        state_q <= is_write_q ? S_WD : S_RD;
                    end
                end
                S_WD: begin
                    if (chi_wd_ready) begin
                        if (beat_q == BEAT_IDX_W'(BEATS - 1)) begin
                            state_q <= S_WC;
                        end else begin
                            beat_q <= beat_q + 1'b1;
                        end
                    end
                end
                S_WC: begin
                    if (chi_wc_valid) begin
                        state_q <= S_GRANT;
                    end
                end
                S_RD: begin
                    if (chi_rd_valid) begin
                        line_q[beat_q*DATA_WIDTH +: DATA_WIDTH] <= chi_rd_data;
                        if (chi_rd_last) begin
                            state_q <= S_GRANT;
                        end else begin
                            beat_q <= beat_q + 1'b1;
                        end
                    end
                end
                S_GRANT: begin
                    if (slc_grant_ready) begin
                        state_q <= S_IDLE;
                    end
                end
                default: state_q <= S_IDLE;
            endcase
        end
    end

    logic unused_chi_rd_id_resp;
    assign unused_chi_rd_id_resp = ^{chi_rd_id, chi_rd_resp, chi_wc_id, chi_wc_resp};

endmodule
/* verilator lint_on UNUSEDSIGNAL */
